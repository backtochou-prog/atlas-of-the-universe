import { angularSeparationDeg, equatorialToUnit } from '../../core/astro/coordinates';
import type { GaiaRecord } from '../catalogue/flags';
import type { SimbadEntry } from '../catalogue/types';

export interface HipConflict {
  readonly hipId: number;
  readonly sourceIds: readonly string[];
}

/** Two Gaia sources claiming the same Hipparcos star: kept, listed, and never merged automatically. */
export function findHipConflicts(records: readonly GaiaRecord[]): HipConflict[] {
  const byHip = new Map<number, string[]>();
  for (const r of records) {
    const h = r.values.hip_id;
    if (h === null) continue;
    const list = byHip.get(h);
    if (list) list.push(r.sourceId);
    else byHip.set(h, [r.sourceId]);
  }
  return [...byHip.entries()].filter(([, ids]) => ids.length > 1).map(([hipId, sourceIds]) => ({ hipId, sourceIds }));
}

export interface PositionalDuplicate {
  readonly a: string;
  readonly b: string;
  readonly separationArcsec: number;
}

/**
 * Candidate positional duplicates: two different source_ids within `radiusArcsec`. They are REPORTED, never merged:
 * close pairs are usually real binaries, and merging would delete real stars.
 */
export function findPositionalDuplicates(records: readonly GaiaRecord[], radiusArcsec = 0.5): PositionalDuplicate[] {
  // Bucket on the 3D unit vector, not on (RA, Dec): that has no poles and no RA wrap-around to special-case.
  // Cell size exceeds the chord for the search radius, so true neighbours are always in the 27 adjacent cells.
  const radiusRad = (radiusArcsec / 3600) * (Math.PI / 180);
  const cell = Math.max(radiusRad * 1.01, 1e-9);
  const units: [number, number, number][] = [];
  const grid = new Map<string, number[]>();
  records.forEach((r, idx) => {
    const ra = r.values.ra, dec = r.values.dec;
    if (ra === null || dec === null) { units.push([NaN, NaN, NaN]); return; }
    const u = equatorialToUnit(ra, dec);
    units.push([u[0], u[1], u[2]]);
    const k = `${Math.floor(u[0] / cell)},${Math.floor(u[1] / cell)},${Math.floor(u[2] / cell)}`;
    const list = grid.get(k);
    if (list) list.push(idx);
    else grid.set(k, [idx]);
  });
  const out: PositionalDuplicate[] = [];
  records.forEach((r, idx) => {
    const u = units[idx]!;
    if (Number.isNaN(u[0])) return;
    const ix = Math.floor(u[0] / cell), iy = Math.floor(u[1] / cell), iz = Math.floor(u[2] / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const cand = grid.get(`${ix + dx},${iy + dy},${iz + dz}`);
      if (!cand) continue;
      for (const other of cand) {
        if (other <= idx) continue;
        const o = records[other]!;
        const sep = angularSeparationDeg(r.values.ra!, r.values.dec!, o.values.ra!, o.values.dec!) * 3600;
        if (sep <= radiusArcsec) out.push({ a: r.sourceId, b: o.sourceId, separationArcsec: sep });
      }
    }
  });
  return out;
}

export interface SimbadRow {
  readonly gaiaIdent: string; // "Gaia DR3 <id>"
  readonly oid: number;
  readonly entry: SimbadEntry;
}

export interface MergeResult {
  readonly entries: Record<string, SimbadEntry>;
  readonly matched: number;
  readonly unmatched: string[];
  /** Gaia ids for which SIMBAD returned more than one distinct object. Neither is chosen. */
  readonly conflicts: { readonly sourceId: string; readonly oids: readonly number[] }[];
  /** SIMBAD objects that matched more than one of our Gaia sources (blended or duplicated sources). */
  readonly sharedObjects: { readonly oid: number; readonly mainId: string; readonly sourceIds: readonly string[] }[];
}

const GAIA_PREFIX = 'Gaia DR3 ';

/**
 * Merge SIMBAD identifications into our Gaia ids by EXACT identifier match ("Gaia DR3 <source_id>"),
 * never by position, so a neighbouring star cannot be mis-assigned. SIMBAD complements Gaia; it never
 * overwrites Gaia astrometry or photometry.
 */
export function mergeSimbad(gaiaIds: readonly string[], rows: readonly SimbadRow[]): MergeResult {
  const byGaia = new Map<string, SimbadRow[]>();
  for (const r of rows) {
    if (!r.gaiaIdent.startsWith(GAIA_PREFIX)) continue;
    const id = r.gaiaIdent.slice(GAIA_PREFIX.length).trim();
    const list = byGaia.get(id);
    if (list) list.push(r);
    else byGaia.set(id, [r]);
  }
  const entries: Record<string, SimbadEntry> = {};
  const unmatched: string[] = [];
  const conflicts: { sourceId: string; oids: number[] }[] = [];
  const byOid = new Map<number, { mainId: string; ids: string[] }>();

  for (const id of gaiaIds) {
    const list = byGaia.get(id);
    if (!list) { unmatched.push(id); continue; }
    const oids = [...new Set(list.map((r) => r.oid))];
    if (oids.length > 1) { conflicts.push({ sourceId: id, oids }); continue; }
    const row = list[0]!;
    entries[id] = row.entry;
    const g = byOid.get(row.oid);
    if (g) g.ids.push(id);
    else byOid.set(row.oid, { mainId: row.entry.m, ids: [id] });
  }
  const sharedObjects = [...byOid.entries()]
    .filter(([, g]) => g.ids.length > 1)
    .map(([oid, g]) => ({ oid, mainId: g.mainId, sourceIds: g.ids }));
  return { entries, matched: Object.keys(entries).length, unmatched, conflicts, sharedObjects };
}
