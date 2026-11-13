/**
 * ViewerNavigationHost: the view-distance rules, flights per category, proxies, inspect-only results, snapshots (Prompt 07, R2a). A viewer double stands in for the WebGL viewer.
 */
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/core/spatial/vec3';
import { METRES_PER_AU, METRES_PER_PARSEC } from '../src/core/units';
import { NavigationController } from '../src/discovery/navigation';
import type { DiscoveryRecord, UniversalId } from '../src/discovery/types';
import {
  NO_DISTANCE_REASON, STAR_VIEW_MAX_PC, STAR_VIEW_PC, ViewerNavigationHost, apparentMagAt, catalogueViewDistancePc, starViewDistancePc, type HostViewer, type Placement,
} from '../src/render/discovery/ViewerNavigationHost';
import type { ViewerCameraSnapshot } from '../src/render/viewer';

const star = (id: string, xyz: Vec3, over: Partial<DiscoveryRecord> = {}): DiscoveryRecord => ({
  id, dataset: 'gaia-dr3', category: 'star', name: id, designations: [], classification: 'K-type star',
  position: { kind: 'icrs', xyzPc: xyz, raDeg: 10, decDeg: 20 }, measurements: {}, drawn: true, sourceKey: 'gaia-dr3', ...over,
});

class FakeViewer implements HostViewer {
  state = { focus: [0, 0, 0] as Vec3, distance: 60, yaw: 0.6, pitch: 0.35 };
  frame = { id: 'stellar-neighbourhood' };
  jdTdb = 2460000;
  brightness = { magLimit: 9 };
  viewport = { width: 1200, height: 800 };
  solarData: HostViewer['solarData'] = { file: { bodies: [{ id: 'sun' }, { id: 'jupiter' }, { id: 'io' }] }, get: (id) => (['sun', 'jupiter', 'io'].includes(id) ? {} : undefined) };
  deep: HostViewer['deep'] = { viewDistancePc: (id) => (id === 'm31' ? 52000 : undefined) };
  deepData: HostViewer['deepData'] = { get: (id) => (['m31', 'milky-way', 'local-group'].includes(id) ? {} : undefined) };
  calls: string[] = [];
  proxy: unknown = 'unset';
  highlights: readonly unknown[] = [];
  point: { xyz: Vec3; d: number; ms: number | undefined } | null = null;
  snap: ViewerCameraSnapshot | null = null;
  restored: ViewerCameraSnapshot | null = null;
  viewDistancePc(id: string): number { return id === 'jupiter' ? 3.3e-9 : 1e-12; }
  bodyHelioPc(id: string): Vec3 { return id === 'jupiter' ? [(5.2 * METRES_PER_AU) / METRES_PER_PARSEC, 0, 0] : [0, 0, 0]; }
  flyToBody(id: string): void { this.calls.push(`body:${id}`); }
  flyToDeep(id: string): void { this.calls.push(`deep:${id}`); }
  flyToLocalGroup(): void { this.calls.push('local-group'); }
  flyToPointPc(xyz: Vec3, d: number, ms?: number): boolean { const ok = xyz.every(Number.isFinite) && d > 0; if (ok) { this.calls.push('point'); this.point = { xyz, d, ms }; } return ok; }
  snapshotCamera(): ViewerCameraSnapshot { return this.snap ?? { ...this.state, frameId: this.frame.id, followId: 'jupiter', selectedBody: 'jupiter', selectedDeep: null }; }
  restoreCamera(s: ViewerCameraSnapshot): void { this.restored = s; }
  setHighlights(items: readonly unknown[]): void { this.highlights = items; }
  setSelectionProxy(p: unknown): void { this.proxy = p; }
}

function setup(records: DiscoveryRecord[], v = new FakeViewer()) {
  const byId = new Map(records.map((r) => [r.id, r] as const));
  const host = new ViewerNavigationHost(v, (id) => byId.get(id), (b) => (b === 'jupiter' ? [5.2 * METRES_PER_AU, 0, 0] : [0, 0, 0]));
  const placements: Placement[] = [];
  host.onPlacement = (p) => placements.push(p);
  const nav = new NavigationController(host);
  return { v, host, nav, placements, byId };
}

describe('view-distance rules', () => {
  it('a nearby star: 4 pc; a distant star keeps two sigma of distance uncertainty in view', () => {
    expect(starViewDistancePc(star('a', [1, 0, 0], { measurements: { distancePc: { value: 1, kind: 'derived', uncertainty: 0.001 } } }))).toBe(STAR_VIEW_PC);
    expect(starViewDistancePc(star('a', [1, 0, 0]))).toBe(STAR_VIEW_PC);
    const far = star('b', [800, 0, 0], { measurements: { distancePc: { value: 800, kind: 'derived', uncertainty: 80 } } });
    expect(starViewDistancePc(far)).toBe(160);
    const uncertain = star('c', [30000, 0, 0], { position: { kind: 'icrs', xyzPc: [30000, 0, 0], raDeg: 1, decDeg: 1, distanceUncertaintyPc: 9000 } });
    expect(starViewDistancePc(uncertain)).toBe(STAR_VIEW_MAX_PC);              // capped
  });

  it('a catalogue galaxy: 2.2 x its physical size (>= 1 kpc); without an angular size 0.15 x its distance (>= 10 kpc)', () => {
    const g = (over: Partial<DiscoveryRecord>): DiscoveryRecord => star('point:ungc:1', [1e7, 0, 0], { dataset: 'ungc', category: 'galaxy', ...over });
    const sized = g({ measurements: { angularSizeArcmin: { value: 10, kind: 'observed' }, distancePc: { value: 1e7, kind: 'observed' } } });
    const sizePc = 1e7 * (10 / 60) * (Math.PI / 180);
    expect(catalogueViewDistancePc(sized)).toBeCloseTo(2.2 * sizePc, 6);
    const tiny = g({ measurements: { angularSizeArcmin: { value: 0.001, kind: 'observed' } } });
    expect(catalogueViewDistancePc(tiny)).toBe(1000);
    expect(catalogueViewDistancePc(g({}))).toBeCloseTo(1.5e6, 3);
    expect(catalogueViewDistancePc(g({ position: { kind: 'sky-only', raDeg: 1, decDeg: 1 } }))).toBeUndefined();
  });

  it('apparent magnitude at a view distance follows the distance modulus', () => {
    const r = star('d', [10, 0, 0], { measurements: { absoluteMag: { value: 5, kind: 'derived' } } });
    expect(apparentMagAt(r, 10)).toBeCloseTo(5, 9);
    expect(apparentMagAt(r, 100)).toBeCloseTo(10, 9);
    const r2 = star('e', [10, 0, 0], { measurements: { apparentMag: { value: 3, kind: 'observed' }, distancePc: { value: 10, kind: 'derived' } } });
    expect(apparentMagAt(r2, 4)).toBeCloseTo(3 + 5 * Math.log10(0.4), 9);
    expect(apparentMagAt(star('f', [1, 0, 0]), 4)).toBeUndefined();
  });

  it('the host applies the rule per category', () => {
    const planet = star('solar:jupiter', [0, 0, 0], { dataset: 'solar-system', category: 'planet', position: { kind: 'solar', bodyId: 'jupiter' } });
    const m31 = star('deep:m31', [0, 0, 0], { dataset: 'deep-space', category: 'galaxy' });
    const hip = star('hip:1', [3, 0, 0], { dataset: 'hipparcos' });
    const { host } = setup([planet, m31, hip]);
    expect(host.viewDistance(planet)).toBe(3.3e-9);
    expect(host.viewDistance(m31)).toBe(52000);
    expect(host.viewDistance(hip)).toBe(4);
    expect(host.viewDistance(star('x', [0, 0, 0], { category: 'planet', position: { kind: 'solar', bodyId: 'nowhere' } }))).toBeUndefined();
  });
});

describe('flights', () => {
  it('Solar System bodies: flyToBody (which follows the body); deep objects: flyToDeep; the Local Group: its own flight', () => {
    const jup = star('solar:jupiter', [0, 0, 0], { dataset: 'solar-system', category: 'planet', position: { kind: 'solar', bodyId: 'jupiter' }, drawn: true });
    const m31 = star('deep:m31', [0, 0, 0], { dataset: 'deep-space', category: 'galaxy', position: { kind: 'icrs', xyzPc: [7e5, 0, 0], raDeg: 10.7, decDeg: 41 } });
    const lg = star('deep:local-group', [0, 0, 0], { dataset: 'deep-space', category: 'galaxy-group', position: { kind: 'sky-only', raDeg: NaN, decDeg: NaN }, drawn: false });
    const { v, nav } = setup([jup, m31, lg]);
    nav.select('solar:jupiter'); nav.select('deep:m31'); nav.select('deep:local-group');
    expect(v.calls).toEqual(['body:jupiter', 'deep:m31', 'local-group']);
    expect(v.proxy).toBeNull();                                       // drawn objects get no proxy
  });

  it('a star flies to its position at the rule distance; a faint one also gets a selection proxy', () => {
    const bright = star('hip:32349', [-0.5, 2.5, -0.9], { dataset: 'hipparcos', measurements: { absoluteMag: { value: 1.4, kind: 'derived' } } });
    const faint = star('gaia:9', [40, 0, 0], { measurements: { absoluteMag: { value: 15, kind: 'derived' } } });
    const { v, nav, placements } = setup([bright, faint]);
    nav.select('hip:32349');
    expect(v.point!.xyz).toEqual([-0.5, 2.5, -0.9]);
    expect(v.point!.d).toBe(4);
    expect(v.proxy).toBeNull();                                       // M = 1.4 seen from 4 pc is magnitude -1.6: visible
    nav.select('gaia:9');
    expect(v.point!.d).toBe(4);
    expect(v.proxy).toMatchObject({ id: 'gaia:9', positionPc: [40, 0, 0] });      // M = 15 at 4 pc is magnitude 12.5, beyond the limit of 9
    expect(placements.map((p) => p.kind)).toEqual(['flight', 'flight']);
  });

  it('an exoplanet goes to its host position with a proxy; a curated "other" object gets a proxy too', () => {
    const planet = star('exo:X b', [12, 3, 1], { dataset: 'nasa-exoplanet-archive', category: 'exoplanet', drawn: false, measurements: { distancePc: { value: 12.4, kind: 'derived', uncertainty: 0.01 } } });
    const sgr = star('other:sgr-a-star', [-1000, 7000, -700], { dataset: 'curated-other', category: 'other', measurements: { distancePc: { value: 8000, kind: 'observed', uncertainty: 30 } } });
    const { v, nav } = setup([planet, sgr]);
    nav.select('exo:X b');
    expect(v.point!.xyz).toEqual([12, 3, 1]);
    expect(v.proxy).toMatchObject({ id: 'exo:X b' });
    expect((v.proxy as { reason: string }).reason).toMatch(/host star/);
    nav.select('other:sgr-a-star');
    expect(v.proxy).toMatchObject({ id: 'other:sgr-a-star' });
    expect(v.point!.d).toBe(60);                                     // sigma 30 pc -> max(4, 2 x 30)
  });

  it('sigma-aware distance is used for the flight of a distant star', () => {
    const far = star('gaia:far', [800, 0, 0], { measurements: { distancePc: { value: 800, kind: 'derived', uncertainty: 80 } } });
    const { v, nav } = setup([far]);
    nav.select('gaia:far');
    expect(v.point!.d).toBe(160);
  });

  it('sky-only records: no flight, an explicit "cannot place in 3D: distance unknown" result', () => {
    const sky = star('gaia:sky', [0, 0, 0], { position: { kind: 'sky-only', raDeg: 10, decDeg: 20 }, drawn: false });
    const cz = star('point:twomrs:7', [0, 0, 0], { dataset: 'twomrs', category: 'galaxy', position: { kind: 'sky-only', raDeg: 10, decDeg: 20 }, drawn: false, measurements: { czKms: { value: 400, kind: 'observed' } } });
    const { v, nav, placements, host } = setup([sky, cz]);
    nav.select('gaia:sky');
    nav.select('point:twomrs:7');
    expect(v.calls).toEqual([]);
    expect(placements).toEqual([
      { kind: 'inspect-only', id: 'gaia:sky', reason: NO_DISTANCE_REASON },
      { kind: 'inspect-only', id: 'point:twomrs:7', reason: NO_DISTANCE_REASON },
    ]);
    expect(host.lastPlacement!.kind).toBe('inspect-only');
  });

  it('a non-finite position never starts a flight', () => {
    const bad = star('gaia:nan', [NaN, 0, 0]);
    const { v, nav, placements } = setup([bad]);
    nav.select('gaia:nan');
    expect(v.point).toBeNull();
    expect(placements[0]!.kind).toBe('inspect-only');
  });

  it('a Solar System body when the layer is not loaded is reported, not thrown', () => {
    const v = new FakeViewer();
    v.solarData = null;
    const jup = star('solar:jupiter', [0, 0, 0], { dataset: 'solar-system', category: 'planet', position: { kind: 'solar', bodyId: 'jupiter' } });
    const { nav, placements } = setup([jup], v);
    expect(() => nav.select('solar:jupiter')).not.toThrow();
    expect(placements[0]!).toMatchObject({ kind: 'inspect-only' });
  });
});

describe('snapshots, highlights, camera port', () => {
  it('snapshot carries the follow / selection state and restore hands it back to the viewer', () => {
    const { v, host } = setup([]);
    const s = host.snapshot();
    expect(s.frame).toBe('stellar-neighbourhood');
    host.restore({ ...s, distance: 5 }, 700);
    expect(v.restored).toMatchObject({ followId: 'jupiter', selectedBody: 'jupiter', distance: 5, frameId: 'stellar-neighbourhood' });
    host.restore({ frame: 'x', focus: [1, 2, 3], distance: 9, yaw: 0, pitch: 0 }, 100);           // a plain snapshot (no extras) is accepted
    expect(v.restored).toMatchObject({ followId: null, selectedBody: null, selectedDeep: null });
  });

  it('highlight places markers at the records\' positions; unknown ids and sky-only records are skipped', () => {
    const a = star('hip:1', [1, 2, 3]);
    const sky = star('gaia:sky', [0, 0, 0], { position: { kind: 'sky-only', raDeg: 1, decDeg: 2 } });
    const jup = star('solar:jupiter', [0, 0, 0], { dataset: 'solar-system', category: 'planet', position: { kind: 'solar', bodyId: 'jupiter' } });
    const { v, host } = setup([a, sky, jup]);
    host.highlight(['hip:1', 'gaia:sky', 'nope:1', 'solar:jupiter']);
    expect((v.highlights as { id: string }[]).map((h) => h.id)).toEqual(['hip:1', 'solar:jupiter']);
    host.highlight([]);
    expect(v.highlights).toEqual([]);
  });

  it('setSelection(null) removes the proxy', () => {
    const { v, host } = setup([]);
    host.setSelection('a:1');
    expect(host.selectedId).toBe('a:1');
    v.proxy = { id: 'x' };
    host.setSelection(null);
    expect(v.proxy).toBeNull();
  });

  it('solar body offsets come from the ephemeris callback at the viewer\'s simulation time, one entry per body, in metres', () => {
    const { host } = setup([]);
    const o = host.solarBodyOffsets();
    expect(o.map((b) => b.id)).toEqual(['solar:sun', 'solar:jupiter', 'solar:io']);
    expect(o.find((b) => b.id === 'solar:jupiter')!.offsetMetres[0]).toBeCloseTo(5.2 * METRES_PER_AU, 0);
  });

  it('cameraView exposes position, forward, up, fov and aspect', () => {
    const { host } = setup([]);
    const c = host.cameraView();
    expect(c.aspect).toBeCloseTo(1.5, 9);
    expect(Math.hypot(...c.forward)).toBeCloseTo(1, 9);
    expect(Math.hypot(...c.positionPc)).toBeCloseTo(60, 6);          // focus at the origin, distance 60 pc
    expect(c.fovYDeg).toBeGreaterThan(0);
  });

  it('resolve is the injected cache lookup (synchronous)', () => {
    const r = star('hip:1', [1, 0, 0]);
    const { host } = setup([r]);
    expect(host.resolve('hip:1' as UniversalId)).toBe(r);
    expect(host.resolve('hip:2' as UniversalId)).toBeUndefined();
  });
});
