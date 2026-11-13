# Project Status (as of 2026-11-13)

## Built and verified
- **Gaia DR3 pipeline.** Live query of the Gaia archive (35,325 sources), documented selection, validation, quality and provenance reports, reproducible offline rebuild.
- **SIMBAD cross-identification.** 31,663 of 35,325 sources identified by exact identifier (89.6%), via the official CfA mirror because the primary host was unreachable.
- **Astrometry core** (`src/core/astro/`): equatorial, Cartesian and Galactic transforms, parallax-to-distance with reliability classes, photometry, proper-motion propagation.
- **Extended scientific schema:** every measurement carries a category (observed/derived/modelled/hypothetical), unit, uncertainty, source, release, record id, retrieval date, epoch and transformation; facts are labelled observed/inferred/hypothesis; imagery carries a fidelity class.
- **Star-field renderer:** 34,890 real stars, one draw call, magnitude-based brightness, BP-RP colour, floating-origin camera.
- **The Solar System (Prompt 05):** Sun, 8 planets and 20 satellites from a JPL/NAIF dataset (`public/data/solar-system.v1.json`); Keplerian orbital mechanics with a documented epoch (JD 2461356.500801 TDB) and measured error against JPL Horizons (216 comparisons, `docs/SOLAR_SYSTEM_VALIDATION.md`); IAU rotation; per-body shaders with true sun direction, analytic shadows, ring shadows, atmospheres, Earth night side, clouds and specular; a physical versus display scale policy with an explicit "NOT to scale" notice; a time controller independent of the system clock; navigation through the frame hierarchy (Milky Way > neighbourhood > Solar System > planet system) with smooth flights and a breadcrumb; an extended inspector with certainty labelling.
- **Textures:** real NASA/USGS maps where they exist, labelled artistic ones where they do not, nothing where neither is available (`docs/TEXTURE_PROVENANCE.md`).
- **Verification (Prompt 05 state):** typecheck, 302 tests in 11 files, production build; real-browser checks of the stars and the Solar System (`npm run qa:solar`, screenshots in `docs/qa/solar/`). Those 11 files and 302 tests are still in the suite; the total including deep space is in the Prompt 06 section.

## What the tests cover versus what the browser run covered
- Automated tests: coordinate and element conversion, Kepler solving, positions against stored Horizons vectors, epoch and time arithmetic, frame hierarchy, display scale policy, dataset validation and provenance, texture manifest, inspector content, plus everything from the star pipeline.
- Real browser (Chromium, software GL): the page loads from local files; stars and bodies render; real mouse clicks select; flights pass through the hierarchy; time controls move bodies by the expected amounts; the scale notice appears; screenshots of several planetary environments were inspected.
- Not verified: GPU performance (software rendering is 3 to 8 frames/s, which says nothing about real hardware), other browsers, mobile, accessibility audit.

## Not built
- Navigation to the observable universe and cosmological distances (the Local Group and nearby universe now exist, see Prompt 06).
- Pluto, dwarf planets, asteroids, comets, spacecraft; moons beyond the 20 included.
- WebXR.
- High-precision ephemerides (DE kernels), light-time, eclipses as computed events.
- Extinction. (Hipparcos and the NASA Exoplanet Archive were added by Prompt 07, see the last section.)

## Findings that shaped the build
Stars: missing G magnitude is not invalid; no Gaia source brighter than G = 1.5; contaminated faint high-parallax sources are flagged, not deleted; visible density is a selection effect; a positional-duplicate search failed near the poles and was rebuilt.
Solar System: the Keplerian approximations drift for moons, so satellite elements are osculating at the reference epoch with a fitted mean-longitude rate (error at most about 4% of orbit radius over one year); JPL prints no mass for some small moons, so one is derived from GM and flagged; the Sun is not in SIMBAD; bodies without a published radius are shown only as markers; a straight Jupiter terminator is correct quarter-phase physics, not a bug.

## Open issues
- SIMBAD data came from the mirror; the primary host was down on the retrieval date.
- No GPU measurements.
- Some bodies use artistic or no textures (listed in `docs/TEXTURE_PROVENANCE.md`).
- Jupiter's map longitude convention is not yet confirmed against its official caption.
- Gaia, USGS and NASA redistribution terms to be confirmed before a public release.
- Nothing from Prompts 04 to 06 is committed; only the foundation commit is pushed.

# Prompt 06: deep space (as of 2026-11-13)
Full description: `docs/DEEP_SPACE.md`. Data and licences: `docs/SCIENTIFIC_DATA.md` section 13.

## Built
- **Data.** 27 curated objects with sourced measurements (`public/data/deep-space.v1.json`: 10 galaxies, 8 nebulae, 6 star clusters, 3 groups, and a documented Milky Way model with every parameter cited); nine point catalogues (McConnachie 2012: 101 rows, UNGC: 869, 2MRS: 43,533, Gaia-based members of the Pleiades, Hyades and four globular clusters); 36 real archive images (130 WebP files in 3 or 4 levels, 41.7 MB) with verbatim credit lines and licence evidence (`public/deepspace/provenance.json`, `docs/DEEP_SPACE_IMAGE_PROVENANCE.md`, `public/credits.html`).
- **Core.** Universe frame tree (Universe > Nearby universe > Local Group > Milky Way > neighbourhood) with the breadcrumb, physical size and redshift-distance maths with uncertainty propagation, disc deprojection, morphology classification, level-of-detail policy with hysteresis and cross-fade, texture-level choice, byte-budget LRU cache (192 MiB), screen-space picking, a frame-time quality governor.
- **Renderers.** Milky Way model, galaxy images (deprojected or flat), nebulae as illustrative multi-layer projections of real images, star clusters from real members, Local Group / M81 group / Virgo markers, the 2MRS galaxy distribution with its selection effects stated on screen.
- **Interface.** Keys `M`, `L`, `U`; a deep-space panel with scale shortcuts, object lists, layer toggles, band buttons, a legend of what the drawings are, and an always-visible image credit line; inspector with a representation badge, provenance and "unavailable" reasons; search by designation; catalogue-point inspector.

## Verified
- `npm run verify` is clean (measured 2026-11-13): typecheck, **29 test files with 661 tests, all passing** (18 `deepspace-*` files with 359 tests, plus the 11 earlier files with 302), and the production build.
- Real-browser QA on software GL (`npm run qa:deepspace`): 129 of 129 checks pass in the last recorded run (`docs/qa/deepspace/qa-log.json`, 2026-11-12T23:11Z; 23 screenshots in the folder); `npm run qa:browser` (stars, 26 checks) and `npm run qa:solar` (43 checks; its frame-rate floor is flaky when the machine is loaded) passed during the review fixes on 2026-11-12 and were not re-run for this documentation update.
- Measured on software GL only (governor disabled): in the QA run peak texture memory 51.1 MiB against the 192 MiB budget, 11.7 fps, 1658 ms to a ready UI; in the performance run (`npm run perf:deepspace`, `docs/qa/deepspace/perf.json`) 8 scenes from 0.8 to 13.6 fps, at most 8 draw calls, a 27-object disposal loop peaking at 61.1 MiB of textures with no growth across loops. Nothing here is a GPU figure.

## Not verified
- Any GPU. Frame times, memory and fill rate on real hardware are unknown.
- Browsers other than Chromium; mobile devices and touch; small screens; WebXR (not built).
- Accessibility beyond text labels and non-colour cues.
- The quality governor in a browser on real hardware (the QA run disables it for repeatable frames).
- A near-edge-on view of nebulae looks flat by design; this is stated on screen but was not evaluated with users.

## Findings that shaped the build
- A flat image is not a 3D object. The four galaxies with published inclination are tilted onto their disc plane (stretch 1/cos i); the others stay flat. The tilt direction is a choice because no source gave the near side.
- M31's PHAT mosaic covers a third of the galaxy, so the default band became the GALEX near-UV map (the first image covering at least half of the catalogue diameter); this is shown as non-visible.
- A nebula image split by brightness into 3 to 5 additive sheets sums back to the original, so layers cost no brightness at the Sun and give parallax elsewhere; thickness is assumed.
- Globular-cluster parallaxes cannot place stars in depth; depth is a seeded Plummer-like draw, labelled `illustrative` in the data, the file caveats and the inspector.
- The Pleiades member list lacks Alcyone and Merope (poor or missing Gaia astrometry for the brightest stars).
- 2MRS distance is cz/H0 with H0 = 70, an application choice. Rows below 1000 km/s are not placed; Virgo members (203, cut -500 to 2500 km/s within 6 deg of M87, which includes M86, M90 and M98) are drawn at the cluster-mean distance up close and cross-fade to Hubble-flow positions far away. The sample reaches 741 Mpc (median 121 Mpc, 3 galaxies beyond 600 Mpc), more than the 600 Mpc camera limit.
- float64 limits: at 10 Mpc the resolution is about 7e7 m, so round trips through the nearby-universe frame cannot be exact; local geometry stays in the deepest frame.
- Reflection nebula: NGC 1999 (the only candidate with a verifiable ESA/Hubble image with full metadata).
- Orion, Horsehead, Eagle and NGC 1999 distances are modelled dust-cloud distances (Zucker et al. 2020), the median over every sightline within 1 deg with the spread in the uncertainty; earlier they were one chosen sightline labelled observed.
- Review fixes (2026-11-12): Milky Way morphology is shown as a literature range, not a catalogue string; nebula text says depth layers are drawn; the non-visible-light warning is computed per filter; Virgo rows have their own ids (`virgo:<row>`); Backspace goes through `DeepUi`; backdrop discs lose picks to real objects; invisible galaxies are not pickable; WebGL context loss and restore are handled; decoded bitmaps no longer leak.
- SIMBAD, VizieR and the Strasbourg hosts were partly unreachable; the CfA mirrors served the data.

## Open issues
- No GPU measurements; context loss and restore were only simulated; the Solar System `TextureManager` has no context-loss handling and was not audited.
- KTX2 / texture compression is not implemented.
- The Orion approach-sweep dip seen in an earlier run is gone in the last run; it was never diagnosed. Brightness steps at hand-offs reach 48 percent against a 50 percent limit.
- Missing or weak imagery: SMC (no image since the Gaia density maps were withdrawn), M32 (GALEX only), M87 (17 arcmin cutout and GALEX), M31 opens on an ultraviolet map, no images for the Pleiades, Hyades, Omega Cen, M13, M4 or the groups.
- The 2MRS sample (741 Mpc) is deeper than the camera range (600 Mpc); "Fly to this entry" does nothing on Virgo and 2MRS rows.
- Near side of the disc galaxies unknown; the Local Group frame is an anchor, not a barycentre.
- No texture compression, mobile tier, WebXR, discovery engine, cosmic-web overlay or DESI/SDSS data.

## Licence flags (check before a public release)
- Gaia: the documentation says "open and free to use with credit ESA/Gaia/DPAC", the Gaia Users page says CC BY-NC 3.0 IGO, and the cluster-member manifests record CC BY-SA 3.0 IGO. The two Gaia density maps derived from DR3 were withdrawn on 2026-11-12 (the SMC now has no image); the 35,325-star subset and the cluster member lists remain Gaia-derived with the question open.
- NED-D file header: "Copyright (C) 2012-2020 California Institute of Technology - All Rights Reserved". Only individual distances are stored with attribution.
- Vasiliev & Baumgardt member lists: Zenodo CC BY 4.0. VizieR tables: free to use with acknowledgement.
- Legacy Surveys: CC BY 4.0, credit "Legacy Surveys / D. Lang (Perimeter Institute)" must be shown unaltered.
- ESA/Hubble, ESA/Webb and ESO images: CC BY 4.0 with credit. Seven of them (47 Tuc VISTA, Cen A multiband and WFI, M31 PHAT, M33 VST, M81 ACS, M104 ACS) were re-checked against their own image pages on 2026-11-12: no non-commercial or third-party notice found; Cen A multiband, whose credit names third parties, is the weakest case. The "unless specifically noted" clause means this can change. GALEX via SkyView: stated public domain (the sentence was not re-read); Legacy Surveys: CC BY 4.0 acknowledgment page re-read.
- HyperLEDA and the Baumgardt table: no terms found on the pages used; values quoted with attribution.

# Prompt 07: discovery engine (as of 2026-11-13)
Full description: `docs/DISCOVERY_ENGINE.md`. Runtime: `docs/DISCOVERY_ENGINE_RUNTIME.md`. Data: `docs/DISCOVERY_DATA_STARS.md`, `docs/DISCOVERY_DATA_EXOPLANETS.md`, `docs/SCIENTIFIC_DATA.md` section 14. Sources of every explanation: `docs/DISCOVERY_NOTES_SOURCES_SOLAR_DEEP.md`, `docs/DISCOVERY_NOTES_SOURCES_STARS_EXO.md`.

## Built
- **Data.** Hipparcos bright-star supplement (8,942 stars, 312 with no Gaia record: Sirius, Betelgeuse, Vega, Polaris, Rigel, Arcturus ...); NASA Exoplanet Archive composite table (6,470 planets, 4,862 hosts); six curated other objects (Sagittarius A*, Cygnus X-1, Crab Pulsar, SN 1987A, Eta Carinae, Vela Pulsar); 69 source-backed explanations (405 claims, 140 reference URLs); 5 curated relations. All rebuild offline from `data/cache/discovery/` (`npm run data:stars:offline`, `data:exoplanets:offline`, `data:other:offline`, `discovery:notes`).
- **Engine** (`src/discovery`, 25 files, pure of DOM and Three.js): universal ids and merge into one record per object (90,950 records from 100,164 adapter records); identifier normalisation (20 rule groups, 18 must-not-conflate pairs); search with prefix, token, substring and flagged typo matching; filters with missing-value counts; frame-aware nearby and visible queries on a KD-tree; typed relations by basis; ten discovery lists; saved bookmarks, collections and history with versioned local storage; camera history with snapshots. Runs in a Web Worker in three stages with time-sliced indexing.
- **Rendering.** Hipparcos supplement as a star-pass layer (457 stars drawn that Gaia does not draw), exoplanet-host markers (4,834 drawable, off by default), highlight rings, selection proxy.
- **Interface** (`src/ui/discovery`, `index.html`): search box, Discover drawer with Featured, Filter, Nearby and Saved tabs, navigation line with Back, Forward and Return to previous view, inspector additions (bookmark, collections, find nearby, parent, relationships, explanation). Keys `/`, `D`, `Alt+Left`, `Alt+Right`.

## Verified
- `npx tsc --noEmit`: no errors (2026-11-13).
- `npx vitest run` (2026-11-13): 52 files, 1,265 tests, 1,264 passed, 1 skipped. In the first full run on a machine with a load average of about 12 one test in `tests/discovery-records.test.ts` timed out at the 5 s default; the file passes alone (70 of 70). The 23 `tests/discovery-*.test.ts` files hold 604 tests (603 passed, 1 skipped).
- Real-browser QA on software GL, logs in `docs/qa/discovery/`: `qa-api-log.json` (run 2026-11-13T12:37Z): 64 of 65 checks pass; `ui-qa-log.json` (run 2026-11-13T12:10Z): 136 of 136 checks pass, 33 screenshots (four viewport sizes, keyboard-only, storage blocked). Page thread: 0 long tasks during indexing in the last API run; search ready 4.2 s, queries ready 9.1 s, complete 12.1 s after engine start; search probe median 27 ms. Software GL, shared machine; not GPU figures. Re-run before relying on these logs: see `docs/qa/discovery/*-log.json`.
- Offline rebuild of the exoplanet file is byte-identical (sha256 c2ccabae...de0ac, checked 2026-11-13). `npm run data:stars:offline` ran and rewrote the supplement with the same file size.
- Spatial benchmark (500,000 synthetic points, `npm run bench:spatial`): KD-tree radius and k-nearest queries 0.007 to 0.5 ms against 3 to 8 ms for brute force.

## Not verified
- Any GPU; browsers other than Chromium; real mobile devices and touch (a 390 px viewport was emulated); screen readers (no NVDA, JAWS or VoiceOver run); WebXR (not built).
- The existing `qa:browser`, `qa:solar` and `qa:deepspace` suites were not re-run for this documentation update. When the engine author last ran them, `qa:deepspace` gave 128 of 129 and `qa:browser` 25 of 26 because the highlight marker renderer drew one draw call with nothing highlighted; whether that was fixed since is not recorded here (`qa:solar` 43 of 43).
- The explanations were not independently re-verified against full page texts.
- The interface QA belongs to a part of the work that was still being finished when this section was written.

## Open issues
- One failing check in the last API QA run: clicking an exoplanet-host halo picks `host:Gl 686` but does not select it through the atlas (`docs/qa/discovery/qa-api-log.json`).
- No credit for the NASA Exoplanet Archive or Hipparcos in the page footer or `public/credits.html`; the archive requires its acknowledgement.
- No variable-star list: no catalogue held; the Hipparcos variability text is not exposed.
- The exoplanet-host layer has no interface control.
- Worker steps that cannot be sliced (up to about 1 s at load) delay a search typed during them.
- 69 explanations only; M81 and M32 rest on a single page.
- Hipparcos V is used as a stand-in for G; B-V to BP-RP is a dwarf relation; 165 Hipparcos stars (for example Alnilam, S/N 3.7) are not drawn.
- WebXR, accounts, sync: not started.

## Licence flags (check before a public release)
- **Hipparcos (VizieR I/239): CC-BY-NC-3.0 IGO**, non-commercial. I/311 gives an acknowledgement (F. van Leeuwen) and no licence text was found for it.
- **NASA Exoplanet Archive**: no licence statement; acknowledgement and citation (Christiansen et al. 2025) required; not yet shown in the application.
- **Gaia**: still three conflicting statements; the 35,325-record subset is now searchable and filterable through the engine with the same open question.
- IAU proper names: CC BY with source mentioned (IAU-CSN header). SIMBAD terms page not fetched.
