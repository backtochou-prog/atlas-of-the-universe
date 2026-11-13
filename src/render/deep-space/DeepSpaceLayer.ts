import { EXTRA_RENDERER_FACTORIES } from './extraRenderers';
import type { PointRowInfo } from './types';
import * as THREE from 'three';
import type { DeepSpaceData } from '../../data/deepspace/deepSpaceData';
import type { DeepImageAsset, DeepImageProvenanceFile, DeepSpaceKind } from '../../data/deepspace/types';
import { distanceMetres, physicalSizeMetres } from '../../core/deepspace/geometry';
import type { Vec3 } from '../../core/spatial/vec3';
import { METRES_PER_PARSEC } from '../../core/units';
import { logSmoothstep } from './DeepSpaceLOD';
import { createBrowserAssetManager, type DeepSpaceAssetManager } from './DeepSpaceAssetManager';
import { GalaxyRenderer } from './GalaxyRenderer';
import { MilkyWayRenderer } from './MilkyWayRenderer';
import type { DeepLayerKind, DeepRenderContext, DeepRendererStats, DeepScreenInfo, DeepSubRenderer } from './types';

const PC = METRES_PER_PARSEC;
/** Extragalactic objects are not drawn within FAR_FADE_FROM_PC of the Sun and are fully drawn beyond FAR_FADE_TO_PC (VISUAL choice). */
export const FAR_FADE_FROM_PC = 120;
export const FAR_FADE_TO_PC = 1200;

export interface DeepLayerVisibility { galaxies: boolean; nebulae: boolean; clusters: boolean; structure: boolean; discovery: boolean }
export interface BandInfo { assetId: string; title: string; band: string; falseColour: boolean; composite: boolean; fidelity: string; credit: string }
export interface DeepLayerStats extends DeepRendererStats { quality: number; textures: number; loading: number; overBudget: boolean }

/** Fallback camera distances for objects that have no angular size (groups, clusters, structure): VISUAL choices. */
const FALLBACK_VIEW_PC: Readonly<Partial<Record<DeepSpaceKind, number>>> = { 'galaxy-group': 1.5e6, 'galaxy-cluster': 6e6, 'cosmic-structure': 1e8 };
const VIEW_FACTOR: Readonly<Record<string, number>> = { galaxy: 2.2, nebula: 2, 'star-cluster': 3 };

/**
 * The deep-space layer: owns the Three.js scene drawn BEFORE the Gaia star pass (parsec units, camera at the origin,
 * everything camera-relative in float64 on the CPU), the image asset manager, and the registry of sub-renderers.
 *
 * Later agents add NebulaRenderer, StarClusterRenderer, ... with `layer.register(renderer)` and never touch this file.
 */
export class DeepSpaceLayer {
  readonly scene = new THREE.Scene();
  readonly assets: DeepSpaceAssetManager<THREE.Texture>;
  readonly galaxies: GalaxyRenderer;
  readonly milkyWay: MilkyWayRenderer;
  private readonly renderers: DeepSubRenderer[] = [];
  private readonly screen = new Map<string, DeepScreenInfo>();
  private visibility: DeepLayerVisibility = { galaxies: true, nebulae: true, clusters: true, structure: true, discovery: true };
  private quality = 1;
  /** Screen-info ids emitted twice in one frame (the later one is dropped). Should stay 0. */
  duplicateIds = 0;
  private lastStats: DeepLayerStats = { drawCalls: 0, textureBytes: 0, pointsDrawn: 0, objectsVisible: 0, quality: 1, textures: 0, loading: 0, overBudget: false };
  private ctx: { -readonly [K in keyof DeepRenderContext]: DeepRenderContext[K] } | null = null;

  constructor(readonly data: DeepSpaceData, readonly images: DeepImageProvenanceFile, opts: { baseUrl: string; maxAnisotropy?: number; assets?: DeepSpaceAssetManager<THREE.Texture>; budgetBytes?: number }) {
    this.assets = opts.assets ?? createBrowserAssetManager(`${opts.baseUrl}deepspace/`, opts.maxAnisotropy ?? 8, opts.budgetBytes);
    this.assets.registerAssets(images.assets as readonly DeepImageAsset[]);
    this.milkyWay = new MilkyWayRenderer(data);
    this.galaxies = new GalaxyRenderer(data, this.assets);
    this.register(this.milkyWay);
    this.register(this.galaxies);
    for (const make of EXTRA_RENDERER_FACTORIES) for (const r of make({ data, assets: this.assets, baseUrl: opts.baseUrl })) this.register(r);
  }

  /** Add a sub-renderer (nebulae, clusters, galaxy clusters, cosmic structure ...). Its group joins the scene. */
  register(r: DeepSubRenderer): void {
    if (this.renderers.includes(r)) return;
    this.renderers.push(r);
    this.scene.add(r.group);
    r.setQuality?.(this.quality);
  }
  unregister(r: DeepSubRenderer): void {
    const i = this.renderers.indexOf(r);
    if (i < 0) return;
    this.renderers.splice(i, 1);
    this.scene.remove(r.group);
  }
  get registered(): readonly DeepSubRenderer[] { return this.renderers; }
  /** The catalogue row behind a 'catalogue-point' screen id ("ungc:123"), for the inspector. */
  pointRow(id: string): PointRowInfo | undefined {
    for (const r of this.renderers) { const p = r.pointRow?.(id); if (p) return p; }
    return undefined;
  }

  /** WebGL context lost/restored (the canvas events): all textures are dropped and re-requested through the asset manager. */
  onContextLost(): void { this.assets.onContextLost(); }
  onContextRestored(): void { this.assets.onContextRestored(); }

  setQuality(q: number): void { this.quality = Math.min(1, Math.max(0.25, q)); for (const r of this.renderers) r.setQuality?.(this.quality); }
  getQuality(): number { return this.quality; }

  setLayerVisibility(v: Partial<DeepLayerVisibility>): void { this.visibility = { ...this.visibility, ...v }; }
  getLayerVisibility(): Readonly<DeepLayerVisibility> { return this.visibility; }

  /** Switch the image band of an object. The swap is instant once the new band's thumbnail is available. */
  setBand(objectId: string, assetId: string): boolean {
    for (const r of this.renderers) if (r.setBand?.(objectId, assetId)) return true;
    return false;
  }
  availableBands(objectId: string): BandInfo[] {
    return this.data.imageAssetsOf(objectId).map((a) => ({ assetId: a.id, title: a.title, band: a.band.kind, falseColour: a.band.falseColour, composite: a.band.composite, fidelity: a.fidelity, credit: a.credit }));
  }
  activeAsset(objectId: string): string | undefined {
    for (const r of this.renderers) { const a = r.activeAsset?.(objectId); if (a) return a; }
    return undefined;
  }

  /**
   * Sun-centred ICRS position of an object in parsecs: the catalogue RA/Dec + distance, else the position a sub-renderer gives it.
   * The latter is a VIEW ANCHOR (Local Group: midway between the Milky Way and M31; 2MRS: the Sun), not a measured position or a barycentre.
   */
  objectPositionPc(id: string): Vec3 | undefined {
    const p = this.data.positionPc(id);
    if (p) return p;
    for (const r of this.renderers) { const q = r.positionPc?.(id); if (q) return q; }
    return undefined;
  }
  /** True when objectPositionPc(id) is a view anchor supplied by a renderer rather than a catalogue position. */
  isViewAnchor(id: string): boolean { return !this.data.positionPc(id) && this.objectPositionPc(id) !== undefined; }

  /**
   * A comfortable camera distance from the object, parsecs: galaxies ~2.2 x the physical diameter, nebulae ~2 x, clusters ~3 x
   * the half-extent (as given by the catalogue angular size and the distance).
   */
  viewDistancePc(id: string): number | undefined {
    for (const r of this.renderers) { const d = r.viewDistancePc?.(id); if (d !== undefined) return d; }
    const o = this.data.get(id);
    if (!o) return undefined;
    if (o.angularSize && o.sky?.distance) {
      const diameterPc = physicalSizeMetres(o.angularSize.majorArcmin, distanceMetres(o.sky.distance).metres) / PC;
      if (o.kind === 'star-cluster') return 3 * (diameterPc / 2);
      return (VIEW_FACTOR[o.kind] ?? 2.2) * diameterPc;
    }
    return FALLBACK_VIEW_PC[o.kind];
  }

  /** Per-frame update: sets the camera range for the current scale, runs every enabled sub-renderer and returns the screen info of all objects. */
  update(c: DeepRenderContext): Map<string, DeepScreenInfo> {
    const camera = c.camera;
    // near/far per frame: near follows the focus distance (nothing nearer than 1e-3 of it matters), far reaches 1e11 pc.
    // Image and glow sprites are drawn without depth test, so the range only decides what is clipped, not how it is sorted.
    camera.near = Math.min(1e7, Math.max(1e-6, 1e-3 * c.focusDistancePc));
    camera.far = 1e11;
    camera.updateProjectionMatrix();
    const ctx = (this.ctx ??= { ...c });
    Object.assign(ctx, c, { quality: this.quality, farFade: logSmoothstep(Math.hypot(c.camPc[0], c.camPc[1], c.camPc[2]), FAR_FADE_FROM_PC, FAR_FADE_TO_PC) });
    this.screen.clear();
    let calls = 0, points = 0, visible = 0;
    for (const r of this.renderers) {
      const on = this.visibility[r.layerKind ?? 'galaxies'];
      r.group.visible = on;
      if (!on) continue;
      for (const info of r.update(ctx)) {
        // ids are unique across renderers (Virgo rows are "virgo:<row>", cloud rows "twomrs:<row>"); a clash would let one overwrite the other's pick/ring info
        if (this.screen.has(info.id)) { this.duplicateIds++; continue; }
        this.screen.set(info.id, info);
      }
      const s = r.stats();
      calls += s.drawCalls; points += s.pointsDrawn; visible += s.objectsVisible;
    }
    this.assets.endFrame(c.nowSeconds);
    const a = this.assets.stats();
    this.lastStats = { drawCalls: calls, textureBytes: a.textureBytes, pointsDrawn: points, objectsVisible: visible, quality: this.quality, textures: a.textures, loading: a.loading, overBudget: a.overBudget };
    return this.screen;
  }

  /** Call once per frame before update(): resets the per-frame texture activation budget. */
  beginFrame(): void { this.assets.beginFrame(); }

  stats(): DeepLayerStats { return this.lastStats; }
  screenInfo(): ReadonlyMap<string, DeepScreenInfo> { return this.screen; }

  dispose(): void {
    for (const r of this.renderers) r.dispose();
    this.renderers.length = 0;
    this.assets.dispose();
    this.scene.clear();
    this.screen.clear();
  }
}

export type { DeepLayerKind };
