/**
 * Visual parameters for drawing each body. These are VISUALISATION CHOICES, kept out of the scientific dataset:
 * fallback colours, atmosphere glow and similar are not measurements. Which textures exist, and how faithful they are,
 * comes from public/textures/provenance.json, not from this file.
 */
export type Rgb = readonly [number, number, number];

export interface BodyAppearance {
  /** Colour used where no texture exists. A visualisation choice, not an observation. */
  readonly fallback: Rgb;
  readonly day?: string;
  readonly night?: string;
  readonly clouds?: string;
  /** Multiplies the map (used to tint a luminance-only map to an approximate natural colour). */
  readonly tint?: Rgb;
  /** Atmosphere glow: colour, shell thickness as a fraction of the radius (exaggerated for visibility), strength. */
  readonly atmosphere?: { readonly colour: Rgb; readonly thickness: number; readonly strength: number; readonly twilight?: number };
  readonly rings?: { readonly texture: string };
  readonly specular?: number;
  readonly emissive?: boolean;
}

const grey = (v: number): Rgb => [v, v, v];

export const APPEARANCE: Readonly<Record<string, BodyAppearance>> = {
  sun: { fallback: [1.0, 0.93, 0.8], emissive: true },
  mercury: { fallback: [0.42, 0.4, 0.38], day: 'mercury', tint: [0.62, 0.57, 0.52] },
  venus: { fallback: [0.92, 0.84, 0.64], day: 'venus', atmosphere: { colour: [1.0, 0.85, 0.55], thickness: 0.03, strength: 0.55, twilight: 0.15 } },
  earth: { fallback: [0.2, 0.35, 0.6], day: 'earth_day', night: 'earth_night', clouds: 'earth_clouds', specular: 0.45, atmosphere: { colour: [0.32, 0.55, 1.0], thickness: 0.018, strength: 1.0, twilight: 0.3 } },
  moon: { fallback: grey(0.5), day: 'moon' },
  mars: { fallback: [0.6, 0.34, 0.22], day: 'mars', atmosphere: { colour: [0.85, 0.6, 0.45], thickness: 0.012, strength: 0.22, twilight: 0.1 } },
  phobos: { fallback: grey(0.22) },
  deimos: { fallback: grey(0.26) },
  jupiter: { fallback: [0.75, 0.65, 0.5], day: 'jupiter', atmosphere: { colour: [0.85, 0.75, 0.6], thickness: 0.01, strength: 0.18 } },
  io: { fallback: [0.85, 0.78, 0.45], day: 'io' },
  europa: { fallback: [0.78, 0.75, 0.68], day: 'europa', tint: [1.0, 0.96, 0.9] },
  ganymede: { fallback: [0.55, 0.5, 0.45], day: 'ganymede' },
  callisto: { fallback: [0.32, 0.29, 0.26], day: 'callisto', tint: [0.95, 0.88, 0.8] },
  saturn: { fallback: [0.85, 0.78, 0.6], day: 'saturn', rings: { texture: 'saturn_rings' }, atmosphere: { colour: [0.9, 0.82, 0.65], thickness: 0.01, strength: 0.15 } },
  mimas: { fallback: grey(0.5) },
  enceladus: { fallback: grey(0.9), day: 'enceladus', tint: [0.95, 0.97, 1.0] },
  tethys: { fallback: grey(0.7) },
  dione: { fallback: grey(0.62) },
  rhea: { fallback: grey(0.6) },
  titan: { fallback: [0.78, 0.55, 0.22], atmosphere: { colour: [0.95, 0.62, 0.2], thickness: 0.05, strength: 0.7, twilight: 0.1 } },
  iapetus: { fallback: grey(0.45) },
  uranus: { fallback: [0.62, 0.82, 0.86], day: 'uranus', atmosphere: { colour: [0.6, 0.85, 0.9], thickness: 0.01, strength: 0.2 } },
  ariel: { fallback: grey(0.5) }, umbriel: { fallback: grey(0.32) }, titania: { fallback: grey(0.48) }, oberon: { fallback: grey(0.42) }, miranda: { fallback: grey(0.5) },
  neptune: { fallback: [0.24, 0.38, 0.85], day: 'neptune', atmosphere: { colour: [0.35, 0.5, 1.0], thickness: 0.01, strength: 0.3 } },
  triton: { fallback: [0.78, 0.72, 0.68], day: 'triton' },
};

export const appearanceOf = (id: string): BodyAppearance => APPEARANCE[id] ?? { fallback: grey(0.5) };

/** Marker colour (the fixed-size dot used when a body is too small to draw as a sphere). */
export const markerColour = (id: string): Rgb => (id === 'sun' ? [1, 0.9, 0.6] : appearanceOf(id).fallback);
