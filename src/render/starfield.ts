import * as THREE from 'three';
import { BRIGHTNESS_GLSL, DEFAULT_BRIGHTNESS, type BrightnessParams } from './brightness';
import { cameraRelative, type StarLayer } from './starLayer';

const VERTEX = /* glsl */ `
uniform float uFade; uniform float uMagLimit; uniform float uMinPx; uniform float uMaxPx; uniform float uPxPerMag; uniform float uMinAlpha; uniform float uPixelRatio; uniform float uHideSuspect;
attribute float aSuspect; attribute float aAbsMag; attribute vec3 aColour; attribute float aConfidence;
varying vec3 vColour; varying float vAlpha;
${BRIGHTNESS_GLSL}
void main() {
  float d = length(position);                 // camera-relative distance, parsecs
  float m = atlasAppMag(aAbsMag, d);
  float dia = atlasDiameter(m);
  if (uHideSuspect > 0.5 && aSuspect > 0.5) dia = 0.0;   // user asked to hide astrometrically suspect stars
  vAlpha = atlasAlpha(m) * aConfidence * uFade;
  vColour = aColour;
  gl_PointSize = dia * uPixelRatio;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = (dia <= 0.0) ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mv;   // not drawn if fainter than the limit
}`;

const FRAGMENT = /* glsl */ `
varying vec3 vColour; varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c) * 2.0;
  if (r > 1.0) discard;
  float soft = 1.0 - smoothstep(0.35, 1.0, r);
  gl_FragColor = vec4(vColour, vAlpha * soft);
}`;

/**
 * Opacity of the Gaia star field as a function of the camera's distance from the Sun (parsecs). 1 out to 20 kpc (the old
 * maximum zoom, so nothing that existed before changes), then a smooth fade to 0 at 200 kpc, where every catalogue star is
 * far below the magnitude limit anyway. Without it the field would end abruptly at the far plane or when the last supergiants
 * drop below the limit.
 */
export const STAR_FADE_FROM_PC = 20_000;
export const STAR_FADE_TO_PC = 200_000;
export function starFieldFade(camDistanceFromSunPc: number): number {
  if (!(camDistanceFromSunPc > STAR_FADE_FROM_PC)) return 1;
  if (camDistanceFromSunPc >= STAR_FADE_TO_PC) return 0;
  const t = Math.log(camDistanceFromSunPc / STAR_FADE_FROM_PC) / Math.log(STAR_FADE_TO_PC / STAR_FADE_FROM_PC);
  return 1 - t * t * (3 - 2 * t);
}

/** GPU star points: one draw call for the whole catalogue layer. Brightness is evaluated per vertex from the camera distance. */
export class StarField {
  readonly object: THREE.Points;
  readonly rel: Float32Array;
  private readonly material: THREE.ShaderMaterial;
  private readonly attr: THREE.BufferAttribute;

  constructor(private readonly layer: StarLayer, params: BrightnessParams = DEFAULT_BRIGHTNESS) {
    this.rel = new Float32Array(layer.count * 3);
    const geo = new THREE.BufferGeometry();
    this.attr = new THREE.BufferAttribute(this.rel, 3);
    this.attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.attr);
    geo.setAttribute('aAbsMag', new THREE.BufferAttribute(layer.absMag, 1));
    geo.setAttribute('aColour', new THREE.BufferAttribute(layer.colour, 3));
    geo.setAttribute('aConfidence', new THREE.BufferAttribute(layer.confidence, 1));
    geo.setAttribute('aSuspect', new THREE.BufferAttribute(Float32Array.from(layer.suspect), 1));
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uMagLimit: { value: params.magLimit }, uMinPx: { value: params.minPx }, uMaxPx: { value: params.maxPx },
        uPxPerMag: { value: params.pxPerMag }, uMinAlpha: { value: params.minAlpha }, uPixelRatio: { value: 1 }, uHideSuspect: { value: 0 }, uFade: { value: 1 },
      },
    });
    this.object = new THREE.Points(geo, this.material);
    this.object.frustumCulled = false; // positions are rewritten every frame; the bounding sphere would be stale
  }

  setBrightness(p: BrightnessParams): void {
    const u = this.material.uniforms as Record<string, { value: number }>;
    u['uMagLimit']!.value = p.magLimit; u['uMinPx']!.value = p.minPx; u['uMaxPx']!.value = p.maxPx;
    u['uPxPerMag']!.value = p.pxPerMag; u['uMinAlpha']!.value = p.minAlpha;
  }

  setHideSuspect(hide: boolean): void {
    (this.material.uniforms as Record<string, { value: number }>)['uHideSuspect']!.value = hide ? 1 : 0;
  }

  /** Global opacity of the whole field, 0..1 (used to fade the Gaia stars out when the camera leaves the sample volume). */
  setFade(f: number): void {
    (this.material.uniforms as Record<string, { value: number }>)['uFade']!.value = f;
    this.object.visible = f > 0.001;
  }

  setPixelRatio(r: number): void {
    (this.material.uniforms as Record<string, { value: number }>)['uPixelRatio']!.value = r;
  }

  /** Recompute camera-relative positions (float64 subtraction) and upload. */
  update(cameraPc: readonly [number, number, number]): void {
    cameraRelative(this.layer, cameraPc, this.rel);
    this.attr.needsUpdate = true;
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.material.dispose();
  }
}
