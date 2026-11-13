# The Solar System

An interactive, navigable Solar System: the Sun, the eight planets and twenty natural satellites, with orbits from JPL data, body orientation from the IAU, real spacecraft maps where they exist, and a time controller. This document describes what is implemented, how, what is approximate, and how to reproduce it.

Generated companions: `docs/SOLAR_SYSTEM_VALIDATION.md` (measured model error against JPL Horizons) and `docs/TEXTURE_PROVENANCE.md` (every texture's source, licence, projection and processing).

## 1. What is implemented

| Group | Bodies |
|---|---|
| Star | Sun |
| Planets | Mercury, Venus, Earth, Mars, Jupiter, Saturn, Uranus, Neptune |
| Satellites (20) | Moon; Phobos, Deimos; Io, Europa, Ganymede, Callisto; Mimas, Enceladus, Tethys, Dione, Rhea, Titan, Iapetus; Ariel, Umbriel, Titania, Oberon, Miranda; Triton |

Not implemented: dwarf planets, asteroids, comets, irregular outer moons, Pluto/Charon, Saturn's ring particles, planetary magnetospheres, surface relief (no displacement maps), the Sun's corona as a physical object.

Integration with the existing architecture: planetary systems are frames in the existing `FrameTree` (Milky Way > stellar neighbourhood > Solar System > *planet* system); the camera is placed in them with the existing floating-origin `refit()` and its hysteresis; the Gaia stars are drawn behind the planets from the same camera; the existing inspector, search-free selection, log zoom and fly-to are reused. The hierarchical scale navigation planned as Prompt 03 was never built as a general system; what exists is this one chain of frames, driven by the same camera.

## 2. Data and sources

All numbers are imported at build time by `tools/solar-import.ts` into `public/data/solar-system.v1.json`. Nothing numeric is hand-entered except the curated context text in `src/data/solar/bodies.ts`, whose every statement carries a certainty label and a reference.

| Source | Used for | Retrieved |
|---|---|---|
| JPL Horizons API (`OBJ_DATA`) | radii, GM, mass, density, albedo, rotation period and rate, obliquity, temperature, orbital period, luminosity, effective temperature; 29 bodies | 2026-11-12 |
| JPL Horizons API (`ELEMENTS`, `VECTORS`) | satellite osculating elements at the epoch; mean-longitude fit samples; validation state vectors | 2026-11-12 |
| JPL SSD, *Approximate Positions of the Planets*, Table 1 | planetary Keplerian elements and rates (1800-2050) | 2026-11-12 |
| JPL SSD, *Planetary Satellite Mean Elements* | mean sidereal period, mean a and e (shown in the inspector; the fit, not this table, advances the satellites) | 2026-11-12 |
| NAIF `pck00011.tpc` | IAU pole right ascension and declination, prime-meridian angle and rate | 2026-11-12 |
| NASA Science, *Our Sun: Facts* | the Sun's spectral type, G2 V (SIMBAD does not catalogue the Sun) | 2026-11-12 |
| CODATA 2018 | G, to derive a mass from GM where JPL prints none | n/a |

Each measurement carries unit, uncertainty (where JPL gives one), category, source, record id, retrieval date and, if derived, its transformation:

| Category | Examples here |
|---|---|
| observed (published by JPL as a measurement or fit result) | radius, GM, density, albedo, rotation period, obliquity, orbital period |
| derived | surface gravity (GM/R² from the mean radius), a mass where JPL prints none (GM/G, with G's uncertainty, which dominates), a mean radius from triaxial radii, a rotation period from a rotation rate, a synchronous rotation period (= orbital period) |
| modelled / hypothetical | none in the measurement table; hypotheses appear only as labelled context facts |

A quantity JPL does not publish is **absent and listed with a reason**, never a number. Parsing is conservative: a value the parser does not understand returns nothing. Three real parser defects were found and fixed while building this (see section 11).

### Context facts
Contextual statements (for example that Europa has a subsurface ocean) carry **observed / inferred / hypothesis** and a reference URL, and each URL was fetched at build time (20 of 20 return HTTP 200). Europa's ocean is labelled *inferred* and its text says it "has not been observed directly"; the question of life there is a *hypothesis*; Triton's capture origin is a *hypothesis*.

## 3. Orbital mechanics

### Planets: JPL low-accuracy Keplerian elements
`src/core/orbits/` implements: Kepler's equation (Newton iteration, residual below 1e-12 over a dense grid of e up to 0.99), element-to-position (Rz(Ω) Rx(i) Rz(ω)), JPL element rates, ecliptic-to-ICRS rotation by ε = 23.43928° (the value on the JPL page), and orbit sampling.

For T Julian centuries from J2000 (TDB): a, e, I, L, ϖ, Ω each equal their J2000 value plus rate × T; ω = ϖ − Ω; M = L − ϖ. The table gives the **Earth-Moon barycentre**, so Earth's centre is the barycentre minus (m_Moon/(m_Earth + m_Moon)) × the Moon's geocentric position (about 4,700 km).

**This is not a high-precision ephemeris.** Measured against JPL Horizons (216 comparisons in `docs/SOLAR_SYSTEM_VALIDATION.md`):

| Planet | At the reference epoch | Worst of 7 sampled dates, 1850-2050 |
|---|---|---|
| Mercury | 5,102 km (23″) | 5,102 km (23″) |
| Venus | 948 km (1.8″) | 9,693 km (18″) |
| Earth | 5,529 km (7.7″) | 8,289 km (12″) |
| Mars | 19,117 km (16″) | 69,512 km (59″) |
| Jupiter | 471,382 km (2.0′) | 1.15 million km (5.3′) |
| Saturn | 1.81 million km (4.4′) | 4.40 million km (10.3′) |
| Uranus | 785,299 km (56″) | 1.22 million km (1.5′) |
| Neptune | 685,997 km (32″) | 1.24 million km (57″) |

Positions outside 1800-2050 are still computed but flagged by `isOutsideValidity()`.

### Satellites: epoch elements, fitted mean-longitude rate
Each satellite uses JPL Horizons osculating elements at the reference epoch, in the ICRF frame centred on its planet (so no plane conversion is needed), advanced with a **mean-longitude rate fitted to Horizons osculating elements** sampled around the epoch (121 samples; spacing a few periods for fast moons, at most 30 days). Atlas does not propagate precession of the apsidal line or the node, and applies no perturbations.

This design was reached by measurement. A first version advanced the satellites with JPL's mean period from the mean-elements table and **drifted badly for fast, precessing orbits** (Io's error reached over 100% of its orbit radius within 90 days) because that table's period is anomalistic, not the rate of the body's longitude. The fit recovers Io's sidereal period, 1.769138 d. JPL itself warns its mean elements are "not intended for ephemeris computation".

Measured error as a fraction of the satellite's distance from its planet (full table in the validation document):

| Satellite | epoch | +30 d | +1 yr | +5 yr |
|---|---:|---:|---:|---:|
| Moon | 0.0% | 0.8% | 3.9% | 16.8% |
| Io | 0.0% | 0.4% | 0.8% | 0.9% |
| Europa | 0.0% | 0.6% | 1.3% | 2.3% |
| Ganymede | 0.0% | 0.1% | 0.1% | 0.1% |
| Titan | 0.0% | 0.0% | 0.0% | 0.2% |
| Triton | 0.0% | 0.0% | 0.6% | 3.1% |
| Mimas | 0.0% | 2.3% | 0.7% | 8.2% |

Orbit lines are the instantaneous Keplerian ellipse at the current time, not a historical path.

### What this does and does not claim
Atlas positions are suitable for **orientation and exploration** (a moon is where JPL puts it to within a few percent of its orbit for a year; a planet to within minutes of arc). They are **not** suitable for eclipse timing, occultations, spacecraft work or anything needing arcsecond accuracy. The Moon's shadow on Earth, for instance, is rendered with true geometry but its *timing* is only as good as the lunar model above.

## 4. Time

| Item | Value |
|---|---|
| Reference epoch | 2026-11-12 00:00:00 UTC = JD 2461356.500801 (TDB) |
| Time scale | JD is TDB-like. TT − UTC = leap seconds + 32.184 s (69.184 s in 2026); TDB − TT (under 2 ms) is ignored. The leap-second table covers 1972-2017; later dates use 37 s |
| Clock | `SimClock` keeps the date as an integer day plus a fraction in [0, 1), so a million small steps lose no precision (tested; a single large double is measurably worse). One real-time step is capped (0.25 s), so a stalled tab cannot jump |
| Speeds | real time, 1 min/s, 1 h/s, 1 d/s, 10 d/s, 100 d/s, 1 yr/s, forwards or backwards |
| Controls | Pause/Play (Space), Slower/Faster ([ ]), Reverse (\), ±1 d, Reset date |
| Independence | Simulation time never reads the user's system clock; it starts at the reference epoch and moves only when told to |

## 5. Orientation and surface mapping

Body orientation uses the IAU pole and prime meridian, **linear terms only**: pole RA/Dec drift per century and the prime-meridian angle W advancing at a constant rate (retrograde when negative: Venus, Uranus). Not modelled: nutation, precession terms, the Moon's librations, Neptune's periodic terms. This limits orientation accuracy to a fraction of a degree for most bodies and a few degrees for the Moon.

**Independent end-to-end check.** The planetary ephemeris, the time scale and Earth's rotation all feed the sub-solar point. At 2026-11-12 12:00 UT it lands within the real-world window (about 4° west, about 17° south, from the equation of time and the Sun's declination), which no single component could produce alone. This is a unit test.

Maps are mapped in the shader from the body-fixed direction (longitude from the prime meridian, latitude from the pole), using the map's own longitude origin. USGS maps carry GeoTIFF tags; the implied radius from each (Mercury 2439.4 km, Io 1821.5, Ganymede 2632.3, Enceladus 252.1, Triton 1350.1, ...) matches the body, confirming a global simple-cylindrical map with its left edge at −180°. East-positive longitude is the USGS convention and is not encoded in the tags. **Jupiter's map orientation could not be verified** (its caption was not machine-readable); the Great Red Spot appears in the southern hemisphere, as it should.

## 6. Rendering

All positions are float64 on the CPU and made camera-relative before reaching the GPU, so distances of 1e12 m never appear as absolute coordinates. One shared sphere mesh per detail level, scaled per body (and by flattening along the pole for Jupiter and Saturn).

| Feature | Implementation |
|---|---|
| Sunlight | Lambertian from the Sun's true direction at each fragment, in view space |
| Eclipses and planet shadows | analytic sphere shadows with penumbra from the Sun's angular size. Occluders use **true** radii, so shadows are physically sized even when a body is drawn enlarged. A planet's moons shadow it; a moon is shadowed by its planet |
| Ring shadows | a ray from the fragment toward the Sun is intersected with the ring plane and the ring opacity sampled, so Saturn's rings shadow the planet and the planet shadows the rings |
| Atmospheres | a limb-glow shell, lit by the Sun, with a terminator twilight band; thickness is exaggerated for visibility and is a visualisation choice, not the atmosphere's height |
| Earth | day map, city lights that appear only on the night side, cloud layer, and a sun-glint on water (water is detected from the map colour; a visualisation choice) |
| Saturn's rings | a flat ring mesh textured from an opacity strip whose radial extent (75,400 to 140,340 km) was calibrated against three known ring features, with residuals of at most 17 of 2048 pixels |
| The Sun | a limb-darkened emissive disc (u = 0.6) with a soft halo. **The halo is a visual effect, not a physical corona and not a measure of luminosity.** The luminosity itself is the IAU nominal value in the inspector |
| Exposure | normalised per body, so the relative brightness of different planets is not physical (Neptune receives about 900 times less light than Earth) |
| Night sides | a 1.2% ambient floor keeps them faintly visible; physically they would be black |
| Depth | near plane 1% of the focus distance, far 1e15 m, depth cleared between the star pass and the Solar System pass |
| Stars | the Gaia field is drawn first, from the same camera, so the real sky is the backdrop |

## 7. Imagery: what is real and what is not

Every texture's fidelity is recorded in `public/textures/provenance.json` and shown in the inspector.

| Body | Texture | Fidelity | Notes |
|---|---|---|---|
| Moon | NASA SVS CGI Moon Kit, LRO LROC colour | scientific map | built from over 100,000 WAC images |
| Jupiter | NASA/JPL/SSI Cassini map PIA07782 | scientific map | longitude origin unverified |
| Io, Europa, Ganymede, Callisto, Enceladus, Triton | USGS Astrogeology global mosaics (Voyager, Galileo, Cassini) | scientific map | Triton: 38% unimaged, drawn flat grey; Europa, Ganymede, Callisto, Mercury: 3-4% polar gaps |
| Earth | NASA SVS 3615 (Blue Marble NG based) and a cloud layer extracted from the same scene | derived | SVS states the look was **art-directed** for a film |
| Earth night lights | Solar System Scope | artistic composite | stylised, not the NASA Black Marble product |
| Mercury | USGS MESSENGER enhanced colour, luminance only, tinted | derived | the source is false colour; only its brightness is used |
| Mars, Venus, Saturn, Uranus, Neptune, Saturn's rings | Solar System Scope, CC BY 4.0 | **artistic composite** | the provider states it contains fictional fill and enhanced saturation |
| Titan, Phobos, Deimos, Mimas, Tethys, Dione, Rhea, Iapetus, the Uranian moons | none | none | plain spheres in a visualisation-choice colour |

No manageable true-colour Mars mosaic could be obtained (the USGS Viking colour mosaic is 12.7 GB). Uranus and Neptune have no global maps at all. Venus's surface is permanently hidden by cloud, so no surface map is drawn.

## 8. Scale: physical size versus drawn size

Physical radii live in the dataset and are **never modified**. Only the radius of the drawn sphere follows the display-scale policy (`src/core/solar/displayScale.ts`):

- **True scale** mode draws every body at its true size.
- **Enlarged** mode (default) raises a small body to a minimum apparent size (0.004 rad) only if (a) the body is in the neighbourhood of what the camera is looking at (within 30 focus distances), (b) the enlargement stays below 20% of the clearance around it (a planet cannot grow past a fraction of its nearest moon's orbit), and (c) the factor stays at or below 400. Otherwise the body is a marker.
- A body smaller than 1.5 px is drawn as a fixed-size **marker**, which carries no size information.
- The interface always says which it is: "Body sizes: true scale", or "Body sizes NOT to scale: *Iapetus* enlarged up to ×21 (orbits and distances are true)", naming the body. The inspector shows "Drawn radius vs true radius".
- Orbits, distances and positions are never altered by display scale.
- A body with no published radius is drawn only as a marker, never with an invented size.

## 9. Navigation

- **Select**: click a body (a marker has a generous hit radius), a name label, or a button.
- **Go to**: buttons, labels, "Centre view" in the inspector. The camera flies there with the distance interpolated geometrically (so no teleporting) and then **follows the body** along its orbit.
- **Parent** (Backspace): from a moon to its planet, from a planet to the overview. **Overview** (O): the planetary region seen from above the ecliptic.
- **Zoom** is exponential, and the minimum distance is 1.35 body radii, so the camera cannot enter a body.
- **Breadcrumb**: Milky Way › Stellar neighbourhood › Solar System › *planet* system, from the frame tree; the planet-system frames move with their planets every frame; hysteresis stops flicker at a boundary. Frame radii are visualisation extents, not astronomical boundaries.
- The Solar System layer is drawn only within 3,000 AU of the Sun; beyond that the planets are far below a pixel and the Sun is the existing reference marker.

## 10. Performance

Measured in a Chromium with **software GL (SwiftShader), so these are floors and not GPU figures**; no GPU timings exist.

- Nothing is loaded up front: zero Solar System textures at startup.
- Textures load only when a body is at least 6 px across, at 512×256 below 110 px and 2048×1024 above, and are disposed after 15 s unused (tested in the browser).
- One shared high-detail and one low-detail sphere; geometry and materials are built lazily the first time a body is large enough; orbit paths are built only for orbits that are drawn; the per-frame result map is reused.
- Typical view: 1 to 8 spheres, up to about 20 markers, 4 to 9 orbit lines, 4 to 8 textures (30 to 45 MB), 15 to 20 draw calls.

## 11. Findings made while building this

1. **A 10,000-fold mass error was caught by reading the raw text.** Phobos's mass is printed as `1.08 (10^-4)` with a scale factor in parentheses; the first parser ignored it. The parser now applies the factor, returns nothing for text it does not understand, and has a regression test.
2. **Plain "Radius (km)" labels were missed**, leaving Iapetus, Umbriel, Titania and Oberon with no radius; the renderer had silently substituted a placeholder size. The parser now reads them, and the renderer can no longer invent a radius.
3. **Satellite drift** from using JPL's mean period (section 3).
4. **A validation harness bug**: Horizons returns time-list rows sorted by time, not in request order, and matching rows by index compared positions at the wrong dates. Rows are now matched by Julian date.
5. **The Sun is not in SIMBAD.** Its spectral type comes from NASA.
6. **Triton's map is 38% no-data**, which looked like a shadow; it is now flat grey and the fraction is reported.
7. **The ring strip's own colours are too dim to use as brightness**; its alpha gives opacity and the colour is a labelled visualisation choice.

## 12. Limitations

- Planet positions are minutes of arc, satellites a few percent of their orbit over a year; not an ephemeris.
- Satellite precession, perturbations, the Sun's barycentric motion and light-time are not modelled.
- Orientation uses linear IAU terms only.
- Six bodies have artistic textures, eleven have no imagery, and Earth's appearance is art-directed.
- No surface relief, no cloud motion, no weather, no aurorae, no night-side glow other than city lights.
- Display exposure is per body, so relative brightness between planets is not physical.
- The Sun's halo and the atmosphere shells are visual effects.
- Jupiter's map longitude is unverified; the ring extent is a calibration, not a published figure for that image.
- Untested on a real GPU, other browsers, or touch devices.

## 13. Reproduce

```bash
npm ci
npm run data:solar          # live: fetch from JPL and NAIF, validate against Horizons, write the dataset
npm run data:solar:offline  # exact rebuild from data/cache/solar (never touches the network)
npm run textures:build      # fetch/verify/downsample textures (needs Python, Pillow, numpy); big USGS downloads are cached
npm run textures:annotate   # recompute no-data fractions from the built outputs
python3 tools/textures/build_textures.py --report   # regenerate docs/TEXTURE_PROVENANCE.md
npm run verify              # typecheck, tests, production build
npm run build && npx vite preview --port 4173
PLAYWRIGHT_MODULE_DIR=<dir with playwright> npm run qa:solar
```

Attribution: JPL Horizons and SSD (NASA/JPL-Caltech), NAIF (NASA/JPL), NASA Science, NASA SVS, USGS Astrogeology Science Center, NASA/JPL/Space Science Institute, Solar System Scope (CC BY 4.0). Full texture credits are in `docs/TEXTURE_PROVENANCE.md` and the inspector.
