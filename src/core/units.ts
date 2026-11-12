/** Physical constants and unit conversions. SI everywhere internally; metres are the scene unit. */
export const METRES_PER_AU = 1.495978707e11; // IAU 2012 exact
export const METRES_PER_PARSEC = 3.0856775814913673e16; // IAU 2015 exact (648000/pi AU)
export const METRES_PER_LIGHT_YEAR = 9.4607304725808e15; // IAU, Julian year
export const METRES_PER_KM = 1e3;

export const toAU = (m: number) => m / METRES_PER_AU;
export const toParsec = (m: number) => m / METRES_PER_PARSEC;
export const toLightYear = (m: number) => m / METRES_PER_LIGHT_YEAR;
