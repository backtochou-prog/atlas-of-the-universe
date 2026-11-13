import { add, scale, sub, ZERO, type Vec3 } from '../spatial/vec3';
import { DEG_TO_RAD } from '../astro/constants';
import { advanceMeanAnomaly, eclipticToIcrs, jplApproxToElements, orbitPath, positionFromElements, type KeplerElements } from './elements';
import { wrapPi } from './kepler';
import { centuriesSinceJ2000, JD_J2000 } from './time';
import type { EphemerisBody, JplApproxOrbit, OrbitDefinition, OsculatingOrbit } from './types';

const KM = 1000;
const TWO_PI = 2 * Math.PI;

export class UnknownBodyError extends Error {
  constructor(id: string) { super(`Unknown Solar System body "${id}"`); this.name = 'UnknownBodyError'; }
}

export function osculatingElementsAt(o: OsculatingOrbit, jdTdb: number): KeplerElements {
  const base: KeplerElements = {
    a: o.a, e: o.e, inclination: o.inclinationDeg * DEG_TO_RAD, node: o.nodeDeg * DEG_TO_RAD,
    argPeri: o.argPeriDeg * DEG_TO_RAD, meanAnomaly: wrapPi(o.meanAnomalyDeg * DEG_TO_RAD),
  };
  const period = o.fittedPeriodDays ?? o.meanPeriodDays ?? o.osculatingPeriodDays;
  return advanceMeanAnomaly(base, TWO_PI / period, jdTdb - o.epochJdTdb);
}

/** Years in the JPL validity window, for flagging evaluations outside it. */
export const yearFromJd = (jdTdb: number): number => 2000 + (jdTdb - JD_J2000) / 365.25;

/**
 * Positions of the Sun, planets and satellites.
 *
 * MODEL LIMITS (also documented in docs/SOLAR_SYSTEM.md):
 *  - Planets: JPL's low-accuracy Keplerian elements with linear rates. These are NOT a high-precision ephemeris;
 *    JPL quotes arcsecond-to-arcminute level errors and the Atlas validation against JPL Horizons is recorded in the dataset.
 *  - Earth: the table gives the Earth-Moon barycentre; Earth's centre is obtained by subtracting the Moon's
 *    mass-weighted offset.
 *  - Satellites: osculating elements at one epoch with a mean-motion correction; no precession, no perturbations.
 *    Accuracy degrades with distance in time from the element epoch.
 *  - The Sun is at the origin (the Sun's motion about the barycentre, about 1.4e9 m at most, is ignored).
 */
export class SolarSystemEphemeris {
  private readonly byId = new Map<string, EphemerisBody>();

  constructor(bodies: readonly EphemerisBody[]) {
    for (const b of bodies) {
      if (this.byId.has(b.id)) throw new Error(`Duplicate body "${b.id}"`);
      this.byId.set(b.id, b);
    }
    for (const b of bodies) {
      if (b.parent !== null && !this.byId.has(b.parent)) throw new Error(`Body "${b.id}" has unknown parent "${b.parent}"`);
    }
  }

  body(id: string): EphemerisBody {
    const b = this.byId.get(id);
    if (!b) throw new UnknownBodyError(id);
    return b;
  }

  has(id: string): boolean { return this.byId.has(id); }

  /** Keplerian elements of a body's own orbit at a time (frame given by the orbit model). */
  elementsAt(id: string, jdTdb: number): { elements: KeplerElements; frame: 'ecliptic-j2000' | 'icrf' } | null {
    const o = this.body(id).orbit;
    if (!o) return null;
    if (o.model === 'jpl-approx-keplerian') return { elements: jplApproxToElements(o.elements, centuriesSinceJ2000(jdTdb)), frame: 'ecliptic-j2000' };
    return { elements: osculatingElementsAt(o, jdTdb), frame: 'icrf' };
  }

  /** Position relative to the parent, in ICRS axes, metres. For Earth this is relative to the Sun and already corrected for the barycentre. */
  relativePosition(id: string, jdTdb: number): Vec3 {
    const b = this.body(id);
    const o = b.orbit;
    if (!o) return ZERO;
    if (o.model === 'osculating-mean-motion') return positionFromElements(osculatingElementsAt(o, jdTdb));
    const raw = eclipticToIcrs(positionFromElements(jplApproxToElements(o.elements, centuriesSinceJ2000(jdTdb))));
    if (!o.barycentre) return raw;
    return sub(raw, this.barycentreOffset(id, jdTdb));
  }

  /** Offset of the barycentre from the planet's centre: (m_moon / (m_planet + m_moon)) * r_moon_relative_to_planet. */
  private barycentreOffset(planetId: string, jdTdb: number): Vec3 {
    const planet = this.body(planetId);
    const moon = [...this.byId.values()].find((m) => m.parent === planetId && m.orbit?.model === 'osculating-mean-motion' && m.gm !== undefined && m.id === 'moon');
    if (!moon || planet.gm === undefined || moon.gm === undefined) return ZERO;
    const fraction = moon.gm / (planet.gm + moon.gm);
    return scale(this.relativePosition(moon.id, jdTdb), fraction);
  }

  /** Heliocentric position (ICRS axes, metres) by walking up the parent chain. */
  heliocentricPosition(id: string, jdTdb: number): Vec3 {
    let p: Vec3 = ZERO;
    for (let cur: EphemerisBody | undefined = this.body(id); cur; cur = cur.parent === null ? undefined : this.body(cur.parent)) {
      p = add(p, this.relativePosition(cur.id, jdTdb));
    }
    return p;
  }

  /** The orbit as a closed polyline relative to the parent, ICRS axes, metres (the instantaneous Keplerian ellipse at this time). */
  orbitPathIcrs(id: string, jdTdb: number, segments = 256): Float64Array | null {
    const at = this.elementsAt(id, jdTdb);
    if (!at) return null;
    const path = orbitPath(at.elements, segments);
    if (at.frame === 'icrf') return path;
    for (let i = 0; i < path.length; i += 3) {
      const v = eclipticToIcrs([path[i]!, path[i + 1]!, path[i + 2]!]);
      path[i] = v[0]; path[i + 1] = v[1]; path[i + 2] = v[2];
    }
    const o = this.body(id).orbit as JplApproxOrbit;
    if (o.barycentre) {
      const off = this.barycentreOffset(id, jdTdb);
      for (let i = 0; i < path.length; i += 3) { path[i] = path[i]! - off[0]; path[i + 1] = path[i + 1]! - off[1]; path[i + 2] = path[i + 2]! - off[2]; }
    }
    return path;
  }

  isOutsideValidity(id: string, jdTdb: number): boolean {
    const o: OrbitDefinition | undefined = this.body(id).orbit;
    if (!o || o.model !== 'jpl-approx-keplerian') return false;
    const y = yearFromJd(jdTdb);
    return y < o.validFromYear || y > o.validToYear;
  }

  ids(): string[] { return [...this.byId.keys()]; }
  children(id: string): EphemerisBody[] { return [...this.byId.values()].filter((b) => b.parent === id); }
}

export { KM };
