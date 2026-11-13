/**
 * Duplicate rule between catalogue rows and the curated (image) galaxies: ONE pure implementation shared by
 *  - the structure renderer (src/render/deep-space/GalaxyClusterRenderer.ts skips a catalogue row that is an image galaxy drawn elsewhere), and
 *  - the discovery engine (workerEngine.ts merges such a row into the curated record: the curated record wins, the row's names stay searchable).
 * Documented and tested in tests/deepspace-render-structure.test.ts and tests/discovery-duplicates.test.ts.
 *
 * A row is the same galaxy as a curated one when (1) its normalised name equals a normalised designation / name of the curated object (directly or through
 * NAME_ALIASES), or (2) it lies within DUPLICATE_MATCH_ARCMIN of a curated galaxy's catalogue position (used when the row has no usable name, e.g. 2MRS).
 */
import { angularSeparationDeg } from '../core/astro/coordinates';

/**
 * Normalised designation: upper case, spaces and punctuation removed, "MESSIER" read as "M", leading zeros of the number dropped
 * ("MESSIER031" -> "M31", "NGC 0224" -> "NGC224", "M 31" -> "M31").
 */
export function normaliseDesignation(s: string): string {
  let t = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  t = t.replace(/^MESSIER/, 'M');
  t = t.replace(/^([A-Z]+)0+(\d)/, '$1$2');
  return t;
}

/**
 * Catalogue spellings that are not designations of the image galaxy but ARE the same object (McConnachie 2012 names M31 and M33
 * "Andromeda" and "Triangulum"; the UNGC has a row "Milky Way", which is drawn from the documented model). Keys normalised.
 */
export const NAME_ALIASES: Readonly<Record<string, string>> = { ANDROMEDA: 'M31', TRIANGULUM: 'M33', MILKYWAY: 'MILKYWAYGALAXY' };
/** Positional match radius (arcmin) for rows with no usable name (2MRS rows carry 2MASS ids, not designations). */
export const DUPLICATE_MATCH_ARCMIN = 0.25;

export interface ImageGalaxyRef {
  /** Optional: returned by findImageGalaxyDuplicate so the caller knows WHICH curated object a row repeats. */
  readonly id?: string;
  readonly designations: readonly string[];
  readonly name: string;
  readonly raDeg?: number;
  readonly decDeg?: number;
}
export interface DuplicateIndex {
  readonly names: ReadonlySet<string>;
  /** Normalised name -> id of the curated object that owns it (only for refs given an id). */
  readonly nameOwner: ReadonlyMap<string, string>;
  readonly sky: readonly { readonly ra: number; readonly dec: number; readonly id?: string }[];
}

export function buildDuplicateIndex(galaxies: readonly ImageGalaxyRef[]): DuplicateIndex {
  const names = new Set<string>();
  const nameOwner = new Map<string, string>();
  const sky: { ra: number; dec: number; id?: string }[] = [];
  for (const g of galaxies) {
    for (const d of [...g.designations, g.name]) {
      const n = normaliseDesignation(d);
      names.add(n);
      if (g.id !== undefined && !nameOwner.has(n)) nameOwner.set(n, g.id);
    }
    if (g.raDeg !== undefined && g.decDeg !== undefined && Number.isFinite(g.raDeg) && Number.isFinite(g.decDeg)) sky.push({ ra: g.raDeg, dec: g.decDeg, ...(g.id !== undefined ? { id: g.id } : {}) });
  }
  return { names, nameOwner, sky };
}

/**
 * Which curated galaxy a row repeats: { matched: true, id } (id is undefined for refs built without ids), or null. Name rule first, then position.
 */
export function findImageGalaxyDuplicate(idx: DuplicateIndex, name: string | null, raDeg: number, decDeg: number): { readonly id: string | undefined } | null {
  if (name) {
    const n = normaliseDesignation(name);
    if (idx.names.has(n)) return { id: idx.nameOwner.get(n) };
    const alias = NAME_ALIASES[n];
    if (alias && idx.names.has(alias)) return { id: idx.nameOwner.get(alias) };
  }
  const tol = DUPLICATE_MATCH_ARCMIN / 60;
  for (const s of idx.sky) {
    if (Math.abs(s.dec - decDeg) > tol) continue;
    if (angularSeparationDeg(s.ra, s.dec, raDeg, decDeg) <= tol) return { id: s.id };
  }
  return null;
}

/** True when the row is an image galaxy drawn elsewhere: its (alias-resolved) name matches a designation, or it lies within DUPLICATE_MATCH_ARCMIN of one. */
export function isImageGalaxyDuplicate(idx: DuplicateIndex, name: string | null, raDeg: number, decDeg: number): boolean {
  return findImageGalaxyDuplicate(idx, name, raDeg, decDeg) !== null;
}
