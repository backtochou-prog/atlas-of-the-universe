# Scientific Data

## Principle
Data and rendering are separate. Renderers read validated `CelestialObject` records; they never hold astronomical values.

## Record model (`src/data/schema.ts`)
Each object has: id, name, designations, classification, frame, optional parent, optional sky position, optional radius/mass/temperature, confidence grade and notes.

Each measurement has: value, SI unit, optional 1σ uncertainty, `SourceRef` (source key, release, record id, URL, retrieval date) and an optional note.

Confidence grades: `confirmed`, `catalogued`, `model`, `hypothetical`. Hypothetical objects must never be rendered as observed.

## Sources (planned integration order)
1. IAU 2015 nominal constants and NASA Planetary Fact Sheets: Solar System (seed data now).
2. SIMBAD: identifiers and coordinates for stars and deep-sky objects.
3. Gaia DR3: stellar astrometry and distances (with parallax uncertainty kept).
4. NASA Exoplanet Archive: exoplanet hosts and parameters, with the archive's reported uncertainties.
5. ESA and NASA imagery: textures and galaxy images, licensed separately from data.

## Current state
- Seed dataset `seed-solar-system` contains Sun, Earth and Moon with nominal values. Values were entered from memory of published constants and **must be re-checked against the cited sources before public release**. Each record's `retrieved` date marks entry, not verification.
- No live data fetching exists yet.

## Validation (`src/data/validate.ts`)
Rejects non-finite values, negative radius/mass/temperature, missing provenance, RA outside [0,360), Dec outside [-90,90].

## Integration rules
- Adding a dataset means adding a `Dataset` object and calling `DataRegistry.register`. No rendering change is needed.
- Duplicate object ids are rejected.
- Caching of downloaded catalogues goes under `data/cache/`, which is git-ignored.
