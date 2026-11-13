import { describe, expect, it } from 'vitest';
import { absoluteMagnitude, discImagePlacement, discPlaneBasis, distanceFromRedshift, distanceModulus, lengthToParsecs, lineOfSightExtentPc, MAX_DEPROJECTION_STRETCH, physicalSizeEstimate, physicalSizeMetres, positionPc, skyPlaneBasis, angularSizeArcmin } from '../src/core/deepspace/geometry';
import { eastUnit, equatorialToUnit, northUnit, unitToEquatorial } from '../src/core/astro/coordinates';
import { dot, length, normalise, scale, add } from '../src/core/spatial/vec3';
import { METRES_PER_MPC, METRES_PER_PARSEC } from '../src/core/units';

describe('physical size', () => {
  it('uses the exact tangent: 1 degree at 1 pc = 2 tan(0.5 deg) pc (hand value 0.0174537355812)', () => {
    expect(physicalSizeMetres(60, METRES_PER_PARSEC) / METRES_PER_PARSEC).toBeCloseTo(0.0174537355812, 12);
    // and it differs from the small-angle value pi/180 = 0.0174532925 (relative 2.5e-5)
    expect(physicalSizeMetres(60, METRES_PER_PARSEC) / METRES_PER_PARSEC).toBeGreaterThan(Math.PI / 180);
  });
  it('is exact for large angles: 90 degrees at distance d spans 2 d', () => {
    expect(physicalSizeMetres(90 * 60, 1)).toBeCloseTo(2, 12);
  });
  it('round-trips with angularSizeArcmin', () => {
    const s = physicalSizeMetres(123.4, 7e22);
    expect(angularSizeArcmin(s, 7e22)).toBeCloseTo(123.4, 9);
  });
  it('rejects nonsense', () => {
    expect(() => physicalSizeMetres(-1, 1)).toThrow();
    expect(() => physicalSizeMetres(1, 0)).toThrow();
    expect(() => physicalSizeMetres(180 * 60, 1)).toThrow();
  });
  it('propagates distance uncertainty: 60 arcmin at 1 +/- 0.1 Mpc -> 17453.7 +/- 1745.4 pc (hand: 0.0174537356 * 1e6 and * 1e5)', () => {
    const e = physicalSizeEstimate(60, { value: 1, unit: 'Mpc', uncertainty: 0.1 });
    expect(e.metres / METRES_PER_PARSEC).toBeCloseTo(17453.7355812, 3);
    expect(e.sigmaMetres / METRES_PER_PARSEC).toBeCloseTo(1745.37355812, 3);
    expect(e.uncertaintyPublished).toBe(true);
  });
  it('adds an angular-size error in quadrature: d=1 Mpc, theta=60 +/- 6 arcmin, sigma_d=0.1 Mpc', () => {
    // dS/dtheta = d sec^2(theta/2) per radian; 6 arcmin = 0.00174533 rad; sec^2(0.5 deg) = 1.0000762
    const e = physicalSizeEstimate(60, { value: 1, unit: 'Mpc', uncertainty: 0.1 }, 6);
    const sd = 1745.37355812;
    const st = 1e6 * 1.0000761544 * 0.00174532925; // pc
    expect(e.sigmaMetres / METRES_PER_PARSEC).toBeCloseTo(Math.hypot(sd, st), 2);
  });
  it('flags an unpublished distance uncertainty instead of inventing zero error', () => {
    const e = physicalSizeEstimate(60, { value: 1, unit: 'Mpc' });
    expect(e.sigmaMetres).toBe(0);
    expect(e.uncertaintyPublished).toBe(false);
  });
});

describe('units, distance modulus, absolute magnitude', () => {
  it('converts length units', () => {
    expect(lengthToParsecs(1, 'Mpc')).toBeCloseTo(1e6, 6);
    expect(lengthToParsecs(2.5, 'kpc')).toBeCloseTo(2500, 9);
    expect(lengthToParsecs(1, 'pc')).toBe(1);
    expect(() => lengthToParsecs(1, 'furlong')).toThrow();
  });
  it('mu(1 Mpc) = 25 exactly; sigma_mu(0.05 Mpc) = 5/ln10 * 0.05 = 0.108574', () => {
    const m = distanceModulus({ value: 1, unit: 'Mpc', uncertainty: 0.05 });
    expect(m.mu).toBeCloseTo(25, 12);
    expect(m.sigmaMu).toBeCloseTo(0.1085736205, 9);
  });
  it('M = m - mu, sigma = hypot(sigma_m, sigma_mu): m=3.44+-0.05 at 1+-0.05 Mpc -> -21.56 +- 0.1195', () => {
    const a = absoluteMagnitude(3.44, { value: 1, unit: 'Mpc', uncertainty: 0.05 }, 0.05);
    expect(a.value).toBeCloseTo(-21.56, 10);
    expect(a.sigma).toBeCloseTo(Math.sqrt(0.0025 + 0.1085736205 ** 2), 9);
    expect(a.sigma).toBeCloseTo(0.1195, 3);
    expect(a.note).toMatch(/extinction/);
  });
});

describe('redshift distances', () => {
  it('cz 1200 km/s at H0 70 -> 17.142857 Mpc; 300 km/s peculiar velocity -> +- 4.2857 Mpc', () => {
    const d = distanceFromRedshift(1200, 70, { peculiarVelocityKms: 300 });
    expect(d.distanceMpc).toBeCloseTo(17.142857, 5);
    expect(d.sigmaMpc).toBeCloseTo(4.285714, 5);
  });
  it('always carries the Hubble-flow caveat and the H0 used', () => {
    const d = distanceFromRedshift(7000, 73);
    expect(d.note).toMatch(/Hubble-flow/);
    expect(d.note).toMatch(/peculiar/i);
    expect(d.note).toMatch(/73/);
    expect(d.sigmaMpc).toBe(0);
  });
  it('refuses beyond the linear regime and bad H0', () => {
    expect(() => distanceFromRedshift(40000, 70)).toThrow(/linear/);
    expect(() => distanceFromRedshift(100, 0)).toThrow();
  });
});

describe('sky -> Cartesian', () => {
  it('M42 (RA 83.8221, Dec -5.3911, 1344 pc) round-trips', () => {
    const p = positionPc({ raDeg: 83.8221, decDeg: -5.3911, distance: { value: 1344, unit: 'pc' } });
    const d = (Math.PI / 180);
    expect(p[0]).toBeCloseTo(1344 * Math.cos(-5.3911 * d) * Math.cos(83.8221 * d), 9);
    expect(p[1]).toBeCloseTo(1344 * Math.cos(-5.3911 * d) * Math.sin(83.8221 * d), 9);
    expect(p[2]).toBeCloseTo(1344 * Math.sin(-5.3911 * d), 9);
    expect(length(p)).toBeCloseTo(1344, 9);
    const back = unitToEquatorial(p);
    expect(back.raDeg).toBeCloseTo(83.8221, 10);
    expect(back.decDeg).toBeCloseTo(-5.3911, 10);
  });
  it('M31 (10.6847, 41.2688) at 0.77 Mpc = 770 000 pc, any unit gives the same point', () => {
    const a = positionPc({ raDeg: 10.6847, decDeg: 41.2688, distance: { value: 0.77, unit: 'Mpc' } });
    const b = positionPc({ raDeg: 10.6847, decDeg: 41.2688, distance: { value: 770, unit: 'kpc' } });
    const c = positionPc({ raDeg: 10.6847, decDeg: 41.2688, distance: { value: 770000, unit: 'pc' } });
    for (let i = 0; i < 3; i++) { expect(a[i]).toBeCloseTo(c[i] as number, 6); expect(b[i]).toBeCloseTo(c[i] as number, 6); }
    expect(length(c)).toBeCloseTo(770000, 6);
    const back = unitToEquatorial(c);
    expect(back.raDeg).toBeCloseTo(10.6847, 10);
    expect(back.decDeg).toBeCloseTo(41.2688, 10);
  });
  it('needs a distance', () => { expect(() => positionPc({ raDeg: 1, decDeg: 1 })).toThrow(/distance/); });
  it('line-of-sight extent from a distance error', () => {
    const e = lineOfSightExtentPc({ value: 0.77, unit: 'Mpc', uncertainty: 0.04 });
    expect(e.nearPc).toBeCloseTo(730000, 4);
    expect(e.farPc).toBeCloseTo(810000, 4);
    expect(e.halfExtentPc).toBeCloseTo(40000, 4);
    expect(lineOfSightExtentPc({ value: 10, unit: 'pc', uncertainty: 50 }).nearPc).toBe(0);
    expect(lineOfSightExtentPc({ value: 10, unit: 'pc' }).halfExtentPc).toBe(0);
  });
});

const near = (a: number, b: number, tol = 1e-12) => expect(Math.abs(a - b)).toBeLessThan(tol);

describe('sky plane basis', () => {
  it('is orthonormal, faces the Sun, north up / east left at PA 0', () => {
    const ra = 83.8, dec = -5.4;
    const b = skyPlaneBasis(ra, dec, 0);
    near(length(b.right), 1); near(length(b.up), 1); near(dot(b.right, b.up), 0);
    const u = equatorialToUnit(ra, dec);
    near(dot(b.normal, u), -1); // toward the observer
    const N = northUnit(ra, dec), E = eastUnit(ra);
    near(dot(b.up, N), 1);
    near(dot(b.right, E), -1);
  });
  it('rotates "up" east of north by the position angle', () => {
    const b = skyPlaneBasis(120, 20, 90);
    near(dot(b.up, eastUnit(120)), 1);
    near(dot(b.right, northUnit(120, 20)), 1);
  });
});

describe('disc plane basis', () => {
  const ra = 10.6847, dec = 41.2688;
  const o = { inclinationDeg: 77, positionAngleDeg: 38, nearSide: 'north-west' as const };
  it('is orthonormal and right-handed', () => {
    const b = discPlaneBasis(o, ra, dec);
    near(length(b.major), 1); near(length(b.minorInPlane), 1); near(length(b.normal), 1);
    near(dot(b.major, b.minorInPlane), 0); near(dot(b.major, b.normal), 0); near(dot(b.minorInPlane, b.normal), 0);
    near(dot(b.normal, normalise([b.major[1] * b.minorInPlane[2] - b.major[2] * b.minorInPlane[1], b.major[2] * b.minorInPlane[0] - b.major[0] * b.minorInPlane[2], b.major[0] * b.minorInPlane[1] - b.major[1] * b.minorInPlane[0]])), 1);
  });
  it('major axis lies on the published position angle; normal tilted by the inclination from the line of sight', () => {
    const b = discPlaneBasis(o, ra, dec);
    const N = northUnit(ra, dec), E = eastUnit(ra);
    const pa = Math.atan2(dot(b.major, E), dot(b.major, N)) * 180 / Math.PI;
    near(pa, 38, 1e-9);
    near(Math.abs(dot(b.normal, b.lineOfSight)), Math.cos(77 * Math.PI / 180), 1e-12);
  });
  it('face-on: stretch 1, normal along the line of sight. edge-on: capped, not exact', () => {
    const f = discPlaneBasis({ inclinationDeg: 0, positionAngleDeg: 0 }, 50, 10);
    near(f.stretch, 1); near(Math.abs(dot(f.normal, f.lineOfSight)), 1); expect(f.exact).toBe(true);
    const e = discPlaneBasis({ inclinationDeg: 90, positionAngleDeg: 0 }, 50, 10);
    near(e.stretch, MAX_DEPROJECTION_STRETCH); near(MAX_DEPROJECTION_STRETCH, 5.7587704831, 1e-9);
    expect(e.exact).toBe(false);
    near(Math.abs(dot(e.normal, e.lineOfSight)), 0, 1e-12);
    const mid = discPlaneBasis({ inclinationDeg: 60, positionAngleDeg: 0 }, 50, 10);
    near(mid.stretch, 2, 1e-12); // 1 / cos 60
    expect(discPlaneBasis({ inclinationDeg: 80, positionAngleDeg: 0 }, 50, 10).exact).toBe(true);
    expect(discPlaneBasis({ inclinationDeg: 80.5, positionAngleDeg: 0 }, 50, 10).exact).toBe(false);
  });
  it('near side: the north-west half of the disc is nearer to us; unknown is flagged as a choice', () => {
    const b = discPlaneBasis(o, ra, dec);
    expect(b.tiltDirectionIsAChoice).toBe(false);
    // The NW direction, relative to the major axis, is -p here (p points south-east for PA 38).
    const towardNW = scale(b.minorInPlane, -1);
    expect(dot(towardNW, b.lineOfSight)).toBeLessThan(0); // negative depth component = closer than the centre
    expect(discPlaneBasis({ inclinationDeg: 60, positionAngleDeg: 10 }, ra, dec).tiltDirectionIsAChoice).toBe(true);
    const opposite = discPlaneBasis({ ...o, nearSide: 'south-east' }, ra, dec);
    expect(dot(scale(opposite.minorInPlane, -1), opposite.lineOfSight)).toBeGreaterThan(0);
  });
  it('refuses a near side that does not pick a side of the major axis', () => {
    expect(() => discPlaneBasis({ inclinationDeg: 60, positionAngleDeg: 45, nearSide: 'north-east' }, 0, 0)).toThrow(/side/);
  });
  it('rejects bad inclination', () => { expect(() => discPlaneBasis({ inclinationDeg: 91, positionAngleDeg: 0 }, 0, 0)).toThrow(); });
});

describe('deprojected image reproduces the sky image when viewed from the Sun', () => {
  const ra = 10.6847, dec = 41.2688;
  const dist = { value: 0.77, unit: 'Mpc' };
  const D = 0.77 * METRES_PER_MPC;
  const E = eastUnit(ra), N = northUnit(ra, dec), u = equatorialToUnit(ra, dec);
  const fov: [number, number] = [100, 60];
  const expected = (sx: number, sy: number, upPa: number): [number, number] => {
    const s = skyPlaneBasis(ra, dec, upPa);
    const hw = physicalSizeMetres(fov[0], D) / 2, hh = physicalSizeMetres(fov[1], D) / 2;
    const off = add(scale(s.right, sx * hw), scale(s.up, sy * hh));
    return [dot(off, E), dot(off, N)];
  };
  const cases: { i: number; pa: number; up: number; near: 'north-west' | 'unknown' | 'south-east' }[] = [
    { i: 0, pa: 0, up: 0, near: 'unknown' }, { i: 30, pa: 38, up: 0, near: 'north-west' }, { i: 60, pa: 120, up: 25, near: 'south-east' }, { i: 77, pa: 38, up: 15, near: 'north-west' }, { i: 80, pa: 10, up: 190, near: 'unknown' },
  ];
  it.each(cases)('orthographic projection is exact (i=$i, PA=$pa, up=$up)', ({ i, pa, up, near: ns }) => {
    const pl = discImagePlacement({ inclinationDeg: i, positionAngleDeg: pa, nearSide: ns }, ra, dec, up, fov, dist);
    const signs: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    pl.corners.forEach((c, k) => {
      const [sx, sy] = signs[k]!;
      const [ex, en] = expected(sx, sy, up);
      // Looking along u from the Sun, a 3D point projects to its components on east and north.
      expect(Math.abs(dot(c, E) - ex) / D).toBeLessThan(1e-12);
      expect(Math.abs(dot(c, N) - en) / D).toBeLessThan(1e-12);
    });
  });
  it('perspective from the Sun matches to the depth-of-disc error (up to ~7% at 77 deg, the field is 1.7 deg wide)', () => {
    const pl = discImagePlacement({ inclinationDeg: 77, positionAngleDeg: 38, nearSide: 'north-west' }, ra, dec, 15, fov, dist);
    const signs: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    pl.corners.forEach((c, k) => {
      const [sx, sy] = signs[k]!;
      const [ex, en] = expected(sx, sy, 15);
      const P = add(scale(u, D), c);
      const w = dot(P, u);
      const ge = (dot(P, E) / w) * D, gn = (dot(P, N) / w) * D; // gnomonic
      const mag = Math.hypot(ex, en);
      expect(Math.hypot(ge - ex, gn - en) / mag).toBeLessThan(0.08); // relative error ~ (depth of the tilted corner)/D = b tan(i)/D, up to ~7% for this field at i = 77 deg
    });
  });
  it('maps the unit sky-vector direction of the corners back to the right RA/Dec within the same tolerance', () => {
    const pl = discImagePlacement({ inclinationDeg: 30, positionAngleDeg: 38, nearSide: 'north-west' }, ra, dec, 0, fov, dist);
    const centre = unitToEquatorial(u);
    const c = pl.corners[2]!; // top right
    const sky = unitToEquatorial(normalise(add(scale(u, D), c)));
    const [ex, en] = expected(1, 1, 0);
    const dra = (sky.raDeg - centre.raDeg) * Math.cos(dec * Math.PI / 180) * Math.PI / 180;
    const ddec = (sky.decDeg - centre.decDeg) * Math.PI / 180;
    expect(Math.abs(dra * D - ex) / Math.hypot(ex, en)).toBeLessThan(0.02);
    expect(Math.abs(ddec * D - en) / Math.hypot(ex, en)).toBeLessThan(0.02);
  });
});
