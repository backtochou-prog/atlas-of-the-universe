/**
 * "What is near this?" across frames (Prompt 07). The rule that makes the answer trustworthy:
 *
 *   Positions are only compared after being expressed in ONE frame, with FrameTree.convert, in float64.
 *   Never subtract a vector that lives in one frame from a vector that lives in another.
 *
 * Every searchable collection is a DOMAIN that declares the frame its positions are in and the length of its unit:
 *  - heliocentricDomain  stars, nebulae, clusters, galaxies: KD-tree over parsecs in the Sun-centred, ICRS-aligned
 *                        'stellar-neighbourhood' frame (units: parsecs, METRES_PER_PARSEC)
 *  - solarDomain         the Solar System bodies in the 'solar-system' frame (metres), positions supplied by a callback at the sim time
 * findNearby converts the origin into EACH domain's frame, queries in that domain's own unit, and returns distances in metres.
 *
 * Precision: an origin 10 Mpc away is ~3e23 m from the Sun, where one float64 step is ~6e7 m (0.4 AU). Distances to neighbours a parsec away
 * are therefore good to ~2e-9 relative, which is far below any catalogue uncertainty; this is stated, not hidden.
 */
import { METRES_PER_PARSEC } from '../core/units';
import { formatDistance } from '../core/spatial/scale';
import { cross, dot, normalise, type Vec3 } from '../core/spatial/vec3';
import type { FrameId, FrameTree, SpatialPosition } from '../core/spatial/frames';
import type { KdTree, SpatialFilter } from './spatialIndex';
import { DATASET_IDS, OBJECT_CATEGORIES, type RecordStore } from './recordStore';
import type { DatasetId, ObjectCategory, UniversalId } from './types';

/** The Sun-centred ICRS-aligned frame of src/data/catalogue/frames.ts. Duplicated here as a string to keep this module free of data imports. */
export const STELLAR_NEIGHBOURHOOD_FRAME = 'stellar-neighbourhood';
export const SOLAR_SYSTEM_FRAME = 'solar-system';

export interface SolarBodyPosition {
  readonly id: UniversalId;
  readonly category: ObjectCategory;
  readonly dataset: DatasetId;
  /** Metres in the domain's frame (the 'solar-system' frame: Sun-centred, ICRS axes) at the current simulation time. */
  readonly offsetMetres: Vec3;
}

export type NearbyDomain = HeliocentricDomain | SolarDomain;

export interface HeliocentricDomain {
  readonly kind: 'kd-tree';
  readonly id: string;
  readonly frame: FrameId;
  /** Length of one coordinate unit in the tree, in metres (parsec). Explicit so a unit mix-up cannot go unnoticed. */
  readonly metresPerUnit: number;
  readonly store: RecordStore;
  readonly tree: KdTree;
}

export interface SolarDomain {
  readonly kind: 'callback';
  readonly id: string;
  readonly frame: FrameId;
  readonly bodies: () => readonly SolarBodyPosition[];
}

export function heliocentricDomain(store: RecordStore, tree: KdTree, opts: { id?: string; frame?: FrameId } = {}): HeliocentricDomain {
  return { kind: 'kd-tree', id: opts.id ?? 'heliocentric', frame: opts.frame ?? STELLAR_NEIGHBOURHOOD_FRAME, metresPerUnit: METRES_PER_PARSEC, store, tree };
}
export function solarDomain(bodies: () => readonly SolarBodyPosition[], opts: { id?: string; frame?: FrameId } = {}): SolarDomain {
  return { kind: 'callback', id: opts.id ?? 'solar-system', frame: opts.frame ?? SOLAR_SYSTEM_FRAME, bodies };
}

export interface NearbyQuery {
  readonly origin: SpatialPosition;
  readonly frames: FrameTree;
  readonly domains: readonly NearbyDomain[];
  /** Maximum distance, metres. */
  readonly radiusMetres?: number;
  /** Number of nearest neighbours. At least one of radiusMetres and k is required; with both, the k nearest within the radius. */
  readonly k?: number;
  readonly categories?: readonly ObjectCategory[];
  readonly datasets?: readonly DatasetId[];
  /** The object the origin belongs to (never returned as its own neighbour). */
  readonly originId?: UniversalId;
}

export interface NearbyNeighbour {
  readonly id: UniversalId;
  readonly category: ObjectCategory;
  readonly dataset: DatasetId;
  readonly distanceMetres: number;
  /** formatDistance(distanceMetres), e.g. "4.24 ly" / "1.30 pc". */
  readonly distanceText: string;
  readonly domain: string;
}

export interface NearbyResult {
  readonly neighbours: readonly NearbyNeighbour[];
  /** The origin expressed in each domain's frame (metres), for display and tests. */
  readonly originInDomain: Readonly<Record<string, Vec3>>;
}

function masks(q: { categories?: readonly ObjectCategory[]; datasets?: readonly DatasetId[] }): { categories: Uint8Array | null; datasets: Uint8Array | null } {
  let categories: Uint8Array | null = null, datasets: Uint8Array | null = null;
  if (q.categories && q.categories.length > 0) { categories = new Uint8Array(OBJECT_CATEGORIES.length); for (const c of q.categories) { const i = OBJECT_CATEGORIES.indexOf(c); if (i >= 0) categories[i] = 1; } }
  if (q.datasets && q.datasets.length > 0) { datasets = new Uint8Array(DATASET_IDS.length); for (const d of q.datasets) { const i = DATASET_IDS.indexOf(d); if (i >= 0) datasets[i] = 1; } }
  return { categories, datasets };
}

export function findNearby(q: NearbyQuery): NearbyResult {
  const hasR = q.radiusMetres !== undefined, hasK = q.k !== undefined;
  if (!hasR && !hasK) throw new Error('findNearby needs radiusMetres and/or k');
  if (hasR && !(q.radiusMetres! >= 0)) throw new RangeError('radiusMetres must be >= 0');
  if (hasK && !(q.k! >= 1)) throw new RangeError('k must be >= 1');
  const m = masks(q);
  const all: NearbyNeighbour[] = [];
  const originInDomain: Record<string, Vec3> = {};

  for (const d of q.domains) {
    const o = q.frames.convert(q.origin, d.frame);               // float64, summed only up to the lowest common ancestor
    originInDomain[d.id] = o;
    if (d.kind === 'kd-tree') {
      const u = d.metresPerUnit;
      const filter: SpatialFilter = { categories: m.categories, datasets: m.datasets, exclude: q.originId !== undefined ? d.store.indexOfId(q.originId) : -1 };
      const hits = hasK
        ? d.tree.nearest(o[0] / u, o[1] / u, o[2] / u, q.k!, filter, hasR ? q.radiusMetres! / u : Infinity)
        : d.tree.radius(o[0] / u, o[1] / u, o[2] / u, q.radiusMetres! / u, filter);
      for (const h of hits) {
        const metres = h.distance * u;
        all.push({ id: d.store.idAt(h.index), category: d.store.categoryAt(h.index), dataset: d.store.datasetAt(h.index), distanceMetres: metres, distanceText: formatDistance(metres), domain: d.id });
      }
    } else {
      for (const b of d.bodies()) {
        if (q.originId !== undefined && b.id === q.originId) continue;
        if (m.categories && !m.categories[OBJECT_CATEGORIES.indexOf(b.category)]) continue;
        if (m.datasets && !m.datasets[DATASET_IDS.indexOf(b.dataset)]) continue;
        const metres = Math.hypot(b.offsetMetres[0] - o[0], b.offsetMetres[1] - o[1], b.offsetMetres[2] - o[2]);
        if (hasR && metres > q.radiusMetres!) continue;
        all.push({ id: b.id, category: b.category, dataset: b.dataset, distanceMetres: metres, distanceText: formatDistance(metres), domain: d.id });
      }
    }
  }
  all.sort((a, b) => a.distanceMetres - b.distanceMetres || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { neighbours: hasK ? all.slice(0, Math.floor(q.k!)) : all, originInDomain };
}

// ---- view frustum -------------------------------------------------------------------------------------------------------------------

export interface ViewQuery {
  /** Camera position in any frame; it is converted into each domain's frame. */
  readonly camera: SpatialPosition;
  readonly frames: FrameTree;
  readonly domains: readonly NearbyDomain[];
  /** Direction the camera looks along, in ICRS-aligned axes (all frames share them). Need not be normalised. */
  readonly forward: Vec3;
  /** Any vector not parallel to `forward`; the camera's up. */
  readonly up: Vec3;
  /** Full vertical field of view, degrees (0 < fov < 180). */
  readonly fovYDeg: number;
  /** width / height */
  readonly aspect: number;
  readonly nearMetres?: number;
  readonly maxDistanceMetres: number;
  readonly categories?: readonly ObjectCategory[];
  readonly datasets?: readonly DatasetId[];
  /** Return at most this many, nearest to the camera first. Default 500. */
  readonly limit?: number;
  /** Cap on candidates examined in the tree (default 100000); `truncated` says if it was reached. */
  readonly maxCandidates?: number;
}

export interface VisibleObject { readonly id: UniversalId; readonly category: ObjectCategory; readonly dataset: DatasetId; readonly distanceMetres: number; readonly domain: string }
export interface VisibleResult { readonly objects: readonly VisibleObject[]; readonly total: number; readonly truncated: boolean }

/** Inward-facing frustum planes (nx, ny, nz, d per plane: inside iff n.p + d >= 0) for a camera at `c` (any unit), in the same unit as `c`. */
export function frustumPlanes(c: Vec3, forward: Vec3, up: Vec3, fovYDeg: number, aspect: number, near: number, far: number): Float64Array {
  if (!(fovYDeg > 0 && fovYDeg < 180) || !(aspect > 0) || !(far > near) || !(near >= 0)) throw new RangeError('invalid frustum parameters');
  const f = normalise(forward);
  const right = normalise(cross(f, up));
  const u = cross(right, f);
  const tanY = Math.tan((fovYDeg * Math.PI) / 360);
  const tanX = tanY * aspect;
  const mk = (n: Vec3, d: number): number[] => { const l = Math.hypot(n[0], n[1], n[2]); return [n[0] / l, n[1] / l, n[2] / l, d / l]; };
  const side = (n: Vec3): number[] => mk(n, -dot(n, c));
  const comb = (a: Vec3, b: Vec3, s: number): Vec3 => [a[0] + s * b[0], a[1] + s * b[1], a[2] + s * b[2]];
  const planes = [
    side(comb(right, f, tanX)),                                   // left
    side(comb([-right[0], -right[1], -right[2]], f, tanX)),       // right
    side(comb([-u[0], -u[1], -u[2]], f, tanY)),                   // top
    side(comb(u, f, tanY)),                                       // bottom
    [f[0], f[1], f[2], -dot(f, c) - near],                        // near
    [-f[0], -f[1], -f[2], dot(f, c) + far],                       // far
  ];
  return Float64Array.from(planes.flat());
}

/** Objects inside the camera's view frustum, nearest first. Cheap box pre-filter in the KD-tree, then exact plane tests. */
export function visibleRegion(q: ViewQuery): VisibleResult {
  const limit = Math.max(1, Math.floor(q.limit ?? 500));
  const cap = Math.max(limit, Math.floor(q.maxCandidates ?? 100_000));
  const m = masks(q);
  const out: VisibleObject[] = [];
  let truncated = false;
  for (const d of q.domains) {
    const c = q.frames.convert(q.camera, d.frame);
    if (d.kind === 'kd-tree') {
      const u = d.metresPerUnit;
      const cu: Vec3 = [c[0] / u, c[1] / u, c[2] / u];
      const planes = frustumPlanes(cu, q.forward, q.up, q.fovYDeg, q.aspect, (q.nearMetres ?? 0) / u, q.maxDistanceMetres / u);
      const ids = d.tree.inPlanes(planes, { categories: m.categories, datasets: m.datasets }, cap);
      if (ids.length >= cap) truncated = true;
      for (const index of ids) {
        const o = 3 * index;
        const metres = Math.hypot(d.store.xyz[o]! - cu[0], d.store.xyz[o + 1]! - cu[1], d.store.xyz[o + 2]! - cu[2]) * u;
        out.push({ id: d.store.idAt(index), category: d.store.categoryAt(index), dataset: d.store.datasetAt(index), distanceMetres: metres, domain: d.id });
      }
    } else {
      const planes = frustumPlanes(c, q.forward, q.up, q.fovYDeg, q.aspect, q.nearMetres ?? 0, q.maxDistanceMetres);
      for (const b of d.bodies()) {
        if (m.categories && !m.categories[OBJECT_CATEGORIES.indexOf(b.category)]) continue;
        if (m.datasets && !m.datasets[DATASET_IDS.indexOf(b.dataset)]) continue;
        let inside = true;
        for (let p = 0; p < 6 && inside; p++) inside = planes[4 * p]! * b.offsetMetres[0] + planes[4 * p + 1]! * b.offsetMetres[1] + planes[4 * p + 2]! * b.offsetMetres[2] + planes[4 * p + 3]! >= 0;
        if (inside) out.push({ id: b.id, category: b.category, dataset: b.dataset, distanceMetres: Math.hypot(b.offsetMetres[0] - c[0], b.offsetMetres[1] - c[1], b.offsetMetres[2] - c[2]), domain: d.id });
      }
    }
  }
  out.sort((a, b) => a.distanceMetres - b.distanceMetres || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { objects: out.slice(0, limit), total: out.length, truncated };
}

/** The stellar-neighbourhood origin of a record that has a 3D position (metres), or undefined. */
export function originOf(store: RecordStore, index: number, frame: FrameId = STELLAR_NEIGHBOURHOOD_FRAME): SpatialPosition | undefined {
  if (!store.hasPosition(index)) return undefined;
  const o = 3 * index;
  return { frame, offset: [store.xyz[o]! * METRES_PER_PARSEC, store.xyz[o + 1]! * METRES_PER_PARSEC, store.xyz[o + 2]! * METRES_PER_PARSEC] };
}
