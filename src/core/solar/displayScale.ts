/**
 * Display scale: how large a body is DRAWN, as opposed to how large it IS.
 *
 * Physical radii live in the dataset and are never modified. This module only decides the radius of the sphere that
 * is rendered. In 'true' mode the two are identical. In 'enhanced' mode small distant bodies are enlarged so they
 * remain visible, subject to two limits so the picture does not lie about spatial relationships:
 *  - an enlarged body may not grow past a fraction of the clearance around it (for example Earth is not made larger
 *    than a fraction of its Moon's orbit), and
 *  - the enlargement factor is capped.
 * Orbits and positions are NEVER altered by display scale.
 */
export interface ScalePolicy {
  readonly mode: 'true' | 'enhanced';
  /** Smallest apparent angular radius (radians) an enhanced body is given. */
  readonly minAngularRadius: number;
  /** Largest fraction of the clearance an enhanced body may occupy. */
  readonly capFraction: number;
  /** Hard cap on the enlargement factor. */
  readonly maxFactor: number;
}

export const TRUE_SCALE: ScalePolicy = { mode: 'true', minAngularRadius: 0, capFraction: 0, maxFactor: 1 };
export const ENHANCED_SCALE: ScalePolicy = { mode: 'enhanced', minAngularRadius: 0.004, capFraction: 0.2, maxFactor: 400 };

/**
 * Radius to draw (metres).
 * @param physical        true radius, metres
 * @param cameraDistance  distance from the camera to the body, metres
 * @param clearance       distance to the nearest neighbour the enlarged body must not engulf, metres (Infinity if none)
 */
export function displayRadius(physical: number, cameraDistance: number, clearance: number, policy: ScalePolicy): number {
  if (!(physical > 0)) throw new Error('Physical radius must be positive');
  if (policy.mode === 'true' || !(cameraDistance > 0)) return physical;
  const wanted = policy.minAngularRadius * cameraDistance;
  const cap = Math.min(policy.capFraction * clearance, policy.maxFactor * physical);
  return Math.max(physical, Math.min(wanted, cap));
}

/** Enlargement factor (>= 1). */
export const exaggeration = (physical: number, display: number): number => display / physical;

/** Human-readable scale statement for the interface. */
export function describeScale(policy: ScalePolicy, maxFactorInView: number, who?: string): { label: string; notToScale: boolean } {
  if (policy.mode === 'true' || maxFactorInView < 1.05) return { label: 'Body sizes: true scale', notToScale: false };
  const f = maxFactorInView >= 100 ? Math.round(maxFactorInView) : maxFactorInView.toPrecision(2);
  return { label: `Body sizes NOT to scale: ${who ? `${who} enlarged` : 'enlarged'} up to \u00d7${f} (orbits and distances are true)`, notToScale: true };
}

/** A sphere smaller than this many pixels is drawn as a marker instead, which carries no size information. */
export const MARKER_PIXEL_RADIUS = 1.5;
export const projectedPixelRadius = (radius: number, distance: number, halfTanFov: number, viewportHeight: number): number =>
  (radius / Math.max(distance, radius)) / halfTanFov * (viewportHeight / 2);
