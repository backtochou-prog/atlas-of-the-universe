/**
 * ViewerNavigationHost (Prompt 07, R2a): the NavigationHost the discovery atlas drives (src/discovery/navigation.ts), implemented on the Viewer.
 * The NavigationController decides WHAT to look at; this class decides HOW CLOSE and performs the flight, using only viewer methods that already
 * interpolate (nothing here teleports the camera).
 *
 * VIEW-DISTANCE RULES (what viewDistance(record) returns; the FocusPlan carries it to focus()). They are conventions of the application, not data:
 *
 *   Solar System bodies   viewer.viewDistancePc(bodyId): a few body radii (the viewer's own rule, ring system for Saturn); flight = viewer.flyToBody, which then follows the body.
 *   Deep-space objects    deep.viewDistancePc(id) (the layer's rule per kind: galaxy 2.2x diameter, nebula / cluster 3x, group 1.5x ...); flight = viewer.flyToDeep.
 *                         The Local Group has no position of its own: flyToLocalGroup (the view anchor the layer defines).
 *   Stars, exoplanet hosts, other point objects with a 3D position
 *                         max(4 pc, 2 x sigma_d) capped at 5000 pc, where sigma_d is the published 1-sigma distance uncertainty. A star whose distance is known to +-10%
 *                         at 800 pc has sigma_d = 80 pc: flying to 4 pc of its NOMINAL position would show a neighbourhood that does not exist (the true position is
 *                         anywhere in +-sigma_d along the line of sight), so the camera stays at least two sigma away and the uncertainty stays visible in the view.
 *   Exoplanets            navigate to the HOST star's position (the planet record carries it) with the star rule, and select the planet; planets are never drawn, so a selection
 *                         proxy marks the system.
 *   Catalogue galaxies (UNGC, McConnachie, 2MRS rows with a distance)
 *                         2.2 x physical size when the row has an angular size and a distance (size = angle x distance), at least 1 kpc; otherwise 0.15 x the distance
 *                         from the Sun (never less than 10 kpc, the rule DeepUi already used). DECISION: not "30 x the nearest-neighbour spacing" - the spacing is a property of the
 *                         survey's flux limit and incompleteness, not of the galaxy, and would make the view change when the catalogue changes.
 *   2MRS rows             have a distance only when cz >= 1000 km/s (d = cz / H0, H0 = 70 an application choice; see records.ts). Below that the record is sky-only and the
 *                         host answers 'inspect-only' (a velocity of a few hundred km/s is dominated by peculiar motion and gives no distance).
 *   Sky-only records      (direction known, distance unknown): NO flight. focus() reports Placement { kind: 'inspect-only', reason: 'cannot place in 3D: distance unknown' } so
 *                         the interface can say so. The same for records with no position at all (the Local Group is handled above).
 *
 * SELECTION PROXY. A marker (viewer.setSelectionProxy) is requested when the record is not drawn at this scale (exoplanets, curated "other" objects with no drawn form, any
 * record with drawn === false) or when a star would be fainter than the viewer's magnitude limit at the view distance (apparent magnitude from the record's absolute magnitude).
 */
import type { Vec3 } from '../../core/spatial/vec3';
import { FOV_DEG, cameraBasis, cameraPosition, type OrbitState } from '../orbitCamera';
import type { CameraView, AtlasViewerPort } from '../../discovery/atlas';
import type { CameraSnapshot, FocusPlan } from '../../discovery/navigation';
import type { DiscoveryRecord, UniversalId } from '../../discovery/types';
import type { SolarBodyOffset } from '../../discovery/engineApi';
import type { HighlightItem, SelectionProxy } from './markerPort';
import type { ViewerCameraSnapshot } from '../viewer';
import { METRES_PER_PARSEC } from '../../core/units';

// ---- rules (pure, exported for tests) --------------------------------------------------------------------------------------------

export const STAR_VIEW_PC = 4;
export const STAR_VIEW_SIGMA_FACTOR = 2;
export const STAR_VIEW_MAX_PC = 5000;
export const CATALOGUE_VIEW_SIZE_FACTOR = 2.2;
export const CATALOGUE_VIEW_MIN_PC = 1000;
export const CATALOGUE_VIEW_DISTANCE_FRACTION = 0.15;
export const CATALOGUE_VIEW_FALLBACK_MIN_PC = 1e4;

export const NO_DISTANCE_REASON = 'cannot place in 3D: distance unknown';
export const NO_POSITION_REASON = 'cannot place in 3D: the object has no position of its own';

const sigmaOf = (r: DiscoveryRecord): number | undefined => {
  const p = r.position;
  const a = p.kind === 'icrs' ? p.distanceUncertaintyPc : undefined;
  const b = r.measurements.distancePc?.uncertainty;
  const v = a ?? b;
  return v !== undefined && Number.isFinite(v) && v > 0 ? v : undefined;
};

/** max(4 pc, 2 sigma_d), capped. See the header. */
export function starViewDistancePc(r: DiscoveryRecord): number {
  const s = sigmaOf(r);
  return s === undefined ? STAR_VIEW_PC : Math.min(STAR_VIEW_MAX_PC, Math.max(STAR_VIEW_PC, STAR_VIEW_SIGMA_FACTOR * s));
}

/** Catalogue galaxy: 2.2 x physical size (>= 1 kpc), else 0.15 x the distance from the Sun (>= 10 kpc). Undefined when the record has no distance. */
export function catalogueViewDistancePc(r: DiscoveryRecord): number | undefined {
  const d = r.position.kind === 'icrs' ? Math.hypot(...r.position.xyzPc) : r.measurements.distancePc?.value;
  if (d === undefined || !(d > 0)) return undefined;
  const arcmin = r.measurements.angularSizeArcmin?.value;
  if (arcmin !== undefined && arcmin > 0) {
    const sizePc = d * (arcmin / 60) * (Math.PI / 180);
    return Math.max(CATALOGUE_VIEW_MIN_PC, CATALOGUE_VIEW_SIZE_FACTOR * sizePc);
  }
  return Math.max(CATALOGUE_VIEW_FALLBACK_MIN_PC, CATALOGUE_VIEW_DISTANCE_FRACTION * d);
}

/** Apparent magnitude the record would have at `viewPc` from it, from its absolute magnitude (or apparent magnitude and distance); undefined when not computable. */
export function apparentMagAt(r: DiscoveryRecord, viewPc: number): number | undefined {
  const M = r.measurements.absoluteMag?.value;
  if (M !== undefined && Number.isFinite(M)) return M + 5 * Math.log10(viewPc) - 5;
  const m = r.measurements.apparentMag?.value, d = r.measurements.distancePc?.value;
  if (m !== undefined && d !== undefined && d > 0) return m - 5 * Math.log10(d) + 5 * Math.log10(viewPc);
  return undefined;
}

const STELLAR = new Set(['star', 'exoplanet-host', 'exoplanet']);
const CATALOGUE_DATASETS = new Set(['ungc', 'local-group-mcconnachie', 'twomrs']);

/** What happened when the host was asked to focus on a record: the interface can show `reason` when nothing moved. */
export type Placement =
  | { readonly kind: 'flight'; readonly id: UniversalId; readonly mode: 'solar-body' | 'deep-object' | 'local-group' | 'point'; readonly viewDistancePc: number | undefined; readonly targetPc?: Vec3; readonly proxy: boolean }
  | { readonly kind: 'inspect-only'; readonly id: UniversalId; readonly reason: string };

/** The members of the Viewer this host uses (a fake implements them in tests). */
export interface HostViewer {
  state: OrbitState;
  frame: { id: string };
  jdTdb: number;
  brightness: { magLimit: number };
  readonly solarData: { readonly file: { readonly bodies: readonly { readonly id: string }[] }; get(id: string): unknown } | null;
  readonly deep: { viewDistancePc(id: string): number | undefined } | null;
  readonly deepData: { get(id: string): unknown } | null;
  viewport: { width: number; height: number };
  viewDistancePc(id: string): number;
  bodyHelioPc(id: string, jd?: number): Vec3;
  flyToBody(id: string, ms?: number): void;
  flyToDeep(id: string, ms?: number): void;
  flyToLocalGroup(ms?: number): void;
  flyToPointPc(xyz: Vec3, viewDistancePc: number, ms?: number, orient?: { yaw: number; pitch: number }): boolean;
  snapshotCamera(): ViewerCameraSnapshot;
  restoreCamera(s: ViewerCameraSnapshot, ms?: number): void;
  setHighlights(items: readonly HighlightItem[]): void;
  setSelectionProxy(p: SelectionProxy | null): void;
}

export class ViewerNavigationHost implements AtlasViewerPort {
  /** The id last passed to setSelection. */
  selectedId: UniversalId | null = null;
  /** What the last focus() did (flight or inspect-only with the reason). */
  lastPlacement: Placement | null = null;
  /** Called after every focus() with the placement; the interface uses it to say "cannot place in 3D: distance unknown". */
  onPlacement: ((p: Placement) => void) | null = null;

  /**
   * @param viewer   the Viewer
   * @param resolveRecord  synchronous record lookup (the atlas record cache: atlas.peek)
   * @param ephemerisMetres  heliocentric position of a Solar System body in metres at a Julian date (viewer.solarData.ephemeris.heliocentricPosition); needed by solarBodyOffsets
   */
  constructor(
    private readonly viewer: HostViewer,
    private readonly resolveRecord: (id: UniversalId) => DiscoveryRecord | undefined,
    private readonly ephemerisMetres?: (bodyId: string, jdTdb: number) => Vec3,
  ) {}

  // ---- NavigationHost ----------------------------------------------------------------------------------------------------

  resolve(id: UniversalId): DiscoveryRecord | undefined { return this.resolveRecord(id); }
  currentFrame(): string { return this.viewer.frame.id; }

  snapshot(): CameraSnapshot {
    const s = this.viewer.snapshotCamera();
    // The extra fields (followId, selectedBody, selectedDeep) ride along on the same object so restore() can bring back the whole view.
    return { frame: s.frameId, focus: s.focus, distance: s.distance, yaw: s.yaw, pitch: s.pitch, followId: s.followId, selectedBody: s.selectedBody, selectedDeep: s.selectedDeep } as CameraSnapshot;
  }

  restore(snapshot: CameraSnapshot, ms: number): void {
    const x = snapshot as CameraSnapshot & Partial<ViewerCameraSnapshot>;
    this.viewer.restoreCamera({
      focus: snapshot.focus, distance: snapshot.distance, yaw: snapshot.yaw, pitch: snapshot.pitch, frameId: snapshot.frame,
      followId: x.followId ?? null, selectedBody: x.selectedBody ?? null, selectedDeep: x.selectedDeep ?? null,
    }, ms);
  }

  setSelection(id: UniversalId | null): void {
    this.selectedId = id;
    if (id === null) this.viewer.setSelectionProxy(null);
  }

  highlight(ids: readonly UniversalId[]): void {
    const items: HighlightItem[] = [];
    for (const id of ids) {
      const rec = this.resolveRecord(id);
      const p = rec ? this.positionOf(rec) : undefined;
      if (p && rec) items.push({ id, positionPc: p, label: rec.name });
    }
    this.viewer.setHighlights(items);
  }

  positionOf(record: DiscoveryRecord): Vec3 | undefined {
    const p = record.position;
    if (p.kind === 'icrs') return p.xyzPc.every(Number.isFinite) ? p.xyzPc : undefined;
    if (p.kind === 'solar') return this.viewer.solarData?.get(p.bodyId) ? this.viewer.bodyHelioPc(p.bodyId) : undefined;
    return undefined;
  }

  viewDistance(record: DiscoveryRecord): number | undefined {
    const p = record.position;
    if (p.kind === 'solar') return this.viewer.solarData?.get(p.bodyId) ? this.viewer.viewDistancePc(p.bodyId) : undefined;
    if (record.dataset === 'deep-space') return this.viewer.deep?.viewDistancePc(record.id.slice('deep:'.length));
    if (CATALOGUE_DATASETS.has(record.dataset)) return catalogueViewDistancePc(record);
    if (p.kind === 'icrs' && (STELLAR.has(record.category) || record.category === 'other' || record.category === 'supernova-remnant')) return starViewDistancePc(record);
    return undefined;
  }

  focus(plan: FocusPlan): void {
    const placement = this.place(plan);
    this.lastPlacement = placement;
    try { this.onPlacement?.(placement); } catch { /* a listener must not break the flight */ }
  }

  private place(plan: FocusPlan): Placement {
    const v = this.viewer;
    const rec = plan.record;
    const t = plan.target;
    const ms = plan.transitionMs;
    this.viewer.setSelectionProxy(null);
    if (t.kind === 'solar-body') {
      if (!v.solarData?.get(t.bodyId)) return { kind: 'inspect-only', id: rec.id, reason: 'the Solar System layer is not loaded' };
      v.flyToBody(t.bodyId, ms);
      return { kind: 'flight', id: rec.id, mode: 'solar-body', viewDistancePc: plan.viewDistancePc, proxy: false };
    }
    if (rec.dataset === 'deep-space') {
      const deepId = rec.id.slice('deep:'.length);
      try {
        if (deepId === 'local-group') { v.flyToLocalGroup(ms); return { kind: 'flight', id: rec.id, mode: 'local-group', viewDistancePc: undefined, proxy: false }; }
        if (v.deepData?.get(deepId)) { v.flyToDeep(deepId, ms); return { kind: 'flight', id: rec.id, mode: 'deep-object', viewDistancePc: plan.viewDistancePc, proxy: false }; }
      } catch { /* no position / view distance: fall through to the generic rules */ }
    }
    if (t.kind === 'direction') return { kind: 'inspect-only', id: rec.id, reason: NO_DISTANCE_REASON };
    if (t.kind === 'none') return { kind: 'inspect-only', id: rec.id, reason: NO_POSITION_REASON };
    const viewPc = plan.viewDistancePc ?? STAR_VIEW_PC;
    if (!v.flyToPointPc(t.xyzPc, viewPc, ms)) return { kind: 'inspect-only', id: rec.id, reason: 'the position is not a finite number' };
    // A proxy when the object is not drawn at this scale, is a curated object with no drawn form, or would be fainter than the magnitude limit at the view distance.
    let proxy = plan.proxy || rec.dataset === 'curated-other';
    if (!proxy && STELLAR.has(rec.category)) {
      const m = apparentMagAt(rec, viewPc);
      if (m !== undefined && m > v.brightness.magLimit) proxy = true;
    }
    if (proxy) {
      const reason = rec.category === 'exoplanet' ? 'Planets are not drawn; the marker shows the host star, where the planet system is.' : (plan.proxyReason ?? 'Too small or faint to see from here; the marker shows where it is.');
      const absoluteMag = rec.measurements.absoluteMag?.value, sizePc = rec.measurements.physicalSizePc?.value;
      v.setSelectionProxy({ id: rec.id, positionPc: t.xyzPc, label: rec.name, reason, ...(absoluteMag !== undefined && Number.isFinite(absoluteMag) ? { absoluteMag } : {}), ...(sizePc !== undefined && sizePc > 0 ? { sizePc } : {}) });
    }
    return { kind: 'flight', id: rec.id, mode: 'point', viewDistancePc: viewPc, targetPc: t.xyzPc, proxy };
  }

  // ---- AtlasViewerPort ---------------------------------------------------------------------------------------------------------

  cameraFocusPc(): Vec3 { return this.viewer.state.focus; }

  cameraView(): CameraView {
    const b = cameraBasis(this.viewer.state);
    const vp = this.viewer.viewport;
    return { positionPc: cameraPosition(this.viewer.state), forward: b.forward, up: b.up, fovYDeg: FOV_DEG, aspect: vp.width / vp.height };
  }

  solarBodyOffsets(): readonly SolarBodyOffset[] {
    const data = this.viewer.solarData;
    if (!data || !this.ephemerisMetres) return [];
    const out: SolarBodyOffset[] = [];
    for (const b of data.file.bodies) {
      const m = this.ephemerisMetres(b.id, this.viewer.jdTdb);
      out.push({ id: `solar:${b.id}`, offsetMetres: [m[0], m[1], m[2]] });
    }
    return out;
  }

  /** Distance from the Sun of a heliocentric parsec position, metres (helper for the interface). */
  static metresFromSun(p: Vec3): number { return Math.hypot(p[0], p[1], p[2]) * METRES_PER_PARSEC; }
}
