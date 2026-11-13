/**
 * Search view model (pure): turns an atlas search result into rows, chips and the state to show. No DOM, no atlas calls.
 */
import type { AtlasSearchHit, AtlasSearchResult, AtlasStatus } from '../../discovery/engineApi';
import type { SuggestItem } from '../../discovery/atlas';
import type { DiscoveryRecord, ObjectCategory } from '../../discovery/types';
import { CATEGORY_GROUPS, CATEGORY_LABEL, distanceTextFor, nf, type CategoryGroupId } from './labels';

export const WINDOW_SIZE = 40;
export const NOT_DRAWN_TEXT = 'not drawn / inspect only';
export const INVALID_ID_MESSAGE = 'No record with that identifier in this atlas; the atlas holds a subset of the catalogue.';

export interface SearchRowVm {
  readonly key: string;
  readonly id: string;
  readonly categoryLabel: string;
  readonly name: string;
  /** The designation that matched, only when it differs from the name. */
  readonly matchedAs: string | null;
  /** "matched “sirus” as Sirius" for a typo-tolerant match. */
  readonly fuzzyNote: string | null;
  readonly classification: string;
  readonly distanceText: string;
  readonly notDrawn: boolean;
  readonly notDrawnText: string | null;
  readonly ariaLabel: string;
  /** Anything that changes the row's look (for keyed reconciliation). */
  readonly sig: string;
}

export interface ChipVm { readonly id: CategoryGroupId; readonly label: string; readonly count: number; readonly active: boolean }

export interface DatasetLine { readonly label: string; readonly count: number | null; readonly state: string; readonly error?: string }

export type SearchView =
  | { readonly kind: 'idle'; readonly recent: readonly SearchRowVm[]; readonly featured: readonly SearchRowVm[]; readonly progress: string | null }
  | { readonly kind: 'indexing'; readonly message: string }
  | { readonly kind: 'results'; readonly rows: readonly SearchRowVm[]; readonly chips: readonly ChipVm[]; readonly total: number; readonly windowText: string | null; readonly progress: string | null }
  | { readonly kind: 'empty'; readonly message: string; readonly chips: readonly ChipVm[]; readonly datasets: readonly DatasetLine[]; readonly progress: string | null }
  | { readonly kind: 'invalid-id'; readonly message: string; readonly detail: string | null; readonly chips: readonly ChipVm[]; readonly progress: string | null };

// ---- text helpers ------------------------------------------------------------------------------------------------------------

/** "matched “sirus” as Sirius": the word of the matched designation the typo was matched to (its capitalisation as published). */
export function fuzzyNoteFor(hit: Pick<AtlasSearchHit, 'fuzzy' | 'matchedDesignation'>): string | null {
  const f = hit.fuzzy;
  if (!f) return null;
  const token = hit.matchedDesignation.split(/[\s,]+/).find((t) => t.toLowerCase() === f.matched.toLowerCase());
  return `matched “${f.typed}” as ${token ?? hit.matchedDesignation}`;
}

export function rowFromHit(hit: AtlasSearchHit, rec: DiscoveryRecord | undefined): SearchRowVm {
  const categoryLabel = CATEGORY_LABEL[hit.category] ?? hit.category;
  const matchedAs = hit.matchedDesignation !== hit.name ? hit.matchedDesignation : null;
  const fuzzyNote = fuzzyNoteFor(hit);
  const distanceText = distanceTextFor(rec);
  const notDrawn = !hit.drawn;
  return finishRow({ id: hit.id, categoryLabel, name: hit.name, matchedAs, fuzzyNote, classification: hit.classification, distanceText, notDrawn });
}

export function rowFromItem(item: SuggestItem, rec: DiscoveryRecord | undefined): SearchRowVm {
  return finishRow({
    id: item.id, categoryLabel: CATEGORY_LABEL[item.category] ?? item.category, name: item.name, matchedAs: null, fuzzyNote: null, classification: item.classification,
    distanceText: distanceTextFor(rec), notDrawn: rec ? !rec.drawn : false,
  });
}

function finishRow(r: { id: string; categoryLabel: string; name: string; matchedAs: string | null; fuzzyNote: string | null; classification: string; distanceText: string; notDrawn: boolean }): SearchRowVm {
  const notDrawnText = r.notDrawn ? NOT_DRAWN_TEXT : null;
  const parts = [r.categoryLabel, r.name, r.matchedAs ? `matched as ${r.matchedAs}` : '', r.fuzzyNote ?? '', r.distanceText, notDrawnText ?? ''].filter(Boolean);
  return {
    key: r.id, id: r.id, categoryLabel: r.categoryLabel, name: r.name, matchedAs: r.matchedAs, fuzzyNote: r.fuzzyNote, classification: r.classification,
    distanceText: r.distanceText, notDrawn: r.notDrawn, notDrawnText, ariaLabel: parts.join(', '),
    sig: [r.categoryLabel, r.name, r.matchedAs ?? '', r.fuzzyNote ?? '', r.classification, r.distanceText, r.notDrawn ? 1 : 0].join('\u0001'),
  };
}

export function chipsFor(counts: Readonly<Partial<Record<ObjectCategory, number>>>, active: CategoryGroupId): ChipVm[] {
  const total = Object.values(counts).reduce<number>((s, n) => s + (n ?? 0), 0);
  return CATEGORY_GROUPS.map((g) => ({
    id: g.id, label: g.label, active: g.id === active,
    count: g.id === 'all' ? total : g.categories.reduce((s, c) => s + (counts[c] ?? 0), 0),
  }));
}

/** Datasets with a searchable record count; failed ones keep their reason. */
export function datasetLines(status: AtlasStatus): DatasetLine[] {
  const NOT_SEARCHABLE = new Set(['simbad', 'notes', 'relations']);
  return status.datasets.filter((d) => !NOT_SEARCHABLE.has(d.key)).map((d) => ({ label: d.label, count: d.count, state: d.state, ...(d.error ? { error: d.error } : {}) }));
}

export function progressLine(status: AtlasStatus): string | null {
  if (status.complete) return null;
  const pct = Math.round(status.progress * 100);
  const ready = datasetLines(status).filter((d) => d.state === 'ready').map((d) => d.label);
  if (!status.readyForSearch) return `Indexing ${pct}%: search opens when the first index is built.`;
  return `Indexing ${pct}%: names in ${ready.length > 0 ? ready.join(', ') : 'the first datasets'} are already searchable; the rest join as they load.`;
}

/** Does the text look like a catalogue identifier (HIP 99999999, Gaia DR3 12, NGC 99999)? */
export function looksLikeIdentifier(q: string): boolean {
  return /^\s*(hip|hd|hr|tyc|gj|gl|bd|cd|sao|tic|toi|koi|kic|epic|wasp|hat-p|kepler|ngc|ic|pgc|ugc|m|messier|2mass|gaia(\s*dr[123])?|dr[123])[\s\-:_]*[\d+\-.]/i.test(q) || /^\s*\d{6,}\s*$/.test(q);
}

/** A specific explanation for an identifier-shaped query that matched nothing. */
export function invalidIdentifierDetail(q: string): string | null {
  const hip = /^\s*hip[\s\-:_]*(\d+)\s*$/i.exec(q);
  if (hip) {
    const n = Number(hip[1]);
    if (n > 120404 || n === 0) return `Hipparcos numbers run from 1 to 120404; HIP ${hip[1]} is outside that range.`;
  }
  const gaia = /^\s*gaia(?:\s*dr[123])?[\s\-:_]*(\d+)\s*$/i.exec(q);
  if (gaia && gaia[1]!.length < 10) return `Gaia source identifiers have at least 10 digits; "${gaia[1]}" has ${gaia[1]!.length}.`;
  return null;
}

export interface BuildSearchInput {
  readonly query: string;
  readonly status: AtlasStatus;
  readonly group: CategoryGroupId;
  readonly result?: AtlasSearchResult | undefined;
  readonly records: ReadonlyMap<string, DiscoveryRecord>;
  readonly history?: readonly SuggestItem[];
  readonly featured?: readonly SuggestItem[];
  readonly windowSize?: number;
}

export function buildSearchView(inp: BuildSearchInput): SearchView {
  const q = inp.query.trim();
  const progress = progressLine(inp.status);
  if (q.length === 0) {
    return {
      kind: 'idle', progress,
      recent: (inp.history ?? []).map((i) => rowFromItem(i, inp.records.get(i.id))),
      featured: (inp.featured ?? []).map((i) => rowFromItem(i, inp.records.get(i.id))),
    };
  }
  if (!inp.status.readyForSearch) return { kind: 'indexing', message: progress ?? 'Indexing: search opens when the first index is built.' };
  const res = inp.result;
  if (!res) return { kind: 'indexing', message: 'Searching…' };
  const win = inp.windowSize ?? WINDOW_SIZE;
  const chips = chipsFor(res.categoryCounts, inp.group);
  if (res.hits.length === 0) {
    if (looksLikeIdentifier(q) && inp.group === 'all') return { kind: 'invalid-id', message: INVALID_ID_MESSAGE, detail: invalidIdentifierDetail(q), chips, progress };
    const where = inp.group === 'all' ? '' : ` in ${CATEGORY_GROUPS.find((g) => g.id === inp.group)?.label.toLowerCase() ?? 'this category'}`;
    return {
      kind: 'empty', chips, progress, datasets: datasetLines(inp.status),
      message: res.normalized === null
        ? `Type at least two characters (letters or digits) to search.`
        : `Nothing matches “${q}”${where} in the datasets loaded.`,
    };
  }
  const rows = res.hits.slice(0, win).map((h) => rowFromHit(h, inp.records.get(h.id)));
  const total = res.total;
  const totalText = `${nf(total)}${res.totalIsLowerBound ? '+' : ''}`;
  const windowText = total > rows.length || res.hits.length > win ? `showing ${nf(rows.length)} of ${totalText}; refine the query` : null;
  return { kind: 'results', rows, chips, total, windowText, progress };
}

// ---- keyboard model ----------------------------------------------------------------------------------------------------------

export interface ComboState { readonly open: boolean; /** -1 = none */ readonly active: number; readonly count: number; readonly query: string }
export interface KeyInfo { readonly key: string; readonly shiftKey?: boolean; readonly altKey?: boolean; readonly ctrlKey?: boolean; readonly metaKey?: boolean }
export type KeyAction =
  | { readonly type: 'none' }
  | { readonly type: 'open'; readonly active: number }
  | { readonly type: 'move'; readonly index: number }
  | { readonly type: 'choose'; readonly index: number; readonly fly: boolean }
  | { readonly type: 'close'; readonly clear: boolean }
  | { readonly type: 'blur' };

/** Next active index with wrap-around; from "none" (-1) ArrowDown goes to the first row and ArrowUp to the last. */
export function moveActive(active: number, count: number, dir: 'next' | 'prev' | 'first' | 'last'): number {
  if (count <= 0) return -1;
  switch (dir) {
    case 'first': return 0;
    case 'last': return count - 1;
    case 'next': return active < 0 ? 0 : (active + 1) % count;
    case 'prev': return active < 0 ? count - 1 : (active - 1 + count) % count;
  }
}

export function reduceKey(s: ComboState, k: KeyInfo): KeyAction {
  if (k.ctrlKey || k.metaKey || k.altKey) return { type: 'none' };
  switch (k.key) {
    case 'ArrowDown':
      if (s.count === 0) return s.open ? { type: 'none' } : { type: 'open', active: -1 };
      if (!s.open) return { type: 'open', active: 0 };
      return { type: 'move', index: moveActive(s.active, s.count, 'next') };
    case 'ArrowUp':
      if (s.count === 0) return { type: 'none' };
      if (!s.open) return { type: 'open', active: s.count - 1 };
      return { type: 'move', index: moveActive(s.active, s.count, 'prev') };
    case 'Home': return s.open && s.active >= 0 && s.count > 0 ? { type: 'move', index: moveActive(s.active, s.count, 'first') } : { type: 'none' };
    case 'End': return s.open && s.active >= 0 && s.count > 0 ? { type: 'move', index: moveActive(s.active, s.count, 'last') } : { type: 'none' };
    case 'Enter':
      if (!s.open || s.count === 0) return { type: 'none' };
      return { type: 'choose', index: s.active >= 0 ? s.active : 0, fly: !k.shiftKey };
    case 'Escape':
      if (s.open || s.query.length > 0) return { type: 'close', clear: true };
      return { type: 'blur' };
    default: return { type: 'none' };
  }
}
