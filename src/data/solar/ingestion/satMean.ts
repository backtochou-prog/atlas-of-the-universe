import { htmlToText } from './jplApprox';

/** One row of the JPL "Planetary Satellite Mean Elements" table. */
export interface SatMeanElements {
  readonly planet: string;
  readonly satellite: string;
  readonly naifId: number;
  readonly epoch: string;
  readonly aKm: number;
  readonly e: number;
  readonly periodDays: number;
  readonly frame: string;
}

const PLANETS = new Set(['Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto']);

/**
 * Parse https://ssd.jpl.nasa.gov/sats/elem/ . JPL warns these mean elements are "not intended for ephemeris
 * computation"; Atlas uses only the mean sidereal period, to keep the orbital phase from drifting.
 * The table renders one cell per line: id, planet, satellite, code, ephemeris, frame, epoch, a, e, w, M, i, node, P, ...
 */
export function parseSatMeanElements(html: string): SatMeanElements[] {
  const lines = htmlToText(html).split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const out: SatMeanElements[] = [];
  for (let k = 0; k + 14 < lines.length; k++) {
    if (!/^\d+$/.test(lines[k]!) || !PLANETS.has(lines[k + 1]!)) continue;
    const t = lines.slice(k, k + 15);
    const naifId = Number(t[3]);
    const epoch = t[6]!;
    const a = Number(t[7]!.replace(/\.$/, '')), e = Number(t[8]), P = Number(t[13]);
    if (![naifId, a, e, P].every(Number.isFinite) || !/^\d{4}-\d{2}-\d{2}/.test(epoch)) continue;
    out.push({ planet: t[1]!, satellite: t[2]!, naifId, epoch, aKm: a, e, periodDays: P, frame: t[5]! });
  }
  return out;
}
