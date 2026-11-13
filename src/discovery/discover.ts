/**
 * Discovery lists (Prompt 07): "nearest stars", "brightest", "fastest proper motion", ... computed from a RecordStore with an explicit
 * criterion and honest scope text. Nothing here invents an interest story (those come from the curated notes, with references):
 * every `reason` is a sentence composed ONLY from the record's own data.
 *
 * Every list states:
 *  - criterion     what is ranked and how ("smallest distance; ...")
 *  - scope         "among N records ..." with the datasets that contributed, and how many records were excluded and why
 *  - caveat        what the data cannot say (e.g. Gaia DR3 omits stars brighter than G = 1.5)
 *  - completeness  always 'not complete': a list covers the datasets held by this atlas, never the sky
 * A record without the ranked value does not qualify (and is counted in `without`), it is never ranked as 0.
 */
import { formatNumber } from '../core/spatial/scale';
import type { RelationGraph } from './relations';
import { DATASET_IDS, MEASUREMENT_META, OBJECT_CATEGORIES, viewSize, wholeStore, type RecordStore, type StoreView } from './recordStore';
import type { DatasetId, MeasurementKey, ObjectCategory, UniversalId, ValueKind } from './types';

export const DATASET_LABELS: Readonly<Record<DatasetId, string>> = {
  'gaia-dr3': 'Gaia DR3', hipparcos: 'Hipparcos', 'solar-system': 'Solar System dataset', 'deep-space': 'curated deep-space objects',
  'nasa-exoplanet-archive': 'NASA Exoplanet Archive', ungc: 'Updated Nearby Galaxy Catalog', 'local-group-mcconnachie': 'McConnachie 2012 Local Group catalogue',
  twomrs: '2MASS Redshift Survey', 'curated-other': 'curated other objects',
};

/** Parallax signal-to-noise below which a distance is not used for "nearest" rankings. d / sigma_d equals parallax / sigma_parallax. */
export const MIN_DISTANCE_SNR = 5;

export interface DiscoveryItem {
  readonly rank: number;
  readonly id: UniversalId;
  readonly name: string;
  readonly value: number;
  /** The value with its unit, e.g. "1.30 pc". */
  readonly valueText: string;
  /** "±0.002 pc" or "uncertainty not published". */
  readonly uncertaintyText: string;
  readonly kind: ValueKind | undefined;
  /** Quality flags the source attached to the record (e.g. Gaia 'high-ruwe'); the item is kept and the UI shows them. */
  readonly flags: readonly string[];
  /** One sentence made only of this record's data. */
  readonly reason: string;
}

export interface DiscoveryList {
  readonly id: string;
  readonly title: string;
  readonly criterion: string;
  readonly scope: string;
  readonly caveat: string;
  readonly completeness: 'not complete';
  /** Records that qualified (have the value and pass the rules). */
  readonly qualifying: number;
  /** Records that could have qualified by category but were excluded, with the reason. */
  readonly excluded: readonly { readonly reason: string; readonly count: number }[];
  readonly items: readonly DiscoveryItem[];
}

const nf = (n: number): string => n.toLocaleString('en-US');
const STAR_CATS: readonly ObjectCategory[] = ['star', 'exoplanet-host'];

/** A value in its unit, readable at any magnitude. */
export function formatMeasurement(key: MeasurementKey, value: number, category?: ObjectCategory): string {
  switch (key) {
    case 'distancePc': return value >= 1e6 ? `${formatNumber(value / 1e6)} Mpc` : value >= 1e3 ? `${formatNumber(value / 1e3)} kpc` : `${formatNumber(value)} pc`;
    case 'physicalSizePc': return value >= 1e3 ? `${formatNumber(value / 1e3)} kpc` : `${formatNumber(value)} pc`;
    case 'apparentMag': case 'absoluteMag': case 'bpRp': return `${value.toFixed(2)} mag`;
    case 'teffK': return `${Math.round(value).toLocaleString('en-US')} K`;
    case 'radiusKm': return category === 'exoplanet' || category === 'planet' || category === 'moon' ? `${formatNumber(value)} km (${(value / 6371).toFixed(2)} Earth radii)` : `${formatNumber(value)} km`;
    case 'orbitalPeriodDays': return value < 1 ? `${(value * 24).toFixed(2)} hours` : `${formatNumber(value)} days`;
    case 'pmTotalMasYr': return `${formatNumber(value)} mas/yr`;
    case 'czKms': return `${formatNumber(value)} km/s`;
    case 'massKg': return `${formatNumber(value)} kg`;
    case 'angularSizeArcmin': return `${formatNumber(value)} arcmin`;
    case 'luminositySun': return `${formatNumber(value)} L☉`;
    case 'radiusSun': return `${formatNumber(value)} R☉`;
    case 'redshift': return value.toFixed(5);
  }
}

function uncertaintyText(key: MeasurementKey, u: number | undefined, category?: ObjectCategory): string {
  return u === undefined ? 'uncertainty not published' : `±${formatMeasurement(key, u, category)}`;
}

interface Selected { readonly idx: number[]; readonly considered: number; readonly excluded: { reason: string; count: number }[] }

function datasetBreakdown(store: RecordStore, idx: readonly number[]): string {
  const c = new Array<number>(DATASET_IDS.length).fill(0);
  for (const i of idx) c[store.datasetIdx[i]!]!++;
  const parts = DATASET_IDS.map((d, k) => ({ d, n: c[k]! })).filter((x) => x.n > 0).map((x) => `${DATASET_LABELS[x.d]}: ${nf(x.n)}`);
  return parts.length > 0 ? parts.join(' + ') : 'no datasets';
}

/** Every list needs the same three steps: visit the view, keep records of the right categories/datasets that have the value, sort. */
function select(view: StoreView, o: { cats: readonly ObjectCategory[]; datasets?: readonly DatasetId[]; key: MeasurementKey; accept?: (i: number, why: (r: string) => void) => boolean }): Selected {
  const { store } = view;
  const ci = new Uint8Array(OBJECT_CATEGORIES.length);
  for (const c of o.cats) ci[OBJECT_CATEGORIES.indexOf(c)] = 1;
  const di = o.datasets ? new Uint8Array(DATASET_IDS.length) : null;
  if (di) for (const d of o.datasets!) di[DATASET_IDS.indexOf(d)] = 1;
  const reasons = new Map<string, number>();
  const why = (r: string): void => { reasons.set(r, (reasons.get(r) ?? 0) + 1); };
  const idx: number[] = [];
  let considered = 0;
  const n = viewSize(view);
  for (let k = 0; k < n; k++) {
    const i = view.indices === null ? k : view.indices[k]!;
    if (ci[store.categoryIdx[i]!] === 0) continue;
    if (di && di[store.datasetIdx[i]!] === 0) continue;
    considered++;
    if (!store.has(o.key, i)) { why(`no ${MEASUREMENT_META[o.key].label.toLowerCase()} in the data`); continue; }
    if (o.accept && !o.accept(i, why)) continue;
    idx.push(i);
  }
  return { idx, considered, excluded: [...reasons.entries()].map(([reason, count]) => ({ reason, count })) };
}

function makeItems(store: RecordStore, idx: readonly number[], key: MeasurementKey, n: number, reasonFor: (i: number, rank: number, valueText: string, unc: string, kind: ValueKind | undefined) => string): DiscoveryItem[] {
  return idx.slice(0, Math.max(0, n)).map((i, r) => {
    const value = store.value(key, i)!;
    const cat = store.categoryAt(i);
    const valueText = formatMeasurement(key, value, cat);
    const unc = uncertaintyText(key, store.uncertainty(key, i), cat);
    const kind = store.kind(key, i);
    return { rank: r + 1, id: store.idAt(i), name: store.recordAt(i).name, value, valueText, uncertaintyText: unc, kind, flags: store.recordAt(i).qualityFlags ?? [], reason: reasonFor(i, r + 1, valueText, unc, kind) };
  });
}

function sortBy(store: RecordStore, idx: number[], key: MeasurementKey, order: 'asc' | 'desc'): number[] {
  const col = store.column(key)!;
  const sgn = order === 'asc' ? 1 : -1;
  return idx.sort((a, b) => sgn * (col.values[a]! - col.values[b]!) || (store.idAt(a) < store.idAt(b) ? -1 : 1));
}

/** How many of the next entries have a distance range (value +- uncertainty) that overlaps the first entry's: their order is then not certain. */
function overlapWithFirst(store: RecordStore, idx: readonly number[], key: MeasurementKey, among: number): number {
  if (idx.length < 2) return 0;
  const v0 = store.value(key, idx[0]!)!, u0 = store.uncertainty(key, idx[0]!);
  if (u0 === undefined) return 0;
  let n = 0;
  for (let k = 1; k < Math.min(idx.length, among); k++) {
    const v = store.value(key, idx[k]!)!, u = store.uncertainty(key, idx[k]!) ?? 0;
    if (v - u <= v0 + u0) n++; else break;
  }
  return n;
}
function withOverlap(l: DiscoveryList, n: number): DiscoveryList {
  if (n === 0 || l.items.length === 0) return l;
  const note = `Within their stated uncertainties the first ${n + 1} distances overlap, so their order is not certain.`;
  const first = l.items[0]!;
  return { ...l, caveat: `${note} ${l.caveat}`, items: [{ ...first, reason: `${first.reason} ${note}` }, ...l.items.slice(1)] };
}
function withFlagNote(l: DiscoveryList): DiscoveryList {
  const flagged = l.items.filter((i) => i.flags.length > 0).length;
  return flagged === 0 ? l : { ...l, caveat: `${flagged} of the ${l.items.length} entries carry quality flags from the source (listed on each entry); they are kept, not hidden. ${l.caveat}` };
}

const kindWord = (k: ValueKind | undefined): string => (k === undefined ? 'kind not stated' : k);

function geoCaveat(store: RecordStore, idx: readonly number[], what: 'distance' | 'brightness'): string {
  const hasGaia = idx.some((i) => store.datasetIdx[i] === DATASET_IDS.indexOf('gaia-dr3'));
  const hip = idx.filter((i) => store.datasetIdx[i] === DATASET_IDS.indexOf('hipparcos')).length;
  const parts: string[] = [];
  if (hasGaia) {
    parts.push(hip > 0
      ? `Gaia DR3 omits stars brighter than G = 1.5; the Hipparcos supplement (${nf(hip)} stars here) covers those.`
      : 'Gaia DR3 omits stars brighter than G = 1.5 and no Hipparcos supplement is loaded here, so the brightest stars are missing from this list.');
    parts.push('The Gaia data held here are a subset of Gaia DR3, not the whole catalogue.');
  }
  if (what === 'brightness') parts.push('Apparent magnitudes are in different photometric bands in different datasets (Gaia G, Hipparcos V, archive V), so values from different datasets are not strictly comparable.');
  if (what === 'distance') parts.push('Distances are inverse-parallax estimates with no zero-point correction; only those with distance/uncertainty of at least 5 are ranked.');
  parts.push('The list covers the datasets loaded in this atlas, not the whole sky.');
  return parts.join(' ');
}

// ---- stars ---------------------------------------------------------------------------------------------------------------------------

const distanceAccept = (store: RecordStore) => (i: number, why: (r: string) => void): boolean => {
  const d = store.value('distancePc', i)!;
  const u = store.uncertainty('distancePc', i);
  if (store.datasetIdx[i] === DATASET_IDS.indexOf('solar-system')) { why('Solar System body'); return false; }
  if (u === undefined || !(u > 0)) { why('no published distance uncertainty, so the parallax S/N cannot be checked'); return false; }
  if (d / u < MIN_DISTANCE_SNR) { why(`distance/uncertainty below ${MIN_DISTANCE_SNR} (parallax S/N < ${MIN_DISTANCE_SNR}: distance unreliable)`); return false; }
  return true;
};

export function nearestStars(view: StoreView, n = 10): DiscoveryList {
  const { store } = view;
  const s = select(view, { cats: STAR_CATS, key: 'distancePc', accept: distanceAccept(store) });
  const idx = sortBy(store, s.idx, 'distancePc', 'asc');
  return withFlagNote(withOverlap({
    id: 'nearest-stars', title: 'Nearest stars',
    criterion: `Smallest distance from the Sun among stars whose distance has parallax S/N of at least ${MIN_DISTANCE_SNR} (distance divided by its uncertainty).`,
    scope: `among ${nf(idx.length)} star records with a reliable distance (${datasetBreakdown(store, idx)}), out of ${nf(s.considered)} star records in view`,
    caveat: geoCaveat(store, idx, 'distance'), completeness: 'not complete', qualifying: idx.length, excluded: s.excluded,
    items: makeItems(store, idx, 'distancePc', n, (i, r, v, u, k) => `${r === 1 ? 'Closest star in this dataset' : `Number ${r} by distance in this dataset`}: ${v} (${kindWord(k)}, ${u}; distance/uncertainty ${(store.value('distancePc', i)! / store.uncertainty('distancePc', i)!).toFixed(0)}).`),
  }, overlapWithFirst(store, idx, 'distancePc', n)));
}

export function brightestStars(view: StoreView, n = 10): DiscoveryList {
  const { store } = view;
  const s = select(view, { cats: STAR_CATS, key: 'apparentMag', accept: (i, why) => { if (store.datasetIdx[i] === DATASET_IDS.indexOf('solar-system')) { why('Solar System body'); return false; } return true; } });
  const idx = sortBy(store, s.idx, 'apparentMag', 'asc');
  return {
    id: 'brightest-stars', title: 'Brightest stars as seen from the Sun',
    criterion: 'Smallest apparent magnitude (brighter = smaller number) as published in each dataset.',
    scope: `among ${nf(idx.length)} star records that have an apparent magnitude (${datasetBreakdown(store, idx)}), out of ${nf(s.considered)} star records in view`,
    caveat: geoCaveat(store, idx, 'brightness'), completeness: 'not complete', qualifying: idx.length, excluded: s.excluded,
    items: makeItems(store, idx, 'apparentMag', n, (i, r, v, u, k) => `${r === 1 ? 'Brightest star in this dataset' : `Number ${r} by apparent magnitude in this dataset`}: ${v} (${kindWord(k)}, ${u}; ${DATASET_LABELS[store.datasetAt(i)]}).`),
  };
}

export function fastestProperMotion(view: StoreView, n = 10): DiscoveryList {
  const { store } = view;
  const s = select(view, { cats: STAR_CATS, key: 'pmTotalMasYr' });
  const idx = sortBy(store, s.idx, 'pmTotalMasYr', 'desc');
  return {
    id: 'fastest-proper-motion', title: 'Fastest proper motion',
    criterion: 'Largest total proper motion on the sky (mas per year), computed from the published proper-motion components.',
    scope: `among ${nf(idx.length)} star records that have a proper motion (${datasetBreakdown(store, idx)}), out of ${nf(s.considered)} star records in view`,
    caveat: 'Proper motion is an angular rate on the sky; it depends on both the star\'s speed and its distance, so it is not a ranking of speed. The list covers the datasets loaded in this atlas, not the whole sky.',
    completeness: 'not complete', qualifying: idx.length, excluded: s.excluded,
    items: makeItems(store, idx, 'pmTotalMasYr', n, (_i, r, v, u, k) => `${r === 1 ? 'Largest proper motion in this dataset' : `Number ${r} by proper motion in this dataset`}: ${v} (${kindWord(k)}, ${u}).`),
  };
}

// ---- exoplanets ----------------------------------------------------------------------------------------------------------------------

/** Number of confirmed planets per host, from the relation graph (planet --orbits--> host, physical), counted for hosts present in the store. */
export function planetCountsByHost(graph: RelationGraph, store: RecordStore): Map<UniversalId, number> {
  const counts = new Map<UniversalId, number>();
  for (const r of graph.all()) {
    if (r.kind !== 'orbits' || r.basis !== 'physical-gravitational') continue;
    const pi = store.indexOfId(r.from), hi = store.indexOfId(r.to);
    if (pi < 0 || hi < 0 || store.categoryAt(pi) !== 'exoplanet') continue;
    const hc = store.categoryAt(hi);
    if (hc !== 'star' && hc !== 'exoplanet-host') continue;
    counts.set(r.to, (counts.get(r.to) ?? 0) + 1);
  }
  return counts;
}

export function nearestExoplanetSystems(view: StoreView, planetCounts: ReadonlyMap<UniversalId, number>, n = 10): DiscoveryList {
  const { store } = view;
  const base = distanceAccept(store);
  const s = select(view, { cats: STAR_CATS, key: 'distancePc', accept: (i, why) => { if ((planetCounts.get(store.idAt(i)) ?? 0) === 0) return false; return base(i, why); } });
  const idx = sortBy(store, s.idx, 'distancePc', 'asc');
  const withPlanets = (() => { let c = 0; for (const [k, n] of planetCounts) if (n > 0 && store.indexOfId(k) >= 0) c++; return c; })();
  return withFlagNote(withOverlap({
    id: 'nearest-exoplanet-systems', title: 'Nearest stars with confirmed planets',
    criterion: `Smallest distance from the Sun among stars that host at least one confirmed planet in the NASA Exoplanet Archive and whose distance has S/N of at least ${MIN_DISTANCE_SNR}.`,
    scope: `among ${nf(idx.length)} host stars with a reliable distance (${datasetBreakdown(store, idx)}), out of ${nf(withPlanets)} host stars in the atlas`,
    caveat: 'Only planets confirmed in the NASA Exoplanet Archive and loaded here are counted; a star with no listed planet is not known to have none. Detection methods favour some systems, so this is not a census. The list covers the datasets loaded in this atlas, not the whole sky.',
    completeness: 'not complete', qualifying: idx.length, excluded: s.excluded,
    items: makeItems(store, idx, 'distancePc', n, (i, r, v, u, k) => `${r === 1 ? 'Closest star with a confirmed planet in this dataset' : `Number ${r} by distance among planet hosts`}: ${v} (${kindWord(k)}, ${u}); ${planetCounts.get(store.idAt(i))} confirmed planet${planetCounts.get(store.idAt(i)) === 1 ? '' : 's'} listed.`),
  }, overlapWithFirst(store, idx, 'distancePc', n)));
}

export function mostPlanetsInSystem(view: StoreView, planetCounts: ReadonlyMap<UniversalId, number>, n = 10): DiscoveryList {
  const { store } = view;
  const rows: { i: number; count: number }[] = [];
  const nv = viewSize(view);
  let considered = 0;
  const inView = view.indices === null ? null : new Set<number>(view.indices);
  void nv;
  for (const [id, count] of planetCounts) {
    const i = store.indexOfId(id);
    if (i < 0 || count <= 0) continue;
    if (inView !== null && !inView.has(i)) continue;
    considered++;
    rows.push({ i, count });
  }
  rows.sort((a, b) => b.count - a.count || (store.idAt(a.i) < store.idAt(b.i) ? -1 : 1));
  const items: DiscoveryItem[] = rows.slice(0, Math.max(0, n)).map((r, k) => ({
    rank: k + 1, id: store.idAt(r.i), name: store.recordAt(r.i).name, value: r.count,
    valueText: `${r.count} confirmed planet${r.count === 1 ? '' : 's'}`, uncertaintyText: 'a count of listed planets (no uncertainty)', kind: 'observed', flags: [],
    reason: `${store.recordAt(r.i).name} has ${r.count} confirmed planet${r.count === 1 ? '' : 's'} listed in the NASA Exoplanet Archive${k > 0 && rows[k - 1]!.count === r.count ? ' (tied with the system above)' : ''}.`,
  }));
  return {
    id: 'most-planets', title: 'Most confirmed planets in one system',
    criterion: 'Largest number of confirmed planets listed for one host star in the NASA Exoplanet Archive records loaded here. Ties are shown in alphabetical order of id.',
    scope: `among ${nf(considered)} host stars with at least one listed planet`,
    caveat: 'A count of planets listed, not a count of planets that exist: systems that were observed more closely have more detections. The list covers the datasets loaded in this atlas, not the whole sky.',
    completeness: 'not complete', qualifying: considered, excluded: [], items,
  };
}

function planetList(view: StoreView, id: string, title: string, key: MeasurementKey, order: 'asc' | 'desc', criterion: string, word: string, n: number, extraCaveat: string): DiscoveryList {
  const { store } = view;
  const s = select(view, { cats: ['exoplanet'], key });
  const idx = sortBy(store, s.idx, key, order);
  return {
    id, title, criterion,
    scope: `among ${nf(idx.length)} confirmed exoplanets that have a published ${MEASUREMENT_META[key].label.toLowerCase()}, out of ${nf(s.considered)} exoplanets in view (${datasetBreakdown(store, idx)})`,
    caveat: `${extraCaveat} Planets without this value are not ranked (they are not treated as zero). The list covers the datasets loaded in this atlas, not the whole sky.`,
    completeness: 'not complete', qualifying: idx.length, excluded: s.excluded,
    items: makeItems(store, idx, key, n, (_i, r, v, u, k) => `${r === 1 ? word : `Number ${r}`} among the ${nf(idx.length)} planets with this value: ${v} (${kindWord(k)}, ${u}).`),
  };
}

export const hottestExoplanets = (view: StoreView, n = 10): DiscoveryList => planetList(view, 'hottest-exoplanets', 'Hottest exoplanets', 'teffK', 'desc',
  'Highest equilibrium temperature published in the NASA Exoplanet Archive (the temperature a planet would have if it only absorbed and re-radiated starlight).', 'Highest equilibrium temperature', n,
  'Equilibrium temperature is modelled from the star and the orbit, not measured on the planet.');
export const shortestPeriodExoplanets = (view: StoreView, n = 10): DiscoveryList => planetList(view, 'shortest-period-exoplanets', 'Shortest orbital periods', 'orbitalPeriodDays', 'asc',
  'Smallest orbital period (days) published in the NASA Exoplanet Archive.', 'Shortest orbital period', n, 'Short periods are easiest to detect, so they are over-represented among known planets.');
export const largestExoplanets = (view: StoreView, n = 10): DiscoveryList => planetList(view, 'largest-exoplanets', 'Largest exoplanets', 'radiusKm', 'desc',
  'Largest radius published in the NASA Exoplanet Archive (converted from Earth radii at 6378.1 km).', 'Largest radius', n, 'Large radii for the biggest candidates depend on models of the star and, for some, on a single transit.');

// ---- galaxies and nebulae ------------------------------------------------------------------------------------------------------------

export function nearestGalaxies(view: StoreView, n = 10): DiscoveryList {
  const { store } = view;
  const s = select(view, {
    cats: ['galaxy'], datasets: ['deep-space', 'ungc', 'local-group-mcconnachie'], key: 'distancePc',
    accept: (i, why) => { if (store.kind('distancePc', i) !== 'observed') { why('distance is not an independent published measurement (derived from group membership, Hubble flow or similar)'); return false; } return true; },
  });
  const idx = sortBy(store, s.idx, 'distancePc', 'asc');
  return withFlagNote(withOverlap({
    id: 'nearest-galaxies', title: 'Nearest galaxies',
    criterion: 'Smallest distance from the Sun among galaxies with a directly published distance (kind observed) in the curated deep-space file, the Updated Nearby Galaxy Catalog and the McConnachie Local Group catalogue.',
    scope: `among ${nf(idx.length)} galaxies with a direct distance (${datasetBreakdown(store, idx)}), out of ${nf(s.considered)} galaxy records from those datasets in view`,
    caveat: 'Satellite galaxies of the Milky Way come first. The catalogues are compilations, not complete: faint dwarfs are missing and the Zone of Avoidance hides galaxies behind the Milky Way plane. Redshift-survey galaxies (2MRS) are not ranked because their distances are derived from cz. The list covers the datasets loaded in this atlas.',
    completeness: 'not complete', qualifying: idx.length, excluded: s.excluded,
    items: makeItems(store, idx, 'distancePc', n, (i, r, v, u, k) => `${r === 1 ? 'Nearest galaxy in these datasets' : `Number ${r} by distance in these datasets`}: ${v} (${kindWord(k)}, ${u}; ${DATASET_LABELS[store.datasetAt(i)]}).`),
  }, overlapWithFirst(store, idx, 'distancePc', n)));
}

export function largestNebulae(view: StoreView, n = 10): DiscoveryList {
  const { store } = view;
  const s = select(view, { cats: ['nebula', 'supernova-remnant'], key: 'physicalSizePc' });
  const idx = sortBy(store, s.idx, 'physicalSizePc', 'desc');
  return {
    id: 'largest-nebulae', title: 'Largest nebulae by physical size',
    criterion: 'Largest physical diameter (parsecs), derived from the published angular size and distance.',
    scope: `among ${nf(idx.length)} nebulae and supernova remnants that have a physical size, out of ${nf(s.considered)} in view (${datasetBreakdown(store, idx)})`,
    caveat: 'The size is the extent in the catalogue\'s own band and isophote, not a sharp boundary, and it inherits the uncertainty of the distance. The list covers the datasets loaded in this atlas, not the whole sky.',
    completeness: 'not complete', qualifying: idx.length, excluded: s.excluded,
    items: makeItems(store, idx, 'physicalSizePc', n, (_i, r, v, u, k) => `${r === 1 ? 'Largest nebula in this dataset' : `Number ${r} by physical size in this dataset`}: ${v} (${kindWord(k)}, ${u}).`),
  };
}

// ---- generic -------------------------------------------------------------------------------------------------------------------------

export interface RankOptions {
  readonly categories?: readonly ObjectCategory[];
  readonly datasets?: readonly DatasetId[];
  readonly title?: string;
}

/** Rank the records of a view by any measurement. Records without the value do not qualify and are counted, never ranked as 0. */
export function rank(view: StoreView, key: MeasurementKey, order: 'asc' | 'desc', n = 10, opts: RankOptions = {}): DiscoveryList {
  const { store } = view;
  const s = select(view, { cats: opts.categories ?? OBJECT_CATEGORIES, key, ...(opts.datasets ? { datasets: opts.datasets } : {}) });
  const idx = store.column(key) ? sortBy(store, s.idx, key, order) : [];
  const meta = MEASUREMENT_META[key];
  return {
    id: `rank-${key}-${order}`, title: opts.title ?? `${order === 'asc' ? 'Smallest' : 'Largest'} ${meta.label.toLowerCase()}`,
    criterion: `${order === 'asc' ? 'Smallest' : 'Largest'} ${meta.label.toLowerCase()} (${meta.unit || 'dimensionless'}), as published; ties broken by id.`,
    scope: `among ${nf(idx.length)} records that have a ${meta.label.toLowerCase()} (${datasetBreakdown(store, idx)}), out of ${nf(s.considered)} records in view`,
    caveat: 'Values of different kinds (observed, derived, modelled) and from different datasets are ranked together as published. The list covers the datasets loaded in this atlas, not the whole sky.',
    completeness: 'not complete', qualifying: idx.length, excluded: s.excluded,
    items: makeItems(store, idx, key, n, (_i, r, v, u, k) => `Number ${r} of ${nf(idx.length)} by ${meta.label.toLowerCase()}: ${v} (${kindWord(k)}, ${u}).`),
  };
}

export { wholeStore };
