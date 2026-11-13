/**
 * Discovery engine contracts (Prompt 07). Pure types, no logic, no DOM, no Three.js.
 *
 * ONE universal id per object, "<namespace>:<local>", stable across sessions (used for bookmarks and history):
 *   gaia:<source_id>      a Gaia DR3 record of the local subset (src/data/catalogue)
 *   hip:<number>          a Hipparcos star that is NOT in the Gaia subset (bright-star supplement)
 *   solar:<bodyId>        Sun, planets, moons (src/data/solar)
 *   deep:<objectId>       curated deep-space object (src/data/deepspace): galaxies, nebulae, clusters, groups
 *   point:<fileId>:<row>  a row of a deep-space point catalogue (ungc, local-group-mcconnachie, twomrs)
 *   exo:<planetName>      a confirmed exoplanet (NASA Exoplanet Archive pl_name)
 *   host:<hostName>       an exoplanet host star / system (archive hostname)
 *   other:<id>            other supported objects (e.g. other:sgr-a-star)
 * A star that exists in several datasets (Gaia + Hipparcos + exoplanet host) is ONE record with `sameAs` links; the
 * Gaia record wins when present, because it is the drawn one.
 */
import type { Vec3 } from '../core/spatial/vec3';

export type UniversalId = string;

export type ObjectCategory =
  | 'star' | 'planet' | 'moon' | 'exoplanet' | 'exoplanet-host' | 'galaxy' | 'nebula' | 'star-cluster'
  | 'galaxy-group' | 'galaxy-cluster' | 'supernova-remnant' | 'other';

export type DatasetId =
  | 'gaia-dr3' | 'hipparcos' | 'solar-system' | 'deep-space' | 'nasa-exoplanet-archive'
  | 'ungc' | 'local-group-mcconnachie' | 'twomrs' | 'curated-other';

/** Quantities a filter may use. A record has a key ONLY if the dataset provides it: absent = unavailable, never 0. */
export type MeasurementKey =
  | 'distancePc' | 'apparentMag' | 'absoluteMag' | 'teffK' | 'luminositySun' | 'radiusKm' | 'radiusSun' | 'massKg'
  | 'angularSizeArcmin' | 'physicalSizePc' | 'redshift' | 'czKms' | 'orbitalPeriodDays' | 'bpRp' | 'pmTotalMasYr';

/** How trustworthy a value is, using the project's existing categories. Filters/rankings must say which they use. */
export type ValueKind = 'observed' | 'derived' | 'modelled';

export interface RecordMeasurement {
  readonly value: number;
  readonly kind: ValueKind;
  /** 1-sigma where published; absent = not published. */
  readonly uncertainty?: number;
  /** Optional (added by the discovery core, R1): a plain statement of an assumption behind the value, e.g. "d = cz / H0, H0 = 70 km/s/Mpc is an application choice". */
  readonly note?: string;
  /** Optional (added by the discovery core, R1): the dataset this value came from when it differs from the record's own dataset (set by mergeRecords when a value is filled from a duplicate in another dataset). */
  readonly source?: DatasetId;
}

/** Where an object is, for spatial queries and navigation. Heliocentric ICRS parsecs; Solar System bodies use `solar` instead. */
export type DiscoveryPosition =
  | { readonly kind: 'icrs'; readonly xyzPc: Vec3; readonly raDeg: number; readonly decDeg: number; readonly distanceUncertaintyPc?: number }
  | { readonly kind: 'sky-only'; readonly raDeg: number; readonly decDeg: number }   // direction known, distance unknown: not placed in 3D
  | { readonly kind: 'solar'; readonly bodyId: string };                              // position from the ephemeris at the current time

export interface DiscoveryRecord {
  readonly id: UniversalId;
  readonly dataset: DatasetId;
  readonly category: ObjectCategory;
  readonly name: string;
  /** Every searchable alternative name/identifier, exactly as published (case preserved): "HIP 32349", "alf CMa", "NGC 224". */
  readonly designations: readonly string[];
  /** Short classification line for lists, e.g. "Spiral galaxy · SA(s)b", "K-type star", "Confirmed exoplanet (transit)". */
  readonly classification: string;
  /** Spectral type exactly as published (stars), for filters/display. */
  readonly spectralType?: string;
  readonly position: DiscoveryPosition;
  readonly measurements: Readonly<Partial<Record<MeasurementKey, RecordMeasurement>>>;
  /** Other records known to be the SAME object in another dataset (identity, not a relationship). */
  readonly sameAs?: readonly UniversalId[];
  /** Whether the Atlas can draw this object at some scale (false = inspect-only, e.g. a Gaia record without distance). */
  readonly drawn: boolean;
  /** Source dataset citation key, resolvable in the data provenance (shown by the inspector). */
  readonly sourceKey: string;
  /** Optional (added by the discovery core, R1): soft quality flags from the source, e.g. Gaia 'high-ruwe' (see src/data/catalogue/flags.ts). A flagged record is kept and the flag is shown with it. */
  readonly qualityFlags?: readonly string[];
}

// ---- relationships --------------------------------------------------------------------------------------------------------------

/**
 * physical-gravitational  bound: orbits, binary component, bound cluster/group membership with a published basis
 * structural              containment in a larger structure that is not a bound orbit (Sun is in the Milky Way)
 * spatial-association     only near each other / in the same region by OUR selection (never presented as physical)
 * identity                same object in two datasets
 */
export type RelationBasis = 'physical-gravitational' | 'structural' | 'spatial-association' | 'identity';
export type RelationKind = 'orbits' | 'member-of' | 'component-of' | 'part-of' | 'near' | 'same-object-as';

export interface Relation {
  readonly from: UniversalId;
  readonly to: UniversalId;
  readonly kind: RelationKind;
  readonly basis: RelationBasis;
  /** Plain sentence, shown to the user ("Europa orbits Jupiter (JPL satellite catalogue)"). */
  readonly statement: string;
  /** Where the relation comes from: a dataset field ("solar-system.parent") or a citation. Required for every relation. */
  readonly source: { readonly label: string; readonly url?: string; readonly derivedFrom?: string };
}

// ---- data files written by tools/discovery ---------------------------------------------------------------------------------

export interface DatasetManifestBase {
  readonly id: string;
  readonly title: string;
  readonly source: { readonly source: string; readonly release?: string; readonly url?: string; readonly retrieved: string };
  readonly licence: string;
  readonly query: string;
  readonly count: number;
  readonly caveats: readonly string[];
  readonly units: Readonly<Record<string, string>>;
}

/** public/data/bright-stars.v1.json.gz — Hipparcos stars (named + bright), SoA. Required columns documented in docs/DISCOVERY_ENGINE.md. */
export interface BrightStarFile {
  readonly manifest: DatasetManifestBase & { readonly astrometricEpoch: string; readonly nameSource: string };
  /** Required: hip, raDeg, decDeg, parallaxMas, parallaxErrMas, pmraMasYr, pmdecMasYr, vMag, bvColour, spectralType, variability, iauName, designations (| separated), gaiaSourceId (string|null: the Gaia subset record that is the same star, found at build time). null = not available. */
  readonly columns: Readonly<Record<string, readonly (number | string | null)[]>>;
}

/** public/data/exoplanets.v1.json.gz — NASA Exoplanet Archive pscomppars, planets + hosts as two SoA tables. */
export interface ExoplanetFile {
  readonly manifest: DatasetManifestBase & { readonly table: string; readonly archiveRelease: string };
  /** Required: hostname, raDeg, decDeg, distPc, distErrPc, spectralType, teffK, stRadiusSun, stMassSun, vMag, gaiaDr3Id (string|null), nPlanets, nStars. */
  readonly hosts: Readonly<Record<string, readonly (number | string | null)[]>>;
  /** Required: plName, hostname, discoveryMethod, discoveryYear, discoveryFacility, periodDays, periodErr, radiusEarth, radiusErr, massEarth, massErr, massKind ('Mass'|'Msini'|'Msin(i)/sin(i)'...), eqTempK, semiMajorAxisAu, refName. */
  readonly planets: Readonly<Record<string, readonly (number | string | null)[]>>;
}

/** public/data/discovery-notes.v1.json — short source-backed explanations. EVERY statement is a claim with >= 1 reference. */
export interface NoteClaim {
  readonly text: string;
  readonly status: 'observed' | 'inferred' | 'hypothesis' | 'historical';
  readonly references: readonly { readonly label: string; readonly url: string; readonly retrieved: string }[];
}
export interface DiscoveryNote {
  readonly id: UniversalId;                 // the object this explains
  readonly oneLine: string;                 // "The nearest known stellar neighbour of the Sun." (also a claim below)
  readonly sections: {
    readonly what: readonly NoteClaim[];
    readonly why: readonly NoteClaim[];
    readonly discovery?: readonly NoteClaim[];
    readonly interesting?: readonly NoteClaim[];
    readonly uncertain: readonly NoteClaim[];
  };
  readonly studiedBy: readonly { readonly mission: string; readonly role: string; readonly reference: { readonly label: string; readonly url: string } }[];
}
export interface DiscoveryNotesFile {
  readonly manifest: { readonly schema: 'atlas-discovery-notes/1'; readonly generated: string; readonly policy: string };
  readonly notes: readonly DiscoveryNote[];
}

export interface RelationsFile {
  readonly manifest: { readonly schema: 'atlas-relations/1'; readonly generated: string };
  readonly relations: readonly Relation[];
}

/** public/data/other-objects.v1.json — a few well-documented objects that fit no other dataset (e.g. Sagittarius A*). */
export interface OtherObject {
  readonly id: UniversalId;                // "other:sgr-a-star"
  readonly name: string;
  readonly designations: readonly string[];
  readonly category: ObjectCategory;       // 'other' | 'supernova-remnant' | 'star' ...
  readonly classification: string;         // e.g. "Supermassive black hole (Galactic centre)"
  readonly raDeg: number;
  readonly decDeg: number;
  /** Distance with its own provenance; absent = unknown (then the object is sky-only). */
  readonly distance?: { readonly value: number; readonly unit: 'pc' | 'kpc' | 'Mpc'; readonly uncertainty?: number; readonly kind: ValueKind; readonly source: { readonly label: string; readonly url: string; readonly retrieved: string } };
  readonly coordinateSource: { readonly label: string; readonly url: string; readonly retrieved: string };
  readonly facts: readonly NoteClaim[];
}
export interface OtherObjectsFile {
  readonly manifest: { readonly schema: 'atlas-other-objects/1'; readonly generated: string; readonly note: string };
  readonly objects: readonly OtherObject[];
}
