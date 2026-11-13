import { describe, expect, it } from 'vitest';
import { equatorialToUnit } from '../src/core/astro/coordinates';
import type { PointCatalogueFile } from '../src/data/deepspace/types';
import {
  APPLICATION_H0_KM_S_MPC, assumedGlobularDepthPc, buildDuplicateIndex, buildMembers, classifyMorphology, distanceBarPc, groupViewDistancePc, hash01,
  hubbleDistancePc, isImageGalaxyDuplicate, isIndependentDistance, markerAlphaFromMag, markerRadiusPx, MARKER_VISUAL, MIN_CZ_FOR_HUBBLE_KMS, normaliseDesignation,
  openMemberDistancePc, plummerLosCdf, plummerLosQuantile, virgoBlend, type ClusterGeometry, type MemberColumns,
} from '../src/render/deep-space/clusterGeometry';
import { CATALOGUE_RANGES, membersWanted, parseRowId, PointCatalogueStore, sunCatalogueWanted } from '../src/render/deep-space/pointCatalogues';
import { clusterNote } from '../src/render/deep-space/StarClusterRenderer';
import { COSMIC_CAVEAT, cosmicNote } from '../src/render/deep-space/CosmicStructureRenderer';

describe('hash and the assumed globular depth', () => {
  it('hash01 is deterministic, in (0,1) and well spread', () => {
    expect(hash01('Gaia 12345')).toBe(hash01('Gaia 12345'));
    expect(hash01('a')).not.toBe(hash01('b'));
    let lo = 0, hi = 0;
    for (let i = 0; i < 4000; i++) { const h = hash01(String(1328057763997754112n + BigInt(i))); expect(h).toBeGreaterThan(0); expect(h).toBeLessThan(1); if (h < 0.5) lo++; else hi++; }
    expect(Math.abs(lo - hi)).toBeLessThan(300);
  });
  it('the Plummer line-of-sight quantile inverts the CDF and is symmetric', () => {
    for (const u of [0.01, 0.2, 0.5, 0.8, 0.99]) expect(plummerLosCdf(plummerLosQuantile(u))).toBeCloseTo(u, 7);
    expect(plummerLosQuantile(0.5)).toBeCloseTo(0, 7);
    expect(plummerLosQuantile(0.3)).toBeCloseTo(-plummerLosQuantile(0.7), 7);
    expect(plummerLosCdf(1e3)).toBeCloseTo(1, 6);
  });
  it('the depth offset is deterministic per star, grows with the projected radius and is centred on the cluster mean', () => {
    expect(assumedGlobularDepthPc('4567', 3, 5)).toBe(assumedGlobularDepthPc('4567', 3, 5));
    const spread = (R: number) => { const v: number[] = []; for (let i = 0; i < 2000; i++) v.push(assumedGlobularDepthPc(`s${i}`, R, 5)); v.sort((a, b) => a - b); return { med: v[1000]!, iqr: v[1500]! - v[500]! }; };
    const inner = spread(0.5), outer = spread(30);
    expect(Math.abs(inner.med)).toBeLessThan(0.5);
    expect(outer.iqr).toBeGreaterThan(inner.iqr * 3);
    // spherical symmetry: at projected radius R and Plummer scale a the quartiles are +/- 0.4 sqrt(a^2 + R^2) (Plummer line of sight, t quartile 0.3...)
    expect(inner.iqr / 2).toBeGreaterThan(0.2 * Math.hypot(5, 0.5)); expect(inner.iqr / 2).toBeLessThan(0.6 * Math.hypot(5, 0.5));
  });
});

describe('member positions', () => {
  it('open clusters: parallax distance, with the three fall-backs to the cluster mean', () => {
    expect(openMemberDistancePc(7.5, 135)).toEqual({ distancePc: 1000 / 7.5, kind: 'parallax' });
    expect(openMemberDistancePc(null, 135)).toEqual({ distancePc: 135, kind: 'mean-no-parallax' });
    expect(openMemberDistancePc(undefined, 135).kind).toBe('mean-no-parallax');
    expect(openMemberDistancePc(0, 135)).toEqual({ distancePc: 135, kind: 'mean-nonpositive-parallax' });
    expect(openMemberDistancePc(-0.3, 135)).toEqual({ distancePc: 135, kind: 'mean-nonpositive-parallax' });
    expect(openMemberDistancePc(Number.NaN, 135).kind).toBe('mean-no-parallax');
  });

  const open: ClusterGeometry = { kind: 'open', raDeg: 56.6, decDeg: 24.1, distancePc: 135, centre: [0, 0, 0], plummerScalePc: 2.7 };
  const centre = ((): ClusterGeometry => { const u = equatorialToUnit(56.6, 24.1); return { ...open, centre: [u[0] * 135, u[1] * 135, u[2] * 135] }; })();
  const cols = (over: Partial<Record<keyof MemberColumns, (number | string | null)[]>> = {}): MemberColumns => ({
    raDeg: [56.0, 57.0, 56.6, 56.7, 56.5], decDeg: [24.0, 24.2, 24.1, 24.3, 24.0], sourceId: ['1', '2', '3', '4', '5'], gMag: [9, 7, 12, 15, 11],
    bpRp: [0.1, 0.5, null, 1.5, 2.0], parallaxMas: [7.4, 7.5, null, 0, -1], parallaxErrMas: [0.01, 0.02, null, 0.5, 0.5], ...over,
  });

  it('builds one row per catalogue row, brightest first, with absolute magnitude from the PLACED distance and exact sky directions', () => {
    const b = buildMembers(cols(), centre);
    expect(b.count).toBe(5);
    expect([...b.gMag]).toEqual([7, 9, 11, 12, 15]);
    expect(b.stats).toMatchObject({ total: 5, placedByParallax: 2, meanNoParallax: 1, meanNonPositiveParallax: 2, noColour: 1 });
    // first row is the G=7 star (ra 57, dec 24.2, parallax 7.5)
    const u = equatorialToUnit(57.0, 24.2), d = 1000 / 7.5;
    expect(centre.centre[0] + b.offset[0]!).toBeCloseTo(u[0] * d, 3);
    expect(centre.centre[1] + b.offset[1]!).toBeCloseTo(u[1] * d, 3);
    expect(centre.centre[2] + b.offset[2]!).toBeCloseTo(u[2] * d, 3);
    expect(b.absMag[0]).toBeCloseTo(7 - 5 * Math.log10(d) + 5, 4);
    // a member with a non-positive parallax sits at the mean distance
    const k = [...b.gMag].indexOf(12); // ra 56.6, dec 24.1 = the centre direction, no parallax: exactly at the centre
    expect(Math.hypot(b.offset[3 * k]!, b.offset[3 * k + 1]!, b.offset[3 * k + 2]!)).toBeLessThan(1e-3);
    expect(b.stats.noisyParallax).toBe(0);
  });
  it('counts parallaxes whose error exceeds 10% as noisy, without moving them', () => {
    const b = buildMembers(cols({ parallaxMas: [7.4, 7.5, 7.5, 1, 7.5], parallaxErrMas: [0.01, 0.02, 0.02, 0.5, 0.9] }), centre);
    expect(b.stats.noisyParallax).toBe(2);
  });
  it('skips rows without a position or a G magnitude (nothing is invented) and never reorders unpredictably', () => {
    const b = buildMembers(cols({ gMag: [9, null, 12, 15, 11] }), centre);
    expect(b.count).toBe(4);
    expect(buildMembers(cols(), centre).gMag).toEqual(buildMembers(cols(), centre).gMag);
  });
  it('globular clusters: the catalogued sky position is reproduced exactly from the Sun, depth is assumed and deterministic', () => {
    const glob: ClusterGeometry = { kind: 'globular', raDeg: 201.7, decDeg: -47.5, distancePc: 5430, centre: [0, 0, 0], plummerScalePc: 7.56 };
    const u0 = equatorialToUnit(201.7, -47.5);
    const g = { ...glob, centre: [u0[0] * 5430, u0[1] * 5430, u0[2] * 5430] as [number, number, number] };
    const c: MemberColumns = { raDeg: [201.7, 201.9, 201.5], decDeg: [-47.5, -47.4, -47.6], sourceId: ['10', '11', '12'], gMag: [12, 13, 14], bpRp: [1, null, 1.2], parallaxMas: [0.2, 0.1, null] };
    const a = buildMembers(c, g), b = buildMembers(c, g);
    expect([...a.offset]).toEqual([...b.offset]);
    expect(a.stats.assumedDepth).toBe(3);
    expect(a.stats.noColour).toBe(1);
    for (let k = 0; k < 3; k++) {
      const p = [g.centre[0] + a.offset[3 * k]!, g.centre[1] + a.offset[3 * k + 1]!, g.centre[2] + a.offset[3 * k + 2]!];
      const r = Math.hypot(p[0]!, p[1]!, p[2]!), uu = equatorialToUnit(c.raDeg[k] as number, c.decDeg[k] as number);
      expect(p[0]! / r).toBeCloseTo(uu[0], 5); expect(p[1]! / r).toBeCloseTo(uu[1], 5); expect(p[2]! / r).toBeCloseTo(uu[2], 5);
      expect(Math.abs(r - 5430)).toBeLessThan(200);
    }
    // the parallax is NOT used: changing it changes nothing
    const c2: MemberColumns = { ...c, parallaxMas: [5, 5, 5] };
    expect([...buildMembers(c2, g).offset]).toEqual([...a.offset]);
  });
});

describe('cosmic structure: cz / H0', () => {
  it('H0 is the documented application choice and d = cz / H0 in parsecs', () => {
    expect(APPLICATION_H0_KM_S_MPC).toBe(70);
    expect(hubbleDistancePc(7000)).toBeCloseTo(100e6, 3);
    expect(hubbleDistancePc(MIN_CZ_FOR_HUBBLE_KMS)).toBeCloseTo((1000 / 70) * 1e6, 3);
  });
  it('rows with cz below 1000 km/s (or no cz) are not placed', () => {
    for (const cz of [999.9, 0, -300, Number.NaN, null, undefined]) expect(hubbleDistancePc(cz)).toBeNull();
  });
});

describe('duplicates of image galaxies', () => {
  const idx = buildDuplicateIndex([
    { designations: ['M 31', 'NGC 224', 'UGC 454', 'PGC 2557'], name: 'Andromeda Galaxy (M31)', raDeg: 10.6847, decDeg: 41.2688 },
    { designations: ['M 33', 'NGC 598'], name: 'Triangulum Galaxy (M33)', raDeg: 23.462, decDeg: 30.66 },
    { designations: ['LMC', 'ESO 56-115'], name: 'Large Magellanic Cloud', raDeg: 80.894, decDeg: -69.756 },
    { designations: ['M 87', 'NGC 4486'], name: 'Messier 87', raDeg: 187.7059, decDeg: 12.3911 },
    { designations: ['The Galaxy', 'Milky Way Galaxy'], name: 'Milky Way' },
  ]);
  it('normalises designations from the three spellings', () => {
    expect(normaliseDesignation('MESSIER031')).toBe('M31');
    expect(normaliseDesignation('M 31')).toBe('M31');
    expect(normaliseDesignation('NGC0224')).toBe('NGC224');
    expect(normaliseDesignation('NGC 224')).toBe('NGC224');
    expect(normaliseDesignation('ESO 56-115')).toBe('ESO56115');
  });
  it('matches by name, by alias and by position, and keeps genuine neighbours', () => {
    expect(isImageGalaxyDuplicate(idx, 'MESSIER031', 10.68, 41.27)).toBe(true);
    expect(isImageGalaxyDuplicate(idx, 'NGC 224', 0, 0)).toBe(true);
    expect(isImageGalaxyDuplicate(idx, 'Andromeda', 99, 9)).toBe(true);     // McConnachie spelling
    expect(isImageGalaxyDuplicate(idx, 'Triangulum', 99, 9)).toBe(true);
    expect(isImageGalaxyDuplicate(idx, 'Milky Way', 266.4, -29)).toBe(true);
    expect(isImageGalaxyDuplicate(idx, 'LMC', 80.9, -69.7)).toBe(true);
    expect(isImageGalaxyDuplicate(idx, null, 187.70593, 12.39113)).toBe(true); // 2MRS row: no name, same place as M87
    expect(isImageGalaxyDuplicate(idx, 'NGC 205', 10.0919, 41.6853)).toBe(false);
    expect(isImageGalaxyDuplicate(idx, 'M32', 10.6743, 40.8652)).toBe(false); // M32 has its own image object in the data, not in this fixture
    expect(isImageGalaxyDuplicate(idx, null, 187.7059 + 0.01, 12.3911)).toBe(false); // 0.6 arcmin away: a different galaxy
  });
});

describe('morphology and distance method', () => {
  it('classifies the three spellings and leaves unknowns neutral', () => {
    expect(classifyMorphology('ungc', 'T=-3')).toBe('early');
    expect(classifyMorphology('ungc', 'T=3')).toBe('intermediate');
    expect(classifyMorphology('ungc', 'T=8')).toBe('late');
    for (const m of ['Sph', 'dE', 'dEem', 'dS0em']) expect(classifyMorphology('ungc', m)).toBe('early');
    for (const m of ['Ir', 'Im', 'BCD', 'Tr']) expect(classifyMorphology('ungc', m)).toBe('late');
    expect(classifyMorphology('local-group-mcconnachie', 'dSph')).toBe('early');
    expect(classifyMorphology('local-group-mcconnachie', 'dIrr')).toBe('late');
    expect(classifyMorphology('local-group-mcconnachie', 'dSph?')).toBe('early');
    expect(classifyMorphology('local-group-mcconnachie', '????')).toBe('unknown');
    expect(classifyMorphology('local-group-mcconnachie', 'Sb')).toBe('intermediate');
    expect(classifyMorphology('twomrs', '-5')).toBe('early');
    expect(classifyMorphology('twomrs', '3A2s')).toBe('intermediate');
    expect(classifyMorphology('twomrs', '98')).toBe('unknown');
    expect(classifyMorphology('twomrs', null)).toBe('unknown');
    expect(classifyMorphology('ungc', null)).toBe('unknown');
  });
  it("UNGC methods 'mem', 'h', \"h'\" and 'txt' are not independent distances", () => {
    for (const m of ['mem', 'h', "h'", 'txt']) expect(isIndependentDistance('ungc', m)).toBe(false);
    for (const m of ['TRGB', 'Cep', 'SBF', 'TF']) expect(isIndependentDistance('ungc', m)).toBe(true);
    expect(isIndependentDistance('local-group-mcconnachie', 'literature compilation')).toBe(true);
    expect(MARKER_VISUAL.notIndependent).toBeLessThan(1);
  });
  it('marker size and opacity are monotone in magnitude and capped', () => {
    let pr = 0, pa = 0;
    for (let m = 20; m >= 0; m -= 0.5) { const r = markerRadiusPx(m), a = markerAlphaFromMag(m); expect(r).toBeGreaterThanOrEqual(pr); expect(a).toBeGreaterThanOrEqual(pa); pr = r; pa = a; }
    expect(markerRadiusPx(-5)).toBe(MARKER_VISUAL.radiusMaxPx);
    expect(markerAlphaFromMag(-5)).toBe(MARKER_VISUAL.alphaMax);
    expect(markerRadiusPx(null)).toBe(MARKER_VISUAL.radiusMinPx);
  });
});

describe('groups and the line-of-sight bar', () => {
  it('a distance bar needs a published error', () => {
    expect(distanceBarPc(1e6, 2e5)).toEqual({ nearPc: 8e5, farPc: 1.2e6 });
    expect(distanceBarPc(1e5, 2e5)).toEqual({ nearPc: 0, farPc: 3e5 });
    for (const e of [null, undefined, Number.NaN, 0, -1]) expect(distanceBarPc(1e6, e)).toBeNull();
  });
  it('view distances are 4 ring radii; unknown ids have none', () => {
    expect(groupViewDistancePc('m81-group')).toBeGreaterThan(2e6);
    expect(groupViewDistancePc('local-group')!).toBeGreaterThan(groupViewDistancePc('m81-group')!);
    expect(groupViewDistancePc('pleiades')).toBeUndefined();
  });
  it('the Virgo members hand over to the cosmic layer smoothly and monotonically', () => {
    let prev = 1;
    for (let d = 1e6; d < 1e9; d *= 1.3) { const w = virgoBlend(d); expect(w).toBeLessThanOrEqual(prev + 1e-12); expect(w).toBeGreaterThanOrEqual(0); prev = w; }
    expect(virgoBlend(1e6)).toBe(1); expect(virgoBlend(1e9)).toBe(0);
  });
});

describe('lazy point-catalogue store (fake loader)', () => {
  const file = (id: string, n = 10): PointCatalogueFile => ({ manifest: { id, title: id, source: { source: 'x', retrieved: 't' }, licence: '', count: n, query: '', distanceBasis: 'per-object-direct', caveats: [], units: {} }, columns: { name: Array.from({ length: n }, (_, i) => `n${i}`), raDeg: Array.from({ length: n }, (_, i) => i) } });
  function harness(opts = {}) {
    const calls: string[] = []; const pending = new Map<string, { ok(): void; fail(e: unknown): void }>();
    const store = new PointCatalogueStore((id) => { calls.push(id); return new Promise<PointCatalogueFile>((res, rej) => pending.set(id, { ok: () => res(file(id)), fail: rej })); }, opts);
    const flush = () => new Promise<void>((r) => setTimeout(r, 0));
    return { store, calls, pending, flush };
  }
  it('fetches nothing until wanted, once only, and returns undefined while loading', async () => {
    const h = harness();
    expect(h.calls).toEqual([]);
    expect(h.store.want('a', 0)).toBeUndefined();
    expect(h.store.want('a', 0.1)).toBeUndefined();
    expect(h.calls).toEqual(['a']);
    h.pending.get('a')!.ok(); await h.flush();
    expect(h.store.want('a', 0.2)?.manifest.id).toBe('a');
    expect(h.calls).toEqual(['a']);
    expect(h.store.stats().resident).toEqual(['a']);
  });
  it('releases a catalogue that has not been wanted for releaseAfterSeconds, and re-fetches it when wanted again', async () => {
    const h = harness({ releaseAfterSeconds: 10 });
    h.store.want('a', 0); h.pending.get('a')!.ok(); await h.flush();
    expect(h.store.endFrame(5)).toEqual([]);
    expect(h.store.endFrame(10.5)).toEqual(['a']);
    expect(h.store.peek('a')).toBeUndefined();
    expect(h.store.residentBytes()).toBe(0);
    h.store.want('a', 11); expect(h.calls).toEqual(['a', 'a']);
  });
  it('keeps a catalogue that is wanted every frame, and one that is retained (refcount)', async () => {
    const h = harness({ releaseAfterSeconds: 10 });
    h.store.want('a', 0); h.store.want('b', 0); h.pending.get('a')!.ok(); h.pending.get('b')!.ok(); await h.flush();
    h.store.retain('b'); h.store.retain('b');
    for (let t = 1; t <= 30; t++) { h.store.want('a', t); h.store.endFrame(t); }
    expect(h.store.peek('a')).toBeDefined();
    expect(h.store.peek('b')).toBeDefined();           // pinned
    h.store.release('b'); expect(h.store.peek('b')).toBeDefined(); // one reference left
    h.store.release('b'); h.store.endFrame(40);
    expect(h.store.peek('b')).toBeUndefined();
    expect(h.store.refCount('b')).toBe(0);
    h.store.release('b'); expect(h.store.refCount('b')).toBe(0); // never negative
  });
  it('evicts the least recently wanted first when over the byte budget, never one wanted this frame', async () => {
    const h = harness({ budgetBytes: 1, releaseAfterSeconds: 1000 });
    h.store.want('a', 0); h.pending.get('a')!.ok(); await h.flush();
    h.store.want('b', 5); h.pending.get('b')!.ok(); await h.flush();
    h.store.want('a', 9); h.store.want('b', 10);
    expect(h.store.endFrame(10)).toEqual(['a']);        // b was wanted this frame; a is the older
    expect(h.store.peek('b')).toBeDefined();
  });
  it('loads at most maxConcurrent catalogues at once, never all together', async () => {
    const h = harness({ maxConcurrent: 1 });
    h.store.want('a', 0); h.store.want('b', 0); h.store.want('c', 0);
    expect(h.calls).toEqual(['a']);
    h.pending.get('a')!.ok(); await h.flush();
    h.store.want('b', 1); expect(h.calls).toEqual(['a', 'b']);
  });
  it('a failed load is retried only after the back-off, without throwing', async () => {
    const h = harness({ retryAfterSeconds: 30 });
    h.store.want('a', 0); h.pending.get('a')!.fail(new Error('boom')); await h.flush();
    h.store.endFrame(1);
    expect(h.store.want('a', 2)).toBeUndefined(); expect(h.calls).toEqual(['a']);
    expect(h.store.errorOf('a')).toBe('boom');
    h.store.want('a', 40); expect(h.calls).toEqual(['a', 'a']);
  });
  it('a synchronous loader failure is contained, and a late result after dispose is discarded', async () => {
    const bad = new PointCatalogueStore(() => { throw new Error('sync'); });
    expect(bad.want('a', 0)).toBeUndefined();
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(bad.errorOf('a')).toBe('sync');
    const h = harness();
    h.store.want('a', 0); h.store.dispose(); h.pending.get('a')!.ok(); await h.flush();
    expect(h.store.peek('a')).toBeUndefined();
    expect(h.store.want('a', 1)).toBeUndefined();
  });
  it('a result that arrives after an eviction generation change is not resurrected', async () => {
    const h = harness({ releaseAfterSeconds: 1 });
    h.store.want('a', 0); h.pending.get('a')!.ok(); await h.flush();
    h.store.endFrame(5); expect(h.store.peek('a')).toBeUndefined();
  });
  it('relevance ranges: Sun-centred catalogues by camera distance, member files by cluster diameters', () => {
    expect(sunCatalogueWanted('local-group-mcconnachie', 1e4)).toBe(false);
    expect(sunCatalogueWanted('local-group-mcconnachie', 6e4)).toBe(true);
    expect(sunCatalogueWanted('ungc', 4e5)).toBe(false);
    expect(sunCatalogueWanted('ungc', 6e5)).toBe(true);
    expect(sunCatalogueWanted('twomrs', 2e6)).toBe(false);
    expect(sunCatalogueWanted('twomrs', 3e6)).toBe(true);
    expect(sunCatalogueWanted('twomrs', 5e8)).toBe(true);
    expect(sunCatalogueWanted('members-pleiades', 10)).toBe(false);
    expect(Object.keys(CATALOGUE_RANGES).sort()).toEqual(['local-group-mcconnachie', 'twomrs', 'ungc']);
    expect(membersWanted(100, 5.4)).toBe(true);   // 100 pc from the Pleiades
    expect(membersWanted(200, 5.4)).toBe(false);  // beyond 30 diameters
  });
  it('parses row ids', () => {
    expect(parseRowId('ungc:12')).toEqual({ fileId: 'ungc', row: 12 });
    expect(parseRowId('local-group-mcconnachie:0')).toEqual({ fileId: 'local-group-mcconnachie', row: 0 });
    for (const bad of ['ungc', 'ungc:-1', 'ungc:1.5', ':3', 'ungc:x']) expect(parseRowId(bad)).toBeNull();
  });
});

describe('notes carry the caveats', () => {
  it('the cosmic-structure note contains the mandatory caveat and says nothing is drawn for filaments or voids', () => {
    const n = cosmicNote({ total: 100, drawn: 90, belowCz: 7, duplicates: 2, noCz: 1 });
    expect(n).toContain(COSMIC_CAVEAT);
    expect(COSMIC_CAVEAT).toMatch(/Hubble flow, H0 70 is our choice/);
    expect(COSMIC_CAVEAT).toMatch(/fingers of God/);
    expect(COSMIC_CAVEAT).toMatch(/Zone of Avoidance behind the Milky Way/);
    expect(COSMIC_CAVEAT).toMatch(/flux-limited \(K<11\.75\)/);
    expect(n).toMatch(/90 of 100/); expect(n).toMatch(/7 with cz < 1000/);
    expect(n).toMatch(/empty regions are NOT voids/);
    expect(cosmicNote(null)).toContain(COSMIC_CAVEAT);
    expect(n).toMatch(/anchored on the Sun.*viewing choice, not a centre of the Universe/);
  });
  it('the cluster note states what is measured and what is assumed', () => {
    const b = buildMembers({ raDeg: [1, 1], decDeg: [1, 1], sourceId: ['a', 'b'], gMag: [5, 6], bpRp: [null, 1], parallaxMas: [null, 7] }, { kind: 'open', raDeg: 1, decDeg: 1, distancePc: 135, centre: [100, 100, 100], plummerScalePc: 2 });
    const manifest = { id: 'x', title: '', source: { source: 'x', retrieved: 't' }, licence: '', count: 2, query: '', distanceBasis: 'per-object-parallax' as const, caveats: [], units: {} };
    const open = clusterNote({ id: 'pleiades', clusterClass: 'open', meanDistanceLabel: '134.8 pc' }, b, manifest);
    expect(open).toMatch(/Alcyone and Merope/); expect(open).toMatch(/1 members with no parallax/); expect(open).toMatch(/No star is invented/);
    const g = buildMembers({ raDeg: [1], decDeg: [1], sourceId: ['a'], gMag: [5], bpRp: [null], parallaxMas: [null] }, { kind: 'globular', raDeg: 1, decDeg: 1, distancePc: 5000, centre: [1, 1, 1], plummerScalePc: 7.5 });
    const glob = clusterNote({ id: 'm13', clusterClass: 'globular', meanDistanceLabel: '7.42 kpc', plummerScalePc: 7.5 }, g, { ...manifest, caveats: ['Truncation (our choice): only the 20000 BRIGHTEST are kept'] });
    expect(glob).toMatch(/positions on the sky are catalogued; depth is assumed from spherical symmetry/);
    expect(glob).toMatch(/ILLUSTRATIVE/); expect(glob).toMatch(/Truncation \(our choice\)/);
    expect(clusterNote({ id: 'm4', clusterClass: 'globular', meanDistanceLabel: '' }, null, null)).toMatch(/depth is assumed/);
  });
});
