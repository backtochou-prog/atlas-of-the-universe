/**
 * Column-oriented store of DiscoveryRecords for filtering, ranking and spatial queries (Prompt 07).
 *
 *  - one typed column per MeasurementKey that has data for at least one record (keys with NO data get no column and are never offered),
 *    each with a presence bitmap: "absent" is a bit, never a 0 and never NaN in the value column;
 *  - category / dataset / distance-band ids and a spectral-class bit mask as small typed arrays;
 *  - heliocentric ICRS positions (parsecs, float64) for records with a 3D position.
 *
 * The store is immutable after construction (build a new one to add data); records stay the source of truth.
 */
import type { DatasetId, DiscoveryRecord, MeasurementKey, ObjectCategory, UniversalId, ValueKind } from './types';
import { UNKNOWN_SPECTRAL_BIT, parseSpectralType, spectralMask } from './spectral';

export const MEASUREMENT_KEYS: readonly MeasurementKey[] = [
  'distancePc', 'apparentMag', 'absoluteMag', 'teffK', 'luminositySun', 'radiusKm', 'radiusSun', 'massKg', 'angularSizeArcmin', 'physicalSizePc',
  'redshift', 'czKms', 'orbitalPeriodDays', 'bpRp', 'pmTotalMasYr',
];

export const MEASUREMENT_META: Readonly<Record<MeasurementKey, { readonly label: string; readonly unit: string }>> = {
  distancePc: { label: 'Distance from the Sun', unit: 'pc' },
  apparentMag: { label: 'Apparent magnitude', unit: 'mag' },
  absoluteMag: { label: 'Absolute magnitude', unit: 'mag' },
  teffK: { label: 'Temperature (stellar effective, or planet equilibrium)', unit: 'K' },
  luminositySun: { label: 'Luminosity', unit: 'L☉' },
  radiusKm: { label: 'Radius', unit: 'km' },
  radiusSun: { label: 'Radius', unit: 'R☉' },
  massKg: { label: 'Mass', unit: 'kg' },
  angularSizeArcmin: { label: 'Angular size', unit: 'arcmin' },
  physicalSizePc: { label: 'Physical size', unit: 'pc' },
  redshift: { label: 'Redshift', unit: '' },
  czKms: { label: 'Recession velocity cz', unit: 'km/s' },
  orbitalPeriodDays: { label: 'Orbital period', unit: 'd' },
  bpRp: { label: 'Colour BP−RP', unit: 'mag' },
  pmTotalMasYr: { label: 'Total proper motion', unit: 'mas/yr' },
};

export const OBJECT_CATEGORIES: readonly ObjectCategory[] = [
  'star', 'planet', 'moon', 'exoplanet', 'exoplanet-host', 'galaxy', 'nebula', 'star-cluster', 'galaxy-group', 'galaxy-cluster', 'supernova-remnant', 'other',
];
export const DATASET_IDS: readonly DatasetId[] = [
  'gaia-dr3', 'hipparcos', 'solar-system', 'deep-space', 'nasa-exoplanet-archive', 'ungc', 'local-group-mcconnachie', 'twomrs', 'curated-other',
];

// ---- distance bands --------------------------------------------------------------------------------------------------------

export type DistanceBandId = 'solar-system' | 'nearby-stars' | 'stellar-neighbourhood' | 'galactic-region' | 'nearby-galaxies' | 'larger-structures';

export interface DistanceBand {
  readonly id: DistanceBandId;
  readonly label: string;
  /** Lower bound in parsecs, exclusive (the previous band's maxPc). */
  readonly minPc: number;
  /** Upper bound in parsecs, inclusive. */
  readonly maxPc: number;
  readonly definition: string;
}

/**
 * Bands on HELIOCENTRIC distance (pc). The bounds are choices of this application, stated here and shown to the user; they are
 * not astronomical boundaries. Solar System bodies form their own band regardless of any distance (their position is an ephemeris).
 * A record without a distance (sky-only) belongs to no band; a band filter excludes it and counts it as "missing".
 */
export const DISTANCE_BANDS: readonly DistanceBand[] = [
  { id: 'solar-system', label: 'Solar System', minPc: -Infinity, maxPc: -Infinity, definition: 'Bodies of the Solar System dataset (position from the ephemeris, not from a catalogue distance).' },
  { id: 'nearby-stars', label: 'Nearby stars', minPc: 0, maxPc: 25, definition: 'Up to 25 pc (about 82 light years), the limit used by the Catalogue of Nearby Stars (Gliese & Jahreiss).' },
  { id: 'stellar-neighbourhood', label: 'Stellar neighbourhood', minPc: 25, maxPc: 1_000, definition: 'Beyond 25 pc and up to 1 kpc, the region where inverse-parallax distances from Gaia are usually reliable.' },
  { id: 'galactic-region', label: 'Galactic region', minPc: 1_000, maxPc: 50_000, definition: 'Beyond 1 kpc and up to 50 kpc, the extent of the Milky Way frame in this atlas (a visualisation extent). Includes the Galactic centre and the Magellanic Clouds side.' },
  { id: 'nearby-galaxies', label: 'Nearby galaxies', minPc: 50_000, maxPc: 11_000_000, definition: 'Beyond 50 kpc and up to 11 Mpc, the Local Volume that the Updated Nearby Galaxy Catalog covers.' },
  { id: 'larger-structures', label: 'Larger structures', minPc: 11_000_000, maxPc: Infinity, definition: 'Beyond 11 Mpc: clusters such as Virgo and the redshift-survey galaxies.' },
];
const BAND_INDEX = new Map(DISTANCE_BANDS.map((b, i) => [b.id, i] as const));
export const bandIndexOf = (id: DistanceBandId): number => BAND_INDEX.get(id)!;
export const NO_BAND = 255;

/** Band of a heliocentric distance in parsecs (never 'solar-system'), or undefined for a non-positive / non-finite distance. */
export function bandOfDistance(pc: number): DistanceBandId | undefined {
  if (!(pc > 0) || !Number.isFinite(pc)) return undefined;
  for (let i = 1; i < DISTANCE_BANDS.length; i++) if (pc <= DISTANCE_BANDS[i]!.maxPc) return DISTANCE_BANDS[i]!.id;
  return 'larger-structures';
}

// ---- store --------------------------------------------------------------------------------------------------------------------

const KIND_CODE: Readonly<Record<ValueKind, number>> = { observed: 1, derived: 2, modelled: 3 };
const KIND_NAME: readonly (ValueKind | undefined)[] = [undefined, 'observed', 'derived', 'modelled'];

export interface MeasurementColumn {
  readonly key: MeasurementKey;
  /** Value where present; the entry is meaningless (0) where the presence bit is 0. */
  readonly values: Float64Array;
  /** Presence bitmap: bit (i & 31) of word (i >> 5). */
  readonly present: Uint32Array;
  /** 1-sigma where published; NaN = not published (the value may still be present). */
  readonly uncertainty: Float64Array;
  readonly kind: Uint8Array;
  readonly count: number;
  readonly min: number;
  readonly max: number;
}

export class RecordStore {
  readonly count: number;
  readonly categoryIdx: Uint8Array;
  readonly datasetIdx: Uint8Array;
  readonly bandIdx: Uint8Array;
  readonly spectral: Uint16Array;
  /** Heliocentric ICRS parsecs, 3 per record; NaN where the record has no 3D position. */
  readonly xyz: Float64Array;
  private readonly columns = new Map<MeasurementKey, MeasurementColumn>();
  private readonly idIndex = new Map<UniversalId, number>();

  private constructor(readonly records: readonly DiscoveryRecord[]) {
    const n = records.length;
    this.count = n;
    this.categoryIdx = new Uint8Array(n);
    this.datasetIdx = new Uint8Array(n);
    this.bandIdx = new Uint8Array(n).fill(NO_BAND);
    this.spectral = new Uint16Array(n);
    this.xyz = new Float64Array(3 * n).fill(NaN);

    const raw = new Map<MeasurementKey, { values: Float64Array; present: Uint32Array; unc: Float64Array; kind: Uint8Array; count: number }>();
    const col = (k: MeasurementKey) => {
      let c = raw.get(k);
      if (!c) { c = { values: new Float64Array(n), present: new Uint32Array((n + 31) >>> 5), unc: new Float64Array(n).fill(NaN), kind: new Uint8Array(n), count: 0 }; raw.set(k, c); }
      return c;
    };
    const solarBand = bandIndexOf('solar-system');
    for (let i = 0; i < n; i++) {
      const r = records[i]!;
      if (!this.idIndex.has(r.id)) this.idIndex.set(r.id, i);
      this.categoryIdx[i] = Math.max(0, OBJECT_CATEGORIES.indexOf(r.category));
      this.datasetIdx[i] = Math.max(0, DATASET_IDS.indexOf(r.dataset));
      this.spectral[i] = r.spectralType !== undefined ? spectralMask(parseSpectralType(r.spectralType).classes) : UNKNOWN_SPECTRAL_BIT;
      for (const key of MEASUREMENT_KEYS) {
        const m = r.measurements[key];
        if (m === undefined || !Number.isFinite(m.value)) continue;     // absent or NaN/Infinity: treated as not available
        const c = col(key);
        c.values[i] = m.value;
        c.present[i >>> 5]! |= 1 << (i & 31);
        if (m.uncertainty !== undefined && Number.isFinite(m.uncertainty)) c.unc[i] = m.uncertainty;
        c.kind[i] = KIND_CODE[m.kind] ?? 0;
        c.count++;
      }
      const p = r.position;
      let dPc: number | undefined = r.measurements.distancePc?.value;
      if (p.kind === 'icrs' && p.xyzPc.every(Number.isFinite)) {
        this.xyz[3 * i] = p.xyzPc[0]; this.xyz[3 * i + 1] = p.xyzPc[1]; this.xyz[3 * i + 2] = p.xyzPc[2];
        if (dPc === undefined || !Number.isFinite(dPc)) dPc = Math.hypot(p.xyzPc[0], p.xyzPc[1], p.xyzPc[2]);
      }
      if (p.kind === 'solar') this.bandIdx[i] = solarBand;
      else if (dPc !== undefined) { const b = bandOfDistance(dPc); if (b !== undefined) this.bandIdx[i] = bandIndexOf(b); }
    }
    for (const [key, c] of raw) {
      if (c.count === 0) continue;
      let min = Infinity, max = -Infinity;
      for (let i = 0; i < n; i++) if ((c.present[i >>> 5]! >>> (i & 31)) & 1) { const v = c.values[i]!; if (v < min) min = v; if (v > max) max = v; }
      this.columns.set(key, { key, values: c.values, present: c.present, uncertainty: c.unc, kind: c.kind, count: c.count, min, max });
    }
  }

  static from(records: readonly DiscoveryRecord[]): RecordStore { return new RecordStore(records); }

  /** Column for a key, or undefined if NO record has a value for it (then the key must not be offered). */
  column(key: MeasurementKey): MeasurementColumn | undefined { return this.columns.get(key); }
  keysWithData(): MeasurementKey[] { return MEASUREMENT_KEYS.filter((k) => this.columns.has(k)); }

  has(key: MeasurementKey, i: number): boolean {
    const c = this.columns.get(key);
    return c !== undefined && ((c.present[i >>> 5]! >>> (i & 31)) & 1) === 1;
  }
  /** The value, or undefined when the record has none (never 0 as a stand-in). */
  value(key: MeasurementKey, i: number): number | undefined {
    const c = this.columns.get(key);
    return c !== undefined && ((c.present[i >>> 5]! >>> (i & 31)) & 1) === 1 ? c.values[i] : undefined;
  }
  uncertainty(key: MeasurementKey, i: number): number | undefined {
    const c = this.columns.get(key);
    if (c === undefined || ((c.present[i >>> 5]! >>> (i & 31)) & 1) === 0) return undefined;
    const u = c.uncertainty[i]!;
    return Number.isNaN(u) ? undefined : u;
  }
  kind(key: MeasurementKey, i: number): ValueKind | undefined {
    const c = this.columns.get(key);
    return c !== undefined && ((c.present[i >>> 5]! >>> (i & 31)) & 1) === 1 ? KIND_NAME[c.kind[i]!] : undefined;
  }

  idAt(i: number): UniversalId { return this.records[i]!.id; }
  recordAt(i: number): DiscoveryRecord { return this.records[i]!; }
  indexOfId(id: UniversalId): number { return this.idIndex.get(id) ?? -1; }
  categoryAt(i: number): ObjectCategory { return OBJECT_CATEGORIES[this.categoryIdx[i]!]!; }
  datasetAt(i: number): DatasetId { return DATASET_IDS[this.datasetIdx[i]!]!; }
  bandAt(i: number): DistanceBandId | undefined { const b = this.bandIdx[i]!; return b === NO_BAND ? undefined : DISTANCE_BANDS[b]!.id; }
  hasPosition(i: number): boolean { return !Number.isNaN(this.xyz[3 * i]!); }
}

/** A store plus an optional subset of its record indices (the result of a filter). */
export interface StoreView {
  readonly store: RecordStore;
  /** Ascending record indices; null = the whole store. */
  readonly indices: Int32Array | null;
}
export const wholeStore = (store: RecordStore): StoreView => ({ store, indices: null });
export const viewSize = (v: StoreView): number => (v.indices === null ? v.store.count : v.indices.length);
