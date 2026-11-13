import { METRES_PER_AU, METRES_PER_GPC, METRES_PER_KPC, METRES_PER_LIGHT_YEAR, METRES_PER_MPC, METRES_PER_PARSEC } from '../units';

export interface DistanceUnit { readonly symbol: string; readonly metres: number }

/** Units a distance is expressed in, smallest to largest. The largest unit with a value of at least 1 is chosen. */
export const DISTANCE_UNITS: readonly DistanceUnit[] = [
  { symbol: 'm', metres: 1 }, { symbol: 'km', metres: 1e3 }, { symbol: 'AU', metres: METRES_PER_AU }, { symbol: 'ly', metres: METRES_PER_LIGHT_YEAR },
  { symbol: 'pc', metres: METRES_PER_PARSEC }, { symbol: 'kpc', metres: METRES_PER_KPC }, { symbol: 'Mpc', metres: METRES_PER_MPC }, { symbol: 'Gpc', metres: METRES_PER_GPC },
];

const SUPERSCRIPT: Record<string, string> = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
const superscript = (n: number): string => String(n).split('').map((c) => SUPERSCRIPT[c] ?? c).join('');

/** Readable number: plain for ordinary magnitudes, scientific notation for very large or small ones. */
export function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1e8 || a < 1e-2) {
    const e = Math.floor(Math.log10(a));
    return `${(v / 10 ** e).toFixed(2)}×10${superscript(e)}`;
  }
  if (a >= 1000) return Math.round(v).toLocaleString('en-US');
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

/** A distance in metres as "384,400 km", "1.00 AU", "4.24 ly" and so on, in the unit that keeps the number readable. */
export function formatDistance(metres: number): string {
  if (!(metres > 0) || !Number.isFinite(metres)) return '—';
  let chosen = DISTANCE_UNITS[0]!;
  for (const u of DISTANCE_UNITS) if (metres / u.metres >= 1) chosen = u;
  // Between 1 km and 1 AU the number of kilometres stays readable well past 10^6; switch to AU only from 0.1 AU.
  if (chosen.symbol === 'AU' && metres / METRES_PER_AU < 0.1) chosen = DISTANCE_UNITS[1]!;
  return `${formatNumber(metres / chosen.metres)} ${chosen.symbol}`;
}
