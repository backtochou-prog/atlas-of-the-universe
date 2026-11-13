import { add, scale, type Vec3 } from '../spatial/vec3';
import { DEG_TO_RAD, KM_S_PER_AU_YR, MAS_PER_DEG, RAD_TO_DEG } from './constants';

/**
 * Conventions
 * - Equatorial coordinates are ICRS right ascension (alpha) and declination (delta), in DEGREES.
 * - Cartesian axes are ICRS-aligned: +X toward (alpha=0, delta=0), +Y toward (alpha=90deg, delta=0),
 *   +Z toward the north celestial pole. Right-handed.
 * - Galactic coordinates (l, b) are in DEGREES, using the IAU 1958 galactic system as defined
 *   relative to ICRS by the Hipparcos/Gaia matrix below.
 * - Proper motions are in mas/yr, with pmra = mu_alpha* = mu_alpha cos(delta) as published by Gaia.
 */

export function equatorialToUnit(raDeg: number, decDeg: number): Vec3 {
  const a = raDeg * DEG_TO_RAD;
  const d = decDeg * DEG_TO_RAD;
  const cd = Math.cos(d);
  return [cd * Math.cos(a), cd * Math.sin(a), Math.sin(d)];
}

/** Direction of increasing right ascension at (alpha, delta). */
export function eastUnit(raDeg: number): Vec3 {
  const a = raDeg * DEG_TO_RAD;
  return [-Math.sin(a), Math.cos(a), 0];
}

/** Direction of increasing declination at (alpha, delta). */
export function northUnit(raDeg: number, decDeg: number): Vec3 {
  const a = raDeg * DEG_TO_RAD;
  const d = decDeg * DEG_TO_RAD;
  return [-Math.sin(d) * Math.cos(a), -Math.sin(d) * Math.sin(a), Math.cos(d)];
}

export function unitToEquatorial(v: Vec3): { raDeg: number; decDeg: number } {
  const r = Math.hypot(v[0], v[1], v[2]);
  if (!(r > 0)) throw new Error('Cannot convert a zero vector to equatorial coordinates');
  let ra = Math.atan2(v[1], v[0]) * RAD_TO_DEG;
  if (ra < 0) ra += 360;
  if (ra >= 360) ra -= 360;
  const dec = Math.asin(Math.max(-1, Math.min(1, v[2] / r))) * RAD_TO_DEG;
  return { raDeg: ra, decDeg: dec };
}

/** Position from (alpha, delta) and a distance in any length unit. The result uses that unit. */
export function sphericalToCartesian(raDeg: number, decDeg: number, distance: number): Vec3 {
  return scale(equatorialToUnit(raDeg, decDeg), distance);
}

export function validEquatorial(raDeg: number, decDeg: number): boolean {
  return (
    Number.isFinite(raDeg) && Number.isFinite(decDeg) && raDeg >= 0 && raDeg < 360 && decDeg >= -90 && decDeg <= 90
  );
}

/**
 * ICRS -> Galactic rotation matrix A_G' (ESA 1997, Hipparcos and Tycho Catalogues, Vol. 1, Sect. 1.5.3;
 * reproduced in the Gaia DR3 documentation). Row i gives galactic axis i in ICRS components, so
 * v_galactic = M * v_icrs and v_icrs = M^T * v_galactic.
 */
export const ICRS_TO_GALACTIC: readonly [Vec3, Vec3, Vec3] = [
  [-0.0548755604162154, -0.873437090234885, -0.4838350155487132],
  [0.4941094278755837, -0.4448296299600112, 0.7469822444972189],
  [-0.8676661490190047, -0.1980763734312015, 0.4559837761750669],
];

const M = ICRS_TO_GALACTIC;

export function icrsToGalacticVector(v: Vec3): Vec3 {
  return [
    M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
    M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
    M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2],
  ];
}

export function galacticToIcrsVector(v: Vec3): Vec3 {
  return [
    M[0][0] * v[0] + M[1][0] * v[1] + M[2][0] * v[2],
    M[0][1] * v[0] + M[1][1] * v[1] + M[2][1] * v[2],
    M[0][2] * v[0] + M[1][2] * v[1] + M[2][2] * v[2],
  ];
}

export function equatorialToGalactic(raDeg: number, decDeg: number): { lDeg: number; bDeg: number } {
  const g = icrsToGalacticVector(equatorialToUnit(raDeg, decDeg));
  const { raDeg: l, decDeg: b } = unitToEquatorial(g);
  return { lDeg: l, bDeg: b };
}

export function galacticToEquatorial(lDeg: number, bDeg: number): { raDeg: number; decDeg: number } {
  return unitToEquatorial(galacticToIcrsVector(equatorialToUnit(lDeg, bDeg)));
}

/** Great-circle separation in degrees (Vincenty form; stable for small and antipodal angles). */
export function angularSeparationDeg(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const a1 = ra1 * DEG_TO_RAD, d1 = dec1 * DEG_TO_RAD, a2 = ra2 * DEG_TO_RAD, d2 = dec2 * DEG_TO_RAD;
  const dl = a2 - a1;
  const x = Math.cos(d2) * Math.sin(dl);
  const y = Math.cos(d1) * Math.sin(d2) - Math.sin(d1) * Math.cos(d2) * Math.cos(dl);
  const z = Math.sin(d1) * Math.sin(d2) + Math.cos(d1) * Math.cos(d2) * Math.cos(dl);
  return Math.atan2(Math.hypot(x, y), z) * RAD_TO_DEG;
}

export interface ProperMotion {
  /** mu_alpha* = mu_alpha cos(delta), mas/yr. */
  readonly pmraMasYr: number;
  readonly pmdecMasYr: number;
}

/**
 * Propagate a position along its proper motion as constant-rate motion on a great circle,
 * assuming ZERO radial velocity (no perspective acceleration). Exact for any step size under
 * that assumption; it is NOT the rigorous space-motion model, which needs radial velocity.
 * Returns degrees.
 */
export function propagateProperMotion(
  raDeg: number,
  decDeg: number,
  pm: ProperMotion,
  dtYears: number,
): { raDeg: number; decDeg: number } {
  const dEast = ((pm.pmraMasYr * dtYears) / MAS_PER_DEG) * DEG_TO_RAD;
  const dNorth = ((pm.pmdecMasYr * dtYears) / MAS_PER_DEG) * DEG_TO_RAD;
  const theta = Math.hypot(dEast, dNorth);
  const u = equatorialToUnit(raDeg, decDeg);
  if (theta === 0) return { raDeg, decDeg };
  const t = add(scale(eastUnit(raDeg), dEast / theta), scale(northUnit(raDeg, decDeg), dNorth / theta));
  return unitToEquatorial(add(scale(u, Math.cos(theta)), scale(t, Math.sin(theta))));
}

/** Tangential velocity in km/s from proper motion (mas/yr) and distance (pc): 4.74047 * mu * d / 1000. */
export function tangentialVelocityKmS(pmraMasYr: number, pmdecMasYr: number, distancePc: number): number {
  return (KM_S_PER_AU_YR * Math.hypot(pmraMasYr, pmdecMasYr) * distancePc) / 1000;
}
