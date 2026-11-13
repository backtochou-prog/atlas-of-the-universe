import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { sphericalToCartesian } from '../src/core/astro/coordinates';
import { DeepSpaceData } from '../src/data/deepspace';
import type { DeepSpaceFile, PointCatalogueFile } from '../src/data/deepspace/types';
import { buildDuplicateIndex, buildMembers, GROUP_EXTENT_PC, hubbleDistancePc, isImageGalaxyDuplicate, maxDistanceFrom, midpoint } from '../src/render/deep-space/clusterGeometry';
import { COSMIC_CAVEAT, COSMIC_STRUCTURE_ID, CosmicStructureRenderer } from '../src/render/deep-space/CosmicStructureRenderer';
import { GalaxyClusterRenderer } from '../src/render/deep-space/GalaxyClusterRenderer';
import { PointCatalogueStore } from '../src/render/deep-space/pointCatalogues';
import { StarClusterRenderer } from '../src/render/deep-space/StarClusterRenderer';
import type { DeepRenderContext } from '../src/render/deep-space/types';
import { cameraBasis, FOV_DEG } from '../src/render/orbitCamera';

const haveAll = existsSync('public/data/deep-space.v1.json') && ['twomrs', 'ungc', 'local-group-mcconnachie', 'members-pleiades', 'members-hyades', 'members-m13'].every((f) => existsSync(`public/data/deepspace/${f}.v1.json.gz`));
const d = describe.skipIf(!haveAll);

const readCat = (id: string): PointCatalogueFile => JSON.parse(gunzipSync(readFileSync(`public/data/deepspace/${id}.v1.json.gz`)).toString()) as PointCatalogueFile;
const num = (c: readonly (number | string | null)[], i: number) => c[i] as number;

d('structure renderers on the real catalogues', () => {
  const file = JSON.parse(readFileSync('public/data/deep-space.v1.json', 'utf8')) as DeepSpaceFile;
  const data = DeepSpaceData.fromFile(file, [], { validate: false });
  const dupIdx = buildDuplicateIndex(data.byKind('galaxy').map((o) => ({ designations: o.designations, name: o.name, ...(o.sky ? { raDeg: o.sky.raDeg, decDeg: o.sky.decDeg } : {}) })));

  const makeStore = () => {
    const loaded: string[] = [];
    const store = new PointCatalogueStore(async (id) => { loaded.push(id); return readCat(id); }, { releaseAfterSeconds: 20 });
    return { store, loaded };
  };
  const flush = () => new Promise<void>((r) => setTimeout(r, 5));
  const PPR = 700 / (2 * Math.tan((FOV_DEG * Math.PI) / 360));
  const ctxAt = (camPc: [number, number, number], target: readonly [number, number, number], now: number, selectedId: string | null = null): DeepRenderContext => {
    const camera = new THREE.PerspectiveCamera(FOV_DEG, 1100 / 700, 1e-3, 1e11);
    const v = [target[0] - camPc[0], target[1] - camPc[1], target[2] - camPc[2]];
    const r = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
    const yaw = Math.atan2(-v[1]! / r, -v[0]! / r) + Math.PI, pitch = -Math.asin(-v[2]! / r) * -1;
    void yaw; void pitch;
    // look along `v`: the basis forward must equal v/r
    const basis = lookBasis([v[0]! / r, v[1]! / r, v[2]! / r]);
    return { camera, camPc, basis, viewport: { width: 1100, height: 700 }, pixelRatio: 1, focusDistancePc: r, pixelsPerRadian: PPR, nowSeconds: now, selectedId, quality: 1, farFade: 1 };
  };
  function lookBasis(f: [number, number, number]) {
    const up0: [number, number, number] = Math.abs(f[2]) > 0.95 ? [1, 0, 0] : [0, 0, 1];
    const rx = f[1] * up0[2] - f[2] * up0[1], ry = f[2] * up0[0] - f[0] * up0[2], rz = f[0] * up0[1] - f[1] * up0[0];
    const rl = Math.hypot(rx, ry, rz); const right: [number, number, number] = [rx / rl, ry / rl, rz / rl];
    const up: [number, number, number] = [right[1] * f[2] - right[2] * f[1], right[2] * f[0] - right[0] * f[2], right[0] * f[1] - right[1] * f[0]];
    return { right, up, forward: f } as ReturnType<typeof cameraBasis>;
  }

  it('Pleiades and Hyades member distances agree with the catalogued mean distance (median of 1000/parallax within 5%)', () => {
    for (const [id, tol] of [['pleiades', 0.02], ['hyades', 0.05]] as const) {
      const o = data.get(id)!, cat = readCat(`members-${id}`);
      const mean = o.sky!.distance!.value; // pc
      const plx = (cat.columns['parallaxMas'] as (number | null)[]).filter((p): p is number => p !== null && p > 0).map((p) => 1000 / p).sort((a, b) => a - b);
      const median = plx[Math.floor(plx.length / 2)]!;
      expect(Math.abs(median - mean) / mean).toBeLessThan(tol);
      const centre = data.positionPc(id)!;
      const c = cat.columns as Record<string, (number | string | null)[]>;
      const b = buildMembers({ raDeg: c['raDeg']!, decDeg: c['decDeg']!, sourceId: c['sourceId']!, gMag: c['gMag']!, bpRp: c['bpRp']!, parallaxMas: c['parallaxMas']!, parallaxErrMas: c['parallaxErrMas'] }, { kind: 'open', raDeg: o.sky!.raDeg, decDeg: o.sky!.decDeg, distancePc: mean, centre, plummerScalePc: 3 });
      expect(b.count).toBe(cat.manifest.count);
      expect(b.stats.placedByParallax + b.stats.meanNoParallax + b.stats.meanNonPositiveParallax).toBe(b.count);
      // the 3D positions reproduce the catalogued distances
      // the placed 3D distances reproduce the catalogued distance (median: the Hyades have long tidal tails that pull the mean out)
      const dist: number[] = [];
      for (let k = 0; k < b.count; k++) dist.push(Math.hypot(centre[0] + b.offset[3 * k]!, centre[1] + b.offset[3 * k + 1]!, centre[2] + b.offset[3 * k + 2]!));
      dist.sort((x, y) => x - y);
      expect(Math.abs(dist[Math.floor(dist.length / 2)]! - mean) / mean).toBeLessThan(tol);
    }
  });

  it('the globular catalogue keeps the cluster centred at the catalogued distance (depth offsets are symmetric)', () => {
    const o = data.get('m13')!, cat = readCat('members-m13'), c = cat.columns as Record<string, (number | string | null)[]>;
    const centre = data.positionPc('m13')!, mean = o.sky!.distance!.value * 1000;
    const b = buildMembers({ raDeg: c['raDeg']!, decDeg: c['decDeg']!, sourceId: c['sourceId']!, gMag: c['gMag']!, bpRp: c['bpRp']!, parallaxMas: c['parallaxMas']! }, { kind: 'globular', raDeg: o.sky!.raDeg, decDeg: o.sky!.decDeg, distancePc: mean, centre, plummerScalePc: o.measurements['halfLightRadiusProjected']!.value });
    const los = centre.map((x) => x / Math.hypot(...centre));
    const z: number[] = [];
    for (let k = 0; k < b.count; k++) z.push(b.offset[3 * k]! * los[0]! + b.offset[3 * k + 1]! * los[1]! + b.offset[3 * k + 2]! * los[2]!);
    z.sort((a, b2) => a - b2);
    expect(Math.abs(z[Math.floor(z.length / 2)]!)).toBeLessThan(0.5);   // median depth offset ~ 0 pc
    expect(b.stats.assumedDepth).toBe(b.count);
  });

  it('GROUP_EXTENT_PC equals the farthest member of each group in the data (so it cannot drift)', () => {
    const lg = readCat('local-group-mcconnachie').columns, un = readCat('ungc').columns, tm = readCat('twomrs').columns;
    const mw = data.positionPc('milky-way')!, m31 = data.positionPc('m31')!;
    const lgPts = (lg['raDeg'] as number[]).map((r, i) => sphericalToCartesian(r, num(lg['decDeg']!, i), num(lg['distMpc']!, i) * 1e6));
    expect(maxDistanceFrom(midpoint(mw, m31), lgPts)).toBeCloseTo(GROUP_EXTENT_PC['local-group']!, -2);
    const m81 = new Set(data.get('m81-group')!.membership!.names);
    const m81Pts = (un['name'] as string[]).flatMap((n, i) => (m81.has(n) ? [sphericalToCartesian(num(un['raDeg']!, i), num(un['decDeg']!, i), num(un['distMpc']!, i) * 1e6)] : []));
    expect(m81Pts.length).toBe(36);
    expect(maxDistanceFrom(data.positionPc('m81-group')!, m81Pts)).toBeCloseTo(GROUP_EXTENT_PC['m81-group']!, -2);
    const vn = new Set(data.get('virgo-cluster')!.membership!.names), dV = data.get('virgo-cluster')!.sky!.distance!.value * 1e6;
    const vPts = (tm['name'] as string[]).flatMap((n, i) => (vn.has(n) ? [sphericalToCartesian(num(tm['raDeg']!, i), num(tm['decDeg']!, i), dV)] : []));
    expect(vPts.length).toBe(203);   // -500 <= cz <= 2500 km/s within 6 deg of M87
    expect(maxDistanceFrom(data.positionPc('virgo-cluster')!, vPts)).toBeCloseTo(GROUP_EXTENT_PC['virgo-cluster']!, -2);
  });

  it('duplicate skipping removes exactly the image galaxies from each file (documented list)', () => {
    const skipped = (id: string) => { const c = readCat(id).columns; return (c['name'] as string[]).filter((n, i) => isImageGalaxyDuplicate(dupIdx, id === 'twomrs' ? null : n, num(c['raDeg']!, i), num(c['decDeg']!, i))); };
    expect(skipped('local-group-mcconnachie').sort()).toEqual(['Andromeda', 'LMC', 'M32', 'SMC', 'Triangulum']);
    expect(skipped('ungc').sort()).toEqual(['LMC', 'MESSIER031', 'MESSIER032', 'MESSIER033', 'MESSIER081', 'Milky Way', 'NGC4594', 'NGC5128', 'SMC']);
    expect(skipped('twomrs').sort()).toEqual(['00424182+4051546', '00424433+4116074', '01335090+3039357', '09553318+6903549', '12304942+1223279', '12395949-1137230', '13252775-4301073']);
  });

  it('StarClusterRenderer: nothing is fetched while far; members of one cluster load when near, appear after the load, and are released when far', async () => {
    const { store, loaded } = makeStore();
    const r = new StarClusterRenderer(data, store);
    const pl = data.positionPc('pleiades')!;
    // far away (1 Mpc): no member catalogue wanted
    r.update(ctxAt([1e6, 0, 0], pl, 1)); store.endFrame(1);
    expect(loaded).toEqual([]);
    // 20 pc from the Pleiades
    const near: [number, number, number] = [pl[0] + 12, pl[1] + 12, pl[2] + 10];
    let screen = r.update(ctxAt(near, pl, 2));
    expect(screen.find((i) => i.id === 'pleiades')!.lod).toMatch(/loading|glow|marker/);
    expect(loaded).toContain('members-pleiades');   // the Hyades are within range from here too (30 diameters), the globular clusters are not
    expect(loaded.filter((f) => /m13|m4|omega|tucanae/.test(f))).toEqual([]);
    await flush();
    screen = r.update(ctxAt(near, pl, 3));
    const info = screen.find((i) => i.id === 'pleiades')!;
    expect(info.kind).toBe('star-cluster');
    expect(info.lod).toBe('members');
    expect(info.representationNote).toMatch(/1721 real Gaia members/);
    expect(info.representationNote).toMatch(/Alcyone and Merope/);
    expect(r.membersResident('pleiades')).toBe(true);
    expect(r.caveats('pleiades')!.length).toBeGreaterThan(2);
    expect(r.stats().drawCalls).toBeGreaterThanOrEqual(2);       // members + the shared marker/glow draw
    expect(r.viewDistancePc('pleiades')).toBeCloseTo(3 * 5.393 / 2, 1);
    expect(r.viewDistancePc('m13')).toBeCloseTo(3 * 6.432 / 2, 0);
    expect(r.viewDistancePc('local-group')).toBeUndefined();
    // far for longer than the release time: arrays dropped
    r.update(ctxAt([1e6, 0, 0], pl, 30)); store.endFrame(30);
    r.update(ctxAt([1e6, 0, 0], pl, 31));
    expect(r.membersResident('pleiades')).toBe(false);
    r.dispose();
  });

  it('the globular note names the assumed depth and the truncation, from the manifest', async () => {
    const { store } = makeStore();
    const r = new StarClusterRenderer(data, store);
    const m13 = data.positionPc('m13')!;
    const near: [number, number, number] = [m13[0] + 8, m13[1] + 5, m13[2] + 5];
    r.update(ctxAt(near, m13, 1)); await flush();
    const info = r.update(ctxAt(near, m13, 2)).find((i) => i.id === 'm13')!;
    expect(info.representationNote).toMatch(/positions on the sky are catalogued; depth is assumed from spherical symmetry/);
    expect(info.representationNote).toMatch(/Truncation \(our choice\)/);
    r.dispose();
  });

  it('GalaxyClusterRenderer: lazy rows, no image duplicates, pickable ids, pointRow round trip, bar only with a published error', async () => {
    const { store, loaded } = makeStore();
    const r = new GalaxyClusterRenderer(data, store);
    const cam: [number, number, number] = [1.2e7, 3e6, 4e6];
    const target = r.positionPc('local-group')!;
    r.update(ctxAt([0, 0, 1e4], target, 1));
    expect(loaded).toEqual([]);                       // near the Sun: nothing requested
    r.update(ctxAt(cam, target, 2)); await flush(); await flush();
    expect(loaded.sort()).toEqual(['local-group-mcconnachie', 'ungc']);   // not twomrs unless near Virgo
    let screen = r.update(ctxAt(cam, target, 3));
    const counts = r.rowCounts();
    expect(counts.lg).toBe(96);                       // 101 rows - Andromeda, M32, LMC, SMC, Triangulum
    expect(counts.skipped['lg']!.imageDuplicates).toBe(5);
    expect(counts.skipped['ungc']!.imageDuplicates).toBe(9);
    expect(counts.skipped['ungc']!.crossCatalogue).toBeGreaterThan(60); // McConnachie rows repeated in the UNGC
    expect(counts.lg + counts.ungc + counts.skipped['ungc']!.crossCatalogue + 9 + 5).toBe(101 + 869);
    // group infos with an illustrative-boundary note
    const lgInfo = screen.find((i) => i.id === 'local-group')!;
    expect(lgInfo.kind).toBe('galaxy-group');
    expect(lgInfo.representationNote).toMatch(/ILLUSTRATIVE boundary/);
    expect(screen.find((i) => i.id === 'virgo-cluster')!.kind).toBe('galaxy-cluster');
    expect(r.viewDistancePc('local-group')).toBeGreaterThan(1e7);
    expect(r.positionPc('local-group')).toBeDefined();
    // pickable catalogue rows
    const pts = screen.filter((i) => i.kind === 'catalogue-point');
    expect(pts.length).toBeGreaterThan(100);
    for (const p of pts.slice(0, 50)) {
      const row = r.pointRow(p.id)!;
      expect(row.id).toBe(p.id);
      expect(String(row.values['name'])).toBe(p.label);
      expect(row.manifest.id).toBe(row.fileId);
      expect(Object.keys(row.values)).toEqual(Object.keys(readCat(row.fileId).columns));
    }
    expect(r.pointRow('ungc:99999')).toBeUndefined();
    expect(r.pointRow('twomrs:3')).toBeUndefined(); expect(r.pointRow('virgo:3')).toBeUndefined();   // Virgo rows only once twomrs is loaded
    expect(r.pointRow('pleiades')).toBeUndefined();
    // line-of-sight bar: a TRGB galaxy with a published error vs a row with none
    const un = readCat('ungc').columns;
    const withErr = (un['name'] as string[]).indexOf('HolmII'), noErr = (un['name'] as string[]).indexOf('[CKT2009]d0926+70');
    const bar = () => r.group.children.find((c) => c.name === 'distance-uncertainty-bar')!.visible;
    r.update(ctxAt(cam, target, 4, `ungc:${withErr}`)); expect(bar()).toBe(true);
    const note = r.update(ctxAt(cam, target, 5, `ungc:${noErr}`)).find((i) => i.id === `ungc:${noErr}`);
    expect(bar()).toBe(false);
    if (note) expect(note.representationNote).toMatch(/no published error/);
    // method that is not independent says so
    const mem = (un['distMethod'] as string[]).indexOf('mem');
    const memInfo = r.update(ctxAt(cam, target, 6)).find((i) => i.id === `ungc:${mem}`);
    if (memInfo) expect(memInfo.representationNote).toMatch(/NOT an independent distance measurement/);
    r.dispose();
  });

  it('GalaxyClusterRenderer: the Virgo rows are the listed members, drawn at the cluster-mean distance, with their own "virgo:" ids', async () => {
    const { store } = makeStore();
    const r = new GalaxyClusterRenderer(data, store);
    const v = r.positionPc('virgo-cluster')!;
    const cam: [number, number, number] = [v[0] * 0.8, v[1] * 0.8, v[2] * 0.8 + 3e6];
    // the three catalogues load one or two at a time (maxConcurrent), so drive a few frames
    let screen = r.update(ctxAt(cam, v, 1));
    for (let t = 2; t < 8; t++) { await flush(); screen = r.update(ctxAt(cam, v, t)); }
    expect(r.rowCounts().virgo).toBe(202);            // 203 listed rows minus M87, which is drawn from its image
    const virgoRows = screen.filter((i) => i.id.startsWith('virgo:'));
    expect(screen.filter((i) => i.id.startsWith('twomrs:'))).toHaveLength(0);   // the 2MRS cloud ids are a different namespace
    expect(virgoRows.length).toBeGreaterThan(50);
    expect(virgoRows[0]!.representationNote).toMatch(/cluster-mean distance 16\.5 Mpc, NOT at its own redshift distance/);
    expect(r.pointRow(virgoRows[0]!.id)!.fileId).toBe('twomrs');     // the data file the row comes from
    expect(r.pointRow(virgoRows[0]!.id)!.placement).toBe('cluster-mean');
    expect(r.pointRow(virgoRows[0]!.id.replace('virgo:', 'twomrs:'))).toBeUndefined();   // the cloud id does not resolve to a Virgo marker
    expect(new Set(virgoRows.map((i) => i.id)).size).toBe(virgoRows.length);
    r.dispose();
  });

  it('CosmicStructureRenderer: counts add up, cz < 1000 rows are not placed, caveat is in the note, <= 300 pickable ids, one draw, no lines', async () => {
    const { store, loaded } = makeStore();
    const r = new CosmicStructureRenderer(data, store);
    r.update(ctxAt([0, 0, 1e5], [0, 0, 0], 1)); expect(loaded).toEqual([]);   // inside 3 Mpc: nothing requested
    const cam: [number, number, number] = [1e8, 2e7, 3e7];
    r.update(ctxAt(cam, [0, 0, 0], 2)); await flush();
    const screen = r.update(ctxAt(cam, [0, 0, 0], 3));
    const c = r.counts()!;
    expect(loaded).toEqual(['twomrs']);
    expect(c.total).toBe(43533);
    expect(c.drawn + c.belowCz + c.duplicates + c.noCz).toBeLessThanOrEqual(c.total);
    const cz = readCat('twomrs').columns['czKms'] as (number | null)[];
    expect(c.belowCz).toBe(cz.filter((z) => z !== null && z < 1000).length);
    expect(c.drawn).toBeGreaterThan(40000);
    expect(c.duplicates).toBe(2);                     // M87 and M104 (the other image galaxies have cz < 1000 and are counted there)
    const s = screen.find((i) => i.id === COSMIC_STRUCTURE_ID)!;
    expect(s.kind).toBe('cosmic-structure');
    expect(s.representationNote).toContain(COSMIC_CAVEAT);
    expect(s.representationNote).toMatch(new RegExp(`${c.belowCz} with cz < 1000`));
    const picks = screen.filter((i) => i.kind === 'catalogue-point');
    expect(picks.length).toBeGreaterThan(0); expect(picks.length).toBeLessThanOrEqual(300);
    for (const p of picks.slice(0, 20)) { const row = r.pointRow(p.id)!; expect(row.fileId).toBe('twomrs'); expect(row.values['czKms']).toBeGreaterThanOrEqual(1000); }
    expect(r.stats().drawCalls).toBe(1);
    expect(r.group.children.every((o) => o instanceof THREE.Points)).toBe(true);   // no filaments, voids or surfaces
    // a pure rotation does not rebuild the camera-relative buffer; a large move does
    const rebuilds = r.rebuilds;
    r.update(ctxAt(cam, [1e8, 0, 0], 4)); expect(r.rebuilds).toBe(rebuilds);
    r.update(ctxAt([cam[0] * 1.5, cam[1], cam[2]], [0, 0, 0], 5)); expect(r.rebuilds).toBe(rebuilds + 1);
    // the distances used are cz / 70
    const rowSample = picks[0]!; const rv = r.pointRow(rowSample.id)!.values;
    expect(hubbleDistancePc(rv['czKms'] as number)).toBeCloseTo(((rv['czKms'] as number) / 70) * 1e6, 3);
    r.dispose();
  });

  it('CosmicStructureRenderer: quality cuts the drawn points; the layer fade hides it near the Sun', async () => {
    const { store } = makeStore();
    const r = new CosmicStructureRenderer(data, store);
    const cam: [number, number, number] = [1e8, 2e7, 3e7];
    r.update(ctxAt(cam, [0, 0, 0], 1)); await flush();
    r.update(ctxAt(cam, [0, 0, 0], 2));
    const full = r.stats().pointsDrawn;
    const low = { ...ctxAt(cam, [0, 0, 0], 3), quality: 0.25 };
    r.update(low);
    expect(r.stats().pointsDrawn).toBeLessThan(full * 0.5);
    r.update({ ...ctxAt(cam, [0, 0, 0], 4), farFade: 0 });
    expect(r.stats().drawCalls).toBe(0);
    r.dispose();
  });
});
