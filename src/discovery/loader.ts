/**
 * Data sources of the discovery engine (Prompt 07, R2a). Every dataset the atlas can hold is named here; the engine asks a DataSource for them
 * one by one, so a test supplies fakes (including ones that fail) and the browser supplies HttpDataSource.
 *
 * Stages (see workerEngine.ts): 0 = gaia, simbad, solar, deep (searchable first); 1 = bright-stars, exoplanets, other-objects, relations (+ notes on the page thread);
 * 2 = ungc, mcconnachie, twomrs (point catalogues, lowest priority).
 */
import type { GaiaDatasetFile, SimbadCrossIdFile } from '../data/catalogue/types';
import { loadJson } from '../data/catalogue/load';
import type { DeepSpaceFile, PointCatalogueFile } from '../data/deepspace/types';
import type { BrightStarFile, DiscoveryNotesFile, ExoplanetFile, OtherObjectsFile, RelationsFile } from './types';

export type DatasetKey = 'gaia' | 'simbad' | 'solar' | 'deep' | 'bright-stars' | 'exoplanets' | 'other-objects' | 'relations' | 'notes' | 'ungc' | 'mcconnachie' | 'twomrs';

export interface DatasetPayloads {
  readonly gaia: GaiaDatasetFile;
  readonly simbad: SimbadCrossIdFile;
  /** solar-system.v1.json, parsed with SolarSystemData.fromFile (the engine needs only the records, so no texture provenance). */
  readonly solar: unknown;
  readonly deep: DeepSpaceFile;
  readonly 'bright-stars': BrightStarFile;
  readonly exoplanets: ExoplanetFile;
  readonly 'other-objects': OtherObjectsFile;
  readonly relations: RelationsFile;
  readonly notes: DiscoveryNotesFile;
  readonly ungc: PointCatalogueFile;
  readonly mcconnachie: PointCatalogueFile;
  readonly twomrs: PointCatalogueFile;
}

export interface DataSource {
  load<K extends DatasetKey>(key: K): Promise<DatasetPayloads[K]>;
}

/** Path of each dataset below the application base URL. */
export const DATASET_PATHS: Readonly<Record<DatasetKey, string>> = {
  gaia: 'data/gaia-dr3-subset.v1.json.gz',
  simbad: 'data/simbad-crossid.v1.json.gz',
  solar: 'data/solar-system.v1.json',
  deep: 'data/deep-space.v1.json',
  'bright-stars': 'data/bright-stars.v1.json.gz',
  exoplanets: 'data/exoplanets.v1.json.gz',
  'other-objects': 'data/other-objects.v1.json',
  relations: 'data/relations.v1.json',
  notes: 'data/discovery-notes.v1.json',
  ungc: 'data/deepspace/ungc.v1.json.gz',
  mcconnachie: 'data/deepspace/local-group-mcconnachie.v1.json.gz',
  twomrs: 'data/deepspace/twomrs.v1.json.gz',
};

export const DATASET_LABEL: Readonly<Record<DatasetKey, string>> = {
  gaia: 'Gaia DR3 subset', simbad: 'SIMBAD identifiers', solar: 'Solar System', deep: 'Deep-space objects', 'bright-stars': 'Hipparcos bright stars',
  exoplanets: 'NASA Exoplanet Archive', 'other-objects': 'Other objects', relations: 'Curated relations', notes: 'Explanations',
  ungc: 'Updated Nearby Galaxy Catalog', mcconnachie: 'McConnachie Local Group catalogue', twomrs: '2MASS Redshift Survey',
};

export const DATASET_STAGE: Readonly<Record<DatasetKey, 0 | 1 | 2>> = {
  gaia: 0, simbad: 0, solar: 0, deep: 0, 'bright-stars': 1, exoplanets: 1, 'other-objects': 1, relations: 1, notes: 1, ungc: 2, mcconnachie: 2, twomrs: 2,
};

/** Fetches the files from `<base>data/...` (works in a page and in a Worker; gunzips with DecompressionStream). */
export class HttpDataSource implements DataSource {
  constructor(private readonly base: string) {}
  load<K extends DatasetKey>(key: K): Promise<DatasetPayloads[K]> {
    return loadJson<DatasetPayloads[K]>(`${this.base}${DATASET_PATHS[key]}`);
  }
}
