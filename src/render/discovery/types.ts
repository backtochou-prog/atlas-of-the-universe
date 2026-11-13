/**
 * Contract for discovery-engine renderers (Prompt 07).
 *  - StarPassLayer: drawn in the Gaia star pass (parsec units, same camera, same magnitude-limit/brightness machinery).
 *    Used for the Hipparcos bright-star supplement. Viewer.addStarPassLayer(layer) (viewer.ts) calls update() each frame.
 *  - Markers/selection proxies are DeepSubRenderers (src/render/deep-space/types.ts) registered through extraRenderers.ts.
 * Coordinates: Sun-centred ICRS parsecs in float64 on the CPU, made camera-relative BEFORE narrowing to float32.
 */
import type * as THREE from 'three';
import type { Vec3 } from '../../core/spatial/vec3';

export interface StarPassLayer {
  readonly name: string;
  readonly object: THREE.Object3D;
  /** Called every frame with the camera position (Sun-centred ICRS pc). */
  update(camPc: Vec3): void;
  setMagLimit?(limit: number): void;
  setPixelRatio?(ratio: number): void;
  /** Distance-based fade in [0,1], same meaning as the Gaia layer's uFade. */
  setFade?(fade: number): void;
  /** Screen-space pick: the id of the star under/near (x,y) CSS px (within a few px, brightness-aware), or null. */
  pick?(x: number, y: number, ctx: { readonly basis: import('../orbitCamera').Basis; readonly viewport: { readonly width: number; readonly height: number }; readonly camPc: Vec3 }): string | null;
  stats(): { readonly points: number };
  dispose(): void;
}
