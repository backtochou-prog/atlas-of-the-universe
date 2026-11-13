import * as THREE from 'three';
import { distanceMetres, lengthToParsecs, physicalSizeMetres } from '../../core/deepspace/geometry';
import { type Vec3 } from '../../core/spatial/vec3';
import { METRES_PER_PARSEC } from '../../core/units';
import type { DeepSpaceData } from '../../data/deepspace/deepSpaceData';
import type { DeepSpaceObject, PointCatalogueFile } from '../../data/deepspace/types';
import { BRIGHTNESS_GLSL } from '../brightness';
import { buildMembers, type ClusterGeometry, type MemberBuild } from './clusterGeometry';
import { logSmoothstep, markerAlpha, objectLod } from './DeepSpaceLOD';
import { membersWanted, type PointCatalogueStore } from './pointCatalogues';
import { SplatSet } from './SplatSet';
import type { DeepRenderContext, DeepRendererStats, DeepScreenInfo, DeepSubRenderer } from './types';

const PC = METRES_PER_PARSEC;

/** The clusters drawn from real catalogued members, and the member file of each (ids shared with the data agents). */
export const STAR_CLUSTER_IDS: readonly string[] = ['pleiades', 'hyades', 'omega-centauri', 'm13', '47-tucanae', 'm4'];

/**
 * VISUAL parameters. None of these is a scientific value: they set how bright, how large and how soft things are drawn.
 */
export const CLUSTER_VISUAL = {
  markerRadiusPx: 2.2, markerPower: 2.0,
  /** Marker / glow tint: open clusters young and blue-white, globular clusters old and warm. A display choice. */
  tint: { open: [0.72, 0.84, 1.0], globular: [1.0, 0.88, 0.66] } as Readonly<Record<'open' | 'globular', readonly [number, number, number]>>,
  glowAlpha: 0.32, glowAlphaApproach: 0.5, glowApproachPx: [8, 36] as readonly [number, number], glowPower: 1.5, glowMinSemiAxisPx: 3, glowExtent: 1.1, minPickRadiusPx: 5,
  /** Star sprites (the brightness.ts conventions: size and opacity linear in magnitude below a magnitude limit). */
  starMinPx: 1.6, starMaxPx: 9, starPxPerMag: 0.55, starMinAlpha: 0.3,
  /**
   * Density cap. A globular core packs thousands of stars into a few pixels and additive blending would turn it into a white
   * blob. Exposure e = min(1, targetCoverage / coverage), coverage = (N/2 sprites of `spriteAreaPx2`) over the disc of the
   * half-number radius. e scales every star's opacity and, as a magnitude-limited saturation, lifts the faint limit by
   * `limitMagPerDecade` magnitudes per decade of e so the faintest stars drop out first.
   */
  targetCoverage: 3, spriteAreaPx2: 5, minExposure: 0.12, limitMagPerDecade: 2,
  /** Weight of the catalogued-extent glow that stays under the member stars (unresolved light: the file holds only the brightest members of a globular cluster). */
  glowUnderMembers: 0.256,
  /** The members cross-fade in over this range of apparent cluster diameter, px (wider than the generic LOD band, which made a resolved cluster pop in). */
  membersFadePx: { open: [22, 100], globular: [32, 72] } as Readonly<Record<'open' | 'globular', readonly [number, number]>>,
  /** Draw range of the members while the cross-fade is under way = weight ^ this (brightest first); 0 = all stars at once (globular clusters, whose crowded cores already saturate smoothly). */
  membersRampPower: { open: 2, globular: 0 } as Readonly<Record<'open' | 'globular', number>>,
  /** Fraction of the members drawn at quality 0.25 (brightest first); linear up to 1 at quality 1. */
  minQualityFraction: 0.3,
  /** Marker and glow fade out between these camera-to-cluster distances (pc): from the Local Group scale a cluster is only a dot on the Sun's own position. */
  markerFadeOutPc: [3e5, 3e6] as readonly [number, number],
} as const;

const VERTEX = /* glsl */ `
uniform vec3 uCentre; uniform float uMagLimit; uniform float uMinPx; uniform float uMaxPx; uniform float uPxPerMag; uniform float uMinAlpha;
uniform float uPixelRatio; uniform float uWeight; uniform float uExposure;
attribute float aAbsMag; attribute vec3 aColour;
varying vec3 vColour; varying float vAlpha;
${BRIGHTNESS_GLSL}
void main() {
  vec3 p = position + uCentre;                 // member offset (small) + cluster centre relative to the camera (float64 on the CPU)
  float d = length(p);
  float m = atlasAppMag(aAbsMag, d);
  float dia = atlasDiameter(m);
  vAlpha = atlasAlpha(m) * uWeight * uExposure;
  vColour = aColour;
  gl_PointSize = dia * uPixelRatio;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  bool hidden = (dia <= 0.0) || (mv.z >= -1e-9) || (vAlpha <= 0.002);
  gl_Position = hidden ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mv;
}`;
const FRAGMENT = /* glsl */ `
varying vec3 vColour; varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c) * 2.0;
  if (r > 1.0) discard;
  float soft = 1.0 - smoothstep(0.3, 1.0, r);
  gl_FragColor = vec4(vColour * (vAlpha * soft), 1.0);
}`;

/** Note shown with a cluster: pure (tested), built from the object, the manifest and the placement counts. */
export function clusterNote(o: { readonly id: string; readonly clusterClass: 'open' | 'globular'; readonly meanDistanceLabel: string; readonly plummerScalePc?: number }, b: MemberBuild | null, manifest: PointCatalogueFile['manifest'] | null): string {
  if (!b || !manifest) return o.clusterClass === 'open'
    ? 'Real Gaia members at their catalogued sky positions; each at its own parallax distance. Member stars load when you are close.'
    : 'Real Gaia members: positions on the sky are catalogued; depth is assumed from spherical symmetry. Member stars load when you are close.';
  const s = b.stats;
  const parts: string[] = [];
  if (o.clusterClass === 'open') {
    parts.push(`${s.total} real Gaia members (catalogue membership), each at its catalogued sky position and at its own parallax distance (1000 / parallax).`);
    if (s.meanNoParallax + s.meanNonPositiveParallax > 0) parts.push(`${s.meanNoParallax} members with no parallax and ${s.meanNonPositiveParallax} with a non-positive parallax are placed at the cluster mean distance (${o.meanDistanceLabel}).`);
    else parts.push('Every member has a usable parallax.');
    parts.push(`Parallaxes are not zero-point corrected${s.noisyParallax > 0 ? `; ${s.noisyParallax} members have a parallax error above 10%, so their depth is mostly measurement noise` : ''}; the depth scatter of faint members is partly noise.`);
    if (s.meanParallaxDistancePc !== null) parts.push(`Mean of the parallax distances ${s.meanParallaxDistancePc.toFixed(1)} pc (catalogued cluster distance ${o.meanDistanceLabel}).`);
  } else {
    parts.push(`${s.total} real Gaia members: positions on the sky are catalogued; depth is assumed from spherical symmetry (ILLUSTRATIVE: a deterministic offset from the cluster mean distance ${o.meanDistanceLabel}, Plummer profile with scale ${o.plummerScalePc?.toFixed(1) ?? '?'} pc, the catalogued projected half-light radius).`);
    parts.push('The real line-of-sight depth of individual stars is not measured: member parallaxes are far too imprecise.');
    const trunc = manifest.caveats.find((c) => /^Truncation/.test(c));
    if (trunc) parts.push(trunc);
    if (s.noColour > 0) parts.push(`${s.noColour} members have no BP-RP colour and are drawn grey. Colours are as observed (not corrected for reddening).`);
  }
  parts.push(`Brightest member drawn G = ${s.brightestG.toFixed(2)}${o.id === 'pleiades' ? ' (Alcyone and Merope are absent from the catalogue)' : ': the very brightest stars can be missing because Gaia astrometry fails for them'}. No star is invented to fill gaps; brightness and size are a display mapping of G.`);
  return parts.join(' ');
}

type MutableInfo = { -readonly [K in keyof DeepScreenInfo]: DeepScreenInfo[K] };

interface Members {
  readonly file: PointCatalogueFile;
  readonly build: MemberBuild;
  readonly points: THREE.Points;
  readonly material: THREE.ShaderMaterial;
  readonly geometry: THREE.BufferGeometry;
}
interface Cluster {
  readonly obj: DeepSpaceObject;
  readonly index: number;
  readonly fileId: string;
  readonly cls: 'open' | 'globular';
  readonly geom: ClusterGeometry;
  readonly pos: Vec3;
  readonly distPc: number;
  readonly halfExtentPc: number;
  readonly halfNumberPc: number;
  readonly mag: number | undefined;
  readonly meanDistanceLabel: string;
  members: Members | null;
  lodLevel: number | undefined;
  note: string;
  noteFor: MemberBuild | null | undefined;
  info: MutableInfo | null;
  lastLod: string;
}

const numericMeasure = (o: DeepSpaceObject, key: string): { value: number; unit: string } | undefined => {
  const m = o.measurements[key];
  return m && Number.isFinite(m.value) ? { value: m.value, unit: m.unit } : undefined;
};

/**
 * Open and globular clusters drawn from their REAL catalogued members (Gaia). One draw call per cluster with members, plus one
 * shared instanced draw for every cluster's marker and glow. Member catalogues are fetched lazily when the camera is within
 * 30 cluster diameters and dropped by the store when far away; until a catalogue is resident the cluster shows its marker/glow.
 */
export class StarClusterRenderer implements DeepSubRenderer {
  readonly name = 'star-clusters';
  readonly layerKind = 'clusters' as const;
  readonly group = new THREE.Group();
  private readonly clusters = new Map<string, Cluster>();
  private readonly splats: SplatSet;
  private readonly out: DeepScreenInfo[] = [];
  private readonly rel: [number, number, number] = [0, 0, 0];
  private lastStats: DeepRendererStats = { drawCalls: 0, textureBytes: 0, pointsDrawn: 0, objectsVisible: 0 };

  constructor(data: DeepSpaceData, private readonly store: PointCatalogueStore) {
    const objs = STAR_CLUSTER_IDS.map((id) => data.get(id)).filter((o): o is DeepSpaceObject => !!o && o.kind === 'star-cluster' && !!o.sky?.distance && !!o.angularSize);
    this.splats = new SplatSet(Math.max(1, objs.length * 2));
    this.group.add(this.splats.mesh);
    objs.forEach((o, index) => {
      const pos = data.positionPc(o.id)!;
      const dM = distanceMetres(o.sky!.distance!).metres;
      const distPc = dM / PC;
      const halfExtentPc = physicalSizeMetres(o.angularSize!.majorArcmin, dM) / PC / 2;
      const cls = o.clusterClass === 'globular' ? 'globular' : 'open';
      const hl = numericMeasure(o, 'halfLightRadiusProjected') ?? numericMeasure(o, 'halfNumberRadius');
      // measurement units are pc in the data; an angular unit would be converted at the cluster distance
      const halfNumberPc = hl ? (hl.unit === 'arcmin' ? physicalSizeMetres(2 * hl.value, dM) / PC / 2 : lengthToParsecs(hl.value, hl.unit)) : 0.3 * halfExtentPc;
      const mag = numericMeasure(o, 'magV')?.value ?? numericMeasure(o, 'magV_total_harris')?.value;
      const d = o.sky!.distance!;
      this.clusters.set(o.id, {
        obj: o, index, fileId: `members-${o.id}`, cls,
        geom: { kind: cls, raDeg: o.sky!.raDeg, decDeg: o.sky!.decDeg, distancePc: distPc, centre: pos, plummerScalePc: halfNumberPc },
        pos, distPc, halfExtentPc, halfNumberPc, mag,
        meanDistanceLabel: `${d.value} ${d.unit}${d.uncertainty !== undefined ? ` +/- ${d.uncertainty}` : ''}`,
        members: null, lodLevel: undefined, note: '', noteFor: undefined, info: null, lastLod: '',
      });
    });
  }

  ids(): string[] { return [...this.clusters.keys()]; }
  positionPc(id: string): Vec3 | undefined { return this.clusters.get(id)?.pos; }
  viewDistancePc(id: string): number | undefined { const c = this.clusters.get(id); return c ? 3 * c.halfExtentPc : undefined; }
  setQuality(): void { /* ctx.quality is read each frame */ }
  /** Manifest caveats of a cluster's member catalogue (verbatim), once loaded. For the inspector. */
  caveats(id: string): readonly string[] | undefined { return this.clusters.get(id)?.members?.file.manifest.caveats; }
  /** True while the cluster's member stars are resident in memory. */
  membersResident(id: string): boolean { return !!this.clusters.get(id)?.members; }

  update(ctx: DeepRenderContext): readonly DeepScreenInfo[] {
    const V = CLUSTER_VISUAL;
    const { camPc, basis, viewport, pixelsPerRadian: ppr, nowSeconds } = ctx;
    this.out.length = 0;
    this.splats.setView(viewport.width, viewport.height, ppr);
    const halfDiag = Math.atan(Math.hypot(viewport.width / 2, viewport.height / 2) / ppr);
    const rel = this.rel;
    let n = 0, visible = 0, calls = 0, points = 0, anyAlpha = false;
    for (const c of this.clusters.values()) {
      rel[0] = c.pos[0] - camPc[0]; rel[1] = c.pos[1] - camPc[1]; rel[2] = c.pos[2] - camPc[2];
      const dist = Math.hypot(rel[0], rel[1], rel[2]);
      const fwd = basis.forward;
      const z = rel[0] * fwd[0] + rel[1] * fwd[1] + rel[2] * fwd[2];
      const apparentDiameterPx = Math.min(1e6, (2 * c.halfExtentPc / Math.max(dist, 1e-9)) * ppr);
      const thetaC = Math.acos(Math.max(-1, Math.min(1, z / Math.max(dist, 1e-9))));
      const angRad = Math.atan2(c.halfExtentPc, Math.max(dist, 1e-9));
      const onScreen = thetaC - angRad < halfDiag;
      let sx = 0, sy = 0;
      if (z > 0) { sx = (rel[0] * basis.right[0] + rel[1] * basis.right[1] + rel[2] * basis.right[2]) / z * ppr; sy = (rel[0] * basis.up[0] + rel[1] * basis.up[1] + rel[2] * basis.up[2]) / z * ppr; }
      const lod = objectLod({ apparentDiameterPx, distanceMetres: Math.max(dist, 1e-9) * PC, physicalSizeMetres: 2 * c.halfExtentPc * PC, ...(c.lodLevel !== undefined ? { previousLevel: c.lodLevel } : {}), hasDetail: true });
      c.lodLevel = lod.level;

      // ---- member catalogue: wanted only within 30 diameters; derived arrays dropped when the store has released the file
      const file = membersWanted(dist, 2 * c.halfExtentPc) ? this.store.want(c.fileId, nowSeconds) : this.store.peek(c.fileId);
      if (c.members && c.members.file !== file) this.disposeMembers(c);
      if (file && !c.members) this.buildMembersFor(c, file);

      // ---- marker + glow
      const tint = V.tint[c.cls];
      const membersWAll = logSmoothstep(apparentDiameterPx, V.membersFadePx[c.cls][0], V.membersFadePx[c.cls][1]);
      const membersW = c.members ? membersWAll : 0;
      // a cluster that is itself beyond the Gaia neighbourhood (the globular clusters) follows the layer's farFade: close to the Sun the real Gaia stars are the truth
      const farKeep = (1 - logSmoothstep(dist, V.markerFadeOutPc[0], V.markerFadeOutPc[1])) * (c.distPc > 1200 ? (ctx.farFade ?? 1) : 1);
      // Inside the member range while the catalogue is still loading, nothing is drawn (no marker, no glow, no error): the members
      // replace them. If the load has failed the glow stays, so the object does not vanish.
      const waiting = !c.members && membersWanted(dist, 2 * c.halfExtentPc) && this.store.errorOf(c.fileId) === null;
      const hold = waiting ? 0 : 1;
      const mAlpha = onScreen ? lod.marker * markerAlpha(c.mag, 0.7) * farKeep * hold : 0;
      this.splats.setStatic(n, V.markerRadiusPx, V.markerRadiusPx, 0, 0, tint[0], tint[1], tint[2], mAlpha, V.markerPower);
      this.splats.setCentre(n, rel[0], rel[1], rel[2]); n++;
      const glowW = Math.max(0, 1 - lod.marker - membersWAll) + membersWAll * (c.members ? (c.cls === 'globular' ? V.glowUnderMembers : 0) : (this.store.errorOf(c.fileId) !== null ? 1 : 0));
      const gr = Math.max(V.glowMinSemiAxisPx, (apparentDiameterPx / 2) * V.glowExtent);
      // The glow stands for the cluster's light before its stars are resolved. Close to the hand-off it rises to the surface brightness
      // the member stars will have (the sprites of a resolved cluster are ~10x brighter per pixel than a 0.32 glow, which popped when they arrived).
      const approach = logSmoothstep(apparentDiameterPx, V.glowApproachPx[0], V.glowApproachPx[1]);
      const gAlpha = onScreen ? glowW * (V.glowAlpha + (V.glowAlphaApproach - V.glowAlpha) * approach) * farKeep * hold : 0;
      this.splats.setStatic(n, gr, gr, 0, 0, tint[0], tint[1], tint[2], gAlpha, V.glowPower);
      this.splats.setCentre(n, rel[0], rel[1], rel[2]); n++;
      if (mAlpha > 0.001 || gAlpha > 0.001) anyAlpha = true;

      // ---- member stars
      const lodLabel: string = c.members ? (lod.stage === 'image' ? 'members' : lod.stage) : waiting ? 'loading members (nothing drawn yet)' : lod.stage === 'image' ? 'glow (members unavailable)' : lod.stage;
      if (c.members) {
        const m = c.members;
        const u = m.material.uniforms as Record<string, { value: unknown }>;
        const visibleMembers = onScreen && membersW > 0.003;
        m.points.visible = visibleMembers;
        if (visibleMembers) {
          // Stars are resolved brightest first (the catalogue is sorted by G): while the cluster is still small the draw range follows the
          // cross-fade weight (to a power), so the light of a resolved open cluster builds up gradually instead of arriving all at once (screen blending
          // of ~1700 stacked sprites saturates even at a low opacity, which made the cross-fade a pop).
          const resolved = Math.pow(membersW, V.membersRampPower[c.cls]);
          const count = Math.max(1, Math.ceil(m.build.count * resolved * (V.minQualityFraction + (1 - V.minQualityFraction) * (Math.max(0, ctx.quality - 0.25) / 0.75))));
          m.geometry.setDrawRange(0, count);
          const rhPx = Math.max(1, (c.halfNumberPc / Math.max(dist, 1e-9)) * ppr);
          const coverage = (count / 2) * V.spriteAreaPx2 / (Math.PI * rhPx * rhPx);
          const expo = Math.min(1, Math.max(V.minExposure, V.targetCoverage / Math.max(coverage, 1e-6)));
          // apparent magnitude, from the camera, of a star as faint as the faintest member at the cluster centre
          const mFaint = m.build.stats.faintestG + 5 * Math.log10(Math.max(dist, 1e-9) / c.distPc);
          u['uMagLimit']!.value = mFaint - V.limitMagPerDecade * Math.max(0, -Math.log10(expo));
          u['uExposure']!.value = expo;
          u['uWeight']!.value = membersW;
          u['uPixelRatio']!.value = ctx.pixelRatio;
          (u['uCentre']!.value as THREE.Vector3).set(rel[0], rel[1], rel[2]);
          calls++; points += count;
        }
      }
      // ---- screen info (reused while nothing it reports changed)
      const noteKey = c.members ? c.members.build : null;
      if (c.noteFor !== noteKey) {
        c.noteFor = noteKey;
        c.note = clusterNote({ id: c.obj.id, clusterClass: c.cls, meanDistanceLabel: c.meanDistanceLabel, plummerScalePc: c.halfNumberPc }, c.members?.build ?? null, c.members?.file.manifest ?? null);
      }
      const shown = onScreen && (farKeep > 0.03 || membersW > 0.01);
      if (shown) visible++;
      const pixelRadius = Math.max(V.minPickRadiusPx, apparentDiameterPx / 2);
      const screenX = viewport.width / 2 + sx, screenY = viewport.height / 2 - sy;
      const info = c.info ??= { id: c.obj.id, kind: 'star-cluster', x: 0, y: 0, pixelRadius: 0, distancePc: 0, visible: false, lod: '', label: c.obj.name, representationNote: c.note };
      info.x = screenX; info.y = screenY; info.pixelRadius = pixelRadius; info.distancePc = dist; info.visible = shown; info.lod = lodLabel; info.representationNote = c.note;
      c.lastLod = lodLabel;
      this.out.push(info);
    }
    this.splats.setCount(anyAlpha ? n : 0);
    this.splats.commit();
    if (anyAlpha) calls++;
    this.lastStats = { drawCalls: calls, textureBytes: 0, pointsDrawn: points + n, objectsVisible: visible };
    return this.out;
  }

  stats(): DeepRendererStats { return this.lastStats; }

  private buildMembersFor(c: Cluster, file: PointCatalogueFile): void {
    const V = CLUSTER_VISUAL;
    const col = file.columns as Record<string, readonly (number | string | null)[]>;
    const build = buildMembers({ raDeg: col['raDeg']!, decDeg: col['decDeg']!, sourceId: col['sourceId']!, gMag: col['gMag']!, bpRp: col['bpRp']!, parallaxMas: col['parallaxMas']!, parallaxErrMas: col['parallaxErrMas'] }, c.geom);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(build.offset, 3));
    geometry.setAttribute('aAbsMag', new THREE.BufferAttribute(build.absMag, 1));
    geometry.setAttribute('aColour', new THREE.BufferAttribute(build.colour, 3));
    geometry.setDrawRange(0, build.count);
    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthTest: false, depthWrite: false,
      // screen blending: out = src + dst (1 - src). Overlapping stars add up but approach white smoothly instead of clipping: the soft cap of a dense core.
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneMinusDstColorFactor, blendDst: THREE.OneFactor,
      uniforms: {
        uCentre: { value: new THREE.Vector3() }, uMagLimit: { value: 20 }, uMinPx: { value: V.starMinPx }, uMaxPx: { value: V.starMaxPx },
        uPxPerMag: { value: V.starPxPerMag }, uMinAlpha: { value: V.starMinAlpha }, uPixelRatio: { value: 1 }, uWeight: { value: 0 }, uExposure: { value: 1 },
      },
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.visible = false;
    points.name = `cluster-members:${c.obj.id}`;
    this.group.add(points);
    c.members = { file, build, points, material, geometry };
  }

  private disposeMembers(c: Cluster): void {
    const m = c.members;
    if (!m) return;
    this.group.remove(m.points);
    m.geometry.dispose(); m.material.dispose();
    c.members = null;
  }

  dispose(): void {
    for (const c of this.clusters.values()) this.disposeMembers(c);
    this.splats.dispose();
    this.clusters.clear();
    this.group.clear();
  }
}
