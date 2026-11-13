import * as THREE from 'three';
import { DEFAULT_BRIGHTNESS, type BrightnessParams } from './brightness';
import { cameraBasis, cameraPosition, DEFAULT_ORBIT, FOV_DEG, interpolate, ORBIT_LIMITS, pan, resetOrientation, rotate, zoom, type OrbitState } from './orbitCamera';
import { pickStar, projectToScreen, type PickResult } from './picking';
import type { StarPassLayer } from './discovery/types';
import type { ExoplanetFile, OtherObjectsFile } from '../discovery/types';
import type { HighlightItem, SelectionProxy } from './discovery/markerPort';
import { DISCOVERY_PICK_TIERS, discoveryMarkerCounts, findDiscoveryMarkers, type DiscoveryMarkerRenderers } from './deep-space/DiscoveryMarkers';
import { StarField, starFieldFade } from './starfield';
import type { StarLayer } from './starLayer';
import { SolarLayer, type BodyScreenInfo } from './solar/solarLayer';
import { SolarHierarchy, type FrameLabel } from './solar/hierarchy';
import { TextureManager } from './solar/textures';
import { pickBodyAt } from './solar/pickBody';
import { DeepSpaceLayer } from './deep-space/DeepSpaceLayer';
import { describeGovernor, type GovernorReport } from './deep-space/DeepSpaceLOD';
import type { DeepScreenInfo } from './deep-space/types';
import type { DeepSpaceData } from '../data/deepspace/deepSpaceData';
import type { DeepImageProvenanceFile } from '../data/deepspace/types';
import { pick as pickScreenCandidates, type PickCandidate } from '../core/deepspace/pick';
import { QualityGovernor } from '../core/deepspace/lod';
import { galacticToIcrsVector } from '../core/astro/coordinates';
import type { SolarSystemData, TextureProvenanceEntry } from '../data/solar/solarCatalogue';
import { ENHANCED_SCALE, TRUE_SCALE, type ScalePolicy } from '../core/solar/displayScale';
import { METRES_PER_AU, METRES_PER_PARSEC } from '../core/units';
import { OBLIQUITY_J2000_DEG } from '../core/orbits/elements';
import { length as vlen, normalise as vnorm, type Vec3 } from "../core/spatial/vec3";

/** Beyond this distance from the Sun the planets are far below one pixel and the Solar System layer is not drawn. */
const SOLAR_ACTIVE_METRES = 3000 * METRES_PER_AU;
const PC = METRES_PER_PARSEC;

/** Selection priority by kind for deepScreen picking (the core picker prefers the smaller on-screen disc first, then this). */
const DEEP_PICK_PRIORITY: Readonly<Record<string, number>> = { nebula: 4, 'star-cluster': 4, galaxy: 3, 'galaxy-group': 2, 'galaxy-cluster': 2, 'cosmic-structure': 1, 'catalogue-point': 0 };
/** Camera distance, parsecs, of the Local Group and nearby-universe overviews (VISUAL choices, not astronomical boundaries). */
export const LOCAL_GROUP_VIEW_PC = 3e6;
export const NEARBY_UNIVERSE_VIEW_PC = 1e8;
/** Beyond this distance from the Sun the deep-space layer is the relevant scale (the HUD/UI may switch its mode). */
export const DEEP_ACTIVE_FROM_PC = 1000;

/** Everything needed to return to a view: restoreCamera(snapshot) flies back, it never teleports. */
export interface ViewerCameraSnapshot extends OrbitState {
  /** Frame id the camera was in (viewer.frame.id), informational. */
  readonly frameId: string;
  /** The Solar System body the camera was following, if any. */
  readonly followId: string | null;
  readonly selectedBody: string | null;
  readonly selectedDeep: string | null;
}

/** Where a point is on the screen. `visible`: inside the viewport and in front of the camera. `behind`: at or behind the camera plane (x, y are then 0 and meaningless). */
export interface ScreenPoint { readonly x: number; readonly y: number; readonly depthPc: number; readonly visible: boolean; readonly behind: boolean }

interface Flight { from: OrbitState; to: (jd: number) => OrbitState; start: number; duration: number; thenFollow: string | null }

/** Owns the WebGL renderer, the camera state, the Gaia star layer and the Solar System layer. No astronomy lives here. */
export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  private readonly starScene = new THREE.Scene();
  private readonly starCamera = new THREE.PerspectiveCamera(FOV_DEG, 1, 1e-6, 1e10); // far 1e10 pc: the Sun marker and any star stay unclipped at 600 Mpc (no depth test is used)
  private readonly solarCamera = new THREE.PerspectiveCamera(FOV_DEG, 1, 1, 1e15);
  private readonly deepCamera = new THREE.PerspectiveCamera(FOV_DEG, 1, 1e-3, 1e11);
  private field: StarField | null = null;
  private sun: THREE.Points;
  state: OrbitState = DEFAULT_ORBIT;
  brightness: BrightnessParams = DEFAULT_BRIGHTNESS;
  hideSuspect = false;
  private flight: Flight | null = null;
  private layer: StarLayer | null = null;
  private width = 1;
  private height = 1;
  drawCalls = 0;
  /** Extra layers drawn in the star pass (see addStarPassLayer). */
  private readonly starPassLayers: StarPassLayer[] = [];
  /** Ids currently highlighted / the selection proxy (kept even when no marker renderer is registered, so the page can draw a fallback). */
  highlights: readonly HighlightItem[] = [];
  selectionProxy: SelectionProxy | null = null;

  // Solar System
  solar: SolarLayer | null = null;
  solarData: SolarSystemData | null = null;
  hierarchy: SolarHierarchy | null = null;
  textures: TextureManager | null = null;
  scalePolicy: ScalePolicy = ENHANCED_SCALE;
  followId: string | null = null;
  selectedBody: string | null = null;
  jdTdb = 0;
  solarActive = false;
  screen: Map<string, BodyScreenInfo> = new Map();
  frame = { id: 'stellar-neighbourhood', path: [] as FrameLabel[] };
  // Deep space (galaxies, Milky Way model, and whatever sub-renderers are registered later)
  deep: DeepSpaceLayer | null = null;
  deepData: DeepSpaceData | null = null;
  /** Screen info of every deep-space object this frame (empty when nothing is attached). */
  deepScreen: Map<string, DeepScreenInfo> = new Map();
  selectedDeep: string | null = null;
  /** True when the camera is far enough from the Sun (>= DEEP_ACTIVE_FROM_PC) or a deep-space object is selected: the UI may show deep-space chrome. */
  deepActive = false;
  /** Optional adaptive quality (core QualityGovernor fed with frame times). Off by default; see enableQualityGovernor. */
  private governor: QualityGovernor | null = null;
  private governorTargetMs = 1000 / 30;
  /** Unclamped moving average of the frame time, ms (display only). */
  private frameMsAvg = 0;
  private lastRenderAt = 0;
  private readonly deepCtx = {
    camera: this.deepCamera, camPc: [0, 0, 0] as Vec3, basis: { right: [1, 0, 0], up: [0, 0, 1], forward: [0, 1, 0] } as ReturnType<typeof cameraBasis>,
    viewport: { width: 1, height: 1 }, pixelRatio: 1, focusDistancePc: 1, pixelsPerRadian: 1, nowSeconds: 0, selectedId: null as string | null, quality: 1,
  };
  /** Closest allowed camera distance from the focus, parsecs. Set per focus so the camera never enters a body. */
  minDistancePc: number = ORBIT_LIMITS.minDistance;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x03050a, 1);
    this.renderer.autoClear = false;
    this.renderer.info.autoReset = false; // several passes per frame: drawCalls is the sum, reset once at the start of render()
    // The Sun is the origin of the catalogue frame. In the star view it is a reference marker, NOT a Gaia record.
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    this.sun = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffe9b8, size: 7, sizeAttenuation: false, transparent: true, opacity: 0.9, depthTest: false }));
    this.sun.frustumCulled = false;
    this.starScene.add(this.sun);
    // WebGL context loss: three.js itself calls preventDefault() and re-creates its GL state on restore; here we drop the deep-space
    // textures (their CPU bitmaps are closed after the first upload, so they cannot be re-uploaded) and let the asset manager re-request them.
    canvas.addEventListener('webglcontextlost', this.onGlLost);
    canvas.addEventListener('webglcontextrestored', this.onGlRestored);
    this.resize();
  }

  /** Counts for QA: how often the GL context was lost / restored while this viewer was alive. */
  readonly glContext = { lost: 0, restored: 0, lostNow: false };
  private readonly onGlLost = (): void => { this.glContext.lost++; this.glContext.lostNow = true; this.deep?.onContextLost(); };
  private readonly onGlRestored = (): void => { this.glContext.restored++; this.glContext.lostNow = false; this.deep?.onContextRestored(); };

  setLayer(layer: StarLayer): void {
    this.field?.dispose();
    this.layer = layer;
    this.field = new StarField(layer, this.brightness);
    this.field.setPixelRatio(this.renderer.getPixelRatio());
    this.field.setHideSuspect(this.hideSuspect);
    this.starScene.add(this.field.object);
  }

  attachSolar(data: SolarSystemData, textureEntries: readonly TextureProvenanceEntry[], textureBase: string): void {
    this.solarData = data;
    this.hierarchy = new SolarHierarchy(data);
    this.textures = new TextureManager(textureBase, textureEntries, Math.min(8, this.renderer.capabilities.getMaxAnisotropy()));
    this.solar = new SolarLayer(data, this.textures);
  }

  /**
   * Attach the deep-space layer (galaxies with their real images, the Milky Way model, and a registry for further
   * sub-renderers: `viewer.deep.register(renderer)`). Call once after the data is loaded.
   */
  attachDeepSpace(data: DeepSpaceData, images: DeepImageProvenanceFile): void {
    this.deep?.dispose();
    this.deepData = data;
    this.deep = new DeepSpaceLayer(data, images, { baseUrl: import.meta.env.BASE_URL, maxAnisotropy: Math.min(8, this.renderer.capabilities.getMaxAnisotropy()) });
    this.markers()?.highlights.setMagLimit(this.brightness.magLimit);
  }

  /** Turn on the adaptive quality governor (target frame time in ms). It feeds frame times to the core QualityGovernor and calls deep.setQuality. */
  enableQualityGovernor(targetMs = 1000 / 30): void { this.governor = new QualityGovernor({ targetMs }); this.governorTargetMs = targetMs; }
  /** Current governor state and the reason for it, for the HUD and QA. */
  governorReport(): GovernorReport {
    return describeGovernor(this.governor !== null, this.deep?.getQuality() ?? 1, this.governor?.frameMsEma ?? 0, this.governorTargetMs, this.frameMsAvg);
  }
  disableQualityGovernor(): void { this.governor = null; this.deep?.setQuality(1); }

  get viewport() { return { width: this.width, height: this.height }; }

  resize(): void {
    this.width = Math.max(1, this.canvas.clientWidth);
    this.height = Math.max(1, this.canvas.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(this.width, this.height, false);
    for (const c of [this.starCamera, this.solarCamera, this.deepCamera]) { c.aspect = this.width / this.height; c.updateProjectionMatrix(); }
    this.field?.setPixelRatio(this.renderer.getPixelRatio());
    for (const l of this.starPassLayers) l.setPixelRatio?.(this.renderer.getPixelRatio());
  }

  setMagLimit(limit: number): void {
    this.brightness = { ...this.brightness, magLimit: limit };
    this.field?.setBrightness(this.brightness);
    for (const l of this.starPassLayers) l.setMagLimit?.(limit);
    this.markers()?.highlights.setMagLimit(limit);
  }

  setHideSuspect(hide: boolean): void { this.hideSuspect = hide; this.field?.setHideSuspect(hide); }

  private limits() { return { minDistance: this.minDistancePc, maxDistance: ORBIT_LIMITS.maxDistance }; }
  private manual(): void { this.flight = null; this.followKeepsTarget(); }
  private followKeepsTarget(): void { /* user input keeps following the body: only the orbit angles and distance change */ }

  zoomBy(delta: number): void { this.manual(); this.state = zoom(this.state, delta, 0.0015, this.limits()); }
  rotateBy(dyaw: number, dpitch: number): void { this.manual(); this.state = rotate(this.state, dyaw, dpitch); }
  panBy(dx: number, dy: number): void { this.manual(); this.followId = null; this.state = pan(this.state, dx, dy, this.height); }

  // ---- extra star-pass layers (Hipparcos supplement ...) -----------------------------------------------------------------------
  /**
   * Add a layer to the star scene (the pass that draws the Gaia stars), so it shares the camera, the floating origin and the magnitude limit.
   * Each frame the viewer calls layer.update(camPc) and layer.setFade(f) (the same fade the Gaia field uses); setMagLimit / setPixelRatio are forwarded when the
   * layer implements them (current values are applied immediately). Its draw calls are part of `drawCalls` (renderer.info covers the whole star scene) and its
   * points are listed by starPassStats(). Returns a function that removes AND disposes the layer; viewer.dispose() disposes whatever is still attached.
   */
  addStarPassLayer(layer: StarPassLayer): () => void {
    this.starPassLayers.push(layer);
    this.starScene.add(layer.object);
    layer.setMagLimit?.(this.brightness.magLimit);
    layer.setPixelRatio?.(this.renderer.getPixelRatio());
    layer.update(cameraPosition(this.state));
    return () => {
      const i = this.starPassLayers.indexOf(layer);
      if (i < 0) return;
      this.starPassLayers.splice(i, 1);
      this.starScene.remove(layer.object);
      layer.dispose();
    };
  }
  /** Name and point count of every extra star-pass layer, for the HUD and QA. */
  starPassStats(): { name: string; points: number }[] { return this.starPassLayers.map((l) => ({ name: l.name, points: l.stats().points })); }

  // ---- camera snapshots, generic flights, projection ---------------------------------------------------------------------------
  /** The view as it is now. Restoring it later (restoreCamera) flies back to this view, follows the same body and re-selects the same deep object. */
  snapshotCamera(): ViewerCameraSnapshot {
    return { ...this.state, focus: [...this.state.focus] as Vec3, frameId: this.frame.id, followId: this.followId, selectedBody: this.selectedBody, selectedDeep: this.selectedDeep };
  }

  /**
   * Fly (never teleport) to a snapshot: focus linearly, distance geometrically, yaw by the short way. If the snapshot followed a Solar System body the flight
   * ends by following it again (the body has moved, so the target focus tracks the ephemeris during the flight).
   */
  restoreCamera(s: ViewerCameraSnapshot, durationMs = 900): void {
    const follow = s.followId !== null && this.solarData?.get(s.followId) ? s.followId : null;
    this.selectedBody = s.selectedBody;
    this.selectedDeep = s.selectedDeep;
    this.followId = null;
    this.minDistancePc = follow ? this.minDistanceFor(follow) : ORBIT_LIMITS.minDistance;
    const fixed: OrbitState = { focus: s.focus, distance: s.distance, yaw: s.yaw, pitch: s.pitch };
    this.flight = {
      from: this.state, start: performance.now(), duration: durationMs, thenFollow: follow,
      to: (jd) => (follow ? { ...fixed, focus: this.bodyHelioPc(follow, jd) } : fixed),
    };
  }

  /**
   * Smooth flight to a point (heliocentric ICRS parsecs) at a view distance. Distance is interpolated geometrically like flyToDeep, so crossing eight orders of
   * magnitude takes the same time per decade. The view distance is clamped to [ORBIT_LIMITS.minDistance, maxDistance] (1e-3 pc .. 6e8 pc) and NaN / non-finite
   * input is rejected (the flight does not start; returns false). Orientation is kept unless `orient` is given.
   */
  flyToPointPc(xyz: Vec3, viewDistancePc: number, durationMs = 1800, orient?: { yaw: number; pitch: number }): boolean {
    if (!xyz.every(Number.isFinite) || !Number.isFinite(viewDistancePc) || viewDistancePc <= 0) return false;
    const distance = Math.min(ORBIT_LIMITS.maxDistance, Math.max(ORBIT_LIMITS.minDistance, viewDistancePc));
    const target: OrbitState = { focus: [xyz[0], xyz[1], xyz[2]], distance, yaw: orient?.yaw ?? this.state.yaw, pitch: orient?.pitch ?? this.state.pitch };
    this.followId = null;
    this.minDistancePc = ORBIT_LIMITS.minDistance;
    this.flight = { from: this.state, start: performance.now(), duration: durationMs, thenFollow: null, to: () => target };
    return true;
  }

  /** Orientation (yaw, pitch) that looks at `focus` from the Sun's side, exposed for hosts that want flyToPointPc to face an object as seen from the Solar System. */
  orientationFromSun(focus: Vec3): { yaw: number; pitch: number } { return this.lookFromSun(focus); }

  /**
   * Where a heliocentric ICRS point (parsecs) is on screen right now. The subtraction camera -> point is done in float64 before projecting, so it is exact at any scale.
   * `behind` is true at or behind the camera plane; `visible` additionally requires the point to be inside the viewport.
   */
  projectPc(xyz: Vec3): ScreenPoint {
    const cam = cameraPosition(this.state);
    const rel: Vec3 = [xyz[0] - cam[0], xyz[1] - cam[1], xyz[2] - cam[2]];
    const s = projectToScreen(rel, cameraBasis(this.state), this.viewport);
    if (!s) return { x: 0, y: 0, depthPc: Math.hypot(rel[0], rel[1], rel[2]), visible: false, behind: true };
    const inside = s.x >= 0 && s.x <= this.width && s.y >= 0 && s.y <= this.height;
    return { x: s.x, y: s.y, depthPc: s.depth, visible: inside, behind: false };
  }

  // ---- highlights and selection proxy (R2b's HighlightMarkers, src/render/deep-space/DiscoveryMarkers.ts) ----------------------------------------
  private markers(): DiscoveryMarkerRenderers | null { return this.deep ? findDiscoveryMarkers(this.deep.registered) : null; }
  /** True when the discovery marker renderers are registered (then the page needs no DOM fallback marker for the selection proxy). */
  get hasMarkerRenderer(): boolean { return this.markers() !== null; }
  /** Mark objects (e.g. the neighbours of the selection) with rings. Always stored in `highlights`; drawn when the marker renderers are registered. */
  setHighlights(items: readonly HighlightItem[]): void {
    this.highlights = items;
    this.markers()?.highlights.setHighlights(items.map((i) => ({ id: i.id, xyzPc: i.positionPc, ...(i.label !== undefined ? { label: i.label } : {}) })));
  }
  /**
   * Draw a ring and the name for the selected object when it is too small or faint to see at the target distance (or has no drawn form). null removes it.
   * The renderer hides the ring again while the object is clearly visible by its own drawing (SelectionProxy.absoluteMag / sizePc, see isOtherwiseVisible).
   */
  setSelectionProxy(proxy: SelectionProxy | null): void {
    this.selectionProxy = proxy;
    this.markers()?.highlights.setSelection(proxy ? {
      id: proxy.id, xyzPc: proxy.positionPc, label: proxy.label,
      ...(proxy.sizePc !== undefined ? { sizePc: proxy.sizePc } : {}), ...(proxy.absoluteMag !== undefined ? { absoluteMag: proxy.absoluteMag } : {}),
    } : null);
  }

  // ---- discovery data for the marker renderers and the host-layer toggle ---------------------------------------------------------
  /**
   * Give the registered marker renderers their data: the NASA Exoplanet Archive hosts (hosts layer, default OFF) and the curated 'other' objects (Sgr A*, Cyg X-1 ...).
   * Returns false when the deep-space layer / marker renderers are not registered. Either argument may be omitted (its dataset failed to load).
   */
  attachDiscoveryMarkers(data: { readonly hosts?: ExoplanetFile['hosts']; readonly others?: OtherObjectsFile }): boolean {
    const m = this.markers();
    if (!m) return false;
    if (data.hosts) m.hosts.setHosts(data.hosts);
    if (data.others) m.others.setOthers(data.others);
    return true;
  }
  /** The exoplanet-host layer (aqua halos at the archive's host stars). Default OFF; the interface supplies the toggle later. */
  setExoplanetHostsVisible(on: boolean): void { this.markers()?.hosts.setEnabled(on); }
  get exoplanetHostsVisible(): boolean { return this.markers()?.hosts.isEnabled() ?? false; }
  /** Counts for the layer toggle ("N hosts drawn, M sky-only"), or null without marker renderers. */
  discoveryMarkerCounts(): ReturnType<typeof discoveryMarkerCounts> | null { const m = this.markers(); return m ? discoveryMarkerCounts(m) : null; }

  // ---- bodies -------------------------------------------------------------------------------------------------
  bodyHelioPc(id: string, jd = this.jdTdb): Vec3 {
    const p = this.solarData!.ephemeris.heliocentricPosition(id, jd);
    return [p[0] / PC, p[1] / PC, p[2] / PC];
  }

  /** A comfortable viewing distance for a body, in parsecs: a few body radii, or the ring system for Saturn. */
  viewDistancePc(id: string): number {
    const d = this.solarData!;
    const meanR = d.meanRadiusMetres(id) ?? 1e6;
    const rings = this.textures?.ringRadiiMetres('saturn_rings');
    const reach = id === 'saturn' && rings ? rings[1] : meanR;
    const factor = id === 'sun' ? 5 : d.get(id)?.kind === 'moon' ? 8 : 4.2;
    return (reach * factor) / PC;
  }

  private minDistanceFor(id: string): number {
    const meanR = this.solarData!.meanRadiusMetres(id) ?? 1e6;
    return (meanR * 1.35 * Math.max(1, this.scalePolicy.mode === 'enhanced' ? 1 : 1)) / PC;
  }

  /** Fly to a body and then follow it as it moves along its orbit. The camera never teleports: distance is interpolated geometrically. */
  flyToBody(id: string, durationMs = 1800): void {
    if (!this.solarData?.get(id)) throw new Error(`Unknown Solar System body "${id}"`);
    const distance = this.viewDistancePc(id);
    const keepYaw = this.state.yaw, keepPitch = this.state.pitch;
    this.selectedBody = id;
    this.followId = null;
    this.minDistancePc = this.minDistanceFor(id);
    this.flight = {
      from: this.state, start: performance.now(), duration: durationMs, thenFollow: id,
      to: (jd) => ({ focus: this.bodyHelioPc(id, jd), distance, yaw: keepYaw, pitch: keepPitch }),
    };
  }

  /** Overview of the planetary region, seen from above the ecliptic. */
  flyToOverview(durationMs = 2200): void {
    const eps = OBLIQUITY_J2000_DEG * Math.PI / 180;
    const target: OrbitState = { focus: [0, 0, 0], distance: (70 * METRES_PER_AU) / PC, yaw: -Math.PI / 2, pitch: Math.asin(Math.cos(eps)) };
    this.followId = null; this.selectedBody = null; this.minDistancePc = ORBIT_LIMITS.minDistance;
    this.flight = { from: this.state, start: performance.now(), duration: durationMs, thenFollow: null, to: () => target };
  }

  /** Back out to the parent: from a moon to its planet, from a planet to the Solar System overview. */
  flyToParent(): void {
    const sel = this.selectedBody ?? this.followId;
    const parent = sel ? this.solarData?.get(sel)?.parent : null;
    if (parent && parent !== 'sun') this.flyToBody(parent);
    else this.flyToOverview();
  }

  flyTo(target: OrbitState, durationMs = 900): void {
    this.followId = null; this.minDistancePc = ORBIT_LIMITS.minDistance;
    this.flight = { from: this.state, start: performance.now(), duration: durationMs, thenFollow: null, to: () => target };
  }
  resetOrientation(): void { const t = resetOrientation(this.state); this.flight = { from: this.state, start: performance.now(), duration: 900, thenFollow: this.followId, to: () => ({ ...this.state, yaw: t.yaw, pitch: t.pitch }) }; }
  get flying(): boolean { return this.flight !== null; }

  camera3(): readonly [number, number, number] { return cameraPosition(this.state); }
  cameraHelioMetres(): Vec3 { const c = cameraPosition(this.state); return [c[0] * PC, c[1] * PC, c[2] * PC]; }

  // ---- projection and picking ---------------------------------------------------------------------------------
  relOf(layerIndex: number): [number, number, number] | null {
    if (!this.field) return null;
    const r = this.field.rel;
    return [r[3 * layerIndex]!, r[3 * layerIndex + 1]!, r[3 * layerIndex + 2]!];
  }

  screenOf(layerIndex: number): { x: number; y: number } | null {
    const rel = this.relOf(layerIndex);
    if (!rel) return null;
    const s = projectToScreen(rel, cameraBasis(this.state), this.viewport);
    return s ? { x: s.x, y: s.y } : null;
  }

  screenOfBody(id: string): { x: number; y: number; r: number } | null {
    const i = this.screen.get(id);
    return i && i.visible ? { x: i.x, y: i.y, r: Math.max(i.pixelRadius, 10) } : null;
  }

  /**
   * The star under the cursor: the Gaia star (PickResult with `catalogueIndex` >= 0, `source` 'gaia') or, when an extra star-pass layer implements pick() and
   * finds a star, that layer's star (`source` 'layer', `catalogueIndex` -1, `layerId` = the layer's id string, e.g. "hip:32349", `layer` = the layer name).
   * When both find one, the nearer to the cursor wins: a layer reporting its distance through the optional pickDistance(id, x, y, ctx) is compared with the
   * Gaia pick's screenDistancePx; a layer without it is preferred, because layer picks are limited to a few pixels and brightness-aware by contract.
   * Callers must test `layerId !== undefined` before using `catalogueIndex`.
   */
  pick(x: number, y: number): PickResult | null {
    const gaia = this.layer && this.field ? pickStar(this.layer, this.field.rel, cameraBasis(this.state), this.viewport, { x, y }, this.brightness, 12, this.hideSuspect) : null;
    let best: PickResult | null = gaia ? { ...gaia, source: 'gaia' } : null;
    if (this.starPassLayers.length === 0) return best;
    const ctx = { basis: cameraBasis(this.state), viewport: this.viewport, camPc: cameraPosition(this.state) };
    for (const l of this.starPassLayers) {
      if (typeof l.pick !== 'function') continue;
      let id: string | null = null;
      try { id = l.pick(x, y, ctx); } catch { id = null; }
      if (id === null) continue;
      const dist = (l as { pickDistance?: (id: string, x: number, y: number, c: typeof ctx) => number }).pickDistance?.(id, x, y, ctx);
      const d = typeof dist === 'number' && Number.isFinite(dist) ? dist : 0;
      if (best === null || d <= best.screenDistancePx) best = { layerIndex: -1, catalogueIndex: -1, screenDistancePx: d, apparentMag: NaN, source: 'layer', layerId: id, layer: l.name };
    }
    return best;
  }

  /** The nearest Solar System body under the cursor (see pickBodyAt). */
  pickBody(x: number, y: number): string | null {
    return this.solarActive ? pickBodyAt(this.screen.values(), x, y) : null;
  }


  // ---- deep space ---------------------------------------------------------------------------------------------------
  /** Camera orientation (yaw, pitch) that looks at `focus` from the Sun's side, i.e. sees the object as we see it from the Solar System. */
  private lookFromSun(focus: Vec3): { yaw: number; pitch: number } {
    const r = vlen(focus) || 1;
    return { yaw: Math.atan2(-focus[1] / r, -focus[0] / r), pitch: Math.max(-1.4, Math.min(1.4, Math.asin(-focus[2] / r))) };
  }

  /**
   * Fly to a deep-space object (galaxy, nebula, cluster ...): the focus becomes its catalogue position, the distance its
   * comfortable viewing distance (layer.viewDistancePc), and the view direction the one a viewer on the Sun's side would have
   * (the Milky Way is seen from 55 degrees above its plane). Distance is interpolated geometrically: never a teleport.
   * Sets `selectedDeep`.
   */
  flyToDeep(id: string, durationMs = 2800): void {
    if (!this.deep) throw new Error('Deep space is not attached');
    const p = this.deep.objectPositionPc(id);
    const d = this.deep.viewDistancePc(id);
    if (!p || d === undefined) throw new Error(`Deep-space object "${id}" has no position/view distance`);
    let orient: { yaw: number; pitch: number };
    if (id === 'milky-way') {
      const ngp = galacticToIcrsVector([0, 0, 1]);
      const el = (55 * Math.PI) / 180;
      const toSun = vnorm([-p[0], -p[1], -p[2]]);
      const horizontal = vnorm([toSun[0] - ngp[0] * (toSun[0] * ngp[0] + toSun[1] * ngp[1] + toSun[2] * ngp[2]), toSun[1] - ngp[1] * (toSun[0] * ngp[0] + toSun[1] * ngp[1] + toSun[2] * ngp[2]), toSun[2] - ngp[2] * (toSun[0] * ngp[0] + toSun[1] * ngp[1] + toSun[2] * ngp[2])]);
      const dir = vnorm([horizontal[0] * Math.cos(el) + ngp[0] * Math.sin(el), horizontal[1] * Math.cos(el) + ngp[1] * Math.sin(el), horizontal[2] * Math.cos(el) + ngp[2] * Math.sin(el)]);
      orient = { yaw: Math.atan2(dir[1], dir[0]), pitch: Math.asin(dir[2]) };
    } else orient = this.lookFromSun(p);
    this.selectedDeep = id;
    this.followId = null;
    this.minDistancePc = ORBIT_LIMITS.minDistance;
    const target: OrbitState = { focus: p, distance: d, yaw: orient.yaw, pitch: orient.pitch };
    this.flight = { from: this.state, start: performance.now(), duration: durationMs, thenFollow: null, to: () => target };
  }

  /** Centre of the Local Group view: the midpoint between the Milky Way's centre and M31 (a VIEW anchor, not the barycentre, which is poorly defined). */
  localGroupAnchorPc(): Vec3 {
    const gc = this.deep?.objectPositionPc('milky-way') ?? [0, 0, 0];
    const m31 = this.deep?.objectPositionPc('m31') ?? [0, 0, 0];
    return [(gc[0] + m31[0]) / 2, (gc[1] + m31[1]) / 2, (gc[2] + m31[2]) / 2];
  }

  /** Smooth flight out to the Local Group (distance ~3 Mpc), keeping the current view direction. */
  flyToLocalGroup(durationMs = 3200): void {
    this.selectedDeep = null; this.followId = null; this.minDistancePc = ORBIT_LIMITS.minDistance;
    const target: OrbitState = { focus: this.localGroupAnchorPc(), distance: LOCAL_GROUP_VIEW_PC, yaw: this.state.yaw, pitch: this.state.pitch };
    this.flight = { from: this.state, start: performance.now(), duration: durationMs, thenFollow: null, to: () => target };
  }

  /** Smooth flight out to the nearby-universe view (distance ~100 Mpc, centred on the Sun). */
  flyToNearbyUniverse(durationMs = 3600): void {
    this.selectedDeep = null; this.followId = null; this.minDistancePc = ORBIT_LIMITS.minDistance;
    const target: OrbitState = { focus: [0, 0, 0], distance: NEARBY_UNIVERSE_VIEW_PC, yaw: this.state.yaw, pitch: this.state.pitch };
    this.flight = { from: this.state, start: performance.now(), duration: durationMs, thenFollow: null, to: () => target };
  }

  /**
   * Back out one level: object -> its parent object if the data names one that can be flown to, else the Local Group view
   * (for anything within ~2 Mpc) or the nearby-universe view; from the Local Group view -> the nearby-universe view.
   */
  flyToParentDeep(): void {
    const t = this.parentDeepTarget(this.selectedDeep);
    if (t.kind === 'object') this.flyToDeep(t.id);
    else if (t.kind === 'local-group') this.flyToLocalGroup();
    else this.flyToNearbyUniverse();
  }

  /**
   * Where "back out one level" leads from the selection `sel` (null = nothing selected): its parent object, the Local Group view, or the
   * nearby-universe view. Pure decision, no flight and no selection change: the selection owner (DeepUi) applies it.
   */
  parentDeepTarget(sel: string | null): { kind: 'object'; id: string } | { kind: 'local-group' } | { kind: 'nearby' } {
    if (!this.deep) return { kind: 'nearby' };
    const parent = sel ? this.deepData?.get(sel)?.parentId : undefined;
    if (parent && parent !== sel && this.deep.objectPositionPc(parent) && this.deep.viewDistancePc(parent) !== undefined) return { kind: 'object', id: parent };
    const focus = this.state.focus;
    const nearLocalGroup = vlen(focus) < 1.5e6 && this.state.distance < 1.5e6;
    if (sel && nearLocalGroup) return { kind: 'local-group' };
    if (this.state.distance < LOCAL_GROUP_VIEW_PC * 0.7 && vlen(focus) < 2e6) return { kind: 'local-group' };
    return { kind: 'nearby' };
  }

  /** Overview flight appropriate to the current scale: the planetary overview inside the Solar System, otherwise the nearby-universe view. */
  flyToDeepOverview(): void { this.flyToNearbyUniverse(); }

  clearDeepSelection(): void { this.selectedDeep = null; }

  screenOfDeep(id: string): { x: number; y: number; r: number } | null {
    const i = this.deepScreen.get(id);
    return i && i.visible ? { x: i.x, y: i.y, r: Math.max(i.pixelRadius, 10) } : null;
  }

  /** The deep-space object under a screen position (core pick: smaller on-screen disc wins, then kind priority), or null. */
  pickDeep(x: number, y: number, opts: { readonly discoveryOnly?: boolean } = {}): string | null {
    if (this.deepScreen.size === 0) return null;
    const cands: PickCandidate[] = [];
    for (const i of this.deepScreen.values()) {
      if (!i.visible || i.pickable === false) continue;
      if (i.kind === 'selection-proxy') continue;                      // never pickable (R2b)
      // discoveryOnly: below the deep-space scale only the discovery markers (exoplanet hosts, curated 'other' objects) are candidates.
      if (opts.discoveryOnly && i.kind !== 'exoplanet-host' && i.kind !== 'other-object') continue;
      const tier = i.kind === 'exoplanet-host' || i.kind === 'other-object' ? DISCOVERY_PICK_TIERS[i.kind] : undefined;
      const region = tier ? tier.backdrop : i.kind === 'cosmic-structure' || i.kind === 'galaxy-group' || i.kind === 'galaxy-cluster';
      cands.push({ id: i.id, x: i.x, y: i.y, radiusPx: i.pixelRadius, priority: tier ? tier.priority : DEEP_PICK_PRIORITY[i.kind] ?? 0, ...(region ? { backdrop: true } : {}), ...(i.kind === 'cosmic-structure' ? { slopPx: 0 } : {}) });
    }
    return pickScreenCandidates(cands, { x, y })?.id ?? null;
  }

  // ---- frame --------------------------------------------------------------------------------------------------
  render(jdTdb: number): void {
    this.jdTdb = jdTdb;
    const st = this.state;
    if (![st.distance, st.yaw, st.pitch, ...st.focus].every(Number.isFinite) || st.distance <= 0) { console.warn('Camera state was not finite; resetting.'); this.state = DEFAULT_ORBIT; this.flight = null; }
    if (this.solarData && this.followId && !this.flight) {
      this.state = { ...this.state, focus: this.bodyHelioPc(this.followId, jdTdb) };
    }
    if (this.flight) {
      const f = this.flight;
      const t = Math.min(1, (performance.now() - f.start) / f.duration);
      this.state = interpolate(f.from, f.to(jdTdb), t);
      if (t >= 1) { this.flight = null; if (f.thenFollow) this.followId = f.thenFollow; }
    }
    const cam = cameraPosition(this.state);
    const camM = this.cameraHelioMetres();
    this.solarActive = !!this.solar && Math.hypot(camM[0], camM[1], camM[2]) < SOLAR_ACTIVE_METRES;
    const camFromSun = Math.hypot(cam[0], cam[1], cam[2]);
    // The Gaia field fades out smoothly when the camera leaves the sample volume (opaque out to 20 kpc, as before).
    const starFade = starFieldFade(camFromSun);
    this.field?.setFade(starFade);
    if (starFade > 0.001) this.field?.update(cam);
    for (const l of this.starPassLayers) { l.setFade?.(starFade); if (starFade > 0.001) l.update(cam); }
    const sp = this.sun.geometry.getAttribute('position') as THREE.BufferAttribute;
    sp.setXYZ(0, -cam[0], -cam[1], -cam[2]);
    sp.needsUpdate = true;
    this.sun.visible = !this.solarActive;
    (this.sun.material as THREE.PointsMaterial).opacity = 0.9 * (0.6 + 0.4 * starFade);

    const b = cameraBasis(this.state);
    for (const c of [this.starCamera, this.solarCamera, this.deepCamera]) { c.position.set(0, 0, 0); c.up.set(0, 0, 1); c.lookAt(b.forward[0], b.forward[1], b.forward[2]); }

    const nowMs = performance.now();
    if (this.governor && this.lastRenderAt > 0) {
      this.frameMsAvg = this.frameMsAvg === 0 ? nowMs - this.lastRenderAt : this.frameMsAvg + 0.1 * (nowMs - this.lastRenderAt - this.frameMsAvg);
      const q = this.governor.update(nowMs - this.lastRenderAt);
      if (this.deep && Math.abs(q - this.deep.getQuality()) > 0.01) this.deep.setQuality(q);
    }
    this.lastRenderAt = nowMs;

    this.renderer.info.reset();
    this.renderer.clear();

    // Pass 1: deep space (galaxies, Milky Way model, registered sub-renderers), parsec units, camera at the origin.
    if (this.deep) {
      const c = this.deepCtx;
      c.camPc = cam; c.basis = b; c.viewport = this.viewport; c.pixelRatio = this.renderer.getPixelRatio();
      c.focusDistancePc = this.state.distance;
      c.pixelsPerRadian = this.height / (2 * Math.tan((FOV_DEG * Math.PI) / 360));
      c.nowSeconds = nowMs / 1000; c.selectedId = this.selectedDeep; c.quality = this.deep.getQuality();
      this.deep.beginFrame();
      this.deepScreen = this.deep.update(c);
      this.renderer.render(this.deep.scene, this.deepCamera);
      this.deepActive = camFromSun >= DEEP_ACTIVE_FROM_PC || this.selectedDeep !== null;
      this.renderer.clearDepth();
    }

    // Pass 2: Gaia stars and the Sun marker.
    this.renderer.render(this.starScene, this.starCamera);

    // Where is the camera in the frame hierarchy? Needed whenever the Solar System or the deep-space layer is in play.
    if (this.hierarchy && (this.solarActive || this.deep)) {
      if (this.solarActive) this.hierarchy.update(jdTdb);
      const where = this.hierarchy.locate(camM, this.frame.id);
      this.frame = { id: where.frame, path: where.path };
    }

    // Pass 3: Solar System (metres), only within 3000 AU of the Sun.
    if (this.solarActive && this.solar && this.hierarchy) {
      const dist = this.state.distance * PC;
      this.solarCamera.near = Math.max(1, 0.01 * dist);
      this.solarCamera.far = 1e15;
      this.solarCamera.updateProjectionMatrix();
      this.screen = this.solar.update({
        jdTdb, camera: this.solarCamera, camHelio: camM, viewport: this.viewport, policy: this.scalePolicy,
        selectedId: this.selectedBody, nowSeconds: performance.now() / 1000, pixelRatio: this.renderer.getPixelRatio(), focusDistance: dist,
      });
      this.renderer.clearDepth();
      this.renderer.render(this.solar.scene, this.solarCamera);
    } else {
      this.screen = new Map();
    }
    this.drawCalls = this.renderer.info.render.calls;
  }

  setScaleMode(mode: 'true' | 'enhanced'): void { this.scalePolicy = mode === 'true' ? TRUE_SCALE : ENHANCED_SCALE; }

  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.onGlLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onGlRestored);
    this.field?.dispose();
    for (const l of this.starPassLayers.splice(0)) { this.starScene.remove(l.object); l.dispose(); }
    this.solar?.dispose();
    this.deep?.dispose();
    this.renderer.dispose();
  }
}
