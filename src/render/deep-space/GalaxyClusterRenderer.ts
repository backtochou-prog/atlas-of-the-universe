import * as THREE from 'three';
import { sphericalToCartesian } from '../../core/astro/coordinates';
import { distanceMetres } from '../../core/deepspace/geometry';
import { length, type Vec3 } from '../../core/spatial/vec3';
import { METRES_PER_PARSEC } from '../../core/units';
import type { DeepSpaceData } from '../../data/deepspace/deepSpaceData';
import type { DeepSpaceObject, PointCatalogueFile } from '../../data/deepspace/types';
import {
  buildDuplicateIndex, classifyMorphology, CROSS_CATALOGUE_MATCH_ARCMIN, distanceBarPc, GROUP_EXTENT_PC, GROUP_RING_MARGIN, groupViewDistancePc,
  isImageGalaxyDuplicate, isIndependentDistance, MARKER_VISUAL, markerAlphaFromMag, markerRadiusPx, midpoint, MORPH_VISUAL, virgoBlend, type DuplicateIndex,
} from './clusterGeometry';
import { logSmoothstep } from './DeepSpaceLOD';
import { parseRowId, rowValues, sunCatalogueWanted, type PointCatalogueStore } from './pointCatalogues';
import { SplatSet } from './SplatSet';
import type { DeepRenderContext, DeepRendererStats, DeepScreenInfo, DeepSubRenderer, PointRowInfo } from './types';
import { angularSeparationDeg } from '../../core/astro/coordinates';

const PC = METRES_PER_PARSEC;
const LG_FILE = 'local-group-mcconnachie';
const UNGC_FILE = 'ungc';
const TWOMRS_FILE = 'twomrs';
/** Id namespace of the Virgo-cluster member rows ("virgo:<row>", row = row of the twomrs file). Distinct from the 2MRS cloud's "twomrs:<row>". */
export const VIRGO_ROW_NS = 'virgo';

export const GROUP_IDS = ['local-group', 'm81-group', 'virgo-cluster'] as const;
type GroupId = (typeof GROUP_IDS)[number];
const GROUP_BIT: Readonly<Record<GroupId, number>> = { 'local-group': 1, 'm81-group': 2, 'virgo-cluster': 4 };

/** VISUAL parameters (drawing choices, not data). */
export const GROUP_VISUAL = {
  markerPower: 2.0,
  glowPower: 1.6, glowAlpha: 0.22, glowMinPx: 2.5,
  /** Group members when their group is selected. */
  highlightAlpha: 2.2, highlightExtraPx: 2, othersWhenGroupSelected: 0.55,
  selectedHaloPx: 11, selectedHaloAlpha: 0.5,
  ringColour: 0x9fb4c8, ringMaxOpacity: 0.5, ringDashes: 72, ringDashFill: 0.55,
  /** The ring fades in between these apparent radii (CSS px), and out when the camera is within RING_INSIDE_FADE x the ring radius. */
  ringFadeInPx: [10, 42] as readonly [number, number], ringInsideFade: [1.0, 1.7] as readonly [number, number],
  barColour: 0xffc977, barOpacity: 0.9, barCapPx: 5,
  /** Camera distance from the Sun (pc) over which each row set fades out when seen from far away (the cosmic-structure layer takes over). */
  lgFadeOut: [8e6, 4e7] as readonly [number, number], ungcFadeOut: [6e7, 3e8] as readonly [number, number],
  minPickRadiusPx: 5,
  minRowAlphaToEmit: 0.04,
} as const;

type MutableInfo = { -readonly [K in keyof DeepScreenInfo]: DeepScreenInfo[K] };

interface RowSet {
  readonly kind: 'lg' | 'ungc' | 'virgo';
  readonly fileId: string;
  /** Namespace of the screen/pick ids of this set's rows ("<ns>:<row>"). The Virgo rows come from the twomrs file but are drawn at the cluster-mean distance, so they get their own namespace, distinct from the 2MRS cloud's "twomrs:<row>" (drawn at cz/H0). */
  readonly ns: string;
  readonly file: PointCatalogueFile;
  readonly n: number;
  readonly row: Int32Array;
  readonly pos: Float64Array;
  readonly dist: Float64Array;
  /** Distance error in pc (NaN = none published / not applicable). */
  readonly err: Float64Array;
  readonly rgb: Float32Array;
  readonly alpha: Float32Array;
  readonly radius: Float32Array;
  /** Catalogue angular radius in radians for the soft glow (0 = none published). */
  readonly glowRad: Float32Array;
  readonly group: Uint8Array;
  readonly infos: (MutableInfo | null)[];
  readonly skipped: { readonly imageDuplicates: number; readonly crossCatalogue: number };
}

interface GroupEntry {
  readonly id: GroupId;
  readonly obj: DeepSpaceObject;
  readonly kind: 'galaxy-group' | 'galaxy-cluster';
  readonly centre: Vec3;
  readonly ringPc: number;
  readonly distBar: { nearPc: number; farPc: number } | null;
  readonly line: THREE.LineSegments;
  readonly lineMat: THREE.LineBasicMaterial;
  readonly lineBuf: Float32Array;
  info: MutableInfo | null;
}

const col = (f: PointCatalogueFile, k: string): readonly (number | string | null)[] => f.columns[k] ?? [];
const numAt = (c: readonly (number | string | null)[], i: number): number | null => { const v = c[i]; return typeof v === 'number' && Number.isFinite(v) ? v : null; };
const strAt = (c: readonly (number | string | null)[], i: number): string | null => { const v = c[i]; return typeof v === 'string' ? v : null; };

/**
 * The Local Group (McConnachie 2012 rows), the nearby galaxies of the Updated Nearby Galaxy Catalog (UNGC, which holds the M81
 * group) and the Virgo Cluster region (2MRS rows listed in the object's membership), each catalogue row an instanced soft marker,
 * one shared draw. Rows are pickable ("<fileId>:<row>", kind catalogue-point; the Virgo rows use "virgo:<row>"). Rows that are image galaxies already drawn by the
 * GalaxyRenderer are skipped (see clusterGeometry.isImageGalaxyDuplicate); UNGC rows that repeat a McConnachie row are skipped
 * (the Local Group file has priority). Group objects get an ILLUSTRATIVE dashed ring, labelled as such. Catalogues load lazily.
 */
export class GalaxyClusterRenderer implements DeepSubRenderer {
  readonly name = 'galaxy-groups';
  readonly layerKind = 'structure' as const;
  readonly group = new THREE.Group();
  private readonly splats: SplatSet;
  private readonly groups = new Map<GroupId, GroupEntry>();
  private readonly dup: DuplicateIndex;
  private sets: { lg: RowSet | null; ungc: RowSet | null; virgo: RowSet | null } = { lg: null, ungc: null, virgo: null };
  private readonly memberNames: Readonly<Record<GroupId, ReadonlySet<string>>>;
  private readonly bar: THREE.LineSegments;
  private readonly barBuf = new Float32Array(6 * 3);
  private readonly barMat: THREE.LineBasicMaterial;
  private readonly out: DeepScreenInfo[] = [];
  private readonly rel: [number, number, number] = [0, 0, 0];
  private readonly lookup = new Map<string, { set: RowSet; i: number }>();
  private virgoPos: Vec3 | undefined;
  private lastStats: DeepRendererStats = { drawCalls: 0, textureBytes: 0, pointsDrawn: 0, objectsVisible: 0 };

  constructor(data: DeepSpaceData, private readonly store: PointCatalogueStore) {
    this.splats = new SplatSet(2 * (130 + 1000 + 260) + 4);
    this.group.add(this.splats.mesh);
    this.dup = buildDuplicateIndex(data.byKind('galaxy').map((o) => ({ designations: o.designations, name: o.name, ...(o.sky ? { raDeg: o.sky.raDeg, decDeg: o.sky.decDeg } : {}) })));
    const names = (id: GroupId): ReadonlySet<string> => new Set(data.get(id)?.membership?.names ?? []);
    this.memberNames = { 'local-group': names('local-group'), 'm81-group': names('m81-group'), 'virgo-cluster': names('virgo-cluster') };
    for (const id of GROUP_IDS) {
      const obj = data.get(id);
      if (!obj) continue;
      let centre: Vec3 | undefined = data.positionPc(id);
      if (!centre && id === 'local-group') {
        const mw = data.positionPc('milky-way'), m31 = data.positionPc('m31');
        if (mw && m31) centre = midpoint(mw, m31);
      }
      const ext = GROUP_EXTENT_PC[id];
      if (!centre || ext === undefined) continue;
      if (id === 'virgo-cluster') this.virgoPos = centre;
      const d = obj.sky?.distance;
      const err = d?.uncertainty !== undefined ? distanceMetres(d).sigmaMetres / PC : undefined;
      const distPc = d ? distanceMetres(d).metres / PC : undefined;
      const lineBuf = new Float32Array(GROUP_VISUAL.ringDashes * 2 * 3);
      const geo = new THREE.BufferGeometry();
      const attr = new THREE.BufferAttribute(lineBuf, 3); attr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('position', attr);
      const lineMat = new THREE.LineBasicMaterial({ color: GROUP_VISUAL.ringColour, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
      const line = new THREE.LineSegments(geo, lineMat);
      line.frustumCulled = false; line.visible = false; line.name = `group-ring:${id}`;
      this.group.add(line);
      this.groups.set(id, {
        id, obj, kind: obj.kind === 'galaxy-cluster' ? 'galaxy-cluster' : 'galaxy-group', centre, ringPc: GROUP_RING_MARGIN * ext,
        distBar: distPc !== undefined ? distanceBarPc(distPc, err) : null, line, lineMat, lineBuf, info: null,
      });
    }
    const bg = new THREE.BufferGeometry();
    const ba = new THREE.BufferAttribute(this.barBuf, 3); ba.setUsage(THREE.DynamicDrawUsage);
    bg.setAttribute('position', ba);
    this.barMat = new THREE.LineBasicMaterial({ color: GROUP_VISUAL.barColour, transparent: true, opacity: GROUP_VISUAL.barOpacity, depthTest: false, depthWrite: false });
    this.bar = new THREE.LineSegments(bg, this.barMat);
    this.bar.frustumCulled = false; this.bar.visible = false; this.bar.name = 'distance-uncertainty-bar';
    this.group.add(this.bar);
  }

  // ---- public queries -------------------------------------------------------------------------------------------------

  groupIds(): string[] { return [...this.groups.keys()]; }
  positionPc(id: string): Vec3 | undefined { return this.groups.get(id as GroupId)?.centre; }
  ringRadiusPc(id: string): number | undefined { return this.groups.get(id as GroupId)?.ringPc; }
  viewDistancePc(id: string): number | undefined { return this.groups.has(id as GroupId) ? groupViewDistancePc(id) : undefined; }
  setQuality(): void { /* a few hundred rows: nothing to cut */ }
  /** Number of rows drawn per set and how many were skipped, once loaded (for the HUD and tests). */
  rowCounts(): { lg: number; ungc: number; virgo: number; skipped: Record<string, { imageDuplicates: number; crossCatalogue: number }> } {
    const s = this.sets;
    return { lg: s.lg?.n ?? 0, ungc: s.ungc?.n ?? 0, virgo: s.virgo?.n ?? 0, skipped: { lg: s.lg?.skipped ?? { imageDuplicates: 0, crossCatalogue: 0 }, ungc: s.ungc?.skipped ?? { imageDuplicates: 0, crossCatalogue: 0 }, virgo: s.virgo?.skipped ?? { imageDuplicates: 0, crossCatalogue: 0 } } };
  }
  caveats(fileId: string): readonly string[] | undefined { return this.store.peek(fileId)?.manifest.caveats; }

  pointRow(id: string): PointRowInfo | undefined {
    const p = parseRowId(id);
    if (!p || (p.fileId !== LG_FILE && p.fileId !== UNGC_FILE && p.fileId !== VIRGO_ROW_NS)) return undefined;
    const e = this.lookup.get(id);
    if (!e) return undefined;
    return { id, fileId: e.set.fileId, row: p.row, values: rowValues(e.set.file, p.row), manifest: e.set.file.manifest, ...(e.set.kind === 'virgo' ? { placement: 'cluster-mean' as const } : {}) };
  }

  // ---- building row sets ----------------------------------------------------------------------------------------------

  private buildLg(file: PointCatalogueFile): RowSet {
    const c = (k: string) => col(file, k);
    const n0 = c('raDeg').length;
    const keep: number[] = []; let dups = 0;
    for (let i = 0; i < n0; i++) {
      if (numAt(c('distMpc'), i) === null) continue;
      if (isImageGalaxyDuplicate(this.dup, strAt(c('name'), i), numAt(c('raDeg'), i)!, numAt(c('decDeg'), i)!)) { dups++; continue; }
      keep.push(i);
    }
    return this.makeSet('lg', LG_FILE, file, keep, { dist: (i) => numAt(c('distMpc'), i)! * 1e6, err: (i) => { const e = numAt(c('distErrMpc'), i); return e === null ? NaN : e * 1e6; }, mag: (i) => numAt(c('vMag'), i), diam: () => null, group: () => GROUP_BIT['local-group'], independent: () => true }, { imageDuplicates: dups, crossCatalogue: 0 });
  }

  private buildUngc(file: PointCatalogueFile, lgFile: PointCatalogueFile | undefined): RowSet {
    const c = (k: string) => col(file, k);
    const n0 = c('raDeg').length;
    const keep: number[] = []; let dups = 0, cross = 0;
    const lgRa = lgFile ? col(lgFile, 'raDeg') : [], lgDec = lgFile ? col(lgFile, 'decDeg') : [];
    const tol = CROSS_CATALOGUE_MATCH_ARCMIN / 60;
    for (let i = 0; i < n0; i++) {
      const ra = numAt(c('raDeg'), i), dec = numAt(c('decDeg'), i);
      if (ra === null || dec === null || numAt(c('distMpc'), i) === null) continue;
      if (isImageGalaxyDuplicate(this.dup, strAt(c('name'), i), ra, dec)) { dups++; continue; }
      let isLg = false;
      for (let j = 0; j < lgRa.length; j++) {
        const lr = lgRa[j] as number, ld = lgDec[j] as number;
        if (Math.abs(ld - dec) <= tol && angularSeparationDeg(lr, ld, ra, dec) <= tol) { isLg = true; break; }
      }
      if (isLg) { cross++; continue; }
      keep.push(i);
    }
    const m81 = this.memberNames['m81-group'];
    return this.makeSet('ungc', UNGC_FILE, file, keep, {
      dist: (i) => numAt(c('distMpc'), i)! * 1e6, err: (i) => { const e = numAt(c('distErrMpc'), i); return e === null ? NaN : e * 1e6; },
      mag: (i) => numAt(c('bMag'), i), diam: (i) => numAt(c('diameterArcmin'), i), group: (i) => (m81.has(strAt(c('name'), i) ?? '\u0000') ? GROUP_BIT['m81-group'] : 0),
      independent: (i) => isIndependentDistance(UNGC_FILE, strAt(c('distMethod'), i)),
    }, { imageDuplicates: dups, crossCatalogue: cross });
  }

  private buildVirgo(file: PointCatalogueFile): RowSet | null {
    const vObj = this.groups.get('virgo-cluster');
    const d = vObj?.obj.sky?.distance;
    if (!vObj || !d) return null;
    const dPc = distanceMetres(d).metres / PC;
    const c = (k: string) => col(file, k);
    const names = this.memberNames['virgo-cluster'];
    const keep: number[] = []; let dups = 0;
    const nm = c('name');
    for (let i = 0; i < nm.length; i++) {
      const s = nm[i];
      if (typeof s !== 'string' || !names.has(s)) continue;
      if (isImageGalaxyDuplicate(this.dup, null, numAt(c('raDeg'), i)!, numAt(c('decDeg'), i)!)) { dups++; continue; }
      keep.push(i);
    }
    return this.makeSet('virgo', TWOMRS_FILE, file, keep, { dist: () => dPc, err: () => NaN, mag: (i) => numAt(c('ksMag'), i), diam: () => null, group: () => GROUP_BIT['virgo-cluster'], independent: () => true }, { imageDuplicates: dups, crossCatalogue: 0 });
  }

  private makeSet(kind: RowSet['kind'], fileId: string, file: PointCatalogueFile, keep: readonly number[], f: {
    dist: (i: number) => number; err: (i: number) => number; mag: (i: number) => number | null; diam: (i: number) => number | null; group: (i: number) => number; independent: (i: number) => boolean;
  }, skipped: RowSet['skipped']): RowSet {
    const n = keep.length;
    const row = new Int32Array(n), pos = new Float64Array(3 * n), dist = new Float64Array(n), err = new Float64Array(n), rgb = new Float32Array(3 * n);
    const alpha = new Float32Array(n), radius = new Float32Array(n), glowRad = new Float32Array(n), grp = new Uint8Array(n);
    const ra = col(file, 'raDeg'), dec = col(file, 'decDeg'), morph = col(file, 'morphology');
    for (let k = 0; k < n; k++) {
      const i = keep[k]!;
      row[k] = i;
      const d = f.dist(i);
      dist[k] = d; err[k] = f.err(i);
      const p = sphericalToCartesian(ra[i] as number, dec[i] as number, d);
      pos[3 * k] = p[0]; pos[3 * k + 1] = p[1]; pos[3 * k + 2] = p[2];
      const cls = classifyMorphology(fileId, strAt(morph, i));
      const m = MORPH_VISUAL[cls];
      rgb[3 * k] = m[0]; rgb[3 * k + 1] = m[1]; rgb[3 * k + 2] = m[2];
      const mag = f.mag(i);
      alpha[k] = markerAlphaFromMag(mag) * (f.independent(i) ? 1 : MARKER_VISUAL.notIndependent);
      radius[k] = markerRadiusPx(mag);
      const dm = f.diam(i);
      glowRad[k] = dm !== null && dm > 0 ? (dm / 60) * (Math.PI / 180) / 2 : 0;
      grp[k] = f.group(i);
    }
    return { kind, fileId, ns: kind === 'virgo' ? VIRGO_ROW_NS : fileId, file, n, row, pos, dist, err, rgb, alpha, radius, glowRad, group: grp, infos: new Array<MutableInfo | null>(n).fill(null), skipped };
  }

  private rebuildLookup(): void {
    this.lookup.clear();
    for (const s of [this.sets.lg, this.sets.ungc, this.sets.virgo]) {
      if (!s) continue;
      for (let k = 0; k < s.n; k++) this.lookup.set(`${s.ns}:${s.row[k]!}`, { set: s, i: k });
    }
  }

  // ---- per-row texts --------------------------------------------------------------------------------------------------

  private rowNote(s: RowSet, k: number): string {
    const f = s.file, i = s.row[k]!;
    const dMpc = s.dist[k]! / 1e6;
    const err = s.err[k]!;
    const errText = Number.isFinite(err) ? `+/- ${(err / 1e6).toPrecision(2)} Mpc (${s.kind === 'lg' ? 'mean of the catalogue\'s upper and lower errors' : 'propagated from the catalogue distance-modulus error'}); drawn as the thin bar along the line of sight when selected` : 'no published error';
    const mag = s.kind === 'lg' ? numAt(col(f, 'vMag'), i) : s.kind === 'ungc' ? numAt(col(f, 'bMag'), i) : numAt(col(f, 'ksMag'), i);
    const magBand = s.kind === 'lg' ? 'V' : s.kind === 'ungc' ? 'B' : 'Ks';
    const morph = strAt(col(f, 'morphology'), i);
    const display = `Marker colour follows the morphology class (display choice: early types warm, late-type/irregular cool) and size/brightness the catalogue ${magBand} magnitude${mag === null ? ' (none published: smallest marker)' : ` ${mag}`} (display mapping, capped) - not a measurement.`;
    if (s.kind === 'virgo') {
      const cz = numAt(col(f, 'czKms'), i);
      return `2MRS galaxy in the Virgo region (our cut, not a published membership). Placed at the cluster-mean distance ${dMpc.toFixed(1)} Mpc, NOT at its own redshift distance${cz !== null ? ` (its cz is ${cz} km/s)` : ''}; the cluster is about 2.4 Mpc deep, so the line-of-sight position is illustrative. Distance: ${errText}. ${display}`;
    }
    const method = strAt(col(f, 'distMethod'), i);
    let t = `${s.kind === 'lg' ? 'McConnachie (2012)' : 'Updated Nearby Galaxy Catalog'} row: distance ${dMpc.toPrecision(3)} Mpc, ${errText}.`;
    if (s.kind === 'ungc' && method) {
      t += isIndependentDistance(UNGC_FILE, method) ? ` Distance method: ${method}.` : ` Distance method '${method}' is NOT an independent distance measurement of this galaxy (assigned from group membership, the Hubble flow or see the paper), so its marker is drawn slightly fainter.`;
    }
    if (morph) t += ` Morphology as catalogued: ${morph}.`;
    return `${t} ${display}`;
  }

  private groupNote(g: GroupEntry): string {
    const sets = this.sets;
    const parts: string[] = [];
    parts.push(`The dashed ring is an ILLUSTRATIVE boundary (radius ${(g.ringPc / 1e6).toFixed(2)} Mpc, sized by the farthest catalogued row from the anchor), not a scientific boundary of the ${g.kind === 'galaxy-cluster' ? 'cluster' : 'group'}.`);
    if (g.id === 'local-group') {
      parts.push(`Anchor: midway between the Milky Way and M31 (illustrative; the Local Group has no catalogued position). ${sets.lg ? `${sets.lg.n} McConnachie (2012) rows drawn (${sets.lg.skipped.imageDuplicates} image galaxies are drawn from their images instead).` : 'Galaxies load when you are far enough away.'} The table's subgroup flag separates Milky Way and M31 satellites from "Rest", which includes nearby neighbours that are not Local Group members.`);
      parts.push('The distance of the group has no published error; per-galaxy distances carry the catalogue errors (bars when selected).');
    } else if (g.id === 'm81-group') {
      const nm = this.memberNames['m81-group'].size;
      parts.push(`Members: ${nm} UNGC galaxies whose main disturber is M81 with tidal index Theta_1 > 0 (Karachentsev et al. 2013) - a tidal criterion, not a proof of binding. The group position is that of M81, not a barycentre. Several members' distances are assigned from membership ('mem'), not independent measurements (fainter markers).`);
    } else {
      parts.push(`Members: ${this.memberNames['virgo-cluster'].size} 2MRS galaxies within 6 degrees of M87 with cz -500 to 2500 km/s (our window, includes blueshifted infalling members, still contaminated by foreground and background; our cut, not a published membership), placed at the cluster-mean SBF distance (16.5 Mpc): their line-of-sight depth is flattened (the real cluster is about 2.4 Mpc deep).`);
    }
    parts.push(g.distBar ? `Group distance: ${((g.distBar.farPc - g.distBar.nearPc) / 2 / 1e6).toPrecision(2)} Mpc published uncertainty (thin bar along the line of sight when selected).` : 'No published distance error for the group position.');
    return parts.join(' ');
  }

  // ---- frame ----------------------------------------------------------------------------------------------------------

  update(ctx: DeepRenderContext): readonly DeepScreenInfo[] {
    const V = GROUP_VISUAL;
    const { camPc, basis, viewport, pixelsPerRadian: ppr, nowSeconds } = ctx;
    this.out.length = 0;
    this.splats.setView(viewport.width, viewport.height, ppr);
    const camSun = length(camPc);
    const farFade = ctx.farFade ?? 1;
    const wantLg = sunCatalogueWanted(LG_FILE, camSun), wantUngc = sunCatalogueWanted(UNGC_FILE, camSun);
    const virgoDist = this.virgoPos ? Math.hypot(this.virgoPos[0] - camPc[0], this.virgoPos[1] - camPc[1], this.virgoPos[2] - camPc[2]) : Infinity;
    const wantVirgo = sunCatalogueWanted(TWOMRS_FILE, camSun) && virgoBlend(virgoDist) > 0.001;

    const lgFile = wantLg || wantUngc ? this.store.want(LG_FILE, nowSeconds) : this.store.peek(LG_FILE);
    const ungcFile = wantUngc ? this.store.want(UNGC_FILE, nowSeconds) : this.store.peek(UNGC_FILE);
    const twFile = wantVirgo ? this.store.want(TWOMRS_FILE, nowSeconds) : this.store.peek(TWOMRS_FILE);
    let changed = false;
    if (this.sets.lg && this.sets.lg.file !== lgFile) { this.sets.lg = null; changed = true; }
    if (this.sets.ungc && this.sets.ungc.file !== ungcFile) { this.sets.ungc = null; changed = true; }
    if (this.sets.virgo && this.sets.virgo.file !== twFile) { this.sets.virgo = null; changed = true; }
    if (lgFile && !this.sets.lg) { this.sets.lg = this.buildLg(lgFile); changed = true; }
    if (ungcFile && lgFile && !this.sets.ungc) { this.sets.ungc = this.buildUngc(ungcFile, lgFile); changed = true; }
    if (twFile && !this.sets.virgo) { this.sets.virgo = this.buildVirgo(twFile); changed = true; }
    if (changed) { this.rebuildLookup(); for (const g of this.groups.values()) g.info = null; }

    const sel = ctx.selectedId;
    const selRow = sel ? parseRowId(sel) : null;
    let selBit = 0;
    for (const g of this.groups.values()) if (g.id === sel) selBit = GROUP_BIT[g.id];
    const lgW = (1 - logSmoothstep(camSun, V.lgFadeOut[0], V.lgFadeOut[1])) * farFade;
    const ungcW = (1 - logSmoothstep(camSun, V.ungcFadeOut[0], V.ungcFadeOut[1])) * farFade;
    const virgoW = virgoBlend(virgoDist) * farFade;

    let n = 0, visible = 0;
    const rel = this.rel;
    const halfW = viewport.width / 2, halfH = viewport.height / 2;
    const emitSet = (s: RowSet | null, w: number): void => {
      if (!s || w <= 0.002) return;
      for (let k = 0; k < s.n; k++) {
        const rx = s.pos[3 * k]! - camPc[0], ry = s.pos[3 * k + 1]! - camPc[1], rz = s.pos[3 * k + 2]! - camPc[2];
        const z = rx * basis.forward[0] + ry * basis.forward[1] + rz * basis.forward[2];
        if (z <= 0) continue;
        const sx = (rx * basis.right[0] + ry * basis.right[1] + rz * basis.right[2]) / z * ppr;
        const sy = (rx * basis.up[0] + ry * basis.up[1] + rz * basis.up[2]) / z * ppr;
        if (Math.abs(sx) > halfW + 20 || Math.abs(sy) > halfH + 20) continue;
        const member = selBit !== 0 && (s.group[k]! & selBit) !== 0;
        let a = s.alpha[k]! * w * (member ? V.highlightAlpha : selBit !== 0 ? V.othersWhenGroupSelected : 1);
        if (a > 1) a = 1;
        const r = s.radius[k]! + (member ? V.highlightExtraPx : 0);
        const isSel = selRow !== null && selRow.row === s.row[k] && selRow.fileId === s.ns;
        const distC = Math.hypot(rx, ry, rz);
        this.splats.setStatic(n, r + (isSel ? 1 : 0), r + (isSel ? 1 : 0), 0, 0, s.rgb[3 * k]!, s.rgb[3 * k + 1]!, s.rgb[3 * k + 2]!, isSel ? 1 : a, V.markerPower);
        this.splats.setCentre(n, rx, ry, rz); n++;
        const gPx = s.glowRad[k]! > 0 ? Math.atan2(s.glowRad[k]! * distC, distC) * ppr : 0;
        if (gPx >= 2.5 && n < this.splats.capacity - 2) {
          this.splats.setStatic(n, gPx, gPx, 0, 0, s.rgb[3 * k]!, s.rgb[3 * k + 1]!, s.rgb[3 * k + 2]!, a * V.glowAlpha * (member ? 1.4 : 1), V.glowPower);
          this.splats.setCentre(n, rx, ry, rz); n++;
        }
        if (isSel && n < this.splats.capacity - 1) {
          this.splats.setStatic(n, V.selectedHaloPx, V.selectedHaloPx, 0, 0, 1, 0.95, 0.8, V.selectedHaloAlpha, 1.2);
          this.splats.setCentre(n, rx, ry, rz); n++;
        }
        if (a >= V.minRowAlphaToEmit) {
          let info = s.infos[k] ?? null;
          if (!info) {
            const key = `${s.ns}:${s.row[k]!}`;
            info = { id: key, kind: 'catalogue-point', x: 0, y: 0, pixelRadius: 0, distancePc: 0, visible: true, lod: 'marker', label: strAt(col(s.file, 'name'), s.row[k]!) ?? key, representationNote: this.rowNote(s, k) };
            s.infos[k] = info;
          }
          info.x = halfW + sx; info.y = halfH - sy; info.pixelRadius = Math.max(V.minPickRadiusPx, r + 2); info.distancePc = distC; info.visible = true;
          this.out.push(info);
          visible++;
        }
        if (n >= this.splats.capacity - 3) return;
      }
    };
    emitSet(this.sets.lg, lgW);
    emitSet(this.sets.ungc, ungcW);
    emitSet(this.sets.virgo, virgoW);
    this.splats.setCount(n);
    this.splats.commit();

    // ---- group rings + infos
    let lines = 0;
    for (const g of this.groups.values()) {
      rel[0] = g.centre[0] - camPc[0]; rel[1] = g.centre[1] - camPc[1]; rel[2] = g.centre[2] - camPc[2];
      const dist = Math.hypot(rel[0], rel[1], rel[2]);
      const z = rel[0] * basis.forward[0] + rel[1] * basis.forward[1] + rel[2] * basis.forward[2];
      const ringPx = (g.ringPc / Math.max(dist, 1e-9)) * ppr;
      let sx = 0, sy = 0;
      if (z > 0) { sx = (rel[0] * basis.right[0] + rel[1] * basis.right[1] + rel[2] * basis.right[2]) / z * ppr; sy = (rel[0] * basis.up[0] + rel[1] * basis.up[1] + rel[2] * basis.up[2]) / z * ppr; }
      const inFront = z > 0;
      const near = Math.max(0, Math.min(1, (ringPx - V.ringFadeInPx[0]) / (V.ringFadeInPx[1] - V.ringFadeInPx[0])));
      const outside = Math.max(0, Math.min(1, (dist / g.ringPc - V.ringInsideFade[0]) / (V.ringInsideFade[1] - V.ringInsideFade[0])));
      const huge = ringPx > 4000 ? 0 : 1;
      let w = near * near * (3 - 2 * near) * outside * huge * farFade;
      // each ring fades with its member set, so the cosmic-structure layer owns the far view
      w *= g.id === 'virgo-cluster' ? virgoW / Math.max(farFade, 1e-6) : g.id === 'local-group' ? lgW / Math.max(farFade, 1e-6) : ungcW / Math.max(farFade, 1e-6);
      const isSelGroup = sel === g.id;
      if (isSelGroup) w = Math.max(w, 0.35 * outside * huge * farFade);
      const show = w > 0.01 && inFront;
      g.line.visible = show;
      if (show) {
        g.lineMat.opacity = Math.min(1, w) * V.ringMaxOpacity * (isSelGroup ? 1.6 : 1);
        this.writeRing(g, rel, basis.right, basis.up);
        lines++;
      }
      const onScreen = inFront && Math.abs(sx) < halfW + ringPx && Math.abs(sy) < halfH + ringPx;
      if (onScreen && w > 0.01) visible++;
      const pixelRadius = Math.max(V.minPickRadiusPx, Math.min(1e5, ringPx));
      let info = g.info;
      if (!info) info = g.info = { id: g.id, kind: g.kind, x: 0, y: 0, pixelRadius: 0, distancePc: 0, visible: false, lod: 'ring', label: g.obj.name, representationNote: this.groupNote(g) };
      info.x = halfW + sx; info.y = halfH - sy; info.pixelRadius = pixelRadius; info.distancePc = dist; info.visible = onScreen && w > 0.01;
      info.lod = (g.id === 'local-group' ? this.sets.lg : g.id === 'm81-group' ? this.sets.ungc : this.sets.virgo) ? 'ring + catalogue markers' : 'ring';
      this.out.push(info);
    }

    // ---- line-of-sight uncertainty bar for the selected object / row
    this.updateBar(sel, camPc, basis.right, ppr);
    this.lastStats = { drawCalls: (n > 0 ? 1 : 0) + lines + (this.bar.visible ? 1 : 0), textureBytes: 0, pointsDrawn: n, objectsVisible: visible };
    return this.out;
  }

  private writeRing(g: GroupEntry, rel: readonly number[], right: Vec3, up: Vec3): void {
    const N = GROUP_VISUAL.ringDashes, fill = GROUP_VISUAL.ringDashFill, R = g.ringPc, b = g.lineBuf;
    let o = 0;
    for (let k = 0; k < N; k++) {
      for (let e = 0; e < 2; e++) {
        const th = ((k + e * fill) / N) * Math.PI * 2;
        const c = Math.cos(th) * R, s = Math.sin(th) * R;
        b[o++] = rel[0]! + c * right[0] + s * up[0]; b[o++] = rel[1]! + c * right[1] + s * up[1]; b[o++] = rel[2]! + c * right[2] + s * up[2];
      }
    }
    (g.line.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  /** The thin amber bar along the Sun-to-object line of sight spanning distance +/- the published error (only when one is published). */
  private updateBar(sel: string | null, camPc: Vec3, right: Vec3, ppr: number): void {
    let u: Vec3 | undefined, bar: { nearPc: number; farPc: number } | null = null;
    if (sel) {
      const e = this.lookup.get(sel);
      if (e) {
        const k = e.i, s = e.set;
        const d = s.dist[k]!;
        u = [s.pos[3 * k]! / d, s.pos[3 * k + 1]! / d, s.pos[3 * k + 2]! / d];
        bar = distanceBarPc(d, s.err[k]!);
      } else {
        const g = this.groups.get(sel as GroupId);
        if (g?.distBar) { const d = length(g.centre); u = [g.centre[0] / d, g.centre[1] / d, g.centre[2] / d]; bar = g.distBar; }
      }
    }
    if (!u || !bar) { this.bar.visible = false; return; }
    const mid = 0.5 * (bar.nearPc + bar.farPc);
    const rx = u[0] * mid - camPc[0], ry = u[1] * mid - camPc[1], rz = u[2] * mid - camPc[2];
    const dist = Math.max(Math.hypot(rx, ry, rz), 1e-9);
    const cap = (GROUP_VISUAL.barCapPx / ppr) * dist;
    const b = this.barBuf;
    const p0: Vec3 = [u[0] * bar.nearPc - camPc[0], u[1] * bar.nearPc - camPc[1], u[2] * bar.nearPc - camPc[2]];
    const p1: Vec3 = [u[0] * bar.farPc - camPc[0], u[1] * bar.farPc - camPc[1], u[2] * bar.farPc - camPc[2]];
    b.set(p0, 0); b.set(p1, 3);
    b.set([p0[0] - cap * right[0], p0[1] - cap * right[1], p0[2] - cap * right[2]], 6); b.set([p0[0] + cap * right[0], p0[1] + cap * right[1], p0[2] + cap * right[2]], 9);
    b.set([p1[0] - cap * right[0], p1[1] - cap * right[1], p1[2] - cap * right[2]], 12); b.set([p1[0] + cap * right[0], p1[1] + cap * right[1], p1[2] + cap * right[2]], 15);
    (this.bar.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.bar.visible = true;
  }

  stats(): DeepRendererStats { return this.lastStats; }

  dispose(): void {
    for (const g of this.groups.values()) { g.line.geometry.dispose(); g.lineMat.dispose(); }
    this.bar.geometry.dispose(); this.barMat.dispose();
    this.splats.dispose();
    this.groups.clear(); this.lookup.clear();
    this.sets = { lg: null, ungc: null, virgo: null };
    this.group.clear();
  }
}
