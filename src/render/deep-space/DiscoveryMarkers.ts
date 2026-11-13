/**
 * Discovery markers (Prompt 07): three DeepSubRenderers registered by extraRenderers.ts through createDiscoveryMarkerRenderers.
 *
 *  ExoplanetHostMarkers  the NASA Exoplanet Archive hosts as instanced soft halos (SplatSet, one draw call). DEFAULT OFF (setEnabled). Size and opacity by
 *                        camera distance, not by planet count (DiscoveryMarkerMath.ts). Hosts with no archive distance are not drawn (counted: counts().hostsSkyOnly).
 *  OtherObjectMarkers    the curated Sgr A*, Cyg X-1, Crab Pulsar, SN 1987A, Eta Carinae, Vela Pulsar at their catalogue positions: a tiny faint dot + halo,
 *                        and a text label at the scales where it can be read. On whenever the 'discovery' layer is on.
 *  HighlightMarkers      small constant-size rings for search / nearby results (setHighlights) and the selection proxy (setSelection): a clear ring and the name
 *                        for a selected record that is too small or faint to be seen at the current scale.
 *
 * Coordinates: Sun-centred ICRS parsecs, float64 on the CPU; positions are made camera-relative BEFORE narrowing to float32 (floating origin).
 * All three are layerKind 'discovery'. Per frame they allocate nothing (preallocated screen infos are mutated in place; the returned array is reused).
 * Picking: infos carry kind 'exoplanet-host' | 'other-object' | 'selection-proxy'; DISCOVERY_PICK_TIERS says how the viewer should rank them
 * (hosts are the lowest tier so they never steal a click from a galaxy or nebula; the selection proxy is never pickable).
 */
import * as THREE from 'three';
import type { Vec3 } from '../../core/spatial/vec3';
import type { ExoplanetFile, OtherObjectsFile } from '../../discovery/types';
import type { ExtraRendererDeps } from './extraRenderers';
import {
  buildHostTable, buildOtherMarkers, HOST_INFO_MAX_RADIUS_PX, HOST_MAX_INFOS, hostsFade, hostStyle, isHostId, isOtherId, isOtherwiseVisible, kthSmallest, OTHER_ALPHA, OTHER_RADIUS_PX,
  type HostTable, type MarkerStyle, type OtherMarker, type SelectionItem,
} from './DiscoveryMarkerMath';
import { LabelAtlas, RingSet } from './DiscoveryRings';
import { SplatSet } from './SplatSet';
import type { DeepRenderContext, DeepRendererStats, DeepScreenInfo, DeepSubRenderer } from './types';

export { DISCOVERY_PICK_TIERS } from './DiscoveryMarkerMath';
export type { SelectionItem } from './DiscoveryMarkerMath';

type MutInfo = { -readonly [K in keyof DeepScreenInfo]: DeepScreenInfo[K] };
const newInfo = (id: string, kind: DeepScreenInfo['kind'], label: string | undefined, note?: string): MutInfo =>
  ({ id, kind, x: 0, y: 0, pixelRadius: 0, distancePc: 0, visible: false, pickable: true, lod: 'marker', ...(label !== undefined ? { label } : {}), ...(note !== undefined ? { representationNote: note } : {}) });

const HOST_COLOUR = [0.42, 0.84, 0.78] as const;     // muted aqua
const OTHER_COLOUR = [0.98, 0.68, 0.44] as const;    // warm amber
const HIGHLIGHT_COLOUR = [0.78, 0.88, 1.0] as const; // pale blue-white
const SELECT_COLOUR = [1.0, 0.86, 0.46] as const;    // soft gold
const VIEW_MARGIN_PX = 24;

export interface DiscoveryMarkerCounts {
  /** Hosts in the archive file. */
  readonly hostsTotal: number;
  /** Hosts with a distance: the ones that can be drawn. */
  readonly hostsDrawable: number;
  /** Hosts with no distance: sky-only, never drawn. */
  readonly hostsSkyOnly: number;
  /** Host halos written to the GPU in the last frame (0 while the layer is off). */
  readonly hostsDrawnNow: number;
  readonly hostsEnabled: boolean;
  readonly others: number;
  readonly othersSkyOnly: number;
  readonly highlights: number;
  readonly highlightsNoPosition: number;
  readonly highlightsDropped: number;
  readonly selectionShown: boolean;
}

// ======================================================================================================================================
export class ExoplanetHostMarkers implements DeepSubRenderer {
  readonly name = 'exoplanet-hosts';
  readonly layerKind = 'discovery' as const;
  readonly group = new THREE.Group();
  private table: HostTable | null = null;
  private splats: SplatSet | null = null;
  private enabled = false;
  private quality = 1;
  private drawnNow = 0;
  private lastStats: DeepRendererStats = { drawCalls: 0, textureBytes: 0, pointsDrawn: 0, objectsVisible: 0 };
  private readonly out: DeepScreenInfo[] = [];
  private infos: (MutInfo | undefined)[] = [];
  private candIdx = new Int32Array(0);
  private candDist = new Float32Array(0);
  private scratch = new Float32Array(0);
  private readonly style: MarkerStyle = { radiusPx: 0, alpha: 0 };

  /** Load the archive's host table (ExoplanetFile.hosts). Replaces any earlier table. */
  setHosts(hosts: ExoplanetFile['hosts']): void {
    this.splats?.dispose();
    if (this.splats) this.group.remove(this.splats.mesh);
    const t = buildHostTable(hosts);
    this.table = t;
    this.splats = new SplatSet(Math.max(1, t.count));
    this.group.add(this.splats.mesh);
    this.infos = new Array<MutInfo | undefined>(t.count).fill(undefined);
    this.candIdx = new Int32Array(t.count); this.candDist = new Float32Array(t.count); this.scratch = new Float32Array(t.count);
  }
  /** The layer toggle (default OFF). While off nothing is drawn and no host is pickable (a highlighted host stays pickable through HighlightMarkers). */
  setEnabled(on: boolean): void { this.enabled = on; if (!on) { this.splats?.setCount(0); this.drawnNow = 0; } }
  isEnabled(): boolean { return this.enabled; }
  setQuality(q: number): void { this.quality = Math.min(1, Math.max(0.25, q)); }
  /** Sun-centred ICRS pc of a drawable host id ('host:<name>'), or undefined (also for sky-only hosts). */
  positionPc(id: string): Vec3 | undefined {
    const t = this.table;
    const k = t?.indexOf.get(id);
    return t && k !== undefined ? [t.positionPc[3 * k]!, t.positionPc[3 * k + 1]!, t.positionPc[3 * k + 2]!] : undefined;
  }
  /** A comfortable camera distance for a host: 3 pc (the surroundings of a star, not a physical size). */
  viewDistancePc(id: string): number | undefined { return this.table?.indexOf.has(id) ? 3 : undefined; }
  hostIds(): readonly string[] { return this.table?.ids ?? []; }
  counts(): Pick<DiscoveryMarkerCounts, 'hostsTotal' | 'hostsDrawable' | 'hostsSkyOnly' | 'hostsDrawnNow' | 'hostsEnabled'> {
    const t = this.table;
    return { hostsTotal: t?.total ?? 0, hostsDrawable: t?.count ?? 0, hostsSkyOnly: t?.skyOnly ?? 0, hostsDrawnNow: this.drawnNow, hostsEnabled: this.enabled };
  }

  update(ctx: DeepRenderContext): readonly DeepScreenInfo[] {
    this.out.length = 0;
    const t = this.table, sp = this.splats;
    const camFromSun = Math.hypot(ctx.camPc[0], ctx.camPc[1], ctx.camPc[2]);
    const fade = hostsFade(camFromSun);
    if (!t || !sp || !this.enabled || fade <= 0.002) { sp?.setCount(0); this.drawnNow = 0; this.lastStats = { drawCalls: 0, textureBytes: 0, pointsDrawn: 0, objectsVisible: 0 }; return this.out; }
    const { camPc, basis, viewport, pixelsPerRadian: ppr } = ctx;
    const w = viewport.width, h = viewport.height, hw = w / 2, hh = h / 2;
    sp.setView(w, h, ppr);
    sp.setAlphaScale(fade);
    const fx = basis.forward[0], fy = basis.forward[1], fz = basis.forward[2];
    const rx0 = basis.right[0], rx1 = basis.right[1], rx2 = basis.right[2], ux0 = basis.up[0], ux1 = basis.up[1], ux2 = basis.up[2];
    const n = Math.min(t.count, Math.ceil(t.count * (ctx.quality ?? this.quality)));
    const P = t.positionPc, st = this.style;
    let m = 0, nc = 0;
    for (let i = 0; i < n; i++) {
      const rx = P[3 * i]! - camPc[0], ry = P[3 * i + 1]! - camPc[1], rz = P[3 * i + 2]! - camPc[2];
      const depth = rx * fx + ry * fy + rz * fz;
      if (!(depth > 1e-9)) continue;
      const sx = hw + ((rx * rx0 + ry * rx1 + rz * rx2) / depth) * ppr;
      const sy = hh - ((rx * ux0 + ry * ux1 + rz * ux2) / depth) * ppr;
      if (sx < -VIEW_MARGIN_PX || sx > w + VIEW_MARGIN_PX || sy < -VIEW_MARGIN_PX || sy > h + VIEW_MARGIN_PX) continue;
      const d = Math.sqrt(rx * rx + ry * ry + rz * rz);
      hostStyle(d, t.nPlanets[i], st);
      sp.setCentre(m, rx, ry, rz);
      sp.setStatic(m, st.radiusPx, st.radiusPx, 0, 0, HOST_COLOUR[0], HOST_COLOUR[1], HOST_COLOUR[2], st.alpha, 1.6);
      m++;
      if (sx >= 0 && sx <= w && sy >= 0 && sy <= h) {
        this.candIdx[nc] = i; this.candDist[nc] = d; nc++;
        const info = (this.infos[i] ??= newInfo(t.ids[i]!, 'exoplanet-host', t.names[i], 'Marker only: a halo at the host star; the archive position is not propagated in proper motion.'));
        info.x = sx; info.y = sy; info.pixelRadius = Math.min(st.radiusPx, HOST_INFO_MAX_RADIUS_PX); info.distancePc = d; info.visible = true; info.pickable = true;
      }
    }
    sp.setCount(m);
    sp.commit();
    this.drawnNow = m;
    // screen infos: the HOST_MAX_INFOS nearest to the camera among the on-screen ones
    let emitted = 0;
    if (nc > 0) {
      let thr = Infinity;
      if (nc > HOST_MAX_INFOS) { for (let k = 0; k < nc; k++) this.scratch[k] = this.candDist[k]!; thr = kthSmallest(this.scratch, nc, HOST_MAX_INFOS - 1); }
      for (let k = 0; k < nc && emitted < HOST_MAX_INFOS; k++) if (this.candDist[k]! <= thr) { this.out.push(this.infos[this.candIdx[k]!]!); emitted++; }
    }
    this.lastStats = { drawCalls: m > 0 ? 1 : 0, textureBytes: 0, pointsDrawn: m, objectsVisible: emitted };
    return this.out;
  }
  stats(): DeepRendererStats { return this.lastStats; }
  dispose(): void { this.splats?.dispose(); this.splats = null; this.table = null; this.group.clear(); }
}

// ======================================================================================================================================
interface OtherEntry { readonly m: OtherMarker; readonly info: MutInfo }

/** Camera distances (pc) between which the label of a curated object is shown: far enough that it is a place, close enough that the name is useful. */
export const OTHER_LABEL_MIN_PC = 0.05;
export const OTHER_LABEL_MAX_PC = 4e5;
const LABEL_DECLUTTER_PX = 70;

export class OtherObjectMarkers implements DeepSubRenderer {
  readonly name = 'other-objects';
  readonly layerKind = 'discovery' as const;
  readonly group = new THREE.Group();
  private entries: OtherEntry[] = [];
  private splats: SplatSet | null = null;
  private labels: LabelAtlas | null = null;
  private skyOnly = 0;
  private lastStats: DeepRendererStats = { drawCalls: 0, textureBytes: 0, pointsDrawn: 0, objectsVisible: 0 };
  private readonly out: DeepScreenInfo[] = [];
  private labelX = new Float32Array(0);
  private labelY = new Float32Array(0);

  /** Load public/data/other-objects.v1.json. Objects without a cited distance are not placed (counted). */
  setOthers(file: OtherObjectsFile): void {
    this.splats?.dispose(); this.labels?.dispose();
    this.group.clear();
    const { markers, skyOnly } = buildOtherMarkers(file);
    this.skyOnly = skyOnly;
    this.entries = markers.map((m) => ({ m, info: newInfo(m.id, 'other-object', m.name, 'Marker only: a single point at its catalogue position; the object is not resolved at this scale.') }));
    this.splats = new SplatSet(Math.max(2, markers.length * 2));
    this.labels = new LabelAtlas(Math.max(1, markers.length));
    this.entries.forEach((e, i) => this.labels!.setText(i, e.m.name));
    this.group.add(this.splats.mesh, this.labels.mesh);
    this.labelX = new Float32Array(markers.length); this.labelY = new Float32Array(markers.length);
  }
  ids(): readonly string[] { return this.entries.map((e) => e.m.id); }
  has(id: string): boolean { return isOtherId(id) && this.entries.some((e) => e.m.id === id); }
  positionPc(id: string): Vec3 | undefined { return this.entries.find((e) => e.m.id === id)?.m.xyzPc; }
  /** A comfortable camera distance: 1/50 of the object's distance from the Sun (a place, not a physical size). */
  viewDistancePc(id: string): number | undefined { const e = this.entries.find((x) => x.m.id === id); return e ? Math.max(0.5, e.m.distancePc / 50) : undefined; }
  counts(): Pick<DiscoveryMarkerCounts, 'others' | 'othersSkyOnly'> { return { others: this.entries.length, othersSkyOnly: this.skyOnly }; }
  /** The label text drawn for slot i (tests). */
  labelText(i: number): string { return this.labels?.textOf(i) ?? ''; }

  update(ctx: DeepRenderContext): readonly DeepScreenInfo[] {
    this.out.length = 0;
    const sp = this.splats, lb = this.labels;
    if (!sp || !lb || this.entries.length === 0) { return this.out; }
    const { camPc, basis, viewport, pixelsPerRadian: ppr } = ctx;
    const w = viewport.width, h = viewport.height;
    sp.setView(w, h, ppr); lb.setView(w, h);
    const fx = basis.forward[0], fy = basis.forward[1], fz = basis.forward[2];
    let m = 0, labelled = 0;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]!, p = e.m.xyzPc;
      const rx = p[0] - camPc[0], ry = p[1] - camPc[1], rz = p[2] - camPc[2];
      const depth = rx * fx + ry * fy + rz * fz;
      lb.hide(i);
      if (!(depth > 1e-9)) continue;
      const sx = w / 2 + ((rx * basis.right[0] + ry * basis.right[1] + rz * basis.right[2]) / depth) * ppr;
      const sy = h / 2 - ((rx * basis.up[0] + ry * basis.up[1] + rz * basis.up[2]) / depth) * ppr;
      if (sx < -VIEW_MARGIN_PX || sx > w + VIEW_MARGIN_PX || sy < -VIEW_MARGIN_PX || sy > h + VIEW_MARGIN_PX) continue;
      const d = Math.sqrt(rx * rx + ry * ry + rz * rz);
      // core dot + wider faint halo: restrained, and distinct from the star points by colour only
      sp.setCentre(m, rx, ry, rz);
      sp.setStatic(m, OTHER_RADIUS_PX, OTHER_RADIUS_PX, 0, 0, OTHER_COLOUR[0], OTHER_COLOUR[1], OTHER_COLOUR[2], OTHER_ALPHA, 1.2); m++;
      sp.setCentre(m, rx, ry, rz);
      sp.setStatic(m, OTHER_RADIUS_PX * 2.6, OTHER_RADIUS_PX * 2.6, 0, 0, OTHER_COLOUR[0], OTHER_COLOUR[1], OTHER_COLOUR[2], OTHER_ALPHA * 0.28, 1.0); m++;
      const info = e.info;
      info.x = sx; info.y = sy; info.pixelRadius = OTHER_RADIUS_PX; info.distancePc = d; info.visible = sx >= 0 && sx <= w && sy >= 0 && sy <= h; info.pickable = info.visible;
      this.out.push(info);
      // label: only at readable scales, and not on top of another label (fixed order = list order wins)
      if (info.visible && d >= OTHER_LABEL_MIN_PC && d <= OTHER_LABEL_MAX_PC) {
        let free = true;
        for (let k = 0; k < labelled; k++) if (Math.abs(this.labelX[k]! - sx) < LABEL_DECLUTTER_PX && Math.abs(this.labelY[k]! - sy) < 16) { free = false; break; }
        if (free) { this.labelX[labelled] = sx; this.labelY[labelled] = sy; labelled++; lb.place(i, rx, ry, rz, OTHER_RADIUS_PX * 2.6 + 4, 0); }
      }
    }
    sp.setCount(m); sp.commit();
    lb.setCount(labelled > 0 ? this.entries.length : 0); lb.commit();   // no label placed -> the label mesh is not visible and costs no draw call
    this.lastStats = { drawCalls: (m > 0 ? 1 : 0) + (labelled > 0 && lb.available ? 1 : 0), textureBytes: 0, pointsDrawn: m, objectsVisible: this.out.length };
    return this.out;
  }
  stats(): DeepRendererStats { return this.lastStats; }
  dispose(): void { this.splats?.dispose(); this.labels?.dispose(); this.splats = null; this.labels = null; this.group.clear(); this.entries = []; }
}

// ======================================================================================================================================
export interface HighlightItem { readonly id: string; readonly xyzPc: Vec3 | null; readonly label?: string }

export const HIGHLIGHT_CAPACITY = 256;
export const HIGHLIGHT_LABELS = 12;
export const HIGHLIGHT_RING_PX = 9;
export const SELECTION_RING_PX = 15;

export class HighlightMarkers implements DeepSubRenderer {
  readonly name = 'discovery-highlights';
  readonly layerKind = 'discovery' as const;
  readonly group = new THREE.Group();
  private readonly rings = new RingSet(HIGHLIGHT_CAPACITY + 2);
  private readonly halo = new SplatSet(2);
  private readonly labels = new LabelAtlas(HIGHLIGHT_LABELS + 1);
  private items: HighlightItem[] = [];
  private infos: (MutInfo | undefined)[] = [];
  private noPosition = 0;
  private dropped = 0;
  private selection: SelectionItem | null = null;
  private selectionInfo: MutInfo | null = null;
  private selectionShown = false;
  private magLimit = 7.5;
  private quality = 1;
  private lastStats: DeepRendererStats = { drawCalls: 0, textureBytes: 0, pointsDrawn: 0, objectsVisible: 0 };
  private readonly out: DeepScreenInfo[] = [];

  constructor(private readonly hosts: ExoplanetHostMarkers | null = null) { this.group.add(this.rings.mesh, this.halo.mesh, this.labels.mesh); }

  /** Rings for search / nearby results. Items without a position (sky-only records) are counted but cannot be drawn. At most HIGHLIGHT_CAPACITY are kept. */
  setHighlights(items: readonly HighlightItem[]): void {
    this.items = items.slice(0, HIGHLIGHT_CAPACITY).map((i) => ({ id: i.id, xyzPc: i.xyzPc ? [i.xyzPc[0], i.xyzPc[1], i.xyzPc[2]] as Vec3 : null, ...(i.label !== undefined ? { label: i.label } : {}) }));
    this.dropped = Math.max(0, items.length - HIGHLIGHT_CAPACITY);
    this.noPosition = this.items.filter((i) => i.xyzPc === null).length;
    this.infos = new Array<MutInfo | undefined>(this.items.length).fill(undefined);
    for (let k = 1; k <= HIGHLIGHT_LABELS; k++) this.labels.hide(k);
    let slot = 1;
    for (const it of this.items) { if (it.xyzPc && it.label && slot <= HIGHLIGHT_LABELS) this.labels.setText(slot++, it.label, 'rgba(190,210,240,0.9)'); }
  }
  /** The selection proxy: a ring + the name for the selected record while it is not otherwise visible at the current scale (see isOtherwiseVisible). null clears it. */
  setSelection(item: SelectionItem | null): void {
    this.selection = item && item.xyzPc ? { ...item, xyzPc: [item.xyzPc[0], item.xyzPc[1], item.xyzPc[2]] } : item;
    this.selectionInfo = item && item.xyzPc ? newInfo(`selection:${item.id}`, 'selection-proxy', item.label) : null;
    if (this.selectionInfo) this.selectionInfo.pickable = false;
    if (item?.label) this.labels.setText(0, item.label, 'rgba(255,232,170,0.95)');
  }
  /** The star pass magnitude limit, used by the 'is the star already visible' rule of the selection proxy. */
  setMagLimit(limit: number): void { this.magLimit = limit; }
  setQuality(q: number): void { this.quality = Math.min(1, Math.max(0.25, q)); }
  highlightIds(): readonly string[] { return this.items.map((i) => i.id); }
  isHighlighted(id: string): boolean { return this.items.some((i) => i.id === id); }
  counts(): Pick<DiscoveryMarkerCounts, 'highlights' | 'highlightsNoPosition' | 'highlightsDropped' | 'selectionShown'> {
    return { highlights: this.items.length, highlightsNoPosition: this.noPosition, highlightsDropped: this.dropped, selectionShown: this.selectionShown };
  }

  update(ctx: DeepRenderContext): readonly DeepScreenInfo[] {
    this.out.length = 0;
    const { camPc, basis, viewport, pixelsPerRadian: ppr } = ctx;
    const w = viewport.width, h = viewport.height;
    this.rings.setView(w, h); this.halo.setView(w, h, ppr); this.labels.setView(w, h);
    const fx = basis.forward[0], fy = basis.forward[1], fz = basis.forward[2];
    const hostsOn = this.hosts?.isEnabled() ?? false;
    const maxN = Math.max(16, Math.ceil(HIGHLIGHT_CAPACITY * (ctx.quality ?? this.quality)));
    let r = 0, lbl = 0, hn = 0;
    let labelled = 0;
    for (let i = 0; i < this.items.length && r < maxN; i++) {
      const it = this.items[i]!, p = it.xyzPc;
      if (!p) continue;
      const rx = p[0] - camPc[0], ry = p[1] - camPc[1], rz = p[2] - camPc[2];
      const depth = rx * fx + ry * fy + rz * fz;
      const hasLabel = it.label !== undefined && lbl < HIGHLIGHT_LABELS;
      if (hasLabel) { lbl++; }
      const slot = hasLabel ? lbl : -1;
      if (slot > 0) this.labels.hide(slot);
      if (!(depth > 1e-9)) continue;
      const sx = w / 2 + ((rx * basis.right[0] + ry * basis.right[1] + rz * basis.right[2]) / depth) * ppr;
      const sy = h / 2 - ((rx * basis.up[0] + ry * basis.up[1] + rz * basis.up[2]) / depth) * ppr;
      if (sx < -VIEW_MARGIN_PX || sx > w + VIEW_MARGIN_PX || sy < -VIEW_MARGIN_PX || sy > h + VIEW_MARGIN_PX) continue;
      this.rings.set(r++, rx, ry, rz, HIGHLIGHT_RING_PX, 1.3, 0.8, HIGHLIGHT_COLOUR[0], HIGHLIGHT_COLOUR[1], HIGHLIGHT_COLOUR[2]);
      if (slot > 0 && labelled < HIGHLIGHT_LABELS) { this.labels.place(slot, rx, ry, rz, HIGHLIGHT_RING_PX + 4, 0); labelled++; }
      // a highlighted host stays pickable when the host layer is off (when it is on, ExoplanetHostMarkers owns that id)
      if (!hostsOn && isHostId(it.id) && sx >= 0 && sx <= w && sy >= 0 && sy <= h && hn < HOST_MAX_INFOS) {
        const info = (this.infos[i] ??= newInfo(it.id, 'exoplanet-host', it.label, 'Highlighted result; the host layer is off.'));
        info.x = sx; info.y = sy; info.pixelRadius = HOST_INFO_MAX_RADIUS_PX; info.distancePc = Math.sqrt(rx * rx + ry * ry + rz * rz); info.visible = true; info.pickable = true;
        this.out.push(info); hn++;
      }
    }
    // selection proxy
    this.selectionShown = false;
    let halo = 0;
    const sel = this.selection;
    if (sel && sel.xyzPc && this.selectionInfo) {
      const rx = sel.xyzPc[0] - camPc[0], ry = sel.xyzPc[1] - camPc[1], rz = sel.xyzPc[2] - camPc[2];
      const depth = rx * fx + ry * fy + rz * fz;
      const d = Math.sqrt(rx * rx + ry * ry + rz * rz);
      this.labels.hide(0);
      if (depth > 1e-9 && !isOtherwiseVisible(sel, d, ppr, this.magLimit)) {
        const sx = w / 2 + ((rx * basis.right[0] + ry * basis.right[1] + rz * basis.right[2]) / depth) * ppr;
        const sy = h / 2 - ((rx * basis.up[0] + ry * basis.up[1] + rz * basis.up[2]) / depth) * ppr;
        if (sx > -VIEW_MARGIN_PX && sx < w + VIEW_MARGIN_PX && sy > -VIEW_MARGIN_PX && sy < h + VIEW_MARGIN_PX) {
          this.rings.set(r++, rx, ry, rz, SELECTION_RING_PX, 1.8, 0.95, SELECT_COLOUR[0], SELECT_COLOUR[1], SELECT_COLOUR[2]);
          this.halo.setCentre(0, rx, ry, rz);
          this.halo.setStatic(0, 7, 7, 0, 0, SELECT_COLOUR[0], SELECT_COLOUR[1], SELECT_COLOUR[2], 0.5, 1.4);
          halo = 1;
          if (sel.label) this.labels.place(0, rx, ry, rz, SELECTION_RING_PX + 5, 0);
          const info = this.selectionInfo;
          info.x = sx; info.y = sy; info.pixelRadius = SELECTION_RING_PX; info.distancePc = d; info.visible = sx >= 0 && sx <= w && sy >= 0 && sy <= h; info.pickable = false;
          this.out.push(info);
          this.selectionShown = true;
        }
      }
    } else this.labels.hide(0);
    this.rings.setCount(r); this.rings.commit();
    this.halo.setCount(halo); this.halo.commit();
    // Nothing to draw -> no mesh is visible and no draw call is issued (a visible mesh of hidden instances still costs a draw call).
    const anyLabel = (labelled > 0 || (this.selectionShown && !!sel?.label)) && this.labels.available;
    this.labels.setCount(anyLabel ? HIGHLIGHT_LABELS + 1 : 0); this.labels.commit();
    this.lastStats = { drawCalls: (r > 0 ? 1 : 0) + (halo > 0 ? 1 : 0) + (anyLabel ? 1 : 0), textureBytes: 0, pointsDrawn: r + halo, objectsVisible: this.out.length };
    return this.out;
  }
  stats(): DeepRendererStats { return this.lastStats; }
  dispose(): void { this.rings.dispose(); this.halo.dispose(); this.labels.dispose(); this.group.clear(); this.items = []; }
}

// ======================================================================================================================================
export interface DiscoveryMarkerRenderers { readonly hosts: ExoplanetHostMarkers; readonly others: OtherObjectMarkers; readonly highlights: HighlightMarkers }

/** The three renderers registered by extraRenderers.ts (order: hosts, others, highlights). Find them again with findDiscoveryMarkers(layer.registered). */
export function createDiscoveryMarkerRenderers(_d: ExtraRendererDeps): readonly DeepSubRenderer[] {
  const hosts = new ExoplanetHostMarkers();
  const others = new OtherObjectMarkers();
  const highlights = new HighlightMarkers(hosts);
  return [hosts, others, highlights];
}

/** Typed handles to the registered discovery renderers (`viewer.deep.registered`), or null when they are not registered. */
export function findDiscoveryMarkers(registered: readonly DeepSubRenderer[]): DiscoveryMarkerRenderers | null {
  const hosts = registered.find((r): r is ExoplanetHostMarkers => r instanceof ExoplanetHostMarkers);
  const others = registered.find((r): r is OtherObjectMarkers => r instanceof OtherObjectMarkers);
  const highlights = registered.find((r): r is HighlightMarkers => r instanceof HighlightMarkers);
  return hosts && others && highlights ? { hosts, others, highlights } : null;
}

/** Combined counts for the UI (the host layer toggle shows hostsDrawable and hostsSkyOnly). */
export function discoveryMarkerCounts(h: DiscoveryMarkerRenderers): DiscoveryMarkerCounts {
  return { ...h.hosts.counts(), ...h.others.counts(), ...h.highlights.counts() };
}

