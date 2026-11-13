# Discovery notes: sources for Solar System and deep-space objects

Authoring source: `tools/discovery/notes/solar-deep.json` (DiscoveryNote[], `src/discovery/types.ts`). Validator: `node tools/discovery/notes/validate_notes.mjs`. Retrieval date for every reference: 2026-11-13.

## Method and limits

- Each claim was written from a page or abstract fetched in the authoring session (NASA Science, ESA, ESO, arXiv abstracts). The fetch tool returned model-summarised quotations, not raw HTML, so claims paraphrase those quotations and were not re-checked against the full page text.
- Wikipedia is not cited. SIMBAD, NED and HyperLEDA pages were not re-fetched for this task; the atlas-side values (distances, radii) come from the atlas data files and are only compared, never used as a source for a claim, except where a claim says 'atlas'.
- Status values: observed = measured; inferred = follows from measurements plus modelling; hypothesis = proposed or unconfirmed, also used for 'open question' statements in the uncertain section; historical = who/when.
- Superlatives (largest, most heavily cratered, closest large star-forming region) appear only with attribution to the fetched source ('NASA calls...').

## Numbers that differ between a source and the atlas (stated in the notes)

- Orion Nebula: NASA 1,500 ly (about 460 pc) vs atlas 418.5 pc. Eagle Nebula: NASA 7,000 ly (about 2.1 kpc) vs atlas 1.69 kpc. Ring Nebula: NASA 2,000 ly vs atlas 782.5 pc. Horsehead: ESA 1,300 ly vs atlas 431 pc. Veil: NASA 1,500 ly vs Fesen et al. 725 pc (atlas). LMC: NASA 52,000 pc vs 49.59 kpc. M104: NASA 28 Mly vs 9.55 Mpc. M4: NASA 5,500 ly vs atlas 1.85 kpc.
- M104 classification: NASA calls it a spiral, McQuinn et al. an elliptical. Titan surface pressure: NASA about 60% above Earth's vs atlas fact about 1.5 bar. Sun width: NASA 'about 100 times' Earth vs atlas radius ratio about 109.

## Not covered

- No source was fetched for: Deimos and the other moons (not requested); Mercury's partly molten core; Venus surface streaks; Perseverance (NASA page 404); Juno's Europa ice-shell result (page 404). Those statements were not written.
- The oneLine of each note is supported by a claim in its sections (checked by hand, not by the validator).

## References used

- Baumgardt et al.: Galactic Globular Cluster Database v4: https://people.smp.uq.edu.au/HolgerBaumgardt/globular/
- Bland-Hawthorn & Gerhard 2016, arXiv:1602.07702: https://arxiv.org/abs/1602.07702
- Breuval et al. 2023, arXiv:2304.00037: https://arxiv.org/abs/2304.00037
- Dalcanton et al. 2012 (PHAT), arXiv:1204.0010: https://arxiv.org/abs/1204.0010
- EHT Collaboration 2019, arXiv:1906.11238: https://arxiv.org/abs/1906.11238
- ESA/Hubble: Horsehead Nebula in infrared (heic1307a): https://esahubble.org/images/heic1307a/
- ESA: Gaia: https://www.esa.int/Science_Exploration/Space_Science/Gaia
- ESO: Radio galaxy Centaurus A (eso0005b): https://www.eso.org/public/images/eso0005b/
- ESO: The Pleiades (b11): https://www.eso.org/public/images/b11/
- Fesen et al. 2021, arXiv:2109.05368: https://arxiv.org/abs/2109.05368
- GRAVITY Collaboration 2019, arXiv:1904.05721: https://arxiv.org/abs/1904.05721
- Garcia-Diaz et al. 2008, arXiv:0802.0518: https://arxiv.org/abs/0802.0518
- Graczyk et al. 2020, arXiv:2010.08754: https://arxiv.org/abs/2010.08754
- Harris, Rejkuba & Harris 2009, arXiv:0911.3180: https://arxiv.org/abs/0911.3180
- Hill et al. 2012, arXiv:1204.6317: https://arxiv.org/abs/1204.6317
- Hunt & Reffert 2023, arXiv:2303.13424: https://arxiv.org/abs/2303.13424
- Karachentsev 2004, arXiv:astro-ph/0410065: https://arxiv.org/abs/astro-ph/0410065
- Karachentsev, Makarov & Kaisina 2013, arXiv:1303.5328: https://arxiv.org/abs/1303.5328
- Kormendy & Bender 2019, arXiv:1810.10073: https://arxiv.org/abs/1810.10073
- Li et al. 2021, arXiv:2107.08029: https://arxiv.org/abs/2107.08029
- Lin et al. 2023, arXiv:2306.01617: https://arxiv.org/abs/2306.01617
- McConnachie 2012, arXiv:1204.1562: https://arxiv.org/abs/1204.1562
- McQuinn et al. 2016, arXiv:1610.03857: https://arxiv.org/abs/1610.03857
- Mei et al. 2007, arXiv:astro-ph/0702510: https://arxiv.org/abs/astro-ph/0702510
- Meingast & Alves 2018, arXiv:1811.04931: https://arxiv.org/abs/1811.04931
- NASA Hubble Messier 1: https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-1/
- NASA Hubble Messier 104: https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-104/
- NASA Hubble Messier 13: https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-13/
- NASA Hubble Messier 16: https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-16/
- NASA Hubble Messier 31: https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-31/
- NASA Hubble Messier 32: https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-32/
- NASA Hubble Messier 33: https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-33/
- NASA Hubble Messier 4: https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-4/
- NASA Hubble Messier 42: https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-42/
- NASA Hubble Messier 57: https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-57/
- NASA Hubble Messier 81: https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-81/
- NASA Hubble Messier 87: https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-87/
- NASA Hubble: Tarantula Nebula in the Large Magellanic Cloud: https://science.nasa.gov/asset/hubble/the-tarantula-nebula-in-the-large-magellanic-cloud/
- NASA Hubble: The Horsehead Nebula: https://science.nasa.gov/asset/hubble/the-horsehead-nebula/
- NASA Science: Callisto: https://science.nasa.gov/jupiter/moons/callisto/
- NASA Science: Cassini: https://science.nasa.gov/mission/cassini/
- NASA Science: Earth Facts: https://science.nasa.gov/earth/facts/
- NASA Science: Enceladus: https://science.nasa.gov/saturn/moons/enceladus/
- NASA Science: Europa: https://science.nasa.gov/jupiter/moons/europa/
- NASA Science: Europa Clipper: https://science.nasa.gov/mission/europa-clipper/
- NASA Science: Galileo: https://science.nasa.gov/mission/galileo/
- NASA Science: Ganymede: https://science.nasa.gov/jupiter/moons/ganymede/
- NASA Science: Hubble finds strong evidence for intermediate-mass black hole in Omega Centauri: https://science.nasa.gov/missions/hubble/nasas-hubble-finds-strong-evidence-for-intermediate-mass-black-hole-in-omega-centauri/
- NASA Science: Hubble shows Milky Way destined for head-on collision with Andromeda (2012): https://science.nasa.gov/missions/hubble/nasas-hubble-shows-milky-way-is-destined-for-head-on-collision-with-andromeda-galaxy/
- NASA Science: Io: https://science.nasa.gov/jupiter/moons/io/
- NASA Science: Juno: https://science.nasa.gov/mission/juno/
- NASA Science: Jupiter Facts: https://science.nasa.gov/jupiter/facts/
- NASA Science: Lunar Reconnaissance Orbiter: https://science.nasa.gov/mission/lro/
- NASA Science: MESSENGER: https://science.nasa.gov/mission/messenger/
- NASA Science: Magellan: https://science.nasa.gov/mission/magellan/
- NASA Science: Mars Facts: https://science.nasa.gov/mars/facts/
- NASA Science: Mercury Facts: https://science.nasa.gov/mercury/facts/
- NASA Science: Moon Facts: https://science.nasa.gov/moon/facts/
- NASA Science: Neptune Facts: https://science.nasa.gov/neptune/facts/
- NASA Science: Parker Solar Probe: https://science.nasa.gov/mission/parker-solar-probe/
- NASA Science: Phobos: https://science.nasa.gov/mars/moons/phobos/
- NASA Science: Saturn Facts: https://science.nasa.gov/saturn/facts/
- NASA Science: Sun Facts: https://science.nasa.gov/sun/facts/
- NASA Science: Titan: https://science.nasa.gov/saturn/moons/titan/
- NASA Science: Titan Facts: https://science.nasa.gov/saturn/moons/titan/facts/
- NASA Science: Triton: https://science.nasa.gov/neptune/moons/triton/
- NASA Science: Uncovering the Veil Nebula: https://science.nasa.gov/missions/hubble/uncovering-the-veil-nebula/
- NASA Science: Uranus Facts: https://science.nasa.gov/uranus/facts/
- NASA Science: Venus Facts: https://science.nasa.gov/venus/facts/
- NASA Science: Voyager 2: https://science.nasa.gov/mission/voyager-2/
- O'Dell et al. 2009, arXiv:0901.3185: https://arxiv.org/abs/0901.3185
- Pietrzynski et al. 2019, arXiv:1903.08096: https://arxiv.org/abs/1903.08096
- Rivera-Sandoval et al. 2015, arXiv:1508.05291: https://arxiv.org/abs/1508.05291
- Shull, Darling & Danforth 2021, arXiv:2103.07922: https://arxiv.org/abs/2103.07922
- Stanke et al. 2010, arXiv:1005.2202: https://arxiv.org/abs/1005.2202
