/**
 * Raw-response cache for the deep-space named-object build.
 * Every network response used by tools/deepspace/build_objects.ts is stored verbatim under
 * data/cache/deepspace/objects/<sha1(key)[0..16]>.txt and listed in index.json
 * (url, query, retrieval date, byte count). `--offline` reads only from here and fails on a miss.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
export const CACHE_DIR = join(ROOT, 'data', 'cache', 'deepspace', 'objects');
const INDEX = join(CACHE_DIR, 'index.json');

interface IndexEntry { file: string; url: string; params?: Record<string, string>; retrieved: string; bytes: number; label?: string }
let index: Record<string, IndexEntry> | null = null;
let offline = false;
export function setOffline(v: boolean): void { offline = v; }
export function isOffline(): boolean { return offline; }

function loadIndex(): Record<string, IndexEntry> {
  if (index) return index;
  mkdirSync(CACHE_DIR, { recursive: true });
  index = existsSync(INDEX) ? (JSON.parse(readFileSync(INDEX, 'utf8')) as Record<string, IndexEntry>) : {};
  return index;
}
function saveIndex(): void {
  const sorted = Object.fromEntries(Object.entries(loadIndex()).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(INDEX, JSON.stringify(sorted, null, 1));
}
export function keyOf(url: string, params?: Record<string, string>): string {
  const p = params ? Object.entries(params).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&') : '';
  return `GET ${url}?${p}`;
}
export function retrievalDate(url: string, params?: Record<string, string>): string | undefined {
  return loadIndex()[keyOf(url, params)]?.retrieved;
}

export function fileRetrievalDate(url: string): string | undefined {
  return loadIndex()[`FILE ${url}`]?.retrieved;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET with query parameters; cached by (url, params). Retries with a 60 s timeout. */
export async function cachedGet(url: string, params?: Record<string, string>, label?: string): Promise<string> {
  const idx = loadIndex();
  const key = keyOf(url, params);
  const hit = idx[key];
  if (hit && existsSync(join(CACHE_DIR, hit.file))) return readFileSync(join(CACHE_DIR, hit.file), 'utf8');
  if (offline) throw new Error(`offline: no cached response for ${key}`);
  const u = new URL(url);
  for (const [k, v] of Object.entries(params ?? {})) u.searchParams.set(k, v);
  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(90_000), headers: { 'User-Agent': 'AtlasOfTheUniverse-data-build/1.0' }, redirect: 'follow' });
      if (!res.ok) { const body = (await res.text()).slice(0, 300); if (res.status >= 400 && res.status < 500) throw Object.assign(new Error(`HTTP ${res.status} for ${u}: ${body}`), { fatal: true }); throw new Error(`HTTP ${res.status} for ${u}`); }
      const text = await res.text();
      const file = createHash('sha1').update(key).digest('hex').slice(0, 16) + '.txt';
      writeFileSync(join(CACHE_DIR, file), text);
      idx[key] = { file, url, params, retrieved: new Date().toISOString().slice(0, 10), bytes: Buffer.byteLength(text), label };
      saveIndex();
      return text;
    } catch (e) { if ((e as { fatal?: boolean }).fatal) throw e; last = e; await sleep(1500 * (attempt + 1)); }
  }
  throw new Error(`fetch failed after retries: ${String(last)}`);
}

/** SIMBAD ADQL via the CfA mirror, returned as an array of row objects. */
export const SIMBAD_TAP = 'https://simbad.cfa.harvard.edu/simbad/sim-tap/sync';
export async function simbadQuery(adql: string, label?: string): Promise<Record<string, string | number | null>[]> {
  const text = await cachedGet(SIMBAD_TAP, { request: 'doQuery', lang: 'adql', format: 'json', query: adql }, label);
  const j = JSON.parse(text) as { metadata: { name: string }[]; data: (string | number | null)[][] };
  return j.data.map((r) => Object.fromEntries(j.metadata.map((m, i) => [m.name, r[i]!])));
}

/** Download a large file once (streamed to disk) and return its local path. Listed in index.json like any other response. */
export async function cachedFile(url: string, name: string): Promise<string> {
  const idx = loadIndex();
  const key = `FILE ${url}`;
  const path = join(CACHE_DIR, name);
  if (idx[key] && existsSync(path)) return path;
  if (offline) throw new Error(`offline: no cached file for ${url}`);
  const { writeFile } = await import('node:fs/promises');
  const res = await fetch(url, { signal: AbortSignal.timeout(600_000), headers: { 'User-Agent': 'AtlasOfTheUniverse-data-build/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(path, buf);
  idx[key] = { file: name, url, retrieved: new Date().toISOString().slice(0, 10), bytes: buf.length };
  saveIndex();
  return path;
}
