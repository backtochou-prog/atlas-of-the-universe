import * as THREE from 'three';
import { distanceMetres, physicalSizeMetres } from '../../core/deepspace/geometry';
import { isPickableWeight } from '../../core/deepspace/pick';
import { length, type Vec3 } from '../../core/spatial/vec3';
import { METRES_PER_PARSEC } from '../../core/units';
import type { DeepSpaceData } from '../../data/deepspace/deepSpaceData';
import type { DeepImageAsset, DeepSpaceObject } from '../../data/deepspace/types';
import { markerAlpha, objectLod } from './DeepSpaceLOD';
import type { AssetView, DeepSpaceAssetManager, ImageStats } from './DeepSpaceAssetManager';
import { galaxyGlowAxes, placeImage, projectEllipse, type GlowAxes, type ImagePlacement, type ScreenEllipse } from './galaxyGeometry';
import { SRGB_ENCODE_GLSL } from './shaderChunks';
import { SplatSet } from './SplatSet';
import type { DeepRenderContext, DeepRendererStats, DeepScreenInfo, DeepSubRenderer } from './types';

const PC = METRES_PER_PARSEC;

/**
 * VISUAL parameters. None of these is a scientific value: they set how bright and how soft things are drawn.
 */
export const GALAXY_VISUAL = {
  /**
   * Per-object display stretch (linear light), from the level-0 thumbnail: the sky level (0.9 x median) is subtracted and the
   * remainder is scaled so that its 99th percentile reaches `targetP99`. A dim UV map is lifted; a bright optical image is not
   * (gain >= 1, it is never darkened). A display choice that does not touch the data.
   */
  targetP99: 0.45,
  blackFromMedian: 0.9,
  exposureMin: 1,
  exposureMax: 3.5,
  /** Superellipse edge fade: the image reaches zero at its frame edge, so no rectangle is ever visible. */
  edgeFeather: 0.24,
  markerRadiusPx: 2.0,
  markerPower: 2.0,
  /** Glow peak weight and profile exponent. */
  glowAlpha: 0.5,
  glowPower: 1.6,
  glowMinSemiAxisPx: 2.5,
  /** The glow is a little larger than the catalogue's isophote so that it covers the image it hands over to. */
  glowExtent: 1.15,
  /** A flat sky-plane image seen edge-on is dimmed so a razor line is not mistaken for a thin galaxy. */
  edgeOnMinWeight: 0.3,
  /** Seconds for an image to fade in after its texture first arrives. */
  imageFadeSeconds: 0.6,
  /** Neutral tint for a glow with no thumbnail. */
  defaultTint: [0.92, 0.88, 0.8] as readonly [number, number, number],
  /** Fraction of the thumbnail's colour (normalised) vs. neutral in the glow tint. */
  tintStrength: 0.7,
  /** Pixel-radius of the largest unresolved object that still counts as 'marker' for pick radius. */
  minPickRadiusPx: 4,
} as const;

const IMAGE_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy, 0.0, 1.0);
}`;

const IMAGE_FRAGMENT = /* glsl */ `
uniform sampler2D uMap; uniform float uWeight; uniform float uExposure; uniform float uBlack; uniform vec3 uTint; uniform float uFeather; uniform vec2 uV0; uniform vec2 uV1; uniform vec2 uVc;
varying vec2 vUv;
${SRGB_ENCODE_GLSL}
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float n = pow(pow(abs(p.x), 4.0) + pow(abs(p.y), 4.0), 0.25);
  float m = 1.0 - smoothstep(1.0 - uFeather, 1.0, n);
  vec2 q = vec2(dot(uV0, p), dot(uV1, p)) + uVc;     // galaxy-ellipse coordinates: |q| = 1.6 at the vignette edge
  m *= 1.0 - smoothstep(0.62, 1.0, length(q) / 1.0);
  vec3 c = texture2D(uMap, vUv).rgb;                 // linear light: the sampler decodes the sRGB image
  c = max(c - vec3(uBlack), vec3(0.0));
  c *= uExposure * uTint * m * uWeight;
  c = mix(c, 0.6 + 0.4 * (1.0 - exp(-(c - 0.6) / 0.4)), step(0.6, c));   // gentle shoulder instead of a hard clip
  gl_FragColor = vec4(atlasSrgbEncode(c), 1.0);
}`;

let sharedQuad: THREE.BufferGeometry | null = null;
function unitQuad(): THREE.BufferGeometry {
  if (!sharedQuad) {
    sharedQuad = new THREE.BufferGeometry();
    sharedQuad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    sharedQuad.setIndex([0, 1, 2, 0, 2, 3]);
  }
  return sharedQuad;
}

interface Entry {
  readonly obj: DeepSpaceObject;
  readonly pos: Vec3;
  readonly distPc: number;
  readonly radiusPc: number;
  readonly physMetres: number;
  readonly mag: number | undefined;
  readonly glow: GlowAxes | null;
  readonly assets: readonly DeepImageAsset[];
  readonly placements: Map<string, ImagePlacement>;
  /** asset currently chosen by the user / default. */
  chosen: string | undefined;
  /** asset currently drawn (swaps to `chosen` once its first texture is ready). */
  shown: string | undefined;
  mesh: THREE.Mesh | null;
  material: THREE.ShaderMaterial | null;
  lodLevel: number | undefined;
  imgFade: number;
  lastShownTexture: unknown;
  vignetteFor: string | undefined;
  lastLabel: string;
}

const numeric = (o: DeepSpaceObject, key: string): number | undefined => {
  const m = o.measurements[key];
  return m && Number.isFinite(m.value) ? m.value : undefined;
};

/**
 * Default band. The brief's rule is "the visible-light asset, else the first". One refinement (reported): an image that covers
 * less than half of the catalogue diameter (the PHAT strip of M31 is a 58' x 18' piece of a 178' galaxy) is a poor default,
 * so candidates are ordered visible-first and the first one that covers at least half of the catalogue major axis wins;
 * if none does, the widest-covering one. Every other band stays one click away (setBand).
 */
export function defaultAssetId(assets: readonly DeepImageAsset[], majorArcmin?: number): string | undefined {
  if (assets.length === 0) return undefined;
  const ordered = [...assets.filter((a) => a.band.kind === 'visible'), ...assets.filter((a) => a.band.kind !== 'visible')];
  if (!majorArcmin) return ordered[0]!.id;
  const cover = (a: DeepImageAsset) => Math.max(a.geometry.fovArcmin[0], a.geometry.fovArcmin[1]) / majorArcmin;
  return (ordered.find((a) => cover(a) >= 0.5) ?? ordered.reduce((best, a) => (cover(a) > cover(best) ? a : best))).id;
}

/**
 * Galaxies drawn from real images (all galaxies of the data file except the Milky Way, which is a documented model).
 *  - deprojected-image: textured plane in the disc plane from the published position angle and inclination.
 *  - observed-image: flat sky-plane image facing the Sun ("projected image, no depth").
 *  - no image: marker and a glow of the catalogue's isophote only.
 * One draw call per visible image, plus one instanced draw for every marker and glow.
 */
export class GalaxyRenderer implements DeepSubRenderer {
  readonly name = 'galaxies';
  readonly layerKind = 'galaxies' as const;
  readonly group = new THREE.Group();
  private readonly entries = new Map<string, Entry>();
  private readonly splats: SplatSet;
  private readonly infos = new Map<string, DeepScreenInfo>();
  private readonly out: DeepScreenInfo[] = [];
  private readonly ell: ScreenEllipse = { a: 0, b: 0, angle: 0, x: 0, y: 0, depth: 0 };
  private readonly rel: [number, number, number] = [0, 0, 0];
  private lastStats: DeepRendererStats = { drawCalls: 0, textureBytes: 0, pointsDrawn: 0, objectsVisible: 0 };
  private lastDt = 0;
  private lastNow = 0;

  constructor(data: DeepSpaceData, private readonly assets: DeepSpaceAssetManager<THREE.Texture>) {
    const list = data.byKind('galaxy').filter((o) => o.id !== 'milky-way' && data.positionPc(o.id));
    this.splats = new SplatSet(Math.max(1, list.length * 2));
    this.group.add(this.splats.mesh);
    for (const o of list) {
      const pos = data.positionPc(o.id)!;
      const imgs = data.imageAssetsOf(o.id);
      const placements = new Map<string, ImagePlacement>();
      for (const a of imgs) placements.set(a.id, placeImage(o, a));
      const defId = defaultAssetId(imgs, o.angularSize?.majorArcmin);
      const first = placements.get(defId ?? '');
      const glow = galaxyGlowAxes(o, first?.halfSizePc);
      const radiusPc = glow?.radiusPc ?? first?.halfSizePc ?? 1;
      const dM = distanceMetres(o.sky!.distance!).metres;
      const mag = numeric(o, 'magV') ?? numeric(o, 'magB') ?? numeric(o, 'magB_total_hyperleda');
      this.entries.set(o.id, {
        obj: o, pos, distPc: length(pos), radiusPc, physMetres: o.angularSize ? physicalSizeMetres(o.angularSize.majorArcmin, dM) : radiusPc * 2 * PC,
        mag, glow, assets: imgs, placements, chosen: defId, shown: undefined, mesh: null, material: null, lodLevel: undefined,
        imgFade: 0, lastShownTexture: null, lastLabel: '', vignetteFor: undefined,
      });
      assets.registerAssets(imgs);
    }
  }

  ids(): string[] { return [...this.entries.keys()]; }
  has(id: string): boolean { return this.entries.has(id); }
  positionPc(id: string): Vec3 | undefined { return this.entries.get(id)?.pos; }
  radiusPc(id: string): number | undefined { return this.entries.get(id)?.radiusPc; }
  /** Where an asset's picture sits (for tests and QA): the galaxy position, the picture centre offset from it and the half-axes, all Sun-centred ICRS parsecs. */
  placementOf(id: string, assetId?: string): { readonly position: Vec3; readonly offset: Vec3; readonly xAxis: Vec3; readonly yAxis: Vec3; readonly kind: string } | undefined {
    const e = this.entries.get(id);
    const pl = e?.placements.get(assetId ?? e.shown ?? e.chosen ?? '');
    return e && pl ? { position: e.pos, offset: pl.offset, xAxis: pl.xAxis, yAxis: pl.yAxis, kind: pl.kind } : undefined;
  }

  viewDistancePc(id: string): number | undefined {
    const e = this.entries.get(id);
    return e ? 2.2 * 2 * e.radiusPc : undefined;
  }

  setBand(objectId: string, assetId: string): boolean {
    const e = this.entries.get(objectId);
    if (!e || !e.assets.some((a) => a.id === assetId)) return false;
    e.chosen = assetId;
    return true;
  }
  activeAsset(objectId: string): string | undefined { const e = this.entries.get(objectId); return e?.shown ?? e?.chosen; }

  update(ctx: DeepRenderContext): readonly DeepScreenInfo[] {
    const V = GALAXY_VISUAL;
    const { camPc, basis, viewport, pixelsPerRadian: ppr, nowSeconds } = ctx;
    this.lastDt = this.lastNow > 0 ? Math.min(0.25, nowSeconds - this.lastNow) : 0;
    this.lastNow = nowSeconds;
    this.out.length = 0;
    this.splats.setView(viewport.width, viewport.height, ppr);
    const halfDiag = Math.atan(Math.hypot(viewport.width / 2, viewport.height / 2) / ppr);
    const farFade = ctx.farFade ?? 1;
    let n = 0, visible = 0, calls = 0, anyAlpha = false;
    const rel = this.rel;
    for (const e of this.entries.values()) {
      rel[0] = e.pos[0] - camPc[0]; rel[1] = e.pos[1] - camPc[1]; rel[2] = e.pos[2] - camPc[2];
      const dist = Math.hypot(rel[0], rel[1], rel[2]);
      const fwd = basis.forward;
      const z = rel[0] * fwd[0] + rel[1] * fwd[1] + rel[2] * fwd[2];
      // Screen ellipse of the catalogue extent (tilted disc or sky ellipse).
      let ellOk = false;
      let a = 0, b = 0, angle = 0, sx = 0, sy = 0;
      if (e.glow) {
        ellOk = projectEllipse(rel as unknown as Vec3, e.glow.A, e.glow.B, basis.right, basis.up, basis.forward, ppr, this.ell);
        if (ellOk) { a = this.ell.a; b = this.ell.b; angle = this.ell.angle; sx = this.ell.x; sy = this.ell.y; }
      }
      if (!ellOk) {
        a = b = (e.radiusPc / Math.max(dist, 1e-9)) * ppr;
        if (z > 0) { sx = (rel[0] * basis.right[0] + rel[1] * basis.right[1] + rel[2] * basis.right[2]) / z * ppr; sy = (rel[0] * basis.up[0] + rel[1] * basis.up[1] + rel[2] * basis.up[2]) / z * ppr; }
      }
      const screenX = viewport.width / 2 + sx, screenY = viewport.height / 2 - sy;
      // Nominal apparent size from the bounding sphere (unaffected by the grazing-angle distortion of the ellipse).
      const apparentDiameterPx = Math.min(1e6, (2 * e.radiusPc / Math.max(dist, 1e-9)) * ppr);
      const angRad = Math.atan2(e.radiusPc, Math.max(dist, 1e-9));
      const thetaC = Math.acos(Math.max(-1, Math.min(1, z / Math.max(dist, 1e-9))));
      const onScreen = thetaC - angRad < halfDiag && farFade > 0.002;
      if (!(ellOk && a < 3e4 && b < 3e4)) { a = b = apparentDiameterPx / 2; }
      const hasImage = e.assets.length > 0;
      const lod = objectLod({ apparentDiameterPx, distanceMetres: Math.max(dist, 1e-9) * PC, physicalSizeMetres: e.physMetres, ...(e.lodLevel !== undefined ? { previousLevel: e.lodLevel } : {}), hasDetail: hasImage });
      e.lodLevel = lod.level;

      // ---- thumbnail (tint, exposure): wanted as soon as the object is more than a speck and on screen
      let stats: ImageStats | null = null;
      const chosenAsset = e.chosen;
      if (onScreen && chosenAsset && apparentDiameterPx >= 1.6) {
        const v = this.assets.want(chosenAsset, { onScreenPx: 0, devicePixelRatio: ctx.pixelRatio, quality: ctx.quality, thumbnailOnly: true, nowSeconds });
        stats = v?.stats ?? null;
      }
      const tint = tintFrom(stats);

      // ---- marker + glow splats
      const mAlpha = onScreen ? lod.marker * markerAlpha(e.mag) * farFade : 0;
      if (mAlpha > 0.001) anyAlpha = true;
      this.splats.setStatic(n, V.markerRadiusPx, V.markerRadiusPx, 0, 0, tint[0], tint[1], tint[2], mAlpha, V.markerPower);
      this.splats.setCentre(n, rel[0], rel[1], rel[2]);
      n++;

      // ---- image
      let imageW = onScreen ? lod.image * farFade : 0;
      let glowW = onScreen ? lod.glow * farFade : 0;
      let lodLabel: string = lod.stage;
      let note: string | undefined;
      let imageDrawn = false;
      if (e.obj.representation.kind === 'deprojected-image') note = e.placements.get(e.shown ?? e.chosen ?? '')?.tiltIsChoice ? 'deprojected image, tilt direction illustrative' : 'deprojected image';
      else if (hasImage) note = 'projected image, no depth';
      else note = 'no image in the atlas: marker and catalogue extent only';
      if (hasImage && imageW > 0.002) {
        const wantAsset = e.chosen!;
        const pl = e.placements.get(wantAsset)!;
        const sizePx = Math.min(16384, (2 * pl.halfSizePc / Math.max(dist, 1e-9)) * ppr);
        const view = this.assets.want(wantAsset, { onScreenPx: sizePx, devicePixelRatio: ctx.pixelRatio, quality: ctx.quality, nowSeconds });
        let drawView: AssetView<THREE.Texture> | null = view;
        let drawAsset = wantAsset;
        if (!view?.texture) {
          // The newly chosen band is not ready: keep drawing the previous one until it is (an instant swap, no blank frame).
          if (e.shown && e.shown !== wantAsset) {
            drawView = this.assets.want(e.shown, { onScreenPx: sizePx, devicePixelRatio: ctx.pixelRatio, quality: ctx.quality, nowSeconds });
            drawAsset = e.shown;
          }
        }
        if (drawView?.texture) {
          if (e.shown !== drawAsset) { e.shown = drawAsset; e.lastShownTexture = null; if (drawAsset === wantAsset) { /* band swap complete */ } }
          const dp = e.placements.get(drawAsset)!;
          const mesh = this.ensureMesh(e);
          const mat = e.material!;
          const u = mat.uniforms as Record<string, { value: unknown }>;
          if (u['uMap']!.value !== drawView.texture) u['uMap']!.value = drawView.texture;
          const st = stretchFor(drawView.stats);
          // fade-in once per shown asset
          e.imgFade = Math.min(1, e.imgFade + this.lastDt / V.imageFadeSeconds);
          let facing = 1;
          if (dp.kind === 'sky-plane' && dist > 0) {
            facing = Math.abs((rel[0] * dp.normal[0] + rel[1] * dp.normal[1] + rel[2] * dp.normal[2]) / dist);
            const t = Math.min(1, Math.max(0, (facing - 0.06) / 0.4));
            facing = V.edgeOnMinWeight + (1 - V.edgeOnMinWeight) * t * t * (3 - 2 * t);
          }
          const w = imageW * e.imgFade * facing;
          u['uWeight']!.value = w;
          u['uExposure']!.value = st.gain;
          u['uBlack']!.value = st.black;
          if (e.vignetteFor !== drawAsset) { e.vignetteFor = drawAsset; (u['uV0']!.value as THREE.Vector2).set(dp.vignette.row0[0], dp.vignette.row0[1]); (u['uV1']!.value as THREE.Vector2).set(dp.vignette.row1[0], dp.vignette.row1[1]); (u['uVc']!.value as THREE.Vector2).set(dp.vignette.c[0], dp.vignette.c[1]); }
          u['uTint']!.value = ONE;
          setQuadMatrix(mesh, dp, rel);
          mesh.visible = w > 0.001;
          if (mesh.visible) { calls++; imageDrawn = true; }
          // while the image is not yet fully in, the glow keeps the energy
          glowW += imageW * (1 - e.imgFade * facing);
          imageW = w;
          lodLabel = `image-L${drawView.level}`;
          if (drawView.level !== drawView.wantedLevel) lodLabel += `->L${drawView.wantedLevel}`;
        } else {
          glowW += imageW; imageW = 0; lodLabel = 'glow (image loading)';
          if (e.mesh) e.mesh.visible = false;
        }
      } else {
        e.imgFade = Math.max(0, e.imgFade - this.lastDt / V.imageFadeSeconds);
        if (e.mesh) e.mesh.visible = false;
        if (e.imgFade > 0 && e.shown && onScreen) { /* fading out handled by the crossfade weights */ }
      }
      if (!hasImage && lod.image > 0) lodLabel = 'glow';

      // glow splat (extent ellipse), written even when weight 0 (alpha 0) so the instance table stays contiguous
      const gAlpha = glowW > 0.001 ? glowW * V.glowAlpha : 0;
      const ga = Math.max(V.glowMinSemiAxisPx, a * V.glowExtent), gb = Math.max(V.glowMinSemiAxisPx, b * V.glowExtent);
      if (onScreen && gAlpha > 0.001) anyAlpha = true;
      this.splats.setStatic(n, ga, gb, angle, 0, tint[0], tint[1], tint[2], onScreen ? gAlpha : 0, V.glowPower);
      this.splats.setCentre(n, rel[0], rel[1], rel[2]);
      n++;
      if (!imageDrawn && e.mesh) e.mesh.visible = false;

      const pixelRadius = Math.max(V.minPickRadiusPx, Math.max(a, b));
      if (onScreen) visible++;
      const pickable = onScreen && isPickableWeight(Math.max(lod.marker, lod.glow, lod.image) * farFade);
      const label = e.obj.name;
      let info = this.infos.get(e.obj.id);
      if (!info || info.x !== screenX || info.y !== screenY || info.lod !== lodLabel || info.pixelRadius !== pixelRadius || info.visible !== onScreen || info.pickable !== pickable) {
        info = { id: e.obj.id, kind: 'galaxy', x: screenX, y: screenY, pixelRadius, distancePc: dist, visible: onScreen, pickable, lod: lodLabel, label, ...(note ? { representationNote: note } : {}) };
        this.infos.set(e.obj.id, info);
      }
      this.out.push(info);
    }
    this.splats.setCount(anyAlpha ? n : 0);
    this.splats.commit();
    if (anyAlpha) calls++;
    this.lastStats = { drawCalls: calls, textureBytes: 0, pointsDrawn: n, objectsVisible: visible };
    return this.out;
  }

  stats(): DeepRendererStats { return this.lastStats; }

  dispose(): void {
    for (const e of this.entries.values()) { e.material?.dispose(); }
    this.splats.dispose();
    this.entries.clear();
    this.infos.clear();
    this.group.clear();
  }

  private ensureMesh(e: Entry): THREE.Mesh {
    if (e.mesh) return e.mesh;
    const mat = new THREE.ShaderMaterial({
      vertexShader: IMAGE_VERTEX, fragmentShader: IMAGE_FRAGMENT,
      transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      uniforms: { uMap: { value: null }, uWeight: { value: 0 }, uExposure: { value: 1 }, uBlack: { value: 0 }, uTint: { value: ONE }, uFeather: { value: GALAXY_VISUAL.edgeFeather }, uV0: { value: new THREE.Vector2() }, uV1: { value: new THREE.Vector2() }, uVc: { value: new THREE.Vector2() } },
    });
    const mesh = new THREE.Mesh(unitQuad(), mat);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false;
    mesh.visible = false;
    mesh.name = `galaxy-image:${e.obj.id}`;
    this.group.add(mesh);
    e.mesh = mesh; e.material = mat;
    return mesh;
  }
}

const ONE = new THREE.Vector3(1, 1, 1);

/** Black level (linear) and gain for an image from its thumbnail statistics. */
export function stretchFor(stats: ImageStats | null): { black: number; gain: number } {
  const V = GALAXY_VISUAL;
  if (!stats || !(stats.p99 > 1e-4)) return { black: 0, gain: 1.4 };
  const black = Math.min(V.blackFromMedian * stats.median, 0.9 * stats.p99);
  const gain = Math.min(V.exposureMax, Math.max(V.exposureMin, V.targetP99 / Math.max(stats.p99 - black, 0.02)));
  return { black, gain };
}

const tintOut: [number, number, number] = [1, 1, 1];
function tintFrom(stats: ImageStats | null): readonly [number, number, number] {
  const V = GALAXY_VISUAL;
  if (!stats) return V.defaultTint;
  const m = stats.mean, mx = Math.max(m[0], m[1], m[2], 1e-6);
  const s = V.tintStrength;
  for (let k = 0; k < 3; k++) tintOut[k] = (1 - s) * V.defaultTint[k]! + s * (m[k]! / mx) * 0.95;
  return tintOut;
}

const M_REUSE = new THREE.Matrix4();
function setQuadMatrix(mesh: THREE.Mesh, p: ImagePlacement, rel: readonly number[]): void {
  const tx = rel[0]! + p.offset[0], ty = rel[1]! + p.offset[1], tz = rel[2]! + p.offset[2];
  // columns: x axis, y axis, normal, translation (camera-relative, float64 until Three narrows the model-view matrix)
  M_REUSE.set(
    p.xAxis[0], p.yAxis[0], p.normal[0], tx,
    p.xAxis[1], p.yAxis[1], p.normal[1], ty,
    p.xAxis[2], p.yAxis[2], p.normal[2], tz,
    0, 0, 0, 1,
  );
  mesh.matrix.copy(M_REUSE);
  mesh.matrixWorld.copy(M_REUSE);
}

