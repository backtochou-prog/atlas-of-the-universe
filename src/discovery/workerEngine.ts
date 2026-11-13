/**
 * The discovery engine (Prompt 07, R2a): loads the datasets in stages, adapts them to DiscoveryRecord, merges duplicates, builds the search index,
 * record store, KD-tree, relation graph, facets and discovery lists, and answers queries. Pure TypeScript, no DOM and no Three.js, so the same class
 * runs inside a Web Worker (worker.ts: the browser) or on the calling thread (InlineEngine in atlas.ts: tests, no-Worker fallback).
 *
 * WHY A WORKER. Measured on the real data (node, cold JIT, see docs/DISCOVERY_ENGINE_RUNTIME.md): recordsFromGaia 0.8 s, mergeRecords 1.3 s, RecordStore.from 0.65 s,
 * SearchIndex.add of 90,971 records 3.2 s. The first three cannot be cut into slices without changing the R1 modules, so the whole pipeline lives off the page thread.
 * Inside the worker the loops that CAN be cut (SearchIndex.add) are time-sliced (scheduler.ts, <= 8 ms slices) so a query typed during indexing is
 * answered between slices; the steps that cannot be cut delay a query by at most their own duration (reported by stats().longestBlockingStepMs).
 *
 * STAGES
 *   0  gaia + simbad + solar + deep -> records -> index #0 (live as it fills; "readyForSearch" when complete). Solar System and deep objects are indexed first.
 *   1  bright-stars + exoplanets + other-objects + relations -> mergeRecords (one record per star: Gaia wins) -> index #1 built in the background and swapped in
 *      atomically (index #0 answers queries until then) -> RecordStore, KD-tree, facets, relation graph, lists.
 *   2  ungc + mcconnachie + twomrs point catalogues, lowest priority: added to the live index in slices, then the store / tree / graph / lists are rebuilt once.
 * A failed dataset is recorded in the status and skipped; everything else keeps working. Nothing here throws to the caller and nothing rejects unhandled.
 *
 * 2MRS DECISION. The 43,533 2MRS rows (named "2MASX J...") are IN the store (filters, facets, nearby, galaxy lists use their real redshifts) and by default also
 * in the search index, so "2MASX J09554244+6903335" finds its row. Measured on the real data (node): +1.2 to 1.5 s of index time (in the worker, sliced) and about +10 MB of heap (167 vs 157 MB for the whole engine) for an identifier a
 * user rarely types. `indexTwoMrs: false` keeps them out of the index (they stay resolvable by id and reachable through nearby / filters).
 */
import { createUniverseFrames, NEIGHBOURHOOD_FRAME } from '../data/catalogue/frames';
import { GaiaCatalogue } from '../data/catalogue/catalogue';
import { DeepSpaceData } from '../data/deepspace/deepSpaceData';
import { SolarSystemData } from '../data/solar/solarCatalogue';
import { METRES_PER_AU, METRES_PER_PARSEC } from '../core/units';
import type { FrameTree, SpatialPosition } from '../core/spatial/frames';
import type { Vec3 } from '../core/spatial/vec3';
import {
  brightestStars, fastestProperMotion, hottestExoplanets, largestExoplanets, largestNebulae, mostPlanetsInSystem, nearestExoplanetSystems, nearestGalaxies, nearestStars,
  planetCountsByHost, shortestPeriodExoplanets, type DiscoveryList,
} from './discover';
import { availableFacets, evaluateFilter, type Facets, type FilterSpec } from './filters';
import { DATASET_LABEL, DATASET_STAGE, type DataSource, type DatasetKey, type DatasetPayloads } from './loader';
import { SOLAR_SYSTEM_FRAME, findNearby, heliocentricDomain, solarDomain, visibleRegion, type NearbyDomain, type SolarBodyPosition } from './nearby';
import {
  mergeRecords, recordsFromBrightStars, recordsFromDeep, recordsFromExoplanets, recordsFromGaia, recordsFromOther, recordsFromPoints, recordsFromSolar,
} from './records';
import { mergePointDuplicates } from './pointMerge';
import { RecordStore, wholeStore } from './recordStore';
import {
  RelationGraph, parseRelationsFile, relationsFromDeep, relationsFromExoplanets, relationsFromSameAs, relationsFromSolar, type RelationLink,
} from './relations';
import { runSliced, macrotaskYield, type Yielder } from './scheduler';
import { DEFAULT_LIMIT, MAX_LIMIT, SearchIndex, type SearchResult } from './searchIndex';
import { buildSpatialIndex, type KdTree } from './spatialIndex';
import type { DiscoveryRecord, ExoplanetFile, Relation, RelationBasis, UniversalId } from './types';
import type {
  AtlasPhase, AtlasSearchHit, AtlasSearchResult, AtlasStatus, DatasetStatus, EngineApi, EngineEvent, EngineStats, FilterOutcome, ListsOutcome, NearbyOutcome,
  NearbyRequest, AtlasSystemMember, RelationGroups, RelationLinkView, RelationsOutcome, SearchRequest, SolarBodyOffset, VisibleOutcome, VisibleRequest,
} from './engineApi';

export interface EngineOptions {
  readonly yield?: Yielder;
  /** Target length of one index-building slice, ms. Default 8. */
  readonly targetSliceMs?: number;
  /** Put the 2MRS rows into the search index (default true; see the header). */
  readonly indexTwoMrs?: boolean;
  readonly emit?: (e: EngineEvent) => void;
  readonly now?: () => number;
  /** Visualisation extent of the solar-system frame, AU (matches SolarHierarchy). */
  readonly solarFrameRadiusAu?: number;
}

/** Datasets the engine loads itself (notes are loaded by the page thread: they are small and needed synchronously). */
const ENGINE_KEYS: readonly DatasetKey[] = ['gaia', 'simbad', 'solar', 'deep', 'bright-stars', 'exoplanets', 'other-objects', 'relations', 'ungc', 'mcconnachie', 'twomrs'];

/** Approximate share of the progress bar for each step. Only ever advances. */
const STEP_WEIGHT: Readonly<Record<string, number>> = {
  'load-0': 0.12, 'index-0': 0.16,
  'load-1': 0.08, 'merge': 0.09, 'index-1': 0.20, 'store-1': 0.08,
  'load-2': 0.07, 'index-2': 0.10, 'store-2': 0.10,
};
const STEP_ORDER = Object.keys(STEP_WEIGHT);

interface QueryState {
  readonly store: RecordStore;
  readonly tree: KdTree;
  readonly facets: Facets;
  readonly graph: RelationGraph;
  readonly lists: readonly DiscoveryList[];
  readonly complete: boolean;
}

const CATALOGUE_ROW_DATASETS: ReadonlySet<string> = new Set(['ungc', 'local-group-mcconnachie', 'twomrs']);
const emptySearch = (query: string): AtlasSearchResult => ({ query, normalized: null, hits: [], total: 0, totalIsLowerBound: false, categoryCounts: {}, fuzzyUsed: false });
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class AtlasEngine implements EngineApi {
  private readonly yielder: Yielder;
  private readonly now: () => number;
  private readonly targetMs: number;
  private readonly indexTwoMrs: boolean;
  private readonly emit: (e: EngineEvent) => void;
  private readonly frames: FrameTree;

  private readonly ds = new Map<DatasetKey, DatasetStatus>();
  private phase: AtlasPhase = 'idle';
  private activity = '';
  private progressDone = 0;
  private progressFrac = 0;
  private progressStep = '';
  private lastEmit = 0;
  private readyForSearch = false;
  private startPromise: Promise<void> | null = null;
  private complete = false;
  private readonly timings: { step: string; ms: number; maxSliceMs?: number; slices?: number }[] = [];

  private index: SearchIndex | null = null;
  private q: QueryState | null = null;
  private aliases = new Map<UniversalId, UniversalId>();
  private mergedRecords: DiscoveryRecord[] = [];
  private pointRecords: DiscoveryRecord[] = [];
  private pointNames = new Map<string, Map<string, number>>();
  private solarData: SolarSystemData | null = null;
  private deepData: DeepSpaceData | null = null;
  private exoFile: ExoplanetFile | null = null;
  private curated: Relation[] = [];
  private twoMrsIndexed = false;

  constructor(private readonly source: DataSource, opts: EngineOptions = {}) {
    this.yielder = opts.yield ?? macrotaskYield;
    this.now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.targetMs = opts.targetSliceMs ?? 8;
    this.indexTwoMrs = opts.indexTwoMrs ?? true;
    this.emit = opts.emit ?? (() => undefined);
    this.frames = createUniverseFrames().add({ id: SOLAR_SYSTEM_FRAME, parent: NEIGHBOURHOOD_FRAME, origin: [0, 0, 0], radius: (opts.solarFrameRadiusAu ?? 100) * METRES_PER_AU });
    for (const key of ENGINE_KEYS) this.ds.set(key, { key, label: DATASET_LABEL[key], stage: DATASET_STAGE[key], state: 'pending', count: null });
  }

  // ---- status ----------------------------------------------------------------------------------------------------------------

  private setDs(key: DatasetKey, patch: Partial<DatasetStatus>): void {
    this.ds.set(key, { ...this.ds.get(key)!, ...patch });
    this.emitStatus(true);
  }

  private statusNow(): AtlasStatus {
    const datasets = ENGINE_KEYS.map((k) => this.ds.get(k)!);
    const w = STEP_WEIGHT[this.progressStep] ?? 0;
    const total = STEP_ORDER.reduce((a, k) => a + STEP_WEIGHT[k]!, 0);
    const progress = this.complete ? 1 : Math.min(0.999, (this.progressDone + w * this.progressFrac) / total);
    return {
      phase: this.phase, datasets, progress, activity: this.activity, readyForSearch: this.readyForSearch,
      readyForQueries: this.q !== null, complete: this.complete, searchable: this.index?.size ?? 0, records: this.q?.store.count ?? 0,
      failed: datasets.filter((d) => d.state === 'failed').map((d) => d.key),
    };
  }

  private emitStatus(force = false): void {
    const t = this.now();
    if (!force && t - this.lastEmit < 80) return;
    this.lastEmit = t;
    try { this.emit({ type: 'status', status: this.statusNow() }); } catch { /* a listener must not break the engine */ }
  }

  private beginStep(step: string, activity: string): void { this.progressStep = step; this.progressFrac = 0; this.activity = activity; this.emitStatus(true); }
  private endStep(step: string): void { this.progressDone += STEP_WEIGHT[step] ?? 0; this.progressFrac = 0; this.progressStep = ''; }

  async status(): Promise<AtlasStatus> { return this.statusNow(); }

  private timed<T>(step: string, f: () => T): T {
    const t0 = this.now();
    try { return f(); } finally { this.timings.push({ step, ms: this.now() - t0 }); }
  }

  // ---- dataset helper ---------------------------------------------------------------------------------------------------------

  /** Load a dataset and adapt it; any failure marks the dataset failed (with the reason) and yields undefined. */
  private async dataset<K extends DatasetKey, R>(key: K, adapt: (payload: DatasetPayloads[K]) => R | Promise<R>, count: (r: R) => number): Promise<R | undefined> {
    const t0 = this.now();
    this.setDs(key, { state: 'loading' });
    try {
      const payload = await this.source.load(key);
      const r = await adapt(payload);
      this.setDs(key, { state: 'ready', count: count(r), ms: Math.round(this.now() - t0) });
      return r;
    } catch (e) {
      this.setDs(key, { state: 'failed', error: msg(e), ms: Math.round(this.now() - t0) });
      return undefined;
    }
  }

  // ---- the pipeline ---------------------------------------------------------------------------------------------------------

  start(): Promise<void> {
    this.startPromise ??= this.run().catch((e) => {
      // Defensive: run() handles every expected failure itself.
      this.activity = `engine stopped: ${msg(e)}`;
      this.complete = true;
      this.phase = 'ready';
      this.emitStatus(true);
    });
    return this.startPromise;
  }

  private async run(): Promise<void> {
    await this.stage0();
    await this.stage1();
    await this.stage2();
    this.phase = 'ready';
    this.complete = true;
    this.activity = '';
    this.emitStatus(true);
  }

  private async sliceIndex(index: SearchIndex, records: readonly DiscoveryRecord[], step: string, label: string): Promise<void> {
    this.beginStep(step, label);
    const stats = await runSliced(records, (batch) => { index.add(batch); }, {
      targetMs: this.targetMs, yield: this.yielder, now: this.now, initialBatch: 50,
      onProgress: (done, total) => { this.progressFrac = total === 0 ? 1 : done / total; this.emitStatus(); },
    });
    this.timings.push({ step, ms: stats.totalMs, maxSliceMs: stats.maxSliceMs, slices: stats.slices });
    this.endStep(step);
  }

  private async stage0(): Promise<void> {
    this.phase = 'stage0';
    this.beginStep('load-0', 'loading the Gaia subset, Solar System and deep-space objects');
    const simbadP = this.dataset('simbad', (f) => f, (f) => f.manifest?.matched ?? 0);
    const gaiaP = this.dataset('gaia', async (f) => {
      const simbad = await simbadP;                                  // identifiers are optional: without them the Gaia records are named by source id
      await this.yielder();
      const cat = GaiaCatalogue.fromFile(f);
      return this.timed('adapter gaia', () => recordsFromGaia(cat, simbad ?? null));
    }, (r) => r.length);
    const solarP = this.dataset('solar', (f) => {
      const data = SolarSystemData.fromFile(f);
      this.solarData = data;
      return recordsFromSolar(data);
    }, (r) => r.length);
    const deepP = this.dataset('deep', (f) => {
      const data = DeepSpaceData.fromFile(f, [], { validate: false });
      this.deepData = data;
      return recordsFromDeep(data);
    }, (r) => r.length);
    const [solarRecs, deepRecs, gaiaRecs] = await Promise.all([solarP, deepP, gaiaP]);
    this.endStep('load-0');

    const index = new SearchIndex();
    this.index = index;                                              // live while it fills: a query during indexing sees what is indexed so far
    this.stage0Records = [...(solarRecs ?? []), ...(deepRecs ?? []), ...(gaiaRecs ?? [])];
    await this.sliceIndex(index, this.stage0Records, 'index-0', 'indexing the Solar System, deep-space objects and the Gaia subset');
    this.readyForSearch = true;
    this.emitStatus(true);
  }
  private stage0Records: DiscoveryRecord[] = [];

  private async stage1(): Promise<void> {
    this.phase = 'stage1';
    this.beginStep('load-1', 'loading Hipparcos stars, exoplanets and curated objects');
    const hipP = this.dataset('bright-stars', (f) => this.timed('adapter bright-stars', () => recordsFromBrightStars(f)), (r) => r.length);
    const exoP = this.dataset('exoplanets', (f) => {
      this.exoFile = f;
      return this.timed('adapter exoplanets', () => recordsFromExoplanets(f));
    }, (r) => r.length);
    const otherP = this.dataset('other-objects', (f) => recordsFromOther(f), (r) => r.length);
    const relP = this.dataset('relations', (f) => {
      const parsed = parseRelationsFile(f);
      this.curated = parsed.relations;
      return parsed.relations;
    }, (r) => r.length);
    const [hip, exo, other] = await Promise.all([hipP, exoP, otherP, relP]);
    this.endStep('load-1');
    await this.yielder();

    let records = this.stage0Records;
    let aliases = new Map<UniversalId, UniversalId>();
    const added = [...(hip ?? []), ...(exo ?? []), ...(other ?? [])];
    this.beginStep('merge', 'merging duplicate stars across datasets');
    if (added.length > 0) {
      const followHost = this.exoFile ? new Map(relationsFromExoplanets(this.exoFile).map((r) => [r.from, r.to] as const)) : undefined;
      const merged = this.timed('mergeRecords', () => mergeRecords([...this.stage0Records, ...added], followHost ? { followHost } : {}));
      records = merged.records;
      aliases = merged.aliases;
    }
    this.endStep('merge');
    this.mergedRecords = records;
    this.aliases = aliases;

    // Index #1: built in the background with index #0 serving queries, then swapped in atomically.
    if (added.length > 0) {
      const next = new SearchIndex();
      await this.sliceIndex(next, records, 'index-1', 'indexing the merged atlas');
      this.index = next;
    } else { this.progressDone += STEP_WEIGHT['index-1']!; }
    this.emit({ type: 'aliases', entries: [...aliases] });
    this.emitStatus(true);

    await this.buildQueryState('store-1', false);
  }

  private async stage2(): Promise<void> {
    this.phase = 'stage2';
    this.beginStep('load-2', 'loading galaxy point catalogues');
    const mk = (key: 'ungc' | 'mcconnachie' | 'twomrs', fileId: string): Promise<DiscoveryRecord[] | undefined> =>
      this.dataset(key, (f) => {
        const names = new Map<string, number>();
        const col = (f as { columns?: Record<string, readonly unknown[]> }).columns?.['name'] ?? [];
        col.forEach((n, i) => { if (typeof n === 'string' && !names.has(n)) names.set(n, i); });
        this.pointNames.set(fileId, names);
        return this.timed(`adapter ${key}`, () => recordsFromPoints(f));
      }, (r) => r.length);
    const [ungc, mcc, twomrs] = await Promise.all([mk('ungc', 'ungc'), mk('mcconnachie', 'local-group-mcconnachie'), mk('twomrs', 'twomrs')]);
    this.endStep('load-2');

    // Rows that are the same galaxy as a curated one (M31 = "Andromeda", LMC, SMC, M32, NGC 5128 ...) are merged into the curated record: the curated record wins and
    // keeps the row's names searchable; the row's id becomes an alias. Same duplicate rule as the structure renderer (duplicates.ts).
    const allSmall = [...(ungc ?? []), ...(mcc ?? [])];
    const pm = this.timed('mergePointDuplicates', () => mergePointDuplicates(this.mergedRecords, [...allSmall, ...(twomrs ?? [])]));
    if (pm.aliases.size > 0) {
      this.mergedRecords = this.mergedRecords.map((r) => pm.updated.get(r.id) ?? r);
      if (this.index) for (const rec of pm.updated.values()) this.index.extend(rec);
      this.aliases = new Map([...this.aliases, ...pm.aliases]);
      this.emit({ type: 'aliases', entries: [...this.aliases] });
    }
    const dropped = new Set(pm.aliases.keys());
    const small = dropped.size === 0 ? allSmall : allSmall.filter((r) => !dropped.has(r.id));
    const twomrsKept = twomrs === undefined ? undefined : dropped.size === 0 ? twomrs : twomrs.filter((r) => !dropped.has(r.id));
    this.pointRecords = [...small, ...(twomrsKept ?? [])];
    const toIndex = twomrsKept && this.indexTwoMrs ? small.concat(twomrsKept) : small;
    if (this.index && toIndex.length > 0) {
      await this.sliceIndex(this.index, toIndex, 'index-2', 'indexing galaxy catalogues (lowest priority)');
      this.twoMrsIndexed = twomrs !== undefined && this.indexTwoMrs;
    } else this.progressDone += STEP_WEIGHT['index-2']!;
    if (this.pointRecords.length > 0) await this.buildQueryState('store-2', true);
    else {
      this.progressDone += STEP_WEIGHT['store-2']!;
      if (this.q) this.q = { ...this.q, complete: true };
    }
  }

  /** (Re)build store, tree, facets, graph and lists from the merged records (+ point records at the end). Swapped in atomically. */
  private async buildQueryState(step: string, final: boolean): Promise<void> {
    this.beginStep(step, 'building the spatial index, filters and relations');
    await this.yielder();
    const all = final ? this.mergedRecords.concat(this.pointRecords) : this.mergedRecords;
    const store = this.timed('RecordStore.from', () => RecordStore.from(all));
    this.progressFrac = 0.35; this.emitStatus();
    await this.yielder();
    const tree = this.timed('buildSpatialIndex', () => buildSpatialIndex(store));
    this.progressFrac = 0.5; this.emitStatus();
    await this.yielder();
    const facets = this.timed('availableFacets', () => availableFacets(store));
    await this.yielder();
    const graph = this.timed('RelationGraph', () => this.buildGraph(store, final));
    this.progressFrac = 0.7; this.emitStatus();
    await this.yielder();
    const lists = this.timed('lists', () => this.computeLists(store, graph));
    this.q = { store, tree, facets, graph, lists, complete: final };
    this.endStep(step);
    this.emitStatus(true);
  }

  private buildGraph(store: RecordStore, withPoints: boolean): RelationGraph {
    const rels: Relation[] = [];
    try { if (this.solarData) rels.push(...relationsFromSolar(this.solarData)); } catch { /* skipped */ }
    try {
      if (this.deepData) {
        const pointRow = withPoints ? (f: string, n: string): number | undefined => this.pointNames.get(f)?.get(n) : undefined;
        rels.push(...relationsFromDeep(this.deepData.all() as never, pointRow ? { pointRow } : {}));
      }
    } catch { /* skipped */ }
    if (this.exoFile) rels.push(...relationsFromExoplanets(this.exoFile));
    rels.push(...relationsFromSameAs(store.records, { known: (id) => store.indexOfId(id) >= 0 }));
    rels.push(...this.curated);
    return new RelationGraph(rels, this.aliases);
  }

  private computeLists(store: RecordStore, graph: RelationGraph): DiscoveryList[] {
    const view = wholeStore(store);
    const out: DiscoveryList[] = [];
    const tryList = (f: () => DiscoveryList): void => { try { out.push(f()); } catch { /* one list failing must not remove the others */ } };
    let counts: Map<UniversalId, number> | null = null;
    try { counts = planetCountsByHost(graph, store); } catch { counts = null; }
    tryList(() => nearestStars(view, 10));
    tryList(() => brightestStars(view, 10));
    tryList(() => fastestProperMotion(view, 10));
    if (counts) { const c = counts; tryList(() => nearestExoplanetSystems(view, c, 10)); tryList(() => mostPlanetsInSystem(view, c, 10)); }
    tryList(() => hottestExoplanets(view, 10));
    tryList(() => shortestPeriodExoplanets(view, 10));
    tryList(() => largestExoplanets(view, 10));
    tryList(() => nearestGalaxies(view, 10));
    tryList(() => largestNebulae(view, 10));
    return out;
  }

  // ---- queries -----------------------------------------------------------------------------------------------------------------

  private lookup(canonical: UniversalId): DiscoveryRecord | undefined {
    const r = this.index?.get(canonical);
    if (r) return r;
    const q = this.q;
    if (q) { const i = q.store.indexOfId(canonical); if (i >= 0) return q.store.recordAt(i); }
    return undefined;
  }

  async resolve(id: UniversalId): Promise<UniversalId | undefined> {
    const c = this.aliases.get(id) ?? id;
    return this.lookup(c) ? c : undefined;
  }
  async getRecord(id: UniversalId): Promise<DiscoveryRecord | undefined> { return this.lookup(this.aliases.get(id) ?? id); }
  async getRecords(ids: readonly UniversalId[]): Promise<(DiscoveryRecord | undefined)[]> { return ids.map((id) => this.lookup(this.aliases.get(id) ?? id)); }

  async search(query: string, opts: SearchRequest = {}): Promise<AtlasSearchResult> {
    const idx = this.index;
    if (!idx || typeof query !== 'string') return emptySearch(String(query ?? ''));
    // Curated records outrank catalogue rows of the SAME match quality: the McConnachie row "Andromeda" and the curated Andromeda Galaxy (M31) are one galaxy, and the
    // curated record (image, explanation, view rules) is the one a user means. So more hits are fetched, regrouped by (match step, tier) and cut to the limit.
    const want = Math.max(1, Math.min(MAX_LIMIT, Math.floor(opts.limit ?? DEFAULT_LIMIT)));
    let r: SearchResult;
    const paged = (opts.offset ?? 0) > 0;                          // a page other than the first keeps the index's own order
    try { r = idx.search(query, paged ? opts : { ...opts, limit: Math.min(MAX_LIMIT, want * 3) }); } catch { return emptySearch(query); }
    const tier = (h: SearchResult['hits'][number]): number => (CATALOGUE_ROW_DATASETS.has(h.dataset) ? 1 : 0);
    const step = (h: SearchResult['hits'][number]): number => Math.floor(h.score / 1000);
    const ordered = (paged ? r.hits.map((h, i) => ({ h, i })) : r.hits.map((h, i) => ({ h, i })).sort((a, b) => step(b.h) - step(a.h) || tier(a.h) - tier(b.h) || a.i - b.i)).map((x) => x.h).slice(0, want);
    const hits: AtlasSearchHit[] = ordered.map((h) => {
      const rec = idx.at(h.index);
      return { ...h, classification: rec?.classification ?? '', drawn: rec?.drawn ?? false };
    });
    return { ...r, hits };
  }

  private view(l: RelationLink): RelationLinkView {
    const rec = this.lookup(l.id);
    return { ...l, name: rec?.name, category: rec?.category };
  }

  async relationsOf(id: UniversalId, limitPerGroup = 200): Promise<RelationsOutcome> {
    const canonical = this.aliases.get(id) ?? id;
    const groups: Record<RelationBasis, RelationLinkView[]> = { 'physical-gravitational': [], structural: [], 'spatial-association': [], identity: [] };
    const g = this.q?.graph;
    let total = 0;
    if (g) {
      const links: RelationLink[] = [
        ...g.outgoing(canonical).map((relation) => ({ id: relation.to, relation, direction: 'out' as const })),
        ...g.incoming(canonical).map((relation) => ({ id: relation.from, relation, direction: 'in' as const })),
      ];
      for (const l of links) {
        total++;
        const list = groups[l.relation.basis];
        if (list.length < limitPerGroup) list.push(this.view(l));
      }
    }
    return { id, canonical, groups: groups as RelationGroups, total };
  }

  async parentsOf(id: UniversalId, includeAssociation = false): Promise<readonly RelationLinkView[]> {
    const g = this.q?.graph;
    if (!g) return [];
    const basis: readonly RelationBasis[] | undefined = includeAssociation ? undefined : ['physical-gravitational', 'structural'];
    return g.parentsOf(this.aliases.get(id) ?? id, basis ? { basis } : {}).map((l) => this.view(l));
  }

  async facets(): Promise<Facets | null> { return this.q?.facets ?? null; }

  async filter(spec: FilterSpec, opts: { readonly limit?: number } = {}): Promise<FilterOutcome | null> {
    const q = this.q;
    if (!q) return null;
    const r = evaluateFilter(q.store, spec);
    const limit = Math.max(0, Math.min(5000, Math.floor(opts.limit ?? 200)));
    const ids: UniversalId[] = [];
    for (let i = 0; i < r.indices.length && ids.length < limit; i++) ids.push(q.store.idAt(r.indices[i]!));
    const { indices: _drop, ...rest } = r;
    void _drop;
    return { ...rest, ids, truncated: r.count > ids.length, complete: q.complete };
  }

  async lists(): Promise<ListsOutcome | null> { return this.q ? { lists: this.q.lists, complete: this.q.complete } : null; }

  private solarDomainFor(bodies: readonly SolarBodyOffset[] | undefined): NearbyDomain | null {
    if (!bodies || bodies.length === 0) return null;
    const list: SolarBodyPosition[] = [];
    for (const b of bodies) {
      const rec = this.lookup(b.id);
      if (!rec) continue;
      list.push({ id: b.id, category: rec.category, dataset: rec.dataset, offsetMetres: b.offsetMetres });
    }
    return list.length > 0 ? solarDomain(() => list) : null;
  }

  async nearby(req: NearbyRequest): Promise<NearbyOutcome> {
    const q = this.q;
    if (!q) return { ok: false, error: 'not-ready', message: 'The atlas is still loading; nearby objects are not available yet.' };
    let origin: SpatialPosition;
    let originId: UniversalId | undefined;
    const o = req.origin;
    const solarDom = this.solarDomainFor(req.solarBodies);
    if (o.kind === 'id') {
      const canonical = this.aliases.get(o.id) ?? o.id;
      const rec = this.lookup(canonical);
      if (!rec) return { ok: false, error: 'unknown-id', message: `"${o.id}" is not an object in the loaded datasets.` };
      originId = canonical;
      const p = rec.position;
      if (p.kind === 'solar') {
        const body = req.solarBodies?.find((b) => b.id === canonical);
        if (!body) return { ok: false, error: 'no-solar-position', message: `${rec.name} is in the Solar System; its position at the current time was not supplied.` };
        origin = { frame: SOLAR_SYSTEM_FRAME, offset: body.offsetMetres };
      } else if (p.kind === 'icrs' && p.xyzPc.every(Number.isFinite)) {
        origin = { frame: NEIGHBOURHOOD_FRAME, offset: [p.xyzPc[0] * METRES_PER_PARSEC, p.xyzPc[1] * METRES_PER_PARSEC, p.xyzPc[2] * METRES_PER_PARSEC] };
      } else return { ok: false, error: 'no-position', message: `${rec.name} has no 3D position (its distance is unknown), so nothing can be said to be near it.` };
    } else if (o.kind === 'position') {
      if (!o.positionPc.every(Number.isFinite)) return { ok: false, error: 'invalid', message: 'The origin position is not finite.' };
      origin = { frame: NEIGHBOURHOOD_FRAME, offset: [o.positionPc[0] * METRES_PER_PARSEC, o.positionPc[1] * METRES_PER_PARSEC, o.positionPc[2] * METRES_PER_PARSEC] };
    } else {
      if (!o.offsetMetres.every(Number.isFinite)) return { ok: false, error: 'invalid', message: 'The origin position is not finite.' };
      origin = { frame: SOLAR_SYSTEM_FRAME, offset: o.offsetMetres };
    }
    const domains: NearbyDomain[] = [];
    if (solarDom) domains.push(solarDom);
    domains.push(heliocentricDomain(q.store, q.tree));
    const system = originId !== undefined ? this.systemOf(originId, q.graph) : [];
    const systemIds = new Set(system.map((m) => m.id));
    try {
      const r = findNearby({
        origin, frames: this.frames, domains, ...(req.k !== undefined ? { k: Math.min(1000, Math.floor(req.k) + systemIds.size) } : {}),
        ...(req.radiusMetres !== undefined ? { radiusMetres: req.radiusMetres } : {}),
        ...(req.categories ? { categories: req.categories } : {}), ...(req.datasets ? { datasets: req.datasets } : {}), ...(originId !== undefined ? { originId } : {}),
      });
      const own = systemIds.size === 0 ? r.neighbours : r.neighbours.filter((n) => !systemIds.has(n.id));
      return {
        ok: true, originFrame: origin.frame, ...(originId !== undefined ? { originId } : {}),
        neighbours: (req.k !== undefined ? own.slice(0, Math.floor(req.k)) : own).map((n) => ({ ...n, name: this.lookup(n.id)?.name ?? n.id })),
        ...(system.length > 0 ? { system } : {}),
      };
    } catch (e) { return { ok: false, error: 'invalid', message: msg(e) }; }
  }

  /**
   * The planetary system of an exoplanet or a star with confirmed planets: the host and all planets except the origin, from the physical 'orbits' relations
   * (planet -> host, NASA Exoplanet Archive). They share the host's position exactly (distance 0), so they are system members, not neighbours. Solar System
   * moons and planets are NOT treated this way: they are at real, different positions.
   */
  private systemOf(origin: UniversalId, graph: RelationGraph): AtlasSystemMember[] {
    const rec = this.lookup(origin);
    if (!rec) return [];
    const isPlanet = (id: UniversalId): boolean => this.lookup(id)?.category === 'exoplanet';
    let host = origin;
    if (rec.category === 'exoplanet') {
      const up = graph.outgoing(origin).find((r) => r.kind === 'orbits' && r.basis === 'physical-gravitational');
      if (!up) return [];
      host = this.aliases.get(up.to) ?? up.to;
    }
    const planets = graph.incoming(host).filter((r) => r.kind === 'orbits' && r.basis === 'physical-gravitational' && isPlanet(r.from)).map((r) => this.aliases.get(r.from) ?? r.from);
    if (planets.length === 0) return [];
    const out: AtlasSystemMember[] = [];
    const push = (id: UniversalId, role: AtlasSystemMember['role']): void => {
      if (id === origin || out.some((m) => m.id === id)) return;
      const r = this.lookup(id);
      if (r) out.push({ id, name: r.name, category: r.category, role });
    };
    push(host, 'host');
    for (const p of planets) push(p, 'planet');
    return out;
  }

  async visible(req: VisibleRequest): Promise<VisibleOutcome> {
    const q = this.q;
    if (!q) return { ok: false, error: 'not-ready', message: 'The atlas is still loading.' };
    const domains: NearbyDomain[] = [];
    const sd = this.solarDomainFor(req.solarBodies);
    if (sd) domains.push(sd);
    domains.push(heliocentricDomain(q.store, q.tree));
    const cam: SpatialPosition = { frame: NEIGHBOURHOOD_FRAME, offset: [req.cameraPc[0] * METRES_PER_PARSEC, req.cameraPc[1] * METRES_PER_PARSEC, req.cameraPc[2] * METRES_PER_PARSEC] as Vec3 };
    try {
      const r = visibleRegion({
        camera: cam, frames: this.frames, domains, forward: req.forward, up: req.up, fovYDeg: req.fovYDeg, aspect: req.aspect, maxDistanceMetres: req.maxDistanceMetres,
        ...(req.nearMetres !== undefined ? { nearMetres: req.nearMetres } : {}), ...(req.categories ? { categories: req.categories } : {}), ...(req.limit !== undefined ? { limit: req.limit } : {}),
      });
      return { ok: true, total: r.total, truncated: r.truncated, objects: r.objects.map((v) => ({ ...v, name: this.lookup(v.id)?.name ?? v.id })) };
    } catch (e) { return { ok: false, error: 'invalid', message: msg(e) }; }
  }

  async stats(): Promise<EngineStats> {
    const blocking = this.timings.filter((t) => t.slices === undefined);
    const sliced = this.timings.filter((t) => t.maxSliceMs !== undefined);
    return {
      records: this.q?.store.count ?? 0, searchable: this.index?.size ?? 0, relations: this.q?.graph.size ?? 0, aliases: this.aliases.size,
      timings: this.timings.map((t) => ({ ...t })), longestBlockingStepMs: blocking.reduce((a, t) => Math.max(a, t.ms), 0),
      longestSliceMs: sliced.reduce((a, t) => Math.max(a, t.maxSliceMs ?? 0), 0), twoMrsIndexed: this.twoMrsIndexed,
    };
  }
}
