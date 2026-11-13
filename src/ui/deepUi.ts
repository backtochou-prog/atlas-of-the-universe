import { formatDistance } from '../core/spatial/scale';
import { distanceMetres } from '../core/deepspace/geometry';
import { equatorialToUnit } from '../core/astro/coordinates';
import { METRES_PER_MPC, METRES_PER_PARSEC } from '../core/units';
import { inspectDeepObject, inspectPointRow, representationBlock } from '../data/catalogue/inspect';
import type { DeepSpaceData } from '../data/deepspace/deepSpaceData';
import type { DeepSpaceKind, RepresentationKind } from '../data/deepspace/types';
import { FOV_DEG, cameraPosition, DEFAULT_ORBIT } from '../render/orbitCamera';
import type { Viewer } from '../render/viewer';
import type { Inspector } from './inspector';
import type { PointRowInfo } from '../render/deep-space/types';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ---- pure helpers (unit-tested) -------------------------------------------------------------------------------------

/** Lower-case and drop spaces and punctuation, so "M 31", "m31" and "M-31" compare equal. */
export function normaliseName(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]+/g, ''); }

export interface DeepSearchHit { readonly id: string; readonly label: string; readonly matched: string; readonly kind: DeepSpaceKind; readonly score: number }

/** Name / designation search over the curated deep-space objects. Exact match ranks first, then prefix, then substring. */
export function searchDeepObjects(data: DeepSpaceData, query: string, limit = 6): DeepSearchHit[] {
  const q = normaliseName(query);
  if (q.length < 2) return [];
  const hits: DeepSearchHit[] = [];
  for (const o of data.all()) {
    let best = Infinity, matched = '';
    for (const cand of [o.name, ...o.designations, o.id]) {
      const c = normaliseName(cand);
      if (!c) continue;
      const score = c === q ? 0 : c.startsWith(q) ? 1 : c.includes(q) ? 2 : Infinity;
      if (score < best) { best = score; matched = cand; }
    }
    if (best < Infinity) hits.push({ id: o.id, label: o.name, matched, kind: o.kind, score: best });
  }
  return hits.sort((a, b) => a.score - b.score || a.label.localeCompare(b.label)).slice(0, limit);
}

export type ViewScale = 'solar-neighbourhood' | 'milky-way' | 'local-group' | 'nearby-universe';
export const SCALE_LABEL: Readonly<Record<ViewScale, string>> = {
  'solar-neighbourhood': 'Solar neighbourhood', 'milky-way': 'Milky Way', 'local-group': 'Local Group', 'nearby-universe': 'Nearby universe',
};
/** Which named scale a camera at `camDistFromSunPc` belongs to. The boundaries are display choices, not astronomical limits. */
export function scaleOfCamera(camDistFromSunPc: number): ViewScale {
  if (camDistFromSunPc < 1.5e3) return 'solar-neighbourhood';
  if (camDistFromSunPc < 3e5) return 'milky-way';
  if (camDistFromSunPc < 1.5e7) return 'local-group';
  return 'nearby-universe';
}

/** Beyond this distance from the Sun the 2MRS caveat is shown while the structure layer is visible. */
export const STRUCTURE_NOTE_FROM_PC = 3e6;
export const STRUCTURE_NOTE = 'Galaxy distribution (2MASS Redshift Survey): distances are Hubble-flow estimates from redshift, so peculiar velocities smear structure along the line of sight; the survey is flux-limited (fewer galaxies seen with distance) and incomplete behind the Milky Way plane (the empty band). Filaments and voids are not drawn.';

export interface ClosestViewInput {
  readonly name: string;
  readonly representationKind: RepresentationKind;
  readonly imageId: string | undefined;
  /** On-screen width of the image, CSS pixels (angular width x pixels per radian). */
  readonly displayedWidthPx: number;
  /** Width of the highest-resolution level actually available, in pixels. */
  readonly nativeWidthPx: number;
}
/**
 * The honest statement for the closest useful view of an object that is only an image. Derived from the representation and the
 * image resolution, never per object: returns undefined while the image is still being shown at or below its native resolution
 * with room to spare, or for objects that are not image-only.
 */
export function closestViewNote(i: ClosestViewInput): string | undefined {
  if (i.representationKind !== 'observed-image' && i.representationKind !== 'deprojected-image') return undefined;
  if (!(i.nativeWidthPx > 0) || i.displayedWidthPx < 0.8 * i.nativeWidthPx) return undefined;
  return `Closest view: Atlas has no three-dimensional stellar data for ${i.name}; this is the highest-resolution image${i.imageId ? ` (${i.imageId})` : ''}. Zooming in further only enlarges its pixels.`;
}

// ---- the panel --------------------------------------------------------------------------------------------------------

const GROUPS: readonly { title: string; kinds: readonly DeepSpaceKind[] }[] = [
  { title: 'Galaxies', kinds: ['galaxy'] }, { title: 'Nebulae', kinds: ['nebula'] }, { title: 'Clusters', kinds: ['star-cluster'] }, { title: 'Groups', kinds: ['galaxy-group', 'galaxy-cluster', 'cosmic-structure'] },
];
const LEGEND_KINDS: readonly RepresentationKind[] = ['observed-members', 'observed-image', 'deprojected-image', 'documented-model', 'illustrative'];
const LAYERS: readonly { key: 'galaxies' | 'nebulae' | 'clusters' | 'structure'; label: string }[] = [
  { key: 'galaxies', label: 'Galaxies' }, { key: 'nebulae', label: 'Nebulae' }, { key: 'clusters', label: 'Star clusters' }, { key: 'structure', label: 'Groups and structure' },
];

export interface DeepUiHooks {
  /** Called before a deep selection is made so the host can clear the star / Solar System selection. */
  beforeSelect(): void;
  /** Optional (R2a): called after a deep object or catalogue row was selected through this UI, with its universal id ("deep:m31", "point:ungc:12"), so the atlas can record the visit. */
  onSelected?(universalId: string): void;
}

/**
 * The deep-space controls: scale shortcuts, object lists, layer toggles, legend, scale note, image credits, labels, the
 * selection ring and the inspector for deep objects and catalogue rows.
 */
export class DeepUi {
  private selectedId: string | null = null;
  /** The selected catalogue row, copied by value (+ its manifest) so the inspector survives the point store releasing the catalogue. */
  private pointSnapshot: PointRowInfo | null = null;
  private shownAsset = '';
  private pendingAsset: string | null = null;
  private readonly last = new Map<string, string>();
  private lastSlow = 0;
  private labelCandidates: string[] = [];
  private readonly labels = new Map<string, HTMLButtonElement>();
  private scaleButtons = new Map<ViewScale, HTMLButtonElement>();
  private creditsSig = '';

  constructor(private readonly viewer: Viewer, private readonly data: DeepSpaceData, private readonly inspector: Inspector, private readonly ring: HTMLElement, private readonly hooks: DeepUiHooks) {
    this.buildPanel();
    inspector.onBand = (assetId) => this.setBand(assetId);
    const btn = document.getElementById('credits-btn');
    btn?.addEventListener('click', () => { const pop = document.getElementById('credits-pop'); if (pop) pop.hidden = !pop.hidden; });
  }

  get selection(): string | null { return this.selectedId; }
  /** The snapshot kept for the selected catalogue row (null when a curated object or nothing is selected). */
  get selectedPoint(): PointRowInfo | null { return this.pointSnapshot; }

  // ---- panel ----
  private buildPanel(): void {
    const root = document.getElementById('deep-panel');
    if (!root) return;
    root.replaceChildren();
    const head = el('div', 'dp-head');
    head.append(el('span', 'dp-title', 'DEEP SPACE'));
    const toggle = el('button', 'chip small', 'Hide');
    toggle.setAttribute('aria-expanded', 'true');
    head.append(toggle);
    root.append(head);
    const body = el('div', 'dp-body');
    toggle.addEventListener('click', () => { body.hidden = !body.hidden; toggle.textContent = body.hidden ? 'Show' : 'Hide'; toggle.setAttribute('aria-expanded', String(!body.hidden)); });

    const scales = el('div', 'dp-scales');
    scales.append(el('div', 'dp-sub', 'Scale'));
    const row = el('div', 'dp-row');
    const mk = (s: ViewScale, key: string, run: () => void) => {
      const b = el('button', 'chip', SCALE_LABEL[s]);
      b.dataset['scale'] = s; b.title = `${SCALE_LABEL[s]} (${key})`;
      b.addEventListener('click', () => { this.clearSelection(); run(); });
      this.scaleButtons.set(s, b); row.append(b);
    };
    mk('solar-neighbourhood', 'H', () => this.viewer.flyTo({ ...DEFAULT_ORBIT, yaw: this.viewer.state.yaw, pitch: this.viewer.state.pitch }));
    mk('milky-way', 'M', () => this.flyScale('milky-way'));
    mk('local-group', 'L', () => this.flyScale('local-group'));
    mk('nearby-universe', 'U', () => this.flyScale('nearby-universe'));
    const nowLine = el('div'); nowLine.id = 'dp-scale-now';
    const crumbs = el('div'); crumbs.id = 'dp-crumbs'; crumbs.title = 'Where the camera is in the frame hierarchy (display only)';
    scales.append(row, nowLine, crumbs);
    body.append(scales);

    const lists = el('div', 'dp-lists');
    for (const g of GROUPS) {
      const objs = this.data.all().filter((o) => g.kinds.includes(o.kind));
      if (!objs.length) continue;
      const d = el('details', 'dp-group');
      d.dataset['group'] = g.title;
      d.append(el('summary', undefined, `${g.title} (${objs.length})`));
      for (const o of objs) {
        const b = el('button', 'dp-item');
        b.dataset['object'] = o.id;
        b.append(el('span', 'n', o.name));
        if (o.sky?.distance) b.append(el('span', 'd', formatDistance(distanceMetres(o.sky.distance).metres)));
        b.addEventListener('click', () => this.selectDeep(o.id, { fly: true }));
        d.append(b);
      }
      if (g.title === 'Groups') {
        const b = el('button', 'dp-item');
        b.dataset['object'] = 'structure-2mrs';
        b.append(el('span', 'n', 'Galaxy distribution (2MRS)'), el('span', 'd', 'observed positions'));
        b.title = 'The 2MASS Redshift Survey galaxies as the observed large-scale layer';
        b.addEventListener('click', () => { this.clearSelection(); this.viewer.deep?.setLayerVisibility({ structure: true }); this.syncToggles(); this.viewer.flyToNearbyUniverse(); });
        d.append(b);
      }
      lists.append(d);
    }
    body.append(lists);

    const layers = el('div', 'dp-layers');
    layers.append(el('div', 'dp-sub', 'Layers'));
    for (const l of LAYERS) {
      const lab = el('label', 'dp-toggle');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = true; cb.dataset['layer'] = l.key;
      cb.addEventListener('change', () => this.viewer.deep?.setLayerVisibility({ [l.key]: cb.checked }));
      lab.append(cb, document.createTextNode(` ${l.label}`));
      layers.append(lab);
    }
    body.append(layers);

    const legend = el('details', 'dp-legend');
    legend.append(el('summary', undefined, 'What the drawings are'));
    for (const k of LEGEND_KINDS) {
      const r = representationBlock({ kind: k, summary: '', depth: 'sky-plane-only' });
      const line = el('div', 'dp-leg');
      line.append(el('span', `rep-badge ${r.tone}`, r.badge), el('span', 'txt', r.meaning));
      legend.append(line);
    }
    legend.append(el('div', 'dp-leg-note', 'Every type also carries a text label; colour is never the only cue. False-colour and non-visible-band images are marked in the inspector.'));
    body.append(legend);

    const help = el('details', 'dp-help');
    help.append(el('summary', undefined, 'Keys'));
    help.append(el('div', 'txt', 'M Milky Way · L Local Group · U nearby universe · H home (Solar neighbourhood) · Backspace one level out · O overview · Esc clear selection · R reset orientation · + / − zoom. Click an object to inspect it.'));
    body.append(help);
    root.append(body);
    this.syncToggles();
  }

  private syncToggles(): void {
    const v = this.viewer.deep?.getLayerVisibility();
    if (!v) return;
    for (const cb of document.querySelectorAll<HTMLInputElement>('#deep-panel input[data-layer]')) cb.checked = v[cb.dataset['layer'] as keyof typeof v];
  }

  /** Scale shortcuts used by the panel and the M / L / U keys. */
  flyScale(s: ViewScale): void {
    const v = this.viewer;
    if (!v.deep) return;
    this.clearSelection();
    if (s === 'solar-neighbourhood') v.flyTo({ ...DEFAULT_ORBIT, yaw: v.state.yaw, pitch: v.state.pitch });
    else if (s === 'milky-way') v.flyToDeep('milky-way');
    else if (s === 'local-group') v.flyToLocalGroup();
    else v.flyToNearbyUniverse();
    // The Milky Way flight selects the model; the scale shortcuts are a view, not an inspection.
    if (s === 'milky-way') { v.selectedDeep = null; }
  }

  // ---- selection ----
  /** Select (and optionally fly to) a curated deep-space object. */
  selectDeep(id: string, opts: { fly: boolean }): void {
    if (!this.data.get(id)) return;
    this.hooks.beforeSelect();
    this.selectedId = id; this.pendingAsset = null; this.pointSnapshot = null;
    this.viewer.selectedDeep = id;
    this.showModel();
    this.hooks.onSelected?.(`deep:${id}`);
    if (opts.fly) this.flyToSelection();
  }

  /** Select one row of a point catalogue (id "<fileId>:<row>"). Returns false if the row is not available. */
  selectPoint(id: string, opts: { fly: boolean }): boolean {
    const live = this.viewer.deep?.pointRow(id);
    if (!live) return false;
    this.hooks.beforeSelect();
    this.selectedId = id; this.viewer.selectedDeep = id;
    // A value copy: the layer drops a point catalogue from memory ~20 s after nothing needed it, and pointRow() is then undefined.
    const row: PointRowInfo = { id: live.id, fileId: live.fileId, row: live.row, values: { ...live.values }, manifest: live.manifest, ...(live.placement ? { placement: live.placement } : {}) };
    this.pointSnapshot = row;
    this.inspector.show(inspectPointRow(row), { canFocus: this.pointPosition(id) !== null, focusLabel: 'Fly to this entry' });
    this.shownAsset = '';
    this.hooks.onSelected?.(`point:${id}`);
    if (opts.fly) this.flyToSelection();
    return true;
  }

  /**
   * Backspace / "back out one level". DeepUi owns the selection, so the viewer's decision (parentDeepTarget) is applied HERE: the inspector,
   * ring, renderer highlight (viewer.selectedDeep) and this.selectedId always change together.
   */
  goToParent(): void {
    const v = this.viewer;
    const t = v.parentDeepTarget(this.selectedId);
    if (t.kind === 'object') { this.selectDeep(t.id, { fly: true }); return; }
    if (this.selectedId !== null) { this.clearSelection(); this.inspector.hide(); }   // a scale flight: nothing is selected afterwards, in the inspector, ring and highlight alike
    if (t.kind === 'local-group') v.flyToLocalGroup(); else v.flyToNearbyUniverse();
  }

  clearSelection(): void {
    if (this.selectedId === null) return;
    this.selectedId = null; this.shownAsset = ''; this.pendingAsset = null; this.pointSnapshot = null;
    this.viewer.clearDeepSelection();
    this.ring.style.display = 'none';
  }

  private showModel(keepScroll = false): void {
    const id = this.selectedId;
    if (!id) return;
    const active = this.pendingAsset ?? this.viewer.deep?.activeAsset(id);
    this.shownAsset = active ?? '';
    this.inspector.show(inspectDeepObject(this.data, id, { activeAssetId: active }), { canFocus: true, focusLabel: 'Fly to this object', keepScroll });
  }

  private setBand(assetId: string): void {
    const id = this.selectedId;
    if (!id) return;
    const ok = this.viewer.deep?.setBand(id, assetId) ?? false;
    this.pendingAsset = assetId;
    if (!ok) this.pendingAsset = null;
    this.showModel(true);
  }

  /** Position of a catalogue row computed from its stored columns (Sun-centred ICRS parsecs); null where the placement belongs to the renderer. */
  private pointPosition(id: string): [number, number, number] | null {
    const row = this.pointSnapshot?.id === id ? this.pointSnapshot : this.viewer.deep?.pointRow(id);
    if (!row) return null;
    const ra = row.values['raDeg'], dec = row.values['decDeg'];
    if (typeof ra !== 'number' || typeof dec !== 'number') return null;
    let pc: number | null = null;
    const dm = row.values['distMpc'], plx = row.values['parallaxMas'];
    if (typeof dm === 'number' && dm > 0) pc = (dm * METRES_PER_MPC) / METRES_PER_PARSEC;
    else if (typeof plx === 'number' && plx > 0) pc = 1000 / plx;
    if (pc === null) return null;
    const u = equatorialToUnit(ra, dec);
    return [u[0] * pc, u[1] * pc, u[2] * pc];
  }

  flyToSelection(): void {
    const id = this.selectedId;
    const v = this.viewer;
    if (!id || !v.deep) return;
    try {
      if (id === 'local-group') { v.flyToLocalGroup(); v.selectedDeep = id; return; }
      if (this.data.get(id)) { v.flyToDeep(id); return; }
      const p = this.pointPosition(id);
      if (p) {
        const r = Math.hypot(p[0], p[1], p[2]);
        v.flyTo({ focus: p, distance: Math.max(r < 1e4 ? 5 : 1e4, 0.15 * r), yaw: v.state.yaw, pitch: v.state.pitch });
        v.selectedDeep = id;
      }
    } catch (err) { console.warn('Cannot fly to the selection', err); }
  }

  // ---- search ----
  /** Deep-space search hits for the search box: curated objects by name, plus catalogue rows that are already loaded and on screen. */
  search(query: string): { label: string; matched: string; run: () => void }[] {
    const out: { label: string; matched: string; run: () => void }[] = [];
    for (const h of searchDeepObjects(this.data, query, 5)) out.push({ label: h.label, matched: `${h.matched} · ${h.kind.replace('-', ' ')}`, run: () => this.selectDeep(h.id, { fly: true }) });
    const q = normaliseName(query);
    if (q.length >= 3 && this.viewer.deep) {
      let n = 0;
      for (const [id, info] of this.viewer.deepScreen) {
        if (info.kind !== 'catalogue-point') continue;
        const row = this.viewer.deep.pointRow(id);
        const name = row?.values['name'];
        if (typeof name !== 'string' || !normaliseName(name).includes(q)) continue;
        out.push({ label: name, matched: `${row!.fileId} catalogue row · already loaded`, run: () => { this.selectPoint(id, { fly: true }); } });
        if (++n >= 4) break;
      }
    }
    return out;
  }

  // ---- per frame ----
  private set(id: string, text: string): void {
    if (this.last.get(id) === text) return;
    this.last.set(id, text);
    const e = document.getElementById(id);
    if (e) e.textContent = text;
  }

  update(nowMs: number): void {
    const v = this.viewer;
    const deepOn = v.deepActive;
    document.body.classList.toggle('deep-active', deepOn && !v.solarActive);
    // selection ring
    if (this.selectedId) {
      const s = v.screenOfDeep(this.selectedId);
      if (s) { const r = Math.min(Math.max(s.r + 6, 14), 600); this.ring.style.display = 'block'; this.ring.style.width = this.ring.style.height = `${r * 2}px`; this.ring.style.transform = `translate(${s.x - r}px, ${s.y - r}px)`; }
      else this.ring.style.display = 'none';
    }
    this.syncLabels();
    if (nowMs - this.lastSlow < 250) return;
    this.lastSlow = nowMs;

    const cam = cameraPosition(v.state);
    const camR = Math.hypot(cam[0], cam[1], cam[2]);
    const scale = scaleOfCamera(camR);
    for (const [s, b] of this.scaleButtons) { b.classList.toggle('on', s === scale); if (s === scale) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current'); }
    this.set('dp-scale-now', `Camera ${formatDistance(camR * METRES_PER_PARSEC)} from the Sun · ${SCALE_LABEL[scale]} scale`);

    // crumbs outside the Solar System
    this.set('dp-crumbs', v.solarActive ? '' : v.frame.path.map((p) => p.name).join(' \u203a '));

    // deep stats (HUD)
    const st = v.deep?.stats();
    const stats = st && deepOn
      ? `deep space: ${st.drawCalls} draw calls · ${(st.textureBytes / 1048576).toFixed(1)} MB textures (${st.textures}${st.loading ? `, ${st.loading} loading` : ''}) · ${st.pointsDrawn.toLocaleString('en-US')} points · quality ${Math.round(st.quality * 100)}% (${v.governorReport().reason})${st.overBudget ? ' · OVER TEXTURE BUDGET' : ''}`
      : '';
    this.set('deep-stats', stats);

    this.updateNote(camR);
    this.updateCredits();
    this.pickLabelCandidates();

    // keep the inspector's image block in step with what is actually drawn (e.g. the default band changed)
    if (this.selectedId && this.data.get(this.selectedId) && !this.pendingAsset) {
      const a = v.deep?.activeAsset(this.selectedId) ?? '';
      if (a && a !== this.shownAsset) this.showModel(true);
    }
    if (this.pendingAsset && v.deep?.activeAsset(this.selectedId ?? '') === this.pendingAsset) this.pendingAsset = null;
  }

  private updateNote(camR: number): void {
    const v = this.viewer;
    const lines: string[] = [];
    const id = this.selectedId;
    const o = id ? this.data.get(id) : undefined;
    if (o && v.deep) {
      const assetId = v.deep.activeAsset(o.id);
      const asset = this.data.imageAssetsOf(o.id).find((a) => a.id === assetId) ?? this.data.imageAssetsOf(o.id)[0];
      if (asset && o.sky?.distance) {
        const pos = v.deep.objectPositionPc(o.id);
        const cam = cameraPosition(v.state);
        const d = pos ? Math.hypot(pos[0] - cam[0], pos[1] - cam[1], pos[2] - cam[2]) : 0;
        if (d > 0) {
          const ppr = v.viewport.height / (2 * Math.tan((FOV_DEG * Math.PI) / 360));
          // Physical width of the picture from its field of view as seen from the Sun, then the angle it subtends from the camera.
          const widthSunRad = (asset.geometry.fovArcmin[0] / 60) * (Math.PI / 180);
          const widthPc = widthSunRad * Math.hypot(pos![0], pos![1], pos![2]);
          const widthRad = 2 * Math.atan(widthPc / 2 / d);
          const top = asset.levels.reduce((m, l) => Math.max(m, l.widthPx), 0);
          const note = closestViewNote({ name: o.name, representationKind: o.representation.kind, imageId: asset.source.imageId, displayedWidthPx: Math.tan(Math.min(widthRad, 3) / 2) * 2 * ppr, nativeWidthPx: top });
          if (note) lines.push(note);
        }
      }
    }
    const vis = v.deep?.getLayerVisibility();
    // Only when a structure renderer is registered: the note must never describe a layer that is not there.
    if (vis?.structure && camR > STRUCTURE_NOTE_FROM_PC && v.deep?.registered.some((r) => r.layerKind === 'structure')) lines.push(STRUCTURE_NOTE);
    const text = lines.join('\n');
    if (this.last.get('deep-note') === text) return;
    this.last.set('deep-note', text);
    const box = document.getElementById('deep-note');
    if (!box) return;
    box.replaceChildren();
    for (const l of lines) box.append(el('div', 'line', l));
    box.hidden = lines.length === 0;
  }

  private updateCredits(): void {
    const v = this.viewer;
    const box = document.getElementById('credits');
    if (!box || !v.deep) return;
    const seen = new Map<string, { credit: string; title: string; licence: string }>();
    for (const info of v.deepScreen.values()) {
      if (!info.visible || info.kind === 'catalogue-point' || !info.lod.startsWith('image')) continue;
      const assetId = v.deep.activeAsset(info.id);
      const asset = this.data.imageAssetsOf(info.id).find((x) => x.id === assetId);
      if (asset && !seen.has(asset.id)) seen.set(asset.id, { credit: asset.credit, title: asset.title, licence: asset.licence.name });
    }
    const sig = [...seen.keys()].sort().join('|');
    if (sig === this.creditsSig) return;
    this.creditsSig = sig;
    box.hidden = seen.size === 0;
    const line = document.getElementById('credits-line');
    const pop = document.getElementById('credits-pop');
    if (line) line.textContent = [...new Set([...seen.values()].map((s) => s.credit))].join(' · ');
    if (pop) {
      pop.replaceChildren();
      for (const s of seen.values()) { const d = el('div', 'cr'); d.append(el('b', undefined, s.title), el('span', undefined, ` — ${s.credit} (${s.licence})`)); pop.append(d); }
      const more = el('a', undefined, 'All image credits and licences'); more.href = `${import.meta.env.BASE_URL}credits.html`; more.target = '_blank'; more.rel = 'noopener';
      pop.append(more);
      if (seen.size === 0) pop.hidden = true;
    }
  }

  // ---- labels ----
  private pickLabelCandidates(): void {
    const v = this.viewer;
    const c: { id: string; r: number }[] = [];
    if (!v.solarActive) {
      for (const i of v.deepScreen.values()) {
        // Discovery markers (exoplanet hosts, curated 'other' objects, the selection proxy) are not curated deep-space objects: the DOM label slots are for those only.
        if (i.kind === 'exoplanet-host' || i.kind === 'other-object' || i.kind === 'selection-proxy') continue;
        if (i.visible && i.kind !== 'catalogue-point' && i.kind !== 'cosmic-structure' && i.pixelRadius >= 5) c.push({ id: i.id, r: i.pixelRadius });
      }
    }
    c.sort((a, b) => b.r - a.r);
    this.labelCandidates = c.slice(0, 12).map((x) => x.id);
    if (this.selectedId && !this.labelCandidates.includes(this.selectedId) && this.data.get(this.selectedId)) this.labelCandidates.push(this.selectedId);
  }

  private syncLabels(): void {
    const layer = document.getElementById('labels');
    if (!layer) return;
    const wanted = new Set<string>();
    for (const id of this.labelCandidates) {
      const s = this.viewer.screenOfDeep(id);
      const o = this.data.get(id);
      if (!s || !o) continue;
      wanted.add(id);
      let b = this.labels.get(id);
      if (!b) {
        b = el('button', 'label', o.name.replace(/\s*\(.*\)$/, ''));
        b.dataset['deep'] = id;
        b.addEventListener('click', (e) => { e.stopPropagation(); this.selectDeep(id, { fly: true }); });
        layer.append(b); this.labels.set(id, b);
      }
      b.style.transform = `translate(${s.x + Math.max(s.r, 6) + 6}px, ${s.y - 8}px)`;
      b.style.display = 'block';
      b.classList.toggle('selected', id === this.selectedId);
    }
    for (const [id, b] of this.labels) if (!wanted.has(id)) b.style.display = 'none';
  }
}
