/**
 * Raw-response cache for the discovery data builds (bright stars, other objects).
 * Every network response is stored verbatim under data/cache/discovery/<scope>/<sha1(key)[0..16]>.txt and listed in
 * that scope's index.json (method, url, params/body, retrieval time, bytes, sha256). `--offline` reads only from here and
 * fails on a miss. Scopes keep concurrent builds from racing on one index file.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const UA = 'AtlasOfTheUniverse-data-build/1.0';

interface Entry { file: string; method: 'GET' | 'POST'; url: string; params?: Record<string, string>; retrieved: string; bytes: number; sha256: string; label?: string }

export class DiscoveryCache {
  private index: Record<string, Entry> | null = null;
  readonly dir: string;
  constructor(scope: string, public offline = false) { this.dir = join(ROOT, 'data', 'cache', 'discovery', scope); }

  private idx(): Record<string, Entry> {
    if (this.index) return this.index;
    mkdirSync(this.dir, { recursive: true });
    const p = join(this.dir, 'index.json');
    this.index = existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Record<string, Entry>) : {};
    return this.index;
  }
  private save(): void {
    const sorted = Object.fromEntries(Object.entries(this.idx()).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(join(this.dir, 'index.json'), JSON.stringify(sorted, null, 1));
  }
  static key(method: string, url: string, params?: Record<string, string>): string {
    const p = params ? Object.entries(params).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&') : '';
    return `${method} ${url}?${p}`;
  }
  /** ISO date (YYYY-MM-DD) the cached response was retrieved, or undefined when not cached. */
  retrieved(method: 'GET' | 'POST', url: string, params?: Record<string, string>): string | undefined {
    return this.idx()[DiscoveryCache.key(method, url, params)]?.retrieved.slice(0, 10);
  }

  /** GET (params in the query string) or POST (params form-encoded in the body); cached by (method, url, params). 4 attempts, 120 s timeout. */
  async fetchText(method: 'GET' | 'POST', url: string, params: Record<string, string> = {}, label?: string, validate?: (t: string) => void): Promise<string> {
    const idx = this.idx();
    const key = DiscoveryCache.key(method, url, params);
    const hit = idx[key];
    if (hit && existsSync(join(this.dir, hit.file))) return readFileSync(join(this.dir, hit.file), 'utf8');
    if (this.offline) throw new Error(`--offline: no cached response for ${label ?? key}`);
    let last: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        let res: Response;
        if (method === 'GET') {
          const u = new URL(url);
          for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
          res = await fetch(u, { signal: AbortSignal.timeout(120_000), headers: { 'User-Agent': UA }, redirect: 'follow' });
        } else {
          res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(120_000), headers: { 'User-Agent': UA, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params), redirect: 'follow' });
        }
        const text = await res.text();
        if (!res.ok) {
          if (res.status >= 400 && res.status < 500 && res.status !== 429) throw Object.assign(new Error(`HTTP ${res.status} for ${url}: ${text.slice(0, 300)}`), { fatal: true });
          throw new Error(`HTTP ${res.status} for ${url}`);
        }
        validate?.(text); // never cache a body that fails validation
        const file = createHash('sha1').update(key).digest('hex').slice(0, 16) + '.txt';
        writeFileSync(join(this.dir, file), text);
        idx[key] = { file, method, url, params, retrieved: new Date().toISOString(), bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex'), label };
        this.save();
        return text;
      } catch (e) {
        last = e;
        if ((e as { fatal?: boolean }).fatal) break;
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      }
    }
    throw new Error(`fetch failed for ${label ?? key}: ${(last as Error).message}`);
  }
  get(url: string, params?: Record<string, string>, label?: string, validate?: (t: string) => void): Promise<string> { return this.fetchText('GET', url, params ?? {}, label, validate); }
  post(url: string, params: Record<string, string>, label?: string, validate?: (t: string) => void): Promise<string> { return this.fetchText('POST', url, params, label, validate); }
}
