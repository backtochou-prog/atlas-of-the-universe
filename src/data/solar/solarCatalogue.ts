import type { CelestialObject, Classification, ImageryNote, Measurement } from '../schema';
import type { EphemerisBody } from '../../core/orbits/types';
import { SolarSystemEphemeris } from '../../core/orbits/ephemeris';
import { SOLAR_FORMAT, SOLAR_FORMAT_VERSION, type SolarBodyRecord, type SolarDatasetFile } from './types';

export interface TextureProvenanceEntry {
  readonly id: string;
  readonly body: string;
  readonly use: string;
  readonly fidelity: 'scientific-map' | 'derived' | 'artistic-composite' | 'procedural';
  readonly source: string;
  readonly credit: string;
  readonly license: string;
  readonly note?: string;
  /** Fraction of the map that is no-data (pure black in the source), 0..1. */
  readonly nodata_fraction?: number;
  readonly outputs?: Readonly<Record<string, { readonly file: string; readonly size: readonly number[] } | string>>;
}

const FRAME = 'solar-system';

/** Browser-side access to the Solar System dataset. */
export class SolarSystemData {
  readonly bodies: ReadonlyMap<string, SolarBodyRecord>;
  readonly ephemeris: SolarSystemEphemeris;

  private constructor(readonly file: SolarDatasetFile, private readonly textures: readonly TextureProvenanceEntry[]) {
    this.bodies = new Map(file.bodies.map((b) => [b.id, b]));
    const eph: EphemerisBody[] = file.bodies.map((b) => ({
      id: b.id, parent: b.parent,
      ...(b.orbit ? { orbit: b.orbit } : {}), ...(b.rotation ? { rotation: b.rotation } : {}), ...(b.gm !== undefined ? { gm: b.gm } : {}),
    }));
    this.ephemeris = new SolarSystemEphemeris(eph);
  }

  static fromFile(file: unknown, textures: readonly TextureProvenanceEntry[] = []): SolarSystemData {
    const f = file as Partial<SolarDatasetFile> | null;
    if (!f || f.format !== SOLAR_FORMAT) throw new Error('Not an Atlas Solar System dataset');
    if (f.formatVersion !== SOLAR_FORMAT_VERSION) throw new Error(`Unsupported Solar System dataset version ${String(f.formatVersion)}`);
    if (!f.manifest || !Array.isArray(f.bodies)) throw new Error('Solar System dataset is incomplete');
    return new SolarSystemData(f as SolarDatasetFile, textures);
  }

  get manifest() { return this.file.manifest; }
  get(id: string): SolarBodyRecord | undefined { return this.bodies.get(id); }
  children(id: string): SolarBodyRecord[] { return this.file.bodies.filter((b) => b.parent === id); }
  physical(id: string, key: string): Measurement | undefined { return this.get(id)?.physical[key]; }
  /** Physical mean radius in metres, or undefined when the dataset has none. */
  meanRadiusMetres(id: string): number | undefined { const r = this.physical(id, 'mean_radius'); return r ? r.value * 1000 : undefined; }

  textureEntries(bodyId: string): TextureProvenanceEntry[] { return this.textures.filter((t) => t.body === bodyId); }

  /** How the imagery drawn for a body should be read, derived from the texture provenance (never from the renderer). */
  imageryNote(bodyId: string): ImageryNote {
    const entries = this.textureEntries(bodyId);
    if (entries.length === 0) {
      return { fidelity: 'none', summary: 'No surface imagery is used for this body: it is drawn as a plain, uniformly coloured sphere. The colour is a visualisation choice, not an observation.' };
    }
    // The least faithful layer determines how the whole appearance must be described.
    const rank = { 'scientific-map': 0, derived: 1, 'artistic-composite': 2, procedural: 3 } as const;
    const worst = [...entries].sort((a, b) => rank[b.fidelity] - rank[a.fidelity])[0]!;
    const label = {
      'scientific-map': 'Scientific map (spacecraft data mosaic)',
      derived: 'Derived from scientific data (processed or art-directed)',
      'artistic-composite': 'Artistic composite based on NASA data, NOT a scientific map',
      procedural: 'Procedurally generated, not imagery',
    }[worst.fidelity];
    const gaps = entries.filter((e) => (e.nodata_fraction ?? 0) > 0.005).map((e) => `${(e.nodata_fraction! * 100).toFixed(e.nodata_fraction! >= 0.1 ? 0 : 1)}% of the ${e.use} map has no data (unimaged terrain), drawn as flat grey`);
    return {
      fidelity: worst.fidelity,
      summary: `${label}. ${entries.map((e) => `${e.use}: ${e.source}`).join('; ')}.${worst.note ? ` ${worst.note}` : ''}${gaps.length ? ` ${gaps.join('; ')}.` : ''}`,
      credit: [...new Set(entries.map((e) => e.credit))].join('; '),
      license: [...new Set(entries.map((e) => e.license))].join('; '),
    };
  }

  /** A sourced scientific record for the inspector. Measurements are those in the dataset; nothing is added here. */
  toObject(id: string): CelestialObject {
    const b = this.get(id);
    if (!b) throw new Error(`Unknown Solar System body "${id}"`);
    const classification: Classification = b.kind === 'star' ? 'star' : b.kind === 'planet' ? 'planet' : 'moon';
    const p = b.physical;
    return {
      id: `solar-${b.id}`,
      name: b.name,
      designations: [b.name, `NAIF ${b.naifId}`],
      classification,
      frame: FRAME,
      ...(b.parent ? { parent: `solar-${b.parent}` } : {}),
      ...(p['mean_radius'] ? { radius: p['mean_radius'] } : {}),
      ...(p['mass'] ? { mass: p['mass'] } : {}),
      ...(p['temperature'] ?? p['effective_temperature'] ? { temperature: (p['temperature'] ?? p['effective_temperature'])! } : {}),
      measurements: p,
      unavailable: b.unavailable,
      referenceFrame: b.orbit ? (b.orbit.model === 'jpl-approx-keplerian' ? 'Heliocentric, ICRS axes (from mean ecliptic J2000 elements)' : 'Parent-centred, ICRF equatorial axes') : 'Origin of the Solar System frame',
      confidence: 'confirmed',
      facts: b.facts,
      imagery: this.imageryNote(b.id),
      ...(b.spectralType ? { notes: `Spectral type ${b.spectralType.value} (${b.spectralType.source}).` } : {}),
    };
  }
}
