import { DEG_TO_RAD } from '../../core/astro/constants';
import { eastUnit, northUnit } from '../../core/astro/coordinates';
import { discImagePlacement, discPlaneBasis, distanceMetres, physicalSizeMetres, skyPlaneBasis, type DiscOrientationDeg } from '../../core/deepspace/geometry';
import { METRES_PER_PARSEC } from '../../core/units';
import type { DeepImageAsset, DeepSpaceObject } from '../../data/deepspace/types';
import { add, dot, scale, type Vec3 } from '../../core/spatial/vec3';

/** Pure geometry for galaxy images and glows. Every vector is float64, Sun-centred ICRS axes, PARSECS. */
const PC = METRES_PER_PARSEC;

export interface ImagePlacement {
  /** Half-width vector (quad local x = +1) and half-height vector (local y = +1), parsecs. */
  readonly xAxis: Vec3;
  readonly yAxis: Vec3;
  /** Unit normal. */
  readonly normal: Vec3;
  /** Centre of the image relative to the object's catalogue position, parsecs. */
  readonly offset: Vec3;
  readonly kind: 'deprojected-disc' | 'sky-plane';
  /** deprojected only: which side tilts toward us is a visual choice. */
  readonly tiltIsChoice: boolean;
  /** deprojected only: the inclination is within the exact-deprojection limit. */
  readonly exact: boolean;
  /** Half of the longer image side, parsecs. */
  readonly halfSizePc: number;
  /**
   * Soft vignette: maps image-normalised coordinates p in [-1,1]^2 to galaxy-ellipse coordinates q = (row0.p + c.x, row1.p + c.y)
   * where |q| = 1 on the ellipse of the galaxy's catalogue extent (semi-major R, minor R q). Shader fades the image for |q| beyond
   * ~1, so only the galaxy and a restrained halo are drawn, never the rectangular frame or the unrelated sky around it.
   */
  readonly vignette: { readonly row0: readonly [number, number]; readonly row1: readonly [number, number]; readonly c: readonly [number, number] };
}

/** Minimum minor/major ratio of the vignette ellipse (an edge-on disc must not get a razor-thin mask). */
export const MIN_VIGNETTE_RATIO = 0.3;

const wrap180 = (d: number) => ((d + 540) % 360) - 180;

/** Offset of the image centre from the object position, as a sky-plane vector in metres (east/north components, exact tangent plane). */
function skyOffsetMetres(obj: DeepSpaceObject, asset: DeepImageAsset, distM: number): Vec3 {
  const sky = obj.sky!;
  const dRa = wrap180(asset.geometry.centreRaDeg - sky.raDeg) * Math.cos(sky.decDeg * DEG_TO_RAD);
  const dDec = asset.geometry.centreDecDeg - sky.decDeg;
  const e = Math.tan(dRa * DEG_TO_RAD) * distM, n = Math.tan(dDec * DEG_TO_RAD) * distM;
  return add(scale(eastUnit(sky.raDeg), e), scale(northUnit(sky.raDeg, sky.decDeg), n));
}

export function discOrientationOf(obj: DeepSpaceObject): DiscOrientationDeg | null {
  const o = obj.orientation;
  if (!o) return null;
  return { inclinationDeg: o.inclinationDeg.value, positionAngleDeg: o.positionAngleDeg.value, nearSide: o.nearSide };
}

/**
 * Where an image plane sits in space.
 *  - 'deprojected-image' objects: the published inclination and position angle give the disc plane (core discImagePlacement);
 *    the image is stretched by 1/cos(i) along the minor axis so that, seen from the Sun, it reproduces the original picture.
 *  - everything else: a flat plane perpendicular to the line of sight to the Sun (no depth is claimed).
 */
export function placeImage(obj: DeepSpaceObject, asset: DeepImageAsset): ImagePlacement {
  const sky = obj.sky, dist = sky?.distance;
  if (!sky || !dist) throw new Error(`${obj.id} has no sky position/distance`);
  const g = asset.geometry;
  const d = distanceMetres(dist).metres;
  const off = skyOffsetMetres(obj, asset, d);
  const orient = obj.representation.kind === 'deprojected-image' ? discOrientationOf(obj) : null;
  const halfSizePc = Math.max(physicalSizeMetres(g.fovArcmin[0], d), physicalSizeMetres(g.fovArcmin[1], d)) / 2 / PC;
  const vignette = vignetteFor(obj, asset, d, off);
  if (orient) {
    const p = discImagePlacement(orient, sky.raDeg, sky.decDeg, g.upPositionAngleDeg, g.fovArcmin, dist);
    const [c0, c1, , c3] = p.corners;
    const X = scale(add(c1, scale(c0, -1)), 0.5 / PC), Y = scale(add(c3, scale(c0, -1)), 0.5 / PC);
    const b = p.basis;
    const a = dot(off, b.major), bb = dot(off, b.skyPerpendicular);
    const offset = scale(add(scale(b.major, a), scale(b.minorInPlane, bb * b.stretch)), 1 / PC);
    return { xAxis: X, yAxis: Y, normal: b.normal, offset, kind: 'deprojected-disc', tiltIsChoice: b.tiltDirectionIsAChoice, exact: b.exact, halfSizePc, vignette };
  }
  const basis = skyPlaneBasis(sky.raDeg, sky.decDeg, g.upPositionAngleDeg);
  const hw = physicalSizeMetres(g.fovArcmin[0], d) / 2 / PC, hh = physicalSizeMetres(g.fovArcmin[1], d) / 2 / PC;
  return { xAxis: scale(basis.right, hw), yAxis: scale(basis.up, hh), normal: basis.normal, offset: scale(off, 1 / PC), kind: 'sky-plane', tiltIsChoice: false, exact: true, halfSizePc, vignette };
}

/** Visual extent of the vignette in units of the catalogue radius (VISUAL: full strength inside ~1.0, gone at 1.6). */
export const VIGNETTE_RADIUS_SCALE = 1.6;

function vignetteFor(obj: DeepSpaceObject, asset: DeepImageAsset, distM: number, offMetres: Vec3): ImagePlacement['vignette'] {
  const sky = obj.sky!, g = asset.geometry;
  const E = eastUnit(sky.raDeg), N = northUnit(sky.raDeg, sky.decDeg);
  const major = obj.angularSize?.majorArcmin;
  const R = (major !== undefined ? physicalSizeMetres(major, distM) / 2 : physicalSizeMetres(Math.max(g.fovArcmin[0], g.fovArcmin[1]), distM) / 4);
  const orient = obj.representation.kind === 'deprojected-image' ? discOrientationOf(obj) : null;
  const paDeg = orient ? orient.positionAngleDeg : (obj.angularSize?.positionAngleDeg ?? 0);
  let ratio = 1;
  if (orient) ratio = Math.cos(orient.inclinationDeg * DEG_TO_RAD);
  else if (obj.angularSize?.positionAngleDeg !== undefined && obj.angularSize.minorArcmin) ratio = obj.angularSize.minorArcmin / obj.angularSize.majorArcmin;
  ratio = Math.min(1, Math.max(MIN_VIGNETTE_RATIO, ratio));
  const pa = paDeg * DEG_TO_RAD, up = g.upPositionAngleDeg * DEG_TO_RAD;
  const m = add(scale(N, Math.cos(pa)), scale(E, Math.sin(pa)));
  const n = add(scale(E, Math.cos(pa)), scale(N, -Math.sin(pa)));
  const upV = add(scale(N, Math.cos(up)), scale(E, Math.sin(up)));
  const rightV = add(scale(E, -Math.cos(up)), scale(N, Math.sin(up)));
  const hw = physicalSizeMetres(g.fovArcmin[0], distM) / 2, hh = physicalSizeMetres(g.fovArcmin[1], distM) / 2;
  const Rm = R * VIGNETTE_RADIUS_SCALE, Rn = R * ratio * VIGNETTE_RADIUS_SCALE;
  return {
    row0: [(hw * dot(rightV, m)) / Rm, (hh * dot(upV, m)) / Rm],
    row1: [(hw * dot(rightV, n)) / Rn, (hh * dot(upV, n)) / Rn],
    c: [dot(offMetres, m) / Rm, dot(offMetres, n) / Rn],
  };
}

export interface GlowAxes {
  /** Semi-axis vectors of the object's extent (D25 or catalogue diameter), parsecs. */
  readonly A: Vec3;
  readonly B: Vec3;
  readonly radiusPc: number;
}

/** The physical extent ellipse of a galaxy: a tilted disc where an orientation is published, else a sky-plane ellipse. */
export function galaxyGlowAxes(obj: DeepSpaceObject, fallbackHalfSizePc?: number): GlowAxes | null {
  const sky = obj.sky;
  if (!sky?.distance) return null;
  const d = distanceMetres(sky.distance).metres;
  const major = obj.angularSize?.majorArcmin;
  const R = major !== undefined ? physicalSizeMetres(major, d) / 2 / PC : fallbackHalfSizePc;
  if (R === undefined || !(R > 0)) return null;
  const orient = obj.representation.kind === 'deprojected-image' ? discOrientationOf(obj) : null;
  if (orient) {
    const b = discPlaneBasis(orient, sky.raDeg, sky.decDeg);
    return { A: scale(b.major, R), B: scale(b.minorInPlane, R), radiusPc: R };
  }
  const E = eastUnit(sky.raDeg), N = northUnit(sky.raDeg, sky.decDeg);
  const pa = (obj.angularSize?.positionAngleDeg ?? 0) * DEG_TO_RAD;
  const q = obj.angularSize?.positionAngleDeg !== undefined && obj.angularSize.minorArcmin ? Math.min(1, obj.angularSize.minorArcmin / obj.angularSize.majorArcmin) : 1;
  const maj = add(scale(N, Math.cos(pa)), scale(E, Math.sin(pa)));
  const min = add(scale(E, Math.cos(pa)), scale(N, -Math.sin(pa)));
  return { A: scale(maj, R), B: scale(min, R * q), radiusPc: R };
}

export interface ScreenEllipse { a: number; b: number; angle: number; x: number; y: number; depth: number }
const out0: ScreenEllipse = { a: 0, b: 0, angle: 0, x: 0, y: 0, depth: 0 };

/**
 * Screen ellipse (CSS px, y up) of the planar ellipse generated by semi-axis vectors A and B around a point at camera-relative
 * position `rel`. Exact perspective projection of the four axis end points; the ellipse is x = cos(t) sA + sin(t) sB, whose
 * semi-axes are the singular values of [sA sB]. Returns false when the centre is behind the camera.
 */
export function projectEllipse(
  rel: Vec3, A: Vec3, B: Vec3, right: Vec3, up: Vec3, forward: Vec3, pxPerRad: number, out: ScreenEllipse = out0,
): boolean {
  const zc = dot(rel, forward);
  if (!(zc > 0)) return false;
  const proj = (sx: number, sy: number, sz: number, ox: number, oy: number, oz: number): [number, number] | null => {
    const px = rel[0] + sx * ox, py = rel[1] + sy * oy, pz = rel[2] + sz * oz;
    const z = px * forward[0] + py * forward[1] + pz * forward[2];
    if (!(z > 0)) return null;
    return [(px * right[0] + py * right[1] + pz * right[2]) / z * pxPerRad, (px * up[0] + py * up[1] + pz * up[2]) / z * pxPerRad];
  };
  const ax1 = proj(1, 1, 1, A[0], A[1], A[2]), ax2 = proj(1, 1, 1, -A[0], -A[1], -A[2]);
  const bx1 = proj(1, 1, 1, B[0], B[1], B[2]), bx2 = proj(1, 1, 1, -B[0], -B[1], -B[2]);
  const cx = (rel[0] * right[0] + rel[1] * right[1] + rel[2] * right[2]) / zc * pxPerRad;
  const cy = (rel[0] * up[0] + rel[1] * up[1] + rel[2] * up[2]) / zc * pxPerRad;
  out.x = cx; out.y = cy; out.depth = zc;
  let sax: number, say: number, sbx: number, sby: number;
  if (ax1 && ax2 && bx1 && bx2) {
    sax = (ax1[0] - ax2[0]) / 2; say = (ax1[1] - ax2[1]) / 2; sbx = (bx1[0] - bx2[0]) / 2; sby = (bx1[1] - bx2[1]) / 2;
  } else {
    // Part of the ellipse is behind the camera: first-order projection at the centre (the object is huge on screen anyway).
    const f = (v: Vec3): [number, number] => [(dot(v, right) - cx / pxPerRad * dot(v, forward)) / zc * pxPerRad, (dot(v, up) - cy / pxPerRad * dot(v, forward)) / zc * pxPerRad];
    [sax, say] = f(A); [sbx, sby] = f(B);
  }
  // 2x2 SVD of [sA sB] via the symmetric matrix M = sA sA^T + sB sB^T.
  const m00 = sax * sax + sbx * sbx, m01 = sax * say + sbx * sby, m11 = say * say + sby * sby;
  const tr = m00 + m11, det = m00 * m11 - m01 * m01;
  const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const l1 = tr / 2 + disc, l2 = Math.max(0, tr / 2 - disc);
  out.a = Math.sqrt(l1); out.b = Math.sqrt(l2);
  out.angle = 0.5 * Math.atan2(2 * m01, m00 - m11);
  return true;
}
