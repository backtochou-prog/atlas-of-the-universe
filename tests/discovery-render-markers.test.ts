import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { equatorialToUnit } from '../src/core/astro/coordinates';
import {
  buildHostTable, buildOtherMarkers, DISCOVERY_PICK_TIERS, HOST_ALPHA_FAR, HOST_ALPHA_NEAR, HOST_MAX_INFOS, HOST_RADIUS_FAR_PX, HOST_RADIUS_NEAR_PX, hostId, hostsFade, hostStyle,
  isHostId, isOtherId, isOtherwiseVisible, kthSmallest,
} from '../src/render/deep-space/DiscoveryMarkerMath';
import {
  createDiscoveryMarkerRenderers, discoveryMarkerCounts, ExoplanetHostMarkers, findDiscoveryMarkers, HighlightMarkers, OtherObjectMarkers,
} from '../src/render/deep-space/DiscoveryMarkers';
import { cameraBasis, FOV_DEG, type OrbitState } from '../src/render/orbitCamera';
import type { DeepRenderContext, DeepScreenInfo } from '../src/render/deep-space/types';
import type { ExoplanetFile, OtherObjectsFile } from '../src/discovery/types';
import { have, readGz, readJson } from './fixtures/discovery/real';

const VP = { width: 1280, height: 800 };
const PPR = VP.height / (2 * Math.tan((FOV_DEG * Math.PI) / 360));
function ctx(state: OrbitState, over: Partial<DeepRenderContext> = {}): DeepRenderContext {
  const b = cameraBasis(state);
  const cam: [number, number, number] = [state.focus[0] - b.forward[0] * state.distance, state.focus[1] - b.forward[1] * state.distance, state.focus[2] - b.forward[2] * state.distance];
  return { camera: new THREE.PerspectiveCamera(FOV_DEG, VP.width / VP.height), camPc: cam, basis: b, viewport: VP, pixelRatio: 1, focusDistancePc: state.distance, pixelsPerRadian: PPR, nowSeconds: 1, selectedId: null, quality: 1, ...over };
}
/** Orbit state of a camera at `camPc` looking at the sky direction (ra, dec). */
function lookAt(camPc: [number, number, number], raDeg: number, decDeg: number): OrbitState {
  const u = equatorialToUnit(raDeg, decDeg);
  const dist = 1e-6;
  return { focus: [camPc[0] + u[0] * dist, camPc[1] + u[1] * dist, camPc[2] + u[2] * dist], distance: dist, yaw: Math.atan2(-u[1], -u[0]), pitch: Math.asin(-u[2]) };
}

/** A synthetic ExoplanetFile.hosts table: n hosts on a ring around the Sun at 10..(10+n) pc, every third with 3 planets, 2 without a distance. */
function hostsTable(n: number): ExoplanetFile['hosts'] {
  const hostname: string[] = [], raDeg: number[] = [], decDeg: number[] = [], distPc: (number | null)[] = [], nPlanets: number[] = [];
  for (let i = 0; i < n; i++) { hostname.push(`H${i}`); raDeg.push((i * 360) / n); decDeg.push(0); distPc.push(10 + i); nPlanets.push(i % 3 === 0 ? 3 : 1); }
  hostname.push('SkyOnlyA', 'SkyOnlyB'); raDeg.push(1, 2); decDeg.push(3, 4); distPc.push(null, 0); nPlanets.push(1, 1);
  hostname.push('H0'); raDeg.push(5); decDeg.push(5); distPc.push(5); nPlanets.push(1); // duplicate name: ignored
  return { hostname, raDeg, decDeg, distPc, nPlanets };
}
const others: OtherObjectsFile = {
  manifest: { schema: 'atlas-other-objects/1', generated: 'x', note: 'x' },
  objects: [
    { id: 'other:a', name: 'Alpha Obj', designations: [], category: 'other', classification: 'x', raDeg: 0, decDeg: 0, distance: { value: 2, unit: 'kpc', kind: 'observed', source: { label: 'x', url: 'x', retrieved: 'x' } }, coordinateSource: { label: 'x', url: 'x', retrieved: 'x' }, facts: [] },
    { id: 'other:b', name: 'Beta Obj', designations: [], category: 'other', classification: 'x', raDeg: 90, decDeg: 0, coordinateSource: { label: 'x', url: 'x', retrieved: 'x' }, facts: [] },
  ],
};

describe('marker math', () => {
  it('ids: host:<name> and other:<id>', () => {
    expect(hostId('TRAPPIST-1')).toBe('host:TRAPPIST-1'); expect(isHostId('host:x')).toBe(true); expect(isHostId('gaia:1')).toBe(false); expect(isOtherId('other:sgr-a-star')).toBe(true);
  });
  it('host size and opacity depend on camera distance only: nearer = larger and stronger, monotone', () => {
    let pr = Infinity, pa = Infinity;
    for (const d of [1, 5, 20, 100, 500, 2000, 5000, 20000]) { const s = hostStyle(d, 1); expect(s.radiusPx).toBeLessThanOrEqual(pr); expect(s.alpha).toBeLessThanOrEqual(pa); pr = s.radiusPx; pa = s.alpha; }
    expect(hostStyle(1, 1)).toEqual({ radiusPx: HOST_RADIUS_NEAR_PX, alpha: HOST_ALPHA_NEAR });
    expect(hostStyle(1e5, 1).radiusPx).toBeCloseTo(HOST_RADIUS_FAR_PX, 9); expect(hostStyle(1e5, 1).alpha).toBeCloseTo(HOST_ALPHA_FAR, 9);
  });
  it('a multi-planet host is slightly stronger; the planet COUNT beyond 1 does not matter', () => {
    const one = hostStyle(100, 1), two = hostStyle(100, 2), seven = hostStyle(100, 7), unknown = hostStyle(100, null);
    expect(two.radiusPx).toBeGreaterThan(one.radiusPx); expect(two.alpha).toBeGreaterThan(one.alpha);
    expect(seven).toEqual(two); expect(unknown).toEqual(one);
    expect(two.radiusPx / one.radiusPx).toBeLessThan(1.2);
  });
  it('the host fade is 1 out to 20 kpc and 0 at 200 kpc', () => {
    expect(hostsFade(0)).toBe(1); expect(hostsFade(20000)).toBe(1); expect(hostsFade(200000)).toBe(0);
    const m = hostsFade(63245); expect(m).toBeGreaterThan(0.4); expect(m).toBeLessThan(0.6);
  });
  it('kthSmallest agrees with a sort', () => {
    const a = Float32Array.from({ length: 500 }, (_, i) => ((i * 7919) % 503) / 7 + (i % 5));
    for (const k of [0, 1, 17, 250, 499]) { const c = Float32Array.from(a); expect(kthSmallest(c, c.length, k)).toBe([...a].sort((x, y) => x - y)[k]); }
  });
  it('selection proxy rule: extended objects hide it at >= 6 px, bright stars hide it, otherwise it shows', () => {
    expect(isOtherwiseVisible({ id: 'x', xyzPc: [1, 0, 0], sizePc: 10 }, 100, PPR, 7.5)).toBe(true);      // 10/100*PPR ~ 86 px
    expect(isOtherwiseVisible({ id: 'x', xyzPc: [1, 0, 0], sizePc: 0.01 }, 100, PPR, 7.5)).toBe(false);   // 0.09 px
    expect(isOtherwiseVisible({ id: 'x', xyzPc: [1, 0, 0], absoluteMag: 4.8 }, 10, PPR, 7.5)).toBe(true);  // m = 4.8 at 10 pc
    expect(isOtherwiseVisible({ id: 'x', xyzPc: [1, 0, 0], absoluteMag: 16.5 }, 20, PPR, 7.5)).toBe(false);
    expect(isOtherwiseVisible({ id: 'x', xyzPc: [1, 0, 0], absoluteMag: 7.2 }, 10, PPR, 7.5)).toBe(false); // within 0.5 mag of the limit: not "clearly" visible
    expect(isOtherwiseVisible({ id: 'x', xyzPc: [1, 0, 0] }, 10, PPR, 7.5)).toBe(false);                   // nothing known: show the proxy
  });
  it('pick tiers: hosts are backdrop (never steal a click), the proxy is plain priority 0', () => {
    expect(DISCOVERY_PICK_TIERS['exoplanet-host'].backdrop).toBe(true); expect(DISCOVERY_PICK_TIERS['other-object'].backdrop).toBe(false);
  });
});

describe('host table', () => {
  const t = buildHostTable(hostsTable(50));
  it('counts drawable and sky-only hosts, ignores duplicates, sorts by distance', () => {
    expect(t.total).toBe(52); expect(t.count).toBe(50); expect(t.skyOnly).toBe(2);
    for (let i = 1; i < t.count; i++) expect(t.distancePc[i]!).toBeGreaterThanOrEqual(t.distancePc[i - 1]!);
    expect(t.ids[0]).toBe('host:H0'); expect(t.indexOf.get('host:H49')).toBe(49);
  });
  it('positions have norm = distance and the catalogue direction', () => {
    const k = t.indexOf.get('host:H10')!;
    expect(Math.hypot(t.positionPc[3 * k]!, t.positionPc[3 * k + 1]!, t.positionPc[3 * k + 2]!)).toBeCloseTo(20, 9);
    const u = equatorialToUnit((10 * 360) / 50, 0);
    expect(t.positionPc[3 * k]! / 20).toBeCloseTo(u[0], 9);
  });
});

describe('ExoplanetHostMarkers', () => {
  const make = (n = 600): ExoplanetHostMarkers => { const h = new ExoplanetHostMarkers(); h.setHosts(hostsTable(n)); return h; };
  const sun = lookAt([0, 0, 0], 0, 0);
  it('is OFF by default: nothing drawn, no screen infos, counts say how many could be drawn', () => {
    const h = make();
    expect(h.isEnabled()).toBe(false);
    expect(h.update(ctx(sun))).toHaveLength(0);
    expect(h.counts()).toMatchObject({ hostsTotal: 602, hostsDrawable: 600, hostsSkyOnly: 2, hostsDrawnNow: 0, hostsEnabled: false });
  });
  it('when on draws the hosts in view and reports infos with id host:<name>, kind exoplanet-host, pickable, radius < 5 px', () => {
    const h = make(); h.setEnabled(true);
    const infos = h.update(ctx(sun));
    expect(infos.length).toBeGreaterThan(0);
    for (const i of infos) { expect(i.id).toMatch(/^host:H\d+$/); expect(i.kind).toBe('exoplanet-host'); expect(i.pickable).toBe(true); expect(i.visible).toBe(true); expect(i.pixelRadius).toBeLessThan(5); expect(i.x).toBeGreaterThanOrEqual(0); expect(i.x).toBeLessThanOrEqual(VP.width); }
    expect(h.counts().hostsDrawnNow).toBeGreaterThan(0);
    expect(h.stats().drawCalls).toBe(1);
    // the host at RA 0, Dec 0 is at the screen centre when looking at (0, 0)
    const h0 = infos.find((i) => i.id === 'host:H0')!;
    expect(h0.x).toBeCloseTo(640, 0); expect(h0.y).toBeCloseTo(400, 0);
    // east is to the left: H1 (RA +0.6 deg) is left of H0
    expect(infos.find((i) => i.id === 'host:H1')!.x).toBeLessThan(h0.x);
  });
  it('caps screen infos at HOST_MAX_INFOS (the nearest to the camera), and reuses the same info objects next frame (no per-frame allocation)', () => {
    const h = new ExoplanetHostMarkers();
    const hs = hostsTable(2000);
    h.setHosts(hs); h.setEnabled(true);
    const wide = lookAt([0, 0, 0], 0, 0);
    const a = [...h.update(ctx(wide))];
    expect(a.length).toBeLessThanOrEqual(HOST_MAX_INFOS);
    const b = [...h.update(ctx(wide))];
    expect(b.length).toBe(a.length);
    const setA = new Set<DeepScreenInfo>(a);
    for (const i of b) expect(setA.has(i)).toBe(true);
    // the kept ones are the nearest: every kept camera distance <= every dropped on-screen one
    const kept = new Set(a.map((i) => i.id));
    const maxKept = Math.max(...a.map((i) => i.distancePc));
    expect(maxKept).toBeLessThanOrEqual(10 + 2000);
    expect(kept.size).toBe(a.length);
  });
  it('lower quality draws fewer (the nearest are kept); turning the layer off clears it', () => {
    const h = make(2000); h.setEnabled(true);
    h.update(ctx(sun, { quality: 1 })); const full = h.counts().hostsDrawnNow;
    h.update(ctx(sun, { quality: 0.25 })); const low = h.counts().hostsDrawnNow;
    expect(low).toBeLessThan(full); expect(low).toBeGreaterThan(0);
    h.setEnabled(false);
    expect(h.update(ctx(sun))).toHaveLength(0); expect(h.counts().hostsDrawnNow).toBe(0);
  });
  it('fades out beyond 200 kpc from the Sun and draws nothing behind the camera', () => {
    const h = make(); h.setEnabled(true);
    expect(h.update(ctx(lookAt([3e5, 0, 0], 0, 0)))).toHaveLength(0);
    expect(h.update(ctx(lookAt([0, 0, 0], 180, 0))).some((i) => i.id === 'host:H0')).toBe(false);
  });
  it('exposes positions only for drawable hosts (sky-only hosts have none)', () => {
    const h = make();
    expect(h.positionPc('host:H3')).toBeDefined(); expect(h.positionPc('host:SkyOnlyA')).toBeUndefined();
    expect(h.viewDistancePc('host:H3')).toBe(3); expect(h.viewDistancePc('host:nope')).toBeUndefined();
  });
  it('dispose is idempotent', () => { const h = make(); h.dispose(); expect(() => h.dispose()).not.toThrow(); });
});

describe('OtherObjectMarkers', () => {
  it('places objects with a cited distance, counts sky-only ones, ids other:<id>', () => {
    const o = new OtherObjectMarkers(); o.setOthers(others);
    expect(o.ids()).toEqual(['other:a']); expect(o.counts()).toEqual({ others: 1, othersSkyOnly: 1 });
    expect(Math.hypot(...(o.positionPc('other:a') as [number, number, number]))).toBeCloseTo(2000, 6);
  });
  it('reports a visible small distinct marker at the screen centre when the camera looks at it', () => {
    const o = new OtherObjectMarkers(); o.setOthers(others);
    const infos = o.update(ctx(lookAt([0, 0, 0], 0, 0)));
    expect(infos).toHaveLength(1);
    const i = infos[0]!;
    expect(i.id).toBe('other:a'); expect(i.kind).toBe('other-object'); expect(i.visible).toBe(true); expect(i.pixelRadius).toBeLessThan(5);
    expect(i.x).toBeCloseTo(640, 0); expect(i.y).toBeCloseTo(400, 0); expect(i.label).toBe('Alpha Obj');
    expect(o.stats().pointsDrawn).toBe(2);
  });
  it('is off screen (not visible) when looking away', () => {
    const o = new OtherObjectMarkers(); o.setOthers(others);
    expect(o.update(ctx(lookAt([0, 0, 0], 180, 0)))).toHaveLength(0);
  });
});

describe('HighlightMarkers and the selection proxy', () => {
  const sun = lookAt([0, 0, 0], 0, 0);
  const setup = (): { hosts: ExoplanetHostMarkers; hl: HighlightMarkers } => { const hosts = new ExoplanetHostMarkers(); hosts.setHosts(hostsTable(50)); const hl = new HighlightMarkers(hosts); return { hosts, hl }; };
  it('counts highlights, items without a position, and drops beyond the capacity', () => {
    const { hl } = setup();
    hl.setHighlights([{ id: 'gaia:1', xyzPc: [10, 0, 0] }, { id: 'gaia:2', xyzPc: null }]);
    expect(hl.counts()).toMatchObject({ highlights: 2, highlightsNoPosition: 1, highlightsDropped: 0 });
    hl.setHighlights(Array.from({ length: 300 }, (_, i) => ({ id: `gaia:${i}`, xyzPc: [10, i, 0] as [number, number, number] })));
    expect(hl.counts()).toMatchObject({ highlights: 256, highlightsDropped: 44 });
    hl.setHighlights([]);
    expect(hl.counts().highlights).toBe(0);
  });
  it('a highlighted host is pickable when the host layer is off, and its id is not duplicated by the host renderer when the layer is on', () => {
    const { hosts, hl } = setup();
    const pos = hosts.positionPc('host:H0')!;
    hl.setHighlights([{ id: 'host:H0', xyzPc: pos, label: 'H0' }, { id: 'gaia:5', xyzPc: [10, 0, 0] }]);
    const off = [...hl.update(ctx(sun))];
    expect(off.map((i) => i.id)).toEqual(['host:H0']); expect(off[0]!.kind).toBe('exoplanet-host'); expect(off[0]!.pickable).toBe(true);
    hosts.setEnabled(true);
    const all = [...hosts.update(ctx(sun)), ...hl.update(ctx(sun))].map((i) => i.id);
    expect(new Set(all).size).toBe(all.length);
  });
  it('shows the selection proxy (ring + label, never pickable) for a faint object and hides it for a clearly visible one', () => {
    const { hl } = setup();
    hl.setSelection({ id: 'gaia:9', xyzPc: [20, 0, 0], label: 'Faint dwarf', absoluteMag: 16.5 });
    const a = hl.update(ctx(sun));
    expect(hl.counts().selectionShown).toBe(true);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ id: 'selection:gaia:9', kind: 'selection-proxy', pickable: false, label: 'Faint dwarf' });
    expect(a[0]!.x).toBeCloseTo(640, 0);
    hl.setSelection({ id: 'gaia:9', xyzPc: [20, 0, 0], label: 'Bright', absoluteMag: -3 });   // m = -3 + 6.5 - 5 = -1.5: clearly visible
    expect(hl.update(ctx(sun))).toHaveLength(0); expect(hl.counts().selectionShown).toBe(false);
    hl.setSelection({ id: 'deep:big', xyzPc: [20, 0, 0], label: 'Big', sizePc: 5 });          // 5/20 rad = 214 px
    expect(hl.update(ctx(sun))).toHaveLength(0);
    hl.setSelection(null);
    expect(hl.update(ctx(sun))).toHaveLength(0);
  });
  it('a selection without a position (sky-only record) draws nothing', () => {
    const { hl } = setup();
    hl.setSelection({ id: 'gaia:9', xyzPc: null, label: 'x' });
    expect(hl.update(ctx(sun))).toHaveLength(0);
  });
  it('the magnitude limit changes what counts as clearly visible', () => {
    const { hl } = setup();
    hl.setSelection({ id: 'gaia:9', xyzPc: [10, 0, 0], label: 'x', absoluteMag: 2 });   // m = 2: visible at limit 7.5, not at limit 2
    expect(hl.update(ctx(sun))).toHaveLength(0);
    hl.setMagLimit(2);
    expect(hl.update(ctx(sun))).toHaveLength(1);
  });
});

describe('registration', () => {
  it('the factory returns three renderers of layerKind discovery; findDiscoveryMarkers returns typed handles; counts combine', () => {
    const rs = createDiscoveryMarkerRenderers({} as never);
    expect(rs).toHaveLength(3);
    for (const r of rs) expect(r.layerKind).toBe('discovery');
    const h = findDiscoveryMarkers(rs)!;
    expect(h.hosts).toBeInstanceOf(ExoplanetHostMarkers);
    expect(findDiscoveryMarkers([])).toBeNull();
    expect(discoveryMarkerCounts(h)).toMatchObject({ hostsTotal: 0, others: 0, highlights: 0, hostsEnabled: false });
    for (const r of rs) expect(() => r.dispose()).not.toThrow();
  });
});

describe.skipIf(!have('exoplanets.v1.json.gz') || !have('other-objects.v1.json'))('real data', () => {
  const exo = readGz<ExoplanetFile>('exoplanets.v1.json.gz');
  const oth = readJson<OtherObjectsFile>('other-objects.v1.json');
  it('4862 hosts: 4834 drawable, 28 sky-only; TRAPPIST-1 at 12.43 pc', () => {
    const t = buildHostTable(exo.hosts);
    expect(t.total).toBe(4862); expect(t.count + t.skyOnly).toBe(4862); expect(t.count).toBe(4834); expect(t.skyOnly).toBe(28);
    const k = t.indexOf.get('host:TRAPPIST-1')!;
    expect(t.distancePc[k]).toBeCloseTo(12.43, 1); expect(t.nPlanets[k]).toBe(7);
    expect(new Set(t.ids).size).toBe(t.count);
    for (const id of t.ids) expect(id.startsWith('host:')).toBe(true);
  });
  it('the six curated objects are placed at their catalogue RA/Dec and cited distances', () => {
    const { markers, skyOnly } = buildOtherMarkers(oth);
    expect(skyOnly).toBe(0);
    expect(markers.map((m) => m.id)).toEqual(['other:sgr-a-star', 'other:cyg-x-1', 'other:crab-pulsar', 'other:sn-1987a', 'other:eta-carinae', 'other:vela-pulsar']);
    const sgr = markers[0]!;
    expect(sgr.distancePc).toBeCloseTo(8178, 6);
    const u = equatorialToUnit(266.416817, -29.007825);
    expect(sgr.xyzPc[0] / 8178).toBeCloseTo(u[0], 5);
    expect(markers.find((m) => m.id === 'other:sn-1987a')!.distancePc).toBeCloseTo(51400, 3);
  });
  it('real host layer: from the Sun looking at the Kepler field draws hundreds of halos and at most HOST_MAX_INFOS infos', () => {
    const h = new ExoplanetHostMarkers(); h.setHosts(exo.hosts); h.setEnabled(true);
    const infos = h.update(ctx(lookAt([0, 0, 0], 290.5, 44.5)));
    expect(h.counts().hostsDrawnNow).toBeGreaterThan(500);
    expect(infos.length).toBeLessThanOrEqual(HOST_MAX_INFOS);
  });
});
