import { describe, expect, it } from 'vitest';
import { describeGovernor, logSmoothstep, markerAlpha, objectLod } from '../src/render/deep-space/DeepSpaceLOD';
import { QualityGovernor } from '../src/core/deepspace/lod';
import { starFieldFade } from '../src/render/starfield';
import { ORBIT_LIMITS, zoom, DEFAULT_ORBIT } from '../src/render/orbitCamera';
import { stretchFor, defaultAssetId, GALAXY_VISUAL } from '../src/render/deep-space/GalaxyRenderer';
import type { DeepImageAsset } from '../src/data/deepspace/types';

const L = (px: number, prev?: number, hasDetail = true) => objectLod({ apparentDiameterPx: px, distanceMetres: 1e22, physicalSizeMetres: 1e21, hasDetail, ...(prev !== undefined ? { previousLevel: prev } : {}) });

describe('objectLod (marker -> glow -> image)', () => {
  it('weights always sum to one and each is in [0, 1]', () => {
    for (let px = 0; px < 3000; px = px * 1.07 + 0.3) {
      const r = L(px);
      expect(r.marker + r.glow + r.image).toBeCloseTo(1, 9);
      for (const w of [r.marker, r.glow, r.image]) { expect(w).toBeGreaterThanOrEqual(-1e-12); expect(w).toBeLessThanOrEqual(1 + 1e-12); }
    }
  });
  it('is a point when tiny, a glow in between, an image when large', () => {
    expect(L(1).stage).toBe('marker'); expect(L(1).marker).toBe(1);
    expect(L(20).stage).toBe('glow');
    expect(L(200).stage).toBe('image'); expect(L(200).image).toBeCloseTo(1, 9);
  });
  it('crossfades smoothly: no weight jumps by more than a small step between neighbouring sizes', () => {
    let prev = L(0.5);
    for (let px = 0.5; px < 2000; px *= 1.01) {
      const r = L(px);
      expect(Math.abs(r.image - prev.image)).toBeLessThan(0.05); expect(Math.abs(r.glow - prev.glow)).toBeLessThan(0.05); expect(Math.abs(r.marker - prev.marker)).toBeLessThan(0.05);
      prev = r;
    }
  });
  it('the image weight is monotonic in size and the marker weight monotonic decreasing', () => {
    let pi = -1, pm = 2;
    for (let px = 0.1; px < 3000; px *= 1.05) { const r = L(px); expect(r.image).toBeGreaterThanOrEqual(pi - 1e-12); expect(r.marker).toBeLessThanOrEqual(pm + 1e-12); pi = r.image; pm = r.marker; }
  });
  it('hysteresis: the discrete stage does not flip back at the threshold it just crossed', () => {
    const up = L(50, 1);
    expect(up.level).toBe(2);
    expect(L(47, up.level).level).toBe(2); // would be level 1 without hysteresis
    expect(L(30, up.level).level).toBe(1);
  });
  it('an object without an image or model never goes beyond the glow', () => {
    const r = L(500, undefined, false);
    expect(r.image).toBe(0); expect(r.glow).toBe(1); expect(r.stage).toBe('glow');
  });
  it('an object of unknown size is capped at the glow stage by the core policy', () => {
    const r = objectLod({ apparentDiameterPx: 500, distanceMetres: 1e22 });
    expect(r.image).toBe(0);
  });
});

describe('small helpers', () => {
  it('logSmoothstep is 0 below, 1 above, monotonic', () => {
    expect(logSmoothstep(100, 300, 3000)).toBe(0); expect(logSmoothstep(5000, 300, 3000)).toBe(1);
    let p = 0; for (let x = 300; x <= 3000; x *= 1.05) { const v = logSmoothstep(x, 300, 3000); expect(v).toBeGreaterThanOrEqual(p); p = v; }
  });
  it('marker brightness follows apparent magnitude (a visual mapping), bounded', () => {
    expect(markerAlpha(3)).toBeGreaterThan(markerAlpha(9)); expect(markerAlpha(-5)).toBe(1); expect(markerAlpha(30)).toBe(0.2); expect(markerAlpha(undefined)).toBe(0.55);
  });
  it('the Gaia star field is fully opaque out to the old 20 kpc limit, then fades smoothly to nothing at 200 kpc', () => {
    expect(starFieldFade(60)).toBe(1); expect(starFieldFade(20_000)).toBe(1); expect(starFieldFade(200_000)).toBe(0); expect(starFieldFade(6e8)).toBe(0);
    let p = 1; for (let d = 20_000; d <= 200_000; d *= 1.05) { const f = starFieldFade(d); expect(f).toBeLessThanOrEqual(p + 1e-12); p = f; }
  });
  it('the camera can zoom out to 600 Mpc with the same logarithmic step', () => {
    expect(ORBIT_LIMITS.maxDistance).toBe(6e8);
    const a = zoom({ ...DEFAULT_ORBIT, distance: 2 }, 100).distance / 2, b = zoom({ ...DEFAULT_ORBIT, distance: 2e8 }, 100).distance / 2e8;
    expect(a).toBeCloseTo(b, 12);
  });
  it('image stretch lifts a dim UV map by subtracting the sky level, and never darkens a bright image', () => {
    const uv = stretchFor({ mean: [0.06, 0.06, 0.06], median: 0.063, p95: 0.1, p99: 0.12, peak: 0.2 });
    expect(uv.black).toBeGreaterThan(0.05); expect(uv.gain).toBeGreaterThan(2);
    const bright = stretchFor({ mean: [0.1, 0.1, 0.1], median: 0.01, p95: 0.5, p99: 0.7, peak: 0.9 });
    expect(bright.gain).toBe(GALAXY_VISUAL.exposureMin);
    expect(stretchFor(null).black).toBe(0);
  });
});

const A = (id: string, kind: DeepImageAsset['band']['kind'], fov: number): DeepImageAsset => ({ id, band: { kind }, geometry: { fovArcmin: [fov, fov / 3] } } as unknown as DeepImageAsset);
describe('defaultAssetId', () => {
  it('prefers visible light, but not an image that covers less than half of the galaxy', () => {
    expect(defaultAssetId([A('uv', 'ultraviolet', 192), A('vis', 'visible', 100)], 178)).toBe('vis');
    expect(defaultAssetId([A('phat', 'multi-band-composite', 58), A('nuv', 'ultraviolet', 192)], 178)).toBe('nuv');
    expect(defaultAssetId([A('a', 'ultraviolet', 10), A('b', 'visible', 20)], 178)).toBe('b');
    expect(defaultAssetId([A('a', 'ultraviolet', 10)], undefined)).toBe('a');
    expect(defaultAssetId([], 5)).toBeUndefined();
  });
});

describe('quality governor report (HUD): pins under slow frames, says why, recovers when frame time recovers', () => {
  it('reports reducing -> floor -> recovering -> full with a reason that names the frame time and the target', () => {
    const g = new QualityGovernor({ targetMs: 33 });
    let raw = 140;
    const rep = () => describeGovernor(true, g.scale, g.frameMsEma, 33, raw);
    for (let i = 0; i < 400; i++) g.update(140); // software GL: ~7 frames/s
    expect(g.scale).toBe(0.25);
    expect(rep().state).toBe('reducing'); expect(rep().reason).toMatch(/at the floor.*140 ms.*33 ms/);
    raw = 10;
    for (let i = 0; i < 30; i++) g.update(10);
    expect(['reducing', 'recovering', 'holding']).toContain(rep().state);
    for (let i = 0; i < 60; i++) g.update(10);
    expect(rep().state).toBe('recovering'); expect(rep().reason).toMatch(/recovering/);
    for (let i = 0; i < 2000; i++) g.update(10);
    expect(g.scale).toBe(1);
    expect(rep().state).toBe('full'); expect(rep().reason).toMatch(/full detail/);
    expect(describeGovernor(false, 1, 0, 33)).toMatchObject({ state: 'off' });
  });
});
