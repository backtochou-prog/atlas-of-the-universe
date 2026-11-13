import type { Measurement, MeasurementKind, SourceRef } from '../../schema';
import type { EphemerisBody, OrbitDefinition, OsculatingOrbit } from '../../../core/orbits/types';
import type { RotationElements } from '../../../core/orbits/rotation';
import { BODY_SPECS, MOON_CENTRES, type BodySpec } from '../bodies';
import { SOLAR_FORMAT, SOLAR_FORMAT_VERSION, type OrbitSource, type SolarBodyRecord, type SolarDatasetFile, type SolarManifest, type SourceNote, type ValidationRow } from '../types';
import { parseObjData, type HorizonsElements, type HorizonsPhysical, type ParsedValue } from './horizons';
import { parseApproxPositionsTable1, type ApproxPlanetName } from './jplApprox';
import { parsePck, type PckBody } from './pck';
import { parseSatMeanElements, type SatMeanElements } from './satMean';
import { objDataUrl } from './horizons';
import type { MeanLongitudeFit } from './fit';

/** CODATA 2018 Newtonian constant of gravitation, used to derive a mass from GM where JPL prints no mass. */
export const G = { value: 6.6743e-11, uncertainty: 1.5e-15, unit: 'm3 kg-1 s-2', source: 'CODATA 2018 (Tiesinga et al. 2021)' } as const;

export interface SolarInputs {
  /** YYYY-MM-DD of retrieval. */
  readonly retrieved: string;
  readonly referenceJdTdb: number;
  readonly referenceIso: string;
  readonly approxHtml: string;
  readonly pckText: string;
  readonly satElemHtml: string;
  /** Raw Horizons OBJ_DATA text by NAIF id. */
  readonly objData: Readonly<Record<number, string>>;
  /** Horizons osculating elements at the reference epoch by body id (moons). */
  readonly moonElements: Readonly<Record<string, HorizonsElements>>;
  /** Mean-longitude fits by body id (satellites). */
  readonly moonFits?: Readonly<Record<string, MeanLongitudeFit>>;
  /** Spectral type of the Sun with its source (SIMBAD does not catalogue the Sun, so it comes from NASA). */
  readonly sunSpectralType?: { readonly value: string; readonly source: string; readonly url: string };
}

const KM3S2_TO_M3S2 = 1e9;

function ref(naifId: number, retrieved: string): SourceRef {
  return { source: 'jpl-horizons', recordId: String(naifId), url: objDataUrl(String(naifId)), retrieved };
}

export function derivedMass(gmKm3S2: number, gmUnc: number | undefined): { value: number; uncertainty: number } {
  const value = (gmKm3S2 * KM3S2_TO_M3S2) / G.value;
  const relGm = gmUnc !== undefined ? gmUnc / gmKm3S2 : 0;
  const rel = Math.hypot(relGm, G.uncertainty / G.value);
  return { value, uncertainty: value * rel };
}

function measurement(value: ParsedValue | { value: number; uncertainty?: number }, unit: string, kind: MeasurementKind, source: SourceRef, extra: Partial<Measurement> = {}): Measurement {
  return {
    value: value.value, unit, kind, source,
    ...(value.uncertainty !== undefined ? { uncertainty: value.uncertainty } : {}),
    ...extra,
  };
}

function physicalFor(spec: BodySpec, p: HorizonsPhysical, retrieved: string, extras: { orbitalPeriodDays?: number; meanA?: SatMeanElements }): { physical: Record<string, Measurement>; unavailable: Record<string, string>; triaxial?: readonly [number, number, number]; synchronous: boolean } {
  const src = ref(spec.naifId, retrieved);
  const m: Record<string, Measurement> = {};
  const unavailable: Record<string, string> = {};
  const missing = (key: string, why = 'JPL does not publish this quantity for this body.') => { if (!m[key]) unavailable[key] = why; };
  const approx = (v: ParsedValue) => (v.approximate ? { note: 'JPL marks this value as approximate (~).' } : {});

  if (p.meanRadiusKm) m['mean_radius'] = measurement(p.meanRadiusKm, 'km', 'observed', src, p.radiusFromPlainLabel ? { note: 'JPL lists this as "Radius (km)"; taken as the mean radius.' } : approx(p.meanRadiusKm));
  else if (p.triaxialRadiiKm) {
    const [a, b, c] = p.triaxialRadiiKm;
    m['mean_radius'] = { value: Math.cbrt(a * b * c), unit: 'km', kind: 'derived', source: src, transformations: ['JPL gives triaxial radii a x b x c; mean radius = (a b c)^(1/3)'], note: `Irregular body with radii ${a} x ${b} x ${c} km (JPL).` };
  }
  if (p.equatorialRadiusKm) m['equatorial_radius'] = measurement(p.equatorialRadiusKm, 'km', 'observed', src);
  if (p.polarRadiusKm) m['polar_radius'] = measurement(p.polarRadiusKm, 'km', 'observed', src);
  if (p.flattening) m['flattening'] = measurement(p.flattening, 'dimensionless', 'observed', src);
  if (p.gmKm3S2) m['gm'] = measurement(p.gmKm3S2, 'km3/s2', 'observed', src);

  if (p.massKg) m['mass'] = measurement(p.massKg, 'kg', 'observed', src, approx(p.massKg));
  else if (p.gmKm3S2) {
    const d = derivedMass(p.gmKm3S2.value, p.gmKm3S2.uncertainty);
    m['mass'] = {
      value: d.value, uncertainty: d.uncertainty, unit: 'kg', kind: 'derived', source: src,
      transformations: [`mass = GM / G with JPL GM and G = ${G.value} m3 kg-1 s-2 (${G.source})`],
      note: 'JPL prints no mass for this body; the uncertainty includes the uncertainty of G, which dominates.',
    };
  }

  if (p.densityGcm3) m['density'] = measurement(p.densityGcm3, 'g/cm3', 'observed', src);
  else if (m['mass'] && m['mean_radius']) {
    const r = m['mean_radius'].value * 1000;
    m['density'] = { value: m['mass'].value / ((4 / 3) * Math.PI * r ** 3) / 1000, unit: 'g/cm3', kind: 'derived', source: src, transformations: ['density = mass / (4/3 pi R^3) using the mean radius'] };
  }
  if (p.geometricAlbedo) m['geometric_albedo'] = measurement(p.geometricAlbedo, 'dimensionless', 'observed', src);

  if (m['mean_radius']) {
    const r = m['mean_radius'].value * 1000;
    if (p.gmKm3S2) m['surface_gravity'] = { value: (p.gmKm3S2.value * KM3S2_TO_M3S2) / (r * r), unit: 'm/s2', kind: 'derived', source: src, transformations: ['g = GM / R^2 with the mean radius; ignores rotation and oblateness'] };
    else if (m['mass']) m['surface_gravity'] = { value: (G.value * m['mass'].value) / (r * r), unit: 'm/s2', kind: 'derived', source: src, transformations: [`g = G m / R^2 with the published mass, G = ${G.value}, and the mean radius; ignores rotation and shape`], note: 'JPL prints no GM for this body.' };
  }
  if (p.equatorialGravityMs2) m['equatorial_gravity'] = measurement(p.equatorialGravityMs2, 'm/s2', 'observed', src);
  if (p.escapeVelocityKmS) m['escape_velocity'] = measurement(p.escapeVelocityKmS, 'km/s', 'observed', src);
  if (p.obliquityDeg) m['obliquity'] = measurement(p.obliquityDeg, 'deg', 'observed', src, { note: 'Angle between the rotation axis and the orbit normal (the Sun: to the ecliptic).' });
  if (p.meanTemperatureK) m['temperature'] = measurement(p.meanTemperatureK, 'K', 'observed', src, { note: 'Mean surface temperature, or the temperature at the 1-bar level for giant planets (definition varies by body, as listed by JPL).' });
  if (p.effectiveTemperatureK) m['effective_temperature'] = measurement(p.effectiveTemperatureK, 'K', 'observed', src, { note: 'IAU 2015 nominal effective temperature.' });
  if (p.luminosityW) m['luminosity'] = measurement(p.luminosityW, 'W', 'observed', src, { note: 'IAU 2015 nominal solar luminosity.' });

  let synchronous = false;
  const period = extras.meanA?.periodDays ?? p.siderealOrbitPeriodDays?.value ?? extras.orbitalPeriodDays;
  if (p.rotationPeriodHours) {
    const retro = p.rotationSense === -1;
    m['rotation_period'] = measurement(p.rotationPeriodHours, 'h', 'observed', src, { note: retro ? 'Retrograde rotation (opposite to the orbital direction).' : 'Sidereal rotation period.' });
  } else if (p.synchronousRotation && period) {
    synchronous = true;
    m['rotation_period'] = { value: period * 24, unit: 'h', kind: 'derived', source: src, transformations: ['JPL lists the rotation as synchronous, so the rotation period equals the orbital period'] };
  } else if (p.rotationRateRadS) {
    m['rotation_period'] = { value: (2 * Math.PI) / Math.abs(p.rotationRateRadS.value) / 3600, unit: 'h', kind: 'derived', source: src, transformations: ['rotation period = 2 pi / |rotation rate| from JPL'] };
    if (spec.kind === 'moon') synchronous = true;
  }
  if (p.synchronousRotation) synchronous = true;

  if (spec.kind === 'planet' && p.siderealOrbitPeriodDays) {
    m['orbital_period'] = measurement(p.siderealOrbitPeriodDays, 'd', 'observed', src, { note: 'Sidereal orbital period.' });
  }
  if (spec.kind === 'moon' && extras.meanA) {
    const sat = extras.meanA;
    const s2: SourceRef = { source: 'jpl-ssd-satellite-mean-elements', recordId: String(sat.naifId), url: 'https://ssd.jpl.nasa.gov/sats/elem/', retrieved };
    m['orbital_period'] = { value: sat.periodDays, unit: 'd', kind: 'observed', source: s2, note: `JPL mean sidereal period (epoch ${sat.epoch}, frame ${sat.frame}).` };
    m['semi_major_axis'] = { value: sat.aKm, unit: 'km', kind: 'observed', source: s2, note: 'JPL mean semi-major axis about the parent planet.' };
    m['eccentricity'] = { value: sat.e, unit: 'dimensionless', kind: 'observed', source: s2, note: 'JPL mean eccentricity.' };
  }

  for (const k of ['mean_radius', 'mass', 'density', 'surface_gravity', 'rotation_period']) missing(k);
  if (spec.kind !== 'star') { missing('geometric_albedo'); missing('temperature', 'JPL lists no representative temperature for this body.'); }
  return { physical: m, unavailable, ...(p.triaxialRadiiKm ? { triaxial: p.triaxialRadiiKm } : {}), synchronous };
}

function rotationFor(pck: PckBody | undefined): RotationElements | undefined {
  if (!pck?.poleRa || !pck.poleDec || !pck.pm) return undefined;
  return { poleRa: [pck.poleRa[0]!, pck.poleRa[1] ?? 0], poleDec: [pck.poleDec[0]!, pck.poleDec[1] ?? 0], primeMeridian: [pck.pm[0]!, pck.pm[1]!] };
}

export function buildSolarBodies(inp: SolarInputs): { bodies: SolarBodyRecord[]; sources: SourceNote[] } {
  const approx = parseApproxPositionsTable1(inp.approxHtml);
  const pck = parsePck(inp.pckText);
  const sats = parseSatMeanElements(inp.satElemHtml);
  const bodies: SolarBodyRecord[] = [];

  for (const spec of BODY_SPECS) {
    const text = inp.objData[spec.naifId];
    if (!text) throw new Error(`Missing Horizons data for ${spec.name} (${spec.naifId})`);
    const parsed = parseObjData(text);
    const meanA = sats.find((s) => s.naifId === spec.naifId);
    const { physical, unavailable, triaxial, synchronous } = physicalFor(spec, parsed, inp.retrieved, { ...(meanA ? { meanA } : {}) });

    let orbit: OrbitDefinition | undefined;
    let orbitSource: OrbitSource | undefined;
    if (spec.kind === 'planet') {
      const row = approx[spec.jplName as ApproxPlanetName];
      if (!row) throw new Error(`No JPL approximate-positions row for ${spec.name}`);
      orbit = { model: 'jpl-approx-keplerian', elements: row, validFromYear: 1800, validToYear: 2050, ...(spec.id === 'earth' ? { barycentre: true } : {}) };
      orbitSource = { model: 'JPL SSD approximate Keplerian elements with linear rates (Table 1, 1800-2050), mean ecliptic and equinox of J2000', source: 'JPL SSD "Approximate Positions of the Planets"', retrieved: inp.retrieved, url: 'https://ssd.jpl.nasa.gov/planets/approx_pos.html' };
      // Planet a, e, I at J2000 as published quantities.
      physical['semi_major_axis'] = { value: row.a[0], unit: 'AU', kind: 'observed', source: { source: 'jpl-ssd-approx-positions', recordId: spec.jplName, url: orbitSource.url, retrieved: inp.retrieved }, epoch: 'J2000.0', note: spec.id === 'earth' ? 'Earth-Moon barycentre, at J2000.0; changes slowly (JPL rate in the dataset).' : 'At J2000.0; changes slowly (JPL rate in the dataset).' };
      physical['eccentricity'] = { value: row.e[0], unit: 'dimensionless', kind: 'observed', source: physical['semi_major_axis']!.source, epoch: 'J2000.0' };
      physical['inclination'] = { value: row.I[0], unit: 'deg', kind: 'observed', source: physical['semi_major_axis']!.source, epoch: 'J2000.0', note: 'To the mean ecliptic of J2000.' };
    } else if (spec.kind === 'moon') {
      const el = inp.moonElements[spec.id];
      if (!el) throw new Error(`Missing Horizons osculating elements for ${spec.name}`);
      const meanPeriod = meanA?.periodDays;
      const fit = inp.moonFits?.[spec.id];
      const o: OsculatingOrbit = {
        model: 'osculating-mean-motion', epochJdTdb: el.jdTdb, a: el.a * 1000, e: el.e, inclinationDeg: el.inclinationDeg, nodeDeg: el.nodeDeg,
        argPeriDeg: el.argPeriDeg, meanAnomalyDeg: el.meanAnomalyDeg, osculatingPeriodDays: el.periodSeconds / 86400, ...(meanPeriod ? { meanPeriodDays: meanPeriod } : {}),
        ...(fit ? { fittedPeriodDays: fit.periodDays, fit: { windowDays: fit.windowDays, samples: fit.samples, rmsDeg: fit.rmsDeg } } : {}),
      };
      orbit = o;
      orbitSource = { model: 'JPL Horizons osculating elements (ICRF equatorial axes, centred on the parent) at the epoch, advanced at a mean-longitude rate fitted to Horizons elements around the epoch; no precession of the apsidal line or node, no perturbations', source: 'JPL Horizons (ELEMENTS) + JPL SSD satellite mean elements', retrieved: inp.retrieved, epochJdTdb: el.jdTdb, url: 'https://ssd.jpl.nasa.gov/api/horizons.api' };
    }

    const rot = rotationFor(pck.get(spec.naifId));
    const gm = physical['gm']?.value;
    bodies.push({
      id: spec.id, name: spec.name, naifId: spec.naifId, kind: spec.kind, parent: spec.parent, physical,
      ...(triaxial ? { triaxialRadiiKm: triaxial } : {}),
      ...(spec.id === 'sun' && inp.sunSpectralType ? { spectralType: { value: inp.sunSpectralType.value, source: `${inp.sunSpectralType.source} (${inp.sunSpectralType.url})`, retrieved: inp.retrieved } } : {}),
      ...(orbit ? { orbit } : {}), ...(orbitSource ? { orbitSource } : {}),
      ...(rot ? { rotation: rot, rotationSource: { model: 'IAU pole and prime-meridian elements, linear terms only (NAIF pck00011.tpc)', source: 'NAIF generic_kernels/pck/pck00011.tpc', retrieved: inp.retrieved, url: 'https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc' } } : {}),
      ...(synchronous ? { synchronousRotation: true } : {}),
      ...(gm !== undefined ? { gm } : {}),
      facts: spec.facts, unavailable,
    });
  }

  const sources: SourceNote[] = [
    { id: 'jpl-horizons', name: 'JPL Horizons System (physical data and osculating elements)', url: 'https://ssd.jpl.nasa.gov/api/horizons.api', retrieved: inp.retrieved },
    { id: 'jpl-ssd-approx-positions', name: 'JPL SSD, Approximate Positions of the Planets (Table 1)', url: 'https://ssd.jpl.nasa.gov/planets/approx_pos.html', retrieved: inp.retrieved },
    { id: 'jpl-ssd-satellite-mean-elements', name: 'JPL SSD, Planetary Satellite Mean Elements', url: 'https://ssd.jpl.nasa.gov/sats/elem/', retrieved: inp.retrieved, note: 'JPL warns these are not intended for ephemeris computation; only mean periods and mean a, e are used.' },
    { id: 'naif-pck', name: 'NAIF PCK pck00011.tpc (IAU rotational elements)', url: 'https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc', retrieved: inp.retrieved },
    { id: 'nasa-sun-facts', name: 'NASA Science, Our Sun: Facts (spectral type G2 V)', url: 'https://science.nasa.gov/sun/facts/', retrieved: inp.retrieved, note: 'SIMBAD does not catalogue the Sun, so its spectral type is taken from NASA.' },
    { id: 'codata', name: 'CODATA 2018 recommended value of G', url: 'https://physics.nist.gov/cgi-bin/cuu/Value?bg', retrieved: inp.retrieved },
  ];
  return { bodies, sources };
}

export function buildSolarDataset(inp: SolarInputs, validation: readonly ValidationRow[], referenceChecks: Readonly<Record<string, number>>, builtAt: string): SolarDatasetFile {
  const { bodies, sources } = buildSolarBodies(inp);
  const manifest: SolarManifest = {
    id: 'solar-system', version: 1, builtAt,
    referenceEpoch: { iso: inp.referenceIso, jdTdb: inp.referenceJdTdb, scale: 'TDB (UTC + 69.184 s)' },
    sources, constants: { gravitationalConstant: { value: G.value, unit: G.unit, source: G.source } },
    validation, referenceChecks,
    notes: [
      'Planet positions use JPL low-accuracy Keplerian elements; they are not a high-precision ephemeris. The table in `validation` records the error against JPL Horizons.',
      'Satellite positions use osculating elements at the reference epoch with JPL mean periods; accuracy degrades with distance in time from the epoch.',
      'Body orientation uses the linear terms of the IAU elements only.',
      'The Sun is placed at the origin; its motion about the barycentre is ignored.',
    ],
  };
  return { format: SOLAR_FORMAT, formatVersion: SOLAR_FORMAT_VERSION, manifest, bodies };
}

/** Minimal description of each body for the ephemeris (no physical data). */
export function ephemerisBodies(file: SolarDatasetFile): EphemerisBody[] {
  return file.bodies.map((b) => ({
    id: b.id, parent: b.parent,
    ...(b.orbit ? { orbit: b.orbit } : {}), ...(b.rotation ? { rotation: b.rotation } : {}), ...(b.gm !== undefined ? { gm: b.gm } : {}),
  }));
}

export { MOON_CENTRES, parseApproxPositionsTable1, parsePck, parseSatMeanElements };
