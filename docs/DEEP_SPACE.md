# Deep space: galaxies, nebulae, star clusters and large-scale structure

Prompt 06 (documentation re-derived 2026-11-13 from the files, test run and QA logs as they stand). This is the main document for everything beyond the Gaia star field and the Solar System. Where a number below comes from the code or the data, the file is named so it can be checked. Where something was not measured, it says so.

Companion documents: data sources and licences in `docs/SCIENTIFIC_DATA.md` section 13; generated per-object data in `docs/DEEP_SPACE_DATA_OBJECTS.md`; generated point-catalogue notes in `docs/DEEP_SPACE_DATA_CATALOGUES.md`; generated image provenance in `docs/DEEP_SPACE_IMAGE_PROVENANCE.md` (do not edit those three by hand); module map in `docs/ARCHITECTURE.md`; technique choices in `docs/RENDERING_STRATEGY.md`.

## 1. Purpose and honesty principles

The atlas shows where real things are, at the scale they are, and says how each picture was made. Deep space is where that is hardest, because almost nothing out there is known in three dimensions: a telescope image of a nebula or a galaxy is a flat picture, and the distance is a single number with an error bar.

Rules the code and data follow:

1. No fabricated numbers. A value that could not be retrieved is absent and listed with a reason (`unavailable` in each object; the table of omissions is in `docs/DEEP_SPACE_DATA_OBJECTS.md`).
2. Every measurement carries unit, kind (observed, derived, modelled), source and uncertainty when one is published. Derived values list their transformations and assumptions.
3. Distances keep their uncertainty. Distances from redshift are Hubble-flow estimates and are labelled so.
4. Every image is a real archive image with its exact archive id, the credit line as published, licence evidence copied from the archive, bands, and what we did to it (`public/deepspace/provenance.json`).
5. Each object states what its picture is (`representation`, section 3). Depth that is not measured is labelled illustrative, on screen, in the inspector and in the credits.
6. No star position is invented. Large-scale structure is observed galaxy positions only; no filaments, voids or cosmic web are drawn (section 8).
7. Nothing here was verified on a GPU (section 13).

## 2. Four-way separation

Four things are kept apart so that none can quietly change another.

| Layer | What it holds | Where |
|---|---|---|
| Metadata | Identity, classification, measurements with provenance | `src/data/deepspace/types.ts` (`DeepSpaceObject`), `public/data/deep-space.v1.json`, built by `tools/deepspace/build_objects.ts` |
| Spatial | ICRS RA/Dec plus a distance `Measurement`. The Cartesian position is derived on load, never stored as truth | `DeepSkyPosition` in `types.ts`; maths in `src/core/deepspace/geometry.ts`; frames in `src/data/catalogue/frames.ts` |
| Representation | What the drawn thing is: `representation.kind`, `depth`, `exaggerations`, and `imageAssetIds` | `Representation` in `types.ts`; image assets in `public/deepspace/provenance.json` (`DeepImageAsset`) |
| Rendering | Three.js drawing; reads the other three, owns no astronomy | `src/render/deep-space/*` |

Supporting pieces: pure policy (level of detail, picking, byte-budget cache, quality governor) in `src/core/deepspace/` (no Three.js, no DOM, unit-tested); data loading and validation in `src/data/deepspace/` (`deepSpaceData.ts`, `validate.ts`); the inspector model in `src/data/catalogue/inspect.ts` (`inspectDeepObject`, `inspectPointRow`); the UI in `src/ui/deepUi.ts`.

The renderers contain "visual" constants (sizes, opacities, tints, layer counts). They are grouped in blocks named `*_VISUAL` and are never presented as data.

## 3. Object classes and rendering strategy

The data file holds 27 objects: 10 galaxies, 8 nebulae, 6 star clusters, 3 groups (`public/data/deep-space.v1.json`). The roster's reflection nebula is NGC 1999 (`ngc-1999`), the only candidate for which a verifiable ESA/Hubble image with full metadata was found.

| Class | Objects | Strategy | Renderer |
|---|---|---|---|
| Milky Way | `milky-way` | Documented analytic model drawn as about 6500 large soft overlapping splats (none is a star) | `MilkyWayRenderer.ts`, `milkyWayModel.ts` |
| Galaxies with disc orientation | M31, M33, M81, LMC | Real image re-mapped onto the disc plane (deprojection), plus marker and glow at distance | `GalaxyRenderer.ts`, `galaxyGeometry.ts` |
| Galaxies without a usable orientation | SMC, M32, M87, Centaurus A, M104 | Real image as a flat sky-plane card facing the Sun, plus marker and glow. The SMC has no image in the atlas (section 4), so it is marker and glow only | `GalaxyRenderer.ts` |
| Nebulae | M42, M16, Carina, Crab, Ring, Horsehead, Veil, NGC 1999 | Multi-layer projection of the real image into 3 to 5 illustrative depth sheets | `NebulaRenderer.ts`, `nebulaGeometry.ts`, `nebulaShaders.ts` |
| Star clusters | Pleiades, Hyades, Omega Cen, M13, 47 Tuc, M4 | Real catalogued member stars as point sprites; glow under them | `StarClusterRenderer.ts`, `clusterGeometry.ts` |
| Galaxy groups | Local Group, M81 group, Virgo Cluster | Catalogue rows as soft markers, plus an illustrative boundary ring | `GalaxyClusterRenderer.ts` |
| Large-scale structure | 2MRS galaxy distribution | 43 533 galaxies as points, at cz/H0 | `CosmicStructureRenderer.ts` |

Every class also has the generic marker, glow, image/members progression of section 10.

### Representation vocabulary

Defined in `RepresentationKind` (`src/data/deepspace/types.ts`). Shown to the user as a badge ("Deprojected image", "Observed members", ...) with the object's `summary` text in the inspector.

| Kind | Meaning | Used by (in the data file today) |
|---|---|---|
| `observed-members` | Drawn points are catalogued objects at their catalogued positions | Pleiades, Hyades, Omega Cen, M13, 47 Tuc, M4; Local Group, M81 group, Virgo Cluster |
| `observed-image` | A real image placed on the sky; depth is not measured, so it is a flat card | SMC (no image shipped, so only marker and glow), M32, M87, Cen A, M104; all 8 nebulae (the nebula layers are added on top, see section 5) |
| `deprojected-image` | A real image re-mapped onto the disc plane using published position angle and inclination | M31, M33, M81, LMC |
| `documented-model` | An analytic model from the literature with cited parameters | Milky Way |
| `illustrative` | A visual aid built for this application; not a measurement | No object in the data file has this kind. It describes presentation aids that the renderers declare themselves: nebula depth layers, group boundary rings, the assumed depth of globular-cluster stars (those four objects carry the `depth` value `illustrative`, below) |

`depth` states how the third dimension is obtained, with the objects that carry each value in `public/data/deep-space.v1.json`:

| `depth` value | Objects |
|---|---|
| `measured-per-object` | Pleiades, Hyades (each member at its own parallax), Local Group, M81 group (catalogue rows with their own distances) |
| `measured-cluster-mean` | Virgo Cluster (every member drawn at the cluster-mean SBF distance, section 8) |
| `illustrative` | Omega Centauri, M13, 47 Tucanae, M4: sky positions are catalogued, each star's line-of-sight offset is a hash-seeded draw, not measured (section 6) |
| `published-orientation-model` | M31, M33, M81, LMC |
| `sky-plane-only` | SMC, M32, M87, Centaurus A, M104 |
| `illustrative-layers` | The 8 nebulae: the real image plus 3 to 5 brightness-split layers at assumed offsets (section 5) |
| `documented-model` | Milky Way |

Optional fields that were added to the contracts during the review pass (all optional, so older data still validates): `DeepSpaceObject.morphologyNote` and `morphologyClassBasis` (section 4); the `illustrative` value of `depth` (it was missing from the type); `DeepScreenInfo.pickable` and `PickCandidate.backdrop` / `slopPx` (section 10); `PointRowInfo.placement`, value `'cluster-mean'` (section 8).

## 4. Galaxies

### Classification
`classifyGalaxy` (`src/core/deepspace/classify.ts`) maps the catalogue's own morphology string to a coarse class used to choose a rendering strategy. The string itself is kept untouched (`morphologyLabel`) and shown beside the class. Rules:
- A label containing "pec" is `peculiar` and wins (Centaurus A, "S0pec").
- `E`, `cE`, `cD` are `elliptical`; `S0` and `S0/a` are `lenticular`.
- `SB` and `SAB` are `barred-spiral`; `SA` and `S` are `spiral`. Magellanic types follow the family letter (`SB(s)m` is barred-spiral, `Im` is irregular).
- `dE` and `dSph` are `dwarf-spheroidal`; `dIrr` is `dwarf-irregular`.
- Numeric T-types (RC3 scale) are accepted: no bar information, so spirals are `spiral`.
- Anything ambiguous or unrecognised throws a `ClassificationError`; the build then uses the next candidate string (HyperLEDA) and records that in the object's facts. M87's SIMBAD string "E-E/S0" could not be classified and HyperLEDA's was used.
- Consequence worth knowing: M104 (Sombrero) is `spiral` from the catalogue string "Sa", although it appears edge-on and has a prominent bulge. The Milky Way has no catalogue morphology string (we are inside it). Its label is the literature range "SBb - SBbc" (Kormendy 2019, arXiv:1810.10073) adopted by the Atlas; the data file says so in `morphologyNote` ("Not a catalogue string..."), the inspector shows it as "Morphology (literature range, adopted by the Atlas)", and the coarse class "barred-spiral" is derived from the single string `morphologyClassBasis` = "SBbc" (the upper end of the range, which `classifyGalaxy` can parse). `validate.ts` checks the class against that basis string.

### Deprojection method
For the four galaxies with a published inclination and position angle (`src/core/deepspace/geometry.ts`, `discPlaneBasis`, `discImagePlacement`):
- The disc plane contains the major axis (position angle PA east of north) and an in-plane minor axis `cos(i) p + s sin(i) u`, where `p` is the sky direction 90 degrees east of the major axis and `u` the line of sight.
- Every image pixel at sky offset (a along the major axis, b along `p`) is placed at `a * major + (b / cos i) * minorInPlane`. Seen from the Sun this projects back onto the original picture; the plane is therefore tilted rather than the image being altered.
- The disc is assumed thin and flat. Bulge, halo, dust above the plane and foreground stars are all mapped onto the plane. Nothing is measured about thickness.
- Deprojection is exact only up to `MAX_DEPROJECTION_INCLINATION_DEG = 80`, where the stretch is 1/cos(80) = 5.76 (`MAX_DEPROJECTION_STRETCH`); beyond it the stretch is capped and the placement is flagged not exact. Nearly edge-on galaxies are not deprojected.

| Galaxy | Inclination | Position angle | Stretch 1/cos i | Source of orientation |
|---|---|---|---|---|
| M31 | 72.17 deg | 35 deg | 3.27 | HyperLEDA |
| M33 | 55.01 deg | 22.67 deg | 1.74 | HyperLEDA |
| M81 | 62.71 deg | 157 deg | 2.18 | HyperLEDA |
| LMC | 25.05 +/- 0.55 deg | 150.76 +/- 0.073 deg | 1.10 | Inno et al. 2016 (classical Cepheids) |

Values are from `docs/DEEP_SPACE_DATA_OBJECTS.md`; the stretch column is arithmetic on them. HyperLEDA publishes no uncertainty for these angles.

### Approximation error
Placing a flat image on a tilted plane puts the far half of the disc farther than the distance `d` and the near half nearer. Seen from the Sun the picture is then not exactly the original. To first order the angular scale error at sky offset `b` from the major axis is `b tan(i) / d`. Evaluated here (arithmetic from that formula and the catalogue minor-axis size, not a measurement) at the minor-axis semi-axis of the catalogue D25 ellipse: M31 about 3.2 percent, M33 about 0.8 percent, M81 about 0.3 percent, LMC about 3.7 percent. The unit test `tests/deepspace-geometry.test.ts` ("deprojected image reproduces the sky image when viewed from the Sun") bounds the error and notes up to about 7 percent at 77 degrees for a 1.7 degree wide field. The error exists only for viewers at the Sun; from elsewhere the tilt is the intended geometry.

### Near-side ambiguity
The inclination fixes the tilt angle but not which edge of the disc is nearer. None of the sources retrieved states it, so `orientation.nearSide` is `unknown` for every galaxy in the data file. `discPlaneBasis` then picks a deterministic side (the side toward `p` is the far side) and sets `tiltDirectionIsAChoice`; the inspector and the object note say "illustrative tilt direction". If a sourced near side is added to the data, the geometry uses it without code changes.

### Milky Way documented model
`models["milky-way"]` in `public/data/deep-space.v1.json`; read by `readMilkyWayParams` (`src/render/deep-space/milkyWayModel.ts`), which looks parameters up by name and throws if one is missing rather than falling back to a made-up value.

| Component | Parameters used | Source |
|---|---|---|
| Sun-centre distance R0 | 8178 pc, uncertainty 25.6 pc (13 stat and 22 sys added in quadrature) | GRAVITY Collaboration 2019, A&A 625, L10 (arXiv:1904.05721) |
| Thin disc | scale length 2.6 kpc, scale height 300 pc, stellar mass 3.5e10 Msun | Bland-Hawthorn & Gerhard 2016, ARA&A 54, 529 (arXiv:1602.07702), recommended values |
| Thick disc | scale length 2.0 kpc, scale height 900 pc, mass 6e9 Msun | same |
| Boxy/peanut bulge | angle 27 deg, top axis ratio 0.5, edge-on axis ratio 0.26, vertical scale 180 pc, X-shape radius 1.5 kpc, mass taken as the mean of the VVV-region range 1.4e10 to 1.7e10 Msun | same |
| Long bar | angle mean of 28 and 33 deg, half-length 5 kpc, thin-bar height 180 pc, mass 7e9 Msun | same |
| Spiral arms | log-periodic fits to maser parallaxes: azimuth range, kink radius, pitch angles, widths per arm (7 rows), width law 336 pc at 8.15 kpc with slope 36 pc/kpc | Reid et al. 2019, ApJ 885, 131 (arXiv:1910.03357), Table 2 and Fig. 4 |

The file also stores other cited numbers that the renderer does not use (rotation speed, solar motion, nuclear disc, black hole mass, virial mass, local density). Parameters from different papers assume different R0 (8.15, 8.178, 8.2 kpc); they are listed separately and not rescaled.

What is not in the model, stated in its `limitations`: arms are young-tracer fits only, and drawn beyond the fitted azimuth range as extrapolation (the renderer extends them by 75 degrees at 0.45 of the intensity, and does not extend a 3 degree fit); the fourth Galactic quadrant has no maser parallaxes and rests on tangency priors; dust hides much of the disc and bulge from optical surveys so the far side is inferred; no warp, flare or individual star is included.

Visual choices that are ours, in the `VISUAL` block of `milkyWayModel.ts`: the visual outer edge of the disc (16 kpc, the model has scale lengths not a boundary), the long-bar width (axis ratio 0.16, the sources give length, angle and heights but not width), the bulge scale as 0.55 of the X radius, 34 percent of splats in arms, colours, and a view-dependent exposure gain computed per camera elevation. Splat positions are generated with a seeded PRNG (`seed: 20260511`), so the picture is reproducible. Equal mass-to-light is assumed between components.

The model fades in beyond 300 pc from the Sun and is fully on beyond 3000 pc (`MW_RENDER_VISUAL`); inside that the real Gaia stars are the truth.

### LMC and SMC
- LMC: `deprojected-image`, using the Cepheid-based inclination and position angle above. Its only image is GALEX near-ultraviolet (`lmc-galex-nuv`), which is therefore the default and is not visible light. The D25 position angle (170 deg, HyperLEDA) and the disc position angle (150.76 deg, Inno et al.) are different quantities from different tracers and are both kept.
- SMC: `observed-image`, `sky-plane-only`, **no image**. It is drawn as marker and glow of the catalogued extent, and the screen note reads "no image in the atlas: marker and catalogue extent only". Its depth structure is not measured.
- Withdrawn: two Gaia DR3 star-count maps made by us (`lmc-gaia-density`, `smc-gaia-density`) were the LMC's second image and the SMC's only image. They were removed on 2026-11-12 because the Gaia Users licence page says Gaia data are distributed under CC BY-NC 3.0 IGO, with separate terms for commercial use, and unrestricted redistribution could not be confirmed. Their WebP files are gone from `public/deepspace/img`, their entries are gone from `tools/deepspace/images/gaps.json`, and `provenance.json`, the credits page and the image provenance document no longer mention them. `tools/deepspace/make_gaia_density.py` still exists but nothing it writes is shipped. Restoring them needs a decision that the project is non-commercial plus re-adding the manifest entries (`public/deepspace/provenance.json` is rebuilt by `npm run deepspace:images`).

### Default band rule and why M31 defaults to ultraviolet
`defaultAssetId` (`src/render/deep-space/GalaxyRenderer.ts`): candidates are ordered visible-light assets first, then the rest in file order; the first one whose field covers at least half of the catalogue's major axis wins; if none does, the widest-covering one. The reason for the coverage condition: the M31 ESA/Hubble PHAT mosaic (`m31-phat-visible`) is a 58 x 18.5 arcmin strip of a 177.8 arcmin galaxy (33 percent), so it would show a thin stripe of a deprojected disc as the default. The first asset that covers enough is GALEX NUV (192 arcmin, 108 percent), so M31 opens in the near ultraviolet. The inspector says it is not visible light and the PHAT mosaic is one band button away (the browser QA switches to it and checks that the credit line follows). The LMC has one image, GALEX NUV, so the rule has nothing to choose between. The PHAT strip's position inside the M31 disc is covered by `tests/deepspace-phat-placement.test.ts`.

Known weakness: for M31 the default is an ultraviolet map and not a picture of what the eye would see. No image in the data set covers the whole galaxy in visible light.

## 5. Nebulae

### Method: multi-layer image projection
A real archive image has no depth. To let the viewer move around it without the picture collapsing into one card, the same texture is split by brightness (and, for emission nebulae only, 30 percent by red-blue colour) into N soft bands. Band k is drawn on its own sheet at a different distance from the Sun.

- N is 3 to 5 (`layerCountFor`: `round(2 + 3 * quality)`, clamped).
- Each sheet is the base sheet moved along the line of sight and scaled about the Sun by `(d + offset) / d` (a homothety). Seen from the Sun every sheet covers exactly the same piece of sky, so there is no visible change at the Sun's own viewpoint; away from that line of sight the sheets separate (parallax).
- Band weights are smooth hat functions that sum to exactly 1 for any pixel; each layer is `encode(colour) * weight` and the framebuffer is additive, so the sum of the sheets is the original image. `bandWeights` in `nebulaGeometry.ts` is the CPU mirror of the shader weights and is unit-tested.
- The band decision uses a blurred copy of the image (mip bias, about 2 percent of the image size) so bands are coherent structures, not pixel noise.
- One instanced draw per visible nebula (all layers share geometry, material and texture).

### Why not ray marching or a volume
There is no density field for any of these nebulae in the data. A ray-marched or voxel volume would have to invent one from a single projection; the result would look like a measurement and is not. Layer projection invents less: the sum of layers reproduces the image, the depth offsets are explicitly assumed, and the object is labelled. Section "Deep space" of `docs/RENDERING_STRATEGY.md` compares the techniques.

### What "illustrative depth" means
- The stack thickness is an assumed fraction of the image's transverse size by class (`NEBULA_VISUAL.thicknessFraction`: emission 0.35, reflection 0.25, dark 0.2, planetary 0.15, supernova remnant 0.2, molecular cloud 0.3). These are not measurements; they only keep the effect modest.
- The ordering of bands is a convention (brightest nearest) except for dark nebulae, where physics supports one ordering: a dark nebula is a silhouette against emission behind it, so the darkest band is placed nearest (`orderingFor`).
- The data file says the same thing as the screen: each nebula has `depth: illustrative-layers`; its `summary` describes the real image split by brightness into layers; its `exaggerations` list the layer count (3 to 5), the assumed thickness fraction for the class, the plain-convention layer order (the dark-nebula ordering above), and that the layers separate only when the camera leaves the line of sight. No text calls the nebula a "flat image only". The assumed values (thickness fractions, ordering, offsets) are display parameters, not data.
- The screen note says "illustrative depth layers — not a measured 3D structure" (`ILLUSTRATIVE_LABEL`). For planetary nebulae and supernova remnants it adds "an expanding shell shown as flat layers: no shell shape is implied". False-colour images add that the colours were assigned by the image makers.

### Edge-on limitation
The sheets are flat, so seen from the side the stack is a few thin lines. The layers are faded with the angle between the view direction and the sheet normal (floor 4 percent, full strength above facing 0.45) so a razor-thin stack is not mistaken for a thin nebula, and below facing 0.2 the note reads "seen edge-on: imagery has no depth data". There is no volume to show there, and none is invented. Viewed from behind the image plane the picture is a mirror image, which the note also says.

### Sub-region assets
An asset is placed by its own centre, field of view and orientation, not the object's catalogue position. An asset covering less than 60 percent of the catalogue major axis, or centred more than half a field-width away from the catalogue position, is labelled a sub-region (`subRegion`, shown in the note with the field size and offset). Examples in the data: the Webb "Cosmic Cliffs" (`carina-nebula-webb-cosmic-cliffs`, a 7.3 x 4.2 arcmin field of NGC 3324, which is about two degrees from the Carina core), the Eagle Nebula Pillars (three of its four images are 4 to 7 arcmin fields of an 80 arcmin object; the fourth is a 32 arcmin ESO field), and the two Veil Hubble fields (2.5 arcmin of a nebula about 3 degrees across). A sub-region is not the whole object.

Default nebula image: visible-light assets first, widest field wins, but the first listed within 10 percent of the widest is preferred (`defaultNebulaAssetId`). Dark nebulae and Orion have near-infrared alternatives (Hubble, VISTA, Webb) one band button away; each non-visible band is marked in the inspector.

### Nebula distances
Four nebulae (Orion, Horsehead, NGC 1999, Eagle) take their distance from Zucker et al. 2020 (VizieR J/A+A/633/A51), a 3D dust-extinction model built on Gaia DR2 parallaxes. The measurement kind is `modelled`, not observed, and the value is the distance to the dust cloud along a sightline, not to the nebula or its illuminating stars. The rule (ours, written into each measurement's `transformations` with every sightline listed): take all catalogued sightlines within 1.0 deg of the SIMBAD position; the value is the median of their d50; the uncertainty is sqrt((half the full range of the sightline medians)^2 + (median catalogue error)^2). The result is a descriptive scatter, not a confidence interval.

| Nebula | Distance | Sightlines within 1 deg |
|---|---|---|
| Orion Nebula (M42) | 418.5 +/- 30 pc | 4 (394 to 445 pc) |
| Horsehead | 431 +/- 21.7 pc | 2 (411 to 451 pc) |
| Eagle (M16) | 1690 +/- 54.7 pc | 2 (1640 to 1739 pc) |
| NGC 1999 | 438 +/- 21 pc | 1 |

NGC 1999 has one sightline, so no spread can be estimated; its 21 pc is that sightline's own error and probably understates the real scatter (the data says so). Derived physical sizes use these distances. For M42 the data keeps one small Gaia cross-check as a fact: in the app's own Gaia subset (not a complete sample) 3 stars with parallax 2.0 to 3.2 mas lie within 0.6 deg, median 1000/parallax = 400 pc, uncorrected for the parallax zero-point; it is not an independent measurement. Other nebula distances come from other papers: Carina 2.35 +/- 0.08 kpc (observed, Shull et al. 2021), Crab 1.9 +/- 0.2 kpc (observed, Lin et al. 2023), Veil 725 +/- 15 pc (observed, Fesen et al. 2021), Ring 782.5 +/- 30.3 pc (derived from a Gaia EDR3 geometric distance of its central star, Bailer-Jones et al. 2021).

## 6. Star clusters

- **Members are real.** Pleiades (1721 members) and Hyades (927) are the Hunt & Reffert 2023 Gaia DR3 membership lists; Omega Centauri, M13, 47 Tucanae and M4 use Vasiliev & Baumgardt 2021 members (Gaia EDR3), probability 0.9 or higher, and if more than 20 000 pass only the 20 000 brightest by G are kept. Nothing is generated: one drawn sprite per catalogue row (`buildMembers`, `clusterGeometry.ts`).
- **Open clusters**: each member is placed at its own parallax distance (1000/parallax pc). A missing or non-positive parallax falls back to the cluster mean and is counted. For faint members the parallax error can approach the cluster depth, so line-of-sight scatter of the faintest stars is partly measurement noise (stated in the file's caveats).
- **Globular clusters: depth is an assumption, and the data says so.** The four objects have `depth: illustrative` (they used to read `measured-cluster-mean`); their `summary` and `exaggerations`, the `members-*` file caveats and the member-row inspector text all state that sky positions are catalogued and the line-of-sight offset of each star is a seeded draw, not a measurement. Per-star parallaxes (about 0.1 to 0.2 mas against errors of 0.02 to 0.3 mas plus a zero-point) cannot place stars in depth. Positions on the sky are catalogued; the line-of-sight offset of each star is a deterministic draw from a Plummer sphere whose scale radius equals the catalogued projected half-light radius (`assumedGlobularDepthPc`, keyed by a hash of the Gaia source id, so it is the same every run). This is declared illustrative; it is not data. The cluster distance itself is the Baumgardt & Vasiliev 2021 value with its uncertainty.
- **Missing bright stars.** Brightest member in the Pleiades file is G = 3.6158; Alcyone and Merope are absent. The Hyades file's brightest is G = 3.2805. A star appears only if it is in the Gaia-based membership catalogue (very bright stars have poor or no Gaia astrometry). The 47 Tuc, Omega Cen, M13 and M4 files are cut at the 20 000 brightest, with faintest G of 17.63, 17.43, 19.85 and 19.63 respectively (values per file manifest), so crowded cores look sparse in faint stars and the sample is biased to giants and horizontal-branch stars.
- **Cluster diameters.** A physical diameter is derived as 2 d tan(theta/2) from an angular size whose definition is stored with it: the Hunt & Reffert half-number radius for the open clusters, and for the globulars the Harris 2010 `Rh`, which the VizieR column text calls the half-mass radius (it is a different quantity from Baumgardt's projected half-light radius used for the star-depth draw; the two are not reconciled). The six diameters carry no uncertainty: a membership-defined size has no published error, and the distance error alone would be a misleadingly small error bar; the measurement's `transformations` say so.
- A soft glow of the catalogued extent stays under the member stars (weight 0.4) for the unresolved light. A density cap keeps additive blending from turning a globular core into a white blob (`CLUSTER_VISUAL.targetCoverage`, exposure lowers opacity and lifts the faint magnitude limit); this is a display choice.
- Only 47 Tucanae has an image (VISTA near-infrared, ESO eso1302a). The other five clusters have no image.

## 7. Spatial integration

### Frame tree
`createUniverseFrames()` in `src/data/catalogue/frames.ts`:

```
universe (r 50 Gpc, visual extent)
 └ nearby-universe (r 400 Mpc)
    └ local-group (r 2 Mpc)
       └ milky-way (r 50 kpc)
          └ stellar-neighbourhood (r 10 kpc, Sun-centred)
```

All frames are ICRS-aligned, metres, float64. `createStellarFrames()` (Milky Way as root) is unchanged; `FrameTree` still allows only one root, which is why the universe tree is a separate builder. `SolarHierarchy` (`src/render/solar/hierarchy.ts`) is built on the universe frames; its `locate()` drives the breadcrumb ("Universe > Nearby universe > Local Group > Milky Way > Stellar neighbourhood > Solar System ..."). Frame hand-off uses `refit()` with hysteresis: enter at 0.5 of a child's radius, leave at 1.0 of the current radius.

### Anchors, not barycentres
The `local-group` frame is an anchor at the Galactic-centre direction, not the Local Group barycentre (which is poorly defined and for which no value is encoded). `milky-way`, `local-group` and `nearby-universe` therefore share one origin, so a position inside the Milky Way never passes through a large number when moved up or down the chain. Separately, the Local Group's boundary ring is centred on the midpoint of the Milky Way centre and M31, labelled illustrative because the group has no catalogued position (`GROUP_EXTENT_PC` in `clusterGeometry.ts`).

### Floating origin and float64 limits (found by tests)
Camera state is float64 parsecs (`OrbitState`; maximum distance 6e8 pc, `ORBIT_LIMITS`). Each deep-space object's position is `objectPc - cameraPc` computed in float64 and narrowed to float32 after the subtraction; the three.js camera sits at the origin. Limits found in `tests/deepspace-frames.test.ts`:
- A point 1 AU from a star at 10 Mpc, kept in that star's own frame, is exact. Converted up to `nearby-universe` and back it is limited by the float64 resolution of 3e23 m, which is above 1e7 m (about 7e7 m); the test asserts the resolution exceeds 10 000 km, so a one-kilometre round trip through the nearby-universe frame is impossible. Routing through the root adds nothing beyond that magnitude.
- A point 1 AU from the Sun converted to the Local Group frame and back is within 4 float64 ulps at 8178 pc (tens of km) and exact if kept in the neighbourhood frame.
- Rule that follows: keep camera and local geometry in the deepest frame that contains them; do not sum offsets through the root.

### Camera-relative narrowing and passes
Per frame, `Viewer.render()` draws pass 1 deep space (parsec units, camera at origin, `near = min(1e7, max(1e-6, 1e-3 * focusDistance))`, `far = 1e11` pc), clears depth, pass 2 Gaia stars and the Sun marker, then pass 3 the Solar System (metres) within 3000 AU. The Gaia star field fades out between 20 kpc and 200 kpc from the Sun (`starFieldFade`); extragalactic objects fade in between 120 pc and 1200 pc (`FAR_FADE_FROM_PC`, `FAR_FADE_TO_PC`). Image and glow sprites are drawn without a depth test, so the near/far range decides clipping, not sorting.

## 8. Large-scale structure

### Datasets
| Dataset | What it is | Rows in file |
|---|---|---|
| McConnachie 2012 (`local-group-mcconnachie`) | Compilation of the observed properties of galaxies in and around the Local Group (VizieR J/AJ/144/4) | 101 (of 102 table rows; "The Galaxy" dropped because it has no distance from itself) |
| Updated Nearby Galaxy Catalog (`ungc`) | Karachentsev, Makarov & Kaisina 2013: galaxies of the Local Volume, within about 11 Mpc with a few velocity-based entries farther (maximum 26.2 Mpc) | 869 |
| 2MASS Redshift Survey (`twomrs`) | Huchra et al. 2012: galaxies with redshifts, complete to extinction-corrected Ks < 11.75 | 43 533 of 44 599 rows (1 066 without a redshift dropped); cz from -300 to 51 864 km/s |

Sources, retrieval dates and licence notes are in `docs/SCIENTIFIC_DATA.md` section 13.

### Selection effects
- **Flux limit.** 2MRS is complete only to Ks < 11.75. The number density of points falls with distance; this is selection, not structure, and only luminous galaxies are seen far away. The on-screen note says so.
- **Zone of Avoidance.** The Milky Way plane (roughly |b| < 5 degrees, wider toward the bulge) obscures galaxies. The empty band in the 2MRS map is a selection effect, not a void.
- **Fingers of God.** Distance comes from redshift, d = cz/H0, which includes peculiar velocities of hundreds of km/s, more in clusters. Clusters appear stretched along the line of sight.
- **H0.** Application choice of 70 km/s/Mpc (`APPLICATION_H0_KM_S_MPC` in `clusterGeometry.ts`), not a catalogue value and not a measurement; its systematic uncertainty is of order 10 percent. Distance is not stored in the file; only cz is.
- **How deep the 2MRS layer goes (measured from `twomrs.v1.json.gz`, d = cz / 70).** The 43 107 rows with cz >= 1000 km/s are placed. Their median distance is 121 Mpc; 18 987 (44 percent) lie beyond 130 Mpc, 60 beyond 400 Mpc (the radius of the `nearby-universe` frame) and 3 beyond 600 Mpc (637, 678 and 741 Mpc, the farthest). All placed rows are drawn: `CosmicStructureRenderer.ts` has no distance cut. The orbit camera can be at most 600 Mpc from its focus (`ORBIT_LIMITS.maxDistance = 6e8` pc) and the structure's own viewing distance is 500 Mpc, so from a Sun-centred view a galaxy beyond the camera's distance on the camera's side is behind the camera, and the three farthest can only be seen from the opposite side. Distant rows are the luminous ones (flux limit). The comment above `ORBIT_LIMITS` in `src/render/orbitCamera.ts` still says the sample "reaches ~130 Mpc"; that is wrong and was left unchanged because source files were outside this documentation pass.
- Rows with cz below 1000 km/s (`MIN_CZ_FOR_HUBBLE_KMS`, about 14 Mpc) are not placed by cz: peculiar velocity is a large fraction of cz there (426 rows are below 1000 km/s, 25 of them with negative cz, for example M31 at -300 km/s). They are not drawn by the structure layer and are counted in its note; nearby galaxies come from UNGC and McConnachie, which have real distances.
- UNGC and McConnachie are compilations, not complete surveys. UNGC publishes no uncertainty on the adopted distance; `distErrMpc` is filled for 299 rows only where a single matching distance-modulus measurement exists (our first-order propagation). Distance methods `mem`, `h`, `h'`, `txt` are not independent measurements for that galaxy.
- Virgo Cluster: 203 galaxies, the 2MRS rows within 6 degrees of M87 with -500 <= cz <= 2500 km/s (constants `CONE_DEG`, `CZ_MIN`, `CZ_MAX` in `tools/deepspace/build_objects.ts`). The window brackets the cluster's mean velocity (about 1100 km/s, dispersion of order 600 to 700 km/s) roughly symmetrically; the earlier lower bound of 0 removed the blueshifted members, and the window now includes M86, M90 and M98. The cut is ours, not a published membership; it includes foreground and background galaxies (the W' cloud near 23 Mpc, for example). At close range they are drawn at the cluster-mean distance (Mei et al. 2007, 16.5 +/- 1.105 Mpc) so the line-of-sight stretch is removed; between 30 Mpc and 120 Mpc camera distance (`VIRGO_BLEND`) they cross-fade to their cz/H0 positions. A galaxy that is also an image galaxy in the data file is skipped in the point layers (`isImageGalaxyDuplicate`). Screen ids: Virgo rows use `virgo:<row>` (`VIRGO_ROW_NS`) so they never collide with 2MRS cloud picks `twomrs:<row>`; a Virgo row still reports file `twomrs` and `placement: 'cluster-mean'`, and the inspector says it is drawn at the cluster-mean distance. `DeepSpaceLayer` keeps the first of any duplicate screen id and counts the rest (`duplicateIds`); the browser QA found 202 `virgo:` ids, 40 cloud ids at that moment and 0 duplicates. Known gap: "Fly to this entry" on a Virgo or 2MRS row does nothing, because `pointPosition` has no distance for `twomrs` rows; Inspect works.
- The M81 group is M81 plus the UNGC rows with main disturber M81 and tidal index Theta_1 > 0, the definition printed in the UNGC paper.

### Why no filaments, voids or cosmic web are drawn
Nothing in the data contains them. A filament or void is a statement about a density field, and the 2MRS points are a flux-limited, redshift-space sample with a Zone of Avoidance. Drawing a web through them would present an interpretation as an observation. The structure note says "No filaments, voids or density surfaces are drawn: none exists in the data, and empty regions are NOT voids" (`COSMIC_NOT_DRAWN`).

What would be needed to draw one honestly: a deeper and more complete spectroscopic survey (for example DESI or SDSS, not integrated), a stated method that corrects for the flux limit and the Zone of Avoidance (or a published peculiar-velocity-based reconstruction of the density field), uncertainty on the result, and a label "derived" with the method and parameters beside it.

## 9. Images and provenance

36 image assets, 130 WebP files, 41.7 MB (40 MiB by `du`) in `public/deepspace/img`, each with 3 or 4 levels (longest side 256, 1024, 2048, 4096 px, never upscaled; WebP quality 80; `tools/deepspace/build_images.py`). By archive (counted from `public/deepspace/provenance.json`): ESA/Hubble 13, ESA/Webb 6, ESO 7 (CC BY 4.0 per their copyright pages), NASA SkyView GALEX tiles 9 (public domain per the SkyView survey description), the Legacy Surveys cutout service 1 (CC BY 4.0 with a fixed credit line). The full table with verbatim credits and licence evidence is `docs/DEEP_SPACE_IMAGE_PROVENANCE.md`; a static page `public/credits.html` (36 entries) is generated by `npm run credits:build` and linked from the image-credits popover ("All image credits and licences"). The two Gaia star-count maps that made it 38 are withdrawn (section 4).

Licence re-verification (2026-11-12): the seven assets that earlier carried only the site-wide ESA/ESO licence sentence (`47-tucanae-vista-ir`, `cen-a-eso-multiband`, `cen-a-eso-wfi`, `m31-phat-visible`, `m33-vst-visible`, `m81-hubble-acs`, `m104-hubble-acs-mosaic`) were checked against each image's own archive page (HTTP 200). None shows a non-commercial, third-party-copyright or no-redistribution notice; each page links the site usage page, and the credit line on the page equals the stored one. The evidence text now quotes the usage page's licence sentence and its credit-line answer, names the image page and gives the date. The one weakest case is `cen-a-eso-multiband`, whose credit names third parties (MPIfR/APEX, NASA/CXC); the ESO page attaches no separate rights notice to them and the usage page says images are cleared for reuse unless stated otherwise, so it was accepted with the third-party names kept in the credit. The ESO licence URL is now the one the ESO pages link (`https://www.eso.org/public/outreach/copyright/`). Two credit strings were corrected to the page text (Orion VISTA acknowledgment; the apostrophe in "O'Dell"). The ESA/ESO "unless specifically noted" clause means this holds as of that date only. The credit-line comparison was run for the 26 ESA/Hubble, ESA/Webb and ESO pages; the 9 GALEX assets and the Legacy Surveys cutout have no such credit block and were not put through it (the Legacy Surveys acknowledgment page was re-read and shows CC BY 4.0; the SkyView "Public domain" sentence was not re-read).

Images the roster wanted but that are not in the data: no image for Pleiades, Hyades, Omega Cen, M13 and M4 (members are drawn), none for the Local Group, M81 group or Virgo, and none for the SMC after the Gaia maps were withdrawn. Higher-fidelity images for the SMC, M32 and M87 are open (M32 has only GALEX NUV, M87 a Legacy Surveys cutout 17 arcmin wide and GALEX).

Rules applied to every image: exact archive id, credit verbatim, geometry (field of view, centre, up angle) from the archive or the FITS header and flagged by `wcsSource`, bands and false-colour flags, and a plain "how to read the colours" note. Non-visible bands are never presented as how the object would look. The inspector computes this per filter (`nonVisibleContent` in `src/data/catalogue/inspect.ts`): each listed filter is classified as UV, near-IR, mid-IR, far-IR/submm or X-ray. An image with no visible filter says "contains no visible light"; a mixed image says "includes ..." (for example the Crab Webb image, the Centaurus A multi-band composite, and the near-infrared channels of the PHAT, Hubble ACS, Orion mosaic and Legacy Surveys images). A test (`tests/deepspace-honesty-fixes.test.ts`) walks every asset in `provenance.json`.

## 10. Level of detail

### Representations and thresholds
`src/core/deepspace/lod.ts` (pure):
- Four levels: 0 point, 1 sprite (glow), 2 image, 3 detail (members, model).
- `LEVEL_UP_PX = [6, 48, 600]`: apparent diameter in CSS px at which the next level takes over going up.
- Hysteresis: a level is kept going down until the size falls below `DOWN_FACTOR = 0.75` of the threshold that entered it. The discrete level decides which resources load.
- Cross-fade: opacity follows a continuous level, a log-space smoothstep over `[threshold / 1.5, threshold * 1.5]` (`FADE_FACTOR = 1.5`). Because `DOWN_FACTOR` (0.75) exceeds `1 / FADE_FACTOR` (0.667), the discrete level is always one of the two cross-faded levels (tested).
- An object with unknown physical size cannot go beyond level 1. The camera inside an object's extent forces level 3 (the Milky Way from the Sun).
- `src/render/deep-space/DeepSpaceLOD.ts` adapts this to the three stages marker, glow, image (weights add to 1).

### Texture levels and the asset cache
`DeepSpaceAssetManager.ts` over `src/core/deepspace/assetCache.ts`:
- Level 0 (a thumbnail of at most 256 px) is held for every wanted asset (glow tint, exposure statistics). `selectTextureLevel` picks the smallest level at least `onScreenPx * devicePixelRatio * quality` px.
- Upgrades load in the background while the lower level stays on screen; at most one big texture is activated per frame; downgrades wait `DOWNGRADE_HOLD_S = 2.5` s; an asset not wanted for `IDLE_TTL_S = 4` s releases all leases.
- Byte budget `DEFAULT_BUDGET_BYTES = 192 * 1024 * 1024` (192 MiB). GPU size is estimated as `width * height * 4 * 1.33` (RGBA plus mip chain), not read from the driver. Unreferenced textures are evicted least-recently-used first; referenced ones are never freed, so the cache can exceed the budget and then reports `overBudget` rather than freeing something in use. Concurrent requests for one level share one load; if every requester gives up, the load is aborted and a late arrival is disposed, never cached.
- Textures are sRGB, mipmapped (`LinearMipmapLinearFilter`), anisotropy up to 8, decoded with `createImageBitmap`. The decoded bitmap is closed after its first upload, and also on abort after decode, on a failed texture creation, and when a texture is evicted or cancelled before its first upload (a leak found in review).
- WebGL context loss: `Viewer` listens for `webglcontextlost` and `webglcontextrestored` and calls `DeepSpaceLayer.onContextLost` / `onContextRestored`. Because closed bitmaps cannot be uploaded again, the asset manager then drops every lease and load (`invalidateAll`), disposes and closes everything, hands out no views while lost, and after restore re-decodes through the normal request path. Tested only by simulation (`WEBGL_lose_context` in software-GL Chromium and a fake decoder in `tests/deepspace-render-assets.test.ts`); no real context loss on a GPU has been observed.
- Picking: a screen disc is only a pick candidate when its draw weight is above `MIN_PICKABLE_DRAW_WEIGHT = 0.05` (`DeepScreenInfo.pickable`), so a galaxy that is faded out near the Sun cannot be clicked. The 2MRS survey disc and the group/cluster ring discs are `backdrop` candidates, the lowest tier: they are picked only when no real candidate is hit or within the slop radius, and the 2MRS disc has no slop of its own.

### Lazy point catalogues
`pointCatalogues.ts`: nothing is fetched until the camera is in range. `CATALOGUE_RANGES` (camera distance from the Sun): McConnachie 50 kpc to 40 Mpc, UNGC 500 kpc to 300 Mpc, 2MRS beyond 3 Mpc. Member files are wanted within 30 cluster diameters (`MEMBERS_RANGE_DIAMETERS`). At most 2 concurrent fetches, a 96 MiB store budget, release after 20 s unused, retry a failed load after 30 s.

### Quality governor
`QualityGovernor` (`lod.ts`): exponential average of frame time, dead band of 15 percent around the target, multiplicative drop of 3 percent per update while over budget, additive recovery of 0.002 per update while under (about 15 times slower), a single hitch clamped to twice the target, floor 0.25. `main.ts` enables it with a 1000/30 ms target (`Viewer.enableQualityGovernor`); it sets `DeepSpaceLayer.setQuality` (clamped 0.25 to 1). The quality scale reduces: Milky Way splat count (a representative prefix), nebula layer count (5 to 3), cluster member and 2MRS point counts (fraction down to 0.3, most luminous first), and texture resolution. The governor reacts to whatever frame times it is fed; it has not been tuned on real hardware.

## 11. Performance

Decisions: one instanced draw per nebula; one shared instanced draw for all galaxy and group markers and glows; one points draw per cluster and for the 2MRS cloud; the 2MRS camera-relative buffer is rebuilt only when the camera has moved more than a fraction of the nearest galaxy's distance (`rebuildFraction`); objects off screen cost no mesh and no texture request; picking is a CPU scan of screen discs (`core/deepspace/pick.ts`: backdrop discs are the lowest tier; otherwise inside beats near, smaller on-screen disc wins, then priority, closeness, id).

All figures below are software GL only (headless Chromium, SwiftShader on the CPU, 1280 x 800, quality governor disabled unless stated). **There are no GPU timings; none of this is a GPU performance claim.** Draw calls, texture bytes and texture counts are exact counts; frame rates describe the CPU renderer.

Browser QA run, `docs/qa/deepspace/qa-log.json`, 2026-11-12T23:11Z:
- 129 checks, 129 pass; the `warnings`, `notRun` and `problems` lists are empty.
- Time from navigation until the deep-space UI was ready: 1658 ms (`loadMs`). Frame rate 11.7 fps (a warning threshold only).
- Peak texture memory 53 614 700 bytes (51.1 MiB) against the 192 MiB budget; `overBudget` stayed false. End-of-run layer stats: 4 draw calls, 3 textures, 95 points, quality 1.
- Approach sweeps (M31, Orion, Pleiades): largest d(ln size)/d(ln distance) 1.00, 1.04 and 1.00; largest step in mean luminance of the object window 48 percent (M31, glow to glow), 47 percent (Orion, glow to image level 0) and 42 percent (Pleiades hand-off), against the 50 percent limit of the check. The margin is small. The Orion sweep, which failed an earlier run (a 4 px dip in apparent size at the glow-to-image hand-off, never diagnosed), passes in this run.
- With the governor on at default settings the HUD showed quality 25 percent ("lowering detail: frames take 86 ms, target 33 ms"). That is the CPU renderer being slow, and shows only that the governor reacts to the frame times it is given.

Performance run, `docs/qa/deepspace/perf.json`, 2026-11-12T23:29Z, `tools/perf-deepspace.mjs` (section 14):

| Scene | fps | Median frame ms | Draw calls (deep layer) | Layer textures (MB) | Points drawn | JS heap MB |
|---|---|---|---|---|---|---|
| Start view, 60 pc, Gaia | 13.6 | 62 | 2 (0) | 0 (0) | 46 | 56 |
| M31 image (image-L1) | 13.0 | 74 | 5 (4) | 4 (6.2) | 95 | 53 |
| Orion Nebula image (image-L1) | 7.6 | 126 | 6 (4) | 9 (12.7) | 83 | 51 |
| Pleiades members | 12.3 | 60 | 4 (2) | 1 (0.3) | 1767 | 42 |
| Omega Centauri members | 4.3 | 267 | 7 (5) | 2 (0.5) | 26 546 | 53 |
| Local Group, 3 Mpc view | 4.2 | 216 | 7 (6) | 5 (1.5) | 43 352 | 69 |
| 2MRS at 100 Mpc | 6.1 | 156 | 5 (4) | 0 (0) | 44 141 | 56 |
| Milky Way from 30 kpc | 0.8 | 1558 | 8 (6) | 1 (0.3) | 6559 | 50 |

- Catalogue loads (milliseconds in the store, `loadMs`): Pleiades 69, Hyades 70, McConnachie 77, UNGC 78, Omega Cen 588, 2MRS 761. Transfer sizes: Omega Cen 699 KB (2.5 MB decoded), 2MRS 1349 KB (3.7 MB decoded).
- Disposal loop (fly to all 27 objects, 3 loops): peak texture memory 64 091 948 bytes (61.1 MiB), peak GPU textures 17, no growth across loops (created 165, disposed 161 after loop 3). After the camera flew away, 5 layer textures with no references were still held at 2, 10 and 20 s and none at 35 s; GPU texture count stayed at the baseline of 0. The performance run and the QA run use different flight paths, which is why their peak memory differs.
- No console errors or warnings in either run, apart from the counted "stale handle" deletes: after the simulated context restore Chromium logs a few "delete: object does not belong to this context" warnings (4 in the last run, `staleHandleDeleteWarnings`), from three.js deleting handles from before the loss. They are counted and reported, not failed; the exact object was not pinned down.

Not measured: GPU frame times, GPU memory, memory on mobile, time to first texture on a slow network, behaviour with the governor active on real hardware, a real (not simulated) context loss.

## 12. Testing

Unit tests (Vitest), measured with `npx vitest run` on 2026-11-13: **29 files, 661 tests, all passing**. `npm run verify` (typecheck, tests, build) is clean. Of these, 18 files (359 tests) are `tests/deepspace-*.test.ts`; the other 11 files hold the 302 tests of the Prompt 05 state. Deep-space files and their test counts:
- `deepspace-geometry` (32): physical size and its error propagation, distance modulus, redshift distance, sky to Cartesian, sky-plane and disc-plane bases, deprojection reproducing the sky image.
- `deepspace-lod` (19), `deepspace-pick` (14), `deepspace-cache` (10): level selection and hysteresis, texture level, governor behaviour, pick rules including the backdrop tier and the pickable weight, cache budget, reference counting, abort and disposal.
- `deepspace-classify` (87): morphology and type classification, including refusals.
- `deepspace-data` (31): validation of the objects file (class matches `classifyGalaxy` or `morphologyClassBasis`, derived measurements need transformations, deprojected images need an orientation, every image id resolves), of the image provenance (licence evidence present, level 0 at most 256 px, https sources, sha256 format) and of the point catalogues, plus `DeepSpaceData` lookups; the shipped files are validated together.
- `deepspace-frames` (13): the universe frame tree, the float64 precision limits (section 7), breadcrumb and hysteresis.
- `deepspace-inspect` (21), `deepspace-inspect-ui` (7): inspector content for objects and catalogue rows, wavelength explanations, search, scale text.
- `deepspace-honesty-fixes` (11): the review fixes: globular depth label and caveats, Orion-region distances (modelled, median over sightlines, spread in the uncertainty), the Virgo window with M86/M90/M98, the Milky Way morphology note, nebula representation text, cluster diameters without a distance-only error bar, the non-visible-light warning for every asset in `provenance.json`, and the Virgo row inspector text.
- `deepspace-phat-placement` (2): the M31 PHAT strip placement.
- `deepspace-render-*` (assets 14, layer 11, lod 14, model 13, nebula 20, structure 30, structure-data 10): asset manager with a fake decoder (bitmap closing, abort, context loss and restore), layer composition (duplicate ids, pickable), LOD adapter and default band, Milky Way model sampling, nebula geometry (bands sum to 1, layer offsets, edge-on fade), cluster member placement and the assumed globular depth, cz/H0, duplicate suppression, lazy point store, caveat text, group extents checked against the data files.
Three.js needs no GPU for the pure parts, and the layers' `update()` runs headlessly in tests.

Browser QA (`tools/qa-deepspace.mjs`, 129 checks, Playwright, Chromium with SwiftShader): the last recorded run, `docs/qa/deepspace/qa-log.json` (2026-11-12T23:11Z), passes all 129 with no warnings. It covers the start view, the four scale shortcuts (M, L, U, H), breadcrumb text at the Milky Way scale, the 2MRS caveat appearing and disappearing with the structure layer, flights to and inspection of M31, M87, LMC, Orion, Carina, Horsehead, NGC 1999, Pleiades, Omega Centauri, the Local Group and the M81 group (badge, distance with uncertainty, no blank values, credit line of the drawn image, band switching, non-visible band notice), a real mouse click selecting M31, a catalogue point inspector, search by designation, approach sweeps (size and brightness continuity), the real Backspace key (M31 to the Local Group with selection, inspector and highlight agreeing, then a scale flight with nothing selected), separate id namespaces for Virgo rows and cloud picks, a simulated context loss and restore (`WEBGL_lose_context`: the viewer sees it, the asset manager drops every texture, the render loop keeps running), the 192 MiB budget, the HUD stats, the static credits page (36 entries) and a clean console. `npm run qa:browser` (26 checks, stars) and `npm run qa:solar` (43 checks) were last run during the review fixes on 2026-11-12 and passed; they were not re-run for this documentation pass.

Screenshots: the last QA run wrote 23 (`01-start-view.png` to `23-after-simulated-context-restore.png`, listed in `qa-log.json`). The directory `docs/qa/deepspace/` holds exactly these 23 PNG files (stale ones from earlier runs were deleted).

What was NOT verified: any GPU (software GL only); real context loss; browsers other than Chromium; mobile devices, touch input and small screens; WebXR (not built); accessibility beyond the text labels; long sessions for memory growth.

## 13. Limitations

- No object is known in three dimensions except the Milky Way model (itself a literature model) and clusters/groups placed by catalogue parallax or redshift. Flat images stay flat.
- Nebula depth (`illustrative-layers`), globular-cluster star depth (`illustrative`), group boundary rings and the tilt direction of deprojected discs are illustrative.
- Deprojected discs assume a thin flat plane; first-order scale error up to a few percent at the disc edge when seen from the Sun (section 4).
- M31's default image is ultraviolet (GALEX NUV); no whole-galaxy visible-light image of M31 is included.
- Image gaps: the SMC has no image (the Gaia maps were withdrawn); M32 has only GALEX NUV; M87 has a 17 arcmin Legacy Surveys cutout and GALEX; no images for the Pleiades, Hyades, Omega Cen, M13, M4 or the groups.
- Many images are false colour or multi-band composites; this is flagged per image, with a per-filter non-visible-light warning.
- Hubble, Webb and ESO images are sub-regions for several nebulae (Cosmic Cliffs, Eagle Pillars, Veil sections).
- The globular-cluster files hold the brightest 20 000 members only.
- Distances of Orion, Horsehead, Eagle and NGC 1999 are modelled dust-cloud distances (Zucker et al. 2020), median over sightlines within 1 deg, with the spread in the uncertainty; NGC 1999 has one sightline and its error bar probably understates the scatter. They are not distances to the illuminating stars.
- The Virgo membership cut (-500 to 2500 km/s within 6 deg of M87) is ours; 2MRS distances are Hubble-flow with H0 = 70; the 2MRS sample reaches 741 Mpc but the camera is limited to 600 Mpc from its focus (section 8); the nearby-universe layer has no filaments or voids by design.
- NED-D distances used for M87 and M81 come from the April 2020 release (v17.1.2); later measurements are not in it.
- **Licence flags.** The Gaia statements disagree (open with credit; CC BY-NC 3.0 IGO on the Users page; CC BY-SA 3.0 IGO in the cluster-member manifests; section 13.2 of `docs/SCIENTIFIC_DATA.md`). The two Gaia-derived images were withdrawn for this reason, but the 35 325-star Gaia subset and the cluster-member point catalogues remain Gaia-derived with the same open question. The ESA/ESO re-verification of 2026-11-12 is described in section 9. The project is a prototype and has not been cleared for public release.
- The reflection nebula is NGC 1999 and the Pleiades nebulosity is not shown.
- No GPU timings exist. Context loss and restore were only simulated. The Solar System `TextureManager` has no context-loss handling of its own and was not audited.
- **KTX2 / Basis texture compression is not implemented**; no mobile or VR tier, no WebXR.
- The adaptive quality governor is wired and unit-tested but untuned on real hardware.
- Known interface gap: "Fly to this entry" on a Virgo or 2MRS catalogue row does nothing (section 8).
- Known code-comment error: `src/render/orbitCamera.ts` says 2MRS "reaches ~130 Mpc" (section 8).

## 14. Rebuilding data and images

All commands run from the repository root. Network is needed only when the cache is missing.

| Task | Command | Offline |
|---|---|---|
| Named objects (`public/data/deep-space.v1.json`, `docs/DEEP_SPACE_DATA_OBJECTS.md`) | `npm run data:objects` | `npm run data:objects:offline` rebuilds exactly from `data/cache/deepspace/objects`; fails on a cache miss |
| Point catalogues (nine files under `public/data/deepspace/`, `docs/DEEP_SPACE_DATA_CATALOGUES.md`) | `npm run data:deepspace:catalogues` (options `--only ungc,twomrs`, `--refresh`) | `npm run data:deepspace:catalogues:offline` rebuilds byte-identical from `data/cache/deepspace/catalogues` (about 122 MB, mostly the Zenodo zip); a checksum mismatch aborts |
| Gaia density maps (withdrawn, see section 4; nothing ships their output) | `python3 tools/deepspace/make_gaia_density.py lmc` and `smc` | needs the Gaia archive; output is cached under `data/cache/deepspace/` |
| Images (`public/deepspace/img`, `provenance.json`, `docs/DEEP_SPACE_IMAGE_PROVENANCE.md`) | `npm run deepspace:images` (option `--only <id>`, `--force`) | no `--offline` flag: originals are cached in `data/cache/deepspace/` and are not downloaded again when present |
| Image provenance document only | `npm run deepspace:images:report` | yes |
| Credits page (`public/credits.html`) | `npm run credits:build` | yes |
| Browser QA | `npm run build && npx vite preview --port 4173 --host 127.0.0.1`, then `PLAYWRIGHT_MODULE_DIR=<dir containing node_modules/playwright> npm run qa:deepspace` | n/a |
| Performance measurements (`docs/qa/deepspace/perf.json`) | same preview server and Playwright, then `npm run perf:deepspace` (runs `tools/perf-deepspace.mjs`; environment variables `ATLAS_URL` and `QA_OUT` change the page and output directory, default `http://127.0.0.1:4173/` and `docs/qa/deepspace`) | n/a |

`tools/perf-deepspace.mjs` records, per scene (start view, M31, Orion, Pleiades, Omega Centauri, Local Group, 2MRS, Milky Way): draw calls, texture bytes and counts, GPU textures and geometries, JS heap (Chromium `performance.memory`), frame rate and median frame time over about 4 s, catalogue load times and transfer sizes, and a disposal loop over all 27 objects. Software GL only: it prints and stores that disclaimer in the JSON.

Image manifests are `tools/deepspace/images/galaxies.json`, `nebulae.json` and `gaps.json` (the 36 shipped assets) (documented in the docstring of `build_images.py`). The cache directory `data/cache/` is not committed.

## 15. Keyboard and interface

| Key | Action |
|---|---|
| `M` | Fly to the Milky Way scale |
| `L` | Fly to the Local Group scale |
| `U` | Fly to the Nearby universe scale |
| `H` | Return to the Gaia star-field home view (60 pc) |
| `O` | Overview (Solar System overview when in the Solar System, else the nearby universe) |
| `Backspace` | Parent: moon to planet, planet to overview; a deep-space object to its parent object when the data names one that can be flown to (M31 to the Local Group), else a scale flight to the Local Group or nearby-universe view with nothing selected. The decision is `Viewer.parentDeepTarget`, applied by `DeepUi.goToParent` so selection, inspector, ring and highlight change together |
| `Esc` | Deselect and close the inspector |
| `+` `-`, arrows, `R` | Zoom, rotate, reset orientation (as before) |

Deep-space panel (`src/ui/deepUi.ts`): the four scale shortcuts with the current camera distance and breadcrumb; grouped object lists (Galaxies, Nebulae, Clusters, Groups) that fly to the object; four layer toggles (galaxies, nebulae, clusters, structure); a "What the drawings are" legend (every type also has a text label; colour is never the only cue); a scale note (beyond 3 Mpc with the structure layer on it carries the 2MRS caveat; at the closest zoom of an image-only object it says the atlas has no three-dimensional data and this is the highest-resolution image); band buttons per object; an image-credits line with the credit of the image drawn, always visible while an image is shown. Search finds deep-space objects by name or designation ("M 87", "NGC 224") ahead of stars. Clicking a catalogue point (a galaxy in UNGC, McConnachie or 2MRS, a cluster member) opens an inspector built from its stored columns with the catalogue caveats. The inspector's "What you are seeing" block shows the representation badge, summary, exaggerations and the provenance of the displayed image.
