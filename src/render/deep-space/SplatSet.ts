import * as THREE from 'three';

/**
 * Instanced soft billboards: ONE draw call for any number of markers, glows and large soft density splats.
 * Used for galaxy markers/glows and for the Milky Way model. Exported so later sub-renderers (nebulae, clusters, ...) can
 * reuse it instead of writing a new point shader.
 *
 * Per instance:
 *   centre   camera-relative position, parsecs (computed in float64 on the CPU, narrowed here: floating origin)
 *   shape    (a, b, angle, unit): semi-axes and rotation of the ellipse on SCREEN (angle in radians, counter-clockwise,
 *            y up). unit 0 = CSS pixels; unit 1 = PARSECS (a is a round radius, converted to pixels with the perspective
 *            of the instance's own depth, so a splat shrinks with distance like a physical blob).
 *   colour   rgb (display-referred, 0..1 per unit weight) and alpha (weight)
 *   power    exponent p of the radial profile (1 - r^2)^p: higher = tighter core, softer skirt
 *
 * Additive blending, no depth test, no depth write: the result does not depend on draw order.
 */
const VERTEX = /* glsl */ `
attribute vec3 aCentre; attribute vec4 aShape; attribute vec4 aColour; attribute float aPower;
uniform vec2 uViewport; uniform float uPxPerRad; uniform float uMaxPx; uniform float uMinPx; uniform float uAlphaScale;
varying vec2 vP; varying vec4 vColour; varying float vPower;
void main() {
  vec4 mv = modelViewMatrix * vec4(aCentre, 1.0);
  float a = aShape.x; float b = aShape.y;
  float fade = 1.0;
  if (aShape.w > 0.5) {
    float d = max(-mv.z, 1e-6);
    a = a / d * uPxPerRad; b = a;
    // A splat that would cover most of the screen is faded out instead of being drawn: no giant overdraw, no
    // sudden fill when the camera passes through one.
    fade = 1.0 - smoothstep(0.55 * uMaxPx, uMaxPx, a);
    if (a < uMinPx) { fade = 0.0; }
  }
  vColour = vec4(aColour.rgb, aColour.a * fade * uAlphaScale);
  vPower = aPower;
  vP = position.xy;
  float ca = cos(aShape.z); float sa = sin(aShape.z);
  vec2 e = vec2(position.x * a, position.y * b);
  vec2 off = vec2(ca * e.x - sa * e.y, sa * e.x + ca * e.y);
  vec4 clip = projectionMatrix * mv;
  clip.xy += off * 2.0 / uViewport * clip.w;
  bool hidden = (mv.z >= -1e-9) || (vColour.a <= 0.0) || (a <= 0.0);
  gl_Position = hidden ? vec4(2.0, 2.0, 2.0, 1.0) : clip;
}`;

const FRAGMENT = /* glsl */ `
varying vec2 vP; varying vec4 vColour; varying float vPower;
void main() {
  float r2 = dot(vP, vP);
  if (r2 >= 1.0) discard;
  float prof = pow(1.0 - r2, vPower);
  gl_FragColor = vec4(vColour.rgb, vColour.a * prof);
}`;

export interface SplatInstance {
  /** Camera-relative centre, parsecs. */
  x: number; y: number; z: number;
  a: number; b: number; angle: number; unit: 0 | 1;
  r: number; g: number; bl: number; alpha: number;
  power: number;
}

export class SplatSet {
  readonly mesh: THREE.Mesh;
  private readonly centre: Float32Array;
  private readonly shape: Float32Array;
  private readonly colour: Float32Array;
  private readonly power: Float32Array;
  private readonly attrs: THREE.InstancedBufferAttribute[];
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  /** Number of instances written this frame (set by the owner through setCount). */
  count = 0;

  constructor(readonly capacity: number, opts: { maxPx?: number; minPx?: number } = {}) {
    this.centre = new Float32Array(capacity * 3);
    this.shape = new Float32Array(capacity * 4);
    this.colour = new Float32Array(capacity * 4);
    this.power = new Float32Array(capacity);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    this.geo.setIndex([0, 1, 2, 0, 2, 3]);
    const mk = (arr: Float32Array, n: number) => { const a = new THREE.InstancedBufferAttribute(arr, n); a.setUsage(THREE.DynamicDrawUsage); return a; };
    this.attrs = [mk(this.centre, 3), mk(this.shape, 4), mk(this.colour, 4), mk(this.power, 1)];
    this.geo.setAttribute('aCentre', this.attrs[0]!);
    this.geo.setAttribute('aShape', this.attrs[1]!);
    this.geo.setAttribute('aColour', this.attrs[2]!);
    this.geo.setAttribute('aPower', this.attrs[3]!);
    this.geo.instanceCount = 0;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX, fragmentShader: FRAGMENT,
      transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uViewport: { value: new THREE.Vector2(1, 1) }, uPxPerRad: { value: 1000 }, uMaxPx: { value: 500 }, uMinPx: { value: opts.minPx ?? 0.2 }, uAlphaScale: { value: 1 } },
    });
    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    void opts.maxPx;
  }

  setView(width: number, height: number, pxPerRad: number, maxPx = 0.6 * Math.max(width, height)): void {
    const u = this.material.uniforms as Record<string, { value: unknown }>;
    (u['uViewport']!.value as THREE.Vector2).set(width, height);
    u['uPxPerRad']!.value = pxPerRad;
    u['uMaxPx']!.value = maxPx;
  }

  /** Global multiplier of every instance's alpha (view-dependent exposure, fades). */
  setAlphaScale(k: number): void { (this.material.uniforms as Record<string, { value: unknown }>)['uAlphaScale']!.value = k; }

  /** Write one instance (no allocation). Call setCount() and commit() after the last one of the frame. */
  set(i: number, s: SplatInstance): void {
    const c = i * 3, h = i * 4;
    this.centre[c] = s.x; this.centre[c + 1] = s.y; this.centre[c + 2] = s.z;
    this.shape[h] = s.a; this.shape[h + 1] = s.b; this.shape[h + 2] = s.angle; this.shape[h + 3] = s.unit;
    this.colour[h] = s.r; this.colour[h + 1] = s.g; this.colour[h + 2] = s.bl; this.colour[h + 3] = s.alpha;
    this.power[i] = s.power;
  }

  /** Cheap direct writers for the hot path of large sets. */
  setCentre(i: number, x: number, y: number, z: number): void { const c = i * 3; this.centre[c] = x; this.centre[c + 1] = y; this.centre[c + 2] = z; }
  setStatic(i: number, a: number, b: number, angle: number, unit: 0 | 1, r: number, g: number, bl: number, alpha: number, power: number): void {
    const h = i * 4;
    this.shape[h] = a; this.shape[h + 1] = b; this.shape[h + 2] = angle; this.shape[h + 3] = unit;
    this.colour[h] = r; this.colour[h + 1] = g; this.colour[h + 2] = bl; this.colour[h + 3] = alpha;
    this.power[i] = power;
  }
  setAlpha(i: number, alpha: number): void { this.colour[i * 4 + 3] = alpha; }

  setCount(n: number): void { this.count = Math.min(n, this.capacity); this.geo.instanceCount = this.count; this.mesh.visible = this.count > 0; }
  commit(): void { for (const a of this.attrs) a.needsUpdate = true; }

  dispose(): void { this.geo.dispose(); this.material.dispose(); }
}
