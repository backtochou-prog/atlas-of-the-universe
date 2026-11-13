/**
 * Registration point for the sub-renderers added after the galaxy foundation. DeepSpaceLayer calls every factory below once.
 * Each factory lives in its own file, owned by one author, so they never edit the same lines.
 */
import type { DeepSubRenderer } from './types';
import type { DeepSpaceData } from '../../data/deepspace';
import type { DeepSpaceAssetManager } from './DeepSpaceAssetManager';
import type * as THREE from 'three';
import { createNebulaRenderers } from './NebulaRenderer';
import { createClusterAndStructureRenderers } from './StructureRenderers';
import { createDiscoveryMarkerRenderers } from './DiscoveryMarkers';

export interface ExtraRendererDeps {
  readonly data: DeepSpaceData;
  readonly assets: DeepSpaceAssetManager<THREE.Texture>;
  /** Base URL of the application (import.meta.env.BASE_URL), for lazily fetching point catalogues. */
  readonly baseUrl: string;
}
export const EXTRA_RENDERER_FACTORIES: readonly ((d: ExtraRendererDeps) => readonly DeepSubRenderer[])[] = [
  createNebulaRenderers,
  createClusterAndStructureRenderers,
  createDiscoveryMarkerRenderers,
];
