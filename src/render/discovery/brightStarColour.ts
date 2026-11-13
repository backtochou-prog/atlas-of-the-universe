/**
 * Johnson B-V -> display colour for the Hipparcos supplement.
 *
 * The atlas's single colour ramp (src/render/starColour.ts) is keyed on the Gaia BP-RP index and is REUSED, not duplicated. B-V is
 * converted to BP-RP first with the published mean dwarf sequence of
 *   Pecaut & Mamajek (2013, ApJS 208, 9), Table 5, as maintained by E. Mamajek: "A Modern Mean Dwarf Stellar Color and Effective
 *   Temperature Sequence", version 2022.04.16, https://www.pas.rochester.edu/~emamajek/EEM_dwarf_UBVIJHK_colors_Teff.txt (retrieved 2026-11-13),
 * columns B-V and Bp-Rp (Gaia DR2 passbands; DR2 and DR3 BP-RP differ by a few hundredths of a magnitude, far below what a colour ramp resolves).
 * The pairs below are the table rows B9.5V ... M6V, copied unchanged. Linear interpolation between rows.
 *
 * LIMITS (VISUALISATION CHOICES): the relation is for dwarfs; giants and supergiants of the same B-V have a somewhat different BP-RP (the
 * difference is of the order of a few tenths of a magnitude in the red, inside the width of one ramp step). Outside the table the value is
 * clamped on the red side (B-V > 2.01) and extrapolated on the blue side (B-V < -0.05) with a flattened slope of 0.5, because
 * the Rayleigh-Jeans tail makes hot stars' colours change slowly; the table has no hot-star Bp-Rp. A star without B-V gets the ramp's neutral grey.
 *
 * Teff is NOT used for colour. (The Ballesteros 2012 B-V -> Teff relation is exposed for the inspector/tests: T = 4600 (1/(0.92 BV + 1.7) + 1/(0.92 BV + 0.62)) K.)
 */
import { colourFromBpRp, MISSING_COLOUR, type Rgb } from '../starColour';

/** [B-V, BP-RP] rows of the Pecaut & Mamajek mean dwarf sequence (see header). Strictly increasing in both. */
export const BV_TO_BPRP: readonly (readonly [number, number])[] = [
  [-0.05, -0.087], [0.0, -0.037], [0.035, 0.005], [0.07, 0.068], [0.1, 0.11], [0.14, 0.166], [0.16, 0.194], [0.185, 0.222], [0.21, 0.263],
  [0.25, 0.32], [0.27, 0.327], [0.295, 0.377], [0.33, 0.434], [0.37, 0.49], [0.39, 0.518], [0.41, 0.546], [0.44, 0.587], [0.486, 0.64],
  [0.5, 0.67], [0.53, 0.694], [0.56, 0.719], [0.58, 0.767], [0.595, 0.784], [0.622, 0.803], [0.65, 0.823], [0.68, 0.85], [0.7, 0.869],
  [0.73, 0.9], [0.775, 0.95], [0.816, 0.983], [0.857, 1.01], [0.884, 1.1], [0.99, 1.21], [1.09, 1.34], [1.15, 1.43], [1.24, 1.53],
  [1.34, 1.7], [1.42, 1.84], [1.445, 1.97], [1.485, 2.09], [1.505, 2.23], [1.522, 2.39], [1.53, 2.5], [1.6, 2.78], [1.65, 2.94],
  [1.69, 3.16], [1.83, 3.35], [1.94, 3.71], [2.01, 4.16],
];

const BLUE_SLOPE = 0.5;

/** BP-RP from B-V by the table above (null for a missing / non-finite input). */
export function bpRpFromBv(bv: number | null | undefined): number | null {
  if (bv === null || bv === undefined || !Number.isFinite(bv)) return null;
  const t = BV_TO_BPRP, first = t[0]!, last = t[t.length - 1]!;
  if (bv <= first[0]) return first[1] + BLUE_SLOPE * (bv - first[0]);
  if (bv >= last[0]) return last[1];
  let lo = 0, hi = t.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t[mid]![0] <= bv) lo = mid; else hi = mid; }
  const a = t[lo]!, b = t[hi]!;
  return a[1] + ((bv - a[0]) / (b[0] - a[0])) * (b[1] - a[1]);
}

/** Display colour for a B-V index through the shared ramp. */
export function colourFromBv(bv: number | null | undefined): Rgb {
  const x = bpRpFromBv(bv);
  return x === null ? MISSING_COLOUR : colourFromBpRp(x);
}

/** Ballesteros (2012, EPL 97, 34008) effective temperature from B-V, kelvin. Informational; not used for colour. */
export function teffFromBvBallesteros(bv: number): number {
  return 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
}
