/** Loaders for the real datasets under public/data (tests skip, with a visible reason, when a file is absent). */
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { GaiaCatalogue } from '../../../src/data/catalogue/catalogue';
import type { SimbadCrossIdFile } from '../../../src/data/catalogue/types';
import { DeepSpaceData } from '../../../src/data/deepspace/deepSpaceData';
import type { DeepSpaceFile, PointCatalogueFile } from '../../../src/data/deepspace/types';
import { SolarSystemData } from '../../../src/data/solar/solarCatalogue';

export const DATA = 'public/data';
export const have = (f: string): boolean => existsSync(`${DATA}/${f}`);
export const readJson = <T>(f: string): T => JSON.parse(readFileSync(`${DATA}/${f}`, 'utf8')) as T;
export const readGz = <T>(f: string): T => JSON.parse(gunzipSync(readFileSync(`${DATA}/${f}`)).toString('utf8')) as T;

let gaia: { cat: GaiaCatalogue; simbad: SimbadCrossIdFile } | undefined;
export function loadGaia(): { cat: GaiaCatalogue; simbad: SimbadCrossIdFile } {
  gaia ??= { cat: GaiaCatalogue.fromFile(readGz('gaia-dr3-subset.v1.json.gz')), simbad: readGz<SimbadCrossIdFile>('simbad-crossid.v1.json.gz') };
  return gaia;
}
export const loadSolar = (): SolarSystemData => SolarSystemData.fromFile(readJson('solar-system.v1.json'));
export const loadDeep = (): DeepSpaceData => DeepSpaceData.fromFile(readJson<DeepSpaceFile>('deep-space.v1.json'), [], { validate: false });
export const loadPoints = (id: string): PointCatalogueFile => readGz<PointCatalogueFile>(`deepspace/${id}.v1.json.gz`);
