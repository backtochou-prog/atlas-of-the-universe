import { describe, expect, it } from 'vitest';
import { equatorialToUnit } from '../src/core/astro/coordinates';
import { bpRpFromBv, BV_TO_BPRP, colourFromBv, teffFromBvBallesteros } from '../src/render/discovery/brightStarColour';
import {
  BRIGHT_MARGINAL_CONFIDENCE, brightPlacement, buildBrightStarSet, drawnGaiaIdSet, HIPPARCOS_EPOCH, propagateToTargetEpoch, TARGET_EPOCH,
} from '../src/render/discovery/brightStarSet';
import { BrightStarLayer } from '../src/render/discovery/BrightStarLayer';
import { cameraBasis } from '../src/render/orbitCamera';
import { colourFromBpRp, MISSING_COLOUR } from '../src/render/starColour';
import { buildStarLayer } from '../src/render/starLayer';
import type { BrightStarFile } from '../src/discovery/types';
import { have, loadGaia, readGz } from './fixtures/discovery/real';

/** Minimal BrightStarFile for the pure builder. Rows: [hip, ra, dec, plx, err, pmra, pmdec, V, B-V, name, gaiaId]. */
type Row = [number, number, number, number | null, number | null, number | null, number | null, number | null, number | null, string | null, string | null];
function file(rows: Row[]): BrightStarFile {
  const col = (i: number): (number | string | null)[] => rows.map((r) => r[i] as number | string | null);
  return {
    manifest: { id: 'x', title: 'x', source: 'x', licence: 'x', query: 'x', count: rows.length, caveats: [], units: {}, astrometricEpoch: 'J1991.25', nameSource: 'x' } as unknown as BrightStarFile['manifest'],
    columns: { hip: col(0), raDeg: col(1), decDeg: col(2), parallaxMas: col(3), parallaxErrMas: col(4), pmraMasYr: col(5), pmdecMasYr: col(6), vMag: col(7), bvColour: col(8), iauName: col(9), gaiaSourceId: col(10) },
  };
}

describe('B-V -> colour', () => {
  it('reproduces the Pecaut & Mamajek rows exactly and the Sun maps to the ramp\'s solar anchor', () => {
    expect(bpRpFromBv(0.65)).toBeCloseTo(0.823, 6);   // G2V
    expect(bpRpFromBv(1.42)).toBeCloseTo(1.84, 6);    // M0V
    expect(bpRpFromBv(0.0)).toBeCloseTo(-0.037, 6);   // A0V
    expect(colourFromBv(0.65)).toEqual(colourFromBpRp(0.823));
  });
  it('interpolates linearly between rows and is strictly increasing over the table', () => {
    expect(bpRpFromBv(0.8)).toBeCloseTo(0.95 + ((0.8 - 0.775) / (0.816 - 0.775)) * (0.983 - 0.95), 6);
    for (let i = 1; i < BV_TO_BPRP.length; i++) { expect(BV_TO_BPRP[i]![0]).toBeGreaterThan(BV_TO_BPRP[i - 1]![0]); expect(BV_TO_BPRP[i]![1]).toBeGreaterThan(BV_TO_BPRP[i - 1]![1]); }
    let prev = -Infinity;
    for (let bv = -0.3; bv <= 2.4; bv += 0.01) { const v = bpRpFromBv(bv)!; expect(v).toBeGreaterThanOrEqual(prev); prev = v; }
  });
  it('clamps on the red side, extrapolates gently on the blue side, and gives grey for a missing index', () => {
    expect(bpRpFromBv(3.3)).toBeCloseTo(4.16, 6);
    expect(bpRpFromBv(-0.3)).toBeCloseTo(-0.087 + 0.5 * (-0.3 + 0.05), 6);
    expect(bpRpFromBv(null)).toBeNull();
    expect(bpRpFromBv(NaN)).toBeNull();
    expect(colourFromBv(null)).toEqual(MISSING_COLOUR);
  });
  it('hot stars are bluer and cool stars redder than the Sun in the display colour', () => {
    const blue = colourFromBv(-0.2), sun = colourFromBv(0.65), red = colourFromBv(1.8);
    expect(blue[2]).toBeGreaterThan(blue[0]); expect(red[0]).toBeGreaterThan(red[2]); expect(sun[0]).toBeGreaterThan(sun[2]);
  });
  it('the Ballesteros relation gives the Sun 5780 K within 30 K', () => {
    expect(Math.abs(teffFromBvBallesteros(0.65) - 5772)).toBeLessThan(40);
  });
});

describe('proper-motion propagation J1991.25 -> J2016.0', () => {
  it('uses dt = 24.75 yr', () => { expect(TARGET_EPOCH - HIPPARCOS_EPOCH).toBeCloseTo(24.75, 10); });
  it('Sirius (pm -546.01, -1223.07 mas/yr) moves 30.27 arcsec in Dec and 13.51 arcsec x sec(dec) in RA', () => {
    const ra = 101.28854105, dec = -16.71314306;
    const p = propagateToTargetEpoch(ra, dec, -546.01, -1223.07);
    const dDecArcsec = (p.decDeg - dec) * 3600, dRaCosArcsec = (p.raDeg - ra) * 3600 * Math.cos((dec * Math.PI) / 180);
    expect(dDecArcsec).toBeCloseTo((-1223.07 * 24.75) / 1000, 1);
    expect(dRaCosArcsec).toBeCloseTo((-546.01 * 24.75) / 1000, 1);
  });
  it('a star without proper motion keeps its catalogue position', () => {
    expect(propagateToTargetEpoch(10, 20, null, null)).toEqual({ raDeg: 10, decDeg: 20 });
    expect(propagateToTargetEpoch(10, 20, 5, null)).toEqual({ raDeg: 10, decDeg: 20 });
  });
  it('is a no-op for zero motion and keeps RA in [0, 360)', () => {
    const p = propagateToTargetEpoch(359.9999, 0, 0, 0);
    expect(p.raDeg).toBeCloseTo(359.9999, 8);
    const q = propagateToTargetEpoch(0.00001, 0, -1000, 0);
    expect(q.raDeg).toBeGreaterThanOrEqual(0); expect(q.raDeg).toBeLessThan(360);
  });
});

describe('reliability rule for the Hipparcos supplement', () => {
  it('places S/N >= 10 as reliable (d = 1000/parallax)', () => {
    const p = brightPlacement(379.21, 1.58, true)!;
    expect(p.placement).toBe('reliable'); expect(p.distancePc).toBeCloseTo(1000 / 379.21, 9);
    expect(brightPlacement(3.78, 0.34, true)!.placement).toBe('reliable');   // Rigel, S/N 11.1
    expect(brightPlacement(3.78, 0.34, false)!.placement).toBe('reliable');  // naming does not matter for a reliable one
  });
  it('places S/N in [5,10) only for NAMED stars, flagged', () => {
    const b = brightPlacement(6.55, 0.83, true)!;                             // Betelgeuse S/N 7.9
    expect(b.placement).toBe('marginal-named'); expect(b.distancePc).toBeCloseTo(152.67, 1);
    expect(brightPlacement(6.55, 0.83, false)).toBeNull();
    expect(brightPlacement(5.89, 1, true)!.placement).toBe('marginal-named');  // Antares S/N 5.89
  });
  it('does not place S/N < 5, non-positive or missing parallaxes, even when named', () => {
    expect(brightPlacement(1.65, 0.45, true)).toBeNull();                      // Alnilam S/N 3.7
    expect(brightPlacement(-2, 0.5, true)).toBeNull();
    expect(brightPlacement(null, 0.5, true)).toBeNull();
    expect(brightPlacement(5, null, true)).toBeNull();
    expect(brightPlacement(5, 0, true)).toBeNull();
  });
  it('an explicit looser limit for named stars places Alnilam (opt-in only)', () => {
    const p = brightPlacement(1.65, 0.45, true, 3)!;
    expect(p.placement).toBe('marginal-named'); expect(p.distancePc).toBeCloseTo(606.06, 1);
    expect(brightPlacement(1.65, 0.45, false, 3)).toBeNull();
  });
});

describe('buildBrightStarSet', () => {
  const rows: Row[] = [
    [1, 10, 20, 100, 1, 0, 0, 2, 0.5, 'Alpha', null],           // reliable, no Gaia link: drawn
    [2, 11, 21, 100, 1, 0, 0, 3, 0.5, null, '111'],             // Gaia record drawn by the Gaia layer: skipped
    [3, 12, 22, 100, 1, 0, 0, 3, 0.5, null, '222'],             // Gaia record NOT drawn: drawn from Hipparcos
    [4, 13, 23, 8, 1, 0, 0, 1, 1.8, 'Beta', null],              // S/N 8, named: marginal-named
    [5, 14, 24, 8, 1, 0, 0, 1, 1.8, null, null],                // S/N 8, unnamed: not placed
    [6, 15, 25, 1, 1, 0, 0, 1, 1.8, 'Gamma', null],             // S/N 1 named: not placed
    [7, 16, 26, null, null, 0, 0, 1, null, null, null],         // no parallax
    [8, 17, 27, 100, 1, 0, 0, null, 0.5, null, null],           // no V: skipped
  ];
  const set = buildBrightStarSet(file(rows), (g) => g === '111');
  it('dedupes against the drawn Gaia set and counts every skip', () => {
    expect(set.stars.map((s) => s.id)).toEqual(['hip:1', 'hip:3', 'hip:4']);
    expect(set.skipped).toMatchObject({ drawnByGaia: 1, unplaced: 3, unplacedMarginalUnnamed: 1, noPhotometryOrPosition: 1 });
    expect(set.skipped.unplacedNamed).toEqual(['Gamma']);
    expect(set.rows).toBe(8);
  });
  it('ids are hip:<n>; names fall back to HIP <n>', () => {
    for (const s of set.stars) expect(s.id).toBe(`hip:${s.hip}`);
    expect(set.stars.map((s) => s.name)).toEqual(['Alpha', 'HIP 3', 'Beta']);
  });
  it('absolute magnitude is V - 5 log10 d + 5; positions have norm = distance; the renderer arrays agree', () => {
    for (let k = 0; k < set.stars.length; k++) {
      const s = set.stars[k]!;
      expect(s.absMag).toBeCloseTo(s.vMag - 5 * Math.log10(s.distancePc) + 5, 9);
      expect(Math.hypot(...s.xyzPc)).toBeCloseTo(s.distancePc, 9);
      expect(set.layer.absMag[k]).toBeCloseTo(s.absMag, 5);
      expect(set.layer.positionPc[3 * k]).toBe(s.xyzPc[0]);
      expect(set.layer.catalogueIndex[k]).toBe(s.hip);
    }
    expect(set.layer.count).toBe(3);
  });
  it('marginal-named stars carry the low-reliability flag and the reduced opacity; reliable ones do not', () => {
    const by = new Map(set.stars.map((s) => [s.hip, s]));
    expect(by.get(1)!.lowReliability).toBe(false); expect(set.layer.confidence[0]).toBe(1);
    expect(by.get(4)!.lowReliability).toBe(true); expect(by.get(4)!.placement).toBe('marginal-named'); expect(set.layer.confidence[2]).toBeCloseTo(BRIGHT_MARGINAL_CONFIDENCE, 6);
  });
  it('a star with no B-V gets the neutral grey, others the ramp colour', () => {
    const s = buildBrightStarSet(file([[1, 0, 0, 100, 1, 0, 0, 2, null, null, null], [2, 0, 0, 100, 1, 0, 0, 2, 0.65, null, null]]), () => false);
    expect([...s.layer.colour.slice(0, 3)]).toEqual([...MISSING_COLOUR].map((x) => Math.fround(x)));
    expect(s.layer.colour[3]).toBeCloseTo(colourFromBpRp(0.823)[0], 5);
  });
  it('drawnGaiaIdSet lists the source ids of the Gaia layer rows', () => {
    const ids = ['a', 'b', 'c'];
    const s = drawnGaiaIdSet({ sourceId: (i) => ids[i]! }, { count: 2, catalogueIndex: Uint32Array.from([2, 0]) });
    expect([...s].sort()).toEqual(['a', 'c']);
  });
});

describe('BrightStarLayer', () => {
  // Stars at +x, +y, -x at 10 pc, V = 2; the camera is the Sun looking along +x.
  const f = file([[10, 0, 0, 100, 1, 0, 0, 2, 0.5, 'East', null], [11, 90, 0, 100, 1, 0, 0, 2, 0.5, 'North', null], [12, 180, 0, 100, 1, 0, 0, 2, 0.5, 'Back', null]]);
  const basis = cameraBasis({ focus: [0, 0, 0], distance: 1, yaw: Math.PI, pitch: 0 }); // looks along +x
  const vp = { width: 1000, height: 800 };
  const make = (): BrightStarLayer => { const l = new BrightStarLayer(f, () => false); l.setPixelRatio(1); l.update([0, 0, 0]); return l; };
  it('exposes the placed list and counts', () => {
    const l = make();
    expect(l.placedStars().map((s) => s.id)).toEqual(['hip:10', 'hip:11', 'hip:12']);
    expect(l.stats().points).toBe(3);
    expect(l.starOf('hip:11')?.name).toBe('North');
    expect(l.starOf('gaia:1')).toBeUndefined();
    l.dispose();
  });
  it('picks the star under the cursor as hip:<n>, nothing far from any star or behind the camera', () => {
    const l = make();
    const ctx = { basis, viewport: vp, camPc: [0, 0, 0] as [number, number, number] };
    expect(l.pick(500, 400, ctx)).toBe('hip:10');
    expect(l.pick(506, 405, ctx)).toBe('hip:10');
    expect(l.pick(100, 100, ctx)).toBeNull();
    l.dispose();
  });
  it('does not pick a star fainter than the magnitude limit, nor when faded out', () => {
    const l = make();
    const ctx = { basis, viewport: vp, camPc: [0, 0, 0] as [number, number, number] };
    l.setMagLimit(1);                         // the stars are V = 2: not drawn
    expect(l.pick(500, 400, ctx)).toBeNull();
    l.setMagLimit(7.5);
    expect(l.pick(500, 400, ctx)).toBe('hip:10');
    l.setFade(0);
    expect(l.pick(500, 400, ctx)).toBeNull();
    l.dispose();
  });
  it('renders camera-relative float32 positions even when the camera is a kiloparsec away (floating origin)', () => {
    const l = new BrightStarLayer(f, () => false);
    const cam: [number, number, number] = [1000.123456789, 0, 0];
    l.update(cam);
    const rel = (l.object as unknown as { geometry: { getAttribute(n: string): { array: Float32Array } } }).geometry.getAttribute('position').array;
    expect(rel[0]).toBeCloseTo(10 - 1000.123456789, 4);
    l.dispose();
  });
});

describe.skipIf(!have('bright-stars.v1.json.gz') || !have('gaia-dr3-subset.v1.json.gz'))('real data: Hipparcos supplement', () => {
  const brightFile = readGz<BrightStarFile>('bright-stars.v1.json.gz');
  const { cat } = loadGaia();
  const gaiaLayer = buildStarLayer(cat);
  const drawn = drawnGaiaIdSet(cat, gaiaLayer);
  const set = buildBrightStarSet(brightFile, (g) => drawn.has(g));
  const byName = new Map(set.stars.map((s) => [s.name, s]));
  it('counts: 8942 rows, none placed that the Gaia layer draws, every placed star has a V and a position', () => {
    expect(set.rows).toBe(8942);
    expect(set.stars.length + set.skipped.drawnByGaia + set.skipped.unplaced + set.skipped.noPhotometryOrPosition).toBe(8942);
    for (const s of set.stars) { if (s.gaiaSourceId !== null) expect(drawn.has(s.gaiaSourceId)).toBe(false); expect(Number.isFinite(s.vMag)).toBe(true); expect(s.xyzPc.every(Number.isFinite)).toBe(true); }
    expect(new Set(set.stars.map((s) => s.id)).size).toBe(set.stars.length);
  });
  it('every Hipparcos-only star with a reliable parallax is placed', () => {
    const c = brightFile.columns;
    let n = 0;
    for (let i = 0; i < (c['hip'] as number[]).length; i++) {
      if (c['gaiaSourceId']![i] !== null) continue;
      const p = c['parallaxMas']![i] as number | null, e = c['parallaxErrMas']![i] as number | null;
      if (p !== null && e !== null && e > 0 && p / e >= 10) { n++; expect(set.stars.some((s) => s.hip === c['hip']![i])).toBe(true); }
    }
    expect(n).toBeGreaterThan(100);
  });
  it('the famous stars are placed where the catalogue says (distance 1000/parallax, direction = catalogue RA/Dec moved by proper motion)', () => {
    const want: [string, number, boolean][] = [['Sirius', 2.637, false], ['Vega', 7.679, false], ['Arcturus', 11.257, false], ['Rigel', 264.55, false], ['Polaris', 132.63, false], ['Rigil Kentaurus', 1.325, false], ['Betelgeuse', 152.67, true], ['Antares', 169.78, true]];
    const c = brightFile.columns;
    for (const [name, d, low] of want) {
      const s = byName.get(name)!;
      expect(s, name).toBeDefined();
      expect(s.distancePc).toBeCloseTo(d, 1); expect(s.lowReliability).toBe(low);
      const i = (c['hip'] as number[]).indexOf(s.hip);
      const u = equatorialToUnit(c['raDeg']![i] as number, c['decDeg']![i] as number);
      const pm = Math.hypot(c['pmraMasYr']![i] as number, c['pmdecMasYr']![i] as number); // mas/yr
      const sepRad = Math.acos(Math.min(1, (u[0] * s.xyzPc[0] + u[1] * s.xyzPc[1] + u[2] * s.xyzPc[2]) / s.distancePc));
      expect(sepRad * 206264806.2).toBeCloseTo(pm * 24.75, -1);   // the shift IS the proper motion over 24.75 yr (to ~10 mas)
    }
  });
  it('Sirius is the brightest placed star from the Sun (smallest V) and its apparent magnitude from the origin equals its V', () => {
    const brightest = [...set.stars].sort((a, b) => a.vMag - b.vMag)[0]!;
    expect(brightest.name).toBe('Sirius'); expect(brightest.vMag).toBeCloseTo(-1.44, 2);
    expect(brightest.absMag + 5 * Math.log10(Math.hypot(...brightest.xyzPc)) - 5).toBeCloseTo(brightest.vMag, 9);
  });
  it('Alnilam is not placed (parallax S/N 3.7) and the atlas can say so', () => {
    expect(byName.has('Alnilam')).toBe(false);
    expect(set.skipped.unplacedNamed).toContain('Alnilam');
  });
  it('Orion belt stars Alnitak and Mintaka are placed as low-reliability', () => {
    expect(byName.get('Alnitak')?.lowReliability).toBe(true); expect(byName.get('Mintaka')?.lowReliability).toBe(true);
  });
});
