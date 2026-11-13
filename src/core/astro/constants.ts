/** Angle and astrometry constants. Every conversion in Atlas goes through these. */
export const DEG_TO_RAD = Math.PI / 180;
export const RAD_TO_DEG = 180 / Math.PI;
export const ARCSEC_PER_DEG = 3600;
export const MAS_PER_ARCSEC = 1000;
export const MAS_PER_DEG = ARCSEC_PER_DEG * MAS_PER_ARCSEC;

/** Julian year in days (IAU). Gaia epochs are Julian years (J2016.0). */
export const DAYS_PER_JULIAN_YEAR = 365.25;

/**
 * 1 AU/yr expressed in km/s (IAU 2012 AU, Julian year). Tangential velocity:
 *   v_t [km/s] = K * mu [mas/yr] / parallax [mas]
 */
export const KM_S_PER_AU_YR = 4.740470446;

/** Distance in parsecs for a parallax in milliarcseconds: d = 1000 / parallax. */
export const PC_MAS = 1000;

/** Gaia DR3 reference epoch (Julian year). All Gaia DR3 astrometry is referred to this epoch. */
export const GAIA_DR3_REFERENCE_EPOCH = 2016.0;

/** Distance of the Sun from the Galactic centre, GRAVITY Collaboration 2019 (A&A 625, L10), in pc. */
export const SUN_GALACTOCENTRIC_DISTANCE_PC = 8178;
