/** SIMBAD TAP (CfA mirror: simbad.cfa.harvard.edu; the Strasbourg host is not reachable from the build machine). */
import { parseCsv } from '../../../src/data/ingestion/csv';
import type { DiscoveryCache } from './cache';

export const SIMBAD_TAP = 'https://simbad.cfa.harvard.edu/simbad/sim-tap/sync';

export async function simbadQuery(cache: DiscoveryCache, adql: string, label: string): Promise<{ header: string[]; rows: string[][]; retrieved: string }> {
  const params = { REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv', QUERY: adql };
  const text = await cache.post(SIMBAD_TAP, params, label, (t) => {
    if (t.trimStart().startsWith('<')) throw new Error(`SIMBAD TAP returned markup for ${label}: ${t.slice(0, 300)}`);
  });
  const all = parseCsv(text).filter((r) => r.length > 1 || (r[0] ?? '') !== '');
  return { header: all[0] ?? [], rows: all.slice(1), retrieved: cache.retrieved('POST', SIMBAD_TAP, params) ?? 'unknown' };
}

/** Collapse SIMBAD's fixed-width identifier padding: "HD  39801" -> "HD 39801". */
export const tidyId = (s: string): string => s.replace(/\s+/g, ' ').trim();
