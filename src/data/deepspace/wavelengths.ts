/**
 * Short, standard explanations of what each observing band shows. These are general astronomy, not claims about one image:
 * what a particular image shows is stated by its own provenance entry (filters, colourNote, processing).
 * Colours in every band other than visible light are ASSIGNED by the people who made the picture.
 */
import type { WavelengthBand } from './types';

export interface WavelengthInfo {
  readonly band: WavelengthBand;
  readonly label: string;
  /** Approximate wavelength range (standard convention; boundaries between bands are not sharp). */
  readonly range: string;
  /** What light of this kind typically reveals. */
  readonly reveals: string;
  /** How colour should be read in this band. */
  readonly colour: string;
}

const ASSIGNED = 'Not visible to the eye: any colour shown is assigned by the image makers (false colour).';

export const WAVELENGTH_INFO: Readonly<Record<WavelengthBand, WavelengthInfo>> = {
  visible: {
    band: 'visible', label: 'Visible light', range: 'about 400 to 700 nm',
    reveals: 'Starlight and glowing gas as the eye is sensitive to it; dust shows up as dark lanes where it blocks the light behind.',
    colour: 'Filter exposures are often combined into a colour picture; the result is a processed composite, not a view through an eyepiece. Telescope images are much more sensitive than the eye.',
  },
  'near-infrared': {
    band: 'near-infrared', label: 'Near-infrared', range: 'about 0.75 to 5 micrometres',
    reveals: 'Older, cooler stars; light that passes through dust more easily than visible light, so stars behind dust clouds become visible.',
    colour: ASSIGNED,
  },
  'mid-infrared': {
    band: 'mid-infrared', label: 'Mid-infrared', range: 'about 5 to 30 micrometres',
    reveals: 'Warm dust and large molecules heated by starlight, and the glow of dusty shells around dying stars.',
    colour: ASSIGNED,
  },
  'far-infrared': {
    band: 'far-infrared', label: 'Far-infrared', range: 'about 30 to 300 micrometres',
    reveals: 'Cool dust, still-forming stars hidden inside clouds.',
    colour: ASSIGNED,
  },
  ultraviolet: {
    band: 'ultraviolet', label: 'Ultraviolet', range: 'about 10 to 400 nm (space telescopes only: the atmosphere blocks most of it)',
    reveals: 'Hot, young, massive stars and recent star formation.',
    colour: ASSIGNED,
  },
  'x-ray': {
    band: 'x-ray', label: 'X-ray', range: 'about 0.01 to 10 nm (space telescopes only)',
    reveals: 'Very hot gas (millions of kelvin), and compact objects such as neutron stars and black holes accreting matter.',
    colour: ASSIGNED,
  },
  radio: {
    band: 'radio', label: 'Radio', range: 'wavelengths from about a millimetre upwards',
    reveals: 'Cold gas (for example neutral hydrogen), and synchrotron emission from fast electrons in magnetic fields.',
    colour: ASSIGNED,
  },
  'gamma-ray': {
    band: 'gamma-ray', label: 'Gamma-ray', range: 'shorter than about 0.01 nm (space telescopes only)',
    reveals: 'The most energetic processes: particle acceleration, pulsars, and some stellar explosions.',
    colour: ASSIGNED,
  },
  'multi-band-composite': {
    band: 'multi-band-composite', label: 'Multi-band composite', range: 'several bands combined into one picture',
    reveals: 'Whatever the combined exposures record; each channel keeps the meaning of its own band.',
    colour: 'Colours are chosen when the bands are combined. Read the filter list and the colour note of the image: it may include non-visible bands or stand-ins for them.',
  },
};

export function wavelengthInfo(band: WavelengthBand): WavelengthInfo { return WAVELENGTH_INFO[band]; }

/** Plain text for the band switcher: what the band shows, and (for non-visible bands) that colours are assigned. */
export function describeBand(band: WavelengthBand): string {
  const w = WAVELENGTH_INFO[band];
  return `${w.label} (${w.range}). ${w.reveals} ${w.colour}`;
}

/** True when a picture in this band can never be "how it would look" to a human eye. */
export function isNonVisibleBand(band: WavelengthBand): boolean { return band !== 'visible'; }
