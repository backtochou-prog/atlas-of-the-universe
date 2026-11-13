import { parallaxToDistance } from '../../core/astro/parallax';
import { HIGH_RUWE, qualityFlags, type GaiaRecord, type QualityFlag } from '../catalogue/flags';
import type { HipConflict, PositionalDuplicate } from './crossid';
import type { RejectedRecord } from './normalize';

export interface QualityReport {
  readonly datasetId: string;
  readonly generatedAt: string;
  readonly counts: {
    readonly queryRows: number;
    readonly imported: number;
    readonly rejected: number;
    readonly rejectedByReason: Readonly<Record<string, number>>;
  };
  readonly distance: {
    readonly reliable: number;
    readonly marginal: number;
    readonly unreliable: number;
    readonly invalid: number;
    readonly missing: number;
    readonly placedIn3d: number;
    readonly notPlacedIn3d: number;
    /** Placed in 3D AND has a G magnitude, i.e. actually drawn by the renderer. */
    readonly drawable: number;
  };
  readonly missingValues: {
    readonly parallax: number;
    readonly properMotion: number;
    readonly bpRp: number;
    readonly teffGspphot: number;
  };
  readonly flags: Readonly<Record<QualityFlag, number>>;
  readonly highRuweThreshold: number;
  readonly crossIdentification: {
    readonly hipparcosMatched: number;
    readonly hipparcosConflictGroups: number;
    readonly hipparcosConflictSources: number;
    readonly positionalDuplicateCandidates: number;
    readonly simbad?: {
      readonly requested: number;
      readonly matched: number;
      readonly unmatched: number;
      readonly conflicts: number;
      readonly sharedObjects: number;
    };
  };
  /** Full list: nothing is dropped without a record. */
  readonly rejected: readonly RejectedRecord[];
  readonly hipConflicts: readonly HipConflict[];
  readonly positionalDuplicates: readonly PositionalDuplicate[];
  readonly notes: readonly string[];
}

const ALL_FLAGS: readonly QualityFlag[] = [
  'no-parallax', 'parallax-invalid', 'parallax-unreliable', 'parallax-marginal', 'no-proper-motion', 'no-g-magnitude', 'no-bp-rp', 'high-ruwe',
  'two-parameter-solution', 'duplicated-source', 'unreasonable-parallax', 'unreasonable-proper-motion', 'hip-large-separation',
];

export function buildQualityReport(input: {
  datasetId: string;
  generatedAt: string;
  queryRows: number;
  records: readonly GaiaRecord[];
  rejected: readonly RejectedRecord[];
  hipConflicts: readonly HipConflict[];
  positionalDuplicates: readonly PositionalDuplicate[];
  maxPlacementDistancePc: number;
  notes?: readonly string[];
}): QualityReport {
  const flags = Object.fromEntries(ALL_FLAGS.map((f) => [f, 0])) as Record<QualityFlag, number>;
  const dist = { reliable: 0, marginal: 0, unreliable: 0, invalid: 0, missing: 0 };
  let placed = 0, drawable = 0, missingPm = 0, missingBpRp = 0, missingTeff = 0, hip = 0;

  for (const rec of input.records) {
    const d = parallaxToDistance(rec.values.parallax, rec.values.parallax_error);
    dist[d.status]++;
    if ((d.status === 'reliable' || d.status === 'marginal') && d.distancePc! <= input.maxPlacementDistancePc) {
      placed++;
      if (rec.values.phot_g_mean_mag !== null) drawable++;
    }
    for (const f of qualityFlags(rec, d)) flags[f]++;
    if (rec.values.pmra === null || rec.values.pmdec === null) missingPm++;
    if (rec.values.phot_bp_mean_mag === null || rec.values.phot_rp_mean_mag === null) missingBpRp++;
    if (rec.values.teff_gspphot === null) missingTeff++;
    if (rec.values.hip_id !== null) hip++;
  }
  const byReason: Record<string, number> = {};
  for (const r of input.rejected) for (const reason of r.reasons) byReason[reason] = (byReason[reason] ?? 0) + 1;

  return {
    datasetId: input.datasetId,
    generatedAt: input.generatedAt,
    counts: { queryRows: input.queryRows, imported: input.records.length, rejected: input.rejected.length, rejectedByReason: byReason },
    distance: { ...dist, placedIn3d: placed, notPlacedIn3d: input.records.length - placed, drawable },
    missingValues: { parallax: dist.missing, properMotion: missingPm, bpRp: missingBpRp, teffGspphot: missingTeff },
    flags,
    highRuweThreshold: HIGH_RUWE,
    crossIdentification: {
      hipparcosMatched: hip,
      hipparcosConflictGroups: input.hipConflicts.length,
      hipparcosConflictSources: input.hipConflicts.reduce((n, c) => n + c.sourceIds.length, 0),
      positionalDuplicateCandidates: input.positionalDuplicates.length,
    },
    rejected: input.rejected,
    hipConflicts: input.hipConflicts,
    positionalDuplicates: input.positionalDuplicates,
    notes: input.notes ?? [],
  };
}
