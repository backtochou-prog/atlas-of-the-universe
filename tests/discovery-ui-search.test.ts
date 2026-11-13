import { describe, expect, it } from 'vitest';
import type { AtlasSearchHit, AtlasSearchResult, AtlasStatus, DatasetStatus } from '../src/discovery/engineApi';
import type { DiscoveryRecord } from '../src/discovery/types';
import {
  INVALID_ID_MESSAGE, NOT_DRAWN_TEXT, WINDOW_SIZE, buildSearchView, chipsFor, fuzzyNoteFor, looksLikeIdentifier, moveActive, progressLine, reduceKey, rowFromHit, invalidIdentifierDetail,
} from '../src/ui/discovery/searchViewModel';
import { LatestGuard } from '../src/ui/discovery/latest';
import { distanceTextFor } from '../src/ui/discovery/labels';

const hit = (o: Partial<AtlasSearchHit> & { id: string; name: string }): AtlasSearchHit => ({
  index: 0, category: 'star', dataset: 'hipparcos', matchedDesignation: o.name, matchKind: 'exact', score: 1000, highlight: [], classification: 'Star · A0m...', drawn: true, ...o,
});
const rec = (o: Partial<DiscoveryRecord> & { id: string }): DiscoveryRecord => ({
  dataset: 'hipparcos', category: 'star', name: o.id, designations: [], classification: '', position: { kind: 'icrs', xyzPc: [0, 0, 0], raDeg: 0, decDeg: 0 }, measurements: {}, drawn: true, sourceKey: 'x', ...o,
});
const ds = (key: string, label: string, state: DatasetStatus['state'], count: number | null, error?: string): DatasetStatus => ({ key: key as never, label, stage: 0, state, count, ...(error ? { error } : {}) });
const status = (o: Partial<AtlasStatus> = {}): AtlasStatus => ({
  phase: 'ready', datasets: [ds('gaia', 'Gaia DR3 subset', 'ready', 35325), ds('solar', 'Solar System', 'ready', 29), ds('simbad', 'SIMBAD identifiers', 'ready', 31663), ds('twomrs', '2MASS Redshift Survey', 'loading', null)],
  progress: 1, activity: '', readyForSearch: true, readyForQueries: true, complete: true, searchable: 100, records: 100, failed: [], ...o,
});
const result = (hits: AtlasSearchHit[], o: Partial<AtlasSearchResult> = {}): AtlasSearchResult => ({ query: 'q', normalized: 'q', hits, total: hits.length, totalIsLowerBound: false, categoryCounts: { star: hits.length }, fuzzyUsed: false, ...o });

describe('search rows', () => {
  it('shows category label as text, the name, the distance and no extra marker for a drawn star', () => {
    const r = rowFromHit(hit({ id: 'hip:32349', name: 'Sirius' }), rec({ id: 'hip:32349', measurements: { distancePc: { value: 2.637, kind: 'derived' } } }));
    expect(r.categoryLabel).toBe('Star');
    expect(r.name).toBe('Sirius');
    expect(r.matchedAs).toBeNull();
    expect(r.distanceText).toMatch(/pc|ly/);
    expect(r.notDrawnText).toBeNull();
    expect(r.ariaLabel).toContain('Star');
  });
  it('names the designation that matched when it differs from the name', () => {
    const r = rowFromHit(hit({ id: 'hip:32349', name: 'Sirius', matchedDesignation: 'HIP 32349' }), undefined);
    expect(r.matchedAs).toBe('HIP 32349');
    expect(r.ariaLabel).toContain('matched as HIP 32349');
  });
  it('says "matched “sirus” as Sirius" for a fuzzy match', () => {
    const h = hit({ id: 'hip:32349', name: 'Sirius', matchKind: 'fuzzy', fuzzy: { typed: 'sirus', matched: 'sirius', distance: 1 } });
    expect(fuzzyNoteFor(h)).toBe('matched “sirus” as Sirius');
    expect(rowFromHit(h, undefined).fuzzyNote).toBe('matched “sirus” as Sirius');
  });
  it('uses the published capitalisation of the word inside a longer designation', () => {
    expect(fuzzyNoteFor({ matchedDesignation: 'NAME Sirius B', fuzzy: { typed: 'sirus', matched: 'sirius', distance: 1 } })).toBe('matched “sirus” as Sirius');
  });
  it('marks a record that is not drawn in words', () => {
    const r = rowFromHit(hit({ id: 'gaia:1', name: 'Gaia DR3 1', drawn: false }), rec({ id: 'gaia:1', position: { kind: 'sky-only', raDeg: 1, decDeg: 2 }, drawn: false }));
    expect(r.notDrawn).toBe(true);
    expect(r.notDrawnText).toBe(NOT_DRAWN_TEXT);
    expect(r.distanceText).toBe('distance unknown');
  });
  it('never prints 0 for a missing distance, and a Solar System body says so', () => {
    expect(distanceTextFor(undefined)).toBe('distance unknown');
    expect(distanceTextFor(rec({ id: 'x', measurements: {} }))).toBe('distance unknown');
    expect(distanceTextFor(rec({ id: 'solar:jupiter', position: { kind: 'solar', bodyId: 'jupiter' } }))).toBe('Solar System');
    expect(distanceTextFor(rec({ id: 'x', measurements: { distancePc: { value: 0, kind: 'derived' } } }))).toBe('distance unknown');
  });
  it('row signatures change when anything visible changes (keyed reconciliation)', () => {
    const a = rowFromHit(hit({ id: 'a', name: 'A' }), undefined), b = rowFromHit(hit({ id: 'a', name: 'A', drawn: false }), undefined);
    expect(a.key).toBe(b.key);
    expect(a.sig).not.toBe(b.sig);
  });
});

describe('category chips', () => {
  it('count per group from the category counts, All = total', () => {
    const chips = chipsFor({ star: 10, 'exoplanet-host': 2, galaxy: 3, nebula: 1, 'supernova-remnant': 1 }, 'all');
    const by = Object.fromEntries(chips.map((c) => [c.id, c.count]));
    expect(by).toMatchObject({ all: 17, stars: 12, galaxies: 3, nebulae: 2, planets: 0, moons: 0, exoplanets: 0, clusters: 0, groups: 0, other: 0 });
    expect(chips.map((c) => c.label)).toEqual(['All', 'Stars', 'Planets', 'Moons', 'Exoplanets', 'Galaxies', 'Nebulae', 'Clusters', 'Groups', 'Other']);
    expect(chips.find((c) => c.active)?.id).toBe('all');
  });
});

describe('search view states', () => {
  const records = new Map<string, DiscoveryRecord>();
  it('results: rows in the engine order, windowed to 40 with an honest line', () => {
    const hits = Array.from({ length: 60 }, (_, i) => hit({ id: `hip:${i + 1}`, name: `Star ${i + 1}` }));
    const v = buildSearchView({ query: 'hip', status: status(), group: 'all', result: result(hits, { total: 1203 }), records });
    if (v.kind !== 'results') throw new Error(v.kind);
    expect(v.rows).toHaveLength(WINDOW_SIZE);
    expect(v.rows[0]!.id).toBe('hip:1');
    expect(v.windowText).toBe('showing 40 of 1,203; refine the query');
  });
  it('a lower bound total says so', () => {
    const v = buildSearchView({ query: 'a', status: status(), group: 'all', result: result([hit({ id: 'a', name: 'A' })], { total: 6000, totalIsLowerBound: true }), records });
    if (v.kind !== 'results') throw new Error(v.kind);
    expect(v.windowText).toContain('6,000+');
  });
  it('no window text when everything is shown', () => {
    const v = buildSearchView({ query: 'a', status: status(), group: 'all', result: result([hit({ id: 'a', name: 'A' })]), records });
    if (v.kind !== 'results') throw new Error(v.kind);
    expect(v.windowText).toBeNull();
  });
  it('empty: says nothing matches in the datasets loaded, lists the searchable datasets with counts, and fabricates no suggestion', () => {
    const v = buildSearchView({ query: 'zzzzqq', status: status({ complete: false, progress: 0.63 }), group: 'all', result: result([], { total: 0, categoryCounts: {} }), records });
    if (v.kind !== 'empty') throw new Error(v.kind);
    expect(v.message).toBe('Nothing matches “zzzzqq” in the datasets loaded.');
    expect(v.datasets.map((d) => d.label)).toEqual(['Gaia DR3 subset', 'Solar System', '2MASS Redshift Survey']);   // SIMBAD is an identifier source, not a searchable dataset
    expect(v.datasets[0]!.count).toBe(35325);
    expect(v.datasets[2]!.state).toBe('loading');
    expect(v.progress).toMatch(/Indexing 63%/);
    expect(JSON.stringify(v)).not.toMatch(/did you mean/i);
  });
  it('empty inside a category chip names the category', () => {
    const v = buildSearchView({ query: 'sirius', status: status(), group: 'galaxies', result: result([], { total: 0, categoryCounts: { star: 2 } }), records });
    if (v.kind !== 'empty') throw new Error(v.kind);
    expect(v.message).toContain('in galaxies');
    expect(v.chips.find((c) => c.id === 'stars')!.count).toBe(2);   // other categories still show their counts so the user can switch
  });
  it('invalid identifier forms get the specific message', () => {
    for (const q of ['HIP 99999999', 'Gaia DR3 12', 'hd 0', 'NGC 99999999']) {
      expect(looksLikeIdentifier(q)).toBe(true);
      const v = buildSearchView({ query: q, status: status(), group: 'all', result: result([], { total: 0, categoryCounts: {} }), records });
      if (v.kind !== 'invalid-id') throw new Error(`${q}: ${v.kind}`);
      expect(v.message).toBe(INVALID_ID_MESSAGE);
      expect(v.message).toContain('subset of the catalogue');
    }
    expect(invalidIdentifierDetail('HIP 99999999')).toMatch(/1 to 120404/);
    expect(invalidIdentifierDetail('Gaia DR3 12')).toMatch(/at least 10 digits/);
    expect(invalidIdentifierDetail('HIP 32349')).toBeNull();
  });
  it('a plain word with no match is NOT treated as an identifier', () => {
    expect(looksLikeIdentifier('zzzzqq')).toBe(false);
    expect(looksLikeIdentifier('Sirius')).toBe(false);
    expect(looksLikeIdentifier('mars')).toBe(false);
  });
  it('a query the engine rejected asks for more characters', () => {
    const v = buildSearchView({ query: 'a', status: status(), group: 'all', result: result([], { total: 0, normalized: null }), records });
    if (v.kind !== 'empty') throw new Error(v.kind);
    expect(v.message).toMatch(/at least two/);
  });
  it('idle (empty query): recent and featured rows, no fabricated objects', () => {
    const v = buildSearchView({
      query: '', status: status(), group: 'all', records: new Map([['solar:sun', rec({ id: 'solar:sun', position: { kind: 'solar', bodyId: 'sun' } })]]),
      history: [{ id: 'hip:1', name: 'Recent', category: 'star', classification: 'Star' }], featured: [{ id: 'solar:sun', name: 'Sun', category: 'star', classification: 'Star · G2V' }],
    });
    if (v.kind !== 'idle') throw new Error(v.kind);
    expect(v.recent.map((r) => r.name)).toEqual(['Recent']);
    expect(v.featured[0]!.distanceText).toBe('Solar System');
  });
  it('indexing: before the first index exists the box says so with a percentage', () => {
    const s = status({ readyForSearch: false, readyForQueries: false, complete: false, progress: 0.21 });
    const v = buildSearchView({ query: 'sir', status: s, group: 'all', records });
    if (v.kind !== 'indexing') throw new Error(v.kind);
    expect(v.message).toMatch(/Indexing 21%/);
  });
  it('progress line names the datasets that are already searchable', () => {
    const line = progressLine(status({ complete: false, readyForQueries: false, progress: 0.63 }))!;
    expect(line).toMatch(/^Indexing 63%: names in Gaia DR3 subset, Solar System are already searchable/);
    expect(progressLine(status())).toBeNull();
  });
});

describe('keyboard model', () => {
  const s = (o: Partial<{ open: boolean; active: number; count: number; query: string }> = {}) => ({ open: true, active: -1, count: 5, query: 'sir', ...o });
  it('active index wraps in both directions', () => {
    expect(moveActive(-1, 5, 'next')).toBe(0);
    expect(moveActive(4, 5, 'next')).toBe(0);
    expect(moveActive(-1, 5, 'prev')).toBe(4);
    expect(moveActive(0, 5, 'prev')).toBe(4);
    expect(moveActive(2, 5, 'first')).toBe(0);
    expect(moveActive(2, 5, 'last')).toBe(4);
    expect(moveActive(0, 0, 'next')).toBe(-1);
  });
  it('ArrowDown / ArrowUp / Home / End', () => {
    expect(reduceKey(s(), { key: 'ArrowDown' })).toEqual({ type: 'move', index: 0 });
    expect(reduceKey(s({ active: 4 }), { key: 'ArrowDown' })).toEqual({ type: 'move', index: 0 });
    expect(reduceKey(s({ active: 0 }), { key: 'ArrowUp' })).toEqual({ type: 'move', index: 4 });
    expect(reduceKey(s({ active: 2 }), { key: 'Home' })).toEqual({ type: 'move', index: 0 });
    expect(reduceKey(s({ active: 2 }), { key: 'End' })).toEqual({ type: 'move', index: 4 });
  });
  it('Home / End stay with the text caret until a row is active', () => {
    expect(reduceKey(s({ active: -1 }), { key: 'Home' })).toEqual({ type: 'none' });
    expect(reduceKey(s({ active: -1 }), { key: 'End' })).toEqual({ type: 'none' });
  });
  it('ArrowDown on a closed list opens it', () => {
    expect(reduceKey(s({ open: false }), { key: 'ArrowDown' })).toEqual({ type: 'open', active: 0 });
  });
  it('Enter chooses the active row (or the first when none) and flies; Shift+Enter inspects without flying', () => {
    expect(reduceKey(s({ active: 2 }), { key: 'Enter' })).toEqual({ type: 'choose', index: 2, fly: true });
    expect(reduceKey(s({ active: -1 }), { key: 'Enter' })).toEqual({ type: 'choose', index: 0, fly: true });
    expect(reduceKey(s({ active: 1 }), { key: 'Enter', shiftKey: true })).toEqual({ type: 'choose', index: 1, fly: false });
    expect(reduceKey(s({ count: 0 }), { key: 'Enter' })).toEqual({ type: 'none' });
    expect(reduceKey(s({ open: false }), { key: 'Enter' })).toEqual({ type: 'none' });
  });
  it('Escape clears and closes; with nothing to clear it leaves the box', () => {
    expect(reduceKey(s(), { key: 'Escape' })).toEqual({ type: 'close', clear: true });
    expect(reduceKey(s({ open: false, query: 'x' }), { key: 'Escape' })).toEqual({ type: 'close', clear: true });
    expect(reduceKey(s({ open: false, query: '' }), { key: 'Escape' })).toEqual({ type: 'blur' });
  });
  it('Tab is not handled (the browser moves focus out) and modifier combinations are left alone', () => {
    expect(reduceKey(s(), { key: 'Tab' })).toEqual({ type: 'none' });
    expect(reduceKey(s(), { key: 'ArrowDown', altKey: true })).toEqual({ type: 'none' });
    expect(reduceKey(s(), { key: 'Enter', ctrlKey: true })).toEqual({ type: 'none' });
  });
});

describe('stale response guard', () => {
  it('only the newest request may apply its answer, whatever order the answers arrive in', async () => {
    const guard = new LatestGuard();
    const applied: string[] = [];
    const ask = (q: string, ms: number): Promise<void> => {
      const token = guard.next();
      return new Promise<void>((resolve) => setTimeout(() => { if (guard.isCurrent(token)) applied.push(q); resolve(); }, ms));
    };
    await Promise.all([ask('s', 30), ask('si', 20), ask('sir', 5)]);   // the slowest answer belongs to the OLDEST request and arrives last
    expect(applied).toEqual(['sir']);
  });
  it('cancel() invalidates everything in flight', () => {
    const g = new LatestGuard();
    const t = g.next();
    g.cancel();
    expect(g.isCurrent(t)).toBe(false);
  });
});
