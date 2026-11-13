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

/**
 * Epistemic category of a value. These are never mixed:
 *  observed     - directly measured by an instrument and published as such by the catalogue
 *  derived      - computed from observed values plus stated assumptions (see `transformations`)
 *  modelled     - an estimate produced by a scientific model fitted to data (e.g. GSP-Phot Teff)
 *  hypothetical - proposed or theoretical, without observational confirmation
 */
export type MeasurementKind = 'observed' | 'derived' | 'modelled' | 'hypothetical';

/**
 * A physical measurement with unit, uncertainty and provenance.
 * Catalogue-native units are preserved (e.g. mas, mas/yr, mag, deg): conversion to other units
 * happens in derived values, never by overwriting the original. A quantity that is not available
 * is ABSENT from `CelestialObject.measurements`; it is never encoded as 0 or NaN.
 */
export interface Measurement {
  readonly value: number;
  /** Unit as published (see ALLOWED_UNITS in validate.ts), e.g. "m", "kg", "K", "mas", "mas/yr", "mag", "pc", "deg". */
  readonly unit: string;
  /** 1-sigma uncertainty, if the source gives one. In `unit` unless `uncertaintyUnit` says otherwise. */
  readonly uncertainty?: number;
  /** Set when the catalogue publishes the uncertainty in a different unit (e.g. RA in deg, error in mas). */
  readonly uncertaintyUnit?: string;
  readonly kind: MeasurementKind;
  readonly source: SourceRef;
  /** Ordered steps applied to reach this value from the original catalogue values. Required for derived values. */
  readonly transformations?: readonly string[];
  /** Reference epoch of the value where it matters, e.g. "J2016.0". */
  readonly epoch?: string;
  /** Free-text qualifier: "nominal", "estimated", "model-dependent", etc. */
  readonly note?: string;
}

/** ICRS equatorial coordinates (degrees) plus distance, when known. */
export interface SkyPosition {
  readonly raDeg: number;
  readonly decDeg: number;
  readonly distance?: Measurement;
}

/** Identification supplied by a cross-reference source (SIMBAD). It never overrides catalogue astrometry. */
export interface Identification {
  readonly mainId: string;
  /** Object type code and label as published by the identification source. */
  readonly objectType: string;
  readonly objectTypeLabel?: string;
  readonly spectralType?: string;
  /** Bibliographic code of the reference for the source's coordinates, where given. */
  readonly coordinateReference?: string;
  readonly source: SourceRef;
}

/** A contextual statement with an explicit certainty label. */
export interface Fact {
  readonly text: string;
  /** observed: measured; inferred: follows from measurements plus modelling; hypothesis: proposed, not confirmed. */
  readonly status: 'observed' | 'inferred' | 'hypothesis';
  readonly reference: string;
  readonly url?: string;
}

/** How the surface or cloud-top imagery used to draw the object should be read. */
export interface ImageryNote {
  readonly fidelity: 'scientific-map' | 'derived' | 'artistic-composite' | 'procedural' | 'none';
  readonly summary: string;
  readonly credit?: string;
  readonly license?: string;
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
  /**
   * Other named quantities, e.g. parallax, pmra, pmdec, g_mag, bp_mag, rp_mag, bp_rp, teff_gspphot.
   * Absent key = not available. Never a zero placeholder.
   */
  readonly measurements?: Readonly<Record<string, Measurement>>;
  /** Reference frame/epoch of `sky`, e.g. "ICRS, J2016.0". */
  readonly referenceFrame?: string;
  readonly identification?: Identification;
  /** Quantity key -> why it is not available. Shown to the user instead of a value. */
  readonly unavailable?: Readonly<Record<string, string>>;
  /** Quality flags attached to this record (kept, never hidden). */
  readonly qualityFlags?: readonly string[];
  readonly facts?: readonly Fact[];
  readonly imagery?: ImageryNote;
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
