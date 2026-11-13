# Atlas of the Universe

A scientifically grounded atlas built on real data: the Gaia DR3 star field with SIMBAD identifications; an interactive Solar System (Sun, 8 planets, 20 moons) from JPL Horizons, JPL SSD and NAIF, with real NASA/USGS planetary maps where they exist and every artistic texture labelled as such; and deep space: a documented Milky Way model, 10 galaxies, 8 nebulae and 6 star clusters drawn from 36 real archive images and real Gaia members, the Local Group, the M81 group, the Virgo Cluster and the 2MASS Redshift Survey galaxy distribution. Each deep-space object states what its picture is (measured, an image placed on the sky, or illustrative depth) and every image carries its archive id, credit and licence. A discovery engine searches and relates what the atlas holds: 90,950 objects from Gaia DR3, a Hipparcos supplement for the stars Gaia cannot show (Sirius, Betelgeuse, Vega ...), the NASA Exoplanet Archive (6,470 planets, 4,862 hosts), the Solar System, deep space and six other objects. It offers search by name or designation with typo handling, filters that say how many records lack a value, nearby objects, discovery lists that state their criterion and scope, typed relationships (physical, structural, association), 69 source-backed explanations, a Back and Forward history, and bookmarks and collections stored in the browser. It only knows the datasets it holds and says so. See `docs/` for the architecture, methodology, provenance, validation and quality reports; start with `docs/DISCOVERY_ENGINE.md`, `docs/DEEP_SPACE.md`, `docs/SOLAR_SYSTEM.md` and `docs/SCIENTIFIC_DATA.md`.

```bash
npm ci
npm run dev                 # development server
npm run verify              # typecheck + tests + production build
npm run build && npx vite preview --port 4173   # serve the production build
npm run data:rebuild        # rebuild the datasets from the local cache (offline, exact)
npm run data:import         # re-download from Gaia and SIMBAD (network)
npm run data:solar:offline  # rebuild the Solar System dataset from the local cache (offline, exact)
npm run data:solar          # re-fetch from JPL and NAIF and re-validate against Horizons (network)
npm run qa:browser          # real-browser checks (stars); needs a preview server and Playwright
npm run qa:solar            # real-browser checks (Solar System)
npm run qa:deepspace        # real-browser checks (deep space); same preview server and Playwright
npm run perf:deepspace      # deep-space measurements into docs/qa/deepspace/perf.json (software GL only); same prerequisites
npm run data:objects            # deep-space named objects: fetch (cached) and rebuild public/data/deep-space.v1.json
npm run data:objects:offline    # rebuild them exactly from data/cache/deepspace/objects
npm run data:deepspace:catalogues          # the nine deep-space point catalogues (VizieR, Zenodo)
npm run data:deepspace:catalogues:offline  # rebuild them exactly from the local cache
npm run deepspace:images         # download (cached) and process the 36 archive images, write provenance
npm run deepspace:images:report  # regenerate docs/DEEP_SPACE_IMAGE_PROVENANCE.md only
npm run credits:build            # regenerate public/credits.html from the image provenance
npm run data:stars:offline       # Hipparcos bright-star supplement, exact rebuild from data/cache/discovery/stars
npm run data:stars               # re-fetch (cached) and rebuild it (network)
npm run data:exoplanets:offline  # NASA Exoplanet Archive composite table, exact rebuild from the cache
npm run data:exoplanets          # re-fetch (cached) and rebuild it (network); add -- --refresh to ignore the cache
npm run data:other:offline       # the six other objects, exact rebuild (npm run data:other for the network)
npm run discovery:notes          # merge the authored explanations and relations into public/data
npm run bench:spatial            # KD-tree vs grid vs brute-force benchmark, 500,000 synthetic points (about 70 s)
npm run qa:discovery-api         # real-browser checks of the discovery engine; same preview server and Playwright
npm run qa:discovery-ui          # real-browser checks of the discovery interface; same prerequisites
```

Controls: drag to orbit, right-drag or Shift-drag to pan, wheel to zoom, click a star to inspect it, `+`/`-` zoom, arrows rotate, `R` reset orientation, `H` return to the star-field home view, `Esc` deselect. Solar System: click a body or a button to select and fly to it, `O` overview, `Backspace` parent (moon to planet, planet to overview), `Space` pause or resume time, `[` `]` slower or faster, `\` reverse. Scale: `M` Milky Way, `L` Local Group, `U` nearby universe (flies to 100 Mpc), `H` back to the star field. Deep space: click an object or pick it from the panel to fly to it and open its inspector; band buttons switch the image (non-visible bands are marked); the layer toggles show or hide galaxies, nebulae, clusters and structure. Discovery: `/` focuses the search box (arrows move through results, `Enter` selects and flies, `Shift+Enter` inspects without flying, `Esc` clears), `D` opens or closes the Discover drawer (Featured, Filter, Nearby, Saved), `Alt+Left` and `Alt+Right` go back and forward through the objects you visited, `Backspace` goes to the parent (moon to planet, planet to its host star where the data say so). The inspector has Bookmark, Find nearby and Go to parent, a Relationships block and an Explanation block.

Data: ESA Gaia DR3 (ESA/Gaia/DPAC), SIMBAD and VizieR (CDS, Strasbourg), JPL Horizons and SSD (NASA/JPL-Caltech), NAIF, NASA, USGS Astrogeology, Solar System Scope (CC BY 4.0), McConnachie 2012, Karachentsev et al. 2013 (UNGC), Huchra et al. 2012 (2MRS), Hipparcos (ESA 1997; van Leeuwen 2007; VizieR I/239 and I/311), IAU Working Group on Star Names, the NASA Exoplanet Archive ("This research has made use of the NASA Exoplanet Archive, which is operated by the California Institute of Technology, under contract with the National Aeronautics and Space Administration under the Exoplanet Exploration Program."), Hunt & Reffert 2023, Vasiliev & Baumgardt 2021, HyperLEDA, NED-D. Deep-space images: ESA/Hubble, ESA/Webb and ESO (CC BY 4.0), NASA GALEX data via SkyView (stated public domain), Legacy Surveys / D. Lang (Perimeter Institute) (CC BY 4.0). Every image's credit line is in the image-credits control on the page, `public/credits.html` and `docs/DEEP_SPACE_IMAGE_PROVENANCE.md`.

Licence note: this is a prototype and has not been cleared for public release. The Gaia statements disagree (open with credit; CC BY-NC 3.0 IGO; CC BY-SA 3.0 IGO), so Gaia-derived data may carry a non-commercial condition (the two Gaia-derived images were withdrawn, so the SMC has no image); the NED-D file is marked "All Rights Reserved" (only individual distances are used, with attribution). The Hipparcos data (VizieR I/239) is marked CC-BY-NC-3.0 IGO, so the supplement is non-commercial as far as we can tell, and the NASA Exoplanet Archive requires its acknowledgement, which the application does not yet display. See `docs/SCIENTIFIC_DATA.md` sections 13.2 and 14.

Limits: all rendering was tested on software GL only, in Chromium (1,265 unit tests in 52 files, 1 skipped; browser checks in `docs/qa/`); no GPU, other-browser, real-phone or WebXR verification (WebXR is not built), no screen-reader run, no accounts or sync (saved bookmarks stay in one browser); the discovery lists rank only the records held and are not a census of the sky; there is no variable-star list; context loss was only simulated, no KTX2 texture compression. Distances to galaxies from redshift use H0 = 70 km/s/Mpc, an application choice; the 2MRS sample reaches 741 Mpc but the camera stops at 600 Mpc. No filaments, voids or cosmic web are drawn.
