/**
 * Saved tab view model (pure): bookmarks, collections and history from a SavedState, with unresolved ids listed as unresolved (never silently dropped).
 */
import type { Bookmark, Collection, HistoryEntry, PersistenceStatus, SavedState } from '../../discovery/saved';
import type { DiscoveryRecord } from '../../discovery/types';
import { CATEGORY_LABEL } from './labels';

export const STORED_IN_BROWSER_NOTE = 'Stored in this browser only. Nothing is sent to a server. Export a file to keep a copy or move it to another browser.';
export const MEMORY_ONLY_WARNING = 'Persistence: memory only. This browser blocks local storage, so your saved objects will be lost when the page closes. Use Export to keep them.';
export const UNRESOLVED_TEXT = 'unresolved: this atlas does not hold this id (the dataset may have changed). Kept, not deleted.';
export const UNRESOLVED_LOADING_TEXT = 'not resolved yet: the datasets are still loading. Kept, not deleted.';

export type Resolver = (id: string) => DiscoveryRecord | undefined;

export interface SavedRowVm {
  readonly key: string; readonly id: string; readonly name: string; readonly categoryLabel: string | null;
  readonly status: 'resolved' | 'unresolved'; readonly statusText: string | null; readonly savedAt: string | null; readonly collections: readonly string[];
}
export interface CollectionVm { readonly id: string; readonly name: string; readonly count: number; readonly unresolvedCount: number; readonly items: readonly SavedRowVm[] }
export interface HistoryRowVm { readonly key: string; readonly id: string; readonly name: string; readonly categoryLabel: string | null; readonly status: 'resolved' | 'unresolved'; readonly at: string; readonly context: string | null }
export interface SavedVm {
  readonly bookmarks: readonly SavedRowVm[];
  readonly collections: readonly CollectionVm[];
  readonly history: readonly HistoryRowVm[];
  readonly persistence: { readonly mode: 'persistent' | 'memory-only'; readonly warning: string | null };
  readonly note: string;
  readonly unresolvedTotal: number;
}

function rowFor(id: string, resolve: Resolver, unresolvedText: string, extra: { savedAt?: string; collections?: readonly string[] } = {}): SavedRowVm {
  const rec = resolve(id);
  return {
    key: id, id, name: rec?.name ?? id, categoryLabel: rec ? CATEGORY_LABEL[rec.category] : null, status: rec ? 'resolved' : 'unresolved', statusText: rec ? null : unresolvedText,
    savedAt: extra.savedAt ?? null, collections: extra.collections ?? [],
  };
}

export function buildSavedVm(state: SavedState, persistence: PersistenceStatus, resolve: Resolver, opts: { readonly datasetsLoading?: boolean } = {}): SavedVm {
  const un = opts.datasetsLoading ? UNRESOLVED_LOADING_TEXT : UNRESOLVED_TEXT;
  const inCollections = new Map<string, string[]>();
  for (const c of state.collections) for (const id of c.items) { const l = inCollections.get(id) ?? []; l.push(c.name); inCollections.set(id, l); }
  const bookmarks = [...state.bookmarks].reverse().map((b: Bookmark) => rowFor(b.id, resolve, un, { savedAt: b.savedAt, collections: inCollections.get(b.id) ?? [] }));
  const collections = state.collections.map((c: Collection): CollectionVm => {
    const items = c.items.map((id) => rowFor(id, resolve, un));
    return { id: c.id, name: c.name, count: items.length, unresolvedCount: items.filter((i) => i.status === 'unresolved').length, items };
  });
  const history = [...state.history].reverse().map((h: HistoryEntry, i): HistoryRowVm => {
    const rec = resolve(h.id);
    return { key: `${h.id}@${h.at}#${i}`, id: h.id, name: rec?.name ?? h.id, categoryLabel: rec ? CATEGORY_LABEL[rec.category] : null, status: rec ? 'resolved' : 'unresolved', at: h.at, context: h.context ?? null };
  });
  const ids = new Set<string>([...state.bookmarks.map((b) => b.id), ...state.collections.flatMap((c) => c.items), ...state.history.map((h) => h.id)]);
  let unresolvedTotal = 0;
  for (const id of ids) if (!resolve(id)) unresolvedTotal++;
  return {
    bookmarks, collections, history, unresolvedTotal, note: STORED_IN_BROWSER_NOTE,
    persistence: { mode: persistence.mode, warning: persistence.mode === 'memory-only' ? `${MEMORY_ONLY_WARNING}${persistence.reason ? ` (${persistence.reason})` : ''}` : null },
  };
}

/** The small "add to collection" menu of an object: every collection with whether the object is in it. */
export function collectionMenu(state: SavedState, id: string): { readonly id: string; readonly name: string; readonly has: boolean }[] {
  return state.collections.map((c) => ({ id: c.id, name: c.name, has: c.items.includes(id) }));
}

/** "2026-11-13T10:00:00Z" -> "13 Nov 2026" in UTC, so the text does not depend on the viewer's locale or time zone. */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]!;
  return `${d.getUTCDate()} ${m} ${d.getUTCFullYear()}`;
}
