export interface ZoomLimits {
  /** Closest allowed distance to the focus target (e.g. just above a surface), metres. */
  minDistance: number;
  /** Farthest allowed distance (e.g. the extent of the current context), metres. */
  maxDistance: number;
}

/**
 * Exponential (logarithmic) zoom: each wheel notch changes distance by a constant FACTOR,
 * so one gesture feels the same at 1 km and at 1 Mpc. `delta` > 0 zooms out, < 0 zooms in.
 */
export function zoomDistance(distance: number, delta: number, limits: ZoomLimits, k = 0.0015): number {
  const next = distance * Math.exp(delta * k);
  return Math.min(limits.maxDistance, Math.max(limits.minDistance, next));
}

/** Decades of scale between two distances, for scale-bar and transition logic. */
export const decadesBetween = (a: number, b: number): number => Math.abs(Math.log10(a / b));
