import { GAIA_NUMERIC_COLUMNS, GAIA_QUERY_COLUMNS, type GaiaNumericColumn } from '../catalogue/columns';
import { parseCsvObjects } from './csv';

export const GAIA_TAP_ENDPOINT = 'https://gea.esac.esa.int/tap-server/tap';

/**
 * Selection criteria for the initial subset (documented in docs/SCIENTIFIC_DATA.md):
 *  - "bright": every source with G < brightGMagLimit (naked-eye-visible sky), regardless of parallax quality
 *  - "nearby": parallax >= nearbyMinParallaxMas (distance <= ~1000/that pc) with parallax/error >= nearbyMinParallaxSnr
 * The union is returned once per source (a single query), ordered by source_id for reproducibility.
 */
export interface GaiaSelection {
  readonly brightGMagLimit: number;
  readonly nearbyMinParallaxMas: number;
  readonly nearbyMinParallaxSnr: number;
}

export const DEFAULT_GAIA_SELECTION: GaiaSelection = {
  brightGMagLimit: 6.5,
  nearbyMinParallaxMas: 25,
  nearbyMinParallaxSnr: 5,
};

const SELECT_EXPR: Partial<Record<string, string>> = {
  hip_id: 'h.original_ext_source_id AS hip_id',
  hip_sep_arcsec: 'h.angular_distance AS hip_sep_arcsec',
  teff_gspphot: 'a.teff_gspphot',
  teff_gspphot_lower: 'a.teff_gspphot_lower',
  teff_gspphot_upper: 'a.teff_gspphot_upper',
};

function assertFinite(name: string, v: number): void {
  if (!Number.isFinite(v)) throw new Error(`Selection parameter ${name} must be finite`);
}

export function buildGaiaQuery(sel: GaiaSelection = DEFAULT_GAIA_SELECTION): string {
  assertFinite('brightGMagLimit', sel.brightGMagLimit);
  assertFinite('nearbyMinParallaxMas', sel.nearbyMinParallaxMas);
  assertFinite('nearbyMinParallaxSnr', sel.nearbyMinParallaxSnr);
  const cols = GAIA_QUERY_COLUMNS.map((c) => SELECT_EXPR[c] ?? `g.${c}`).join(', ');
  return [
    `SELECT ${cols}`,
    'FROM gaiadr3.gaia_source AS g',
    'LEFT OUTER JOIN gaiadr3.hipparcos2_best_neighbour AS h ON g.source_id = h.source_id',
    'LEFT OUTER JOIN gaiadr3.astrophysical_parameters AS a ON g.source_id = a.source_id',
    `WHERE g.phot_g_mean_mag < ${sel.brightGMagLimit} OR (g.parallax >= ${sel.nearbyMinParallaxMas} AND g.parallax_over_error >= ${sel.nearbyMinParallaxSnr})`,
    'ORDER BY g.source_id',
  ].join('\n');
}

export function describeSelection(sel: GaiaSelection = DEFAULT_GAIA_SELECTION): string[] {
  return [
    `Bright set: phot_g_mean_mag < ${sel.brightGMagLimit} (all sources, regardless of parallax quality).`,
    `Nearby set: parallax >= ${sel.nearbyMinParallaxMas} mas (distance <= ${(1000 / sel.nearbyMinParallaxMas).toFixed(0)} pc) and parallax_over_error >= ${sel.nearbyMinParallaxSnr}.`,
    'Union of the two sets, one row per source_id, ordered by source_id.',
    'Cross-matches joined (left outer): gaiadr3.hipparcos2_best_neighbour (Hipparcos number) and gaiadr3.astrophysical_parameters (GSP-Phot Teff, modelled).',
  ];
}

export interface GaiaRawRow {
  readonly sourceId: string;
  readonly refEpoch: number | null;
  readonly values: Readonly<Record<GaiaNumericColumn, number | null>>;
  readonly duplicatedSource: boolean | null;
  /** Problems found while parsing this row (non-numeric text in a numeric column, unparsable boolean). */
  readonly parseIssues: readonly string[];
}

/** Parse a Gaia archive CSV. Empty cells become null: the catalogue has no value there. */
export function parseGaiaCsv(text: string): GaiaRawRow[] {
  const { header, rows } = parseCsvObjects(text);
  const missing = GAIA_QUERY_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) throw new Error(`Gaia CSV is missing expected columns: ${missing.join(', ')}`);

  return rows.map((r) => {
    const issues: string[] = [];
    const num = (col: string): number | null => {
      const raw = r[col]!.trim();
      if (raw === '') return null;
      const v = Number(raw);
      if (!Number.isFinite(v)) { issues.push(`non-numeric ${col}="${raw.slice(0, 24)}"`); return null; }
      return v;
    };
    const values = {} as Record<GaiaNumericColumn, number | null>;
    for (const c of GAIA_NUMERIC_COLUMNS) values[c] = num(c);
    const dupRaw = r['duplicated_source']!.trim().toLowerCase();
    let duplicatedSource: boolean | null = null;
    if (dupRaw === 'true') duplicatedSource = true;
    else if (dupRaw === 'false') duplicatedSource = false;
    else if (dupRaw !== '') issues.push(`unparsable duplicated_source="${dupRaw.slice(0, 12)}"`);
    return { sourceId: r['source_id']!.trim(), refEpoch: num('ref_epoch'), values, duplicatedSource, parseIssues: issues };
  });
}
