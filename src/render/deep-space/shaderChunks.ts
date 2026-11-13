/** GLSL shared by the deep-space shaders. */

/** Exact sRGB opto-electronic transfer function (linear light -> display-encoded). */
export const SRGB_ENCODE_GLSL = /* glsl */ `
vec3 atlasSrgbEncode(vec3 c) {
  c = max(c, vec3(0.0));
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}
`;
