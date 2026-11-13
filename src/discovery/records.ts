/**
 * Adapters from the datasets held by the atlas to DiscoveryRecord (Prompt 07), and mergeRecords.
 *
 * MAPPING DECISIONS (also listed in docs/DISCOVERY_ENGINE.md)
 *
 *  A measurement key is set ONLY when the source provides it. Never 0, never NaN, never a guess. Values the source flags as limits are not set.
 *
 *  Gaia DR3 (recordsFromGaia)
 *   distancePc     d = 1000/parallax from src/core/astro/parallax.ts, only for status 'reliable' (S/N >= 10) or 'marginal' (5 <= S/N < 10); derived;
 *                  uncertainty = the first-order sigma that module computes. No zero-point correction.
 *   apparentMag    G (phot_g_mean_mag), observed, uncertainty from the flux S/N (1.0857/SNR).
 *   absoluteMag    M_G = G - 5 log10 d + 5, derived, no extinction; uncertainty combines the G error and the relative distance error.
 *   teffK          GSP-Phot, modelled, half of the 16-84 percentile range as uncertainty.   bpRp  BP - RP, derived.
 *   pmTotalMasYr   hypot(pmra, pmdec), derived; uncertainty propagated from the two errors ignoring their correlation (not published here).
 *   category       'star' only if SIMBAD classifies the source as a star (same rule as GaiaCatalogue.toObject); otherwise 'other': Atlas does not call an
 *                  unidentified Gaia source a star.
 *   drawn          has a distance AND a G magnitude (what the Gaia point layer needs).
 *   qualityFlags   the catalogue's soft flags (src/data/catalogue/flags.ts: high-ruwe, parallax-marginal, ...). Flagged records are kept; lists show the flags.
 *   position       icrs when a distance exists, otherwise sky-only (ra/dec from Gaia).
 *
 *  Solar System (recordsFromSolar)  radiusKm (mean_radius), massKg, orbitalPeriodDays (orbital_period, converted to days); the Sun also gets teffK (effective
 *   temperature), luminositySun (W / 3.828e26) and radiusSun (km / 695700). Planet / moon 'temperature' is a surface or 1-bar temperature, NOT an effective or
 *   equilibrium temperature, and is not mapped to teffK. position kind 'solar' (no catalogue distance), so the record belongs to the Solar System distance band.
 *
 *  Deep space (recordsFromDeep)  distancePc from sky.distance (pc/kpc/Mpc converted) except for the Milky Way: its stored distance is the distance from the Sun to
 *   the Galactic centre, not a distance to "the galaxy we are in", so it is NOT set (the position is the Galactic-centre direction anchor). angularSizeArcmin from the
 *   catalogue major axis. physicalSizePc: the published physicalDiameter / physicalDiameterD25 if present, else derived from angular size and distance (derived).
 *   apparentMag: first present of magV, magB, magV_total_harris, magB_total_hyperleda (bands differ between objects; the band is not stored in the record).
 *   absoluteMag: absMagV then absMagB. massKg from mass / stellarMass (Msun x 1.98841e30). nebulaClass 'supernova-remnant' -> category 'supernova-remnant'.
 *   'hypothetical' measurements are skipped. The Local Group has no position in the data: sky-only with NaN direction, drawn false (see hasSkyDirection).
 *
 *  Point catalogues (recordsFromPoints)  A row for the Milky Way itself gets no distance (the Sun is inside it). UNGC: distance from distMpc (kind 'observed' unless the method code is one of mem/h/h'/txt, which are not independent
 *   measurements: then 'derived'); McConnachie: distMpc observed; 2MRS: czKms observed; distancePc ONLY if cz >= 1000 km/s (d = cz / 70 km/s/Mpc, an application choice
 *   with ~10% systematic uncertainty, the same rule as the structure renderer), kind 'derived' with that assumption in `note`, no uncertainty. apparentMag is B (UNGC), V (McConnachie)
 *   or extinction-corrected Ks (2MRS). A 2MRS id of the form hhmmssss+ddmmsss also gets its standard SIMBAD name "2MASX J<id>".
 *
 *  Hipparcos (recordsFromBrightStars)  apparentMag = V; distancePc by brightPlacement.ts (the renderer's rule): parallax S/N >= 10, or a NAMED star with S/N 5-10 (kind 'derived', uncertainty from the parallax error,
 *   note 'low reliability: parallax S/N < 10'); every other star is sky-only (inspect-only); absoluteMag derived; pmTotalMasYr derived. B-V is not stored (it is not BP-RP). sameAs gaia:<id> when the file found the Gaia record.
 *
 *  NASA Exoplanet Archive (recordsFromExoplanets)  hosts: distancePc (derived by the archive from parallax), apparentMag V, teffK (stellar, modelled), radiusSun, massKg
 *   (stMassSun x 1.98841e30, derived), pmTotalMasYr. Planets (category 'exoplanet', never drawn): orbitalPeriodDays, radiusKm (Earth radii x 6378.1 km, derived), massKg ONLY
 *   for massKind 'Mass' (derived) or 'M-R relationship' (modelled): a Msini minimum mass is not a mass and is omitted; teffK = EQUILIBRIUM temperature (modelled);
 *   limit-flagged values are omitted. A planet's position and distancePc are its host's.
 *
 *  Other objects (recordsFromOther)  position from the cited coordinates, distance from its own cited source (pc/kpc/Mpc); drawn = has a distance.
 */
import { equatorialToUnit } from '../core/astro/coordinates';
import { absoluteMagnitude } from '../core/astro/photometry';
import { lengthToParsecs, physicalSizeEstimate } from '../core/deepspace/geometry';
import type { Vec3 } from '../core/spatial/vec3';
import type { GaiaCatalogue } from '../data/catalogue/catalogue';
import type { SimbadCrossIdFile } from '../data/catalogue/types';
import type { DeepSpaceData } from '../data/deepspace/deepSpaceData';
import type { PointCatalogueFile } from '../data/deepspace/types';
import type { Measurement } from '../data/schema';
import type { SolarSystemData } from '../data/solar/solarCatalogue';
import { brightPlacement, LOW_RELIABILITY_NOTE } from './brightPlacement';
import { isProperName } from './normalize';
import type {
  BrightStarFile, DatasetId, DiscoveryPosition, DiscoveryRecord, ExoplanetFile, MeasurementKey, ObjectCategory, OtherObjectsFile, RecordMeasurement, UniversalId, ValueKind,
} from './types';

type Meas = Partial<Record<MeasurementKey, RecordMeasurement>>;

const MSUN_KG = 1.98841e30;                // IAU 2015 nominal GM_sun / G
const LSUN_W = 3.828e26;                   // IAU 2015 nominal solar luminosity
const RSUN_KM = 695_700;                   // IAU 2015 nominal solar radius
const REARTH_KM = 6378.1;                  // IAU 2015 nominal equatorial Earth radius
const LN10_5 = 5 / Math.LN10;

export const APPLICATION_H0_KM_S_MPC = 70;
export const MIN_CZ_FOR_HUBBLE_KMS = 1000;
export const UNGC_NOT_INDEPENDENT: ReadonlySet<string> = new Set(['mem', 'h', "h'", 'txt']);
const H0_NOTE = `d = cz / H0 with H0 = ${APPLICATION_H0_KM_S_MPC} km/s/Mpc, an application choice (not a measurement); about 10% systematic uncertainty; peculiar velocities are not removed.`;

const fin = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);
const unc = (u: number | null | undefined): { uncertainty?: number } => (u !== null && u !== undefined && Number.isFinite(u) && u >= 0 ? { uncertainty: u } : {});

/** Does the record have a direction on the sky? false for a record defined only by its members (the Local Group), whose sky-only position has non-finite angles. */
export function hasSkyDirection(p: DiscoveryPosition): boolean {
  return p.kind === 'solar' ? false : Number.isFinite(p.raDeg) && Number.isFinite(p.decDeg);
}

function icrs(raDeg: number, decDeg: number, distancePc: number, sigmaPc?: number): DiscoveryPosition {
  const u = equatorialToUnit(raDeg, decDeg);
  return { kind: 'icrs', xyzPc: [u[0] * distancePc, u[1] * distancePc, u[2] * distancePc], raDeg, decDeg, ...(sigmaPc !== undefined && Number.isFinite(sigmaPc) ? { distanceUncertaintyPc: sigmaPc } : {}) };
}

function column(cols: Readonly<Record<string, readonly unknown[]>>, name: string, required: boolean, what: string): readonly unknown[] {
  const c = cols[name];
  if (c === undefined) { if (required) throw new Error(`${what}: required column "${name}" is missing`); return []; }
  return c;
}
const at = (c: readonly unknown[], i: number): unknown => (i < c.length ? c[i] : null);

function pmTotal(pmra: number | null, pmdec: number | null, e1: number | null, e2: number | null): RecordMeasurement | undefined {
  if (pmra === null || pmdec === null) return undefined;
  const total = Math.hypot(pmra, pmdec);
  const sigma = e1 !== null && e2 !== null && total > 0 ? Math.hypot(pmra * e1, pmdec * e2) / total : null;
  return { value: total, kind: 'derived', ...unc(sigma) };
}

const strip = (s: string): string => s.replace(/^(?:\*{1,2}|V\*|NAME)\s+/, '');

// ---- Gaia ------------------------------------------------------------------------------------------------------------------------------

export function recordsFromGaia(cat: GaiaCatalogue, simbad: SimbadCrossIdFile | null): DiscoveryRecord[] {
  const out: DiscoveryRecord[] = [];
  for (let i = 0; i < cat.count; i++) {
    const sid = cat.sourceId(i);
    const ra = cat.value('ra', i), dec = cat.value('dec', i);
    if (ra === null || dec === null) continue;
    const entry = simbad?.entries[sid];
    const hip = cat.value('hip_id', i);
    const proper = entry?.i.find((x) => x.startsWith('NAME '))?.slice(5);
    const designations = [...new Set([`Gaia DR3 ${sid}`, ...(hip !== null ? [`HIP ${hip}`] : []), ...(entry ? [entry.m, ...entry.i] : [])])];
    const m: Meas = {};
    const info = cat.distanceInfo(i);
    const d = info.status === 'reliable' || info.status === 'marginal' ? info.distancePc! : null;
    if (d !== null) m.distancePc = { value: d, kind: 'derived', ...unc(info.sigmaPc) };
    const g = cat.value('phot_g_mean_mag', i);
    const gSnr = cat.value('phot_g_mean_flux_over_error', i);
    const gSigma = gSnr !== null && gSnr > 0 ? 1.0857362047581294 / gSnr : null;
    if (g !== null) m.apparentMag = { value: g, kind: 'observed', ...unc(gSigma) };
    if (d !== null && g !== null) {
      const rel = info.sigmaPc !== undefined ? info.sigmaPc / d : 0;
      m.absoluteMag = { value: absoluteMagnitude(g, d), kind: 'derived', uncertainty: Math.hypot(gSigma ?? 0, LN10_5 * rel) };
    }
    const teff = cat.value('teff_gspphot', i);
    if (teff !== null) {
      const lo = cat.value('teff_gspphot_lower', i), hi = cat.value('teff_gspphot_upper', i);
      m.teffK = { value: teff, kind: 'modelled', ...unc(lo !== null && hi !== null ? (hi - lo) / 2 : null) };
    }
    const bp = cat.bpRp(i);
    if (bp !== null) m.bpRp = { value: bp, kind: 'derived' };
    const pm = pmTotal(cat.value('pmra', i), cat.value('pmdec', i), cat.value('pmra_error', i), cat.value('pmdec_error', i));
    if (pm) m.pmTotalMasYr = pm;

    const flags = cat.flags(i);
    const otype = entry?.t;
    const isStar = otype !== undefined && !otype.endsWith('?') && (otype.startsWith('*') || otype.endsWith('*'));
    const label = entry ? simbad?.otypes[entry.t]?.description ?? simbad?.otypes[entry.t]?.label ?? entry.t : undefined;
    const rec: DiscoveryRecord = {
      id: `gaia:${sid}`, dataset: 'gaia-dr3', category: isStar ? 'star' : 'other',
      name: proper ?? (entry ? strip(entry.m) : `Gaia DR3 ${sid}`), designations,
      classification: entry ? `${label}${entry.sp ? ` · ${entry.sp}` : ''}` : 'Gaia DR3 source without a SIMBAD identification',
      ...(entry?.sp ? { spectralType: entry.sp } : {}),
      position: d !== null ? icrs(ra, dec, d, info.sigmaPc) : { kind: 'sky-only', raDeg: ra, decDeg: dec },
      measurements: m, drawn: d !== null && g !== null, sourceKey: 'gaia-dr3',
      ...(flags.length > 0 ? { qualityFlags: flags } : {}),
    };
    out.push(rec);
  }
  return out;
}

// ---- Solar System ------------------------------------------------------------------------------------------------------------------------

const toValueKind = (k: Measurement['kind']): ValueKind | null => (k === 'hypothetical' ? null : k);

function convert(m: Measurement, to: 'km' | 'kg' | 'K' | 'd'): number | null {
  const u = m.unit;
  if (!Number.isFinite(m.value)) return null;
  if (to === 'km') return u === 'km' ? m.value : u === 'm' ? m.value / 1000 : null;
  if (to === 'kg') return u === 'kg' ? m.value : null;
  if (to === 'K') return u === 'K' ? m.value : null;
  return u === 'd' || u === 'day' || u === 'days' ? m.value : u === 'h' ? m.value / 24 : u === 'yr' ? m.value * 365.25 : null;
}
function fromMeasurement(m: Measurement | undefined, to: 'km' | 'kg' | 'K' | 'd', scale = 1): RecordMeasurement | undefined {
  if (!m) return undefined;
  const kind = toValueKind(m.kind);
  const v = convert(m, to);
  if (kind === null || v === null) return undefined;
  const u = m.uncertainty !== undefined && (m.uncertaintyUnit === undefined || m.uncertaintyUnit === m.unit) ? convert({ ...m, value: m.uncertainty }, to) : null;
  return { value: v * scale, kind, ...unc(u !== null ? u * scale : null) };
}

export function recordsFromSolar(solar: SolarSystemData): DiscoveryRecord[] {
  const out: DiscoveryRecord[] = [];
  const names = new Map(solar.file.bodies.map((b) => [b.id, b.name] as const));
  for (const b of solar.file.bodies) {
    const p = b.physical;
    const m: Meas = {};
    const radius = fromMeasurement(p['mean_radius'], 'km');
    if (radius) m.radiusKm = radius;
    const mass = fromMeasurement(p['mass'], 'kg');
    if (mass) m.massKg = mass;
    const period = fromMeasurement(p['orbital_period'], 'd');
    if (period) m.orbitalPeriodDays = period;
    if (b.kind === 'star') {
      const teff = fromMeasurement(p['effective_temperature'], 'K');
      if (teff) m.teffK = teff;
      const lum = p['luminosity'];
      if (lum && lum.unit === 'W' && Number.isFinite(lum.value) && toValueKind(lum.kind)) m.luminositySun = { value: lum.value / LSUN_W, kind: 'derived' };
      if (radius) m.radiusSun = { value: radius.value / RSUN_KM, kind: 'derived', ...unc(radius.uncertainty !== undefined ? radius.uncertainty / RSUN_KM : null) };
    }
    const category: ObjectCategory = b.kind === 'star' ? 'star' : b.kind === 'planet' ? 'planet' : 'moon';
    out.push({
      id: `solar:${b.id}`, dataset: 'solar-system', category, name: b.name, designations: [b.name, `NAIF ${b.naifId}`],
      classification: b.kind === 'star' ? `Star${b.spectralType ? ` · ${b.spectralType.value}` : ''}` : b.kind === 'planet' ? 'Planet' : `Moon of ${names.get(b.parent ?? '') ?? b.parent ?? 'unknown'}`,
      ...(b.spectralType ? { spectralType: b.spectralType.value } : {}),
      position: { kind: 'solar', bodyId: b.id }, measurements: m, drawn: true, sourceKey: 'solar-system.v1',
    });
  }
  return out;
}

// ---- Deep space --------------------------------------------------------------------------------------------------------------------------

const KIND_LABEL: Readonly<Record<string, string>> = { galaxy: 'Galaxy', nebula: 'Nebula', 'star-cluster': 'Star cluster', 'galaxy-group': 'Group of galaxies', 'galaxy-cluster': 'Cluster of galaxies', 'cosmic-structure': 'Cosmic structure' };
const NEBULA_LABEL: Readonly<Record<string, string>> = { emission: 'Emission nebula', reflection: 'Reflection nebula', dark: 'Dark nebula', planetary: 'Planetary nebula', 'supernova-remnant': 'Supernova remnant', 'molecular-cloud': 'Molecular cloud' };

function lengthPc(m: Measurement | undefined): { value: number; kind: ValueKind; uncertainty?: number } | null {
  if (!m) return null;
  const kind = toValueKind(m.kind);
  if (kind === null) return null;
  try {
    const value = lengthToParsecs(m.value, m.unit);
    if (!(value > 0) || !Number.isFinite(value)) return null;
    const u = m.uncertainty !== undefined ? lengthToParsecs(m.uncertainty, m.uncertaintyUnit ?? m.unit) : undefined;
    return { value, kind, ...(u !== undefined && Number.isFinite(u) ? { uncertainty: u } : {}) };
  } catch { return null; }
}

export function recordsFromDeep(deep: DeepSpaceData): DiscoveryRecord[] {
  const out: DiscoveryRecord[] = [];
  for (const o of deep.all()) {
    const m: Meas = {};
    const dist = o.id === 'milky-way' ? null : lengthPc(o.sky?.distance);
    if (dist) m.distancePc = { value: dist.value, kind: dist.kind, ...unc(dist.uncertainty) };
    if (o.angularSize) m.angularSizeArcmin = { value: o.angularSize.majorArcmin, kind: 'observed' };
    const size = lengthPc(o.measurements['physicalDiameter']) ?? lengthPc(o.measurements['physicalDiameterD25']);
    if (size) m.physicalSizePc = { value: size.value, kind: size.kind, ...unc(size.uncertainty) };
    else if (o.angularSize && o.sky?.distance && dist) {
      try {
        const e = physicalSizeEstimate(o.angularSize.majorArcmin, o.sky.distance);
        m.physicalSizePc = { value: e.metres / 3.0856775814913673e16, kind: 'derived', ...(e.uncertaintyPublished ? { uncertainty: e.sigmaMetres / 3.0856775814913673e16 } : {}) };
      } catch { /* size not derivable */ }
    }
    for (const k of ['magV', 'magB', 'magV_total_harris', 'magB_total_hyperleda']) {
      const mm = o.measurements[k];
      const kind = mm ? toValueKind(mm.kind) : null;
      if (mm && kind && mm.unit === 'mag' && Number.isFinite(mm.value)) { m.apparentMag = { value: mm.value, kind, ...unc(mm.uncertainty) }; break; }
    }
    for (const k of ['absMagV', 'absMagB']) {
      const mm = o.measurements[k];
      const kind = mm ? toValueKind(mm.kind) : null;
      if (mm && kind && Number.isFinite(mm.value)) { m.absoluteMag = { value: mm.value, kind, ...unc(mm.uncertainty) }; break; }
    }
    for (const k of ['mass', 'stellarMass']) {
      const mm = o.measurements[k];
      const kind = mm ? toValueKind(mm.kind) : null;
      if (mm && kind && mm.unit === 'Msun' && Number.isFinite(mm.value)) { m.massKg = { value: mm.value * MSUN_KG, kind, ...unc(mm.uncertainty !== undefined ? mm.uncertainty * MSUN_KG : null) }; break; }
    }
    const category: ObjectCategory = o.kind === 'nebula' ? (o.nebulaClass === 'supernova-remnant' ? 'supernova-remnant' : 'nebula')
      : o.kind === 'cosmic-structure' ? 'other' : (o.kind as ObjectCategory);
    const pc = deep.positionPc(o.id);
    let position: DiscoveryPosition;
    if (o.sky && pc) position = { kind: 'icrs', xyzPc: pc as Vec3, raDeg: o.sky.raDeg, decDeg: o.sky.decDeg, ...(dist?.uncertainty !== undefined ? { distanceUncertaintyPc: dist.uncertainty } : {}) };   // exactly the position the viewer uses
    else if (o.sky) position = { kind: 'sky-only', raDeg: o.sky.raDeg, decDeg: o.sky.decDeg };
    else position = { kind: 'sky-only', raDeg: NaN, decDeg: NaN };
    const label = o.kind === 'nebula' ? NEBULA_LABEL[o.nebulaClass ?? ''] ?? 'Nebula' : o.kind === 'star-cluster' ? (o.clusterClass === 'globular' ? 'Globular cluster' : o.clusterClass === 'open' ? 'Open cluster' : 'Star cluster') : KIND_LABEL[o.kind] ?? 'Object';
    out.push({
      id: `deep:${o.id}`, dataset: 'deep-space', category, name: o.name, designations: [...new Set([o.name, ...o.designations, o.id])],
      classification: `${label}${o.morphologyLabel ? ` · ${o.morphologyLabel}` : ''}`,
      position, measurements: m, drawn: position.kind === 'icrs', sourceKey: 'deep-space.v1',
    });
  }
  return out;
}

// ---- point catalogues -------------------------------------------------------------------------------------------------------------------

const POINT_FILES: ReadonlySet<string> = new Set(['ungc', 'local-group-mcconnachie', 'twomrs']);

export function recordsFromPoints(file: PointCatalogueFile): DiscoveryRecord[] {
  const fid = file.manifest.id;
  if (!POINT_FILES.has(fid)) throw new Error(`Unknown point catalogue "${fid}"`);
  const dataset = fid as DatasetId;
  const c = file.columns;
  const what = `point catalogue ${fid}`;
  const name = column(c, 'name', true, what), ra = column(c, 'raDeg', true, what), dec = column(c, 'decDeg', true, what);
  const distMpc = column(c, 'distMpc', false, what), distErr = column(c, 'distErrMpc', false, what), method = column(c, 'distMethod', false, what);
  const morph = column(c, 'morphology', false, what), bMag = column(c, 'bMag', false, what), vMag = column(c, 'vMag', false, what), ksMag = column(c, 'ksMag', false, what);
  const diam = column(c, 'diameterArcmin', false, what), cz = column(c, 'czKms', false, what), czErr = column(c, 'czErrKms', false, what), simb = column(c, 'ngcSimbadName', false, what);
  const out: DiscoveryRecord[] = [];
  for (let i = 0; i < name.length; i++) {
    const nm = text(name[i]);
    const r = fin(ra[i]), d = fin(dec[i]);
    if (nm === null || r === null || d === null) continue;
    const m: Meas = {};
    let dPc: number | null = null;
    let sigmaPc: number | undefined;
    // The Sun is inside the Milky Way: a catalogue row for it carries a conventional distance (to its centre), not a distance to the galaxy. Not set.
    const isMilkyWay = /^(?:the galaxy|milky way(?: galaxy)?)$/i.test(nm);
    if (fid !== 'twomrs') {
      const dm = isMilkyWay ? null : fin(at(distMpc, i));
      if (dm !== null && dm > 0) {
        dPc = dm * 1e6;
        const e = fin(at(distErr, i));
        sigmaPc = e !== null && e >= 0 ? e * 1e6 : undefined;
        const meth = text(at(method, i));
        const independent = !(fid === 'ungc' && meth !== null && UNGC_NOT_INDEPENDENT.has(meth));
        m.distancePc = { value: dPc, kind: independent ? 'observed' : 'derived', ...unc(sigmaPc), ...(independent ? {} : { note: `Distance method "${meth}" is not an independent distance measurement of this galaxy (assigned from group membership, the Hubble flow or see the paper).` }) };
      }
      const mag = fid === 'ungc' ? fin(at(bMag, i)) : fin(at(vMag, i));
      if (mag !== null) m.apparentMag = { value: mag, kind: 'observed' };
    } else {
      const v = fin(at(cz, i));
      if (v !== null) {
        m.czKms = { value: v, kind: 'observed', ...unc(fin(at(czErr, i))) };
        if (v >= MIN_CZ_FOR_HUBBLE_KMS) { dPc = (v / APPLICATION_H0_KM_S_MPC) * 1e6; m.distancePc = { value: dPc, kind: 'derived', note: H0_NOTE }; }
      }
      const k = fin(at(ksMag, i));
      if (k !== null) m.apparentMag = { value: k, kind: 'observed' };
    }
    const dia = fin(at(diam, i));
    if (dia !== null && dia > 0) m.angularSizeArcmin = { value: dia, kind: 'observed' };
    const designations = [nm];
    const alt = text(at(simb, i));
    if (alt !== null && alt !== nm) designations.push(alt);
    if (fid === 'twomrs' && /^\d{8}[+-]\d{7}$/.test(nm)) designations.push(`2MASX J${nm}`);
    const mo = text(at(morph, i));
    out.push({
      id: `point:${fid}:${i}`, dataset, category: 'galaxy', name: nm, designations,
      classification: `Galaxy${mo ? ` · ${mo}` : ''}`,
      position: dPc !== null ? icrs(r, d, dPc, sigmaPc) : { kind: 'sky-only', raDeg: r, decDeg: d },
      measurements: m, drawn: dPc !== null, sourceKey: fid,
    });
  }
  return out;
}

// ---- Hipparcos --------------------------------------------------------------------------------------------------------------------------

export function recordsFromBrightStars(file: BrightStarFile): DiscoveryRecord[] {
  const c = file.columns;
  const what = 'bright-stars file';
  const hip = column(c, 'hip', true, what), ra = column(c, 'raDeg', true, what), dec = column(c, 'decDeg', true, what);
  const plx = column(c, 'parallaxMas', false, what), plxE = column(c, 'parallaxErrMas', false, what), pmra = column(c, 'pmraMasYr', false, what), pmdec = column(c, 'pmdecMasYr', false, what);
  const pmraE = column(c, 'pmraErrMasYr', false, what), pmdecE = column(c, 'pmdecErrMasYr', false, what), vmag = column(c, 'vMag', false, what);
  const sp = column(c, 'spectralType', false, what), iau = column(c, 'iauName', false, what), desig = column(c, 'designations', false, what);
  const gaia = column(c, 'gaiaSourceId', false, what);
  const out: DiscoveryRecord[] = [];
  for (let i = 0; i < hip.length; i++) {
    const h = fin(hip[i]);
    const r = fin(ra[i]), d = fin(dec[i]);
    if (h === null || r === null || d === null) continue;
    const m: Meas = {};
    const iauName = text(at(iau, i));
    // The same placement rule as the renderer (brightPlacement.ts): S/N >= 10, or a NAMED star with S/N 5-10 (flagged), gets a distance; others stay sky-only.
    const placed = brightPlacement(fin(at(plx, i)), fin(at(plxE, i)), iauName !== null);
    const dPc = placed ? placed.distancePc : null;
    const sigma = placed ? placed.sigmaPc : undefined;
    const v = fin(at(vmag, i));
    if (placed) m.distancePc = { value: placed.distancePc, kind: 'derived', ...unc(sigma), ...(placed.placement === 'marginal-named' ? { note: LOW_RELIABILITY_NOTE } : {}) };
    if (v !== null) m.apparentMag = { value: v, kind: 'observed' };
    if (dPc !== null && v !== null) m.absoluteMag = { value: absoluteMagnitude(v, dPc), kind: 'derived', ...unc(sigma !== undefined ? LN10_5 * (sigma / dPc) : null), ...(placed!.placement === 'marginal-named' ? { note: LOW_RELIABILITY_NOTE } : {}) };
    const pm = pmTotal(fin(at(pmra, i)), fin(at(pmdec, i)), fin(at(pmraE, i)), fin(at(pmdecE, i)));
    if (pm) m.pmTotalMasYr = pm;
    const spec = text(at(sp, i));
    const gid = text(at(gaia, i));
    const desigs = [...new Set([`HIP ${h}`, ...(iauName ? [iauName] : []), ...(text(at(desig, i)) ?? '').split('|').map((s) => s.trim()).filter((s) => s.length > 0)])];
    out.push({
      id: `hip:${h}`, dataset: 'hipparcos', category: 'star', name: iauName ?? `HIP ${h}`, designations: desigs,
      classification: `Star${spec ? ` · ${spec}` : ''}`, ...(spec ? { spectralType: spec } : {}),
      position: dPc !== null ? icrs(r, d, dPc, sigma) : { kind: 'sky-only', raDeg: r, decDeg: d },
      measurements: m, ...(gid ? { sameAs: [`gaia:${gid}`] } : {}), drawn: dPc !== null && v !== null, sourceKey: 'hipparcos',
    });
  }
  return out;
}

// ---- NASA Exoplanet Archive --------------------------------------------------------------------------------------------------------------

export function recordsFromExoplanets(file: ExoplanetFile): DiscoveryRecord[] {
  const h = file.hosts, p = file.planets;
  const hn = column(h, 'hostname', true, 'exoplanets hosts'), hra = column(h, 'raDeg', true, 'exoplanets hosts'), hdec = column(h, 'decDeg', true, 'exoplanets hosts');
  const hdist = column(h, 'distPc', false, 'hosts'), hdistE = column(h, 'distErrPc', false, 'hosts'), hsp = column(h, 'spectralType', false, 'hosts');
  const hteff = column(h, 'teffK', false, 'hosts'), hteffE = column(h, 'teffErrK', false, 'hosts'), hrad = column(h, 'stRadiusSun', false, 'hosts'), hmass = column(h, 'stMassSun', false, 'hosts');
  const hv = column(h, 'vMag', false, 'hosts'), hgaia = column(h, 'gaiaDr3Id', false, 'hosts'), hhip = column(h, 'hipName', false, 'hosts'), hhd = column(h, 'hdName', false, 'hosts'), htic = column(h, 'ticId', false, 'hosts');
  const hpmra = column(h, 'pmRaMasYr', false, 'hosts'), hpmdec = column(h, 'pmDecMasYr', false, 'hosts');
  const out: DiscoveryRecord[] = [];
  const hostPos = new Map<string, { position: DiscoveryPosition; dist?: RecordMeasurement }>();
  for (let i = 0; i < hn.length; i++) {
    const name = text(hn[i]);
    const r = fin(hra[i]), d = fin(hdec[i]);
    if (name === null || r === null || d === null) continue;
    const m: Meas = {};
    const dist = fin(at(hdist, i));
    const distM: RecordMeasurement | undefined = dist !== null && dist > 0 ? { value: dist, kind: 'derived', ...unc(fin(at(hdistE, i))) } : undefined;
    if (distM) m.distancePc = distM;
    const v = fin(at(hv, i));
    if (v !== null) m.apparentMag = { value: v, kind: 'observed' };
    const teff = fin(at(hteff, i));
    if (teff !== null) m.teffK = { value: teff, kind: 'modelled', ...unc(fin(at(hteffE, i))) };
    const rad = fin(at(hrad, i));
    if (rad !== null && rad > 0) m.radiusSun = { value: rad, kind: 'derived' };
    const mass = fin(at(hmass, i));
    if (mass !== null && mass > 0) m.massKg = { value: mass * MSUN_KG, kind: 'derived' };
    const pm = pmTotal(fin(at(hpmra, i)), fin(at(hpmdec, i)), null, null);
    if (pm) m.pmTotalMasYr = pm;
    const gid = text(at(hgaia, i));
    const spec = text(at(hsp, i));
    const desigs = [...new Set([name, text(at(hhip, i)), text(at(hhd, i)), text(at(htic, i)), gid ? `Gaia DR3 ${gid}` : null].filter((x): x is string => x !== null))];
    const position: DiscoveryPosition = distM ? icrs(r, d, distM.value, distM.uncertainty) : { kind: 'sky-only', raDeg: r, decDeg: d };
    hostPos.set(name, { position, ...(distM ? { dist: distM } : {}) });
    out.push({
      id: `host:${name}`, dataset: 'nasa-exoplanet-archive', category: 'exoplanet-host', name, designations: desigs,
      classification: `Planet host star${spec ? ` · ${spec}` : ''}`, ...(spec ? { spectralType: spec } : {}),
      position, measurements: m, ...(gid ? { sameAs: [`gaia:${gid}`] } : {}), drawn: distM !== undefined, sourceKey: 'nasa-exoplanet-archive',
    });
  }
  const pn = column(p, 'plName', true, 'exoplanets planets'), ph = column(p, 'hostname', true, 'planets');
  const method = column(p, 'discoveryMethod', false, 'planets'), year = column(p, 'discoveryYear', false, 'planets');
  const per = column(p, 'periodDays', false, 'planets'), perE = column(p, 'periodErr', false, 'planets'), perL = column(p, 'periodLim', false, 'planets');
  const rad = column(p, 'radiusEarth', false, 'planets'), radE = column(p, 'radiusErr', false, 'planets'), radL = column(p, 'radiusLim', false, 'planets');
  const mas = column(p, 'massEarth', false, 'planets'), masE = column(p, 'massErr', false, 'planets'), masL = column(p, 'massLim', false, 'planets'), masK = column(p, 'massKind', false, 'planets');
  const eq = column(p, 'eqTempK', false, 'planets'), contro = column(p, 'controversial', false, 'planets');
  for (let i = 0; i < pn.length; i++) {
    const name = text(pn[i]);
    const host = text(ph[i]);
    if (name === null || host === null) continue;
    const m: Meas = {};
    const hp = hostPos.get(host);
    if (hp?.dist) m.distancePc = hp.dist;
    const noLimit = (lim: unknown): boolean => lim === null || lim === undefined || lim === 0;
    const pv = fin(at(per, i));
    if (pv !== null && pv > 0 && noLimit(at(perL, i))) m.orbitalPeriodDays = { value: pv, kind: 'observed', ...unc(fin(at(perE, i))) };
    const rv = fin(at(rad, i));
    if (rv !== null && rv > 0 && noLimit(at(radL, i))) m.radiusKm = { value: rv * REARTH_KM, kind: 'derived', ...unc((() => { const e = fin(at(radE, i)); return e !== null ? e * REARTH_KM : null; })()) };
    const mv = fin(at(mas, i));
    const mk = text(at(masK, i));
    if (mv !== null && mv > 0 && noLimit(at(masL, i)) && (mk === 'Mass' || mk === 'M-R relationship')) {
      const e = fin(at(masE, i));
      m.massKg = { value: mv * 5.972168e24, kind: mk === 'Mass' ? 'derived' : 'modelled', ...(mk === 'M-R relationship' ? { note: 'Mass estimated from a mass-radius relationship, not measured.' } : {}), ...unc(e !== null ? e * 5.972168e24 : null) };
    }
    const tv = fin(at(eq, i));
    if (tv !== null && tv > 0) m.teffK = { value: tv, kind: 'modelled', note: 'Equilibrium temperature of the planet (modelled from the star and the orbit), not an effective temperature.' };
    const meth = text(at(method, i)), yr = fin(at(year, i));
    out.push({
      id: `exo:${name}`, dataset: 'nasa-exoplanet-archive', category: 'exoplanet', name, designations: [name],
      classification: `Confirmed exoplanet${meth || yr !== null ? ` (${[meth, yr !== null ? String(yr) : null].filter(Boolean).join(', ')})` : ''}${fin(at(contro, i)) === 1 ? ' · listed as controversial' : ''}`,
      position: hp?.position ?? { kind: 'sky-only', raDeg: NaN, decDeg: NaN }, measurements: m, drawn: false, sourceKey: 'nasa-exoplanet-archive',
    });
  }
  return out;
}

// ---- other objects ---------------------------------------------------------------------------------------------------------------------

export function recordsFromOther(file: OtherObjectsFile): DiscoveryRecord[] {
  const out: DiscoveryRecord[] = [];
  for (const o of file.objects) {
    if (typeof o.id !== 'string' || !Number.isFinite(o.raDeg) || !Number.isFinite(o.decDeg)) continue;
    const m: Meas = {};
    let dPc: number | null = null;
    let sigma: number | undefined;
    if (o.distance) {
      try {
        dPc = lengthToParsecs(o.distance.value, o.distance.unit);
        sigma = o.distance.uncertainty !== undefined ? lengthToParsecs(o.distance.uncertainty, o.distance.unit) : undefined;
      } catch { dPc = null; }
      if (dPc !== null && dPc > 0) m.distancePc = { value: dPc, kind: o.distance.kind, ...unc(sigma) }; else dPc = null;
    }
    out.push({
      id: o.id, dataset: 'curated-other', category: o.category, name: o.name, designations: [...new Set([o.name, ...o.designations])],
      classification: o.classification,
      position: dPc !== null ? icrs(o.raDeg, o.decDeg, dPc, sigma) : { kind: 'sky-only', raDeg: o.raDeg, decDeg: o.decDeg },
      measurements: m, drawn: dPc !== null, sourceKey: 'curated-other',
    });
  }
  return out;
}

// ---- merging --------------------------------------------------------------------------------------------------------------------------

export interface MergeResult {
  /** One record per object. */
  readonly records: DiscoveryRecord[];
  /** Merged-away id -> canonical id. Pass to RelationGraph and to saved-id resolution so old ids keep working. */
  readonly aliases: Map<UniversalId, UniversalId>;
  readonly merges: readonly { readonly canonical: UniversalId; readonly absorbed: readonly UniversalId[] }[];
  readonly warnings: readonly string[];
}

const PRIORITY: readonly DatasetId[] = ['gaia-dr3', 'hipparcos', 'nasa-exoplanet-archive', 'curated-other'];
const priorityOf = (d: DatasetId): number => { const i = PRIORITY.indexOf(d); return i < 0 ? PRIORITY.length : i; };
const STELLAR: ReadonlySet<ObjectCategory> = new Set<ObjectCategory>(['star', 'exoplanet-host']);
/** An unclassified Gaia source (category 'other') may be the same object as a star of another dataset: that dataset says it is a star. */
const mergeable = (r: DiscoveryRecord): boolean => STELLAR.has(r.category) || (r.category === 'other' && r.dataset === 'gaia-dr3');
const INDEPENDENT_KEYS: readonly MeasurementKey[] = ['apparentMag', 'teffK', 'radiusSun', 'radiusKm', 'massKg', 'bpRp', 'pmTotalMasYr', 'angularSizeArcmin', 'czKms', 'redshift', 'orbitalPeriodDays'];
const DISTANCE_GROUP: readonly MeasurementKey[] = ['distancePc', 'absoluteMag', 'luminositySun', 'physicalSizePc'];

export interface MergeOptions {
  /**
   * dependent record id -> the record it belongs to (planet -> host star, from relationsFromExoplanets). After merging, a dependent whose host was merged takes the
   * CANONICAL host's position and distance, so a star and its planets are never a few hundred AU apart because two catalogues measured the star's distance differently.
   */
  readonly followHost?: ReadonlyMap<UniversalId, UniversalId>;
}

/**
 * Resolve `sameAs`: records of the SAME star in different datasets become one. The Gaia record wins (it is the drawn one), then Hipparcos, then the exoplanet
 * host, then others. Only stars and planet hosts merge (and an unclassified Gaia source 'other' joins a star record of another dataset, becoming a 'star' because that dataset says it is one); any other sameAs link is reported and ignored.
 * The winner keeps its id, dataset, category, classification, drawn flag and every value it has. Where it lacks a value, one is taken from a duplicate and tagged
 * with `source` (the duplicate's dataset); the distance group (distancePc, absoluteMag, ...) and the 3D position are taken together from one duplicate or not at all.
 * All designations are kept, so every alternative id still finds the canonical record; `aliases` maps absorbed ids to it.
 */
export function mergeRecords(records: readonly DiscoveryRecord[], opts: MergeOptions = {}): MergeResult {
  const warnings: string[] = [];
  const byId = new Map<UniversalId, DiscoveryRecord>();
  const order: DiscoveryRecord[] = [];
  for (const r of records) {
    if (byId.has(r.id)) { warnings.push(`duplicate record id ${r.id}: the later one was ignored`); continue; }
    byId.set(r.id, r);
    order.push(r);
  }
  // Union-find over record ids AND over sameAs targets that are not loaded: two records that both say "I am gaia:X" are the same star
  // even when gaia:X itself is not in the data (the Hipparcos record and the planet-host record of a bright star the Gaia subset lacks).
  const parent = new Map<UniversalId, UniversalId>();
  const find = (x: UniversalId): UniversalId => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    for (let c = x; c !== r;) { const n = parent.get(c)!; parent.set(c, r); c = n; }
    return r;
  };
  for (const r of order) find(r.id);
  for (const r of order) for (const s of r.sameAs ?? []) if (s !== r.id) parent.set(find(r.id), find(s));
  const pos = new Map<UniversalId, number>(order.map((r, i) => [r.id, i] as const));
  const groups = new Map<UniversalId, DiscoveryRecord[]>();
  for (const r of order) { const k = find(r.id); const g = groups.get(k); if (g) g.push(r); else groups.set(k, [r]); }
  // Only stars merge. A member that is not a star (or an unclassified Gaia source) is left alone and reported.
  const finalGroups: DiscoveryRecord[][] = [];
  for (const g of groups.values()) {
    if (g.length < 2) { finalGroups.push(g); continue; }
    const ok = g.filter(mergeable);
    for (const r of g) if (!mergeable(r)) { warnings.push(`sameAs links ${r.id} (${r.category}) to other records: ignored, only stars merge`); finalGroups.push([r]); }
    if (ok.length > 1 && ok.some((r) => r.category !== 'other')) finalGroups.push(ok);
    else { if (ok.length > 1) warnings.push(`sameAs links ${ok.map((r) => r.id).join(', ')}: none is a classified star, not merged`); for (const r of ok) finalGroups.push([r]); }
  }

  const aliases = new Map<UniversalId, UniversalId>();
  const merges: { canonical: UniversalId; absorbed: UniversalId[] }[] = [];
  const mergedBy = new Map<UniversalId, DiscoveryRecord>();       // canonical id -> merged record
  const drop = new Set<UniversalId>();
  for (const g of finalGroups) {
    if (g.length === 1) continue;
    const sorted = [...g].sort((a, b) => priorityOf(a.dataset) - priorityOf(b.dataset) || pos.get(a.id)! - pos.get(b.id)!);
    const win = sorted[0]!;
    const donors = sorted.slice(1);
    const measurements: Meas = { ...win.measurements };
    for (const k of INDEPENDENT_KEYS) {
      if (measurements[k] !== undefined) continue;
      const d = donors.find((x) => x.measurements[k] !== undefined);
      if (d) measurements[k] = { ...d.measurements[k]!, source: d.dataset };
    }
    let position = win.position;
    if (win.position.kind !== 'icrs' && measurements.distancePc === undefined) {
      const d = donors.find((x) => x.position.kind === 'icrs' && x.measurements.distancePc !== undefined);
      if (d) {
        position = d.position;
        for (const k of DISTANCE_GROUP) if (measurements[k] === undefined && d.measurements[k] !== undefined) measurements[k] = { ...d.measurements[k]!, source: d.dataset };
      }
    }
    const designations = [...new Set([...win.designations, ...donors.flatMap((x) => x.designations)])];
    const donorName = donors.find((x) => isProperName(x.name))?.name;
    const name = !isProperName(win.name) && donorName !== undefined ? donorName : win.name;
    const sameAs = [...new Set([...(win.sameAs ?? []), ...donors.flatMap((x) => [x.id, ...(x.sameAs ?? [])])])].filter((x) => x !== win.id);
    const spectralType = win.spectralType ?? donors.find((x) => x.spectralType !== undefined)?.spectralType;
    const category: ObjectCategory = win.category === 'other' ? (donors.find((x) => STELLAR.has(x.category))?.category === 'exoplanet-host' || donors.some((x) => STELLAR.has(x.category)) ? 'star' : 'other') : win.category;
    mergedBy.set(win.id, { ...win, category, name, designations, position, measurements, sameAs, ...(spectralType !== undefined ? { spectralType } : {}) });
    for (const d of donors) { aliases.set(d.id, win.id); drop.add(d.id); }
    merges.push({ canonical: win.id, absorbed: donors.map((d) => d.id) });
  }
  const result: DiscoveryRecord[] = [];
  for (const r of order) {
    if (drop.has(r.id)) continue;
    result.push(mergedBy.get(r.id) ?? r);
  }
  if (opts.followHost && aliases.size > 0) {
    const at = new Map(result.map((r, i) => [r.id, i] as const));
    for (const [dep, host] of opts.followHost) {
      const di = at.get(dep), hi = at.get(aliases.get(host) ?? host);
      if (di === undefined || hi === undefined || !aliases.has(host)) continue;       // only hosts that were merged away change anything
      const h = result[hi]!, d = result[di]!;
      const dist = h.measurements.distancePc;
      const { distancePc: _drop, ...rest } = d.measurements;
      void _drop;
      result[di] = { ...d, position: h.position, measurements: dist ? { ...rest, distancePc: dist } : rest };
    }
  }
  return { records: result, aliases, merges, warnings };
}
