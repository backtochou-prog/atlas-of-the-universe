# Roadmap

Status key: **done** = in the repository and checked; **partial** = part built, remainder listed; **not started**; **planned**.

| # | Phase | Status | Notes |
|---|---|---|---|
| 1 | Foundation | done | Spatial core, schema, validation, tests |
| 2 | Star renderer | done | Gaia star field, orbit camera, picking, inspector (browser-tested) |
| 3 | General hierarchical scale navigation | **partial** | Universe > Nearby universe > Local Group > Milky Way > neighbourhood > Solar System > planet system is built (frames, camera flights `M` `L` `U`, breadcrumb with hysteresis). Not built: the observable universe and cosmological distances (the nearby-universe frame stops at 400 Mpc, the camera at 600 Mpc from its focus, while the 2MRS sample it shows reaches 741 Mpc at H0 = 70: 60 galaxies lie beyond 400 Mpc and 3 beyond 600 Mpc), breadcrumb *navigation* (clicking a crumb), the Local Group barycentre (the frame is an anchor) |
| 4 | Real data ingestion | **partial** | Gaia DR3 and SIMBAD (stars); JPL Horizons, SSD, NAIF (Solar System); since Prompt 07 also the Hipparcos bright-star supplement (8,942 stars), the NASA Exoplanet Archive composite table (6,470 planets, 4,862 hosts) and six curated other objects. Remainder below |
| 5 | Solar System | **done for the Sun, planets and 20 moons** | Remainder below |
| 6 | Deep-sky layers | **done with a remainder** (Prompt 06) | Milky Way documented model, 10 galaxies, 8 nebulae, 6 star clusters, Local Group / M81 group / Virgo, the 2MRS distribution, with 36 images, provenance, inspector and credits page. 661 unit tests in 29 files; 129 of 129 browser checks pass on software GL; no GPU run. Remainder in section 6 below |
| 7 | Adaptive performance | **partial** | A frame-time quality governor exists, is wired to the deep-space layer and unit-tested; it is untuned on real GPUs. Mobile and VR tier, texture compression (KTX2) not started |
| 8 | WebXR | not started | Capability flag only (`navigator.xr` detection) |
| 9 | Discovery engine | **done with a remainder** (Prompt 07) | One record per object over 12 datasets (90,950 records); search with identifier normalisation and typo handling; filters with missing-value counts; frame-aware nearby and visible queries; relations by basis; 10 discovery lists; 69 source-backed explanations; saved bookmarks, collections and history (local only); camera history with Back and Forward; Worker engine; Hipparcos supplement and exoplanet-host markers. 604 discovery unit tests; browser QA logs in `docs/qa/discovery/`. Remainder in section 9 below. Not built: guided tours and recommendations |

## 5. Solar System: remainder
- **Ephemerides.** Replace the Keplerian models with JPL development ephemerides (DE440 via SPICE `.bsp` kernels, or Chebyshev tables built from Horizons) for arcsecond accuracy, light-time, and correct eclipses.
- **Satellite precession.** Model apsidal and nodal precession (J2) or use SAT/JUP/URA/NEP kernels, so moons stay accurate over decades instead of years.
- **Imagery.** True-colour Mars (needs a tiled or range-requested source for the 12.7 GB Viking mosaic, or a smaller USGS/NASA product), a real Saturn and ring profile, Cassini maps for Titan's surface and the mid-sized Saturnian moons, Voyager 2 maps of the Uranian moons, and the NASA Black Marble for night lights.
- **Relief.** Displacement and normal maps from LOLA/MOLA/LRO.
- **More bodies.** Pluto and Charon, Ceres and Vesta, the irregular outer moons, selected comets and asteroids (JPL Small-Body Database), and spacecraft trajectories.
- **Verify** Jupiter's map longitude convention against its official caption.

## 6. Deep space: remainder
- **Images.** An image for the SMC (it has none since the Gaia star-count maps were withdrawn on licence grounds on 2026-11-12; they could return only if the project is accepted as non-commercial), higher-fidelity images for M32 (GALEX near-UV only) and M87 (a 17 arcmin Legacy Surveys cutout and GALEX); a whole-galaxy visible-light image of M31; images for the Pleiades, Hyades, Omega Cen, M13 and M4.
- **Cosmic web.** Filaments or voids only as a clearly labelled derived overlay with a proper method (flux-limit and Zone of Avoidance correction, smoothing scale, uncertainty), or from a published reconstruction. Not drawn today, by design.
- **Surveys beyond 2MRS.** Spectroscopic surveys such as DESI and SDSS for deeper, more complete galaxy positions. Not integrated.
- **Real 3D nebula models.** For example Orion from published three-dimensional studies, replacing the illustrative layers for that object. None exists in the data.
- **Texture compression.** KTX2 / Basis Universal in the image build and loader. Not implemented; textures are decoded WebP uploaded as RGBA.
- **Mobile and WebXR tiers.** Device tier selection, smaller asset set, touch review, stereo path; none exists.
- **Adaptive governor on real GPUs.** Measure and tune the thresholds on hardware; today only software GL has been run. `npm run perf:deepspace` (`tools/perf-deepspace.mjs`) is the script to repeat there; its current `perf.json` is software GL.
- **Real context loss.** Loss and restore are handled for the deep-space textures and tested only by simulation (`WEBGL_lose_context`). Test on a real GPU, and audit the Solar System `TextureManager`, which has no context-loss handling of its own.
- **Breadcrumb navigation.** The breadcrumb is display only.
- **Near sides.** Source the near side of the disc galaxies so the tilt direction is not a choice.
- **Spatial index.** Picking is a CPU scan; fine for the current counts, not for a million-galaxy layer.
- **Open QA items.** The Orion approach sweep that once showed a dip in apparent size at the glow-to-image hand-off passes in the last run (cause never diagnosed). Brightness steps at representation hand-offs are 42 to 48 percent against the check's 50 percent limit, a small margin.
- **Catalogue rows.** "Fly to this entry" on a Virgo or 2MRS row does nothing (no position for `twomrs` rows in `pointPosition`); Inspect works.
- **Camera range.** The 2MRS sample reaches 741 Mpc but the orbit camera stops at 600 Mpc from its focus; either extend the limit or keep the three farthest galaxies out. The comment above `ORBIT_LIMITS` in `src/render/orbitCamera.ts` wrongly says "~130 Mpc".
- **Licences.** Resolve the Gaia licence discrepancy (the 35 325-star subset and the cluster member lists are still Gaia-derived) and the NED-D header before a public release (`docs/SCIENTIFIC_DATA.md` section 13.2). The seven ESA/ESO image licences were re-checked against their own pages on 2026-11-12; the GALEX and Legacy Surveys assets were not put through that comparison, and the ESA/ESO clause "unless specifically noted" means the check can age.

## 4. Data ingestion: remainder
- **Hipparcos** and the **NASA Exoplanet Archive** are now ingested (Prompt 07, section 9). Not ingested: extra Hipparcos stars fainter than V = 6.5 other than IAU-named ones, and exoplanet candidates.
- **Tiled, streamed catalogues** and a spatial index for picking (discovery queries have a KD-tree; picking in the viewer is still a CPU scan).
- **Extinction**, the parallax zero-point correction and a distance prior for distant stars.

## 9. Discovery engine: remainder
- **WebXR: not started.** Nothing in the discovery interface or the viewer has a stereo path; only the capability flag exists.
- **Accounts and sync: not started.** Saved discoveries are local to one browser (`localStorage`); `SyncAdapter` (`src/discovery/saved.ts`) is an interface that nothing implements. No backend.
- **Licence decisions.** Hipparcos data carries CC-BY-NC-3.0 IGO on the VizieR I/239 ReadMe; the Gaia statements still disagree (open with credit; CC BY-NC 3.0 IGO; CC BY-SA 3.0 IGO). Both need a decision before any public or commercial release. The NASA Exoplanet Archive acknowledgement and the Hipparcos credit are not yet shown in the page footer or `public/credits.html`.
- **Variable stars.** No variable-star catalogue (GCVS, VSX) is held, so there is no "interesting variable stars" list. The Hipparcos `variability` text exists per star in `bright-stars.v1.json.gz` (Hipparcos type letters) but the engine does not map it into records, filters or lists. `src/discovery/discover.ts` offers ten lists (nearest stars, brightest stars, fastest proper motion, nearest planet hosts, most planets in one system, hottest, shortest-period and largest exoplanets, nearest galaxies, largest nebulae) and nothing about variability. Exposing the Hipparcos flag as a filter and a list is possible; anything beyond it needs a new dataset.
- **Multi-language names.** Only the catalogue names and IAU proper names exist. No translations.
- **Exoplanet atmosphere data.** None held: the table has period, radius, mass, equilibrium temperature, semi-major axis, eccentricity, discovery data. No spectra, no composition.
- **Exoplanet host layer control.** The layer (4,834 drawable hosts) is off by default and has no interface control; `viewer.setExoplanetHostsVisible` is code-only.
- **Explanations.** 69 objects have one; the rest show "No curated explanation yet." M81 and M32 rest on a single page each; several deep-space notes have three or four claims. Notes are paraphrases and were not re-verified against full page texts.
- **Hipparcos supplement.** V stands in for G; B-V to BP-RP uses the dwarf-sequence relation; 165 stars are not placed in 3D (Alnilam is searchable but not drawn); 40 IAU-named stars without a HIP number and four stars without a hip2 row are absent.
- **2MRS.** Rows below cz = 1,000 km/s are not placed; distances are cz / H0 with an assumed H0.
- **Open QA items.** One check of the last recorded API QA run fails (a click on an exoplanet-host halo does not select; see `docs/qa/discovery/qa-api-log.json`). Browser checks were run on software GL in Chromium only; no GPU, other browsers, real phones or screen readers. The performance numbers are from a shared machine.
- **Texture compression (KTX2)** and **mobile tier**: unchanged, not started (section 6).
- **Search.** The page cannot get an answer while the worker is inside a non-sliceable step (up to about 1 s at load); making `mergeRecords`, the adapters and `RecordStore` incremental would remove that.

## Dependencies
General scale navigation (3) builds on the frame chain that now exists, extended to the universe by Prompt 06. Exoplanets are searchable as records and their hosts are drawn as markers; drawing planets themselves would need a system model that does not exist. A mobile and VR tier needs the adaptive governor (7).

## Blockers and risks
- No GPU measurements exist; all rendering timings are from software GL. This includes the deep-space layer.
- Six bodies use artistic textures and eleven have none; closing that gap depends on obtaining suitable scientific maps.
- SIMBAD's primary host was unreachable on 2026-11-12; the CfA mirror served the data.
- Gaia and USGS/NASA redistribution terms should be re-checked before a public release. For deep space the Gaia statements disagree (open and free with credit, CC BY-NC 3.0 IGO, CC BY-SA 3.0 IGO; the two Gaia-derived images were withdrawn for this) and NED-D carries an "All Rights Reserved" header.
