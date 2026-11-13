/** Kepler's equation and anomaly conversions for elliptical orbits (0 <= e < 1). Angles in radians. */

const TWO_PI = 2 * Math.PI;

export function wrapPi(x: number): number {
  const y = (((x + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI;
  return y - Math.PI;
}

export class KeplerError extends Error {
  constructor(message: string) { super(message); this.name = 'KeplerError'; }
}

/**
 * Solve M = E - e sin E for the eccentric anomaly E.
 * Newton iteration from a safe starting value, converged to |dE| < tol (default 1e-13 rad). Valid for 0 <= e < 1;
 * parabolic and hyperbolic orbits are not supported and throw.
 */
export function solveKepler(meanAnomaly: number, e: number, tol = 1e-13, maxIter = 60): number {
  if (!Number.isFinite(meanAnomaly) || !Number.isFinite(e)) throw new KeplerError('Mean anomaly and eccentricity must be finite');
  if (e < 0 || e >= 1) throw new KeplerError(`Eccentricity ${e} is outside [0, 1): only elliptical orbits are supported`);
  const M = wrapPi(meanAnomaly);
  if (e === 0) return M;
  // Starting guess: M + e sin M works for moderate e; for large e start from pi * sign(M) to stay in the monotonic region.
  let E = e < 0.8 ? M + e * Math.sin(M) : Math.sign(M || 1) * Math.PI;
  for (let i = 0; i < maxIter; i++) {
    const f = E - e * Math.sin(E) - M;
    const dE = f / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < tol) return E;
  }
  throw new KeplerError(`Kepler iteration did not converge (M=${meanAnomaly}, e=${e})`);
}

export const trueFromEccentric = (E: number, e: number): number =>
  2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));

export const eccentricFromTrue = (nu: number, e: number): number =>
  2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));

export const meanFromEccentric = (E: number, e: number): number => E - e * Math.sin(E);

/** Orbital period in the same time unit as sqrt(a^3/mu): T = 2 pi sqrt(a^3 / mu). */
export const periodFromSemiMajorAxis = (a: number, mu: number): number => TWO_PI * Math.sqrt((a * a * a) / mu);
