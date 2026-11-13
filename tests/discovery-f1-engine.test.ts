/**
 * F1 integration fixes, engine side, on the REAL datasets (engine on the calling thread):
 *  - catalogue rows that are the same galaxy as a curated one are merged (one search result: the curated record);
 *  - search ranking for the named objects of the brief;
 *  - nearby() keeps the origin's own planetary system out of the neighbours (returned as `system`);
 *  - Betelgeuse is in nearby()/the KD tree, Alnilam is searchable but cannot be placed in 3D;
 *  - atlas.parent() with exclude / fallback (one history).
 * Plus pure tests of the shared duplicate rule and SearchIndex.extend.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { DiscoveryAtlas, InlineEngineClient, type AtlasViewerPort } from '../src/discovery/atlas';
import { buildDuplicateIndex, findImageGalaxyDuplicate, isImageGalaxyDuplicate, normaliseDesignation } from '../src/discovery/duplicates';
import { mergePointDuplicates } from '../src/discovery/pointMerge';
import { SearchIndex } from '../src/discovery/searchIndex';
import type { CameraSnapshot, FocusPlan } from '../src/discovery/navigation';
import type { DiscoveryRecord, UniversalId } from '../src/discovery/types';
import type { SolarBodyOffset } from '../src/discovery/engineApi';
import { MemoryAdapter } from '../src/discovery/saved';
import { NO_DISTANCE_REASON, ViewerNavigationHost, type HostViewer, type Placement } from '../src/render/discovery/ViewerNavigationHost';
import type { Vec3 } from '../src/core/spatial/vec3';
import { have, loadGaia } from './fixtures/discovery/real';
import { FileDataSource } from './fixtures/discovery/source';

const rec = (id: string, name: string, designations: string[], over: Partial<DiscoveryRecord> = {}): DiscoveryRecord => ({
  id, dataset: 'deep-space', category: 'galaxy', name, designations, classification: 'Galaxy', position: { kind: 'icrs', xyzPc: [1e6, 0, 0], raDeg: 10.68, decDeg: 41.27 },
  measurements: {}, drawn: true, sourceKey: 'deep-space', ...over,
});
const row = (id: string, name: string, ra: number, dec: number, ds: DiscoveryRecord['dataset'] = 'local-group-mcconnachie'): DiscoveryRecord =>
  rec(id, name, [name], { dataset: ds, position: { kind: 'icrs', xyzPc: [7e5, 0, 0], raDeg: ra, decDeg: dec }, sourceKey: ds });

describe('the shared duplicate rule (src/discovery/duplicates.ts)', () => {
  const idx = buildDuplicateIndex([
    { id: 'deep:m31', name: 'Andromeda Galaxy (M31)', designations: ['M 31', 'NGC 224'], raDeg: 10.6847, decDeg: 41.2688 },
    { id: 'deep:lmc', name: 'Large Magellanic Cloud', designations: ['LMC'], raDeg: 80.894, decDeg: -69.756 },
  ]);
  it('names (normalised, aliased) and positions identify the curated object, and say WHICH one', () => {
    expect(findImageGalaxyDuplicate(idx, 'Andromeda', 0, 0)).toEqual({ id: 'deep:m31' });
    expect(findImageGalaxyDuplicate(idx, 'NGC0224', 0, 0)).toEqual({ id: 'deep:m31' });
    expect(findImageGalaxyDuplicate(idx, 'MESSIER031', 0, 0)).toEqual({ id: 'deep:m31' });
    expect(findImageGalaxyDuplicate(idx, 'LMC', 0, 0)).toEqual({ id: 'deep:lmc' });
    expect(findImageGalaxyDuplicate(idx, null, 80.8945, -69.7561)).toEqual({ id: 'deep:lmc' });
    expect(findImageGalaxyDuplicate(idx, 'Andromeda IX', 13.2, 43.2)).toBeNull();
    expect(findImageGalaxyDuplicate(idx, null, 10.68, 41.0)).toBeNull();              // 0.27 deg away: not a position match
    expect(isImageGalaxyDuplicate(idx, 'M 31', 0, 0)).toBe(true);
    expect(normaliseDesignation('NGC 0224')).toBe('NGC224');
  });
});

describe('mergePointDuplicates and SearchIndex.extend (synthetic)', () => {
  const curated = [rec('deep:m31', 'Andromeda Galaxy (M31)', ['Andromeda Galaxy (M31)', 'M 31', 'NGC 224'], { position: { kind: 'icrs', xyzPc: [7.6e5, 0, 0], raDeg: 10.6847, decDeg: 41.2688 } }), rec('deep:other', 'Other', ['Other'], { category: 'nebula' })];
  const points = [row('point:mcc:1', 'Andromeda', 10.68458, 41.26917), row('point:mcc:2', 'Andromeda IX', 13.22, 43.2), row('point:ungc:7', 'NGC0224', 10.68, 41.27, 'ungc')];
  it('rows that are the curated galaxy are dropped and aliased; the curated record keeps their names as extra designations and lists them in sameAs', () => {
    const r = mergePointDuplicates(curated, points);
    expect(r.kept.map((p) => p.id)).toEqual(['point:mcc:2']);
    expect([...r.aliases]).toEqual([['point:mcc:1', 'deep:m31'], ['point:ungc:7', 'deep:m31']]);
    const m31 = r.updated.get('deep:m31')!;
    expect(m31.designations.slice(0, 3)).toEqual(['Andromeda Galaxy (M31)', 'M 31', 'NGC 224']);
    expect(m31.designations).toContain('Andromeda');
    expect(m31.designations.filter((d) => normaliseDesignation(d) === 'NGC224')).toHaveLength(1);   // 'NGC0224' repeats 'NGC 224': not added twice
    expect(m31.sameAs).toEqual(['point:mcc:1', 'point:ungc:7']);
    expect(r.updated.has('deep:other')).toBe(false);
  });
  it('only galaxies are merged, and only into curated GALAXIES', () => {
    const star = rec('gaia:1', 'Andromeda', ['Andromeda'], { category: 'star', dataset: 'gaia-dr3' });
    expect(mergePointDuplicates(curated, [star]).kept).toHaveLength(1);
    expect(mergePointDuplicates([rec('deep:neb', 'Andromeda', ['Andromeda'], { category: 'nebula' })], points).aliases.size).toBe(0);
  });
  it('SearchIndex.extend makes the new designations searchable on the SAME record and keeps the old ones', () => {
    const idx = new SearchIndex();
    idx.add(curated);
    expect(idx.search('Andromeda').hits[0]!.id).toBe('deep:m31');
    expect(idx.search('Triangulum').hits).toHaveLength(0);
    const r = mergePointDuplicates(curated, [...points, row('point:mcc:3', 'Triangulum', 1, 2)]);   // not a duplicate here: nothing to extend
    expect(r.aliases.has('point:mcc:3')).toBe(false);
    const upd = r.updated.get('deep:m31')!;
    const withTri = { ...upd, designations: [...upd.designations, 'Triangulum'] };
    expect(idx.extend(withTri)).toBe(withTri.designations.length - curated[0]!.designations.length);
    expect(idx.search('Triangulum').hits[0]!.id).toBe('deep:m31');
    expect(idx.search('NGC 224').hits[0]!.id).toBe('deep:m31');
    expect(idx.get('deep:m31')!.designations).toContain('Triangulum');
    expect(idx.size).toBe(2);
    expect(idx.extend(rec('deep:m31', 'Different name', ['x']))).toBe(0);           // not an extension of the old record
    expect(idx.extend(rec('deep:unknown', 'x', ['x']))).toBe(0);
  });
});

const NEED = ['gaia-dr3-subset.v1.json.gz', 'simbad-crossid.v1.json.gz', 'solar-system.v1.json', 'deep-space.v1.json', 'deepspace/ungc.v1.json.gz', 'deepspace/local-group-mcconnachie.v1.json.gz', 'deepspace/twomrs.v1.json.gz', 'bright-stars.v1.json.gz', 'exoplanets.v1.json.gz', 'other-objects.v1.json', 'discovery-notes.v1.json', 'relations.v1.json'];
const missing = NEED.filter((f) => !have(f));

class FakeHost implements AtlasViewerPort {
  plans: FocusPlan[] = [];
  cam: CameraSnapshot = { frame: 'stellar-neighbourhood', focus: [0, 0, 0], distance: 60, yaw: 0, pitch: 0 };
  constructor(private readonly resolveRecord: (id: UniversalId) => DiscoveryRecord | undefined) {}
  focus(plan: FocusPlan): void { this.plans.push(plan); }
  snapshot(): CameraSnapshot { return { ...this.cam }; }
  restore(s: CameraSnapshot): void { this.cam = { ...s }; }
  setSelection(): void { /* no-op */ }
  highlight(): void { /* no-op */ }
  currentFrame(): string { return 'stellar-neighbourhood'; }
  resolve(id: UniversalId): DiscoveryRecord | undefined { return this.resolveRecord(id); }
  positionOf(): Vec3 | undefined { return undefined; }
  cameraFocusPc(): Vec3 { return this.cam.focus; }
  cameraView() { return { positionPc: [60, 0, 0] as Vec3, forward: [-1, 0, 0] as Vec3, up: [0, 0, 1] as Vec3, fovYDeg: 50, aspect: 1.5 }; }
  solarBodyOffsets(): readonly SolarBodyOffset[] { return []; }
}

describe.skipIf(missing.length > 0)(`F1 on the real datasets${missing.length ? ` (SKIPPED: missing ${missing.join(', ')})` : ''}`, () => {
  let atlas: DiscoveryAtlas;
  let host: FakeHost;
  beforeAll(async () => {
    atlas = new DiscoveryAtlas({ engine: new InlineEngineClient(new FileDataSource()), notesSource: new FileDataSource(), storage: new MemoryAdapter() });
    host = new FakeHost((id) => atlas.peek(id));
    atlas.attachViewer(host);
    await atlas.start();
  }, 180_000);
  const first = async (q: string): Promise<string | undefined> => (await atlas.search(q, { limit: 5 })).hits[0]?.id;

  it('M31, M33, LMC, SMC, M32, M81, M87, NGC 5128: each common name resolves to ONE exact result, the curated record', async () => {
    const cases: [string, string][] = [
      ['Andromeda', 'deep:m31'], ['Andromeda Galaxy', 'deep:m31'], ['M31', 'deep:m31'], ['NGC 224', 'deep:m31'],
      ['Triangulum', 'deep:m33'], ['M33', 'deep:m33'], ['NGC 598', 'deep:m33'],
      ['Large Magellanic Cloud', 'deep:lmc'], ['LMC', 'deep:lmc'], ['SMC', 'deep:smc'], ['Small Magellanic Cloud', 'deep:smc'],
      ['M32', 'deep:m32'], ['NGC 221', 'deep:m32'], ['M81', 'deep:m81'], ['NGC 3031', 'deep:m81'],
      ['Messier 87', 'deep:m87'], ['M87', 'deep:m87'], ['Virgo A', 'deep:m87'], ['NGC 4486', 'deep:m87'],
      ['Centaurus A', 'deep:cen-a'], ['NGC 5128', 'deep:cen-a'],
    ];
    for (const [q, want] of cases) {
      const r = await atlas.search(q, { limit: 8 });
      expect(r.hits[0]?.id, q).toBe(want);
      const exact = r.hits.filter((h) => h.matchKind === 'exact');
      expect(exact.map((h) => h.id), q).toEqual([want]);                    // no second record answers the same name exactly
      expect(r.hits.filter((h) => h.id.startsWith('point:') && h.matchKind === 'exact'), q).toHaveLength(0);
    }
  });

  it('the merged rows are aliases of the curated record, which keeps their names; points that are different galaxies are untouched', async () => {
    expect(await atlas.resolve('point:local-group-mcconnachie:27')).toBe('deep:m31');
    expect(await atlas.resolve('point:local-group-mcconnachie:52')).toBe('deep:m33');
    expect((await atlas.getRecord('point:local-group-mcconnachie:27'))!.id).toBe('deep:m31');
    const m31 = (await atlas.getRecord('deep:m31'))!;
    expect(m31.designations).toEqual(expect.arrayContaining(['Andromeda', 'M 31', 'NGC 224']));
    expect(m31.sameAs).toContain('point:local-group-mcconnachie:27');
    expect(m31.name).toBe('Andromeda Galaxy (M31)');                         // the curated record wins
    expect(await atlas.resolve('point:local-group-mcconnachie:48')).toBe('point:local-group-mcconnachie:48');   // Andromeda II: a different galaxy
    expect(await first('Andromeda II')).toBe('point:local-group-mcconnachie:48');
    expect(await first('Centaurus A-dE5')).toMatch(/^point:ungc:/);
  });

  it('ranking: the named objects of the brief return the intended record FIRST', async () => {
    const g = loadGaia();
    const someGaia = g.cat.sourceId(1234);
    const trappist = await atlas.resolve('host:TRAPPIST-1');
    const proxima = await atlas.resolve('hip:70890');
    const cases: [string, string | undefined][] = [
      ['Orion Nebula', 'deep:orion-nebula'], ['M42', 'deep:orion-nebula'],
      ['Sagittarius A*', 'other:sgr-a-star'], ['Sgr A*', 'other:sgr-a-star'],
      ['Kepler-452b', 'exo:Kepler-452 b'], ['TRAPPIST-1', trappist], ['Europa', 'solar:europa'], ['Proxima', proxima],
      ['Sirius', 'hip:32349'], ['Betelgeuse', 'hip:27989'], ['HIP 32349', 'hip:32349'], [`Gaia DR3 ${someGaia}`, await atlas.resolve(`gaia:${someGaia}`)],
    ];
    for (const [q, want] of cases) expect(await first(q), q).toBe(want);
    expect(trappist).toMatch(/^gaia:/);
    expect(proxima).toMatch(/^gaia:/);
  });

  it('Alnilam (parallax S/N 3.7) is found by search, is not drawn, and the viewer host says it cannot be placed in 3D; Betelgeuse is placed', async () => {
    const r = await atlas.search('Alnilam');
    expect(r.hits[0]!.id).toBe('hip:26311');
    expect(r.hits[0]!.drawn).toBe(false);
    const alnilam = (await atlas.getRecord('hip:26311'))!;
    expect(alnilam.position.kind).toBe('sky-only');
    const b = await atlas.search('Betelgeuse');
    expect(b.hits[0]!.id).toBe('hip:27989');
    expect(b.hits[0]!.drawn).toBe(true);
    const bet = (await atlas.getRecord('hip:27989'))!;
    expect(bet.position.kind).toBe('icrs');
    expect(bet.measurements.distancePc!.note).toBe('low reliability: parallax S/N < 10');

    // the real ViewerNavigationHost over a minimal viewer double
    const calls: string[] = [];
    const v: HostViewer = {
      state: { focus: [0, 0, 0], distance: 60, yaw: 0, pitch: 0 }, frame: { id: 'stellar-neighbourhood' }, jdTdb: 2460000, brightness: { magLimit: 9 }, viewport: { width: 1200, height: 800 },
      solarData: null, deep: null, deepData: null, viewDistancePc: () => 1, bodyHelioPc: () => [0, 0, 0], flyToBody() {}, flyToDeep() {}, flyToLocalGroup() {},
      flyToPointPc: () => { calls.push('point'); return true; },
      snapshotCamera: () => ({ focus: [0, 0, 0], distance: 60, yaw: 0, pitch: 0, frameId: 'stellar-neighbourhood', followId: null, selectedBody: null, selectedDeep: null }), restoreCamera() {},
      setHighlights() {}, setSelectionProxy() {},
    };
    const navHost = new ViewerNavigationHost(v, (id) => atlas.peek(id));
    const placements: Placement[] = [];
    navHost.onPlacement = (p) => placements.push(p);
    atlas.attachViewer(navHost);
    const sel = await atlas.select('hip:26311', { focus: true });
    expect(sel.ok).toBe(true);
    expect(placements.at(-1)).toMatchObject({ kind: 'inspect-only', id: 'hip:26311', reason: NO_DISTANCE_REASON });
    expect(NO_DISTANCE_REASON).toMatch(/cannot place in 3D/);
    expect(calls).toEqual([]);                                                 // no flight
    await atlas.select('hip:27989', { focus: true });
    expect(placements.at(-1)).toMatchObject({ kind: 'flight', id: 'hip:27989', mode: 'point' });
    expect(calls).toEqual(['point']);
    atlas.attachViewer(host);
  });

  it('Betelgeuse is in the KD tree: nearby() within 200 pc of the Sun lists it; Alnilam (no distance) is never a neighbour', async () => {
    const n = await atlas.nearby({ origin: { positionPc: [0, 0, 0] }, radiusPc: 200, categories: ['star'] });
    expect(n.ok).toBe(true);
    if (!n.ok) return;
    const ids = n.neighbours.map((x) => x.id);
    expect(ids).toContain('hip:27989');
    expect(ids).not.toContain('hip:26311');
    const bet = n.neighbours.find((x) => x.id === 'hip:27989')!;
    expect(bet.distanceMetres / 3.0856775814913673e16).toBeCloseTo(152.67, 1);
  });

  it('nearby(): an exoplanet or a host keeps its own system out of the neighbours; the system is returned separately', async () => {
    const trappist = (await atlas.resolve('host:TRAPPIST-1'))!;
    const fromPlanet = await atlas.nearby({ origin: 'exo:TRAPPIST-1 b', radiusPc: 5 });
    expect(fromPlanet.ok).toBe(true);
    if (!fromPlanet.ok) return;
    const sys = fromPlanet.system!.map((m) => m.id);
    expect(sys).toContain(trappist);
    expect(sys).toContain('exo:TRAPPIST-1 c');
    expect(sys).not.toContain('exo:TRAPPIST-1 b');                            // never the origin itself
    expect(fromPlanet.system!.find((m) => m.id === trappist)!.role).toBe('host');
    expect(fromPlanet.system!.filter((m) => m.role === 'planet')).toHaveLength(6);
    for (const id of sys) expect(fromPlanet.neighbours.map((x) => x.id)).not.toContain(id);
    expect(fromPlanet.neighbours.every((x) => x.distanceMetres > 0)).toBe(true);

    const fromHost = await atlas.nearby({ origin: trappist, radiusPc: 5 });
    expect(fromHost.ok).toBe(true);
    if (!fromHost.ok) return;
    expect(fromHost.system!.map((m) => m.id)).toEqual(expect.arrayContaining(['exo:TRAPPIST-1 b', 'exo:TRAPPIST-1 h']));
    expect(fromHost.system!.some((m) => m.role === 'host')).toBe(false);
    expect(fromHost.neighbours.some((x) => x.id.startsWith('exo:TRAPPIST-1'))).toBe(false);
    expect(fromHost.neighbours.every((x) => x.distanceMetres > 0)).toBe(true);

    // k nearest: still k neighbours (the system members do not use up the quota)
    const k = await atlas.nearby({ origin: 'exo:TRAPPIST-1 b', k: 5 });
    expect(k.ok && k.neighbours.length).toBe(5);

    // a star with no planets has no system; a Solar System moon is not treated as a "system member"
    const sirius = await atlas.nearby({ origin: 'hip:32349', radiusPc: 5 });
    expect(sirius.ok && sirius.system).toBeFalsy();
  });

  it('parent(): the relation graph first; exclude skips a parent; the fallback runs when none is usable and the step is in the same history', async () => {
    host.plans.length = 0;
    await atlas.select('solar:europa', { focus: true });
    const up = await atlas.parent({ exclude: (l) => !l.id.startsWith('solar:') || l.id === 'solar:sun', fallback: () => { throw new Error('no fallback expected for a moon'); } });
    expect(up.ok).toBe(true);
    expect('via' in up && up.via?.id).toBe('solar:jupiter');
    expect(atlas.selection).toBe('solar:jupiter');
    expect('fallback' in up && up.fallback).toBeFalsy();

    let ran: { hadSelection: boolean } | null = null;
    const top = await atlas.parent({ exclude: (l) => !l.id.startsWith('solar:') || l.id === 'solar:sun', fallback: (c) => { ran = c; } });
    expect(top).toMatchObject({ ok: true, fallback: true });
    expect(ran).toEqual({ hadSelection: true });
    expect(atlas.selection).toBeNull();                                      // recorded as a deselect in the history
    expect(atlas.navState()!.canBack).toBe(true);
    const back = atlas.back();
    expect(back.ok).toBe(true);
    expect(atlas.selection).toBe('solar:jupiter');                          // back returns to the object the user left

    // nothing selected: the fallback runs without a deselect
    atlas.deselect();
    let ran2: { hadSelection: boolean } | null = null;
    const none = await atlas.parent({ fallback: (c) => { ran2 = c; } });
    expect(none).toMatchObject({ ok: true, fallback: true });
    expect(ran2).toEqual({ hadSelection: false });
    expect(await atlas.parent()).toMatchObject({ ok: false, error: 'no-selection' });

    // a curated deep-space object: the relation graph names no parent for M31 (its curated parentId is the viewer's business), so the viewer's own step runs
    // (with hadSelection: the page needs the selection from BEFORE the atlas recorded the deselect, which it captures itself)
    await atlas.select('deep:m31', { focus: false });
    let ran3: { hadSelection: boolean } | null = null;
    const g = await atlas.parent({ fallback: (c) => { ran3 = c; } });
    expect(g.ok).toBe(true);
    if ('fallback' in g && g.fallback) { expect(ran3).toEqual({ hadSelection: true }); expect(atlas.selection).toBeNull(); }
    else expect(atlas.selection).not.toBe('deep:m31');
  });
});
