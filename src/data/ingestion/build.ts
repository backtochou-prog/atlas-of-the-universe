import { createHash } from 'node:crypto';
import { GAIA_COLUMN_UNITS, GAIA_NUMERIC_COLUMNS, GAIA_REFERENCE_EPOCH, type GaiaNumericColumn } from '../catalogue/columns';
import { HIGH_RUWE, type GaiaRecord } from '../catalogue/flags';
import { NEIGHBOURHOOD_RADIUS_PC } from '../catalogue/frames';
import {
  DATASET_FORMAT_VERSION, GAIA_FORMAT, SIMBAD_FORMAT,
  type GaiaDatasetFile, type GaiaManifest, type RetrievalRecord, type SimbadCrossIdFile, type SimbadManifest,
} from '../catalogue/types';
import { MARGINAL_PARALLAX_SNR, RELIABLE_PARALLAX_SNR } from '../../core/astro/parallax';
import { findHipConflicts, findPositionalDuplicates, type MergeResult } from './crossid';
import { describeSelection, parseGaiaCsv, DEFAULT_GAIA_SELECTION, GAIA_TAP_ENDPOINT, type GaiaSelection } from './gaia';
import { normalizeGaia, type RejectedRecord } from './normalize';
import { buildQualityReport, type QualityReport } from './quality';

export const GAIA_ATTRIBUTION: readonly string[] = [
  'This work has made use of data from the European Space Agency (ESA) mission Gaia (https://www.cosmos.esa.int/gaia), processed by the Gaia Data Processing and Analysis Consortium (DPAC, https://www.cosmos.esa.int/web/gaia/dpac/consortium). Funding for the DPAC has been provided by national institutions, in particular the institutions participating in the Gaia Multilateral Agreement.',
  'Gaia Collaboration, Prusti et al. 2016, A&A 595, A1 (the Gaia mission).',
  'Gaia Collaboration, Vallenari et al. 2023, A&A 674, A1 (Gaia Data Release 3: summary of the content and survey properties).',
];

export const SIMBAD_ATTRIBUTION: readonly string[] = [
  'This research has made use of the SIMBAD database, operated at CDS, Strasbourg, France.',
  'Wenger et al. 2000, A&AS 143, 9 (the SIMBAD astronomical database).',
];

function contentHash(f: Pick<GaiaDatasetFile, 'sourceId' | 'duplicatedSource' | 'columns'>): string {
  return createHash('sha256').update(JSON.stringify({ s: f.sourceId, d: f.duplicatedSource, c: f.columns })).digest('hex');
}

export interface GaiaBuildInput {
  readonly rawCsv: string;
  readonly retrieval: RetrievalRecord;
  readonly selection?: GaiaSelection;
  readonly builtAt: string;
  readonly version?: number;
}

export interface GaiaBuildResult {
  readonly file: GaiaDatasetFile;
  readonly quality: QualityReport;
  readonly records: readonly GaiaRecord[];
  readonly rejected: readonly RejectedRecord[];
}

export function buildGaiaDataset(input: GaiaBuildInput): GaiaBuildResult {
  const selection = input.selection ?? DEFAULT_GAIA_SELECTION;
  const raw = parseGaiaCsv(input.rawCsv);
  const { records, rejected } = normalizeGaia(raw);

  const cols = {} as Record<GaiaNumericColumn, (number | null)[]>;
  for (const c of GAIA_NUMERIC_COLUMNS) cols[c] = records.map((r) => r.values[c]);
  const partial = { sourceId: records.map((r) => r.sourceId), duplicatedSource: records.map((r) => r.duplicatedSource), columns: cols };

  const manifest: GaiaManifest = {
    id: 'gaia-dr3-subset',
    version: input.version ?? 1,
    builtAt: input.builtAt,
    catalogue: {
      name: 'Gaia DR3', release: 'DR3', releaseDate: '2022-06-13', archive: 'https://gea.esac.esa.int/archive/',
      tapUrl: GAIA_TAP_ENDPOINT, documentation: 'https://www.cosmos.esa.int/web/gaia/dr3',
      referenceEpoch: GAIA_REFERENCE_EPOCH, referenceFrame: 'ICRS',
    },
    retrieval: input.retrieval,
    selection: describeSelection(selection),
    thresholds: { reliableParallaxSnr: RELIABLE_PARALLAX_SNR, marginalParallaxSnr: MARGINAL_PARALLAX_SNR, highRuwe: HIGH_RUWE },
    counts: { queryRows: raw.length, imported: records.length, rejected: rejected.length },
    contentSha256: contentHash(partial),
    units: { ...GAIA_COLUMN_UNITS, source_id: 'identifier' },
    attribution: GAIA_ATTRIBUTION,
    notes: [
      'Original catalogue values are stored unchanged, in catalogue units. null means the catalogue has no value; it is never zero.',
      'All astrometry is at the Gaia DR3 reference epoch J2016.0 in ICRS. No proper-motion propagation is applied.',
      'Distances are derived at load time from parallax and are never stored in this file.',
    ],
  };

  const hipConflicts = findHipConflicts(records);
  const positionalDuplicates = findPositionalDuplicates(records);
  const quality = buildQualityReport({
    datasetId: manifest.id, generatedAt: input.builtAt, queryRows: raw.length, records, rejected, hipConflicts, positionalDuplicates,
    maxPlacementDistancePc: NEIGHBOURHOOD_RADIUS_PC,
    notes: [`Stars with an inferred distance beyond ${NEIGHBOURHOOD_RADIUS_PC} pc are not placed in 3D (outside the visualisation frame).`],
  });

  return { file: { format: GAIA_FORMAT, formatVersion: DATASET_FORMAT_VERSION, manifest, ...partial }, quality, records, rejected };
}

export function buildSimbadFile(input: {
  builtAt: string;
  retrievedAt: string;
  service: SimbadManifest['service'];
  batchQuery: string;
  requested: number;
  merge: MergeResult;
  otypes: SimbadCrossIdFile['otypes'];
  version?: number;
}): SimbadCrossIdFile {
  const accounted = input.merge.matched + input.merge.unmatched.length + input.merge.conflicts.length;
  if (accounted !== input.requested) throw new Error(`SIMBAD accounting error: matched + unmatched + conflicts = ${accounted}, requested ${input.requested}`);
  return {
    format: SIMBAD_FORMAT,
    formatVersion: DATASET_FORMAT_VERSION,
    manifest: {
      id: 'simbad-crossid', version: input.version ?? 1, builtAt: input.builtAt, service: input.service, retrievedAt: input.retrievedAt,
      querySummary: 'Exact match on the SIMBAD identifier "Gaia DR3 <source_id>", then the object\'s main identifier, object type, spectral type, coordinate bibcode and identifier list.',
      batchQuery: input.batchQuery,
      requested: input.requested, matched: input.merge.matched, unmatched: input.merge.unmatched.length,
      conflicts: input.merge.conflicts.length, sharedObjects: input.merge.sharedObjects.length,
      attribution: SIMBAD_ATTRIBUTION,
      notes: [
        'SIMBAD complements Gaia: it supplies identifiers and classification only. Gaia astrometry and photometry are never replaced.',
        'Matching is by exact identifier, never by position. Gaia ids with more than one SIMBAD object are left unmatched and listed as conflicts.',
        `Identifier lists are prioritised and capped; the full count is kept per object.`,
      ],
    },
    otypes: input.otypes,
    entries: input.merge.entries,
  };
}
