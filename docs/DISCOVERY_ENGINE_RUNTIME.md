# Discovery engine: runtime architecture (Prompt 07, R2a)

How the 90,971-record atlas is loaded, indexed and queried without blocking the page. Code: `src/discovery/{atlas,loader,scheduler,workerEngine,worker,workerClient,engineApi}.ts`,
`src/render/discovery/ViewerNavigationHost.ts`, viewer additions in `src/render/viewer.ts`, wiring in `src/main.ts`.

## Threads

```
page thread                                   Worker (src/discovery/worker.ts)
-----------                                   --------------------------------
DiscoveryAtlas (atlas.ts)   --- calls ---->   AtlasEngine (workerEngine.ts)
  record cache (peek)       <-- results ---     loads, adapts, merges, indexes, answers queries
  notes (alias aware)       <-- status ----     SearchIndex, RecordStore, KD-tree, RelationGraph,
  SavedStore (localStorage)                       facets, lists, FrameTree
  NavigationController + ViewerNavigationHost
```

Why a Worker: measured in node on the real data (cold JIT), `recordsFromGaia` 0.8-1.0 s, `mergeRecords` 0.8-1.3 s, `RecordStore.from` 0.4-0.65 s, `SearchIndex.add` of all
records about 3 s. The first three cannot be cut into time slices without changing the R1 modules. The engine therefore runs in a Worker; the page never holds the index.
Inside the Worker the loop that can be cut (index building) runs in adaptive slices of about 8 ms (`scheduler.ts: runSliced`) so queries are answered between slices.
Without `Worker` (tests, odd browsers) `InlineEngineClient` runs the same class on the calling thread; its non-sliceable steps then block that thread.

Every query is a Promise. Synchronous on the page: `status`, `peek(id)` (cache), `noteFor(id)`, `saved`, `navState()`.

## Stages

| stage | datasets | what becomes available |
|---|---|---|
| 0 | gaia, simbad, solar, deep | `readyForSearch`: search over Solar System, deep objects and the Gaia subset (35,325 + 27 + 29 records) |
| 1 | bright-stars, exoplanets, other-objects, relations (notes on the page thread) | `mergeRecords` (one record per star, Gaia wins), index #1 built in the background and swapped in atomically, then store, KD-tree, facets, relation graph, lists: `readyForQueries` (nearby, filter, relations, lists, visible) |
| 2 | ungc, mcconnachie, twomrs | point catalogues added to the live index in slices (lowest priority); store / tree / graph / lists rebuilt once: `complete` |

A failed dataset is reported (`state: 'failed'`, `error`) and skipped; the rest keeps working. Nothing rejects unhandled (`tests/discovery-atlas-engine.test.ts`).
The engine is started after the first painted frames, in `requestIdleCallback` time (`main.ts`); `?atlas=manual` leaves the start to the caller (QA).

## 2MRS decision

The 43,533 2MRS rows ("2MASX J..." identifiers) are in the store (filters, facets, nearby, galaxy lists use their real redshifts) and by default in the search index, so an
identifier finds its row. Measured cost (node, whole engine): +1.2 to 1.5 s index time (in the Worker) and about +10 MB heap (167 vs 157 MB). Switch off with
`indexTwoMrs: false`; the rows then stay reachable by id, nearby and filters.

## Measured (software GL Chromium, page otherwise idle; `tools/qa-discovery-api.mjs`)

* Main thread: 0 long tasks (>50 ms) in a 12 s idle baseline; 0 to 1 long tasks (longest 64 ms) during the 8 to 14 s the engine needs, across 4 runs.
* Engine thread (not the page): search ready 3.1-4.1 s after start, queries ready 6.4-11 s, complete 8.5-14 s. Longest uninterruptible step 0.64-1.0 s
  (a dataset adapter or `mergeRecords`), longest sliced index chunk 66-194 ms (varies with machine load) (segment compaction inside `SearchIndex.add`; a query waits at most that long).
* A search probe every 150 ms from the page saw a median answer time of 10-28 ms; the worst answers (0.45 to 1.3 s) came while the Worker was inside a non-sliceable step.

## Selection and navigation

`atlas.select(id, { focus })` serialises operations, resolves the record (one message if it is not cached), records the visit in `SavedStore.history`, calls
`NavigationController.select` (history entry with a camera snapshot taken when the entry is left), flies through the host when `focus` is true, and notifies
`onSelectionChange`. `back`/`forward`/`returnToPrevious` restore the snapshot of the entry as a flight. `parent()` asks the engine's relation graph.
Canvas clicks show the inspector immediately with the pre-existing UI and then record the visit with `focus: false`.

View-distance rules per category are documented at the top of `ViewerNavigationHost.ts`.

## F1 integration notes (renderers wired, merged duplicates, parent, nearby)

* **Renderers.** `src/render/discovery/attachDiscoveryRenderers.ts` loads `bright-stars`, `exoplanets` and `other-objects` on the page thread (off the boot path; the Worker fetches the same URLs
  for the engine, and the browser HTTP cache serves the second request, so each file travels once) and attaches the Hipparcos supplement (`viewer.addStarPassLayer(BrightStarLayer)`) and the marker
  data (`viewer.attachDiscoveryMarkers`). The exoplanet-host layer is OFF by default: `viewer.setExoplanetHostsVisible(true)`. `?discovery-renderers=off` skips all of it (A/B runs of the QA scripts).
* **Draw calls.** A mesh that is `visible` costs a draw call even when every instance is hidden, so the label meshes of `HighlightMarkers` and `OtherObjectMarkers` are made invisible
  (instance count 0) when no label is placed. At the start view the frame is Gaia field + Sun marker + the Hipparcos supplement = 3 draw calls; the marker meshes add none.
* **One placement rule for bright stars.** `src/discovery/brightPlacement.ts` is used by both `recordsFromBrightStars` and `buildBrightStarSet`: parallax S/N >= 10 is placed; a star with an IAU name and
  S/N 5-10 is placed with a `derived` distance, the uncertainty from the parallax error and the note "low reliability: parallax S/N < 10" (Betelgeuse 7.9, Antares 5.9); every other star is sky-only
  (Alnilam, S/N 3.7: searchable, inspectable, not drawn, "cannot place in 3D"). So the KD tree, `nearby()` and the inspector agree with what is drawn.
* **Catalogue rows that are a curated galaxy.** `src/discovery/duplicates.ts` is the structure renderer's documented duplicate rule (name / alias / 0.25' position), now shared. At stage 2
  `pointMerge.ts` merges such rows (the McConnachie "Andromeda", LMC, SMC, M32, NGC 5128 ...) into the curated `deep:*` record: the curated record wins, keeps the row's names as extra
  designations (searchable: `SearchIndex.extend`), lists the row in `sameAs`, and the row id becomes an alias. Cost: about 0.4 s in the Worker (43,533 2MRS rows are tested by position).
* **nearby() and planetary systems.** For an exoplanet or a star with confirmed planets the host and the planets (physical `orbits` relations) share one position (distance 0). They are returned in
  `system` (role host / planet) and are never in `neighbours`; `k` still returns k neighbours.
* **Parent and history.** `atlas.parent({ exclude, fallback })` walks the relation graph; when it names no usable parent it records a deselect (same history) and runs the viewer's own scale flight.
  Inside the Solar System the page excludes the Sun, so moon -> planet -> overview is unchanged. Overview, home and the scale keys also record a deselect first, so `back()` returns to the object and the camera.
