/**
 * Contract between the page thread (atlas.ts) and the discovery engine (workerEngine.ts), which runs in a Web Worker in the browser and in
 * the same thread in tests. Types only (no code), so the page can import it without bundling the engine.
 *
 * Every method is async because the engine may be in another thread. Arguments and results are structured-cloneable (no class instances, no functions).
 */
import type { Vec3 } from '../core/spatial/vec3';
import type { DatasetKey } from './loader';
import type { DiscoveryList } from './discover';
import type { FilterResult, FilterSpec, Facets } from './filters';
import type { NearbyNeighbour, VisibleObject } from './nearby';
import type { RelationLink } from './relations';
import type { SearchHit, SearchResult } from './searchIndex';
import type { DatasetId, DiscoveryRecord, ObjectCategory, Relation, RelationBasis, UniversalId } from './types';

export type DatasetState = 'pending' | 'loading' | 'ready' | 'failed';
export type AtlasPhase = 'idle' | 'stage0' | 'stage1' | 'stage2' | 'ready';

export interface DatasetStatus {
  readonly key: DatasetKey;
  readonly label: string;
  readonly stage: 0 | 1 | 2;
  readonly state: DatasetState;
  /** Records contributed to the atlas (before merging duplicates), or items for notes / relations; null until known. */
  readonly count: number | null;
  /** Why it failed (state === 'failed'). */
  readonly error?: string;
  /** Milliseconds from request to ready/failed. */
  readonly ms?: number;
}

export interface AtlasStatus {
  readonly phase: AtlasPhase;
  readonly datasets: readonly DatasetStatus[];
  /** Overall indexing progress 0..1 (loading + adapters + merge + index + store builds; weights are approximate, the value only ever increases). */
  readonly progress: number;
  /** What the engine is doing right now, for a progress line ("indexing 2MASS Redshift Survey"). Empty when ready. */
  readonly activity: string;
  /** True as soon as the first search index exists (stage 0 done): search works, on the datasets that are ready. */
  readonly readyForSearch: boolean;
  /** Stage 1 merged the duplicate stars and built the store: nearby / filters / lists / relations work. */
  readonly readyForQueries: boolean;
  /** Everything finished (successfully or degraded). */
  readonly complete: boolean;
  /** Records currently searchable. */
  readonly searchable: number;
  /** Records in the store (merged, one per object); 0 until stage 1. */
  readonly records: number;
  readonly failed: readonly DatasetKey[];
}

export type EngineEvent =
  | { readonly type: 'status'; readonly status: AtlasStatus }
  | { readonly type: 'aliases'; readonly entries: readonly (readonly [UniversalId, UniversalId])[] };

export interface AtlasSearchHit extends SearchHit {
  readonly classification: string;
  readonly drawn: boolean;
}
export interface AtlasSearchResult extends Omit<SearchResult, 'hits'> { readonly hits: readonly AtlasSearchHit[] }

export interface SearchRequest { readonly categories?: readonly ObjectCategory[]; readonly limit?: number; readonly offset?: number; readonly fuzzy?: boolean }

export type NearbyOrigin =
  | { readonly kind: 'id'; readonly id: UniversalId }
  /** Heliocentric ICRS parsecs (the stellar-neighbourhood frame, in parsecs): e.g. the camera focus. */
  | { readonly kind: 'position'; readonly positionPc: Vec3 }
  /** Metres in the solar-system frame (a point near a planet). */
  | { readonly kind: 'solar-position'; readonly offsetMetres: Vec3 };

/** A Solar System body's position at the current simulation time: metres in the solar-system frame (Sun-centred, ICRS axes). Supplied by the page: the ephemeris lives there. */
export interface SolarBodyOffset { readonly id: UniversalId; readonly offsetMetres: Vec3 }

export interface NearbyRequest {
  readonly origin: NearbyOrigin;
  /** At least one of radiusMetres and k. With both: the k nearest within the radius. */
  readonly radiusMetres?: number;
  readonly k?: number;
  readonly categories?: readonly ObjectCategory[];
  readonly datasets?: readonly DatasetId[];
  readonly solarBodies?: readonly SolarBodyOffset[];
}
export interface AtlasNeighbour extends NearbyNeighbour { readonly name: string }
/** A member of the origin's own planetary system (its host star, or its planets): same position as the origin, so NOT a neighbour. */
export interface AtlasSystemMember { readonly id: UniversalId; readonly name: string; readonly category: ObjectCategory; readonly role: 'host' | 'planet' }
export type NearbyOutcome =
  | {
    readonly ok: true; readonly neighbours: readonly AtlasNeighbour[]; readonly originId?: UniversalId; readonly originFrame: string;
    /** When the origin is an exoplanet or a star with confirmed planets: its host and planets (excluding the origin), taken from the physical 'orbits' relations. They are never in `neighbours`. */
    readonly system?: readonly AtlasSystemMember[];
  }
  | { readonly ok: false; readonly error: 'not-ready' | 'unknown-id' | 'no-position' | 'no-solar-position' | 'invalid'; readonly message: string };

export interface VisibleRequest {
  readonly cameraPc: Vec3;
  readonly forward: Vec3;
  readonly up: Vec3;
  readonly fovYDeg: number;
  readonly aspect: number;
  readonly maxDistanceMetres: number;
  readonly nearMetres?: number;
  readonly categories?: readonly ObjectCategory[];
  readonly limit?: number;
  readonly solarBodies?: readonly SolarBodyOffset[];
}
export interface AtlasVisibleObject extends VisibleObject { readonly name: string }
export type VisibleOutcome =
  | { readonly ok: true; readonly objects: readonly AtlasVisibleObject[]; readonly total: number; readonly truncated: boolean }
  | { readonly ok: false; readonly error: 'not-ready' | 'invalid'; readonly message: string };

export interface FilterOutcome extends Omit<FilterResult, 'indices'> {
  /** Matching record ids in ascending store order, at most `limit`. */
  readonly ids: readonly UniversalId[];
  readonly truncated: boolean;
  /** False while stage 2 (point catalogues) is still being added: counts then exclude those records. */
  readonly complete: boolean;
}

export type RelationGroups = Readonly<Record<RelationBasis, readonly RelationLinkView[]>>;
export interface RelationLinkView extends RelationLink { readonly name: string | undefined; readonly category: ObjectCategory | undefined }
export interface RelationsOutcome { readonly id: UniversalId; readonly canonical: UniversalId; readonly groups: RelationGroups; readonly total: number }

export interface ListsOutcome {
  readonly lists: readonly DiscoveryList[];
  /** True once computed from the final store (after stage 2). */
  readonly complete: boolean;
}

export interface EngineStats {
  readonly records: number;
  readonly searchable: number;
  readonly relations: number;
  readonly aliases: number;
  /** Wall-clock ms of each engine step, in order. */
  readonly timings: readonly { readonly step: string; readonly ms: number; readonly maxSliceMs?: number; readonly slices?: number }[];
  /** The longest uninterruptible step (an adapter, mergeRecords, RecordStore.from ...): how long the engine thread could not answer a query. */
  readonly longestBlockingStepMs: number;
  /** The longest sliced chunk of index building, ms. */
  readonly longestSliceMs: number;
  readonly twoMrsIndexed: boolean;
}

export interface EngineApi {
  /** Run all stages. Resolves when finished (also when some datasets failed: never rejects). */
  start(): Promise<void>;
  status(): Promise<AtlasStatus>;
  search(query: string, opts?: SearchRequest): Promise<AtlasSearchResult>;
  /** The canonical id for an id or alias (host:TRAPPIST-1 -> the merged record), or undefined when unknown. */
  resolve(id: UniversalId): Promise<UniversalId | undefined>;
  getRecord(id: UniversalId): Promise<DiscoveryRecord | undefined>;
  getRecords(ids: readonly UniversalId[]): Promise<(DiscoveryRecord | undefined)[]>;
  relationsOf(id: UniversalId, limitPerGroup?: number): Promise<RelationsOutcome>;
  parentsOf(id: UniversalId, includeAssociation?: boolean): Promise<readonly RelationLinkView[]>;
  facets(): Promise<Facets | null>;
  filter(spec: FilterSpec, opts?: { readonly limit?: number }): Promise<FilterOutcome | null>;
  lists(): Promise<ListsOutcome | null>;
  nearby(req: NearbyRequest): Promise<NearbyOutcome>;
  visible(req: VisibleRequest): Promise<VisibleOutcome>;
  stats(): Promise<EngineStats>;
}

export type { Relation };
