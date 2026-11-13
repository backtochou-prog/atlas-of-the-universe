/**
 * GLSL for the Solar System layer. Everything is evaluated in VIEW space with the camera at the origin, so distances
 * of order 1e12 m never reach the GPU as absolute coordinates, only as camera-relative values.
 *
 * Lighting: Lambertian from the Sun's actual direction at each fragment, with analytic sphere shadows (eclipses and
 * planet shadows on rings) and a ring shadow on the planet. Per-body exposure is normalised, so the RELATIVE brightness
 * of different planets is not physical (a real camera would also adjust exposure for Neptune).
 */
export const PLANET_VERTEX = /* glsl */ `
varying vec3 vObj; varying vec3 vNormalView; varying vec3 vViewPos;
void main() {
  vObj = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mv.xyz;
  vNormalView = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * mv;
}`;

const OCCLUSION = /* glsl */ `
uniform vec3 uSunView; uniform float uSunRadius;
uniform vec4 uOcc[5]; uniform int uOccCount;
// Fraction of the Sun's disc hidden from point P by the occluding spheres (umbra and penumbra, small-angle approximation).
float sunVisibility(vec3 P) {
  vec3 toS = uSunView - P; float dS = length(toS); vec3 dir = toS / dS;
  float sunAng = uSunRadius / dS;
  float hidden = 0.0;
  for (int i = 0; i < 5; i++) {
    if (i >= uOccCount) break;
    vec3 PC = uOcc[i].xyz - P; float t = dot(PC, dir);
    if (t <= 0.0 || t >= dS) continue;
    float sep = length(PC - t * dir) / t;
    float occ = uOcc[i].w / t;
    hidden = max(hidden, 1.0 - smoothstep(max(occ - sunAng, 0.0), occ + sunAng, sep));
  }
  return 1.0 - hidden;
}`;

export const PLANET_FRAGMENT = /* glsl */ `
precision highp float;
varying vec3 vObj; varying vec3 vNormalView; varying vec3 vViewPos;
uniform sampler2D uDay; uniform sampler2D uNight; uniform sampler2D uClouds;
uniform float uHasDay; uniform float uHasNight; uniform float uHasClouds;
uniform vec3 uFallback; uniform vec3 uTint; uniform float uLonLeft;
uniform float uAmbient; uniform float uSpecular; uniform vec3 uTwilightColour; uniform float uTwilight; uniform float uNoData;
// ring shadow on the planet
uniform float uHasRing; uniform sampler2D uRingTex; uniform vec3 uRingNormalView; uniform vec3 uRingCentreView; uniform vec2 uRingRadii;
${OCCLUSION}
const float PI = 3.14159265359;

float ringShadow(vec3 P) {
  if (uHasRing < 0.5) return 1.0;
  vec3 toS = uSunView - P; vec3 dir = normalize(toS);
  float denom = dot(dir, uRingNormalView);
  if (abs(denom) < 1e-5) return 1.0;
  float t = dot(uRingCentreView - P, uRingNormalView) / denom;
  if (t <= 0.0) return 1.0;
  float r = length(P + t * dir - uRingCentreView);
  float u = (r - uRingRadii.x) / (uRingRadii.y - uRingRadii.x);
  if (u < 0.0 || u > 1.0) return 1.0;
  return 1.0 - 0.92 * texture(uRingTex, vec2(u, 0.5)).a;
}

void main() {
  vec3 p = normalize(vObj);                    // body-fixed direction: local +y is the pole, +x the prime meridian
  float lon = atan(-p.z, p.x);
  float lat = asin(clamp(p.y, -1.0, 1.0));
  float u = fract((lon - uLonLeft) / (2.0 * PI));
  vec2 uv = vec2(u, 0.5 + lat / PI);
  // Avoid a one-texel seam at the longitude wrap by choosing the smaller of two derivative estimates.
  vec2 uvB = vec2(fract(u + 0.5), uv.y);
  vec2 a1 = dFdx(uv), b1 = dFdy(uv), a2 = dFdx(uvB), b2 = dFdy(uvB);
  vec2 dx = abs(a1.x) < abs(a2.x) ? a1 : a2;
  vec2 dy = abs(b1.x) < abs(b2.x) ? b1 : b2;

  vec3 albedo = uFallback;
  if (uHasDay > 0.5) {
    vec3 t = textureGrad(uDay, uv, dx, dy).rgb;
    // A zero-valued texel in a planetary mosaic is NO DATA (unimaged terrain). Draw it as a flat neutral grey, never as shadow.
    if (uNoData > 0.5 && dot(t, vec3(0.3333)) < 0.003) albedo = vec3(0.07, 0.07, 0.075);
    else albedo = t * uTint;
  }
  float cloud = 0.0;
  if (uHasClouds > 0.5) { cloud = textureGrad(uClouds, uv, dx, dy).r; albedo = mix(albedo, vec3(0.96), clamp(cloud * 0.92, 0.0, 1.0)); }

  vec3 N = normalize(vNormalView);
  vec3 V = normalize(-vViewPos);
  vec3 L = normalize(uSunView - vViewPos);
  float ndl = dot(N, L);
  float vis = sunVisibility(vViewPos) * ringShadow(vViewPos);
  float diffuse = max(ndl, 0.0) * vis;

  vec3 col = albedo * (diffuse + uAmbient);
  if (uSpecular > 0.0 && uHasDay > 0.5) {
    vec3 d = textureGrad(uDay, uv, dx, dy).rgb;
    float water = clamp((d.b - max(d.r, d.g) - 0.02) * 6.0, 0.0, 1.0) * (1.0 - cloud);
    float s = pow(max(dot(reflect(-L, N), V), 0.0), 70.0);
    col += vec3(1.0, 0.97, 0.9) * s * water * uSpecular * vis * step(0.0, ndl);
  }
  if (uHasNight > 0.5) {
    float dark = 1.0 - smoothstep(-0.10, 0.04, ndl * vis + (1.0 - vis) * -0.2);
    col += textureGrad(uNight, uv, dx, dy).rgb * dark * 1.25 * (1.0 - cloud * 0.7);
  }
  if (uTwilight > 0.0) {
    float band = smoothstep(-0.14, 0.0, ndl) * (1.0 - smoothstep(0.0, 0.22, ndl));
    col += uTwilightColour * band * uTwilight * vis * 0.5;
  }
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

export const ATMOSPHERE_FRAGMENT = /* glsl */ `
precision highp float;
varying vec3 vObj; varying vec3 vNormalView; varying vec3 vViewPos;
uniform vec3 uColour; uniform float uStrength; uniform float uPower;
${OCCLUSION}
void main() {
  vec3 N = normalize(vNormalView), V = normalize(-vViewPos), L = normalize(uSunView - vViewPos);
  float rim = pow(1.0 - abs(dot(N, V)), uPower);
  float lit = smoothstep(-0.25, 0.45, dot(N, L)) * sunVisibility(vViewPos);
  float a = rim * (0.12 + 0.88 * lit) * uStrength;
  gl_FragColor = vec4(uColour * a, a);
  #include <colorspace_fragment>
}`;

export const RING_FRAGMENT = /* glsl */ `
precision highp float;
varying vec3 vObj; varying vec3 vNormalView; varying vec3 vViewPos;
uniform sampler2D uRingTex; uniform vec2 uRingRadii; uniform float uAmbient;
${OCCLUSION}
void main() {
  float r = length(vObj.xy);
  float u = (r - uRingRadii.x) / (uRingRadii.y - uRingRadii.x);
  if (u < 0.0 || u > 1.0) discard;
  vec4 t = texture(uRingTex, vec2(u, 0.5));
  vec3 N = normalize(vNormalView), V = normalize(-vViewPos), L = normalize(uSunView - vViewPos);
  float ndl = dot(N, L);
  bool sameSide = (dot(N, V) * ndl) > 0.0;
  float vis = sunVisibility(vViewPos);
  // Reflected light when the Sun and the viewer are on the same side; transmitted light through thin parts otherwise.
  float lit = sameSide ? abs(ndl) : abs(ndl) * (1.0 - t.a) * 0.7;
  // The strip supplies OPACITY (alpha) and structure (luminance). The warm colour is a visualisation choice, not a measurement:
  // the strip's own RGB is too dim to be used as brightness.
  float structure = clamp(dot(t.rgb, vec3(0.3333)) / 0.40, 0.65, 1.0);
  vec3 col = vec3(0.88, 0.81, 0.68) * structure * (lit * vis + uAmbient);
  gl_FragColor = vec4(col, t.a);
  #include <colorspace_fragment>
}`;

export const SUN_FRAGMENT = /* glsl */ `
precision highp float;
varying vec3 vObj; varying vec3 vNormalView; varying vec3 vViewPos;
void main() {
  vec3 N = normalize(vNormalView), V = normalize(-vViewPos);
  float mu = clamp(dot(N, V), 0.0, 1.0);
  float I = 1.0 - 0.6 * (1.0 - mu);     // linear limb darkening, u = 0.6 (visible light, approximate)
  vec3 col = vec3(1.0, 0.92, 0.74) * I * 0.98;   // limb-darkened disc; not clipped, so the darkening stays visible
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

export const GLOW_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

/** A VISUAL EFFECT: a soft halo around the Sun. It is not a physical corona and does not represent luminosity. */
export const GLOW_FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 vUv; uniform float uOpacity; uniform float uInner;   // uInner: the photosphere's radius as a fraction of the quad
void main() {
  float r = length(vUv - 0.5) * 2.0;       // 1.0 at the quad edge
  if (r < uInner) discard;                  // (the depth test, not this, hides the halo behind the disc: the quad sits at the Sun's centre depth)
  float x = (r - uInner) / max(1.0 - uInner, 1e-4);
  float a = pow(max(1.0 - x, 0.0), 2.4) * uOpacity;
  gl_FragColor = vec4(vec3(1.0, 0.82, 0.55) * a, a);
  #include <colorspace_fragment>
}`;

export const MARKER_VERTEX = /* glsl */ `
attribute vec3 aColour; attribute float aSize; varying vec3 vColour;
void main() { vColour = aColour; gl_PointSize = aSize; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
export const MARKER_FRAGMENT = /* glsl */ `
precision highp float; varying vec3 vColour;
void main() {
  vec2 c = gl_PointCoord - 0.5; float r = length(c) * 2.0;
  if (r > 1.0) discard;
  gl_FragColor = vec4(vColour, smoothstep(1.0, 0.55, r));
  #include <colorspace_fragment>
}`;
