import type { GaiaNumericColumn } from './columns';

export const GAIA_FORMAT = 'atlas-gaia-columns' as const;
export const SIMBAD_FORMAT = 'atlas-simbad-crossid' as const;
export const DATASET_FORMAT_VERSION = 1 as const;

export interface CatalogueIdentity {
  readonly name: string;
  readonly release: string;
  readonly releaseDate: string;
  readonly archive: string;
  readonly tapUrl: string;
  readonly documentation: string;
  readonly referenceEpoch: number;
  readonly referenceFrame: string;
}

export interface RetrievalRecord {
  /** ISO 8601 timestamp of the retrieval that produced the cached raw file. */
  readonly retrievedAt: string;
  readonly endpoint: string;
  /** The exact ADQL submitted. */
  readonly adql: string;
  readonly rawSha256: string;
  readonly rawBytes: number;
  readonly rawRows: number;
}

export interface GaiaManifest {
  readonly id: string;
  readonly version: number;
  readonly builtAt: string;
  readonly catalogue: CatalogueIdentity;
  readonly retrieval: RetrievalRecord;
  readonly selection: readonly string[];
  readonly thresholds: {
    readonly reliableParallaxSnr: number;
    readonly marginalParallaxSnr: number;
    readonly highRuwe: number;
  };
  readonly counts: { readonly queryRows: number; readonly imported: number; readonly rejected: number };
  /** SHA-256 of the canonical JSON of sourceId, duplicatedSource and columns: identical raw input gives an identical hash. */
  readonly contentSha256: string;
  readonly units: Readonly<Record<string, string>>;
  readonly attribution: readonly string[];
  readonly notes: readonly string[];
}

/** Columnar dataset. `null` = not present in the catalogue (never zero). source_id is a string: it exceeds 2^53. */
export interface GaiaDatasetFile {
  readonly format: typeof GAIA_FORMAT;
  readonly formatVersion: typeof DATASET_FORMAT_VERSION;
  readonly manifest: GaiaManifest;
  readonly sourceId: readonly string[];
  readonly duplicatedSource: readonly (boolean | null)[];
  readonly columns: Readonly<Record<GaiaNumericColumn, readonly (number | null)[]>>;
}

export interface SimbadEntry {
  /** SIMBAD main identifier. */
  readonly m: string;
  /** SIMBAD object type code (otype). */
  readonly t: string;
  /** Spectral type as given by SIMBAD, if any. */
  readonly sp?: string;
  /** SIMBAD coordinate reference (bibcode), if any. */
  readonly c?: string;
  /** Selected alternative identifiers (prioritised, capped). */
  readonly i: readonly string[];
  /** Total number of identifiers SIMBAD lists for the object. */
  readonly n: number;
}

export interface SimbadManifest {
  readonly id: string;
  readonly version: number;
  readonly builtAt: string;
  readonly service: { readonly name: string; readonly endpoint: string; readonly note: string };
  readonly retrievedAt: string;
  readonly querySummary: string;
  readonly batchQuery: string;
  readonly requested: number;
  readonly matched: number;
  readonly unmatched: number;
  readonly conflicts: number;
  readonly sharedObjects: number;
  readonly attribution: readonly string[];
  readonly notes: readonly string[];
}

export interface SimbadCrossIdFile {
  readonly format: typeof SIMBAD_FORMAT;
  readonly formatVersion: typeof DATASET_FORMAT_VERSION;
  readonly manifest: SimbadManifest;
  /** otype code -> SIMBAD label/description. */
  readonly otypes: Readonly<Record<string, { readonly label: string; readonly description: string }>>;
  /** Keyed by Gaia DR3 source_id (string). */
  readonly entries: Readonly<Record<string, SimbadEntry>>;
}
