import type { Dataset } from './schema';

/**
 * Seed dataset: a deliberately small set of Solar System values with publicly documented
 * nominal figures. Values are from NASA Planetary Fact Sheets / IAU 2015 nominal constants
 * and should be re-verified against the cited sources before any public release.
 * `retrieved` marks when the value was entered, not when the source was published.
 */
const RETRIEVED = '2026-11-12';

const nasa = (recordId: string, url: string) => ({
  source: 'nasa-planetary-fact-sheet',
  recordId,
  url,
  retrieved: RETRIEVED,
});

export const SEED_SOLAR: Dataset = {
  id: 'seed-solar-system',
  title: 'Solar System seed (nominal values)',
  source: { source: 'nasa-planetary-fact-sheet', retrieved: RETRIEVED, url: 'https://nssdc.gsfc.nasa.gov/planetary/factsheet/' },
  licence: 'US Government work (public domain) for NASA-derived values; verify before redistribution',
  objects: [
    {
      id: 'sun',
      name: 'Sun',
      designations: ['Sol'],
      classification: 'star',
      frame: 'solar-system',
      radius: { value: 6.957e8, unit: 'm', uncertainty: 0, source: { source: 'iau-2015-b3', retrieved: RETRIEVED }, note: 'IAU 2015 nominal solar radius' },
      mass: { value: 1.9885e30, unit: 'kg', source: { source: 'iau-2015-b3', retrieved: RETRIEVED }, note: 'derived from GM_sun' },
      temperature: { value: 5772, unit: 'K', source: { source: 'iau-2015-b3', retrieved: RETRIEVED }, note: 'effective temperature, nominal' },
      confidence: 'confirmed',
    },
    {
      id: 'earth',
      name: 'Earth',
      designations: [],
      classification: 'planet',
      frame: 'solar-system',
      parent: 'sun',
      radius: { value: 6.378137e6, unit: 'm', source: { source: 'iau-2015-b3', retrieved: RETRIEVED }, note: 'equatorial, nominal' },
      mass: { value: 5.9722e24, unit: 'kg', source: nasa('earth', 'https://nssdc.gsfc.nasa.gov/planetary/factsheet/earthfact.html'), note: 'approximate' },
      confidence: 'confirmed',
    },
    {
      id: 'moon',
      name: 'Moon',
      designations: ['Luna'],
      classification: 'moon',
      frame: 'earth-system',
      parent: 'earth',
      radius: { value: 1.7374e6, unit: 'm', source: nasa('moon', 'https://nssdc.gsfc.nasa.gov/planetary/factsheet/moonfact.html'), note: 'mean radius' },
      mass: { value: 7.342e22, unit: 'kg', source: nasa('moon', 'https://nssdc.gsfc.nasa.gov/planetary/factsheet/moonfact.html') },
      confidence: 'confirmed',
    },
  ],
};
