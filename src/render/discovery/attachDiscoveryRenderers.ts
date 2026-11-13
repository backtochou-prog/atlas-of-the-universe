/**
 * Wires the real discovery renderers into a Viewer (Prompt 07, F1). Page-side only: the engine in the Worker loads the same files for search and records;
 * the browser HTTP cache serves these requests from that fetch when both ask for the same URL (they do: DATASET_PATHS), so the files travel once.
 *
 *   Hipparcos bright-star supplement  -> viewer.addStarPassLayer(new BrightStarLayer(file, isDrawnByGaia))   (stars Gaia cannot show: Sirius, Betelgeuse, Vega ...)
 *   NASA Exoplanet Archive hosts      -> viewer.attachDiscoveryMarkers({ hosts })   layer OFF until viewer.setExoplanetHostsVisible(true)
 *   curated other objects             -> viewer.attachDiscoveryMarkers({ others })
 * Every dataset is independent: one that fails to load is reported in `failed` and the others still attach.
 */
import { loadJson } from '../../data/catalogue/load';
import { DATASET_PATHS } from '../../discovery/loader';
import type { BrightStarFile, ExoplanetFile, OtherObjectsFile } from '../../discovery/types';
import type { StarLayer } from '../starLayer';
import type { Viewer } from '../viewer';
import { BrightStarLayer } from './BrightStarLayer';
import { drawnGaiaIdSet } from './brightStarSet';

export interface DiscoveryRenderersReport {
  readonly bright: BrightStarLayer | null;
  readonly markers: boolean;
  readonly hostsLoaded: boolean;
  readonly othersLoaded: boolean;
  readonly failed: readonly { readonly dataset: string; readonly error: string }[];
}

export async function attachDiscoveryRenderers(viewer: Viewer, cat: { sourceId(i: number): string }, layer: Pick<StarLayer, 'count' | 'catalogueIndex'>, base: string): Promise<DiscoveryRenderersReport> {
  const failed: { dataset: string; error: string }[] = [];
  const get = async <T>(key: 'bright-stars' | 'exoplanets' | 'other-objects'): Promise<T | null> => {
    try { return await loadJson<T>(`${base}${DATASET_PATHS[key]}`); }
    catch (e) { failed.push({ dataset: key, error: e instanceof Error ? e.message : String(e) }); return null; }
  };
  const [bright, exo, others] = await Promise.all([get<BrightStarFile>('bright-stars'), get<ExoplanetFile>('exoplanets'), get<OtherObjectsFile>('other-objects')]);
  let layerObj: BrightStarLayer | null = null;
  const drawn = drawnGaiaIdSet(cat, layer);
  if (bright) {
    try {
      layerObj = new BrightStarLayer(bright, (id) => drawn.has(id));
      viewer.addStarPassLayer(layerObj);
    } catch (e) { failed.push({ dataset: 'bright-stars', error: e instanceof Error ? e.message : String(e) }); layerObj = null; }
  }
  const markers = viewer.attachDiscoveryMarkers({ ...(exo ? { hosts: exo.hosts } : {}), ...(others ? { others } : {}) });
  return { bright: layerObj, markers, hostsLoaded: !!exo && markers, othersLoaded: !!others && markers, failed };
}
