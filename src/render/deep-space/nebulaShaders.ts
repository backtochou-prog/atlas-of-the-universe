import { SRGB_ENCODE_GLSL } from './shaderChunks';

/**
 * One instanced draw per nebula: every instance is one depth layer (a sheet). Per instance: camera-relative centre and the two
 * half-axis vectors (parsecs, computed in float64 on the CPU and narrowed after the subtraction), and the band index.
 */
export const NEBULA_VERTEX = /* glsl */ `
attribute vec3 aCentre; attribute vec3 aX; attribute vec3 aY; attribute float aBand;
varying vec2 vUv; varying float vBand;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  vBand = aBand;
  vec3 p = aCentre + position.x * aX + position.y * aY;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

/**
 * The band split. t in [0, 1] is the band coordinate of a pixel (0 = darkest band); the N weights are smooth hat functions of t
 * (a smoothstep on each side) and sum to exactly 1 for any t, so the layers add back to the original image.
 * Mirrored on the CPU by bandWeights() in nebulaGeometry.ts (tested).
 */
export const BAND_GLSL = /* glsl */ `
float atlasBandCoord(vec3 c, float knee, float colourWeight) {
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float t = clamp(sqrt(l / knee), 0.0, 1.0);
  float gate = smoothstep(0.02, 0.12, l);                       // colour is ignored where there is almost no light
  float tc = clamp(0.5 + 0.5 * (c.r - c.b) / (c.r + c.b + 1e-4), 0.0, 1.0);
  return mix(t, tc, colourWeight * gate);
}
float atlasBandWeight(float t, float k, float n) {
  float h = clamp(1.0 - abs(t * (n - 1.0) - k), 0.0, 1.0);
  return h * h * (3.0 - 2.0 * h);
}
`;

export const NEBULA_FRAGMENT = /* glsl */ `
uniform sampler2D uMap; uniform float uWeight; uniform float uExposure; uniform float uBlack; uniform float uFeather;
uniform float uLayers; uniform float uColourWeight; uniform float uKnee; uniform float uBandBias;
varying vec2 vUv; varying float vBand;
${SRGB_ENCODE_GLSL}
${BAND_GLSL}
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float n = pow(pow(abs(p.x), 4.0) + pow(abs(p.y), 4.0), 0.25);
  float m = 1.0 - smoothstep(1.0 - uFeather, 1.0, n);            // superellipse feather: the frame edge reaches zero, no rectangle
  vec3 c = texture2D(uMap, vUv).rgb;                              // linear light (the sampler decodes the sRGB image)
  c = max(c - vec3(uBlack), vec3(0.0)) * uExposure;
  vec3 cb = max(texture2D(uMap, vUv, uBandBias).rgb - vec3(uBlack), vec3(0.0)) * uExposure;   // blurred copy decides the band only
  float w = atlasBandWeight(atlasBandCoord(cb, uKnee, uColourWeight), vBand, uLayers);
  c = mix(c, 0.6 + 0.4 * (1.0 - exp(-(c - 0.6) / 0.4)), step(0.6, c));   // gentle shoulder instead of a hard clip (same as the galaxies)
  // Encode FIRST, weight AFTER: the framebuffer is display-referred and additive, so sum_k(w_k * encode(c)) = encode(c) exactly.
  gl_FragColor = vec4(atlasSrgbEncode(c) * (m * uWeight * w), 1.0);
}`;
