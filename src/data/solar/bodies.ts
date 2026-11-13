import type { SolarBodyKind, SolarFact } from './types';

/**
 * Curated identity and context for each body. NOTHING numeric is hand-entered here: every physical value comes from
 * the JPL/NAIF import. This file holds names, hierarchy, which source rows to use, and contextual facts, each with an
 * explicit certainty label and a reference. Visual parameters live in src/render/solar/appearance.ts, not here.
 */
export interface BodySpec {
  readonly id: string;
  readonly name: string;
  readonly naifId: number;
  readonly kind: SolarBodyKind;
  readonly parent: string | null;
  /** JPL SSD table name (planets) or satellite name as it appears in the mean-elements table. */
  readonly jplName: string;
  readonly facts: readonly SolarFact[];
}

const NASA = (path: string) => `https://science.nasa.gov/${path}/`;
const f = (text: string, status: SolarFact['status'], reference: string, url?: string): SolarFact => ({ text, status, reference, ...(url ? { url } : {}) });

export const BODY_SPECS: readonly BodySpec[] = [
  { id: 'sun', name: 'Sun', naifId: 10, kind: 'star', parent: null, jplName: 'Sun', facts: [
    f('The Sun is a G-type main-sequence star (spectral type G2V). It rotates differentially: its equator turns faster than its poles, so the single rotation period given is an adopted value.', 'observed', 'NASA Science (spectral type G2 V); JPL Horizons adopted sidereal period', NASA('sun')),
    f('Its luminosity and effective temperature are the IAU 2015 nominal values; the Sun’s actual output varies slightly over the 11-year activity cycle.', 'observed', 'IAU 2015 Resolution B3; JPL Horizons', NASA('sun')),
  ] },
  { id: 'mercury', name: 'Mercury', naifId: 199, kind: 'planet', parent: 'sun', jplName: 'Mercury', facts: [
    f('Mercury has no substantial atmosphere, only a thin surface-bounded exosphere, so its surface temperature swings by hundreds of kelvin between day and night.', 'observed', 'NASA MESSENGER mission results', NASA('mercury')),
    f('Radar and MESSENGER data indicate water ice in permanently shadowed craters near the poles. The ice is inferred from reflectance, radar and neutron data rather than sampled directly.', 'inferred', 'NASA MESSENGER mission results', NASA('mercury')),
  ] },
  { id: 'venus', name: 'Venus', naifId: 299, kind: 'planet', parent: 'sun', jplName: 'Venus', facts: [
    f('Venus rotates retrograde (opposite to its orbital motion) and very slowly: a sidereal day is longer than its year.', 'observed', 'JPL Horizons rotation rate; radar observations', NASA('venus')),
    f('Its surface is permanently hidden by opaque sulfuric-acid cloud, so visible-light images show an almost featureless disc. The surface has been mapped only by radar (Magellan) and a few landers.', 'observed', 'NASA Magellan and Venera results', NASA('venus')),
  ] },
  { id: 'earth', name: 'Earth', naifId: 399, kind: 'planet', parent: 'sun', jplName: 'EM Bary', facts: [
    f('About 71% of Earth’s surface is covered by liquid-water oceans (JPL lists 3.62×10⁸ km² of sea and 1.48×10⁸ km² of land).', 'observed', 'JPL Horizons geophysical data', NASA('earth')),
    f('Earth is the only place known to host life. Its Moon raises the ocean tides.', 'observed', 'NASA Earth science', NASA('earth')),
  ] },
  { id: 'moon', name: 'Moon', naifId: 301, kind: 'moon', parent: 'earth', jplName: 'Moon', facts: [
    f('The Moon rotates synchronously, so the same hemisphere always faces Earth.', 'observed', 'JPL Horizons; LRO', NASA('moon')),
    f('The leading hypothesis is that the Moon formed from debris of a giant impact between the early Earth and a Mars-sized body. It is widely supported but not directly confirmed.', 'hypothesis', 'NASA lunar science (Apollo sample and LRO results)', NASA('moon')),
  ] },
  { id: 'mars', name: 'Mars', naifId: 499, kind: 'planet', parent: 'sun', jplName: 'Mars', facts: [
    f('Mars has a thin carbon-dioxide atmosphere and polar caps of water ice and carbon-dioxide ice.', 'observed', 'NASA Mars missions', NASA('mars')),
    f('Orbiter and rover data show that liquid water once flowed on the surface; its extent and duration are still debated.', 'inferred', 'NASA Mars Exploration Program', NASA('mars')),
  ] },
  { id: 'phobos', name: 'Phobos', naifId: 401, kind: 'moon', parent: 'mars', jplName: 'Phobos', facts: [
    f('Phobos is a small, irregular, cratered moon that orbits Mars in under eight hours, faster than Mars rotates.', 'observed', 'JPL Horizons; Mars Express and MRO imaging', NASA('mars/moons/phobos')),
    f('Tidal interaction is slowly lowering its orbit, and it is expected to break up or impact Mars in tens of millions of years. This is an inference from the measured orbital decay.', 'inferred', 'NASA Mars moons', NASA('mars/moons/phobos')),
  ] },
  { id: 'deimos', name: 'Deimos', naifId: 402, kind: 'moon', parent: 'mars', jplName: 'Deimos', facts: [
    f('Deimos is the smaller and more distant of Mars’s two moons, with a smoother surface than Phobos.', 'observed', 'NASA Mars moons', NASA('mars/moons/deimos')),
  ] },
  { id: 'jupiter', name: 'Jupiter', naifId: 599, kind: 'planet', parent: 'sun', jplName: 'Jupiter', facts: [
    f('Jupiter is a gas giant made mostly of hydrogen and helium. Its Great Red Spot is a persistent anticyclonic storm that has been observed for well over a century and has been shrinking.', 'observed', 'Hubble, Juno and Cassini observations', NASA('jupiter')),
    f('The radius quoted is the volume-mean radius; the 1-bar equatorial radius is larger because of Jupiter’s rapid rotation and flattening.', 'observed', 'JPL Horizons', NASA('jupiter')),
  ] },
  { id: 'io', name: 'Io', naifId: 501, kind: 'moon', parent: 'jupiter', jplName: 'Io', facts: [
    f('Io is the most volcanically active body known in the Solar System, with eruptions observed by Voyager, Galileo and Juno.', 'observed', 'NASA Galileo and Juno results', NASA('jupiter/moons/io')),
    f('Its volcanism is attributed to tidal heating from orbital resonance with Europa and Ganymede, a model consistent with the observed heat flow.', 'inferred', 'NASA Galileo results', NASA('jupiter/moons/io')),
  ] },
  { id: 'europa', name: 'Europa', naifId: 502, kind: 'moon', parent: 'jupiter', jplName: 'Europa', facts: [
    f('Europa has a young, fractured water-ice surface with few impact craters.', 'observed', 'Galileo imaging', NASA('jupiter/moons/europa')),
    f('Several lines of evidence, including Galileo magnetometer data showing an induced magnetic field, indicate a global liquid-water ocean beneath the ice shell. The ocean has not been observed directly, so this is a strong inference rather than a confirmed observation. NASA’s Europa Clipper mission, launched in 2024, is designed to investigate it.', 'inferred', 'NASA Galileo results; Europa Clipper mission', NASA('jupiter/moons/europa')),
    f('Whether Europa’s ocean could support life is an open question.', 'hypothesis', 'NASA Europa Clipper', NASA('jupiter/moons/europa')),
  ] },
  { id: 'ganymede', name: 'Ganymede', naifId: 503, kind: 'moon', parent: 'jupiter', jplName: 'Ganymede', facts: [
    f('Ganymede is the largest moon in the Solar System, larger than Mercury, and the only moon known to generate its own magnetic field.', 'observed', 'Galileo magnetometer and JPL Horizons radius', NASA('jupiter/moons/ganymede')),
    f('Magnetic and Hubble auroral observations indicate a subsurface salty ocean.', 'inferred', 'Galileo and Hubble results', NASA('jupiter/moons/ganymede')),
  ] },
  { id: 'callisto', name: 'Callisto', naifId: 504, kind: 'moon', parent: 'jupiter', jplName: 'Callisto', facts: [
    f('Callisto has one of the most heavily cratered, and therefore oldest, surfaces known in the Solar System.', 'observed', 'Galileo imaging', NASA('jupiter/moons/callisto')),
    f('A subsurface ocean has been proposed on the basis of magnetic measurements but is less certain than for Europa or Ganymede.', 'hypothesis', 'Galileo magnetometer results', NASA('jupiter/moons/callisto')),
  ] },
  { id: 'saturn', name: 'Saturn', naifId: 699, kind: 'planet', parent: 'sun', jplName: 'Saturn', facts: [
    f('Saturn’s mean density (about 0.69 g/cm³) is lower than that of water.', 'observed', 'JPL Horizons density', NASA('saturn')),
    f('Its rings are made mostly of water-ice particles from micrometres to metres across and are extremely thin compared with their width.', 'observed', 'Cassini mission results', NASA('saturn')),
  ] },
  { id: 'mimas', name: 'Mimas', naifId: 601, kind: 'moon', parent: 'saturn', jplName: 'Mimas', facts: [
    f('Mimas is dominated by the large impact crater Herschel.', 'observed', 'Cassini imaging', NASA('saturn/moons/mimas')),
  ] },
  { id: 'enceladus', name: 'Enceladus', naifId: 602, kind: 'moon', parent: 'saturn', jplName: 'Enceladus', facts: [
    f('Cassini observed plumes of water vapour and ice grains erupting from fractures near Enceladus’s south pole, and sampled their composition.', 'observed', 'Cassini mission results', NASA('saturn/moons/enceladus')),
    f('Gravity and libration measurements indicate a global subsurface liquid-water ocean beneath the ice shell.', 'inferred', 'Cassini mission results', NASA('saturn/moons/enceladus')),
  ] },
  { id: 'tethys', name: 'Tethys', naifId: 603, kind: 'moon', parent: 'saturn', jplName: 'Tethys', facts: [] },
  { id: 'dione', name: 'Dione', naifId: 604, kind: 'moon', parent: 'saturn', jplName: 'Dione', facts: [] },
  { id: 'rhea', name: 'Rhea', naifId: 605, kind: 'moon', parent: 'saturn', jplName: 'Rhea', facts: [] },
  { id: 'titan', name: 'Titan', naifId: 606, kind: 'moon', parent: 'saturn', jplName: 'Titan', facts: [
    f('Titan is the only moon known with a dense atmosphere; the Huygens probe measured a surface pressure of about 1.5 bar.', 'observed', 'Cassini-Huygens results', NASA('saturn/moons/titan')),
    f('Cassini radar observed lakes and seas of liquid methane and ethane near the poles.', 'observed', 'Cassini radar', NASA('saturn/moons/titan')),
    f('Tidal-deformation measurements suggest a subsurface ocean.', 'inferred', 'Cassini gravity measurements', NASA('saturn/moons/titan')),
  ] },
  { id: 'iapetus', name: 'Iapetus', naifId: 608, kind: 'moon', parent: 'saturn', jplName: 'Iapetus', facts: [] },
  { id: 'uranus', name: 'Uranus', naifId: 799, kind: 'planet', parent: 'sun', jplName: 'Uranus', facts: [
    f('Uranus’s rotation axis is tilted about 98 degrees to its orbital plane, so it effectively rolls around the Sun on its side. The tilt is the obliquity listed by JPL.', 'observed', 'JPL Horizons obliquity', NASA('uranus')),
    f('Only one spacecraft, Voyager 2 in 1986, has visited Uranus; its disc appears nearly featureless and pale cyan in visible light.', 'observed', 'NASA Voyager 2', NASA('uranus')),
  ] },
  { id: 'ariel', name: 'Ariel', naifId: 701, kind: 'moon', parent: 'uranus', jplName: 'Ariel', facts: [] },
  { id: 'umbriel', name: 'Umbriel', naifId: 702, kind: 'moon', parent: 'uranus', jplName: 'Umbriel', facts: [] },
  { id: 'titania', name: 'Titania', naifId: 703, kind: 'moon', parent: 'uranus', jplName: 'Titania', facts: [] },
  { id: 'oberon', name: 'Oberon', naifId: 704, kind: 'moon', parent: 'uranus', jplName: 'Oberon', facts: [] },
  { id: 'miranda', name: 'Miranda', naifId: 705, kind: 'moon', parent: 'uranus', jplName: 'Miranda', facts: [] },
  { id: 'neptune', name: 'Neptune', naifId: 899, kind: 'planet', parent: 'sun', jplName: 'Neptune', facts: [
    f('Voyager 2 measured winds on Neptune exceeding 1,000 km/h, among the fastest in the Solar System.', 'observed', 'NASA Voyager 2', NASA('neptune')),
    f('Like Uranus, Neptune has been visited only by Voyager 2 (1989), and no global surface map exists.', 'observed', 'NASA Voyager 2', NASA('neptune')),
  ] },
  { id: 'triton', name: 'Triton', naifId: 801, kind: 'moon', parent: 'neptune', jplName: 'Triton', facts: [
    f('Triton orbits Neptune retrograde (its orbital inclination, as listed by JPL, is above 90 degrees).', 'observed', 'JPL Horizons orbital data', NASA('neptune/moons/triton')),
    f('Triton is thought to be a captured Kuiper-belt object because of that retrograde orbit. This is the leading hypothesis, not a confirmed fact.', 'hypothesis', 'NASA Triton', NASA('neptune/moons/triton')),
    f('Voyager 2 imaged dark plumes rising from Triton’s surface, evidence of current geysers.', 'observed', 'NASA Voyager 2', NASA('neptune/moons/triton')),
  ] },
];

/** Satellites of each planet that Atlas models. */
export const MOON_CENTRES: Readonly<Record<string, string>> = {
  moon: '@399', phobos: '@499', deimos: '@499', io: '@599', europa: '@599', ganymede: '@599', callisto: '@599',
  mimas: '@699', enceladus: '@699', tethys: '@699', dione: '@699', rhea: '@699', titan: '@699', iapetus: '@699',
  ariel: '@799', umbriel: '@799', titania: '@799', oberon: '@799', miranda: '@799', triton: '@899',
};

export const bodySpec = (id: string): BodySpec => {
  const s = BODY_SPECS.find((b) => b.id === id);
  if (!s) throw new Error(`Unknown body "${id}"`);
  return s;
};
