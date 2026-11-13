import type { GaiaCatalogue } from './catalogue';
import type { SimbadCrossIdFile } from './types';

export interface SearchHit {
  readonly index: number;
  readonly label: string;
  /** The identifier that matched. */
  readonly matched: string;
  readonly score: number;
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Identifier search over EVERY catalogue record, including those that cannot be drawn (no distance or no G
 * magnitude), so any record can be inspected. Matches Gaia source ids, Hipparcos numbers, SIMBAD main ids,
 * proper names and the capped alternative-identifier list. Exact matches rank first, then prefix, then substring.
 */
export function searchCatalogue(cat: GaiaCatalogue, simbad: SimbadCrossIdFile | null, query: string, limit = 8): SearchHit[] {
  const q = norm(query);
  if (q.length < 2) return [];
  const hits: SearchHit[] = [];
  for (let i = 0; i < cat.count; i++) {
    const id = cat.sourceId(i);
    const hip = cat.value('hip_id', i);
    const entry = simbad?.entries[id];
    let best = Infinity;
    let matched = '';
    const consider = (candidate: string) => {
      const c = norm(candidate);
      const score = c === q ? 0 : c.startsWith(q) ? 1 : c.includes(q) ? 2 : Infinity;
      if (score < best) { best = score; matched = candidate; }
    };
    consider(id);
    consider(`Gaia DR3 ${id}`);
    if (hip !== null) consider(`HIP ${hip}`);
    if (entry) { consider(entry.m); for (const x of entry.i) consider(x.startsWith('NAME ') ? x.slice(5) : x); }
    if (best === Infinity) continue;
    const proper = entry?.i.find((x) => x.startsWith('NAME '))?.slice(5);
    hits.push({ index: i, label: proper ?? entry?.m ?? `Gaia DR3 ${id}`, matched, score: best + 0 });
  }
  hits.sort((a, b) => a.score - b.score || (cat.value('phot_g_mean_mag', a.index) ?? 99) - (cat.value('phot_g_mean_mag', b.index) ?? 99));
  return hits.slice(0, limit);
}
