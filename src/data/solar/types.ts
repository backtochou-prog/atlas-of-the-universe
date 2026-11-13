import type { Measurement } from '../schema';
import type { OrbitDefinition } from '../../core/orbits/types';
import type { RotationElements } from '../../core/orbits/rotation';

export const SOLAR_FORMAT = 'atlas-solar-system' as const;
export const SOLAR_FORMAT_VERSION = 1 as const;

export type SolarBodyKind = 'star' | 'planet' | 'moon';

/** A contextual statement with an explicit certainty label. Observed facts, inferences and hypotheses are never mixed. */
export interface SolarFact {
  readonly text: string;
  /** observed: directly measured; inferred: follows from measurements plus modelling; hypothesis: proposed, not confirmed. */
  readonly status: 'observed' | 'inferred' | 'hypothesis';
  readonly reference: string;
  readonly url?: string;
}

export interface SourceNote {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly retrieved: string;
  readonly note?: string;
}

export interface OrbitSource {
  readonly model: string;
  readonly source: string;
  readonly retrieved: string;
  readonly epochJdTdb?: number;
  readonly url: string;
}

export interface SolarBodyRecord {
  readonly id: string;
  readonly name: string;
  readonly naifId: number;
  readonly kind: SolarBodyKind;
  readonly parent: string | null;
  /** Physical quantities keyed by name. Each carries unit, uncertainty, category, source and retrieval date. */
  readonly physical: Readonly<Record<string, Measurement>>;
  readonly triaxialRadiiKm?: readonly [number, number, number];
  readonly spectralType?: { readonly value: string; readonly source: string; readonly retrieved: string };
  readonly orbit?: OrbitDefinition;
  readonly orbitSource?: OrbitSource;
  readonly rotation?: RotationElements;
  readonly rotationSource?: OrbitSource;
  /** True when rotation is synchronous with the orbit (the same hemisphere faces the parent). */
  readonly synchronousRotation?: boolean;
  /** GM, km^3/s^2, used for the Earth-Moon barycentre correction. */
  readonly gm?: number;
  readonly facts: readonly SolarFact[];
  /** Quantities JPL does not publish for this body, with the reason. */
  readonly unavailable: Readonly<Record<string, string>>;
}

export interface ValidationRow {
  readonly body: string;
  readonly label: string;
  readonly jdTdb: number;
  readonly errorKm: number;
  /** Angular error as seen from the parent (arcseconds). */
  readonly errorArcsec: number;
  /** Error as a fraction of the distance to the parent. */
  readonly relativeError: number;
}

export interface SolarManifest {
  readonly id: string;
  readonly version: number;
  readonly builtAt: string;
  readonly referenceEpoch: { readonly iso: string; readonly jdTdb: number; readonly scale: string };
  readonly sources: readonly SourceNote[];
  readonly constants: { readonly gravitationalConstant: { readonly value: number; readonly unit: string; readonly source: string } };
  readonly validation: readonly ValidationRow[];
  /** HTTP status recorded for each reference URL cited in the facts, at build time (0 = not checked). */
  readonly referenceChecks: Readonly<Record<string, number>>;
  readonly notes: readonly string[];
}

export interface SolarDatasetFile {
  readonly format: typeof SOLAR_FORMAT;
  readonly formatVersion: typeof SOLAR_FORMAT_VERSION;
  readonly manifest: SolarManifest;
  readonly bodies: readonly SolarBodyRecord[];
}
