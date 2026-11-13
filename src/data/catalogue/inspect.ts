import type { CelestialObject, Fact, ImageryNote, Measurement, MeasurementKind } from '../schema';
import { FLAG_DESCRIPTIONS, type QualityFlag } from './flags';
import type { DeepSpaceData } from '../deepspace/deepSpaceData';
import type { DeepImageAsset, DeepSpaceObject, Representation, RepresentationKind } from '../deepspace/types';
import { wavelengthInfo } from '../deepspace/wavelengths';
import { equatorialToGalactic } from '../../core/astro/coordinates';
import type { PointRowInfo } from '../../render/deep-space/types';
import { DATASET_LABELS, formatMeasurement as formatDiscoveryMeasurement } from '../../discovery/discover';
import { MEASUREMENT_KEYS, MEASUREMENT_META } from '../../discovery/recordStore';
import type { DatasetId, DiscoveryNote, DiscoveryRecord, MeasurementKey, NoteClaim } from '../../discovery/types';
import { placementNotice } from '../../ui/discovery/labels';

export interface InspectorField {
  readonly key: string;
  readonly label: string;
  readonly available: boolean;
  /** Formatted value, or "Unavailable". */
  readonly value: string;
  readonly unit: string;
  readonly uncertainty?: string;
  readonly kind?: MeasurementKind;
  readonly source?: string;
  readonly epoch?: string;
  readonly transformations?: readonly string[];
  readonly note?: string;
  /** Why it is unavailable. */
  readonly reason?: string;
  /** Visible explanatory line under the row (method, basis, caveat). */
  readonly detail?: string;
}

export interface InspectorSection {
  readonly title: string;
  readonly fields: readonly InspectorField[];
}

/** A short statement shown under the title: why something is limited or missing (never colour only: it has text and a label). */
export interface InspectorNotice { readonly tone: 'warn' | 'info'; readonly label: string; readonly text: string }

export interface InspectorModel {
  /** Universal id of a discovery record, when the model was built from one (the discovery interface attaches relations, explanation and actions to it). */
  readonly recordId?: string;
  /** Visible notices: 'Not placed in 3D', 'Low reliability' ... */
  readonly notices?: readonly InspectorNotice[];
  readonly name: string;
  readonly classification: string;
  readonly designations: readonly string[];
  readonly referenceFrame: string;
  readonly sections: readonly InspectorSection[];
  readonly provenance: readonly string[];
  readonly flags: readonly { readonly flag: string; readonly description: string }[];
  readonly notes: string;
  readonly facts: readonly Fact[];
  readonly imagery?: ImageryNote;
  /** Deep-space objects only: the 'What you are seeing' block. */
  readonly representation?: RepresentationBlock;
  /** Deep-space objects only: provenance of the displayed image (undefined = no image is drawn). */
  readonly imageProvenance?: ImageProvenanceBlock;
  /** Deep-space objects only: every image band available for the object (the UI shows a switcher when there is more than one). */
  readonly bands?: readonly BandChoice[];
  /** Deep-space objects only: what is shown when no image is drawn. */
  readonly noImageNote?: string;
}

export type RepresentationTone = 'members' | 'image' | 'deprojected' | 'model' | 'illustrative';
export interface RepresentationBlock {
  readonly kind: RepresentationKind;
  /** Text label of the badge (never colour only). */
  readonly badge: string;
  readonly tone: RepresentationTone;
  /** What this kind of representation means in general. */
  readonly meaning: string;
  readonly summary: string;
  readonly depth: string;
  readonly exaggerations: readonly string[];
}
export interface BandChoice { readonly assetId: string; readonly label: string; readonly band: string; readonly falseColour: boolean }
export interface ImageProvenanceBlock {
  readonly assetId: string;
  readonly title: string;
  readonly archive: string;
  readonly imageId: string;
  readonly landingUrl: string;
  /** Verbatim credit line: displaying it is required by the licence. */
  readonly credit: string;
  readonly licenceName: string;
  readonly licenceUrl: string;
  readonly attributionRequired: boolean;
  readonly telescope: string;
  readonly instrument?: string;
  readonly date?: string;
  readonly bandLabel: string;
  readonly bandReveals: string;
  readonly filters: readonly string[];
  readonly falseColour: boolean;
  readonly composite: boolean;
  readonly colourNote: string;
  /** Always present for non-visible or false-colour pictures: the image is not how the object would look to the eye. */
  readonly notAnEyeView?: string;
  /**
   * Plain statement about coverage and the default choice: set when this picture covers less than half of the object's catalogue
   * extent (a strip or partial field), and when the default band is not visible light because the visible picture is such a strip.
   */
  readonly coverageNote?: string;
  readonly fovArcmin: readonly [number, number];
  readonly fidelity: string;
  readonly fidelityLabel: string;
  readonly processing: readonly string[];
}

const DEFAULT_DECIMALS: Readonly<Record<string, number>> = { count: 0, Msun: 0, Myr: 0, dex: 2, arcmin: 2, kpc: 2, Mpc: 3, 'log10(yr)': 2, deg: 8, mas: 3, 'mas/yr': 3, mag: 3, pc: 2, K: 0, dimensionless: 3, kg: 4, m: 0, 'km/s': 2 };

/** Round the uncertainty to 2 significant figures and show the value to the same decimal place. */
export function formatMeasurement(m: Measurement): { value: string; uncertainty?: string } {
  const sameUnit = m.uncertaintyUnit === undefined || m.uncertaintyUnit === m.unit;
  let dec = DEFAULT_DECIMALS[m.unit] ?? 4;
  if (m.uncertainty !== undefined && m.uncertainty > 0 && sameUnit) {
    dec = Math.min(10, Math.max(0, 1 - Math.floor(Math.log10(m.uncertainty))));
  }
  const abs = Math.abs(m.value);
  const value = abs !== 0 && (abs >= 1e7 || abs < 1e-4) ? m.value.toExponential(4) : m.value.toFixed(dec);
  if (m.uncertainty === undefined) return { value };
  const uUnit = m.uncertaintyUnit ?? m.unit;
  // Same rule as the value: scientific notation for very large or very small uncertainties (a mass uncertainty can be 1e18 kg).
  const big = m.uncertainty >= 1e7 || (m.uncertainty > 0 && m.uncertainty < 1e-4);
  const uDec = m.uncertainty > 0 ? Math.min(10, Math.max(0, 1 - Math.floor(Math.log10(m.uncertainty)))) : 0;
  return { value, uncertainty: `±${big ? m.uncertainty.toExponential(2) : m.uncertainty.toFixed(uDec)} ${uUnit}` };
}

interface Spec { key: string; label: string; unavailableKeys?: readonly string[] }

const SOLAR_SECTIONS: readonly { title: string; specs: readonly Spec[] }[] = [
  { title: 'Physical', specs: [
    { key: 'mean_radius', label: 'Mean radius' }, { key: 'equatorial_radius', label: 'Equatorial radius' }, { key: 'polar_radius', label: 'Polar radius' },
    { key: 'mass', label: 'Mass' }, { key: 'density', label: 'Mean density' }, { key: 'surface_gravity', label: 'Surface gravity' },
    { key: 'escape_velocity', label: 'Escape velocity' }, { key: 'temperature', label: 'Temperature' }, { key: 'effective_temperature', label: 'Effective temperature' },
    { key: 'luminosity', label: 'Luminosity' }, { key: 'geometric_albedo', label: 'Geometric albedo' },
  ] },
  { title: 'Rotation', specs: [{ key: 'rotation_period', label: 'Rotation period' }, { key: 'obliquity', label: 'Axial tilt' }] },
  { title: 'Orbit', specs: [
    { key: 'orbital_period', label: 'Orbital period' }, { key: 'semi_major_axis', label: 'Distance from parent (semi-major axis)' },
    { key: 'eccentricity', label: 'Eccentricity' }, { key: 'inclination', label: 'Inclination' },
  ] },
];

/** Keys that are simply omitted (not shown as "Unavailable") when absent, because they do not apply to the body type. */
const OPTIONAL_SOLAR_KEYS: ReadonlySet<string> = new Set(['equatorial_radius', 'polar_radius', 'effective_temperature', 'luminosity', 'escape_velocity', 'orbital_period', 'semi_major_axis', 'eccentricity', 'inclination', 'obliquity', 'temperature', 'geometric_albedo']);

const SECTIONS: readonly { title: string; specs: readonly Spec[] }[] = [
  { title: 'Position', specs: [{ key: 'ra', label: 'Right ascension' }, { key: 'dec', label: 'Declination' }, { key: 'gal_l', label: 'Galactic longitude' }, { key: 'gal_b', label: 'Galactic latitude' }] },
  { title: 'Distance', specs: [{ key: 'distance', label: 'Distance' }] },
  { title: 'Astrometry', specs: [{ key: 'parallax', label: 'Parallax' }, { key: 'pmra', label: 'Proper motion RA*', unavailableKeys: ['proper_motion'] }, { key: 'pmdec', label: 'Proper motion Dec', unavailableKeys: ['proper_motion'] }, { key: 'ruwe', label: 'RUWE' }] },
  { title: 'Photometry', specs: [{ key: 'g_mag', label: 'G magnitude' }, { key: 'bp_mag', label: 'BP magnitude' }, { key: 'rp_mag', label: 'RP magnitude' }, { key: 'bp_rp', label: 'BP − RP colour' }, { key: 'abs_g_mag', label: 'Absolute G (no extinction)' }] },
  { title: 'Modelled', specs: [{ key: 'teff_gspphot', label: 'Teff (GSP-Phot model)' }] },
];

function describeSource(m: Measurement): string {
  const s = m.source;
  return [s.source, s.release, s.recordId ? `id ${s.recordId}` : null, `retrieved ${s.retrieved}`].filter(Boolean).join(' · ');
}

function field(obj: CelestialObject, spec: Spec): InspectorField {
  const measurement = spec.key === 'distance' ? obj.sky?.distance : obj.measurements?.[spec.key];
  const reason = obj.unavailable?.[spec.key] ?? spec.unavailableKeys?.map((k) => obj.unavailable?.[k]).find(Boolean) ?? 'Not provided by the catalogue.';
  return fieldOf(measurement, spec.key, spec.label, reason);
}

function fieldOf(measurement: Measurement | undefined, key: string, label: string, reason: string): InspectorField {
  const spec = { key, label };
  if (!measurement) {
    return { key: spec.key, label: spec.label, available: false, value: 'Unavailable', unit: '', reason };
  }
  const f = formatMeasurement(measurement);
  return {
    key: spec.key, label: spec.label, available: true, value: f.value, unit: measurement.unit,
    ...(f.uncertainty ? { uncertainty: f.uncertainty } : {}),
    kind: measurement.kind,
    source: describeSource(measurement),
    ...(measurement.epoch ? { epoch: measurement.epoch } : {}),
    ...(measurement.transformations ? { transformations: measurement.transformations } : {}),
    ...(measurement.note ? { note: measurement.note } : {}),
  };
}

export function inspectObject(obj: CelestialObject, opts: { extraSections?: readonly InspectorSection[] } = {}): InspectorModel {
  const solar = obj.classification === 'planet' || obj.classification === 'moon' || obj.frame === 'solar-system';
  const ident = obj.identification;
  const classification = ident
    ? `${ident.objectTypeLabel ?? ident.objectType} (SIMBAD type ${ident.objectType})${ident.spectralType ? ` · spectral type ${ident.spectralType}` : ''}`
    : solar ? (({ planet: 'Planet', moon: 'Natural satellite', star: 'Star (the Sun)' } as Record<string, string>)[obj.classification] ?? 'Solar System object')
    : obj.classification === 'star' ? 'Star' : 'Gaia source — not classified (no SIMBAD identification)';

  const layout = solar ? SOLAR_SECTIONS : SECTIONS;
  const sections: InspectorSection[] = layout
    .map((sec) => ({
      title: sec.title,
      // For Solar System bodies, a quantity that does not apply (a planet has no semi-major axis about a parent in this table, a
      // moon has no luminosity) is omitted; a quantity that should exist but is missing is shown as Unavailable with a reason.
      fields: sec.specs.map((spec) => field(obj, spec)).filter((f) => !(solar && !f.available && OPTIONAL_SOLAR_KEYS.has(f.key))),
    }))
    .filter((sec) => sec.fields.length > 0);
  if (opts.extraSections) sections.push(...opts.extraSections);
  const provenance: string[] = [];
  const gaiaM = obj.measurements?.['g_mag'] ?? obj.measurements?.['ra'];
  if (solar) {
    const seen = new Set<string>();
    for (const m of Object.values(obj.measurements ?? {})) {
      const line = `${m.source.source}${m.source.recordId ? ` (id ${m.source.recordId})` : ''} · retrieved ${m.source.retrieved}${m.source.url ? ` · ${m.source.url}` : ''}`;
      if (!seen.has(line)) { seen.add(line); provenance.push(line); }
    }
  } else if (gaiaM) provenance.push(`Astrometry and photometry: ${describeSource(gaiaM)} · ${gaiaM.source.url ?? ''}`.trim());
  if (ident) provenance.push(`Identification: ${describeSource({ value: 0, unit: 'dimensionless', kind: 'observed', source: ident.source })} · ${ident.source.url ?? ''}${ident.coordinateReference ? ` · SIMBAD coordinate reference ${ident.coordinateReference}` : ''}`.trim());
  const flags = (obj.qualityFlags ?? []).map((flag) => ({ flag, description: FLAG_DESCRIPTIONS[flag as QualityFlag] ?? flag }));

  return {
    name: obj.name,
    classification,
    designations: obj.designations,
    referenceFrame: obj.referenceFrame ?? 'not specified',
    sections,
    provenance,
    flags,
    notes: obj.notes ?? '',
    facts: obj.facts ?? [],
    ...(obj.imagery ? { imagery: obj.imagery } : {}),
  };
}

// ======================================================================================================================
// Deep-space objects and catalogue rows (galaxies, nebulae, clusters, groups, structure)
// ======================================================================================================================

const REPRESENTATION_BADGE: Readonly<Record<RepresentationKind, { badge: string; tone: RepresentationTone; meaning: string }>> = {
  'observed-members': { badge: 'OBSERVED MEMBERS', tone: 'members', meaning: 'Each drawn point is a catalogued object at its catalogued sky position. How its distance was obtained is stated in the summary.' },
  'observed-image': { badge: 'OBSERVED IMAGE', tone: 'image', meaning: 'A real telescope image placed where the object is on the sky. The image is flat: its depth is not measured.' },
  'deprojected-image': { badge: 'DEPROJECTED IMAGE', tone: 'deprojected', meaning: 'A real image re-mapped onto the galaxy’s disc plane using the published inclination and position angle. The tilt is a model; the picture itself is real.' },
  'documented-model': { badge: 'DOCUMENTED MODEL', tone: 'model', meaning: 'An analytic model from the literature with cited parameters. It is not a photograph and not a measurement of every part it draws.' },
  illustrative: { badge: 'ILLUSTRATIVE', tone: 'illustrative', meaning: 'A visual aid made for this application. It is not a measurement.' },
};
const DEPTH_TEXT: Readonly<Record<Representation['depth'], string>> = {
  'measured-per-object': 'measured for each object',
  'measured-cluster-mean': 'one measured mean distance for the whole set; individual depths are not used',
  'published-orientation-model': 'from a published inclination and position angle (a model); the near side may be unknown',
  'sky-plane-only': 'not measured: the image is flat, facing the Sun',
  illustrative: 'not measured: line-of-sight positions are drawn by the Atlas as described below',
  'illustrative-layers': 'the real image on the sky plane, plus illustrative depth layers that are not measured',
  'documented-model': 'from a documented model',
};
const FIDELITY_LABEL: Readonly<Record<string, string>> = {
  'scientific-image': 'Scientific image (data processed for display)',
  'multi-band-composite': 'Multi-band composite (colours assigned when combining bands)',
  'artist-processed': 'Artist-processed image (colour and contrast chosen by the processor)',
};

export function representationBlock(rep: Representation): RepresentationBlock {
  const b = REPRESENTATION_BADGE[rep.kind];
  return { kind: rep.kind, badge: b.badge, tone: b.tone, meaning: b.meaning, summary: rep.summary, depth: DEPTH_TEXT[rep.depth], exaggerations: rep.exaggerations ?? [] };
}

const fovText = (a: DeepImageAsset): string => `${a.geometry.fovArcmin[0].toPrecision(3)} \u00d7 ${a.geometry.fovArcmin[1].toPrecision(3)} arcmin`;
const fovMajor = (a: DeepImageAsset): number => Math.max(a.geometry.fovArcmin[0], a.geometry.fovArcmin[1]);

/** What the coverage of the shown picture means (see ImageProvenanceBlock.coverageNote). `majorArcmin` is the catalogue extent of the object. */
export function imageCoverageNote(a: DeepImageAsset, siblings: readonly DeepImageAsset[], majorArcmin: number | undefined): string | undefined {
  if (!majorArcmin || !(majorArcmin > 0)) return undefined;
  const notes: string[] = [];
  const share = (x: DeepImageAsset) => Math.round((100 * fovMajor(x)) / majorArcmin);
  if (fovMajor(a) < 0.5 * majorArcmin) {
    notes.push(`This picture is a partial field: ${fovText(a)}, about ${share(a)}% of the object's catalogue extent (${majorArcmin.toPrecision(3)} arcmin). The rest of the object is not covered by this image.`);
  }
  const nonVisible = a.band.kind !== 'visible' && a.band.kind !== 'multi-band-composite';
  if (nonVisible) {
    const partial = siblings.filter((x) => x.id !== a.id && (x.band.kind === 'visible' || x.band.kind === 'multi-band-composite') && fovMajor(x) < 0.5 * majorArcmin);
    if (partial.length) {
      notes.push(`This default is a ${wavelengthInfo(a.band.kind).label.toLowerCase()} map, not a visible-light picture: the visible-light image available (${partial.map((x) => `${x.title}, field ${fovText(x)}`).join('; ')}) covers only a strip of the object, so the full-extent map is shown first. Choose the visible band with the band buttons to see the strip in place.`);
    }
  }
  return notes.length ? notes.join(' ') : undefined;
}

/** Region of the spectrum a single filter label belongs to, or null when it is visible light (or cannot be told). */
function filterRegion(label: string): string | null {
  const l = label.toLowerCase();
  if (/x-?ray|chandra|rosat/.test(l)) return 'X-ray';
  if (/galex|\b[fn]uv\b|ultraviolet/.test(l)) return 'ultraviolet';
  if (/laboca|submm|submillimet|radio/.test(l)) return 'submillimetre/radio';
  const m = /(\d+(?:\.\d+)?)\s*(nm|um|\u00b5m|micron)/.exec(l);
  if (m) {
    const nm = Number(m[1]) * (m[2] === 'nm' ? 1 : 1000);
    if (nm < 380) return 'ultraviolet';
    if (nm > 750 && nm <= 2500) return 'near-infrared';
    if (nm > 2500 && nm <= 30000) return 'mid-infrared';
    if (nm > 30000) return 'far-infrared/submillimetre';
    return null;
  }
  if (/^z\b/.test(l)) return 'near-infrared'; // z-band (~900 nm) when only the band letter is given
  return null;
}
/**
 * What part of an image is NOT visible light, from its band kind AND its listed filters (a multi-band composite can be infrared only,
 * or add X-ray / submillimetre data / a near-infrared channel to optical ones).
 */
export function nonVisibleContent(a: DeepImageAsset): { readonly any: boolean; readonly all: boolean; readonly regions: readonly string[] } {
  const regions = new Set<string>();
  let visibleFilters = 0;
  for (const f of a.band.filters) {
    const r = filterRegion(f);
    if (r) regions.add(r); else visibleFilters++;
  }
  const kindNonVisible = a.band.kind !== 'visible' && a.band.kind !== 'multi-band-composite';
  if (kindNonVisible && regions.size === 0) regions.add(a.band.kind);
  const all = kindNonVisible || (a.band.filters.length > 0 && visibleFilters === 0 && regions.size > 0);
  return { any: regions.size > 0, all, regions: [...regions] };
}

export function imageProvenanceBlock(a: DeepImageAsset, ctx?: { siblings: readonly DeepImageAsset[]; majorArcmin: number | undefined }): ImageProvenanceBlock {
  const coverage = ctx ? imageCoverageNote(a, ctx.siblings, ctx.majorArcmin) : undefined;
  const w = wavelengthInfo(a.band.kind);
  const nv = nonVisibleContent(a);
  const nonVisibleNote = !nv.any ? '' : nv.all ? `This band is not visible light: the image contains no visible light (${nv.regions.join(', ')} only).` : `Part of this image is not visible light (includes ${nv.regions.join(', ')} data).`;
  const notEye = nv.any || a.band.falseColour
    ? ['Not how it would look to the eye.', nonVisibleNote, a.band.falseColour ? 'The colours are assigned by the image makers.' : '', a.band.composite ? 'Several exposures or bands were combined.' : ''].filter(Boolean).join(' ')
    : undefined;
  return {
    assetId: a.id, title: a.title, archive: a.source.archive, imageId: a.source.imageId, landingUrl: a.source.landingUrl,
    credit: a.credit, licenceName: a.licence.name, licenceUrl: a.licence.url, attributionRequired: a.licence.attributionRequired,
    telescope: a.observation.telescope, ...(a.observation.instrument ? { instrument: a.observation.instrument } : {}), ...(a.observation.date ? { date: a.observation.date } : {}),
    bandLabel: nv.any && a.band.kind === 'multi-band-composite' ? `${w.label} (${nv.all ? `${nv.regions.join(', ')} only` : `includes ${nv.regions.join(', ')}`})` : w.label, bandReveals: `${w.reveals} ${w.colour}`, filters: a.band.filters, falseColour: a.band.falseColour, composite: a.band.composite, colourNote: a.band.colourNote,
    ...(notEye ? { notAnEyeView: notEye } : {}),
    ...(coverage ? { coverageNote: coverage } : {}),
    fovArcmin: a.geometry.fovArcmin, fidelity: a.fidelity, fidelityLabel: FIDELITY_LABEL[a.fidelity] ?? a.fidelity, processing: a.processing,
  };
}

const shortTelescope = (t: string): string => t.split(/[(,;]| plus | with | and /)[0]!.trim().replace(/ \(.*$/, '');

/** Short label for a band button: the band, plus a hint (telescope, else channel) when several assets share the band. */
function bandChoices(assets: readonly DeepImageAsset[]): BandChoice[] {
  return assets.map((a) => {
    const base = wavelengthInfo(a.band.kind).label;
    const same = assets.filter((o) => o.band.kind === a.band.kind);
    let hint = '';
    if (same.length > 1) {
      const tel = shortTelescope(a.observation.telescope);
      const telShared = same.filter((o) => shortTelescope(o.observation.telescope) === tel).length > 1;
      hint = telShared ? (a.band.filters[0] ?? a.observation.instrument ?? tel) : tel;
      if (hint.length > 28) hint = `${hint.slice(0, 26)}\u2026`;
    }
    return { assetId: a.id, label: hint ? `${base} \u00b7 ${hint}` : base, band: a.band.kind, falseColour: a.band.falseColour };
  });
}

/** de Vaucouleurs T-type names (the RC3 convention; Third Reference Catalogue of Bright Galaxies, de Vaucouleurs et al. 1991). */
export const DE_VAUCOULEURS_T: Readonly<Record<number, string>> = {
  [-6]: 'compact elliptical (cE)', [-5]: 'elliptical (E)', [-4]: 'elliptical, early (E+)', [-3]: 'lenticular, early (S0−)', [-2]: 'lenticular (S0°)', [-1]: 'lenticular, late (S0+)',
  0: 'S0/a', 1: 'Sa', 2: 'Sab', 3: 'Sb', 4: 'Sbc', 5: 'Sc', 6: 'Scd', 7: 'Sd', 8: 'Sdm', 9: 'Sm', 10: 'Im (irregular, Magellanic)', 11: 'compact irregular (cI)',
};
/** "T=3" or 3 -> "T = 3: Sb (de Vaucouleurs T-type, RC3 convention)". undefined if the string is not a T-type. */
export function describeTType(v: string | number | null | undefined): string | undefined {
  if (v === null || v === undefined) return undefined;
  const m = typeof v === 'number' ? [String(v), String(v)] : /^T\s*=\s*(-?\d+)$/.exec(v.trim());
  if (!m) return undefined;
  const t = Number(m[1]);
  const name = DE_VAUCOULEURS_T[t];
  return name ? `T = ${t}: ${name}. de Vaucouleurs T-type, standard RC3 convention (a numeric stage along the Hubble sequence).` : undefined;
}

const GALAXY_CLASS_LABEL: Readonly<Record<string, string>> = {
  spiral: 'Spiral', 'barred-spiral': 'Barred spiral', lenticular: 'Lenticular', elliptical: 'Elliptical', irregular: 'Irregular',
  'dwarf-spheroidal': 'Dwarf spheroidal / dwarf elliptical', 'dwarf-irregular': 'Dwarf irregular', peculiar: 'Peculiar',
};
const NEBULA_CLASS_LABEL: Readonly<Record<string, string>> = {
  emission: 'Emission nebula', reflection: 'Reflection nebula', dark: 'Dark nebula', planetary: 'Planetary nebula', 'supernova-remnant': 'Supernova remnant', 'molecular-cloud': 'Molecular cloud',
};
const CLUSTER_CLASS_LABEL: Readonly<Record<string, string>> = { open: 'Open cluster', globular: 'Globular cluster' };
const KIND_LABEL: Readonly<Record<string, string>> = { galaxy: 'Galaxy', nebula: 'Nebula', 'star-cluster': 'Star cluster', 'galaxy-group': 'Galaxy group', 'galaxy-cluster': 'Galaxy cluster', 'cosmic-structure': 'Large-scale structure' };
const NEAR_SIDE: Readonly<Record<string, string>> = { 'north-east': 'north-east edge nearer', 'south-west': 'south-west edge nearer', 'north-west': 'north-west edge nearer', 'south-east': 'south-east edge nearer' };

const LABELS: Readonly<Record<string, string>> = {
  magB: 'Apparent B magnitude', magV: 'Apparent V magnitude', magK: 'Apparent K magnitude', magB_total_hyperleda: 'Total B magnitude (HyperLEDA)', magV_total_harris: 'Total V magnitude (Harris)',
  absMagB: 'Absolute B magnitude', absMagV: 'Absolute V magnitude', radialVelocity: 'Radial velocity (heliocentric)', physicalDiameterD25: 'Physical diameter (D25, catalogue distance)', physicalDiameter: 'Physical diameter',
  angularMajorAxisSimbad: 'Angular major axis (SIMBAD)', distanceModulus: 'Distance modulus', memberCount: 'Members in the membership list', memberCountProperMotion: 'Members (proper-motion selection)',
  memberCountRadialVelocity: 'Members (radial-velocity selection)', logAge: 'log age', age: 'Age', extinctionAV: 'Extinction A(V)', halfNumberRadius: 'Half-number radius', tidalRadius: 'Tidal radius', totalRadius: 'Total radius',
  meanParallax: 'Mean parallax', meanPmRa: 'Mean proper motion RA*', meanPmDec: 'Mean proper motion Dec', metallicityFeH: 'Metallicity [Fe/H]', mass: 'Mass', halfLightRadiusProjected: 'Half-light radius (projected)',
  colourExcessEBV: 'Colour excess E(B−V)', sunGalacticCentreDistance: 'Sun to Galactic Centre distance', stellarMass: 'Stellar mass', thinDiscScaleLength: 'Thin disc scale length', thinDiscScaleHeight: 'Thin disc scale height',
  thickDiscScaleLength: 'Thick disc scale length', thickDiscScaleHeight: 'Thick disc scale height', longBarHalfLength: 'Long bar half-length', barAngle: 'Bar angle', virialMass: 'Virial mass', emissionLines: 'Emission lines',
  angularSize: 'Angular size', orientation: 'Orientation', sky: 'Sky position',
};
const labelOf = (key: string): string => LABELS[key] ?? key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

function textField(key: string, label: string, value: string, extra: Partial<InspectorField> = {}): InspectorField {
  return { key, label, available: true, value, unit: '', ...extra };
}
function unavailable(key: string, label: string, reason: string): InspectorField { return { key, label, available: false, value: 'Unavailable', unit: '', reason }; }

const hubbleCaveat = (m: Measurement): string | undefined => {
  const t = `${m.note ?? ''} ${(m.transformations ?? []).join(' ')}`;
  return /hubble|redshift distance|from the redshift|cz\s*\//i.test(t) && !/redshift-independent/i.test(t)
    ? 'Hubble-flow estimate from the redshift: peculiar velocities (hundreds of km/s) shift it, so individual distances can be off by several Mpc.' : undefined;
};

function distanceField(m: Measurement | undefined, reason: string): InspectorField {
  if (!m) return unavailable('distance', 'Distance', reason);
  const f = fieldOf(m, 'distance', 'Distance', reason);
  const method = m.note ? m.note : undefined;
  const detail = [method, hubbleCaveat(m)].filter(Boolean).join(' ');
  return { ...f, ...(f.uncertainty ? {} : { uncertainty: 'no published uncertainty' }), ...(detail ? { detail } : {}) };
}

/** Sections shared by every deep-space object, built from DeepSpaceData.toCelestialObject plus the raw record. */
function deepSections(o: DeepSpaceObject, obj: CelestialObject, assets: readonly DeepImageAsset[]): InspectorSection[] {
  const M = obj.measurements ?? {};
  const U = obj.unavailable ?? {};
  const used = new Set<string>();
  const get = (key: string, label = labelOf(key), reason?: string): InspectorField => { used.add(key); return fieldOf(M[key], key, label, reason ?? U[key] ?? 'Not provided by the catalogue used.'); };
  const optional = (keys: readonly string[]): InspectorField[] => keys.filter((k) => M[k] || U[k]).map((k) => get(k));
  const sections: InspectorSection[] = [];

  // Identity: coarse class (derived by the Atlas from the catalogue's own string) AND the string.
  const identity: InspectorField[] = [textField('kind', 'Object type', KIND_LABEL[o.kind] ?? o.kind)];
  if (o.galaxyClass) identity.push(textField('class', 'Morphology class', GALAXY_CLASS_LABEL[o.galaxyClass] ?? o.galaxyClass, { kind: 'derived', source: 'Atlas classifier applied to the catalogue string below', note: 'A coarse class chosen from the morphology string below (a catalogue string, or for the Milky Way a literature range stated there); it is never used to override the label.' }));
  if (o.nebulaClass) identity.push(textField('class', 'Nebula class', NEBULA_CLASS_LABEL[o.nebulaClass] ?? o.nebulaClass));
  if (o.clusterClass) identity.push(textField('class', 'Cluster class', CLUSTER_CLASS_LABEL[o.clusterClass] ?? o.clusterClass));
  if (o.morphologyLabel) {
    if (o.morphologyNote) identity.push(textField('morphology', 'Morphology (literature range, adopted by the Atlas)', o.morphologyLabel, { detail: o.morphologyNote }));
    else {
      const tt = describeTType(o.morphologyLabel);
      identity.push(textField('morphology', o.kind === 'galaxy' ? 'Morphology (catalogue string)' : 'Catalogue type', o.morphologyLabel, { detail: tt ?? 'As given by the catalogue; not edited.' }));
    }
  } else if (o.kind === 'galaxy') identity.push(unavailable('morphology', 'Morphology (catalogue string)', U['morphology'] ?? 'The catalogue gives no morphology string for this object.'));
  sections.push({ title: 'Identity', fields: identity });

  // Position
  const pos: InspectorField[] = [];
  if (o.sky) {
    const src = o.sky.coordinateSource;
    const srcText = [src.source, src.release, src.recordId ? `id ${src.recordId}` : null, `retrieved ${src.retrieved}`].filter(Boolean).join(' · ');
    pos.push(textField('ra', 'Right ascension (ICRS)', o.sky.raDeg.toFixed(5), { unit: 'deg', kind: 'observed', source: srcText }));
    pos.push(textField('dec', 'Declination (ICRS)', o.sky.decDeg.toFixed(5), { unit: 'deg', kind: 'observed', source: srcText }));
    const g = equatorialToGalactic(o.sky.raDeg, o.sky.decDeg);
    const tr = ['rotation of the ICRS direction into Galactic coordinates (IAU 1958 Galactic system, standard matrix)'];
    pos.push(textField('gal_l', 'Galactic longitude l', g.lDeg.toFixed(4), { unit: 'deg', kind: 'derived', source: 'atlas-derived from RA/Dec', transformations: tr }));
    pos.push(textField('gal_b', 'Galactic latitude b', g.bDeg.toFixed(4), { unit: 'deg', kind: 'derived', source: 'atlas-derived from RA/Dec', transformations: tr }));
  } else pos.push(unavailable('sky', 'Sky position', U['sky'] ?? 'No single catalogue position.'));
  sections.push({ title: 'Position', fields: pos });

  // Distance
  used.add('distance');
  sections.push({ title: 'Distance', fields: [distanceField(M['distance'], U['distance'] ?? 'No distance in the catalogues used.'), ...optional(['distanceModulus'])] });

  // Brightness
  const bright = o.kind === 'galaxy' || o.kind === 'nebula' || o.kind === 'star-cluster';
  if (bright) {
    const keys = ['magB', 'magV', 'magK', 'magB_total_hyperleda', 'magV_total_harris', 'absMagB', 'absMagV'];
    const fields = [...optional(keys)];
    if (!keys.some((k) => M[k]) && !keys.some((k) => U[k])) fields.push(unavailable('mag', 'Apparent magnitude', 'No magnitude was retrieved for this object.'));
    if (o.id !== 'milky-way') sections.push({ title: 'Brightness', fields });
    else if (U['magV']) sections.push({ title: 'Brightness', fields: [get('magV', 'Apparent V magnitude', 'We are inside the Galaxy: it has no apparent magnitude as a whole.')] });
  }

  // Size
  const size: InspectorField[] = [];
  if (o.angularSize) {
    const a = o.angularSize;
    const srcText = [a.source.source, a.source.release, a.source.recordId ? `id ${a.source.recordId}` : null, `retrieved ${a.source.retrieved}`].filter(Boolean).join(' · ');
    size.push(textField('angular_size', 'Angular size (major axis)', a.majorArcmin.toFixed(2), { unit: 'arcmin', kind: 'observed', source: srcText, detail: a.definition.length > 160 ? `${a.definition.slice(0, 157)}...` : a.definition }));
    if (a.minorArcmin !== undefined) size.push(textField('angular_minor', 'Angular size (minor axis)', a.minorArcmin.toFixed(2), { unit: 'arcmin', kind: 'observed', source: srcText }));
  } else size.push(unavailable('angular_size', 'Angular size', U['angularSize'] ?? 'No angular size in the catalogues used.'));
  used.add('angular_size');
  size.push(M['physical_size'] ? get('physical_size', 'Physical size (derived)') : unavailable('physical_size', 'Physical size (derived)', U['physical_size'] ?? 'Needs both an angular size and a distance.'));
  for (const k of ['physicalDiameterD25', 'physicalDiameter', 'angularMajorAxisSimbad', 'halfNumberRadius', 'tidalRadius', 'totalRadius', 'halfLightRadiusProjected']) if (M[k]) size.push(get(k));
  sections.push({ title: 'Size', fields: size });

  // Orientation (galaxies)
  if (o.kind === 'galaxy') {
    const f: InspectorField[] = [];
    if (o.orientation) {
      f.push(get('inclination', 'Inclination (0 = face-on)'), get('position_angle', 'Position angle (major axis, N through E)'));
      f.push(o.orientation.nearSide === 'unknown'
        ? textField('near_side', 'Nearer side', 'unknown', { detail: 'The published orientation does not say which edge is nearer: the tilt direction shown in the picture is a presentation choice.' })
        : textField('near_side', 'Nearer side', NEAR_SIDE[o.orientation.nearSide] ?? o.orientation.nearSide));
    } else f.push(unavailable('orientation', 'Inclination and position angle', U['orientation'] ?? 'No published disc orientation for this object; the image is shown flat, facing the Sun.'));
    sections.push({ title: 'Orientation', fields: f });
    // Redshift
    const v = M['radialVelocity'];
    const kin: InspectorField[] = [];
    if (v) {
      kin.push(get('radialVelocity'));
      if (v.unit === 'km/s' && Math.abs(v.value) < 30000) {
        kin.push(textField('redshift', 'Redshift z (non-relativistic)', (v.value / 299792.458).toExponential(3), { kind: 'derived', source: 'atlas-derived from the radial velocity', transformations: ['z = v / c with c = 299 792.458 km/s (valid for small velocities)'], detail: v.value < 0 ? 'Negative: the galaxy is approaching (blueshift) from our local motion plus its own.' : 'For nearby galaxies much of this is peculiar motion, not cosmic expansion.' }));
      }
    } else kin.push(unavailable('redshift', 'Redshift / radial velocity', U['radialVelocity'] ?? 'No radial velocity in the catalogues used.'));
    sections.push({ title: 'Redshift', fields: kin });
  } else if (M['radialVelocity']) sections.push({ title: 'Motion', fields: [get('radialVelocity'), ...optional(['meanPmRa', 'meanPmDec', 'meanParallax'])] });

  // Nebulae: emission and wavelengths
  if (o.kind === 'nebula') {
    const f: InspectorField[] = [];
    if (M['emissionLines']) f.push(get('emissionLines'));
    else f.push(unavailable('emissionLines', 'Emission lines', U['emissionLines'] ?? 'No emission-line measurement was retrieved for this object.'));
    f.push(textField('emission_note', 'Emission characteristics', (o.facts ?? []).length ? 'see Context' : 'none retrieved', { detail: 'Only facts published by the cited sources are listed under Context; none are inferred here.' }));
    sections.push({ title: 'Emission', fields: f });
  }

  // Clusters: members, age, composition
  if (o.kind === 'star-cluster') {
    const f: InspectorField[] = [...optional(['memberCount', 'memberCountProperMotion', 'memberCountRadialVelocity'])];
    const mc = M['memberCount'] ?? M['memberCountProperMotion'];
    f.push(textField('members_basis', 'Membership list', mc ? (mc.note ?? 'see source') : 'not recorded', { detail: mc ? `${mc.source.release ?? mc.source.source}${mc.source.recordId ? ` · ${mc.source.recordId}` : ''}${o.pointsFileId ? ` · stars drawn from point file "${o.pointsFileId}"` : ''}` : undefined }));
    f.push(...optional(['age', 'logAge', 'metallicityFeH', 'extinctionAV', 'colourExcessEBV', 'mass']));
    if (!M['age'] && !U['age']) f.push(unavailable('age', 'Age', 'No age was retrieved for this cluster.'));
    sections.push({ title: 'Cluster properties', fields: f });
  }

  // Groups and structure
  if (o.kind === 'galaxy-group' || o.kind === 'galaxy-cluster' || o.kind === 'cosmic-structure') {
    const f: InspectorField[] = [...optional(['memberCount'])];
    if (o.membership) {
      f.push(textField('member_names', 'Members listed', String(o.membership.names.length), { detail: `Selection basis: ${o.membership.basis}`, source: [o.membership.source.source, o.membership.source.release].filter(Boolean).join(' · ') }));
      f.push(textField('member_file', 'Member catalogue', o.membership.pointsFileId));
    } else f.push(unavailable('membership', 'Membership', U['membership'] ?? 'No membership list is attached to this structure.'));
    sections.push({ title: 'Membership', fields: f });
  }

  // Model parameters / anything else
  const rest: InspectorField[] = [];
  for (const k of Object.keys(M)) if (!used.has(k) && !['inclination', 'position_angle', 'physical_size', 'angular_size', 'distance'].includes(k)) rest.push(get(k));
  for (const k of Object.keys(U)) if (!used.has(k) && !['physical_size', 'sky', 'distance', 'angularSize', 'orientation'].includes(k)) rest.push(get(k));
  if (rest.length) sections.push({ title: o.id === 'milky-way' ? 'Model parameters (documented)' : 'Other measurements', fields: rest });

  // Observational wavelengths of available images
  if (o.kind !== 'star-cluster' && o.kind !== 'galaxy-group' && o.kind !== 'galaxy-cluster' && o.kind !== 'cosmic-structure') {
    const w: InspectorField[] = assets.length
      ? assets.map((a) => textField(`band_${a.id}`, a.title.length > 46 ? `${a.title.slice(0, 44)}…` : a.title, wavelengthInfo(a.band.kind).label, { detail: `Filters: ${a.band.filters.join(', ') || 'not listed'}${a.band.falseColour ? ' · false colour' : ''}` }))
      : [unavailable('bands', 'Images', 'No image of this object is drawn: it is shown as catalogued points, a model, or a marker.')];
    sections.push({ title: 'Observational wavelengths', fields: w });
  }
  return sections;
}

export interface DeepInspectOptions {
  /** The asset currently drawn (viewer.deep.activeAsset); defaults to the object's first (preferred) asset. */
  readonly activeAssetId?: string | undefined;
}

/** Inspector model for a curated deep-space object. */
export function inspectDeepObject(data: DeepSpaceData, id: string, opts: DeepInspectOptions = {}): InspectorModel {
  const o = data.get(id);
  if (!o) throw new Error(`Unknown deep-space object "${id}"`);
  const obj = data.toCelestialObject(id);
  const assets = data.imageAssetsOf(id);
  const active = assets.find((a) => a.id === opts.activeAssetId) ?? assets[0];
  const classLabel = o.galaxyClass ? GALAXY_CLASS_LABEL[o.galaxyClass] : o.nebulaClass ? NEBULA_CLASS_LABEL[o.nebulaClass] : o.clusterClass ? CLUSTER_CLASS_LABEL[o.clusterClass] : KIND_LABEL[o.kind];
  const provenance: string[] = [];
  const seen = new Set<string>();
  const add = (m: Measurement | undefined) => {
    if (!m) return;
    const line = `${m.source.source}${m.source.release ? ` · ${m.source.release}` : ''}${m.source.recordId ? ` · ${m.source.recordId}` : ''} · retrieved ${m.source.retrieved}${m.source.url ? ` · ${m.source.url}` : ''}`;
    if (!seen.has(line)) { seen.add(line); provenance.push(line); }
  };
  if (o.sky) { const c = o.sky.coordinateSource; provenance.push(`Coordinates: ${c.source}${c.release ? ` · ${c.release}` : ''} · retrieved ${c.retrieved}${c.url ? ` · ${c.url}` : ''}`); }
  for (const m of Object.values(obj.measurements ?? {})) add(m);
  return {
    name: o.name,
    classification: `${classLabel}${o.morphologyLabel && o.kind === 'galaxy' ? (o.morphologyNote ? ` · literature morphology range ${o.morphologyLabel} (not a catalogue string)` : ` · catalogue morphology ${o.morphologyLabel}`) : ''}`,
    designations: o.designations,
    referenceFrame: o.id === 'milky-way' ? 'Sun-centred ICRS-aligned axes (the model is defined in Galactocentric coordinates)' : (obj.referenceFrame ?? 'ICRS'),
    sections: deepSections(o, obj, assets),
    provenance,
    flags: [],
    notes: o.notes ?? '',
    facts: obj.facts ?? [],
    representation: representationBlock(o.representation),
    ...(active ? { imageProvenance: imageProvenanceBlock(active, { siblings: assets, majorArcmin: o.angularSize?.majorArcmin }) } : {}),
    ...(assets.length ? { bands: bandChoices(assets) } : {}),
    ...(assets.length ? {} : { noImageNote: o.representation.kind === 'observed-members' ? 'No picture is drawn for this object: the points are catalogued members at their catalogued positions.' : o.representation.kind === 'documented-model' ? 'No photograph is drawn: this is a documented model.' : 'No image is available for this object.' }),
  };
}

const POINT_LABELS: Readonly<Record<string, string>> = {
  raDeg: 'Right ascension (ICRS)', decDeg: 'Declination (ICRS)', distMpc: 'Distance', distErrMpc: 'Distance error', distMethod: 'Distance method', morphology: 'Morphology / type (catalogue string)', bMag: 'Apparent B magnitude',
  vMag: 'Apparent V magnitude', kMag: 'Apparent Ks magnitude', ksMag: 'Ks magnitude (extinction-corrected)', ktMag: 'Total Ks magnitude (extinction-corrected)', diameterArcmin: 'Angular diameter', tType: 'de Vaucouleurs T-type',
  dwarfMorphology: 'Dwarf morphology class', surfaceBrightnessClass: 'Surface-brightness class', mainDisturber: 'Main tidal disturber', tidalIndex: 'Tidal index Θ₁', hrvKms: 'Heliocentric radial velocity',
  distModulusMag: 'Distance modulus', distModulusErrMag: 'Distance modulus error', ngcSimbadName: 'SIMBAD name', czKms: 'Redshift cz', czErrKms: 'cz error', glonDeg: 'Galactic longitude l', glatDeg: 'Galactic latitude b',
  czSource: 'cz source code', distErrUpMpc: 'Distance error (upper)', distErrLowMpc: 'Distance error (lower)', distRefs: 'Distance references', subgroup: 'Subgroup', halfLightRadiusArcmin: 'Half-light radius',
  sourceId: 'Gaia DR3 source id', gMag: 'Gaia G magnitude', bpRp: 'BP−RP colour', parallaxMas: 'Parallax', parallaxErrMas: 'Parallax error', pmraMasYr: 'Proper motion RA*', pmdecMasYr: 'Proper motion Dec',
  probability: 'Membership probability', insideTidalRadius: 'Inside the tidal radius',
};
const POINT_KIND_OBSERVED: ReadonlySet<string> = new Set(['raDeg', 'decDeg', 'bMag', 'vMag', 'kMag', 'ksMag', 'ktMag', 'diameterArcmin', 'hrvKms', 'czKms', 'czErrKms', 'gMag', 'bpRp', 'parallaxMas', 'parallaxErrMas', 'pmraMasYr', 'pmdecMasYr', 'glonDeg', 'glatDeg', 'halfLightRadiusArcmin']);
const NULL_REASON: Readonly<Record<string, string>> = {
  distErrMpc: 'The catalogue publishes no uncertainty on this distance (no published error).',
  distErrUpMpc: 'No published upper error for this galaxy.', distErrLowMpc: 'No published lower error for this galaxy.',
  bpRp: 'Gaia has no BP−RP colour for this star.', parallaxMas: 'No parallax in the catalogue for this star.', probability: 'The membership catalogue gives no probability for this star.',
};
const unitFromDescription = (d: string | undefined): string => {
  if (!d) return '';
  const head = d.split(/[,;(]/)[0]!.trim();
  return /^(deg|Mpc|kpc|mas|mas\/yr|mag|arcmin|km\/s)$/.test(head) ? head : '';
};

/** Human wording for how the line-of-sight position of a point catalogue was obtained. */
export const DISTANCE_BASIS_TEXT: Readonly<Record<string, string>> = {
  'per-object-direct': 'each object has its own catalogue distance (redshift-independent method where stated)',
  'per-object-redshift-hubble-flow': 'each galaxy’s distance is a Hubble-flow estimate from its redshift (cz); peculiar velocities shift individual objects along the line of sight',
  'cluster-mean': 'every object is placed at one cluster-mean distance',
  'per-object-parallax': 'each star is placed using its own Gaia parallax',
};

/** Inspector model for one row of a point catalogue (UNGC, McConnachie, 2MRS, cluster member). */
export function inspectPointRow(row: PointRowInfo): InspectorModel {
  const m = row.manifest;
  const v = row.values;
  const isMember = row.fileId.startsWith('members-');
  const name = String(v['name'] ?? row.id);
  const direct = m.distanceBasis;
  const sections: InspectorSection[] = [];
  const src = `${m.source.source}${m.source.release ? ` · ${m.source.release}` : ''}${m.source.recordId ? ` · ${m.source.recordId}` : ''} · retrieved ${m.source.retrieved}`;
  const fieldFor = (key: string): InspectorField => {
    const label = POINT_LABELS[key] ?? key;
    const desc = m.units[key];
    const raw = v[key];
    if (raw === null || raw === undefined) return unavailable(key, label, NULL_REASON[key] ?? `Not available for this row of ${m.title}.`);
    const kind: MeasurementKind | undefined = POINT_KIND_OBSERVED.has(key) ? 'observed' : key === 'distMpc' ? (direct === 'per-object-redshift-hubble-flow' ? 'derived' : 'observed') : undefined;
    let value = typeof raw === 'number' ? (Number.isInteger(raw) ? String(raw) : String(Number(raw.toPrecision(7)))) : raw;
    if (key === 'insideTidalRadius') value = raw === 1 ? 'yes' : 'no';
    const tt = key === 'morphology' || key === 'tType' ? describeTType(typeof raw === 'string' ? raw : raw) : undefined;
    return { key, label, available: true, value, unit: unitFromDescription(desc), ...(kind ? { kind } : {}), source: src, ...(desc ? { note: desc } : {}), ...(tt ? { detail: tt } : {}) };
  };
  const use = (keys: readonly string[]): InspectorField[] => keys.filter((k) => k in v).map(fieldFor);

  const id: InspectorField[] = [textField('name', 'Catalogue name', name)];
  if (v['ngcSimbadName'] && v['ngcSimbadName'] !== name) id.push(fieldFor('ngcSimbadName'));
  id.push(...use(['morphology', 'tType', 'dwarfMorphology', 'sourceId', 'subgroup']));
  if (row.fileId === 'twomrs' && v['morphology'] !== undefined && v['morphology'] !== null) id[id.length - 1] = { ...id[id.length - 1]!, detail: 'ZCAT-convention type code as stored in the catalogue; it is not decoded here.' };
  sections.push({ title: 'Identity', fields: id });
  sections.push({ title: 'Position', fields: use(['raDeg', 'decDeg', 'glonDeg', 'glatDeg']) });

  const dist: InspectorField[] = [];
  if (isMember) {
    dist.push(...use(['parallaxMas', 'parallaxErrMas']));
    const p = v['parallaxMas'];
    if (typeof p === 'number' && p > 0) {
      dist.push(textField('plx_distance', 'Inverse-parallax distance', (1000 / p).toFixed(1), { unit: 'pc', kind: 'derived', source: 'atlas-derived from the Gaia parallax', transformations: ['d = 1000 / parallax(mas) pc'], detail: 'Naive inversion, no zero-point correction (Gaia DR3 parallaxes carry an offset of a few hundredths of a mas); the cluster distance in the object record is more precise.' }));
    }
  } else if (row.fileId === 'twomrs') {
    dist.push(...use(['czKms', 'czErrKms']));
    if (row.placement === 'cluster-mean') dist.push(textField('distance_basis', 'Distance basis (as drawn)', 'cluster-mean distance, not this galaxy\u2019s own', { kind: 'derived', detail: 'This galaxy is shown as a Virgo-region member at the cluster-mean SBF distance (16.5 Mpc), not at its redshift distance; its cz is listed above and a Hubble-flow distance would be affected by peculiar velocities. The membership cut is ours, not a published list.' }));
    else dist.push(textField('distance_basis', 'Distance basis', 'Hubble-flow estimate from cz', { kind: 'derived', detail: `${DISTANCE_BASIS_TEXT[direct] ?? direct}. This catalogue has no redshift-independent distance.` }));
  } else {
    const d = fieldFor('distMpc');
    dist.push({ ...d, ...(row.values['distErrMpc'] === null || row.values['distErrMpc'] === undefined ? { uncertainty: 'no published error' } : { uncertainty: `±${row.values['distErrMpc']} Mpc` }), detail: `Method: ${v['distMethod'] ?? 'not given'}. ${DISTANCE_BASIS_TEXT[direct] ?? direct}.` });
    dist.push(...use(['distErrMpc', 'distErrUpMpc', 'distErrLowMpc', 'distMethod', 'distModulusMag', 'distModulusErrMag', 'distRefs']));
  }
  sections.push({ title: 'Distance', fields: dist });
  const phot = use(['gMag', 'bpRp', 'bMag', 'vMag', 'kMag', 'ksMag', 'ktMag', 'diameterArcmin', 'halfLightRadiusArcmin']);
  if (phot.length) sections.push({ title: isMember ? 'Photometry' : 'Brightness and size', fields: phot });
  const mot = use(['pmraMasYr', 'pmdecMasYr', 'probability', 'insideTidalRadius', 'hrvKms', 'surfaceBrightnessClass', 'mainDisturber', 'tidalIndex']);
  if (mot.length) sections.push({ title: isMember ? 'Motion and membership' : 'Environment and motion', fields: mot });
  sections.push({ title: 'About this catalogue', fields: [
    textField('catalogue', 'Catalogue', m.title, { source: src }),
    textField('licence', 'Licence', m.licence.length > 90 ? `${m.licence.slice(0, 88)}…` : m.licence, { detail: m.licence.length > 90 ? m.licence : undefined }),
    ...m.caveats.map((c, i) => textField(`caveat_${i}`, `Caveat ${i + 1}`, c.length > 70 ? `${c.slice(0, 68)}…` : c, { detail: c.length > 70 ? c : undefined })),
  ] });

  const meanDepth = isMember && direct === 'cluster-mean';
  const rep: Representation = {
    kind: 'observed-members',
    summary: meanDepth
      ? 'A star from the membership list, drawn at its catalogued sky position (measured). Its line-of-sight position is NOT measured: the Atlas draws it as a deterministic hash-seeded illustrative offset from the single cluster-mean distance (Plummer-like profile scaled by the projected half-light radius).'
      : isMember
      ? `A star from the membership list, drawn at its catalogued sky position; its line-of-sight position follows its own parallax (${DISTANCE_BASIS_TEXT[direct] ?? direct}).`
      : `A catalogued galaxy drawn as a point at its catalogued sky position. Line of sight: ${DISTANCE_BASIS_TEXT[direct] ?? direct}. Marker size is a drawing choice, not a measurement.`,
    depth: meanDepth ? 'illustrative' : direct === 'cluster-mean' ? 'measured-cluster-mean' : 'measured-per-object',
    exaggerations: meanDepth ? ['Line-of-sight offset from the cluster-mean distance is an illustrative hash-seeded draw, not a measurement.'] : [],
  };
  return {
    name,
    classification: isMember ? 'Star · cluster member (catalogue row)' : 'Galaxy · catalogue row',
    designations: [name, ...(typeof v['ngcSimbadName'] === 'string' && v['ngcSimbadName'] !== name ? [v['ngcSimbadName']] : [])],
    referenceFrame: 'ICRS (catalogue epoch)',
    sections,
    provenance: [`${m.title}: ${src}${m.source.url ? ` · ${m.source.url}` : ''}`, `Selection: ${m.query}`],
    flags: [],
    notes: '',
    facts: [],
    representation: representationBlock(rep),
    noImageNote: 'No picture exists for an individual catalogue point: it is drawn as a marker.',
  };
}

// ======================================================================================================================
// Discovery records (Prompt 07, R2a): a minimal generic inspector for objects that have no dedicated inspector
// (hip:, exo:, host:, other: and the fallback for any record). Deliberately simple and correct: the UI phase extends it.
// ======================================================================================================================

/** What inspectDiscoveryRecord needs from the atlas (a DiscoveryAtlas satisfies it). */
export interface RecordNoteSource { noteFor(id: string): DiscoveryNote | undefined }

const KEYS_BY_CATEGORY: Readonly<Record<string, readonly MeasurementKey[]>> = {
  star: ['distancePc', 'apparentMag', 'absoluteMag', 'teffK', 'pmTotalMasYr'],
  'exoplanet-host': ['distancePc', 'apparentMag', 'absoluteMag', 'teffK', 'pmTotalMasYr'],
  exoplanet: ['orbitalPeriodDays', 'radiusKm', 'massKg', 'teffK'],
  planet: ['radiusKm', 'massKg', 'orbitalPeriodDays'],
  moon: ['radiusKm', 'massKg', 'orbitalPeriodDays'],
  galaxy: ['distancePc', 'apparentMag', 'angularSizeArcmin'],
};
const FIELD_LABEL_OVERRIDE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  exoplanet: { teffK: 'Equilibrium temperature (modelled)' },
};

function unavailableReason(rec: DiscoveryRecord, key: MeasurementKey): string {
  const label = DATASET_LABELS[rec.dataset];
  if (key === 'distancePc') {
    if (rec.position.kind === 'sky-only') {
      const cz = rec.measurements.czKms?.value;
      if (cz !== undefined) return `${label} gives a velocity (cz = ${cz.toFixed(0)} km/s) but no distance: below 1000 km/s the velocity is dominated by the galaxy's own motion, so no Hubble-flow distance is derived.`;
      return `${label} gives no distance for this object; it is known only as a direction on the sky.`;
    }
    return `${label} does not provide a distance.`;
  }
  if (key === 'massKg' && rec.category === 'exoplanet') return `${label} lists no mass for this planet, or only a minimum mass (M sin i), which is not shown as a mass.`;
  return `Not provided by ${label}.`;
}

function recordField(rec: DiscoveryRecord, key: MeasurementKey): InspectorField {
  const meta = MEASUREMENT_META[key];
  const label = FIELD_LABEL_OVERRIDE[rec.category]?.[key] ?? meta.label;
  const m = rec.measurements[key];
  if (m === undefined || !Number.isFinite(m.value)) return { key, label, available: false, value: 'Unavailable', unit: '', reason: unavailableReason(rec, key) };
  const src = m.source !== undefined ? DATASET_LABELS[m.source] : DATASET_LABELS[rec.dataset];
  return {
    key, label, available: true, value: formatDiscoveryMeasurement(key, m.value, rec.category), unit: '', kind: m.kind,
    ...(m.uncertainty !== undefined ? { uncertainty: `±${formatDiscoveryMeasurement(key, m.uncertainty, rec.category)}` } : {}),
    source: src + (m.source !== undefined && m.source !== rec.dataset ? ' (filled from a duplicate record in this dataset)' : ''),
    // A stated assumption or reliability caveat ("low reliability: parallax S/N < 10", "d = cz / H0 ...") is shown in the row itself, not only in its tooltip.
    ...(m.note ? { note: m.note, detail: m.note } : {}),
  };
}

const CLAIM_STATUS: Readonly<Record<string, Fact['status']>> = { observed: 'observed', inferred: 'inferred', hypothesis: 'hypothesis', historical: 'observed' };

/** A generic inspector model for a DiscoveryRecord: name, classification, designations, measurements with kind / uncertainty / source, 'Unavailable' with a reason, notes. */
export function inspectDiscoveryRecord(rec: DiscoveryRecord, atlas?: RecordNoteSource): InspectorModel {
  const p = rec.position;
  const position: InspectorField[] = [];
  if (p.kind === 'solar') {
    position.push({ key: 'position', label: 'Position', available: true, value: 'from the ephemeris at the current simulation time', unit: '', kind: 'derived', source: DATASET_LABELS[rec.dataset] });
  } else if (Number.isFinite((p as { raDeg: number }).raDeg) && Number.isFinite((p as { decDeg: number }).decDeg)) {
    const q = p as { raDeg: number; decDeg: number };
    position.push({ key: 'ra', label: 'Right ascension', available: true, value: `${q.raDeg.toFixed(5)}°`, unit: '', kind: 'observed', source: DATASET_LABELS[rec.dataset] });
    position.push({ key: 'dec', label: 'Declination', available: true, value: `${q.decDeg.toFixed(5)}°`, unit: '', kind: 'observed', source: DATASET_LABELS[rec.dataset] });
  } else {
    position.push({ key: 'position', label: 'Position', available: false, value: 'Unavailable', unit: '', reason: 'This object is defined by its members and has no direction of its own.' });
  }
  if (rec.category !== 'planet' && rec.category !== 'moon') position.push(recordField(rec, 'distancePc'));

  const wanted = KEYS_BY_CATEGORY[rec.category] ?? ['distancePc'];
  const shown = new Set<MeasurementKey>(['distancePc']);
  const fields: InspectorField[] = [];
  for (const key of wanted) { if (key === 'distancePc') continue; fields.push(recordField(rec, key)); shown.add(key); }
  // Everything else the record has, so no published value is hidden.
  for (const key of MEASUREMENT_KEYS) if (!shown.has(key) && rec.measurements[key] !== undefined) fields.push(recordField(rec, key));

  // Distance precision: d / sigma_d equals parallax / sigma_parallax (the S/N of the parallax). Derived from the record's own two numbers; absent when no uncertainty is published.
  const dist = rec.measurements.distancePc;
  if (dist !== undefined && dist.uncertainty !== undefined && dist.uncertainty > 0 && Number.isFinite(dist.value) && (rec.category === 'star' || rec.category === 'exoplanet-host' || rec.category === 'other')) {
    const snr = dist.value / dist.uncertainty;
    position.push({
      key: 'distance_snr', label: 'Parallax quality (S/N)', available: true, value: snr >= 100 ? snr.toFixed(0) : snr.toPrecision(3), unit: '', kind: 'derived',
      source: DATASET_LABELS[dist.source ?? rec.dataset],
      detail: snr < 5 ? 'Below 5: the distance is not reliable and is left out of the "nearest" rankings.' : snr < 10 ? 'Below 10: treat the distance as approximate.' : 'd divided by its uncertainty, equal to parallax over its error.',
    });
  }
  const notices: InspectorNotice[] = [];
  const place = placementNotice(rec);
  if (place) notices.push({ tone: 'info', label: rec.position.kind === 'sky-only' ? 'Not placed in 3D' : 'Not drawn', text: place });
  const lowRel = Object.entries(rec.measurements).filter(([, m]) => m?.note !== undefined && /low reliability/i.test(m.note)).map(([k, m]) => `${MEASUREMENT_META[k as MeasurementKey].label}: ${m!.note}`);
  if (lowRel.length > 0) notices.push({ tone: 'warn', label: 'Low reliability', text: lowRel.join(' ') });

  const sections: InspectorSection[] = [{ title: 'Position', fields: position }];
  if (fields.length > 0) sections.push({ title: 'Measurements', fields });
  if (rec.spectralType !== undefined) sections.push({ title: 'Spectrum', fields: [{ key: 'spectralType', label: 'Spectral type (as published)', available: true, value: rec.spectralType, unit: '', kind: 'observed', source: DATASET_LABELS[rec.dataset] }] });

  const note = atlas?.noteFor(rec.id);
  const facts: Fact[] = [];
  if (note) {
    const add = (list: readonly NoteClaim[] | undefined, prefix = ''): void => {
      for (const c of list ?? []) {
        const ref = c.references[0];
        facts.push({ text: `${prefix}${c.status === 'historical' ? '(historical) ' : ''}${c.text}`, status: CLAIM_STATUS[c.status] ?? 'inferred', reference: c.references.map((r) => `${r.label} (retrieved ${r.retrieved})`).join('; '), ...(ref ? { url: ref.url } : {}) });
      }
    };
    add(note.sections.what); add(note.sections.why); add(note.sections.discovery); add(note.sections.interesting); add(note.sections.uncertain, 'Uncertain: ');
  }
  const provenance = [`${DATASET_LABELS[rec.dataset]} · source key ${rec.sourceKey}`];
  for (const s of new Set(Object.values(rec.measurements).map((m) => m?.source).filter((d): d is DatasetId => d !== undefined && d !== rec.dataset))) provenance.push(`Some values were filled from a duplicate record in ${DATASET_LABELS[s]}`);
  if (rec.sameAs && rec.sameAs.length > 0) provenance.push(`The same object in other datasets: ${rec.sameAs.join(', ')}`);

  return {
    recordId: rec.id,
    ...(notices.length > 0 ? { notices } : {}),
    name: rec.name,
    classification: rec.classification,
    designations: rec.designations,
    referenceFrame: p.kind === 'icrs' ? 'ICRS, heliocentric (Sun-centred)' : p.kind === 'solar' ? 'Solar System (ephemeris)' : 'ICRS (direction only)',
    sections,
    provenance,
    flags: (rec.qualityFlags ?? []).map((flag) => ({ flag, description: FLAG_DESCRIPTIONS[flag as QualityFlag] ?? flag })),
    notes: note?.oneLine ?? '',
    facts,
  };
}
