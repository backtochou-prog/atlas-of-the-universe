import * as THREE from 'three';

/**
 * Instanced screen-space RINGS (one draw call): thin circles of a given pixel radius and width around a camera-relative point. Used for search/nearby highlights and
 * the selection proxy. Rings have a constant pixel size (they mark a place, not a physical size) and are never full-screen.
 * Same conventions as SplatSet: camera-relative centres in parsecs (float64 subtraction on the CPU), CSS-pixel viewport, additive, no depth test.
 */
const VERTEX = /* glsl */ `
attribute vec3 aCentre; attribute vec4 aRing; attribute vec3 aColour;
uniform vec2 uViewport;
varying vec2 vLocal; varying vec4 vRing; varying vec3 vColour;
void main() {
  vec4 mv = modelViewMatrix * vec4(aCentre, 1.0);
  float half_ = aRing.x + aRing.y * 0.5 + 2.0;
  vLocal = position.xy * half_; vRing = aRing; vColour = aColour;
  vec4 clip = projectionMatrix * mv;
  clip.xy += position.xy * half_ * 2.0 / uViewport * clip.w;
  bool hidden = (mv.z >= -1e-9) || (aRing.z <= 0.0);
  gl_Position = hidden ? vec4(2.0, 2.0, 2.0, 1.0) : clip;
}`;
const FRAGMENT = /* glsl */ `
varying vec2 vLocal; varying vec4 vRing; varying vec3 vColour;
void main() {
  float d = abs(length(vLocal) - vRing.x);
  float hw = vRing.y * 0.5;
  float a = 1.0 - smoothstep(hw - 0.75, hw + 0.75, d);
  if (a <= 0.003) discard;
  gl_FragColor = vec4(vColour, vRing.z * a);
}`;

export class RingSet {
  readonly mesh: THREE.Mesh;
  private readonly centre: Float32Array;
  private readonly ring: Float32Array;
  private readonly colour: Float32Array;
  private readonly attrs: THREE.InstancedBufferAttribute[];
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  count = 0;

  constructor(readonly capacity: number) {
    this.centre = new Float32Array(capacity * 3);
    this.ring = new Float32Array(capacity * 4);
    this.colour = new Float32Array(capacity * 3);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    this.geo.setIndex([0, 1, 2, 0, 2, 3]);
    const mk = (arr: Float32Array, n: number) => { const a = new THREE.InstancedBufferAttribute(arr, n); a.setUsage(THREE.DynamicDrawUsage); return a; };
    this.attrs = [mk(this.centre, 3), mk(this.ring, 4), mk(this.colour, 3)];
    this.geo.setAttribute('aCentre', this.attrs[0]!);
    this.geo.setAttribute('aRing', this.attrs[1]!);
    this.geo.setAttribute('aColour', this.attrs[2]!);
    this.geo.instanceCount = 0;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uViewport: { value: new THREE.Vector2(1, 1) } },
    });
    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  setView(width: number, height: number): void { (this.material.uniforms['uViewport']!.value as THREE.Vector2).set(width, height); }

  set(i: number, x: number, y: number, z: number, radiusPx: number, widthPx: number, alpha: number, r: number, g: number, b: number): void {
    const c = i * 3, h = i * 4;
    this.centre[c] = x; this.centre[c + 1] = y; this.centre[c + 2] = z;
    this.ring[h] = radiusPx; this.ring[h + 1] = widthPx; this.ring[h + 2] = alpha; this.ring[h + 3] = 0;
    this.colour[c] = r; this.colour[c + 1] = g; this.colour[c + 2] = b;
  }
  setCount(n: number): void { this.count = Math.min(n, this.capacity); this.geo.instanceCount = this.count; this.mesh.visible = this.count > 0; }
  commit(): void { for (const a of this.attrs) a.needsUpdate = true; }
  dispose(): void { this.geo.dispose(); this.material.dispose(); }
}

/**
 * Text labels in ONE draw call: label strings are rendered once into a shared canvas atlas (fixed slots), drawn as instanced screen-space quads next to a
 * camera-relative anchor. Needs a DOM canvas; without one (unit tests) `available` is false and every call is a no-op.
 */
const LABEL_VERTEX = /* glsl */ `
attribute vec3 aCentre; attribute vec4 aBox; attribute float aSlot;
uniform vec2 uViewport; uniform float uSlots;
varying vec2 vUv; varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4(aCentre, 1.0);
  vec4 clip = projectionMatrix * mv;
  // aBox: offset x, offset y (CSS px from the anchor, y up), width, height; aBox.w < 0 = hidden
  vec2 px = aBox.xy + (position.xy * 0.5 + 0.5) * aBox.zw;
  clip.xy += px * 2.0 / uViewport * clip.w;
  vUv = vec2(position.x * 0.5 + 0.5, (aSlot + 0.5 - position.y * 0.5) / uSlots);
  vA = 1.0;
  bool hidden = (mv.z >= -1e-9) || (aBox.w <= 0.0);
  gl_Position = hidden ? vec4(2.0, 2.0, 2.0, 1.0) : clip;
}`;
const LABEL_FRAGMENT = /* glsl */ `
uniform sampler2D uAtlas; uniform float uAlpha;
varying vec2 vUv; varying float vA;
void main() { vec4 t = texture2D(uAtlas, vUv); gl_FragColor = vec4(t.rgb, t.a * uAlpha); }`;

export const LABEL_SLOT_W = 256;
export const LABEL_SLOT_H = 26;
const LABEL_SCALE = 2; // texture pixels per CSS pixel

export class LabelAtlas {
  readonly mesh: THREE.Mesh;
  readonly available: boolean;
  private canvas: HTMLCanvasElement | null = null;
  private ctx2d: CanvasRenderingContext2D | null = null;
  private texture: THREE.CanvasTexture | null = null;
  private readonly centre: Float32Array;
  private readonly box: Float32Array;
  private readonly slotAttr: Float32Array;
  private readonly attrs: THREE.InstancedBufferAttribute[] = [];
  private readonly geo = new THREE.InstancedBufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private readonly text: string[];
  /** Measured CSS width of each slot's text. */
  readonly widths: Float32Array;
  count = 0;

  constructor(readonly slots: number) {
    this.centre = new Float32Array(slots * 3);
    this.box = new Float32Array(slots * 4);
    this.slotAttr = Float32Array.from({ length: slots }, (_, i) => i);
    this.widths = new Float32Array(slots);
    this.text = new Array<string>(slots).fill('');
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = LABEL_SLOT_W * LABEL_SCALE; c.height = LABEL_SLOT_H * LABEL_SCALE * slots;
      const g = c.getContext('2d');
      if (g) { this.canvas = c; this.ctx2d = g; }
    }
    this.available = this.ctx2d !== null;
    if (this.canvas) {
      const t = new THREE.CanvasTexture(this.canvas);
      t.colorSpace = THREE.SRGBColorSpace; t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = false; t.flipY = false;
      this.texture = t;
    }
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    this.geo.setIndex([0, 1, 2, 0, 2, 3]);
    const mk = (name: string, arr: Float32Array, n: number) => { const a = new THREE.InstancedBufferAttribute(arr, n); a.setUsage(THREE.DynamicDrawUsage); this.attrs.push(a); this.geo.setAttribute(name, a); };
    mk('aCentre', this.centre, 3); mk('aBox', this.box, 4); mk('aSlot', this.slotAttr, 1);
    this.geo.instanceCount = 0;
    this.material = new THREE.ShaderMaterial({
      vertexShader: LABEL_VERTEX, fragmentShader: LABEL_FRAGMENT, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uViewport: { value: new THREE.Vector2(1, 1) }, uSlots: { value: slots }, uAtlas: { value: this.texture }, uAlpha: { value: 1 } },
    });
    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  setView(width: number, height: number): void { (this.material.uniforms['uViewport']!.value as THREE.Vector2).set(width, height); }

  /** Render `text` into `slot` (only when it changed). Colour is a CSS colour. */
  setText(slot: number, text: string, colour = 'rgba(224,230,238,0.92)'): void {
    if (!this.ctx2d || slot < 0 || slot >= this.slots || this.text[slot] === text) return;
    this.text[slot] = text;
    const g = this.ctx2d, S = LABEL_SCALE, y = slot * LABEL_SLOT_H * S;
    g.clearRect(0, y, LABEL_SLOT_W * S, LABEL_SLOT_H * S);
    g.font = `${12.5 * S}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    g.textBaseline = 'middle';
    const w = Math.min(LABEL_SLOT_W - 8, Math.ceil(g.measureText(text).width / S) + 8);
    g.fillStyle = 'rgba(3,5,10,0.55)';
    g.fillRect(0, y + 3 * S, w * S, (LABEL_SLOT_H - 6) * S);
    g.fillStyle = colour;
    g.fillText(text, 4 * S, y + (LABEL_SLOT_H / 2) * S, (LABEL_SLOT_W - 8) * S);
    this.widths[slot] = w;
    if (this.texture) this.texture.needsUpdate = true;
  }
  textOf(slot: number): string { return this.text[slot] ?? ''; }

  /** Place the label of `slot` with its box starting (dx, dy) CSS px right/up of the anchor. */
  place(slot: number, x: number, y: number, z: number, dx: number, dy: number): void {
    const c = slot * 3, b = slot * 4;
    this.centre[c] = x; this.centre[c + 1] = y; this.centre[c + 2] = z;
    this.box[b] = dx; this.box[b + 1] = dy - LABEL_SLOT_H / 2; this.box[b + 2] = LABEL_SLOT_W; this.box[b + 3] = LABEL_SLOT_H;
    // the atlas slot holds the text left-aligned; the quad covers the whole slot (transparent beyond the text)
  }
  hide(slot: number): void { this.box[slot * 4 + 3] = 0; }
  setAlpha(a: number): void { (this.material.uniforms['uAlpha'] as { value: number }).value = a; }
  /** Draw `n` slots (0..n-1). */
  setCount(n: number): void { this.count = Math.min(n, this.slots); this.geo.instanceCount = this.count; this.mesh.visible = this.count > 0 && this.available; }
  commit(): void { for (const a of this.attrs) a.needsUpdate = true; }
  dispose(): void { this.geo.dispose(); this.material.dispose(); this.texture?.dispose(); }
}
