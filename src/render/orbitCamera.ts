import { add, cross, normalise, scale, type Vec3 } from '../core/spatial/vec3';
import { zoomDistance } from '../core/spatial/zoom';

/**
 * Orbit camera around a focus point, in heliocentric ICRS parsecs (float64). The camera itself is always
 * rendered at the origin: star positions are made camera-relative before they reach the GPU (floating origin).
 * This milestone has one frame (the stellar neighbourhood); hierarchical multi-frame navigation is a later milestone.
 */
export interface OrbitState {
  readonly focus: Vec3;
  readonly distance: number;
  readonly yaw: number;
  readonly pitch: number;
}

/** maxDistance 6e8 pc = 600 Mpc: most of the nearby-universe layer (the 2MRS sample extends to ~741 Mpc; the few galaxies beyond 600 Mpc cannot be viewed from outside them). Zoom is logarithmic, so the feel is unchanged at every scale. */
export const ORBIT_LIMITS = { minDistance: 1e-3, maxDistance: 6e8 } as const;
export interface Limits { minDistance: number; maxDistance: number }
export const PITCH_LIMIT = 1.45;
export const FOV_DEG = 50;
export const DEFAULT_ORBIT: OrbitState = { focus: [0, 0, 0], distance: 60, yaw: 0.6, pitch: 0.35 };
const TAN_HALF_FOV = Math.tan((FOV_DEG * Math.PI) / 360);

export const clampPitch = (p: number): number => Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, p));

/** Unit vector from the focus to the camera. */
export function viewDirection(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return [cp * Math.cos(yaw), cp * Math.sin(yaw), Math.sin(pitch)];
}

export function cameraPosition(s: OrbitState): Vec3 {
  return add(s.focus, scale(viewDirection(s.yaw, s.pitch), s.distance));
}

export interface Basis { readonly right: Vec3; readonly up: Vec3; readonly forward: Vec3 }

export function cameraBasis(s: OrbitState): Basis {
  const forward = scale(viewDirection(s.yaw, s.pitch), -1);
  const right = normalise(cross(forward, [0, 0, 1]));
  const up = cross(right, forward);
  return { right, up, forward };
}

/** Exponential zoom: each unit of `delta` multiplies the distance by a fixed factor. */
export function zoom(s: OrbitState, delta: number, k = 0.0015, limits: Limits = ORBIT_LIMITS): OrbitState {
  return { ...s, distance: zoomDistance(s.distance, delta, limits, k) };
}

export function rotate(s: OrbitState, dyaw: number, dpitch: number): OrbitState {
  return { ...s, yaw: s.yaw + dyaw, pitch: clampPitch(s.pitch + dpitch) };
}

/** Metres-per-pixel analogue in parsecs: how much sky distance one screen pixel spans at the focus. */
export function parsecsPerPixel(distance: number, viewportHeightPx: number): number {
  return (2 * distance * TAN_HALF_FOV) / viewportHeightPx;
}

/** Pan scales with distance, so dragging feels the same at 1 pc and at 1 kpc. */
export function pan(s: OrbitState, dxPx: number, dyPx: number, viewportHeightPx: number): OrbitState {
  const { right, up } = cameraBasis(s);
  const ppp = parsecsPerPixel(s.distance, viewportHeightPx);
  return { ...s, focus: add(s.focus, add(scale(right, -dxPx * ppp), scale(up, dyPx * ppp))) };
}

export function resetOrientation(s: OrbitState): OrbitState {
  return { ...s, yaw: DEFAULT_ORBIT.yaw, pitch: DEFAULT_ORBIT.pitch };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const wrap = (x: number) => ((x + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;

/** Smooth interpolation between two orbit states: focus moves linearly, distance geometrically. */
export function interpolate(a: OrbitState, b: OrbitState, t: number): OrbitState {
  const u = t * t * t * (t * (t * 6 - 15) + 10);
  return {
    focus: [lerp(a.focus[0], b.focus[0], u), lerp(a.focus[1], b.focus[1], u), lerp(a.focus[2], b.focus[2], u)],
    distance: Math.exp(lerp(Math.log(a.distance), Math.log(b.distance), u)),
    yaw: a.yaw + wrap(b.yaw - a.yaw) * u,
    pitch: lerp(a.pitch, b.pitch, u),
  };
}
