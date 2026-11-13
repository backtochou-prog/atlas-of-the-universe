/**
 * Filter tab: category, distance band, dataset, spectral class and numeric range filters, with a live count and list. Only measurements that the facets say
 * have data are offered, each with "n of N records have this value"; records without a value are excluded and the excluded count is stated.
 * The state is serialisable to the URL hash (see filterViewModel.ts), so a filtered view can be shared.
 */
import type { DiscoveryAtlas } from '../../discovery/atlas';
import type { Facets } from '../../discovery/filters';
import type { DiscoveryRecord, MeasurementKey } from '../../discovery/types';
import { KeyedList, el, frameBatch, type KeyedItem } from './dom';
import { LatestGuard } from './latest';
import { CATEGORY_LABEL, distanceTextFor, nf } from './labels';
import {
  EMPTY_FILTER, FILTER_WINDOW, HIGHLIGHT_MAX, isEmptyFilter, offeredBands, offeredCategories, offeredDatasets, offeredMeasurements, offeredSpectral, parseBound, parseFilter, serializeFilter,
  summariseFilter, toSpec, toggle, withRange, type FilterState,
} from './filterViewModel';
import { note, objectRowButton, type Tab } from './rows';

export const FILTER_DEBOUNCE_MS = 150;

export class FilterTab implements Tab {
  readonly id = 'filter';
  readonly label = 'Filter';
  readonly root = el('div', 'dr-pane');
  state: FilterState = EMPTY_FILTER;
  private facets: Facets | null = null;
  private readonly form = el('div', 'flt-form');
  private readonly countEl = el('p', 'flt-count');
  private readonly scopeEl = el('p', 'dr-note');
  private readonly exclEl = el('ul', 'flt-excl');
  private readonly provEl = el('p', 'dr-note');
  private readonly hintEl = el('p', 'dr-note');
  private readonly winEl = el('p', 'dr-note');
  private readonly listEl = el('ul', 'obj-list');
  private readonly list = new KeyedList(this.listEl);
  private readonly sky = el('input');
  private readonly skyNote = el('span', 'muted');
  private readonly guard = new LatestGuard();
  private readonly paint = frameBatch(() => this.flush());
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastIds: readonly string[] = [];
  private lastSummary: ReturnType<typeof summariseFilter> | null = null;
  private lastRows: readonly KeyedItem[] = [];
  private lastEmptyState = true;
  private shown = false;
  private highlighting = false;
  private readonly rangeInputs = new Map<MeasurementKey, { min: HTMLInputElement; max: HTMLInputElement; err: HTMLElement }>();
  onStateChange: ((s: FilterState) => void) | null = null;

  constructor(private readonly atlas: DiscoveryAtlas, private readonly choose: (id: string, fly: boolean) => void) {
    const intro = note('Filters combine with AND. A record that has no value for a filtered quantity is not included; the number left out is stated below.');
    const clear = el('button', 'dr-btn', 'Clear filters');
    clear.type = 'button';
    clear.addEventListener('click', () => this.setState(EMPTY_FILTER));
    this.sky.type = 'checkbox'; this.sky.id = 'flt-sky';
    const skyLab = el('label', 'dr-check');
    skyLab.htmlFor = 'flt-sky';
    skyLab.append(this.sky, el('span', undefined, ' Show in the sky'), this.skyNote);
    this.sky.addEventListener('change', () => this.applyHighlight());
    // The result summary stays at the top of the tab while the options scroll, so the count is always in view while a filter is adjusted.
    const res = el('div', 'flt-result');
    const live = el('div'); live.setAttribute('aria-live', 'polite');
    live.append(this.countEl, this.scopeEl, this.exclEl, this.provEl);
    const actions = el('div', 'dr-actions');
    actions.append(skyLab, clear);
    res.append(live, actions);
    this.root.append(res, intro, this.form, this.hintEl, this.listEl, this.winEl);
    atlas.onStatus((s) => { if (this.shown && !this.facets && s.readyForQueries) void this.loadFacets(); });
  }

  onShow(): void {
    this.shown = true;
    if (!this.facets) void this.loadFacets();
  }
  onHide(): void { this.shown = false; }

  /** Replace the whole state (hash load, clear). */
  setState(s: FilterState, notify = true): void {
    this.state = s;
    if (this.facets) this.syncControls();
    this.run();
    if (notify) this.onStateChange?.(s);
  }

  /** Apply a URL hash such as `#f.cat=star&f.r.teffK=3000..6000`. */
  loadHash(hash: string): void { this.setState(parseFilter(hash), false); }
  hash(): string { return serializeFilter(this.state); }

  // ---- building the form from the facets --------------------------------------------------------------------------------------------

  private async loadFacets(): Promise<void> {
    if (!this.atlas.status.readyForQueries) {
      this.form.replaceChildren(note(`Filters need the full index (indexing ${Math.round(this.atlas.status.progress * 100)}%). They appear when it is built.`));
      return;
    }
    const f = await this.atlas.facets();
    if (!f) { this.form.replaceChildren(note('The filter options could not be read.')); return; }
    this.facets = f;
    this.buildForm(f);
    this.syncControls();
    this.run();
  }

  private group(title: string, hint?: string): { box: HTMLElement; body: HTMLElement } {
    const box = el('fieldset', 'flt-group');
    box.append(el('legend', undefined, title));
    if (hint) box.append(el('p', 'dr-note', hint));
    const body = el('div', 'flt-opts');
    box.append(body);
    return { box, body };
  }

  private check(group: string, value: string, label: string, count: number | null, title?: string): HTMLElement {
    const lab = el('label', 'dr-check');
    const cb = el('input'); cb.type = 'checkbox'; cb.dataset['group'] = group; cb.value = value;
    if (title) lab.title = title;
    lab.append(cb, el('span', undefined, ` ${label}`));
    if (count !== null) lab.append(el('span', 'n', ` ${nf(count)}`));
    return lab;
  }

  private chip(group: string, value: string, label: string, count: number): HTMLButtonElement {
    const b = el('button', 'sb-chip', `${label} ${nf(count)}`);
    b.type = 'button'; b.dataset['group'] = group; b.dataset['value'] = value; b.setAttribute('aria-pressed', 'false');
    return b;
  }

  private buildForm(f: Facets): void {
    this.form.replaceChildren();
    this.rangeInputs.clear();
    const cats = this.group('Category');
    for (const c of offeredCategories(f)) cats.body.append(this.check('cat', c.id, c.label, c.count));
    const bands = this.group('Distance from the Sun', 'Named bands; the bounds are choices of this application, not astronomical boundaries.');
    for (const b of offeredBands(f)) bands.body.append(this.check('band', b.id, `${b.label} (${b.bounds})`, b.count, b.definition));
    if (f.withoutDistanceBand > 0) bands.box.append(note(`${nf(f.withoutDistanceBand)} records have no distance and belong to no band.`));
    const ds = this.group('Dataset');
    for (const d of offeredDatasets(f)) ds.body.append(this.chip('ds', d.id, d.label, d.count));
    const sp = this.group('Spectral class', 'As published; a composite type counts for each class it names.');
    for (const c of offeredSpectral(f)) sp.body.append(this.chip('sp', c.id, c.label, c.count));
    const rng = el('details', 'flt-ranges');
    rng.append(el('summary', undefined, 'Numeric ranges'));
    rng.append(note('Only quantities that some record in this atlas has are offered. Leave a box empty for no limit.'));
    for (const m of offeredMeasurements(f)) {
      const row = el('div', 'flt-range');
      row.dataset['key'] = m.key;
      const id = `flt-r-${m.key}`;
      const lab = el('label', 'flt-r-label', `${m.label}${m.unit ? ` (${m.unit})` : ''}`);
      lab.htmlFor = `${id}-min`;
      const mk = (suffix: 'min' | 'max', ph: string): HTMLInputElement => {
        const i = el('input'); i.type = 'text'; i.inputMode = 'decimal'; i.id = `${id}-${suffix}`; i.placeholder = ph; i.autocomplete = 'off';
        i.setAttribute('aria-label', `${m.label} ${suffix === 'min' ? 'minimum' : 'maximum'}`);
        i.addEventListener('input', () => this.onRangeInput(m.key));
        return i;
      };
      const min = mk('min', `min ${+m.min.toPrecision(3)}`), max = mk('max', `max ${+m.max.toPrecision(3)}`);
      const err = el('div', 'flt-err'); err.setAttribute('role', 'alert');
      const have = el('div', 'dr-note', m.haveText);
      row.append(lab, el('div', 'flt-inputs', ''), have, err);
      row.querySelector('.flt-inputs')!.append(min, el('span', undefined, ' to '), max);
      this.rangeInputs.set(m.key, { min, max, err });
      rng.append(row);
    }
    this.form.append(cats.box, bands.box, ds.box, sp.box, rng);
    // one delegated listener for the checkboxes and chips
    this.form.addEventListener('change', (e) => {
      const cb = e.target as HTMLInputElement;
      if (cb.type !== 'checkbox' || !cb.dataset['group']) return;
      this.toggleGroup(cb.dataset['group']!, cb.value);
    });
    this.form.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-group]');
      if (b) this.toggleGroup(b.dataset['group']!, b.dataset['value']!);
    });
  }

  private toggleGroup(group: string, value: string): void {
    const s = this.state;
    switch (group) {
      case 'cat': this.setState({ ...s, categories: toggle(s.categories, value as never) }); break;
      case 'band': this.setState({ ...s, bands: toggle(s.bands, value as never) }); break;
      case 'ds': this.setState({ ...s, datasets: toggle(s.datasets, value as never) }); break;
      case 'sp': this.setState({ ...s, spectral: toggle(s.spectral, value as never) }); break;
    }
  }

  private onRangeInput(key: MeasurementKey): void {
    const r = this.rangeInputs.get(key)!;
    const lo = parseBound(r.min.value), hi = parseBound(r.max.value);
    if (!lo.ok || !hi.ok) { r.err.textContent = 'Enter a number (for example 3000 or 1e4), or leave the box empty.'; return; }
    if (lo.value !== undefined && hi.value !== undefined && lo.value > hi.value) { r.err.textContent = 'The minimum is above the maximum, so nothing can match.'; }
    else r.err.textContent = '';
    this.state = withRange(this.state, key, { ...(lo.value !== undefined ? { min: lo.value } : {}), ...(hi.value !== undefined ? { max: hi.value } : {}) });
    this.run();
    this.onStateChange?.(this.state);
  }

  /** Copy the state into the controls (after a hash load or clear). */
  private syncControls(): void {
    const s = this.state;
    this.form.querySelectorAll<HTMLInputElement>('input[type=checkbox][data-group]').forEach((cb) => {
      const g = cb.dataset['group'];
      const list = g === 'cat' ? s.categories : g === 'band' ? s.bands : [];
      cb.checked = (list as readonly string[]).includes(cb.value);
    });
    this.form.querySelectorAll<HTMLButtonElement>('button[data-group]').forEach((b) => {
      const list = b.dataset['group'] === 'ds' ? s.datasets : s.spectral;
      b.setAttribute('aria-pressed', String((list as readonly string[]).includes(b.dataset['value']!)));
    });
    for (const [key, r] of this.rangeInputs) {
      const v = s.ranges[key];
      const lo = v?.min !== undefined ? String(v.min) : '', hi = v?.max !== undefined ? String(v.max) : '';
      if (r.min.value !== lo) r.min.value = lo;
      if (r.max.value !== hi) r.max.value = hi;
      r.err.textContent = '';
    }
    if (Object.keys(s.ranges).length > 0) this.form.querySelector<HTMLDetailsElement>('.flt-ranges')!.open = true;
  }

  // ---- running -----------------------------------------------------------------------------------------------------------------

  private run(): void {
    clearTimeout(this.timer);
    const token = this.guard.next();
    this.timer = setTimeout(() => { void this.exec(token); }, FILTER_DEBOUNCE_MS);
  }

  private async exec(token: number): Promise<void> {
    if (!this.facets) return;
    const empty = isEmptyFilter(this.state);
    const out = await this.atlas.filter(toSpec(this.state), { limit: HIGHLIGHT_MAX });
    if (!this.guard.isCurrent(token)) return;
    if (!out) { this.countEl.textContent = 'The filter could not be run.'; return; }
    const shownIds = out.ids.slice(0, FILTER_WINDOW);
    const recs = empty ? [] : await this.atlas.getRecords(shownIds);
    if (!this.guard.isCurrent(token)) return;
    this.lastIds = out.ids;
    this.lastEmptyState = empty;
    this.lastSummary = summariseFilter(out);
    this.lastRows = empty ? [] : shownIds.map((id, i) => this.rowItem(id, recs[i]));
    this.paint.schedule();
    this.applyHighlight();
  }

  private rowItem(id: string, r: DiscoveryRecord | undefined): KeyedItem {
    const name = r?.name ?? id, cat = r ? CATEGORY_LABEL[r.category] : '', dist = distanceTextFor(r);
    return {
      key: id, sig: `${name}|${cat}|${dist}`,
      build: () => { const li = el('li'); li.append(objectRowButton({ id, name, category: cat, right: dist }, this.choose)); return li; },
    };
  }

  private flush(): void {
    const s = this.lastSummary;
    if (!s) return;
    const total = this.facets?.total ?? 0;
    this.countEl.textContent = this.lastEmptyState ? `All ${nf(total)} records (no filter chosen)` : s.countText;
    this.scopeEl.textContent = this.lastEmptyState ? '' : s.scopeText;
    this.exclEl.replaceChildren(...s.excluded.map((t) => { const li = el('li', undefined, t); return li; }));
    this.provEl.textContent = s.provisional ?? ''; this.provEl.hidden = s.provisional === null;
    this.hintEl.textContent = this.lastEmptyState ? 'Choose a category, band, dataset, spectral class or range to see matching objects.' : '';
    this.hintEl.hidden = !this.lastEmptyState;
    this.list.update(this.lastRows);
    this.winEl.textContent = s.windowText ?? ''; this.winEl.hidden = s.windowText === null;
    this.skyNote.textContent = this.sky.checked ? ` (${s.highlightCount} marked; at most ${HIGHLIGHT_MAX})` : ` (up to ${HIGHLIGHT_MAX} results)`;
  }

  private applyHighlight(): void {
    if (this.sky.checked && !this.lastEmptyState) { this.highlighting = true; void this.atlas.highlight(this.lastIds.slice(0, HIGHLIGHT_MAX)); }
    else if (this.highlighting) { this.highlighting = false; void this.atlas.highlight([]); }
    this.paint.schedule();
  }
}
