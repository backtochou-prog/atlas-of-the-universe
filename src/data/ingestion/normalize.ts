import { GAIA_NUMERIC_COLUMNS, GAIA_REFERENCE_EPOCH, type GaiaNumericColumn } from '../catalogue/columns';
import type { GaiaRecord } from '../catalogue/flags';
import { validEquatorial } from '../../core/astro/coordinates';
import type { GaiaRawRow } from './gaia';

export interface RejectedRecord {
  readonly sourceId: string;
  readonly reasons: readonly string[];
  /** The parsed values, kept so a rejection can be audited. */
  readonly values: Readonly<Record<GaiaNumericColumn, number | null>>;
}

const ERROR_COLUMNS: readonly GaiaNumericColumn[] = [
  'ra_error', 'dec_error', 'parallax_error', 'pmra_error', 'pmdec_error',
  'phot_g_mean_flux_over_error', 'phot_bp_mean_flux_over_error', 'phot_rp_mean_flux_over_error',
  'astrometric_excess_noise', 'hip_sep_arcsec', 'teff_gspphot_lower', 'teff_gspphot_upper',
];

export const G_MAG_RANGE = { min: -5, max: 25 } as const;

/**
 * Hard validation. A record is REJECTED only when it is physically or structurally invalid.
 * Questionable-but-plausible records are kept and flagged elsewhere (see flags.ts); nothing is dropped silently.
 */
export function normalizeGaia(rows: readonly GaiaRawRow[]): { records: GaiaRecord[]; rejected: RejectedRecord[] } {
  const records: GaiaRecord[] = [];
  const rejected: RejectedRecord[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const reasons: string[] = [];
    const v = row.values;

    if (!/^\d{1,19}$/.test(row.sourceId)) reasons.push('invalid-source-id');
    else if (seen.has(row.sourceId)) reasons.push('duplicate-source-id');
    for (const issue of row.parseIssues) reasons.push(`parse: ${issue}`);
    if (row.refEpoch !== GAIA_REFERENCE_EPOCH) reasons.push(`unexpected-reference-epoch (${row.refEpoch})`);

    if (v.ra === null || v.dec === null || !validEquatorial(v.ra, v.dec)) reasons.push('invalid-coordinates');
    // A MISSING G magnitude is not invalid: real nearby stars can lack G photometry. They are kept and
    // flagged 'no-g-magnitude'. Only a G value that is present but implausible is rejected.
    if (v.phot_g_mean_mag !== null && (v.phot_g_mean_mag < G_MAG_RANGE.min || v.phot_g_mean_mag > G_MAG_RANGE.max)) {
      reasons.push('invalid-g-magnitude');
    }
    for (const col of ERROR_COLUMNS) {
      const x = v[col];
      if (x !== null && x < 0) reasons.push(`negative-${col}`);
    }
    for (const col of GAIA_NUMERIC_COLUMNS) {
      const x = v[col];
      if (x !== null && !Number.isFinite(x)) reasons.push(`non-finite-${col}`);
    }

    if (reasons.length > 0) {
      rejected.push({ sourceId: row.sourceId, reasons, values: v });
      continue;
    }
    seen.add(row.sourceId);
    records.push({ sourceId: row.sourceId, values: v, duplicatedSource: row.duplicatedSource });
  }
  return { records, rejected };
}
