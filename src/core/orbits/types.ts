import type { JplApproxElements } from './elements';
import type { RotationElements } from './rotation';

/** Orbit of a planet from the JPL "Approximate Positions of the Planets" tables. Heliocentric, mean ecliptic and equinox of J2000. */
export interface JplApproxOrbit {
  readonly model: 'jpl-approx-keplerian';
  readonly elements: JplApproxElements;
  /** Years for which JPL states the table is valid. Evaluating outside is allowed but flagged. */
  readonly validFromYear: number;
  readonly validToYear: number;
  /** True when the elements describe the Earth-Moon barycentre rather than the body itself. */
  readonly barycentre?: boolean;
}

/**
 * Orbit of a satellite: osculating elements at an epoch in the ICRF frame centred on the parent planet (JPL Horizons),
 * advanced with a MEAN motion taken from JPL's mean orbital period when available. Secular precession is not modelled.
 */
export interface OsculatingOrbit {
  readonly model: 'osculating-mean-motion';
  readonly epochJdTdb: number;
  /** Metres. */
  readonly a: number;
  readonly e: number;
  readonly inclinationDeg: number;
  readonly nodeDeg: number;
  readonly argPeriDeg: number;
  readonly meanAnomalyDeg: number;
  /** Period implied by the osculating semi-major axis, days. */
  readonly osculatingPeriodDays: number;
  /** JPL's published period for the mean elements, days (an anomalistic-type period; shown, not used for propagation when a fit exists). */
  readonly meanPeriodDays?: number;
  /**
   * Period of the MEAN LONGITUDE, days, fitted to Horizons osculating elements around the epoch. This is the rate used to
   * advance the satellite, because it stays in phase when the apsidal line and node precess.
   */
  readonly fittedPeriodDays?: number;
  /** Description of the fit window, kept for provenance. */
  readonly fit?: { readonly windowDays: number; readonly samples: number; readonly rmsDeg: number };
}

export type OrbitDefinition = JplApproxOrbit | OsculatingOrbit;

export interface EphemerisBody {
  readonly id: string;
  /** Parent id; null for the Sun. */
  readonly parent: string | null;
  readonly orbit?: OrbitDefinition;
  readonly rotation?: RotationElements;
  /** GM, km^3/s^2: needed for the Earth-Moon barycentre correction. */
  readonly gm?: number;
}
