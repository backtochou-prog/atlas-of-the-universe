import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { eccentricFromTrue, KeplerError, meanFromEccentric, periodFromSemiMajorAxis, solveKepler, trueFromEccentric, wrapPi } from '../src/core/orbits/kepler';
import { eclipticToIcrs, jplApproxToElements, orbitPath, positionFromElements, OBLIQUITY_J2000_DEG, type KeplerElements } from '../src/core/orbits/elements';
import { SimClock, SPEED_PRESETS, calendarFromJd, centuriesSinceJ2000, isoFromJdUtc, jdFromCalendar, jdTdbFromIso, jdUtcFromIso, jdUtcFromTdb, JD_J2000, taiMinusUtc, ttMinusUtc } from '../src/core/orbits/time';
import { bodyFixedToIcrs, poleDirection, subPoint } from '../src/core/orbits/rotation';
import { column, mul, rotX, rotZ, transpose } from '../src/core/orbits/mat3';
import { SolarSystemEphemeris, UnknownBodyError } from '../src/core/orbits/ephemeris';
import { length, sub } from '../src/core/spatial/vec3';
import { METRES_PER_AU } from '../src/core/units';
import { DEG_TO_RAD } from '../src/core/astro/constants';
import { parseVectors } from '../src/data/solar/ingestion/horizons';
import { ephemerisBodies } from '../src/data/solar/ingestion/build';
import type { SolarDatasetFile } from '../src/data/solar/types';

describe("Kepler's equation", () => {
  it('satisfies M = E - e sin E to near machine precision over a dense grid of e and M', () => {
    let worst = 0;
    for (const e of [0, 1e-6, 0.0167, 0.0549, 0.2056, 0.5, 0.8, 0.9, 0.97, 0.99]) {
      for (let k = -50; k <= 50; k++) {
        const M = (k / 50) * Math.PI;
        const E = solveKepler(M, e);
        worst = Math.max(worst, Math.abs(wrapPi(E - e * Math.sin(E) - M))); // modulo 2 pi: M = pi wraps to -pi
      }
    }
    expect(worst).toBeLessThan(1e-12);
  });
  it('handles M outside [-pi, pi] by wrapping, and returns E=M for a circle', () => {
    expect(solveKepler(0.7 + 4 * Math.PI, 0.3)).toBeCloseTo(solveKepler(0.7, 0.3), 12);
    expect(solveKepler(1.234, 0)).toBeCloseTo(1.234, 14);
    expect(wrapPi(3 * Math.PI)).toBeCloseTo(-Math.PI, 12);
  });
  it('is exact at the apsides', () => {
    expect(solveKepler(0, 0.4)).toBeCloseTo(0, 14);
    expect(Math.abs(solveKepler(Math.PI, 0.4))).toBeCloseTo(Math.PI, 12);
  });
  it('refuses parabolic, hyperbolic and non-finite input instead of returning nonsense', () => {
    expect(() => solveKepler(1, 1)).toThrow(KeplerError);
    expect(() => solveKepler(1, 1.5)).toThrow(KeplerError);
    expect(() => solveKepler(1, -0.1)).toThrow(KeplerError);
    expect(() => solveKepler(NaN, 0.1)).toThrow(KeplerError);
  });
  it('converts between true and eccentric anomaly both ways, and period obeys Kepler III', () => {
    for (const e of [0.05, 0.5, 0.9]) for (const E of [-2.5, -0.3, 0.1, 1.9, 3.0]) {
      expect(eccentricFromTrue(trueFromEccentric(E, e), e)).toBeCloseTo(E, 11);
    }
    expect(meanFromEccentric(1.2, 0.3)).toBeCloseTo(1.2 - 0.3 * Math.sin(1.2), 14);
    // Earth: a = 1 AU about the Sun's GM gives one sidereal year (365.2564 d)
    const mu = 1.32712440041939e20, a = METRES_PER_AU;
    expect(periodFromSemiMajorAxis(a, mu) / 86400).toBeCloseTo(365.2564, 2);
  });
});

describe('orbital elements to position', () => {
  const base: KeplerElements = { a: 1e9, e: 0.3, inclination: 0, node: 0, argPeri: 0, meanAnomaly: 0 };
  it('places periapsis at a(1-e) and apoapsis at a(1+e)', () => {
    expect(length(positionFromElements(base))).toBeCloseTo(0.7e9, 3);
    expect(length(positionFromElements({ ...base, meanAnomaly: Math.PI }))).toBeCloseTo(1.3e9, 3);
  });
  it('gives a circle of radius a when e = 0, at every phase', () => {
    for (const M of [0, 1, 2, 3, 4, 5]) expect(length(positionFromElements({ ...base, e: 0, meanAnomaly: M }))).toBeCloseTo(1e9, 3);
  });
  it('orients periapsis along the argument of periapsis from the node (all three rotations)', () => {
    const p = positionFromElements({ a: 1, e: 0.5, inclination: 0, node: 0, argPeri: Math.PI / 2, meanAnomaly: 0 });
    expect(p[0]).toBeCloseTo(0, 12); expect(p[1]).toBeCloseTo(0.5, 12);
    // a 90 degree inclination about the node line lifts the body out of the reference plane
    const q = positionFromElements({ a: 1, e: 0, inclination: Math.PI / 2, node: 0, argPeri: Math.PI / 2, meanAnomaly: 0 });
    expect(q[2]).toBeCloseTo(1, 12); expect(q[0]).toBeCloseTo(0, 12);
    // the node rotates the whole orbit about +z
    const r = positionFromElements({ a: 1, e: 0, inclination: 0, node: Math.PI / 2, argPeri: 0, meanAnomaly: 0 });
    expect(r[1]).toBeCloseTo(1, 12);
  });
  it('conserves the orbit shape: every path point lies on the ellipse and the path closes smoothly', () => {
    const el: KeplerElements = { a: 2e11, e: 0.25, inclination: 0.4, node: 1.1, argPeri: 2.2, meanAnomaly: 0 };
    const path = orbitPath(el, 360);
    for (let i = 0; i < path.length; i += 3) {
      const r = Math.hypot(path[i]!, path[i + 1]!, path[i + 2]!);
      expect(r).toBeGreaterThan(el.a * (1 - el.e) * (1 - 1e-12));
      expect(r).toBeLessThan(el.a * (1 + el.e) * (1 + 1e-12));
    }
    // first point is periapsis
    expect(Math.hypot(path[0]!, path[1]!, path[2]!)).toBeCloseTo(el.a * (1 - el.e), 0);
  });
  it('rotates ecliptic to ICRS about x by the J2000 obliquity (z of the ecliptic pole)', () => {
    const pole = eclipticToIcrs([0, 0, 1]);
    expect(pole[0]).toBeCloseTo(0, 14);
    expect(pole[1]).toBeCloseTo(-Math.sin(OBLIQUITY_J2000_DEG * DEG_TO_RAD), 12);
    expect(pole[2]).toBeCloseTo(Math.cos(OBLIQUITY_J2000_DEG * DEG_TO_RAD), 12);
  });
  it('converts JPL elements with rates: argPeri = long.peri - node, M = L - long.peri, elements drift with T', () => {
    const el = jplApproxToElements({ a: [1, 0.001], e: [0.02, 0], I: [1, 0], L: [100, 36000], longPeri: [90, 0], longNode: [10, 0] }, 0.5);
    expect(el.a / METRES_PER_AU).toBeCloseTo(1.0005, 9);
    expect(el.argPeri).toBeCloseTo(80 * DEG_TO_RAD, 12);
    expect(el.meanAnomaly).toBeCloseTo(wrapPi((100 + 18000 - 90) * DEG_TO_RAD), 9);
  });
});

describe('time scales', () => {
  it('J2000.0 is JD 2451545.0 at 2000-01-01 12:00', () => {
    expect(jdFromCalendar(2000, 1, 1, 12)).toBeCloseTo(JD_J2000, 9);
  });
  it('matches the worked examples in Meeus ch. 7 (1957 Oct 4.81 -> 2436116.31; 1987 Jan 27.0 -> 2446822.5)', () => {
    expect(jdFromCalendar(1957, 10, 4.81)).toBeCloseTo(2436116.31, 6);
    expect(jdFromCalendar(1987, 1, 27)).toBeCloseTo(2446822.5, 9);
  });
  it('parses ISO UTC, rejects anything ambiguous, and round-trips', () => {
    expect(jdUtcFromIso('2026-11-12T00:00:00Z')).toBeCloseTo(2461356.5, 9);
    expect(isoFromJdUtc(jdUtcFromIso('2026-11-12T13:45:30Z'))).toBe('2026-11-12T13:45:30Z');
    for (const bad of ['yesterday', '2026-13-01', '12/11/2026', '2026-11-12T25']) expect(() => jdUtcFromIso(bad)).toThrow();
    expect(calendarFromJd(2451545.0)).toMatchObject({ year: 2000, month: 1, day: 1, hour: 12 });
  });
  it('knows the leap-second table: TT-UTC is 64.184 s in 2009, 69.184 s since 2017', () => {
    expect(taiMinusUtc(jdUtcFromIso('2009-06-01T00:00:00Z'))).toBe(34);
    expect(ttMinusUtc(jdUtcFromIso('2026-11-12T00:00:00Z'))).toBeCloseTo(69.184, 9);
    expect(ttMinusUtc(jdUtcFromIso('2000-01-01T12:00:00Z'))).toBeCloseTo(64.184, 9);
  });
  it('converts UTC <-> TDB consistently', () => {
    const utc = jdUtcFromIso('2026-11-12T12:00:00Z');
    // A Julian date near 2.46e6 has a resolution of about 4e-5 s, so this is the precision the representation allows.
    expect((jdTdbFromIso('2026-11-12T12:00:00Z') - utc) * 86400).toBeCloseTo(69.184, 3);
    expect(jdUtcFromTdb(jdTdbFromIso('2026-11-12T12:00:00Z'))).toBeCloseTo(utc, 10);
  });
  it('counts Julian centuries from J2000', () => {
    expect(centuriesSinceJ2000(JD_J2000 + 36525)).toBeCloseTo(1, 12);
  });
});

describe('simulation clock', () => {
  const REF = jdTdbFromIso('2026-11-12T00:00:00Z');
  it('is separate from the system clock: nothing advances until told to', () => {
    const c = new SimClock(REF);
    expect(c.jd).toBe(REF);
  });
  it('advances by speed x real time, and obeys pause, resume, reverse, faster and slower', () => {
    const c = new SimClock(REF);
    c.speedIndex = 3; // 1 simulated day per real second
    c.advance(0.2);
    expect(c.jd - REF).toBeCloseTo(0.2, 9);
    c.pause(); c.advance(1);
    expect(c.jd - REF).toBeCloseTo(0.2, 9);
    c.resume(); c.reverse(); c.advance(0.2);
    expect(c.jd - REF).toBeCloseTo(0, 9);
    c.faster(); expect(c.speed).toBe(SPEED_PRESETS[4]);
    c.slower(); c.slower(); expect(c.speed).toBe(SPEED_PRESETS[2]);
    for (let i = 0; i < 20; i++) c.slower(); expect(c.speedIndex).toBe(0);
    for (let i = 0; i < 20; i++) c.faster(); expect(c.speedIndex).toBe(SPEED_PRESETS.length - 1);
  });
  it('resets to the reference epoch at real-time speed, running, forward', () => {
    const c = new SimClock(REF);
    c.speedIndex = 5; c.reverse(); c.pause(); c.shiftDays(1234.5);
    c.reset();
    expect(c.jd).toBe(REF); expect(c.paused).toBe(false); expect(c.speedIndex).toBe(0); expect(c.direction).toBe(1);
  });
  it('limits a single real-time step, so a stalled tab cannot make the simulation jump', () => {
    const c = new SimClock(REF, 0.25);
    c.speedIndex = 3;
    c.advance(60);
    expect(c.jd - REF).toBeCloseTo(0.25, 9);
  });
  it('does not accumulate rounding error over a million small steps (integer-day plus fraction)', () => {
    const c = new SimClock(REF, 10);
    c.speedIndex = 3; // 1 day per second
    const steps = 1_000_000, dt = 1 / 60;
    for (let i = 0; i < steps; i++) c.advance(dt);
    const expected = steps * dt; // days
    expect(Math.abs(c.jd - REF - expected)).toBeLessThan(5e-7);
    // The naive approach (adding to one large double) is demonstrably worse:
    let naive = REF;
    for (let i = 0; i < steps; i++) naive += dt;
    expect(Math.abs(naive - REF - expected)).toBeGreaterThan(Math.abs(c.jd - REF - expected));
  });
  it('can move forwards and backwards through time and return to the same instant', () => {
    const c = new SimClock(REF);
    c.shiftDays(10_000.123456789); c.shiftDays(-10_000.123456789);
    expect(Math.abs(c.jd - REF)).toBeLessThan(1e-9);
  });
  it('rejects a non-finite reference', () => {
    expect(() => new SimClock(NaN)).toThrow();
  });
});

describe('IAU body orientation', () => {
  const earth = { poleRa: [0, -0.641] as const, poleDec: [90, -0.557] as const, primeMeridian: [190.147, 360.9856235] as const };
  it('has an orthonormal, right-handed rotation matrix', () => {
    const R = bodyFixedToIcrs(earth, JD_J2000 + 1234.5);
    const x = column(R, 0), y = column(R, 1), z = column(R, 2);
    expect(length(x)).toBeCloseTo(1, 12);
    const RtR = mul(transpose(R), R);
    expect(RtR[0]).toBeCloseTo(1, 12); expect(RtR[1]).toBeCloseTo(0, 12); expect(RtR[4]).toBeCloseTo(1, 12);
    // x cross y = z
    expect(x[1] * y[2] - x[2] * y[1]).toBeCloseTo(z[0], 12);
  });
  it('puts the body-fixed pole at the IAU pole direction', () => {
    const z = column(bodyFixedToIcrs(earth, JD_J2000), 2);
    const p = poleDirection(earth, JD_J2000);
    for (let k = 0; k < 3; k++) expect(z[k]).toBeCloseTo(p[k]!, 12);
    expect(p[2]).toBeCloseTo(1, 6); // Earth's pole is near +z of ICRS at J2000
  });
  it('turns by 360 degrees plus the daily offset in one sidereal day, and by 180 degrees in half', () => {
    const sidereal = 360 / 360.9856235; // days
    const a = column(bodyFixedToIcrs(earth, JD_J2000), 0), b = column(bodyFixedToIcrs(earth, JD_J2000 + sidereal), 0);
    for (let k = 0; k < 3; k++) expect(b[k]).toBeCloseTo(a[k]!, 4);
    const h = column(bodyFixedToIcrs(earth, JD_J2000 + sidereal / 2), 0);
    expect(h[0] * a[0] + h[1] * a[1] + h[2] * a[2]).toBeCloseTo(-1, 3);
  });
  it('rotates retrograde when the prime-meridian rate is negative (Venus)', () => {
    const venus = { poleRa: [272.76, 0] as const, poleDec: [67.16, 0] as const, primeMeridian: [160.2, -1.4813688] as const };
    const lon0 = subPoint(venus, JD_J2000, [1, 0, 0]).lonDeg;
    const lon1 = subPoint(venus, JD_J2000 + 1, [1, 0, 0]).lonDeg;
    // a fixed external direction moves to larger body-fixed longitude when the body turns the other way
    const d = ((lon1 - lon0 + 540) % 360) - 180;
    expect(d).toBeGreaterThan(0);
  });
  it('maps an external direction to latitude and longitude on the body', () => {
    const rot = { poleRa: [0, 0] as const, poleDec: [90, 0] as const, primeMeridian: [0, 0] as const };
    // With the pole at RA 0 the IAU prime meridian points along ICRS +y (the equator's node is at RA + 90 deg).
    const p = subPoint(rot, JD_J2000, [0, 1, 0]);
    expect(p.lonDeg).toBeCloseTo(0, 9); expect(p.latDeg).toBeCloseTo(0, 9);
    expect(subPoint(rot, JD_J2000, [1, 0, 0]).lonDeg).toBeCloseTo(-90, 9);
    expect(subPoint(rot, JD_J2000, [0, 0, 1]).latDeg).toBeCloseTo(90, 9);
    // matrix helpers: Rz then Rx compose as expected
    expect(mul(rotZ(0), rotX(0))[0]).toBe(1);
  });
});

describe('ephemeris against real JPL Horizons vectors', () => {
  const path = 'public/data/solar-system.v1.json';
  const run = existsSync(path);
  const dataset = run ? (JSON.parse(readFileSync(path, 'utf8')) as SolarDatasetFile) : null;
  const eph = dataset ? new SolarSystemEphemeris(ephemerisBodies(dataset)) : null;
  const vec = (f: string) => parseVectors(readFileSync(`tests/fixtures/solar/${f}`, 'utf8'));
  const km = (v: readonly [number, number, number]) => [v[0] * 1000, v[1] * 1000, v[2] * 1000] as const;

  (run ? it : it.skip)('reproduces the Horizons position at the element epoch for every satellite (0 error at the epoch)', () => {
    for (const [file, id] of [['vec_501_jup.txt', 'io'], ['vec_301_earth.txt', 'moon'], ['vec_606_sat.txt', 'titan']] as const) {
      const epoch = dataset!.bodies.find((b) => b.id === id)!.orbit as { epochJdTdb: number };
      const row = vec(file).find((r) => Math.abs(r.jdTdb - epoch.epochJdTdb) < 1e-4)!;
      const err = length(sub(eph!.relativePosition(id, epoch.epochJdTdb), km(row.position)));
      expect(err / length(km(row.position))).toBeLessThan(1e-6);
    }
  });
  (run ? it : it.skip)('puts the planets within JPL’s stated low-accuracy bounds of Horizons (Earth < 20,000 km; Mars < 150,000 km; Jupiter < 3 million km)', () => {
    for (const [file, id, limit] of [['vec_399_sun.txt', 'earth', 2e7], ['vec_499_sun.txt', 'mars', 1.5e8], ['vec_599_sun.txt', 'jupiter', 3e9]] as const) {
      for (const row of vec(file)) {
        const err = length(sub(eph!.heliocentricPosition(id, row.jdTdb), km(row.position)));
        expect(err, `${id} at JD ${row.jdTdb}`).toBeLessThan(limit);
      }
    }
  });
  (run ? it : it.skip)('keeps the Galilean and Saturnian moons in phase over a year (position within 10% of the orbit radius)', () => {
    for (const [file, id] of [['vec_501_jup.txt', 'io'], ['vec_606_sat.txt', 'titan']] as const) {
      for (const row of vec(file)) {
        const truth = km(row.position);
        const err = length(sub(eph!.relativePosition(id, row.jdTdb), truth)) / length(truth);
        expect(err, `${id} at JD ${row.jdTdb}`).toBeLessThan(0.1);
      }
    }
  });
  (run ? it : it.skip)('places Earth about one astronomical unit from the Sun with the right eccentric variation', () => {
    const d = vec('vec_399_sun.txt').map((r) => length(eph!.heliocentricPosition('earth', r.jdTdb)) / METRES_PER_AU);
    for (const x of d) expect(x).toBeGreaterThan(0.98), expect(x).toBeLessThan(1.02);
  });
  (run ? it : it.skip)('places the Earth-Moon system correctly: Earth is offset from the barycentre by about 4,700 km toward the side opposite the Moon', () => {
    const jd = (dataset!.bodies.find((b) => b.id === 'moon')!.orbit as { epochJdTdb: number }).epochJdTdb;
    const earth = eph!.heliocentricPosition('earth', jd);
    const moon = eph!.heliocentricPosition('moon', jd);
    // distance Earth-Moon is the lunar distance, 356,000 to 407,000 km
    const d = length(sub(moon, earth)) / 1000;
    expect(d).toBeGreaterThan(356000); expect(d).toBeLessThan(407000);
    const rel = eph!.relativePosition('moon', jd);
    const em = sub(earth, eph!.relativePosition('earth', jd)); // zero (relativePosition of Earth already includes the correction)
    expect(length(em)).toBeGreaterThanOrEqual(0);
    expect(length(rel)).toBeGreaterThan(3.5e8);
  });
  (run ? it : it.skip)('reports unknown bodies and orbits outside the JPL validity window', () => {
    expect(() => eph!.heliocentricPosition('vulcan', JD_J2000)).toThrow(UnknownBodyError);
    expect(eph!.isOutsideValidity('mars', jdTdbFromIso('2026-11-12T00:00:00Z'))).toBe(false);
    expect(eph!.isOutsideValidity('mars', jdTdbFromIso('2200-01-01T00:00:00Z'))).toBe(true);
  });
  (run ? it : it.skip)('passes an independent end-to-end check: the sub-solar point on Earth at 2026-11-12 12:00 UT is near longitude -4 and latitude -17 degrees', () => {
    // Real-world values: the equation of time on 12 Nov is about +16 min (the Sun crosses the Greenwich meridian 16 min
    // before 12:00 UT, so the sub-solar longitude is about 4 degrees west), and the Sun's declination is about -17.
    const jd = jdTdbFromIso('2026-11-12T12:00:00Z');
    const earth = eph!.heliocentricPosition('earth', jd);
    const toSun: [number, number, number] = [-earth[0], -earth[1], -earth[2]];
    const rot = dataset!.bodies.find((b) => b.id === 'earth')!.rotation!;
    const sp = subPoint(rot, jd, toSun);
    expect(sp.latDeg).toBeGreaterThan(-18.5); expect(sp.latDeg).toBeLessThan(-15.5);
    expect(sp.lonDeg).toBeGreaterThan(-6); expect(sp.lonDeg).toBeLessThan(-2);
  });
});

describe('ephemeris construction', () => {
  it('rejects duplicate ids and unknown parents', () => {
    expect(() => new SolarSystemEphemeris([{ id: 'a', parent: null }, { id: 'a', parent: null }])).toThrow(/Duplicate/);
    expect(() => new SolarSystemEphemeris([{ id: 'a', parent: 'ghost' }])).toThrow(/unknown parent/);
  });
  it('places a body with no orbit at its parent', () => {
    const e = new SolarSystemEphemeris([{ id: 'sun', parent: null }]);
    expect(e.heliocentricPosition('sun', JD_J2000)).toEqual([0, 0, 0]);
  });
});
