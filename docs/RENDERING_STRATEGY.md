# Rendering Strategy

## Coordinate frames
The universe is a tree of frames (`src/core/spatial/frames.ts`): Universe > galaxy > neighbourhood > star system > body. Each frame's `origin` is expressed in its parent, in metres, float64. Axes are not rotated between frames; body spin is a render concern.

A position is `(frame, offset)`. Conversion sums offsets only up to the lowest common ancestor, so intra-system geometry never touches galaxy-scale magnitudes.

## Precision (measured, not assumed)
- Float64 rounding at magnitude x is about x × 2.2e-16. At 2.6e20 m (about 27,000 light-years, roughly the Sun's distance from the galactic centre) that is about 6e4 m.
- The test suite confirms: round trips through a nearby frame are sub-millimetre; round trips through the universe root lose tens of km. Precision-critical work must stay in nearby frames.
- Narrowing to float32 happens only in `cameraRelative`, after subtracting the camera position in float64.

## Floating origin and hand-offs
`refit()` moves the viewer into a child frame only within 0.5 × the child's radius and back to the parent only beyond 1.0 × the current radius. The gap is hysteresis: a viewer between the bounds keeps its current frame. Tested in `tests/spatial.test.ts`. The star viewer uses the floating origin; the frame hand-offs (`refit`) drive the breadcrumb through `SolarHierarchy`, which is built on the universe frame tree (Universe > Nearby universe > Local Group > Milky Way > neighbourhood), not the camera arithmetic itself, which stays in Sun-centred float64 parsecs.

## Logarithmic zoom
`zoomDistance` scales distance exponentially with scroll input, so one gesture feels the same at 1 km and at 1 Mpc. Limits are clamped per context.

## Star field (implemented)
Source: `src/render/` and the vertex shader in `starfield.ts`.

**Placement.** Positions come from the catalogue unchanged: RA/Dec at epoch J2016.0 plus the parallax distance, converted to ICRS Cartesian parsecs. A star appears only if the catalogue supports both a distance (reliable or marginal parallax) and a G magnitude. Nothing is moved to look better; the browser QA aims the camera along Proxima Centauri's catalogue direction and requires it to land at screen centre (it does, to 0.000 px).

**Floating origin.** The camera position is float64. Each frame, `cameraRelative()` subtracts it from every star in float64 and only then narrows to float32, so precision does not degrade far from the Sun (tested with a 9000 pc offset and a 1 micro-parsec separation).

**Brightness (a documented visualisation choice, `src/render/brightness.ts`).**
1. Derived absolute magnitude per star: M = G - 5 log10(d_sun) + 5 (no extinction).
2. Apparent magnitude from the *camera*: m = M + 5 log10(d_camera) - 5. Stars therefore brighten as you approach them, as they would physically (extinction ignored).
3. Point diameter and opacity are **linear in magnitude, i.e. logarithmic in flux** (Pogson). Diameter = clamp(1.2 + 1.15 x (limit - m), 1.2, 12) px; stars fainter than the limiting magnitude (default 7.5, user-adjustable) are not drawn. Opacity rises from 0.28 to 1 over the 5 magnitudes brighter than the limit.
4. **Point size does not represent stellar radius**, and this is stated on screen. The mapping is not calibrated photometry.
5. The GLSL is generated from the same constants as the TypeScript functions, and a test pins the shared log identity.

**Colour.** A smooth blue-white-yellow-orange ramp keyed on BP-RP (a visualisation choice, not a blackbody conversion). A source with no BP-RP is a neutral grey so missing colour is visible, not silently tinted.

**Uncertainty is visible.** Stars with a marginal parallax distance are drawn at 55% opacity. Stars with a poor astrometric fit (RUWE > 1.4) can be hidden with a toggle (off by default: nothing is hidden unasked).

**Cost.** One draw call for all stars plus one for the Sun marker (verified in the browser). Positions are re-uploaded each frame (about 105,000 floats). `frustumCulled` is off because positions change every frame. Picking is a CPU scan of the layer using the same camera-relative buffer the GPU uses.

**Demonstration data.** None is drawn in the star field. Before this milestone no star field existed, so no demonstration dataset had to be replaced. The Sun marker is the only non-catalogue element and is labelled as such.

## Solar System rendering (implemented)
Full description in `docs/SOLAR_SYSTEM.md`. The decisions that matter for the rendering strategy:

- **Positions are camera-relative.** Body positions come from the ephemeris in float64, are converted to metres, and have the camera subtracted before they reach the GPU. A 4.5e12 m distance therefore never appears as an absolute coordinate; the same floating-origin idea as the star layer, with metre units.
- **Two passes, two scales.** Stars are drawn in parsec units with their own near/far planes; the depth buffer is cleared; the Solar System is drawn in metres with near = 1% of the focus distance and far = 1e15 m. This avoids a logarithmic depth buffer and its custom-shader cost while keeping depth resolution in metres near the focus (about 6 km at Jupiter's range).
- **Physical size is separate from drawn size.** A pure policy (`displayScale.ts`) decides the radius of the sphere that is drawn; physical radii in the dataset are never modified, shadows use the true radii, and the interface says when sizes are not to scale. Bodies below 1.5 px become fixed-size markers, which carry no size information.
- **Lighting is analytic and uses the real geometry.** Lambert from the Sun's direction at each fragment; sphere shadows (eclipses, a planet's shadow on its rings) and a ring shadow on the planet are ray tests in the fragment shader. Exposure is normalised per body, so relative brightness between planets is not physical.
- **Resources follow need.** Geometry and materials are built the first time a body is large enough; textures load at 512x256 below 110 px and 2048x1024 above, only when a body is at least 6 px across, and are disposed after 15 s unused; orbit lines are built only when drawn; two shared sphere meshes; the per-frame result map is reused.
- **Honest imagery.** A texture's fidelity (scientific map, derived, artistic composite, none) comes from its provenance file and is shown to the user; no-data texels (zero in the source) are drawn flat grey, not black.
- **Visual effects are labelled.** The Sun's halo, the atmosphere shells' thickness and the ring colour are visualisation choices and are documented as such.

## Deep space (implemented; full description in `docs/DEEP_SPACE.md`)
Three passes per frame: deep space (parsec units), Gaia stars, Solar System (metres), with depth cleared between them. Deep-space objects are placed camera-relative (float64 minus camera, then float32). Image and glow sprites are drawn without a depth test, so the camera range (near = 1e-3 of the focus distance, at most 1e7 pc; far = 1e11 pc) decides only what is clipped, not how it is sorted.

### Techniques evaluated
| Technique | What it needs | Verdict for this atlas |
|---|---|---|
| Volumetric ray marching of a density field | A 3D density (and emissivity) for the object, per-pixel marching cost | Not used. No 3D density exists for the nebulae or the galaxies in the data. Marching a field made up from one image would draw an invented structure that looks measured, and costs fill rate on every pixel of a large screen object. Software GL (the only environment tested) would make it unusable |
| 3D density fields or voxel textures | A published 3D reconstruction | Not used, same reason. Would be the right tool for a published 3D model (see the roadmap: Orion from published studies) |
| Textured volumes (3D textures, slice stacks) | A volume to slice | Not used. A stack of slices of a flat image is what layer projection already is, without pretending to a volume |
| Particles / point sprites | A catalogue of real objects | **Used where real points exist**: cluster members (Gaia), group and nearby galaxies (catalogue rows), the 2MRS galaxy distribution. Also the Milky Way model, drawn as about 6500 large soft splats that are explicitly not stars |
| Image planes (flat textured quads) | An image with geometry | **Used** for galaxies without a usable orientation, and for markers and glows at distance |
| Disc-plane image (deprojection) | Published inclination and position angle | **Used** for M31, M33, M81, LMC. A flat image on a tilted plane; the tilt direction is a choice because the near side is unknown |
| Multi-layer image projection | An image; an assumed thickness | **Used** for all nebulae: the image split by brightness into 3 to 5 additive sheets whose sum is the original, spread along the line of sight by an assumed, labelled thickness (the data says `depth: illustrative-layers`; the thickness fractions per class, 0.15 to 0.35 of the transverse size, are display parameters, not measurements). Cheap (one instanced draw per nebula), honest about what is invented, and gives parallax when the camera moves. Limit: flat when seen edge-on |

### Choice per object class
| Class | Choice | Why |
|---|---|---|
| Milky Way | Splats from a documented analytic model | The literature gives parameters, not a density map; soft overlap hides that no star is placed |
| Spiral galaxies with orientation | Deprojected image | Orientation is published; image is real |
| Ellipticals, irregulars, peculiars, edge-on | Flat image card | No usable orientation; depth is not measured and none is claimed |
| Nebulae | Multi-layer projection | Moves with the viewer, sum equals the real picture, depth declared illustrative |
| Star clusters | Point sprites per real member | Members and their sky positions are real; open-cluster depth from parallax; globular depth assumed (hash-seeded Plummer-like draw, `depth: illustrative` in the data) |
| Groups, nearby galaxies, structure | Instanced soft markers | Real rows; no surface is drawn |

### Energy-conserving layers
The nebula fragment shader encodes colour to sRGB first and multiplies by the band weight afterwards. The framebuffer is display-referred and additive, so the sum over the N bands of `weight x encode(colour)` is exactly `encode(colour)` because the weights sum to 1. The result seen from the Sun is the original image; the layers only differ when the camera leaves that line of sight. `tests/deepspace-render-nebula.test.ts` checks the weights sum to 1 and the offsets and scale about the Sun.

### Texture handling today and what is not done
- Implemented: WebP levels (longest side 256 / 1024 / 2048 / 4096 px, never upscaled), sRGB textures with mipmaps and anisotropic filtering, background upgrade with the lower level kept on screen, at most one large-texture activation per frame, a 2.5 s hold before downgrading, release after 4 s unused, a 192 MiB byte budget with least-recently-used eviction and reference-counted leases, in-flight de-duplication and abort.
- **Context loss.** Decoded bitmaps are closed after upload (and on abort, failure or early eviction), so they cannot be uploaded twice. On `webglcontextlost` the asset manager therefore drops every lease and load and hands out nothing; after `webglcontextrestored` textures are re-decoded through the normal request path. Verified by simulation (`WEBGL_lose_context` in software-GL Chromium, fake decoder in unit tests); never observed on a GPU.
- **Texture compression is not implemented.** Textures are decoded WebP uploaded as RGBA with mipmaps; GPU memory is estimated as width x height x 4 x 1.33 per texture. KTX2 with Basis Universal transcoding (smaller GPU memory and faster upload, with a per-device transcode target) is the planned step; it would change the asset build and the loader, not the renderers.
- Lazy loading: point catalogues are fetched only when the camera is in range (`CATALOGUE_RANGES`) and dropped after 20 s unused.

### Mobile and WebXR tier preparation
Exists: the quality governor and a quality scale that cuts splat counts, nebula layers, point counts and texture level; resolution levels; byte-budget eviction; lazy catalogue loading; `navigator.xr` detection (`src/core/capabilities.ts`).
Does not exist: a device tier selector, a smaller texture set, KTX2 (not implemented), a stereo or XR render path, a touch-first interface review, or any measurement on mobile or XR hardware. Nothing here should be read as mobile or WebXR support.

## Not implemented yet
- Surface relief, cloud motion for planets; texture compression; mobile and VR tier; WebXR; filaments, voids or a cosmic web (by design, until a derived method is available); real 3D nebula models; navigation beyond 600 Mpc and cosmological distances (the 2MRS sample reaches 741 Mpc at H0 = 70, 3 galaxies lie beyond 600 Mpc, and the camera is limited to 600 Mpc from its focus).
- The quality governor is wired and unit-tested but has not been tuned or measured on a GPU.
- No GPU timings exist anywhere in this project; `docs/qa/deepspace/perf.json` (`npm run perf:deepspace`) holds software-GL figures only.

## Performance rules
- Load assets on demand; never the whole catalogue (the current layer is 35,000 stars from two static files).
- Use instancing or a single points draw for any set above a few hundred objects.
- Keep GPU memory bounded by LOD eviction (needed once larger catalogues are loaded).
