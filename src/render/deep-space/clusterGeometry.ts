/**
 * Pure maths for the cluster / galaxy-group / cosmic-structure renderers. No Three.js, no DOM, no clocks: everything here is
 * float64 and unit-tested (tests/deepspace-render-structure*.test.ts).
 *
 * Three kinds of numbers appear and are kept apart:
 *   MEASURED   catalogue values used as published (RA/Dec, parallax, cz, magnitudes, distances)
 *   DERIVED    arithmetic on measured values (1000/parallax, cz/H0), with the assumption stated at the definition
 *   VISUAL     drawing choices (colours, sizes, opacities): in the *_VISUAL blocks, never presented as data
 */
import { angularSeparationDeg, equatorialToUnit } from '../../core/astro/coordinates';
import { DEG_TO_RAD } from '../../core/astro/constants';
import type { Vec3 } from '../../core/spatial/vec3';
import { colourFromBpRp } from '../starColour';

// ---- cosmic structure: Hubble-flow distances ------------------------------------------------------------------------------

/**
 * H0 = 70 km/s/Mpc: an APPLICATION CHOICE, NOT A MEASUREMENT. It converts cz to a distance for drawing only
 * (d = cz / H0, linear Hubble law). It carries a systematic uncertainty of order 10%, and peculiar velocities of hundreds of
 * km/s are not removed. Defined once, here.
 */
export const APPLICATION_H0_KM_S_MPC = 70;
/**
 * Rows with cz below this are NOT placed using cz: at that distance (about 14 Mpc) the peculiar velocity (hundreds of km/s)
 * is a large fraction of cz, so a Hubble-flow distance would be meaningless. They are not drawn by the cosmic-structure layer and
 * are counted in its note. (The nearby galaxies are drawn from the UNGC and McConnachie catalogues, which carry real distances.)
 */
export const MIN_CZ_FOR_HUBBLE_KMS = 1000;
/** The 2MRS flux limit (extinction-corrected Ks), from the catalogue's own documentation (see the file's caveats). */
export const TWOMRS_KS_LIMIT = 11.75;
export const PC_PER_MPC = 1e6;

/** Distance in parsecs from cz, or null when cz is not usable (below MIN_CZ_FOR_HUBBLE_KMS, or not finite). */
export function hubbleDistancePc(czKms: number | null | undefined, h0 = APPLICATION_H0_KM_S_MPC): number | null {
  if (czKms === null || czKms === undefined || !Number.isFinite(czKms) || czKms < MIN_CZ_FOR_HUBBLE_KMS) return null;
  return (czKms / h0) * PC_PER_MPC;
}

// ---- star-cluster members -------------------------------------------------------------------------------------------------

/** Deterministic uniform in (0, 1) from a string (FNV-1a, then a murmur3 finaliser). Same id, same number, in every run. */
export function hash01(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return ((h >>> 0) + 0.5) / 4294967296;
}

/** Plummer line-of-sight CDF: F(t) = 1/2 + t (2 t^2 + 3) / (4 (1 + t^2)^1.5), t = z / sqrt(a^2 + R^2). */
export function plummerLosCdf(t: number): number { const q = 1 + t * t; return 0.5 + (t * (2 * t * t + 3)) / (4 * q * Math.sqrt(q)); }

/** Inverse of plummerLosCdf by bisection (monotone). u in (0,1). */
export function plummerLosQuantile(u: number): number {
  let lo = -50, hi = 50;   // u is clamped to [0.001, 0.999] by the caller, which keeps |t| below about 4
  for (let i = 0; i < 36; i++) { const mid = 0.5 * (lo + hi); if (plummerLosCdf(mid) < u) lo = mid; else hi = mid; }
  return 0.5 * (lo + hi);
}

/**
 * ILLUSTRATIVE line-of-sight offset (pc, + = away from the Sun) of a globular-cluster member whose PROJECTED radius is R (pc).
 * The depth of an individual globular-cluster star is NOT measured (its parallax is far too imprecise). We assume the cluster
 * is spherically symmetric with a Plummer profile whose scale radius equals the catalogued projected half-light radius
 * (for a Plummer sphere the two are equal); the star's depth is then a deterministic quantile of the line-of-sight density at its
 * projected radius, p(z | R) ~ (1 + z^2 / (a^2 + R^2))^(-5/2), selected by a hash of its Gaia source id.
 */
export function assumedGlobularDepthPc(sourceId: string, projectedRadiusPc: number, plummerScalePc: number): number {
  const u = Math.min(0.999, Math.max(0.001, hash01(sourceId)));
  const s = Math.sqrt(plummerScalePc * plummerScalePc + projectedRadiusPc * projectedRadiusPc);
  return s * plummerLosQuantile(u);
}

export type PlacementKind = 'parallax' | 'mean-no-parallax' | 'mean-nonpositive-parallax' | 'assumed-depth';

/** Distance of an open-cluster member from its own parallax (1000 / mas = pc); unusable parallaxes fall back to the cluster mean. */
export function openMemberDistancePc(parallaxMas: number | null | undefined, meanDistancePc: number): { distancePc: number; kind: PlacementKind } {
  if (parallaxMas === null || parallaxMas === undefined || !Number.isFinite(parallaxMas)) return { distancePc: meanDistancePc, kind: 'mean-no-parallax' };
  if (!(parallaxMas > 0)) return { distancePc: meanDistancePc, kind: 'mean-nonpositive-parallax' };
  return { distancePc: 1000 / parallaxMas, kind: 'parallax' };
}

export interface MemberColumns {
  readonly raDeg: readonly (number | string | null)[];
  readonly decDeg: readonly (number | string | null)[];
  readonly sourceId: readonly (number | string | null)[];
  readonly gMag: readonly (number | string | null)[];
  readonly bpRp: readonly (number | string | null)[];
  readonly parallaxMas: readonly (number | string | null)[];
  readonly parallaxErrMas?: readonly (number | string | null)[] | undefined;
}

export interface ClusterGeometry {
  readonly kind: 'open' | 'globular';
  readonly raDeg: number;
  readonly decDeg: number;
  /** Catalogued mean distance, pc. */
  readonly distancePc: number;
  /** Cluster centre, Sun-centred ICRS pc (from raDeg/decDeg/distancePc). */
  readonly centre: Vec3;
  /** Plummer scale radius, pc (globular only): the catalogued projected half-light radius. */
  readonly plummerScalePc: number;
}

export interface MemberBuild {
  readonly count: number;
  /** pc, member position minus cluster centre (float64 difference, narrowed to float32: small numbers). x,y,z interleaved. */
  readonly offset: Float32Array;
  /** Absolute Gaia G magnitude from the PLACED distance: M = G - 5 log10(d) + 5. */
  readonly absMag: Float32Array;
  readonly colour: Float32Array;
  /** Apparent G as catalogued, brightest first (the draw order; the quality scale keeps a prefix). */
  readonly gMag: Float32Array;
  readonly stats: {
    readonly total: number;
    readonly placedByParallax: number;
    readonly meanNoParallax: number;
    readonly meanNonPositiveParallax: number;
    readonly assumedDepth: number;
    readonly noColour: number;
    /** Parallax placed, but parallax error / parallax above 10% (line-of-sight scatter is then partly measurement noise). */
    readonly noisyParallax: number;
    readonly meanParallaxDistancePc: number | null;
    readonly faintestG: number;
    readonly brightestG: number;
  };
}

const num = (v: number | string | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Build the renderer arrays of a cluster from its member catalogue. Nothing is generated: one output row per catalogue row
 * that has a position and a G magnitude. Brightest first.
 */
export function buildMembers(cols: MemberColumns, g: ClusterGeometry): MemberBuild {
  const n = cols.raDeg.length;
  const rows: number[] = [];
  for (let i = 0; i < n; i++) if (num(cols.raDeg[i]) !== null && num(cols.decDeg[i]) !== null && num(cols.gMag[i]) !== null) rows.push(i);
  rows.sort((a, b) => (cols.gMag[a] as number) - (cols.gMag[b] as number) || a - b);
  const m = rows.length;
  const offset = new Float32Array(m * 3), absMag = new Float32Array(m), colour = new Float32Array(m * 3), gMag = new Float32Array(m);
  let byPlx = 0, noPlx = 0, nonPos = 0, assumed = 0, noCol = 0, noisy = 0, sumD = 0;
  for (let k = 0; k < m; k++) {
    const i = rows[k]!;
    const ra = cols.raDeg[i] as number, dec = cols.decDeg[i] as number, G = cols.gMag[i] as number;
    let d: number;
    if (g.kind === 'open') {
      const p = openMemberDistancePc(num(cols.parallaxMas[i]), g.distancePc);
      d = p.distancePc;
      if (p.kind === 'parallax') {
        byPlx++; sumD += d;
        const e = cols.parallaxErrMas ? num(cols.parallaxErrMas[i]) : null;
        if (e !== null && e / (cols.parallaxMas[i] as number) > 0.1) noisy++;
      } else if (p.kind === 'mean-no-parallax') noPlx++; else nonPos++;
    } else {
      const sep = angularSeparationDeg(g.raDeg, g.decDeg, ra, dec) * DEG_TO_RAD;
      const R = g.distancePc * Math.sin(Math.min(sep, Math.PI / 2));
      d = Math.max(1e-3, g.distancePc + assumedGlobularDepthPc(String(cols.sourceId[i] ?? i), R, g.plummerScalePc));
      assumed++;
    }
    // Along the star's OWN line of sight, so its catalogued sky position is reproduced exactly from the Sun.
    const u = equatorialToUnit(ra, dec);
    offset[3 * k] = u[0] * d - g.centre[0]; offset[3 * k + 1] = u[1] * d - g.centre[1]; offset[3 * k + 2] = u[2] * d - g.centre[2];
    absMag[k] = G - 5 * Math.log10(d) + 5;
    gMag[k] = G;
    const bp = num(cols.bpRp[i]);
    if (bp === null) noCol++;
    const c = colourFromBpRp(bp);
    colour[3 * k] = c[0]; colour[3 * k + 1] = c[1]; colour[3 * k + 2] = c[2];
  }
  return {
    count: m, offset, absMag, colour, gMag,
    stats: {
      total: m, placedByParallax: byPlx, meanNoParallax: noPlx, meanNonPositiveParallax: nonPos, assumedDepth: assumed, noColour: noCol, noisyParallax: noisy,
      meanParallaxDistancePc: byPlx > 0 ? sumD / byPlx : null, faintestG: m ? gMag[m - 1]! : NaN, brightestG: m ? gMag[0]! : NaN,
    },
  };
}

// ---- galaxy markers: morphology, magnitude, distance method ---------------------------------------------------------------

export type MorphClass = 'early' | 'intermediate' | 'late' | 'unknown';

/**
 * De Vaucouleurs T-type to a coarse class: T <= 0 (E, S0) early; 1..5 intermediate (Sa-Sc); >= 6 late (Scd, Sd, Sm, Im, BCD).
 * The three files spell morphology differently, so each form is read here (the strings are kept exactly as stored in the data):
 *   UNGC          "T=<n>" or a dwarf class (Sph, dE, dEem, dS0em, S0em early-ish; Ir, Im, BCD, Tr, Sm, HIcld late)
 *   McConnachie   MType: dSph, dE (early), dIrr, Irr, dIrr/dSph, Sc, Sb, cE, "????"
 *   2MRS (ZCAT)   a code whose leading integer is the T-type; codes outside -9..11 (98 = unknown, 20 ...) are unknown.
 */
export function classifyMorphology(fileId: string, morphology: string | null | undefined): MorphClass {
  if (morphology === null || morphology === undefined) return 'unknown';
  const s = morphology.trim();
  if (s === '' || /^\?+$/.test(s)) return 'unknown';
  const fromT = (t: number): MorphClass => (t <= 0 ? 'early' : t <= 5 ? 'intermediate' : 'late');
  if (fileId === 'twomrs') {
    const m = /^(-?\d+)/.exec(s);
    if (!m) return 'unknown';
    const t = Number(m[1]);
    return t >= -9 && t <= 11 ? fromT(t) : 'unknown';
  }
  const tm = /^T=(-?\d+)$/.exec(s);
  if (tm) return fromT(Number(tm[1]));
  const k = s.replace(/[?()]/g, '');
  if (/^(dSph|Sph|dE|dEem|dE\/dSph|cE|S0|S0em|dS0em|E)$/.test(k)) return 'early';
  if (/^(dIrr|Irr|Ir|Im|BCD|Tr|Sm|HIcld|dIrr\/dSph)$/.test(k)) return 'late';
  if (/^S[abcd]/.test(k)) return 'intermediate';
  return 'unknown';
}

/**
 * DISPLAY choice (not data, and not the galaxies' real colours at this scale): early types warm, intermediate neutral, late and
 * irregular cool. Restrained so no hue dominates; unknown morphology is neutral grey-white.
 */
export const MORPH_VISUAL: Readonly<Record<MorphClass, readonly [number, number, number]>> = {
  early: [1.0, 0.8, 0.58],
  intermediate: [0.92, 0.92, 0.9],
  late: [0.6, 0.78, 1.0],
  unknown: [0.78, 0.78, 0.8],
};

/** UNGC distance-method codes that are NOT independent distance measurements of the galaxy (see the file's caveats). */
export const UNGC_NOT_INDEPENDENT: ReadonlySet<string> = new Set(['mem', 'h', "h'", 'txt']);
export function isIndependentDistance(fileId: string, method: string | null | undefined): boolean {
  return !(fileId === 'ungc' && method !== null && method !== undefined && UNGC_NOT_INDEPENDENT.has(method));
}

/** VISUAL mapping of a catalogue apparent magnitude (B, V or Ks as the file gives it; not recomputed for the camera). */
export const MARKER_VISUAL = {
  refMag: 15, radiusMinPx: 1.3, radiusMaxPx: 3.8, radiusPxPerMag: 0.28,
  alphaMin: 0.28, alphaMax: 0.95, alphaPerMag: 0.06, alphaNoMag: 0.35,
  /** Opacity factor for rows whose distance is not an independent measurement. */
  notIndependent: 0.6,
} as const;
export function markerRadiusPx(mag: number | null | undefined): number {
  const V = MARKER_VISUAL;
  if (mag === null || mag === undefined || !Number.isFinite(mag)) return V.radiusMinPx;
  return Math.min(V.radiusMaxPx, Math.max(V.radiusMinPx, V.radiusMinPx + V.radiusPxPerMag * (V.refMag - mag)));
}
export function markerAlphaFromMag(mag: number | null | undefined): number {
  const V = MARKER_VISUAL;
  if (mag === null || mag === undefined || !Number.isFinite(mag)) return V.alphaNoMag;
  return Math.min(V.alphaMax, Math.max(V.alphaMin, V.alphaMin + V.alphaPerMag * (V.refMag - mag)));
}

// ---- duplicate rows: image galaxies already drawn by GalaxyRenderer ------------------------------------------------------
// The rule lives in src/discovery/duplicates.ts (pure; the discovery engine uses the SAME function to merge catalogue rows into the curated records).
export { buildDuplicateIndex, DUPLICATE_MATCH_ARCMIN, isImageGalaxyDuplicate, NAME_ALIASES, normaliseDesignation } from '../../discovery/duplicates';
export type { DuplicateIndex, ImageGalaxyRef } from '../../discovery/duplicates';

/** Positional match radius (arcmin) when the same galaxy appears in two catalogues (McConnachie and UNGC). */
export const CROSS_CATALOGUE_MATCH_ARCMIN = 1.0;

// ---- groups ---------------------------------------------------------------------------------------------------------------

export function maxDistanceFrom(centre: Vec3, points: readonly Vec3[]): number {
  let m = 0;
  for (const p of points) m = Math.max(m, Math.hypot(p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]));
  return m;
}

/** Midpoint of two positions (used for the illustrative Local Group anchor: halfway between the Milky Way and M31). */
export function midpoint(a: Vec3, b: Vec3): Vec3 { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]; }

/**
 * Radius (pc) of the illustrative boundary ring of a group: the largest distance from its anchor to any catalogued member row,
 * widened by `margin`. A drawing aid sized by the data's own spread; NOT a physical boundary of the group.
 */
export const GROUP_RING_MARGIN = 1.08;
export function ringRadiusPc(centre: Vec3, members: readonly Vec3[]): number { return GROUP_RING_MARGIN * maxDistanceFrom(centre, members); }

/**
 * Radius (pc) of the illustrative ring of each group, measured from its anchor to the farthest catalogued member row
 * (before GROUP_RING_MARGIN). Derived offline from the point files with the same code as ringRadiusPc and checked against the files
 * by tests/deepspace-render-structure-data.test.ts, so these cannot drift from the data silently. Anchors: Local Group = midpoint
 * of the Milky Way centre and M31 (illustrative: the Local Group has no catalogued position); M81 group = M81; Virgo = the
 * cluster position in the data file (members are flattened onto the cluster-mean distance, as the data file states).
 */
export const GROUP_EXTENT_PC: Readonly<Record<string, number>> = {
  'local-group': 3_054_994,
  'm81-group': 563_606,
  'virgo-cluster': 1_723_022,
};
/** A group's comfortable camera distance is this many ring radii (the same 3-4 x rule the layer uses for clusters; a VISUAL choice). */
export const GROUP_VIEW_RADII = 4;
export function groupViewDistancePc(id: string): number | undefined {
  const r = GROUP_EXTENT_PC[id];
  return r === undefined ? undefined : GROUP_VIEW_RADII * GROUP_RING_MARGIN * r;
}

/**
 * Crossfade between the Virgo members drawn at the cluster-mean distance (galaxy-cluster renderer, weight w) and the same
 * galaxies drawn at cz/H0 by the cosmic-structure layer (weight 1 - w). Depends only on the camera's distance from the cluster.
 */
export const VIRGO_BLEND = { fromPc: 3e7, toPc: 1.2e8 } as const;
export function virgoBlend(camToVirgoPc: number): number {
  if (!(camToVirgoPc > 0)) return 1;
  const t = Math.min(1, Math.max(0, (Math.log(camToVirgoPc) - Math.log(VIRGO_BLEND.fromPc)) / (Math.log(VIRGO_BLEND.toPc) - Math.log(VIRGO_BLEND.fromPc))));
  return 1 - t * t * (3 - 2 * t);
}

/** Line-of-sight uncertainty bar of a catalogue row in pc: [near, far] distances, or null when there is no published error. */
export function distanceBarPc(distPc: number, errPc: number | null | undefined): { nearPc: number; farPc: number } | null {
  if (errPc === null || errPc === undefined || !Number.isFinite(errPc) || !(errPc > 0)) return null;
  return { nearPc: Math.max(0, distPc - errPc), farPc: distPc + errPc };
}
