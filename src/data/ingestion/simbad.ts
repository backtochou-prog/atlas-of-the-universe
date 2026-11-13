import type { SimbadEntry } from '../catalogue/types';
import { parseCsvObjects } from './csv';
import type { SimbadRow } from './crossid';
import { tapSync, type TapConfig } from './tap';

/**
 * SIMBAD (CDS, Strasbourg) is queried through its public TAP service.
 * The primary host is tried first; the official CfA (Harvard) mirror is the documented fallback.
 * The host that actually served the data is recorded in the dataset manifest.
 */
export const SIMBAD_ENDPOINTS = [
  { name: 'SIMBAD (CDS Strasbourg)', endpoint: 'https://simbad.cds.unistra.fr/simbad/sim-tap' },
  { name: 'SIMBAD mirror (CfA Harvard)', endpoint: 'https://simbad.cfa.harvard.edu/simbad/sim-tap' },
] as const;

export const SIMBAD_BATCH_SIZE = 250;
export const MAX_IDENTIFIERS_PER_OBJECT = 12;

const sqlString = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** One batch query: exact "Gaia DR3 <source_id>" identifier match, then the object's main id, type, spectral type, coordinate reference and id list. */
function batchQueryFor(inList: string): string {
  return [
    'SELECT i1.id AS gaia_ident, b.oid, b.main_id, b.otype, b.sp_type, b.coo_bibcode, x.ids',
    'FROM ident AS i1',
    'JOIN basic AS b ON i1.oidref = b.oid',
    'JOIN ids AS x ON x.oidref = b.oid',
    `WHERE i1.id IN (${inList})`,
  ].join('\n');
}

export function buildSimbadBatchQuery(gaiaIds: readonly string[]): string {
  if (gaiaIds.length === 0) throw new Error('No Gaia ids supplied');
  for (const id of gaiaIds) if (!/^\d{1,19}$/.test(id)) throw new Error(`Refusing to query invalid Gaia id "${id}"`);
  return batchQueryFor(gaiaIds.map((id) => sqlString(`Gaia DR3 ${id}`)).join(','));
}

/** The same query with a placeholder list, for the provenance report. */
export const SIMBAD_BATCH_QUERY_TEMPLATE: string = batchQueryFor("'Gaia DR3 <source_id>', ...  /* up to 250 ids per request */");

export const SIMBAD_OTYPE_QUERY = 'SELECT otype, label, description FROM otypedef';

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

const PRIORITY: readonly RegExp[] = [
  /^NAME /, /^\* /, /^V\* /, /^(HD|HR|HIP) /, /^(GJ|Gl|LHS|LTT|Wolf|Ross) /, /^(BD|CD|CPD)[-+]/, /^TYC /, /^2MASS /, /^TIC /,
];

/** Keep the identifiers people actually use, ordered by usefulness, capped. The total count is kept separately. */
export function selectIdentifiers(idsField: string, exclude: readonly string[] = [], cap = MAX_IDENTIFIERS_PER_OBJECT): { selected: string[]; total: number } {
  const all = idsField.split('|').map(collapse).filter((s) => s.length > 0);
  const skip = new Set(exclude.map(collapse));
  const ranked: { id: string; rank: number; order: number }[] = [];
  all.forEach((id, order) => {
    if (skip.has(id)) return;
    const rank = PRIORITY.findIndex((re) => re.test(id));
    if (rank >= 0) ranked.push({ id, rank, order });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.order - b.order);
  return { selected: ranked.slice(0, cap).map((r) => r.id), total: all.length };
}

export function parseSimbadBatch(csv: string): SimbadRow[] {
  const { rows } = parseCsvObjects(csv);
  return rows.map((r) => {
    const gaiaIdent = r['gaia_ident']!.trim();
    const { selected, total } = selectIdentifiers(r['ids'] ?? '', [gaiaIdent]);
    const sp = collapse(r['sp_type'] ?? '');
    const bib = (r['coo_bibcode'] ?? '').trim();
    const entry: SimbadEntry = {
      m: collapse(r['main_id']!),
      t: r['otype']!.trim(),
      ...(sp ? { sp } : {}),
      ...(bib ? { c: bib } : {}),
      i: selected,
      n: total,
    };
    return { gaiaIdent, oid: Number(r['oid']), entry };
  });
}

export function parseOtypes(csv: string): Record<string, { label: string; description: string }> {
  const { rows } = parseCsvObjects(csv);
  const out: Record<string, { label: string; description: string }> = {};
  for (const r of rows) out[r['otype']!.trim()] = { label: r['label']!.trim(), description: r['description']!.trim() };
  return out;
}

export interface ProbeResult {
  readonly name: string;
  readonly endpoint: string;
  readonly reachable: boolean;
  readonly detail: string;
}

/** Try each endpoint with a trivial query; return the first that answers with CSV. */
export async function probeSimbad(
  candidates = SIMBAD_ENDPOINTS,
  base: Omit<TapConfig, 'endpoint'> = {},
): Promise<{ chosen: ProbeResult | null; attempts: ProbeResult[] }> {
  const attempts: ProbeResult[] = [];
  for (const c of candidates) {
    try {
      const text = await tapSync({ ...base, endpoint: c.endpoint, timeoutMs: 30_000 }, 'SELECT TOP 1 main_id FROM basic');
      const ok = text.trimStart().startsWith('main_id');
      const r: ProbeResult = { name: c.name, endpoint: c.endpoint, reachable: ok, detail: ok ? 'answered a test query' : 'unexpected response' };
      attempts.push(r);
      if (ok) return { chosen: r, attempts };
    } catch (e) {
      attempts.push({ name: c.name, endpoint: c.endpoint, reachable: false, detail: String((e as Error).message).slice(0, 160) });
    }
  }
  return { chosen: null, attempts };
}
