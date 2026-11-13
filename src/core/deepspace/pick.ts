/**
 * Screen-space picking. Pure.
 *
 * A candidate is a disc on screen: centre (x, y) in CSS px and an on-screen radius in px.
 * An object smaller than MIN_HIT_RADIUS_PX is still pickable (its hit radius is raised to the minimum), so distant
 * galaxies shown as dots can be clicked.
 *
 * Rule, in order (first difference decides):
 *   0. backdrop   a candidate flagged `backdrop` (a huge region disc: the 2MRS survey volume, a group ring) is only picked when NO real
 *                 candidate is hit or within slop; it never steals a pick from a galaxy, nebula, cluster or catalogue point.
 *   1. class      cursor inside the (minimum-raised) disc  beats  cursor only within `slopPx` outside it.
 *   2. size       the SMALLER on-screen radius wins. This is what makes a nebula inside a galaxy-sized region pickable:
 *                 where discs overlap, the smallest disc containing the cursor is the most specific object.
 *                 Radii closer than 1 px count as equal.
 *   3. priority   higher `priority` wins (default 0).
 *   4. closeness  smaller distance/radius (the cursor is nearer the centre in relative terms).
 *   5. id         lexicographic, so the result is deterministic.
 */
export interface PickCandidate {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly radiusPx: number;
  readonly priority?: number;
  readonly pickable?: boolean;
  /** A region/backdrop disc: lowest tier, see rule 0. */
  readonly backdrop?: boolean;
  /** Overrides the slop for this candidate (0 = only 'inside' counts). */
  readonly slopPx?: number;
}
export interface PickResult { readonly id: string; readonly kind: 'inside' | 'near'; readonly distancePx: number }

export const MIN_HIT_RADIUS_PX = 8;
export const DEFAULT_SLOP_PX = 6;

export function pick(candidates: readonly PickCandidate[], cursor: { x: number; y: number }, opts: { slopPx?: number; minHitRadiusPx?: number } = {}): PickResult | null {
  const slop = opts.slopPx ?? DEFAULT_SLOP_PX;
  const minR = opts.minHitRadiusPx ?? MIN_HIT_RADIUS_PX;
  interface Hit { c: PickCandidate; r: number; d: number; cls: 0 | 1; bg: 0 | 1 }
  const hits: Hit[] = [];
  for (const c of candidates) {
    if (c.pickable === false) continue;
    if (![c.x, c.y, c.radiusPx].every(Number.isFinite)) continue;
    const r = Math.max(c.radiusPx, minR);
    const d = Math.hypot(cursor.x - c.x, cursor.y - c.y);
    const bg = c.backdrop ? 1 : 0;
    if (d <= r) hits.push({ c, r, d, cls: 0, bg });
    else if (d <= r + (c.slopPx ?? slop)) hits.push({ c, r, d, cls: 1, bg });
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => {
    if (a.bg !== b.bg) return a.bg - b.bg;
    if (a.cls !== b.cls) return a.cls - b.cls;
    if (Math.abs(a.r - b.r) >= 1) return a.r - b.r;
    const pa = a.c.priority ?? 0, pb = b.c.priority ?? 0;
    if (pa !== pb) return pb - pa;
    const ra = a.d / a.r, rb = b.d / b.r;
    if (ra !== rb) return ra - rb;
    return a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0;
  });
  const h = hits[0] as Hit;
  return { id: h.c.id, kind: h.cls === 0 ? 'inside' : 'near', distancePx: h.d };
}

/**
 * An object is pickable only if it is actually visible: its draw weight (the largest of its marker / glow / image weights, each already
 * multiplied by the distance fade) must exceed this. 0.05 = a 5% opacity layer, about the faintest thing a viewer can notice;
 * below it an object is drawn but not clickable, so a click never selects something the user cannot see.
 */
export const MIN_PICKABLE_DRAW_WEIGHT = 0.05;
export function isPickableWeight(drawWeight: number): boolean { return Number.isFinite(drawWeight) && drawWeight > MIN_PICKABLE_DRAW_WEIGHT; }
