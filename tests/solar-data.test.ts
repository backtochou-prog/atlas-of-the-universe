import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { labelPairs, parseElements, parseObjData, parseRotationPeriod, parseTriaxial, parseValue, parseVectors, objDataUrl } from '../src/data/solar/ingestion/horizons';
import { parseApproxPositionsTable1 } from '../src/data/solar/ingestion/jplApprox';
import { parsePck } from '../src/data/solar/ingestion/pck';
import { parseSatMeanElements } from '../src/data/solar/ingestion/satMean';
import { fitMeanLongitudeRate, sampleSpacingDays } from '../src/data/solar/ingestion/fit';
import { derivedMass, G } from '../src/data/solar/ingestion/build';
import { SolarSystemData, type TextureProvenanceEntry } from '../src/data/solar/solarCatalogue';
import { inspectObject } from '../src/data/catalogue/inspect';
import { validateDataset } from '../src/data/validate';
import { BODY_SPECS, MOON_CENTRES } from '../src/data/solar/bodies';
import type { SolarDatasetFile } from '../src/data/solar/types';
import type { Dataset } from '../src/data/schema';
import { ENHANCED_SCALE, TRUE_SCALE, describeScale, displayRadius, exaggeration, projectedPixelRadius } from '../src/core/solar/displayScale';

const fx = (n: string) => readFileSync(`tests/fixtures/solar/${n}`, 'utf8');

describe('Horizons value parsing', () => {
  it('parses plain values, uncertainties in all JPL spellings, approximations and decimal scale factors', () => {
    expect(parseValue('6371.01+-0.02')).toMatchObject({ value: 6371.01, uncertainty: 0.02, approximate: false });
    expect(parseValue('1560.8   +- 0.3')).toMatchObject({ value: 1560.8, uncertainty: 0.3 });
    expect(parseValue('0.67 +/- 0.03')).toMatchObject({ value: 0.67, uncertainty: 0.03 });
    expect(parseValue('1.3262 +- .0003')).toMatchObject({ value: 1.3262, uncertainty: 0.0003 });
    expect(parseValue('~1988410')).toMatchObject({ value: 1988410, approximate: true });
    expect(parseValue('1.08 (10^-4)')!.value).toBeCloseTo(1.08e-4, 15);
    expect(parseValue('9.3772(10^3)')!.value).toBeCloseTo(9377.2, 9);
  });
  it('returns undefined for text it does not understand rather than a wrong number', () => {
    expect(parseValue('Synchronous')).toBeUndefined();
    expect(parseValue('')).toBeUndefined();
    expect(parseValue('n/a')).toBeUndefined();
  });
  it('parses triaxial radii and rotation periods in every format JPL uses', () => {
    expect(parseTriaxial('13.1 x11.1 x9.3')).toEqual([13.1, 11.1, 9.3]);
    expect(parseTriaxial('2575.5')).toBeUndefined();
    expect(parseRotationPeriod('24.622962 hr').hours!.value).toBeCloseTo(24.622962, 9);
    expect(parseRotationPeriod('58.6463 d').hours!.value).toBeCloseTo(58.6463 * 24, 6);
    expect(parseRotationPeriod('17.24+-0.01 h').hours).toMatchObject({ value: 17.24, uncertainty: 0.01 });
    expect(parseRotationPeriod('9h 55m 29.711 s').hours!.value).toBeCloseTo(9 + 55 / 60 + 29.711 / 3600, 9);
    expect(parseRotationPeriod('Synchronous').synchronous).toBe(true);
    expect(parseRotationPeriod('').hours).toBeUndefined();
  });
  it('does not mistake a lower-case unit for the start of the next label (regression: "d    Escape vel.")', () => {
    const pairs = labelPairs('  Sidereal orb. per.    = 87.969257  d    Escape vel. km/s      =  4.435');
    expect(pairs).toEqual([{ label: 'Sidereal orb. per.', raw: '87.969257  d' }, { label: 'Escape vel. km/s', raw: '4.435' }]);
  });
  it('splits two pairs joined by a single space (regression: Venus density, rotation rate)', () => {
    const pairs = labelPairs('  Vol. Mean Radius (km) =  6051.84+-0.01 Density (g/cm^3)      =  5.204');
    expect(pairs.map((p) => p.label)).toEqual(['Vol. Mean Radius (km)', 'Density (g/cm^3)']);
    expect(pairs[1]!.raw).toBe('5.204');
  });
  it('builds Horizons URLs for each request type', () => {
    expect(objDataUrl('599')).toContain("COMMAND='599'");
    expect(objDataUrl('599')).toContain("OBJ_DATA='YES'");
  });
});

describe('Horizons physical data (real captured responses)', () => {
  const p = (id: number) => parseObjData(fx(`horizons_obj_${id}.txt`));
  it('reads Earth: radius with uncertainty, mass with its exponent, GM, density, rotation and temperature', () => {
    const e = p(399);
    expect(e.meanRadiusKm).toMatchObject({ value: 6371.01, uncertainty: 0.02 });
    expect(e.massKg!.value).toBeCloseTo(5.97219e24, -12);
    expect(e.massKg!.uncertainty).toBeCloseTo(6e20, -15);
    expect(e.gmKm3S2).toMatchObject({ value: 398600.435436, uncertainty: 0.0014 });
    expect(e.densityGcm3!.value).toBe(5.51);
    expect(e.rotationPeriodHours!.value).toBeCloseTo(23.9344695944, 9);
    expect(e.meanTemperatureK!.value).toBe(287.6);
    expect(e.flattening!.value).toBeCloseTo(1 / 298.257223563, 12);
  });
  it('applies the (10^-4) scale factor to Phobos’s mass (regression: a 10,000x error was caught by reading the raw text)', () => {
    expect(p(401).massKg!.value).toBeCloseTo(1.08e16, -5);
    expect(p(401).triaxialRadiiKm).toEqual([13.1, 11.1, 9.3]);
    expect(p(401).synchronousRotation).toBe(true);
  });
  it('reads giant planets exactly (no floating-point noise from the exponent)', () => {
    expect(p(599).massKg!.value).toBe(1.89819e27);
    expect(p(599).equatorialRadiusKm).toMatchObject({ value: 71492, uncertainty: 4 });
    expect(p(699).densityGcm3).toMatchObject({ value: 0.687, uncertainty: 0.001 });
  });
  it('detects retrograde rotation from the sign of the rotation rate (Venus, Uranus)', () => {
    expect(p(299).rotationSense).toBe(-1);
    expect(p(799).rotationSense).toBe(-1);
    expect(p(399).rotationSense).toBe(1);
    expect(p(299).rotationPeriodHours!.value).toBeCloseTo(243.018484 * 24, 3);
  });
  it('reads satellites: GM and density with uncertainties, synchronous rotation', () => {
    const eu = p(502);
    expect(eu.meanRadiusKm).toMatchObject({ value: 1560.8, uncertainty: 0.3 });
    expect(eu.gmKm3S2).toMatchObject({ value: 3202.7121, uncertainty: 0.0054 });
    expect(eu.densityGcm3).toMatchObject({ value: 3.013, uncertainty: 0.005 });
    expect(eu.synchronousRotation).toBe(true);
    expect(eu.massKg).toBeUndefined(); // JPL prints no mass for Europa: it must be derived, not invented
  });
  it('reads the Sun: IAU nominal luminosity, effective temperature and an approximate mass flagged as such', () => {
    const s = p(10);
    expect(s.luminosityW!.value).toBeCloseTo(3.828e26, -20);
    expect(s.effectiveTemperatureK!.value).toBe(5772);
    expect(s.massKg!.approximate).toBe(true);
    expect(s.rotationPeriodHours!.value).toBeCloseTo(25.38 * 24, 6);
  });
  it('reads a plain "Radius (km)" label as the mean radius (Iapetus), and not when the radii are triaxial (Phobos)', () => {
    const iap = parseObjData("*******\n Revised: Jan 26, 2022   Iapetus / (Saturn)   608\n  Radius (km)            = 734.5    +- 4.0    Density (g/cm^3)=  1.088 +- 0.018 \n  GM (km^3/s^2)          = 120.52   +- 0.03   V(1,0)          =   +1.5 (.7-2.5)\n*******");
    expect(iap.meanRadiusKm).toMatchObject({ value: 734.5, uncertainty: 4 });
    expect(iap.radiusFromPlainLabel).toBe(true);
    expect(parseObjData(readFileSync('tests/fixtures/solar/horizons_obj_401.txt', 'utf8')).meanRadiusKm).toBeUndefined();
  });
  it('reads the obliquity in arcminutes for Mercury and degrees elsewhere', () => {
    expect(p(199).obliquityDeg!.value).toBeCloseTo(2.11 / 60, 9);
    expect(p(799).obliquityDeg!.value).toBeCloseTo(97.77, 9);
  });
  it('parses orbital periods whether the unit is in the value or in the label', () => {
    expect(p(199).siderealOrbitPeriodDays!.value).toBeCloseTo(87.969257, 9);
    expect(p(299).siderealOrbitPeriodDays!.value).toBeCloseTo(224.70079922, 9);
    expect(p(399).siderealOrbitPeriodDays!.value).toBeCloseTo(365.25636, 9);
  });
});

describe('Horizons ELEMENTS and VECTORS tables (real responses)', () => {
  it('parses osculating elements', () => {
    const el = parseElements(fx('elem_502.txt'));
    expect(el).toHaveLength(1); // single-epoch fixture
    const first = el[0]!;
    expect(first.a).toBeGreaterThan(6.6e5); expect(first.a).toBeLessThan(6.8e5); // Europa about Jupiter, km
    expect(first.e).toBeGreaterThan(0); expect(first.e).toBeLessThan(0.02);
    expect(first.inclinationDeg).toBeGreaterThan(24); expect(first.inclinationDeg).toBeLessThan(27); // to the ICRF equator
  });
  it('parses state vectors and returns one record per requested time', () => {
    const v = parseVectors(fx('vec_501_jup.txt'));
    expect(v.length).toBeGreaterThanOrEqual(8);
    for (const r of v) {
      const dist = Math.hypot(...r.position);
      expect(dist).toBeGreaterThan(4.0e5); expect(dist).toBeLessThan(4.4e5); // Io about Jupiter
    }
  });
  it('rejects a response with no ephemeris block (a failed request) instead of returning nothing', () => {
    expect(() => parseVectors('API ERROR: bad command')).toThrow(/SOE/);
    expect(() => parseElements('nothing here')).toThrow(/SOE/);
  });
});

describe('JPL approximate-positions Table 1', () => {
  const t = parseApproxPositionsTable1(fx('approx_pos.html'));
  it('has all eight rows with the published elements and rates', () => {
    expect(Object.keys(t).sort()).toEqual(['EM Bary', 'Jupiter', 'Mars', 'Mercury', 'Neptune', 'Saturn', 'Uranus', 'Venus']);
    expect(t.Mercury.a).toEqual([0.38709927, 0.00000037]);
    expect(t['EM Bary'].e[0]).toBe(0.01671123);
    expect(t.Jupiter.L).toEqual([34.39644051, 3034.74612775]);
    expect(t.Neptune.longNode[1]).toBe(-0.00508664);
  });
  it('reads Table 1 (1800-2050) and not Table 2a', () => {
    expect(t.Mercury.I[0]).toBe(7.00497902); // Table 2a would give 7.00559432
  });
  it('fails loudly if the page layout changes', () => {
    expect(() => parseApproxPositionsTable1('<html>nothing</html>')).toThrow(/Table 1/);
  });
});

describe('NAIF PCK', () => {
  const pck = parsePck(fx('pck_subset.tpc'));
  it('reads IAU pole and prime-meridian elements', () => {
    expect(pck.get(399)!.poleRa).toEqual([0, -0.641, 0]);
    expect(pck.get(399)!.pm![1]).toBeCloseTo(360.9856235, 9);
    expect(pck.get(599)!.poleRa![0]).toBeCloseTo(268.056595, 9);
    expect(pck.get(799)!.pm![1]).toBeLessThan(0); // Uranus: retrograde under the IAU positive-pole rule
  });
  it('understands Fortran D exponents', () => {
    expect(pck.get(301)!.pm![2]).toBeCloseTo(-1.4e-12, 20);
  });
});

describe('satellite mean elements (JPL SSD)', () => {
  const rows = parseSatMeanElements(fx('sats_elem_subset.txt'));
  it('reads satellites with their NAIF id, mean period, mean a and reference frame', () => {
    const moon = rows.find((r) => r.naifId === 301)!;
    expect(moon).toMatchObject({ planet: 'Earth', satellite: 'Moon', frame: 'ecliptic' });
    expect(moon.periodDays).toBeCloseTo(27.322, 3);
    const io = rows.find((r) => r.naifId === 501)!;
    expect(io.periodDays).toBeCloseTo(1.762732, 6);
    expect(io.aKm).toBe(421800);
  });
});

describe('mean-longitude fit', () => {
  it('recovers a known rate through wrapped angles and short-period oscillation', () => {
    const rate = 203.4889538, samples = [];
    for (let k = 0; k < 121; k++) {
      const t = k * 8.8;
      const lam = 40 + rate * t + 2.5 * Math.sin(0.7 * t); // oscillation of 2.5 deg
      const wrapped = ((lam % 360) + 360) % 360;
      samples.push({ jdTdb: 2461000 + t, nodeDeg: 100, argPeriDeg: 50, meanAnomalyDeg: ((wrapped - 150) % 360 + 360) % 360 });
    }
    const fit = fitMeanLongitudeRate(samples, rate * 1.003); // a 0.3% wrong guess must still resolve the revolutions
    expect(fit.rateDegPerDay).toBeCloseTo(rate, 3);
    expect(fit.rmsDeg).toBeLessThan(3);
    expect(fit.periodDays).toBeCloseTo(360 / rate, 5);
  });
  it('needs enough samples and chooses sample spacing from the period', () => {
    expect(() => fitMeanLongitudeRate([], 1)).toThrow();
    expect(sampleSpacingDays(0.32)).toBe(1.6);
    expect(sampleSpacingDays(79)).toBe(30);
    expect(sampleSpacingDays(0.01)).toBe(0.5);
  });
});

describe('derived quantities', () => {
  it('derives a mass from GM and G, with G’s uncertainty dominating the error', () => {
    const d = derivedMass(398600.435436, 0.0014);
    expect(d.value).toBeCloseTo(5.9722e24, -20);
    expect(d.uncertainty / d.value).toBeGreaterThan(2e-5);
    expect(d.uncertainty / d.value).toBeLessThan(3e-5);
    expect(G.value).toBe(6.6743e-11);
  });
});

describe('the built Solar System dataset', () => {
  const path = 'public/data/solar-system.v1.json';
  const run = existsSync(path);
  const file = run ? (JSON.parse(readFileSync(path, 'utf8')) as SolarDatasetFile) : null;
  const texPath = 'public/textures/provenance.json';
  const textures = existsSync(texPath) ? (JSON.parse(readFileSync(texPath, 'utf8')).textures as TextureProvenanceEntry[]) : [];
  const data = file ? SolarSystemData.fromFile(file, textures) : null;

  (run ? it : it.skip)('contains the Sun, eight planets and the requested moons', () => {
    const ids = file!.bodies.map((b) => b.id);
    for (const id of ['sun', 'mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'moon', 'phobos', 'deimos', 'io', 'europa', 'ganymede', 'callisto', 'titan', 'enceladus', 'triton']) expect(ids).toContain(id);
    expect(file!.bodies.filter((b) => b.kind === 'planet')).toHaveLength(8);
  });
  (run ? it : it.skip)('has a consistent parent-child hierarchy: every body has a known parent, moons orbit planets, planets orbit the Sun', () => {
    const byId = new Map(file!.bodies.map((b) => [b.id, b]));
    for (const b of file!.bodies) {
      if (b.id === 'sun') { expect(b.parent).toBeNull(); continue; }
      expect(byId.has(b.parent!), `${b.id} -> ${b.parent}`).toBe(true);
      if (b.kind === 'planet') expect(b.parent).toBe('sun');
      if (b.kind === 'moon') expect(byId.get(b.parent!)!.kind).toBe('planet');
    }
    expect(data!.children('jupiter').map((c) => c.id)).toEqual(expect.arrayContaining(['io', 'europa', 'ganymede', 'callisto']));
    expect(MOON_CENTRES['io']).toBe('@599');
    expect(BODY_SPECS.map((b) => b.id)).toEqual(file!.bodies.map((b) => b.id));
  });
  (run ? it : it.skip)('gives every measurement a unit, category, source and retrieval date, and records transformations for derived values', () => {
    for (const b of file!.bodies) {
      for (const [k, m] of Object.entries(b.physical)) {
        expect(m.unit, `${b.id}.${k}`).toBeTruthy();
        expect(['observed', 'derived', 'modelled', 'hypothetical']).toContain(m.kind);
        expect(m.source.source, `${b.id}.${k}`).toBeTruthy();
        expect(m.source.retrieved, `${b.id}.${k}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        if (m.kind === 'derived') expect(m.transformations?.length, `${b.id}.${k}`).toBeGreaterThan(0);
      }
    }
  });
  (run ? it : it.skip)('passes the dataset validator (units, finite values, positive radii and masses)', () => {
    const ds: Dataset = { id: 's', title: 's', source: { source: 'jpl', retrieved: '2026-11-12' }, licence: 'NASA/JPL public data', objects: file!.bodies.map((b) => data!.toObject(b.id)) };
    expect(validateDataset(ds)).toEqual([]);
  });
  (run ? it : it.skip)('has physically sensible values: Earth radius, Jupiter mass, Ganymede larger than Mercury, Sun luminosity', () => {
    expect(data!.physical('earth', 'mean_radius')!.value).toBeCloseTo(6371.01, 2);
    expect(data!.physical('jupiter', 'mass')!.value).toBeCloseTo(1.89819e27, -22);
    expect(data!.physical('ganymede', 'mean_radius')!.value).toBeGreaterThan(data!.physical('mercury', 'mean_radius')!.value);
    expect(data!.physical('sun', 'luminosity')!.value).toBeCloseTo(3.828e26, -20);
    expect(data!.get('sun')!.spectralType?.value).toBe('G2V');
    expect(data!.get('sun')!.spectralType?.source).toMatch(/NASA/); // SIMBAD does not catalogue the Sun
  });
  (run ? it : it.skip)('derives surface gravity as GM/R^2 and checks it against JPL’s published equatorial gravity', () => {
    const g = data!.physical('earth', 'surface_gravity')!;
    expect(g.kind).toBe('derived');
    expect(g.value).toBeCloseTo(9.82, 1); // mean-radius gravity
    expect(Math.abs(g.value - data!.physical('earth', 'equatorial_gravity')!.value) / g.value).toBeLessThan(0.01);
    expect(data!.physical('jupiter', 'surface_gravity')!.value).toBeGreaterThan(20);
  });
  (run ? it : it.skip)('derives a mass where JPL prints none and labels it derived (Europa)', () => {
    const m = data!.physical('europa', 'mass')!;
    expect(m.kind).toBe('derived');
    expect(m.value).toBeCloseTo(4.8e22, -21);
    expect(m.transformations![0]).toMatch(/GM \/ G/);
  });
  (run ? it : it.skip)('marks Venus and Uranus rotation as retrograde and satellites as synchronous', () => {
    expect(data!.physical('venus', 'rotation_period')!.note).toMatch(/Retrograde/);
    expect(data!.get('venus')!.rotation!.primeMeridian[1]).toBeLessThan(0);
    expect(data!.get('io')!.synchronousRotation).toBe(true);
    expect(data!.get('moon')!.synchronousRotation).toBe(true);
    expect(data!.get('triton')!.orbit).toBeDefined();
  });
  (run ? it : it.skip)('records what JPL does not publish as unavailable with a reason, never as a number', () => {
    const ph = data!.get('phobos')!;
    expect(ph.triaxialRadiiKm).toEqual([13.1, 11.1, 9.3]);
    expect(ph.physical['mean_radius']!.kind).toBe('derived'); // from the triaxial radii
    expect(ph.physical['temperature']).toBeUndefined();
    expect(ph.unavailable['temperature']).toMatch(/JPL lists no/);
  });
  (run ? it : it.skip)('labels every contextual fact as observed, inferred or hypothesis and cites a reference', () => {
    for (const b of file!.bodies) for (const f of b.facts) {
      expect(['observed', 'inferred', 'hypothesis']).toContain(f.status);
      expect(f.reference.length).toBeGreaterThan(5);
    }
    const europa = data!.get('europa')!.facts;
    const ocean = europa.find((f) => /ocean/i.test(f.text) && /magnetometer/i.test(f.text))!;
    expect(ocean.status).toBe('inferred'); // not "observed": the ocean has not been directly seen
    expect(ocean.text).toMatch(/not been observed directly/);
    expect(europa.some((f) => f.status === 'hypothesis')).toBe(true);
    expect(data!.get('triton')!.facts.find((f) => /captured/.test(f.text))!.status).toBe('hypothesis');
  });
  (run ? it : it.skip)('recorded a reachable reference URL for every cited source', () => {
    const checks = Object.values(file!.manifest.referenceChecks);
    expect(checks.length).toBeGreaterThan(10);
    expect(checks.every((s) => s === 200)).toBe(true);
  });
  (run ? it : it.skip)('records validation against JPL Horizons, with zero satellite error at the epoch', () => {
    const v = file!.manifest.validation;
    expect(v.length).toBeGreaterThan(100);
    for (const r of v.filter((x) => x.label === 'epoch')) expect(r.relativeError, r.body).toBeLessThan(1e-5);
  });
  (run ? it : it.skip)('feeds the inspector with sourced fields and omits quantities that do not apply', () => {
    const m = inspectObject(data!.toObject('europa'));
    const keys = m.sections.flatMap((s) => s.fields.map((f) => f.key));
    expect(keys).toEqual(expect.arrayContaining(['mean_radius', 'mass', 'density', 'surface_gravity', 'rotation_period', 'orbital_period', 'semi_major_axis']));
    expect(keys).not.toContain('luminosity');
    expect(m.classification).toBe('Natural satellite');
    expect(m.facts.length).toBeGreaterThan(1);
    const mass = m.sections.flatMap((s) => s.fields).find((f) => f.key === 'mass')!;
    expect(mass.kind).toBe('derived');
    expect(mass.transformations![0]).toMatch(/GM \/ G/);
  });
});

describe('texture provenance', () => {
  const texPath = 'public/textures/provenance.json';
  const run = existsSync(texPath);
  const tex = run ? (JSON.parse(readFileSync(texPath, 'utf8')).textures as (TextureProvenanceEntry & Record<string, unknown>)[]) : [];

  (run ? it : it.skip)('documents source, original asset, licence, resolution, projection, processing and use for every texture', () => {
    expect(tex.length).toBeGreaterThanOrEqual(15);
    for (const t of tex) {
      for (const k of ['source', 'asset', 'license', 'projection', 'processing', 'use', 'fidelity', 'credit', 'original_sha256']) expect(t[k], `${t.id}.${k}`).toBeTruthy();
      expect(t['original_size'], t.id).toHaveLength(2);
    }
  });
  (run ? it : it.skip)('labels artistic composites honestly and never claims them as scientific maps', () => {
    for (const id of ['mars', 'saturn', 'uranus', 'neptune', 'venus']) {
      const t = tex.find((x) => x.id === id)!;
      expect(t.fidelity, id).toBe('artistic-composite');
      expect(String(t['license'])).toMatch(/CC BY 4\.0/);
    }
    for (const id of ['moon', 'jupiter', 'io', 'europa', 'ganymede', 'callisto', 'enceladus', 'triton']) expect(tex.find((x) => x.id === id)!.fidelity, id).toBe('scientific-map');
    expect(tex.find((x) => x.id === 'earth_day')!.fidelity).toBe('derived');
    expect(String(tex.find((x) => x.id === 'earth_day')!['note'])).toMatch(/ART-DIRECTED/);
  });
  (run ? it : it.skip)('the dataset reports the least-faithful layer when describing a body’s imagery', () => {
    const data = SolarSystemData.fromFile(JSON.parse(readFileSync('public/data/solar-system.v1.json', 'utf8')), tex);
    expect(data.imageryNote('saturn').fidelity).toBe('artistic-composite');
    expect(data.imageryNote('earth').fidelity).toBe('artistic-composite'); // night lights layer is stylised, so the whole appearance is described that way
    expect(data.imageryNote('europa').fidelity).toBe('scientific-map');
    expect(data.imageryNote('titan').fidelity).toBe('none');
    expect(data.imageryNote('titan').summary).toMatch(/visualisation choice/);
  });
  (run ? it : it.skip)('has output files at two resolutions for each map', () => {
    for (const t of tex.filter((x) => !x['ring'])) {
      const outs = t.outputs as Record<string, { file: string; size: number[] }>;
      expect(outs['2k']!.size).toEqual([2048, 1024]);
      expect(outs['512']!.size).toEqual([512, 256]);
      expect(existsSync(`public/${outs['2k']!.file}`), t.id).toBe(true);
    }
  });
});

describe('display scale is separate from physical scale', () => {
  const R = 6.371e6;
  it('never changes the physical radius and is exactly physical in true-scale mode', () => {
    for (const d of [1e7, 1e9, 1e12]) expect(displayRadius(R, d, Infinity, TRUE_SCALE)).toBe(R);
  });
  it('never draws a body smaller than it is', () => {
    for (const d of [1, 1e6, 1e9, 1e12, 1e14]) expect(displayRadius(R, d, 1e9, ENHANCED_SCALE)).toBeGreaterThanOrEqual(R);
  });
  it('leaves a body alone when it is already large enough on screen', () => {
    expect(displayRadius(R, 2e7, Infinity, ENHANCED_SCALE)).toBe(R); // 0.32 rad apparent radius
  });
  it('enlarges a small distant body to the minimum angular size, up to the cap', () => {
    const d = 1e10; // wanted = 4e7 (6.3x)
    expect(displayRadius(R, d, Infinity, ENHANCED_SCALE)).toBeCloseTo(0.004 * d, 3);
  });
  it('limits enlargement to a fraction of the clearance so Earth cannot swallow its Moon’s orbit', () => {
    const r = displayRadius(R, 1.5e11, 3.844e8, ENHANCED_SCALE);
    expect(r).toBeLessThanOrEqual(0.2 * 3.844e8 + 1);
    expect(r).toBeGreaterThan(R);
  });
  it('caps the enlargement factor', () => {
    expect(exaggeration(R, displayRadius(R, 1e15, Infinity, ENHANCED_SCALE))).toBeLessThanOrEqual(ENHANCED_SCALE.maxFactor);
  });
  it('reports clearly whether the picture is to scale', () => {
    expect(describeScale(TRUE_SCALE, 50).notToScale).toBe(false);
    expect(describeScale(ENHANCED_SCALE, 1.01).notToScale).toBe(false);
    const s = describeScale(ENHANCED_SCALE, 37);
    expect(s.notToScale).toBe(true);
    expect(s.label).toMatch(/NOT to scale/);
    expect(s.label).toMatch(/37/);
  });
  it('computes projected pixel radius and refuses a non-positive radius', () => {
    const half = Math.tan((50 * Math.PI) / 360);
    expect(projectedPixelRadius(1, 100, half, 800)).toBeCloseTo((1 / 100 / half) * 400, 9);
    expect(() => displayRadius(0, 1, 1, ENHANCED_SCALE)).toThrow();
  });
});
