import type { GaiaCatalogue } from '../data/catalogue/catalogue';
import { NEIGHBOURHOOD_RADIUS_PC } from '../data/catalogue/frames';
import { HIGH_RUWE } from '../data/catalogue/flags';
import { colourFromBpRp } from './starColour';

/**
 * Typed, renderer-ready arrays built from the NORMALISED catalogue. Positions are heliocentric ICRS
 * parsecs in float64 (the camera-relative subtraction happens per frame, then narrows to float32).
 * Nothing here is invented: a star is only included if the catalogue supports a position AND a brightness.
 */
export interface StarLayer {
  readonly count: number;
  /** Catalogue row index for each drawn star. */
  readonly catalogueIndex: Uint32Array;
  /** x,y,z in pc, float64, heliocentric ICRS. */
  readonly positionPc: Float64Array;
  /** Derived absolute G magnitude (no extinction). */
  readonly absMag: Float32Array;
  readonly colour: Float32Array;
  /** 1 for reliable distances, <1 for marginal (drawn dimmer so they are not mistaken for firm positions). */
  readonly confidence: Float32Array;
  /** 1 where the astrometric fit is poor (RUWE > 1.4). Drawn by default; the user can hide them. */
  readonly suspect: Uint8Array;
  readonly suspectCount: number;
  readonly skipped: {
    readonly noDistance: number;
    readonly noGMagnitude: number;
    readonly outsideExtent: number;
  };
}

export const MARGINAL_CONFIDENCE = 0.55;

export function buildStarLayer(cat: GaiaCatalogue, maxDistancePc = NEIGHBOURHOOD_RADIUS_PC): StarLayer {
  const idx: number[] = [];
  let noDistance = 0, noG = 0, outside = 0;
  for (let i = 0; i < cat.count; i++) {
    const d = cat.distancePc(i);
    if (d === null) { noDistance++; continue; }
    if (d > maxDistancePc) { outside++; continue; }
    if (cat.value('phot_g_mean_mag', i) === null) { noG++; continue; }
    idx.push(i);
  }
  const n = idx.length;
  const catalogueIndex = new Uint32Array(n);
  const positionPc = new Float64Array(n * 3);
  const absMag = new Float32Array(n);
  const colour = new Float32Array(n * 3);
  const confidence = new Float32Array(n);
  const suspect = new Uint8Array(n);
  let suspectCount = 0;
  for (let k = 0; k < n; k++) {
    const i = idx[k]!;
    catalogueIndex[k] = i;
    const p = cat.positionPc(i)!;
    positionPc[3 * k] = p[0]; positionPc[3 * k + 1] = p[1]; positionPc[3 * k + 2] = p[2];
    absMag[k] = cat.absoluteGMag(i)!;
    const c = colourFromBpRp(cat.bpRp(i));
    colour[3 * k] = c[0]; colour[3 * k + 1] = c[1]; colour[3 * k + 2] = c[2];
    confidence[k] = cat.distanceStatus(i) === 'reliable' ? 1 : MARGINAL_CONFIDENCE;
    const ruwe = cat.value('ruwe', i);
    if (ruwe !== null && ruwe > HIGH_RUWE) { suspect[k] = 1; suspectCount++; }
  }
  return { count: n, catalogueIndex, positionPc, absMag, colour, confidence, suspect, suspectCount, skipped: { noDistance, noGMagnitude: noG, outsideExtent: outside } };
}

/** Camera-relative positions (float64 subtraction, narrowed to float32) written into `out` without allocating. */
export function cameraRelative(layer: StarLayer, cam: readonly [number, number, number], out: Float32Array): void {
  const p = layer.positionPc;
  const cx = cam[0], cy = cam[1], cz = cam[2];
  for (let i = 0, n = layer.count * 3; i < n; i += 3) {
    out[i] = p[i]! - cx;
    out[i + 1] = p[i + 1]! - cy;
    out[i + 2] = p[i + 2]! - cz;
  }
}
