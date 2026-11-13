/** Plain-Node reader for public/data/gaia-dr3-subset.v1.json.gz (no browser code). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { ROOT } from './cache';

export interface GaiaSubset {
  n: number; sourceId: string[]; ra: (number | null)[]; dec: (number | null)[]; parallax: (number | null)[]; parallaxError: (number | null)[];
  pmra: (number | null)[]; pmdec: (number | null)[]; gMag: (number | null)[]; hipId: (number | null)[]; manifestBuiltAt: string;
}
export function loadGaiaSubset(): GaiaSubset {
  const f = JSON.parse(gunzipSync(readFileSync(join(ROOT, 'public', 'data', 'gaia-dr3-subset.v1.json.gz'))).toString('utf8')) as {
    manifest: { builtAt: string }; sourceId: string[]; columns: Record<string, (number | null)[]>;
  };
  const c = f.columns;
  return { n: f.sourceId.length, sourceId: f.sourceId, ra: c.ra!, dec: c.dec!, parallax: c.parallax!, parallaxError: c.parallax_error!, pmra: c.pmra!, pmdec: c.pmdec!, gMag: c.phot_g_mean_mag!, hipId: c.hip_id!, manifestBuiltAt: f.manifest.builtAt };
}
