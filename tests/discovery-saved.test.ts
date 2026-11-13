import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_STORAGE_KEY, LocalStorageAdapter, MemoryAdapter, SavedStore, mergeSavedStates, sanitizeState, validateName, isValidId, type SavedChange, type SavedState, type StorageLike } from '../src/discovery/saved';

function clock(start = '2026-11-13T10:00:00.000Z') {
  let t = Date.parse(start);
  return { now: () => new Date(t), tick: (ms = 1000) => { t += ms; } };
}
let n = 0;
const ids = () => `col-${++n}`;
function make(opts: { adapter?: MemoryAdapter; limits?: Partial<import('../src/discovery/saved').SavedLimits> } = {}) {
  const c = clock();
  const adapter = opts.adapter ?? new MemoryAdapter();
  let k = 0;
  const store = new SavedStore({ adapter, now: c.now, newId: () => `c${++k}`, ...(opts.limits ? { limits: opts.limits } : {}) });
  return { store, adapter, c };
}
const must = <T>(r: { ok: true; value: T } | { ok: false; message: string }): T => { if (!r.ok) throw new Error(r.message); return r.value; };

describe('storage adapters', () => {
  it('MemoryAdapter is a map', () => {
    const a = new MemoryAdapter();
    expect(a.getItem('k')).toBeNull();
    a.setItem('k', 'v');
    expect(a.getItem('k')).toBe('v');
    a.removeItem('k');
    expect(a.getItem('k')).toBeNull();
    expect(a.persistence().mode).toBe('memory-only');
  });
  const web = (): StorageLike & { data: Map<string, string> } => { const data = new Map<string, string>(); return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: (k) => { data.delete(k); } }; };
  it('LocalStorageAdapter persists when storage works', () => {
    const w = web();
    const a = new LocalStorageAdapter(() => w);
    a.setItem('a', '1');
    expect(w.data.get('a')).toBe('1');
    expect(a.getItem('a')).toBe('1');
    expect(a.persistence()).toEqual({ mode: 'persistent' });
    a.removeItem('a');
    expect(w.data.has('a')).toBe(false);
  });
  it('accessing localStorage can throw (blocked): falls back to memory and reports it', () => {
    const a = new LocalStorageAdapter(() => { throw new DOMException('denied', 'SecurityError'); });
    expect(a.getItem('x')).toBeNull();
    a.setItem('x', 'kept');
    expect(a.getItem('x')).toBe('kept');
    const p = a.persistence();
    expect(p.mode).toBe('memory-only');
    expect(p.reason).toMatch(/blocked/);
    a.removeItem('x');
    expect(a.getItem('x')).toBeNull();
  });
  it('storage missing (undefined) is memory only', () => {
    const a = new LocalStorageAdapter(() => undefined);
    a.setItem('x', '1');
    expect(a.getItem('x')).toBe('1');
    expect(a.persistence().mode).toBe('memory-only');
  });
  it('a full storage (quota) falls back to memory without losing the write', () => {
    const w = web();
    const full: StorageLike = { ...w, setItem: () => { throw new DOMException('quota', 'QuotaExceededError'); } };
    const a = new LocalStorageAdapter(() => full);
    a.setItem('big', 'data');
    expect(a.getItem('big')).toBe('data');
    expect(a.persistence()).toMatchObject({ mode: 'memory-only' });
    expect(a.persistence().reason).toMatch(/full or blocked/);
  });
  it('reads that throw are survived', () => {
    const bad: StorageLike = { getItem: () => { throw new Error('boom'); }, setItem: () => undefined, removeItem: () => undefined };
    const a = new LocalStorageAdapter(() => bad);
    expect(a.getItem('x')).toBeNull();
    expect(a.persistence().mode).toBe('memory-only');
  });
  it('a store on a blocked localStorage works and says persistence is memory only', () => {
    const a = new LocalStorageAdapter(() => { throw new Error('no'); });
    const s = new SavedStore({ adapter: a });
    expect(must(s.addBookmark('gaia:1')).id).toBe('gaia:1');
    expect(s.persistence().mode).toBe('memory-only');
    expect(s.isBookmarked('gaia:1')).toBe(true);
  });
});

describe('versioned document, recovery, migration', () => {
  it('starts empty and writes schema v1 with a revision', () => {
    const { store, adapter } = make();
    expect(store.loadReport).toEqual({ status: 'empty', dropped: 0 });
    store.addBookmark('solar:earth');
    const doc = JSON.parse(adapter.getItem(DEFAULT_STORAGE_KEY)!);
    expect(doc).toMatchObject({ schema: 'atlas-saved', version: 1, revision: 1 });
    expect(doc.bookmarks).toEqual([{ id: 'solar:earth', savedAt: '2026-11-13T10:00:00.000Z' }]);
  });
  it('reloads exactly what was saved', () => {
    const a = make();
    a.store.addBookmark('solar:earth', 'home');
    const col = must(a.store.createCollection('Planets'));
    a.store.addToCollection(col.id, 'solar:mars');
    a.store.recordVisit('deep:m31', { dataset: 'deep-space', context: 'search: andromeda' });
    const b = new SavedStore({ adapter: a.adapter, now: a.c.now });
    expect(b.loadReport.status).toBe('loaded');
    expect(b.snapshot()).toEqual(a.store.snapshot());
  });
  it('corrupt JSON recovers to empty, never throws, and keeps a backup', () => {
    const adapter = new MemoryAdapter();
    adapter.setItem(DEFAULT_STORAGE_KEY, '{"schema":"atlas-saved","version":1,"bookm');
    const s = new SavedStore({ adapter });
    expect(s.loadReport.status).toBe('recovered-corrupt');
    expect(s.loadReport.backupKey).toBe(`${DEFAULT_STORAGE_KEY}.backup`);
    expect(adapter.getItem(`${DEFAULT_STORAGE_KEY}.backup`)).toBe('{"schema":"atlas-saved","version":1,"bookm');
    expect(s.bookmarks()).toEqual([]);
    s.addBookmark('gaia:5');                                     // usable afterwards
    expect(new SavedStore({ adapter }).isBookmarked('gaia:5')).toBe(true);
    expect(adapter.getItem(`${DEFAULT_STORAGE_KEY}.backup`)).toContain('"bookm');   // the backup is still there
  });
  it('JSON that is not an object is recovered too', () => {
    for (const raw of ['null', '3', '"text"', 'true']) {
      const adapter = new MemoryAdapter();
      adapter.setItem(DEFAULT_STORAGE_KEY, raw);
      const s = new SavedStore({ adapter });
      expect(s.loadReport.status, raw).toMatch(/recovered/);
      expect(adapter.getItem(`${DEFAULT_STORAGE_KEY}.backup`)).toBe(raw);
    }
  });
  it('a document from a newer version is backed up, not overwritten silently, and not interpreted', () => {
    const adapter = new MemoryAdapter();
    const future = JSON.stringify({ schema: 'atlas-saved', version: 2, bookmarks: [{ id: 'gaia:1', savedAt: '2026-01-01T00:00:00Z' }] });
    adapter.setItem(DEFAULT_STORAGE_KEY, future);
    const s = new SavedStore({ adapter });
    expect(s.loadReport).toMatchObject({ status: 'recovered-future-version', fromVersion: 2 });
    expect(adapter.getItem(`${DEFAULT_STORAGE_KEY}.backup`)).toBe(future);
    expect(s.bookmarks()).toEqual([]);
  });
  it('migrates the version-0 prototype shape', () => {
    const adapter = new MemoryAdapter();
    adapter.setItem(DEFAULT_STORAGE_KEY, JSON.stringify({ bookmarks: ['gaia:1', 'deep:m31', 5], history: ['gaia:1'] }));
    const c = clock();
    const s = new SavedStore({ adapter, now: c.now });
    expect(s.loadReport).toMatchObject({ status: 'migrated', fromVersion: 0 });
    expect(s.bookmarks().map((b) => b.id).sort()).toEqual(['deep:m31', 'gaia:1']);
    expect(s.history()).toHaveLength(1);
    expect(s.bookmarks()[0]!.savedAt).toBe('2026-11-13T10:00:00.000Z');
  });
  it('a failing migration is recovered, not thrown', () => {
    const adapter = new MemoryAdapter();
    adapter.setItem(DEFAULT_STORAGE_KEY, JSON.stringify({ version: 0 }));
    const s = new SavedStore({ adapter, migrations: { 0: () => { throw new Error('bad'); } } });
    expect(s.loadReport.status).toBe('recovered-invalid');
    expect(adapter.getItem(`${DEFAULT_STORAGE_KEY}.backup`)).not.toBeNull();
  });
  it('a missing migration step is recovered', () => {
    const adapter = new MemoryAdapter();
    adapter.setItem(DEFAULT_STORAGE_KEY, JSON.stringify({ version: 0 }));
    expect(new SavedStore({ adapter, migrations: {} }).loadReport.status).toBe('recovered-invalid');
  });
  it('invalid items inside a valid document are dropped and counted', () => {
    const adapter = new MemoryAdapter();
    adapter.setItem(DEFAULT_STORAGE_KEY, JSON.stringify({
      schema: 'atlas-saved', version: 1, revision: 3,
      bookmarks: [{ id: 'gaia:1', savedAt: '2026-01-01T00:00:00Z' }, { id: 'bad id', savedAt: '2026-01-01T00:00:00Z' }, { id: 'gaia:1', savedAt: '2026-01-02T00:00:00Z' }, null, { id: 'gaia:2', savedAt: 'yesterday' }],
      collections: [{ id: 'c1', name: 'Good', createdAt: '2026-01-01T00:00:00Z', items: ['gaia:1', 'gaia:1', 'nope', 'solar:mars'] }, { id: 'c2', name: '', createdAt: '2026-01-01T00:00:00Z', items: [] }, { id: 'c3', name: 'good', createdAt: '2026-01-01T00:00:00Z', items: [] }],
      history: [{ id: 'gaia:1', at: '2026-01-01T00:00:00Z', dataset: 'gaia-dr3' }, { id: 'x', at: 'z' }, { id: 'gaia:1', at: '2026-01-01T00:00:00Z', dataset: 'made-up' }],
    }));
    const s = new SavedStore({ adapter });
    expect(s.loadReport.status).toBe('loaded');
    expect(s.loadReport.dropped).toBeGreaterThanOrEqual(7);
    expect(s.bookmarks().map((b) => b.id).sort()).toEqual(['gaia:1', 'solar:mars']);       // solar:mars is a collection item, so it is also a bookmark
    expect(s.collections().map((c) => [c.name, c.items])).toEqual([['Good', ['gaia:1', 'solar:mars']]]);
    expect(s.history().map((h) => h.dataset)).toEqual([undefined, 'gaia-dr3']);
    expect(s.revision).toBe(3);
  });
});

describe('bookmarks', () => {
  it('add, idempotent re-add, note, remove', () => {
    const { store, c } = make();
    const b = must(store.addBookmark('gaia:123', 'nice'));
    expect(b).toEqual({ id: 'gaia:123', savedAt: '2026-11-13T10:00:00.000Z', note: 'nice' });
    c.tick();
    expect(must(store.addBookmark('gaia:123'))).toEqual(b);                          // no change, no new time
    expect(store.revision).toBe(1);
    expect(must(store.addBookmark('gaia:123', 'newer')).savedAt).toBe(b.savedAt);    // note replaced, savedAt kept
    expect(must(store.setNote('gaia:123', '')).note).toBeUndefined();
    expect(store.bookmarks()).toHaveLength(1);
    expect(must(store.removeBookmark('gaia:123'))).toBe(true);
    expect(store.isBookmarked('gaia:123')).toBe(false);
  });
  it('newest first', () => {
    const { store, c } = make();
    store.addBookmark('a:1'); c.tick(); store.addBookmark('a:2'); c.tick(); store.addBookmark('a:3');
    expect(store.bookmarks().map((b) => b.id)).toEqual(['a:3', 'a:2', 'a:1']);
  });
  it('invalid ids and notes are refused with a code', () => {
    const { store } = make();
    for (const id of ['', 'nocolon', 'UPPER:x', 'a:', 'a: b\u0000', 'x'.repeat(300), undefined as never, 5 as never, null as never]) {
      const r = store.addBookmark(id);
      expect(r.ok, String(id).slice(0, 10)).toBe(false);
      if (!r.ok) expect(r.error).toBe('invalid-id');
    }
    const r = store.addBookmark('a:1', 'x'.repeat(5000));
    expect(r.ok).toBe(false);
    expect(store.bookmarks()).toHaveLength(0);
    expect(isValidId('exo:Kepler-452 b')).toBe(true);                                   // planet names contain spaces
    expect(isValidId('point:ungc:12')).toBe(true);
  });
  it('removing or noting something not bookmarked is not-found', () => {
    const { store } = make();
    expect(store.removeBookmark('a:1')).toMatchObject({ ok: false, error: 'not-found' });
    expect(store.setNote('a:1', 'x')).toMatchObject({ ok: false, error: 'not-found' });
  });
  it('limits', () => {
    const { store } = make({ limits: { maxBookmarks: 2 } });
    store.addBookmark('a:1'); store.addBookmark('a:2');
    expect(store.addBookmark('a:3')).toMatchObject({ ok: false, error: 'limit' });
    expect(store.addBookmark('a:1')).toMatchObject({ ok: true });                       // existing one still fine
  });
});

describe('collections', () => {
  it('create, rename, reorder, delete with unique ids and names', () => {
    const { store } = make();
    const a = must(store.createCollection('  Nearby   stars '));
    expect(a.name).toBe('Nearby stars');
    const b = must(store.createCollection('Galaxies'));
    expect(a.id).not.toBe(b.id);
    expect(store.createCollection('nearby STARS')).toMatchObject({ ok: false, error: 'duplicate-name' });
    expect(store.renameCollection(b.id, 'Nearby stars')).toMatchObject({ ok: false, error: 'duplicate-name' });
    expect(must(store.renameCollection(b.id, 'Galaxies I like')).name).toBe('Galaxies I like');
    expect(must(store.renameCollection(a.id, 'nearby stars')).name).toBe('nearby stars');   // renaming to its own name in other case is allowed
    expect(must(store.reorderCollections([b.id, a.id])).map((c) => c.id)).toEqual([b.id, a.id]);
    expect(store.collections().map((c) => c.id)).toEqual([b.id, a.id]);
    expect(must(store.deleteCollection(a.id))).toBe(true);
    expect(store.collections()).toHaveLength(1);
    expect(store.deleteCollection('missing')).toMatchObject({ ok: false, error: 'not-found' });
    expect(store.renameCollection('missing', 'x')).toMatchObject({ ok: false, error: 'not-found' });
  });
  it('name validation', () => {
    const { store } = make();
    for (const bad of ['', '   ', 'x'.repeat(61), 'bad\u0007name', 5 as never, undefined as never]) expect(store.createCollection(bad), JSON.stringify(bad)).toMatchObject({ ok: false, error: 'invalid-name' });
    expect(validateName('x'.repeat(60)).ok).toBe(true);
    expect(store.createCollection('Zürich ☆ Sterne')).toMatchObject({ ok: true });
  });
  it('reorder must be a permutation', () => {
    const { store } = make();
    const a = must(store.createCollection('A')), b = must(store.createCollection('B'));
    for (const order of [[a.id], [a.id, a.id], [a.id, 'zzz'], [a.id, b.id, 'extra'], []]) expect(store.reorderCollections(order), JSON.stringify(order)).toMatchObject({ ok: false, error: 'invalid-order' });
    expect(store.collections().map((c) => c.id)).toEqual([a.id, b.id]);
  });
  it('items: add (auto-bookmark), duplicates refused, one bookmark in several collections, move, remove', () => {
    const { store } = make();
    const a = must(store.createCollection('A')), b = must(store.createCollection('B'));
    must(store.addToCollection(a.id, 'gaia:1'));
    must(store.addToCollection(a.id, 'gaia:2'));
    must(store.addToCollection(b.id, 'gaia:1'));
    expect(store.addToCollection(a.id, 'gaia:1')).toMatchObject({ ok: false, error: 'invalid-input' });
    expect(store.isBookmarked('gaia:1')).toBe(true);
    expect(store.collectionsContaining('gaia:1').map((c) => c.name)).toEqual(['A', 'B']);
    expect(store.bookmarks()).toHaveLength(2);
    must(store.addToCollection(a.id, 'gaia:3'));
    expect(must(store.moveInCollection(a.id, 'gaia:3', 0)).items).toEqual(['gaia:3', 'gaia:1', 'gaia:2']);
    expect(must(store.moveInCollection(a.id, 'gaia:3', 2)).items).toEqual(['gaia:1', 'gaia:2', 'gaia:3']);
    expect(store.moveInCollection(a.id, 'gaia:3', 3)).toMatchObject({ ok: false, error: 'invalid-order' });
    expect(store.moveInCollection(a.id, 'gaia:9', 0)).toMatchObject({ ok: false, error: 'not-found' });
    expect(must(store.removeFromCollection(a.id, 'gaia:2')).items).toEqual(['gaia:1', 'gaia:3']);
    expect(store.isBookmarked('gaia:2')).toBe(true);                                    // removing from a collection keeps the bookmark
    expect(store.removeFromCollection(a.id, 'gaia:2')).toMatchObject({ ok: false, error: 'not-found' });
    expect(store.addToCollection('missing', 'gaia:1')).toMatchObject({ ok: false, error: 'not-found' });
    expect(store.addToCollection(a.id, 'bad id')).toMatchObject({ ok: false, error: 'invalid-id' });
  });
  it('deleting a collection keeps the bookmarks; removing a bookmark removes it from every collection', () => {
    const { store } = make();
    const a = must(store.createCollection('A')), b = must(store.createCollection('B'));
    store.addToCollection(a.id, 'gaia:1'); store.addToCollection(b.id, 'gaia:1'); store.addToCollection(b.id, 'gaia:2');
    store.deleteCollection(a.id);
    expect(store.isBookmarked('gaia:1')).toBe(true);
    store.removeBookmark('gaia:1');
    expect(store.collection(b.id)!.items).toEqual(['gaia:2']);
  });
  it('limits on collections and items', () => {
    const { store } = make({ limits: { maxCollections: 2, maxItemsPerCollection: 1 } });
    const a = must(store.createCollection('A'));
    must(store.createCollection('B'));
    expect(store.createCollection('C')).toMatchObject({ ok: false, error: 'limit' });
    must(store.addToCollection(a.id, 'a:1'));
    expect(store.addToCollection(a.id, 'a:2')).toMatchObject({ ok: false, error: 'limit' });
    expect(store.isBookmarked('a:2')).toBe(false);                                      // a refused add changes nothing
  });
  it('default collection ids are unique and independent of the clock', () => {
    const adapter = new MemoryAdapter();
    const c = clock();
    const s = new SavedStore({ adapter, now: c.now });
    const x = must(s.createCollection('X')), y = must(s.createCollection('Y'));
    expect(x.id).not.toBe(y.id);
  });
});

describe('history', () => {
  it('records newest first with time and dataset context; consecutive duplicates collapse', () => {
    const { store, c } = make();
    must(store.recordVisit('gaia:1', { dataset: 'gaia-dr3', context: 'search: barnard' }));
    c.tick();
    expect(must(store.recordVisit('gaia:1'))).toBeNull();                                  // same as the last visit
    c.tick();
    must(store.recordVisit('solar:earth', { dataset: 'solar-system' }));
    c.tick();
    must(store.recordVisit('gaia:1'));                                                     // not consecutive: a new entry
    expect(store.history().map((h) => h.id)).toEqual(['gaia:1', 'solar:earth', 'gaia:1']);
    expect(store.history()[2]).toEqual({ id: 'gaia:1', at: '2026-11-13T10:00:00.000Z', dataset: 'gaia-dr3', context: 'search: barnard' });
    expect(store.history()[1]!.at).toBe('2026-11-13T10:00:02.000Z');
  });
  it('is capped at 200 (oldest dropped)', () => {
    const { store } = make();
    for (let i = 0; i < 260; i++) store.recordVisit(`a:${i}`);
    const h = store.history();
    expect(h).toHaveLength(200);
    expect(h[0]!.id).toBe('a:259');
    expect(h[199]!.id).toBe('a:60');
  });
  it('clear, and an invalid id is refused; unknown dataset context is ignored', () => {
    const { store } = make();
    store.recordVisit('a:1', { dataset: 'not-a-dataset' as never });
    expect(store.history()[0]!.dataset).toBeUndefined();
    expect(store.recordVisit('bad')).toMatchObject({ ok: false, error: 'invalid-id' });
    expect(must(store.clearHistory())).toBe(true);
    expect(store.history()).toEqual([]);
    expect(must(store.clearHistory())).toBe(true);
  });
});

describe('unresolved ids are reported, never dropped', () => {
  it('resolveBookmarks and unresolvedIds', () => {
    const { store } = make();
    store.addBookmark('gaia:1'); store.addBookmark('gaia:gone');
    const col = must(store.createCollection('C'));
    store.addToCollection(col.id, 'deep:gone');
    store.recordVisit('hip:gone');
    const known = new Map([['gaia:1', { name: 'One' }]]);
    const r = store.resolveBookmarks((id) => known.get(id));
    expect(r.map((x) => [x.bookmark.id, x.status])).toEqual([['deep:gone', 'unresolved'], ['gaia:gone', 'unresolved'], ['gaia:1', 'resolved']]);
    expect(r.find((x) => x.status === 'resolved')!.record).toEqual({ name: 'One' });
    expect(store.unresolvedIds((id) => known.get(id)).sort()).toEqual(['deep:gone', 'gaia:gone', 'hip:gone']);
    expect(store.bookmarks()).toHaveLength(3);                                           // nothing was removed
  });
});

describe('export and import', () => {
  function populated() {
    const m = make();
    m.store.addBookmark('gaia:1', 'note one'); m.c.tick();
    m.store.addBookmark('gaia:2');
    const col = must(m.store.createCollection('Mine'));
    m.store.addToCollection(col.id, 'gaia:1');
    m.store.recordVisit('gaia:2', { dataset: 'gaia-dr3' });
    return m;
  }
  it('round trip into an empty store', () => {
    const src = populated();
    const json = src.store.exportJson();
    expect(JSON.parse(json).schema).toBe('atlas-saved-export/1');
    const dst = make();
    const rep = dst.store.importJson(json);
    expect(rep).toMatchObject({ ok: true, mode: 'merge', bookmarksAdded: 2, collectionsAdded: 1, itemsAdded: 1, historyAdded: 1, dropped: 0 });
    expect(dst.store.bookmarks()).toEqual(src.store.bookmarks());
    expect(dst.store.collections().map((c) => [c.name, c.items])).toEqual([['Mine', ['gaia:1']]]);
    expect(dst.store.history()).toEqual(src.store.history());
  });
  it('merge keeps existing data, adds new, keeps the earlier savedAt and the local note, matches collections by name', () => {
    const src = populated();
    const dst = make();
    dst.c.tick(5000);
    dst.store.addBookmark('gaia:1', 'my own note');
    const mine = must(dst.store.createCollection('mine'));                                  // same name, other case
    dst.store.addToCollection(mine.id, 'gaia:9');
    const rep = dst.store.importJson(src.store.exportJson(), { mode: 'merge' });
    expect(rep.ok).toBe(true);
    expect(rep.collectionsAdded).toBe(0);
    const g1 = dst.store.bookmarks().find((b) => b.id === 'gaia:1')!;
    expect(g1.note).toBe('my own note');
    expect(g1.savedAt).toBe('2026-11-13T10:00:00.000Z');                                    // the earlier of the two
    expect(dst.store.collection(mine.id)!.items).toEqual(['gaia:9', 'gaia:1']);
    expect(dst.store.bookmarks().map((b) => b.id).sort()).toEqual(['gaia:1', 'gaia:2', 'gaia:9']);
    const again = dst.store.importJson(src.store.exportJson());                             // idempotent
    expect(again).toMatchObject({ ok: true, bookmarksAdded: 0, collectionsAdded: 0, itemsAdded: 0, historyAdded: 0 });
  });
  it('replace discards the current data', () => {
    const src = populated();
    const dst = make();
    dst.store.addBookmark('x:old');
    const rep = dst.store.importJson(src.store.exportJson(), { mode: 'replace' });
    expect(rep.ok).toBe(true);
    expect(dst.store.isBookmarked('x:old')).toBe(false);
    expect(dst.store.bookmarks()).toHaveLength(2);
    expect(dst.store.revision).toBeGreaterThan(1);                 // the revision keeps counting; it is not reset by a replace
  });
  it('accepts the raw storage document as well', () => {
    const src = populated();
    const dst = make();
    expect(dst.store.importJson(src.adapter.getItem(DEFAULT_STORAGE_KEY)!)).toMatchObject({ ok: true, bookmarksAdded: 2 });
  });
  it('never trusts the input: bad JSON, wrong shapes, hostile values, oversize', () => {
    const { store } = make();
    store.addBookmark('keep:1');
    for (const bad of ['', 'not json', 'null', '[]', '{}', '42', '{"state":5}', JSON.stringify({ schema: 'atlas-saved-export/1', state: 'x' })]) {
      const r = store.importJson(bad);
      expect(r.ok, bad).toBe(false);
      expect(r.message).toBeTruthy();
    }
    const hostile = JSON.stringify({
      schema: 'atlas-saved-export/1',
      state: {
        __proto__: { polluted: true }, constructor: { prototype: { polluted: true } },
        bookmarks: [{ id: 'ok:1', savedAt: '2026-01-01T00:00:00Z', note: 'n', evil: '<script>' }, { id: '<img src=x onerror=alert(1)>', savedAt: '2026-01-01T00:00:00Z' }, { id: 'ok:2', savedAt: 'not a date' }],
        collections: [{ id: 'c', name: '<b>bold</b>', createdAt: '2026-01-01T00:00:00Z', items: ['ok:1', { toString: 1 }] }],
        history: 'nope',
      },
    });
    const r = store.importJson(hostile);
    expect(r.ok).toBe(true);
    expect(r.dropped).toBeGreaterThanOrEqual(3);
    expect(store.bookmarks().map((b) => b.id).sort()).toEqual(['keep:1', 'ok:1']);
    expect(store.bookmarks().find((b) => b.id === 'ok:1')).not.toHaveProperty('evil');
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(store.importJson('x'.repeat(5_000_000)).ok).toBe(false);
    expect(store.importJson(undefined as never).ok).toBe(false);
  });
  it('a file with nothing readable fails instead of silently importing nothing', () => {
    const { store } = make();
    const r = store.importJson(JSON.stringify({ bookmarks: [{ id: 'bad' }, { id: 'also bad' }] }));
    expect(r.ok).toBe(false);
  });
  it('refuses an import that would exceed the limits and changes nothing', () => {
    const src = populated();
    const dst = make({ limits: { maxBookmarks: 1 } });
    dst.store.addBookmark('only:1');
    const before = dst.store.snapshot();
    const r = dst.store.importJson(src.store.exportJson());
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/limits/);
    expect(dst.store.snapshot()).toBe(before);
  });
  it('import history is merged by time, collapsed and capped', () => {
    const a = make(), b = make();
    a.store.recordVisit('x:1'); a.c.tick(); a.store.recordVisit('x:2');
    b.c.tick(500); b.store.recordVisit('x:2'); b.c.tick(); b.store.recordVisit('x:3');
    b.store.importJson(a.store.exportJson());
    expect(b.store.history().map((h) => h.id)).toEqual(['x:3', 'x:2', 'x:2', 'x:1'].filter((_, i, arr) => !(i === 1 && arr[1] === arr[2])));
  });
  it('mergeSavedStates is pure', () => {
    const base: SavedState = { schema: 'atlas-saved', version: 1, revision: 0, bookmarks: [{ id: 'a:1', savedAt: '2026-01-01T00:00:00Z' }], collections: [], history: [] };
    const other: SavedState = { ...base, bookmarks: [{ id: 'a:2', savedAt: '2026-01-02T00:00:00Z' }] };
    const out = mergeSavedStates(base, other, ids);
    expect(out.bookmarksAdded).toBe(1);
    expect(base.bookmarks).toHaveLength(1);
    expect(other.bookmarks).toHaveLength(1);
  });
  it('sanitizeState tolerates anything', () => {
    for (const v of [null, undefined, 1, 'x', [], {}, { bookmarks: 5, collections: null, history: {} }]) {
      const r = sanitizeState(v);
      if (v === null || v === undefined || typeof v !== 'object') expect(r).toBeNull();
      else expect(r!.state.bookmarks).toEqual([]);
    }
  });
});

describe('quota and subscriptions', () => {
  it('a change that would exceed the serialised size is refused and nothing changes', () => {
    const { store } = make({ limits: { maxChars: 600 } });
    must(store.addBookmark('a:1'));
    let refused = 0;
    for (let i = 0; i < 20; i++) { const r = store.addBookmark(`a:${i + 100}`, 'x'.repeat(100)); if (!r.ok) { refused++; expect(r.error).toBe('quota'); } }
    expect(refused).toBeGreaterThan(0);
    expect(JSON.stringify(store.snapshot()).length).toBeLessThanOrEqual(600);
  });
  it('a storage that cannot be written does not lose the in-memory change and is reported', () => {
    const raising = { getItem: () => null, setItem: () => { throw new Error('disk full'); }, removeItem: () => undefined, persistence: () => ({ mode: 'persistent' as const }) };
    const s = new SavedStore({ adapter: raising });
    expect(s.addBookmark('a:1').ok).toBe(true);
    expect(s.isBookmarked('a:1')).toBe(true);
    expect(s.persistence()).toMatchObject({ mode: 'memory-only' });
    expect(s.persistence().reason).toMatch(/disk full/);
  });
  it('subscribers are told what changed, in order, and can unsubscribe; a throwing listener does not break the store', () => {
    const { store } = make();
    const seen: SavedChange[] = [];
    const off = store.subscribe((c) => seen.push(c));
    store.subscribe(() => { throw new Error('listener bug'); });
    store.addBookmark('a:1');
    const col = must(store.createCollection('C'));
    store.addToCollection(col.id, 'a:2');
    store.recordVisit('a:1');
    store.removeBookmark('a:1');
    expect(seen.map((c) => c.kind)).toEqual(['bookmarks', 'collections', 'all', 'history', 'all']);
    expect(seen.map((c) => c.revision)).toEqual([1, 2, 3, 4, 5]);
    off();
    store.addBookmark('a:9');
    expect(seen).toHaveLength(5);
    const spy = vi.fn();
    store.subscribe(spy);
    store.addBookmark('a:1');                                   // a no-op re-add of nothing new? (a:1 was removed, so this is new)
    store.addBookmark('a:1');                                   // idempotent: no event
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it('failed operations do not notify', () => {
    const { store } = make();
    const spy = vi.fn();
    store.subscribe(spy);
    store.addBookmark('bad');
    store.removeBookmark('a:1');
    store.createCollection('');
    expect(spy).not.toHaveBeenCalled();
    expect(store.revision).toBe(0);
  });
});
