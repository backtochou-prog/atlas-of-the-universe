# Architecture

## Stack
| Concern | Choice | Status |
|---|---|---|
| Language | TypeScript (strict, `noUncheckedIndexedAccess`) | In use |
| Build | Vite 8 | In use |
| Tests | Vitest 5 (52 files, 1,265 tests of which 1 is skipped, measured 2026-11-13; 18 files are `tests/deepspace-*.test.ts`, 23 are `tests/discovery-*.test.ts` with 604 tests; `npm run verify` prints the current count) | In use; maths, ingestion, catalogue, renderer logic, a headless run of the Solar System layer, the deep-space geometry, LOD, cache, data validation and renderer logic, and the discovery engine, atlas, navigation, saved store and UI view models |
| 3D | Three.js 0.187, WebGL2 required | In use: star points, the Solar System and the deep-space layer (custom GLSL) |
| Build-time scripts | `tsx` 4 (TypeScript), Python 3 with Pillow and numpy (textures and deep-space images) | dev-only |
| UI | Plain DOM | In use (`src/ui/`). React is deferred until panels need shared state |
| Browser QA | Playwright (**not a project dependency**) | `tools/qa-browser.mjs` (stars, 26 checks), `tools/qa-solar.mjs` (Solar System, 43 checks), `tools/qa-deepspace.mjs` (deep space, 129 checks), `tools/perf-deepspace.mjs` (deep-space measurements, `npm run perf:deepspace`), `tools/qa-discovery-api.mjs` and `tools/qa-discovery-ui.mjs` (discovery engine and interface; logs in `docs/qa/discovery/`) |

Not adopted: WebGPU, a state library, a physics engine. `src/core/capabilities.ts` detects WebGL2, WebGL1, `navigator.gpu` and `navigator.xr`. **WebGL2 is required**: without it the page says so and draws nothing. Nothing renders with WebGPU or WebXR. Textures are WebP with mipmaps; no GPU texture compression is used.

## What exists and what does not
| Capability | State |
|---|---|
| Gaia DR3 star field (35,325 sources; 34,890 drawn), magnitude brightness, BP-RP colour, click, search, scientific inspector | Built and browser-tested |
| **Solar System**: Sun, 8 planets, 20 moons; JPL data; elliptical orbits; IAU orientation; time controller; real maps where they exist; eclipse, ring and planet shadows; Earth day/night/clouds; Saturn's rings | **Built and browser-tested** (see `docs/SOLAR_SYSTEM.md`) |
| Frame hierarchy Universe > Nearby universe > Local Group > Milky Way > neighbourhood > Solar System > planet system driving the camera context and breadcrumb, with hysteresis | Built (`createUniverseFrames`); the Local Group frame is an anchor, not a barycentre |
| Scale navigation by flight: neighbourhood, Milky Way (`M`), Local Group (`L`), nearby universe (`U`) | Built; the observable universe and cosmological distances are not |
| **Deep space**: Milky Way documented model, 10 galaxies from real images, 8 nebulae as illustrative depth layers of real images, 6 star clusters from real Gaia members, Local Group / M81 group / Virgo, 2MRS galaxy distribution | **Built and browser-tested on software GL** (see `docs/DEEP_SPACE.md`); 27 objects, 36 images, 9 point catalogues; WebGL context loss and restore handled and tested by simulation only |
| Planetary textures at full scientific fidelity for every body | Partial: see the fidelity table in `docs/SOLAR_SYSTEM.md` (six artistic composites, eleven bodies with none) |
| **Discovery engine** (Prompt 07): one record per object across Gaia, Hipparcos, the Solar System, deep space, the NASA Exoplanet Archive and other objects; search, filters, nearby, lists, relations, explanations, saved discoveries, history; Worker engine; Hipparcos supplement and exoplanet-host markers | **Built; browser-tested on software GL** (see `docs/DISCOVERY_ENGINE.md`); interface QA and some integration checks were still being completed when this was written |
| WebXR, mobile tier, texture compression, filaments and voids | Not built |

## Module map and dependency direction
```
core/astro        coordinates, parallax, photometry                       (no deps)
core/spatial      frame tree (+ setOrigin), refit, zoom, vec3, scale formatting
core/orbits       time scales + SimClock, Kepler, elements, IAU rotation, ephemeris   (pure maths; depends on core only)
core/solar        displayScale: physical versus drawn radius              (pure)
core/deepspace    deep-space maths and policy, all pure: geometry (physical size, redshift distance, image planes, deprojection), classify,
                  lod (levels, texture level, QualityGovernor), pick, assetCache (byte-budget LRU)
data/schema       Measurement, CelestialObject (+ Fact, ImageryNote)
data/deepspace    types (DeepSpaceObject, Representation, point catalogues, image provenance), validate, DeepSpaceData, wavelength notes
data/catalogue    Gaia columns, flags, reader, inspect (stars, solar bodies AND deep-space objects and catalogue rows), search, frames (stellar + universe)
data/solar        types, curated body list, SolarSystemData (browser), ingestion/ (build time)
discovery         PURE core, no DOM and no Three.js: types (universal ids, records, relations, file contracts), normalize, searchIndex, records (adapters + mergeRecords),
                  pointMerge + duplicates, recordStore, filters, spectral, spatialIndex (KD-tree), nearby (frame-aware), relations, discover (lists), saved,
                  navigation (NavigationController, NavigationHost), brightPlacement; the ENGINE: atlas (page-side facade DiscoveryAtlas), workerEngine (AtlasEngine),
                  worker + workerClient, scheduler (time slicing), loader (12 datasets in 3 stages), engineApi (message contract)
data/ingestion    Gaia and SIMBAD importers
render            stars: brightness, colour, layer, picking, orbit camera, starfield, viewer
render/solar      appearance, shaders, textures (lazy cache), solarLayer, hierarchy, pickBody
render/discovery BrightStarLayer + brightStarSet + brightStarColour (Hipparcos supplement), attachDiscoveryRenderers, ViewerNavigationHost (NavigationHost on the viewer),
                  markerPort; the marker renderers (exoplanet hosts, other objects, highlight rings, selection proxy) live in render/deep-space/DiscoveryMarkers.ts and DiscoveryRings.ts
render/deep-space DeepSpaceLayer (scene, registry, quality), DeepSpaceAssetManager, DeepSpaceLOD, GalaxyRenderer, MilkyWayRenderer + milkyWayModel,
                  NebulaRenderer + nebulaGeometry, StarClusterRenderer, GalaxyClusterRenderer, CosmicStructureRenderer, clusterGeometry, pointCatalogues
ui                inspector, hud, input, solarUi (time, scale, breadcrumb, labels), deepUi (scale shortcuts, object lists, layer toggles, bands, credits)
ui/discovery     SearchBox, DiscoverDrawer (FeaturedTab, FilterTab, NearbyTab, SavedTab), NavContext, InspectorExtras; each has a pure *ViewModel module that is unit-tested
main.ts           boot: load local datasets, wire everything
tools/            data-import (Gaia, SIMBAD), solar-import (JPL), textures/build_textures.py, deepspace/ (build_objects.ts, build_catalogues.ts,
                  build_images.py, make_gaia_density.py (output not shipped), make_credits_page.mjs, image manifests), qa-*.mjs, perf-deepspace.mjs
```
- `render` depends on `data` and `core`; nothing in `data` or `core` depends on `render`.
- `src/discovery` (pure core and engine) imports from `core`, `data` types and `data` loaders only; it imports nothing from `render` or `ui`. `render/discovery` and `ui/discovery` import `src/discovery` and talk to it through its public API (`DiscoveryAtlas`, `NavigationHost`). The viewer implements `NavigationHost` through `ViewerNavigationHost`; the atlas never touches Three.js.
- `render/deep-space` depends on `core/deepspace` and `data/deepspace`; the sub-renderers know nothing of each other and register with the layer.
- The browser bundle imports no `node:*` modules. Node-only: `data/ingestion/cache.ts`, `data/ingestion/build.ts`, `data/solar/ingestion/*`, `tools/`.
- Pure logic (brightness, colour, picking, scale policy, ephemeris, clock) is separate from the three.js classes, so it is unit-tested without WebGL. `SolarLayer.update()` is also tested headlessly (three.js needs no GPU until it renders).

## Data flow
```
Gaia + SIMBAD ──(build time)──▶ public/data/gaia-dr3-subset.v1.json.gz, simbad-crossid.v1.json.gz      (see SCIENTIFIC_DATA.md)
JPL Horizons, JPL SSD, NAIF ──(build time, validated against Horizons)──▶ public/data/solar-system.v1.json
USGS, NASA SVS/JPL, Solar System Scope ──(python, build time)──▶ public/textures/*.jpg + provenance.json

browser:  load local files ──▶ GaiaCatalogue / SolarSystemData
   per frame:  SimClock.advance ─▶ ephemeris (float64) ─▶ positions − camera (float64) ─▶ float32 ─▶ GPU
               star pass (parsec units) ─▶ clear depth ─▶ Solar System pass (metre units)
   click:      body? (pickBodyAt) else star ─▶ CelestialObject (with sources) ─▶ inspectObject ─▶ DOM
```
Deep space (details in `docs/DEEP_SPACE.md`):
```
SIMBAD, VizieR, HyperLEDA, NED-D, arXiv ──(tools/deepspace/build_objects.ts)──▶ public/data/deep-space.v1.json            objects + Milky Way model
VizieR, Zenodo ──(tools/deepspace/build_catalogues.ts)──▶ public/data/deepspace/<id>.v1.json.gz                            9 point catalogues, lazy
ESA/Hubble, ESA/Webb, ESO, SkyView/GALEX, Legacy Surveys ──(build_images.py)──▶ public/deepspace/img/*.webp + provenance.json   36 images, 3-4 levels each (130 files)

browser:  main.ts loads deep-space.v1.json + provenance.json ─▶ DeepSpaceData ─▶ viewer.attachDeepSpace ─▶ DeepSpaceLayer
   per frame:  Viewer.render:  governor ─▶ quality;  DeepSpaceLayer.update(camera, quality):  each sub-renderer places objects camera-relative
               (float64 minus camera, then float32), chooses marker / glow / image / members by apparent size, asks the asset manager for a texture level,
               returns screen info for picking, labels and the HUD
   click:      deep-space disc pick (only discs with draw weight above 0.05 are candidates; backdrop discs such as the 2MRS volume lose to real candidates; smaller disc wins)
               ─▶ DeepSpaceObject or catalogue row ─▶ inspectDeepObject / inspectPointRow ─▶ DOM
   Backspace:  Viewer.parentDeepTarget decides, DeepUi.goToParent applies (DeepUi owns the selection)
   GL context: webglcontextlost / webglcontextrestored ─▶ DeepSpaceLayer.onContextLost / onContextRestored ─▶ DeepSpaceAssetManager drops every lease and re-requests after restore
```
Discovery (details in `docs/DISCOVERY_ENGINE.md` and `docs/DISCOVERY_ENGINE_RUNTIME.md`):
```
VizieR I/311 + I/239, IAU WGSN, SIMBAD ──(tools/discovery/build_bright_stars.ts)──▶ public/data/bright-stars.v1.json.gz         8,942 Hipparcos stars
NASA Exoplanet Archive pscomppars ──(build_exoplanets.ts)──▶ public/data/exoplanets.v1.json.gz                                 6,470 planets, 4,862 hosts
SIMBAD, arXiv ──(build_other_objects.ts)──▶ public/data/other-objects.v1.json                                                  6 objects
tools/discovery/notes/*.json ──(build_notes.mjs)──▶ public/data/discovery-notes.v1.json, relations.v1.json                    69 notes, 5 curated relations

page thread                                   Web Worker (src/discovery/worker.ts)
  DiscoveryAtlas  ──── Promise calls ────▶      AtlasEngine: fetch 12 files in 3 stages, adapters, mergeRecords,
   record cache, notes, SavedStore,   ◀── results/status ──   SearchIndex (sliced ~8 ms), RecordStore, KD-tree, RelationGraph, facets, lists
   NavigationController ──▶ NavigationHost = ViewerNavigationHost ──▶ Viewer flights (flyToBody / flyToDeep / flyToPointPc / restoreCamera)
  ui/discovery  (search box, Discover drawer, nav line, inspector additions)  ◀──▶  DiscoveryAtlas public API only
  per frame: Viewer updates the Hipparcos star-pass layer and the marker layers (no discovery queries in the render loop)
```
- **Boundaries.** Pure core: nothing in `src/discovery` uses the DOM or Three.js (checked by search); only `worker.ts`, `workerClient.ts`, `createBrowserAtlas` and `HttpDataSource` touch browser APIs (`Worker`, `fetch`), so the engine runs unchanged in node tests through `InlineEngineClient` and a file-based data source. UI: `src/ui/discovery`, DOM only, no engine internals. Render: `src/render/discovery` plus the marker renderers, Three.js only, no search or ranking logic. The page boots without the engine; the engine starts after the first two frames in idle time and the older Gaia and deep-space search answers until its index exists.
- **Selection.** `main.ts` has one router, `selectById`, from a universal id to the existing selection paths (Gaia row, Solar System body, deep object, catalogue point) or the generic record inspector for `hip:`, `exo:`, `host:`, `other:` ids.
- **Frames.** Nearby and visible queries convert the origin into each domain's frame with `FrameTree.convert` (float64). Stars and deep objects live in the Sun-centred ICRS-aligned parsec frame, Solar System bodies in the metre-unit `solar-system` frame.

Nothing is requested from JPL, Gaia, SIMBAD or any archive at runtime.

## Spatial architecture
- A position is `(frame, offset)`; each frame's origin is stored in its parent's coordinates. `FrameTree.setOrigin` lets a frame follow a moving body without changing the hierarchy.
- `refit()` moves the viewer into a child frame only within 0.5 of the child radius and back to the parent only beyond 1.0 of the current radius (hysteresis).
- The camera state is float64 in parsecs. Star positions are subtracted from it in float64 and narrowed to float32; Solar System bodies are converted to metres first. A moon's position through the frames (`jupiter-system` to `stellar-neighbourhood`) matches the ephemeris to 1 part in 10⁹ (tested).
- Render passes in `Viewer.render()`, one camera orientation, separate near/far planes, depth cleared between them:
  1. deep space (parsec units, camera at the origin; near = `min(1e7, max(1e-6, 1e-3 x focus distance))`, far = 1e11 pc);
  2. Gaia stars and the Sun marker (1e-6 to 1e6 pc);
  3. the Solar System (metres; 1% of the focus distance to 1e15 m), only within 3000 AU of the Sun.
  The Gaia field fades out between 20 and 200 kpc from the Sun; extragalactic objects fade in between 120 and 1200 pc.
- Frame tree for deep space (`createUniverseFrames`, `src/data/catalogue/frames.ts`): `universe` (r 50 Gpc, visual extent) > `nearby-universe` (400 Mpc) > `local-group` (2 Mpc) > `milky-way` (50 kpc) > `stellar-neighbourhood` (10 kpc, Sun-centred). The three upper frames share the Galactic-centre anchor as origin; the Local Group frame is an anchor, not a barycentre. `FrameTree` allows one root, so `createStellarFrames` (Milky Way as root) is kept unchanged beside it. `SolarHierarchy` is built on the universe tree.
- Float64 limits found by tests (`tests/deepspace-frames.test.ts`): at 10 Mpc the float64 resolution is about 7e7 m, so a round trip through `nearby-universe` cannot be better than that; a point kept in its own deep frame is exact. Keep camera state in the deepest frame; narrow to float32 only after subtracting the camera.

## Data model
`src/data/schema.ts`: `Measurement` carries value, unit, uncertainty, `kind` (observed / derived / modelled / hypothetical), source, transformations and epoch. Missing quantities are absent and listed in `unavailable` with a reason. `CelestialObject` adds `facts` (each observed / inferred / hypothesis with a reference) and an `ImageryNote` stating how faithful the imagery is.

## Commands
| Command | Does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run verify` | typecheck, all tests, production build |
| `npm run data:import` / `data:rebuild` | Gaia and SIMBAD: live import / exact offline rebuild |
| `npm run data:solar` / `data:solar:offline` | Solar System from JPL and NAIF: live / exact offline rebuild |
| `npm run textures:build` / `textures:annotate` | fetch and downsample textures / recompute no-data fractions |
| `npm run data:objects` / `data:objects:offline` | deep-space named objects: live import / exact rebuild from cache |
| `npm run data:deepspace:catalogues` / `:offline` | the nine deep-space point catalogues: live / exact rebuild |
| `npm run deepspace:images`, `deepspace:images:report`, `credits:build` | build the image levels and provenance; regenerate the provenance document; regenerate `public/credits.html` |
| `npm run qa:browser`, `npm run qa:solar`, `npm run qa:deepspace` | real-browser checks (need a preview server and Playwright) |
| `npm run data:stars` / `data:stars:offline` | Hipparcos supplement: fetch (cached) / exact rebuild from `data/cache/discovery/stars` |
| `npm run data:exoplanets` / `data:exoplanets:offline` | NASA Exoplanet Archive composite table: fetch (cached) / exact rebuild |
| `npm run data:other` / `data:other:offline` | the six curated other objects |
| `npm run discovery:notes` | merge the authored notes and relations into `public/data/discovery-notes.v1.json` and `relations.v1.json` |
| `npm run qa:discovery-api`, `npm run qa:discovery-ui` | real-browser checks of the discovery engine and interface (preview server and Playwright; logs and screenshots in `docs/qa/discovery/`) |
| `npm run bench:spatial` | KD-tree vs grid vs brute-force benchmark on 500,000 synthetic points (about 70 s) |
| `npm run perf:deepspace` | deep-space measurements into `docs/qa/deepspace/perf.json` (software GL only; same prerequisites) |

## Known limits
- Orbits are low-accuracy models, validated against Horizons and documented; they are not ephemerides.
- No GPU timings exist: browser QA used software rendering.
- Picking stars is a CPU scan of about 35,000 stars; a spatial index is needed beyond a few hundred thousand. (Discovery queries do use a KD-tree; picking does not.) Deep-space picking is a CPU scan of screen discs (`core/deepspace/pick.ts`); the 2MRS layer offers 300 pickable points at a time (`pickCount`).
- Solar System textures are 2K at most; deep-space images have 3 or 4 WebP levels (256 to 4096 px) under a 192 MiB texture budget. A mobile and VR tier is prepared (resolution levels, lazy loading, byte-budget eviction, quality scale) but not built, and no GPU texture compression (KTX2/Basis) exists. Decoded `ImageBitmap`s are closed after upload, so after a WebGL context loss the deep-space textures are re-decoded rather than re-uploaded; this is tested by simulation only, and the Solar System `TextureManager` has no context-loss handling of its own (not audited).
- Extension points for deep space: a new object class is a `DeepSubRenderer` (`src/render/deep-space/types.ts`) registered through `EXTRA_RENDERER_FACTORIES` (`extraRenderers.ts`) or `DeepSpaceLayer.register`; new objects need an entry in `tools/deepspace/data/objects/roster.ts` and, for images, a manifest entry in `tools/deepspace/images/*.json`; a new point catalogue needs a file id with required columns (`validate.ts`) and a range in `CATALOGUE_RANGES`.
- Discovery engine: the worker cannot answer while it is inside a non-sliceable step (an adapter, `mergeRecords`, `RecordStore.from`: up to about 1 s during load); the page thread is not blocked. Further limits in `docs/DISCOVERY_ENGINE.md` section 18.
- The git history of this milestone is not committed.
