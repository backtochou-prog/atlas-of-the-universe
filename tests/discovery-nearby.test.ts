import { describe, expect, it } from 'vitest';
import { createUniverseFrames, LOCAL_GROUP_FRAME, NEIGHBOURHOOD_FRAME, UNIVERSE_FRAME } from '../src/data/catalogue/frames';
import type { SpatialPosition } from '../src/core/spatial/frames';
import { FrameTree } from '../src/core/spatial/frames';
import { formatDistance } from '../src/core/spatial/scale';
import { METRES_PER_AU, METRES_PER_MPC, METRES_PER_PARSEC } from '../src/core/units';
import type { Vec3 } from '../src/core/spatial/vec3';
import { RecordStore } from '../src/discovery/recordStore';
import { SOLAR_SYSTEM_FRAME, findNearby, frustumPlanes, heliocentricDomain, originOf, solarDomain, visibleRegion, type SolarBodyPosition } from '../src/discovery/nearby';
import { buildSpatialIndex } from '../src/discovery/spatialIndex';
import type { DiscoveryRecord, ObjectCategory } from '../src/discovery/types';
import { mulberry32, rec } from './fixtures/discovery/synthetic';

const PC = METRES_PER_PARSEC;
const star = (id: string, xyz: Vec3, category: ObjectCategory = 'star', dataset: DiscoveryRecord['dataset'] = 'gaia-dr3'): DiscoveryRecord =>
  rec(id, id, [id], category, { dataset, position: { kind: 'icrs', xyzPc: xyz, raDeg: 0, decDeg: 0 }, measurements: { distancePc: { value: Math.hypot(...xyz), kind: 'derived' } } });

function frames(): FrameTree {
  const t = createUniverseFrames();
  t.add({ id: SOLAR_SYSTEM_FRAME, parent: NEIGHBOURHOOD_FRAME, origin: [0, 0, 0], radius: 100 * METRES_AU });
  // a star system frame centred on a star 3 pc away (non-zero origin: the case where a naive subtraction goes wrong)
  t.add({ id: 'alpha-system', parent: NEIGHBOURHOOD_FRAME, origin: [3 * PC, -1 * PC, 0.5 * PC], radius: 1e14 });
  return t;
}
const METRES_AU = METRES_PER_AU;

const solarBodies = (): SolarBodyPosition[] => [
  { id: 'solar:sun', category: 'star', dataset: 'solar-system', offsetMetres: [0, 0, 0] },
  { id: 'solar:earth', category: 'planet', dataset: 'solar-system', offsetMetres: [1 * METRES_AU, 0, 0] },
  { id: 'solar:jupiter', category: 'planet', dataset: 'solar-system', offsetMetres: [0, 5.2 * METRES_AU, 0] },
  { id: 'solar:moon', category: 'moon', dataset: 'solar-system', offsetMetres: [1 * METRES_AU + 3.844e8, 0, 0] },
];

describe('findNearby', () => {
  const recs = [
    star('s:proxima', [-1.5, -1.2, -3.8]), star('s:alpha', [-1.6, -1.3, -3.7]), star('s:sirius', [-1.6, 8.0, -2.5]), star('s:far', [50, 50, 50]),
    star('h:host', [10, 0, 0], 'exoplanet-host', 'nasa-exoplanet-archive'),
  ];
  const store = RecordStore.from(recs);
  const tree = buildSpatialIndex(store);
  const ft = frames();
  const hel = heliocentricDomain(store, tree);
  const sol = solarDomain(solarBodies);

  it('requires a radius or k, and validates them', () => {
    const origin: SpatialPosition = { frame: NEIGHBOURHOOD_FRAME, offset: [0, 0, 0] };
    expect(() => findNearby({ origin, frames: ft, domains: [hel] })).toThrow();
    expect(() => findNearby({ origin, frames: ft, domains: [hel], k: 0 })).toThrow(RangeError);
    expect(() => findNearby({ origin, frames: ft, domains: [hel], radiusMetres: -1 })).toThrow(RangeError);
    expect(() => findNearby({ origin: { frame: 'nowhere', offset: [0, 0, 0] }, frames: ft, domains: [hel], k: 1 })).toThrow(/Unknown frame/);
  });

  it('nearest 3 stars to a point, with distances in metres and display units', () => {
    const origin: SpatialPosition = { frame: NEIGHBOURHOOD_FRAME, offset: [-1.55 * PC, -1.25 * PC, -3.75 * PC] };
    const r = findNearby({ origin, frames: ft, domains: [hel], k: 3 });
    expect(r.neighbours.map((n) => n.id)).toEqual(['s:alpha', 's:proxima', 's:sirius']);
    const expected = Math.hypot(0.05, 0.05, 0.05) * PC;
    expect(r.neighbours[0]!.distanceMetres).toBeCloseTo(expected, -3);
    expect(r.neighbours[0]!.distanceText).toBe(formatDistance(r.neighbours[0]!.distanceMetres));
    expect(r.neighbours[0]!.domain).toBe('heliocentric');
    expect(r.neighbours.map((n) => n.distanceMetres)).toEqual([...r.neighbours.map((n) => n.distanceMetres)].sort((a, b) => a - b));
  });

  it('radius query, categories and datasets', () => {
    const origin: SpatialPosition = { frame: NEIGHBOURHOOD_FRAME, offset: [0, 0, 0] };
    const r = findNearby({ origin, frames: ft, domains: [hel], radiusMetres: 12 * PC });
    expect(r.neighbours.map((n) => n.id).sort()).toEqual(['h:host', 's:alpha', 's:proxima', 's:sirius']);
    expect(findNearby({ origin, frames: ft, domains: [hel], radiusMetres: 12 * PC, categories: ['exoplanet-host'] }).neighbours.map((n) => n.id)).toEqual(['h:host']);
    expect(findNearby({ origin, frames: ft, domains: [hel], radiusMetres: 100 * PC, datasets: ['nasa-exoplanet-archive'] }).neighbours.map((n) => n.id)).toEqual(['h:host']);
    expect(findNearby({ origin, frames: ft, domains: [hel], radiusMetres: 1 * PC }).neighbours).toEqual([]);
    expect(findNearby({ origin, frames: ft, domains: [hel], k: 2, radiusMetres: 4.5 * PC }).neighbours.map((n) => n.id)).toEqual(['s:alpha', 's:proxima']);   // k within a radius
  });

  it('never returns the origin object itself', () => {
    const origin = originOf(store, store.indexOfId('s:proxima'))!;
    const withSelf = findNearby({ origin, frames: ft, domains: [hel], k: 3 });
    expect(withSelf.neighbours[0]!.id).toBe('s:proxima');                       // without telling it who the origin is, the star is its own nearest neighbour (distance 0)
    expect(withSelf.neighbours[0]!.distanceMetres).toBeLessThan(100);            // zero up to the float64 round trip of pc -> m -> pc (metres, against 1e16)
    const r = findNearby({ origin, frames: ft, domains: [hel], k: 3, originId: 's:proxima' });
    expect(r.neighbours.map((n) => n.id)).toEqual(['s:alpha', 's:sirius', 'h:host']);
  });

  it('solar-system bodies come from the callback in their own frame and merge with stars in one distance order', () => {
    const origin: SpatialPosition = { frame: SOLAR_SYSTEM_FRAME, offset: [1 * METRES_AU, 0, 0] };           // at Earth
    const r = findNearby({ origin, frames: ft, domains: [sol, hel], radiusMetres: 6 * METRES_AU, originId: 'solar:earth' });
    expect(r.neighbours.map((n) => n.id)).toEqual(['solar:moon', 'solar:sun', 'solar:jupiter']);
    expect(r.neighbours[0]!.distanceMetres).toBeCloseTo(3.844e8, -2);
    expect(r.neighbours[0]!.domain).toBe('solar-system');
    const far = findNearby({ origin, frames: ft, domains: [sol, hel], k: 6, originId: 'solar:earth' });
    expect(far.neighbours.slice(0, 3).map((n) => n.id)).toEqual(['solar:moon', 'solar:sun', 'solar:jupiter']);
    expect(far.neighbours.slice(3).map((n) => n.domain)).toEqual(['heliocentric', 'heliocentric', 'heliocentric']);
    expect(findNearby({ origin, frames: ft, domains: [sol], radiusMetres: 10 * METRES_AU, categories: ['moon'] }).neighbours.map((n) => n.id)).toEqual(['solar:moon']);
  });

  it('an origin given in the solar-system frame equals the same point given in the neighbourhood frame', () => {
    const bodies = (): SolarBodyPosition[] => solarBodies();
    const sSol = findNearby({ origin: { frame: SOLAR_SYSTEM_FRAME, offset: [2 * METRES_AU, 1 * METRES_AU, 0] }, frames: ft, domains: [solarDomain(bodies), hel], k: 8 });
    const sNb = findNearby({ origin: { frame: NEIGHBOURHOOD_FRAME, offset: [2 * METRES_AU, 1 * METRES_AU, 0] }, frames: ft, domains: [solarDomain(bodies), hel], k: 8 });
    expect(sSol.neighbours).toEqual(sNb.neighbours);
    // and the same point expressed in a star-system frame that is displaced from the Sun gives the same result again
    const alphaOrigin = ft.get('alpha-system').origin;
    const inAlpha: SpatialPosition = { frame: 'alpha-system', offset: [-alphaOrigin[0] + 2 * METRES_AU, -alphaOrigin[1] + 1 * METRES_AU, -alphaOrigin[2]] };
    const sAlpha = findNearby({ origin: inAlpha, frames: ft, domains: [solarDomain(bodies), hel], k: 8 });
    expect(sAlpha.neighbours.map((n) => n.id)).toEqual(sNb.neighbours.map((n) => n.id));
    for (let i = 0; i < sAlpha.neighbours.length; i++) expect(sAlpha.neighbours[i]!.distanceMetres / sNb.neighbours[i]!.distanceMetres).toBeCloseTo(1, 9);
  });

  it('no cross-frame subtraction: a point in a displaced local frame is converted before comparing', () => {
    // the origin sits 0.1 pc from the star s:alpha-local in the shared frame, but its LOCAL offset is tiny
    const a = [3.1, -1, 0.5] as const;
    const local = RecordStore.from([star('s:near', a), star('s:other', [0, 0, 0.2]), star('s:third', [3, -1, 0.9])]);
    const dom = heliocentricDomain(local, buildSpatialIndex(local));
    const origin: SpatialPosition = { frame: 'alpha-system', offset: [0.05 * PC, 0, 0] };            // = (3.05, -1, 0.5) pc in the neighbourhood frame
    const r = findNearby({ origin, frames: ft, domains: [dom], k: 3 });
    expect(r.neighbours.map((n) => n.id)).toEqual(['s:near', 's:third', 's:other']);
    expect(r.neighbours[0]!.distanceMetres).toBeCloseTo(0.05 * PC, -4);
    // the wrong way (compare the raw local offset with heliocentric positions) gives a different, wrong order: this is what the rule prevents
    const naive = [...local.records].map((s) => ({ id: s.id, d: Math.hypot(...(s.position.kind === 'icrs' ? s.position.xyzPc : [NaN, NaN, NaN]).map((v, i) => v - origin.offset[i]! / PC)) }))
      .sort((x, y) => x.d - y.d).map((x) => x.id);
    expect(naive).not.toEqual(r.neighbours.map((n) => n.id));
    expect(naive[0]).toBe('s:other');
    expect(r.originInDomain['heliocentric']![0]).toBeCloseTo(3.05 * PC, -3);
  });

  it('a galaxy at 10 Mpc as origin: float64 keeps neighbours a parsec away accurate', () => {
    const base: Vec3 = [6e6, 7e6, 3e6];               // |base| ~ 9.7 Mpc
    const nb = [[0.3, 0, 0], [0, 0.6, 0], [0, 0, -0.9], [1.5, 1.5, 0]] as const;
    const recs2 = nb.map((o, i) => star(`g:${i}`, [base[0] + o[0], base[1] + o[1], base[2] + o[2]], 'galaxy', 'deep-space'));
    const s2 = RecordStore.from([...recs2, star('g:far', [1e5, 0, 0], 'galaxy', 'deep-space')]);
    const dom = heliocentricDomain(s2, buildSpatialIndex(s2));
    const origin: SpatialPosition = { frame: NEIGHBOURHOOD_FRAME, offset: [base[0] * PC, base[1] * PC, base[2] * PC] };
    const r = findNearby({ origin, frames: ft, domains: [dom], radiusMetres: 3 * PC });
    expect(r.neighbours.map((n) => n.id)).toEqual(['g:0', 'g:1', 'g:2', 'g:3']);
    const truth = [0.3, 0.6, 0.9, Math.hypot(1.5, 1.5)];
    r.neighbours.forEach((n, i) => expect(Math.abs(n.distanceMetres / PC - truth[i]!) / truth[i]!).toBeLessThan(1e-7));
    expect(Math.hypot(...origin.offset) / METRES_PER_MPC).toBeGreaterThan(9);
  });

  it('works from an origin in the Local Group frame (anchored at the Galactic centre) and the universe root', () => {
    const origin: SpatialPosition = { frame: NEIGHBOURHOOD_FRAME, offset: [1 * PC, 1 * PC, 1 * PC] };
    const viaUniverse = ft.rebaseTo(origin, UNIVERSE_FRAME);
    const viaGroup = ft.rebaseTo(origin, LOCAL_GROUP_FRAME);
    const a = findNearby({ origin, frames: ft, domains: [hel], k: 3 });
    const b = findNearby({ origin: viaUniverse, frames: ft, domains: [hel], k: 3 });
    const c = findNearby({ origin: viaGroup, frames: ft, domains: [hel], k: 3 });
    expect(b.neighbours.map((n) => n.id)).toEqual(a.neighbours.map((n) => n.id));
    expect(c.neighbours.map((n) => n.id)).toEqual(a.neighbours.map((n) => n.id));
  });

  it('no domains or an empty domain gives no neighbours', () => {
    const origin: SpatialPosition = { frame: NEIGHBOURHOOD_FRAME, offset: [0, 0, 0] };
    expect(findNearby({ origin, frames: ft, domains: [], k: 3 }).neighbours).toEqual([]);
    const empty = RecordStore.from([]);
    expect(findNearby({ origin, frames: ft, domains: [heliocentricDomain(empty, buildSpatialIndex(empty))], k: 3 }).neighbours).toEqual([]);
  });

  it('brute-force equivalence over random stars and origins in three different frames (500 queries)', () => {
    const rnd = mulberry32(21);
    const rs: DiscoveryRecord[] = [];
    for (let i = 0; i < 1500; i++) { const s = Math.pow(10, rnd() * 3); rs.push(star(`r:${i}`, [(rnd() - 0.5) * s, (rnd() - 0.5) * s, (rnd() - 0.5) * s])); }
    const st = RecordStore.from(rs);
    const dom = heliocentricDomain(st, buildSpatialIndex(st));
    const fr = ['alpha-system', NEIGHBOURHOOD_FRAME, SOLAR_SYSTEM_FRAME];
    for (let q = 0; q < 500; q++) {
      const f = fr[q % 3]!;
      const origin: SpatialPosition = { frame: f, offset: [(rnd() - 0.5) * 20 * PC, (rnd() - 0.5) * 20 * PC, (rnd() - 0.5) * 20 * PC] };
      const o = ft.convert(origin, NEIGHBOURHOOD_FRAME);
      const k = 1 + Math.floor(rnd() * 10);
      const expected = rs.map((r) => ({ id: r.id, d: Math.hypot(...(r.position as { xyzPc: Vec3 }).xyzPc.map((v, i) => v * PC - o[i]!)) })).sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : 1)).slice(0, k);
      const got = findNearby({ origin, frames: ft, domains: [dom], k }).neighbours;
      expect(got.map((n) => n.id)).toEqual(expected.map((e) => e.id));
    }
  });
});

describe('visibleRegion', () => {
  const ft = frames();
  const rnd = mulberry32(31);
  const recs: DiscoveryRecord[] = [];
  for (let i = 0; i < 2000; i++) recs.push(star(`v:${i}`, [(rnd() - 0.5) * 400, (rnd() - 0.5) * 400, (rnd() - 0.5) * 400], i % 3 === 0 ? 'galaxy' : 'star', i % 2 ? 'ungc' : 'gaia-dr3'));
  const store = RecordStore.from(recs);
  const dom = heliocentricDomain(store, buildSpatialIndex(store));

  const inFrustum = (p: Vec3, cam: Vec3, fwd: Vec3, up: Vec3, fovY: number, aspect: number, near: number, far: number): boolean => {
    const f = fwd.map((v) => v / Math.hypot(...fwd)) as unknown as Vec3;
    const r0: Vec3 = [f[1] * up[2] - f[2] * up[1], f[2] * up[0] - f[0] * up[2], f[0] * up[1] - f[1] * up[0]];
    const rl = Math.hypot(...r0);
    const right = r0.map((v) => v / rl) as unknown as Vec3;
    const u: Vec3 = [right[1] * f[2] - right[2] * f[1], right[2] * f[0] - right[0] * f[2], right[0] * f[1] - right[1] * f[0]];
    const d = [p[0] - cam[0], p[1] - cam[1], p[2] - cam[2]];
    const z = d[0]! * f[0] + d[1]! * f[1] + d[2]! * f[2];
    if (z < near || z > far) return false;
    const x = d[0]! * right[0] + d[1]! * right[1] + d[2]! * right[2];
    const y = d[0]! * u[0] + d[1]! * u[1] + d[2]! * u[2];
    const ty = Math.tan((fovY * Math.PI) / 360);
    return Math.abs(y) <= z * ty && Math.abs(x) <= z * ty * aspect;
  };

  it('equals an exact per-point frustum test (200 random cameras)', () => {
    let nonEmpty = 0;
    for (let n = 0; n < 200; n++) {
      const cam: Vec3 = [(rnd() - 0.5) * 300, (rnd() - 0.5) * 300, (rnd() - 0.5) * 300];
      const fwd: Vec3 = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
      const up: Vec3 = [rnd() - 0.5, rnd() - 0.5, 1];
      const fov = 20 + rnd() * 100, aspect = 0.6 + rnd() * 1.4;
      const far = 50 + rnd() * 400;
      const frame = n % 2 === 0 ? NEIGHBOURHOOD_FRAME : 'alpha-system';
      const camMetres: Vec3 = [cam[0] * PC, cam[1] * PC, cam[2] * PC];
      const camPos: SpatialPosition = frame === NEIGHBOURHOOD_FRAME ? { frame, offset: camMetres } : { frame, offset: [camMetres[0] - 3 * PC, camMetres[1] + 1 * PC, camMetres[2] - 0.5 * PC] };
      const res = visibleRegion({ camera: camPos, frames: ft, domains: [dom], forward: fwd, up, fovYDeg: fov, aspect, maxDistanceMetres: far * PC, limit: 5000 });
      const expected = recs.filter((r) => inFrustum((r.position as { xyzPc: Vec3 }).xyzPc, cam, fwd, up, fov, aspect, 0, far)).map((r) => r.id);
      expect(res.objects.map((o) => o.id).sort(), `camera ${n}`).toEqual(expected.sort());
      if (expected.length > 0) nonEmpty++;
      const d = res.objects.map((o) => o.distanceMetres);
      expect(d).toEqual([...d].sort((a, b) => a - b));
    }
    expect(nonEmpty).toBeGreaterThan(150);
  });

  it('category filter, limit (nearest first) and near plane', () => {
    const base = { camera: { frame: NEIGHBOURHOOD_FRAME, offset: [0, 0, 0] as Vec3 }, frames: ft, domains: [dom], forward: [1, 0, 0] as Vec3, up: [0, 0, 1] as Vec3, fovYDeg: 120, aspect: 1.5, maxDistanceMetres: 300 * PC };
    const all = visibleRegion({ ...base, limit: 5000 });
    expect(all.total).toBe(all.objects.length);
    const gal = visibleRegion({ ...base, categories: ['galaxy'], limit: 5000 });
    expect(gal.objects.every((o) => o.category === 'galaxy')).toBe(true);
    expect(gal.total).toBeLessThan(all.total);
    const few = visibleRegion({ ...base, limit: 5 });
    expect(few.objects.map((o) => o.id)).toEqual(all.objects.slice(0, 5).map((o) => o.id));
    expect(few.total).toBe(all.total);
    const nearCut = visibleRegion({ ...base, nearMetres: 100 * PC, limit: 5000 });
    expect(nearCut.objects.every((o) => o.distanceMetres >= 100 * PC)).toBe(true);
    expect(visibleRegion({ ...base, datasets: ['ungc'], limit: 5000 }).objects.every((o) => o.dataset === 'ungc')).toBe(true);
  });

  it('nothing behind the camera; a narrow cone sees less than a wide one', () => {
    const base = { camera: { frame: NEIGHBOURHOOD_FRAME, offset: [0, 0, 0] as Vec3 }, frames: ft, domains: [dom], up: [0, 0, 1] as Vec3, aspect: 1, maxDistanceMetres: 1000 * PC, limit: 5000 };
    const fwd = visibleRegion({ ...base, forward: [1, 0, 0], fovYDeg: 60 });
    const back = visibleRegion({ ...base, forward: [-1, 0, 0], fovYDeg: 60 });
    const ids = new Set(fwd.objects.map((o) => o.id));
    for (const o of back.objects) expect(ids.has(o.id)).toBe(false);
    expect(visibleRegion({ ...base, forward: [1, 0, 0], fovYDeg: 10 }).total).toBeLessThan(fwd.total);
  });

  it('the Solar System bodies are tested with the same frustum, in their own frame', () => {
    const sol = solarDomain(solarBodies);
    const r = visibleRegion({ camera: { frame: SOLAR_SYSTEM_FRAME, offset: [-1 * METRES_AU, 0, 0] }, frames: ft, domains: [sol], forward: [1, 0, 0], up: [0, 0, 1], fovYDeg: 30, aspect: 1, maxDistanceMetres: 10 * METRES_AU });
    expect(r.objects.map((o) => o.id)).toEqual(['solar:sun', 'solar:earth', 'solar:moon']);           // Jupiter is 5.2 AU off-axis, outside a 30 degree cone at that range? (checked below)
  });

  it('rejects an invalid frustum', () => {
    expect(() => frustumPlanes([0, 0, 0], [1, 0, 0], [0, 0, 1], 0, 1, 0, 10)).toThrow(RangeError);
    expect(() => frustumPlanes([0, 0, 0], [1, 0, 0], [0, 0, 1], 60, 0, 0, 10)).toThrow(RangeError);
    expect(() => frustumPlanes([0, 0, 0], [1, 0, 0], [0, 0, 1], 60, 1, 10, 5)).toThrow(RangeError);
    expect(() => frustumPlanes([0, 0, 0], [0, 0, 0], [0, 0, 1], 60, 1, 0, 5)).toThrow();
    expect(frustumPlanes([0, 0, 0], [1, 0, 0], [0, 0, 1], 60, 1, 0, 5)).toHaveLength(24);
  });
});
