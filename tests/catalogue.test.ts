import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { GaiaCatalogue } from '../src/data/catalogue/catalogue';
import { inspectObject, formatMeasurement } from '../src/data/catalogue/inspect';
import { createStellarFrames, NEIGHBOURHOOD_FRAME, MILKY_WAY_FRAME } from '../src/data/catalogue/frames';
import { buildGaiaDataset } from '../src/data/ingestion/build';
import { parseSimbadBatch } from '../src/data/ingestion/simbad';
import { mergeSimbad } from '../src/data/ingestion/crossid';
import { buildSimbadFile } from '../src/data/ingestion/build';
import { validateDataset } from '../src/data/validate';
import type { Dataset } from '../src/data/schema';
import type { GaiaDatasetFile, SimbadCrossIdFile } from '../src/data/catalogue/types';
import { equatorialToGalactic, galacticToEquatorial, sphericalToCartesian } from '../src/core/astro/coordinates';
import { METRES_PER_PARSEC } from '../src/core/units';
import { length } from '../src/core/spatial/vec3';

const csv = readFileSync('tests/fixtures/gaia-sample.csv', 'utf8');
const built = buildGaiaDataset({ rawCsv: csv, retrieval: { retrievedAt: '2026-11-12T12:00:00.000Z', endpoint: 'test', adql: 'q', rawSha256: 'x', rawBytes: 1, rawRows: 10 }, builtAt: 'x' });
const cat = GaiaCatalogue.fromFile(JSON.parse(JSON.stringify(built.file)));
const ids = [...built.file.sourceId];
const sRows = parseSimbadBatch(readFileSync('tests/fixtures/simbad-batch.csv', 'utf8'));
const merge = mergeSimbad(ids, sRows);
const simbad: SimbadCrossIdFile = buildSimbadFile({
  builtAt: 'x', retrievedAt: '2026-11-12T13:00:00.000Z', service: { name: 'SIMBAD mirror', endpoint: 'e', note: 'n' }, batchQuery: 'q', requested: ids.length, merge,
  otypes: { 'SB*': { label: 'SpectroscopicBinary', description: 'Spectroscopic binary' }, 'PM*': { label: 'High_proper_motion*', description: 'High proper-motion Star' } },
});
const at = (id: string) => cat.indexOf(id);

describe('GaiaCatalogue reader', () => {
  it('rejects files that are not Atlas datasets or have a wrong version/shape', () => {
    expect(() => GaiaCatalogue.fromFile({})).toThrow(/Not an Atlas Gaia/);
    expect(() => GaiaCatalogue.fromFile({ ...built.file, formatVersion: 99 })).toThrow(/version/);
    expect(() => GaiaCatalogue.fromFile({ ...built.file, sourceId: ['1'] })).toThrow(/length mismatch|rows/);
  });
  it('returns null (never NaN or 0) for missing values and the exact value otherwise', () => {
    const alnair = at('6560604777055249536');
    expect(cat.value('parallax', alnair)).toBeNull();
    expect(cat.value('phot_g_mean_mag', alnair)).not.toBeNull();
    expect(cat.value('parallax', at('4993479684438433792'))).toBe(39.91825815729799);
  });
  it('never infers a distance when parallax is missing, and never places that star', () => {
    const alnair = at('6560604777055249536');
    expect(cat.distanceStatus(alnair)).toBe('missing');
    expect(cat.distancePc(alnair)).toBeNull();
    expect(cat.positionPc(alnair)).toBeNull();
    expect(cat.positionMetres(alnair)).toBeNull();
    expect(cat.absoluteGMag(alnair)).toBeNull();
  });
  it('places a real star at its parallax distance (Proxima Centauri ~1.30 pc, Barnard ~1.83 pc)', () => {
    expect(cat.distancePc(at('5853498713190525696'))).toBeCloseTo(1.302, 2);
    expect(cat.distancePc(at('4472832130942575872'))).toBeCloseTo(1.828, 2);
    const p = cat.positionPc(at('5853498713190525696'))!;
    expect(Math.hypot(...p)).toBeCloseTo(cat.distancePc(at('5853498713190525696'))!, 10);
  });
  it('position direction matches the catalogue RA/Dec exactly (no re-arrangement)', () => {
    const i = at('5853498713190525696');
    const p = cat.positionPc(i)!;
    const expected = sphericalToCartesian(cat.value('ra', i)!, cat.value('dec', i)!, cat.distancePc(i)!);
    for (let k = 0; k < 3; k++) expect(p[k]).toBeCloseTo(expected[k]!, 10);
  });
  it('metres and parsecs agree', () => {
    const i = at('4993479684438433792');
    expect(length(cat.positionMetres(i)!) / METRES_PER_PARSEC).toBeCloseTo(cat.distancePc(i)!, 8);
  });
  it('derives absolute magnitude from G and distance (alpha Phe ~ +0.1)', () => {
    expect(cat.absoluteGMag(at('4993479684438433792'))).toBeCloseTo(2.09 - 5 * Math.log10(25.05) + 5, 1);
  });
  it('reconstructs the original record without alteration', () => {
    const rec = cat.record(at('4993479684438433792'));
    expect(rec.values.pmra).toBe(176.2682926212513);
    expect(rec.duplicatedSource).toBe(false);
  });
});

describe('CelestialObject construction: provenance, categories, missing data', () => {
  const obj = cat.toObject(at('4993479684438433792'), simbad);
  it('attaches catalogue, release, record id, retrieval date and epoch to every measurement', () => {
    for (const [k, m] of Object.entries(obj.measurements!)) {
      expect(m.source.source, k).toBe('gaia-dr3');
      expect(m.source.release, k).toBe('DR3');
      expect(m.source.recordId, k).toBe('4993479684438433792');
      expect(m.source.retrieved, k).toBe('2026-11-12');
    }
    expect(obj.measurements!['parallax']!.epoch).toBe('J2016.0');
  });
  it('keeps catalogue units and the published uncertainty on observed values', () => {
    expect(obj.measurements!['parallax']).toMatchObject({ value: 39.91825815729799, unit: 'mas', uncertainty: 0.7283222, kind: 'observed' });
    expect(obj.measurements!['pmra']).toMatchObject({ unit: 'mas/yr', kind: 'observed' });
    expect(obj.measurements!['ra']).toMatchObject({ unit: 'deg', uncertaintyUnit: 'mas' });
  });
  it('labels distance and colour as DERIVED with their transformation history', () => {
    const d = obj.sky!.distance!;
    expect(d.kind).toBe('derived');
    expect(d.unit).toBe('pc');
    expect(d.transformations!.join(' ')).toMatch(/1000 \/ parallax/);
    expect(obj.measurements!['bp_rp']!.kind).toBe('derived');
    expect(obj.measurements!['abs_g_mag']!.transformations!.join(' ')).toMatch(/extinction NOT applied/);
  });
  it('labels a model estimate as MODELLED, never observed', () => {
    const t = cat.toObject(at('1249152584299776'), null).measurements!['teff_gspphot']!;
    expect(t.kind).toBe('modelled');
    expect(t.unit).toBe('K');
    expect(t.note).toMatch(/GSP-Phot/);
  });
  it('omits unavailable quantities and says why, instead of inventing them', () => {
    const o = cat.toObject(at('6560604777055249536'), simbad);
    expect(o.measurements!['parallax']).toBeUndefined();
    expect(o.sky!.distance).toBeUndefined();
    expect(o.unavailable!['parallax']).toMatch(/No parallax/);
    expect(o.unavailable!['distance']).toMatch(/No parallax/);
    expect(o.unavailable!['proper_motion']).toBeDefined();
  });
  it('treats a missing G magnitude as unavailable, not as 0', () => {
    const o = cat.toObject(at('268449582148460928'), null);
    expect(o.measurements!['g_mag']).toBeUndefined();
    expect(o.unavailable!['g_mag']).toMatch(/No G/);
    expect(o.qualityFlags).toContain('no-g-magnitude');
  });
  it('marks a marginal parallax distance as marginal in the record', () => {
    const o = cat.toObject(at('205499655242974464'), null);
    expect(o.qualityFlags).toContain('parallax-marginal');
    expect(o.sky!.distance!.note).toMatch(/Marginal/);
  });
  it('does not claim a Gaia source is a star without an identification', () => {
    const o = cat.toObject(at('268449582148460928'), null);
    expect(o.classification).toBe('other');
    expect(o.notes).toMatch(/not classified as a star/);
  });
  it('takes classification and names from SIMBAD while keeping Gaia astrometry', () => {
    expect(obj.name).toBe('Ankaa');
    expect(obj.classification).toBe('star');
    expect(obj.identification!.objectType).toBe('SB*');
    expect(obj.identification!.source.source).toBe('simbad');
    expect(obj.designations).toEqual(expect.arrayContaining(['Gaia DR3 4993479684438433792', 'NAME Ankaa', '* alf Phe']));
    expect(obj.measurements!['parallax']!.source.source).toBe('gaia-dr3'); // not overwritten
  });
  it('produces objects that pass the dataset validator', () => {
    const ds: Dataset = {
      id: 'x', title: 'x', source: { source: 'gaia-dr3', retrieved: '2026-11-12' }, licence: 'ESA/Gaia/DPAC',
      objects: ids.map((id) => cat.toObject(cat.indexOf(id), simbad)),
    };
    expect(validateDataset(ds)).toEqual([]);
  });
  it('places the object in the stellar-neighbourhood frame at epoch J2016.0 ICRS', () => {
    expect(obj.frame).toBe(NEIGHBOURHOOD_FRAME);
    expect(obj.referenceFrame).toBe('ICRS, J2016.0');
  });
});

describe('review fixes: honest labelling', () => {
  it('credits SIMBAD data to the host that actually served it (the mirror), not a hard-coded host', () => {
    const o = cat.toObject(at('4993479684438433792'), simbad);
    expect(o.identification!.source.url).toBe(simbad.manifest.service.endpoint);
  });
  it('labels RUWE as a catalogue-published statistic, not something Atlas derived', () => {
    const r = cat.toObject(at('4993479684438433792'), null).measurements!['ruwe']!;
    expect(r.kind).toBe('observed');
    expect(r.note).toMatch(/does not derive/);
  });
  it('says when an absolute-magnitude uncertainty omits the photometric term', () => {
    const noSnr = buildGaiaDataset({ rawCsv: csv.replace(/,194\.66753,/, ',,'), retrieval: built.file.manifest.retrieval, builtAt: 'x' });
    const c2 = GaiaCatalogue.fromFile(noSnr.file);
    const m = c2.toObject(c2.indexOf('4993479684438433792'), null).measurements!['abs_g_mag']!;
    expect(m.note).toMatch(/parallax contribution only/);
  });
  it('refuses to build a SIMBAD file whose counts do not add up', () => {
    const bad = { ...merge, matched: merge.matched + 1 };
    expect(() => buildSimbadFile({ builtAt: 'x', retrievedAt: 'x', service: { name: 's', endpoint: 'e', note: 'n' }, batchQuery: 'q', requested: ids.length, merge: bad, otypes: {} })).toThrow(/accounting error/);
  });
});

describe('inspector model', () => {
  const m = inspectObject(cat.toObject(at('4993479684438433792'), simbad));
  const field = (model: typeof m, key: string) => model.sections.flatMap((s) => s.fields).find((f) => f.key === key)!;
  it('shows designation, classification, coordinates, distance, magnitude and provenance', () => {
    expect(m.name).toBe('Ankaa');
    expect(m.classification).toMatch(/SpectroscopicBinary/);
    expect(m.classification).toMatch(/K0\.5IIIb/);
    expect(field(m, 'ra').available).toBe(true);
    expect(field(m, 'distance').value).toMatch(/^25\./);
    expect(field(m, 'g_mag').unit).toBe('mag');
    expect(m.provenance.join(' ')).toMatch(/gaia-dr3/);
    expect(m.provenance.join(' ')).toMatch(/simbad/);
    expect(m.referenceFrame).toBe('ICRS, J2016.0');
  });
  it('shows uncertainties and the category of each value', () => {
    expect(field(m, 'parallax').uncertainty).toMatch(/^±/);
    expect(field(m, 'parallax').kind).toBe('observed');
    expect(field(m, 'distance').kind).toBe('derived');
    expect(field(m, 'ra').uncertainty).toMatch(/mas$/);
  });
  it('shows missing quantities as Unavailable with a reason (not blank, not zero)', () => {
    const miss = inspectObject(cat.toObject(at('6560604777055249536'), simbad));
    const plx = field(miss, 'parallax');
    expect(plx.available).toBe(false);
    expect(plx.value).toBe('Unavailable');
    expect(plx.reason).toMatch(/No parallax/);
    expect(field(miss, 'distance').available).toBe(false);
    expect(field(miss, 'pmra').reason).toMatch(/proper motion/i);
    expect(miss.flags.map((f) => f.flag)).toContain('no-parallax');
  });
  it('shows a genuine zero as 0 and not as unavailable', () => {
    const zero = buildGaiaDataset({ rawCsv: csv.replace('-398.87213472266046', '0'), retrieval: built.file.manifest.retrieval, builtAt: 'x' });
    const c2 = GaiaCatalogue.fromFile(zero.file);
    const f = field(inspectObject(c2.toObject(c2.indexOf('4993479684438433792'), null)), 'pmdec');
    expect(f.available).toBe(true);
    expect(f.value).toMatch(/^0\.0+/);
  });
  it('rounds to the precision the uncertainty justifies', () => {
    expect(formatMeasurement({ value: 39.91825815729799, unit: 'mas', uncertainty: 0.7283222, kind: 'observed', source: { source: 's', retrieved: 'r' } })).toEqual({ value: '39.92', uncertainty: '±0.73 mas' }); // uncertainty to 2 s.f., value to the same decimal place
  });
  it('lists quality flags with plain-language explanations', () => {
    const f = inspectObject(cat.toObject(at('268449582148460928'), null)).flags;
    expect(f.find((x) => x.flag === 'no-g-magnitude')!.description).toMatch(/does not draw it/);
  });
});

describe('frames', () => {
  const tree = createStellarFrames();
  it('places the Sun 8.178 kpc from the Galactic centre', () => {
    const sunInGalaxy = tree.convert({ frame: NEIGHBOURHOOD_FRAME, offset: [0, 0, 0] }, MILKY_WAY_FRAME);
    expect(length(sunInGalaxy) / METRES_PER_PARSEC).toBeCloseTo(8178, 3);
  });
  it('a star 100 pc toward the Galactic centre is 8078 pc from it, and one away is 8278 pc', () => {
    const gc = galacticToEquatorial(0, 0);
    const toward = sphericalToCartesian(gc.raDeg, gc.decDeg, 100 * METRES_PER_PARSEC);
    const away = sphericalToCartesian(gc.raDeg, gc.decDeg, -100 * METRES_PER_PARSEC);
    const a = tree.convert({ frame: NEIGHBOURHOOD_FRAME, offset: toward }, MILKY_WAY_FRAME);
    const b = tree.convert({ frame: NEIGHBOURHOOD_FRAME, offset: away }, MILKY_WAY_FRAME);
    expect(length(a) / METRES_PER_PARSEC).toBeCloseTo(8078, 2);
    expect(length(b) / METRES_PER_PARSEC).toBeCloseTo(8278, 2);
  });
  it('a star in the direction l=90 is displaced perpendicular to the Sun-centre line', () => {
    const e = galacticToEquatorial(90, 0);
    const p = sphericalToCartesian(e.raDeg, e.decDeg, 100 * METRES_PER_PARSEC);
    const inGalaxy = tree.convert({ frame: NEIGHBOURHOOD_FRAME, offset: p }, MILKY_WAY_FRAME);
    expect(length(inGalaxy) / METRES_PER_PARSEC).toBeCloseTo(Math.hypot(8178, 100), 2);
  });
  it('catalogue coordinates round-trip through galactic longitude and latitude', () => {
    const g = equatorialToGalactic(266.405, -28.936);
    expect(Math.abs(g.lDeg) < 0.01 || Math.abs(g.lDeg - 360) < 0.01).toBe(true);
    expect(g.bDeg).toBeCloseTo(0, 2);
  });
});

describe('the built dataset on disk', () => {
  const path = 'public/data/gaia-dr3-subset.v1.json.gz';
  const run = existsSync(path);
  (run ? it : it.skip)('loads, matches its manifest, and every distance class is accounted for', () => {
    const file = JSON.parse(gunzipSync(readFileSync(path)).toString()) as GaiaDatasetFile;
    const c = GaiaCatalogue.fromFile(file);
    expect(c.count).toBe(file.manifest.counts.imported);
    expect(c.count).toBeGreaterThan(30000);
    expect(file.manifest.counts.queryRows).toBe(file.manifest.counts.imported + file.manifest.counts.rejected);
    let withDistance = 0, missing = 0;
    for (let i = 0; i < c.count; i++) { if (c.distancePc(i) !== null) withDistance++; if (c.distanceStatus(i) === 'missing') missing++; }
    expect(withDistance).toBeGreaterThan(30000);
    expect(missing).toBeGreaterThan(0); // real missing-parallax sources exist and are preserved
  });
  (run ? it : it.skip)('agrees with independent literature distances for well-known stars', () => {
    const file = JSON.parse(gunzipSync(readFileSync(path)).toString()) as GaiaDatasetFile;
    const c = GaiaCatalogue.fromFile(file);
    const known: [string, number][] = [['5853498713190525696', 1.30], ['4472832130942575872', 1.83]]; // Proxima, Barnard's Star
    for (const [id, pc] of known) expect(Math.abs(c.distancePc(c.indexOf(id))! - pc) / pc).toBeLessThan(0.01);
  });
});

describe('review fixes: very large uncertainties use scientific notation like the value', () => {
  it('formats a 1e18 kg uncertainty readably (Europa’s derived mass)', () => {
    const f = formatMeasurement({ value: 4.7986e22, unit: 'kg', uncertainty: 1.0814749e18, kind: 'derived', source: { source: 's', retrieved: 'r' } });
    expect(f.value).toBe('4.7986e+22');
    expect(f.uncertainty).toBe('±1.08e+18 kg');
  });
  it('keeps ordinary uncertainties in plain decimals', () => {
    expect(formatMeasurement({ value: 6371.01, unit: 'km', uncertainty: 0.02, kind: 'observed', source: { source: 's', retrieved: 'r' } })).toEqual({ value: '6371.010', uncertainty: '±0.020 km' }); // two significant figures of the uncertainty
  });
});
