/**
 * IVOA TAP client (sync and async/UWS). `fetch` is injectable so the protocol is testable offline.
 * No credentials are used or stored: the archives queried here allow anonymous access.
 */
export class TapError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'TapError';
  }
}

export interface TapConfig {
  /** Base TAP URL without a trailing slash, e.g. https://gea.esac.esa.int/tap-server/tap */
  readonly endpoint: string;
  readonly fetch?: typeof fetch;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const UA = 'AtlasOfTheUniverse-ingest/0.1 (open-source astronomy visualisation; build-time import)';
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function form(params: Record<string, string>): URLSearchParams {
  return new URLSearchParams(params);
}

function xmlInfo(text: string): string {
  const m = text.match(/<INFO[^>]*name="QUERY_STATUS"[^>]*>([\s\S]*?)<\/INFO>/);
  if (m?.[1]) return m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
  // An HTML error page: report its title only, never its CSS or script.
  const title = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim();
  if (title) return title.slice(0, 200);
  return text.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** Throws if the response is an HTTP error, or an XML/HTML error body where CSV was expected. */
export function assertCsvResponse(status: number, ok: boolean, text: string): void {
  if (!ok) throw new TapError(`TAP request failed with HTTP ${status}: ${xmlInfo(text)}`, status);
  const head = text.trimStart().slice(0, 1);
  if (head === '<') throw new TapError(`TAP service returned markup instead of CSV: ${xmlInfo(text)}`, status);
}

export async function tapSync(cfg: TapConfig, adql: string): Promise<string> {
  const f = cfg.fetch ?? fetch;
  const res = await f(`${cfg.endpoint}/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
    body: form({ REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv', QUERY: adql }),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 120_000),
  });
  const text = await res.text();
  assertCsvResponse(res.status, res.ok, text);
  return text;
}

/** Async (UWS) job: submit, poll the phase, download the result. Needed for result sets over the sync row cap. */
export async function tapAsync(cfg: TapConfig, adql: string, log: (m: string) => void = () => {}): Promise<string> {
  const f = cfg.fetch ?? fetch;
  const sleep = cfg.sleep ?? defaultSleep;
  const poll = cfg.pollIntervalMs ?? 3000;
  const deadline = Date.now() + (cfg.timeoutMs ?? 20 * 60_000);
  const headers = { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA };

  const submit = await f(`${cfg.endpoint}/async`, {
    method: 'POST',
    headers,
    body: form({ REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv', PHASE: 'RUN', QUERY: adql }),
    signal: AbortSignal.timeout(60_000),
  });
  const submitText = await submit.text();
  if (!submit.ok) throw new TapError(`TAP job submission failed with HTTP ${submit.status}: ${xmlInfo(submitText)}`, submit.status);

  let jobUrl = submit.redirected ? submit.url : '';
  if (!jobUrl) {
    const id = submitText.match(/<(?:uws:)?jobId[^>]*>([^<]+)</)?.[1];
    if (!id) throw new TapError('TAP job submission returned no job identifier');
    jobUrl = `${cfg.endpoint}/async/${id.trim()}`;
  }
  jobUrl = jobUrl.replace(/\/+$/, '');
  log(`job ${jobUrl}`);

  const reqTimeout = () => AbortSignal.timeout(60_000);
  const KNOWN_ACTIVE = new Set(['PENDING', 'QUEUED', 'EXECUTING', 'HELD', 'SUSPENDED', 'UNKNOWN']);
  for (;;) {
    const ph = await f(`${jobUrl}/phase`, { headers: { 'user-agent': UA }, signal: reqTimeout() });
    const phaseText = await ph.text();
    if (!ph.ok) throw new TapError(`TAP phase request failed with HTTP ${ph.status}: ${xmlInfo(phaseText)}`, ph.status);
    const phase = phaseText.trim().toUpperCase();
    if (phase === 'COMPLETED') break;
    if (!KNOWN_ACTIVE.has(phase) && phase !== 'ERROR' && phase !== 'ABORTED') {
      throw new TapError(`TAP job is in unexpected phase "${phase.slice(0, 20)}"`);
    }
    if (phase === 'ERROR' || phase === 'ABORTED') {
      const err = await f(`${jobUrl}/error`, { headers: { 'user-agent': UA }, signal: reqTimeout() }).then((r) => r.text()).catch(() => '');
      throw new TapError(`TAP job ${phase}: ${xmlInfo(err)}`);
    }
    if (Date.now() > deadline) throw new TapError(`TAP job timed out in phase ${phase}`);
    log(`phase ${phase}`);
    await sleep(poll);
  }
  const out = await f(`${jobUrl}/results/result`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(cfg.timeoutMs ?? 20 * 60_000) });
  const text = await out.text();
  assertCsvResponse(out.status, out.ok, text);
  return text;
}
