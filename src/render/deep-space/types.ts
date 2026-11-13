/**
 * Contract between the deep-space layer (src/render/deep-space/DeepSpaceLayer.ts), its per-kind sub-renderers and the viewer.
 * Sub-renderers own only drawing: they read DeepSpaceData / point catalogues / image assets and never alter them.
 *
 * COORDINATES. Everything is Sun-centred ICRS parsecs in float64 on the CPU. The camera sits at the origin of the deep-space
 * scene; each object's `position` is (objectPc - cameraPc) narrowed to float32 AFTER the subtraction (floating origin).
 * Never put absolute parsec coordinates into a Float32Array that reaches the GPU.
 */
import type * as THREE from 'three';
import type { Vec3 } from '../../core/spatial/vec3';
import type { Basis } from '../orbitCamera';

export interface DeepRenderContext {
  /** Perspective camera at the origin looking along `basis.forward`; near/far are set by the layer for the current scale (parsecs). */
  readonly camera: THREE.PerspectiveCamera;
  /** Camera position, Sun-centred ICRS, parsecs, float64. */
  readonly camPc: Vec3;
  readonly basis: Basis;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly pixelRatio: number;
  /** Distance from the camera to the orbit focus, parsecs. */
  readonly focusDistancePc: number;
  /** Pixels per radian at the screen centre: height / (2 tan(fov/2)). Angular size (rad) * this = pixels. */
  readonly pixelsPerRadian: number;
  readonly nowSeconds: number;
  readonly selectedId: string | null;
  /** Quality scale in (0, 1]: sub-renderers scale point counts / layer counts / texture level by it. 1 = full. */
  readonly quality: number;
  /**
   * Optional (added by R2a). 0 while the camera is in the solar neighbourhood (< ~120 pc from the Sun), 1 beyond ~1.2 kpc,
   * log-smooth between. Extragalactic sub-renderers multiply their opacity by it: close to the Sun the real Gaia stars are the
   * truth and distant galaxies are not drawn. Sub-renderers of things INSIDE the neighbourhood (nebulae, nearby clusters) ignore it.
   */
  readonly farFade?: number;
}

/** Where an object is on screen this frame (used for picking, labels and the selection ring). */
export interface DeepScreenInfo {
  readonly id: string;
  readonly kind: 'galaxy' | 'nebula' | 'star-cluster' | 'galaxy-group' | 'galaxy-cluster' | 'cosmic-structure' | 'catalogue-point'
    // discovery markers (DiscoveryMarkers.ts): exoplanet host halo, curated other object (Sgr A* ...), selection proxy ring
    | 'exoplanet-host' | 'other-object' | 'selection-proxy';
  readonly x: number;
  readonly y: number;
  /** Apparent radius in CSS pixels (>= a few px for picking even when the object is tiny). */
  readonly pixelRadius: number;
  readonly distancePc: number;
  readonly visible: boolean;
  /** False = drawn (or on screen) but too faint to click (draw weight below MIN_PICKABLE_DRAW_WEIGHT); absent = same as `visible`. */
  readonly pickable?: boolean;
  /** Which representation level is drawn now: 'marker' | 'glow' | 'image-L0..' | 'members' ... (shown in the HUD and used by QA). */
  readonly lod: string;
  readonly label?: string;
  /** Optional honesty note shown next to the object (e.g. 'projected image, no depth', 'illustrative tilt direction'). */
  readonly representationNote?: string;
}

/** Which user-facing layer toggle a sub-renderer belongs to (DeepSpaceLayer.setLayerVisibility). */
export type DeepLayerKind = 'galaxies' | 'nebulae' | 'clusters' | 'structure' | 'discovery';

export interface DeepRendererStats {
  readonly drawCalls: number;
  readonly textureBytes: number;
  readonly pointsDrawn: number;
  readonly objectsVisible: number;
}

/** One row of a point catalogue (a galaxy in UNGC/McConnachie/2MRS, a cluster member star), for the inspector. */
export interface PointRowInfo {
  /** The DeepScreenInfo id this row was drawn under: "<fileId>:<rowIndex>" ("virgo:<rowIndex>" for the Virgo member rows, whose fileId is twomrs). */
  readonly id: string;
  readonly fileId: string;
  readonly row: number;
  /** Column name -> value, exactly as stored (null = not available). */
  readonly values: Readonly<Record<string, number | string | null>>;
  readonly manifest: import('../../data/deepspace/types').PointCatalogueManifest;
  /** Set when the row is drawn somewhere other than its catalogue distance implies: 'cluster-mean' = at the mean distance of its cluster (Virgo), not at cz/H0. */
  readonly placement?: 'cluster-mean';
}

export interface DeepSubRenderer {
  readonly name: string;
  readonly group: THREE.Group;
  /** Optional (added by R2a): which layer toggle controls this renderer. Default 'galaxies'. */
  readonly layerKind?: DeepLayerKind;
  /** Optional: a comfortable camera distance (parsecs) for an object this renderer manages; undefined if it does not manage it. */
  viewDistancePc?(id: string): number | undefined;
  /**
   * Optional: a position (Sun-centred ICRS parsecs) for an object this renderer manages that has no catalogue position of its own.
   * It is a VIEW ANCHOR, not a barycentre (Local Group: midway between the Milky Way and M31, illustrative; 2MRS: the Sun, the centre of the survey volume).
   */
  positionPc?(id: string): Vec3 | undefined;
  /** Optional: switch the image band of an object this renderer manages; returns true if handled. */
  setBand?(objectId: string, assetId: string): boolean;
  /** Optional: the asset currently drawn for an object this renderer manages. */
  activeAsset?(objectId: string): string | undefined;
  /** Optional: catalogue row behind a 'catalogue-point' screen id this renderer drew (undefined if not its id). */
  pointRow?(id: string): PointRowInfo | undefined;
  /** Optional: called when the layer quality changes (0.25..1). */
  setQuality?(q: number): void;
  /** Position/LOD/visibility for this frame; request assets; return screen info for every object it manages. */
  update(ctx: DeepRenderContext): readonly DeepScreenInfo[];
  stats(): DeepRendererStats;
  dispose(): void;
}
