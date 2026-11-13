import * as THREE from 'three';
import { galacticToIcrsVector } from '../../core/astro/coordinates';
import { dot, length, type Vec3 } from '../../core/spatial/vec3';
import { METRES_PER_PARSEC } from '../../core/units';
import type { DeepSpaceData } from '../../data/deepspace/deepSpaceData';
import { logSmoothstep, objectLod } from './DeepSpaceLOD';
import { projectEllipse, type ScreenEllipse } from './galaxyGeometry';
import { buildViewGainTable, readMilkyWayParams, sampleMilkyWay, viewGain, VISUAL as MW_VISUAL, type MilkyWayParams, type MwSplats } from './milkyWayModel';
import { SplatSet } from './SplatSet';
import type { DeepRenderContext, DeepRendererStats, DeepScreenInfo, DeepSubRenderer } from './types';

const PC = METRES_PER_PARSEC;

/** VISUAL parameters of the Milky Way renderer (presentation only; the model's science is in milkyWayModel.ts + the data file). */
export const MW_RENDER_VISUAL = {
  /** The model is drawn when the camera is farther than `fadeInFromPc` from the Sun and fully so beyond `fadeInToPc`. Within a few hundred pc the real Gaia stars are the truth. */
  fadeInFromPc: 300,
  fadeInToPc: 3000,
  /** Far glow and marker. */
  glowColour: [0.95, 0.86, 0.72] as readonly [number, number, number],
  glowAlpha: 0.5,
  glowPower: 1.6,
  glowExtent: 0.9,
  markerAlpha: 0.8,
  markerRadiusPx: 2.0,
  minPickRadiusPx: 4,
  /** Splats whose screen radius would exceed this fade out (fill-rate guard: the camera inside the disc would otherwise overdraw the screen thousands of times). */
  maxSplatPx: 140,
} as const;

/**
 * The Milky Way as a DOCUMENTED MODEL seen from outside: spiral arms (Reid et al. 2019), thin/thick disc, bulge and long bar
 * (Bland-Hawthorn & Gerhard 2016), drawn as a smooth glow of ~4000 large soft splats. Nothing is a star. See milkyWayModel.ts.
 */
export class MilkyWayRenderer implements DeepSubRenderer {
  readonly name = 'milky-way-model';
  readonly layerKind = 'galaxies' as const;
  readonly group = new THREE.Group();
  readonly params: MilkyWayParams;
  readonly splats: MwSplats;
  private readonly gains: Float32Array;
  private readonly body: SplatSet;
  private readonly far: SplatSet;
  private readonly gc: Vec3;
  private readonly normal: Vec3;
  private readonly axisA: Vec3;
  private readonly axisB: Vec3;
  private readonly ell: ScreenEllipse = { a: 0, b: 0, angle: 0, x: 0, y: 0, depth: 0 };
  private lodLevel: number | undefined;
  private lastStats: DeepRendererStats = { drawCalls: 0, textureBytes: 0, pointsDrawn: 0, objectsVisible: 0 };
  private info: DeepScreenInfo | null = null;
  private readonly out: DeepScreenInfo[] = [];
  private quality = 1;
  private readonly rel: [number, number, number] = [0, 0, 0];

  constructor(data: DeepSpaceData) {
    const model = data.file.models['milky-way'];
    if (!model) throw new Error('The data file has no models["milky-way"]');
    this.params = readMilkyWayParams(model);
    this.splats = sampleMilkyWay(this.params);
    this.gains = buildViewGainTable(this.splats);
    this.gc = data.positionPc('milky-way') ?? galacticToIcrsVector([this.params.r0Pc, 0, 0]);
    const R = MW_VISUAL.discRadiusPc * MW_RENDER_VISUAL.glowExtent;
    this.normal = galacticToIcrsVector([0, 0, 1]);
    this.axisA = galacticToIcrsVector([R, 0, 0]);
    this.axisB = galacticToIcrsVector([0, R, 0]);
    this.body = new SplatSet(this.splats.count);
    for (let i = 0; i < this.splats.count; i++) {
      const c = this.splats.colour;
      this.body.setStatic(i, this.splats.radiusPc[i]!, this.splats.radiusPc[i]!, 0, 1, c[3 * i]!, c[3 * i + 1]!, c[3 * i + 2]!, this.splats.alpha[i]!, 2.0);
    }
    this.far = new SplatSet(2);
    this.group.add(this.body.mesh, this.far.mesh);
  }

  /** Visual disc radius, pc (a presentation extent, not a boundary). */
  get discRadiusPc(): number { return MW_VISUAL.discRadiusPc; }
  positionPc(id: string): Vec3 | undefined { return id === 'milky-way' ? this.gc : undefined; }
  viewDistancePc(id: string): number | undefined { return id === 'milky-way' ? 2.2 * 2 * MW_VISUAL.discRadiusPc : undefined; }
  setQuality(q: number): void { this.quality = Math.min(1, Math.max(0.25, q)); }

  update(ctx: DeepRenderContext): readonly DeepScreenInfo[] {
    const V = MW_RENDER_VISUAL;
    const { camPc, basis, viewport, pixelsPerRadian: ppr } = ctx;
    const rel = this.rel;
    rel[0] = this.gc[0] - camPc[0]; rel[1] = this.gc[1] - camPc[1]; rel[2] = this.gc[2] - camPc[2];
    const dist = Math.hypot(rel[0], rel[1], rel[2]);
    const camFromSun = length(camPc);
    const fadeIn = logSmoothstep(camFromSun, V.fadeInFromPc, V.fadeInToPc);
    const halfDiag = Math.atan(Math.hypot(viewport.width / 2, viewport.height / 2) / ppr);
    const ok = projectEllipse(rel as unknown as Vec3, this.axisA, this.axisB, basis.right, basis.up, basis.forward, ppr, this.ell);
    const sx = viewport.width / 2 + (ok ? this.ell.x : 0), sy = viewport.height / 2 - (ok ? this.ell.y : 0);
    const R = MW_VISUAL.discRadiusPc;
    const diameterPx = Math.min(1e6, (2 * R / Math.max(dist, 1e-9)) * ppr);
    let a = ok ? this.ell.a : diameterPx / 2, b = ok ? this.ell.b : diameterPx / 2;
    if (!(a < 3e4 && b < 3e4)) { a = b = diameterPx / 2; }
    const lod = objectLod({ apparentDiameterPx: diameterPx, distanceMetres: Math.max(dist, 1e-9) * PC, physicalSizeMetres: 2 * R * PC, ...(this.lodLevel !== undefined ? { previousLevel: this.lodLevel } : {}) });
    this.lodLevel = lod.level;
    const thetaC = Math.acos(Math.max(-1, Math.min(1, (rel[0] * basis.forward[0] + rel[1] * basis.forward[1] + rel[2] * basis.forward[2]) / Math.max(dist, 1e-9))));
    const onScreen = thetaC - Math.atan2(R, Math.max(dist, 1e-9)) < halfDiag;

    // ---- splat body: drawn only once the camera has left the solar neighbourhood
    const wBody = onScreen ? lod.image * fadeIn : 0;
    let calls = 0, points = 0;
    if (wBody > 0.002) {
      const count = Math.max(1, Math.ceil(this.splats.count * this.quality));
      const p = this.splats.positionIcrs;
      const cx = camPc[0], cy = camPc[1], cz = camPc[2];
      for (let i = 0; i < count; i++) this.body.setCentre(i, p[3 * i]! - cx, p[3 * i + 1]! - cy, p[3 * i + 2]! - cz);
      const dir0 = rel[0] / (dist || 1), dir1 = rel[1] / (dist || 1), dir2 = rel[2] / (dist || 1);
      const elev = (Math.asin(Math.min(1, Math.abs(dot([dir0, dir1, dir2], this.normal)))) * 180) / Math.PI;
      this.body.setAlphaScale(wBody * viewGain(this.gains, elev) * (this.splats.count / count));
      this.body.setView(viewport.width, viewport.height, ppr, V.maxSplatPx);
      this.body.setCount(count);
      this.body.commit();
      calls++; points += count;
    } else this.body.setCount(0);

    // ---- far representation: glow then marker (same LOD vocabulary as every galaxy)
    const tint = V.glowColour;
    const gAlpha = onScreen ? lod.glow * V.glowAlpha : 0;
    this.far.setStatic(0, Math.max(2.5, a), Math.max(2.5, b), ok ? this.ell.angle : 0, 0, tint[0], tint[1], tint[2], gAlpha, V.glowPower);
    this.far.setCentre(0, rel[0], rel[1], rel[2]);
    this.far.setStatic(1, V.markerRadiusPx, V.markerRadiusPx, 0, 0, tint[0], tint[1], tint[2], onScreen ? lod.marker * V.markerAlpha : 0, 2.0);
    this.far.setCentre(1, rel[0], rel[1], rel[2]);
    this.far.setView(viewport.width, viewport.height, ppr);
    this.far.setCount(gAlpha > 0.001 || (onScreen && lod.marker > 0.001) ? 2 : 0);
    this.far.commit();
    if (this.far.mesh.visible) { calls++; points += 2; }

    // The model is selectable only while it is drawn (or its glow/marker is).
    const selectable = onScreen && (wBody > 0.05 || lod.glow > 0.05 || lod.marker > 0.05);
    const label = wBody > 0.002 ? (lod.image >= 0.99 ? 'model-splats' : 'model-splats->glow') : lod.stage;
    const pickR = Math.max(V.minPickRadiusPx, Math.max(a, b));
    if (!this.info || this.info.x !== sx || this.info.y !== sy || this.info.pixelRadius !== pickR || this.info.visible !== selectable || this.info.lod !== label) {
      this.info = {
        id: 'milky-way', kind: 'galaxy', x: sx, y: sy, pixelRadius: pickR, distancePc: dist, visible: selectable, lod: label, label: 'Milky Way (model)',
        representationNote: 'documented model from literature parameters; spiral arms beyond the maser data are extrapolated; no individual stars',
      };
    }
    this.out.length = 0;
    this.out.push(this.info);
    this.lastStats = { drawCalls: calls, textureBytes: 0, pointsDrawn: points, objectsVisible: selectable ? 1 : 0 };
    return this.out;
  }

  stats(): DeepRendererStats { return this.lastStats; }
  dispose(): void { this.body.dispose(); this.far.dispose(); this.group.clear(); }
}
