/**
 * Merge catalogue point rows that are the SAME galaxy as a curated deep-space galaxy (Prompt 07, F1).
 *
 * The McConnachie row "Andromeda" and the curated Andromeda Galaxy (M31) are one object; so are the UNGC / McConnachie rows LMC, SMC, M32, NGC5128 ... and
 * the 2MRS rows that sit on a curated galaxy. The rule is the structure renderer's (duplicates.ts: name / alias / position match), so the atlas search, the
 * drawing and the inspector agree on what is one object. The curated record WINS (its image, notes, view rules); it keeps the row's names as extra designations
 * (still searchable), lists the row's id in `sameAs`, and the row's id becomes an alias of the curated id (clicks on the point resolve to the curated record).
 * Only `galaxy` rows against curated `galaxy` records; nothing else is merged here (stars merge in records.ts mergeRecords).
 */
import { buildDuplicateIndex, findImageGalaxyDuplicate, normaliseDesignation } from './duplicates';
import type { DiscoveryRecord, UniversalId } from './types';

export interface PointMergeResult {
  /** The point rows that are NOT duplicates of a curated galaxy, in input order. */
  readonly kept: DiscoveryRecord[];
  /** Curated records that gained designations / sameAs (same id, new object); callers replace theirs. */
  readonly updated: Map<UniversalId, DiscoveryRecord>;
  /** point id -> curated id, for every merged row. */
  readonly aliases: Map<UniversalId, UniversalId>;
}

const skyOf = (r: DiscoveryRecord): { ra: number; dec: number } | null =>
  r.position.kind === 'solar' ? null : Number.isFinite(r.position.raDeg) && Number.isFinite(r.position.decDeg) ? { ra: r.position.raDeg, dec: r.position.decDeg } : null;

export function mergePointDuplicates(curated: readonly DiscoveryRecord[], points: readonly DiscoveryRecord[]): PointMergeResult {
  const galaxies = curated.filter((r) => r.category === 'galaxy' && r.dataset === 'deep-space');
  const ref = galaxies.map((g) => { const s = skyOf(g); return { id: g.id, designations: g.designations, name: g.name, ...(s ? { raDeg: s.ra, decDeg: s.dec } : {}) }; });
  const idx = buildDuplicateIndex(ref);
  const byId = new Map(galaxies.map((g) => [g.id, g] as const));
  const extra = new Map<UniversalId, { desig: string[]; same: UniversalId[] }>();
  const kept: DiscoveryRecord[] = [];
  const aliases = new Map<UniversalId, UniversalId>();
  for (const p of points) {
    let owner: UniversalId | undefined;
    if (p.category === 'galaxy') {
      const s = skyOf(p);
      const first = findImageGalaxyDuplicate(idx, p.name, s ? s.ra : NaN, s ? s.dec : NaN);
      owner = first?.id;
      if (owner === undefined && first === null) {
        for (let k = 1; k < p.designations.length && owner === undefined; k++) {
          if (p.designations[k] === p.name) continue;
          owner = findImageGalaxyDuplicate(idx, p.designations[k]!, NaN, NaN)?.id;
        }
      }
    }
    if (owner === undefined || !byId.has(owner)) { kept.push(p); continue; }
    aliases.set(p.id, owner);
    let e = extra.get(owner);
    if (!e) { e = { desig: [], same: [] }; extra.set(owner, e); }
    e.desig.push(p.name, ...p.designations);
    e.same.push(p.id);
  }
  const updated = new Map<UniversalId, DiscoveryRecord>();
  for (const [id, e] of extra) {
    const rec = byId.get(id)!;
    const seen = new Set(rec.designations.map(normaliseDesignation));
    const designations = [...rec.designations];
    for (const d of e.desig) { const n = normaliseDesignation(d); if (n.length > 0 && !seen.has(n)) { seen.add(n); designations.push(d); } }
    updated.set(id, { ...rec, designations, sameAs: [...new Set([...(rec.sameAs ?? []), ...e.same])] });
  }
  return { kept, updated, aliases };
}
