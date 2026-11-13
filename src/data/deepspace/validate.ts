import type { Measurement } from '../schema';
import { classifyGalaxy, ClassificationError } from '../../core/deepspace/classify';
import type { DeepImageAsset, DeepImageProvenanceFile, DeepSpaceFile, DeepSpaceObject, PointCatalogueFile } from './types';

export interface Issue { readonly severity: 'error' | 'warning'; readonly path: string; readonly code: string; readonly message: string }
export interface ValidationReport { readonly ok: boolean; readonly errors: readonly Issue[]; readonly warnings: readonly Issue[] }

class Collector {
  readonly issues: Issue[] = [];
  err(path: string, code: string, message: string) { this.issues.push({ severity: 'error', path, code, message }); }
  warn(path: string, code: string, message: string) { this.issues.push({ severity: 'warning', path, code, message }); }
  report(): ValidationReport {
    const errors = this.issues.filter((i) => i.severity === 'error');
    return { ok: errors.length === 0, errors, warnings: this.issues.filter((i) => i.severity === 'warning') };
  }
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === 'string' && x.trim() !== '';
const isHttps = (x: unknown): boolean => { if (typeof x !== 'string') return false; try { return new URL(x).protocol === 'https:'; } catch { return false; } };
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const DISTANCE_UNITS: readonly string[] = ['pc', 'kpc', 'Mpc'];

// ---- objects file --------------------------------------------------------------------------------------------------

export interface CrossCheckContext {
  /** Image assets (provenance file). When supplied, every imageAssetId must resolve and name the same object. */
  readonly images?: DeepImageProvenanceFile | readonly DeepImageAsset[];
  /** Loaded point catalogues, or just their ids. When supplied, pointsFileId / membership are checked. */
  readonly catalogues?: Readonly<Record<string, PointCatalogueFile>> | readonly string[];
}

function checkMeasurement(c: Collector, path: string, m: Measurement | undefined, opts: { distance?: boolean } = {}): void {
  if (!m || typeof m !== 'object') { c.err(path, 'measurement.missing', 'measurement is missing'); return; }
  if (!isNum(m.value)) c.err(`${path}.value`, 'measurement.value', 'value must be a finite number');
  if (!isStr(m.unit)) c.err(`${path}.unit`, 'measurement.unit', 'unit is required');
  if (!['observed', 'derived', 'modelled', 'hypothetical'].includes(m.kind)) c.err(`${path}.kind`, 'measurement.kind', `invalid kind "${String(m.kind)}"`);
  if (!m.source || !isStr(m.source.source) || !isStr(m.source.retrieved)) c.err(`${path}.source`, 'measurement.source', 'source.source and source.retrieved are required');
  if (m.uncertainty !== undefined && !(isNum(m.uncertainty) && m.uncertainty >= 0)) c.err(`${path}.uncertainty`, 'measurement.uncertainty', 'uncertainty must be a finite number >= 0');
  if (m.kind === 'derived' && (!m.transformations || m.transformations.length === 0)) c.err(`${path}.transformations`, 'measurement.derived-needs-transformations', 'derived values must list their transformations');
  if (opts.distance) {
    if (!DISTANCE_UNITS.includes(m.unit)) c.err(`${path}.unit`, 'distance.unit', `distance unit must be one of ${DISTANCE_UNITS.join(', ')}, got "${m.unit}"`);
    if (!(isNum(m.value) && m.value > 0)) c.err(`${path}.value`, 'distance.value', 'distance must be > 0');
  }
}

/** Structural and scientific-consistency validation of the curated objects file. Pure. */
export function validateDeepSpaceFile(file: DeepSpaceFile, ctx: CrossCheckContext = {}): ValidationReport {
  const c = new Collector();
  if (!file || typeof file !== 'object') { c.err('', 'file', 'not an object'); return c.report(); }
  if (file.manifest?.schema !== 'atlas-deep-space/1') c.err('manifest.schema', 'manifest.schema', 'schema must be "atlas-deep-space/1"');
  if (!Array.isArray(file.objects)) { c.err('objects', 'objects', 'objects must be an array'); return c.report(); }

  const ids = new Set<string>();
  for (const o of file.objects) if (o && typeof o.id === 'string') ids.add(o.id);
  const seen = new Set<string>();

  const imageById = new Map<string, DeepImageAsset>();
  if (ctx.images) for (const a of 'assets' in ctx.images ? ctx.images.assets : ctx.images) imageById.set(a.id, a);
  const catalogues: { has(id: string): boolean; names(id: string): ReadonlySet<string> | undefined } | undefined = ctx.catalogues
    ? Array.isArray(ctx.catalogues)
      ? { has: (id) => (ctx.catalogues as readonly string[]).includes(id), names: () => undefined }
      : { has: (id) => id in (ctx.catalogues as object), names: (id) => { const f = (ctx.catalogues as Record<string, PointCatalogueFile>)[id]; return f ? new Set(f.columns['name'] as string[]) : undefined; } }
    : undefined;

  file.objects.forEach((o: DeepSpaceObject, idx) => {
    const p = `objects[${idx}](${o?.id})`;
    if (!isStr(o?.id) || !KEBAB.test(o.id)) { c.err(`${p}.id`, 'object.id', 'id must be kebab-case'); return; }
    if (seen.has(o.id)) c.err(`${p}.id`, 'object.duplicate', `duplicate id "${o.id}"`);
    seen.add(o.id);
    if (!isStr(o.name)) c.err(`${p}.name`, 'object.name', 'name is required');
    if (!Array.isArray(o.designations)) c.err(`${p}.designations`, 'object.designations', 'designations must be an array');

    // kind <-> class
    const classes = { galaxy: o.galaxyClass, nebula: o.nebulaClass, 'star-cluster': o.clusterClass } as const;
    const set = (Object.entries(classes) as [string, string | undefined][]).filter(([, v]) => v !== undefined);
    if (o.kind === 'galaxy' || o.kind === 'nebula' || o.kind === 'star-cluster') {
      if (classes[o.kind] === undefined) c.err(`${p}.${o.kind}Class`, 'object.class-missing', `kind "${o.kind}" requires its class field`);
      if (set.some(([k]) => k !== o.kind)) c.err(p, 'object.class-extra', `class fields of other kinds are set on a ${o.kind}`);
    } else if (set.length > 0) c.err(p, 'object.class-extra', `kind "${o.kind}" must not carry galaxy/nebula/cluster class fields`);

    // galaxyClass vs the catalogue's own label
    if (o.kind === 'galaxy' && o.galaxyClass !== undefined) {
      if (!isStr(o.morphologyLabel)) c.err(`${p}.morphologyLabel`, 'galaxy.morphology-missing', 'a galaxy needs its catalogue morphologyLabel');
      else {
        try {
          const derived = classifyGalaxy(isStr(o.morphologyClassBasis) ? o.morphologyClassBasis : o.morphologyLabel);
          if (derived !== o.galaxyClass) c.err(`${p}.galaxyClass`, 'galaxy.class-mismatch', `galaxyClass "${o.galaxyClass}" disagrees with classifyGalaxy("${o.morphologyLabel}") = "${derived}"`);
        } catch (e) {
          if (e instanceof ClassificationError) c.err(`${p}.morphologyLabel`, 'galaxy.unclassifiable', e.message);
          else throw e;
        }
      }
    }

    if (o.sky) {
      if (!(isNum(o.sky.raDeg) && o.sky.raDeg >= 0 && o.sky.raDeg < 360)) c.err(`${p}.sky.raDeg`, 'sky.ra', 'raDeg must be in [0, 360)');
      if (!(isNum(o.sky.decDeg) && o.sky.decDeg >= -90 && o.sky.decDeg <= 90)) c.err(`${p}.sky.decDeg`, 'sky.dec', 'decDeg must be in [-90, 90]');
      if (!o.sky.coordinateSource || !isStr(o.sky.coordinateSource.source)) c.err(`${p}.sky.coordinateSource`, 'sky.source', 'coordinateSource is required');
      if (o.sky.distance) checkMeasurement(c, `${p}.sky.distance`, o.sky.distance, { distance: true });
    }
    if (o.angularSize) {
      if (!(isNum(o.angularSize.majorArcmin) && o.angularSize.majorArcmin > 0)) c.err(`${p}.angularSize.majorArcmin`, 'size.major', 'majorArcmin must be > 0');
      if (o.angularSize.minorArcmin !== undefined && !(isNum(o.angularSize.minorArcmin) && o.angularSize.minorArcmin > 0 && o.angularSize.minorArcmin <= o.angularSize.majorArcmin)) c.err(`${p}.angularSize.minorArcmin`, 'size.minor', 'minorArcmin must be in (0, major]');
      if (!isStr(o.angularSize.definition)) c.err(`${p}.angularSize.definition`, 'size.definition', 'definition is required');
    }
    if (o.orientation) {
      checkMeasurement(c, `${p}.orientation.inclinationDeg`, o.orientation.inclinationDeg);
      checkMeasurement(c, `${p}.orientation.positionAngleDeg`, o.orientation.positionAngleDeg);
      const i = o.orientation.inclinationDeg?.value;
      if (isNum(i) && !(i >= 0 && i <= 90)) c.err(`${p}.orientation.inclinationDeg`, 'orientation.inclination', 'inclination must be in [0, 90] degrees');
      const pa = o.orientation.positionAngleDeg?.value;
      if (isNum(pa) && !(pa >= 0 && pa <= 360)) c.err(`${p}.orientation.positionAngleDeg`, 'orientation.pa', 'position angle must be in [0, 360] degrees');
    }
    for (const [k, m] of Object.entries(o.measurements ?? {})) checkMeasurement(c, `${p}.measurements.${k}`, m);

    // representation
    const r = o.representation;
    if (!r || !isStr(r.summary)) c.err(`${p}.representation`, 'representation.summary', 'representation.summary is required (the honesty field)');
    else {
      if (!['observed-members', 'observed-image', 'deprojected-image', 'documented-model', 'illustrative'].includes(r.kind)) c.err(`${p}.representation.kind`, 'representation.kind', `invalid kind "${r.kind}"`);
      if (r.kind === 'deprojected-image' && !o.orientation) c.err(`${p}.representation`, 'representation.needs-orientation', 'deprojected-image requires published orientation');
      if (r.kind === 'observed-members' && !o.pointsFileId && !o.membership) c.err(`${p}.representation`, 'representation.needs-points', 'observed-members requires pointsFileId or membership');
    }

    if (!Array.isArray(o.imageAssetIds)) c.err(`${p}.imageAssetIds`, 'images.array', 'imageAssetIds must be an array');
    else {
      if (new Set(o.imageAssetIds).size !== o.imageAssetIds.length) c.err(`${p}.imageAssetIds`, 'images.duplicate', 'duplicate image ids');
      if (imageById.size > 0 || ctx.images) {
        for (const id of o.imageAssetIds) {
          const a = imageById.get(id);
          if (!a) c.err(`${p}.imageAssetIds`, 'images.unresolved', `image asset "${id}" not found in the provenance file`);
          else if (a.objectId !== o.id) c.err(`${p}.imageAssetIds`, 'images.wrong-object', `image "${id}" belongs to "${a.objectId}", not "${o.id}"`);
        }
      }
    }

    if (o.parentId !== undefined && !ids.has(o.parentId)) c.err(`${p}.parentId`, 'parent.unresolved', `parent "${o.parentId}" is not an object in the file`);
    if (o.pointsFileId !== undefined && catalogues && !catalogues.has(o.pointsFileId)) c.err(`${p}.pointsFileId`, 'points.unresolved', `points file "${o.pointsFileId}" not found`);
    if (o.membership) {
      if (!isStr(o.membership.basis)) c.err(`${p}.membership.basis`, 'membership.basis', 'basis is required');
      if (!Array.isArray(o.membership.names) || o.membership.names.length === 0) c.err(`${p}.membership.names`, 'membership.names', 'names must be a non-empty array');
      else if (catalogues) {
        if (!catalogues.has(o.membership.pointsFileId)) c.err(`${p}.membership.pointsFileId`, 'points.unresolved', `points file "${o.membership.pointsFileId}" not found`);
        else {
          const names = catalogues.names(o.membership.pointsFileId);
          if (names) for (const n of o.membership.names) if (!names.has(n)) c.err(`${p}.membership.names`, 'membership.unresolved', `member "${n}" not in catalogue "${o.membership.pointsFileId}"`);
        }
      }
    }
  });

  for (const [key, m] of Object.entries(file.models ?? {})) {
    if (!m.limitations || m.limitations.length === 0) c.err(`models.${key}`, 'model.limitations', 'a documented model must state its limitations');
    for (const prm of m.parameters ?? []) if (!isStr(prm.reference) || !isNum(prm.value)) c.err(`models.${key}.${prm.name}`, 'model.parameter', 'every model parameter needs a finite value and a reference');
  }
  return c.report();
}

// ---- image provenance ----------------------------------------------------------------------------------------------

const BANDS = ['visible', 'near-infrared', 'mid-infrared', 'far-infrared', 'ultraviolet', 'x-ray', 'radio', 'gamma-ray', 'multi-band-composite'];

/** Every image must be redistributable with evidence, honest about its bands and colours, and have a sane level pyramid. */
export function validateImageProvenance(file: DeepImageProvenanceFile): ValidationReport {
  const c = new Collector();
  if (file?.manifest?.schema !== 'atlas-deep-images/1') c.err('manifest.schema', 'manifest.schema', 'schema must be "atlas-deep-images/1"');
  if (!Array.isArray(file?.assets)) { c.err('assets', 'assets', 'assets must be an array'); return c.report(); }
  const seen = new Set<string>();
  file.assets.forEach((a, idx) => {
    const p = `assets[${idx}](${a?.id})`;
    if (!isStr(a?.id) || !KEBAB.test(a.id)) c.err(`${p}.id`, 'image.id', 'id must be kebab-case');
    else { if (seen.has(a.id)) c.err(`${p}.id`, 'image.duplicate', `duplicate id "${a.id}"`); seen.add(a.id); }
    if (!isStr(a.objectId)) c.err(`${p}.objectId`, 'image.object', 'objectId is required');
    if (!isStr(a.title)) c.err(`${p}.title`, 'image.title', 'title is required');
    if (!isStr(a.credit)) c.err(`${p}.credit`, 'image.credit', 'credit line is required (verbatim)');

    const l = a.licence;
    if (!l || !isStr(l.evidence)) c.err(`${p}.licence.evidence`, 'licence.evidence', 'licence.evidence (verbatim archive text) must be non-empty');
    if (!l || l.redistributionAllowed !== true) c.err(`${p}.licence.redistributionAllowed`, 'licence.redistribution', 'redistributionAllowed must be true');
    if (!l || !isStr(l.name)) c.err(`${p}.licence.name`, 'licence.name', 'licence name is required');
    if (!l || !isHttps(l.url)) c.err(`${p}.licence.url`, 'url.https', 'licence.url must be an https URL');
    if (l && typeof l.attributionRequired !== 'boolean') c.err(`${p}.licence.attributionRequired`, 'licence.attribution', 'attributionRequired must be boolean');

    const b = a.band;
    if (!b || !BANDS.includes(b.kind)) c.err(`${p}.band.kind`, 'band.kind', `band.kind must be one of ${BANDS.join(', ')}`);
    if (!b || typeof b.falseColour !== 'boolean') c.err(`${p}.band.falseColour`, 'band.falseColour', 'band.falseColour must be boolean');
    if (!b || typeof b.composite !== 'boolean') c.err(`${p}.band.composite`, 'band.composite', 'band.composite must be boolean');
    if (!b || !Array.isArray(b.filters)) c.err(`${p}.band.filters`, 'band.filters', 'band.filters must be an array');
    if (!b || !isStr(b.colourNote)) c.err(`${p}.band.colourNote`, 'band.colourNote', 'band.colourNote is required');

    const s = a.source;
    if (!s || !isStr(s.archive) || !isStr(s.imageId)) c.err(`${p}.source`, 'source.ids', 'source.archive and source.imageId are required');
    if (!s || !isHttps(s.landingUrl)) c.err(`${p}.source.landingUrl`, 'url.https', 'landingUrl must be an https URL');
    if (!s || !isHttps(s.downloadUrl)) c.err(`${p}.source.downloadUrl`, 'url.https', 'downloadUrl must be an https URL');
    if (!s || !isStr(s.retrieved)) c.err(`${p}.source.retrieved`, 'source.retrieved', 'retrieved date is required');
    if (!s || typeof s.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(s.sha256)) c.err(`${p}.source.sha256`, 'source.sha256', 'sha256 must be 64 lowercase hex characters');

    const g = a.geometry;
    if (!g) c.err(`${p}.geometry`, 'geometry.missing', 'geometry is required');
    else {
      if (!(Array.isArray(g.fovArcmin) && g.fovArcmin.length === 2 && (g.fovArcmin as readonly unknown[]).every((v) => isNum(v) && v > 0))) c.err(`${p}.geometry.fovArcmin`, 'geometry.fov', 'fovArcmin must be two numbers > 0');
      for (const k of ['originalWidthPx', 'originalHeightPx'] as const) if (!(isNum(g[k]) && g[k] > 0)) c.err(`${p}.geometry.${k}`, 'geometry.size', `${k} must be > 0`);
      if (!isNum(g.centreRaDeg) || g.centreRaDeg < 0 || g.centreRaDeg >= 360) c.err(`${p}.geometry.centreRaDeg`, 'geometry.ra', 'centreRaDeg must be in [0, 360)');
      if (!isNum(g.centreDecDeg) || g.centreDecDeg < -90 || g.centreDecDeg > 90) c.err(`${p}.geometry.centreDecDeg`, 'geometry.dec', 'centreDecDeg must be in [-90, 90]');
      if (!isNum(g.upPositionAngleDeg)) c.err(`${p}.geometry.upPositionAngleDeg`, 'geometry.pa', 'upPositionAngleDeg must be numeric');
      if (!['fits-header', 'archive-metadata', 'estimated-from-published-size'].includes(g.wcsSource)) c.err(`${p}.geometry.wcsSource`, 'geometry.wcs', 'wcsSource invalid');
    }
    if (!Array.isArray(a.processing)) c.err(`${p}.processing`, 'processing', 'processing must be an array (what we did to the image)');
    if (!['scientific-image', 'multi-band-composite', 'artist-processed'].includes(a.fidelity)) c.err(`${p}.fidelity`, 'fidelity', 'fidelity invalid');

    if (!Array.isArray(a.levels) || a.levels.length === 0) c.err(`${p}.levels`, 'levels.empty', 'at least one level is required');
    else {
      const first = a.levels[0]!;
      if (Math.max(first.widthPx, first.heightPx) > 256) c.err(`${p}.levels[0]`, 'levels.first-size', `level 0 must be <= 256 px on its long side, is ${Math.max(first.widthPx, first.heightPx)}`);
      (a.levels as DeepImageAsset['levels']).forEach((lv, i) => {
        if (!(isNum(lv.widthPx) && lv.widthPx > 0 && isNum(lv.heightPx) && lv.heightPx > 0)) c.err(`${p}.levels[${i}]`, 'levels.size', 'widthPx/heightPx must be > 0');
        if (!isStr(lv.file)) c.err(`${p}.levels[${i}].file`, 'levels.file', 'file is required');
        if (!(isNum(lv.bytes) && lv.bytes > 0)) c.err(`${p}.levels[${i}].bytes`, 'levels.bytes', 'bytes must be > 0');
        if (i > 0) {
          const prev = a.levels[i - 1]!;
          if (!(Math.max(lv.widthPx, lv.heightPx) > Math.max(prev.widthPx, prev.heightPx))) c.err(`${p}.levels[${i}]`, 'levels.increasing', 'levels must be strictly increasing in size');
          if (!(lv.level > prev.level)) c.err(`${p}.levels[${i}]`, 'levels.index', 'level numbers must be strictly increasing');
        }
      });
    }
  });
  return c.report();
}

// ---- point catalogues ----------------------------------------------------------------------------------------------

type ColSpec = { readonly nullable: boolean; readonly type: 'string' | 'number' };
const BASE: Record<string, ColSpec> = { name: { nullable: false, type: 'string' }, raDeg: { nullable: false, type: 'number' }, decDeg: { nullable: false, type: 'number' } };
const NEARBY: Record<string, ColSpec> = {
  ...BASE, distMpc: { nullable: false, type: 'number' }, distErrMpc: { nullable: true, type: 'number' }, distMethod: { nullable: false, type: 'string' },
  morphology: { nullable: true, type: 'string' }, diameterArcmin: { nullable: true, type: 'number' },
};
const REQUIRED_COLUMNS: Readonly<Record<string, Record<string, ColSpec>>> = {
  ungc: NEARBY,
  'local-group-mcconnachie': NEARBY,
  twomrs: { ...BASE, czKms: { nullable: false, type: 'number' }, czErrKms: { nullable: true, type: 'number' }, ksMag: { nullable: false, type: 'number' }, morphology: { nullable: true, type: 'string' } },
};
const MEMBERS: Record<string, ColSpec> = {
  ...BASE, sourceId: { nullable: false, type: 'string' }, gMag: { nullable: false, type: 'number' }, bpRp: { nullable: true, type: 'number' },
  parallaxMas: { nullable: true, type: 'number' }, pmraMasYr: { nullable: false, type: 'number' }, pmdecMasYr: { nullable: false, type: 'number' }, probability: { nullable: true, type: 'number' },
};

export function requiredColumnsFor(id: string): Record<string, ColSpec> {
  return REQUIRED_COLUMNS[id] ?? (id.startsWith('members-') ? MEMBERS : BASE);
}

export function validatePointCatalogue(file: PointCatalogueFile): ValidationReport {
  const c = new Collector();
  if (!file?.manifest || !file.columns) { c.err('', 'file', 'manifest and columns are required'); return c.report(); }
  const id = file.manifest.id;
  const spec = requiredColumnsFor(id);
  const cols = file.columns;
  const lengths = new Set(Object.values(cols).map((v) => v.length));
  if (lengths.size > 1) c.err('columns', 'columns.length', `columns have different lengths: ${Object.entries(cols).map(([k, v]) => `${k}=${v.length}`).join(', ')}`);
  const n = [...lengths][0] ?? 0;
  if (isNum(file.manifest.count) && file.manifest.count !== n) c.err('manifest.count', 'columns.count', `manifest.count ${file.manifest.count} != rows ${n}`);
  for (const [name, s] of Object.entries(spec)) {
    const col = cols[name];
    if (!col) { c.err(`columns.${name}`, 'columns.required', `required column "${name}" is missing for catalogue "${id}"`); continue; }
    for (let i = 0; i < col.length; i++) {
      const v = col[i];
      if (v === null || v === undefined) { if (!s.nullable) c.err(`columns.${name}[${i}]`, 'value.null', `${name} must not be null`); continue; }
      if (s.type === 'number' ? !isNum(v) : typeof v !== 'string') { c.err(`columns.${name}[${i}]`, 'value.type', `${name}[${i}] must be a finite ${s.type}, got ${String(v)}`); break; }
    }
  }
  if (id === 'ungc' || id === 'local-group-mcconnachie') if (!cols['bMag'] && !cols['vMag']) c.err('columns', 'columns.required', 'one of bMag or vMag is required');
  const ra = cols['raDeg'], dec = cols['decDeg'];
  if (ra) for (let i = 0; i < ra.length; i++) { const v = ra[i]; if (isNum(v) && !(v >= 0 && v < 360)) { c.err(`columns.raDeg[${i}]`, 'value.ra', `raDeg ${v} not in [0, 360)`); break; } }
  if (dec) for (let i = 0; i < dec.length; i++) { const v = dec[i]; if (isNum(v) && !(v >= -90 && v <= 90)) { c.err(`columns.decDeg[${i}]`, 'value.dec', `decDeg ${v} not in [-90, 90]`); break; } }
  for (const [name, col] of Object.entries(cols)) {
    if (spec[name]) continue;
    for (let i = 0; i < col.length; i++) if (typeof col[i] === 'number' && !Number.isFinite(col[i] as number)) { c.err(`columns.${name}[${i}]`, 'value.nan', `${name}[${i}] is NaN/Infinity`); break; }
  }
  return c.report();
}
