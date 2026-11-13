/**
 * Filter tab view model (pure): the filter state, its URL-hash form, what the facets allow us to offer, and the plain sentences about excluded records.
 *
 * "Missing is not zero": a numeric range is offered only for a measurement the facets say has data; the text says how many records have it and, after a filter
 * runs, how many records without the value are not included.
 */
import { DISTANCE_BANDS, MEASUREMENT_KEYS, MEASUREMENT_META, OBJECT_CATEGORIES, DATASET_IDS, type DistanceBandId } from '../../discovery/recordStore';
import { SPECTRAL_CLASSES, type SpectralClass } from '../../discovery/spectral';
import type { Facets, FilterKey, FilterSpec } from '../../discovery/filters';
import type { FilterOutcome } from '../../discovery/engineApi';
import { DATASET_LABELS } from '../../discovery/discover';
import type { DatasetId, MeasurementKey, ObjectCategory } from '../../discovery/types';
import { CATEGORY_LABEL, nf } from './labels';

export interface RangeState { min?: number; max?: number }
export interface FilterState {
  readonly categories: readonly ObjectCategory[];
  readonly datasets: readonly DatasetId[];
  readonly bands: readonly DistanceBandId[];
  readonly spectral: readonly SpectralClass[];
  readonly ranges: Readonly<Partial<Record<MeasurementKey, RangeState>>>;
}
export const EMPTY_FILTER: FilterState = { categories: [], datasets: [], bands: [], spectral: [], ranges: {} };

export function isEmptyFilter(s: FilterState): boolean {
  return s.categories.length === 0 && s.datasets.length === 0 && s.bands.length === 0 && s.spectral.length === 0 && Object.keys(s.ranges).length === 0;
}

/** The engine's FilterSpec for a state (AND semantics are the engine's). */
export function toSpec(s: FilterState): FilterSpec {
  const ranges: Partial<Record<MeasurementKey, RangeState>> = {};
  for (const [k, r] of Object.entries(s.ranges) as [MeasurementKey, RangeState][]) {
    if (r.min === undefined && r.max === undefined) continue;
    ranges[k] = { ...(r.min !== undefined ? { min: r.min } : {}), ...(r.max !== undefined ? { max: r.max } : {}) };
  }
  return {
    ...(s.categories.length ? { categories: s.categories } : {}), ...(s.datasets.length ? { datasets: s.datasets } : {}),
    ...(s.bands.length ? { distanceBands: s.bands } : {}), ...(s.spectral.length ? { spectralClasses: s.spectral } : {}),
    ...(Object.keys(ranges).length ? { ranges } : {}),
  };
}

export function toggle<T>(list: readonly T[], v: T): T[] { return list.includes(v) ? list.filter((x) => x !== v) : [...list, v]; }

export function withRange(s: FilterState, key: MeasurementKey, r: RangeState): FilterState {
  const ranges = { ...s.ranges };
  if (r.min === undefined && r.max === undefined) delete ranges[key]; else ranges[key] = { ...(r.min !== undefined ? { min: r.min } : {}), ...(r.max !== undefined ? { max: r.max } : {}) };
  return { ...s, ranges };
}

/** Parse what the user typed into a range box: empty -> undefined (open end); "1e3", "-0.5" and "3,000" are numbers; anything else is invalid. */
export function parseBound(text: string): { ok: true; value: number | undefined } | { ok: false } {
  const t = text.trim().replace(/,/g, '');
  if (t === '') return { ok: true, value: undefined };
  const v = Number(t);
  return Number.isFinite(v) ? { ok: true, value: v } : { ok: false };
}

// ---- URL hash ----------------------------------------------------------------------------------------------------------------

const P = 'f.';
/** `f.cat=star,galaxy&f.band=nearby-stars&f.r.teffK=3000..6000` (no leading '#'). Round-trips through parseFilter. */
export function serializeFilter(s: FilterState): string {
  const p: string[] = [];
  const list = (k: string, v: readonly string[]): void => { if (v.length) p.push(`${P}${k}=${v.map(encodeURIComponent).join(',')}`); };
  list('cat', s.categories); list('ds', s.datasets); list('band', s.bands); list('sp', s.spectral);
  for (const key of MEASUREMENT_KEYS) {
    const r = s.ranges[key];
    if (!r || (r.min === undefined && r.max === undefined)) continue;
    p.push(`${P}r.${key}=${r.min ?? ''}..${r.max ?? ''}`);
  }
  return p.join('&');
}

/** Unknown names and malformed numbers are ignored, never trusted. Accepts a hash with or without '#'. */
export function parseFilter(hash: string): FilterState {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const pick = <T extends string>(k: string, allowed: readonly T[]): T[] => {
    const raw = params.get(P + k);
    if (!raw) return [];
    return [...new Set(raw.split(',').map((x) => decodeURIComponent(x)).filter((x): x is T => (allowed as readonly string[]).includes(x)))];
  };
  const ranges: Partial<Record<MeasurementKey, RangeState>> = {};
  for (const key of MEASUREMENT_KEYS) {
    const raw = params.get(`${P}r.${key}`);
    if (!raw) continue;
    const i = raw.indexOf('..');
    if (i < 0) continue;
    const lo = parseBound(raw.slice(0, i)), hi = parseBound(raw.slice(i + 2));
    if (!lo.ok || !hi.ok || (lo.value === undefined && hi.value === undefined)) continue;
    ranges[key] = { ...(lo.value !== undefined ? { min: lo.value } : {}), ...(hi.value !== undefined ? { max: hi.value } : {}) };
  }
  return {
    categories: pick<ObjectCategory>('cat', OBJECT_CATEGORIES), datasets: pick<DatasetId>('ds', DATASET_IDS),
    bands: pick<DistanceBandId>('band', DISTANCE_BANDS.map((b) => b.id)), spectral: pick<SpectralClass>('sp', SPECTRAL_CLASSES), ranges,
  };
}

export function hasFilterParams(hash: string): boolean { return /(^|&)f\./.test(hash.replace(/^#/, '')); }

// ---- what to offer -----------------------------------------------------------------------------------------------------------

export interface MeasurementOffer { readonly key: MeasurementKey; readonly label: string; readonly unit: string; readonly count: number; readonly total: number; readonly min: number; readonly max: number; readonly haveText: string }
/** Only the measurements the facets say have at least one value; keys with no data are not offered at all. */
export function offeredMeasurements(f: Facets): MeasurementOffer[] {
  return f.measurements.filter((m) => m.count > 0).map((m) => {
    const meta = MEASUREMENT_META[m.key];
    return { key: m.key, label: meta.label, unit: meta.unit, count: m.count, total: f.total, min: m.min, max: m.max, haveText: `${nf(m.count)} of ${nf(f.total)} records have this value` };
  });
}

const compactPc = (pc: number): string => {
  if (!Number.isFinite(pc)) return '';
  if (pc >= 1e6) return `${+(pc / 1e6).toPrecision(3)} Mpc`;
  if (pc >= 1e3) return `${+(pc / 1e3).toPrecision(3)} kpc`;
  return `${+pc.toPrecision(3)} pc`;
};
/** Named distance bands with their bounds, e.g. "Nearby stars (up to 25 pc)". */
export function bandBounds(id: DistanceBandId): string {
  const b = DISTANCE_BANDS.find((x) => x.id === id)!;
  if (id === 'solar-system') return 'Solar System bodies';
  if (!Number.isFinite(b.maxPc)) return `beyond ${compactPc(b.minPc)}`;
  return b.minPc <= 0 ? `up to ${compactPc(b.maxPc)}` : `${compactPc(b.minPc)} to ${compactPc(b.maxPc)}`;
}
export interface BandOffer { readonly id: DistanceBandId; readonly label: string; readonly bounds: string; readonly definition: string; readonly count: number }
export function offeredBands(f: Facets): BandOffer[] {
  return f.distanceBands.map((b) => {
    const def = DISTANCE_BANDS.find((x) => x.id === b.id)!;
    return { id: b.id, label: def.label, bounds: bandBounds(b.id), definition: def.definition, count: b.count };
  });
}
export const offeredCategories = (f: Facets): { id: ObjectCategory; label: string; count: number }[] => f.categories.map((c) => ({ id: c.id, label: CATEGORY_LABEL[c.id], count: c.count }));
export const offeredDatasets = (f: Facets): { id: DatasetId; label: string; count: number }[] => f.datasets.map((d) => ({ id: d.id, label: DATASET_LABELS[d.id], count: d.count }));
export const offeredSpectral = (f: Facets): { id: SpectralClass; label: string; count: number }[] => f.spectralClasses.map((c) => ({ id: c.id, label: c.id === 'unknown' ? 'unknown' : c.id, count: c.count }));

// ---- sentences about results -------------------------------------------------------------------------------------------------

const MISSING_PHRASE: Partial<Record<FilterKey, string>> = {
  distanceBand: 'a distance', spectralClass: 'a usable spectral type',
};
function missingPhrase(key: FilterKey): string {
  const p = MISSING_PHRASE[key];
  if (p) return p;
  const meta = MEASUREMENT_META[key as MeasurementKey];
  const label = meta.label.replace(/ \(.*\)$/, '').toLowerCase();
  return /^(a|e|i|o|u)/.test(label) ? `an ${label}` : `a ${label}`;
}

/** "1,204 records without a temperature are not included". One line per filtered key that excluded something. */
export function excludedLines(out: Pick<FilterOutcome, 'excludedForMissing'>): string[] {
  const lines: string[] = [];
  for (const [key, n] of Object.entries(out.excludedForMissing) as [FilterKey, number][]) {
    if (!n) continue;
    lines.push(`${nf(n)} ${n === 1 ? 'record' : 'records'} without ${missingPhrase(key)} ${n === 1 ? 'is' : 'are'} not included.`);
  }
  return lines;
}

export interface FilterSummary { readonly countText: string; readonly scopeText: string; readonly excluded: readonly string[]; readonly windowText: string | null; readonly provisional: string | null; readonly highlightCount: number }
export const HIGHLIGHT_MAX = 256;
export const FILTER_WINDOW = 40;
export function summariseFilter(out: FilterOutcome, shown = FILTER_WINDOW): FilterSummary {
  return {
    countText: `${nf(out.count)} ${out.count === 1 ? 'record matches' : 'records match'}`,
    scopeText: `among ${nf(out.scope)} records that pass the category and dataset choices`,
    excluded: excludedLines(out),
    windowText: out.count > shown ? `showing ${nf(Math.min(shown, out.ids.length))} of ${nf(out.count)}; refine the filters` : null,
    provisional: out.complete ? null : 'Counts exclude the point catalogues that are still loading.',
    highlightCount: Math.min(HIGHLIGHT_MAX, out.ids.length),
  };
}
