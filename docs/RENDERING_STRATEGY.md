# Rendering Strategy

## Coordinate frames
The universe is a tree of frames (`src/core/spatial/frames.ts`): Universe > galaxy > neighbourhood > star system > body. Each frame's `origin` is expressed in its parent, in metres, float64. Axes are not rotated between frames; body spin is a render concern.

A position is `(frame, offset)`. Conversion sums offsets only up to the lowest common ancestor, so intra-system geometry never touches galaxy-scale magnitudes.

## Precision (measured, not assumed)
- Float64 rounding at magnitude x is about x × 2.2e-16. At 2.6e20 m (about 27,000 light-years, roughly the Sun's distance from the galactic centre) that is about 6e4 m.
- The test suite confirms: round trips through a nearby frame are sub-millimetre; round trips through the universe root lose tens of km. Precision-critical work must stay in nearby frames.
- Narrowing to float32 happens only in `cameraRelative`, after subtracting the camera position in float64.

## Floating origin and hand-offs
`refit()` keeps the viewer in the deepest frame that contains it. Descend when within 0.5 × a child's radius; ascend when beyond 1.0 × the current radius. The gap is hysteresis: a viewer at a boundary cannot flip-flop between frames. Tested in `tests/spatial.test.ts`.

## Logarithmic zoom
`zoomDistance` scales distance exponentially with scroll input, so one gesture feels the same at 1 km and at 1 Mpc. Limits are clamped per context.

## Planned rendering layers (Prompt 02 onward)
- Star fields: instanced points, magnitude-scaled, culled by frustum and by frame.
- Galaxies and nebulae: billboards or volumetric shells, streamed by LOD.
- Planets: sphere LOD with textures loaded asynchronously.
- Transitions: cross-fades across frame hand-offs, not cuts.
- Adaptive quality: a frame-time budget lowers resolution and particle counts.

## Performance rules
- Load assets on demand; never the whole catalogue.
- Use instancing for any set above a few hundred objects.
- Keep GPU memory bounded by LOD eviction.
