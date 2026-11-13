# Discovery engine (Prompt 07)

State as of 2026-11-13. This document describes what is in the code and the data of this repository today. Where something is unfinished or was not tested it says so. Numbers are either read from files, produced by commands re-run for this document (marked "re-measured"), or taken from named QA logs. Every timing is from a shared machine with software GL (SwiftShader) Chromium or from node; no GPU was involved anywhere.

Companion documents: `docs/DISCOVERY_ENGINE_RUNTIME.md` (worker, stages, selection and navigation notes), `docs/DISCOVERY_DATA_STARS.md` and `docs/DISCOVERY_DATA_EXOPLANETS.md` (how the two new catalogues were built), `docs/DISCOVERY_NOTES_SOURCES_SOLAR_DEEP.md` and `docs/DISCOVERY_NOTES_SOURCES_STARS_EXO.md` (every source of every explanation), `docs/SCIENTIFIC_DATA.md` section 14 (provenance and licences of the discovery datasets).

## 1. Purpose and principles

The discovery engine turns the datasets the Atlas holds into one searchable, filterable, navigable collection. It is an observatory, not a search site: it can find what is in the atlas, fly there, say what is known and how well, and say what is not held. It is not a general astronomy database.

| Principle | What it means in the code |
|---|---|
| Only datasets we hold | Search, lists and filters read only the 12 files loaded by `src/discovery/loader.ts`. There is no network query at runtime. A list says "among N records in this atlas" and carries `completeness: 'not complete'` (`src/discovery/discover.ts`). |
| Missing is not zero | A `DiscoveryRecord` has a measurement key only when the source supplies the value (`src/discovery/types.ts`). `RecordStore` keeps a presence bitmap per key; a filter excludes records without the value and counts them (`excludedForMissing`). Keys with no data at all are never offered (`facets.unavailableKeys`; today `redshift`). |
| Sourced claims | Every explanation statement is a `NoteClaim` with at least one reference (URL and retrieval date) and a status: observed, inferred, hypothesis or historical. The notes validators reject a claim without a status or reference, and the inspector adds a warning line to a note that still contains one (`claimsWithoutProvenance`, `src/ui/discovery/notesViewModel.ts`, used in `InspectorExtras.ts`). |
| Value kinds | Each measurement is `observed`, `derived` or `modelled` with an uncertainty when the source gives one. The inspector shows OBS / DER / MOD badges. |
| Relation honesty | Relations are typed (`orbits`, `member-of`, `component-of`, `part-of`, `near`, `same-object-as`) and carry a basis: physical-gravitational, structural, spatial-association, identity. Each has a required source. A group membership is "physical" only when the source's own basis text says so. Nothing is invented to fill a tree (section 10). |
| Frames | Positions are compared only after being converted into one frame with `FrameTree.convert` in float64 (section 8). |
| Nothing heavy in the render loop | The engine runs in a Web Worker, built in stages, with sliced index building. Queries are asynchronous. The viewer does no discovery work per frame beyond updating two marker layers and the Hipparcos supplement (section 14). |

## 2. Universal ids, merge rules and adapters

### 2.1 Id scheme

One id per object, `<namespace>:<local>`, stable across sessions (bookmarks and history use it). Defined in `src/discovery/types.ts`.

| Namespace | Meaning | Count in the final atlas (re-measured with `atlas.facets()` on the real files) |
|---|---|---|
| `gaia:<source_id>` | Gaia DR3 record of the local subset | 35,325 |
| `hip:<n>` | Hipparcos star that has no Gaia record in the subset | 312 |
| `solar:<bodyId>` | Sun, 8 planets, 20 moons | 29 |
| `deep:<id>` | curated deep-space object | 27 |
| `point:<fileId>:<row>` | row of ungc, local-group-mcconnachie or twomrs | 860 + 96 + 43,526 after 21 rows merge into curated galaxies |
| `exo:<pl_name>` | confirmed exoplanet | 6,470 |
| `host:<hostname>` | exoplanet host that is not also a Gaia or Hipparcos star | 4,299 (the other 563 of the 4,862 hosts are merged into a Gaia or Hipparcos record) |
| `other:<id>` | curated other object | 6 |

Total: 90,950 records (100,164 adapter records before merging; 9,214 ids are aliases of a canonical record). Source of these numbers: `tests/fixtures/discovery/source` data loaded through `DiscoveryAtlas`, `stats().records`, `stats().aliases`, `facets().datasets`.

### 2.2 Merge rules (`mergeRecords`, `src/discovery/records.ts`; `pointMerge.ts`)

- **Same star in several datasets becomes one record.** The datasets say so through `sameAs` (the Hipparcos file stores the Gaia id found at build time; the exoplanet archive stores `gaia_dr3_id`). `mergeRecords` joins records connected by `sameAs` with a union-find, including links to ids that are not loaded.
- **Winner order:** Gaia DR3, then Hipparcos, then the NASA host, then curated-other (`PRIORITY` in `records.ts`). The winner keeps its id, category, classification, drawn flag and every value it has.
- **Gaps are filled from duplicates**, tagged with `source` (the duplicate's dataset). The distance group (distance, absolute magnitude, luminosity, physical size) and the 3D position come together from one duplicate or not at all, so a position is never combined with a distance from another catalogue.
- **All designations are kept**, so every old id and name still finds the canonical record. `aliases` maps each absorbed id (for example `host:TRAPPIST-1`, `hip:70890`) to the canonical id; the atlas, the relation graph, saved bookmarks and notes (alias-aware `noteFor`) all resolve through it.
- **A planet follows its host.** After merging, a dependent record takes the canonical host's position and distance, so a star and its planets are never apart because two catalogues disagree on the distance.
- **Only stars merge.** A `sameAs` link on any other category is reported as a warning and ignored. An unclassified Gaia source (category `other`) joins a star record from another dataset, which then makes it a star.
- **Curated deep objects win over catalogue rows** (`src/discovery/pointMerge.ts`, rule in `src/discovery/duplicates.ts`, shared with the structure renderer): a UNGC / McConnachie / 2MRS row is the same galaxy as a curated one when its normalised name or alias equals the curated name, or when it lies within the documented position tolerance. The curated record keeps its id, gains the row's names as extra designations, lists the row in `sameAs`; the row id becomes an alias. 21 rows merged in the real data (860 of 869 UNGC, 96 of 101 McConnachie, 43,526 of 43,533 2MRS remain as own records).

### 2.3 Adapter mapping table

Each adapter is in `src/discovery/records.ts`; its header comment is the specification. A measurement key is set only when the source gives the value.

| Dataset adapter | Records | Position | Measurements set (kind) | Notable decisions |
|---|---|---|---|---|
| `recordsFromGaia` | 35,325 | `icrs` when a distance exists, else `sky-only` | distancePc (derived, from parallax, only when S/N >= 5, uncertainty first-order); apparentMag G (observed); absoluteMag (derived, no extinction); teffK (GSP-Phot, modelled); bpRp (derived); pmTotalMasYr (derived) | category `star` only if SIMBAD classifies it as one, otherwise `other`; no parallax zero-point correction; `qualityFlags` (e.g. high-ruwe) kept; `drawn` = has distance and G |
| `recordsFromSolar` | 29 | `solar` (bodyId) | radiusKm, massKg, orbitalPeriodDays; the Sun also teffK, luminositySun, radiusSun | planet temperatures are surface values, not effective temperature, so they are not mapped to teffK |
| `recordsFromDeep` | 27 | `icrs` from the object's sky position and distance | distancePc, angularSizeArcmin, physicalSizePc (published or derived), apparentMag (first of V, B ...), absoluteMag, massKg | the Milky Way gets no distance (its stored distance is to the Galactic centre); the Local Group has no position and is sky-only with non-finite angles; `hypothetical` measurements are skipped |
| `recordsFromPoints` | 869 + 101 + 43,533 before merging | `icrs` with a distance, else `sky-only` | UNGC distance (observed unless the method is a membership or text, then derived); McConnachie distance (observed); 2MRS czKms (observed) and distancePc = cz / H0 only when cz >= 1000 km/s (derived, H0 = 70 km/s/Mpc is an application choice, noted on the measurement) | a 2MRS row below 1000 km/s is sky-only and inspect-only; 2MRS ids of the form hhmmssss+ddmmsss also get the SIMBAD name "2MASX J..." |
| `recordsFromBrightStars` | 8,942 | by `brightPlacement.ts`: S/N >= 10 placed; named star with S/N 5 to 10 placed as derived with a "low reliability: parallax S/N < 10" note; others sky-only | apparentMag V (observed), distancePc, absoluteMag (derived), pmTotalMasYr (derived) | B-V is not stored in the record (it is not BP-RP); `sameAs gaia:<id>` when the build found the Gaia record |
| `recordsFromExoplanets` (hosts) | 4,862 | `icrs`, or `sky-only` for 28 hosts without a distance | distancePc, apparentMag V, teffK (stellar, modelled), radiusSun, massKg (derived from stellar mass), pmTotalMasYr | |
| `recordsFromExoplanets` (planets) | 6,470 | the host's position | orbitalPeriodDays, radiusKm (derived from Earth radii), massKg only when `massKind` is Mass (derived) or M-R relationship (modelled), teffK = equilibrium temperature (modelled) | a Msini minimum mass is not a mass and is omitted; limit-flagged values are omitted; planets are never drawn |
| `recordsFromOther` | 6 | `icrs` when the cited distance exists | distancePc with its own cited source | `drawn` = has a distance |

## 3. Datasets

### 3.1 Searchable now

| Dataset | Held records | Source | Licence / terms to carry |
|---|---|---|---|
| Gaia DR3 subset | 35,325 (34,890 drawn) | ESA Gaia DR3 via the Gaia archive, selection in `docs/SCIENTIFIC_DATA.md` section 1 | **Licence statements disagree** (section 3.3) |
| SIMBAD identifiers | 31,663 Gaia records matched | SIMBAD (CDS) via the CfA mirror | names and identifiers are what is searchable; SIMBAD's terms page was not fetched; acknowledgement given in the credits |
| Hipparcos supplement | 8,942 rows (8,630 merge into Gaia records, 312 stay own records) | VizieR I/311 (van Leeuwen 2007, astrometry) and I/239 (ESA 1997, V, B-V, type, variability), IAU WGSN names, SIMBAD identifiers; retrieved 2026-11-13 | **CC-BY-NC-3.0 IGO** stated in the I/239 ReadMe (non-commercial); I/311 ReadMe gives an acknowledgement and no licence text; IAU-CSN file: CC BY with source mentioned |
| Solar System | 29 | JPL / NAIF (`docs/SOLAR_SYSTEM.md`) | NASA / JPL |
| Curated deep-space objects | 27 | `docs/DEEP_SPACE_DATA_OBJECTS.md` | see `docs/SCIENTIFIC_DATA.md` section 13 |
| UNGC, McConnachie 2012, 2MRS | 869, 101, 43,533 | VizieR | CDS acknowledgement; see `docs/SCIENTIFIC_DATA.md` 13.2 |
| NASA Exoplanet Archive `pscomppars` | 6,470 planets, 4,862 hosts | archive TAP, retrieved 2026-11-13 (archive count 6,470, last updated 2026-11-12) | No licence statement; **standard acknowledgement required** in published material, and the archive asks for a citation of Christiansen et al. (2025). Text in `docs/DISCOVERY_DATA_EXOPLANETS.md` |
| Other objects | 6 (Sagittarius A*, Cygnus X-1, Crab Pulsar, SN 1987A, Eta Carinae, Vela Pulsar) | SIMBAD positions, arXiv for each distance | each distance cites its paper |
| Explanations | 69 notes | authored from NASA, ESA, ESO, arXiv, SIMBAD and archive pages | paraphrases; section 12 |
| Relations | 5 curated edges + derived | `public/data/relations.v1.json` and dataset fields | section 10 |

### 3.2 Not searchable (not held)

- Gaia stars outside the 35,325-record subset. Stars brighter than G = 1.5 are not in the Gaia subset; the Hipparcos supplement covers V <= 6.5 plus IAU-named stars (8,942 rows), which is our definition of naked-eye and not a completeness claim.
- Any star fainter than that and not in Gaia or an exoplanet host list: for example most of the sky's catalogued stars (HD, SAO, TYC entries not in SIMBAD cross-ids of our Gaia rows).
- Variable-star catalogues (GCVS, VSX): none held (section 18).
- Asteroids, comets, dwarf planets, spacecraft, moons beyond the 20 held, unconfirmed exoplanet candidates.
- NGC / IC / Messier objects other than those in the 27 curated objects or in UNGC, McConnachie and 2MRS rows. The Atlas has no NGC catalogue.
- Individual members of the Pleiades, Hyades and four globular clusters (the `members-*` point files are drawn by the deep-space layer; the discovery engine does not load them).
- Names in languages other than the catalogue's own (no multi-language name table).
- Pulsars and black holes other than the six curated "other" objects.

### 3.3 Licence concerns specific to discovery data

1. **Hipparcos CC-BY-NC-3.0 IGO.** The VizieR I/239 ReadMe says "License: CC-BY-NC-3.0 IGO". The supplement is therefore non-commercial as far as we can tell. The project is a prototype not cleared for public release; this needs a decision (roadmap).
2. **NASA Exoplanet Archive.** No licence; the acknowledgement text must appear in published material (`docs/DISCOVERY_DATA_EXOPLANETS.md` quotes it verbatim). Checked by search on 2026-11-13: the page footer (`index.html`) and `public/credits.html` name Gaia, SIMBAD and the deep-space sources only; neither the NASA Exoplanet Archive acknowledgement nor a Hipparcos / van Leeuwen credit appears in them, so the acknowledgement exists in the documentation only. This is an open issue (`docs/PROJECT_STATUS.md`).
3. **SIMBAD and IAU names.** SIMBAD's terms page was not fetched. IAU proper names come from the WGSN file whose header says its products are released under CC BY (credit the source).
4. **Gaia.** Three statements still disagree (open with credit to ESA/Gaia/DPAC; CC BY-NC 3.0 IGO on the Gaia Users page; CC BY-SA 3.0 IGO in our cluster-member manifests). The 35,325-record subset, now also searchable and filterable through the engine, carries the same open question (`docs/SCIENTIFIC_DATA.md` 13.2 item 1). Nothing in this work resolves it.
5. The engine merges Gaia and Hipparcos records; a merged record can therefore carry values from both datasets. The `source` field on a measurement says which dataset a filled value came from.

## 4. Identifier matching

`src/discovery/normalize.ts` turns every designation, at index time, and every query, at query time, into one canonical key by the same function. Two raw names are the same designation if and only if their keys are equal. 20 rule groups are listed in `NORMALIZATION_RULES`, each with examples that `tests/discovery-normalize.test.ts` executes (re-measured: 20 rules, 18 must-stay-distinct pairs).

| Rule | Examples (raw to key) |
|---|---|
| case, white space, separators | `CRAB_nebula` to `crab nebula` |
| diacritics, ligatures, apostrophes | `Boötes` to `bootes`, `Barnard’s Star` to `barnards star` |
| punctuation | `mu. Cen` to `mu cen` |
| SIMBAD prefixes `* `, `** `, `V* `, `NAME ` | `* alf CMa` to `alpha cma` |
| Messier | `M31`, `Messier 31`, `M-31` to `m 31` |
| NGC / IC (separate series) | `NGC0224` to `ngc 224`; `NGC 224 A` to `ngc 224a` |
| HIP, HD (HDE is HD), HR, SAO, TIC and similar | `HIP032349` to `hip 32349` |
| Gliese | `Gl 551`, `GJ551`, `Gliese 551` to `gj 551` |
| Gaia | `4472832130942575872` (bare 16 to 19 digits) to `gaia dr3 ...`; `Gaia EDR3 N` is DR3; `Gaia DR2 N` stays DR2 |
| exoplanet names | `Kepler-452 b`, `kepler452b` to `kepler 452b`; `TRAPPIST-1e` to `trappist 1e` |
| Bayer | `α CMa`, `alf CMa`, `alpha Canis Majoris` to `alpha cma`; `α¹ Cap` to `alpha1 cap` |
| Flamsteed and variable stars | `61 Cygni` to `61 cyg`; `RR Lyrae` to `rr lyr` |
| pulsars | `psrb0531+21` to `psr b0531+21` |
| BD / CD / CPD zones | `BD +1 543` to `bd+01 543` |
| TYC, 2MASS, Sharpless, Melotte / Collinder / Markarian | `TYC 0055-0745-1` to `tyc 55-745-1`; `Sh 2-103` to `sh2 103` |
| galactic centre | `Sagittarius A*` to `sgr a*` |
| hyphenated numbers | `LP 592-4` stays `lp 592-4` |

**Must not be conflated** (`MUST_STAY_DISTINCT`, asserted by tests): M3 / M31, M 1 / M 10, NGC 22 / NGC 224, NGC 224 / IC 224, NGC 224 / NGC 224A, HIP 3 / HIP 32349, HD 1 / HD 10, Gaia DR2 N / Gaia DR3 N, two Gaia ids differing in the last digit, Kepler-452b / Kepler-452c, Kepler-45b / Kepler-452b, TRAPPIST-1 / TRAPPIST-2, alpha CMa / alpha CMi, alpha CMa / beta CMa, alpha1 Cap / alpha2 Cap, Sgr A* / Sgr A, PSR B0531+21 / PSR B0531+22, BD+01 543 / BD-01 543.

The module never guesses a catalogue from a bare number (`224` stays `224`), never fuses different numbers, and does not correct typos; typo handling is a separate, visibly flagged stage of the search index.

## 5. Search architecture

Code: `src/discovery/searchIndex.ts`, `src/discovery/workerEngine.ts` (`search`), `src/ui/discovery/SearchBox.ts` and `searchViewModel.ts`.

- **Inverted token index** (token to posting list) plus sorted token segments for binary-searched token prefixes.
- **Sorted-key prefix search**: sorted arrays of unique canonical keys with lists of entry ids; exact and prefix are binary searches.
- **Trigram index** over name-like words of three or more letters for the substring stage. Catalogue numbers are never substring-matched.
- **Bounded edit-distance fuzzy stage**: a symmetric-delete dictionary over purely alphabetic words of four or more letters; edit distance 1 for 4 to 7 letters, 2 for 8 or more, adjacent transposition counts as 1. It runs only when too few non-fuzzy hits exist. Identifiers and numbers are never fuzzy-matched, so a mistyped catalogue number cannot open a different object. A fuzzy hit carries what was typed, what it matched and the distance; the UI row says "matched “sirus” as Sirius".
- **Segments** (LSM style): `add(records)` creates new segments, merged when comparable in size, so a lazily loaded dataset joins without rebuilding what exists. `extend()` adds designations to an already indexed record (used when a catalogue row is merged into a curated galaxy).
- **Ranking order**: match kind first (exact, prefix, token-prefix, substring, fuzzy), so a typo can never outrank an exact or prefix hit. Inside a kind: category order (`CATEGORY_ORDER`: planet, moon, star, exoplanet-host, exoplanet, galaxy, nebula, supernova-remnant, star-cluster, galaxy-group, galaxy-cluster, other; an editorial familiar-to-remote order, no dataset appears in it), proper name before catalogue identifier, brighter apparent magnitude first, insertion order. At atlas level `workerEngine.search` additionally puts curated records before catalogue rows of the same match quality (so "Andromeda" returns `deep:m31`, not the McConnachie row).
- **Bounds**: each stage scans at most `SCAN_CAP` = 6,000 entries; when more exist the result says `totalIsLowerBound: true` and only the first 6,000 in key order are ranked. Counts are over distinct records among the scanned candidates. Queries longer than 128 characters, shorter than 2 characters, or without a letter or digit are rejected as empty results. Default result limit 20, maximum 200; the UI shows a window of at most 40 rows and says "showing 40 of N; refine the query".
- **Categories**: results are filterable by category; counts per category are always reported for all categories. The UI offers chips (All, Stars, Planets, Moons, Exoplanets, Galaxies, Nebulae, Clusters, Groups, Other) with counts.
- **History and suggestions**: with an empty query, `atlas.suggest('')` returns the recent history plus featured objects that have notes (8 featured in the last API QA run).
- **Before the index exists** the search box uses the older Gaia-sample and deep-object search (`fallbackSearch` in `src/main.ts`) and says so.

Search probe from the real browser run: queries answered during indexing had a median of 27.2 ms from the page; see section 6.

## 6. Runtime: Worker, stages, time slicing

Details in `docs/DISCOVERY_ENGINE_RUNTIME.md`. Summary:

- The engine (`AtlasEngine`, `src/discovery/workerEngine.ts`) runs in a Web Worker (`src/discovery/worker.ts`, client `workerClient.ts`); `DiscoveryAtlas` (`src/discovery/atlas.ts`) is the page-side facade with a record cache, the notes, the saved store and the navigation controller. Without `Worker` (tests, unusual browsers) `InlineEngineClient` runs the same class on the calling thread; its non-sliceable steps would then block that thread.
- Stage 0 (Gaia, SIMBAD, Solar System, deep space) makes search available. Stage 1 (Hipparcos, exoplanets, other objects, relations; notes on the page thread) merges duplicates, builds a second index in the background, swaps it in atomically, then builds the record store, KD-tree, facets, relation graph and lists. Stage 2 adds the point catalogues (2MRS, UNGC, McConnachie) to the live index in slices and rebuilds the store once. A dataset that fails to load is reported and skipped; the rest keeps working.
- Index building runs in adaptive slices of about 8 ms (`scheduler.ts: runSliced`) so queries are answered between slices. The steps that cannot be cut (dataset adapters, `mergeRecords`, `RecordStore.from`) are the longest blocking steps of the worker; the page thread is not blocked by them.
- The engine starts after the first two painted frames, in idle time (`requestIdleCallback`, 1.5 s timeout). `?atlas=manual` leaves the start to the caller (QA). `?discovery-renderers=off` skips the Hipparcos layer and the markers.

**Measured, real Chromium (software GL, shared machine, page otherwise idle), `docs/qa/discovery/qa-api-log.json`, run of 2026-11-13T12:37Z:**

| Quantity | Value |
|---|---|
| main-thread long tasks (> 50 ms), 12 s idle baseline | 0 |
| main-thread long tasks during the 12.1 s of indexing | 0 (longest 0 ms) |
| search ready / queries ready / complete, from engine start | 4.16 s / 9.08 s / 12.13 s |
| search probe every 150 ms from the page (81 probes) | median 27.2 ms, maximum 1,000.3 ms (answers that waited for a non-sliceable worker step) |
| records after all stages | 90,950 |

An earlier set of runs recorded by the engine author (4 runs, same setup): search ready 3.1 to 4.1 s, queries ready 6.4 to 11 s, complete 8.5 to 14 s, longest uninterruptible worker step 0.64 to 1.07 s, longest sliced index chunk 66 to 194 ms, probe median 10 to 29 ms, worst probe 0.45 to 1.3 s, 0 long tasks in most runs and one task of 64 ms in one run (source: the R2a report in `docs/DISCOVERY_ENGINE_RUNTIME.md`; the 64 ms task was not re-checked in every later run).

**Re-measured in node (whole engine on the calling thread, real files, shared machine with a load average of about 12 at the time, so slower than a quiet machine):** gaia adapter 1,209 ms; index-0 2,548 ms in 251 slices (largest slice 46 ms); bright-star adapter 210 ms; exoplanet adapter 148 ms; `mergeRecords` 1,089 ms; index-1 2,472 ms in 257 slices (largest 47 ms); `RecordStore.from` 453 ms; KD-tree build 162 ms; facets 67 ms; relation graph 81 ms; lists 354 ms; 2MRS adapter 264 ms; `mergePointDuplicates` 662 ms; index-2 1,362 ms in 157 slices (largest 69 ms). Longest blocking step 1,209 ms.

**2MRS decision.** The 43,533 2MRS rows are in the store (filters, facets, nearby) and by default also in the search index so "2MASX J..." ids resolve. Cost measured by the engine author in node: +1.2 to 1.5 s of index time in the worker and about +10 MB of heap (167 vs 157 MB). `indexTwoMrs: false` switches it off.

**Synthetic scale test** (`tests/discovery-perf.test.ts`, 250,000 synthetic records, figures from the R1 report on a shared box where a trivial 250k-element loop took about 1.3 ms): search index build 3.2 to 3.6 s in one call; record store 1.2 to 1.5 s; keystroke-prefix queries over 4,514 designations median 0.8 ms, 95th percentile 5.3 to 6.1 ms; adding 5,000 records to the full index 102 to 155 ms; combined 6-condition filter median 22 to 30 ms; KD-tree build 322 to 390 ms for 225k points. The test asserts only loose bounds.

## 7. Filters and facets

Code: `src/discovery/filters.ts`, `recordStore.ts`, `spectral.ts`; UI `src/ui/discovery/FilterTab.ts`, `filterViewModel.ts`.

Filters combine with AND: categories, datasets, distance bands, spectral classes and inclusive numeric ranges on any measurement key. The scope is the set passing the categorical filters. `excludedForMissing[key]` counts scope records that have no value for a filtered key, no distance band, or no usable spectral type; `excludedAny` counts a record once however many keys it lacks.

**Distance bands** (heliocentric pc; bounds are choices of this application, shown to the user, not astronomical boundaries; `DISTANCE_BANDS`):

| Band | Bounds | Records (re-measured) |
|---|---|---|
| Solar System | bodies of the Solar System dataset (ephemeris position, no catalogue distance) | 29 |
| Nearby stars | up to 25 pc (the limit of the Catalogue of Nearby Stars) | 5,822 |
| Stellar neighbourhood | 25 pc to 1 kpc | 37,946 |
| Galactic region | 1 kpc to 50 kpc (the Milky Way frame extent in this atlas) | 2,372 |
| Nearby galaxies | 50 kpc to 11 Mpc (the Local Volume of the UNGC) | 874 |
| Larger structures | beyond 11 Mpc | 43,180 |
| (no distance band) | sky-only records | 727 |

**Measurements offered** (records with a value, of 90,950; `atlas.facets()` re-measured). Only keys with at least one value are offered, each with "n of N records have this value".

| Key | Records with a value | Kinds |
|---|---|---|
| distancePc | 90,193 | observed 693, derived 89,496, modelled 4 |
| apparentMag | 84,086 | observed |
| absoluteMag | 35,356 | derived |
| teffK (stellar effective, or planet equilibrium) | 23,972 | modelled 23,971, observed 1 |
| luminositySun | 1 | derived (the Sun only) |
| radiusKm | 6,444 | derived 6,419, observed 25 |
| radiusSun | 4,548 | derived |
| massKg | 10,182 | derived 7,124, modelled 3,039, observed 19 |
| angularSizeArcmin | 874 | observed |
| physicalSizePc | 21 | derived |
| czKms | 43,526 | observed |
| orbitalPeriodDays | 6,135 | observed |
| bpRp | 33,953 | derived |
| pmTotalMasYr | 39,548 | derived |
| redshift | 0 | not offered (`unavailableKeys`) |

Most of the 89,496 derived distances are 2MRS Hubble-flow distances; a filter on distance mixes parallax distances and cz / H0 distances, and the kind counts show it.

**Spectral parser** (`src/discovery/spectral.ts`): input is the type exactly as published; output is every class the text names. Classes O B A F G K M, brown dwarfs L T Y (followed by a digit or end), W (Wolf-Rayet), C (carbon), S, D (white dwarfs), and `unknown`. Lower-case qualifiers before the class are not classes (`sdB5` is B). Alternatives and composites name every class they mention (`G8/K0III` is G and K, `K1V+K5V` is K), so a filter for a possible class matches. `uncertain` is true for `:` or `?`. Anything else (empty, galaxy morphology, garbage) is `unknown`; nothing is guessed. Records per class (re-measured): O 73, B 1,752, A 1,965, F 1,778, G 2,752, K 6,441, M 8,557, L 415, T 19, Y 1, W 6, C 62, S 24, D 1,102, unknown 66,470. Selecting `unknown` includes records without a usable type; otherwise they are excluded and counted.

**Missing-value policy**: a record without the filtered value is excluded and the UI says how many ("N records without a temperature are not included"). `NaN` bounds throw. The filter state serialises into the URL hash (`#d=filter&f.cat=...&f.r.teffK=3000..6000`) and restores the same drawer tab and count.

## 8. Spatial queries

Code: `src/discovery/spatialIndex.ts`, `nearby.ts`, `tools/discovery/bench_spatial.ts`.

**Structure.** A static balanced KD-tree over float64 heliocentric ICRS parsecs, leaf size 8, each node with a tight bounding box and OR-ed category and dataset masks, so a category filter prunes subtrees during traversal instead of after. Queries: radius, k-nearest, frustum.

**Why a KD-tree.** The data span about 8 orders of magnitude in radius (35k stars inside about 1 kpc, hundreds of galaxies to 10 Mpc, 43k redshift-survey galaxies to 150 Mpc and beyond). A uniform grid needs a cell size per scale. The benchmark (`npm run bench:spatial`, 500,000 deterministic synthetic points mimicking those scales; the table is the engine author's full run, about 70 s; the benchmark was not re-run for this document) gave, mean per query:

| Case | KD-tree | Grid (cell size) | Brute force |
|---|---|---|---|
| core, radius 5 pc (15.4 hits), count only | 0.0066 ms (sorted list 0.054 ms) | 0.30 ms (2 pc), 3.4 ms (200 pc), 5.5 ms (20 kpc), 6.0 ms (2 Mpc) | 4.1 ms |
| core, radius 25 pc (932 hits), count only | 0.056 ms (sorted list 0.46 ms) | 12.1 ms (2 pc), 6.5 ms (200 pc), 9.7 ms (20 kpc), 9.6 ms (2 Mpc) | 3.0 ms |
| far field, radius 2 Mpc (250 hits), count only | 0.010 ms (sorted list 0.22 ms) | 24.7 ms (2 pc), 47.5 ms (200 pc), 38.7 ms (20 kpc), 0.105 ms (2 Mpc) | 3.3 ms |
| k nearest, k = 3 / 10 / 100, core | 0.066 / 0.019 / 0.085 ms | not implemented | 8.2 / 5.7 / 5.1 ms |
| k nearest, k = 3 / 10 / 100, far field | 0.009 / 0.015 / 0.061 ms | not implemented | 4.5 / 4.9 / 5.4 ms |
| k = 10 within one of 6 categories, filter during traversal | 0.052 ms (0.028 ms unfiltered) | | |
| build | 886 ms (131,071 nodes) | 57 to 602 ms | |

No single grid cell size works across the range (the 25 pc core query is slower on every grid than on brute force, and the grid with a 2 Mpc cell, which is fast in the far field, puts the whole core in one cell), so the KD-tree is used; the grid exists only inside the benchmark script. Machine: shared, CPU only; compare the columns with each other, not with a clock. The real index holds 90,950 records, much smaller than the benchmark cloud; its KD-tree build was 162 ms (stage 1) and 179 ms (stage 2) in the node run above.

**Frame-aware queries** (`findNearby`, `visibleRegion`). Every searchable collection is a domain that declares its frame and the length of its unit: the heliocentric domain (stars, nebulae, clusters, galaxies; KD-tree in parsecs in the Sun-centred ICRS-aligned `stellar-neighbourhood` frame) and the Solar System domain (bodies in the `solar-system` frame in metres, positions supplied by a callback at the current simulation time). `findNearby` converts the origin into each domain's frame with `FrameTree.convert` (float64, summed only up to the lowest common ancestor), queries in that domain's unit and returns distances in metres. Results from both domains are merged and sorted. `visible` tests records against a view frustum built from the camera.

**Why coordinates from unrelated frames are never subtracted.** Frame origins differ (the Solar System frame is metres around the Sun, the local frames are parsecs; the Local Group and Milky Way frames are anchored on the Galactic centre). A raw subtraction of two vectors in different frames returns a number that has no meaning. The tests include a displaced local frame, an origin 10 Mpc away and a counter-example where naive subtraction gives a different answer. Precision is stated: at 10 Mpc one float64 step is about 6e7 m (0.4 AU), good for neighbours a parsec away to about 2e-9 relative, far below any catalogue uncertainty.

**Same-system handling.** For an exoplanet, or a star with confirmed planets, the host and its planets share one position (distance 0). They are returned in the `system` list (role host or planet) and are never in `neighbours`; `k` still returns `k` neighbours. In the real data TRAPPIST-1 returns 7 planets as its system. The nearest neighbours of Sirius in the last API QA run were Sirius C (6,857 AU), Procyon 1.61 pc, Luyten's star 1.76 pc, Kapteyn c and Kapteyn's star 2.31 pc; from Jupiter the Solar System domain gave Io, Europa, Ganymede first.

## 9. Camera navigation integration

Code: `src/discovery/navigation.ts` (pure `NavigationController`), `src/render/discovery/ViewerNavigationHost.ts` (`NavigationHost` on the viewer), viewer additions in `src/render/viewer.ts`, routing in `src/main.ts`.

- `NavigationController` decides what to look at and how close; it never moves a camera. The host does, using only viewer methods that already interpolate. Call order of `select(id)` on the host is a tested contract: `resolve` then `snapshot`, `currentFrame`, `setSelection`, `highlight([])`, `positionOf`, `viewDistance`, `focus(plan)`. An unknown id touches only `resolve`. Selecting the selected id is a no-op.
- **History**: a bounded list (default 50) of entries with the camera snapshot taken when the entry is left, so Back restores the exact view the user left (focus, distance, yaw, pitch, frame). `back`, `forward`, `returnToPrevious` restore snapshots as flights; `parent()` asks the relation graph (physical first, then structural, then association); when it names no usable parent the page records a deselect and runs the viewer's own scale flight (moon to planet to overview). Overview, home and the scale keys record a deselect first, so Back returns to the object. Transition time default 1,200 ms.
- **View distance per category** (documented at the top of `ViewerNavigationHost.ts`; conventions of the application, not data):

| Category | Rule |
|---|---|
| Solar System body | `viewer.viewDistancePc(bodyId)`, flight with `flyToBody`, then follows the body |
| Curated deep object | `deep.viewDistancePc(id)` through `flyToDeep`; the Local Group has its own anchor flight |
| Star, exoplanet host, other point object with 3D position | max(4 pc, 2 sigma of the published distance), capped at 5,000 pc, so the uncertainty stays visible instead of showing a neighbourhood that does not exist |
| Exoplanet | the host's position with the star rule, plus a selection proxy (planets are never drawn) |
| Catalogue galaxy (UNGC, McConnachie, 2MRS with a distance) | 2.2 x physical size (at least 1 kpc), else 0.15 x distance (at least 10 kpc); not "30 x nearest-neighbour spacing", because that spacing depends on the survey, not on the galaxy |
| 2MRS row with cz < 1000 km/s, any sky-only record | no flight; the placement is `inspect-only` with the reason "cannot place in 3D: distance unknown" |

- **Selection proxy** (`viewer.setSelectionProxy`): a marker is requested when the record is not drawn at this scale (exoplanets, curated other objects with no drawn form, any record with `drawn === false`) or when a star would be fainter than the magnitude limit at the view distance.
- **Inspect-only records** (no 3D position) are selectable and inspectable; the navigation line says "Cannot be placed in 3D", the camera does not move.
- **Snapshot and restore**: `viewer.snapshotCamera` and `restoreCamera` (a flight; keeps follow, selection and frame); `flyToPointPc` rejects non-finite input; `projectPc` returns screen coordinates with a `behind` flag.
- **Picking**: `viewer.pick()` returns `source: 'gaia'` with a catalogue index, or `source: 'layer'` with `layerId` such as `hip:32349`. When both answer, the nearer wins if the layer implements `pickDistance`. `pickDeep` uses explicit pick tiers for exoplanet-host and other-object markers and ignores selection-proxy markers.
- `main.ts` has one `selectById(id, { fly, context })` router: `gaia:` to `selectRow`, `solar:` to `selectBody`, `deep:` to `deepUi.selectDeep`, `point:` to `deepUi.selectPoint`, everything else (`hip:`, `exo:`, `host:`, `other:`) to the generic `inspectDiscoveryRecord`. Canvas clicks show the inspector immediately and then record history with `focus: false`. `window.__atlas.discovery` exposes the atlas for QA.

## 10. Object relationships

Code: `src/discovery/relations.ts`; data `public/data/relations.v1.json`, built by `npm run discovery:notes` from `tools/discovery/notes/relations.json`.

**Basis**: `physical-gravitational` (orbits, binary component, bound membership with a published basis), `structural` (containment that is not an orbit: the Sun is in the Milky Way), `spatial-association` (near each other, or listed together by a distance cut or a catalogue; never presented as physical), `identity` (same object in two datasets). **Kind to basis** is validated (`orbits` and `component-of` only physical; `part-of` only structural; `near` only association; `same-object-as` only identity; `member-of` any of three). The graph validator (`validate()`) reports missing sources, physical edges without a source, self-relations, dangling ids, cycles and conflicting duplicates.

**The three bases the UI separates**: relations are shown in groups by basis (physical, structural, association); the identity group is empty today.

**How edges are produced** (counts re-measured from the real graph, 6,857 edges):

| Producer | Edges | Kind / basis |
|---|---|---|
| `relationsFromSolar`: `parent` field of the Solar System dataset | 28 | orbits / physical (20 moons to planets; 8 planets to the Sun) |
| `relationsFromExoplanets`: archive lists the planet under its host | 6,470 | orbits / physical |
| `relationsFromDeep`: `parentId` of curated objects | 14 part-of structural; 1 member-of physical; 6 member-of association | basis per `classifyMembershipBasis` |
| `relationsFromDeep`: membership names that resolve to a catalogue row | 35 physical, 298 association | member-of |
| curated file (`relations.v1.json`), each with a cited paper | 5 | Proxima orbits Alpha Cen A and B (Kervella et al. 2017, arXiv:1611.03495); Alpha Cen A and B components of one binary (Pourbaix and Boffin 2016); Sun part-of Milky Way; Sgr A* part-of Milky Way (GRAVITY 2019; Genzel et al. 2010) |
| `relationsFromSameAs` | 0 in the final graph | after merging, `sameAs` pairs are aliases, not edges |

**Rule for group membership** (`classifyMembershipBasis`): physical only if the group's own basis text says "physical group", "gravitationally bound", "virialised" and the like; a distance cut ("within 3 Mpc of the Sun"), "all rows of a catalogue", "our cut, not a published membership" or contamination language makes it an association whatever the real astronomy is. The atlas claims only what its source states.

**What is not invented.** Sirius has no relation edges in the data. The Gaia subset holds a record named "Sirius C" 6,857 AU away whose SIMBAD identifiers include "NAME Sirius B", and the Sirius note says the star is orbited by a white dwarf, but no relation source in the atlas links the two records, so the atlas draws no edge. Planets are not related to each other; moons are not related to each other; no hierarchy is built for stars in the Milky Way beyond the two curated edges; stars have no cluster membership.

**Examples from real data** (`atlas.relationsOf`):
- Europa: orbits Jupiter (physical, Solar System dataset parent body).
- TRAPPIST-1 (`gaia:2635476908753563008`): 7 planets, all physical, from the archive.
- Proxima Cen: orbits Rigil Kentaurus and Toliman (physical, curated, Kervella et al. 2017) and has planets b and d (physical, archive); total 4.
- M81: member of the M81 Group, physical, because the source defines the group as physical. M31: member of the Local Group, association (101 members listed there are all association). Virgo Cluster: 203 listed members, all association by our own selection cut.

## 11. Discovery lists

Code: `src/discovery/discover.ts`; UI `FeaturedTab.ts`. Each list states `criterion`, `scope` ("among N records ..., out of M in view", with the contributing datasets), `caveat`, `completeness: 'not complete'`, the count of records excluded and why. A record without the ranked value is excluded and counted, never ranked as 0. Each item's one-sentence reason is composed only from the record's own data; no interest story is generated. Values re-measured on the real data:

| List | Criterion | Qualifying | First three |
|---|---|---|---|
| Nearest stars | smallest distance among stars with distance S/N >= 5 | 35,576 of 36,080 star records | Toliman 1.25 pc, Proxima Cen 1.30 pc, Rigil Kentaurus 1.32 pc |
| Brightest stars as seen from the Sun | smallest apparent magnitude as published in each dataset | 35,751 | Sirius -1.44, Canopus -0.62, Arcturus -0.05 |
| Fastest proper motion | largest total proper motion (mas/yr), not a speed ranking | 35,708 | Barnard's star 10,393, Kapteyn's star 8,644, HD 103095 7,062 |
| Nearest stars with confirmed planets | nearest host with S/N >= 5 | 4,591 of 4,862 hosts | Proxima Cen 1.30 pc, Barnard's star 1.83 pc, Ran 3.22 pc |
| Most confirmed planets in one system | count of planets listed in the archive | 4,862 hosts | KOI-351 (8), TRAPPIST-1 (7), HD 219134 (6) |
| Hottest exoplanets | highest equilibrium temperature (modelled) | 5,930 of 6,470 | KOI-55 b 7,778 K, KOI-55 c 6,911 K, KELT-9 b 3,921 K |
| Shortest orbital periods | smallest period | 6,108 | PSR J1719-1438 b 2.18 h, ZTF J1828+2308 b 2.69 h, M62H b 3.19 h |
| Largest exoplanets | largest radius | 6,415 | V2376 Ori b, HD 100546 b, GQ Lup b |
| Nearest galaxies | nearest with a directly published distance (curated, UNGC, McConnachie) | 683 of 966 | Canis Major 7.00 kpc, Segue 1 20.0 kpc, Sag dSph 20.0 kpc |
| Largest nebulae by physical size | largest derived physical diameter | 6 of 9 | Veil Nebula 48.5 pc, Eagle Nebula 39.3 pc, Orion Nebula 8.04 pc |

Caveats written into the lists include: Gaia DR3 omits stars brighter than G = 1.5; a nearest-star distance with S/N < 5 is not used; proper motion is an angular rate, not a speed; detection methods favour short periods and large planets; the galaxy catalogues are compilations (the Zone of Avoidance hides galaxies); 2MRS distances are not independent and are not ranked; nebula sizes are the catalogue's own isophote, not a sharp boundary.

**There is no list of variable stars.** The Hipparcos file carries a per-star `variability` text (Hipparcos type: 466 periodic, 1,005 unsolved, 467 micro-variable, 990 duplicity-induced, 17 type R, 2,903 no variability detected, 3,094 with a magnitude range only), but the engine does not map it into a record or a filter, so neither the lists nor the UI offer one. No variable-star catalogue is held.

## 12. Educational notes

Schema (`src/discovery/types.ts`, file `public/data/discovery-notes.v1.json`, schema `atlas-discovery-notes/1`): per object `oneLine`, sections `what`, `why`, `discovery`, `interesting`, `uncertain`, and `studiedBy` (mission, role, reference). Every statement is a `NoteClaim`: text, status (observed, inferred, hypothesis, historical) and one or more references with label, URL and retrieval date. The validators check that ids exist, every claim has a valid status and an https reference with an ISO date, `what`, `why` and `uncertain` are present, no section has more than 3 claims, `oneLine` is at most 120 characters, no emoji. `validate_notes.mjs` checks the solar and deep-space source file (re-run: 45 notes, 214 claims, 0 errors) and only knows solar and deep ids, so the stars and exoplanet notes are checked by `validate_relations.mjs` together with the relations (re-run: 5 relations and 24 notes validated, OK).

**Sourcing policy.** Each claim was written from a page fetched in the authoring session (NASA Science, ESA, ESO, arXiv abstract pages, SIMBAD and archive queries). No claim from memory; where a source did not state it the claim was dropped. Wikipedia is not cited. Superlatives appear only with attribution ("NASA calls ..."). The UI says "Notes paraphrase the cited pages; they are not measurements."

**What exists** (counted from the shipped file):

| | |
|---|---|
| notes | 69: Solar System 18, deep space 27, Hipparcos stars 14, exoplanets 8, exoplanet host 1, other 1 |
| claims | 405: observed 213, inferred 107, historical 44, hypothesis 41; sections what 129, why 92, discovery 40, interesting 26, uncertain 118 |
| distinct reference URLs | 140; `studiedBy` entries 103 |
| objects | Sun, 8 planets, Moon, Io, Europa, Ganymede, Callisto, Titan, Enceladus, Triton, Phobos; Milky Way, M31, M33, LMC, SMC, M87, Cen A, M81, M104, M32; Orion, Eagle, Carina, Crab, Ring, Horsehead, Veil nebulae, NGC 1999; Pleiades, Hyades, Omega Cen, M13, 47 Tuc, M4; Local Group, Virgo Cluster, M81 Group; Sirius, Betelgeuse, Proxima, Alpha Cen A and B, Barnard's star, Vega, Polaris, Rigel, Arcturus, Antares, Tau Ceti, Epsilon Eridani, Mira; Proxima b, TRAPPIST-1 and its planet e, 51 Peg b, Kepler-452 b, 55 Cnc e, HD 209458 b, LHS 1140 b, TOI-700 d; Sagittarius A* |

**Limitations.**
- The notes paraphrase fetched pages or abstracts. They were not independently re-verified against the full page text; for the Solar System and deep-space notes the fetch tool returned model-summarised quotations, and for arXiv papers only abstracts were read.
- Two notes are weak by source count: M81 and M32 each rest on a single NASA Hubble Messier page. Several others are thin (3 to 4 claims): Callisto, Milky Way, LMC, SMC, Cen A, the Carina, Horsehead and Veil nebulae, NGC 1999, Pleiades, Hyades, Omega Cen, M13, 47 Tuc, M4, Local Group, Virgo Cluster, M81 Group. Rigel, Arcturus and Mira have one to three references.
- Where a source number differs from the atlas value the note says so. The list is in `docs/DISCOVERY_NOTES_SOURCES_SOLAR_DEEP.md`: Orion Nebula NASA 1,500 ly (about 460 pc) vs atlas 418.5 pc; Eagle 7,000 ly (about 2.1 kpc) vs 1.69 kpc; Ring 2,000 ly vs 782.5 pc; Horsehead (ESA) 1,300 ly vs 431 pc; Veil 1,500 ly vs 725 pc (Fesen et al.); LMC 52,000 pc vs 49.59 kpc; M104 28 Mly vs 9.55 Mpc; M4 5,500 ly vs 1.85 kpc; M104 morphology (NASA spiral, McQuinn et al. elliptical); Titan surface pressure; Sun width about 100 times Earth vs atlas ratio about 109.
- Not covered (no source fetched): Deimos and further moons, Mercury's core, Venus surface streaks, Perseverance and Juno's Europa ice-shell result (pages returned 404); details of what was dropped for stars and exoplanets are in `docs/DISCOVERY_NOTES_SOURCES_STARS_EXO.md`.
- 69 objects out of 90,950 have a note; a record without one shows "No curated explanation yet." and nothing else (the UI never fills the gap).

## 13. Saved discoveries

Code: `src/discovery/saved.ts`; UI `SavedTab.ts`, `savedViewModel.ts`, inspector actions.

- **Storage adapters** (`StorageAdapter`): `MemoryAdapter`; `LocalStorageAdapter` wraps every access in try/catch and falls back to memory when storage is blocked or full, then reports `persistence: 'memory-only'` with a reason, which the Saved tab shows as a warning. Default key `atlas.saved`.
- **Schema v1** (`schema: 'atlas-saved'`, `version: 1`, a revision counter): bookmarks (id, savedAt, optional note up to 1,000 characters), collections (id, name up to 60 characters, createdAt, ordered ids), history (id, at, optional dataset and context). Limits: 2,000 bookmarks, 50 collections, 2,000 items per collection, 200 history entries, 1,000,000 characters in all (`DEFAULT_LIMITS`). Migration `0 -> 1` converts an unversioned document.
- **Robustness**: a corrupt document never throws; it is copied to `<key>.backup`, the store starts empty and `loadReport` says what happened. A document from a newer version is also backed up, never overwritten silently. Invalid shapes are dropped and counted. A saved id that no longer resolves is reported as unresolved and kept.
- **Collections**: create, rename, delete (with confirmation in the UI), reorder, add, remove, move within.
- **History**: every selection is recorded (`recordVisit`) with its context ("search: ...", "discover drawer").
- **Export and import**: `exportJson()` and `importJson(text, { mode: 'merge' | 'replace' })` with an `ImportReport`; the UI exports to a text document and imports with merge. `mergeSavedStates` merges two states deterministically.
- **`SyncAdapter`** (`push(state)`, `pull()`): an interface and an extension point only. Nothing implements it.
- **Not implemented**: accounts, a backend, cross-device sync, sharing links for collections. Saved data lives in this browser only, and the tab says so. The URL hash (filter state, drawer tab) is the only shareable state.

## 14. Rendering of discovery data

**Hipparcos supplement** (`src/render/discovery/BrightStarLayer.ts`, `brightStarSet.ts`, `brightStarColour.ts`; attached through `src/render/discovery/attachDiscoveryRenderers.ts` and `viewer.addStarPassLayer`). It draws only the Hipparcos stars the Gaia layer does not already draw.

- **Placement rule** (one rule for the layer and the engine, `src/discovery/brightPlacement.ts`): parallax S/N >= 10 is placed; a star with an IAU name and S/N 5 to 10 is placed as low reliability (derived distance, uncertainty from the parallax error, note "low reliability: parallax S/N < 10": Betelgeuse 7.9, Antares 5.9); every other star is sky-only (Alnilam, S/N 3.7, is searchable and inspectable but not drawn; an opt-in `namedMinSnr: 3` would place it). Positions are propagated from J1991.25 to J2016.0 along a great circle with zero radial velocity; distance is unchanged.
- **Brightness**: absolute magnitude M_V = V - 5 log10 d + 5 is passed to the Gaia layer's shader as if it were M_G. V stands in for G (they differ by up to about 0.3 mag for B to M dwarfs): a visual approximation, not photometry. Variability is not modelled.
- **Colour**: B-V converted to BP-RP with the Pecaut and Mamajek mean dwarf sequence (Table 5, version 2022.04.16, www.pas.rochester.edu, retrieved 2026-11-13), then through the existing BP-RP ramp. It is a dwarf-sequence relation, so giants and supergiants are only approximately coloured.
- **Counts** (R2b report and the API QA log): 457 of 8,942 rows drawn (312 with no Gaia link plus Gaia-linked rows the Gaia layer cannot draw, which overlap); 8,320 not drawn because the Gaia layer already draws their linked Gaia record (the Gaia layer draws 34,890 of 35,325); 165 not placed. 27 named stars are placed as low reliability. The API QA run recorded the layer as `hipparcos-bright-stars` with 457 points.
- **Cost**: the update runs per frame; node measurement 0.04 ms per frame for 7,043 stars (R2b report), build 107 ms. No GPU measurement.
- **Accuracy check**: screen centroids of Sirius, Betelgeuse, Rigel, Vega, Arcturus, Polaris and Rigil Kentaurus against an independent gnomonic projection of catalogue RA/Dec were all within 1 px (R2b, software GL).

**Exoplanet host and other-object markers** (`src/render/deep-space/DiscoveryMarkers.ts`, `DiscoveryRings.ts`): 4,834 of 4,862 hosts have a distance and are drawable as halos (28 are sky-only and counted, not drawn); one draw call; the layer is off by default and there is no on-screen control for it (`viewer.setExoplanetHostsVisible(true)` from code only). The six curated other objects have a dot, halo and label. Highlight rings (at most 256) mark filter, nearby and search results, plus the selection proxy. At the start view the frame is 3 draw calls (Gaia field, Sun marker, Hipparcos supplement); the marker meshes add none when nothing is shown; turning the host layer on adds exactly one (6 to 7 calls in the API QA scene).

## 15. User interface (what exists)

Implemented in `src/ui/discovery/*` and `index.html`. Only the following exist; U1's work was still in progress when this was written, so check the code for later changes.

- **Search box** (top left, "Search the atlas ( / )"): an ARIA combobox and listbox, focus stays in the input. `/` focuses it. Category chips with counts. 60 ms debounce and a request counter so a stale answer never replaces a newer one. Rows show category as text, name, a compact distance, the matched designation when it is not the name, and "distance unknown" and "not drawn / inspect only" for records without one. Messages for an empty result ("Nothing matches ... in the datasets loaded", with datasets searched) and for invalid identifiers. Enter selects and flies; Shift+Enter inspects without flying; arrows, Home and End move; Esc clears and then leaves.
- **Discover drawer** (`D` or the Discover button): a left sheet (a bottom sheet at 700 px wide or less) with tabs Featured, Filter, Nearby, Saved (arrow keys, Home, End), a Narrow or Wide pin remembered in `localStorage` (`atlas.drawer.pinned`). Below 1100 px wide only one of drawer and inspector is open at a time. Esc closes the top-most panel.
  - Featured: the ten lists of section 11, each with criterion, scope, caveat, completeness statement and excluded counts, items with value, uncertainty, OBS / DER / MOD tag and a reason, and a "Note" with sources where one exists.
  - Filter: categories, distance bands, datasets, spectral classes and numeric ranges, only for what the facets say has data, with live count, excluded-for-missing sentences, at most 40 listed rows, "Show in the sky" (highlights at most 256 matches) and a shareable URL hash.
  - Nearby: around the selected object or the camera focus, radius slider from AU to Mpc, one category group, "In the same system" listed apart from "Neighbours".
  - Saved: bookmarks, collections, history, export and import, persistence warning and unresolved ids.
- **Navigation context** (top centre): Back, Forward and "Return to previous view" labelled with the object they lead to, plus one line saying what the camera is doing; `Alt+Left` and `Alt+Right`.
- **Inspector additions**: Bookmark, collection menu, Find nearby, Go to parent, Back; a Relationships block grouped by basis (or "No relationships are recorded for this object in the datasets loaded"); an Explanation block (one line, policy line, expandable sections, status label and reference with retrieval date on every claim).
- **Keys** (existing, unchanged): `Backspace` parent, `O` overview, `H` home, `M` `L` `U` scales, `Esc` deselect. New: `/`, `D`, `Alt+Left`, `Alt+Right`.
- Not built in the UI: a toggle for the exoplanet host layer; a variable-star list; any account feature; multi-language names.

## 16. Testing

**Unit and integration tests (vitest), re-measured on 2026-11-13.** The whole suite: 52 files, 1,265 tests, of which 1,264 passed and 1 is skipped (a pre-existing sentinel); in the full run on a heavily loaded machine (load average about 12) one test in `tests/discovery-records.test.ts` timed out at the 5 s default and passed when that file was run alone (70 of 70). The 23 `tests/discovery-*.test.ts` files hold 604 tests (603 passed, 1 skipped, re-run with `npx vitest run discovery`). They cover: normalisation rules and the must-not-conflate list; the search index (match kinds, fuzzy flags, caps, categories); record store, filters and spectral parsing; KD-tree against brute force (2,500 radius, 3,000 k-NN, 1,600 filtered queries, 500 `findNearby` queries across three frames, 200 random frustums); frame-correct nearby with a displaced frame, a 10 Mpc origin and a naive-subtraction counter-example; relations (basis rules, validation, real data); saved discoveries (corrupt, future-version, blocked storage, import and export, migration); navigation call order and history; discovery lists; adapters and `mergeRecords` on the full real data; the engine and atlas with fake failing data sources; the atlas with a fake viewer host on the real data; Hipparcos placement, epoch propagation and de-duplication against the Gaia drawn set; marker counts and selection-proxy rules; pure UI view models (search, filter, nearby, saved, notes, relations). Tests that need real data files skip with a visible reason if a file is absent.

**Real-browser QA (Chromium, SwiftShader software GL).**
- `npm run qa:discovery-api` (`tools/qa-discovery-api.mjs`, `docs/qa/discovery/qa-api-log.json`, 9 screenshots `01` to `09`): last recorded run 64 of 65 checks pass. The failing check is "clicking a host halo (lowest pick tier) selects that host star through the atlas": `viewer.pickDeep` returned `host:Gl 686` but the selection stayed empty (an alias-resolution problem on that click path, not fixed at the time of writing).
- `npm run qa:discovery-ui` (`tools/qa-discovery-ui.mjs`, `docs/qa/discovery/ui-qa-log.json`, 33 screenshots `ui-01` to `ui-33`): last recorded run 136 of 136 checks, 0 warnings. It drives real keyboard and mouse input through search, drawer, inspector, nearby, history, saved, keyboard-only use, tab order, race handling and 4 viewport sizes (1280x800, 1024x700, 768x1024, 390x844) including touch-target size and no horizontal scroll, and storage blocked. The interface work was not declared finished when this was written: treat these logs as the record of the run they contain, and re-run before relying on them.
- Existing suites (`qa:browser` 26, `qa:solar` 43, `qa:deepspace` 129): when the engine author last ran them, `qa:deepspace` was 128 of 129 and `qa:browser` 25 of 26 because the highlight marker renderer drew one draw call with nothing highlighted. They were not re-run for this document; see `docs/qa/discovery/*-log.json` and the status document for later runs.

**Not verified.** Any GPU; browsers other than Chromium; real mobile devices and touch (a 390 px viewport was only emulated); screen readers (ARIA roles and focus management are present and tested through attributes, but nothing was run in NVDA, JAWS or VoiceOver); high-contrast modes; the Worker engine with a real slow network; load on very low-memory devices; WebXR (not built).

## 17. Performance observations

- Search is answered from an in-memory index; the page only awaits a Promise. In the real browser run the page's own 150 ms probe saw a median of 27.2 ms during indexing, with the worst answers waiting on a non-sliceable worker step.
- The page thread shows no long tasks from indexing in the recorded runs (0 in the 12.1 s run; one 64 ms task in one earlier run).
- Index building is the largest cost. Re-measured in node: 2.5 s for the stage-0 index, 2.5 s for the stage-1 rebuild with the merged records, 1.4 s to add the point catalogues in stage 2 (sliced; the largest slice was 69 ms).
- Memory (engine author's node measurement): about 157 MB heap without 2MRS indexing, 167 MB with.
- The spatial benchmark shows the KD-tree answering radius and k-nearest queries in 0.01 to 0.5 ms against 3 to 8 ms for brute force on 500,000 points (section 8).
- Nothing here is a GPU figure. Frame-time costs of the Hipparcos layer and markers are node measurements of the JavaScript update (0.04 and 0.124 ms per frame in the R2b report), not frame times.

## 18. Limitations

- Coverage is the 12 datasets above. A star not in them cannot be found.
- Gaia distances are 1000 / parallax without zero-point correction; Hipparcos named stars with S/N 5 to 10 are placed with a low-reliability note, and their uncertainty probably understates the real one (resolved discs, variability).
- The Hipparcos supplement uses V as a stand-in for G and a dwarf-sequence B-V to BP-RP relation.
- 2MRS distances are cz / H0 with H0 = 70 km/s/Mpc (an application choice), peculiar velocities not removed; 426 rows below 1,000 km/s have no distance.
- No variable-star list: no catalogue held, and the Hipparcos variability text is not exposed (section 11).
- No exoplanet atmosphere data; planet records have only archive period, radius, mass, equilibrium temperature. Mass is shown with its kind; 3,034 of the 6,439 mass values are estimates from a mass-radius relation (`massKind`); Msini values are not stored as a mass.
- 28 exoplanet hosts have no distance and cannot be placed in 3D; the exoplanet host layer has no UI control.
- Exoplanet host stellar parameters are first-row values; 218 hosts disagree between their planet rows in the source on a stellar parameter.
- Only 69 objects have explanations; the notes are paraphrases (section 12).
- The 40 IAU-named stars without a HIP number (mostly exoplanet hosts) were not added to the supplement.
- Four named Hipparcos stars (HIP 31067, 55203, 78727, 115125) have no row in the new reduction and are absent.
- Saved discoveries are local to one browser; no sync.
- Search typo tolerance covers alphabetic words of four or more letters only; there is no phonetic or multi-language matching.
- The page cannot answer while the worker is inside a non-sliceable step (up to about 1 s during load).
- If the Worker fails after it was created the engine stops and the search falls back to the older Gaia and deep-space search; only a failure to construct it falls back to the inline engine (stated in the R2a report; not re-tested).
- `Backspace` and the overview keys still run through legacy viewer paths first and are recorded into the atlas history through the page's hooks (see `docs/DISCOVERY_ENGINE_RUNTIME.md`).
- Licence questions in section 3.3 are open.

## 19. Rebuild commands and file sizes

```bash
npm run data:stars:offline       # Hipparcos supplement from data/cache/discovery/stars (fails on a cache miss)
npm run data:stars               # fetch (cached) and build
npm run data:exoplanets:offline  # NASA Exoplanet Archive from data/cache/discovery/exoplanets; byte-identical (sha256 c2ccabae...de0ac)
npm run data:exoplanets          # fetch (cached) and build; add -- --refresh to ignore the cache
npm run data:other:offline       # six other objects from data/cache/discovery/other
npm run data:other
npm run discovery:notes          # merge tools/discovery/notes/*.json into discovery-notes.v1.json and relations.v1.json
node tools/discovery/notes/validate_notes.mjs       # validate the notes
node tools/discovery/notes/validate_relations.mjs   # validate the relations
node tools/discovery/validate_stars_other.mjs       # validate the stars and other-objects files
npm run bench:spatial            # 500,000-point spatial benchmark, about 70 s; accepts a point count: npm run bench:spatial -- 100000
npm run qa:discovery-api         # needs a preview server on 127.0.0.1:4173 and Playwright (PLAYWRIGHT_MODULE_DIR=/root/jumanji-vr)
npm run qa:discovery-ui
```

`npm run data:stars:offline` was run for this document as a check of the flag: it rewrote `public/data/bright-stars.v1.json.gz` (718,108 bytes, same size as before) and `docs/DISCOVERY_DATA_STARS.md`. The other builders were not re-run here.

File sizes (`ls -l`, bytes) of the files the engine loads:

| File | Bytes |
|---|---|
| `public/data/gaia-dr3-subset.v1.json.gz` | 4,246,234 |
| `public/data/simbad-crossid.v1.json.gz` | 1,436,638 |
| `public/data/solar-system.v1.json` | 185,667 |
| `public/data/deep-space.v1.json` | 294,796 |
| `public/data/bright-stars.v1.json.gz` | 718,108 |
| `public/data/exoplanets.v1.json.gz` | 662,421 |
| `public/data/other-objects.v1.json` | 17,876 |
| `public/data/discovery-notes.v1.json` | 236,018 |
| `public/data/relations.v1.json` | 3,415 |
| `public/data/deepspace/ungc.v1.json.gz` | 34,364 |
| `public/data/deepspace/local-group-mcconnachie.v1.json.gz` | 5,066 |
| `public/data/deepspace/twomrs.v1.json.gz` | 1,380,664 |
| total of the twelve | 9,221,267 (compressed where named .gz) |

The three new files (bright stars, exoplanets, other objects) plus notes and relations add 1,637,838 bytes to the earlier set. Source of truth for the datasets and caches: `data/cache/discovery/` (stars 15 MB, exoplanets 7.6 MB, other 400 KB on disk).
