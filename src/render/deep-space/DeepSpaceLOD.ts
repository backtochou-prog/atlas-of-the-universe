import { selectRepresentation } from '../../core/deepspace/lod';

/**
 * Thin adapter over core/deepspace/lod.ts for objects drawn as marker -> glow -> image.
 * Maps the core levels (0 point, 1 sprite, 2 image, 3 detail) to three representations and returns crossfade weights that
 * are a smooth function of the apparent size, so nothing pops. The discrete `level` (with hysteresis) is for resource
 * decisions; the weights are for opacity. Pure.
 */
export type Stage = 'marker' | 'glow' | 'image';

export interface ObjectLod {
  /** Weights of the three representations. They add to 1 (the crossfade is energy-conserving in weight, not in flux). */
  readonly marker: number;
  readonly glow: number;
  readonly image: number;
  /** Discrete primary stage (hysteresis applied). */
  readonly stage: Stage;
  /** Discrete core level, to be fed back as `previousLevel`. */
  readonly level: number;
}

export interface ObjectLodInput {
  readonly apparentDiameterPx: number;
  readonly distanceMetres: number;
  /** Physical diameter, metres. Unknown => the object cannot go beyond the glow stage. */
  readonly physicalSizeMetres?: number;
  readonly previousLevel?: number;
  /** False when the object has no image/model to show: the glow is the largest stage. */
  readonly hasDetail?: boolean;
}

const STAGES: readonly Stage[] = ['marker', 'glow', 'image', 'image'];

export function objectLod(i: ObjectLodInput): ObjectLod {
  const r = selectRepresentation({
    apparentPixels: i.apparentDiameterPx, distance: i.distanceMetres,
    ...(i.physicalSizeMetres !== undefined ? { physicalSizeMetres: i.physicalSizeMetres } : {}),
    ...(i.previousLevel !== undefined ? { previousLevel: i.previousLevel } : {}),
  });
  let w0 = 0, w1 = 0, w2 = 0;
  const add = (lv: number, w: number) => { if (lv <= 0) w0 += w; else if (lv === 1) w1 += w; else w2 += w; };
  add(r.lower, 1 - r.weight);
  add(r.upper, r.weight);
  if (i.hasDetail === false) { w1 += w2; w2 = 0; }
  const stage = i.hasDetail === false && r.level >= 2 ? 'glow' : STAGES[r.level] as Stage;
  return { marker: w0, glow: w1, image: w2, stage, level: r.level };
}

/** Smooth 0..1 ramp in log space between lo and hi (both > 0). */
export function logSmoothstep(x: number, lo: number, hi: number): number {
  if (!(x > 0)) return 0;
  const t = Math.min(1, Math.max(0, (Math.log(x) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))));
  return t * t * (3 - 2 * t);
}

/** Marker opacity from an apparent magnitude: brighter = more opaque. A VISUAL mapping, not photometry. */
export function markerAlpha(apparentMag: number | undefined, fallback = 0.55): number {
  if (apparentMag === undefined || !Number.isFinite(apparentMag)) return fallback;
  return Math.min(1, Math.max(0.2, 0.24 + 0.1 * (11 - apparentMag)));
}

export interface GovernorReport {
  readonly enabled: boolean;
  /** Current deep-layer quality scale, 0.25..1. */
  readonly quality: number;
  /** Smoothed frame time the governor reacts to (ms) and its target. */
  readonly frameMs: number;
  readonly targetMs: number;
  readonly state: 'off' | 'full' | 'reducing' | 'holding' | 'recovering';
  /** One line for the HUD that says why the quality is what it is. */
  readonly reason: string;
}

/**
 * Plain-language reason for the governor's current quality (mirrors the dead band of core QualityGovernor: +-15 % around the target).
 * The frame time is whatever the browser reports, including software rendering: this is never a GPU measurement.
 */
export function describeGovernor(enabled: boolean, quality: number, governorMs: number, targetMs: number, shownMs: number = governorMs): GovernorReport {
  // The governor clamps each sample to 2x the target, so its own average cannot exceed that: the decision uses it, the text shows the unclamped average.
  const frameMs = governorMs;
  if (!enabled) return { enabled, quality, frameMs, targetMs, state: 'off', reason: 'adaptive quality off' };
  const ms = `${shownMs.toFixed(0)} ms`, tg = `${targetMs.toFixed(0)} ms`;
  if (frameMs > targetMs * 1.15) return { enabled, quality, frameMs, targetMs, state: 'reducing', reason: quality <= 0.251 ? `at the floor: frames take ${ms}, target ${tg} (slow renderer or busy machine)` : `lowering detail: frames take ${ms}, target ${tg}` };
  if (quality >= 0.995) return { enabled, quality, frameMs, targetMs, state: 'full', reason: `full detail: frames take ${ms}, target ${tg}` };
  if (frameMs < targetMs * 0.85) return { enabled, quality, frameMs, targetMs, state: 'recovering', reason: `recovering: frames take ${ms}, under the ${tg} target` };
  return { enabled, quality, frameMs, targetMs, state: 'holding', reason: `holding: frames take ${ms}, near the ${tg} target` };
}
