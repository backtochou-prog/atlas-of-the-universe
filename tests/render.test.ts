import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { apparentMagFromCamera, BRIGHTNESS_GLSL, DEFAULT_BRIGHTNESS, pointAlpha, pointDiameterPx } from '../src/render/brightness';
import { colourFromBpRp, MISSING_COLOUR } from '../src/render/starColour';
import { buildStarLayer, cameraRelative, MARGINAL_CONFIDENCE, type StarLayer } from '../src/render/starLayer';
import { pickStar, projectToScreen } from '../src/render/picking';
import { cameraBasis, cameraPosition, clampPitch, interpolate, pan, parsecsPerPixel, rotate, zoom, DEFAULT_ORBIT, PITCH_LIMIT } from '../src/render/orbitCamera';
import { GaiaCatalogue } from '../src/data/catalogue/catalogue';
import { buildGaiaDataset } from '../src/data/ingestion/build';
import type { GaiaDatasetFile } from '../src/data/catalogue/types';
import { absoluteMagnitude, apparentMagnitudeAt } from '../src/core/astro/photometry';
import { length } from '../src/core/spatial/vec3';

const csv = readFileSync('tests/fixtures/gaia-sample.csv', 'utf8');
const built = buildGaiaDataset({ rawCsv: csv, retrieval: { retrievedAt: '2026-11-12T12:00:00.000Z', endpoint: 't', adql: 'q', rawSha256: 'x', rawBytes: 1, rawRows: 10 }, builtAt: 'x' });
const cat = GaiaCatalogue.fromFile(built.file);

describe('brightness mapping (documented visualisation choice)', () => {
  it('matches the distance modulus: a star 10 pc away shows its absolute magnitude', () => {
    expect(apparentMagFromCamera(4.83, 10)).toBeCloseTo(4.83, 12);
    expect(apparentMagFromCamera(4.83, 100)).toBeCloseTo(9.83, 12);
    expect(apparentMagFromCamera(4.83, 1)).toBeCloseTo(-0.17, 12);
  });
  it('agrees with the core photometry helpers (one source of truth)', () => {
    const M = absoluteMagnitude(6.2, 37);
    expect(apparentMagFromCamera(M, 12.5)).toBeCloseTo(apparentMagnitudeAt(M, 12.5), 12);
  });
  it('does not blow up when the camera sits on a star', () => {
    expect(Number.isFinite(apparentMagFromCamera(5, 0))).toBe(true);
  });
  it('is monotonic: brighter stars are never smaller or fainter', () => {
    let lastD = -1, lastA = -1;
    for (let m = DEFAULT_BRIGHTNESS.magLimit; m >= -2; m -= 0.5) {
      const d = pointDiameterPx(m), a = pointAlpha(m);
      expect(d).toBeGreaterThanOrEqual(lastD);
      expect(a).toBeGreaterThanOrEqual(lastA);
      lastD = d; lastA = a;
    }
  });
  it('draws nothing fainter than the limiting magnitude and bounds the size', () => {
    expect(pointDiameterPx(DEFAULT_BRIGHTNESS.magLimit + 0.01)).toBe(0);
    expect(pointAlpha(DEFAULT_BRIGHTNESS.magLimit + 0.01)).toBe(0);
    expect(pointDiameterPx(-10)).toBe(DEFAULT_BRIGHTNESS.maxPx);
    expect(pointDiameterPx(DEFAULT_BRIGHTNESS.magLimit)).toBeCloseTo(DEFAULT_BRIGHTNESS.minPx, 12);
  });
  it('is linear in magnitude (logarithmic in flux): equal magnitude steps give equal size steps', () => {
    const a = pointDiameterPx(5) - pointDiameterPx(6), b = pointDiameterPx(3) - pointDiameterPx(4);
    expect(a).toBeCloseTo(b, 12);
  });
  it('the GLSL mirrors the same constants and log identity', () => {
    expect(BRIGHTNESS_GLSL).toContain('5.0 * log2(max(distPc, 1e-9)) * 0.30102999566 - 5.0');
    expect(Math.log2(37.5) * 0.30102999566).toBeCloseTo(Math.log10(37.5), 9);
    expect(BRIGHTNESS_GLSL).toContain('(uMagLimit - m) / 5.0');
  });
});

describe('colour ramp', () => {
  it('goes blue-white to red as BP-RP increases', () => {
    const blue = colourFromBpRp(-0.3), sun = colourFromBpRp(0.82), red = colourFromBpRp(3.0);
    expect(blue[2]).toBeGreaterThan(blue[0]);
    expect(red[0]).toBeGreaterThan(red[2]);
    expect(sun[0]).toBeGreaterThanOrEqual(sun[2]);
  });
  it('clamps outside the anchors and is continuous', () => {
    expect(colourFromBpRp(-9)).toEqual(colourFromBpRp(-0.5));
    expect(colourFromBpRp(99)).toEqual(colourFromBpRp(3.5));
    for (let x = -0.5; x < 3.4; x += 0.1) {
      const a = colourFromBpRp(x), b = colourFromBpRp(x + 0.1);
      for (let k = 0; k < 3; k++) expect(Math.abs(a[k]! - b[k]!)).toBeLessThan(0.15);
    }
  });
  it('gives missing colour a distinct neutral grey so it is visible, not silently tinted', () => {
    expect(colourFromBpRp(null)).toEqual(MISSING_COLOUR);
    expect(colourFromBpRp(NaN)).toEqual(MISSING_COLOUR);
  });
});

describe('star layer built from the normalised catalogue', () => {
  const layer = buildStarLayer(cat);
  it('contains only stars with BOTH a parallax distance and a G magnitude', () => {
    expect(layer.count).toBe(built.quality.distance.drawable);
    for (let k = 0; k < layer.count; k++) {
      const i = layer.catalogueIndex[k]!;
      expect(cat.distancePc(i)).not.toBeNull();
      expect(cat.value('phot_g_mean_mag', i)).not.toBeNull();
    }
  });
  it('excludes the source with no parallax and the two with no G magnitude, and counts them', () => {
    const drawn = new Set([...layer.catalogueIndex].map((i) => cat.sourceId(i)));
    expect(drawn.has('6560604777055249536')).toBe(false); // Alnair, no parallax
    expect(drawn.has('268449582148460928')).toBe(false); // no G
    expect(layer.skipped.noDistance).toBe(2);
    expect(layer.skipped.noGMagnitude).toBe(2);
    expect(layer.count + layer.skipped.noDistance + layer.skipped.noGMagnitude + layer.skipped.outsideExtent).toBe(cat.count);
  });
  it('uses the catalogue positions unchanged (no re-arrangement)', () => {
    for (let k = 0; k < layer.count; k++) {
      const p = cat.positionPc(layer.catalogueIndex[k]!)!;
      expect([layer.positionPc[3 * k], layer.positionPc[3 * k + 1], layer.positionPc[3 * k + 2]]).toEqual(p);
    }
  });
  it('stores the derived absolute magnitude, so apparent magnitude from the Sun equals the catalogue G', () => {
    for (let k = 0; k < layer.count; k++) {
      const i = layer.catalogueIndex[k]!;
      const d = Math.hypot(layer.positionPc[3 * k]!, layer.positionPc[3 * k + 1]!, layer.positionPc[3 * k + 2]!);
      expect(apparentMagFromCamera(layer.absMag[k]!, d)).toBeCloseTo(cat.value('phot_g_mean_mag', i)!, 4);
    }
  });
  it('draws marginal distances dimmer than reliable ones', () => {
    const marg = [...layer.catalogueIndex].findIndex((i) => cat.distanceStatus(i) === 'marginal');
    const rel = [...layer.catalogueIndex].findIndex((i) => cat.distanceStatus(i) === 'reliable');
    expect(layer.confidence[marg]).toBeCloseTo(MARGINAL_CONFIDENCE, 6); // stored as float32
    expect(layer.confidence[rel]).toBe(1);
  });
  it('marks astrometrically suspect stars (RUWE > 1.4) without removing them', () => {
    for (let k = 0; k < layer.count; k++) {
      const ruwe = cat.value('ruwe', layer.catalogueIndex[k]!);
      expect(layer.suspect[k] === 1).toBe(ruwe !== null && ruwe > 1.4);
    }
    expect(layer.suspectCount).toBe(layer.suspect.reduce((a, b) => a + b, 0));
    expect(layer.suspectCount).toBeGreaterThan(0);
  });
  it('excludes stars beyond the frame extent and reports them', () => {
    const tight = buildStarLayer(cat, 3);
    expect(tight.skipped.outsideExtent).toBeGreaterThan(0);
    expect(tight.count).toBeLessThan(layer.count);
  });
  it('camera-relative positions subtract in float64 before narrowing (no jitter far from the origin)', () => {
    const far: StarLayer = { ...layer, count: 1, positionPc: Float64Array.of(9000.000001, 0, 0) };
    const out = new Float32Array(3);
    cameraRelative(far, [9000, 0, 0], out);
    expect(out[0]).toBeCloseTo(1e-6, 9); // would be 0 or 0.00098 if subtracted in float32
  });
});

describe('picking', () => {
  const basis = cameraBasis({ ...DEFAULT_ORBIT, yaw: 0, pitch: 0 }); // camera on +X looking toward -X
  const vp = { width: 1000, height: 800 };
  const mk = (rels: [number, number, number][], absMag: number[]): { layer: StarLayer; rel: Float32Array } => {
    const n = rels.length;
    const layer: StarLayer = { count: n, catalogueIndex: Uint32Array.from(rels.map((_, i) => 100 + i)), positionPc: new Float64Array(n * 3), absMag: Float32Array.from(absMag), colour: new Float32Array(n * 3), confidence: new Float32Array(n).fill(1), suspect: new Uint8Array(n), suspectCount: 0, skipped: { noDistance: 0, noGMagnitude: 0, outsideExtent: 0 } };
    return { layer, rel: Float32Array.from(rels.flat()) };
  };
  it('projects a point straight ahead to the screen centre and to the right of centre when to the right', () => {
    const ahead = projectToScreen([-10, 0, 0], basis, vp)!;
    expect(ahead.x).toBeCloseTo(500, 6);
    expect(ahead.y).toBeCloseTo(400, 6);
    const right = projectToScreen([-10, 2, 0], basis, vp)!;
    const dir = basis.right[1] > 0 ? 1 : -1;
    expect(Math.sign(right.x - 500)).toBe(dir);
  });
  it('returns null for points behind the camera', () => {
    expect(projectToScreen([10, 0, 0], basis, vp)).toBeNull();
  });
  it('picks the star under the cursor, and nothing when clicking empty sky', () => {
    const { layer, rel } = mk([[-10, 0, 0], [-10, 3, 0]], [3, 3]);
    const s = projectToScreen([-10, 0, 0], basis, vp)!;
    expect(pickStar(layer, rel, basis, vp, { x: s.x + 2, y: s.y + 1 })!.catalogueIndex).toBe(100);
    expect(pickStar(layer, rel, basis, vp, { x: 5, y: 5 })).toBeNull();
  });
  it('ignores stars fainter than the limiting magnitude (you cannot select what is not drawn)', () => {
    const { layer, rel } = mk([[-10, 0, 0]], [20]);
    const s = projectToScreen([-10, 0, 0], basis, vp)!;
    expect(pickStar(layer, rel, basis, vp, { x: s.x, y: s.y })).toBeNull();
  });
  it('cannot pick a star the user has hidden', () => {
    const { layer, rel } = mk([[-10, 0, 0]], [3]);
    const sus: StarLayer = { ...layer, suspect: Uint8Array.of(1), suspectCount: 1 };
    const s = projectToScreen([-10, 0, 0], basis, vp)!;
    expect(pickStar(sus, rel, basis, vp, { x: s.x, y: s.y })).not.toBeNull();
    expect(pickStar(sus, rel, basis, vp, { x: s.x, y: s.y }, DEFAULT_BRIGHTNESS, 12, true)).toBeNull();
  });
  it('resolves overlap in favour of the brighter star', () => {
    const { layer, rel } = mk([[-10, 0, 0], [-10, 0.0001, 0]], [8, 2]);
    const s = projectToScreen([-10, 0, 0], basis, vp)!;
    expect(pickStar(layer, rel, basis, vp, { x: s.x, y: s.y })!.catalogueIndex).toBe(101);
  });
});

describe('orbit camera', () => {
  it('zooms by a constant factor per step at any distance (logarithmic)', () => {
    const a = zoom({ ...DEFAULT_ORBIT, distance: 2 }, 100).distance / 2;
    const b = zoom({ ...DEFAULT_ORBIT, distance: 2000 }, 100).distance / 2000;
    expect(a).toBeCloseTo(b, 12);
    expect(zoom(DEFAULT_ORBIT, 100).distance).toBeGreaterThan(DEFAULT_ORBIT.distance); // positive delta zooms out
  });
  it('clamps zoom to the allowed range', () => {
    expect(zoom(DEFAULT_ORBIT, -1e9).distance).toBe(1e-3);
    expect(zoom(DEFAULT_ORBIT, 1e9).distance).toBe(6e8); // 600 Mpc: the deep-space layer (was 20 000 pc)
  });
  it('places the camera at the requested distance from the focus', () => {
    const s = { ...DEFAULT_ORBIT, focus: [3, -2, 1] as const, distance: 42 };
    const c = cameraPosition(s);
    expect(length([c[0] - 3, c[1] + 2, c[2] - 1])).toBeCloseTo(42, 10);
  });
  it('has an orthonormal basis', () => {
    const { right, up, forward } = cameraBasis({ ...DEFAULT_ORBIT, yaw: 1.2, pitch: -0.6 });
    for (const v of [right, up, forward]) expect(length(v)).toBeCloseTo(1, 12);
    expect(right[0] * up[0] + right[1] * up[1] + right[2] * up[2]).toBeCloseTo(0, 12);
    expect(right[0] * forward[0] + right[1] * forward[1] + right[2] * forward[2]).toBeCloseTo(0, 12);
  });
  it('limits pitch so the up vector never degenerates', () => {
    expect(clampPitch(10)).toBe(PITCH_LIMIT);
    expect(clampPitch(-10)).toBe(-PITCH_LIMIT);
    expect(rotate(DEFAULT_ORBIT, 0, 10).pitch).toBe(PITCH_LIMIT);
  });
  it('pans in proportion to distance, so dragging feels the same at any scale', () => {
    const near = pan({ ...DEFAULT_ORBIT, distance: 1 }, 100, 0, 800), far = pan({ ...DEFAULT_ORBIT, distance: 1000 }, 100, 0, 800);
    expect(length(far.focus) / length(near.focus)).toBeCloseTo(1000, 6);
    expect(parsecsPerPixel(1000, 800) / parsecsPerPixel(1, 800)).toBeCloseTo(1000, 9);
  });
  it('interpolates smoothly and exactly at the ends, with geometric distance', () => {
    const a = { ...DEFAULT_ORBIT, distance: 1 }, b = { ...DEFAULT_ORBIT, distance: 10000, focus: [5, 5, 5] as const, yaw: 3 };
    expect(interpolate(a, b, 0).distance).toBeCloseTo(1, 12);
    expect(interpolate(a, b, 1).distance).toBeCloseTo(10000, 8);
    expect(interpolate(a, b, 0.5).distance).toBeCloseTo(100, 6); // geometric mean
    let last = 0;
    for (let t = 0; t <= 1; t += 0.05) { const d = interpolate(a, b, t).distance; expect(d).toBeGreaterThanOrEqual(last); last = d; }
  });
});

describe('real dataset integration', () => {
  const path = 'public/data/gaia-dr3-subset.v1.json.gz';
  const qpath = 'data/reports/gaia-dr3-subset.v1.quality.json';
  (existsSync(path) && existsSync(qpath) ? it : it.skip)('the renderer layer size equals the quality report "drawable" count', () => {
    const file = JSON.parse(gunzipSync(readFileSync(path)).toString()) as GaiaDatasetFile;
    const real = GaiaCatalogue.fromFile(file);
    const layer = buildStarLayer(real);
    const q = JSON.parse(readFileSync(qpath, 'utf8')) as { distance: { drawable: number } };
    expect(layer.count).toBe(q.distance.drawable);
    expect(layer.count).toBeGreaterThan(30000);
  });
});
