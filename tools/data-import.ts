/**
 * Build-time data import. Usage:
 *   npx tsx tools/data-import.ts gaia   [--offline] [--refresh]
 *   npx tsx tools/data-import.ts simbad [--offline] [--refresh]
 *   npx tsx tools/data-import.ts report
 *   npx tsx tools/data-import.ts all    [--offline] [--refresh]
 * --offline  never touch the network; fail if a cache entry is missing (exact reproduction)
 * --refresh  ignore cached downloads and fetch again
 * Raw downloads are cached in data/cache/ (git-ignored). No credentials are used or required.
 */
import { gzipSync, gunzipSync } from 'node:zlib';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { buildGaiaDataset, buildSimbadFile } from '../src/data/ingestion/build';
import { FileCache } from '../src/data/ingestion/cache';
import { mergeSimbad, type SimbadRow } from '../src/data/ingestion/crossid';
import { buildGaiaQuery, GAIA_TAP_ENDPOINT, DEFAULT_GAIA_SELECTION, parseGaiaCsv } from '../src/data/ingestion/gaia';
import { renderProvenanceMarkdown, renderQualityMarkdown } from '../src/data/ingestion/report';
import {
  buildSimbadBatchQuery, parseOtypes, parseSimbadBatch, probeSimbad, SIMBAD_BATCH_QUERY_TEMPLATE, SIMBAD_BATCH_SIZE, SIMBAD_OTYPE_QUERY,
} from '../src/data/ingestion/simbad';
import { tapAsync, tapSync } from '../src/data/ingestion/tap';
import type { GaiaDatasetFile, SimbadCrossIdFile } from '../src/data/catalogue/types';
import type { QualityReport } from '../src/data/ingestion/quality';

const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith('--')) ?? 'all';
const OFFLINE = args.includes('--offline');
const REFRESH = args.includes('--refresh');
const CACHE = new FileCache('data/cache');
const GAIA_OUT = 'public/data/gaia-dr3-subset.v1.json.gz';
const SIMBAD_OUT = 'public/data/simbad-crossid.v1.json.gz';
const QUALITY_JSON = 'data/reports/gaia-dr3-subset.v1.quality.json';
const log = (m: string) => console.log(`[import] ${m}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function readGz<T>(path: string): Promise<T> {
  return JSON.parse(gunzipSync(await readFile(path)).toString('utf8')) as T;
}
async function writeGz(path: string, data: unknown): Promise<void> {
  await writeFile(path, gzipSync(JSON.stringify(data), { level: 9 }));
}

async function cached(endpoint: string, query: string, fetchLive: () => Promise<string>, rowsOf: (t: string) => number, validate: (t: string) => void = () => {}) {
  const key = FileCache.key(endpoint, query);
  if (!REFRESH) {
    const hit = await CACHE.get(key);
    if (hit) { validate(hit.text); return { text: hit.text, meta: hit.meta, fromCache: true }; }
  }
  if (OFFLINE) throw new Error(`--offline: no cache entry ${key} for ${endpoint}. Run without --offline first.`);
  const text = await fetchLive();
  validate(text); // never cache a body that does not parse: a bad download must not become permanent
  const meta = await CACHE.put(key, text, { endpoint, query, retrievedAt: new Date().toISOString(), rows: rowsOf(text) });
  return { text, meta, fromCache: false };
}
const csvRows = (t: string) => Math.max(0, t.trim().split('\n').length - 1);

async function importGaia(): Promise<void> {
  const query = buildGaiaQuery(DEFAULT_GAIA_SELECTION);
  log(`Gaia DR3 query (${GAIA_TAP_ENDPOINT}):\n${query}`);
  const r = await cached(GAIA_TAP_ENDPOINT, query, () => tapAsync({ endpoint: GAIA_TAP_ENDPOINT }, query, (m) => log(m)), csvRows, (t) => { parseGaiaCsv(t); });
  log(`${r.fromCache ? 'using cached download' : 'downloaded'}: ${r.meta.rows} rows, ${r.meta.bytes} bytes, sha256 ${r.meta.sha256.slice(0, 12)}...`);
  const built = buildGaiaDataset({
    rawCsv: r.text,
    selection: DEFAULT_GAIA_SELECTION,
    builtAt: new Date().toISOString(),
    retrieval: { retrievedAt: r.meta.retrievedAt, endpoint: GAIA_TAP_ENDPOINT, adql: query, rawSha256: r.meta.sha256, rawBytes: r.meta.bytes, rawRows: r.meta.rows },
  });
  await mkdir('public/data', { recursive: true });
  await mkdir('data/reports', { recursive: true });
  await writeGz(GAIA_OUT, built.file);
  // A rebuilt Gaia dataset invalidates any SIMBAD file built from the previous one.
  await unlink(SIMBAD_OUT).then(() => log(`removed ${SIMBAD_OUT}: it was built from the previous Gaia dataset. Re-run "npm run data:simbad".`), () => {});
  await writeFile(QUALITY_JSON, JSON.stringify(built.quality, null, 2));
  log(`wrote ${GAIA_OUT}: imported ${built.records.length}, rejected ${built.rejected.length}, content sha256 ${built.file.manifest.contentSha256.slice(0, 12)}...`);
  await importReport();
}

async function importSimbad(): Promise<void> {
  const gaia = await readGz<GaiaDatasetFile>(GAIA_OUT);
  const ids = [...gaia.sourceId];
  let service = { name: 'SIMBAD (cached)', endpoint: 'cached', note: 'Served entirely from the local cache.' };
  let endpoint = '';
  if (!OFFLINE) {
    const probe = await probeSimbad();
    for (const a of probe.attempts) log(`probe ${a.name}: ${a.reachable ? 'OK' : 'UNREACHABLE'} (${a.detail})`);
    if (!probe.chosen) throw new Error('No SIMBAD endpoint is reachable. Nothing was fabricated; re-run later.');
    endpoint = probe.chosen.endpoint;
    const failed = probe.attempts.filter((a) => !a.reachable);
    service = {
      name: probe.chosen.name, endpoint,
      note: failed.length ? `Primary host unavailable at retrieval time (${failed.map((f) => `${f.name}: ${f.detail}`).join('; ')}); the official mirror served the data.` : 'Primary host used.',
    };
  } else {
    const one = await CACHE.get(FileCache.key('simbad-meta', 'service'));
    if (one) service = JSON.parse(one.text) as typeof service;
    endpoint = service.endpoint;
  }
  const tap = { endpoint, timeoutMs: 120_000 };

  const ot = await cached(`${endpoint}#otypes`, SIMBAD_OTYPE_QUERY, () => tapSync(tap, SIMBAD_OTYPE_QUERY), csvRows, (t) => { parseOtypes(t); });
  const otypes = parseOtypes(ot.text);

  const rows: SimbadRow[] = [];
  let retrievedAt = ot.meta.retrievedAt;
  const batches = Math.ceil(ids.length / SIMBAD_BATCH_SIZE);
  for (let b = 0; b < batches; b++) {
    const chunk = ids.slice(b * SIMBAD_BATCH_SIZE, (b + 1) * SIMBAD_BATCH_SIZE);
    const query = buildSimbadBatchQuery(chunk);
    const res = await cached(`${endpoint}#batch`, query, async () => {
      await sleep(400); // be polite: stay well under the service rate limit
      return tapSync(tap, query);
    }, csvRows, (t) => { parseSimbadBatch(t); });
    if (res.meta.retrievedAt > retrievedAt) retrievedAt = res.meta.retrievedAt;
    rows.push(...parseSimbadBatch(res.text));
    if ((b + 1) % 10 === 0 || b === batches - 1) log(`batch ${b + 1}/${batches} (${res.fromCache ? 'cache' : 'live'}), rows so far ${rows.length}`);
  }
  await CACHE.put(FileCache.key('simbad-meta', 'service'), JSON.stringify(service), { endpoint: 'simbad-meta', query: 'service', retrievedAt, rows: 1 });

  const merge = mergeSimbad(ids, rows);
  const file = buildSimbadFile({
    builtAt: new Date().toISOString(), retrievedAt, service, requested: ids.length, merge, otypes,
    batchQuery: SIMBAD_BATCH_QUERY_TEMPLATE,
  });
  await writeGz(SIMBAD_OUT, file);
  log(`wrote ${SIMBAD_OUT}: matched ${merge.matched}/${ids.length}, unmatched ${merge.unmatched.length}, conflicts ${merge.conflicts.length}, shared objects ${merge.sharedObjects.length}`);

  const q = JSON.parse(await readFile(QUALITY_JSON, 'utf8')) as QualityReport & { crossIdentification: Record<string, unknown> };
  const updated = {
    ...q,
    crossIdentification: {
      ...q.crossIdentification,
      simbad: { requested: ids.length, matched: merge.matched, unmatched: merge.unmatched.length, conflicts: merge.conflicts.length, sharedObjects: merge.sharedObjects.length },
      simbadConflicts: merge.conflicts, simbadSharedObjects: merge.sharedObjects,
    },
  };
  await writeFile(QUALITY_JSON, JSON.stringify(updated, null, 2));
  await importReport();
}

async function importReport(): Promise<void> {
  const gaia = await readGz<GaiaDatasetFile>(GAIA_OUT);
  const q = JSON.parse(await readFile(QUALITY_JSON, 'utf8')) as QualityReport;
  let simbad: SimbadCrossIdFile | undefined;
  try { simbad = await readGz<SimbadCrossIdFile>(SIMBAD_OUT); } catch { simbad = undefined; }
  await writeFile('docs/DATA_QUALITY_REPORT.md', renderQualityMarkdown(q, gaia.manifest, simbad?.manifest));
  await writeFile('docs/DATA_PROVENANCE.md', renderProvenanceMarkdown(gaia.manifest, simbad?.manifest));
  log('wrote docs/DATA_QUALITY_REPORT.md and docs/DATA_PROVENANCE.md');
}

if (cmd === 'gaia') await importGaia();
else if (cmd === 'simbad') await importSimbad();
else if (cmd === 'report') await importReport();
else if (cmd === 'all') { await importGaia(); await importSimbad(); }
else { console.error(`Unknown command "${cmd}"`); process.exit(2); }
