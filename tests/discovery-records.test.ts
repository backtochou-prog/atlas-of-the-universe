import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GaiaCatalogue } from '../src/data/catalogue/catalogue';
import { buildGaiaDataset, buildSimbadFile } from '../src/data/ingestion/build';
import { mergeSimbad } from '../src/data/ingestion/crossid';
import { parseSimbadBatch } from '../src/data/ingestion/simbad';
import { parallaxToDistance } from '../src/core/astro/parallax';
import type { PointCatalogueFile } from '../src/data/deepspace/types';
import { APPLICATION_H0_KM_S_MPC as RENDER_H0, MIN_CZ_FOR_HUBBLE_KMS as RENDER_MIN_CZ, UNGC_NOT_INDEPENDENT as RENDER_NOT_INDEPENDENT, hubbleDistancePc } from '../src/render/deep-space/clusterGeometry';
import {
  APPLICATION_H0_KM_S_MPC, MIN_CZ_FOR_HUBBLE_KMS, UNGC_NOT_INDEPENDENT, hasSkyDirection, mergeRecords, recordsFromBrightStars, recordsFromDeep, recordsFromExoplanets, recordsFromGaia, recordsFromOther,
  recordsFromPoints, recordsFromSolar,
} from '../src/discovery/records';
import { RecordStore } from '../src/discovery/recordStore';
import { SearchIndex } from '../src/discovery/searchIndex';
import type { BrightStarFile, DiscoveryRecord, ExoplanetFile, OtherObjectsFile } from '../src/discovery/types';
import { have, loadDeep, loadGaia, loadPoints, loadSolar, readGz, readJson } from './fixtures/discovery/real';
import { rec } from './fixtures/discovery/synthetic';

const OBJECT_CATEGORIES = ['star', 'planet', 'moon', 'exoplanet', 'exoplanet-host', 'galaxy', 'nebula', 'star-cluster', 'galaxy-group', 'galaxy-cluster', 'supernova-remnant', 'other'];

/** Properties every record from every adapter must have. Problems are collected and asserted once, so a 40,000-record check stays fast. */
function checkRecords(recs: readonly DiscoveryRecord[], label: string): void {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const r of recs) {
    const bad = (msg: string): void => { if (problems.length < 20) problems.push(`${label} ${r.id}: ${msg}`); };
    if (seen.has(r.id)) bad('duplicate id');
    seen.add(r.id);
    if (!/^[a-z]+:.+/.test(r.id)) bad('id shape');
    if (!OBJECT_CATEGORIES.includes(r.category)) bad(`category ${r.category}`);
    if (r.name.length === 0) bad('empty name');
    if (r.designations.length === 0) bad('no designation');
    if (new Set(r.designations).size !== r.designations.length) bad('repeated designation');
    if (r.designations.some((d) => typeof d !== 'string' || d.trim().length === 0)) bad('empty designation');
    if (r.sourceKey.length === 0) bad('no sourceKey');
    for (const [k, m] of Object.entries(r.measurements)) {
      if (!Number.isFinite(m!.value)) bad(`${k} not finite`);
      if (!['observed', 'derived', 'modelled'].includes(m!.kind)) bad(`${k} kind`);
      if (m!.uncertainty !== undefined && !(Number.isFinite(m!.uncertainty) && m!.uncertainty >= 0)) bad(`${k} uncertainty`);
    }
    const p = r.position;
    if (p.kind === 'icrs') {
      if (!p.xyzPc.every(Number.isFinite)) bad('xyz not finite');
      if (!(Math.hypot(...p.xyzPc) > 0)) bad('xyz at the origin');
    }
    if (p.kind === 'sky-only') {
      if (hasSkyDirection(p) && !(p.raDeg >= 0 && p.raDeg < 360 && Math.abs(p.decDeg) <= 90)) bad('ra/dec out of range');
      if (r.drawn) bad('a sky-only record cannot be drawn in 3D');
    }
  }
  expect(problems).toEqual([]);
}

describe('constants shared with the structure renderer', () => {
  it('equal the renderer\'s definitions (they are duplicated to keep src/discovery free of render imports)', () => {
    expect(APPLICATION_H0_KM_S_MPC).toBe(RENDER_H0);
    expect(MIN_CZ_FOR_HUBBLE_KMS).toBe(RENDER_MIN_CZ);
    expect([...UNGC_NOT_INDEPENDENT].sort()).toEqual([...RENDER_NOT_INDEPENDENT].sort());
  });
});

describe('recordsFromGaia on the real-row fixture', () => {
  const csv = readFileSync('tests/fixtures/gaia-sample.csv', 'utf8');
  const built = buildGaiaDataset({ rawCsv: csv, retrieval: { retrievedAt: '2026-11-12T12:00:00.000Z', endpoint: 't', adql: 'q', rawSha256: 'x', rawBytes: 1, rawRows: 10 }, builtAt: 'x' });
  const cat = GaiaCatalogue.fromFile(built.file);
  const merge = mergeSimbad([...built.file.sourceId], parseSimbadBatch(readFileSync('tests/fixtures/simbad-batch.csv', 'utf8')));
  const simbad = buildSimbadFile({ builtAt: 'x', retrievedAt: '2026-11-12T13:00:00.000Z', service: { name: 's', endpoint: 'e', note: 'n' }, batchQuery: 'q', requested: 10, merge, otypes: { 'BY*': { label: 'BY*', description: 'Variable of BY Dra type' } } });
  const recs = recordsFromGaia(cat, simbad);
  const byId = new Map(recs.map((r) => [r.id, r]));
  it('one record per source with a position; all well-formed', () => {
    expect(recs).toHaveLength(cat.count);
    checkRecords(recs, 'gaia fixture');
  });
  it('Barnard\'s star: designations, distance by the existing parallax rule, magnitudes, proper motion, temperature', () => {
    const b = byId.get('gaia:4472832130942575872')!;
    expect(b).toMatchObject({ dataset: 'gaia-dr3', category: 'star', name: "Barnard's star", spectralType: 'M4V', drawn: true, sourceKey: 'gaia-dr3' });
    expect(b.designations).toEqual(expect.arrayContaining(['Gaia DR3 4472832130942575872', 'HIP 87937', "NAME Barnard's star", 'GJ 699', 'TIC 325554331']));
    const i = cat.indexOf('4472832130942575872');
    const d = parallaxToDistance(cat.value('parallax', i), cat.value('parallax_error', i));
    expect(b.measurements.distancePc).toEqual({ value: d.distancePc, kind: 'derived', uncertainty: d.sigmaPc });
    expect(b.measurements.distancePc!.value).toBeCloseTo(1.828, 2);
    expect(b.measurements.apparentMag).toMatchObject({ kind: 'observed' });
    expect(b.measurements.apparentMag!.value).toBe(cat.value('phot_g_mean_mag', i));
    expect(b.measurements.absoluteMag).toMatchObject({ kind: 'derived' });
    expect(b.measurements.absoluteMag!.value).toBeCloseTo(cat.absoluteGMag(i)!, 12);
    expect(b.measurements.teffK).toMatchObject({ kind: 'modelled' });
    expect(b.measurements.bpRp!.value).toBeCloseTo(cat.bpRp(i)!, 12);
    expect(b.measurements.pmTotalMasYr!.value).toBeCloseTo(Math.hypot(cat.value('pmra', i)!, cat.value('pmdec', i)!), 9);
    expect(b.classification).toBe('Variable of BY Dra type · M4V');
    expect(b.position.kind).toBe('icrs');
    if (b.position.kind === 'icrs') {
      const p = cat.positionPc(i)!;
      b.position.xyzPc.forEach((v, k) => expect(v).toBeCloseTo(p[k]!, 12));
      expect(b.position.distanceUncertaintyPc).toBe(d.sigmaPc);
    }
  });
  it('no parallax: no distance key (not zero), sky-only position, not drawn, still searchable', () => {
    const a = byId.get('gaia:6560604777055249536')!;                       // Alnair: no parallax in the catalogue
    expect(a.measurements.distancePc).toBeUndefined();
    expect(a.measurements.absoluteMag).toBeUndefined();
    expect(a.position.kind).toBe('sky-only');
    expect(a.drawn).toBe(false);
    expect(a.measurements.apparentMag).toBeDefined();
    const idx = new SearchIndex();
    idx.add(recs);
    expect(idx.search('Alnair').hits[0]!.id).toBe(a.id);
    expect(idx.search('alf gru').hits.map((h) => h.id)).toContain(a.id);
  });
  it('no G magnitude: drawn false even with a distance, and no apparent/absolute magnitude', () => {
    const noG = recs.filter((r) => r.measurements.distancePc && !r.measurements.apparentMag);
    expect(noG.length).toBeGreaterThan(0);
    for (const r of noG) { expect(r.drawn).toBe(false); expect(r.measurements.absoluteMag).toBeUndefined(); }
  });
  it('names strip the SIMBAD type prefix; an unmatched source is not called a star', () => {
    const almaaz = byId.get('gaia:205499655242974464')!;
    expect(almaaz.name).toBe('Almaaz');
    const cet = byId.get('gaia:3665501184671104')!;
    expect(cet.name).toBe('93 Cet');
    expect(cet.designations).toContain('* 93 Cet');
    const none = recordsFromGaia(cat, null);
    expect(none.every((r) => r.category === 'other')).toBe(true);
    expect(none[0]!.name).toMatch(/^Gaia DR3 \d+$/);
    expect(none[0]!.classification).toBe('Gaia DR3 source without a SIMBAD identification');
  });
  it('an empty catalogue gives no records', () => {
    expect(recordsFromGaia({ count: 0 } as GaiaCatalogue, null)).toEqual([]);
  });
});

describe.skipIf(!have('gaia-dr3-subset.v1.json.gz'))('recordsFromGaia on the real file', () => {
  const { cat, simbad } = loadGaia();
  const recs = recordsFromGaia(cat, simbad);
  it('35,325 well-formed records; distances follow the parallax rule exactly', () => {
    expect(recs).toHaveLength(cat.count);
    expect(recs.length).toBeGreaterThan(35000);
    checkRecords(recs, 'gaia real');
    let withDist = 0;
    for (let i = 0; i < cat.count; i += 7) {
      const r = recs[i]!;
      const d = cat.distancePc(i);
      expect(r.measurements.distancePc?.value, r.id).toBe(d === null ? undefined : d);
      if (d !== null) withDist++;
    }
    expect(withDist).toBeGreaterThan(1000);
    const stars = recs.filter((r) => r.category === 'star').length;
    expect(stars).toBeGreaterThan(30000);
    expect(recs.filter((r) => r.category === 'other').length).toBeGreaterThan(1000);
  });
  it('no star brighter than G = 1.5 is present (the reason the Hipparcos supplement exists)', () => {
    expect(Math.min(...recs.map((r) => r.measurements.apparentMag?.value ?? 99))).toBeGreaterThan(1.4);
  });
  it('is searchable by proper name, Hipparcos number and Gaia id', () => {
    const idx = new SearchIndex();
    idx.add(recs);
    expect(idx.search('Barnard\'s star').hits[0]!.id).toBe('gaia:4472832130942575872');
    expect(idx.search('HIP 87937').hits[0]!.id).toBe('gaia:4472832130942575872');
    expect(idx.search('4472832130942575872').hits[0]!.id).toBe('gaia:4472832130942575872');
    expect(idx.search('proxima').hits.map((h) => h.id)).toContain('gaia:5853498713190525696');
    expect(idx.search('GJ 699').hits[0]!.id).toBe('gaia:4472832130942575872');
  });
});

describe.skipIf(!have('solar-system.v1.json'))('recordsFromSolar on the real file', () => {
  const solar = loadSolar();
  const recs = recordsFromSolar(solar);
  const by = new Map(recs.map((r) => [r.id, r]));
  it('Sun, 8 planets, 20 moons', () => {
    expect(recs).toHaveLength(29);
    checkRecords(recs, 'solar');
    expect(recs.filter((r) => r.category === 'planet')).toHaveLength(8);
    expect(recs.filter((r) => r.category === 'moon')).toHaveLength(20);
    expect(by.get('solar:sun')!.category).toBe('star');
    expect(recs.every((r) => r.position.kind === 'solar' && r.dataset === 'solar-system' && r.drawn)).toBe(true);
  });
  it('maps radius, mass, period; the Sun gets Teff, luminosity and radius in solar units; no catalogue distance', () => {
    const e = by.get('solar:earth')!;
    expect(e.measurements.radiusKm!.value).toBeCloseTo(6371, -1);
    expect(e.measurements.massKg!.value).toBeCloseTo(5.97e24, -22);
    expect(e.measurements.orbitalPeriodDays!.value).toBeCloseTo(365.25, 0);
    expect(e.measurements.teffK).toBeUndefined();                       // a planet's 'temperature' is not an effective temperature
    expect(e.measurements.distancePc).toBeUndefined();
    const s = by.get('solar:sun')!;
    expect(s.measurements.teffK!.value).toBe(5772);
    expect(s.measurements.luminositySun!.value).toBeCloseTo(1, 3);
    expect(s.measurements.radiusSun!.value).toBeCloseTo(1, 3);
    expect(s.spectralType).toBeDefined();
    expect(by.get('solar:io')!.classification).toBe('Moon of Jupiter');
    expect(by.get('solar:mars')!.classification).toBe('Planet');
    expect(by.get('solar:io')!.designations).toEqual(expect.arrayContaining(['Io', 'NAIF 501']));
    expect(by.get('solar:sun')!.measurements.orbitalPeriodDays).toBeUndefined();
  });
  it('solar bodies fall in their own distance band', () => {
    const st = RecordStore.from(recs);
    expect(st.bandAt(0)).toBe('solar-system');
    expect(st.bandIdx.every((b) => b === st.bandIdx[0])).toBe(true);
  });
});

describe.skipIf(!have('deep-space.v1.json'))('recordsFromDeep on the real file', () => {
  const deep = loadDeep();
  const recs = recordsFromDeep(deep);
  const by = new Map(recs.map((r) => [r.id, r]));
  it('27 records with the documented categories', () => {
    expect(recs).toHaveLength(27);
    checkRecords(recs, 'deep');
    expect(recs.filter((r) => r.category === 'galaxy')).toHaveLength(10);
    expect(recs.filter((r) => r.category === 'nebula').map((r) => r.id).sort()).toEqual(['deep:eagle-nebula', 'deep:carina-nebula', 'deep:horsehead-nebula', 'deep:ngc-1999', 'deep:orion-nebula', 'deep:ring-nebula'].sort());
    expect(recs.filter((r) => r.category === 'supernova-remnant').map((r) => r.id).sort()).toEqual(['deep:crab-nebula', 'deep:veil-nebula']);
    expect(recs.filter((r) => r.category === 'star-cluster')).toHaveLength(6);
    expect(recs.filter((r) => r.category === 'galaxy-group').map((r) => r.id).sort()).toEqual(['deep:local-group', 'deep:m81-group']);
    expect(by.get('deep:virgo-cluster')!.category).toBe('galaxy-cluster');
  });
  it('M31: unit conversion, uncertainty, size, magnitude, classification, designations incl. the bracket-free ones', () => {
    const m = by.get('deep:m31')!;
    expect(m.measurements.distancePc).toMatchObject({ value: 761000, kind: 'observed', uncertainty: 11000 });
    expect(m.measurements.angularSizeArcmin!.value).toBeCloseTo(177.83, 2);
    expect(m.measurements.physicalSizePc!.kind).toBe('derived');
    expect(m.measurements.physicalSizePc!.value).toBeGreaterThan(30000);
    expect(m.measurements.apparentMag).toMatchObject({ value: expect.any(Number), kind: 'observed' });
    expect(m.designations).toEqual(expect.arrayContaining(['M 31', 'NGC 224', 'UGC 454']));
    expect(m.classification).toMatch(/^Galaxy · /);
    expect(m.drawn).toBe(true);
    expect(m.position.kind).toBe('icrs');
  });
  it('the Milky Way keeps its Galactic-centre direction but no "distance to the galaxy"', () => {
    const mw = by.get('deep:milky-way')!;
    expect(mw.measurements.distancePc).toBeUndefined();
    expect(mw.position.kind).toBe('icrs');
    expect(mw.measurements.massKg).toBeDefined();
  });
  it('the Local Group has no position of its own: sky-only with no direction, not drawn', () => {
    const lg = by.get('deep:local-group')!;
    expect(lg.position.kind).toBe('sky-only');
    expect(hasSkyDirection(lg.position)).toBe(false);
    expect(lg.drawn).toBe(false);
    expect(lg.measurements.distancePc).toBeUndefined();
    const st = RecordStore.from(recs);
    expect(st.hasPosition(st.indexOfId('deep:local-group'))).toBe(false);
  });
  it('positions are the viewer\'s positions; supernova remnants and clusters have sizes; cluster mass is in kg', () => {
    for (const r of recs) if (r.position.kind === 'icrs') {
      const pc = deep.positionPc(r.id.slice(5))!;
      expect(r.position.xyzPc).toEqual(pc);
    }
    expect(by.get('deep:crab-nebula')!.measurements.physicalSizePc!.value).toBeGreaterThan(1);
    expect(by.get('deep:m13')!.measurements.massKg!.value).toBeGreaterThan(1e30);
    expect(by.get('deep:orion-nebula')!.measurements.distancePc!.kind).toBe('modelled');
  });
  it('searchable by the name, by a bracketed catalogue number and by its other designations', () => {
    const idx = new SearchIndex();
    idx.add(recs);
    expect(idx.search('M31').hits[0]!.id).toBe('deep:m31');
    expect(idx.search('Andromeda').hits[0]!.id).toBe('deep:m31');
    expect(idx.search('NGC 1952').hits[0]!.id).toBe('deep:crab-nebula');
    expect(idx.search('Messier 42').hits[0]!.id).toBe('deep:orion-nebula');
    expect(idx.search('Local Group').hits[0]!.id).toBe('deep:local-group');
  });
});

describe('recordsFromPoints on small fixtures', () => {
  const ungc: PointCatalogueFile = {
    manifest: { id: 'ungc', title: 't', source: { source: 's', retrieved: '2026-11-13' }, licence: 'l', count: 4, query: 'q', distanceBasis: 'per-object-direct', caveats: [], units: {} },
    columns: {
      name: ['Direct', 'Assigned', 'NoDist', 'Zero'], raDeg: [10, 20, 30, 40], decDeg: [-5, 5, 15, 25],
      distMpc: [3.5, 4, null, 0], distErrMpc: [0.1, null, null, null], distMethod: ['TRGB', 'mem', null, 'TRGB'], morphology: ['Im', 'Sm', null, 'E'], bMag: [12.5, null, 14, 10],
      diameterArcmin: [5.5, null, 0, 1], ngcSimbadName: ['NGC 1', 'UGC 2', null, null],
    },
  };
  const recs = recordsFromPoints(ungc);
  it('ids, categories, datasets, designations', () => {
    expect(recs.map((r) => r.id)).toEqual(['point:ungc:0', 'point:ungc:1', 'point:ungc:2', 'point:ungc:3']);
    expect(recs.every((r) => r.category === 'galaxy' && r.dataset === 'ungc')).toBe(true);
    expect(recs[0]!.designations).toEqual(['Direct', 'NGC 1']);
    expect(recs[2]!.designations).toEqual(['NoDist']);
    checkRecords(recs, 'ungc fixture');
  });
  it('a direct distance is observed with its uncertainty; a membership-assigned one is derived and says so', () => {
    expect(recs[0]!.measurements.distancePc).toEqual({ value: 3.5e6, kind: 'observed', uncertainty: 1e5 });
    expect(recs[1]!.measurements.distancePc!.kind).toBe('derived');
    expect(recs[1]!.measurements.distancePc!.note).toMatch(/not an independent distance measurement/);
    expect(recs[1]!.measurements.distancePc!.uncertainty).toBeUndefined();
  });
  it('a row for the Milky Way itself has no distance (we are inside it)', () => {
    const f: PointCatalogueFile = { ...ungc, manifest: { ...ungc.manifest, id: 'local-group-mcconnachie' }, columns: { name: ['Milky Way', 'LMC'], raDeg: [266.4, 80.9], decDeg: [-29, -69.8], distMpc: [0.01, 0.05], distErrMpc: [null, 0.002], vMag: [null, 0.4] } };
    const r = recordsFromPoints(f);
    expect(r[0]!.measurements.distancePc).toBeUndefined();
    expect(r[0]!.position.kind).toBe('sky-only');
    expect(r[1]!.measurements.distancePc!.value).toBe(50000);
  });
  it('missing and non-positive values are absent, not zero', () => {
    expect(recs[2]!.measurements.distancePc).toBeUndefined();
    expect(recs[2]!.position.kind).toBe('sky-only');
    expect(recs[2]!.drawn).toBe(false);
    expect(recs[2]!.measurements.angularSizeArcmin).toBeUndefined();                  // 0 arcmin is not a size
    expect(recs[3]!.measurements.distancePc).toBeUndefined();                          // 0 Mpc is not a distance
    expect(recs[1]!.measurements.apparentMag).toBeUndefined();
    expect(recs[0]!.measurements.apparentMag).toEqual({ value: 12.5, kind: 'observed' });
    expect(recs[0]!.classification).toBe('Galaxy · Im');
  });
  it('2MRS: cz is observed; distance only from 1000 km/s, derived, with the H0 assumption in the note', () => {
    const f: PointCatalogueFile = {
      manifest: { ...ungc.manifest, id: 'twomrs', distanceBasis: 'per-object-redshift-hubble-flow' },
      columns: { name: ['00424433+4116074', 'low', 'none', 'negative', 'exact'], raDeg: [10, 20, 30, 40, 50], decDeg: [41, 5, 15, 25, 35], czKms: [7000, 999, null, -300, 1000], czErrKms: [4, null, null, 4, null], ksMag: [10.5, 9, 8, 7, null], morphology: ['3A2s', null, null, null, null] },
    };
    const r = recordsFromPoints(f);
    expect(r[0]!.measurements.czKms).toEqual({ value: 7000, kind: 'observed', uncertainty: 4 });
    expect(r[0]!.measurements.distancePc!.value).toBeCloseTo(1e8, 3);                 // 7000 / 70 Mpc
    expect(r[0]!.measurements.distancePc!.kind).toBe('derived');
    expect(r[0]!.measurements.distancePc!.note).toMatch(/H0 = 70 km\/s\/Mpc, an application choice/);
    expect(r[0]!.measurements.distancePc!.value).toBe(hubbleDistancePc(7000));        // the renderer's number
    expect(r[0]!.designations).toEqual(['00424433+4116074', '2MASX J00424433+4116074']);
    expect(r[1]!.measurements.czKms!.value).toBe(999);
    expect(r[1]!.measurements.distancePc).toBeUndefined();                              // below 1000 km/s: peculiar velocity dominates
    expect(r[1]!.position.kind).toBe('sky-only');
    expect(r[2]!.measurements.czKms).toBeUndefined();
    expect(r[3]!.measurements.czKms!.value).toBe(-300);
    expect(r[3]!.measurements.distancePc).toBeUndefined();
    expect(r[4]!.measurements.distancePc).toBeDefined();                                // exactly 1000 is allowed, as in the renderer
    expect(hubbleDistancePc(1000)).not.toBeNull();
    expect(hubbleDistancePc(999)).toBeNull();
    expect(r[4]!.measurements.apparentMag).toBeUndefined();
    expect(r.every((x) => x.dataset === 'twomrs')).toBe(true);
    expect(r[1]!.designations).toEqual(['low']);                                        // only the standard 2MASS-id shape gets a 2MASX name
  });
  it('McConnachie: distance observed with the mean error; V magnitude', () => {
    const f: PointCatalogueFile = {
      manifest: { ...ungc.manifest, id: 'local-group-mcconnachie' },
      columns: { name: ['Draco'], raDeg: [260.05], decDeg: [57.9], distMpc: [0.076], distErrMpc: [0.006], vMag: [10.6], morphology: ['dSph'], diameterArcmin: [null] },
    };
    const r = recordsFromPoints(f)[0]!;
    expect(r.measurements.distancePc).toEqual({ value: 76000, kind: 'observed', uncertainty: 6000 });
    expect(r.measurements.apparentMag!.value).toBe(10.6);
    expect(r.dataset).toBe('local-group-mcconnachie');
  });
  it('rejects an unknown file id and a file without its required columns; tolerates optional ones missing', () => {
    expect(() => recordsFromPoints({ ...ungc, manifest: { ...ungc.manifest, id: 'mystery' } })).toThrow(/Unknown point catalogue/);
    expect(() => recordsFromPoints({ ...ungc, columns: { raDeg: [1] } })).toThrow(/required column "name"/);
    const minimal = recordsFromPoints({ ...ungc, columns: { name: ['A'], raDeg: [1], decDeg: [2] } });
    expect(minimal).toHaveLength(1);
    expect(minimal[0]!.measurements).toEqual({});
  });
  it('skips rows without a usable name or position', () => {
    const r = recordsFromPoints({ ...ungc, columns: { name: ['', null, 'ok', 'nan-ra'], raDeg: [1, 2, 3, NaN], decDeg: [1, 2, 3, 4] } });
    expect(r.map((x) => x.name)).toEqual(['ok']);
  });
  it('an empty catalogue is empty', () => {
    expect(recordsFromPoints({ ...ungc, columns: { name: [], raDeg: [], decDeg: [] } })).toEqual([]);
  });
});

describe.skipIf(!have('deepspace/ungc.v1.json.gz'))('recordsFromPoints on the real files', () => {
  it.each(['ungc', 'local-group-mcconnachie'])('%s: every row becomes a record', (id) => {
    const f = loadPoints(id);
    const recs = recordsFromPoints(f);
    expect(recs).toHaveLength(f.manifest.count);
    checkRecords(recs, id);
    const noDist = recs.filter((r) => r.measurements.distancePc === undefined).map((r) => r.name);
    expect(noDist.every((n) => /^(?:the galaxy|milky way)/i.test(n)), noDist.join(',')).toBe(true);        // only the galaxy we are inside
  });
  it('ungc: rows with a non-independent method are derived, the rest observed', () => {
    const f = loadPoints('ungc');
    const recs = recordsFromPoints(f);
    const methods = f.columns['distMethod'] as (string | null)[];
    let derived = 0;
    recs.forEach((r, i) => {
      if (/^milky way/i.test(r.name)) { expect(r.measurements.distancePc).toBeUndefined(); return; }
      const bad = methods[i] !== null && UNGC_NOT_INDEPENDENT.has(methods[i]!);
      expect(r.measurements.distancePc?.kind, r.id).toBe(bad ? 'derived' : 'observed');
      if (bad) derived++;
    });
    expect(derived).toBeGreaterThan(10);
  });
  it('twomrs: 43,533 rows, cz for every row that has one, distances only above the cz limit, all using the renderer\'s rule', () => {
    const f = loadPoints('twomrs');
    const recs = recordsFromPoints(f);
    expect(recs).toHaveLength(43533);
    checkRecords(recs, 'twomrs');
    const cz = f.columns['czKms'] as (number | null)[];
    let withD = 0, without = 0;
    recs.forEach((r, i) => {
      const expected = hubbleDistancePc(cz[i]);
      expect(r.measurements.distancePc?.value, r.id).toBe(expected === null ? undefined : expected);
      expect(r.measurements.czKms?.value).toBe(cz[i] === null ? undefined : cz[i]);
      if (expected === null) without++; else withD++;
    });
    expect(withD).toBeGreaterThan(35000);
    expect(without).toBeGreaterThan(100);
  });
});

describe('recordsFromBrightStars', () => {
  const file: BrightStarFile = {
    manifest: { id: 'bright', title: 't', source: { source: 's', retrieved: '2026-11-13' }, licence: 'l', query: 'q', count: 5, caveats: [], units: {}, astrometricEpoch: 'J1991.25', nameSource: 'IAU' },
    columns: {
      hip: [32349, 27989, 11767, 1, 2], raDeg: [101.287, 88.793, 37.95, 0.1, 0.2], decDeg: [-16.716, 7.407, 89.264, 10, -10],
      parallaxMas: [379.21, 6.55, 7.54, -52.8, null], parallaxErrMas: [1.58, 0.83, 0.11, 33.7, null],
      pmraMasYr: [-546.01, 27.33, 44.22, 1, null], pmdecMasYr: [-1223.07, 10.86, -11.74, 2, null], pmraErrMasYr: [1.3, 0.7, 0.1, 5, null], pmdecErrMasYr: [1.2, 0.6, 0.1, 5, null],
      vMag: [-1.44, 0.42, 1.98, 5.1, null], spectralType: ['A0m...', 'M2Iab', 'F7:Ib-II', null, null], iauName: ['Sirius', 'Betelgeuse', 'Polaris', null, null],
      designations: ['HIP 32349|HD 48915|alf CMa|HR 2491', 'HIP 27989|HD 39801|alf Ori', 'HIP 11767|alf UMi', 'HIP 1', null], gaiaSourceId: [null, null, '4636000000000000000', null, null],
      parallaxQuality: ['good', 'poor', 'good', 'poor', null],
    },
  };
  const recs = recordsFromBrightStars(file);
  it('maps the columns and ids', () => {
    expect(recs.map((r) => r.id)).toEqual(['hip:32349', 'hip:27989', 'hip:11767', 'hip:1', 'hip:2']);
    checkRecords(recs, 'bright fixture');
    expect(recs[0]).toMatchObject({ name: 'Sirius', dataset: 'hipparcos', category: 'star', spectralType: 'A0m...', drawn: true, classification: 'Star · A0m...' });
    expect(recs[0]!.designations).toEqual(['HIP 32349', 'Sirius', 'HD 48915', 'alf CMa', 'HR 2491']);
    expect(recs[0]!.measurements.apparentMag).toEqual({ value: -1.44, kind: 'observed' });
    expect(recs[0]!.measurements.distancePc!.value).toBeCloseTo(2.637, 3);
    expect(recs[0]!.measurements.absoluteMag!.kind).toBe('derived');
    expect(recs[0]!.measurements.absoluteMag!.value).toBeCloseTo(-1.44 - 5 * Math.log10(2.637) + 5, 2);
    expect(recs[0]!.measurements.pmTotalMasYr!.value).toBeCloseTo(Math.hypot(-546.01, -1223.07), 9);
    expect(recs[3]!.name).toBe('HIP 1');
    expect(recs[3]!.designations).toEqual(['HIP 1']);
  });
  it('a NAMED star with parallax S/N 5-10 (Betelgeuse 6.55/0.83 = 7.9) is placed: derived distance, parallax-error uncertainty, low-reliability note; same rule as the renderer', () => {
    const b = recs[1]!;
    expect(b.name).toBe('Betelgeuse');
    expect(b.measurements.distancePc!.value).toBeCloseTo(1000 / 6.55, 6);
    expect(b.measurements.distancePc!.kind).toBe('derived');
    expect(b.measurements.distancePc!.uncertainty).toBeCloseTo((1000 * 0.83) / (6.55 * 6.55), 6);
    expect(b.measurements.distancePc!.note).toBe('low reliability: parallax S/N < 10');
    expect(b.measurements.absoluteMag!.note).toBe('low reliability: parallax S/N < 10');
    expect(b.position.kind).toBe('icrs');
    expect(b.drawn).toBe(true);
    // a reliable star carries no such note
    expect(recs[0]!.measurements.distancePc!.note).toBeUndefined();
  });
  it('a negative parallax never gives a distance; the star stays, sky-only and not drawn; a row with nothing has no measurements', () => {
    expect(recs[3]!.measurements.distancePc).toBeUndefined();
    expect(recs[3]!.position.kind).toBe('sky-only');
    expect(recs[3]!.drawn).toBe(false);
    expect(recs[4]!.measurements).toEqual({});
    expect(recs[4]!.drawn).toBe(false);
  });
  it('an UNNAMED star with S/N 5-10 and a named one with S/N < 5 (Alnilam 3.7) stay sky-only', () => {
    const f: BrightStarFile = { ...file, columns: {
      hip: [1001, 26311], raDeg: [10, 84.05], decDeg: [10, -1.2], parallaxMas: [6.55, 1.65], parallaxErrMas: [0.83, 0.45], vMag: [3, 1.69], iauName: [null, 'Alnilam'],
    } };
    const r = recordsFromBrightStars(f);
    expect(r[0]!.measurements.distancePc).toBeUndefined();
    expect(r[1]!.measurements.distancePc).toBeUndefined();
    expect(r[1]!.position.kind).toBe('sky-only');
    expect(r[1]!.drawn).toBe(false);
  });
  it('sameAs links the Gaia record when the file found one', () => {
    expect(recs[2]!.sameAs).toEqual(['gaia:4636000000000000000']);
    expect(recs[0]!.sameAs).toBeUndefined();
  });
  it('the parallaxQuality column is not consulted: the placement rule is S/N alone (shared with the renderer)', () => {
    const { parallaxQuality: _q, ...rest } = file.columns;
    void _q;
    const r = recordsFromBrightStars({ ...file, columns: rest });
    expect(r[0]!.measurements.distancePc).toBeDefined();
    expect(r[1]!.measurements.distancePc).toBeDefined();
  });
  it('requires hip, raDeg, decDeg', () => {
    expect(() => recordsFromBrightStars({ ...file, columns: { raDeg: [1], decDeg: [2] } })).toThrow(/required column "hip"/);
    expect(recordsFromBrightStars({ ...file, columns: { hip: [], raDeg: [], decDeg: [] } })).toEqual([]);
  });
});

describe.skipIf(!have('bright-stars.v1.json.gz'))('recordsFromBrightStars on the real file', () => {
  const file = readGz<BrightStarFile>('bright-stars.v1.json.gz');
  const recs = recordsFromBrightStars(file);
  it('every row, well-formed; the brightest stars are present', () => {
    expect(recs).toHaveLength(file.manifest.count);
    checkRecords(recs, 'bright real');
    const sirius = recs.find((r) => r.name === 'Sirius')!;
    expect(sirius.designations).toEqual(expect.arrayContaining(['HIP 32349', 'HD 48915']));
    expect(sirius.measurements.apparentMag!.value).toBeCloseTo(-1.44, 1);
    expect(sirius.measurements.distancePc!.value).toBeCloseTo(2.64, 1);
    for (const n of ['Vega', 'Polaris', 'Rigel', 'Betelgeuse', 'Arcturus', 'Canopus']) expect(recs.some((r) => r.name === n), n).toBe(true);
  });
  it('every row that has a distance satisfies the shared placement rule (S/N >= 10, or an IAU-named star with S/N 5-10 flagged low reliability); all others are sky-only', () => {
    const plx = file.columns['parallaxMas'] as (number | null)[], err = file.columns['parallaxErrMas'] as (number | null)[], iau = file.columns['iauName'] as (string | null)[];
    recs.forEach((r, i) => {
      const snr = plx[i] !== null && err[i] !== null && err[i]! > 0 ? plx[i]! / err[i]! : -Infinity;
      const expectPlaced = plx[i]! > 0 && (snr >= 10 || (snr >= 5 && iau[i] !== null));
      expect(r.measurements.distancePc !== undefined, r.id).toBe(expectPlaced);
      expect(r.position.kind === 'icrs', r.id).toBe(expectPlaced);
      if (expectPlaced) expect(r.measurements.distancePc!.note === 'low reliability: parallax S/N < 10', r.id).toBe(snr < 10);
    });
    const betel = recs.find((r) => r.name === 'Betelgeuse')!;
    expect(betel.measurements.distancePc!.note).toBe('low reliability: parallax S/N < 10');
    const alnilam = recs.find((r) => r.name === 'Alnilam')!;
    expect(alnilam.measurements.distancePc).toBeUndefined();
    expect(alnilam.drawn).toBe(false);
  });
  it('searchable by IAU name and by Bayer designation; unique ids', () => {
    const idx = new SearchIndex();
    idx.add(recs);
    expect(idx.search('Sirius').hits[0]!.id).toBe('hip:32349');
    expect(idx.search('alpha CMa').hits.map((h) => h.id)).toContain('hip:32349');
    expect(idx.search('HR 2491').hits.map((h) => h.id)).toContain('hip:32349');
  });
});

describe('recordsFromExoplanets', () => {
  const file: ExoplanetFile = {
    manifest: { id: 'x', title: 't', source: { source: 's', retrieved: '2026-11-13' }, licence: 'l', query: 'q', count: 6, caveats: [], units: {}, table: 'pscomppars', archiveRelease: 'r' },
    hosts: {
      hostname: ['TRAPPIST-1', 'Nodist', '11 Com'], raDeg: [346.62, 10, 185.18], decDeg: [-5.04, 20, 17.79], distPc: [12.43, null, 93.18], distErrPc: [0.02, null, 1.92],
      spectralType: ['M8 V', null, 'G8 III'], teffK: [2566, null, 4874], teffErrK: [26, null, null], stRadiusSun: [0.12, null, 13.76], stMassSun: [0.09, null, 2.09], vMag: [18.8, null, 4.72],
      gaiaDr3Id: ['2635476908753563008', null, null], hipName: [null, null, 'HIP 60202'], hdName: [null, null, 'HD 107383'], ticId: ['TIC 1', null, null], pmRaMasYr: [930.7, null, -109.2], pmDecMasYr: [-479.0, null, 88.2],
    },
    planets: {
      plName: ['TRAPPIST-1 b', 'TRAPPIST-1 e', 'Nodist b', 'Msini b', 'Limit b', '11 Com b'], hostname: ['TRAPPIST-1', 'TRAPPIST-1', 'Nodist', '11 Com', '11 Com', '11 Com'],
      discoveryMethod: ['Transit', 'Transit', 'Imaging', 'Radial Velocity', 'Transit', 'Radial Velocity'], discoveryYear: [2016, 2017, 2020, 2007, 2021, 2007],
      periodDays: [1.51, 6.1, null, 323.2, 5, 323.21], periodErr: [0.00002, 0.00003, null, 0.06, null, 0.06], periodLim: [0, 0, null, 0, 1, 0],
      radiusEarth: [1.12, 0.92, null, null, 3, 12.2], radiusErr: [0.014, 0.013, null, null, null, null], radiusLim: [0, 0, null, null, 1, 0],
      massEarth: [1.37, 0.69, null, 4914, 10, 4914], massErr: [0.07, 0.04, null, 39, null, 39], massLim: [0, 0, null, 0, 0, 0], massKind: ['Mass', 'M-R relationship', null, 'Msini', 'Mass', 'Msini'],
      eqTempK: [400, 250, null, null, null, 803], controversial: [0, 0, 0, 0, 1, 0],
    },
  };
  const recs = recordsFromExoplanets(file);
  const by = new Map(recs.map((r) => [r.id, r]));
  it('hosts first, then planets, with the documented ids and categories', () => {
    expect(recs.map((r) => r.id)).toEqual(['host:TRAPPIST-1', 'host:Nodist', 'host:11 Com', 'exo:TRAPPIST-1 b', 'exo:TRAPPIST-1 e', 'exo:Nodist b', 'exo:Msini b', 'exo:Limit b', 'exo:11 Com b']);
    checkRecords(recs, 'exo fixture');
    expect(by.get('host:TRAPPIST-1')).toMatchObject({ category: 'exoplanet-host', dataset: 'nasa-exoplanet-archive', spectralType: 'M8 V', sameAs: ['gaia:2635476908753563008'], drawn: true });
    expect(by.get('exo:TRAPPIST-1 b')).toMatchObject({ category: 'exoplanet', drawn: false });
  });
  it('host: distance with uncertainty, stellar parameters, designations from the archive\'s own columns', () => {
    const h = by.get('host:11 Com')!;
    expect(h.designations).toEqual(['11 Com', 'HIP 60202', 'HD 107383']);
    expect(h.measurements.distancePc).toEqual({ value: 93.18, kind: 'derived', uncertainty: 1.92 });
    expect(h.measurements.teffK).toEqual({ value: 4874, kind: 'modelled' });
    expect(h.measurements.radiusSun!.value).toBe(13.76);
    expect(h.measurements.massKg!.value).toBeCloseTo(2.09 * 1.98841e30, -25);
    expect(h.measurements.pmTotalMasYr!.value).toBeCloseTo(Math.hypot(-109.2, 88.2), 9);
    expect(by.get('host:TRAPPIST-1')!.designations).toEqual(['TRAPPIST-1', 'TIC 1', 'Gaia DR3 2635476908753563008']);
    const nd = by.get('host:Nodist')!;
    expect(nd.measurements).toEqual({});
    expect(nd.position.kind).toBe('sky-only');
    expect(nd.drawn).toBe(false);
  });
  it('planet: period, radius in km, mass only when it is a mass, equilibrium temperature as modelled', () => {
    const b = by.get('exo:TRAPPIST-1 b')!;
    expect(b.measurements.orbitalPeriodDays).toEqual({ value: 1.51, kind: 'observed', uncertainty: 0.00002 });
    expect(b.measurements.radiusKm!.value).toBeCloseTo(1.12 * 6378.1, 6);
    expect(b.measurements.radiusKm!.uncertainty).toBeCloseTo(0.014 * 6378.1, 6);
    expect(b.measurements.massKg).toMatchObject({ kind: 'derived' });
    expect(b.measurements.massKg!.value).toBeCloseTo(1.37 * 5.972168e24, -20);
    expect(b.measurements.teffK).toMatchObject({ value: 400, kind: 'modelled' });
    expect(b.measurements.teffK!.note).toMatch(/Equilibrium temperature/);
    expect(b.classification).toBe('Confirmed exoplanet (Transit, 2016)');
    expect(by.get('exo:TRAPPIST-1 e')!.measurements.massKg).toMatchObject({ kind: 'modelled' });
    expect(by.get('exo:TRAPPIST-1 e')!.measurements.massKg!.note).toMatch(/mass-radius relationship/);
  });
  it('a planet takes its host\'s position and distance; a host without one gives the planet no distance', () => {
    const b = by.get('exo:TRAPPIST-1 b')!, h = by.get('host:TRAPPIST-1')!;
    expect(b.position).toEqual(h.position);
    expect(b.measurements.distancePc).toEqual(h.measurements.distancePc);
    expect(by.get('exo:Nodist b')!.position.kind).toBe('sky-only');
    expect(by.get('exo:Nodist b')!.measurements).toEqual({});
  });
  it('a minimum mass (Msini) is NOT a mass; limit-flagged values are not values; controversial is stated', () => {
    expect(by.get('exo:Msini b')!.measurements.massKg).toBeUndefined();
    expect(by.get('exo:11 Com b')!.measurements.massKg).toBeUndefined();
    const lim = by.get('exo:Limit b')!;
    expect(lim.measurements.radiusKm).toBeUndefined();
    expect(lim.measurements.orbitalPeriodDays).toBeUndefined();
    expect(lim.measurements.massKg).toBeDefined();                                       // massLim 0 and kind Mass
    expect(lim.classification).toMatch(/controversial/);
  });
  it('requires host and planet name columns', () => {
    expect(() => recordsFromExoplanets({ ...file, hosts: {} })).toThrow(/required column "hostname"/);
    expect(() => recordsFromExoplanets({ ...file, planets: {} })).toThrow(/required column "plName"/);
  });
});

describe.skipIf(!have('exoplanets.v1.json.gz'))('recordsFromExoplanets on the real file', () => {
  const file = readGz<ExoplanetFile>('exoplanets.v1.json.gz');
  const recs = recordsFromExoplanets(file);
  it('every host and planet, well-formed, unique ids', () => {
    const hosts = (file.hosts['hostname'] as string[]).length, planets = (file.planets['plName'] as string[]).length;
    expect(recs).toHaveLength(hosts + planets);
    checkRecords(recs, 'exo real');
  });
  it('no planet has a minimum mass as its mass; every limit-flagged radius is dropped', () => {
    const kinds = file.planets['massKind'] as (string | null)[];
    const radLim = file.planets['radiusLim'] as (number | null)[];
    const planets = recs.filter((r) => r.category === 'exoplanet');
    planets.forEach((r, i) => {
      if (kinds[i] === 'Msini' || kinds[i] === 'Msin(i)/sin(i)' || kinds[i] === null) expect(r.measurements.massKg, r.id).toBeUndefined();
      if (radLim[i] === 1 || radLim[i] === -1) expect(r.measurements.radiusKm, r.id).toBeUndefined();
    });
    expect(planets.filter((r) => r.measurements.massKg).length).toBeGreaterThan(4000);
  });
  it('searchable by planet name in all spellings', () => {
    const idx = new SearchIndex();
    idx.add(recs);
    expect(idx.search('TRAPPIST-1 e').hits[0]!.id).toBe('exo:TRAPPIST-1 e');
    expect(idx.search('trappist 1e').hits[0]!.id).toBe('exo:TRAPPIST-1 e');
    expect(idx.search('Kepler-452b').hits[0]!.id).toBe('exo:Kepler-452 b');
    expect(idx.search('kepler 452 b').hits[0]!.id).toBe('exo:Kepler-452 b');
    expect(idx.search('55 Cnc e').hits[0]!.id).toBe('exo:55 Cnc e');
    expect(idx.search('HD 209458 b').hits[0]!.id).toBe('exo:HD 209458 b');
  });
});

describe('recordsFromOther', () => {
  const claim = { label: 'l', url: 'https://x', retrieved: '2026-11-13' };
  const file: OtherObjectsFile = {
    manifest: { schema: 'atlas-other-objects/1', generated: '2026-11-13', note: 'n' },
    objects: [
      { id: 'other:a', name: 'Sagittarius A*', designations: ['Sagittarius A*', 'Sgr A*'], category: 'other', classification: 'Supermassive black hole', raDeg: 266.4, decDeg: -29.0, distance: { value: 8.178, unit: 'kpc', uncertainty: 0.026, kind: 'derived', source: claim }, coordinateSource: claim, facts: [] },
      { id: 'other:b', name: 'Nodist', designations: ['Nodist'], category: 'star', classification: 'Star', raDeg: 1, decDeg: 2, coordinateSource: claim, facts: [] },
      { id: 'other:c', name: 'BadUnit', designations: [], category: 'other', classification: 'x', raDeg: 1, decDeg: 2, distance: { value: 5, unit: 'furlong' as never, kind: 'derived', source: claim }, coordinateSource: claim, facts: [] },
      { id: 'other:d', name: 'NaNpos', designations: [], category: 'other', classification: 'x', raDeg: NaN, decDeg: 2, coordinateSource: claim, facts: [] },
    ],
  };
  const recs = recordsFromOther(file);
  it('converts units, keeps the stated kind, never invents a distance', () => {
    expect(recs.map((r) => r.id)).toEqual(['other:a', 'other:b', 'other:c']);
    expect(recs[0]!.measurements.distancePc).toMatchObject({ value: 8178, kind: 'derived' });
    expect(recs[0]!.measurements.distancePc!.uncertainty).toBeCloseTo(26, 9);
    expect(recs[0]!.position.kind).toBe('icrs');
    expect(recs[0]!.drawn).toBe(true);
    expect(recs[1]!.measurements.distancePc).toBeUndefined();
    expect(recs[1]!.position.kind).toBe('sky-only');
    expect(recs[1]!.drawn).toBe(false);
    expect(recs[2]!.measurements.distancePc).toBeUndefined();          // an unknown unit is not guessed
    expect(recs[2]!.designations).toEqual(['BadUnit']);
    checkRecords(recs, 'other fixture');
    expect(recs.every((r) => r.dataset === 'curated-other' && r.sourceKey === 'curated-other')).toBe(true);
  });
});

describe.skipIf(!have('other-objects.v1.json'))('recordsFromOther on the real file', () => {
  const file = readJson<OtherObjectsFile>('other-objects.v1.json');
  const recs = recordsFromOther(file);
  it('every object, ids as published, distances in parsecs', () => {
    expect(recs.map((r) => r.id)).toEqual(file.objects.map((o) => o.id));
    checkRecords(recs, 'other real');
    const sgr = recs.find((r) => r.id === 'other:sgr-a-star')!;
    expect(sgr.measurements.distancePc!.value).toBe(8178);
    const idx = new SearchIndex();
    idx.add(recs);
    expect(idx.search('Sgr A*').hits[0]!.id).toBe('other:sgr-a-star');
    expect(idx.search('Sagittarius A*').hits[0]!.id).toBe('other:sgr-a-star');
    expect(idx.search('PSR B0531+21').hits[0]!.id).toBe('other:crab-pulsar');
  });
});

describe('mergeRecords: dependents follow their host', () => {
  it('a planet of a merged-away host takes the canonical host\'s position and distance', () => {
    const star = rec('gaia:1', 'Gaia DR3 1', ['Gaia DR3 1'], 'star', { position: { kind: 'icrs', xyzPc: [10, 0, 0], raDeg: 0, decDeg: 0 }, measurements: { distancePc: { value: 10, kind: 'derived', uncertainty: 0.01 } } });
    const host = rec('host:A', 'A', ['A'], 'exoplanet-host', { dataset: 'nasa-exoplanet-archive', sameAs: ['gaia:1'], position: { kind: 'icrs', xyzPc: [10.02, 0, 0], raDeg: 0, decDeg: 0 }, measurements: { distancePc: { value: 10.02, kind: 'derived' } } });
    const planet = rec('exo:A b', 'A b', ['A b'], 'exoplanet', { dataset: 'nasa-exoplanet-archive', position: host.position, measurements: { distancePc: { value: 10.02, kind: 'derived' }, orbitalPeriodDays: { value: 3, kind: 'observed' } } });
    const lone = rec('exo:B b', 'B b', ['B b'], 'exoplanet', { dataset: 'nasa-exoplanet-archive', position: { kind: 'icrs', xyzPc: [50, 0, 0], raDeg: 0, decDeg: 0 }, measurements: { distancePc: { value: 50, kind: 'derived' } } });
    const follow = new Map([['exo:A b', 'host:A'], ['exo:B b', 'host:B']]);
    const r = mergeRecords([star, host, planet, lone], { followHost: follow });
    const p = r.records.find((x) => x.id === 'exo:A b')!;
    expect(p.position).toEqual(star.position);
    expect(p.measurements.distancePc).toEqual({ value: 10, kind: 'derived', uncertainty: 0.01 });
    expect(p.measurements.orbitalPeriodDays).toEqual({ value: 3, kind: 'observed' });       // everything else is the planet's own
    expect(r.records.find((x) => x.id === 'exo:B b')).toBe(lone);                           // a host that was not merged changes nothing
    expect(mergeRecords([star, host, planet]).records.find((x) => x.id === 'exo:A b')!.position).toEqual(host.position);   // without the option nothing moves
  });
});

describe('mergeRecords', () => {
  const gaia = rec('gaia:1', 'HD 1', ['Gaia DR3 1', 'HIP 1', 'HD 1'], 'star', { measurements: { apparentMag: { value: 5, kind: 'observed' }, distancePc: { value: 10, kind: 'derived', uncertainty: 0.1 } }, position: { kind: 'icrs', xyzPc: [10, 0, 0], raDeg: 0, decDeg: 0 }, drawn: true });
  const hip = rec('hip:1', 'Starname', ['HIP 1', 'Starname', 'HR 7'], 'star', { dataset: 'hipparcos', sameAs: ['gaia:1'], spectralType: 'K0V', measurements: { apparentMag: { value: 5.2, kind: 'observed' }, pmTotalMasYr: { value: 100, kind: 'derived' } } });
  const host = rec('host:HD 1', 'HD 1', ['HD 1', 'Planet Host Alias'], 'exoplanet-host', { dataset: 'nasa-exoplanet-archive', sameAs: ['gaia:1'], measurements: { teffK: { value: 5000, kind: 'modelled' }, distancePc: { value: 10.2, kind: 'derived', uncertainty: 0.3 } } });
  const other = rec('deep:m31', 'M31', ['M31'], 'galaxy', { dataset: 'deep-space' });

  it('the Gaia record wins; duplicates become sameAs links and are not listed twice', () => {
    const r = mergeRecords([hip, host, other, gaia]);
    expect(r.records.map((x) => x.id)).toEqual(['deep:m31', 'gaia:1']);          // the canonical record keeps its own place in the input order
    const g = r.records[1]!;
    expect(g.dataset).toBe('gaia-dr3');
    expect([...g.sameAs!].sort()).toEqual(['hip:1', 'host:HD 1']);
    expect(r.aliases.get('hip:1')).toBe('gaia:1');
    expect(r.aliases.get('host:HD 1')).toBe('gaia:1');
    expect(r.merges).toEqual([{ canonical: 'gaia:1', absorbed: ['hip:1', 'host:HD 1'] }]);
    expect(r.warnings).toEqual([]);
  });
  it('the winner keeps every value it has; gaps are filled from the duplicate and tagged with its dataset', () => {
    const g = mergeRecords([gaia, hip, host]).records[0]!;
    expect(g.measurements.apparentMag).toEqual({ value: 5, kind: 'observed' });                      // the winner's own, not Hipparcos' 5.2
    expect(g.measurements.distancePc).toEqual({ value: 10, kind: 'derived', uncertainty: 0.1 });
    expect(g.measurements.pmTotalMasYr).toEqual({ value: 100, kind: 'derived', source: 'hipparcos' });
    expect(g.measurements.teffK).toEqual({ value: 5000, kind: 'modelled', source: 'nasa-exoplanet-archive' });
    expect(g.spectralType).toBe('K0V');
    expect(g.drawn).toBe(true);
  });
  it('all designations stay searchable and resolve to the canonical record', () => {
    const merged = mergeRecords([gaia, hip, host]).records;
    const idx = new SearchIndex();
    idx.add(merged);
    for (const q of ['HR 7', 'Starname', 'Planet Host Alias', 'HIP 1', 'HD 1', 'Gaia DR3 1']) {
      const hits = idx.search(q).hits.filter((h) => h.matchKind === 'exact');
      expect(hits.map((h) => h.id), q).toEqual(['gaia:1']);
    }
    expect(merged[0]!.designations).toEqual(['Gaia DR3 1', 'HIP 1', 'HD 1', 'Starname', 'HR 7', 'Planet Host Alias']);
  });
  it('a proper name from a duplicate replaces an identifier used as the name', () => {
    expect(mergeRecords([gaia, hip]).records[0]!.name).toBe('Starname');
    const named = { ...gaia, name: 'Barnard' };
    expect(mergeRecords([named, hip]).records[0]!.name).toBe('Barnard');
  });
  it('distance and position come from a duplicate together, or not at all', () => {
    const lonely = rec('gaia:2', 'Gaia DR3 2', ['Gaia DR3 2'], 'star', { measurements: { apparentMag: { value: 7, kind: 'observed' } }, position: { kind: 'sky-only', raDeg: 1, decDeg: 2 }, drawn: false, sameAs: ['host:X'] });
    const h = rec('host:X', 'X', ['X'], 'exoplanet-host', { dataset: 'nasa-exoplanet-archive', position: { kind: 'icrs', xyzPc: [0, 20, 0], raDeg: 90, decDeg: 0 }, measurements: { distancePc: { value: 20, kind: 'derived', uncertainty: 1 }, absoluteMag: { value: 3, kind: 'derived' } } });
    const m = mergeRecords([lonely, h]).records[0]!;
    expect(m.position).toEqual(h.position);
    expect(m.measurements.distancePc).toEqual({ value: 20, kind: 'derived', uncertainty: 1, source: 'nasa-exoplanet-archive' });
    expect(m.measurements.absoluteMag!.source).toBe('nasa-exoplanet-archive');
    expect(m.drawn).toBe(false);                                                                       // what the Gaia layer can draw is unchanged
    const noPos = rec('host:Y', 'Y', ['Y'], 'exoplanet-host', { dataset: 'nasa-exoplanet-archive', measurements: { distancePc: { value: 5, kind: 'derived' } } });
    const lonely2 = { ...lonely, sameAs: ['host:Y'] };
    expect(mergeRecords([lonely2, noPos]).records[0]!.measurements.distancePc).toBeUndefined();         // a distance without a 3D position is not borrowed
    const withPos = mergeRecords([{ ...gaia, id: 'gaia:3', sameAs: ['host:Z'] }, rec('host:Z', 'Z', ['Z'], 'exoplanet-host', { dataset: 'nasa-exoplanet-archive', measurements: { distancePc: { value: 99, kind: 'derived' } }, position: { kind: 'icrs', xyzPc: [99, 0, 0], raDeg: 0, decDeg: 0 } })]).records[0]!;
    expect(withPos.measurements.distancePc!.value).toBe(10);                                           // the winner's own distance is never replaced
  });
  it('the link may be declared on either side, and chains merge into one record', () => {
    const a = rec('gaia:a', 'A', ['A'], 'star');
    const b = rec('hip:b', 'B', ['B'], 'star', { dataset: 'hipparcos', sameAs: ['gaia:a'] });
    const c = rec('host:c', 'C', ['C'], 'exoplanet-host', { dataset: 'nasa-exoplanet-archive', sameAs: ['hip:b'] });
    const r = mergeRecords([c, b, a]);
    expect(r.records.map((x) => x.id)).toEqual(['gaia:a']);
    expect(r.aliases.size).toBe(2);
    const reverse = mergeRecords([{ ...a, sameAs: ['host:c', 'hip:b'] }, b, c]);
    expect(reverse.records.map((x) => x.id)).toEqual(['gaia:a']);
  });
  it('priority without a Gaia record: Hipparcos, then the archive host', () => {
    expect(mergeRecords([host, hip]).records.map((x) => x.id)).toEqual(['hip:1']);
    const h2 = { ...host, sameAs: ['hip:1'] };
    const r = mergeRecords([h2, { ...hip, sameAs: [] }]);
    expect(r.records[0]!.id).toBe('hip:1');
    expect(r.records[0]!.sameAs).toEqual(['host:HD 1']);
  });
  it('a link to a record that is not loaded is kept as an unresolved sameAs and merges nothing', () => {
    const r = mergeRecords([hip]);
    expect(r.records).toHaveLength(1);
    expect(r.records[0]!.sameAs).toEqual(['gaia:1']);
    expect(r.aliases.size).toBe(0);
  });
  it('only stars merge: a sameAs between other categories is reported and ignored', () => {
    const g = rec('deep:x', 'X', ['X'], 'galaxy', { dataset: 'deep-space', sameAs: ['gaia:1'] });
    const r = mergeRecords([gaia, g]);
    expect(r.records).toHaveLength(2);
    expect(r.warnings[0]).toMatch(/only stars merge/);
    const ex = rec('exo:p', 'p', ['p'], 'exoplanet', { dataset: 'nasa-exoplanet-archive', sameAs: ['host:HD 1'] });
    expect(mergeRecords([host, ex]).records).toHaveLength(2);
  });
  it('an unclassified Gaia source joins a star of another dataset and becomes a star', () => {
    const unknown = rec('gaia:9', 'Gaia DR3 9', ['Gaia DR3 9'], 'other', { sameAs: [] });
    const star = rec('hip:9', 'HIP 9', ['HIP 9'], 'star', { dataset: 'hipparcos', sameAs: ['gaia:9'] });
    const r = mergeRecords([unknown, star]);
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({ id: 'gaia:9', category: 'star' });
    const twoOthers = mergeRecords([unknown, rec('gaia:8', 'Gaia DR3 8', ['Gaia DR3 8'], 'other', { sameAs: ['gaia:9'] })]);
    expect(twoOthers.records).toHaveLength(2);
  });
  it('duplicate ids keep the first and warn; unrelated records pass through unchanged and in order', () => {
    const r = mergeRecords([other, gaia, { ...other, name: 'impostor' }]);
    expect(r.records.map((x) => x.name)).toEqual(['M31', 'HD 1']);
    expect(r.warnings[0]).toMatch(/duplicate record id deep:m31/);
    expect(r.records[0]).toBe(other);
  });
  it('empty and singleton inputs', () => {
    expect(mergeRecords([])).toMatchObject({ records: [], merges: [], warnings: [] });
    expect(mergeRecords([other]).records).toEqual([other]);
  });
  it('does not mutate its input', () => {
    const before = JSON.stringify([gaia, hip, host]);
    mergeRecords([gaia, hip, host]);
    expect(JSON.stringify([gaia, hip, host])).toBe(before);
  });
});

describe.skipIf(!have('gaia-dr3-subset.v1.json.gz') || !have('bright-stars.v1.json.gz') || !have('exoplanets.v1.json.gz'))('the full atlas dataset, merged', () => {
  const { cat, simbad } = loadGaia();
  const gaia = recordsFromGaia(cat, simbad);
  const hip = recordsFromBrightStars(readGz<BrightStarFile>('bright-stars.v1.json.gz'));
  const exo = recordsFromExoplanets(readGz<ExoplanetFile>('exoplanets.v1.json.gz'));
  const merged = mergeRecords([...gaia, ...hip, ...exo]);
  it('Hipparcos stars that are in the Gaia subset are folded into the Gaia record, the rest stay as hip:', () => {
    expect(merged.warnings).toEqual([]);
    const hipKept = merged.records.filter((r) => r.dataset === 'hipparcos');
    const hipAbsorbed = merged.merges.flatMap((m) => m.absorbed).filter((id) => id.startsWith('hip:'));
    expect(hipKept.length + hipAbsorbed.length).toBe(hip.length);
    expect(hipAbsorbed.length).toBeGreaterThan(5000);
    expect(hipKept.length).toBeGreaterThan(250);                                    // stars the Gaia subset lacks (no Gaia source id in the file, or a source outside the subset)
    expect(hipKept.some((r) => r.name === 'Sirius')).toBe(true);
    expect(gaia.some((r) => r.name === 'Sirius')).toBe(false);
  });
  it('record ids stay unique and every absorbed id is an alias', () => {
    const ids = new Set(merged.records.map((r) => r.id));
    expect(ids.size).toBe(merged.records.length);
    for (const [alias, canon] of merged.aliases) { expect(ids.has(alias)).toBe(false); expect(ids.has(canon)).toBe(true); }
    expect(merged.records.length).toBe(gaia.length + hip.length + exo.length - merged.aliases.size);
  });
  it('a star in all three datasets is one record that finds every name', () => {
    const idx = new SearchIndex();
    idx.add(merged.records);
    const r = idx.search('HD 209458 b');
    expect(r.hits[0]!.id).toBe('exo:HD 209458 b');
    const host = idx.resolveDesignation('HD 209458');
    expect(host.length).toBeGreaterThanOrEqual(1);
    const store = RecordStore.from(merged.records);
    expect(store.keysWithData()).toContain('orbitalPeriodDays');
    expect(store.column('redshift')).toBeUndefined();                              // no redshift anywhere: not offered
  });
});
