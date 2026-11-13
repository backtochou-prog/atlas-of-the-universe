/**
 * Photometry helpers. All results are DERIVED quantities and say so.
 * Extinction (interstellar dust) is NOT modelled anywhere in Atlas yet.
 */

/** Absolute magnitude M = m - 5 log10(d/10 pc) = m - 5 log10(d) + 5, for d in parsecs. */
export function absoluteMagnitude(apparent: number, distancePc: number): number {
  if (!(distancePc > 0)) throw new Error('distance must be positive');
  return apparent - 5 * Math.log10(distancePc) + 5;
}

/** Apparent magnitude of an object of absolute magnitude M seen from distance d (pc), no extinction. */
export function apparentMagnitudeAt(absolute: number, distancePc: number): number {
  if (!(distancePc > 0)) throw new Error('distance must be positive');
  return absolute + 5 * Math.log10(distancePc) - 5;
}

/** Ratio of fluxes F1/F2 for magnitudes m1, m2. */
export const fluxRatio = (m1: number, m2: number): number => Math.pow(10, -0.4 * (m1 - m2));

/**
 * 1-sigma magnitude uncertainty from a flux signal-to-noise ratio: (2.5/ln 10)/SNR ~ 1.0857/SNR.
 * Excludes photometric zero-point calibration uncertainty, which is not in the catalogue columns used.
 */
export function magnitudeErrorFromFluxSnr(fluxOverError: number): number | null {
  return Number.isFinite(fluxOverError) && fluxOverError > 0 ? 1.0857362047581294 / fluxOverError : null;
}

/** BP-RP colour index and its propagated uncertainty (independent errors). */
export function colourIndex(
  bp: number | null,
  rp: number | null,
  bpErr: number | null,
  rpErr: number | null,
): { value: number; sigma: number | null } | null {
  if (bp === null || rp === null || !Number.isFinite(bp) || !Number.isFinite(rp)) return null;
  const sigma = bpErr !== null && rpErr !== null ? Math.hypot(bpErr, rpErr) : null;
  return { value: bp - rp, sigma };
}
