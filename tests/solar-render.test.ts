import { existsSync, readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { SolarSystemData, type TextureProvenanceEntry } from '../src/data/solar/solarCatalogue';
import { SolarLayer, type BodyScreenInfo } from '../src/render/solar/solarLayer';
import { TextureManager } from '../src/render/solar/textures';
import { SolarHierarchy, SOLAR_FRAME } from '../src/render/solar/hierarchy';
import { pickBodyAt, MARKER_HIT_RADIUS, SPHERE_HIT_MARGIN } from '../src/render/solar/pickBody';
import { appearanceOf, APPEARANCE } from '../src/render/solar/appearance';
import { ENHANCED_SCALE, TRUE_SCALE } from '../src/core/solar/displayScale';
import { FrameTree } from '../src/core/spatial/frames';
import { formatDistance, formatNumber } from '../src/core/spatial/scale';
import { METRES_PER_AU, METRES_PER_PARSEC } from '../src/core/units';
import { jdTdbFromIso } from '../src/core/orbits/time';
import { length, sub, type Vec3 } from '../src/core/spatial/vec3';

const run = existsSync('public/data/solar-system.v1.json');
const textures: TextureProvenanceEntry[] = existsSync('public/textures/provenance.json') ? JSON.parse(readFileSync('public/textures/provenance.json', 'utf8')).textures : [];
const data = run ? SolarSystemData.fromFile(JSON.parse(readFileSync('public/data/solar-system.v1.json', 'utf8')), textures) : null;
const JD = jdTdbFromIso('2026-11-12T00:00:00Z');

function camera(width = 1000, height = 800): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(50, width / height, 1, 1e15);
  c.up.set(0, 0, 1);
  return c;
}

/** Aim a camera placed at `pos` (heliocentric metres) at `target`, and return the layer's screen info. */
function frame(layer: SolarLayer, pos: Vec3, target: Vec3, opts: { policy?: typeof ENHANCED_SCALE; focusDistance?: number; selected?: string | null } = {}) {
  const cam = camera();
  cam.position.set(0, 0, 0);
  cam.lookAt(target[0] - pos[0], target[1] - pos[1], target[2] - pos[2]);
  return layer.update({
    jdTdb: JD, camera: cam, camHelio: pos, viewport: { width: 1000, height: 800 }, policy: opts.policy ?? ENHANCED_SCALE,
    selectedId: opts.selected ?? null, nowSeconds: 0, pixelRatio: 1, focusDistance: opts.focusDistance ?? length(sub(target, pos)),
  });
}

function offsetFrom(body: Vec3, dist: number, dir: Vec3 = [0.6, 0.3, 0.74]): Vec3 {
  const l = Math.hypot(...dir);
  return [body[0] + (dir[0] / l) * dist, body[1] + (dir[1] / l) * dist, body[2] + (dir[2] / l) * dist];
}

(run ? describe : describe.skip)('SolarLayer (real dataset, no GPU needed)', () => {
  const mk = () => new SolarLayer(data!, new TextureManager('/', []));
  const earth = (): Vec3 => data!.ephemeris.heliocentricPosition('earth', JD);

  it('draws a nearby planet as a sphere whose apparent size follows its TRUE radius', () => {
    const layer = mk();
    const pos = offsetFrom(earth(), 3e7);
    const info = frame(layer, pos, earth()).get('earth')!;
    const halfTan = Math.tan((50 * Math.PI) / 360);
    expect(info.asSphere).toBe(true);
    expect(info.exaggeration).toBe(1);
    expect(info.pixelRadius).toBeCloseTo((6.371e6 / length(sub(earth(), pos)) / halfTan) * 400, 0);
  });

  it('never alters the physical radius: it equals the dataset value however much the body is enlarged', () => {
    const layer = mk();
    const overview: Vec3 = [0, 0, 6e12];
    const s = frame(layer, overview, [0, 0, 0], { focusDistance: 6e12 });
    for (const [id, info] of s) {
      expect(data!.meanRadiusMetres(id), `${id} has a published radius`).toBeDefined();
      expect(info.physicalRadius, id).toBeCloseTo(data!.meanRadiusMetres(id)!, 6);
      expect(info.displayRadius, id).toBeGreaterThanOrEqual(info.physicalRadius);
    }
  });

  it('enlarges small bodies at overview scale (not to scale) and reports the factor, and not in true-scale mode', () => {
    const overview: Vec3 = [0, 0, 6e12];
    const enlarged = [...frame(mk(), overview, [0, 0, 0], { focusDistance: 6e12 }).values()].filter((i) => i.exaggeration > 1.05);
    expect(enlarged.length).toBeGreaterThan(3);
    const truth = [...frame(mk(), overview, [0, 0, 0], { policy: TRUE_SCALE, focusDistance: 6e12 }).values()];
    for (const i of truth) expect(i.exaggeration).toBe(1);
  });

  it('keeps a distant planet at true scale (a marker) when the camera is close to another body', () => {
    const layer = mk();
    const e = earth();
    const info = frame(layer, offsetFrom(e, 3e7), e).get('venus')!;
    expect(info.exaggeration).toBe(1);
    expect(info.asSphere).toBe(false);
  });

  it('does not let an enlarged planet swallow its Moon’s orbit', () => {
    const layer = mk();
    const e = earth();
    const info = frame(layer, offsetFrom(e, 2e9), e, { focusDistance: 2e9 }).get('earth')!;
    expect(info.displayRadius).toBeLessThanOrEqual(0.2 * 3.84e8 * 1.1);
    expect(info.displayRadius).toBeGreaterThanOrEqual(6.371e6);
  });

  it('points the sunlight uniform at the real Sun (checked against an independent calculation)', () => {
    const layer = mk();
    const e = earth();
    const pos = offsetFrom(e, 3e7);
    const cam = camera();
    cam.position.set(0, 0, 0); cam.lookAt(e[0] - pos[0], e[1] - pos[1], e[2] - pos[2]); cam.updateMatrixWorld();
    layer.update({ jdTdb: JD, camera: cam, camHelio: pos, viewport: { width: 1000, height: 800 }, policy: ENHANCED_SCALE, selectedId: null, nowSeconds: 0, pixelRatio: 1, focusDistance: 3e7 });
    const sunView = (layer.nodes.get('earth')!.mat!.uniforms['uSunView'] as { value: THREE.Vector3 }).value.clone();
    // Independent: Sun (the origin) relative to the camera, rotated into view space by the camera's inverse rotation.
    const expected = new THREE.Vector3(-pos[0], -pos[1], -pos[2]).applyQuaternion(cam.quaternion.clone().invert());
    expect(sunView.angleTo(expected)).toBeLessThan(1e-4);
    expect(sunView.length() / expected.length()).toBeCloseTo(1, 4);
  });

  it('shadows a moon with its parent planet and a planet with its moons (eclipse occluders, true radii)', () => {
    const layer = mk();
    const e = earth();
    frame(layer, offsetFrom(e, 3e7), e);
    const u = layer.nodes.get('earth')!.mat!.uniforms as Record<string, { value: unknown }>;
    expect(u['uOccCount']!.value).toBe(1); // the Moon
    const occ = (u['uOcc']!.value as THREE.Vector4[])[0]!;
    expect(occ.w).toBeCloseTo(1.7374e6, -4); // the Moon's TRUE radius, so the shadow is physically sized
    const j = data!.ephemeris.heliocentricPosition('jupiter', JD);
    frame(layer, offsetFrom(j, 4e8), j);
    expect((layer.nodes.get('jupiter')!.mat!.uniforms['uOccCount'] as { value: number }).value).toBe(4);
  });

  it('draws orbit lines at overview scale and hides a planet’s own orbit when the camera is inside its system', () => {
    const layer = mk();
    frame(layer, [0, 0, 6e12], [0, 0, 0], { focusDistance: 6e12 });
    expect(layer.stats.orbits).toBeGreaterThanOrEqual(6); // Mercury's orbit is only ~8 px across at this distance, so it is correctly not drawn
    frame(layer, [0, 0, 2e12], [0, 0, 0], { focusDistance: 2e12 });
    expect(layer.stats.orbits).toBeGreaterThanOrEqual(8); // closer, all eight planetary orbits are large enough to read
    const e = earth();
    frame(layer, offsetFrom(e, 3e7), e);
    expect(layer.nodes.get('earth')!.orbit?.visible ?? false).toBe(false);
  });

  it('reuses one result map and updates its entries in place (no per-frame allocation of the map)', () => {
    const layer = mk();
    const a = frame(layer, [0, 0, 6e12], [0, 0, 0], { focusDistance: 6e12 });
    const b = frame(layer, [0, 0, 5e12], [0, 0, 0], { focusDistance: 5e12 });
    expect(b).toBe(a);
  });

  it('builds geometry and materials lazily: nothing is created for a body that is never large on screen', () => {
    const layer = mk();
    frame(layer, [0, 0, 6e13], [0, 0, 0], { focusDistance: 6e13 });
    for (const n of layer.nodes.values()) expect(n.mesh, n.id).toBeNull();
  });

  it('reports marker and sphere counts and keeps every body’s heliocentric position equal to the ephemeris', () => {
    const layer = mk();
    const s = frame(layer, [0, 0, 6e12], [0, 0, 0], { focusDistance: 6e12 });
    for (const [id, info] of s) {
      const truth = data!.ephemeris.heliocentricPosition(id, JD);
      expect(length(sub(info.helio, truth)), id).toBeLessThan(1);
    }
    expect(layer.stats.markers + layer.stats.spheres).toBeGreaterThan(0);
  });
});

(run ? describe : describe.skip)('frame hierarchy (existing FrameTree and refit, now driven by the Solar System)', () => {
  const h = () => new SolarHierarchy(data!);
  it('nests Milky Way > stellar neighbourhood > Solar System > planetary systems', () => {
    const t = h().tree;
    expect(t.ancestry('jupiter-system')).toEqual(['jupiter-system', SOLAR_FRAME, 'stellar-neighbourhood', 'milky-way', 'local-group', 'nearby-universe', 'universe']);
    for (const p of ['earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']) expect(t.get(`${p}-system`).parent).toBe(SOLAR_FRAME);
    expect(() => t.get('mercury-system')).toThrow(); // no satellites modelled, so no system frame
  });
  it('moves each system frame with its planet', () => {
    const hh = h();
    hh.update(JD);
    const p = data!.ephemeris.heliocentricPosition('jupiter', JD);
    expect(length(sub(hh.tree.get('jupiter-system').origin, p))).toBeLessThan(1);
    hh.update(JD + 400);
    const p2 = data!.ephemeris.heliocentricPosition('jupiter', JD + 400);
    expect(length(sub(hh.tree.get('jupiter-system').origin, p2))).toBeLessThan(1);
    expect(length(sub(p, p2))).toBeGreaterThan(1e11); // it really moved
  });
  it('converts a moon’s position through the frames to the same heliocentric position as the ephemeris', () => {
    const hh = h();
    hh.update(JD);
    const rel = data!.ephemeris.relativePosition('io', JD);
    const viaFrames = hh.tree.convert({ frame: 'jupiter-system', offset: rel }, 'stellar-neighbourhood');
    const truth = data!.ephemeris.heliocentricPosition('io', JD);
    expect(length(sub(viaFrames, truth)) / length(truth)).toBeLessThan(1e-9);
  });
  it('places a camera in the right frame at several scales, with a readable breadcrumb', () => {
    const hh = h();
    hh.update(JD);
    const e = data!.ephemeris.heliocentricPosition('earth', JD);
    expect(hh.locate([e[0] + 2e7, e[1], e[2]]).frame).toBe('earth-system');
    expect(hh.locate([e[0] + 2e7, e[1], e[2]]).path.map((p) => p.name)).toEqual(['Universe', 'Nearby universe', 'Local Group', 'Milky Way', 'Stellar neighbourhood (Gaia sample)', 'Solar System', 'Earth system']);
    expect(hh.locate([3 * METRES_PER_AU, 0, 0]).frame).toBe(SOLAR_FRAME);
    expect(hh.locate([1000 * METRES_PER_AU, 0, 0]).frame).toBe('stellar-neighbourhood');
    expect(hh.locate([0.5 * METRES_PER_PARSEC * 0 + 1e19, 0, 0]).frame).toBe('stellar-neighbourhood');
  });
  it('has hysteresis: a camera between the enter and exit bounds keeps its current frame (no flicker at a boundary)', () => {
    const hh = h();
    hh.update(JD);
    const e = data!.ephemeris.heliocentricPosition('earth', JD);
    const r = hh.tree.get('earth-system').radius;
    const inside = hh.locate([e[0] + 0.3 * r, e[1], e[2]]).frame; // within the enter bound
    expect(inside).toBe('earth-system');
    const between = hh.locate([e[0] + 0.8 * r, e[1], e[2]], 'earth-system').frame; // between enter and exit, coming from inside
    const fromOutside = hh.locate([e[0] + 0.8 * r, e[1], e[2]], SOLAR_FRAME).frame;
    expect(between).toBe('earth-system');
    expect(fromOutside).toBe(SOLAR_FRAME);
    expect(hh.locate([e[0] + 1.2 * r, e[1], e[2]], 'earth-system').frame).toBe(SOLAR_FRAME);
  });
  it('FrameTree.setOrigin moves a frame and refuses to move the root', () => {
    const t = new FrameTree().add({ id: 'u', parent: null, origin: [0, 0, 0], radius: 100 }).add({ id: 'c', parent: 'u', origin: [1, 0, 0], radius: 10 });
    t.setOrigin('c', [5, 6, 7]);
    expect(t.get('c').origin).toEqual([5, 6, 7]);
    expect(t.convert({ frame: 'c', offset: [0, 0, 0] }, 'u')).toEqual([5, 6, 7]);
    expect(() => t.setOrigin('u', [1, 1, 1])).toThrow(/root/);
  });
});

describe('picking a body', () => {
  const b = (id: string, x: number, y: number, r: number, asSphere: boolean, distance: number): BodyScreenInfo => ({ id, x, y, pixelRadius: r, distance, visible: true, asSphere, physicalRadius: 1, displayRadius: 1, exaggeration: 1, helio: [0, 0, 0] });
  it('hits a drawn disc (with a margin) and a marker (with a generous radius), and nothing in empty sky', () => {
    const list = [b('planet', 500, 400, 100, true, 1e9), b('dot', 100, 100, 2, false, 1e12)];
    expect(pickBodyAt(list, 500 + 100 + SPHERE_HIT_MARGIN - 1, 400)).toBe('planet');
    expect(pickBodyAt(list, 100 + MARKER_HIT_RADIUS - 1, 100)).toBe('dot');
    expect(pickBodyAt(list, 300, 700)).toBeNull();
    expect(pickBodyAt(list, 500 + 100 + SPHERE_HIT_MARGIN + 2, 400)).toBeNull();
  });
  it('prefers the nearer body when discs overlap (a moon in front of its planet)', () => {
    const list = [b('jupiter', 500, 400, 150, true, 4e8), b('io', 520, 410, 20, true, 2e8)];
    expect(pickBodyAt(list, 515, 405)).toBe('io');
    expect(pickBodyAt(list, 400, 400)).toBe('jupiter');
  });
  it('ignores bodies that are not visible', () => {
    const list = [{ ...b('hidden', 500, 400, 100, true, 1), visible: false }];
    expect(pickBodyAt(list, 500, 400)).toBeNull();
  });
});

describe('appearance parameters are visualisation choices, kept separate from science', () => {
  it('every body with a texture id uses an id that exists in the provenance (when it is present)', () => {
    if (textures.length === 0) return;
    const ids = new Set(textures.map((t) => t.id));
    for (const [body, look] of Object.entries(APPEARANCE)) {
      for (const t of [look.day, look.night, look.clouds, look.rings?.texture]) if (t) expect(ids.has(t), `${body}: ${t}`).toBe(true);
    }
  });
  it('gives an unknown body a neutral fallback instead of failing', () => {
    expect(appearanceOf('nonexistent').fallback).toEqual([0.5, 0.5, 0.5]);
  });
  it('uses a luminance-only map for Mercury with a tint, never presenting its false colour', () => {
    expect(appearanceOf('mercury').tint).toBeDefined();
    expect(textures.find((t) => t.id === 'mercury')?.note ?? 'ENHANCED').toMatch(/ENHANCED|false-colour/i);
  });
});

describe('texture manager (no loading needed)', () => {
  it('reads the longitude origin and ring calibration from the provenance, and returns null for unknown textures', () => {
    const tm = new TextureManager('/', textures);
    expect(tm.get('does-not-exist', '2k', 0)).toBeNull();
    if (textures.length === 0) return;
    expect(tm.lonLeftRadians('io')).toBeCloseTo((-180 * Math.PI) / 180, 2);
    const ring = tm.ringRadiiMetres('saturn_rings')!;
    expect(ring[0]).toBeGreaterThan(7.2e7); expect(ring[0]).toBeLessThan(7.8e7);
    expect(ring[1]).toBeGreaterThan(1.39e8); expect(ring[1]).toBeLessThan(1.42e8);
    expect(tm.has('saturn_rings')).toBe(true);
  });
  it('records a ring calibration with its residuals and the known features it was fitted against', () => {
    const e = textures.find((t) => t.id === 'saturn_rings') as unknown as { ring_calibration?: { residual_px: number[]; features_used_km: Record<string, number> } } | undefined;
    if (!e) return;
    expect(e.ring_calibration!.residual_px.every((r) => Math.abs(r) < 40)).toBe(true);
    expect(Object.keys(e.ring_calibration!.features_used_km)).toContain('a_ring_outer_edge');
  });
  it('records GeoTIFF-derived longitude extents for USGS maps, with the implied radius matching the body', () => {
    const io = textures.find((t) => t.id === 'io') as unknown as { lon_left_deg?: number; implied_radius_km?: number; projection_verified_from_geotiff?: boolean } | undefined;
    if (!io) return;
    expect(io.projection_verified_from_geotiff).toBe(true);
    expect(io.lon_left_deg).toBeCloseTo(-180, 1);
    expect(io.implied_radius_km).toBeCloseTo(1821.5, 0);
  });
});

describe('distance formatting spans kilometres to light-years', () => {
  it('chooses a readable unit at each scale', () => {
    expect(formatDistance(384400e3)).toBe('384,400 km');
    expect(formatDistance(METRES_PER_AU)).toBe('1.00 AU');
    expect(formatDistance(0.05 * METRES_PER_AU)).toMatch(/km$/);
    expect(formatDistance(9.4607304725808e15)).toBe('1.00 ly');
    expect(formatDistance(METRES_PER_PARSEC * 4000)).toBe('4.00 kpc');
    expect(formatDistance(0)).toBe('—');
    expect(formatDistance(NaN)).toBe('—');
  });
  it('uses scientific notation for very large or small numbers', () => {
    expect(formatNumber(1.5e8)).toBe('1.50×10⁸');
    expect(formatNumber(0.001)).toBe('1.00×10⁻³');
  });
});

(run ? describe : describe.skip)('a body without a published radius is never given an invented size', () => {
  it('is drawn only as a marker, with no physical or display radius', () => {
    const raw = JSON.parse(readFileSync('public/data/solar-system.v1.json', 'utf8'));
    const iapetus = raw.bodies.find((b: { id: string }) => b.id === 'iapetus');
    delete iapetus.physical.mean_radius;
    iapetus.unavailable.mean_radius = 'test: removed';
    const d = SolarSystemData.fromFile(raw, []);
    const layer = new SolarLayer(d, new TextureManager('/', []));
    const sat = d.ephemeris.heliocentricPosition('saturn', JD);
    const pos: Vec3 = [sat[0] + 1e8, sat[1], sat[2] + 5e7];
    const info = frame(layer, pos, sat).get('iapetus')!;
    expect(info.asSphere).toBe(false);
    expect(Number.isNaN(info.physicalRadius)).toBe(true);
    expect(layer.nodes.get('iapetus')!.mesh).toBeNull();
  });
  it('every body in the shipped dataset now has a published radius (parser regression: plain "Radius (km)" labels)', () => {
    for (const b of data!.file.bodies) expect(b.physical['mean_radius'], b.id).toBeDefined();
    expect(data!.physical('iapetus', 'mean_radius')).toMatchObject({ value: 734.5, uncertainty: 4 });
    expect(data!.physical('iapetus', 'mean_radius')!.note).toMatch(/taken as the mean radius/);
  });
});
