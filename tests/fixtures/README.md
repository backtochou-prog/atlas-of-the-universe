# Test fixtures

- `gaia-sample.csv`: real rows from the Gaia DR3 archive (retrieved 2026-11-12 with the query in `docs/DATA_PROVENANCE.md`), chosen to cover edge cases: Barnard's Star, Proxima Centauri, alpha Phe, a source with no parallax (Alnair), sources with no G magnitude, high RUWE, marginal parallax, a duplicated-source flag, a 2-parameter solution, and a Hipparcos + GSP-Phot row. Values are unmodified.
- `simbad-batch.csv`: the matching real SIMBAD rows (same retrieval).

Tests that need synthetic bad input modify copies of these rows in memory and say so.
