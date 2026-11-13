import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { GaiaCatalogue } from '../src/data/catalogue/catalogue';
import { searchCatalogue } from '../src/data/catalogue/search';
import { buildGaiaDataset, buildSimbadFile } from '../src/data/ingestion/build';
import { mergeSimbad } from '../src/data/ingestion/crossid';
import { parseSimbadBatch } from '../src/data/ingestion/simbad';
import type { GaiaDatasetFile, SimbadCrossIdFile } from '../src/data/catalogue/types';
import { equatorialToGalactic } from '../src/core/astro/coordinates';

const csv = readFileSync('tests/fixtures/gaia-sample.csv', 'utf8');
const built = buildGaiaDataset({ rawCsv: csv, retrieval: { retrievedAt: '2026-11-12T12:00:00.000Z', endpoint: 't', adql: 'q', rawSha256: 'x', rawBytes: 1, rawRows: 10 }, builtAt: 'x' });
const cat = GaiaCatalogue.fromFile(built.file);
const merge = mergeSimbad([...built.file.sourceId], parseSimbadBatch(readFileSync('tests/fixtures/simbad-batch.csv', 'utf8')));
const simbad: SimbadCrossIdFile = buildSimbadFile({ builtAt: 'x', retrievedAt: '2026-11-12T13:00:00.000Z', service: { name: 's', endpoint: 'e', note: 'n' }, batchQuery: 'q', requested: 10, merge, otypes: {} });

describe('catalogue search', () => {
  it('finds a record by SIMBAD proper name', () => {
    const h = searchCatalogue(cat, simbad, 'ankaa');
    expect(h[0]!.label).toBe('Ankaa');
    expect(cat.sourceId(h[0]!.index)).toBe('4993479684438433792');
  });
  it('finds by Hipparcos number (exact) and by full Gaia source id', () => {
    expect(cat.sourceId(searchCatalogue(cat, simbad, 'HIP 87937')[0]!.index)).toBe('4472832130942575872');
    expect(cat.sourceId(searchCatalogue(cat, simbad, '5853498713190525696')[0]!.index)).toBe('5853498713190525696');
  });
  it('finds records that cannot be drawn (no parallax), so they can still be inspected', () => {
    const h = searchCatalogue(cat, simbad, 'Alnair');
    expect(h.length).toBeGreaterThan(0);
    expect(cat.distancePc(h[0]!.index)).toBeNull();
  });
  it('ignores case and padded whitespace', () => {
    expect(searchCatalogue(cat, simbad, '  HIP   87937 ')).toHaveLength(1);
  });
  it('ranks exact matches above substring matches', () => {
    const h = searchCatalogue(cat, simbad, 'hip 2081'); // exact for alpha Phe
    expect(h[0]!.score).toBe(0);
  });
  it('returns nothing for too-short or unknown queries, and still works without SIMBAD loaded', () => {
    expect(searchCatalogue(cat, simbad, 'a')).toEqual([]);
    expect(searchCatalogue(cat, simbad, 'zzzzzz')).toEqual([]);
    expect(searchCatalogue(cat, null, '5853498713190525696')).toHaveLength(1);
  });
  it('respects the result limit', () => {
    expect(searchCatalogue(cat, simbad, 'gaia dr3', 3).length).toBeLessThanOrEqual(3);
  });
});

describe('physical sanity of the coordinate transform on the real dataset', () => {
  const path = 'public/data/gaia-dr3-subset.v1.json.gz';
  const run = existsSync(path);
  const load = () => GaiaCatalogue.fromFile(JSON.parse(gunzipSync(readFileSync(path)).toString()) as GaiaDatasetFile);
  const inPlane = (c: GaiaCatalogue, i: number) => Math.abs(equatorialToGalactic(c.value('ra', i)!, c.value('dec', i)!).bDeg) < 10;
  const ISOTROPIC = 0.1736; // sin(10 deg): the fraction of a uniform sphere within |b| < 10

  (run ? it : it.skip)('distant stars concentrate toward the Galactic plane (real Milky Way structure)', () => {
    const c = load();
    let far = 0, plane = 0;
    for (let i = 0; i < c.count; i++) { const d = c.distancePc(i); if (d !== null && d > 300) { far++; if (inPlane(c, i)) plane++; } }
    expect(far).toBeGreaterThan(500);
    expect(plane / far).toBeGreaterThan(0.3);
  });
  (run ? it : it.skip)('nearby stars brighter than G=14 are isotropic, as they must be', () => {
    const c = load();
    let n = 0, plane = 0;
    for (let i = 0; i < c.count; i++) {
      const d = c.distancePc(i), g = c.value('phot_g_mean_mag', i);
      if (d !== null && d < 40 && g !== null && g <= 14) { n++; if (inPlane(c, i)) plane++; }
    }
    expect(n).toBeGreaterThan(5000);
    expect(Math.abs(plane / n - ISOTROPIC)).toBeLessThan(0.03);
  });
  // Regression record of a real data-quality finding: faint high-parallax stars in the plane are contaminated by
  // spurious astrometric solutions in crowded fields. They are KEPT and flagged (RUWE > 1.4), never silently dropped.
  (run ? it : it.skip)('the faint nearby in-plane excess is explained by poor astrometric fits (RUWE > 1.4)', () => {
    const c = load();
    const frac = (plane: boolean) => {
      let n = 0, bad = 0;
      for (let i = 0; i < c.count; i++) {
        const d = c.distancePc(i), g = c.value('phot_g_mean_mag', i), r = c.value('ruwe', i);
        if (d === null || d < 30 || d >= 40 || g === null || g <= 14 || inPlane(c, i) !== plane) continue;
        n++; if (r !== null && r > 1.4) bad++;
      }
      return bad / n;
    };
    expect(frac(true)).toBeGreaterThan(2 * frac(false));
  });
});
