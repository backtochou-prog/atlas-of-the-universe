import * as THREE from 'three';
import { distanceMetres, physicalSizeMetres } from '../../core/deepspace/geometry';
import { isPickableWeight } from '../../core/deepspace/pick';
import { dot, type Vec3 } from '../../core/spatial/vec3';
import { METRES_PER_PARSEC } from '../../core/units';
import type { DeepSpaceData } from '../../data/deepspace/deepSpaceData';
import type { DeepImageAsset, DeepSpaceObject } from '../../data/deepspace/types';
import type { AssetView, DeepSpaceAssetManager, ImageStats } from './DeepSpaceAssetManager';
import { logSmoothstep, objectLod } from './DeepSpaceLOD';
import { GALAXY_VISUAL } from './GalaxyRenderer';
import { projectEllipse, type ScreenEllipse } from './galaxyGeometry';
import {
  defaultNebulaAssetId, edgeOnFade, layerCountFor, layerOffsetsPc, layerQuads, NEBULA_VISUAL, nebulaNote, nebulaStretch, orderingFor, placeNebulaAsset, thicknessPcFor,
  type NebulaPlacement,
} from './nebulaGeometry';
import { NEBULA_FRAGMENT, NEBULA_VERTEX } from './nebulaShaders';
import type { ExtraRendererDeps } from './extraRenderers';
import { SplatSet } from './SplatSet';
import type { DeepRenderContext, DeepRendererStats, DeepScreenInfo, DeepSubRenderer } from './types';

const PC = METRES_PER_PARSEC;
const MAX_LAYERS = NEBULA_VISUAL.layersMax;

interface Entry {
  readonly obj: DeepSpaceObject;
  readonly pos: Vec3;
  readonly distPc: number;
  readonly assets: readonly DeepImageAsset[];
  readonly placements: Map<string, NebulaPlacement>;
  /** Catalogue extent (or, without one, the default field) as a physical diameter, metres, and the radius of its bounding sphere, parsecs. */
  readonly extentRadiusPc: number;
  readonly extentMetres: number;
  readonly thicknessFraction: number;
  chosen: string | undefined;
  shown: string | undefined;
  mesh: THREE.Mesh | null;
  material: THREE.ShaderMaterial | null;
  geo: THREE.InstancedBufferGeometry | null;
  attrs: { centre: Float32Array; x: Float32Array; y: Float32Array } | null;
  lvlExtent: number | undefined;
  lvlImage: number | undefined;
  imgFade: number;
  layers: number;
  lastLabel: string;
}

/** What the last update() decided for an object (for tests, QA and the UI). */
export interface NebulaLayerState {
  readonly assetId: string | undefined;
  readonly layers: number;
  readonly offsetsPc: readonly number[];
  readonly thicknessPc: number;
  readonly facing: number;
  readonly fade: number;
}

/**
 * Nebulae drawn from real archive images as an ILLUSTRATIVE stack of depth layers (see nebulaGeometry.ts).
 *  marker (fixed documented brightness, no magnitudes exist) -> glow (tint from the level-0 thumbnail) -> image layers.
 * Draw calls: ONE instanced draw per visible nebula (all layers share one geometry, one material, one texture), plus one shared
 * instanced draw for every marker and glow. Nebulae that are off screen cost nothing (no mesh, no texture request).
 */
export class NebulaRenderer implements DeepSubRenderer {
  readonly name = 'nebulae';
  readonly layerKind = 'nebulae' as const;
  readonly group = new THREE.Group();
  private readonly entries = new Map<string, Entry>();
  private readonly splats: SplatSet;
  private readonly infos = new Map<string, DeepScreenInfo>();
  private readonly out: DeepScreenInfo[] = [];
  private readonly states = new Map<string, NebulaLayerState>();
  private readonly ell: ScreenEllipse = { a: 0, b: 0, angle: 0, x: 0, y: 0, depth: 0 };
  private lastStats: DeepRendererStats = { drawCalls: 0, textureBytes: 0, pointsDrawn: 0, objectsVisible: 0 };
  private lastDt = 0;
  private lastNow = 0;
  private quality = 1;

  constructor(data: DeepSpaceData, private readonly assets: DeepSpaceAssetManager<THREE.Texture>) {
    const list = data.byKind('nebula').filter((o) => data.positionPc(o.id) && o.sky?.distance);
    this.splats = new SplatSet(Math.max(1, list.length * 2));
    this.group.add(this.splats.mesh);
    for (const o of list) {
      const imgs = data.imageAssetsOf(o.id);
      const placements = new Map<string, NebulaPlacement>();
      for (const a of imgs) placements.set(a.id, placeNebulaAsset(o, a));
      const defId = defaultNebulaAssetId(imgs);
      const dM = distanceMetres(o.sky!.distance!).metres;
      const major = o.angularSize?.majorArcmin ?? (defId ? placements.get(defId)!.fovMaxArcmin : 1);
      const extentMetres = physicalSizeMetres(major, dM);
      this.entries.set(o.id, {
        obj: o, pos: data.positionPc(o.id)!, distPc: dM / PC, assets: imgs, placements, extentMetres, extentRadiusPc: extentMetres / 2 / PC,
        thicknessFraction: o.nebulaClass ? NEBULA_VISUAL.thicknessFraction[o.nebulaClass] : 0.25,
        chosen: defId, shown: undefined, mesh: null, material: null, geo: null, attrs: null, lvlExtent: undefined, lvlImage: undefined, imgFade: 0, layers: 0, lastLabel: '',
      });
      assets.registerAssets(imgs);
    }
  }

  ids(): string[] { return [...this.entries.keys()]; }
  has(id: string): boolean { return this.entries.has(id); }
  positionPc(id: string): Vec3 | undefined { return this.entries.get(id)?.pos; }
  placement(id: string, assetId?: string): NebulaPlacement | undefined {
    const e = this.entries.get(id);
    return e ? e.placements.get(assetId ?? e.shown ?? e.chosen ?? '') : undefined;
  }
  /** State of the depth layers as last drawn (undefined before the first frame in which the nebula was on screen). */
  layerState(id: string): NebulaLayerState | undefined { return this.states.get(id); }

  /** ~2x the physical diameter (longer side) of the primary asset's field; without an image, 2x the catalogue extent. */
  viewDistancePc(id: string): number | undefined {
    const e = this.entries.get(id);
    if (!e) return undefined;
    const p = e.placements.get(e.chosen ?? '');
    return 2 * (p ? p.transversePc : e.extentRadiusPc * 2);
  }

  setBand(objectId: string, assetId: string): boolean {
    const e = this.entries.get(objectId);
    if (!e || !e.assets.some((a) => a.id === assetId)) return false;
    e.chosen = assetId;
    return true;
  }
  activeAsset(objectId: string): string | undefined { const e = this.entries.get(objectId); return e?.shown ?? e?.chosen; }
  setQuality(q: number): void { this.quality = Math.min(1, Math.max(0.25, q)); }

  update(ctx: DeepRenderContext): readonly DeepScreenInfo[] {
    const V = NEBULA_VISUAL;
    const { camPc, basis, viewport, pixelsPerRadian: ppr, nowSeconds } = ctx;
    this.lastDt = this.lastNow > 0 ? Math.min(0.25, Math.max(0, nowSeconds - this.lastNow)) : 0;
    this.lastNow = nowSeconds;
    this.out.length = 0;
    this.splats.setView(viewport.width, viewport.height, ppr);
    const halfDiag = Math.atan(Math.hypot(viewport.width / 2, viewport.height / 2) / ppr);
    const nLayers = layerCountFor(ctx.quality ?? this.quality);
    let n = 0, visible = 0, calls = 0, anyAlpha = false;
    const rel: [number, number, number] = [0, 0, 0], relC: [number, number, number] = [0, 0, 0];
    const fwd = basis.forward;
    for (const e of this.entries.values()) {
      rel[0] = e.pos[0] - camPc[0]; rel[1] = e.pos[1] - camPc[1]; rel[2] = e.pos[2] - camPc[2];
      const dist = Math.max(Math.hypot(rel[0], rel[1], rel[2]), 1e-9);
      const fade = 1 - logSmoothstep(dist, V.galacticFadeFromPc, V.galacticFadeToPc);
      const hasImage = e.assets.length > 0 && e.chosen !== undefined;
      const wantId = e.chosen;
      const shownId = e.shown ?? wantId;
      const pl = hasImage ? e.placements.get(shownId!)! : undefined;
      const thicknessPc = pl ? thicknessPcFor(e.obj.nebulaClass, pl.transversePc) : 0;
      if (pl) { relC[0] = pl.centre[0] - camPc[0]; relC[1] = pl.centre[1] - camPc[1]; relC[2] = pl.centre[2] - camPc[2]; }
      else { relC[0] = rel[0]; relC[1] = rel[1]; relC[2] = rel[2]; }
      const distC = Math.max(Math.hypot(relC[0], relC[1], relC[2]), 1e-9);

      // ---- cheap culling: the bounding spheres of the catalogue extent (marker/glow) and of the image stack against the view cone
      const coneOut = (v: readonly number[], d: number, radius: number) => {
        const z = v[0]! * fwd[0] + v[1]! * fwd[1] + v[2]! * fwd[2];
        const theta = Math.acos(Math.max(-1, Math.min(1, z / d)));
        return theta - Math.atan2(radius, d) >= halfDiag;
      };
      const objOn = !coneOut(rel, dist, e.extentRadiusPc);
      const imgOn = pl ? !coneOut(relC, distC, pl.halfDiagPc + thicknessPc / 2) : false;
      const onScreen = (objOn || imgOn) && fade > 0.002;
      if (!onScreen) {
        if (e.mesh) e.mesh.visible = false;
        e.imgFade = Math.max(0, e.imgFade - this.lastDt / V.imageFadeSeconds);
        // every instance slot stays defined (alpha 0) so the table is contiguous
        this.splats.setStatic(n, 1, 1, 0, 0, 0, 0, 0, 0, 1); this.splats.setCentre(n, rel[0], rel[1], rel[2]); n++;
        this.splats.setStatic(n, 1, 1, 0, 0, 0, 0, 0, 0, 1); this.splats.setCentre(n, rel[0], rel[1], rel[2]); n++;
        this.pushInfo(e, -1, -1, V.minPickRadiusPx, dist, false, 'offscreen', undefined, false);
        continue;
      }

      // ---- sizes (CSS px)
      const extentPx = Math.min(1e6, (2 * e.extentRadiusPc / dist) * ppr);
      const imagePx = pl ? Math.min(1e6, (pl.transversePc / distC) * ppr) : 0;
      const lodE = objectLod({ apparentDiameterPx: extentPx, distanceMetres: dist * PC, physicalSizeMetres: e.extentMetres, ...(e.lvlExtent !== undefined ? { previousLevel: e.lvlExtent } : {}), hasDetail: hasImage });
      e.lvlExtent = lodE.level;
      const lodI = pl ? objectLod({ apparentDiameterPx: imagePx, distanceMetres: distC * PC, physicalSizeMetres: pl.transversePc * PC, ...(e.lvlImage !== undefined ? { previousLevel: e.lvlImage } : {}), hasDetail: true }) : null;
      if (lodI) e.lvlImage = lodI.level;

      // ---- thumbnail (tint, stretch): wanted as soon as the object is more than a speck
      let stats: ImageStats | null = null;
      if (wantId && Math.max(extentPx, imagePx) >= 1.6) {
        stats = this.assets.want(wantId, { onScreenPx: 0, devicePixelRatio: ctx.pixelRatio, quality: ctx.quality, thumbnailOnly: true, nowSeconds })?.stats ?? null;
      }
      const tint = tintFrom(stats);

      // ---- weights: marker from the catalogue extent, image from the size of the field itself, glow takes the remainder
      const markerW = lodE.marker * fade;
      let imageW = lodI ? lodI.image * fade : 0;
      let glowW = hasImage ? Math.max(0, 1 - lodE.marker - (lodI ? lodI.image : 0)) * fade : lodE.glow * fade;
      let lodLabel: string = hasImage ? (imageW > 0.5 ? 'image' : lodE.marker > 0.5 ? 'marker' : 'glow') : lodE.stage;
      let imageDrawn = false;
      let facing = 1, fromBehind = false;

      if (pl && hasImage && imageW > 0.002) {
        const sizePx = Math.min(16384, imagePx);
        const view = this.assets.want(wantId!, { onScreenPx: sizePx, devicePixelRatio: ctx.pixelRatio, quality: ctx.quality, nowSeconds });
        let drawView: AssetView<THREE.Texture> | null = view;
        let drawAsset = wantId!;
        if (!view?.texture && e.shown && e.shown !== wantId) {
          // the newly chosen band is not ready: keep drawing the previous one (an instant swap, no blank frame)
          drawView = this.assets.want(e.shown, { onScreenPx: sizePx, devicePixelRatio: ctx.pixelRatio, quality: ctx.quality, nowSeconds });
          drawAsset = e.shown;
        }
        if (drawView?.texture) {
          e.shown = drawAsset;
          const dp = e.placements.get(drawAsset)!;
          const dpThickness = thicknessPcFor(e.obj.nebulaClass, dp.transversePc);
          if (dp !== pl) { relC[0] = dp.centre[0] - camPc[0]; relC[1] = dp.centre[1] - camPc[1]; relC[2] = dp.centre[2] - camPc[2]; }
          const dC = Math.max(Math.hypot(relC[0], relC[1], relC[2]), 1e-9);
          const cosN = dot(relC as unknown as Vec3, dp.normal) / dC;
          facing = Math.abs(cosN); fromBehind = cosN > V.behindMinFacing;
          const mesh = this.ensureMesh(e);
          const mat = e.material!;
          const u = mat.uniforms as Record<string, { value: unknown }>;
          if (u['uMap']!.value !== drawView.texture) u['uMap']!.value = drawView.texture;
          const st = nebulaStretch(drawView.stats);
          e.imgFade = Math.min(1, e.imgFade + this.lastDt / V.imageFadeSeconds);
          const w = imageW * e.imgFade * edgeOnFade(facing);
          u['uWeight']!.value = w;
          u['uExposure']!.value = st.gain;
          u['uBlack']!.value = st.black;
          u['uLayers']!.value = nLayers;
          u['uColourWeight']!.value = e.obj.nebulaClass ? V.colourBandWeight[e.obj.nebulaClass] : 0;
          u['uBandBias']!.value = Math.min(8, Math.max(0, Math.log2(Math.max(1, V.bandBlurFraction * drawView.levelSizePx))));
          // the layers (float64 here, narrowed after the camera subtraction)
          const offs = layerOffsetsPc(nLayers, dpThickness, orderingFor(e.obj.nebulaClass));
          const quads = layerQuads(dp, offs);
          const a = e.attrs!;
          for (let k = 0; k < nLayers; k++) {
            const q = quads[k]!;
            a.centre[3 * k] = q.centre[0] - camPc[0]; a.centre[3 * k + 1] = q.centre[1] - camPc[1]; a.centre[3 * k + 2] = q.centre[2] - camPc[2];
            a.x[3 * k] = q.xAxis[0]; a.x[3 * k + 1] = q.xAxis[1]; a.x[3 * k + 2] = q.xAxis[2];
            a.y[3 * k] = q.yAxis[0]; a.y[3 * k + 1] = q.yAxis[1]; a.y[3 * k + 2] = q.yAxis[2];
          }
          const g = e.geo!;
          g.instanceCount = nLayers;
          for (const nm of ['aCentre', 'aX', 'aY']) (g.getAttribute(nm) as THREE.InstancedBufferAttribute).needsUpdate = true;
          e.layers = nLayers;
          mesh.visible = w > 0.001;
          if (mesh.visible) { calls++; imageDrawn = true; }
          // While the image is still fading in, the glow keeps the energy. The edge-on fade deliberately does NOT hand its light to
          // the glow: that would invent volume.
          glowW += imageW * (1 - e.imgFade);
          imageW = w;
          lodLabel = `image-L${drawView.level}`;
          if (drawView.level !== drawView.wantedLevel) lodLabel += `->L${drawView.wantedLevel}`;
          this.states.set(e.obj.id, { assetId: drawAsset, layers: nLayers, offsetsPc: offs, thicknessPc: dpThickness, facing, fade: edgeOnFade(facing) });
        } else {
          glowW += imageW; imageW = 0; lodLabel = 'glow (image loading)';
          if (e.mesh) e.mesh.visible = false;
        }
      } else {
        e.imgFade = Math.max(0, e.imgFade - this.lastDt / V.imageFadeSeconds);
        if (e.mesh) e.mesh.visible = false;
      }
      if (!imageDrawn && e.mesh) e.mesh.visible = false;
      const dpl = e.placements.get(e.shown ?? wantId ?? '') ?? pl;

      // ---- marker (at the catalogue position)
      const mAlpha = markerW * V.markerAlpha;
      if (mAlpha > 0.001) anyAlpha = true;
      this.splats.setStatic(n, V.markerRadiusPx, V.markerRadiusPx, 0, 0, tint[0], tint[1], tint[2], mAlpha, V.markerPower);
      this.splats.setCentre(n, rel[0], rel[1], rel[2]);
      n++;

      // ---- glow: the footprint of the field (an ellipse inscribed in the image rectangle), or the catalogue extent without an image
      let ga: number, gb: number, gAngle = 0, gcx = rel[0], gcy = rel[1], gcz = rel[2];
      let sx = 0, sy = 0, hasScreen = false;
      const projPoint = (v: readonly number[]): boolean => {
        const z = v[0]! * fwd[0] + v[1]! * fwd[1] + v[2]! * fwd[2];
        if (!(z > 0)) return false;
        sx = (v[0]! * basis.right[0] + v[1]! * basis.right[1] + v[2]! * basis.right[2]) / z * ppr;
        sy = (v[0]! * basis.up[0] + v[1]! * basis.up[1] + v[2]! * basis.up[2]) / z * ppr;
        return true;
      };
      const radiusPxExtent = extentPx / 2;
      let radiusPx = radiusPxExtent;
      let scrX = viewport.width / 2, scrY = viewport.height / 2;
      if (dpl && hasImage && projectEllipse(relC as unknown as Vec3, dpl.xAxis, dpl.yAxis, basis.right, basis.up, fwd, ppr, this.ell) && this.ell.a < 3e4 && this.ell.b < 3e4) {
        ga = Math.max(V.glowMinSemiAxisPx, this.ell.a * V.glowExtent); gb = Math.max(V.glowMinSemiAxisPx, this.ell.b * V.glowExtent); gAngle = this.ell.angle;
        gcx = relC[0]; gcy = relC[1]; gcz = relC[2];
        radiusPx = Math.min(1e5, Math.max(this.ell.a, this.ell.b));
        // screen anchor of the label/pick disc: the catalogue position at small scale, the field's centre once the image takes over
        const wI = lodI ? lodI.image : 0;
        const okO = projPoint(rel); const ox = sx, oy = sy;
        const okC = projPoint(relC);
        const cx = sx, cy = sy;
        // The radius is NOT blended with the catalogue extent: the glow, the image and the pick disc all share the image field's own
        // footprint (the catalogue extent can be 10-20 % larger or smaller than the asset's field, and blending towards it made the
        // reported size shrink at the glow -> image hand-off). Only the anchor point crossfades, by the image weight.
        if (okO && okC) { sx = ox + (cx - ox) * wI; sy = oy + (cy - oy) * wI; hasScreen = true; }
        else if (okC) { hasScreen = true; } else if (okO) { sx = ox; sy = oy; hasScreen = true; }
      } else {
        ga = gb = Math.max(V.glowMinSemiAxisPx, Math.min(3e4, radiusPxExtent) * V.glowExtent);
        hasScreen = projPoint(rel);
      }
      if (hasScreen) { scrX = viewport.width / 2 + sx; scrY = viewport.height / 2 - sy; } else { scrX = -1e4; scrY = -1e4; }
      const gAlpha = glowW > 0.001 ? glowW * V.glowAlpha : 0;
      if (gAlpha > 0.001) anyAlpha = true;
      this.splats.setStatic(n, ga, gb, gAngle, 0, tint[0], tint[1], tint[2], gAlpha, V.glowPower);
      this.splats.setCentre(n, gcx, gcy, gcz);
      n++;

      visible++;
      const note = nebulaNote({ asset: e.assets.find((x) => x.id === (e.shown ?? wantId)), placement: dpl, nebulaClass: e.obj.nebulaClass, imageShown: imageDrawn, facing, fromBehind });
      this.pushInfo(e, scrX, scrY, Math.max(V.minPickRadiusPx, radiusPx), dist, hasScreen, lodLabel, note, hasScreen && isPickableWeight(Math.max(markerW, imageW, glowW)));
    }
    this.splats.setCount(anyAlpha ? n : 0);
    this.splats.commit();
    if (anyAlpha) calls++;
    this.lastStats = { drawCalls: calls, textureBytes: 0, pointsDrawn: n, objectsVisible: visible };
    return this.out;
  }

  stats(): DeepRendererStats { return this.lastStats; }

  dispose(): void {
    for (const e of this.entries.values()) { e.material?.dispose(); e.geo?.dispose(); }
    this.splats.dispose();
    this.entries.clear();
    this.infos.clear();
    this.states.clear();
    this.group.clear();
  }

  private pushInfo(e: Entry, x: number, y: number, pixelRadius: number, dist: number, onScreen: boolean, lod: string, note: string | undefined, pickable: boolean): void {
    let info = this.infos.get(e.obj.id);
    if (!info || info.x !== x || info.y !== y || info.lod !== lod || info.pixelRadius !== pixelRadius || info.visible !== onScreen || info.pickable !== pickable || info.representationNote !== note) {
      info = { id: e.obj.id, kind: 'nebula', x, y, pixelRadius, distancePc: dist, visible: onScreen, pickable, lod, label: e.obj.name, ...(note ? { representationNote: note } : {}) };
      this.infos.set(e.obj.id, info);
    }
    this.out.push(info);
  }

  private ensureMesh(e: Entry): THREE.Mesh {
    if (e.mesh) return e.mesh;
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const centre = new Float32Array(MAX_LAYERS * 3), x = new Float32Array(MAX_LAYERS * 3), y = new Float32Array(MAX_LAYERS * 3), band = new Float32Array(MAX_LAYERS);
    for (let k = 0; k < MAX_LAYERS; k++) band[k] = k;
    const mk = (arr: Float32Array, n: number, dyn: boolean) => { const a = new THREE.InstancedBufferAttribute(arr, n); if (dyn) a.setUsage(THREE.DynamicDrawUsage); return a; };
    geo.setAttribute('aCentre', mk(centre, 3, true));
    geo.setAttribute('aX', mk(x, 3, true));
    geo.setAttribute('aY', mk(y, 3, true));
    geo.setAttribute('aBand', mk(band, 1, false));
    geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      vertexShader: NEBULA_VERTEX, fragmentShader: NEBULA_FRAGMENT,
      transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      uniforms: {
        uMap: { value: null }, uWeight: { value: 0 }, uExposure: { value: 1 }, uBlack: { value: 0 }, uFeather: { value: GALAXY_VISUAL.edgeFeather },
        uLayers: { value: 3 }, uColourWeight: { value: 0 }, uKnee: { value: NEBULA_VISUAL.bandKnee }, uBandBias: { value: 3 },
      },
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false;
    mesh.visible = false;
    mesh.name = `nebula-layers:${e.obj.id}`;
    this.group.add(mesh);
    e.mesh = mesh; e.material = mat; e.geo = geo; e.attrs = { centre, x, y };
    return mesh;
  }
}

const tintOut: [number, number, number] = [1, 1, 1];
/** Glow tint from the thumbnail's mean colour, the same recipe as the galaxies (normalised, mixed with a neutral warm white). */
function tintFrom(stats: ImageStats | null): readonly [number, number, number] {
  const V = GALAXY_VISUAL;
  if (!stats) return V.defaultTint;
  const m = stats.mean, mx = Math.max(m[0], m[1], m[2], 1e-6);
  const s = V.tintStrength;
  for (let k = 0; k < 3; k++) tintOut[k] = (1 - s) * V.defaultTint[k]! + s * (m[k]! / mx) * 0.95;
  return tintOut;
}

export function createNebulaRenderers(d: ExtraRendererDeps): readonly DeepSubRenderer[] {
  return [new NebulaRenderer(d.data, d.assets)];
}

