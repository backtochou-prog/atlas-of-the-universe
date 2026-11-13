import * as THREE from 'three';
import { sphericalToCartesian } from '../../core/astro/coordinates';
import { length, type Vec3 } from '../../core/spatial/vec3';
import type { DeepSpaceData } from '../../data/deepspace/deepSpaceData';
import type { PointCatalogueFile } from '../../data/deepspace/types';
import { BRIGHTNESS_GLSL } from '../brightness';
import {
  APPLICATION_H0_KM_S_MPC, buildDuplicateIndex, hubbleDistancePc, isImageGalaxyDuplicate, MIN_CZ_FOR_HUBBLE_KMS, TWOMRS_KS_LIMIT, virgoBlend, type DuplicateIndex,
} from './clusterGeometry';
import { parseRowId, rowValues, sunCatalogueWanted, type PointCatalogueStore } from './pointCatalogues';
import type { DeepRenderContext, DeepRendererStats, DeepScreenInfo, DeepSubRenderer, PointRowInfo } from './types';

const TWOMRS_FILE = 'twomrs';
/** Identifier of the single 'cosmic-structure' screen info. */
export const COSMIC_STRUCTURE_ID = 'twomrs';

/** VISUAL parameters (drawing choices, not data). */
export const COSMIC_VISUAL = {
  /** One tint for every galaxy: near-infrared light of old stars; no colour is claimed (the file has no usable colours). */
  tint: [0.86, 0.9, 1.0] as readonly [number, number, number],
  minPx: 1.2, maxPx: 3.6, pxPerMag: 0.4, minAlpha: 0.3,
  /**
   * Auto-exposure. The apparent Ks magnitude from the camera is M + 5 log10(d) - 5 (inverse-square dimming with distance). The
   * magnitude limit starts at the survey's own flux limit and is raised by 5 log10(D / referenceDistance) once the camera is farther
   * than `referencePc` from the Sun, so the cloud stays visible when you back away. A display choice, not photometry.
   */
  referencePc: 3e7,
  /** Fraction of the points drawn at quality 0.25 (most luminous first). */
  minQualityFraction: 0.3,
  /** Selection of pickable points: how many, and how often (frames) the set is re-chosen while the camera moves. */
  pickCount: 300, reselectEveryFrames: 12, pickRadiusPx: 6,
  /** Rebuild the camera-relative buffer when the camera has moved more than this fraction of the nearest drawn galaxy's distance (0.05 px of error). */
  rebuildFraction: 6e-5,
  /** Opacity of the cloud when the camera is farther than this from the Sun, falling off (the cloud is then a few pixels across). */
  structureRadiusPc: 7.4e8,
} as const;

const VERTEX = /* glsl */ `
uniform float uMagLimit; uniform float uMinPx; uniform float uMaxPx; uniform float uPxPerMag; uniform float uMinAlpha;
uniform float uPixelRatio; uniform float uWeight; uniform float uVirgoW;
attribute float aAbsMag; attribute float aVirgo;
varying float vAlpha;
${BRIGHTNESS_GLSL}
void main() {
  float d = length(position);                  // camera-relative distance, parsecs
  float m = atlasAppMag(aAbsMag, d);
  float dia = atlasDiameter(m);
  vAlpha = atlasAlpha(m) * uWeight * mix(1.0, 1.0 - uVirgoW, aVirgo);
  gl_PointSize = dia * uPixelRatio;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  bool hidden = (dia <= 0.0) || (mv.z >= -1e-9) || (vAlpha <= 0.003);
  gl_Position = hidden ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mv;
}`;
const FRAGMENT = /* glsl */ `
uniform vec3 uTint; varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c) * 2.0;
  if (r > 1.0) discard;
  gl_FragColor = vec4(uTint, vAlpha * (1.0 - smoothstep(0.2, 1.0, r)));
}`;

/** The note shown with the cosmic structure. The caveat sentence is mandatory and verbatim. */
export const COSMIC_CAVEAT =
  'Observed galaxy positions; distances are redshift estimates (Hubble flow, H0 70 is our choice), so clusters are stretched along the line of sight (fingers of God); '
  + 'the empty band is the Zone of Avoidance behind the Milky Way; the survey is flux-limited (K<11.75), so fewer galaxies are included at larger distance.';
/** The 2MRS view is centred on the Sun because the survey is: that is a VIEW ANCHOR (where the camera flies to), not a centre of anything physical. */
export const COSMIC_ANCHOR = 'The view is anchored on the Sun, the centre of the survey volume: a viewing choice, not a centre of the Universe.';
export const COSMIC_NOT_DRAWN = 'No filaments, voids or density surfaces are drawn: none exists in the data, and empty regions are NOT voids.';

export function cosmicNote(c: { total: number; drawn: number; belowCz: number; duplicates: number; noCz: number } | null): string {
  const head = `${COSMIC_CAVEAT} ${COSMIC_NOT_DRAWN} ${COSMIC_ANCHOR}`;
  if (!c) return `${head} 2MASS Redshift Survey (Huchra et al. 2012) galaxies load when you are far from the Sun.`;
  return `${head} ${c.drawn} of ${c.total} 2MRS galaxies are placed at d = cz / ${APPLICATION_H0_KM_S_MPC} km/s/Mpc. ${c.belowCz} with cz < ${MIN_CZ_FOR_HUBBLE_KMS} km/s are NOT drawn here (peculiar velocity dominates cz; nearby galaxies come from the catalogues with measured distances)${c.noCz > 0 ? `; ${c.noCz} have no cz` : ''}; ${c.duplicates} are drawn as images elsewhere. Brightness follows the Ks magnitude and the distance from the camera (display mapping).`;
}

interface Built {
  readonly file: PointCatalogueFile;
  readonly n: number;
  readonly row: Int32Array;
  readonly pos: Float64Array;
  readonly points: THREE.Points;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.ShaderMaterial;
  readonly rel: Float32Array;
  readonly absMag: Float32Array;
  readonly stats: { total: number; drawn: number; belowCz: number; duplicates: number; noCz: number };
}

type MutableInfo = { -readonly [K in keyof DeepScreenInfo]: DeepScreenInfo[K] };

/**
 * The 2MRS galaxies as an observed large-scale layer: ~43 000 tiny soft points, ONE draw call. Position = RA/Dec and
 * d = cz / H0 (H0 an application choice). Rows with cz < 1000 km/s are not placed (counted in the note). The camera-relative
 * Float32 position buffer is rebuilt only when the camera has moved more than `rebuildFraction` of the distance to the nearest
 * drawn galaxy (a pure rotation costs nothing); each rebuild is one pass over the points.
 */
export class CosmicStructureRenderer implements DeepSubRenderer {
  readonly name = 'cosmic-structure';
  readonly layerKind = 'structure' as const;
  readonly group = new THREE.Group();
  private built: Built | null = null;
  private readonly dup: DuplicateIndex;
  private readonly virgoRows: ReadonlySet<string>;
  private readonly virgoPos: Vec3 | undefined;
  private readonly lastCam: [number, number, number] = [NaN, NaN, NaN];
  private nearestPc = 1;
  private lastCount = -1;
  private frame = 0;
  private lastSelectFrame = -1e9;
  private readonly pickIdx = new Int32Array(COSMIC_VISUAL.pickCount);
  private readonly pickKey = new Float64Array(COSMIC_VISUAL.pickCount);
  private pickN = 0;
  private readonly pickInfos = new Map<number, MutableInfo>();
  private structureInfo: MutableInfo | null = null;
  private noteFor: unknown = undefined;
  private note = cosmicNote(null);
  private out: DeepScreenInfo[] = [];
  private lastStats: DeepRendererStats = { drawCalls: 0, textureBytes: 0, pointsDrawn: 0, objectsVisible: 0 };
  /** Milliseconds the last position-buffer rebuild took (measured with performance.now when available). For the QA report. */
  lastRebuildMs = 0;
  rebuilds = 0;

  constructor(data: DeepSpaceData, private readonly store: PointCatalogueStore) {
    this.dup = buildDuplicateIndex(data.byKind('galaxy').map((o) => ({ designations: o.designations, name: o.name, ...(o.sky ? { raDeg: o.sky.raDeg, decDeg: o.sky.decDeg } : {}) })));
    this.virgoRows = new Set(data.get('virgo-cluster')?.membership?.names ?? []);
    this.virgoPos = data.positionPc('virgo-cluster');
  }

  positionPc(id: string): Vec3 | undefined { return id === COSMIC_STRUCTURE_ID ? [0, 0, 0] : undefined; }
  /** A comfortable distance to see the survey volume from outside: 500 Mpc, just inside the orbit camera's 600 Mpc limit (VISUAL; the farthest placed galaxy is about 740 Mpc from the Sun). */
  viewDistancePc(id: string): number | undefined { return id === COSMIC_STRUCTURE_ID ? 5e8 : undefined; }
  setQuality(): void { /* ctx.quality is read each frame */ }
  caveats(): readonly string[] | undefined { return this.built?.file.manifest.caveats; }
  /** Placement counts once loaded. */
  counts(): Built['stats'] | undefined { return this.built?.stats; }

  pointRow(id: string): PointRowInfo | undefined {
    const p = parseRowId(id);
    if (!p || p.fileId !== TWOMRS_FILE) return undefined;
    const f = this.built?.file ?? this.store.peek(TWOMRS_FILE);
    if (!f || p.row >= (f.columns['raDeg']?.length ?? 0)) return undefined;
    return { id, fileId: p.fileId, row: p.row, values: rowValues(f, p.row), manifest: f.manifest };
  }

  private build(file: PointCatalogueFile): Built {
    const V = COSMIC_VISUAL;
    const c = file.columns as Record<string, readonly (number | string | null)[]>;
    const ra = c['raDeg']!, dec = c['decDeg']!, cz = c['czKms']!, ks = c['ksMag']!, nm = c['name']!;
    const total = ra.length;
    let belowCz = 0, dups = 0, noCz = 0;
    const idx: number[] = [], dist: number[] = [], absM: number[] = [];
    for (let i = 0; i < total; i++) {
      const z = cz[i], k = ks[i];
      if (typeof z !== 'number') { noCz++; continue; }
      const d = hubbleDistancePc(z);
      if (d === null) { belowCz++; continue; }
      if (typeof k !== 'number' || typeof ra[i] !== 'number' || typeof dec[i] !== 'number') continue;
      if (isImageGalaxyDuplicate(this.dup, null, ra[i] as number, dec[i] as number)) { dups++; continue; }
      idx.push(i); dist.push(d); absM.push(k - 5 * Math.log10(d) + 5);
    }
    // most luminous first: the quality scale keeps a prefix, so what is cut is the intrinsically faintest (visible only nearby)
    const order = idx.map((_, j) => j).sort((a, b) => absM[a]! - absM[b]! || a - b);
    const n = order.length;
    const row = new Int32Array(n), pos = new Float64Array(3 * n), absMag = new Float32Array(n), virgo = new Float32Array(n);
    for (let j = 0; j < n; j++) {
      const o = order[j]!, i = idx[o]!;
      row[j] = i;
      const p = sphericalToCartesian(ra[i] as number, dec[i] as number, dist[o]!);
      pos[3 * j] = p[0]; pos[3 * j + 1] = p[1]; pos[3 * j + 2] = p[2];
      absMag[j] = absM[o]!;
      virgo[j] = this.virgoRows.has(nm[i] as string) ? 1 : 0;
    }
    const rel = new Float32Array(3 * n);
    const geometry = new THREE.BufferGeometry();
    const ra3 = new THREE.BufferAttribute(rel, 3); ra3.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', ra3);
    geometry.setAttribute('aAbsMag', new THREE.BufferAttribute(absMag, 1));
    geometry.setAttribute('aVirgo', new THREE.BufferAttribute(virgo, 1));
    geometry.setDrawRange(0, n);
    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: {
        uMagLimit: { value: TWOMRS_KS_LIMIT }, uMinPx: { value: V.minPx }, uMaxPx: { value: V.maxPx }, uPxPerMag: { value: V.pxPerMag }, uMinAlpha: { value: V.minAlpha },
        uPixelRatio: { value: 1 }, uWeight: { value: 0 }, uVirgoW: { value: 0 }, uTint: { value: new THREE.Vector3(V.tint[0], V.tint[1], V.tint[2]) },
      },
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false; points.visible = false; points.name = 'cosmic-structure:2mrs';
    this.group.add(points);
    this.lastCam[0] = NaN;
    return { file, n, row, pos, points, geometry, material, rel, absMag, stats: { total, drawn: n, belowCz, duplicates: dups, noCz } };
  }

  private dropBuilt(): void {
    const b = this.built;
    if (!b) return;
    this.group.remove(b.points);
    b.geometry.dispose(); b.material.dispose();
    this.built = null; this.pickN = 0; this.pickInfos.clear(); this.lastCount = -1;
  }

  update(ctx: DeepRenderContext): readonly DeepScreenInfo[] {
    const V = COSMIC_VISUAL;
    const { camPc, basis, viewport, pixelsPerRadian: ppr, nowSeconds } = ctx;
    this.out.length = 0;
    this.frame++;
    const camSun = length(camPc);
    const wanted = sunCatalogueWanted(TWOMRS_FILE, camSun);
    const file = wanted ? this.store.want(TWOMRS_FILE, nowSeconds) : this.store.peek(TWOMRS_FILE);
    if (this.built && this.built.file !== file) this.dropBuilt();
    if (file && !this.built) this.built = this.build(file);
    const b = this.built;
    if (!b) { this.lastStats = { drawCalls: 0, textureBytes: 0, pointsDrawn: 0, objectsVisible: 0 }; return this.out; }
    if (this.noteFor !== b) { this.noteFor = b; this.note = cosmicNote(b.stats); if (this.structureInfo) this.structureInfo.representationNote = this.note; }

    const farFade = ctx.farFade ?? 1;
    const cam = this.lastCam;
    const moved = Math.hypot(camPc[0] - cam[0], camPc[1] - cam[1], camPc[2] - cam[2]);
    const count = Math.max(1, Math.ceil(b.n * (V.minQualityFraction + (1 - V.minQualityFraction) * (Math.max(0, ctx.quality - 0.25) / 0.75))));
    if (!(moved <= V.rebuildFraction * this.nearestPc) || count !== this.lastCount) this.rebuild(b, camPc, count);

    // ---- the cloud
    const weight = (wanted ? 1 : 0) * farFade;
    const u = b.material.uniforms as Record<string, { value: unknown }>;
    const virgoDist = this.virgoPos ? Math.hypot(this.virgoPos[0] - camPc[0], this.virgoPos[1] - camPc[1], this.virgoPos[2] - camPc[2]) : Infinity;
    u['uMagLimit']!.value = TWOMRS_KS_LIMIT + 5 * Math.log10(Math.max(1, camSun / V.referencePc));
    u['uWeight']!.value = weight;
    u['uVirgoW']!.value = virgoBlend(virgoDist);
    u['uPixelRatio']!.value = ctx.pixelRatio;
    b.points.visible = weight > 0.003;
    b.geometry.setDrawRange(0, count);

    // ---- pickable points: the most prominent N (re-chosen every few frames; screen position refreshed every frame)
    if (b.points.visible) {
      if (this.frame - this.lastSelectFrame >= V.reselectEveryFrames || this.pickN === 0) { this.selectProminent(b, count, basis, ppr, viewport.width, viewport.height); this.lastSelectFrame = this.frame; }
      this.emitPicked(b, camPc, basis, ppr, viewport.width, viewport.height);
    }
    // ---- single structure info (centre = the Sun; the layer is centred there, the radius is the farthest placed galaxy)
    {
      const rx = -camPc[0], ry = -camPc[1], rz = -camPc[2];
      const dist = Math.hypot(rx, ry, rz);
      const z = rx * basis.forward[0] + ry * basis.forward[1] + rz * basis.forward[2];
      let sx = 0, sy = 0;
      if (z > 0) { sx = (rx * basis.right[0] + ry * basis.right[1] + rz * basis.right[2]) / z * ppr; sy = (rx * basis.up[0] + ry * basis.up[1] + rz * basis.up[2]) / z * ppr; }
      const info = this.structureInfo ??= { id: COSMIC_STRUCTURE_ID, kind: 'cosmic-structure', x: 0, y: 0, pixelRadius: 0, distancePc: 0, visible: false, lod: 'points', label: '2MASS Redshift Survey galaxies (Hubble-flow distances)', representationNote: this.note };
      info.x = viewport.width / 2 + sx; info.y = viewport.height / 2 - sy; info.distancePc = dist;
      info.pixelRadius = Math.min(1e5, Math.max(8, (V.structureRadiusPc / Math.max(dist, 1e-9)) * ppr));
      info.visible = b.points.visible; info.lod = `points (${count} of ${b.n})`;
      this.out.push(info);
    }
    this.lastStats = { drawCalls: b.points.visible ? 1 : 0, textureBytes: 0, pointsDrawn: b.points.visible ? count : 0, objectsVisible: b.points.visible ? this.pickN : 0 };
    return this.out;
  }

  private rebuild(b: Built, camPc: Vec3, count: number): void {
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    const { pos, rel } = b;
    const cx = camPc[0], cy = camPc[1], cz = camPc[2];
    let dmin2 = Infinity;
    for (let i = 0, j = 0; i < count; i++, j += 3) {
      const x = pos[j]! - cx, y = pos[j + 1]! - cy, z = pos[j + 2]! - cz;
      rel[j] = x; rel[j + 1] = y; rel[j + 2] = z;
      const d2 = x * x + y * y + z * z;
      if (d2 < dmin2) dmin2 = d2;
    }
    (b.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.lastCam[0] = cx; this.lastCam[1] = cy; this.lastCam[2] = cz;
    this.nearestPc = Math.max(1, Math.sqrt(dmin2));
    this.lastCount = count;
    this.rebuilds++;
    if (typeof performance !== 'undefined') this.lastRebuildMs = performance.now() - t0;
  }

  /** Keep the `pickCount` brightest (smallest apparent magnitude from the camera) drawn galaxies that are inside the view. */
  private selectProminent(b: Built, count: number, basis: DeepRenderContext['basis'], ppr: number, w: number, h: number): void {
    const K = COSMIC_VISUAL.pickCount, rel = b.rel;
    const idx = this.pickIdx, key = this.pickKey;
    const fwd = basis.forward, right = basis.right, up = basis.up;
    const hw = w / 2, hh = h / 2;
    let n = 0, worst = 0, worstKey = -Infinity;
    for (let i = 0, j = 0; i < count; i++, j += 3) {
      const x = rel[j]!, y = rel[j + 1]!, z = rel[j + 2]!;
      const depth = x * fwd[0] + y * fwd[1] + z * fwd[2];
      if (depth <= 0) continue;
      if (Math.abs(x * right[0] + y * right[1] + z * right[2]) / depth * ppr > hw) continue;
      if (Math.abs(x * up[0] + y * up[1] + z * up[2]) / depth * ppr > hh) continue;
      const m = b.absMag[i]! + 5 * Math.log10(Math.sqrt(x * x + y * y + z * z)) - 5;
      if (n < K) {
        idx[n] = i; key[n] = m; n++;
        if (n === K) { worstKey = -Infinity; for (let q = 0; q < K; q++) if (key[q]! > worstKey) { worstKey = key[q]!; worst = q; } }
      } else if (m < worstKey) {
        idx[worst] = i; key[worst] = m;
        worstKey = -Infinity; for (let q = 0; q < K; q++) if (key[q]! > worstKey) { worstKey = key[q]!; worst = q; }
      }
    }
    this.pickN = n;
  }

  private emitPicked(b: Built, camPc: Vec3, basis: DeepRenderContext['basis'], ppr: number, w: number, h: number): void {
    const V = COSMIC_VISUAL;
    const pos = b.pos;
    let kept = 0;
    for (let q = 0; q < this.pickN; q++) {
      const i = this.pickIdx[q]!;
      const rx = pos[3 * i]! - camPc[0], ry = pos[3 * i + 1]! - camPc[1], rz = pos[3 * i + 2]! - camPc[2];
      const z = rx * basis.forward[0] + ry * basis.forward[1] + rz * basis.forward[2];
      if (z <= 0) continue;
      const sx = (rx * basis.right[0] + ry * basis.right[1] + rz * basis.right[2]) / z * ppr;
      const sy = (rx * basis.up[0] + ry * basis.up[1] + rz * basis.up[2]) / z * ppr;
      if (Math.abs(sx) > w / 2 || Math.abs(sy) > h / 2) continue;
      const row = b.row[i]!;
      let info = this.pickInfos.get(row);
      if (!info) {
        const nameCol = b.file.columns['name']!;
        const cz = b.file.columns['czKms']![row] as number;
        info = { id: `${TWOMRS_FILE}:${row}`, kind: 'catalogue-point', x: 0, y: 0, pixelRadius: V.pickRadiusPx, distancePc: 0, visible: true, lod: 'point',
          label: String(nameCol[row] ?? `2MRS row ${row}`),
          representationNote: `2MRS galaxy: sky position observed; distance ${(cz / APPLICATION_H0_KM_S_MPC).toFixed(0)} Mpc is cz / H0 (cz = ${cz} km/s, H0 ${APPLICATION_H0_KM_S_MPC} is our choice): a Hubble-flow estimate with no published distance error (peculiar velocities of hundreds of km/s are not removed, so the line-of-sight position can be off by several Mpc). ${COSMIC_CAVEAT}` };
        this.pickInfos.set(row, info);
      }
      info.x = w / 2 + sx; info.y = h / 2 - sy; info.distancePc = Math.hypot(rx, ry, rz);
      this.out.push(info);
      kept++;
    }
    void kept;
  }

  stats(): DeepRendererStats { return this.lastStats; }

  dispose(): void { this.dropBuilt(); this.group.clear(); }
}
