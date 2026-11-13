/**
 * Level-of-detail policy. Pure: no DOM, no Three.js, no clocks. Callers pass in what they measured.
 *
 * Representation levels, coarse to fine:
 *   0 point   a dot / marker (object too small to show structure)
 *   1 sprite  a flat textured billboard from the smallest image level
 *   2 image   the full textured plane (or deprojected disc) with the level chosen by selectTextureLevel
 *   3 detail  members, volumetric or model detail (only when the object's physical size is known)
 *
 * Two outputs are kept apart so nothing pops and nothing flickers:
 *   - `level`: the DISCRETE primary level, switched with HYSTERESIS (up at the threshold, down only after falling to
 *     DOWN_FACTOR * threshold). Resources are loaded for it.
 *   - `lower`/`upper`/`weight`: a CONTINUOUS crossfade between two adjacent levels, a pure smooth function of the
 *     apparent size (log-space smoothstep over [threshold/F, threshold*F]). Opacity follows this, so nothing pops.
 * Invariant (tested): level is always lower or upper, because DOWN_FACTOR (0.75) > 1/F (0.667).
 */
export const REPRESENTATIONS = ['point', 'sprite', 'image', 'detail'] as const;
export type RepresentationName = (typeof REPRESENTATIONS)[number];

/** Apparent diameter (CSS px) at which the next level takes over, going up. */
export const LEVEL_UP_PX: readonly number[] = [6, 48, 600];
/** Going down, a level is kept until apparent size < DOWN_FACTOR * the threshold that entered it. */
export const DOWN_FACTOR = 0.75;
/** Half-width of the crossfade band in log space (multiplicative). Must satisfy 1/FADE_FACTOR < DOWN_FACTOR. */
export const FADE_FACTOR = 1.5;

export interface LodInput {
  /** Apparent on-screen diameter in CSS pixels. */
  readonly apparentPixels: number;
  /** Physical diameter, metres. Unknown size => the object cannot go beyond 'sprite' (no scale to draw detail at). */
  readonly physicalSizeMetres?: number;
  /** Distance from the camera to the object centre, metres. */
  readonly distance: number;
  /** Previous discrete level (0..3) for hysteresis. */
  readonly previousLevel?: number;
}

export interface LodResult {
  readonly level: number;
  readonly name: RepresentationName;
  readonly lower: number;
  readonly upper: number;
  /** Opacity of `upper` in the crossfade (0 = only lower, 1 = only upper). lower === upper => weight 0. */
  readonly weight: number;
  /** The camera is inside the object's extent: detail is forced (e.g. the Milky Way from the Sun). */
  readonly inside: boolean;
}

const smooth = (t: number) => { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x); };

/** Continuous level in [0, 3]: sum over thresholds of a smoothstep in log(px). Monotonic non-decreasing in px. */
export function continuousLevel(apparentPixels: number): number {
  if (!(apparentPixels > 0)) return 0;
  let l = 0;
  for (const t of LEVEL_UP_PX) l += smooth(Math.log(apparentPixels / (t / FADE_FACTOR)) / Math.log(FADE_FACTOR * FADE_FACTOR));
  return l;
}

export function selectRepresentation(input: LodInput): LodResult {
  const { apparentPixels, physicalSizeMetres, distance, previousLevel } = input;
  if (!(distance > 0) || !Number.isFinite(distance)) throw new RangeError('distance must be positive and finite');
  if (!Number.isFinite(apparentPixels) || apparentPixels < 0) throw new RangeError('apparentPixels must be finite and >= 0');
  const maxLevel = physicalSizeMetres === undefined || !(physicalSizeMetres > 0) ? 1 : 3;
  const inside = physicalSizeMetres !== undefined && physicalSizeMetres > 0 && distance < physicalSizeMetres / 2;

  // Discrete level with hysteresis.
  let level = previousLevel !== undefined && Number.isInteger(previousLevel) ? Math.min(Math.max(previousLevel, 0), 3) : 0;
  if (previousLevel === undefined) {
    while (level < 3 && apparentPixels >= (LEVEL_UP_PX[level] as number)) level++;
  } else {
    while (level < 3 && apparentPixels >= (LEVEL_UP_PX[level] as number)) level++;
    while (level > 0 && apparentPixels < (LEVEL_UP_PX[level - 1] as number) * DOWN_FACTOR) level--;
  }
  level = Math.min(level, maxLevel);

  let cont = Math.min(continuousLevel(apparentPixels), maxLevel);
  if (inside) { level = 3; cont = 3; }
  const lower = Math.min(Math.floor(cont), 3);
  const upper = Math.min(lower + 1, 3, maxLevel);
  const weight = upper === lower ? 0 : cont - lower;
  // The invariant can be broken only by the maxLevel clamp (both ends are clamped alike) -> keep level inside [lower, upper].
  const clamped = Math.min(Math.max(level, lower), Math.max(upper, lower));
  return { level: clamped, name: REPRESENTATIONS[clamped] as RepresentationName, lower, upper, weight, inside };
}

// ---- texture levels ------------------------------------------------------------------------------------------------

/**
 * Index of the texture level to use. `levelSizesPx` = the larger side of each level, strictly increasing (level 0 first).
 * Needed resolution = onScreenPx * devicePixelRatio * qualityScale. Chooses the SMALLEST level whose size >= needed
 * (never a larger one than necessary); if even the largest is too small, the largest. Level 0 is the floor.
 * Monotonic non-decreasing in onScreenPx. `qualityScale` in (0, 1] cuts resolution when the governor asks for it.
 */
export function selectTextureLevel(levelSizesPx: readonly number[], onScreenPx: number, devicePixelRatio = 1, qualityScale = 1): number {
  if (levelSizesPx.length === 0) throw new RangeError('no texture levels');
  for (let i = 1; i < levelSizesPx.length; i++) {
    if (!((levelSizesPx[i] as number) > (levelSizesPx[i - 1] as number))) throw new RangeError('texture level sizes must be strictly increasing');
  }
  const q = Math.min(1, Math.max(0.05, qualityScale));
  const needed = Math.max(0, onScreenPx) * Math.max(0.5, devicePixelRatio) * q;
  for (let i = 0; i < levelSizesPx.length; i++) if ((levelSizesPx[i] as number) >= needed) return i;
  return levelSizesPx.length - 1;
}

// ---- adaptive quality governor -------------------------------------------------------------------------------------

export interface GovernorOptions {
  /** Target frame time, ms (e.g. 1000/45). */
  readonly targetMs: number;
  /** EMA smoothing, 0..1 (default 0.1). */
  readonly emaAlpha?: number;
  /** Dead band either side of the target, fraction (default 0.15): no change inside it, which prevents oscillation. */
  readonly tolerance?: number;
  /** Multiplicative drop per update while over budget (default 0.03). */
  readonly downRate?: number;
  /** Additive recovery per update while under budget (default 0.002: ~15x slower than the drop). */
  readonly upRate?: number;
  readonly minScale?: number;
}

/**
 * Frame-time EMA -> quality scale in (0, 1]. Drops quickly when over budget, recovers slowly when comfortably under it,
 * holds inside the dead band. A single hitch is clamped to 2x target so it cannot slam the quality down alone.
 * No clock: the caller feeds frame durations. Not a GPU measurement; it only reacts to whatever frame times it is given.
 */
export class QualityGovernor {
  private readonly o: Required<GovernorOptions>;
  private ema: number;
  private q = 1;
  constructor(opts: GovernorOptions) {
    if (!(opts.targetMs > 0)) throw new RangeError('targetMs must be positive');
    this.o = { emaAlpha: 0.1, tolerance: 0.15, downRate: 0.03, upRate: 0.002, minScale: 0.25, ...opts };
    this.ema = opts.targetMs;
  }
  update(frameMs: number): number {
    if (!Number.isFinite(frameMs) || frameMs < 0) return this.q;
    const sample = Math.min(frameMs, this.o.targetMs * 2);
    this.ema += this.o.emaAlpha * (sample - this.ema);
    if (this.ema > this.o.targetMs * (1 + this.o.tolerance)) this.q = Math.max(this.o.minScale, this.q * (1 - this.o.downRate));
    else if (this.ema < this.o.targetMs * (1 - this.o.tolerance)) this.q = Math.min(1, this.q + this.o.upRate);
    return this.q;
  }
  get scale(): number { return this.q; }
  get frameMsEma(): number { return this.ema; }
  reset(): void { this.q = 1; this.ema = this.o.targetMs; }
}
