/**
 * Nearby view model (pure): radius slider mapping, rows, same-system separation, messages.
 */
import { formatDistance } from '../../core/spatial/scale';
import { METRES_PER_AU, METRES_PER_PARSEC } from '../../core/units';
import type { AtlasNeighbour, AtlasSystemMember, NearbyOutcome } from '../../discovery/engineApi';
import { CATEGORY_LABEL, nf } from './labels';

/** Radius range of the slider: 1 AU up to what the frames support (a bound the caller computes from the facets; default 100 Mpc). */
export const MIN_RADIUS_METRES = METRES_PER_AU;
export const DEFAULT_MAX_RADIUS_METRES = 1e8 * METRES_PER_PARSEC;
export const SLIDER_STEPS = 1000;
export const NEARBY_K = 120;
export const NEARBY_WINDOW = 40;

/** t in [0, SLIDER_STEPS] -> radius in metres, logarithmic. */
export function radiusFromSlider(t: number, maxMetres: number = DEFAULT_MAX_RADIUS_METRES): number {
  const f = Math.min(1, Math.max(0, t / SLIDER_STEPS));
  const lo = Math.log10(MIN_RADIUS_METRES), hi = Math.log10(Math.max(maxMetres, MIN_RADIUS_METRES * 10));
  return Math.pow(10, lo + f * (hi - lo));
}
export function sliderFromRadius(metres: number, maxMetres: number = DEFAULT_MAX_RADIUS_METRES): number {
  const lo = Math.log10(MIN_RADIUS_METRES), hi = Math.log10(Math.max(maxMetres, MIN_RADIUS_METRES * 10));
  const f = (Math.log10(Math.max(metres, MIN_RADIUS_METRES)) - lo) / (hi - lo);
  return Math.round(Math.min(1, Math.max(0, f)) * SLIDER_STEPS);
}
export const radiusLabel = (metres: number): string => formatDistance(metres);

export interface NearbyRowVm {
  readonly key: string; readonly id: string; readonly name: string; readonly categoryLabel: string; readonly distanceText: string; readonly distanceMetres: number; readonly domain: string;
}
export interface SystemRowVm { readonly key: string; readonly id: string; readonly name: string; readonly categoryLabel: string; readonly roleText: string }
export interface NearbyVm {
  readonly ok: boolean;
  readonly message: string | null;
  readonly neighbours: readonly NearbyRowVm[];
  readonly system: readonly SystemRowVm[];
  readonly summary: string;
  /** True when the list was cut at k (more lie inside the radius). */
  readonly truncated: boolean;
}

export const rowFromNeighbour = (n: AtlasNeighbour): NearbyRowVm => ({
  key: n.id, id: n.id, name: n.name, categoryLabel: CATEGORY_LABEL[n.category] ?? n.category, distanceText: n.distanceText, distanceMetres: n.distanceMetres, domain: n.domain,
});
export const rowFromMember = (m: AtlasSystemMember): SystemRowVm => ({
  key: m.id, id: m.id, name: m.name, categoryLabel: CATEGORY_LABEL[m.category] ?? m.category, roleText: m.role === 'host' ? 'Host star of this system' : 'Planet of this system',
});

const FAIL_TEXT: Readonly<Record<string, string>> = {
  'not-ready': 'The nearby search needs the engine to finish building its spatial index. Progress is shown in the search box.',
  'unknown-id': 'This object is not in the loaded datasets.',
  'no-position': 'This object has no position in 3D (its distance is unknown), so there is nothing to measure from.',
  'no-solar-position': 'The Solar System position of this object is not available.',
  invalid: '',
};

export function buildNearbyVm(out: NearbyOutcome, ctx: { readonly originName: string; readonly radiusMetres: number; readonly k?: number }): NearbyVm {
  if (!out.ok) return { ok: false, message: FAIL_TEXT[out.error] || out.message, neighbours: [], system: [], summary: '', truncated: false };
  // The origin is never its own neighbour, and the list is sorted nearest first: enforce both here as a guard on whatever the engine returned.
  const neighbours = out.neighbours.filter((n) => n.id !== out.originId).map(rowFromNeighbour).sort((a, b) => a.distanceMetres - b.distanceMetres);
  const system = (out.system ?? []).map(rowFromMember);
  const k = ctx.k ?? NEARBY_K;
  const truncated = neighbours.length >= k;
  const within = radiusLabel(ctx.radiusMetres);
  const summary = neighbours.length === 0
    ? `Nothing else in the datasets loaded lies within ${within} of ${ctx.originName}. That is a statement about these datasets, not about the universe.`
    : truncated ? `The nearest ${nf(neighbours.length)} within ${within} of ${ctx.originName}; more lie inside this radius.` : `${nf(neighbours.length)} within ${within} of ${ctx.originName}, nearest first.`;
  return { ok: true, message: null, neighbours, system, summary, truncated };
}
