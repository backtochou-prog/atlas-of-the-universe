import { apparentMagFromCamera, DEFAULT_BRIGHTNESS, type BrightnessParams } from './brightness';
import { FOV_DEG, type Basis } from './orbitCamera';
import type { StarLayer } from './starLayer';

export interface Viewport { readonly width: number; readonly height: number }

const TAN_HALF_FOV = Math.tan((FOV_DEG * Math.PI) / 360);

/** Screen position (pixels, origin top-left) of a camera-relative point, or null if behind the camera. */
export function projectToScreen(
  rel: readonly [number, number, number],
  basis: Basis,
  vp: Viewport,
): { x: number; y: number; depth: number } | null {
  const depth = rel[0] * basis.forward[0] + rel[1] * basis.forward[1] + rel[2] * basis.forward[2];
  if (!(depth > 1e-9)) return null;
  const rx = rel[0] * basis.right[0] + rel[1] * basis.right[1] + rel[2] * basis.right[2];
  const ry = rel[0] * basis.up[0] + rel[1] * basis.up[1] + rel[2] * basis.up[2];
  const aspect = vp.width / vp.height;
  const ndcX = rx / (depth * TAN_HALF_FOV * aspect);
  const ndcY = ry / (depth * TAN_HALF_FOV);
  return { x: (ndcX * 0.5 + 0.5) * vp.width, y: (0.5 - ndcY * 0.5) * vp.height, depth };
}

export interface PickResult {
  /** Index into the StarLayer arrays. */
  readonly layerIndex: number;
  readonly catalogueIndex: number;
  readonly screenDistancePx: number;
  readonly apparentMag: number;
  /** Added by R2a. 'gaia' (default, absent for older callers): layerIndex / catalogueIndex are valid. 'layer': the star belongs to an extra star-pass layer and both indices are -1. */
  readonly source?: 'gaia' | 'layer';
  /** Added by R2a. Only when source === 'layer': the layer's id string for the star (a universal id such as "hip:32349"). */
  readonly layerId?: string;
  /** Added by R2a. Only when source === 'layer': the layer's name. */
  readonly layer?: string;
}

/**
 * Pick the star nearest the cursor among those actually DRAWN (brighter than the magnitude limit).
 * Ties within the pick radius go to the brighter star. `rel` is the same camera-relative buffer the GPU uses,
 * so what you click is what you see.
 */
export function pickStar(
  layer: StarLayer,
  rel: Float32Array,
  basis: Basis,
  vp: Viewport,
  cursor: { x: number; y: number },
  params: BrightnessParams = DEFAULT_BRIGHTNESS,
  radiusPx = 12,
  hideSuspect = false,
): PickResult | null {
  let best: PickResult | null = null;
  let bestScore = Infinity;
  for (let k = 0; k < layer.count; k++) {
    if (hideSuspect && layer.suspect[k]) continue; // hidden stars cannot be picked
    const rx = rel[3 * k]!, ry = rel[3 * k + 1]!, rz = rel[3 * k + 2]!;
    const d = Math.hypot(rx, ry, rz);
    const m = apparentMagFromCamera(layer.absMag[k]!, d);
    if (m > params.magLimit) continue;
    const s = projectToScreen([rx, ry, rz], basis, vp);
    if (!s) continue;
    const dist = Math.hypot(s.x - cursor.x, s.y - cursor.y);
    if (dist > radiusPx) continue;
    // Closest wins; brightness (smaller m) breaks near-ties.
    const score = dist + 0.15 * m;
    if (score < bestScore) {
      bestScore = score;
      best = { layerIndex: k, catalogueIndex: layer.catalogueIndex[k]!, screenDistancePx: dist, apparentMag: m };
    }
  }
  return best;
}
