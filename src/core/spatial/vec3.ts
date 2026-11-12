/** Float64 3-vectors as plain tuples. All spatial maths in Atlas is float64 on the CPU;
 *  only camera-relative results are ever narrowed to float32 for the GPU. */
export type Vec3 = readonly [number, number, number];

export const ZERO: Vec3 = [0, 0, 0];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));

/** The only sanctioned float64 -> float32 narrowing point. Input must be camera-relative. */
export const toFloat32 = (a: Vec3): Float32Array => Float32Array.of(a[0], a[1], a[2]);
