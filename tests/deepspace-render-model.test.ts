import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { armRadiusKpc, buildViewGainTable, GAIN_ELEVATIONS_DEG, galactocentricToIcrs, MW_COMPONENTS, readMilkyWayParams, sampleMilkyWay, viewGain, VISUAL } from '../src/render/deep-space/milkyWayModel';
import { discOrientationOf, galaxyGlowAxes, placeImage, projectEllipse, VIGNETTE_RADIUS_SCALE } from '../src/render/deep-space/galaxyGeometry';
import type { DeepImageProvenanceFile, DeepSpaceFile } from '../src/data/deepspace/types';
import { DeepSpaceData } from '../src/data/deepspace';
import { dot, length, normalise } from '../src/core/spatial/vec3';
import { equatorialToGalactic, galacticToIcrsVector, icrsToGalacticVector } from '../src/core/astro/coordinates';
import { METRES_PER_PARSEC } from '../src/core/units';
import { DEG_TO_RAD } from '../src/core/astro/constants';

const have = existsSync('public/data/deep-space.v1.json') && existsSync('public/deepspace/provenance.json');
const file = have ? (JSON.parse(readFileSync('public/data/deep-space.v1.json', 'utf8')) as DeepSpaceFile) : null;
const prov = have ? (JSON.parse(readFileSync('public/deepspace/provenance.json', 'utf8')) as DeepImageProvenanceFile) : null;
const d = describe.skipIf(!have);

d('Milky Way model sampler (pure; reads the real data file)', () => {
  const model = file!.models['milky-way']!;
  const p = readMilkyWayParams(model);
  const s = sampleMilkyWay(p);

  it('takes its scientific inputs from the data file', () => {
    expect(p.r0Pc).toBe(8178); expect(p.thinLengthPc).toBe(2600); expect(p.thinHeightPc).toBe(300); expect(p.thickHeightPc).toBe(900);
    expect(p.barHalfLengthPc).toBe(5000); expect(p.arms.map((a) => a.name)).toContain('Perseus');
    expect(p.armWidthAt8150Pc).toBe(336);
  });
  it('refuses to guess when a parameter is missing or ambiguous', () => {
    expect(() => readMilkyWayParams({ ...model, parameters: model.parameters.filter((q) => !/Thin disc exponential scale length/.test(q.name)) })).toThrow(/Thin disc exponential scale length/);
    const tables = { ...model.tables! }; delete (tables as Record<string, unknown>)['spiral-arms-reid2019'];
    expect(() => readMilkyWayParams({ ...model, tables })).toThrow(/arms/);
  });
  it('is deterministic and produces the documented number of splats', () => {
    const t = sampleMilkyWay(p);
    expect(t.count).toBe(s.count); expect(Array.from(t.positionIcrs.slice(0, 30))).toEqual(Array.from(s.positionIcrs.slice(0, 30)));
    expect(s.count).toBeGreaterThan(VISUAL.splatCount * 0.8); expect(s.count).toBeLessThan(VISUAL.splatCount * 1.2);
    for (const c of MW_COMPONENTS) expect(s.component.includes(MW_COMPONENTS.indexOf(c))).toBe(true);
  });
  it('arm centre lines obey the log-periodic law and pass through R_kink at beta_kink', () => {
    for (const a of p.arms) expect(armRadiusKpc(a, (a.betaKinkDeg * Math.PI) / 180)).toBeCloseTo(a.rKinkKpc, 9);
    const per = p.arms.find((a) => a.name === 'Perseus')!;
    const b = (per.betaKinkDeg + 20) * DEG_TO_RAD;
    expect(armRadiusKpc(per, b)).toBeCloseTo(per.rKinkKpc * Math.exp(-20 * DEG_TO_RAD * Math.tan(per.psiAboveDeg * DEG_TO_RAD)), 9);
  });
  it('the thin disc is exponential in radius (median radius of a Gamma(2) profile = 1.678 L) and flat', () => {
    const idx = Array.from({ length: s.count }, (_, i) => i).filter((i) => s.component[i] === MW_COMPONENTS.indexOf('thin'));
    const R = idx.map((i) => Math.hypot(s.galactocentric[3 * i]!, s.galactocentric[3 * i + 1]!)).sort((x, y) => x - y);
    expect(R[Math.floor(R.length / 2)]! / p.thinLengthPc).toBeGreaterThan(1.4); expect(R[Math.floor(R.length / 2)]! / p.thinLengthPc).toBeLessThan(1.9);
    const zs = idx.map((i) => Math.abs(s.galactocentric[3 * i + 2]!)).sort((x, y) => x - y);
    expect(zs[Math.floor(zs.length / 2)]! / p.thinHeightPc).toBeCloseTo(Math.LN2, 0); // Laplace median |z| = ln2 * scale height
  });
  it('the bar lies at the published angle, near end toward positive longitude (+y, Sun side)', () => {
    const idx = Array.from({ length: s.count }, (_, i) => i).filter((i) => s.component[i] === MW_COMPONENTS.indexOf('bar'));
    let sxx = 0, sxy = 0, syy = 0;
    for (const i of idx) { const x = s.galactocentric[3 * i]!, y = s.galactocentric[3 * i + 1]!; sxx += x * x; sxy += x * y; syy += y * y; }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy); // principal axis angle from +x
    const fromSunLine = Math.abs(Math.abs(ang) * (180 / Math.PI) - 180 + p.barAngleDeg); // axis of (-cos, sin) is 180-phi
    expect(Math.min(fromSunLine, Math.abs(ang * (180 / Math.PI) + p.barAngleDeg))).toBeLessThan(6);
  });
  it('places the Sun at R0 from the Galactic centre in ICRS and puts splats in the right frame', () => {
    const gc = galactocentricToIcrs([0, 0, 0], p.r0Pc);
    expect(length(gc)).toBeCloseTo(p.r0Pc, 6);
    const l = equatorialToGalactic(...(Object.values(require_unit(gc)) as [number, number]));
    expect(l.bDeg).toBeCloseTo(0, 6); expect(Math.min(l.lDeg, 360 - l.lDeg)).toBeLessThan(1e-6);
    // a point above the plane (galactocentric +z) is toward the north Galactic pole in ICRS
    const up = galactocentricToIcrs([-p.r0Pc, 0, 100], p.r0Pc);
    expect(dot(normalise(up), galacticToIcrsVector([0, 0, 1]))).toBeCloseTo(1, 6);
    expect(icrsToGalacticVector(up)[2]).toBeCloseTo(100, 6);
  });
  it('view gain: edge-on piles splats up, so its gain is smaller than face-on; interpolation is bounded and monotonic in between', () => {
    const t = buildViewGainTable(s);
    expect(t.length).toBe(GAIN_ELEVATIONS_DEG.length);
    expect(t[0]!).toBeLessThan(t[t.length - 1]!);
    for (const g of t) expect(g).toBeGreaterThan(0);
    expect(viewGain(t, 0)).toBe(t[0]); expect(viewGain(t, 90)).toBe(t[t.length - 1]); expect(viewGain(t, -90)).toBe(t[t.length - 1]);
    const mid = viewGain(t, 42); expect(mid).toBeGreaterThanOrEqual(Math.min(t[3]!, t[4]!)); expect(mid).toBeLessThanOrEqual(Math.max(t[3]!, t[4]!));
  });
});

function require_unit(v: readonly [number, number, number]): { ra: number; dec: number } {
  const n = normalise(v);
  return { ra: ((Math.atan2(n[1], n[0]) / DEG_TO_RAD) + 360) % 360, dec: Math.asin(n[2]) / DEG_TO_RAD };
}

d('galaxy image geometry (real data)', () => {
  const data = DeepSpaceData.fromFile(file!, prov!, { validate: false });
  const m31 = data.get('m31')!, m87 = data.get('m87')!;
  const PC = METRES_PER_PARSEC;

  it('a sky-plane image faces the Sun and has the published angular size at the catalogue distance', () => {
    const a = data.imageAssetsOf('m87')[0]!;
    const pl = placeImage(m87, a);
    const pos = data.positionPc('m87')!;
    expect(pl.kind).toBe('sky-plane');
    expect(dot(pl.normal, normalise(pos))).toBeLessThan(-0.999999); // normal toward the observer (back to the Sun)
    const d0 = length(pos);
    const angW = 2 * Math.atan(length(pl.xAxis) / d0) / DEG_TO_RAD * 60;
    expect(angW).toBeCloseTo(a.geometry.fovArcmin[0], 3);
  });
  it('a deprojected image, seen from the Sun, reproduces the original frame (width exactly, height by the 1/cos(i) stretch)', () => {
    const a = data.imageAssetsOf('m31')[0]!;
    const pl = placeImage(m31, a);
    expect(pl.kind).toBe('deprojected-disc');
    expect(pl.tiltIsChoice).toBe(true); // nearSide is 'unknown' in the data: flagged as illustrative
    const pos = data.positionPc('m31')!; const u = normalise(pos);
    const proj = (v: readonly number[]) => { const k = dot(v as never, u); return [v[0]! - k * u[0], v[1]! - k * u[1], v[2]! - k * u[2]]; };
    const px = proj(pl.xAxis), py = proj(pl.yAxis);
    const ang = (v: number[]) => (2 * Math.atan(Math.hypot(...(v as [number, number, number])) / length(pos)) / DEG_TO_RAD) * 60;
    expect(ang(px)).toBeCloseTo(a.geometry.fovArcmin[0], 2);
    expect(ang(py)).toBeCloseTo(a.geometry.fovArcmin[1], 2);
    // the tilted axis is stretched (its true length exceeds its projection), the other is not
    const stretch = [length(pl.xAxis) / Math.hypot(...(px as [number, number, number])), length(pl.yAxis) / Math.hypot(...(py as [number, number, number]))];
    expect(Math.max(...stretch)).toBeGreaterThan(1.5);
    expect(Math.min(...stretch)).toBeGreaterThanOrEqual(1 - 1e-9);
    const o = discOrientationOf(m31)!;
    expect(o.inclinationDeg).toBeCloseTo(72.17, 2);
  });
  it('the vignette ellipse is centred on the galaxy and reaches |q| = 1 at 1.6 catalogue radii', () => {
    const a = data.imageAssetsOf('m87')[0]!;
    const pl = placeImage(m87, a);
    const R = (m87.angularSize!.majorArcmin * DEG_TO_RAD) / 60 / 2 * length(data.positionPc('m87')!);
    // image centre == object position here, so q(0,0) = 0; q at +x edge: hw/(R*1.6)
    expect(Math.hypot(...pl.vignette.c)).toBeLessThan(1e-3);
    const hw = length(pl.xAxis);
    expect(Math.hypot(pl.vignette.row0[0], pl.vignette.row1[0])).toBeCloseTo(hw / (R * VIGNETTE_RADIUS_SCALE), 2);
  });
  it('the glow of a tilted disc projects to an ellipse with axis ratio about cos(i) when seen from the Sun', () => {
    const g = galaxyGlowAxes(m31)!;
    const pos = data.positionPc('m31')!;
    const f = normalise(pos.map((x) => -x) as unknown as [number, number, number]); // camera at the Sun looks toward M31: forward = +pos
    const fwd = normalise(pos); void f;
    const right = normalise([-fwd[1], fwd[0], 0]); const up = [fwd[1] * right[2] - fwd[2] * right[1], fwd[2] * right[0] - fwd[0] * right[2], fwd[0] * right[1] - fwd[1] * right[0]] as [number, number, number];
    const out = { a: 0, b: 0, angle: 0, x: 0, y: 0, depth: 0 };
    expect(projectEllipse(pos, g.A, g.B, right, up, fwd, 1000, out)).toBe(true);
    expect(out.b / out.a).toBeCloseTo(Math.cos(72.17 * DEG_TO_RAD), 2);
    expect(out.a).toBeCloseTo((g.radiusPc / length(pos)) * 1000, 0);
    void PC;
  });
  it('projectEllipse reports false for an object behind the camera and is a circle for a face-on disc', () => {
    const out = { a: 0, b: 0, angle: 0, x: 0, y: 0, depth: 0 };
    expect(projectEllipse([0, 0, -10], [1, 0, 0], [0, 1, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], 500, out)).toBe(false);
    expect(projectEllipse([0, 0, 100], [1, 0, 0], [0, 1, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], 500, out)).toBe(true);
    expect(out.a).toBeCloseTo(5, 6); expect(out.b).toBeCloseTo(5, 6);
  });
});
