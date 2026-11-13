/**
 * Filtering over a RecordStore (Prompt 07). Filters combine with AND. "Missing is not zero": a record without a value for a filtered key
 * is excluded and COUNTED, never compared as 0 or NaN.
 *
 * Definitions (all documented in docs/DISCOVERY_ENGINE.md):
 *  - scope            records that pass the categorical filters (categories, datasets).
 *  - excludedForMissing[key]   among the scope, how many have NO value for `key` (numeric range keys), no distance band ('distanceBand'),
 *                     or no usable spectral type ('spectralClass'). A record missing several keys is counted under each; excludedAny counts it once.
 *  - spectral filter  a record matches if ANY class named by its published type is selected (see spectral.ts); selecting 'unknown'
 *                     also matches records without a usable spectral type. Without 'unknown' selected those records are excluded and counted.
 */
import type { DatasetId, MeasurementKey, ObjectCategory } from './types';
import {
  DATASET_IDS, DISTANCE_BANDS, MEASUREMENT_KEYS, NO_BAND, OBJECT_CATEGORIES, bandIndexOf, type DistanceBandId, type MeasurementColumn, type RecordStore,
} from './recordStore';
import { SPECTRAL_CLASSES, UNKNOWN_SPECTRAL_BIT, spectralMask, type SpectralClass } from './spectral';

export interface RangeFilter { readonly min?: number; readonly max?: number }

export interface FilterSpec {
  readonly categories?: readonly ObjectCategory[];
  readonly datasets?: readonly DatasetId[];
  readonly distanceBands?: readonly DistanceBandId[];
  /** Inclusive numeric ranges on any MeasurementKey. */
  readonly ranges?: Readonly<Partial<Record<MeasurementKey, RangeFilter>>>;
  readonly spectralClasses?: readonly SpectralClass[];
}

export type FilterKey = MeasurementKey | 'distanceBand' | 'spectralClass';

export interface FilterResult {
  /** Ascending indices of matching records. */
  readonly indices: Int32Array;
  readonly count: number;
  /** Records passing the categorical filters. */
  readonly scope: number;
  readonly excludedForMissing: Readonly<Partial<Record<FilterKey, number>>>;
  /** Scope records excluded because at least one filtered value is missing. */
  readonly excludedAny: number;
}

interface ActiveRange { readonly key: MeasurementKey; readonly col: MeasurementColumn | undefined; readonly min: number; readonly max: number }

function mask(values: readonly number[], size: number): Uint8Array | null {
  const a = new Uint8Array(size);
  for (const v of values) if (v >= 0) a[v] = 1;
  return a;
}

export function evaluateFilter(store: RecordStore, spec: FilterSpec = {}): FilterResult {
  const n = store.count;
  const catAllowed = spec.categories && spec.categories.length > 0 ? mask(spec.categories.map((c) => OBJECT_CATEGORIES.indexOf(c)), OBJECT_CATEGORIES.length) : null;
  const dsAllowed = spec.datasets && spec.datasets.length > 0 ? mask(spec.datasets.map((d) => DATASET_IDS.indexOf(d)), DATASET_IDS.length) : null;
  const bandAllowed = spec.distanceBands && spec.distanceBands.length > 0 ? mask(spec.distanceBands.map((b) => bandIndexOf(b)), DISTANCE_BANDS.length) : null;
  const specMask = spec.spectralClasses && spec.spectralClasses.length > 0 ? spectralMask(spec.spectralClasses) : 0;

  const active: ActiveRange[] = [];
  for (const key of MEASUREMENT_KEYS) {
    const r = spec.ranges?.[key];
    if (r === undefined || (r.min === undefined && r.max === undefined)) continue;
    if ((r.min !== undefined && Number.isNaN(r.min)) || (r.max !== undefined && Number.isNaN(r.max))) throw new RangeError(`Filter range for ${key} has a NaN bound`);
    active.push({ key, col: store.column(key), min: r.min ?? -Infinity, max: r.max ?? Infinity });
  }
  const nActive = active.length;
  const missing = new Float64Array(nActive);
  let missingBand = 0, missingSpectral = 0, excludedAny = 0, scope = 0, count = 0;

  // One fused pass over typed arrays, no per-record allocation. The first three range filters are unrolled into locals; any further ones
  // run as extra tight passes over a per-record state byte (bits: 1 in scope, 2 failed a condition, 4 lacks a filtered value).
  const cat = store.categoryIdx, ds = store.datasetIdx, band = store.bandIdx, spectral = store.spectral;
  const fused = Math.min(nActive, 3);
  const slot = (k: number) => {
    const a = k < fused ? active[k]! : undefined;
    return { vals: a?.col?.values ?? null, pres: a?.col?.present ?? null, min: a?.min ?? -Infinity, max: a?.max ?? Infinity, on: a !== undefined };
  };
  const s0 = slot(0), s1 = slot(1), s2 = slot(2);
  const v0 = s0.vals, p0 = s0.pres, v1 = s1.vals, p1 = s1.pres, v2 = s2.vals, p2 = s2.pres;
  let m0 = 0, m1 = 0, m2 = 0;
  const extra = nActive > fused;
  const st = extra ? new Uint8Array(n) : null;
  const out = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (catAllowed !== null && catAllowed[cat[i]!] === 0) continue;
    if (dsAllowed !== null && dsAllowed[ds[i]!] === 0) continue;
    scope++;
    let flags = 0;
    if (s0.on) {
      if (p0 === null || ((p0[i >>> 5]! >>> (i & 31)) & 1) === 0) { m0++; flags |= 6; }
      else { const v = v0![i]!; if (v < s0.min || v > s0.max) flags |= 2; }
      if (s1.on) {
        if (p1 === null || ((p1[i >>> 5]! >>> (i & 31)) & 1) === 0) { m1++; flags |= 6; }
        else { const v = v1![i]!; if (v < s1.min || v > s1.max) flags |= 2; }
        if (s2.on) {
          if (p2 === null || ((p2[i >>> 5]! >>> (i & 31)) & 1) === 0) { m2++; flags |= 6; }
          else { const v = v2![i]!; if (v < s2.min || v > s2.max) flags |= 2; }
        }
      }
    }
    if (bandAllowed !== null) {
      const b = band[i]!;
      if (b === NO_BAND) { missingBand++; flags |= 6; } else if (bandAllowed[b] === 0) flags |= 2;
    }
    if (specMask !== 0) {
      const m = spectral[i]!;
      if (m === UNKNOWN_SPECTRAL_BIT) {
        if ((specMask & UNKNOWN_SPECTRAL_BIT) === 0) { missingSpectral++; flags |= 6; }
      } else if ((m & specMask) === 0) flags |= 2;
    }
    if (st !== null) { st[i] = 1 | flags; continue; }
    if (flags & 4) excludedAny++;
    if ((flags & 2) === 0) out[count++] = i;
  }
  missing[0] = m0; if (nActive > 1) missing[1] = m1; if (nActive > 2) missing[2] = m2;
  if (st !== null) {
    for (let f = fused; f < nActive; f++) {
      const col = active[f]!.col;
      const min = active[f]!.min, max = active[f]!.max;
      if (!col) {                                    // no record has this key at all
        for (let i = 0; i < n; i++) if (st[i]! & 1) st[i] = st[i]! | 6;
        missing[f] = scope;
        continue;
      }
      const vals = col.values, pres = col.present;
      let miss = 0;
      for (let i = 0; i < n; i++) {
        const s = st[i]!;
        if (s === 0) continue;
        if (((pres[i >>> 5]! >>> (i & 31)) & 1) === 0) { miss++; st[i] = s | 6; continue; }
        const v = vals[i]!;
        if (v < min || v > max) st[i] = s | 2;
      }
      missing[f] = miss;
    }
    for (let i = 0; i < n; i++) {
      const s = st[i]!;
      if (s === 0) continue;
      if (s & 4) excludedAny++;
      if ((s & 2) === 0) out[count++] = i;
    }
  }
  const excludedForMissing: Partial<Record<FilterKey, number>> = {};
  for (let f = 0; f < nActive; f++) excludedForMissing[active[f]!.key] = missing[f]!;
  if (bandAllowed !== null) excludedForMissing.distanceBand = missingBand;
  if (specMask !== 0) excludedForMissing.spectralClass = missingSpectral;
  return { indices: out.slice(0, count), count, scope, excludedForMissing, excludedAny };
}

// ---- facets ---------------------------------------------------------------------------------------------------------------------

export interface MeasurementFacet {
  readonly key: MeasurementKey;
  /** Records that HAVE a value. */
  readonly count: number;
  readonly min: number;
  readonly max: number;
  readonly byKind: Readonly<{ observed: number; derived: number; modelled: number }>;
}

export interface Facets {
  readonly total: number;
  /** Only keys with at least one value: the filter UI offers exactly these. */
  readonly measurements: readonly MeasurementFacet[];
  /** Keys with no value anywhere: must NOT be offered. */
  readonly unavailableKeys: readonly MeasurementKey[];
  readonly categories: readonly { readonly id: ObjectCategory; readonly count: number }[];
  readonly datasets: readonly { readonly id: DatasetId; readonly count: number }[];
  readonly distanceBands: readonly { readonly id: DistanceBandId; readonly count: number }[];
  readonly withoutDistanceBand: number;
  readonly spectralClasses: readonly { readonly id: SpectralClass; readonly count: number }[];
}

export function availableFacets(store: RecordStore): Facets {
  const measurements: MeasurementFacet[] = [];
  const unavailable: MeasurementKey[] = [];
  for (const key of MEASUREMENT_KEYS) {
    const c = store.column(key);
    if (!c) { unavailable.push(key); continue; }
    const byKind = { observed: 0, derived: 0, modelled: 0 };
    for (let i = 0; i < store.count; i++) {
      if (((c.present[i >>> 5]! >>> (i & 31)) & 1) === 0) continue;
      const k = c.kind[i]!;
      if (k === 1) byKind.observed++; else if (k === 2) byKind.derived++; else if (k === 3) byKind.modelled++;
    }
    measurements.push({ key, count: c.count, min: c.min, max: c.max, byKind });
  }
  const cat = new Array<number>(OBJECT_CATEGORIES.length).fill(0);
  const ds = new Array<number>(DATASET_IDS.length).fill(0);
  const bands = new Array<number>(DISTANCE_BANDS.length).fill(0);
  const spec = new Array<number>(SPECTRAL_CLASSES.length).fill(0);
  let noBand = 0;
  for (let i = 0; i < store.count; i++) {
    cat[store.categoryIdx[i]!]!++;
    ds[store.datasetIdx[i]!]!++;
    const b = store.bandIdx[i]!;
    if (b === NO_BAND) noBand++; else bands[b]!++;
    const m = store.spectral[i]!;
    for (let c = 0; c < SPECTRAL_CLASSES.length; c++) if ((m >> c) & 1) spec[c]!++;
  }
  return {
    total: store.count,
    measurements,
    unavailableKeys: unavailable,
    categories: OBJECT_CATEGORIES.map((id, i) => ({ id, count: cat[i]! })).filter((x) => x.count > 0),
    datasets: DATASET_IDS.map((id, i) => ({ id, count: ds[i]! })).filter((x) => x.count > 0),
    distanceBands: DISTANCE_BANDS.map((b, i) => ({ id: b.id, count: bands[i]! })).filter((x) => x.count > 0),
    withoutDistanceBand: noBand,
    spectralClasses: SPECTRAL_CLASSES.map((id, i) => ({ id, count: spec[i]! })).filter((x) => x.count > 0),
  };
}
