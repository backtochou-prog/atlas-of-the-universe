/**
 * Deep-space data model (Prompt 06). Pure types: nothing here draws anything.
 *
 * Four things are kept apart, and must stay apart:
 *   1. object METADATA      DeepSpaceObject (identity, classification, measurements with provenance)
 *   2. SPATIAL coordinates  DeepSpaceObject.sky: catalogue ICRS RA/Dec + a distance Measurement (with uncertainty).
 *                           The Cartesian position is DERIVED on load and never stored as the truth.
 *   3. VISUAL representation  DeepSpaceObject.representation + imageAssetIds (what the picture is and how it is read)
 *   4. RENDERING implementation  src/render/deep-space/* (reads 1-3, owns no astronomy)
 */
import type { Fact, Measurement, SourceRef } from '../schema';

export type DeepSpaceKind =
  | 'galaxy' | 'nebula' | 'star-cluster' | 'galaxy-group' | 'galaxy-cluster' | 'cosmic-structure';

/** Coarse galaxy class used to choose a rendering strategy. `morphologyLabel` keeps the catalogue's own string. */
export type GalaxyClass =
  | 'spiral' | 'barred-spiral' | 'lenticular' | 'elliptical' | 'irregular' | 'dwarf-spheroidal' | 'dwarf-irregular' | 'peculiar';
export type NebulaClass =
  | 'emission' | 'reflection' | 'dark' | 'planetary' | 'supernova-remnant' | 'molecular-cloud';
export type ClusterClass = 'open' | 'globular';

/**
 * What the drawn representation IS. This is the honesty field. Shown in the inspector and in the HUD.
 *  observed-members   the drawn points are catalogued objects at their catalogued positions (e.g. Gaia cluster members)
 *  observed-image     a real telescope image projected where the object is on the sky (depth NOT measured)
 *  deprojected-image  a real image re-mapped onto the galaxy's disc plane using published position angle and inclination
 *  documented-model   an analytic model from the literature, parameters cited (e.g. Milky Way spiral arms, disc profile)
 *  illustrative       a visual aid built for this application (e.g. depth layers, boundaries); NOT a measurement
 */
export type RepresentationKind = 'observed-members' | 'observed-image' | 'deprojected-image' | 'documented-model' | 'illustrative';

export interface Representation {
  readonly kind: RepresentationKind;
  /** One or two sentences, shown verbatim to the user. Must say what is measured and what is not. */
  readonly summary: string;
  /** How the third dimension is obtained. */
  readonly depth: 'measured-per-object' | 'measured-cluster-mean' | 'illustrative' | 'published-orientation-model' | 'sky-plane-only' | 'illustrative-layers' | 'documented-model';
  /** Anything that is a visual exaggeration or stylisation rather than data (never hidden). */
  readonly exaggerations?: readonly string[];
}

export interface DeepSkyPosition {
  /** ICRS, degrees, catalogue epoch. */
  readonly raDeg: number;
  readonly decDeg: number;
  /** Distance with uncertainty. Always a Measurement: unit pc|kpc|Mpc. Absent = distance unknown (object is then not placed in 3D). */
  readonly distance?: Measurement;
  readonly coordinateSource: SourceRef;
}

export interface AngularSize {
  readonly majorArcmin: number;
  readonly minorArcmin?: number;
  /** Position angle of the major axis, degrees east of north. */
  readonly positionAngleDeg?: number;
  readonly source: SourceRef;
  /** What the size is: 'D25' (25 mag/arcsec^2 isophote), 'optical-extent', 'half-light-diameter', 'catalogue-diameter'. */
  readonly definition: string;
}

/** Orientation of a disc galaxy, from the literature. Both numbers are published values with sources. */
export interface DiscOrientation {
  /** Inclination, degrees: 0 = face-on, 90 = edge-on. */
  readonly inclinationDeg: Measurement;
  /** Position angle of the major axis, degrees east of north. */
  readonly positionAngleDeg: Measurement;
  /** Which side of the major axis is nearer to us. 'unknown' means the 3D tilt direction in the picture is a choice, not a fact. */
  readonly nearSide: 'north-east' | 'south-west' | 'north-west' | 'south-east' | 'unknown';
}

export interface DeepSpaceObject {
  readonly id: string;                       // stable, kebab-case: "m31", "orion-nebula", "pleiades"
  readonly name: string;                     // display name, e.g. "Andromeda Galaxy (M31)"
  readonly designations: readonly string[];  // "M 31", "NGC 224", "UGC 454", ...
  readonly kind: DeepSpaceKind;
  /** Exactly one of these is set, matching `kind` (nebula/star-cluster/galaxy). */
  readonly galaxyClass?: GalaxyClass;
  readonly nebulaClass?: NebulaClass;
  readonly clusterClass?: ClusterClass;
  /** The catalogue's own morphology / type string, untouched: "SA(s)b", "E+0-1 pec", "PN", "Gb". */
  readonly morphologyLabel?: string;
  /**
   * Set only when `morphologyLabel` is NOT a catalogue string but a literature range or statement adopted by this application
   * (e.g. the Milky Way, "SBb - SBbc", Kormendy 2019). Says so, with the source. The inspector then shows this instead of "as given by the catalogue".
   */
  readonly morphologyNote?: string;
  /** When the label is a range, the single type string actually passed to `classifyGalaxy` to derive `galaxyClass` (a choice of ours, stated in `morphologyNote`). */
  readonly morphologyClassBasis?: string;
  readonly sky?: DeepSkyPosition;
  readonly angularSize?: AngularSize;
  readonly orientation?: DiscOrientation;
  /** Named quantities, each with unit, uncertainty, kind (observed/derived/modelled) and source. Absent = not available. */
  readonly measurements: Readonly<Record<string, Measurement>>;
  readonly unavailable?: Readonly<Record<string, string>>;
  readonly facts?: readonly Fact[];
  readonly representation: Representation;
  /** Ids into the image provenance file (public/deepspace/provenance.json). Order: preferred first. */
  readonly imageAssetIds: readonly string[];
  /** Id of a members/points file under public/data/deepspace/ if the object is drawn from catalogued members. */
  readonly pointsFileId?: string;
  /** Parent in the astronomical hierarchy where it is scientifically meaningful ("m32" -> "local-group"). */
  readonly parentId?: string;
  /** For galaxy groups / clusters: which rows of a point catalogue are members, and on what basis. */
  readonly membership?: {
    readonly pointsFileId: string;
    /** Catalogue names (the `name` column) of the members. Explicit, so the selection is reproducible. */
    readonly names: readonly string[];
    /** Plain statement of the membership criterion and whose it is ("McConnachie 2012 Table 1: within 3 Mpc of the Sun"). */
    readonly basis: string;
    readonly source: SourceRef;
  };
  readonly notes?: string;
}

/** The curated objects file: public/data/deep-space.v1.json */
export interface DeepSpaceFile {
  readonly manifest: {
    readonly schema: 'atlas-deep-space/1';
    readonly generated: string;
    readonly builtBy: string;
    readonly sources: readonly { readonly key: string; readonly title: string; readonly url: string; readonly retrieved: string; readonly licence: string; readonly note?: string }[];
  };
  readonly objects: readonly DeepSpaceObject[];
  /** Documented analytic model parameters (Milky Way). Every number carries its reference. */
  readonly models: Readonly<Record<string, DocumentedModel>>;
}

export interface ModelParameter { readonly name: string; readonly value: number; readonly unit: string; readonly uncertainty?: number; readonly reference: string; readonly url?: string }
export interface DocumentedModel {
  readonly id: string;
  readonly title: string;
  readonly parameters: readonly ModelParameter[];
  /** Tables of cited numbers (e.g. spiral-arm segments), column-major with a units row. */
  readonly tables?: Readonly<Record<string, { readonly columns: readonly string[]; readonly units: readonly string[]; readonly rows: readonly (number | string)[][]; readonly reference: string; readonly url?: string }>>;
  readonly limitations: readonly string[];
}

// ---- point catalogues: structure-of-arrays files under public/data/deepspace/*.v1.json.gz -------------------------------

export interface PointCatalogueManifest {
  readonly id: string;
  readonly title: string;
  readonly source: SourceRef;
  readonly licence: string;
  readonly count: number;
  /** The exact query / selection that produced the rows, so the file can be rebuilt. */
  readonly query: string;
  /** How position along the line of sight was obtained for each row. */
  readonly distanceBasis: 'per-object-direct' | 'per-object-redshift-hubble-flow' | 'cluster-mean' | 'per-object-parallax';
  /** Plain statement of what the points are and are not (selection effects, completeness, distortions). */
  readonly caveats: readonly string[];
  readonly units: Readonly<Record<string, string>>;
}
/** Columns are equal-length arrays. Required columns depend on `manifest.id` (see docs/DEEP_SPACE.md). null = not available. */
export interface PointCatalogueFile {
  readonly manifest: PointCatalogueManifest;
  readonly columns: Readonly<Record<string, readonly (number | string | null)[]>>;
}

// ---- image assets: public/deepspace/provenance.json -------------------------------------------------------------------------

export type WavelengthBand = 'visible' | 'near-infrared' | 'mid-infrared' | 'far-infrared' | 'ultraviolet' | 'x-ray' | 'radio' | 'gamma-ray' | 'multi-band-composite';

export interface ImageLevel {
  /** 0 = smallest (always-resident thumbnail), higher = more detail. */
  readonly level: number;
  readonly file: string;             // relative to public/deepspace/
  readonly widthPx: number;
  readonly heightPx: number;
  readonly bytes: number;
  readonly format: 'jpeg' | 'webp' | 'png';
}

export interface DeepImageAsset {
  readonly id: string;
  readonly objectId: string;
  readonly title: string;
  readonly band: {
    readonly kind: WavelengthBand;
    /** Filters / instrument channels as published, e.g. ["F435W","F555W","F658N"], or ["Ks"]. */
    readonly filters: readonly string[];
    /** True if the colours are assigned by the image makers (not what an eye would see). */
    readonly falseColour: boolean;
    /** True if several exposures/bands/missions were combined. */
    readonly composite: boolean;
    /** Plain statement of how to read the colours. */
    readonly colourNote: string;
  };
  readonly source: {
    readonly archive: string;          // "ESA/Hubble", "ESO", "NASA Image and Video Library", "NASA SkyView", ...
    readonly imageId: string;          // the archive's own identifier: "heic1502a", "eso1103a", "PIA..." , "GALEX/NUV"
    readonly landingUrl: string;       // page that documents the image
    readonly downloadUrl: string;      // exact file URL used
    readonly retrieved: string;        // ISO date
    readonly sha256: string;           // of the downloaded original
  };
  readonly credit: string;             // the credit line exactly as published
  readonly licence: {
    readonly name: string;             // "CC BY 4.0", "NASA media usage guidelines", ...
    readonly url: string;
    /** The sentence(s) on the archive's pages that grant the licence, copied verbatim. */
    readonly evidence: string;
    readonly attributionRequired: boolean;
    readonly redistributionAllowed: boolean;
  };
  readonly observation: { readonly telescope: string; readonly instrument?: string; readonly date?: string };
  readonly geometry: {
    readonly originalWidthPx: number;
    readonly originalHeightPx: number;
    /** Field of view of the ORIGINAL image on the sky, arcminutes (width, height). */
    readonly fovArcmin: readonly [number, number];
    readonly centreRaDeg: number;
    readonly centreDecDeg: number;
    /** Degrees the image's "up" is rotated east of celestial north (0 = north up, east left). */
    readonly upPositionAngleDeg: number;
    readonly wcsSource: 'fits-header' | 'archive-metadata' | 'estimated-from-published-size';
  };
  readonly processing: readonly string[];
  readonly levels: readonly ImageLevel[];
  /** How a user should read this image. Shown in the inspector. */
  readonly fidelity: 'scientific-image' | 'multi-band-composite' | 'artist-processed';
}
export interface DeepImageProvenanceFile {
  readonly manifest: { readonly schema: 'atlas-deep-images/1'; readonly generated: string };
  readonly assets: readonly DeepImageAsset[];
}
