import { describe, expect, it } from 'vitest';
import { METRES_PER_AU, METRES_PER_PARSEC } from '../src/core/units';
import type { NearbyOutcome } from '../src/discovery/engineApi';
import { MemoryAdapter, SavedStore } from '../src/discovery/saved';
import type { DiscoveryRecord } from '../src/discovery/types';
import {
  DEFAULT_MAX_RADIUS_METRES, MIN_RADIUS_METRES, NEARBY_K, SLIDER_STEPS, buildNearbyVm, radiusFromSlider, radiusLabel, sliderFromRadius,
} from '../src/ui/discovery/nearbyViewModel';
import { MEMORY_ONLY_WARNING, STORED_IN_BROWSER_NOTE, UNRESOLVED_LOADING_TEXT, UNRESOLVED_TEXT, buildSavedVm, collectionMenu, shortDate } from '../src/ui/discovery/savedViewModel';

describe('nearby radius slider', () => {
  it('is logarithmic from 1 AU up to the bound', () => {
    const rel = (a: number, b: number): number => Math.abs(a - b) / b;
    expect(rel(radiusFromSlider(0), METRES_PER_AU)).toBeLessThan(1e-9);
    expect(rel(radiusFromSlider(SLIDER_STEPS), DEFAULT_MAX_RADIUS_METRES)).toBeLessThan(1e-9);
    expect(rel(radiusFromSlider(SLIDER_STEPS / 2), Math.sqrt(METRES_PER_AU * DEFAULT_MAX_RADIUS_METRES))).toBeLessThan(1e-9);
    expect(rel(radiusFromSlider(1e9), DEFAULT_MAX_RADIUS_METRES)).toBeLessThan(1e-9);      // clamped
    expect(rel(radiusFromSlider(-5), METRES_PER_AU)).toBeLessThan(1e-9);
  });
  it('round trips and respects a custom bound', () => {
    const max = 5e8 * METRES_PER_PARSEC;
    for (const t of [0, 100, 500, 999, 1000]) expect(sliderFromRadius(radiusFromSlider(t, max), max)).toBe(t);
    expect(sliderFromRadius(MIN_RADIUS_METRES / 10)).toBe(0);
  });
  it('labels use readable units', () => {
    expect(radiusLabel(METRES_PER_AU)).toMatch(/AU/);
    expect(radiusLabel(5 * METRES_PER_PARSEC)).toBe('5.00 pc');
    expect(radiusLabel(2e6 * METRES_PER_PARSEC)).toMatch(/Mpc/);
  });
});

describe('nearby rows', () => {
  const nb = (id: string, name: string, d: number, text: string) => ({ id, category: 'star' as const, dataset: 'gaia-dr3' as const, distanceMetres: d, distanceText: text, domain: 'heliocentric', name });
  const outcome: NearbyOutcome = {
    ok: true, originFrame: 'stellar-neighbourhood', originId: 'hip:32349',
    neighbours: [nb('hip:37279', 'Procyon', 5e16, '1.61 pc'), nb('hip:32349', 'Sirius', 0, '0'), nb('gaia:1', 'Sirius C', 1e15, '6,857 AU')],
    system: [{ id: 'host:TRAPPIST-1', name: 'TRAPPIST-1', category: 'exoplanet-host', role: 'host' }, { id: 'exo:TRAPPIST-1 b', name: 'TRAPPIST-1 b', category: 'exoplanet', role: 'planet' }],
  };
  it('sorts nearest first, never lists the origin as its own neighbour, all distances positive', () => {
    const vm = buildNearbyVm(outcome, { originName: 'Sirius', radiusMetres: 5 * METRES_PER_PARSEC });
    expect(vm.ok).toBe(true);
    expect(vm.neighbours.map((n) => n.name)).toEqual(['Sirius C', 'Procyon']);
    expect(vm.neighbours.every((n) => n.distanceMetres > 0)).toBe(true);
    expect(vm.neighbours.map((n) => n.id)).not.toContain('hip:32349');
    expect(vm.summary).toBe('2 within 5.00 pc of Sirius, nearest first.');
  });
  it('same-system members are separate from neighbours and have role text', () => {
    const vm = buildNearbyVm(outcome, { originName: 'TRAPPIST-1 e', radiusMetres: METRES_PER_PARSEC });
    expect(vm.system.map((s) => s.roleText)).toEqual(['Host star of this system', 'Planet of this system']);
    expect(vm.neighbours.map((n) => n.id)).not.toContain('host:TRAPPIST-1');
  });
  it('an empty result is a statement about the datasets, not the universe', () => {
    const vm = buildNearbyVm({ ok: true, originFrame: 'x', neighbours: [] }, { originName: 'Sirius', radiusMetres: METRES_PER_AU });
    expect(vm.summary).toMatch(/datasets loaded/);
    expect(vm.summary).toMatch(/not about the universe/);
  });
  it('a full list says more lie inside the radius', () => {
    const many = Array.from({ length: NEARBY_K }, (_, i) => nb(`gaia:${i}`, `S${i}`, 1e15 + i, '1 pc'));
    const vm = buildNearbyVm({ ok: true, originFrame: 'x', neighbours: many }, { originName: 'X', radiusMetres: 1e18 });
    expect(vm.truncated).toBe(true);
    expect(vm.summary).toMatch(/more lie inside this radius/);
  });
  it('failures become plain messages', () => {
    expect(buildNearbyVm({ ok: false, error: 'no-position', message: 'm' }, { originName: 'X', radiusMetres: 1 }).message).toMatch(/no position in 3D/);
    expect(buildNearbyVm({ ok: false, error: 'not-ready', message: 'm' }, { originName: 'X', radiusMetres: 1 }).message).toMatch(/spatial index/);
    expect(buildNearbyVm({ ok: false, error: 'invalid', message: 'There is no camera' }, { originName: 'X', radiusMetres: 1 }).message).toBe('There is no camera');
  });
});

describe('saved model', () => {
  const rec = (id: string, name: string): DiscoveryRecord => ({ id, dataset: 'hipparcos', category: 'star', name, designations: [], classification: '', position: { kind: 'sky-only', raDeg: 0, decDeg: 0 }, measurements: {}, drawn: false, sourceKey: 'x' });
  const known = new Map([['hip:32349', rec('hip:32349', 'Sirius')], ['hip:37279', rec('hip:37279', 'Procyon')]]);
  const must = <T>(r: { ok: true; value: T } | { ok: false; message: string }): T => { if (!r.ok) throw new Error(r.message); return r.value; };
  const make = () => { let k = 0; return new SavedStore({ adapter: new MemoryAdapter(), now: () => new Date('2026-11-13T10:00:00Z'), newId: () => `c${++k}` }); };

  it('lists bookmarks newest first with names, collections with counts', () => {
    const s = make();
    s.addBookmark('hip:32349'); s.addBookmark('hip:37279');
    const col = must(s.createCollection('Nearby'));
    s.addToCollection(col.id, 'hip:32349');
    const vm = buildSavedVm(s.snapshot(), { mode: 'persistent' }, (id) => known.get(id));
    expect(vm.bookmarks.map((b) => b.name)).toEqual(['Procyon', 'Sirius']);
    expect(vm.bookmarks[1]!.collections).toEqual(['Nearby']);
    expect(vm.collections).toMatchObject([{ name: 'Nearby', count: 1, unresolvedCount: 0 }]);
    expect(vm.note).toBe(STORED_IN_BROWSER_NOTE);
    expect(vm.persistence.warning).toBeNull();
  });
  it('shows an unresolved id as unresolved, never drops it', () => {
    const s = make();
    s.addBookmark('hip:32349'); s.addBookmark('exo:Gone b');
    const col = must(s.createCollection('X'));
    s.addToCollection(col.id, 'exo:Gone b');
    s.recordVisit('exo:Gone b');
    const vm = buildSavedVm(s.snapshot(), { mode: 'persistent' }, (id) => known.get(id));
    const gone = vm.bookmarks.find((b) => b.id === 'exo:Gone b')!;
    expect(gone.status).toBe('unresolved');
    expect(gone.statusText).toBe(UNRESOLVED_TEXT);
    expect(gone.name).toBe('exo:Gone b');
    expect(vm.collections[0]!.items[0]!.status).toBe('unresolved');
    expect(vm.collections[0]!.unresolvedCount).toBe(1);
    expect(vm.history[0]!.status).toBe('unresolved');
    expect(vm.unresolvedTotal).toBe(1);
    expect(vm.bookmarks).toHaveLength(2);
  });
  it('while datasets are still loading the reason says so', () => {
    const s = make();
    s.addBookmark('point:twomrs:5');
    const vm = buildSavedVm(s.snapshot(), { mode: 'persistent' }, () => undefined, { datasetsLoading: true });
    expect(vm.bookmarks[0]!.statusText).toBe(UNRESOLVED_LOADING_TEXT);
  });
  it('warns when persistence is memory only', () => {
    const vm = buildSavedVm(make().snapshot(), { mode: 'memory-only', reason: 'localStorage is blocked' }, () => undefined);
    expect(vm.persistence.warning).toContain(MEMORY_ONLY_WARNING);
    expect(vm.persistence.warning).toContain('localStorage is blocked');
    expect(vm.persistence.warning).toMatch(/memory only/);
  });
  it('the collection menu shows every collection with membership', () => {
    const s = make();
    const a = must(s.createCollection('A')), b = must(s.createCollection('B'));
    s.addBookmark('hip:32349'); s.addToCollection(b.id, 'hip:32349');
    expect(collectionMenu(s.snapshot(), 'hip:32349')).toEqual([{ id: a.id, name: 'A', has: false }, { id: b.id, name: 'B', has: true }]);
  });
  it('dates do not depend on the viewer time zone', () => {
    expect(shortDate('2026-11-13T23:59:00Z')).toBe('13 Nov 2026');
    expect(shortDate('nonsense')).toBe('nonsense');
  });
});
