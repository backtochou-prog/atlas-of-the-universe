import type { Vec3 } from '../spatial/vec3';
import { DEG_TO_RAD, RAD_TO_DEG } from '../astro/constants';
import { apply, column, mul, rotX, rotZ, transpose, type Mat3 } from './mat3';
import { centuriesSinceJ2000, daysSinceJ2000 } from './time';

/**
 * IAU body orientation (WGCCRE): the pole right ascension and declination and the prime-meridian angle W are
 * linear in time. Only the linear terms are used. The periodic nutation, precession and libration terms (for example
 * the Moon's librations or Neptune's sinusoidal terms) are NOT modelled, which limits the orientation accuracy to
 * a fraction of a degree for most bodies and a few degrees for the Moon.
 */
export interface RotationElements {
  /** [value at J2000 (deg), rate (deg per Julian century)]. */
  readonly poleRa: readonly [number, number];
  readonly poleDec: readonly [number, number];
  /** [W0 (deg), rate (deg per day)]. A negative rate means retrograde rotation under the IAU positive-pole rule. */
  readonly primeMeridian: readonly [number, number];
}

export function poleDirection(rot: RotationElements, jdTdb: number): Vec3 {
  const T = centuriesSinceJ2000(jdTdb);
  const ra = (rot.poleRa[0] + rot.poleRa[1] * T) * DEG_TO_RAD;
  const dec = (rot.poleDec[0] + rot.poleDec[1] * T) * DEG_TO_RAD;
  return [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
}

/**
 * Rotation matrix taking body-fixed coordinates to ICRS: Rz(ra + 90 deg) Rx(90 deg - dec) Rz(W).
 * Body-fixed +z is the north pole, +x the prime meridian at the equator, +y 90 degrees east.
 */
export function bodyFixedToIcrs(rot: RotationElements, jdTdb: number): Mat3 {
  const T = centuriesSinceJ2000(jdTdb);
  const d = daysSinceJ2000(jdTdb);
  const ra = (rot.poleRa[0] + rot.poleRa[1] * T) * DEG_TO_RAD;
  const dec = (rot.poleDec[0] + rot.poleDec[1] * T) * DEG_TO_RAD;
  const W = (rot.primeMeridian[0] + rot.primeMeridian[1] * d) * DEG_TO_RAD;
  return mul(mul(rotZ(ra + Math.PI / 2), rotX(Math.PI / 2 - dec)), rotZ(W));
}

/** Planetocentric longitude (deg, east positive, in (-180, 180]) and latitude (deg) of the point where a direction (in ICRS) meets the body. */
export function subPoint(rot: RotationElements, jdTdb: number, directionIcrs: Vec3): { lonDeg: number; latDeg: number } {
  const v = apply(transpose(bodyFixedToIcrs(rot, jdTdb)), directionIcrs);
  const r = Math.hypot(v[0], v[1], v[2]);
  return { lonDeg: Math.atan2(v[1], v[0]) * RAD_TO_DEG, latDeg: Math.asin(v[2] / r) * RAD_TO_DEG };
}

export { column as bodyAxis };
