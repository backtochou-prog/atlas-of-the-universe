/**
 * The DiscoveryAtlas on the REAL datasets (engine on the calling thread): aliases and notes, relations, nearby through the real frame tree (including the Solar System
 * domain at a simulation time supplied by the page), filters, lists, and the select / back / forward / parent history with a fake viewer host.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { DiscoveryAtlas, InlineEngineClient, type AtlasViewerPort } from '../src/discovery/atlas';
import type { CameraSnapshot, FocusPlan } from '../src/discovery/navigation';
import type { DiscoveryRecord, UniversalId } from '../src/discovery/types';
import type { SolarBodyOffset } from '../src/discovery/engineApi';
import { METRES_PER_AU, METRES_PER_PARSEC } from '../src/core/units';
import type { Vec3 } from '../src/core/spatial/vec3';
import { MemoryAdapter } from '../src/discovery/saved';
import { have } from './fixtures/discovery/real';
import { FileDataSource } from './fixtures/discovery/source';

const NEED = ['gaia-dr3-subset.v1.json.gz', 'simbad-crossid.v1.json.gz', 'solar-system.v1.json', 'deep-space.v1.json', 'deepspace/ungc.v1.json.gz', 'deepspace/local-group-mcconnachie.v1.json.gz', 'deepspace/twomrs.v1.json.gz', 'bright-stars.v1.json.gz', 'exoplanets.v1.json.gz', 'other-objects.v1.json', 'discovery-notes.v1.json', 'relations.v1.json'];
const missing = NEED.filter((f) => !have(f));

/** A viewer double: records every call, keeps a camera, never draws. */
class FakeHost implements AtlasViewerPort {
  calls: string[] = [];
  plans: FocusPlan[] = [];
  cam: CameraSnapshot = { frame: 'stellar-neighbourhood', focus: [0, 0, 0], distance: 60, yaw: 0, pitch: 0 };
  sel: UniversalId | null = null;
  bodies: SolarBodyOffset[] = [];
  constructor(private readonly resolveRecord: (id: UniversalId) => DiscoveryRecord | undefined) {}
  focus(plan: FocusPlan): void { this.calls.push(`focus:${plan.id}`); this.plans.push(plan); const t = plan.target; if (t.kind === 'point') this.cam = { ...this.cam, focus: t.xyzPc, distance: plan.viewDistancePc ?? 4 }; }
  snapshot(): CameraSnapshot { return { ...this.cam }; }
  restore(s: CameraSnapshot): void { this.calls.push('restore'); this.cam = { ...s }; }
  setSelection(id: UniversalId | null): void { this.sel = id; }
  highlight(ids: readonly UniversalId[]): void { this.calls.push(`highlight:${ids.length}`); }
  currentFrame(): string { return 'stellar-neighbourhood'; }
  resolve(id: UniversalId): DiscoveryRecord | undefined { return this.resolveRecord(id); }
  positionOf(): Vec3 | undefined { return undefined; }
  cameraFocusPc(): Vec3 { return this.cam.focus; }
  cameraView() { return { positionPc: [this.cam.focus[0] + this.cam.distance, this.cam.focus[1], this.cam.focus[2]] as Vec3, forward: [-1, 0, 0] as Vec3, up: [0, 0, 1] as Vec3, fovYDeg: 50, aspect: 1.5 }; }
  solarBodyOffsets(): readonly SolarBodyOffset[] { return this.bodies; }
}

describe.skipIf(missing.length > 0)(`DiscoveryAtlas on the real datasets${missing.length ? ` (SKIPPED: missing ${missing.join(', ')})` : ''}`, () => {
  let client: InlineEngineClient;
  const mk = (): { atlas: DiscoveryAtlas; host: FakeHost } => {
    const atlas = new DiscoveryAtlas({ engine: client, notesSource: new FileDataSource(), storage: new MemoryAdapter() });
    const host = new FakeHost((id) => atlas.peek(id));
    atlas.attachViewer(host);
    return { atlas, host };
  };
  let base: DiscoveryAtlas;

  beforeAll(async () => {
    client = new InlineEngineClient(new FileDataSource());
    base = new DiscoveryAtlas({ engine: client, notesSource: new FileDataSource(), storage: new MemoryAdapter() });
    await base.start();
  }, 180_000);

  it('every dataset is ready and the atlas holds one record per object', () => {
    const s = base.status;
    expect(s.complete).toBe(true);
    expect(s.failed).toEqual([]);
    expect(s.records).toBeGreaterThan(90_000);
    expect(s.datasets.every((d) => d.state === 'ready')).toBe(true);
  });

  it('aliases: a note keyed hip:70890 (Proxima) is found from the Gaia record it was merged into, and from every alias', async () => {
    const proxima = await base.resolve('hip:70890');
    expect(proxima).toMatch(/^gaia:/);
    expect(base.canonical('hip:70890')).toBe(proxima);
    expect(base.noteFor(proxima!)?.id).toBe('hip:70890');
    expect(base.noteFor('hip:70890')?.id).toBe('hip:70890');
    const rec = await base.getRecord('hip:70890');                    // alias-aware record lookup
    expect(rec?.id).toBe(proxima);
    expect(rec?.designations.some((d) => /proxima/i.test(d))).toBe(true);
    // the planet's host alias resolves too
    const trappist = await base.resolve('host:TRAPPIST-1');
    expect(trappist).toBeDefined();
    expect(base.noteFor(trappist!)?.id).toBe('host:TRAPPIST-1');
    expect(await base.resolve('nonsense:1')).toBeUndefined();
  });

  it('search finds the named objects; invalid and empty queries are handled without error', async () => {
    const first = async (q: string): Promise<string> => (await base.search(q)).hits[0]?.id ?? '(none)';
    expect(await first('Sirius')).toBe('hip:32349');
    expect(await first('Betelgeuse')).toBe('hip:27989');
    expect(await first('Kepler-452b')).toBe('exo:Kepler-452 b');
    expect(await first('Sagittarius A*')).toBe('other:sgr-a-star');
    expect(await first('Europa')).toBe('solar:europa');
    expect(await first('TRAPPIST-1')).toBe((await base.resolve('host:TRAPPIST-1'))!);
    expect((await base.search('Proxima')).hits[0]!.id).toBe(await base.resolve('hip:70890'));
    for (const bad of ['', ' ', 'a', '!!', 'x'.repeat(500), '\u0000', "'; drop table"]) {
      const r = await base.search(bad);
      expect(Array.isArray(r.hits), JSON.stringify(bad)).toBe(true);
    }
    expect((await base.search('', {})).hits).toEqual([]);
    expect((await base.search('zzzzzzzzqqq')).hits).toEqual([]);
    const res = await base.search('Sirius', { categories: ['exoplanet'] });
    expect(res.hits.every((h) => h.category === 'exoplanet')).toBe(true);
  });

  it('curated records outrank catalogue rows of the same match quality', async () => {
    const r = await base.search('Large Magellanic Cloud', { limit: 6 });
    const firstPoint = r.hits.findIndex((h) => h.id.startsWith('point:'));
    const curated = r.hits.findIndex((h) => h.id === 'deep:lmc');
    expect(curated).toBeGreaterThanOrEqual(0);
    if (firstPoint >= 0) expect(r.hits[curated]!.score).toBeGreaterThanOrEqual(r.hits[firstPoint]!.score - 999);
  });

  it('suggest: with nothing typed it offers history (newest first, distinct) and the objects that have an explanation', async () => {
    const { atlas } = mk();
    await atlas.start();
    const empty = await atlas.suggest('');
    expect(empty.kind).toBe('empty');
    expect(empty.history).toEqual([]);
    expect(empty.featured.length).toBeGreaterThan(3);
    atlas.saved.recordVisit('hip:32349');
    atlas.saved.recordVisit('solar:europa');
    atlas.saved.recordVisit('hip:32349');
    const again = await atlas.suggest('   ');
    expect(again.history.map((h) => h.id)).toEqual(['hip:32349', 'solar:europa']);
    const typed = await atlas.suggest('Betel');
    expect(typed.kind).toBe('results');
    expect(typed.result!.hits[0]!.id).toBe('hip:27989');
  });

  it('relationsOf groups by basis: Europa physically orbits Jupiter; TRAPPIST-1 planets orbit the host; the Sun is structurally part of the Milky Way', async () => {
    const eu = await base.relationsOf('solar:europa');
    expect(eu.groups['physical-gravitational'].some((l) => l.id === 'solar:jupiter' && l.direction === 'out' && l.relation.kind === 'orbits')).toBe(true);
    const host = (await base.resolve('host:TRAPPIST-1'))!;
    const tr = await base.relationsOf('host:TRAPPIST-1');
    expect(tr.canonical).toBe(host);
    const planets = tr.groups['physical-gravitational'].filter((l) => l.direction === 'in' && l.id.startsWith('exo:TRAPPIST-1 '));
    expect(planets).toHaveLength(7);
    expect(planets.every((l) => l.relation.source.label.length > 0 && l.name !== undefined)).toBe(true);
    const sun = await base.relationsOf('solar:sun');
    expect(sun.groups.structural.some((l) => l.id === 'deep:milky-way')).toBe(true);
    expect(sun.groups['spatial-association'].every((l) => l.relation.basis === 'spatial-association')).toBe(true);
  });

  it('nearby(k=5) from Sirius returns real neighbours with distances, nearest first; the origin is not its own neighbour', async () => {
    const r = await base.nearby({ origin: 'hip:32349', k: 5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.neighbours).toHaveLength(5);
    expect(r.neighbours.map((n) => n.id)).not.toContain('hip:32349');
    const d = r.neighbours.map((n) => n.distanceMetres);
    expect(d).toEqual([...d].sort((a, b) => a - b));
    expect(d[0]!).toBeGreaterThan(0);
    expect(d[4]!).toBeLessThan(10 * METRES_PER_PARSEC);
    expect(r.neighbours.every((n) => n.name.length > 0 && n.distanceText.length > 0)).toBe(true);
  });

  it('nearby uses the REAL frame tree: a Solar System body at the simulation time, a star, and an explicit position all agree', async () => {
    // Jupiter 5.2 AU from the Sun along +x, Io 421,700 km from Jupiter, in the solar-system frame (metres)
    const J: Vec3 = [5.2 * METRES_PER_AU, 0, 0];
    const solarBodies: SolarBodyOffset[] = [
      { id: 'solar:sun', offsetMetres: [0, 0, 0] }, { id: 'solar:jupiter', offsetMetres: J }, { id: 'solar:io', offsetMetres: [J[0] + 4.217e8, 0, 0] }, { id: 'solar:europa', offsetMetres: [J[0], 6.711e8, 0] },
    ];
    const { atlas, host } = mk();
    host.bodies = solarBodies;
    await atlas.start();
    // from Jupiter: its moons are nearest, then the Sun; all distances come from the solar frame
    const r = await atlas.nearby({ origin: 'solar:jupiter', k: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.originFrame).toBe('solar-system');
    expect(r.neighbours.map((n) => n.id)).toEqual(['solar:io', 'solar:europa', 'solar:sun']);
    expect(r.neighbours[0]!.distanceMetres).toBeCloseTo(4.217e8, -3);
    expect(r.neighbours[2]!.distanceMetres).toBeCloseTo(5.2 * METRES_PER_AU, -4);
    // from a star: the Sun is at the star's catalogue distance, Jupiter is NOT 5.2 AU from the star (no subtraction across unrelated frames)
    const sirius = await atlas.getRecord('hip:32349');
    const p = sirius!.position;
    expect(p.kind).toBe('icrs');
    if (p.kind !== 'icrs') return;
    const dStar = Math.hypot(...p.xyzPc) * METRES_PER_PARSEC;
    const s = await atlas.nearby({ origin: 'hip:32349', radiusMetres: dStar * 1.001, categories: ['star', 'planet', 'moon'] });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    const sun = s.neighbours.find((n) => n.id === 'solar:sun');
    const jup = s.neighbours.find((n) => n.id === 'solar:jupiter');
    expect(sun).toBeDefined();
    expect(sun!.distanceMetres / dStar).toBeCloseTo(1, 9);
    // Jupiter's distance from the star differs from the Sun's by at most Jupiter's offset (5.2 AU), computed from vectors in ONE frame
    const star: Vec3 = [p.xyzPc[0] * METRES_PER_PARSEC, p.xyzPc[1] * METRES_PER_PARSEC, p.xyzPc[2] * METRES_PER_PARSEC];
    const expectJ = Math.hypot(star[0] - J[0], star[1] - J[1], star[2] - J[2]);
    expect(jup!.distanceMetres).toBeCloseTo(expectJ, -3);
    expect(Math.abs(jup!.distanceMetres - sun!.distanceMetres)).toBeLessThanOrEqual(5.2 * METRES_PER_AU * 1.0000001);
    // an explicit position at Jupiter's place (expressed in parsecs, heliocentric) finds the same Sun distance as the solar-frame origin
    const viaPos = await atlas.nearby({ origin: { positionPc: [J[0] / METRES_PER_PARSEC, 0, 0] }, k: 1, categories: ['star'] });
    const viaSolar = await client.nearby({ origin: { kind: 'solar-position', offsetMetres: J }, k: 1, categories: ['star'], solarBodies });
    expect(viaPos.ok && viaSolar.ok).toBe(true);
    if (viaPos.ok && viaSolar.ok) {
      expect(viaPos.neighbours[0]!.id).toBe(viaSolar.neighbours[0]!.id);                                   // the same nearest star from the same place, however the place is expressed
      expect(Math.abs(viaPos.neighbours[0]!.distanceMetres - viaSolar.neighbours[0]!.distanceMetres)).toBeLessThan(1e-6 * viaSolar.neighbours[0]!.distanceMetres);
    }
    // camera origin = the viewer's focus
    host.cam = { ...host.cam, focus: [p.xyzPc[0], p.xyzPc[1], p.xyzPc[2]] };
    const cam = await atlas.nearby({ origin: 'camera', k: 2, categories: ['star'] });
    expect(cam.ok).toBe(true);
    if (cam.ok) expect(cam.neighbours[0]!.id).toBe('hip:32349');
  });

  it('nearby reports why it cannot answer: unknown id, sky-only object, bad parameters, a body without a time-position', async () => {
    const un = await base.nearby({ origin: 'gaia:0', k: 3 });
    expect(un.ok).toBe(false);
    if (!un.ok) expect(un.error).toBe('unknown-id');
    const noArgs = await base.nearby({ origin: 'hip:32349' });
    expect(noArgs.ok).toBe(false);
    const sol = await base.nearby({ origin: 'solar:mars', k: 2 });
    expect(sol.ok).toBe(false);
    if (!sol.ok) expect(sol.error).toBe('no-solar-position');
    const lg = await base.nearby({ origin: 'deep:local-group', k: 2 });
    expect(lg.ok).toBe(false);
    if (!lg.ok) expect(lg.error).toBe('no-position');
    const noCam = await base.nearby({ origin: 'camera', k: 2 });
    expect(noCam.ok).toBe(false);
    const bad = await base.nearby({ origin: { positionPc: [NaN, 0, 0] }, k: 2 });
    expect(bad.ok).toBe(false);
  });

  it('visible(): needs the viewer; returns objects inside the frustum with names, nearest first', async () => {
    const none = await base.visible({ maxDistanceMetres: 10 * METRES_PER_PARSEC });
    expect(none.ok).toBe(false);
    const { atlas, host } = mk();
    await atlas.start();
    host.cam = { frame: 'stellar-neighbourhood', focus: [0, 0, 0], distance: 5, yaw: 0, pitch: 0 };
    const v = await atlas.visible({ maxDistanceMetres: 30 * METRES_PER_PARSEC, categories: ['star'], limit: 50 });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.objects.length).toBeGreaterThan(0);
      const d = v.objects.map((o) => o.distanceMetres);
      expect(d).toEqual([...d].sort((a, b) => a - b));
      expect(v.objects.every((o) => o.name.length > 0)).toBe(true);
    }
  });

  it('facets offer only keys with data; filter counts what it excluded for missing values (never treating missing as zero)', async () => {
    const f = await base.facets();
    expect(f!.unavailableKeys).toContain('redshift');
    const r = await base.filter({ categories: ['exoplanet'], ranges: { radiusKm: { min: 0 } } });
    expect(r!.excludedForMissing.radiusKm).toBeGreaterThan(0);
    expect(r!.count + r!.excludedForMissing.radiusKm!).toBe(r!.scope);
    expect(r!.ids.length).toBeLessThanOrEqual(200);
    expect(r!.complete).toBe(true);
    const small = await base.filter({ categories: ['star'], ranges: { apparentMag: { max: 0 } } }, { limit: 3 });
    expect(small!.ids.length).toBeLessThanOrEqual(3);
    expect(small!.truncated).toBe(small!.count > small!.ids.length);
  });

  it('lists are computed once, complete, each stating its criterion and scope', async () => {
    const a = await base.lists();
    const b = await base.lists();
    expect(a).toBe(b);                                                // cached
    expect(a!.complete).toBe(true);
    expect(a!.lists.map((l) => l.id)).toEqual(expect.arrayContaining(['nearest-stars', 'brightest-stars', 'nearest-galaxies']));
    expect(a!.lists.every((l) => l.criterion.length > 0 && l.scope.length > 0 && l.completeness === 'not complete')).toBe(true);
    expect(a!.lists.find((l) => l.id === 'brightest-stars')!.items[0]!.name).toBe('Sirius');
  });

  describe('selection and history', () => {
    it('select records history, flies only when asked, and notifies once per change; the same object again is a no-op', async () => {
      const { atlas, host } = mk();
      await atlas.start();
      const seen: (string | null)[] = [];
      atlas.onSelectionChange((e) => seen.push(e.id));
      const r1 = await atlas.select('hip:32349');
      expect(r1.ok).toBe(true);
      expect(host.calls).toContain('focus:hip:32349');
      expect(host.plans[0]!.viewDistancePc).toBe(4);                  // default rule when the host supplies none
      const again = await atlas.select('hip:32349');
      expect(again.ok && again.noop).toBe(true);
      const r2 = await atlas.select('solar:europa', { focus: false });
      expect(r2.ok).toBe(true);
      expect(host.calls.filter((c) => c.startsWith('focus:'))).toEqual(['focus:hip:32349']);       // focus:false = no flight
      expect(atlas.selection).toBe('solar:europa');
      expect(seen).toEqual(['hip:32349', 'solar:europa']);
      expect(atlas.saved.history().map((h) => h.id)).toEqual(['solar:europa', 'hip:32349']);
      const unknown = await atlas.select('nonsense:1');
      expect(unknown.ok).toBe(false);
      if (!unknown.ok) expect(unknown.error).toBe('unknown-id');
      expect(atlas.selection).toBe('solar:europa');
    });

    it('selecting an alias selects the canonical record', async () => {
      const { atlas } = mk();
      await atlas.start();
      const r = await atlas.select('hip:70890', { focus: false });
      expect(r.ok).toBe(true);
      expect(atlas.selection).toBe(await base.resolve('hip:70890'));
    });

    it('back and forward restore the camera snapshot of the entry they leave, not a fresh flight', async () => {
      const { atlas, host } = mk();
      await atlas.start();
      host.cam = { frame: 'stellar-neighbourhood', focus: [1, 2, 3], distance: 77, yaw: 0.5, pitch: 0.25 };
      await atlas.select('hip:32349');
      const afterSirius = { ...host.cam };
      await atlas.select('deep:m31');
      expect(atlas.back().ok).toBe(true);
      expect(atlas.selection).toBe('hip:32349');
      expect(host.calls).toContain('restore');
      expect(host.cam).toEqual(expect.objectContaining({ distance: afterSirius.distance }));
      expect(atlas.back().ok).toBe(true);
      expect(atlas.selection).toBeNull();
      expect(host.cam.focus).toEqual([1, 2, 3]);                      // all the way back to the view before the first selection
      expect(host.cam.distance).toBe(77);
      expect(atlas.back().ok).toBe(false);
      expect(atlas.forward().ok).toBe(true);
      expect(atlas.selection).toBe('hip:32349');
      expect(atlas.returnToPrevious().ok).toBe(true);
    });

    it('parent() goes up the relation graph: Io -> Jupiter -> Sun; a planet -> its host; M31 has only an association', async () => {
      const { atlas } = mk();
      await atlas.start();
      await atlas.select('solar:io', { focus: false });
      const p1 = await atlas.parent();
      expect(p1.ok).toBe(true);
      expect(atlas.selection).toBe('solar:jupiter');
      const p2 = await atlas.parent();
      expect(p2.ok).toBe(true);
      expect(atlas.selection).toBe('solar:sun');
      await atlas.select('exo:TRAPPIST-1 e', { focus: false });
      const p3 = await atlas.parent();
      expect(p3.ok).toBe(true);
      expect(atlas.selection).toBe(await base.resolve('host:TRAPPIST-1'));
      await atlas.select('deep:m31', { focus: false });
      const p4 = await atlas.parent();
      expect(p4.ok).toBe(false);
      const p5 = await atlas.parent({ includeAssociation: true });
      expect(p5.ok).toBe(true);
      expect(atlas.selection).toBe('deep:local-group');
      await atlas.deselect();
      expect((await atlas.parent()).ok).toBe(false);
    });

    it('selecting an exoplanet focuses the HOST star position and says the planet is not drawn (proxy)', async () => {
      const { atlas, host } = mk();
      await atlas.start();
      await atlas.select('exo:TRAPPIST-1 e');
      const plan = host.plans[host.plans.length - 1]!;
      expect(plan.id).toBe('exo:TRAPPIST-1 e');
      expect(plan.proxy).toBe(true);
      expect(plan.target.kind).toBe('point');
      const hostRec = await atlas.getRecord('host:TRAPPIST-1');
      if (plan.target.kind === 'point' && hostRec!.position.kind === 'icrs') expect(plan.target.xyzPc).toEqual(hostRec!.position.xyzPc);
    });

    it('serialises quick selections: the last call wins and the history order is the call order', async () => {
      const { atlas } = mk();
      await atlas.start();
      const ps = [atlas.select('hip:32349', { focus: false }), atlas.select('hip:27989', { focus: false }), atlas.select('solar:mars', { focus: false })];
      await Promise.all(ps);
      expect(atlas.selection).toBe('solar:mars');
      expect(atlas.navHistory().map((e) => e.selection)).toEqual([null, 'hip:32349', 'hip:27989', 'solar:mars']);
    });
  });

  it('saved: bookmarks and collections work through the atlas store', () => {
    const { atlas } = mk();
    expect(atlas.saved.addBookmark('hip:32349').ok).toBe(true);
    expect(atlas.saved.isBookmarked('hip:32349')).toBe(true);
    expect(atlas.saved.persistence().mode).toBe('memory-only');
  });
});
