import type { Measurement } from '../../data/schema';
import { DEG_TO_RAD } from '../astro/constants';
import { eastUnit, equatorialToUnit, northUnit } from '../astro/coordinates';
import { add, cross, dot, normalise, scale, type Vec3 } from '../spatial/vec3';
import { METRES_PER_AU, METRES_PER_GPC, METRES_PER_KM, METRES_PER_KPC, METRES_PER_LIGHT_YEAR, METRES_PER_MPC, METRES_PER_PARSEC } from '../units';

/** Everything here is float64 and pure. Angles in degrees at the API, radians inside. */

const METRES_PER_UNIT: Readonly<Record<string, number>> = {
  m: 1, km: METRES_PER_KM, AU: METRES_PER_AU, au: METRES_PER_AU, ly: METRES_PER_LIGHT_YEAR,
  pc: METRES_PER_PARSEC, kpc: METRES_PER_KPC, Mpc: METRES_PER_MPC, Gpc: METRES_PER_GPC,
};

export interface ValueWithSigma { readonly value: number; readonly unit: string; readonly uncertainty?: number }

export function metresPerUnit(unit: string): number {
  const f = METRES_PER_UNIT[unit];
  if (f === undefined) throw new Error(`Unknown length unit "${unit}"`);
  return f;
}
export function lengthToMetres(value: number, unit: string): number { return value * metresPerUnit(unit); }
export function lengthToParsecs(value: number, unit: string): number { return (value * metresPerUnit(unit)) / METRES_PER_PARSEC; }

/** Distance (metres) and its 1-sigma uncertainty (metres, 0 when unpublished). `uncertaintyPublished` says which. */
export function distanceMetres(d: ValueWithSigma): { metres: number; sigmaMetres: number; uncertaintyPublished: boolean } {
  if (!(d.value > 0) || !Number.isFinite(d.value)) throw new RangeError(`Distance must be positive and finite, got ${d.value}`);
  const f = metresPerUnit(d.unit);
  const published = d.uncertainty !== undefined && Number.isFinite(d.uncertainty);
  return { metres: d.value * f, sigmaMetres: published ? Math.abs(d.uncertainty as number) * f : 0, uncertaintyPublished: published };
}

/** Physical extent of an object of angular size `angularArcmin` at `distanceMetres`: 2 d tan(theta/2). Exact, not small-angle. */
export function physicalSizeMetres(angularArcmin: number, distanceMetres: number): number {
  if (!(angularArcmin >= 0) || !(distanceMetres > 0)) throw new RangeError('angular size must be >= 0 and distance > 0');
  const half = (angularArcmin / 60) * DEG_TO_RAD * 0.5;
  if (half >= Math.PI / 2) throw new RangeError('angular size must be below 180 degrees');
  return 2 * distanceMetres * Math.tan(half);
}

/** Inverse of physicalSizeMetres: angular diameter in arcmin of an object of `sizeMetres` at `distanceMetres`. */
export function angularSizeArcmin(sizeMetres: number, distanceMetres: number): number {
  return (2 * Math.atan(sizeMetres / (2 * distanceMetres))) / DEG_TO_RAD * 60;
}

export interface SizeEstimate { readonly metres: number; readonly sigmaMetres: number; readonly uncertaintyPublished: boolean }

/**
 * Physical size with first-order propagation of the distance (and optional angular-size) uncertainty:
 *   S = 2 d tan(theta/2);  dS/dd = 2 tan(theta/2);  dS/dtheta = d sec^2(theta/2)  (theta in radians)
 *   sigma_S = sqrt( (dS/dd sigma_d)^2 + (dS/dtheta sigma_theta)^2 )
 * Errors are assumed independent. Absent distance uncertainty contributes zero and is reported via `uncertaintyPublished`.
 */
export function physicalSizeEstimate(angularArcmin: number, distance: ValueWithSigma, angularSigmaArcmin = 0): SizeEstimate {
  const d = distanceMetres(distance);
  const metres = physicalSizeMetres(angularArcmin, d.metres);
  const half = (angularArcmin / 60) * DEG_TO_RAD * 0.5;
  const dSdd = 2 * Math.tan(half);
  const dSdTheta = d.metres / (Math.cos(half) ** 2); // per radian of theta (S = 2 d tan(theta/2) => dS/dtheta = d sec^2(theta/2))
  const sigmaTheta = (angularSigmaArcmin / 60) * DEG_TO_RAD;
  const sigmaMetres = Math.hypot(dSdd * d.sigmaMetres, dSdTheta * sigmaTheta);
  return { metres, sigmaMetres, uncertaintyPublished: d.uncertaintyPublished || angularSigmaArcmin > 0 };
}

/** Distance modulus mu = 5 log10(d/10 pc) with sigma_mu = (5/ln10) sigma_d/d. */
export function distanceModulus(distance: ValueWithSigma): { mu: number; sigmaMu: number } {
  const d = distanceMetres(distance);
  const dpc = d.metres / METRES_PER_PARSEC;
  return { mu: 5 * Math.log10(dpc / 10), sigmaMu: (5 / Math.LN10) * (d.sigmaMetres / d.metres) };
}

/**
 * Absolute magnitude M = m - mu (no extinction or K-correction applied: stated, not hidden).
 * sigma_M = sqrt(sigma_m^2 + sigma_mu^2).
 */
export function absoluteMagnitude(apparentMag: number, distance: ValueWithSigma, apparentSigma = 0): { value: number; sigma: number; note: string } {
  const { mu, sigmaMu } = distanceModulus(distance);
  return {
    value: apparentMag - mu,
    sigma: Math.hypot(apparentSigma, sigmaMu),
    note: 'M = m - 5 log10(d / 10 pc). No Galactic or internal extinction and no K-correction applied.',
  };
}

export const SPEED_OF_LIGHT_KM_S = 299_792.458;

export interface RedshiftDistance {
  readonly distanceMpc: number;
  /** 1-sigma from the supplied peculiar-velocity and cz uncertainties; 0 when none supplied (then NOT a real error bar). */
  readonly sigmaMpc: number;
  readonly note: string;
}
/**
 * Hubble-flow distance d = cz / H0 (linear law, valid for cz << c). It is NOT a measured distance: peculiar velocities
 * (typically a few hundred km/s, up to ~1000+ km/s in clusters, "fingers of God") add an error of v_pec/H0 that does not
 * shrink with distance. Throws above z = 0.1 where the linear law is no longer adequate.
 */
export function distanceFromRedshift(czKms: number, H0KmSMpc: number, opts: { peculiarVelocityKms?: number; czSigmaKms?: number } = {}): RedshiftDistance {
  if (!(H0KmSMpc > 0)) throw new RangeError('H0 must be positive');
  if (!Number.isFinite(czKms)) throw new RangeError('cz must be finite');
  if (czKms / SPEED_OF_LIGHT_KM_S > 0.1) throw new RangeError('z > 0.1: the linear Hubble law is not adequate; use a cosmological distance');
  const sigmaV = Math.hypot(opts.peculiarVelocityKms ?? 0, opts.czSigmaKms ?? 0);
  return {
    distanceMpc: czKms / H0KmSMpc,
    sigmaMpc: sigmaV / H0KmSMpc,
    note: `Hubble-flow estimate d = cz / H0 with H0 = ${H0KmSMpc} km/s/Mpc. Peculiar velocities (hundreds of km/s, more in clusters) are not removed, so nearby values and cluster members are unreliable along the line of sight (fingers of God).`,
  };
}

/** Sun-centred ICRS Cartesian position in PARSECS from RA/Dec (deg) and a distance with unit pc|kpc|Mpc (or any known length unit). */
export function positionPc(sky: { raDeg: number; decDeg: number; distance?: ValueWithSigma }): Vec3 {
  if (!sky.distance) throw new Error('positionPc: object has no distance');
  return scale(equatorialToUnit(sky.raDeg, sky.decDeg), lengthToParsecs(sky.distance.value, sky.distance.unit));
}

/** Line-of-sight extent implied by a distance uncertainty (parsecs). near = max(0, d - sigma), far = d + sigma. */
export function lineOfSightExtentPc(distance: ValueWithSigma): { nearPc: number; farPc: number; halfExtentPc: number; centrePc: number } {
  const d = distanceMetres(distance);
  const c = d.metres / METRES_PER_PARSEC;
  const s = d.sigmaMetres / METRES_PER_PARSEC;
  return { nearPc: Math.max(0, c - s), farPc: c + s, halfExtentPc: s, centrePc: c };
}

/** Same as ValueWithSigma but for a full schema Measurement. */
export function fromMeasurement(m: Pick<Measurement, 'value' | 'unit' | 'uncertainty'>): ValueWithSigma { return m; }

// ---- image planes -----------------------------------------------------------------------------------------------------

export interface PlaneBasis { readonly right: Vec3; readonly up: Vec3; readonly normal: Vec3 }

/**
 * Basis of a flat, sky-projected image centred on (ra, dec). `up` is the image's up direction: north rotated
 * `upPositionAngleDeg` degrees EAST (counter-clockwise on the sky as seen from the inside, the astronomical convention).
 * `right` completes the picture: with north up, right = west (east is left on the sky). `normal` = right x up points
 * TOWARD the observer (back to the Sun), so a quad with this basis faces the Sun.
 */
export function skyPlaneBasis(raDeg: number, decDeg: number, upPositionAngleDeg: number): PlaneBasis {
  const E = eastUnit(raDeg);
  const N = northUnit(raDeg, decDeg);
  const pa = upPositionAngleDeg * DEG_TO_RAD;
  const up = add(scale(N, Math.cos(pa)), scale(E, Math.sin(pa)));
  const right = add(scale(E, -Math.cos(pa)), scale(N, Math.sin(pa)));
  return { right, up, normal: cross(right, up) };
}

export interface DiscOrientationDeg {
  readonly inclinationDeg: number;
  /** Major-axis position angle, degrees east of north. */
  readonly positionAngleDeg: number;
  /** Side of the major axis nearer to us; 'unknown' makes the sign of the tilt an arbitrary (flagged) choice. */
  readonly nearSide?: 'north-east' | 'south-west' | 'north-west' | 'south-east' | 'unknown';
}

/** Inclination above which deprojection is not attempted at full strength: 1/cos(80 deg) = 5.76. */
export const MAX_DEPROJECTION_INCLINATION_DEG = 80;
export const MAX_DEPROJECTION_STRETCH = 1 / Math.cos(MAX_DEPROJECTION_INCLINATION_DEG * DEG_TO_RAD);

export interface DiscPlaneBasis {
  /** Unit vector along the disc's major axis (ICRS). */
  readonly major: Vec3;
  /** Unit vector in the disc plane perpendicular to major (ICRS). */
  readonly minorInPlane: Vec3;
  /** Disc normal = major x minorInPlane. */
  readonly normal: Vec3;
  /** The sky-plane direction perpendicular to the major axis, the one the minor axis is foreshortened along. */
  readonly skyPerpendicular: Vec3;
  /** Unit vector from the Sun to the object. */
  readonly lineOfSight: Vec3;
  /**
   * Factor to apply along `minorInPlane` to sky-image coordinates measured along `skyPerpendicular`, so that the image
   * viewed from the Sun reproduces the original: 1 / cos(i), capped at 1/cos(80 deg) = 5.76. Beyond i = 80 deg an exact
   * deprojection is ill-conditioned (and impossible at 90: the disc is edge-on), so `exact` is false and the image is
   * only an illustration of the disc plane.
   */
  readonly stretch: number;
  readonly exact: boolean;
  /** True when nearSide was 'unknown': which half of the disc tilts toward us is a visual choice, not a measurement. */
  readonly tiltDirectionIsAChoice: boolean;
}

const NEAR_DIRECTION: Readonly<Record<string, readonly [number, number]>> = {
  // [north, east] components of the sky direction toward the near side
  'north-east': [1, 1], 'north-west': [1, -1], 'south-east': [-1, 1], 'south-west': [-1, -1],
};

/**
 * Orthonormal ICRS basis of a disc seen from the Sun at (ra, dec) with published position angle PA and inclination i.
 *   major        = cos(PA) N + sin(PA) E
 *   p (sky perp) = cos(PA) E - sin(PA) N               (90 deg east of the major axis)
 *   minorInPlane = cos(i) p + s sin(i) u               (u = line of sight, s = +1: the p side is the far side)
 *   normal       = major x minorInPlane
 * Mapping an image onto the plane: a sky offset (a along major, b along p) goes to a*major + (b*stretch)*minorInPlane.
 * Viewed from the Sun (orthographically, or perspective with d >> disc radius) this projects back to (a, b), i.e. the
 * original picture. The disc is assumed thin and flat.
 */
export function discPlaneBasis(orientation: DiscOrientationDeg, raDeg: number, decDeg: number): DiscPlaneBasis {
  const i = orientation.inclinationDeg;
  if (!(i >= 0 && i <= 90)) throw new RangeError(`inclination must be in [0, 90] degrees, got ${i}`);
  const E = eastUnit(raDeg);
  const N = northUnit(raDeg, decDeg);
  const u = equatorialToUnit(raDeg, decDeg);
  const pa = orientation.positionAngleDeg * DEG_TO_RAD;
  const major = add(scale(N, Math.cos(pa)), scale(E, Math.sin(pa)));
  const p = add(scale(E, Math.cos(pa)), scale(N, -Math.sin(pa)));

  const near = orientation.nearSide ?? 'unknown';
  let s = 1;
  let isChoice = true;
  if (near !== 'unknown') {
    const dir = NEAR_DIRECTION[near];
    if (!dir) throw new Error(`Unknown nearSide "${near}"`);
    const nearVec = add(scale(N, dir[0]), scale(E, dir[1]));
    const side = dot(nearVec, p);
    if (Math.abs(side) < 1e-6) throw new Error(`nearSide "${near}" does not pick a side of a major axis at position angle ${orientation.positionAngleDeg} deg`);
    s = side > 0 ? -1 : 1; // the near side is the side on which the plane comes toward us (negative along u)
    isChoice = false;
  }
  const ir = i * DEG_TO_RAD;
  const minorInPlane = normalise(add(scale(p, Math.cos(ir)), scale(u, s * Math.sin(ir))));
  const normal = normalise(cross(major, minorInPlane));
  const raw = Math.cos(ir) > 1e-12 ? 1 / Math.cos(ir) : Infinity;
  const exact = i <= MAX_DEPROJECTION_INCLINATION_DEG;
  return { major, minorInPlane, normal, skyPerpendicular: p, lineOfSight: u, stretch: Math.min(raw, MAX_DEPROJECTION_STRETCH), exact, tiltDirectionIsAChoice: isChoice };
}

export interface DiscImagePlacement {
  readonly basis: DiscPlaneBasis;
  /** Image corners [bottom-left, bottom-right, top-right, top-left] relative to the image centre, metres, ICRS axes. */
  readonly corners: readonly [Vec3, Vec3, Vec3, Vec3];
}

/**
 * Corners of a deprojected image in 3D. The image (width x height on the sky given as `fovArcmin`, up = `upPositionAngleDeg`)
 * is assumed centred on the galaxy centre. Each corner's sky offset (a, b) along the major axis and its sky perpendicular is
 * placed at a*major + b*stretch*minorInPlane.
 */
export function discImagePlacement(
  orientation: DiscOrientationDeg, raDeg: number, decDeg: number, upPositionAngleDeg: number,
  fovArcmin: readonly [number, number], distance: ValueWithSigma,
): DiscImagePlacement {
  const basis = discPlaneBasis(orientation, raDeg, decDeg);
  const sky = skyPlaneBasis(raDeg, decDeg, upPositionAngleDeg);
  const d = distanceMetres(distance).metres;
  const hw = physicalSizeMetres(fovArcmin[0], d) / 2;
  const hh = physicalSizeMetres(fovArcmin[1], d) / 2;
  const corner = (sx: number, sy: number): Vec3 => {
    const off = add(scale(sky.right, sx * hw), scale(sky.up, sy * hh));
    const a = dot(off, basis.major);
    const b = dot(off, basis.skyPerpendicular);
    return add(scale(basis.major, a), scale(basis.minorInPlane, b * basis.stretch));
  };
  return { basis, corners: [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)] };
}
