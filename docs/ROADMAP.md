# Roadmap

Each phase depends on the one above it. A phase cannot start until its predecessor is done.

Status key: **done** = in the repository and checked; **not started** = no code yet; **planned** = intended, depends on earlier phases.

| # | Phase | Status | Depends on |
|---|---|---|---|
| 1 | Foundation | done | none |
| 2 | First renderer (Prompt 02) | not started | 1 |
| 3 | Scale navigation | planned, blocked by 2 | 2 |
| 4 | Real data ingestion | planned, blocked by 3 | 3 |
| 5 | Solar System detail | planned, blocked by 4 | 4 |
| 6 | Deep-sky layers | planned, blocked by 5 | 5 |
| 7 | Adaptive performance | planned, blocked by 6 | 6 |
| 8 | WebXR | planned, blocked by 7 | 7 |

## 1. Foundation (done)
Delivered in the repository:
- Toolchain: TypeScript, Vite 8, Vitest 5.
- Spatial core: frame tree, floating origin (`refit`), zoom maths.
- Data layer: schema, validation, seed dataset (`SEED_SOLAR`), registry.
- Capability detection (`src/core/capabilities.ts`).
- Tests: 17 tests in `tests/spatial.test.ts` and `tests/data.test.ts`.

## 2. First renderer (not started)
Planned: a Three.js scene driven by the floating origin, camera controls, a star field from an instanced points buffer, and a capability-based fallback.
Nothing in this phase exists yet. `src/render/` is not created, and `src/main.ts` does not start a renderer.

## 3. Scale navigation (planned)
Planned: frame hand-offs visible in the scene, a scale indicator, and transitions between Solar System and Galactic scales.

## 4. Real data ingestion (planned)
Planned: build-time or cached import of SIMBAD and Gaia DR3 subsets with provenance, and an object inspector panel showing sources and uncertainty.

## 5. Solar System detail (planned)
Planned: planet and moon bodies with textures, and orbit geometry from catalogued elements.

## 6. Deep-sky layers (planned)
Planned: nebulae and galaxies with level-of-detail and streaming.

## 7. Adaptive performance (planned)
Planned: a frame-budget governor and a mobile quality tier.

## 8. WebXR (planned)
Planned: XR session entry and controller navigation, reusing the spatial core. `src/core/capabilities.ts` reports a WebXR flag only.

## Blockers
- No textures or licensed imagery have been sourced.
- The seed data values have not been verified against their sources. See `docs/PROJECT_STATUS.md` and `docs/SCIENTIFIC_DATA.md`.
- No git commits exist yet.
