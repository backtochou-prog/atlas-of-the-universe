import type { CelestialObject, Classification, Fact, ImageryNote, Measurement, SourceRef } from '../schema';
import { NEIGHBOURHOOD_FRAME } from '../catalogue/frames';
import { loadJson } from '../catalogue/load';
import { physicalSizeEstimate, positionPc as skyToPc } from '../../core/deepspace/geometry';
import type { Vec3 } from '../../core/spatial/vec3';
import type { DeepImageAsset, DeepImageProvenanceFile, DeepSpaceFile, DeepSpaceKind, DeepSpaceObject, PointCatalogueFile } from './types';
import { validateDeepSpaceFile, type Issue } from './validate';

export class DeepSpaceValidationError extends Error {
  constructor(readonly errors: readonly Issue[]) {
    super(`Deep-space data failed validation (${errors.length} errors): ${errors.slice(0, 5).map((e) => `${e.path}: ${e.message}`).join('; ')}`);
    this.name = 'DeepSpaceValidationError';
  }
}

const CLASSIFICATION: Readonly<Record<DeepSpaceKind, Classification>> = {
  galaxy: 'galaxy', nebula: 'nebula', 'star-cluster': 'star-cluster', 'galaxy-group': 'galaxy-group', 'galaxy-cluster': 'galaxy-cluster', 'cosmic-structure': 'other',
};

export type DeepInspectorObject = CelestialObject & { readonly representation: string };

export class DeepSpaceData {
  private readonly byId = new Map<string, DeepSpaceObject>();
  private readonly images = new Map<string, DeepImageAsset>();
  private readonly posCache = new Map<string, Vec3 | null>();

  private constructor(readonly file: DeepSpaceFile, images: readonly DeepImageAsset[]) {
    for (const o of file.objects) this.byId.set(o.id, o);
    for (const a of images) this.images.set(a.id, a);
  }

  /** Validates (and throws DeepSpaceValidationError on any error) unless `validate: false`. */
  static fromFile(file: DeepSpaceFile, images: DeepImageProvenanceFile | readonly DeepImageAsset[] = [], opts: { validate?: boolean; catalogues?: Readonly<Record<string, PointCatalogueFile>> | readonly string[] } = {}): DeepSpaceData {
    const assets = 'assets' in images ? images.assets : images;
    if (opts.validate !== false) {
      const report = validateDeepSpaceFile(file, { images: assets, catalogues: opts.catalogues });
      if (!report.ok) throw new DeepSpaceValidationError(report.errors);
    }
    return new DeepSpaceData(file, assets);
  }

  get(id: string): DeepSpaceObject | undefined { return this.byId.get(id); }
  all(): readonly DeepSpaceObject[] { return this.file.objects; }
  byKind(kind: DeepSpaceKind): readonly DeepSpaceObject[] { return this.file.objects.filter((o) => o.kind === kind); }
  children(parentId: string): readonly DeepSpaceObject[] { return this.file.objects.filter((o) => o.parentId === parentId); }
  imageAssetsOf(id: string): readonly DeepImageAsset[] {
    return (this.byId.get(id)?.imageAssetIds ?? []).map((a) => this.images.get(a)).filter((a): a is DeepImageAsset => a !== undefined);
  }

  /** Sun-centred ICRS Cartesian position in parsecs, DERIVED from RA/Dec + distance and cached. undefined without a distance. */
  positionPc(id: string): Vec3 | undefined {
    const hit = this.posCache.get(id);
    if (hit !== undefined) return hit ?? undefined;
    const o = this.byId.get(id);
    const p = o?.sky?.distance ? skyToPc({ raDeg: o.sky.raDeg, decDeg: o.sky.decDeg, distance: o.sky.distance }) : null;
    this.posCache.set(id, p);
    return p ?? undefined;
  }

  /** Inspector model. The position frame is the Sun-centred, ICRS-aligned 'stellar-neighbourhood' frame. */
  toCelestialObject(id: string): DeepInspectorObject {
    const o = this.byId.get(id);
    if (!o) throw new Error(`Unknown deep-space object "${id}"`);
    const retrieved = this.file.manifest.generated;
    const derivedSource: SourceRef = { source: 'atlas-derived', retrieved };
    const measurements: Record<string, Measurement> = { ...o.measurements };
    if (o.sky?.distance) measurements['distance'] = o.sky.distance;
    if (o.orientation) {
      measurements['inclination'] = o.orientation.inclinationDeg;
      measurements['position_angle'] = o.orientation.positionAngleDeg;
    }
    if (o.angularSize) measurements['angular_size'] = { value: o.angularSize.majorArcmin, unit: 'arcmin', kind: 'observed', source: o.angularSize.source, note: o.angularSize.definition };
    const unavailable: Record<string, string> = { ...o.unavailable };
    if (o.angularSize && o.sky?.distance) {
      const d = o.sky.distance;
      const est = physicalSizeEstimate(o.angularSize.majorArcmin, d);
      const half = est.sigmaMetres;
      measurements['physical_size'] = {
        value: est.metres / 3.0856775814913673e16, unit: 'pc', kind: 'derived', source: derivedSource,
        ...(est.uncertaintyPublished ? { uncertainty: half / 3.0856775814913673e16 } : {}),
        transformations: [
          `angular major axis ${o.angularSize.majorArcmin} arcmin (${o.angularSize.definition})`,
          `distance ${d.value} ${d.unit}${d.uncertainty !== undefined ? ` +/- ${d.uncertainty}` : ' (no published uncertainty)'}`,
          'size = 2 d tan(theta / 2)',
          est.uncertaintyPublished ? 'uncertainty propagated from the distance error only (first order)' : 'no uncertainty: the distance has none published',
        ],
        note: 'Size in the catalogue\'s measuring band and isophote, not a boundary of the object.',
      };
    } else if (o.angularSize) unavailable['physical_size'] = 'needs a distance';

    const images = this.imageAssetsOf(id);
    const fidelity: ImageryNote['fidelity'] =
      o.representation.kind === 'observed-members' ? 'scientific-map'
      : o.representation.kind === 'documented-model' || o.representation.kind === 'illustrative' ? 'procedural'
      : o.representation.kind === 'deprojected-image' ? 'derived'
      : images.some((a) => a.fidelity !== 'scientific-image') ? 'artistic-composite' : 'scientific-map';
    const imagery: ImageryNote = {
      fidelity,
      summary: o.representation.summary,
      ...(images.length ? { credit: [...new Set(images.map((a) => a.credit))].join(' | '), license: [...new Set(images.map((a) => a.licence.name))].join(', ') } : {}),
    };
    const exaggerations = o.representation.exaggerations ?? [];
    const representation = [o.representation.summary, `Depth: ${o.representation.depth}.`, ...(exaggerations.length ? [`Exaggerations: ${exaggerations.join('; ')}.`] : [])].join(' ');
    const facts: Fact[] = [...(o.facts ?? [])];

    return {
      id: o.id,
      name: o.name,
      designations: o.designations,
      classification: CLASSIFICATION[o.kind],
      frame: NEIGHBOURHOOD_FRAME,
      ...(o.parentId ? { parent: o.parentId } : {}),
      ...(o.sky ? { sky: { raDeg: o.sky.raDeg, decDeg: o.sky.decDeg, ...(o.sky.distance ? { distance: o.sky.distance } : {}) }, referenceFrame: 'ICRS (catalogue epoch)' } : {}),
      measurements,
      ...(Object.keys(unavailable).length ? { unavailable } : {}),
      ...(facts.length ? { facts } : {}),
      imagery,
      confidence: o.representation.kind === 'documented-model' ? 'model' : 'catalogued',
      ...(o.notes ? { notes: o.notes } : {}),
      representation,
    };
  }
}

// ---- loaders (browser; local files only) ---------------------------------------------------------------------------

/** `base` is the site base URL with trailing slash, e.g. import.meta.env.BASE_URL. */
export function loadDeepSpaceFile(base: string): Promise<DeepSpaceFile> { return loadJson<DeepSpaceFile>(`${base}data/deep-space.v1.json`); }
export function loadImageProvenance(base: string): Promise<DeepImageProvenanceFile> { return loadJson<DeepImageProvenanceFile>(`${base}deepspace/provenance.json`); }
export function loadPointCatalogue(base: string, id: string): Promise<PointCatalogueFile> { return loadJson<PointCatalogueFile>(`${base}data/deepspace/${id}.v1.json.gz`); }
