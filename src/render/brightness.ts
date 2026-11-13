/**
 * Magnitude -> screen appearance. A VISUALISATION CHOICE, documented in docs/RENDERING_STRATEGY.md.
 *
 * Apparent magnitude as seen from the camera (distance modulus, no extinction):
 *     m_cam = M_G + 5 log10(d_cam[pc]) - 5
 * where M_G = G - 5 log10(d_sun[pc]) + 5 is the star's derived absolute G magnitude.
 *
 * Point diameter and opacity are LINEAR IN MAGNITUDE (logarithmic in flux, Pogson's law). They are not
 * calibrated photometry and a point's size says NOTHING about the star's physical radius.
 */
export interface BrightnessParams {
  /** Stars fainter than this (apparent mag from the camera) are not drawn. */
  readonly magLimit: number;
  readonly minPx: number;
  readonly maxPx: number;
  /** Pixels of diameter gained per magnitude brighter than the limit. */
  readonly pxPerMag: number;
  readonly minAlpha: number;
}

export const DEFAULT_BRIGHTNESS: BrightnessParams = { magLimit: 7.5, minPx: 1.2, maxPx: 12, pxPerMag: 1.15, minAlpha: 0.28 };

export function apparentMagFromCamera(absoluteMag: number, cameraDistancePc: number): number {
  const d = Math.max(cameraDistancePc, 1e-9); // avoid log(0) when the camera sits on a star
  return absoluteMag + 5 * Math.log10(d) - 5;
}

export function pointDiameterPx(mApp: number, p: BrightnessParams = DEFAULT_BRIGHTNESS): number {
  if (mApp > p.magLimit) return 0;
  return Math.min(p.maxPx, p.minPx + p.pxPerMag * (p.magLimit - mApp));
}

export function pointAlpha(mApp: number, p: BrightnessParams = DEFAULT_BRIGHTNESS): number {
  if (mApp > p.magLimit) return 0;
  const t = Math.min(1, (p.magLimit - mApp) / 5); // fully opaque 5 mag above the limit
  return p.minAlpha + (1 - p.minAlpha) * t;
}

/** GLSL implementing exactly the functions above; kept next to them so they cannot drift apart silently. */
export const BRIGHTNESS_GLSL = /* glsl */ `
float atlasAppMag(float absMag, float distPc) { return absMag + 5.0 * log2(max(distPc, 1e-9)) * 0.30102999566 - 5.0; }
float atlasDiameter(float m) {
  if (m > uMagLimit) return 0.0;
  return min(uMaxPx, uMinPx + uPxPerMag * (uMagLimit - m));
}
float atlasAlpha(float m) {
  if (m > uMagLimit) return 0.0;
  float t = min(1.0, (uMagLimit - m) / 5.0);
  return uMinAlpha + (1.0 - uMinAlpha) * t;
}
`;
