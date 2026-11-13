import type { DeepSubRenderer } from './types';
import type { ExtraRendererDeps } from './extraRenderers';
import { CosmicStructureRenderer } from './CosmicStructureRenderer';
import { GalaxyClusterRenderer } from './GalaxyClusterRenderer';
import { createBrowserPointStore } from './pointCatalogues';
import { StarClusterRenderer } from './StarClusterRenderer';

/**
 * Star clusters (real Gaia members), the Local Group / M81 group / Virgo region (catalogue rows) and the 2MRS large-scale galaxy
 * distribution. The three renderers share ONE point-catalogue store: nothing is fetched until the camera is in a catalogue's range,
 * and a catalogue that has not been wanted for a while is dropped from memory.
 */
export function createClusterAndStructureRenderers(d: ExtraRendererDeps): readonly DeepSubRenderer[] {
  const store = createBrowserPointStore(d.baseUrl);
  const clusters = new StarClusterRenderer(d.data, store);
  const groups = new GalaxyClusterRenderer(d.data, store);
  const cosmic = new CosmicStructureRenderer(d.data, store);
  // Every renderer closes the frame for the store (idempotent, and time based, so the order and a hidden layer do not matter).
  for (const r of [clusters, groups, cosmic]) {
    const u = r.update.bind(r);
    r.update = (ctx) => { const out = u(ctx); store.endFrame(ctx.nowSeconds); return out; };
  }
  const origDispose = cosmic.dispose.bind(cosmic);
  cosmic.dispose = () => { origDispose(); store.dispose(); };
  return [clusters, groups, cosmic];
}
