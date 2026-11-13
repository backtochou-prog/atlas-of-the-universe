/**
 * Local saved discoveries (Prompt 07): bookmarks, collections, exploration history, with a modular persistence layer.
 *
 *  - Everything lives in ONE versioned JSON document under one storage key (schema 'atlas-saved', version 1).
 *  - Persistence goes through a synchronous StorageAdapter. LocalStorageAdapter wraps every access in try/catch and falls back to memory
 *    when storage is blocked (private window, disabled cookies) or full; it then reports persistence 'memory-only' so the UI can say so.
 *  - A corrupt document never throws: it is copied to `<key>.backup`, the store starts empty and loadReport says what happened.
 *    A document from a NEWER version is also backed up and never overwritten silently.
 *  - There are no accounts and no backend here. SyncAdapter below is an extension point only (an interface, nothing implements it).
 *  - Every time comes from an injectable clock; ids of collections from an injectable generator, so tests are deterministic.
 *  - A saved id that no longer resolves is reported as unresolved (resolve / unresolved), never dropped silently.
 */
import type { DatasetId, UniversalId } from './types';

// ---- persistence ---------------------------------------------------------------------------------------------------------------------

export type PersistenceMode = 'persistent' | 'memory-only';
export interface PersistenceStatus { readonly mode: PersistenceMode; /** Why persistence is not available, if it is not. */ readonly reason?: string }

export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  persistence(): PersistenceStatus;
}

export class MemoryAdapter implements StorageAdapter {
  private readonly data = new Map<string, string>();
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.data.set(key, value); }
  removeItem(key: string): void { this.data.delete(key); }
  persistence(): PersistenceStatus { return { mode: 'memory-only', reason: 'memory adapter (not persisted)' }; }
}

/** The subset of the Web Storage API that is used. */
export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

export class LocalStorageAdapter implements StorageAdapter {
  private readonly mem = new MemoryAdapter();
  private reason: string | undefined;
  private backend: StorageLike | undefined | null = null;   // null = not resolved yet

  /** @param getStorage  how to obtain the storage; defaults to globalThis.localStorage (the access itself can throw). */
  constructor(private readonly getStorage: () => StorageLike | undefined = () => (globalThis as { localStorage?: StorageLike }).localStorage) {}

  private storage(): StorageLike | undefined {
    if (this.reason !== undefined) return undefined;
    if (this.backend === null) {
      try { this.backend = this.getStorage(); if (this.backend === undefined) this.reason = 'localStorage is not available'; }
      catch (e) { this.backend = undefined; this.reason = `localStorage is blocked (${describe(e)})`; }
    }
    return this.backend;
  }
  private fail(e: unknown, what: string): void { this.reason = `${what} (${describe(e)})`; }

  getItem(key: string): string | null {
    const m = this.mem.getItem(key);
    if (m !== null) return m;
    const s = this.storage();
    if (!s) return null;
    try { return s.getItem(key); } catch (e) { this.fail(e, 'localStorage read failed'); return null; }
  }
  setItem(key: string, value: string): void {
    const s = this.storage();
    if (s) {
      try { s.setItem(key, value); this.mem.removeItem(key); return; }
      catch (e) { this.fail(e, 'localStorage is full or blocked'); }
    }
    this.mem.setItem(key, value);
  }
  removeItem(key: string): void {
    this.mem.removeItem(key);
    const s = this.storage();
    if (!s) return;
    try { s.removeItem(key); } catch (e) { this.fail(e, 'localStorage remove failed'); }
  }
  persistence(): PersistenceStatus {
    this.storage();
    return this.reason === undefined ? { mode: 'persistent' } : { mode: 'memory-only', reason: this.reason };
  }
}
const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---- data model -----------------------------------------------------------------------------------------------------------------------

export interface Bookmark { readonly id: UniversalId; /** ISO 8601 */ readonly savedAt: string; readonly note?: string }
export interface Collection { readonly id: string; readonly name: string; readonly createdAt: string; /** Ids in display order; each is also a bookmark. */ readonly items: readonly UniversalId[] }
export interface HistoryEntry { readonly id: UniversalId; readonly at: string; readonly dataset?: DatasetId; /** Free text context supplied by the caller, e.g. "search: sirius". */ readonly context?: string }

export const SAVED_SCHEMA = 'atlas-saved' as const;
export const SAVED_VERSION = 1 as const;
export interface SavedState {
  readonly schema: typeof SAVED_SCHEMA;
  readonly version: typeof SAVED_VERSION;
  /** Increments on every committed change (useful to a SyncAdapter). */
  readonly revision: number;
  /** Oldest first. */
  readonly bookmarks: readonly Bookmark[];
  readonly collections: readonly Collection[];
  /** Oldest first. */
  readonly history: readonly HistoryEntry[];
}

export interface SavedLimits {
  readonly maxBookmarks: number; readonly maxCollections: number; readonly maxItemsPerCollection: number;
  readonly maxHistory: number; readonly maxNoteChars: number; readonly maxNameChars: number;
  /** Cap on the serialised document, in UTF-16 code units (about the localStorage budget with margin). */
  readonly maxChars: number;
}
export const DEFAULT_LIMITS: SavedLimits = { maxBookmarks: 2000, maxCollections: 50, maxItemsPerCollection: 2000, maxHistory: 200, maxNoteChars: 1000, maxNameChars: 60, maxChars: 1_000_000 };

export type SavedErrorCode = 'invalid-id' | 'invalid-name' | 'duplicate-name' | 'not-found' | 'limit' | 'quota' | 'invalid-order' | 'invalid-input';
export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: SavedErrorCode; readonly message: string };
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const err = <T = never>(error: SavedErrorCode, message: string): Result<T> => ({ ok: false, error, message });

export type SavedChange = { readonly kind: 'bookmarks' | 'collections' | 'history' | 'all'; readonly revision: number };

export type LoadStatus = 'empty' | 'loaded' | 'migrated' | 'recovered-corrupt' | 'recovered-future-version' | 'recovered-invalid';
export interface LoadReport { readonly status: LoadStatus; readonly fromVersion?: number; /** Items discarded because they had an invalid shape. */ readonly dropped: number; readonly backupKey?: string }

/** Extension point for syncing across devices. Nothing in this repository implements it; there are no accounts and no server. */
export interface SyncAdapter {
  readonly id: string;
  /** Called after local commits. Implementations must be idempotent and must not throw. */
  push(state: SavedState): Promise<{ readonly ok: boolean; readonly message?: string }>;
  /** The remote copy, or null if there is none. Combine with mergeSavedStates(local, remote). */
  pull(): Promise<SavedState | null>;
}

// ---- validation helpers (never trust a shape) ----------------------------------------------------------------------------------------

const RE_ID = /^[a-z][a-z0-9-]*:[^\u0000-\u001f]+$/;
const RE_CONTROL = /[\u0000-\u001f\u007f]/;
export const isValidId = (id: unknown): id is UniversalId => typeof id === 'string' && id.length <= 200 && RE_ID.test(id);
const isIso = (s: unknown): s is string => typeof s === 'string' && s.length <= 40 && !Number.isNaN(Date.parse(s));
const DATASETS: ReadonlySet<string> = new Set(['gaia-dr3', 'hipparcos', 'solar-system', 'deep-space', 'nasa-exoplanet-archive', 'ungc', 'local-group-mcconnachie', 'twomrs', 'curated-other']);

export function validateName(raw: unknown, limits: SavedLimits = DEFAULT_LIMITS): Result<string> {
  if (typeof raw !== 'string') return err('invalid-name', 'A name must be text.');
  const name = raw.replace(/\s+/g, ' ').trim();
  if (name.length === 0) return err('invalid-name', 'A name cannot be empty.');
  if (name.length > limits.maxNameChars) return err('invalid-name', `A name can have at most ${limits.maxNameChars} characters.`);
  if (RE_CONTROL.test(name)) return err('invalid-name', 'A name cannot contain control characters.');
  return ok(name);
}

const EMPTY_STATE: SavedState = { schema: SAVED_SCHEMA, version: SAVED_VERSION, revision: 0, bookmarks: [], collections: [], history: [] };

/** Clean an untrusted object into a SavedState; invalid items are dropped and counted. */
export function sanitizeState(input: unknown, limits: SavedLimits = DEFAULT_LIMITS): { state: SavedState; dropped: number } | null {
  if (typeof input !== 'object' || input === null) return null;
  const o = input as Record<string, unknown>;
  let dropped = 0;
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const bookmarks: Bookmark[] = [];
  const seen = new Set<string>();
  for (const b of arr(o['bookmarks'])) {
    const r = b as Record<string, unknown> | null;
    if (!r || !isValidId(r['id']) || !isIso(r['savedAt']) || seen.has(r['id'])) { dropped++; continue; }
    const note = typeof r['note'] === 'string' && r['note'].length > 0 ? r['note'].slice(0, limits.maxNoteChars) : undefined;
    seen.add(r['id']);
    bookmarks.push({ id: r['id'], savedAt: r['savedAt'], ...(note !== undefined ? { note } : {}) });
  }
  const collections: Collection[] = [];
  const collIds = new Set<string>(), collNames = new Set<string>();
  for (const c of arr(o['collections'])) {
    const r = c as Record<string, unknown> | null;
    const name = r ? validateName(r['name'], limits) : null;
    if (!r || typeof r['id'] !== 'string' || r['id'].length === 0 || r['id'].length > 80 || !name || !name.ok || !isIso(r['createdAt']) || collIds.has(r['id']) || collNames.has(name.value.toLowerCase())) { dropped++; continue; }
    const items: UniversalId[] = [];
    for (const it of arr(r['items'])) { if (isValidId(it) && !items.includes(it)) items.push(it); else dropped++; }
    collIds.add(r['id']); collNames.add(name.value.toLowerCase());
    collections.push({ id: r['id'], name: name.value, createdAt: r['createdAt'], items });
  }
  // a collection item must also be a bookmark
  const have = new Set(bookmarks.map((b) => b.id));
  for (const c of collections) for (const id of c.items) if (!have.has(id)) { have.add(id); bookmarks.push({ id, savedAt: c.createdAt }); }
  const history: HistoryEntry[] = [];
  for (const h of arr(o['history'])) {
    const r = h as Record<string, unknown> | null;
    if (!r || !isValidId(r['id']) || !isIso(r['at'])) { dropped++; continue; }
    const dataset = typeof r['dataset'] === 'string' && DATASETS.has(r['dataset']) ? (r['dataset'] as DatasetId) : undefined;
    const context = typeof r['context'] === 'string' && r['context'].length > 0 ? r['context'].slice(0, 200) : undefined;
    history.push({ id: r['id'], at: r['at'], ...(dataset ? { dataset } : {}), ...(context ? { context } : {}) });
  }
  const revision = typeof o['revision'] === 'number' && Number.isFinite(o['revision']) && o['revision'] >= 0 ? Math.floor(o['revision']) : 0;
  return { state: { schema: SAVED_SCHEMA, version: SAVED_VERSION, revision, bookmarks, collections, history: history.slice(-limits.maxHistory) }, dropped };
}

/** Collapse consecutive duplicate ids and cap the length (oldest dropped). */
function normaliseHistory(h: readonly HistoryEntry[], cap: number): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const e of h) if (out.length === 0 || out[out.length - 1]!.id !== e.id) out.push(e);
  return out.slice(-cap);
}

export interface MergeOutcome { readonly state: SavedState; readonly bookmarksAdded: number; readonly collectionsAdded: number; readonly itemsAdded: number; readonly historyAdded: number }

/**
 * Pure merge of two states (used by import-merge and available to a SyncAdapter). `local` wins on conflicts of notes and names;
 * bookmarks keep the EARLIER savedAt; collections match by id, then by case-insensitive name; history is the union ordered by time.
 */
export function mergeSavedStates(local: SavedState, remote: SavedState, newId: () => string, limits: SavedLimits = DEFAULT_LIMITS): MergeOutcome {
  const bookmarks = new Map(local.bookmarks.map((b) => [b.id, b] as const));
  let bookmarksAdded = 0;
  for (const b of remote.bookmarks) {
    const mine = bookmarks.get(b.id);
    if (!mine) { bookmarks.set(b.id, b); bookmarksAdded++; continue; }
    const savedAt = Date.parse(b.savedAt) < Date.parse(mine.savedAt) ? b.savedAt : mine.savedAt;
    const note = mine.note ?? b.note;
    bookmarks.set(b.id, { id: b.id, savedAt, ...(note !== undefined ? { note } : {}) });
  }
  const collections: Collection[] = local.collections.map((c) => ({ ...c, items: [...c.items] }));
  let collectionsAdded = 0, itemsAdded = 0;
  for (const rc of remote.collections) {
    let target = collections.find((c) => c.id === rc.id) ?? collections.find((c) => c.name.toLowerCase() === rc.name.toLowerCase());
    if (!target) {
      let id = rc.id;
      while (collections.some((c) => c.id === id)) id = newId();
      target = { id, name: rc.name, createdAt: rc.createdAt, items: [] };
      collections.push(target);
      collectionsAdded++;
    }
    const items = target.items as UniversalId[];
    for (const it of rc.items) if (!items.includes(it)) { items.push(it); itemsAdded++; if (!bookmarks.has(it)) { bookmarks.set(it, { id: it, savedAt: rc.createdAt }); bookmarksAdded++; } }
  }
  const histKey = (h: HistoryEntry): string => `${h.id}\u0000${h.at}`;
  const seen = new Set(local.history.map(histKey));
  const added = remote.history.filter((h) => !seen.has(histKey(h)));
  const history = normaliseHistory([...local.history, ...added].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)), limits.maxHistory);
  return {
    state: { ...local, bookmarks: [...bookmarks.values()], collections, history },
    bookmarksAdded, collectionsAdded, itemsAdded, historyAdded: added.length,
  };
}

// ---- migrations -----------------------------------------------------------------------------------------------------------------------

/** version N document -> version N+1 document. Version 0 was a prototype shape: { bookmarks: string[], history: string[] }. */
export type Migration = (old: unknown, nowIso: string) => unknown;
export const MIGRATIONS: Readonly<Record<number, Migration>> = {
  0: (old, nowIso) => {
    const o = (old ?? {}) as { bookmarks?: unknown; history?: unknown };
    const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    return {
      schema: SAVED_SCHEMA, version: 1, revision: 0,
      bookmarks: ids(o.bookmarks).map((id) => ({ id, savedAt: nowIso })),
      collections: [],
      history: ids(o.history).map((id) => ({ id, at: nowIso })),
    };
  },
};

// ---- the store ------------------------------------------------------------------------------------------------------------------------

export interface SavedStoreOptions {
  readonly adapter: StorageAdapter;
  readonly now?: () => Date;
  readonly storageKey?: string;
  readonly limits?: Partial<SavedLimits>;
  /** Generator of collection ids; must return a new string on each call. */
  readonly newId?: () => string;
  readonly migrations?: Readonly<Record<number, Migration>>;
}

export const DEFAULT_STORAGE_KEY = 'atlas.saved';

export interface ResolvedBookmark<R> { readonly bookmark: Bookmark; readonly status: 'resolved' | 'unresolved'; readonly record?: R }
export interface ImportReport {
  readonly ok: boolean; readonly mode: 'merge' | 'replace';
  readonly bookmarksAdded: number; readonly collectionsAdded: number; readonly itemsAdded: number; readonly historyAdded: number;
  readonly dropped: number; readonly message?: string;
}

export class SavedStore {
  private state: SavedState;
  private readonly adapter: StorageAdapter;
  private readonly now: () => Date;
  private readonly key: string;
  private readonly lim: SavedLimits;
  private readonly makeId: () => string;
  private readonly listeners = new Set<(c: SavedChange) => void>();
  private idCounter = 0;
  private lastWriteError: string | undefined;
  readonly loadReport: LoadReport;

  constructor(opts: SavedStoreOptions) {
    this.adapter = opts.adapter;
    this.now = opts.now ?? (() => new Date());
    this.key = opts.storageKey ?? DEFAULT_STORAGE_KEY;
    this.lim = { ...DEFAULT_LIMITS, ...opts.limits };
    this.makeId = opts.newId ?? (() => `col-${this.now().getTime().toString(36)}-${(++this.idCounter).toString(36)}`);
    const loaded = this.load(opts.migrations ?? MIGRATIONS);
    this.state = loaded.state;
    this.loadReport = loaded.report;
  }

  private readRaw(): string | null { try { return this.adapter.getItem(this.key); } catch { return null; } }
  private backup(raw: string): string | undefined {
    const k = `${this.key}.backup`;
    try { this.adapter.setItem(k, raw); return k; } catch { return undefined; }
  }

  private load(migrations: Readonly<Record<number, Migration>>): { state: SavedState; report: LoadReport } {
    const raw = this.readRaw();
    if (raw === null) return { state: EMPTY_STATE, report: { status: 'empty', dropped: 0 } };
    let doc: unknown;
    try { doc = JSON.parse(raw); } catch {
      const b = this.backup(raw);
      return { state: EMPTY_STATE, report: { status: 'recovered-corrupt', dropped: 0, ...(b ? { backupKey: b } : {}) } };
    }
    if (typeof doc !== 'object' || doc === null) {
      const b = this.backup(raw);
      return { state: EMPTY_STATE, report: { status: 'recovered-invalid', dropped: 0, ...(b ? { backupKey: b } : {}) } };
    }
    let version = typeof (doc as { version?: unknown }).version === 'number' ? (doc as { version: number }).version : 0;
    if (version > SAVED_VERSION) {
      const b = this.backup(raw);
      return { state: EMPTY_STATE, report: { status: 'recovered-future-version', fromVersion: version, dropped: 0, ...(b ? { backupKey: b } : {}) } };
    }
    const fromVersion = version;
    let migrated = false;
    try {
      while (version < SAVED_VERSION) {
        const m = migrations[version];
        if (!m) throw new Error(`no migration from version ${version}`);
        doc = m(doc, this.now().toISOString());
        version++;
        migrated = true;
      }
    } catch {
      const b = this.backup(raw);
      return { state: EMPTY_STATE, report: { status: 'recovered-invalid', fromVersion, dropped: 0, ...(b ? { backupKey: b } : {}) } };
    }
    const clean = sanitizeState(doc, this.lim);
    if (!clean) {
      const b = this.backup(raw);
      return { state: EMPTY_STATE, report: { status: 'recovered-invalid', fromVersion, dropped: 0, ...(b ? { backupKey: b } : {}) } };
    }
    return { state: clean.state, report: { status: migrated ? 'migrated' : 'loaded', fromVersion, dropped: clean.dropped } };
  }

  // ---- persistence ---------------------------------------------------------------------------------------------------------------

  persistence(): PersistenceStatus {
    const p = this.adapter.persistence();
    return this.lastWriteError !== undefined && p.mode === 'persistent' ? { mode: 'memory-only', reason: this.lastWriteError } : p;
  }

  private commit(next: Omit<SavedState, 'revision'>, kind: SavedChange['kind']): Result<SavedState> {
    const state: SavedState = { ...next, revision: this.state.revision + 1 };
    const json = JSON.stringify(state);
    if (json.length > this.lim.maxChars) return err('quota', `The saved data would be ${json.length} characters, over the ${this.lim.maxChars} limit.`);
    try { this.adapter.setItem(this.key, json); this.lastWriteError = undefined; }
    catch (e) { this.lastWriteError = `could not write: ${describe(e)}`; }
    this.state = state;
    for (const l of [...this.listeners]) { try { l({ kind, revision: state.revision }); } catch { /* a listener must not break the store */ } }
    return ok(state);
  }

  subscribe(listener: (c: SavedChange) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  snapshot(): SavedState { return this.state; }
  get revision(): number { return this.state.revision; }
  limits(): SavedLimits { return this.lim; }

  // ---- bookmarks -----------------------------------------------------------------------------------------------------------------

  bookmarks(): Bookmark[] { return [...this.state.bookmarks].reverse(); }
  isBookmarked(id: UniversalId): boolean { return this.state.bookmarks.some((b) => b.id === id); }

  /** Idempotent: bookmarking an already-saved id returns the existing bookmark (a new note replaces the old one only if given). */
  addBookmark(id: UniversalId, note?: string): Result<Bookmark> {
    if (!isValidId(id)) return err('invalid-id', `"${String(id).slice(0, 40)}" is not an object id.`);
    if (note !== undefined && (typeof note !== 'string' || note.length > this.lim.maxNoteChars)) return err('invalid-input', `A note can have at most ${this.lim.maxNoteChars} characters.`);
    const existing = this.state.bookmarks.find((b) => b.id === id);
    if (existing && note === undefined) return ok(existing);
    if (!existing && this.state.bookmarks.length >= this.lim.maxBookmarks) return err('limit', `At most ${this.lim.maxBookmarks} bookmarks.`);
    const bm: Bookmark = { id, savedAt: existing?.savedAt ?? this.now().toISOString(), ...(note !== undefined && note.length > 0 ? { note } : {}) };
    const bookmarks = existing ? this.state.bookmarks.map((b) => (b.id === id ? bm : b)) : [...this.state.bookmarks, bm];
    const r = this.commit({ ...this.state, bookmarks }, 'bookmarks');
    return r.ok ? ok(bm) : r;
  }

  setNote(id: UniversalId, note: string): Result<Bookmark> {
    if (!this.isBookmarked(id)) return err('not-found', 'That object is not bookmarked.');
    if (typeof note !== 'string' || note.length > this.lim.maxNoteChars) return err('invalid-input', `A note can have at most ${this.lim.maxNoteChars} characters.`);
    const old = this.state.bookmarks.find((b) => b.id === id)!;
    const bm: Bookmark = { id, savedAt: old.savedAt, ...(note.length > 0 ? { note } : {}) };
    const r = this.commit({ ...this.state, bookmarks: this.state.bookmarks.map((b) => (b.id === id ? bm : b)) }, 'bookmarks');
    return r.ok ? ok(bm) : r;
  }

  /** Removes the bookmark and its membership in every collection. */
  removeBookmark(id: UniversalId): Result<true> {
    if (!this.isBookmarked(id)) return err('not-found', 'That object is not bookmarked.');
    const r = this.commit({
      ...this.state,
      bookmarks: this.state.bookmarks.filter((b) => b.id !== id),
      collections: this.state.collections.map((c) => ({ ...c, items: c.items.filter((x) => x !== id) })),
    }, 'all');
    return r.ok ? ok(true) : r;
  }

  // ---- collections ---------------------------------------------------------------------------------------------------------------

  collections(): readonly Collection[] { return this.state.collections; }
  collection(id: string): Collection | undefined { return this.state.collections.find((c) => c.id === id); }
  collectionsContaining(id: UniversalId): Collection[] { return this.state.collections.filter((c) => c.items.includes(id)); }

  private nameClash(name: string, exceptId?: string): boolean {
    return this.state.collections.some((c) => c.id !== exceptId && c.name.toLowerCase() === name.toLowerCase());
  }

  createCollection(rawName: string): Result<Collection> {
    const name = validateName(rawName, this.lim);
    if (!name.ok) return name;
    if (this.nameClash(name.value)) return err('duplicate-name', `There is already a collection called "${name.value}".`);
    if (this.state.collections.length >= this.lim.maxCollections) return err('limit', `At most ${this.lim.maxCollections} collections.`);
    let id = this.makeId();
    while (this.state.collections.some((c) => c.id === id)) id = this.makeId();
    const c: Collection = { id, name: name.value, createdAt: this.now().toISOString(), items: [] };
    const r = this.commit({ ...this.state, collections: [...this.state.collections, c] }, 'collections');
    return r.ok ? ok(c) : r;
  }

  renameCollection(id: string, rawName: string): Result<Collection> {
    const c = this.collection(id);
    if (!c) return err('not-found', 'No such collection.');
    const name = validateName(rawName, this.lim);
    if (!name.ok) return name;
    if (this.nameClash(name.value, id)) return err('duplicate-name', `There is already a collection called "${name.value}".`);
    const next = { ...c, name: name.value };
    const r = this.commit({ ...this.state, collections: this.state.collections.map((x) => (x.id === id ? next : x)) }, 'collections');
    return r.ok ? ok(next) : r;
  }

  /** Deletes the collection only; its objects stay bookmarked. */
  deleteCollection(id: string): Result<true> {
    if (!this.collection(id)) return err('not-found', 'No such collection.');
    const r = this.commit({ ...this.state, collections: this.state.collections.filter((c) => c.id !== id) }, 'collections');
    return r.ok ? ok(true) : r;
  }

  /** `orderedIds` must be a permutation of the existing collection ids. */
  reorderCollections(orderedIds: readonly string[]): Result<readonly Collection[]> {
    const have = this.state.collections.map((c) => c.id);
    if (orderedIds.length !== have.length || new Set(orderedIds).size !== have.length || !orderedIds.every((i) => have.includes(i))) return err('invalid-order', 'The order must list every collection exactly once.');
    const byId = new Map(this.state.collections.map((c) => [c.id, c] as const));
    const r = this.commit({ ...this.state, collections: orderedIds.map((i) => byId.get(i)!) }, 'collections');
    return r.ok ? ok(r.value.collections) : r;
  }

  /** Adds to the collection; if the object is not bookmarked it is bookmarked first (an object in a collection is always a bookmark). A duplicate is refused. */
  addToCollection(collectionId: string, id: UniversalId): Result<Collection> {
    const c = this.collection(collectionId);
    if (!c) return err('not-found', 'No such collection.');
    if (!isValidId(id)) return err('invalid-id', `"${String(id).slice(0, 40)}" is not an object id.`);
    if (c.items.includes(id)) return err('invalid-input', 'That object is already in the collection.');
    if (c.items.length >= this.lim.maxItemsPerCollection) return err('limit', `At most ${this.lim.maxItemsPerCollection} objects per collection.`);
    const needsBookmark = !this.isBookmarked(id);
    if (needsBookmark && this.state.bookmarks.length >= this.lim.maxBookmarks) return err('limit', `At most ${this.lim.maxBookmarks} bookmarks.`);
    const next = { ...c, items: [...c.items, id] };
    const r = this.commit({
      ...this.state,
      bookmarks: needsBookmark ? [...this.state.bookmarks, { id, savedAt: this.now().toISOString() }] : this.state.bookmarks,
      collections: this.state.collections.map((x) => (x.id === collectionId ? next : x)),
    }, 'all');
    return r.ok ? ok(next) : r;
  }

  removeFromCollection(collectionId: string, id: UniversalId): Result<Collection> {
    const c = this.collection(collectionId);
    if (!c) return err('not-found', 'No such collection.');
    if (!c.items.includes(id)) return err('not-found', 'That object is not in the collection.');
    const next = { ...c, items: c.items.filter((x) => x !== id) };
    const r = this.commit({ ...this.state, collections: this.state.collections.map((x) => (x.id === collectionId ? next : x)) }, 'collections');
    return r.ok ? ok(next) : r;
  }

  moveInCollection(collectionId: string, id: UniversalId, toIndex: number): Result<Collection> {
    const c = this.collection(collectionId);
    if (!c) return err('not-found', 'No such collection.');
    const from = c.items.indexOf(id);
    if (from < 0) return err('not-found', 'That object is not in the collection.');
    if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= c.items.length) return err('invalid-order', 'The target position is outside the collection.');
    const items = [...c.items];
    items.splice(from, 1);
    items.splice(toIndex, 0, id);
    const next = { ...c, items };
    const r = this.commit({ ...this.state, collections: this.state.collections.map((x) => (x.id === collectionId ? next : x)) }, 'collections');
    return r.ok ? ok(next) : r;
  }

  // ---- history -------------------------------------------------------------------------------------------------------------------

  /** Newest first. */
  history(): HistoryEntry[] { return [...this.state.history].reverse(); }

  /** Records a visit. A visit to the object that was visited last is not a new entry. Capped at limits.maxHistory (oldest dropped). */
  recordVisit(id: UniversalId, ctx: { readonly dataset?: DatasetId; readonly context?: string } = {}): Result<HistoryEntry | null> {
    if (!isValidId(id)) return err('invalid-id', `"${String(id).slice(0, 40)}" is not an object id.`);
    const last = this.state.history[this.state.history.length - 1];
    if (last && last.id === id) return ok(null);
    const entry: HistoryEntry = {
      id, at: this.now().toISOString(),
      ...(ctx.dataset && DATASETS.has(ctx.dataset) ? { dataset: ctx.dataset } : {}),
      ...(ctx.context ? { context: ctx.context.slice(0, 200) } : {}),
    };
    const r = this.commit({ ...this.state, history: [...this.state.history, entry].slice(-this.lim.maxHistory) }, 'history');
    return r.ok ? ok(entry) : r;
  }

  clearHistory(): Result<true> {
    if (this.state.history.length === 0) return ok(true);
    const r = this.commit({ ...this.state, history: [] }, 'history');
    return r.ok ? ok(true) : r;
  }

  // ---- resolution ----------------------------------------------------------------------------------------------------------------

  /** Every bookmark with its record if `resolver` finds one; unresolved ids are listed with status 'unresolved', never dropped. */
  resolveBookmarks<R>(resolver: (id: UniversalId) => R | undefined): ResolvedBookmark<R>[] {
    return this.bookmarks().map((bookmark) => {
      const record = resolver(bookmark.id);
      return record === undefined ? { bookmark, status: 'unresolved' as const } : { bookmark, status: 'resolved' as const, record };
    });
  }
  /** Ids saved anywhere (bookmarks, collections, history) that the resolver cannot find. */
  unresolvedIds(resolver: (id: UniversalId) => unknown): UniversalId[] {
    const ids = new Set<UniversalId>([...this.state.bookmarks.map((b) => b.id), ...this.state.collections.flatMap((c) => c.items), ...this.state.history.map((h) => h.id)]);
    return [...ids].filter((id) => resolver(id) === undefined);
  }

  // ---- export / import -----------------------------------------------------------------------------------------------------------

  exportJson(): string {
    return JSON.stringify({ schema: 'atlas-saved-export/1', exportedAt: this.now().toISOString(), state: this.state }, null, 2);
  }

  /** Validates everything; unknown or malformed parts are dropped and counted, never trusted. 'replace' discards the current data. */
  importJson(text: string, opts: { readonly mode?: 'merge' | 'replace' } = {}): ImportReport {
    const mode = opts.mode ?? 'merge';
    const fail = (message: string): ImportReport => ({ ok: false, mode, bookmarksAdded: 0, collectionsAdded: 0, itemsAdded: 0, historyAdded: 0, dropped: 0, message });
    if (typeof text !== 'string' || text.length === 0) return fail('The file is empty.');
    if (text.length > this.lim.maxChars * 2) return fail('The file is too large to import.');
    let doc: unknown;
    try { doc = JSON.parse(text); } catch { return fail('The file is not valid JSON.'); }
    const env = doc as { schema?: unknown; state?: unknown } | null;
    const payload = env && typeof env === 'object' && env.schema === 'atlas-saved-export/1' ? env.state : doc;
    const p = payload as Record<string, unknown> | null;
    if (typeof p !== 'object' || p === null || Array.isArray(p) || !('bookmarks' in p || 'collections' in p || 'history' in p)) return fail('The file does not contain saved discoveries.');
    const clean = sanitizeState(payload, this.lim);
    if (!clean) return fail('The file does not contain saved discoveries.');
    const incoming = clean.state;
    if (incoming.bookmarks.length === 0 && incoming.collections.length === 0 && incoming.history.length === 0 && clean.dropped > 0) return fail('Nothing in the file could be read.');
    const base: SavedState = mode === 'replace' ? { ...EMPTY_STATE, revision: this.state.revision } : this.state;
    const merged = mergeSavedStates(base, incoming, () => this.makeId(), this.lim);
    if (merged.state.bookmarks.length > this.lim.maxBookmarks || merged.state.collections.length > this.lim.maxCollections || merged.state.collections.some((c) => c.items.length > this.lim.maxItemsPerCollection)) {
      return fail('Importing would exceed the limits for bookmarks or collections; nothing was changed.');
    }
    const r = this.commit({ ...merged.state, history: normaliseHistory(merged.state.history, this.lim.maxHistory) }, 'all');
    if (!r.ok) return fail(r.message);
    return { ok: true, mode, bookmarksAdded: merged.bookmarksAdded, collectionsAdded: merged.collectionsAdded, itemsAdded: merged.itemsAdded, historyAdded: merged.historyAdded, dropped: clean.dropped };
  }
}
