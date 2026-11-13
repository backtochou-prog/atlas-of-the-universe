import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createStellarFrames, createUniverseFrames, LOCAL_GROUP_FRAME, MILKY_WAY_FRAME, NEARBY_UNIVERSE_FRAME, NEIGHBOURHOOD_FRAME, UNIVERSE_FRAME } from '../src/data/catalogue/frames';
import { refit } from '../src/core/spatial/anchor';
import { SolarHierarchy } from '../src/render/solar/hierarchy';
import { SolarSystemData, type TextureProvenanceEntry } from '../src/data/solar/solarCatalogue';
import { METRES_PER_AU, METRES_PER_KPC, METRES_PER_MPC, METRES_PER_PARSEC } from '../src/core/units';
import { equatorialToUnit } from '../src/core/astro/coordinates';
import { galacticToIcrsVector } from '../src/core/astro/coordinates';
import { length, scale, sub, type Vec3 } from '../src/core/spatial/vec3';
import { cameraRelative } from '../src/core/spatial/anchor';

describe('createUniverseFrames', () => {
  const t = createUniverseFrames();
  it('is universe > nearby-universe > local-group > milky-way > stellar-neighbourhood with the specified radii', () => {
    expect(t.ancestry(NEIGHBOURHOOD_FRAME)).toEqual([NEIGHBOURHOOD_FRAME, MILKY_WAY_FRAME, LOCAL_GROUP_FRAME, NEARBY_UNIVERSE_FRAME, UNIVERSE_FRAME]);
    expect(t.get(NEARBY_UNIVERSE_FRAME).radius / (400 * METRES_PER_MPC)).toBeCloseTo(1, 12);
    expect(t.get(LOCAL_GROUP_FRAME).radius / (2 * METRES_PER_MPC)).toBeCloseTo(1, 12);
    expect(t.get(MILKY_WAY_FRAME).radius / (50 * METRES_PER_KPC)).toBeCloseTo(1, 12);
    expect(t.get(NEIGHBOURHOOD_FRAME).radius / (10 * METRES_PER_KPC)).toBeCloseTo(1, 12);
    expect(t.root?.id).toBe(UNIVERSE_FRAME);
  });
  it('the Sun is 8.178 kpc from the Galactic-centre anchor in every upper frame, same as before', () => {
    const sun = t.convert({ frame: NEIGHBOURHOOD_FRAME, offset: [0, 0, 0] }, LOCAL_GROUP_FRAME);
    expect(length(sun) / METRES_PER_PARSEC).toBeCloseTo(8178, 6);
    const towardCentre = galacticToIcrsVector([1, 0, 0]);
    expect(length(sub(sun, scale(towardCentre, -8178 * METRES_PER_PARSEC)))).toBeLessThan(1);
    expect(t.convert({ frame: NEIGHBOURHOOD_FRAME, offset: [0, 0, 0] }, UNIVERSE_FRAME)).toEqual(sun);
  });
  it('the local-group origin is the Galactic-centre anchor, not a barycentre (origin of milky-way and local-group coincide)', () => {
    expect(t.get(LOCAL_GROUP_FRAME).origin).toEqual([0, 0, 0]);
    expect(t.get(MILKY_WAY_FRAME).origin).toEqual([0, 0, 0]);
  });
  it('createStellarFrames is unchanged: milky-way is the root', () => {
    const s = createStellarFrames();
    expect(s.root?.id).toBe(MILKY_WAY_FRAME);
    expect(s.ancestry(NEIGHBOURHOOD_FRAME)).toEqual([NEIGHBOURHOOD_FRAME, MILKY_WAY_FRAME]);
  });
  it('refit places a Sun-centred point in the right frame at several distances', () => {
    const at = (pc: number) => refit(t, { frame: NEIGHBOURHOOD_FRAME, offset: scale(equatorialToUnit(30, 20), pc * METRES_PER_PARSEC) }).frame;
    expect(at(100)).toBe(NEIGHBOURHOOD_FRAME);
    expect(at(100_000)).toBe(LOCAL_GROUP_FRAME);
    expect(at(20_000_000)).toBe(NEARBY_UNIVERSE_FRAME);
    expect(at(2_000_000_000)).toBe(UNIVERSE_FRAME);
  });
});

describe('float64 precision through the chain (what is and is not achievable)', () => {
  const t = createUniverseFrames();
  const ulp = (x: number) => 2 ** (Math.floor(Math.log2(Math.abs(x))) - 52);
  const dir = equatorialToUnit(187.7, 12.4);
  const starOrigin: Vec3 = scale(dir, 10 * METRES_PER_MPC);
  t.add({ id: 'star-10mpc', parent: NEARBY_UNIVERSE_FRAME, origin: starOrigin, radius: 1e14 });
  const oneAu: Vec3 = [METRES_PER_AU, 0, 0];

  it('a point 1 AU from a star at 10 Mpc, kept in the star frame, is exact (0 m error) however the camera moves in that frame', () => {
    const cam = { frame: 'star-10mpc', offset: [0.5 * METRES_PER_AU, 0, 0] as Vec3 };
    const rel = cameraRelative(t, { frame: 'star-10mpc', offset: oneAu }, cam);
    expect(Math.abs(rel[0]! - 0.5 * METRES_PER_AU)).toBeLessThan(1e4 /* float32 narrowing of 7.5e10 */);
    expect(t.convert({ frame: 'star-10mpc', offset: oneAu }, 'star-10mpc')).toEqual(oneAu);
  });
  it('rebasing that point up to nearby-universe and back is limited by float64 resolution at 3e23 m (~7e7 m), NOT below 1 km: rebasing never sums through the root, but 10 Mpc itself is that large', () => {
    const up = t.convert({ frame: 'star-10mpc', offset: oneAu }, NEARBY_UNIVERSE_FRAME);
    const back = t.convert({ frame: NEARBY_UNIVERSE_FRAME, offset: up }, 'star-10mpc');
    const err = length(sub(back, oneAu));
    const bound = 2 * ulp(10 * METRES_PER_MPC) * Math.sqrt(3);
    expect(err).toBeLessThanOrEqual(bound);
    expect(ulp(10 * METRES_PER_MPC)).toBeGreaterThan(1e7); // so the "1 km" target is impossible by this route; keep camera state in its deepest frame
  });
  it('via the universe root the answer is identical (the Galactic anchor adds nothing), so the chain does not add error beyond the magnitude itself', () => {
    const viaNearby = t.convert({ frame: 'star-10mpc', offset: oneAu }, NEARBY_UNIVERSE_FRAME);
    const viaRoot = t.convert({ frame: 'star-10mpc', offset: oneAu }, UNIVERSE_FRAME);
    expect(viaRoot).toEqual(viaNearby);
  });
  it('a point 1 AU from the Sun converts to the local-group frame and back within the resolution at 8 kpc (~33 km), and exactly when kept in the neighbourhood frame', () => {
    const up = t.convert({ frame: NEIGHBOURHOOD_FRAME, offset: oneAu }, LOCAL_GROUP_FRAME);
    const back = t.convert({ frame: LOCAL_GROUP_FRAME, offset: up }, NEIGHBOURHOOD_FRAME);
    expect(length(sub(back, oneAu))).toBeLessThanOrEqual(4 * ulp(8178 * METRES_PER_PARSEC));
    expect(t.convert({ frame: NEIGHBOURHOOD_FRAME, offset: oneAu }, NEIGHBOURHOOD_FRAME)).toEqual(oneAu);
  });
});

const dataPath = 'public/data/solar-system.v1.json';
const run = existsSync(dataPath);
const textures: TextureProvenanceEntry[] = existsSync('public/textures/provenance.json') ? JSON.parse(readFileSync('public/textures/provenance.json', 'utf8')).textures : [];
(run ? describe : describe.skip)('SolarHierarchy breadcrumb on the universe frames (skip reason: public/data/solar-system.v1.json not present)', () => {
  const h = () => new SolarHierarchy(SolarSystemData.fromFile(JSON.parse(readFileSync(dataPath, 'utf8')), textures));
  const names = (x: Vec3) => h().locate(x).path.map((p) => p.name);
  const away = (m: number): Vec3 => scale(equatorialToUnit(266.4, -29.0), -m); // away from the Galactic centre
  it('100 kpc from the Sun reads Universe > Nearby universe > Local Group', () => {
    expect(names(away(100_000 * METRES_PER_PARSEC))).toEqual(['Universe', 'Nearby universe', 'Local Group']);
  });
  it('20 Mpc reads Universe > Nearby universe', () => {
    expect(names(away(20 * METRES_PER_MPC))).toEqual(['Universe', 'Nearby universe']);
  });
  it('5 pc still reads down to the stellar neighbourhood, and the new frames have kinds', () => {
    const hh = h();
    expect(hh.locate(away(5 * METRES_PER_PARSEC)).path.map((p) => p.name)).toEqual(['Universe', 'Nearby universe', 'Local Group', 'Milky Way', 'Stellar neighbourhood (Gaia sample)']);
    expect(hh.label(UNIVERSE_FRAME)?.kind).toBe('universe');
    expect(hh.label(LOCAL_GROUP_FRAME)?.kind).toBe('anchor region');
  });
  it('zooming out through a boundary has hysteresis (does not flicker between Local Group and Nearby universe)', () => {
    const hh = h();
    const r = 2 * METRES_PER_MPC;
    // 1.2 Mpc from the anchor: inside local-group's exit bound (1.0 r) -> stay when coming from there
    const p = away(1.2 * METRES_PER_MPC);
    expect(hh.locate(p, LOCAL_GROUP_FRAME).frame).toBe(LOCAL_GROUP_FRAME);
    expect(hh.locate(p, NEARBY_UNIVERSE_FRAME).frame).toBe(NEARBY_UNIVERSE_FRAME); // from outside: not deep enough (enter 0.5 r = 1 Mpc)
    void r;
  });
});
