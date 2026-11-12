/**
 * Scientific data model. Visual rendering reads from these records; it never invents values.
 * Every measured quantity carries provenance. Missing values are `undefined`, never guessed.
 */

export type Classification =
  | 'star' | 'planet' | 'moon' | 'dwarf-planet' | 'asteroid' | 'comet'
  | 'star-cluster' | 'nebula' | 'galaxy' | 'galaxy-group' | 'galaxy-cluster'
  | 'exoplanet-host' | 'other';

/** A named source with a stable identifier, so every value can be traced back. */
export interface SourceRef {
  /** Short key, e.g. "nasa-planetary-fact-sheet", "simbad", "gaia-dr3", "nasa-exoplanet-archive". */
  readonly source: string;
  /** Dataset version / release, e.g. "DR3", "2024-06". */
  readonly release?: string;
  /** Record or table identifier inside that source. */
  readonly recordId?: string;
  /** URL to the authoritative record, where one exists. */
  readonly url?: string;
  /** ISO date the value was retrieved or last verified. */
  readonly retrieved: string;
}

/** A physical measurement with unit, uncertainty and provenance. */
export interface Measurement {
  readonly value: number;
  /** SI unit, e.g. "m", "kg", "K", "pc". Stored SI; conversion happens at display time. */
  readonly unit: string;
  /** 1-sigma uncertainty in the same unit, if the source gives one. */
  readonly uncertainty?: number;
  readonly source: SourceRef;
  /** Free-text qualifier: "nominal", "estimated", "model-dependent", etc. */
  readonly note?: string;
}

/** ICRS equatorial coordinates (degrees) plus distance, when known. */
export interface SkyPosition {
  readonly raDeg: number;
  readonly decDeg: number;
  readonly distance?: Measurement;
}

export interface CelestialObject {
  /** Stable internal id, e.g. "sun", "earth", "gaia-dr3-4373465352415301632". */
  readonly id: string;
  /** Primary display name. */
  readonly name: string;
  /** Other designations (catalogue ids, Bayer names, etc.). */
  readonly designations: readonly string[];
  readonly classification: Classification;
  /** Frame id in the spatial FrameTree that this object's position is expressed in. */
  readonly frame: string;
  /** Parent body id, for moons and planets (orbital hierarchy). */
  readonly parent?: string;
  /** Galactocentric or heliocentric position, when the data supports it. */
  readonly sky?: SkyPosition;
  readonly radius?: Measurement;
  readonly mass?: Measurement;
  readonly temperature?: Measurement;
  /** Optional, purely presentational: a texture key. Never used for scientific values. */
  readonly visualKey?: string;
  /** Confidence grade for the record as a whole. */
  readonly confidence: 'confirmed' | 'catalogued' | 'model' | 'hypothetical';
  readonly notes?: string;
}

/** A dataset is a collection of objects from one source, plus its licence and version. */
export interface Dataset {
  readonly id: string;
  readonly title: string;
  readonly source: SourceRef;
  readonly licence: string;
  readonly objects: readonly CelestialObject[];
}
