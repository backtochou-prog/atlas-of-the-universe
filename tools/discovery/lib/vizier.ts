/** VizieR ASU (asu-tsv) access on the CfA mirror (the only VizieR host reachable from the build machine). Cached via DiscoveryCache. */
import type { DiscoveryCache } from './cache';

export const VIZIER_URL = 'https://vizier.cfa.harvard.edu/viz-bin/asu-tsv';
export const VIZIER_README = (cat: string) => `https://vizier.cfa.harvard.edu/ftp/cats/${cat}/ReadMe`;

export interface VizierTable { rows: Record<string, string>[]; units: Record<string, string> }

export function parseAsuTsv(text: string, label: string): VizierTable {
  const err = /#\*\*\*\*(?:\s*)(.*)/.exec(text) ?? /^#+\s*(?:Error|ERROR)[^\n]*/m.exec(text);
  if (err) throw new Error(`VizieR error for ${label}: ${err[0]}`);
  const lines = text.split('\n').filter((l) => !l.startsWith('#'));
  const start = lines.findIndex((l) => l.trim().length > 0);
  if (start < 0) return { rows: [], units: {} };
  const header = lines[start]!.split('\t').map((s) => s.trim());
  const unitLine = (lines[start + 1] ?? '').split('\t').map((s) => s.trim());
  const units: Record<string, string> = {};
  header.forEach((h, i) => { units[h] = unitLine[i] ?? ''; });
  const rows: Record<string, string>[] = [];
  for (let i = start + 3; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.trim()) continue;
    const f = l.split('\t');
    if (f.length !== header.length) throw new Error(`VizieR ${label}: row ${i} has ${f.length} fields, header ${header.length}`);
    const r: Record<string, string> = {};
    header.forEach((h, j) => { r[h] = f[j]!.trim(); });
    rows.push(r);
  }
  return { rows, units };
}

export async function vizier(cache: DiscoveryCache, source: string, constraints: Record<string, string>, out: string, label: string): Promise<VizierTable & { retrieved: string; params: Record<string, string> }> {
  const params = { '-source': source, ...constraints, '-out': out, '-out.max': 'unlimited', '-sort': 'HIP' };
  const text = await cache.get(VIZIER_URL, params, label, (t) => { parseAsuTsv(t, label); });
  const tbl = parseAsuTsv(text, label);
  return { ...tbl, retrieved: cache.retrieved('GET', VIZIER_URL, params) ?? 'unknown', params };
}

/** Parse a number; blank / non-numeric -> null (missing is never zero). */
export function num(s: string | undefined): number | null {
  if (s === undefined) return null;
  const t = s.trim();
  if (t === '' || t === '---') return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}
