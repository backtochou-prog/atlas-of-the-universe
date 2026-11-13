/**
 * DiscoveryAtlas (Prompt 07, R2a): the one object the interface talks to.
 *
 *   engine (Web Worker or inline)   loads, adapts, merges, indexes and answers search / nearby / filter / relations / lists   (workerEngine.ts)
 *   notes (this thread)             the source-backed explanations (236 KB), alias aware: a note keyed hip:70890 is found from the Gaia record of Proxima
 *   saved (this thread)             bookmarks, collections, history in localStorage (SavedStore + LocalStorageAdapter; memory-only when blocked)
 *   nav (this thread)               NavigationController: selection history with camera snapshots, driven through a NavigationHost (the viewer)
 *
 * ASYNC BY DESIGN. The index lives in a Worker, so every query is a Promise. Synchronous reads are limited to what this thread already holds:
 * status, peek(id) (the record cache), noteFor(id), saved, nav state. Selecting an id the cache has not seen costs one message to the engine.
 *
 * STAGED LOADING (see AtlasStatus): search works as soon as `readyForSearch` (stage 0), on the datasets that are ready; `readyForQueries` (stage 1)
 * adds nearby / filters / relations / lists; `complete` means the point catalogues are in too. A failed dataset degrades: its `state` is 'failed' with
 * the reason, and everything else keeps working.
 *
 * SELECTION. select(id, { focus }) records the visit in history, asks the host to fly (when focus), and notifies onSelectionChange subscribers; the subscriber
 * shows the inspector. back / forward / returnToPrevious restore the camera snapshot of the entry (a flight, never a teleport). Selection operations are
 * serialised, so two quick clicks cannot interleave.
 */
import type { Vec3 } from '../core/spatial/vec3';
import type { Facets, FilterSpec } from './filters';
import { HttpDataSource, DATASET_LABEL, type DataSource } from './loader';
import { NavigationController, type FocusPlan, type NavFailure, type NavigationHost, type NavResult, type NavState } from './navigation';
import { LocalStorageAdapter, SavedStore, type HistoryEntry, type StorageAdapter } from './saved';
import { AtlasEngine, type EngineOptions } from './workerEngine';
import type {
  AtlasSearchResult, AtlasStatus, DatasetStatus, EngineApi, EngineEvent, EngineStats, FilterOutcome, ListsOutcome, NearbyOutcome, RelationLinkView, RelationsOutcome,
  SearchRequest, SolarBodyOffset, VisibleOutcome,
} from './engineApi';
import type { EngineClient } from './workerClient';
import type { DiscoveryNote, DiscoveryNotesFile, DiscoveryRecord, ObjectCategory, DatasetId, UniversalId } from './types';
import { METRES_PER_PARSEC } from '../core/units';

// ---- engine clients ------------------------------------------------------------------------------------------------------------

/** The engine on the calling thread: tests, and the fallback when Workers are unavailable (its non-sliceable steps then block the page: see workerEngine.ts). */
export class InlineEngineClient implements EngineClient {
  readonly engine: AtlasEngine;
  private readonly listeners = new Set<(e: EngineEvent) => void>();
  constructor(source: DataSource, opts: Omit<EngineOptions, 'emit'> = {}) {
    this.engine = new AtlasEngine(source, { ...opts, emit: (e) => { for (const l of [...this.listeners]) { try { l(e); } catch { /* listener errors stay in the listener */ } } } });
  }
  onEvent(cb: (e: EngineEvent) => void): () => void { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }
  terminate(): void { this.listeners.clear(); }
  start: EngineApi['start'] = () => this.engine.start();
  status: EngineApi['status'] = () => this.engine.status();
  search: EngineApi['search'] = (q, o) => this.engine.search(q, o);
  resolve: EngineApi['resolve'] = (id) => this.engine.resolve(id);
  getRecord: EngineApi['getRecord'] = (id) => this.engine.getRecord(id);
  getRecords: EngineApi['getRecords'] = (ids) => this.engine.getRecords(ids);
  relationsOf: EngineApi['relationsOf'] = (id, l) => this.engine.relationsOf(id, l);
  parentsOf: EngineApi['parentsOf'] = (id, a) => this.engine.parentsOf(id, a);
  facets: EngineApi['facets'] = () => this.engine.facets();
  filter: EngineApi['filter'] = (s, o) => this.engine.filter(s, o);
  lists: EngineApi['lists'] = () => this.engine.lists();
  nearby: EngineApi['nearby'] = (r) => this.engine.nearby(r);
  visible: EngineApi['visible'] = (r) => this.engine.visible(r);
  stats: EngineApi['stats'] = () => this.engine.stats();
}

// ---- viewer port ---------------------------------------------------------------------------------------------------------------

export interface CameraView { readonly positionPc: Vec3; readonly forward: Vec3; readonly up: Vec3; readonly fovYDeg: number; readonly aspect: number }

/** What the atlas needs from the viewer beyond navigation: the live camera and the Solar System at the current simulation time. ViewerNavigationHost implements it. */
export interface AtlasViewerPort extends NavigationHost {
  /** The orbit focus, heliocentric ICRS parsecs. */
  cameraFocusPc(): Vec3;
  cameraView(): CameraView;
  /** Metres in the solar-system frame (Sun-centred, ICRS axes) of every Solar System body at the current simulation time. */
  solarBodyOffsets(): readonly SolarBodyOffset[];
  /** Optional: mark neighbours / search results in the viewer. */
  highlight(ids: readonly UniversalId[]): void;
}

// ---- public types --------------------------------------------------------------------------------------------------------------

export type NearbyOriginSpec = UniversalId | 'camera' | { readonly positionPc: Vec3 };
export interface AtlasNearbyQuery {
  /** An object id, 'camera' (the viewer's orbit focus), or an explicit heliocentric ICRS position in parsecs. */
  readonly origin: NearbyOriginSpec;
  /** Metres, or radiusPc for convenience. */
  readonly radiusMetres?: number;
  readonly radiusPc?: number;
  readonly k?: number;
  readonly categories?: readonly ObjectCategory[];
  readonly datasets?: readonly DatasetId[];
}

export interface SuggestItem { readonly id: UniversalId; readonly name: string; readonly category: ObjectCategory; readonly classification: string }
export interface SuggestResult {
  /** 'empty': nothing typed -> history and featured are filled; 'results': `result` holds the search. */
  readonly kind: 'empty' | 'results';
  readonly query: string;
  readonly result?: AtlasSearchResult;
  /** Most recent distinct visits, newest first (empty-query only). */
  readonly history: readonly SuggestItem[];
  /** Objects that have a source-backed explanation, in the notes file's order (empty-query only). */
  readonly featured: readonly SuggestItem[];
}

export interface SelectOptions {
  /** Fly the camera to the object (default true). Pass false when the user clicked an object that is already on screen. */
  readonly focus?: boolean;
  readonly reason?: string;
  /** Free text stored with the history entry ("search: sirius"). */
  readonly context?: string;
}
export interface SelectionEvent {
  readonly id: UniversalId | null;
  readonly record: DiscoveryRecord | undefined;
  readonly cause: 'select' | 'deselect' | 'back' | 'forward' | 'previous' | 'parent';
  readonly reason: string;
  readonly focus: boolean;
  readonly nav: NavState;
}
/** Result of atlas.parent: a navigation result, the relation used (via) or fallback: true when the viewer's own parent flight ran. */
export type ParentResult = (NavResult & { readonly fallback?: undefined }) | { readonly ok: true; readonly noop: false; readonly fallback: true } | Extract<AtlasNavResult, { ok: false }>;
export type AtlasNavResult = NavResult | { readonly ok: false; readonly error: NavFailure | 'no-host'; readonly message: string };

export interface AtlasOptions {
  readonly engine: EngineClient;
  /** Where the explanations come from (default: the same source the engine would use is NOT assumed: pass it). */
  readonly notesSource?: DataSource;
  readonly storage?: StorageAdapter;
  readonly maxHistory?: number;
  readonly cacheSize?: number;
  readonly now?: () => Date;
}

const NOTES_STATUS = (state: DatasetStatus['state'], count: number | null, error?: string, ms?: number): DatasetStatus =>
  ({ key: 'notes', label: DATASET_LABEL['notes'], stage: 1, state, count, ...(error ? { error } : {}), ...(ms !== undefined ? { ms } : {}) });

const toItem = (r: DiscoveryRecord): SuggestItem => ({ id: r.id, name: r.name, category: r.category, classification: r.classification });

export class DiscoveryAtlas {
  readonly saved: SavedStore;
  private readonly engine: EngineClient;
  private readonly notesSource: DataSource | undefined;
  private host: AtlasViewerPort | null = null;
  private nav: NavigationController | null = null;
  private navUnsub: (() => void) | null = null;
  private readonly maxHistory: number;

  private statusValue: AtlasStatus;
  private notesStatus: DatasetStatus;
  private readonly statusListeners = new Set<(s: AtlasStatus) => void>();
  private readonly selectionListeners = new Set<(e: SelectionEvent) => void>();

  private readonly cache = new Map<UniversalId, DiscoveryRecord>();
  private readonly cacheSize: number;
  private aliases = new Map<UniversalId, UniversalId>();
  private notes: DiscoveryNote[] = [];
  private notesByCanonical = new Map<UniversalId, DiscoveryNote>();
  private listsCache: ListsOutcome | null = null;
  private startPromise: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private focusNext = true;
  private cause: SelectionEvent['cause'] = 'select';
  private lastReason = 'selected';
  private lastFocus = true;

  constructor(opts: AtlasOptions) {
    this.engine = opts.engine;
    this.notesSource = opts.notesSource;
    this.maxHistory = opts.maxHistory ?? 50;
    this.cacheSize = opts.cacheSize ?? 3000;
    this.saved = new SavedStore({ adapter: opts.storage ?? new LocalStorageAdapter(), ...(opts.now ? { now: opts.now } : {}) });
    this.notesStatus = NOTES_STATUS(this.notesSource ? 'pending' : 'failed', null, this.notesSource ? undefined : 'no notes source configured');
    this.statusValue = this.compose({ phase: 'idle', datasets: [], progress: 0, activity: '', readyForSearch: false, readyForQueries: false, complete: false, searchable: 0, records: 0, failed: [] });
    this.engine.onEvent((e) => this.onEngineEvent(e));
  }

  // ---- lifecycle and status ------------------------------------------------------------------------------------------------

  /** Start loading (idempotent). Resolves when everything finished, also when some datasets failed. Call it after the first paint. */
  start(): Promise<void> {
    this.startPromise ??= (async () => {
      const notes = this.loadNotes();
      try { await this.engine.start(); } catch (e) { this.patchFailed(e); }
      await notes;
      try { this.statusValue = this.compose(await this.engine.status()); this.emitStatus(); } catch { /* keep the last pushed status */ }
    })();
    return this.startPromise;
  }

  private patchFailed(e: unknown): void {
    const why = e instanceof Error ? e.message : String(e);
    this.statusValue = this.compose({ ...this.statusValue, phase: 'ready', complete: true, activity: `the discovery engine stopped: ${why}` });
    this.emitStatus();
  }

  private async loadNotes(): Promise<void> {
    if (!this.notesSource) return;
    const t0 = Date.now();
    this.notesStatus = NOTES_STATUS('loading', null);
    this.refreshStatus();
    try {
      const f = (await this.notesSource.load('notes')) as DiscoveryNotesFile;
      this.notes = Array.isArray(f?.notes) ? f.notes : [];
      this.indexNotes();
      this.notesStatus = NOTES_STATUS('ready', this.notes.length, undefined, Date.now() - t0);
    } catch (e) {
      this.notesStatus = NOTES_STATUS('failed', null, e instanceof Error ? e.message : String(e), Date.now() - t0);
    }
    this.refreshStatus();
  }

  private compose(s: AtlasStatus): AtlasStatus {
    const datasets = [...s.datasets.filter((d) => d.key !== 'notes'), this.notesStatus];
    const failed = datasets.filter((d) => d.state === 'failed').map((d) => d.key);
    return { ...s, datasets, failed };
  }
  private refreshStatus(): void { this.statusValue = this.compose(this.statusValue); this.emitStatus(); }
  private emitStatus(): void { for (const l of [...this.statusListeners]) { try { l(this.statusValue); } catch { /* listener errors stay in the listener */ } } }

  private onEngineEvent(e: EngineEvent): void {
    if (e.type === 'status') { this.statusValue = this.compose(e.status); this.emitStatus(); }
    else if (e.type === 'aliases') { this.aliases = new Map(e.entries); this.indexNotes(); }
  }

  get status(): AtlasStatus { return this.statusValue; }
  /** Subscribe to status changes (progress is throttled to ~12 per second). The callback is called once with the current status. Returns the unsubscribe function. */
  onStatus(cb: (s: AtlasStatus) => void): () => void {
    this.statusListeners.add(cb);
    try { cb(this.statusValue); } catch { /* listener errors stay in the listener */ }
    return () => { this.statusListeners.delete(cb); };
  }
  /** Resolves when `pred` holds for the status (immediately if it already does). */
  whenStatus(pred: (s: AtlasStatus) => boolean): Promise<AtlasStatus> {
    if (pred(this.statusValue)) return Promise.resolve(this.statusValue);
    return new Promise((resolve) => { const off = this.onStatus((s) => { if (pred(s)) { off(); resolve(s); } }); });
  }
  stats(): Promise<EngineStats> { return this.engine.stats(); }
  dispose(): void { this.navUnsub?.(); this.engine.terminate(); }

  // ---- records -------------------------------------------------------------------------------------------------------------

  private remember(r: DiscoveryRecord): void {
    this.cache.delete(r.id);
    this.cache.set(r.id, r);
    if (this.cache.size > this.cacheSize) { const oldest = this.cache.keys().next().value; if (oldest !== undefined) this.cache.delete(oldest); }
  }

  /** The record if this thread already holds it (alias aware), else undefined. Synchronous. */
  peek(id: UniversalId): DiscoveryRecord | undefined { return this.cache.get(this.aliases.get(id) ?? id); }

  async getRecord(id: UniversalId): Promise<DiscoveryRecord | undefined> {
    const hit = this.peek(id);
    if (hit) return hit;
    try {
      const r = await this.engine.getRecord(id);
      if (r) this.remember(r);
      return r;
    } catch { return undefined; }
  }
  async getRecords(ids: readonly UniversalId[]): Promise<(DiscoveryRecord | undefined)[]> {
    const out: (DiscoveryRecord | undefined)[] = ids.map((id) => this.peek(id));
    const missing = ids.map((_id, i) => (out[i] ? -1 : i)).filter((i) => i >= 0);
    if (missing.length > 0) {
      try {
        const got = await this.engine.getRecords(missing.map((i) => ids[i]!));
        got.forEach((r, k) => { if (r) { this.remember(r); out[missing[k]!] = r; } });
      } catch { /* leave undefined */ }
    }
    return out;
  }
  /** Canonical id for an id or an alias (host:TRAPPIST-1 -> the merged star record), undefined when the atlas does not know it. */
  async resolve(id: UniversalId): Promise<UniversalId | undefined> {
    const a = this.aliases.get(id);
    if (a !== undefined) return a;
    try { return await this.engine.resolve(id); } catch { return undefined; }
  }
  /** Canonical id by the aliases this thread knows (synchronous; ids merged at stage 1 only). */
  canonical(id: UniversalId): UniversalId { return this.aliases.get(id) ?? id; }

  // ---- notes ---------------------------------------------------------------------------------------------------------------

  private indexNotes(): void {
    const m = new Map<UniversalId, DiscoveryNote>();
    for (const n of this.notes) m.set(this.aliases.get(n.id) ?? n.id, n);
    this.notesByCanonical = m;
  }
  /** The explanation for an object, alias aware (a note keyed hip:70890 is found from the Gaia record the Hipparcos star was merged into). */
  noteFor(id: UniversalId): DiscoveryNote | undefined { return this.notesByCanonical.get(this.aliases.get(id) ?? id); }
  get noteCount(): number { return this.notes.length; }

  // ---- search ---------------------------------------------------------------------------------------------------------------

  async search(query: string, opts: SearchRequest = {}): Promise<AtlasSearchResult> {
    try { return await this.engine.search(query, opts); }
    catch { return { query: String(query), normalized: null, hits: [], total: 0, totalIsLowerBound: false, categoryCounts: {}, fuzzyUsed: false }; }
  }

  /** Partial-name suggestions with the same engine. With nothing typed: recent history and the objects that have an explanation. */
  async suggest(query: string, opts: { readonly limit?: number; readonly categories?: readonly ObjectCategory[] } = {}): Promise<SuggestResult> {
    const q = typeof query === 'string' ? query : '';
    if (q.trim().length === 0) {
      const hist: UniversalId[] = [];
      for (const h of this.saved.history()) { const c = this.aliases.get(h.id) ?? h.id; if (!hist.includes(c)) hist.push(c); if (hist.length >= 8) break; }
      const featuredIds = [...new Set(this.notes.map((n) => this.aliases.get(n.id) ?? n.id))].slice(0, 8);
      const [h, f] = await Promise.all([this.getRecords(hist), this.getRecords(featuredIds)]);
      return { kind: 'empty', query: q, history: h.filter((r): r is DiscoveryRecord => !!r).map(toItem), featured: f.filter((r): r is DiscoveryRecord => !!r).map(toItem) };
    }
    const result = await this.search(q, { limit: opts.limit ?? 8, ...(opts.categories ? { categories: opts.categories } : {}) });
    return { kind: 'results', query: q, result, history: [], featured: [] };
  }

  // ---- structure ---------------------------------------------------------------------------------------------------------------

  relationsOf(id: UniversalId, limitPerGroup?: number): Promise<RelationsOutcome> {
    return this.engine.relationsOf(id, limitPerGroup).catch(() => ({ id, canonical: this.canonical(id), groups: { 'physical-gravitational': [], structural: [], 'spatial-association': [], identity: [] }, total: 0 }));
  }
  facets(): Promise<Facets | null> { return this.engine.facets().catch(() => null); }
  filter(spec: FilterSpec, opts?: { readonly limit?: number }): Promise<FilterOutcome | null> { return this.engine.filter(spec, opts).catch(() => null); }
  /** The discovery lists, computed once by the engine and cached here when complete. */
  async lists(): Promise<ListsOutcome | null> {
    if (this.listsCache?.complete) return this.listsCache;
    try {
      const r = await this.engine.lists();
      if (r?.complete) this.listsCache = r;
      return r;
    } catch { return null; }
  }

  /**
   * Objects near an origin, nearest first, distances in metres computed in a common frame (Solar System bodies in their own frame at the current simulation time,
   * stars and deep objects in the heliocentric ICRS frame; see nearby.ts). origin 'camera' needs the viewer attached.
   */
  async nearby(q: AtlasNearbyQuery): Promise<NearbyOutcome> {
    const o = q.origin;
    let origin;
    if (typeof o === 'string' && o !== 'camera') origin = { kind: 'id' as const, id: o };
    else if (o === 'camera') {
      if (!this.host) return { ok: false, error: 'invalid', message: 'There is no camera: the viewer is not attached.' };
      origin = { kind: 'position' as const, positionPc: this.host.cameraFocusPc() };
    } else origin = { kind: 'position' as const, positionPc: o.positionPc };
    const radiusMetres = q.radiusMetres ?? (q.radiusPc !== undefined ? q.radiusPc * METRES_PER_PARSEC : undefined);
    if (radiusMetres === undefined && q.k === undefined) return { ok: false, error: 'invalid', message: 'Give a radius or a number of neighbours (k).' };
    try {
      return await this.engine.nearby({
        origin, ...(radiusMetres !== undefined ? { radiusMetres } : {}), ...(q.k !== undefined ? { k: q.k } : {}),
        ...(q.categories ? { categories: q.categories } : {}), ...(q.datasets ? { datasets: q.datasets } : {}),
        ...(this.host ? { solarBodies: this.host.solarBodyOffsets() } : {}),
      });
    } catch (e) { return { ok: false, error: 'invalid', message: e instanceof Error ? e.message : String(e) }; }
  }

  /** Objects inside the camera's view frustum (nearest first). Needs the viewer attached. */
  async visible(opts: { readonly maxDistanceMetres: number; readonly categories?: readonly ObjectCategory[]; readonly limit?: number }): Promise<VisibleOutcome> {
    if (!this.host) return { ok: false, error: 'invalid', message: 'There is no camera: the viewer is not attached.' };
    const c = this.host.cameraView();
    try {
      return await this.engine.visible({
        cameraPc: c.positionPc, forward: c.forward, up: c.up, fovYDeg: c.fovYDeg, aspect: c.aspect, maxDistanceMetres: opts.maxDistanceMetres,
        ...(opts.categories ? { categories: opts.categories } : {}), ...(opts.limit !== undefined ? { limit: opts.limit } : {}), solarBodies: this.host.solarBodyOffsets(),
      });
    } catch (e) { return { ok: false, error: 'invalid', message: e instanceof Error ? e.message : String(e) }; }
  }

  // ---- viewer and navigation ---------------------------------------------------------------------------------------------------

  /** Attach the viewer (call once, before the first select). */
  attachViewer(host: AtlasViewerPort): void {
    this.host = host;
    this.navUnsub?.();
    const gated: NavigationHost = {
      focus: (plan: FocusPlan) => { if (this.focusNext) host.focus(plan); },
      snapshot: () => host.snapshot(),
      restore: (s, ms) => host.restore(s, ms),
      setSelection: (id) => host.setSelection(id),
      highlight: (ids) => host.highlight(ids),
      currentFrame: () => host.currentFrame(),
      resolve: (id) => this.peek(id),
      positionOf: (r) => host.positionOf(r),
      ...(host.viewDistance ? { viewDistance: (r: DiscoveryRecord) => host.viewDistance!(r) } : {}),
    };
    this.nav = new NavigationController(gated, null, { maxHistory: this.maxHistory });
    this.navUnsub = this.nav.subscribe((s) => this.onNavChange(s));
  }

  get selection(): UniversalId | null { return this.nav?.selection ?? null; }
  navState(): NavState | null { return this.nav?.state() ?? null; }
  /** The history entries of the navigation controller (selection + camera snapshot), oldest first. */
  navHistory() { return this.nav?.history() ?? []; }

  onSelectionChange(cb: (e: SelectionEvent) => void): () => void { this.selectionListeners.add(cb); return () => { this.selectionListeners.delete(cb); }; }

  private onNavChange(s: NavState): void {
    const id = s.selection;
    const emit = (record: DiscoveryRecord | undefined): void => {
      const ev: SelectionEvent = { id, record, cause: this.cause, reason: this.lastReason, focus: this.lastFocus, nav: s };
      for (const l of [...this.selectionListeners]) { try { l(ev); } catch { /* listener errors stay in the listener */ } }
    };
    if (id === null) { emit(undefined); return; }
    const rec = this.peek(id);
    if (rec) emit(rec); else void this.getRecord(id).then(emit);
  }

  private serial<T>(f: () => Promise<T>): Promise<T> {
    const run = this.queue.then(f, f);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Select an object: history entry, optional flight, selection event. Resolves with the navigation result (ok: false, 'unknown-id' for an id the atlas does not hold).
   * Selecting the object that is already selected is a no-op.
   */
  select(id: UniversalId, opts: SelectOptions = {}): Promise<AtlasNavResult> {
    return this.serial(async () => {
      if (!this.nav) return { ok: false, error: 'no-host', message: 'The viewer is not attached.' } as const;
      const rec = await this.getRecord(id);
      if (!rec) return { ok: false, error: 'unknown-id', message: `"${id}" is not an object in the loaded datasets.` } as const;
      this.cause = 'select'; this.lastReason = opts.reason ?? 'selected'; this.lastFocus = opts.focus ?? true;
      this.focusNext = opts.focus ?? true;
      let r: NavResult;
      try { r = this.nav.select(rec.id, this.lastReason); } finally { this.focusNext = true; }
      if (r.ok && !r.noop) this.saved.recordVisit(rec.id, { dataset: rec.dataset, ...(opts.context ? { context: opts.context } : {}) });
      return r;
    });
  }

  /** Fly again to the current selection (the inspector's "fly to this object"). false when nothing is selected or the record is not cached. */
  refocus(): boolean {
    const sel = this.selection;
    const rec = sel === null ? undefined : this.peek(sel);
    if (!this.nav || !this.host || !rec) return false;
    this.host.focus(this.nav.plan(rec, 'fly to selection'));
    return true;
  }

  deselect(): AtlasNavResult {
    if (!this.nav) return { ok: false, error: 'no-host', message: 'The viewer is not attached.' };
    this.cause = 'deselect'; this.lastReason = 'cleared'; this.lastFocus = false;
    return this.nav.deselect();
  }
  back(): AtlasNavResult { return this.jump('back', () => this.nav!.back()); }
  forward(): AtlasNavResult { return this.jump('forward', () => this.nav!.forward()); }
  returnToPrevious(): AtlasNavResult { return this.jump('previous', () => this.nav!.returnToPrevious()); }
  private jump(cause: SelectionEvent['cause'], f: () => NavResult): AtlasNavResult {
    if (!this.nav) return { ok: false, error: 'no-host', message: 'The viewer is not attached.' };
    this.cause = cause; this.lastReason = cause === 'back' ? 'back' : cause === 'forward' ? 'forward' : 'returned to the previous place'; this.lastFocus = true;
    return f();
  }

  /**
   * "Back out one level": select the physical or structural parent of the current selection (what it orbits, what it is part of) from the relation graph.
   * Associations ("listed with") only with includeAssociation. Parents that cannot be resolved, or that `exclude` rejects, are skipped.
   *
   * `fallback` is the viewer's own parent flight (a scale flight such as "Solar System overview" or "Local Group view"), used when the relation data offers no usable
   * parent or nothing is selected. With a selection the atlas first records a deselect (so the step is in the SAME history: back returns to the object and the view
   * the user left), then runs the fallback. Result: `fallback: true` when it ran.
   */
  async parent(opts: { readonly includeAssociation?: boolean; readonly exclude?: (link: RelationLinkView) => boolean; readonly fallback?: (ctx: { readonly hadSelection: boolean }) => void } = {}): Promise<ParentResult> {
    const sel = this.selection;
    const runFallback = (hadSelection: boolean): ParentResult => {
      if (hadSelection) this.deselect();
      opts.fallback!({ hadSelection });
      return { ok: true, noop: false, fallback: true };
    };
    if (sel === null) return opts.fallback ? runFallback(false) : { ok: false, error: 'no-selection', message: 'Nothing is selected.' };
    let links: readonly RelationLinkView[];
    try { links = await this.engine.parentsOf(sel, opts.includeAssociation ?? false); } catch { links = []; }
    for (const link of links) {
      if (opts.exclude?.(link)) continue;
      if (!(await this.getRecord(link.id))) continue;
      const r = await this.select(link.id, { reason: `parent: ${link.relation.statement}` });
      return r.ok ? { ...r, via: link } : r;
    }
    if (opts.fallback) return runFallback(true);
    return { ok: false, error: 'no-parent', message: 'The relation data lists no parent for this object.' };
  }

  /** Mark objects in the viewer (e.g. nearby results). Fetches the records first, because the host places the markers from their positions. */
  async highlight(ids: readonly UniversalId[]): Promise<void> {
    if (!this.host) return;
    await this.getRecords(ids);
    this.host.highlight(ids);
  }
}

// ---- construction helpers ------------------------------------------------------------------------------------------------------

/** An atlas whose engine runs on the calling thread over `source` (tests, no-Worker fallback). */
export function createInlineAtlas(source: DataSource, opts: Omit<AtlasOptions, 'engine' | 'notesSource'> & { readonly engine?: Omit<EngineOptions, 'emit'>; readonly notesSource?: DataSource } = {}): DiscoveryAtlas {
  const { engine: engineOpts, notesSource, ...rest } = opts;
  return new DiscoveryAtlas({ ...rest, engine: new InlineEngineClient(source, engineOpts), notesSource: notesSource ?? source });
}

/** The browser atlas: engine in a Web Worker over `<base>data/...`, notes fetched on this thread. Falls back to the inline engine if the Worker cannot be created. */
export async function createBrowserAtlas(base: string, opts: Omit<AtlasOptions, 'engine' | 'notesSource'> & { readonly indexTwoMrs?: boolean } = {}): Promise<DiscoveryAtlas> {
  const { indexTwoMrs, ...rest } = opts;
  const source = new HttpDataSource(base);
  let engine: EngineClient;
  try {
    const { WorkerEngineClient } = await import('./workerClient');
    engine = new WorkerEngineClient(base, { indexTwoMrs: indexTwoMrs ?? true });
  } catch (e) {
    console.warn('The discovery Worker is unavailable; the engine runs on the page thread.', e);
    engine = new InlineEngineClient(source, { indexTwoMrs: indexTwoMrs ?? true });
  }
  return new DiscoveryAtlas({ ...rest, engine, notesSource: source });
}

export type { HistoryEntry };
