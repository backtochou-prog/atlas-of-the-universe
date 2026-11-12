# Architecture

## Stack
| Concern | Choice | Status |
|---|---|---|
| Language | TypeScript (strict, `noUncheckedIndexedAccess`) | In use |
| Build | Vite 8 | In use |
| Tests | Vitest 5 | In use; runs the spatial maths and data checks headlessly |
| 3D | Three.js 0.187 (`@types/three` 0.187) | Installed; not yet imported by any module. The planned renderer (Prompt 02) targets WebGL2 |
| UI | Plain DOM | In use; `src/main.ts` writes status text directly. React is deferred until panels need state |

Not adopted: WebGPU, a state library, a physics engine. `src/core/capabilities.ts` detects WebGL2 (with WebGL1 fallback), `navigator.gpu` and `navigator.xr`; nothing renders with WebGPU or WebXR yet. Each tool is added only when a concrete feature needs it.

## Module boundaries
| Path | Contents | Imports |
|---|---|---|
| `src/core/spatial/` | Frame tree (`frames.ts`), floating origin (`anchor.ts`), zoom maths (`zoom.ts`), vector helpers (`vec3.ts`) | Local modules only; no rendering |
| `src/core/units.ts` | Units module | Not reviewed in detail |
| `src/core/capabilities.ts` | Feature detection: WebGL2 (with WebGL1 fallback), WebGPU, WebXR flags | Browser APIs only |
| `src/data/` | Schema, registry, validation, seed dataset (`SEED_SOLAR`) | Local modules only; no rendering |
| `src/render/` | Planned. Three.js scene code that consumes the spatial and data layers | Does not exist yet |
| `src/main.ts` | Bootstrap: detects capabilities, builds the registry, validates the seed data, writes status text | No renderer is started |

Dependency direction: `render` (planned) depends on `core/spatial` and `data`. Neither `core/spatial` nor `data` depends on rendering.

## Spatial core
- The universe is a tree of frames. Each frame's origin is stored in its parent's coordinates. A position is a frame plus an offset.
- `refit()` in `src/core/spatial/anchor.ts` moves the viewer into a child frame only within 0.5 of the child radius and back to the parent only beyond 1.0 of the current radius. The gap is hysteresis, so a viewer between those bounds keeps its current frame.
- `zoomDistance` and `decadesBetween` in `src/core/spatial/zoom.ts` give logarithmic zoom.
- Precision figures, the hand-off rules and the planned rendering layers are described in `docs/RENDERING_STRATEGY.md`. That file is the detail source; this one does not repeat it.

## Data
- `src/data/schema.ts` defines `Dataset`, `CelestialObject` and `Measurement`.
- `validateDataset` (`src/data/validate.ts`) checks a dataset against the schema.
- `SEED_SOLAR` (`src/data/seed.ts`) is a hand-entered seed dataset. Its values have not been checked against their cited sources.
- There is no live ingestion. No SIMBAD or Gaia import module exists.

## Verification
`npm run verify` runs `npm run typecheck` (`tsc --noEmit`), `npm test` (`vitest run`) and `vite build`.

Last recorded test run: 17 tests in 2 files (`tests/spatial.test.ts`, `tests/data.test.ts`) passed. The typecheck and build results were not re-run for this document.

## Known limits
- No renderer exists. No scene, camera or visible 3D output is implemented.
- Three.js is installed but unused.
- No textures or licensed imagery are in the repository.
- The git repository has no commits yet.
