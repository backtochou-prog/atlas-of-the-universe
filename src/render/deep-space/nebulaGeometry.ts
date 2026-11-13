import { DEG_TO_RAD } from '../../core/astro/constants';
import { equatorialToUnit } from '../../core/astro/coordinates';
import { distanceMetres, skyPlaneBasis } from '../../core/deepspace/geometry';
import { dot, scale, type Vec3 } from '../../core/spatial/vec3';
import { METRES_PER_PARSEC } from '../../core/units';
import type { ImageStats } from './DeepSpaceAssetManager';
import type { DeepImageAsset, DeepSpaceObject, NebulaClass } from '../../data/deepspace/types';

/**
 * Pure geometry of the nebula "multi-layer image projection". No Three.js, no DOM.
 *
 * WHAT THIS IS. A real archive image is a flat picture: it has no depth. To let the viewer move around a nebula without the picture
 * collapsing into a single card, the SAME texture is split by brightness (and, for emission nebulae, a little by colour) into N soft
 * bands; band k is drawn on its own sheet at a different distance from the Sun. The depth offsets are an ASSUMED thickness, a visual
 * parameter per nebula class: they are not measurements. The sheets are all scaled about the Sun (a homothety), so seen from the Sun
 * every sheet covers exactly the same piece of sky, and because the band weights sum to one the sum of the sheets is the original
 * image. Off that line of sight the sheets separate (parallax). Nothing here is a measured 3D structure.
 */
const PC = METRES_PER_PARSEC;

/** VISUAL parameters. None of these is a scientific value: they set how the illustration is built and drawn. */
export const NEBULA_VISUAL = {
  /** Layer count range; the count follows ctx.quality. */
  layersMin: 3,
  layersMax: 5,
  /**
   * ASSUMED line-of-sight thickness of the stack, as a fraction of the sheet's transverse size (its longer side), by class.
   * Illustrative: the real depth of these objects is not known from the image; the fractions only keep the effect modest.
   */
  thicknessFraction: { emission: 0.35, reflection: 0.25, dark: 0.2, planetary: 0.15, 'supernova-remnant': 0.2, 'molecular-cloud': 0.3 } as Readonly<Record<NebulaClass, number>>,
  /** Weight of the colour (red-blue) criterion versus the luminance criterion in the band coordinate, by class. Emission nebulae only. */
  colourBandWeight: { emission: 0.3, reflection: 0, dark: 0, planetary: 0, 'supernova-remnant': 0, 'molecular-cloud': 0 } as Readonly<Record<NebulaClass, number>>,
  /** Luminance (after black level and gain) that maps to the top band: t = sqrt(L / knee). */
  bandKnee: 0.6,
  /**
   * Display stretch (the galaxies' recipe with a gentler black level): a nebula often fills its frame, so its median is nebulosity, not sky;
   * subtracting 0.9 x median (as for galaxies) would remove real faint emission. Only this fraction of the median is subtracted.
   */
  blackFromMedian: 0.3,
  targetP99: 0.45,
  exposureMin: 1,
  exposureMax: 3.5,
  /** Facing below this (cos of the angle to the sheet normal) is "edge-on", not "from behind": the sign is meaningless there. */
  behindMinFacing: 0.02,
  /** The band decision is made from a blurred copy of the image (about this fraction of the image size), so that bands are cohesive structures, not pixel noise. */
  bandBlurFraction: 0.02,
  /** Fade of the layers with the angle between the view direction and the sheet normal (facing = |cos|). Floor is a few percent: never exactly zero, never invented volume. */
  edgeOnFloor: 0.04,
  edgeOnFacingLo: 0.05,
  edgeOnFacingHi: 0.45,
  /** Below this facing the note says the picture is seen edge-on (about 78 degrees from the normal). */
  edgeOnNoteFacing: 0.2,
  /** Fixed marker opacity: the data has no nebular magnitudes, so nothing is invented. */
  markerAlpha: 0.5,
  markerRadiusPx: 2.0,
  markerPower: 2.0,
  glowAlpha: 0.38,
  glowPower: 1.6,
  glowMinSemiAxisPx: 2.5,
  /** Glow footprint relative to the inscribed ellipse of the image field. */
  glowExtent: 1.0,
  imageFadeSeconds: 0.6,
  minPickRadiusPx: 4,
  /** Nebulae are Milky Way objects: they fade out when the camera is far from them (log-smooth between these distances, parsecs). */
  galacticFadeFromPc: 8e4,
  galacticFadeToPc: 8e5,
  /** An asset covering less than this fraction of the catalogue's major axis is labelled a sub-region. */
  subRegionCoverage: 0.6,
  /** An asset whose centre lies further than this many field-widths from the catalogue position is a different field (sub-region). */
  subRegionOffsetFields: 0.5,
} as const;

export type DepthOrdering = 'bright-near' | 'dark-near';

/**
 * Which band sits nearer to the Sun.
 *  - 'dark-near' (dark nebulae only): a dark nebula is seen as a silhouette against emission behind it, so the absorbing
 *    (darkest) material is necessarily in front of the bright material. This is the one ordering the physics supports.
 *  - 'bright-near' (everything else): a plain convention, brightest band nearest, with no claim that it is the real order.
 */
export function orderingFor(cls: NebulaClass | undefined): DepthOrdering { return cls === 'dark' ? 'dark-near' : 'bright-near'; }

export const ILLUSTRATIVE_LABEL = 'illustrative depth layers — not a measured 3D structure';
export const EDGE_ON_NOTE = 'seen edge-on: imagery has no depth data';

export interface NebulaPlacement {
  readonly assetId: string;
  /** Sun-centred ICRS parsecs: the centre of the asset's own field at the object's catalogued distance (the PLANE is perpendicular to the line of sight to this centre). */
  readonly centre: Vec3;
  /** Half-width / half-height vectors of the field in the sheet plane, parsecs (gnomonic: half-size = d tan(fov/2)). */
  readonly xAxis: Vec3;
  readonly yAxis: Vec3;
  /** Unit normal, pointing TOWARD the Sun (the side the image is seen from). */
  readonly normal: Vec3;
  readonly distancePc: number;
  /** Longer side of the field, parsecs. */
  readonly transversePc: number;
  /** Half of the diagonal, parsecs. */
  readonly halfDiagPc: number;
  /** Largest field side, arcmin. */
  readonly fovMaxArcmin: number;
  /** Angular separation of the field's centre from the object's catalogue position, arcmin. */
  readonly separationArcmin: number;
  /** Field size over the catalogue's major axis (undefined when the catalogue has no size). */
  readonly coverage: number | undefined;
  readonly subRegion: boolean;
}

/** Angular separation of two ICRS directions, arcmin. */
export function separationArcmin(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const a = equatorialToUnit(ra1, dec1), b = equatorialToUnit(ra2, dec2);
  const c = Math.min(1, Math.max(-1, dot(a, b)));
  // atan2 of the cross magnitude is accurate for tiny separations
  const cr = Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);
  return (Math.atan2(cr, c) / DEG_TO_RAD) * 60;
}

/**
 * Place an asset BY ITS OWN GEOMETRY: its own centre direction, its own field of view and up angle, at the distance of the object.
 * (The Cosmic Cliffs field is two degrees from the Carina core; the Eagle Pillars and the Veil arcs are sub-fields: none of them
 * is centred on the object.)
 */
export function placeNebulaAsset(obj: DeepSpaceObject, asset: DeepImageAsset): NebulaPlacement {
  const sky = obj.sky, dist = sky?.distance;
  if (!sky || !dist) throw new Error(`${obj.id} has no sky position/distance`);
  const g = asset.geometry;
  const d = distanceMetres(dist).metres / PC;
  const u = equatorialToUnit(g.centreRaDeg, g.centreDecDeg);
  const basis = skyPlaneBasis(g.centreRaDeg, g.centreDecDeg, g.upPositionAngleDeg);
  const hw = d * Math.tan((g.fovArcmin[0] / 60) * DEG_TO_RAD / 2), hh = d * Math.tan((g.fovArcmin[1] / 60) * DEG_TO_RAD / 2);
  const fovMax = Math.max(g.fovArcmin[0], g.fovArcmin[1]);
  const sep = separationArcmin(sky.raDeg, sky.decDeg, g.centreRaDeg, g.centreDecDeg);
  const major = obj.angularSize?.majorArcmin;
  const coverage = major !== undefined && major > 0 ? fovMax / major : undefined;
  const subRegion = (coverage !== undefined && coverage < NEBULA_VISUAL.subRegionCoverage) || sep > NEBULA_VISUAL.subRegionOffsetFields * fovMax;
  return {
    assetId: asset.id, centre: scale(u, d), xAxis: scale(basis.right, hw), yAxis: scale(basis.up, hh), normal: basis.normal,
    distancePc: d, transversePc: 2 * Math.max(hw, hh), halfDiagPc: Math.hypot(hw, hh), fovMaxArcmin: fovMax, separationArcmin: sep, coverage, subRegion,
  };
}

/**
 * Default image of a nebula: the visible-light assets first (widest field wins, but the first one listed within 10 % of the
 * widest is preferred, because the data file lists the preferred asset first); if there is no visible-light image, the widest
 * of the others. Every other band stays one setBand() away.
 */
export function defaultNebulaAssetId(assets: readonly DeepImageAsset[]): string | undefined {
  if (assets.length === 0) return undefined;
  const fov = (a: DeepImageAsset) => Math.max(a.geometry.fovArcmin[0], a.geometry.fovArcmin[1]);
  const pool = assets.some((a) => a.band.kind === 'visible') ? assets.filter((a) => a.band.kind === 'visible') : assets;
  const widest = Math.max(...pool.map(fov));
  return (pool.find((a) => fov(a) >= 0.9 * widest) ?? pool[0]!).id;
}

/** Layer count for a quality scale in (0, 1]: 3 at the lowest, 5 at full quality. */
export function layerCountFor(quality: number): number {
  const q = Math.min(1, Math.max(0, quality));
  return Math.max(NEBULA_VISUAL.layersMin, Math.min(NEBULA_VISUAL.layersMax, Math.round(2 + 3 * q)));
}

/** Assumed stack thickness, parsecs. */
export function thicknessPcFor(cls: NebulaClass | undefined, transversePc: number): number {
  return (cls ? NEBULA_VISUAL.thicknessFraction[cls] : 0.25) * transversePc;
}

/**
 * Line-of-sight offsets of the N bands, parsecs, positive = farther from the Sun. Band k = 0 is the DARKEST, k = N-1 the brightest.
 * Spans exactly [-T/2, +T/2].
 */
export function layerOffsetsPc(n: number, thicknessPc: number, ordering: DepthOrdering): number[] {
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const o = n === 1 ? 0.5 : k / (n - 1);
    out.push(ordering === 'bright-near' ? thicknessPc / 2 - o * thicknessPc : -thicknessPc / 2 + o * thicknessPc);
  }
  return out;
}

export interface LayerQuad {
  readonly offsetPc: number;
  /** (d + offset) / d: the homothety factor about the Sun. */
  readonly scale: number;
  readonly centre: Vec3;
  readonly xAxis: Vec3;
  readonly yAxis: Vec3;
}

/**
 * The N sheets. Sheet k is the base sheet moved along the line of sight to its offset and scaled about the Sun by (d+offset)/d,
 * which is the same as multiplying every point of the base sheet by that factor. So every corner of every sheet lies on the same
 * ray from the Sun as the corresponding corner of the base sheet: from the Sun the sheets coincide.
 */
export function layerQuads(p: NebulaPlacement, offsetsPc: readonly number[]): LayerQuad[] {
  return offsetsPc.map((off) => {
    const s = (p.distancePc + off) / p.distancePc;
    return { offsetPc: off, scale: s, centre: scale(p.centre, s), xAxis: scale(p.xAxis, s), yAxis: scale(p.yAxis, s) };
  });
}

/** CPU mirror of the shader's band weights: smooth hat functions on t in [0, 1]; the N weights sum to exactly 1. */
export function bandWeights(t: number, n: number): number[] {
  const x = Math.min(1, Math.max(0, t)) * (n - 1);
  const out: number[] = [];
  for (let k = 0; k < n; k++) { const h = Math.min(1, Math.max(0, 1 - Math.abs(x - k))); out.push(h * h * (3 - 2 * h)); }
  return out;
}

/** Multiplier applied to every layer for a view at `facing` = |cos| of the angle between the view direction and the sheet normal. */
export function edgeOnFade(facing: number): number {
  const V = NEBULA_VISUAL;
  const t = Math.min(1, Math.max(0, (facing - V.edgeOnFacingLo) / (V.edgeOnFacingHi - V.edgeOnFacingLo)));
  return V.edgeOnFloor + (1 - V.edgeOnFloor) * t * t * (3 - 2 * t);
}

export interface NebulaNoteInput {
  readonly asset: DeepImageAsset | undefined;
  readonly placement: NebulaPlacement | undefined;
  readonly nebulaClass: NebulaClass | undefined;
  readonly imageShown: boolean;
  readonly facing: number;
  readonly fromBehind: boolean;
}

/** The honesty note shown with the object. Never contradicts the data file's own representation text. */
export function nebulaNote(i: NebulaNoteInput): string {
  if (!i.asset || !i.imageShown) {
    return i.asset ? 'marker/glow only at this scale (catalogued position and distance; no nebular brightness is available, so the marker brightness is a fixed choice)' : 'no image in the atlas: marker only';
  }
  const parts: string[] = [ILLUSTRATIVE_LABEL];
  const p = i.placement;
  if (p?.subRegion) {
    const bits = [`${p.fovMaxArcmin.toFixed(p.fovMaxArcmin < 10 ? 1 : 0)}′ field`];
    if (p.separationArcmin > 0.5 * p.fovMaxArcmin) bits.push(`${(p.separationArcmin / 60).toFixed(2)}° from the catalogue position`);
    if (p.coverage !== undefined && p.coverage < NEBULA_VISUAL.subRegionCoverage) bits.push(`${Math.round(p.coverage * 100)}% of the catalogue extent`);
    parts.push(`sub-region image of this object (${bits.join(', ')}): ${i.asset.title}`);
  }
  if (i.asset.band.falseColour) parts.push('colours assigned by the image makers (false colour), not the visible appearance');
  if (i.nebulaClass === 'planetary' || i.nebulaClass === 'supernova-remnant') parts.push('an expanding shell shown as flat layers: no shell shape is implied');
  if (i.facing < NEBULA_VISUAL.edgeOnNoteFacing) parts.push(EDGE_ON_NOTE);
  if (i.fromBehind) parts.push('viewed from behind the image plane (mirror image)');
  return parts.join(' · ');
}

/** Black level (linear) and gain from the thumbnail statistics; never darkens (gain >= 1). A display choice that does not touch the data. */
export function nebulaStretch(stats: ImageStats | null): { black: number; gain: number } {
  const V = NEBULA_VISUAL;
  if (!stats || !(stats.p99 > 1e-4)) return { black: 0, gain: 1.4 };
  const black = Math.min(V.blackFromMedian * stats.median, 0.9 * stats.p99);
  const gain = Math.min(V.exposureMax, Math.max(V.exposureMin, V.targetP99 / Math.max(stats.p99 - black, 0.02)));
  return { black, gain };
}
