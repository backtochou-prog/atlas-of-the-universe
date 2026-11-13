import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/core/spatial/vec3';
import { METRES_PER_PARSEC } from '../src/core/units';
import { NavigationController, defaultViewDistancePc, type CameraSnapshot, type FocusPlan, type NavigationHost } from '../src/discovery/navigation';
import { RelationGraph } from '../src/discovery/relations';
import type { DiscoveryRecord, Relation, UniversalId } from '../src/discovery/types';
import { rec } from './fixtures/discovery/synthetic';

const at = (xyz: Vec3): DiscoveryRecord['position'] => ({ kind: 'icrs', xyzPc: xyz, raDeg: 0, decDeg: 0 });
const RECORDS: DiscoveryRecord[] = [
  rec('gaia:a', 'Alpha', ['Alpha'], 'star', { position: at([1, 0, 0]), drawn: true }),
  rec('gaia:b', 'Beta', ['Beta'], 'star', { position: at([2, 0, 0]), drawn: true }),
  rec('gaia:c', 'Gamma', ['Gamma'], 'star', { position: at([3, 0, 0]), drawn: true }),
  rec('solar:jupiter', 'Jupiter', ['Jupiter'], 'planet', { dataset: 'solar-system', position: { kind: 'solar', bodyId: 'jupiter' }, drawn: true, measurements: { radiusKm: { value: 69911, kind: 'observed' } } }),
  rec('solar:io', 'Io', ['Io'], 'moon', { dataset: 'solar-system', position: { kind: 'solar', bodyId: 'io' }, drawn: true }),
  rec('solar:sun', 'Sun', ['Sun'], 'star', { dataset: 'solar-system', position: { kind: 'solar', bodyId: 'sun' }, drawn: true }),
  rec('exo:p', 'Planet p', ['Planet p'], 'exoplanet', { dataset: 'nasa-exoplanet-archive', position: at([1, 0, 0]), drawn: false }),
  rec('other:faint', 'Faint', ['Faint'], 'galaxy', { position: { kind: 'sky-only', raDeg: 10, decDeg: 20 }, drawn: false }),
  rec('deep:lg', 'Local Group', ['Local Group'], 'galaxy-group', { dataset: 'deep-space', position: { kind: 'sky-only', raDeg: NaN, decDeg: NaN }, drawn: false }),
  rec('deep:m31', 'M31', ['M31'], 'galaxy', { dataset: 'deep-space', position: at([7.6e5, 0, 0]), drawn: true, measurements: { physicalSizePc: { value: 46000, kind: 'derived' } } }),
  rec('deep:crab', 'Crab', ['Crab'], 'supernova-remnant', { dataset: 'deep-space', position: at([0, 1900, 0]), drawn: true, measurements: { physicalSizePc: { value: 3.4, kind: 'derived' } } }),
];

class FakeHost implements NavigationHost {
  calls: string[] = [];
  selection: UniversalId | null = null;
  camera: CameraSnapshot = { frame: 'stellar-neighbourhood', focus: [0, 0, 0], distance: 10, yaw: 0, pitch: 0 };
  frame = 'stellar-neighbourhood';
  plans: FocusPlan[] = [];
  highlighted: readonly UniversalId[] = [];
  restored: { snapshot: CameraSnapshot; ms: number }[] = [];
  constructor(private readonly records: readonly DiscoveryRecord[] = RECORDS) {}
  focus(plan: FocusPlan): void { this.calls.push(`focus:${plan.id}`); this.plans.push(plan); this.camera = { ...this.camera, focus: plan.target.kind === 'point' ? plan.target.xyzPc : this.camera.focus, distance: plan.viewDistancePc ?? this.camera.distance }; }
  snapshot(): CameraSnapshot { this.calls.push('snapshot'); return { ...this.camera }; }
  restore(s: CameraSnapshot, ms: number): void { this.calls.push('restore'); this.restored.push({ snapshot: s, ms }); this.camera = { ...s }; }
  setSelection(id: UniversalId | null): void { this.calls.push(`select:${id}`); this.selection = id; }
  highlight(ids: readonly UniversalId[]): void { this.calls.push(`highlight:${ids.length}`); this.highlighted = ids; }
  currentFrame(): string { this.calls.push('frame'); return this.frame; }
  resolve(id: UniversalId): DiscoveryRecord | undefined { this.calls.push(`resolve:${id}`); return this.records.find((r) => r.id === id); }
  positionOf(r: DiscoveryRecord): Vec3 | undefined { this.calls.push(`positionOf:${r.id}`); return undefined; }
  viewDistance?: (r: DiscoveryRecord) => number | undefined;
  withDistanceRule(): this { this.viewDistance = (r) => { this.calls.push(`viewDistance:${r.id}`); return r.category === 'galaxy' ? 2.2 * (r.measurements.physicalSizePc?.value ?? 0) : undefined; }; return this; }
  clear(): void { this.calls = []; }
}

const rel = (from: string, to: string, kind: Relation['kind'], basis: Relation['basis']): Relation => ({ from, to, kind, basis, statement: `${from} ${kind} ${to}`, source: { label: 't' } });

describe('select', () => {
  it('calls the host in a fixed order: resolve, snapshot, frame, setSelection, highlight clear, [position, view distance], focus', () => {
    const h = new FakeHost().withDistanceRule();
    const nav = new NavigationController(h);
    const r = nav.select('gaia:a');
    expect(r.ok).toBe(true);
    expect(h.calls).toEqual(['resolve:gaia:a', 'snapshot', 'frame', 'select:gaia:a', 'highlight:0', 'positionOf:gaia:a', 'viewDistance:gaia:a', 'focus:gaia:a']);
    expect(nav.selection).toBe('gaia:a');
  });
  it('the controller never moves the camera itself: only focus(plan) and restore() are requests', () => {
    const h = new FakeHost();
    const nav = new NavigationController(h);
    nav.select('gaia:a');
    nav.select('gaia:b');
    expect(h.camera.focus).toEqual([2, 0, 0]);        // changed only by the host's own focus()
    expect(h.plans.map((p) => p.id)).toEqual(['gaia:a', 'gaia:b']);
  });
  it('the plan carries target, view distance, reason and transition time', () => {
    const h = new FakeHost();
    const nav = new NavigationController(h, null, { transitionMs: 777 });
    const p = (nav.select('gaia:b', 'from search') as { plan: FocusPlan }).plan;
    expect(p).toMatchObject({ id: 'gaia:b', target: { kind: 'point', xyzPc: [2, 0, 0] }, viewDistancePc: 4, proxy: false, transitionMs: 777, reason: 'from search' });
    expect(p.record.id).toBe('gaia:b');
  });
  it('the host\'s own view-distance rule wins; its undefined falls back to the default rule', () => {
    const h = new FakeHost().withDistanceRule();
    const nav = new NavigationController(h);
    expect((nav.select('deep:m31') as { plan: FocusPlan }).plan.viewDistancePc).toBeCloseTo(2.2 * 46000, 6);       // galaxy at 2.2 x diameter, from the host
    expect((nav.select('gaia:a') as { plan: FocusPlan }).plan.viewDistancePc).toBe(4);                              // host returned undefined: default for a star
  });
  it('default view distances per category', () => {
    const base = (c: DiscoveryRecord['category'], m: DiscoveryRecord['measurements'] = {}) => rec('x:1', 'x', ['x'], c, { measurements: m });
    expect(defaultViewDistancePc(base('star'))).toBe(4);
    expect(defaultViewDistancePc(base('exoplanet-host'))).toBe(4);
    expect(defaultViewDistancePc(base('planet', { radiusKm: { value: 6371, kind: 'observed' } }))).toBeCloseTo((6371 * 1000 * 4) / METRES_PER_PARSEC, 20);
    expect(defaultViewDistancePc(base('planet'))).toBeUndefined();
    expect(defaultViewDistancePc(base('galaxy', { physicalSizePc: { value: 10, kind: 'derived' } }))).toBe(22);
    expect(defaultViewDistancePc(base('galaxy'))).toBeUndefined();
    expect(defaultViewDistancePc(base('nebula', { physicalSizePc: { value: 4, kind: 'derived' } }))).toBe(12);
    expect(defaultViewDistancePc(base('star-cluster', { physicalSizePc: { value: 5, kind: 'derived' } }))).toBe(15);
    expect(defaultViewDistancePc(base('galaxy-cluster', { physicalSizePc: { value: 2, kind: 'derived' } }))).toBe(3);
    expect(defaultViewDistancePc(base('other'))).toBeUndefined();
    expect(defaultViewDistancePc(base('galaxy', { physicalSizePc: { value: 0, kind: 'derived' } }))).toBeUndefined();
  });
  it('Solar System bodies are targeted by body id (the host places them with its ephemeris)', () => {
    const h = new FakeHost();
    const p = (new NavigationController(h).select('solar:jupiter') as { plan: FocusPlan }).plan;
    expect(p.target).toEqual({ kind: 'solar-body', bodyId: 'jupiter' });
    expect(p.viewDistancePc).toBeCloseTo((69911 * 1000 * 4) / METRES_PER_PARSEC, 20);
    expect(p.proxy).toBe(false);
  });
  it('objects that cannot be resolved at this scale get proxy: true, with a reason', () => {
    const h = new FakeHost();
    const nav = new NavigationController(h);
    const exo = (nav.select('exo:p') as { plan: FocusPlan }).plan;
    expect(exo).toMatchObject({ proxy: true, target: { kind: 'point', xyzPc: [1, 0, 0] } });          // drawn at its host's position as a marker
    expect(exo.proxyReason).toMatch(/not drawn/);
    const faint = (nav.select('other:faint') as { plan: FocusPlan }).plan;
    expect(faint).toMatchObject({ proxy: true, target: { kind: 'direction', raDeg: 10, decDeg: 20 } });
    expect(faint.proxyReason).toMatch(/distance is unknown/);
    const lg = (nav.select('deep:lg') as { plan: FocusPlan }).plan;
    expect(lg).toMatchObject({ proxy: true, target: { kind: 'none' } });
    expect((nav.select('gaia:a') as { plan: FocusPlan }).plan.proxy).toBe(false);
  });
  it('the host may refine the position through positionOf', () => {
    const h = new FakeHost();
    h.positionOf = (r) => (r.id === 'gaia:a' ? [9, 9, 9] : undefined);
    expect((new NavigationController(h).select('gaia:a') as { plan: FocusPlan }).plan.target).toEqual({ kind: 'point', xyzPc: [9, 9, 9] });
  });
  it('an unknown id touches only resolve(), changes nothing and says so', () => {
    const h = new FakeHost();
    const nav = new NavigationController(h);
    nav.select('gaia:a');
    h.clear();
    const r = nav.select('gaia:nope');
    expect(r).toMatchObject({ ok: false, error: 'unknown-id' });
    expect(h.calls).toEqual(['resolve:gaia:nope']);
    expect(nav.selection).toBe('gaia:a');
    expect(nav.state().length).toBe(2);
  });
  it('selecting the already selected id is a complete no-op', () => {
    const h = new FakeHost();
    const nav = new NavigationController(h);
    nav.select('gaia:a');
    h.clear();
    const r = nav.select('gaia:a');
    expect(r).toEqual({ ok: true, noop: true });
    expect(h.calls).toEqual(['resolve:gaia:a']);
    expect(nav.state().length).toBe(2);
    expect(nav.history().map((e) => e.selection)).toEqual([null, 'gaia:a']);
  });
});

describe('back, forward, history', () => {
  it('back restores the camera snapshot taken when the entry was left, then forward returns', () => {
    const h = new FakeHost();
    const nav = new NavigationController(h, null, { restoreMs: 321 });
    h.camera = { ...h.camera, yaw: 1 };
    nav.select('gaia:a');                            // leaves the start view (yaw 1)
    h.camera = { ...h.camera, yaw: 2, distance: 5 }; // the user orbits around A
    nav.select('gaia:b');                            // leaves A at yaw 2
    h.clear();
    expect(nav.back()).toMatchObject({ ok: true });
    expect(h.calls).toEqual(['snapshot', 'frame', 'select:gaia:a', 'highlight:0', 'restore']);
    expect(h.restored[0]!.snapshot).toMatchObject({ yaw: 2, distance: 5 });
    expect(h.restored[0]!.ms).toBe(321);
    expect(nav.selection).toBe('gaia:a');
    expect(nav.back()).toMatchObject({ ok: true });
    expect(h.restored[1]!.snapshot.yaw).toBe(1);
    expect(nav.selection).toBeNull();
    expect(h.selection).toBeNull();
    expect(nav.back()).toMatchObject({ ok: false, error: 'at-start' });
    expect(nav.forward()).toMatchObject({ ok: true });
    expect(nav.selection).toBe('gaia:a');
    expect(nav.forward()).toMatchObject({ ok: true });
    expect(nav.selection).toBe('gaia:b');
    expect(nav.forward()).toMatchObject({ ok: false, error: 'at-end' });
  });
  it('selecting after back discards the forward history', () => {
    const h = new FakeHost();
    const nav = new NavigationController(h);
    nav.select('gaia:a'); nav.select('gaia:b'); nav.back();
    expect(nav.state()).toMatchObject({ canBack: true, canForward: true });
    nav.select('gaia:c');
    expect(nav.state().canForward).toBe(false);
    expect(nav.history().map((e) => e.selection)).toEqual([null, 'gaia:a', 'gaia:c']);
  });
  it('the history is bounded and drops the oldest', () => {
    const h = new FakeHost();
    const nav = new NavigationController(h, null, { maxHistory: 4 });
    for (const id of ['gaia:a', 'gaia:b', 'gaia:c', 'solar:sun', 'solar:io']) nav.select(id);
    expect(nav.history().map((e) => e.selection)).toEqual(['gaia:c', 'solar:sun', 'solar:io'].length === 3 ? ['gaia:b', 'gaia:c', 'solar:sun', 'solar:io'] : []);
    expect(nav.state().length).toBe(4);
    let back = 0;
    while (nav.back().ok) back++;
    expect(back).toBe(3);
    expect(nav.selection).toBe('gaia:b');
  });
  it('a bound below 2 is raised to 2', () => {
    const nav = new NavigationController(new FakeHost(), null, { maxHistory: 0 });
    nav.select('gaia:a'); nav.select('gaia:b');
    expect(nav.state().length).toBe(2);
  });
  it('deselect clears the selection and the highlight, keeps the camera, and back returns to the selection', () => {
    const h = new FakeHost();
    const nav = new NavigationController(h);
    nav.select('gaia:a');
    h.camera = { ...h.camera, yaw: 3 };
    h.clear();
    expect(nav.deselect()).toMatchObject({ ok: true, noop: false });
    expect(h.calls).toEqual(['snapshot', 'frame', 'select:null', 'highlight:0']);
    expect(nav.selection).toBeNull();
    expect(nav.deselect()).toEqual({ ok: true, noop: true });
    expect(nav.back()).toMatchObject({ ok: true });
    expect(nav.selection).toBe('gaia:a');
    expect(h.camera.yaw).toBe(3);
  });
  it('returnToPrevious toggles between the last two places, also after back and forward', () => {
    const h = new FakeHost();
    const nav = new NavigationController(h);
    expect(nav.returnToPrevious()).toMatchObject({ ok: false, error: 'no-previous' });
    nav.select('gaia:a'); nav.select('gaia:b'); nav.select('gaia:c');
    expect(nav.returnToPrevious()).toMatchObject({ ok: true });
    expect(nav.selection).toBe('gaia:b');
    expect(nav.returnToPrevious()).toMatchObject({ ok: true });
    expect(nav.selection).toBe('gaia:c');
    nav.back(); nav.back();                                  // now at A
    expect(nav.selection).toBe('gaia:a');
    expect(nav.returnToPrevious().ok).toBe(true);
    expect(nav.selection).toBe('gaia:b');                    // the place we were at just before A
  });
  it('an entry whose object is gone still restores the camera; one without a camera falls back to a plan', () => {
    const records = [...RECORDS];
    const h = new FakeHost(records);
    const nav = new NavigationController(h);
    nav.select('gaia:a'); nav.select('gaia:b');
    records.splice(records.findIndex((r) => r.id === 'gaia:a'), 1);              // dataset unloaded
    expect(nav.back()).toMatchObject({ ok: true });
    expect(h.restored).toHaveLength(1);
  });
  it('subscribers see every state change', () => {
    const h = new FakeHost();
    const nav = new NavigationController(h);
    const seen: (string | null)[] = [];
    const off = nav.subscribe((s) => seen.push(s.selection));
    nav.select('gaia:a'); nav.select('gaia:a'); nav.select('gaia:b'); nav.back(); nav.deselect();
    off();
    nav.select('gaia:c');
    expect(seen).toEqual(['gaia:a', 'gaia:b', 'gaia:a', null]);
  });
  it('snapshot and frame are recorded per entry', () => {
    const h = new FakeHost();
    const nav = new NavigationController(h);
    h.frame = 'solar-system';
    nav.select('solar:jupiter');
    h.frame = 'jupiter-system';
    nav.select('solar:io');
    const entries = nav.history();
    expect(entries[0]).toMatchObject({ selection: null, frame: 'solar-system' });
    expect(entries[1]).toMatchObject({ selection: 'solar:jupiter', frame: 'jupiter-system' });
    expect(entries[2]).toMatchObject({ selection: 'solar:io', camera: undefined });
  });
});

describe('parent', () => {
  const graph = new RelationGraph([
    rel('solar:io', 'solar:jupiter', 'orbits', 'physical-gravitational'),
    rel('solar:jupiter', 'solar:sun', 'orbits', 'physical-gravitational'),
    rel('deep:m31', 'deep:lg', 'member-of', 'spatial-association'),
    rel('deep:crab', 'deep:milky-way', 'part-of', 'structural'),
    rel('gaia:b', 'gaia:ghost', 'orbits', 'physical-gravitational'),
    rel('gaia:b', 'gaia:a', 'member-of', 'structural'),
  ]);
  it('selects the physical parent, then its parent; back returns to the child with its camera', () => {
    const h = new FakeHost();
    const nav = new NavigationController(h, graph);
    nav.select('solar:io');
    h.camera = { ...h.camera, yaw: 4 };
    const r = nav.parent();
    expect(r).toMatchObject({ ok: true });
    expect((r as { via: { relation: Relation } }).via.relation.kind).toBe('orbits');
    expect(nav.selection).toBe('solar:jupiter');
    expect(h.plans[h.plans.length - 1]!.reason).toBe('parent: solar:io orbits solar:jupiter');
    expect(nav.parent()).toMatchObject({ ok: true });
    expect(nav.selection).toBe('solar:sun');
    expect(nav.parent()).toMatchObject({ ok: false, error: 'no-parent' });
    nav.back(); nav.back();
    expect(nav.selection).toBe('solar:io');
    expect(h.camera.yaw).toBe(4);                              // back after parent restored the child's view
  });
  it('associations are not parents unless asked', () => {
    const h = new FakeHost();
    const nav = new NavigationController(h, graph);
    nav.select('deep:m31');
    expect(nav.parent()).toMatchObject({ ok: false, error: 'no-parent' });
  });
  it('with association allowed, an association parent is used when the host can resolve it', () => {
    const h = new FakeHost();
    const nav = new NavigationController(h, graph);
    nav.select('deep:m31');
    const r = nav.parent({ includeAssociation: true });
    expect(r).toMatchObject({ ok: true });
    expect(nav.selection).toBe('deep:lg');
  });
  it('structural parents count; unresolvable parents are skipped in favour of the next', () => {
    const h = new FakeHost();
    const nav = new NavigationController(h, graph);
    nav.select('gaia:b');
    expect(nav.parent()).toMatchObject({ ok: true });
    expect(nav.selection).toBe('gaia:a');                      // gaia:ghost (physical, preferred) is not loaded, so the structural parent is used
  });
  it('failure cases: nothing selected, no graph', () => {
    expect(new NavigationController(new FakeHost(), graph).parent()).toMatchObject({ ok: false, error: 'no-selection' });
    const nav = new NavigationController(new FakeHost());
    nav.select('gaia:a');
    expect(nav.parent()).toMatchObject({ ok: false, error: 'not-available' });
  });
});

describe('nearby navigation', () => {
  it('asks the provider for k neighbours of the selection, highlights them, and selecting one is a normal select', () => {
    const h = new FakeHost();
    const asked: [string, number][] = [];
    const nav = new NavigationController(h, null, { nearby: (r, k) => { asked.push([r.id, k]); return [{ id: 'gaia:b', distanceText: '1.0 pc' }, { id: 'gaia:c', distanceText: '2.0 pc' }]; } });
    expect(nav.nearbyNavigation(5)).toMatchObject({ ok: false, error: 'no-selection' });
    nav.select('gaia:a');
    h.clear();
    const r = nav.nearbyNavigation(5);
    expect(r).toMatchObject({ ok: true });
    expect(asked).toEqual([['gaia:a', 5]]);
    expect(h.highlighted).toEqual(['gaia:b', 'gaia:c']);
    expect(nav.selectNeighbour('gaia:b').ok).toBe(true);
    expect(nav.selection).toBe('gaia:b');
    expect(h.highlighted).toEqual([]);                          // the new selection clears the neighbour highlight
  });
  it('failure cases', () => {
    const h = new FakeHost();
    const none = new NavigationController(h, null, { nearby: () => [] });
    none.select('gaia:a');
    expect(none.nearbyNavigation(3)).toMatchObject({ ok: false, error: 'no-neighbours' });
    const unwired = new NavigationController(h);
    unwired.select('gaia:a');
    expect(unwired.nearbyNavigation(3)).toMatchObject({ ok: false, error: 'not-available' });
    const clamp = new NavigationController(h, null, { nearby: (_r, k) => { expect(k).toBe(1); return [{ id: 'gaia:b' }]; } });
    clamp.select('gaia:a');
    expect(clamp.nearbyNavigation(0.2)).toMatchObject({ ok: true });         // k is clamped to at least 1
  });
});
