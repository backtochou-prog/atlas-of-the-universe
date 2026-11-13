import { parallaxToDistance, type ParallaxDistance } from '../../core/astro/parallax';
import type { GaiaNumericColumn } from './columns';

/** Browser-safe record shape shared by the importer and the catalogue reader. */
export interface GaiaRecord {
  readonly sourceId: string;
  readonly values: Readonly<Record<GaiaNumericColumn, number | null>>;
  readonly duplicatedSource: boolean | null;
}

export const HIGH_RUWE = 1.4;
export const MAX_PLAUSIBLE_PARALLAX_MAS = 1000; // Proxima Centauri is ~768 mas
export const MAX_PLAUSIBLE_PM_MAS_YR = 15000; // Barnard's star is ~10 400 mas/yr
export const HIP_MAX_SEPARATION_ARCSEC = 1.0;

export type QualityFlag =
  | 'no-parallax'
  | 'parallax-invalid'
  | 'parallax-unreliable'
  | 'parallax-marginal'
  | 'no-proper-motion'
  | 'no-g-magnitude'
  | 'no-bp-rp'
  | 'high-ruwe'
  | 'two-parameter-solution'
  | 'duplicated-source'
  | 'unreasonable-parallax'
  | 'unreasonable-proper-motion'
  | 'hip-large-separation';

/** Soft quality flags. A flagged record is KEPT and the flag is shown to the user. */
export function qualityFlags(rec: GaiaRecord, dist: ParallaxDistance = parallaxToDistance(rec.values.parallax, rec.values.parallax_error)): QualityFlag[] {
  const v = rec.values;
  const f: QualityFlag[] = [];
  switch (dist.status) {
    case 'missing': f.push('no-parallax'); break;
    case 'invalid': f.push('parallax-invalid'); break;
    case 'unreliable': f.push('parallax-unreliable'); break;
    case 'marginal': f.push('parallax-marginal'); break;
    default: break;
  }
  if (v.pmra === null || v.pmdec === null) f.push('no-proper-motion');
  if (v.phot_g_mean_mag === null) f.push('no-g-magnitude');
  if (v.phot_bp_mean_mag === null || v.phot_rp_mean_mag === null) f.push('no-bp-rp');
  if (v.ruwe !== null && v.ruwe > HIGH_RUWE) f.push('high-ruwe');
  if (v.astrometric_params_solved === 3) f.push('two-parameter-solution');
  if (rec.duplicatedSource === true) f.push('duplicated-source');
  if (v.parallax !== null && Math.abs(v.parallax) > MAX_PLAUSIBLE_PARALLAX_MAS) f.push('unreasonable-parallax');
  if (v.pmra !== null && v.pmdec !== null && Math.hypot(v.pmra, v.pmdec) > MAX_PLAUSIBLE_PM_MAS_YR) f.push('unreasonable-proper-motion');
  if (v.hip_sep_arcsec !== null && v.hip_sep_arcsec > HIP_MAX_SEPARATION_ARCSEC) f.push('hip-large-separation');
  return f;
}

export const FLAG_DESCRIPTIONS: Readonly<Record<QualityFlag, string>> = {
  'no-parallax': 'The catalogue has no parallax for this source; it has no distance here.',
  'parallax-invalid': 'A parallax is present but its uncertainty is missing or non-positive.',
  'parallax-unreliable': 'Parallax/error < 5 or parallax <= 0; no distance is inferred.',
  'parallax-marginal': 'Parallax/error between 5 and 10; the inverse-parallax distance is biased.',
  'no-proper-motion': 'No proper motion in the catalogue.',
  'no-g-magnitude': 'No G-band photometry in the catalogue: the star has a position but no brightness, so Atlas does not draw it.',
  'no-bp-rp': 'BP and/or RP photometry missing; colour is unavailable.',
  'high-ruwe': 'RUWE > 1.4: the single-star astrometric solution fits poorly (binary or other problem).',
  'two-parameter-solution': 'Only a 2-parameter (position) solution: no parallax or proper motion was fitted.',
  'duplicated-source': 'Gaia flags this as a duplicated source entry.',
  'unreasonable-parallax': 'Parallax magnitude beyond any known star; kept but suspicious.',
  'unreasonable-proper-motion': 'Proper motion beyond any known star; kept but suspicious.',
  'hip-large-separation': 'Hipparcos cross-match separation exceeds 1 arcsec. Sources with no Gaia proper motion are expected to show this (unmodelled motion between epochs); otherwise verify the match.',
};
