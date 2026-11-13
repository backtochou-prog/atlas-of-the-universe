/**
 * Column definitions for the Gaia DR3 subset. Shared by the build-time importer and the browser
 * reader. Units are the units PUBLISHED by the Gaia archive; nothing is converted in storage.
 */
export const GAIA_NUMERIC_COLUMNS = [
  'ra', 'ra_error', 'dec', 'dec_error',
  'parallax', 'parallax_error',
  'pmra', 'pmra_error', 'pmdec', 'pmdec_error',
  'phot_g_mean_mag', 'phot_g_mean_flux_over_error',
  'phot_bp_mean_mag', 'phot_bp_mean_flux_over_error',
  'phot_rp_mean_mag', 'phot_rp_mean_flux_over_error',
  'ruwe', 'astrometric_params_solved', 'visibility_periods_used', 'astrometric_excess_noise',
  'hip_id', 'hip_sep_arcsec',
  'teff_gspphot', 'teff_gspphot_lower', 'teff_gspphot_upper',
] as const;

export type GaiaNumericColumn = (typeof GAIA_NUMERIC_COLUMNS)[number];

/** Units as published by the Gaia archive (ra_error and dec_error are in mas; ra_error includes cos(dec)). */
export const GAIA_COLUMN_UNITS: Readonly<Record<GaiaNumericColumn, string>> = {
  ra: 'deg', ra_error: 'mas', dec: 'deg', dec_error: 'mas',
  parallax: 'mas', parallax_error: 'mas',
  pmra: 'mas/yr', pmra_error: 'mas/yr', pmdec: 'mas/yr', pmdec_error: 'mas/yr',
  phot_g_mean_mag: 'mag', phot_g_mean_flux_over_error: 'dimensionless',
  phot_bp_mean_mag: 'mag', phot_bp_mean_flux_over_error: 'dimensionless',
  phot_rp_mean_mag: 'mag', phot_rp_mean_flux_over_error: 'dimensionless',
  ruwe: 'dimensionless', astrometric_params_solved: 'dimensionless', visibility_periods_used: 'dimensionless',
  astrometric_excess_noise: 'mas',
  hip_id: 'dimensionless', hip_sep_arcsec: 'arcsec',
  teff_gspphot: 'K', teff_gspphot_lower: 'K', teff_gspphot_upper: 'K',
};

/** Columns in the exact order requested from the archive (after source_id, ref_epoch). */
export const GAIA_QUERY_COLUMNS = [
  'source_id', 'ref_epoch', ...GAIA_NUMERIC_COLUMNS.slice(0, 20), 'duplicated_source', ...GAIA_NUMERIC_COLUMNS.slice(20),
] as const;

export const GAIA_REFERENCE_EPOCH = 2016.0;
