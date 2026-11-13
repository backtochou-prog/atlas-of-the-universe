import type { Vec3 } from '../spatial/vec3';
import { DEG_TO_RAD } from '../astro/constants';
import { METRES_PER_AU } from '../units';
import { solveKepler, wrapPi } from './kepler';
import { apply, rotX, type Mat3 } from './mat3';

/** Classical Keplerian elements. Lengths in metres, angles in radians. */
export interface KeplerElements {
  readonly a: number;
  readonly e: number;
  readonly inclination: number;
  /** Longitude of the ascending node. */
  readonly node: number;
  /** Argument of periapsis. */
  readonly argPeri: number;
  /** Mean anomaly at the time of evaluation. */
  readonly meanAnomaly: number;
}

/**
 * Position in the reference frame of the elements (the frame whose x-axis points to the ascending node reference),
 * from Rz(node) Rx(i) Rz(argPeri) applied to the perifocal position.
 */
export function positionFromElements(el: KeplerElements): Vec3 {
  const E = solveKepler(el.meanAnomaly, el.e);
  const xp = el.a * (Math.cos(E) - el.e);
  const yp = el.a * Math.sqrt(1 - el.e * el.e) * Math.sin(E);
  const cw = Math.cos(el.argPeri), sw = Math.sin(el.argPeri);
  const ci = Math.cos(el.inclination), si = Math.sin(el.inclination);
  const cO = Math.cos(el.node), sO = Math.sin(el.node);
  const x1 = xp * cw - yp * sw;
  const y1 = xp * sw + yp * cw;
  const y2 = y1 * ci;
  const z2 = y1 * si;
  return [x1 * cO - y2 * sO, x1 * sO + y2 * cO, z2];
}

/** Points along the orbit at uniform eccentric anomaly, as a flat Float64Array of x,y,z. */
export function orbitPath(el: KeplerElements, segments = 256): Float64Array {
  const out = new Float64Array(segments * 3);
  const cw = Math.cos(el.argPeri), sw = Math.sin(el.argPeri);
  const ci = Math.cos(el.inclination), si = Math.sin(el.inclination);
  const cO = Math.cos(el.node), sO = Math.sin(el.node);
  const b = el.a * Math.sqrt(1 - el.e * el.e);
  for (let k = 0; k < segments; k++) {
    const E = (2 * Math.PI * k) / segments;
    const xp = el.a * (Math.cos(E) - el.e), yp = b * Math.sin(E);
    const x1 = xp * cw - yp * sw, y1 = xp * sw + yp * cw;
    const y2 = y1 * ci, z2 = y1 * si;
    out[3 * k] = x1 * cO - y2 * sO;
    out[3 * k + 1] = x1 * sO + y2 * cO;
    out[3 * k + 2] = z2;
  }
  return out;
}

/** Obliquity of the ecliptic at J2000 as stated on the JPL "Approximate Positions of the Planets" page. */
export const OBLIQUITY_J2000_DEG = 23.43928;
export const ECLIPTIC_TO_ICRS: Mat3 = rotX(OBLIQUITY_J2000_DEG * DEG_TO_RAD);

/** Rotate a vector from the mean ecliptic and equinox of J2000 to the equatorial J2000 (ICRF) frame. */
export const eclipticToIcrs = (v: Vec3): Vec3 => apply(ECLIPTIC_TO_ICRS, v);

/** [value at J2000, rate per Julian century]. */
export type Rate = readonly [number, number];

/** Keplerian elements and rates as tabulated by JPL SSD (Standish) for the major planets. a in au, angles in degrees. */
export interface JplApproxElements {
  readonly a: Rate;
  readonly e: Rate;
  readonly I: Rate;
  /** Mean longitude. */
  readonly L: Rate;
  /** Longitude of perihelion. */
  readonly longPeri: Rate;
  readonly longNode: Rate;
}

/** Elements at T Julian centuries from J2000: a = a0 + a' T, etc.; argument of perihelion = long.peri - long.node; M = L - long.peri. */
export function jplApproxToElements(el: JplApproxElements, T: number): KeplerElements {
  const at = (r: Rate) => r[0] + r[1] * T;
  const longPeri = at(el.longPeri) * DEG_TO_RAD;
  const node = at(el.longNode) * DEG_TO_RAD;
  return {
    a: at(el.a) * METRES_PER_AU,
    e: at(el.e),
    inclination: at(el.I) * DEG_TO_RAD,
    node,
    argPeri: longPeri - node,
    meanAnomaly: wrapPi(at(el.L) * DEG_TO_RAD - longPeri),
  };
}

/** Elements for a body whose elements are given at an epoch and advanced by a constant mean motion. */
export function advanceMeanAnomaly(el: KeplerElements, meanMotionRadPerDay: number, days: number): KeplerElements {
  return { ...el, meanAnomaly: wrapPi(el.meanAnomaly + meanMotionRadPerDay * days) };
}
