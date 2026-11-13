/**
 * The one search box. ARIA combobox + listbox (focus stays in the input, aria-activedescendant names the active row), category chips that filter the query,
 * keyed rows (a keystroke does not rebuild the list), a 60 ms debounce and a request counter so a stale answer never replaces a newer one.
 * Pure logic lives in searchViewModel.ts; this file only touches the DOM and the atlas.
 */
import type { DiscoveryAtlas } from '../../discovery/atlas';
import type { AtlasSearchResult } from '../../discovery/engineApi';
import type { DiscoveryRecord } from '../../discovery/types';
import { KeyedList, el, frameBatch, announce, type KeyedItem } from './dom';
import { LatestGuard } from './latest';
import { CATEGORY_GROUPS, groupById, nf, type CategoryGroupId } from './labels';
import {
  WINDOW_SIZE, buildSearchView, progressLine, reduceKey, type ChipVm, type SearchRowVm, type SearchView,
} from './searchViewModel';

export const DEBOUNCE_MS = 60;

/** A pre-index hit (the Gaia sample and curated objects that can be searched before the engine has built its index). */
export interface FallbackHit { readonly label: string; readonly matched: string; readonly run: () => void; readonly deep?: boolean }

export interface SearchBoxDeps {
  readonly atlas: DiscoveryAtlas;
  choose(id: string, o: { fly: boolean; context: string }): void;
  fallback?(query: string): readonly FallbackHit[];
}

export class SearchBox {
  readonly input: HTMLInputElement;
  private readonly pop: HTMLElement;
  private readonly chipsEl: HTMLElement;
  private readonly msgEl: HTMLElement;
  private readonly progressEl: HTMLElement;
  private readonly dsEl: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly footEl: HTMLElement;
  private readonly headEl: HTMLElement;
  private readonly clearBtn: HTMLButtonElement;
  private readonly rows: KeyedList;
  private readonly guard = new LatestGuard();
  private readonly render = frameBatch(() => this.paint());
  private timer: ReturnType<typeof setTimeout> | undefined;

  private group: CategoryGroupId = 'all';
  private view: SearchView = { kind: 'idle', recent: [], featured: [], progress: null };
  private fallbackHits: readonly FallbackHit[] = [];
  private shownIds: string[] = [];
  private active = -1;
  private open = false;
  private phaseKey = '';
  /** The text each chip last showed, so unchanged chips are not touched. */
  private readonly chipText = new Map<string, string>();
  private readonly chipEls = new Map<CategoryGroupId, HTMLButtonElement>();
  private lastProgress: string | null = null;

  constructor(private readonly deps: SearchBoxDeps, input: HTMLInputElement) {
    // The page's previous search handler (Gaia only) is bound to the original input: a clone keeps the markup and drops the old listeners.
    const fresh = input.cloneNode(true) as HTMLInputElement;
    input.replaceWith(fresh);
    this.input = fresh;
    const host = fresh.closest<HTMLElement>('#find')!;
    this.pop = host.querySelector<HTMLElement>('#sb-pop')!;
    this.chipsEl = this.pop.querySelector<HTMLElement>('.sb-chips')!;
    this.msgEl = this.pop.querySelector<HTMLElement>('.sb-msg')!;
    this.progressEl = this.pop.querySelector<HTMLElement>('.sb-progress')!;
    this.dsEl = this.pop.querySelector<HTMLElement>('.sb-ds')!;
    this.listEl = this.pop.querySelector<HTMLElement>('#results')!;
    this.footEl = this.pop.querySelector<HTMLElement>('.sb-foot')!;
    this.headEl = this.pop.querySelector<HTMLElement>('.sb-heading')!;
    this.clearBtn = host.querySelector<HTMLButtonElement>('#sb-clear')!;
    this.rows = new KeyedList(this.listEl);
    this.buildChips();
    this.bind(host);
    deps.atlas.onStatus((s) => this.onStatus(s));
  }

  // ---- wiring ------------------------------------------------------------------------------------------------------------------

  private bind(host: HTMLElement): void {
    this.input.addEventListener('input', () => { this.syncClear(); this.queue(); });
    this.input.addEventListener('focus', () => { this.setOpen(true); this.queue(0); });
    this.input.addEventListener('click', () => { if (!this.open) { this.setOpen(true); this.queue(0); } });
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.clearBtn.addEventListener('click', () => { this.clear(); this.input.focus(); });
    // Mouse use must not take focus from the input (it would close the list before the click lands).
    this.pop.addEventListener('mousedown', (e) => { if (!(e.target as HTMLElement).closest('button')) e.preventDefault(); });
    this.listEl.addEventListener('click', (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-i]');
      if (li) this.chooseIndex(Number(li.dataset['i']), !(e as MouseEvent).shiftKey);
    });
    this.listEl.addEventListener('mousemove', (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-i]');
      if (li && this.active !== Number(li.dataset['i'])) this.setActive(Number(li.dataset['i']), false);
    });
    host.addEventListener('focusout', (e) => {
      const to = (e as FocusEvent).relatedTarget as Node | null;
      if (to && host.contains(to)) return;
      this.setOpen(false);
    });
    this.chipsEl.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-group]');
      if (b) { this.setGroup(b.dataset['group'] as CategoryGroupId); this.input.focus(); }
    });
    this.chipsEl.addEventListener('keydown', (e) => this.onChipKey(e));
  }

  private buildChips(): void {
    for (const g of CATEGORY_GROUPS) {
      const b = el('button', 'sb-chip', g.label);
      b.type = 'button'; b.dataset['group'] = g.id; b.tabIndex = g.id === 'all' ? 0 : -1;
      b.setAttribute('aria-pressed', String(g.id === 'all'));
      this.chipsEl.append(b);
      this.chipEls.set(g.id, b);
    }
  }

  // ---- state changes -----------------------------------------------------------------------------------------------------------

  focus(): void { this.input.focus(); this.input.select(); }
  get isOpen(): boolean { return this.open; }
  get query(): string { return this.input.value; }

  /** Put a query in the box and run it (used by "search for this" links). */
  setQuery(q: string): void { this.input.value = q; this.syncClear(); this.setOpen(true); this.queue(0); }

  clear(): void {
    this.input.value = ''; this.group = 'all'; this.syncChipPressed();
    this.syncClear(); this.guard.cancel(); this.active = -1;
    this.queue(0);
  }

  close(): void { this.setOpen(false); }

  private syncClear(): void { this.clearBtn.hidden = this.input.value.length === 0; }

  private setOpen(v: boolean): void {
    if (this.open === v) return;
    this.open = v;
    this.pop.hidden = !v;
    this.input.setAttribute('aria-expanded', String(v));
    if (!v) { this.input.removeAttribute('aria-activedescendant'); this.active = -1; }
    else this.render.schedule();
    document.body.classList.toggle('search-open', v);
  }

  private setGroup(g: CategoryGroupId): void {
    if (this.group === g) return;
    this.group = g; this.syncChipPressed(); this.active = -1;
    this.queue(0);
  }

  private syncChipPressed(): void {
    for (const [id, b] of this.chipEls) { const on = id === this.group; b.setAttribute('aria-pressed', String(on)); b.tabIndex = on ? 0 : -1; }
  }

  private queue(delay = DEBOUNCE_MS): void {
    clearTimeout(this.timer);
    const token = this.guard.next();
    if (delay === 0) void this.run(token); else this.timer = setTimeout(() => { void this.run(token); }, delay);
  }

  private onStatus(s: { readonly readyForSearch: boolean; readonly readyForQueries: boolean; readonly complete: boolean }): void {
    const key = `${s.readyForSearch}|${s.readyForQueries}|${s.complete}`;
    const changed = this.phaseKey !== '' && key !== this.phaseKey;
    this.phaseKey = key;
    if (changed && this.input.value.trim().length > 0 && this.open) this.queue(0);
    if (this.open) this.render.schedule();   // progress text only changes when the line changes (see paint)
  }

  // ---- the query ---------------------------------------------------------------------------------------------------------------

  private async run(token: number): Promise<void> {
    const atlas = this.deps.atlas;
    const q = this.input.value;
    const records = new Map<string, DiscoveryRecord>();
    let result: AtlasSearchResult | undefined;
    let history: Awaited<ReturnType<DiscoveryAtlas['suggest']>>['history'] = [], featured: typeof history = [];
    this.fallbackHits = [];
    if (q.trim().length === 0) {
      const s = await atlas.suggest('');
      history = s.history; featured = s.featured;
      const recs = await atlas.getRecords([...history, ...featured].map((i) => i.id));
      recs.forEach((r) => { if (r) records.set(r.id, r); });
    } else if (!atlas.status.readyForSearch) {
      this.fallbackHits = this.deps.fallback?.(q) ?? [];
    } else {
      const cats = groupById(this.group).categories;
      result = await atlas.search(q, { limit: WINDOW_SIZE, ...(cats.length ? { categories: cats } : {}) });
      const recs = await atlas.getRecords(result.hits.map((h) => h.id));
      recs.forEach((r) => { if (r) records.set(r.id, r); });
    }
    if (!this.guard.isCurrent(token)) return;          // a newer request was started: this answer is stale
    this.view = buildSearchView({ query: q, status: atlas.status, group: this.group, result, records, history, featured });
    this.active = -1;
    this.render.schedule();
    if (this.view.kind === 'results') announce(`${this.view.total} results`);
  }

  // ---- keyboard ----------------------------------------------------------------------------------------------------------------

  private onKey(e: KeyboardEvent): void {
    const count = this.shownIds.length;
    const a = reduceKey({ open: this.open, active: this.active, count: this.fallbackHits.length > 0 ? this.fallbackHits.length : count, query: this.input.value }, e);
    switch (a.type) {
      case 'none': return;
      case 'open': this.setOpen(true); this.setActive(a.active, true); break;
      case 'move': this.setActive(a.index, true); break;
      case 'choose': this.chooseIndex(a.index, a.fly); break;
      case 'close': this.clear(); this.setOpen(false); break;
      case 'blur': this.input.blur(); return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  private onChipKey(e: KeyboardEvent): void {
    const chips = [...this.chipEls.values()];
    const i = chips.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const n = (i + (e.key === 'ArrowRight' ? 1 : -1) + chips.length) % chips.length;
      chips.forEach((c, k) => { c.tabIndex = k === n ? 0 : -1; });
      chips[n]!.focus();
      e.preventDefault(); e.stopPropagation();
    } else if (e.key === 'Escape') { this.input.focus(); e.preventDefault(); e.stopPropagation(); }
  }

  private setActive(i: number, scroll: boolean): void {
    this.active = i;
    this.syncActive(scroll);
  }

  private syncActive(scroll: boolean): void {
    const items = this.listEl.children;
    for (let k = 0; k < items.length; k++) {
      const li = items[k] as HTMLElement;
      const on = k === this.active;
      if ((li.getAttribute('aria-selected') === 'true') !== on) li.setAttribute('aria-selected', String(on));
    }
    const cur = this.active >= 0 ? (items[this.active] as HTMLElement | undefined) : undefined;
    if (cur) { this.input.setAttribute('aria-activedescendant', cur.id); if (scroll) cur.scrollIntoView({ block: 'nearest' }); }
    else this.input.removeAttribute('aria-activedescendant');
  }

  private chooseIndex(i: number, fly: boolean): void {
    if (this.fallbackHits.length > 0) {
      const h = this.fallbackHits[i];
      if (!h) return;
      this.finishChoice(h.label);
      h.run();
      return;
    }
    const id = this.shownIds[i];
    if (!id) return;
    const row = this.allRows().find((r) => r.id === id);
    const q = this.input.value.trim();
    this.finishChoice(row?.name ?? q);
    this.deps.choose(id, { fly, context: q ? `search: ${q.slice(0, 60)}` : 'search: suggestion' });
  }

  private finishChoice(label: string): void {
    this.input.value = label; this.syncClear();
    this.guard.cancel();
    this.setOpen(false);
    this.input.blur();
  }

  // ---- painting (at most once per frame) ---------------------------------------------------------------------------------------

  private allRows(): readonly SearchRowVm[] {
    const v = this.view;
    if (v.kind === 'results') return v.rows;
    if (v.kind === 'idle') return [...v.recent, ...v.featured];
    return [];
  }

  private rowItem(r: SearchRowVm, index: number): KeyedItem {
    return {
      key: r.key, sig: `${r.sig}\u0002${index}`,
      build: () => {
        const li = el('li', `sb-row${r.notDrawn ? ' undrawn' : ''}`);
        li.setAttribute('role', 'option'); li.setAttribute('aria-label', r.ariaLabel);
        li.setAttribute('aria-selected', 'false');
        li.id = `sb-opt-${index}`; li.dataset['id'] = r.id; li.dataset['i'] = String(index);
        if (r.id.startsWith('deep:')) li.dataset['deep'] = '1';          // the deep-space QA and styles look for this marker
        const sub: string[] = [];
        if (r.fuzzyNote) sub.push(r.fuzzyNote);
        if (r.matchedAs) sub.push(`matched as ${r.matchedAs}`);
        sub.push(r.classification);
        li.append(el('span', 'r-cat', r.categoryLabel), el('span', 'r-name', r.name), el('span', 'r-dist', r.distanceText));
        const s = el('span', 'r-sub', sub.join(' · '));
        if (r.notDrawnText) s.append(el('span', 'r-flag', r.notDrawnText));
        li.append(s);
        return li;
      },
    };
  }

  private paint(): void {
    if (!this.open) return;
    const v = this.view;
    const atlas = this.deps.atlas;
    // fallback rows: before the index exists
    let progress: string | null = progressLine(atlas.status);
    if (v.kind === 'idle' || v.kind === 'results' || v.kind === 'empty' || v.kind === 'invalid-id') progress = v.progress ?? progress;
    if (progress !== this.lastProgress) { this.lastProgress = progress; this.progressEl.textContent = progress ?? ''; this.progressEl.hidden = progress === null; }

    let chips: readonly ChipVm[] = [];
    let message = '';
    let detail = '';
    let showDs = false;
    let foot = '';
    const items: KeyedItem[] = [];
    let ids: string[] = [];
    let heading = '';

    if (this.fallbackHits.length > 0) {
      chips = [];
      this.fallbackHits.forEach((h, i) => {
        items.push({
          key: `fb:${i}:${h.label}`, sig: `${h.label}|${h.matched}`,
          build: () => {
            const li = el('li', 'sb-row'); li.setAttribute('role', 'option'); li.setAttribute('aria-selected', 'false'); li.id = `sb-opt-${i}`; li.dataset['i'] = String(i);
            if (h.deep) li.dataset['deep'] = '1';
            li.append(el('span', 'r-cat', ''), el('span', 'r-name', h.label), el('span', 'r-dist', ''), el('span', 'r-sub', h.matched));
            return li;
          },
        });
      });
      ids = this.fallbackHits.map((h) => h.label);
      message = '';
    } else if (v.kind === 'idle') {
      heading = 'Recent and featured';
      let i = 0;
      for (const r of [...v.recent, ...v.featured]) items.push(this.rowItem(r, i++));
      ids = [...v.recent, ...v.featured].map((r) => r.id);
      if (v.recent.length === 0 && v.featured.length === 0) message = 'Type a name or an identifier: HIP 32349, Sirius, M31, Europa.';
      else heading = `${v.recent.length ? `Recent (${v.recent.length}) · ` : ''}Featured: objects with a source-backed note`;
    } else if (v.kind === 'indexing') {
      message = v.message;
    } else if (v.kind === 'results') {
      chips = v.chips;
      let i = 0;
      for (const r of v.rows) items.push(this.rowItem(r, i++));
      ids = v.rows.map((r) => r.id);
      foot = v.windowText ?? '';
    } else if (v.kind === 'empty') {
      chips = v.chips; message = v.message; showDs = true;
    } else if (v.kind === 'invalid-id') {
      chips = v.chips; message = v.message; detail = v.detail ?? '';
    }

    this.shownIds = this.fallbackHits.length > 0 ? [] : ids;
    this.setText(this.msgEl, [message, detail].filter(Boolean).join(' '), message !== '');
    this.paintChips(chips);
    this.paintDatasets(showDs ? v : null);
    this.rows.update(items);
    this.listEl.hidden = items.length === 0;
    this.footEl.textContent = foot; this.footEl.hidden = foot === '';
    this.setText(this.headEl, heading, heading !== '');
    // keep the active row valid
    if (this.active >= items.length) this.active = -1;
    this.syncActive(false);
    this.input.setAttribute('aria-controls', 'results');
  }

  private setText(e: HTMLElement, text: string, visible: boolean): void {
    if (e.textContent !== text) e.textContent = text;
    e.hidden = !visible;
  }

  private paintChips(chips: readonly ChipVm[]): void {
    this.chipsEl.hidden = chips.length === 0;
    if (chips.length === 0) return;
    for (const c of chips) {
      const b = this.chipEls.get(c.id)!;
      const text = c.id === 'all' || c.count > 0 || c.active ? `${c.label} ${nf(c.count)}` : c.label;
      if (this.chipText.get(c.id) !== text) { this.chipText.set(c.id, text); b.textContent = text; }
      b.classList.toggle('zero', c.count === 0 && !c.active);
      b.setAttribute('aria-label', `${c.label}, ${c.count} ${c.count === 1 ? 'result' : 'results'}`);
    }
  }

  private dsKey = '';
  private paintDatasets(v: SearchView | null): void {
    this.dsEl.hidden = v === null || v.kind !== 'empty';
    if (v === null || v.kind !== 'empty') { this.dsKey = ''; return; }
    const key = v.datasets.map((d) => `${d.label}:${d.count}:${d.state}`).join('|');
    if (key === this.dsKey) return;
    this.dsKey = key;
    this.dsEl.replaceChildren();
    this.dsEl.append(el('div', 'sb-ds-h', 'Searched datasets'));
    const ul = el('ul');
    for (const d of v.datasets) {
      const li = el('li');
      li.append(el('span', undefined, d.label), el('span', 'n', d.state === 'ready' ? nf(d.count ?? 0) : d.state === 'failed' ? `failed${d.error ? `: ${d.error}` : ''}` : 'loading…'));
      ul.append(li);
    }
    this.dsEl.append(ul);
  }
}
