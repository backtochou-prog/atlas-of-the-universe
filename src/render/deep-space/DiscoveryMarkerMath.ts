/**
 * Pure helpers of the discovery markers (exoplanet hosts, curated other objects, highlights, selection proxy). No THREE, no DOM.
 *
 * VISUAL CHOICES (documented, not astronomy):
 *  - Host halos are sized and dimmed by DISTANCE FROM THE CAMERA only (log-smooth between 5 pc and 5 kpc): a host 12 pc away is a clearer
 *    halo than one 4 kpc away. The NUMBER OF PLANETS does not set the size. A host with more than one known planet gets a slightly stronger
 *    marker (radius x1.12, opacity x1.25, capped): a display choice so that multi-planet systems stand out a little, not a measure of anything.
 *  - Hosts without a distance in the archive are not drawn (their position on the sky is known, their place in space is not); they are counted.
 *  - The curated other objects are small and faint on purpose (they are single points at their catalogue positions).
 */
import { equatorialToUnit } from '../../core/astro/coordinates';
import { lengthToParsecs } from '../../core/deepspace/geometry';
import type { Vec3 } from '../../core/spatial/vec3';
import type { ExoplanetFile, OtherObjectsFile } from '../../discovery/types';
import { logSmoothstep } from './DeepSpaceLOD';

export const HOST_ID_PREFIX = 'host:';
export const OTHER_ID_PREFIX = 'other:';

export const hostId = (hostname: string): string => `${HOST_ID_PREFIX}${hostname}`;
export const isHostId = (id: string): boolean => id.startsWith(HOST_ID_PREFIX);
export const isOtherId = (id: string): boolean => id.startsWith(OTHER_ID_PREFIX);

/** Hosts are closer than this (camera distance, pc) = full strength; farther than HOST_FAR_PC = weakest. */
export const HOST_NEAR_PC = 5;
export const HOST_FAR_PC = 5000;
export const HOST_RADIUS_NEAR_PX = 5;
export const HOST_RADIUS_FAR_PX = 2.4;
export const HOST_ALPHA_NEAR = 0.55;
export const HOST_ALPHA_FAR = 0.24;
export const HOST_MULTI_RADIUS = 1.12;
export const HOST_MULTI_ALPHA = 1.25;
export const HOST_MAX_ALPHA = 0.8;
/** Screen infos are emitted for at most this many (nearest to the camera) on-screen hosts per frame. */
export const HOST_MAX_INFOS = 300;
/** A host halo's pixelRadius in its screen info stays below the label-candidate threshold of 5 px used by the deep UI. */
export const HOST_INFO_MAX_RADIUS_PX = 4.5;

export interface MarkerStyle { radiusPx: number; alpha: number }

/** Style of a host halo at camera distance `distPc` (pc) with `nPlanets` known planets (null/undefined = unknown, treated as 1). Allocation-free: fills `out`. */
export function hostStyle(distPc: number, nPlanets: number | null | undefined, out: MarkerStyle = { radiusPx: 0, alpha: 0 }): MarkerStyle {
  const t = logSmoothstep(Math.max(distPc, 1e-9), HOST_NEAR_PC, HOST_FAR_PC);
  let r = HOST_RADIUS_NEAR_PX + (HOST_RADIUS_FAR_PX - HOST_RADIUS_NEAR_PX) * t;
  let a = HOST_ALPHA_NEAR + (HOST_ALPHA_FAR - HOST_ALPHA_NEAR) * t;
  if (nPlanets !== null && nPlanets !== undefined && nPlanets > 1) { r *= HOST_MULTI_RADIUS; a = Math.min(HOST_MAX_ALPHA, a * HOST_MULTI_ALPHA); }
  out.radiusPx = r; out.alpha = a;
  return out;
}

/** Opacity of host markers vs the camera's distance from the Sun: 1 out to 20 kpc, 0 at 200 kpc (the same fade as the Gaia star field). */
export function hostsFade(camFromSunPc: number): number {
  return 1 - logSmoothstep(Math.max(camFromSunPc, 1e-9), 20_000, 200_000);
}

// ---- exoplanet host table ----------------------------------------------------------------------------------------------------------

export interface HostTable {
  /** Drawn hosts, sorted by distance from the Sun (ascending) so that a reduced-quality draw keeps the nearest. */
  readonly count: number;
  readonly names: readonly string[];
  readonly ids: readonly string[];
  /** Sun-centred ICRS pc, float64, xyz interleaved. */
  readonly positionPc: Float64Array;
  readonly distancePc: Float64Array;
  readonly nPlanets: Int16Array;
  /** Hosts in the file with no usable distance (sky-only: not drawn). */
  readonly skyOnly: number;
  /** Hosts in the file. */
  readonly total: number;
  /** id -> index into the arrays. */
  readonly indexOf: ReadonlyMap<string, number>;
}

const fin = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function buildHostTable(hosts: ExoplanetFile['hosts']): HostTable {
  const name = hosts['hostname'] ?? [], ra = hosts['raDeg'] ?? [], dec = hosts['decDeg'] ?? [], dist = hosts['distPc'] ?? [], np = hosts['nPlanets'] ?? [];
  const rows: { name: string; ra: number; dec: number; d: number; n: number }[] = [];
  const seen = new Set<string>();
  let skyOnly = 0, total = 0;
  for (let i = 0; i < name.length; i++) {
    const nm = name[i];
    if (typeof nm !== 'string' || nm.length === 0 || seen.has(nm)) continue;
    seen.add(nm);
    total++;
    const r = fin(ra[i]), d = fin(dec[i]), ds = fin(dist[i]);
    if (r === null || d === null || ds === null || !(ds > 0)) { skyOnly++; continue; }
    rows.push({ name: nm, ra: r, dec: d, d: ds, n: fin(np[i]) ?? 0 });
  }
  rows.sort((a, b) => a.d - b.d || (a.name < b.name ? -1 : 1));
  const count = rows.length;
  const positionPc = new Float64Array(count * 3), distancePc = new Float64Array(count), nPlanets = new Int16Array(count);
  const names: string[] = [], ids: string[] = [], indexOf = new Map<string, number>();
  for (let k = 0; k < count; k++) {
    const r = rows[k]!;
    const u = equatorialToUnit(r.ra, r.dec);
    positionPc[3 * k] = u[0] * r.d; positionPc[3 * k + 1] = u[1] * r.d; positionPc[3 * k + 2] = u[2] * r.d;
    distancePc[k] = r.d; nPlanets[k] = r.n;
    names.push(r.name); ids.push(hostId(r.name)); indexOf.set(hostId(r.name), k);
  }
  return { count, names, ids, positionPc, distancePc, nPlanets, skyOnly, total, indexOf };
}

// ---- other objects --------------------------------------------------------------------------------------------------------------------

export interface OtherMarker { readonly id: string; readonly name: string; readonly xyzPc: Vec3; readonly distancePc: number; readonly classification: string }

export function buildOtherMarkers(file: OtherObjectsFile): { markers: OtherMarker[]; skyOnly: number } {
  const markers: OtherMarker[] = [];
  let skyOnly = 0;
  for (const o of file.objects) {
    if (typeof o.id !== 'string' || !isOtherId(o.id) || !Number.isFinite(o.raDeg) || !Number.isFinite(o.decDeg)) continue;
    let d: number | null = null;
    if (o.distance) { try { d = lengthToParsecs(o.distance.value, o.distance.unit); } catch { d = null; } }
    if (d === null || !(d > 0)) { skyOnly++; continue; }
    const u = equatorialToUnit(o.raDeg, o.decDeg);
    markers.push({ id: o.id, name: o.name, xyzPc: [u[0] * d, u[1] * d, u[2] * d], distancePc: d, classification: o.classification });
  }
  return { markers, skyOnly };
}

export const OTHER_RADIUS_PX = 3.2;
export const OTHER_ALPHA = 0.42;
/** Other objects never pass below this fraction of their opacity at distance (so a far object stays findable), and fade out only inside this camera distance (pc). */
export const OTHER_MIN_CAMERA_PC = 1e-3;

// ---- selection proxy ------------------------------------------------------------------------------------------------------------------------

export interface SelectionItem {
  readonly id: string;
  readonly xyzPc: Vec3 | null;
  readonly label?: string;
  /** Physical radius of the object, pc (extended objects): the proxy is hidden when it spans >= SELECTION_VISIBLE_PX on screen. */
  readonly sizePc?: number;
  /** Absolute magnitude (stars): the proxy is hidden when the star would be drawn clearly (apparent magnitude from the camera <= magLimit - 0.5). */
  readonly absoluteMag?: number;
}
export const SELECTION_VISIBLE_PX = 6;
export const SELECTION_MAG_MARGIN = 0.5;

/**
 * Would the selected record already be visible at this scale by its own drawing? (true = no proxy.)
 * With neither `sizePc` nor `absoluteMag` nothing is known about how the record is drawn, so the proxy is shown.
 */
export function isOtherwiseVisible(item: SelectionItem, camDistancePc: number, pxPerRadian: number, magLimit: number): boolean {
  const d = Math.max(camDistancePc, 1e-9);
  if (item.sizePc !== undefined && Number.isFinite(item.sizePc) && (item.sizePc / d) * pxPerRadian >= SELECTION_VISIBLE_PX) return true;
  if (item.absoluteMag !== undefined && Number.isFinite(item.absoluteMag) && item.absoluteMag + 5 * Math.log10(d) - 5 <= magLimit - SELECTION_MAG_MARGIN) return true;
  return false;
}

// ---- pick tiers for the viewer ------------------------------------------------------------------------------------------------------------

/**
 * Suggested core pick() tier for each discovery kind (the viewer maps DeepScreenInfo -> PickCandidate):
 *  exoplanet-host   priority 0 and `backdrop: true`: a host halo is only picked when no galaxy / nebula / cluster is hit (it never steals a click).
 *  other-object     priority 1, a normal candidate (a tiny disc wins where it overlaps a big region, like a nebula inside a galaxy).
 *  selection-proxy  never pickable (pickable: false is set on its infos).
 */
export const DISCOVERY_PICK_TIERS: Readonly<Record<'exoplanet-host' | 'other-object' | 'selection-proxy', { priority: number; backdrop: boolean }>> = {
  'exoplanet-host': { priority: 0, backdrop: true },
  'other-object': { priority: 1, backdrop: false },
  'selection-proxy': { priority: 0, backdrop: false },
};

// ---- k-th smallest (quickselect) -----------------------------------------------------------------------------------------------------------

/** The k-th smallest (0-based) value of a[0..n); reorders a[0..n). Allocation-free. */
export function kthSmallest(a: Float32Array, n: number, k: number): number {
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1]!;
    let i = lo, j = hi;
    while (i <= j) {
      while (a[i]! < pivot) i++;
      while (a[j]! > pivot) j--;
      if (i <= j) { const t = a[i]!; a[i] = a[j]!; a[j] = t; i++; j--; }
    }
    if (k <= j) hi = j; else if (k >= i) lo = i; else return a[k]!;
  }
  return a[k]!;
}
