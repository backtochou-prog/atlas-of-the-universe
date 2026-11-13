/**
 * Nearby tab: objects near the selected object or near the camera focus, within a radius (log slider, AU to Mpc, bounded by what the data frames support),
 * optionally one category. Same-system members (an exoplanet host and its planets) are listed apart from neighbours; each row selects and flies.
 */
import type { DiscoveryAtlas } from '../../discovery/atlas';
import type { Facets } from '../../discovery/filters';
import { METRES_PER_PARSEC } from '../../core/units';
import { KeyedList, el, type KeyedItem } from './dom';
import { LatestGuard } from './latest';
import { CATEGORY_GROUPS, groupById, type CategoryGroupId } from './labels';
import {
  DEFAULT_MAX_RADIUS_METRES, NEARBY_K, NEARBY_WINDOW, SLIDER_STEPS, buildNearbyVm, radiusFromSlider, radiusLabel, sliderFromRadius, type NearbyRowVm,
} from './nearbyViewModel';
import { note, objectRowButton, type Tab } from './rows';

export type NearbyAround = 'selected' | 'camera';

export class NearbyTab implements Tab {
  readonly id = 'nearby';
  readonly label = 'Nearby';
  readonly root = el('div', 'dr-pane');
  private around: NearbyAround = 'selected';
  private originId: string | null = null;           // explicit origin from "Find nearby"
  private radiusM = 5 * METRES_PER_PARSEC;
  private maxM = DEFAULT_MAX_RADIUS_METRES;
  private group: CategoryGroupId = 'all';
  private visibleRows = NEARBY_WINDOW;
  private readonly guard = new LatestGuard();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private shown = false;
  private readonly aroundSel = el('input'); private readonly aroundCam = el('input');
  private readonly originName = el('span', 'n');
  private readonly slider = el('input');
  private readonly radiusOut = el('output', 'flt-count');
  private readonly select = el('select');
  private readonly summaryEl = el('p', 'dr-note');
  private readonly msgEl = el('p', 'dr-note');
  private readonly sysHead = el('h3', 'dr-h', 'In the same system');
  private readonly sysEl = el('ul', 'obj-list');
  private readonly neighHead = el('h3', 'dr-h', 'Neighbours');
  private readonly listEl = el('ul', 'obj-list');
  private readonly list = new KeyedList(this.listEl);
  private readonly more = el('button', 'dr-btn', 'Show more');
  private lastRows: readonly NearbyRowVm[] = [];

  constructor(private readonly atlas: DiscoveryAtlas, private readonly choose: (id: string, fly: boolean) => void) {
    const around = el('fieldset', 'flt-group');
    around.append(el('legend', undefined, 'Around'));
    const mk = (input: HTMLInputElement, id: string, value: NearbyAround, label: string, extra?: HTMLElement): HTMLElement => {
      input.type = 'radio'; input.name = 'nb-around'; input.id = id; input.value = value;
      input.addEventListener('change', () => { if (input.checked) { this.around = value; if (value === 'camera') this.originId = null; this.run(); } });
      const l = el('label', 'dr-check'); l.htmlFor = id; l.append(input, el('span', undefined, ` ${label}`));
      if (extra) l.append(extra);
      return l;
    };
    this.aroundSel.checked = true;
    around.append(mk(this.aroundSel, 'nb-sel', 'selected', 'Selected object', this.originName), mk(this.aroundCam, 'nb-cam', 'camera', 'Camera focus'));
    const rad = el('div', 'flt-group');
    const lab = el('label', undefined, 'Radius'); lab.htmlFor = 'nb-radius';
    this.slider.type = 'range'; this.slider.id = 'nb-radius'; this.slider.min = '0'; this.slider.max = String(SLIDER_STEPS); this.slider.step = '1';
    this.slider.addEventListener('input', () => { this.radiusM = radiusFromSlider(Number(this.slider.value), this.maxM); this.syncRadius(); this.run(); });
    this.radiusOut.htmlFor.add('nb-radius');
    rad.append(lab, this.slider, this.radiusOut, note('Logarithmic: from 1 AU up to the largest distance in the loaded datasets.'));
    const catRow = el('div', 'flt-group');
    const catLab = el('label', undefined, 'Category'); catLab.htmlFor = 'nb-cat';
    this.select.id = 'nb-cat';
    for (const g of CATEGORY_GROUPS) { const o = el('option', undefined, g.id === 'all' ? 'All categories' : g.label); o.value = g.id; this.select.append(o); }
    this.select.addEventListener('change', () => { this.group = this.select.value as CategoryGroupId; this.visibleRows = NEARBY_WINDOW; this.run(); });
    catRow.append(catLab, this.select);
    const back = el('button', 'dr-btn', 'Back');
    back.type = 'button'; back.title = 'Return to the previous selection and camera view';
    back.addEventListener('click', () => { void this.atlas.back(); });
    this.more.type = 'button';
    this.more.addEventListener('click', () => { this.visibleRows = Math.min(NEARBY_K, this.visibleRows + NEARBY_WINDOW); this.renderRows(); });
    this.root.append(around, rad, catRow, back, this.summaryEl, this.msgEl, this.sysHead, this.sysEl, this.neighHead, this.listEl, this.more);
    this.sysHead.hidden = this.sysEl.hidden = this.more.hidden = true;
    this.syncRadius();
    atlas.onSelectionChange(() => { if (this.shown && this.around === 'selected' && !this.originId) this.run(); this.syncOrigin(); });
    atlas.onStatus((s) => { if (this.shown && s.readyForQueries && this.lastRows.length === 0) this.run(); });
  }

  /** "Find nearby" from the inspector: around this object. */
  setOrigin(id: string): void {
    this.originId = id; this.around = 'selected'; this.aroundSel.checked = true; this.visibleRows = NEARBY_WINDOW;
    this.syncOrigin();
    if (this.shown) this.run();
  }

  onShow(): void {
    this.shown = true;
    void this.atlas.facets().then((f) => this.applyBounds(f));
    this.syncOrigin();
    this.run();
  }
  onHide(): void { this.shown = false; }

  private applyBounds(f: Facets | null): void {
    const dist = f?.measurements.find((m) => m.key === 'distancePc');
    if (!dist) return;
    this.maxM = Math.max(dist.max * METRES_PER_PARSEC, 100 * METRES_PER_PARSEC);
    this.slider.value = String(sliderFromRadius(this.radiusM, this.maxM));
    this.syncRadius();
  }

  private syncRadius(): void {
    this.slider.value = String(sliderFromRadius(this.radiusM, this.maxM));
    const t = radiusLabel(this.radiusM);
    this.radiusOut.textContent = t;
    this.slider.setAttribute('aria-valuetext', t);
  }

  private currentOriginId(): string | null { return this.originId ?? this.atlas.selection; }

  private syncOrigin(): void {
    const id = this.currentOriginId();
    const name = id ? (this.atlas.peek(id)?.name ?? id) : '';
    this.originName.textContent = id ? `: ${name}` : ': nothing selected';
  }

  // ---- query -------------------------------------------------------------------------------------------------------------------

  private run(): void {
    clearTimeout(this.timer);
    const token = this.guard.next();
    this.timer = setTimeout(() => { void this.exec(token); }, 120);
  }

  private async exec(token: number): Promise<void> {
    const atlas = this.atlas;
    if (!atlas.status.readyForQueries) { this.showMsg(`Nearby search needs the spatial index (indexing ${Math.round(atlas.status.progress * 100)}%).`); return; }
    const origin = this.around === 'camera' ? 'camera' : this.currentOriginId();
    if (origin === null) { this.showMsg('Select an object first, or choose Camera focus.'); return; }
    const cats = groupById(this.group).categories;
    const out = await atlas.nearby({ origin, radiusMetres: this.radiusM, k: NEARBY_K, ...(cats.length ? { categories: cats } : {}) });
    if (!this.guard.isCurrent(token)) return;
    const originName = origin === 'camera' ? 'the camera focus' : (atlas.peek(origin)?.name ?? origin);
    const vm = buildNearbyVm(out, { originName, radiusMetres: this.radiusM });
    if (!vm.ok) { this.showMsg(vm.message ?? ''); return; }
    this.msgEl.hidden = true;
    this.summaryEl.textContent = vm.summary;
    this.sysEl.replaceChildren(...vm.system.map((s) => { const li = el('li'); li.append(objectRowButton({ id: s.id, name: s.name, category: s.categoryLabel, right: s.roleText }, this.choose)); return li; }));
    this.sysHead.hidden = this.sysEl.hidden = vm.system.length === 0;
    this.lastRows = vm.neighbours;
    this.visibleRows = NEARBY_WINDOW;
    this.neighHead.hidden = vm.neighbours.length === 0;
    this.renderRows();
    this.syncOrigin();
  }

  private showMsg(text: string): void {
    this.msgEl.textContent = text; this.msgEl.hidden = false;
    this.summaryEl.textContent = '';
    this.lastRows = []; this.list.clear(); this.sysHead.hidden = this.sysEl.hidden = this.more.hidden = true; this.neighHead.hidden = true;
  }

  private renderRows(): void {
    const rows = this.lastRows.slice(0, this.visibleRows);
    const items: KeyedItem[] = rows.map((r) => ({
      key: r.key, sig: `${r.name}|${r.distanceText}|${r.categoryLabel}`,
      build: () => { const li = el('li'); li.append(objectRowButton({ id: r.id, name: r.name, category: r.categoryLabel, right: r.distanceText }, this.choose)); return li; },
    }));
    this.list.update(items);
    const left = this.lastRows.length - rows.length;
    this.more.hidden = left <= 0;
    this.more.textContent = `Show ${Math.min(NEARBY_WINDOW, left)} more (${left} not shown)`;
  }
}
