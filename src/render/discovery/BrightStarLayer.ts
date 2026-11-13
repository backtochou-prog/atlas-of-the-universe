/**
 * The Hipparcos bright-star supplement as a StarPassLayer (Viewer.addStarPassLayer). Which stars, how they are placed and why: brightStarSet.ts.
 * Drawing REUSES the Gaia star field (render/starfield.ts StarField: one draw call, camera-relative float64 -> float32 subtraction, the shared brightness
 * shader with uFade / magnitude limit / pixel ratio) and the shared screen picker (render/picking.ts pickStar), so a Hipparcos star and a Gaia star of the
 * same magnitude look and click the same.
 */
import { DEFAULT_BRIGHTNESS, type BrightnessParams } from '../brightness';
import type { Basis } from '../orbitCamera';
import { pickStar, projectToScreen } from '../picking';
import { StarField } from '../starfield';
import type { Vec3 } from '../../core/spatial/vec3';
import type { BrightStarFile } from '../../discovery/types';
import { buildBrightStarSet, type BrightStarSet, type PlacedBrightStar } from './brightStarSet';
import type { StarPassLayer } from './types';

export const BRIGHT_PICK_RADIUS_PX = 12;

export class BrightStarLayer implements StarPassLayer {
  readonly name = 'hipparcos-bright-stars';
  readonly object: StarField['object'];
  readonly set: BrightStarSet;
  private readonly field: StarField;
  private params: BrightnessParams;
  private fade = 1;
  private readonly byHip = new Map<number, PlacedBrightStar>();
  private readonly indexOfHip = new Map<number, number>();

  constructor(file: BrightStarFile, isDrawnByGaia: (gaiaSourceId: string) => boolean, params: BrightnessParams = DEFAULT_BRIGHTNESS, opts: { namedMinSnr?: number } = {}) {
    this.set = buildBrightStarSet(file, isDrawnByGaia, opts);
    this.params = params;
    this.field = new StarField(this.set.layer, params);
    this.object = this.field.object;
    this.set.stars.forEach((s, k) => { this.byHip.set(s.hip, s); this.indexOfHip.set(s.hip, k); });
  }

  /** The stars this layer places (id, name, xyz pc, V, ...), for the spatial-index consistency tests and the atlas. */
  placedStars(): readonly PlacedBrightStar[] { return this.set.stars; }
  starOf(id: string): PlacedBrightStar | undefined { return id.startsWith('hip:') ? this.byHip.get(Number(id.slice(4))) : undefined; }

  update(camPc: Vec3): void { if (this.fade > 0.001) this.field.update(camPc); }
  setMagLimit(limit: number): void { this.params = { ...this.params, magLimit: limit }; this.field.setBrightness(this.params); }
  setBrightness(p: BrightnessParams): void { this.params = p; this.field.setBrightness(p); }
  setPixelRatio(ratio: number): void { this.field.setPixelRatio(ratio); }
  setFade(fade: number): void { this.fade = fade; this.field.setFade(fade); }

  pick(x: number, y: number, ctx: { readonly basis: Basis; readonly viewport: { readonly width: number; readonly height: number }; readonly camPc: Vec3 }): string | null {
    if (this.fade <= 0.001 || this.set.layer.count === 0) return null;
    // `rel` is the buffer uploaded by update(): what is clicked is what is drawn.
    const r = pickStar(this.set.layer, this.field.rel, ctx.basis, ctx.viewport, { x, y }, this.params, BRIGHT_PICK_RADIUS_PX);
    return r ? `hip:${r.catalogueIndex}` : null;
  }

  /**
   * Screen distance (CSS px) from (x, y) to the star `id` as drawn this frame, Infinity when it is behind the camera or unknown. Viewer.pick compares it with the Gaia pick's
   * distance so the TRUE nearest of the two layers wins (a Hipparcos star right under the cursor is not lost to a faint Gaia star 11 px away).
   */
  pickDistance(id: string, x: number, y: number, ctx: { readonly basis: Basis; readonly viewport: { readonly width: number; readonly height: number } }): number {
    const k = id.startsWith('hip:') ? this.indexOfHip.get(Number(id.slice(4))) : undefined;
    if (k === undefined) return Infinity;
    const rel = this.field.rel;
    const s = projectToScreen([rel[3 * k]!, rel[3 * k + 1]!, rel[3 * k + 2]!], ctx.basis, ctx.viewport);
    return s ? Math.hypot(s.x - x, s.y - y) : Infinity;
  }

  stats(): { readonly points: number } { return { points: this.set.layer.count }; }
  dispose(): void { this.field.dispose(); }
}
