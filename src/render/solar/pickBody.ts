import type { BodyScreenInfo } from './solarLayer';

/** Extra pixels around a drawn disc that still count as a hit. */
export const SPHERE_HIT_MARGIN = 6;
/** Hit radius for a body drawn as a marker (a marker carries no size, so the target is generous). */
export const MARKER_HIT_RADIUS = 12;

/**
 * The Solar System body under a screen position. A body drawn as a sphere is hit within its disc plus a margin; a
 * marker within a fixed radius. When discs overlap (a moon in front of its planet) the NEARER body wins, then the
 * closer centre.
 */
export function pickBodyAt(bodies: Iterable<BodyScreenInfo>, x: number, y: number): string | null {
  let best: { id: string; score: number } | null = null;
  for (const b of bodies) {
    if (!b.visible) continue;
    const hit = b.asSphere ? b.pixelRadius + SPHERE_HIT_MARGIN : MARKER_HIT_RADIUS;
    const d = Math.hypot(b.x - x, b.y - y);
    if (d > hit) continue;
    const score = b.distance * 1e-3 + d;
    if (!best || score < best.score) best = { id: b.id, score };
  }
  return best?.id ?? null;
}
