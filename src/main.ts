import { detectCapabilities } from './core/capabilities';
import { GaiaCatalogue } from './data/catalogue/catalogue';
import { inspectDiscoveryRecord, inspectObject } from './data/catalogue/inspect';
import { loadJson } from './data/catalogue/load';
import { searchCatalogue } from './data/catalogue/search';
import { createBrowserAtlas, type DiscoveryAtlas } from './discovery/atlas';
import { ViewerNavigationHost, type Placement } from './render/discovery/ViewerNavigationHost';
import { attachDiscoveryRenderers, type DiscoveryRenderersReport } from './render/discovery/attachDiscoveryRenderers';
import type { DiscoveryRecord } from './discovery/types';
import type { Vec3 } from './core/spatial/vec3';
import type { GaiaDatasetFile, SimbadCrossIdFile } from './data/catalogue/types';
import { DEFAULT_ORBIT, parsecsPerPixel } from './render/orbitCamera';
import { buildStarLayer, type StarLayer } from './render/starLayer';
import { Viewer } from './render/viewer';
import { Hud } from './ui/hud';
import { bindInput } from './ui/input';
import { Inspector } from './ui/inspector';
import { SolarUi } from './ui/solarUi';
import { DeepUi } from './ui/deepUi';
import { mountDiscoveryUi, type DiscoveryUi } from './ui/discovery';
import { SolarSystemData, type TextureProvenanceEntry } from './data/solar/solarCatalogue';
import { SimClock } from './core/orbits/time';
import { DeepSpaceData, loadDeepSpaceFile, loadImageProvenance } from './data/deepspace';

const base = import.meta.env.BASE_URL;
const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

async function boot(): Promise<void> {
  const hud = new Hud();
  const caps = await detectCapabilities();
  if (caps.backend !== 'webgl2') {
    hud.status('WebGL 2 is required to draw the star field and is not available in this browser.');
    return;
  }
  hud.status('Loading local Gaia DR3 subset…');
  const canvas = byId<HTMLCanvasElement>('scene');
  const viewer = new Viewer(canvas);

  const [gaiaFile, simbad] = await Promise.all([
    loadJson<GaiaDatasetFile>(`${base}data/gaia-dr3-subset.v1.json.gz`),
    loadJson<SimbadCrossIdFile>(`${base}data/simbad-crossid.v1.json.gz`).catch(() => null),
  ]);
  const cat = GaiaCatalogue.fromFile(gaiaFile);
  const layer: StarLayer = buildStarLayer(cat);
  viewer.setLayer(layer);
  hud.setDataset({
    catalogued: cat.count, layer, simbadMatched: simbad ? simbad.manifest.matched : null,
    release: cat.manifest.catalogue.release, retrieved: cat.manifest.retrieval.retrievedAt.slice(0, 10),
  });
  hud.status('');

  // Solar System: local dataset plus texture provenance (which also says how faithful each texture is).
  let solarData: SolarSystemData | null = null;
  let clock: SimClock | null = null;
  let solarUi: SolarUi | null = null;
  try {
    const [solarFile, texProv] = await Promise.all([
      fetch(`${base}data/solar-system.v1.json`).then((r) => { if (!r.ok) throw new Error(`solar dataset HTTP ${r.status}`); return r.json(); }),
      fetch(`${base}textures/provenance.json`).then((r) => (r.ok ? r.json() : { textures: [] })),
    ]);
    const entries = (texProv as { textures: TextureProvenanceEntry[] }).textures;
    solarData = SolarSystemData.fromFile(solarFile, entries);
    viewer.attachSolar(solarData, entries, `${base}`);
    clock = new SimClock(solarData.manifest.referenceEpoch.jdTdb);
  } catch (err) {
    console.error('Solar System unavailable', err);
    hud.status('The Solar System dataset could not be loaded; the star field is still available.');
  }

  // Deep space (R2a wiring; the UI phase extends this): curated objects + image provenance. Image levels load lazily by size on screen.
  let deepData: DeepSpaceData | null = null;
  try {
    const [deepFile, deepImages] = await Promise.all([loadDeepSpaceFile(base), loadImageProvenance(base)]);
    deepData = DeepSpaceData.fromFile(deepFile, deepImages);
    viewer.attachDeepSpace(deepData, deepImages);
  } catch (err) { console.error('Deep space unavailable', err); }

  // The real discovery renderers: the Hipparcos supplement (Sirius, Betelgeuse ... which Gaia cannot show), the exoplanet-host layer (default OFF) and the curated
  // 'other' objects. Loaded off the boot path; each dataset fails on its own (the page and the star field are unaffected).
  let discoveryRenderers: DiscoveryRenderersReport | null = null;
  // `?discovery-renderers=off` skips them (A/B comparison of the QA scripts with and without the supplement layer and the marker data).
  if (new URLSearchParams(location.search).get('discovery-renderers') !== 'off') void attachDiscoveryRenderers(viewer, cat, layer, base).then((r) => {
    discoveryRenderers = r;
    for (const f of r.failed) console.warn(`Discovery renderer data "${f.dataset}" could not be loaded: ${f.error}`);
  }).catch((err) => console.warn('The discovery renderers could not be attached.', err));

  const ring = byId('ring');
  // layer index per catalogue row (-1 = not drawn: no distance or no G magnitude)
  const layerOf = new Int32Array(cat.count).fill(-1);
  for (let k = 0; k < layer.count; k++) layerOf[layer.catalogueIndex[k]!] = k;

  let selected: number | null = null; // catalogue row of the inspected record
  let selectedBody: string | null = null;
  // ---- discovery atlas wiring (R2a) -------------------------------------------------------------------------------------------
  // The atlas (engine in a Web Worker) owns selection history and flights; the functions below only SHOW a selection. `shownId` is the universal id the inspector shows.
  let atlas: DiscoveryAtlas | null = null;
  let navHost: ViewerNavigationHost | null = null;
  let discoveryUi: DiscoveryUi | null = null;
  let shownId: string | null = null;
  let genericPos: Vec3 | null = null;          // heliocentric ICRS pc of a selection shown by the generic inspector (hip:, exo:, host:, other:, fallbacks)
  const sourceIdOf = (id: string): string => id.slice('gaia:'.length);
  const focusSelected = () => {
    if (selectedBody) { viewer.flyToBody(selectedBody); return; }
    if (selected === null || layerOf[selected]! < 0) return;
    const k = layerOf[selected]!;
    const p = layer.positionPc.subarray(3 * k, 3 * k + 3);
    viewer.flyTo({ ...viewer.state, focus: [p[0]!, p[1]!, p[2]!], distance: Math.min(viewer.state.distance, 12) });
  };
  let deepUi: DeepUi | null = null;
  const legacyClear = () => { selected = null; selectedBody = null; viewer.selectedBody = null; genericPos = null; shownId = null; deepUi?.clearSelection(); inspector.hide(); ring.style.display = 'none'; viewer.setSelectionProxy(null); };
  const clear = () => { legacyClear(); atlas?.deselect(); };
  const inspector = new Inspector(byId('inspector'), () => { if (deepUi?.selection) deepUi.flyToSelection(); else if (selected !== null || selectedBody) focusSelected(); else if (!atlas?.refocus()) focusSelected(); }, clear);
  // Selecting a Solar System body or a star drops any deep-space selection (the inspector is shared).
  const dropDeep = () => deepUi?.clearSelection();
  const selectBody = (id: string) => {
    if (!solarData || !solarUi) return;
    dropDeep();
    selected = null; selectedBody = id; viewer.selectedBody = id; genericPos = null; shownId = `solar:${id}`;
    inspector.show(inspectObject(solarData.toObject(id), { extraSections: solarUi.liveSections(id) }), { canFocus: true, focusLabel: 'Fly to this body' });
  };
  const selectRow = (row: number, focus = false) => {
    dropDeep();
    selectedBody = null; viewer.selectedBody = null; genericPos = null;
    selected = row; shownId = `gaia:${cat.sourceId(row)}`;
    inspector.show(inspectObject(cat.toObject(row, simbad)), { canFocus: layerOf[row]! >= 0 });
    if (layerOf[row]! < 0) ring.style.display = 'none';
    if (focus) focusSelected();
  };

  // ---- the selection router (R2a) -------------------------------------------------------------------------------------------
  // display(id): show the inspector for a universal id with the dedicated UI that exists for it. It never moves the camera (the atlas's host does).
  //   gaia:* -> selectRow     solar:* -> selectBody     deep:* -> deepUi.selectDeep     point:* -> deepUi.selectPoint (a row the renderer holds)
  //   everything else (hip:, exo:, host:, other:, and any of the above the dedicated UI cannot show) -> inspectDiscoveryRecord
  const showGeneric = (rec: DiscoveryRecord) => {
    dropDeep();
    selected = null; selectedBody = null; viewer.selectedBody = null;
    shownId = rec.id;
    const p = rec.position;
    genericPos = p.kind === 'icrs' ? p.xyzPc : null;
    inspector.show(inspectDiscoveryRecord(rec), { canFocus: genericPos !== null, focusLabel: 'Fly to this object' });   // notes, relations and actions are added by the discovery UI (src/ui/discovery)
    ring.style.display = 'none';
  };
  let quiet = false;       // true while display() runs for a selection the atlas already knows about: the deep panel's onSelected hook must not re-record it
  const display = (id: string, rec?: DiscoveryRecord): void => {
    if (shownId === id) return;
    quiet = true;
    try { displayInner(id, rec); } finally { quiet = false; }
  };
  const displayInner = (id: string, rec?: DiscoveryRecord): void => {
    const colon = id.indexOf(':');
    const ns = colon < 0 ? '' : id.slice(0, colon);
    if (ns === 'gaia') { const row = cat.indexOf(sourceIdOf(id)); if (row >= 0) { selectRow(row, false); return; } }
    else if (ns === 'solar' && solarData && solarData.get(id.slice(6))) { selectBody(id.slice(6)); return; }
    else if (ns === 'deep' && deepUi && deepData?.get(id.slice(5))) { deepUi.selectDeep(id.slice(5), { fly: false }); shownId = id; genericPos = null; selected = null; selectedBody = null; return; }
    else if (ns === 'point' && deepUi) {
      const key = id.slice(6);
      if (deepUi.selectPoint(key, { fly: false })) { shownId = id; genericPos = null; selected = null; selectedBody = null; return; }
    }
    const r = rec ?? atlas?.peek(id);
    if (r) showGeneric(r);
  };
  // The legacy flight for an id the atlas does not hold yet (the engine is still loading): the pre-atlas behaviour.
  const legacyFly = (id: string): void => {
    if (id.startsWith('solar:')) viewer.flyToBody(id.slice(6));
    else if (id.startsWith('deep:')) deepUi?.flyToSelection();
    else focusSelected();
  };
  /**
   * selectById(id): the one entry point for "the user chose this object". Records the visit in the atlas history (back / forward work) and, with fly, flies there.
   * display() is immediate for ids this page can show without the atlas (clicks stay instant even while the engine is busy indexing).
   */
  const selectById = (id: string, o: { fly?: boolean; context?: string } = {}): void => {
    const fly = o.fly ?? true;
    const local = /^(gaia|solar|deep|point):/.test(id);
    if (local) display(id);
    if (!atlas) { if (fly) legacyFly(id); return; }
    void atlas.select(id, { focus: fly, ...(o.context ? { context: o.context } : {}) }).then((r) => {
      if (!r.ok && r.error === 'unknown-id' && fly && local) legacyFly(id);
    });
  };

  const search = byId<HTMLInputElement>('search');
  const results = byId('results');
  let searchSeq = 0;
  const renderAtlasResults = (q: string, res: Awaited<ReturnType<DiscoveryAtlas['search']>>) => {
    results.replaceChildren();
    results.hidden = res.hits.length === 0;
    for (const h of res.hits) {
      const li = document.createElement('li');
      li.tabIndex = 0;
      li.textContent = h.name;
      if (h.id.startsWith('deep:')) li.dataset['deep'] = '1';          // the deep-space QA and styles look for this marker
      const small = document.createElement('small');
      small.textContent = `${h.matchedDesignation === h.name ? h.classification : `${h.matchedDesignation} \u00b7 ${h.classification}`}${h.drawn ? '' : ' \u00b7 not drawn'}`;
      li.append(small);
      const pick = () => { results.hidden = true; search.blur(); selectById(h.id, { fly: true, context: `search: ${q.slice(0, 60)}` }); };
      li.addEventListener('click', pick);
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter') pick(); });
      results.append(li);
    }
  };
  search.addEventListener('input', () => {
    if (atlas?.status.readyForSearch) {
      const q = search.value, seq = ++searchSeq;
      if (q.trim().length === 0) { results.hidden = true; return; }
      void atlas.search(q, { limit: 8 }).then((res) => { if (seq === searchSeq) renderAtlasResults(q, res); });
      return;
    }
    // Before the atlas is searchable: the pre-atlas search over the Gaia subset and the curated deep-space objects.
    const hits = searchCatalogue(cat, simbad, search.value);
    const deepHits = deepUi?.search(search.value) ?? [];
    results.replaceChildren();
    results.hidden = hits.length === 0 && deepHits.length === 0;
    for (const h of deepHits) {
      const li = document.createElement('li');
      li.tabIndex = 0;
      li.textContent = h.label;
      li.dataset['deep'] = '1';
      const small = document.createElement('small');
      small.textContent = h.matched;
      li.append(small);
      const pick = () => { h.run(); results.hidden = true; search.blur(); };
      li.addEventListener('click', pick);
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter') pick(); });
      results.append(li);
    }
    for (const h of hits) {
      const li = document.createElement('li');
      li.tabIndex = 0;
      li.textContent = h.label;
      const small = document.createElement('small');
      small.textContent = `${h.matched}${layerOf[h.index]! < 0 ? ' \u00b7 not drawn' : ''}`;
      li.append(small);
      const pick = () => { results.hidden = true; search.blur(); selectById(`gaia:${cat.sourceId(h.index)}`, { fly: true, context: 'search' }); };
      li.addEventListener('click', pick);
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter') pick(); });
      results.append(li);
    }
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const first = results.firstElementChild as HTMLElement | null; first?.click(); }
    if (e.key === 'Escape') { results.hidden = true; search.blur(); }
  });

  if (solarData && clock) solarUi = new SolarUi(viewer, solarData, clock, { select: (id) => selectById(`solar:${id}`, { fly: false, context: 'solar bar' }) });
  if (deepData && viewer.deep) {
    deepUi = new DeepUi(viewer, deepData, inspector, ring, {
      beforeSelect: () => { selected = null; selectedBody = null; viewer.selectedBody = null; genericPos = null; },
      onSelected: (id) => { shownId = id; if (!quiet) void atlas?.select(id, { focus: false, context: 'deep-space panel' }); },
    });
    viewer.enableQualityGovernor();
  }
  const gotoClock = clock;

  // A canvas pick of a star: the Gaia layer answers with a catalogue row, an extra star-pass layer (Hipparcos supplement) with its universal id (see Viewer.pick).
  const selectPicked = (star: { catalogueIndex: number; layerId?: string }): void => {
    if (star.layerId !== undefined) selectById(star.layerId, { fly: false, context: 'click' });
    else selectById(`gaia:${cat.sourceId(star.catalogueIndex)}`, { fly: false, context: 'click' });
  };

  // ---- the discovery atlas: engine in a Worker, started after the first paint ----------------------------------------------------
  try {
    const a = await createBrowserAtlas(base);
    atlas = a;
    const host = new ViewerNavigationHost(viewer, (id) => a.peek(id), solarData ? (b, jd) => solarData!.ephemeris.heliocentricPosition(b, jd) : undefined);
    let noteTimer = 0;
    host.onPlacement = (p: Placement) => {
      if (p.kind === 'inspect-only') {
        hud.status(`${a.peek(p.id)?.name ?? p.id}: ${p.reason}`);
        window.clearTimeout(noteTimer);
        noteTimer = window.setTimeout(() => hud.status(''), 7000);
      }
    };
    navHost = host;
    a.attachViewer(host);
    a.onSelectionChange((ev) => {
      if (ev.id === null) { if (shownId !== null) legacyClear(); return; }
      display(ev.id, ev.record);
    });
    // The discovery interface (search box, Discover drawer, navigation context, inspector additions). It only talks to the atlas API.
    discoveryUi = mountDiscoveryUi({
      atlas: a, inspector,
      select: (id, o) => selectById(id, { fly: o.fly, context: o.context }),
      shownId: () => shownId,
      isFlying: () => viewer.flying,
      goParent: () => goParent(),
      fallbackSearch: (q) => [
        ...(deepUi?.search(q) ?? []).map((h) => ({ label: h.label, matched: h.matched, run: h.run, deep: true })),
        ...searchCatalogue(cat, simbad, q).map((h) => ({ label: h.label, matched: `${h.matched}${layerOf[h.index]! < 0 ? ' \u00b7 not drawn' : ''}`, run: () => selectById(`gaia:${cat.sourceId(h.index)}`, { fly: true, context: 'search' }) })),
      ],
    });
  } catch (err) {
    console.warn('The discovery atlas is unavailable; search and selection use the Gaia subset only.', err);
    const pop = document.getElementById('sb-pop'); if (pop) pop.hidden = false;     // the pre-atlas search writes into #results, which lives in this pop-up
  }

  // ---- parent / overview / home through the atlas history -----------------------------------------------------------------------
  // One history for select, back, forward and parent. A view change that leaves the selected object (overview, home, a scale flight) first records a deselect in the
  // atlas, so back() returns to the object AND the camera the user left. Without an atlas (or while it still loads) the pre-atlas behaviour applies unchanged.
  const viaHistory = (fly: () => void): void => {
    if (atlas && atlas.selection !== null) atlas.deselect();
    fly();
  };
  /** The viewer's own parent step. `sel` is the deep-space selection the user had BEFORE the atlas recorded the deselect (the parent object comes from the curated parentId). */
  const legacyParent = (sel: string | null = deepUi?.selection ?? null): void => {
    if (viewer.solarActive) { viewer.flyToParent(); return; }
    if (!(viewer.deep && viewer.deepActive)) return;
    if (!atlas || !deepUi) { if (deepUi) deepUi.goToParent(); else viewer.flyToParentDeep(); return; }
    const t = viewer.parentDeepTarget(sel);
    if (t.kind === 'object') deepUi.selectDeep(t.id, { fly: true });                                // the parent object: DeepUi flies, selects and records the visit in the atlas history
    else if (t.kind === 'local-group') viewer.flyToLocalGroup();                                    // a scale flight: nothing is selected afterwards
    else viewer.flyToNearbyUniverse();
  };
  /**
   * Backspace. atlas.parent() walks the relation graph (a moon -> its planet, a planet -> its host star ...); when the data names no usable parent it runs the viewer's own
   * scale flight (a deep-space object -> its curated parent / the Local Group view / the nearby universe). Inside the Solar System the legacy chain is kept exactly:
   * moon -> planet -> overview (the Sun is not a "parent" to fly to). The step is recorded in the atlas history, so back / forward / parent share one history.
   */
  const goParent = (): void => {
    if (!atlas || !atlas.status.readyForQueries) { legacyParent(); return; }
    const inSolar = viewer.solarActive;
    const deepSel = deepUi?.selection ?? null;
    void atlas.parent({
      ...(inSolar ? { exclude: (l: { id: string }) => !l.id.startsWith('solar:') || l.id === 'solar:sun' } : {}),
      fallback: ({ hadSelection }) => {
        if (inSolar) { if (hadSelection) viewer.flyToOverview(); else viewer.flyToParent(); }
        else legacyParent(deepSel);
      },
    });
  };

  bindInput(canvas, {
    zoom: (d) => viewer.zoomBy(d),
    rotate: (a, b) => viewer.rotateBy(a, b),
    pan: (x, y) => viewer.panBy(x, y),
    pick: (x, y) => {
      // Priority: Solar System bodies, then the stars in their own scale; deep-space objects are pickable only once the camera is at
      // a deep-space scale (viewer.deepActive). Zoomed in close (< 1 kpc from the focus) a Gaia star under the cursor wins over a
      // deep-space object's disc; zoomed out the deep-space object wins.
      const body = viewer.pickBody(x, y);
      if (body) { selectById(`solar:${body}`, { fly: false, context: 'click' }); return; }
      const starFirst = !viewer.deepActive || viewer.state.distance < 1000;
      const star = starFirst ? viewer.pick(x, y) : null;
      if (star) { selectPicked(star); return; }
      if (deepUi && viewer.deepActive) {
        const id = viewer.pickDeep(x, y);
        if (id) {
          if (deepUi.selection === id) return;
          if (/^(hip|exo|host|other|gaia|solar|deep|point):/.test(id)) { selectById(id, { fly: false, context: 'click' }); return; }
          if (viewer.deepData?.get(id)) { deepUi.selectDeep(id, { fly: false }); return; }
          if (deepUi.selectPoint(id, { fly: false })) return;
        }
        if (!starFirst) { const r = viewer.pick(x, y); if (r) { selectPicked(r); return; } }
      } else if (viewer.hasMarkerRenderer) {
        // Below the deep-space scale only the discovery markers can be hit (an exoplanet host halo, Sgr A* ...); hosts are the lowest tier, curated 'other' objects rank above.
        const id = viewer.pickDeep(x, y, { discoveryOnly: true });
        if (id) { selectById(id, { fly: false, context: 'click' }); return; }
      }
      clear();
    },
    resetOrientation: () => viewer.resetOrientation(),
    home: () => viaHistory(() => viewer.flyTo(DEFAULT_ORBIT)),
    clearSelection: clear,
    toggleTime: () => gotoClock?.toggle(),
    slower: () => gotoClock?.slower(),
    faster: () => gotoClock?.faster(),
    reverseTime: () => gotoClock?.reverse(),
    parent: goParent,
    overview: () => viaHistory(() => { if (viewer.solar && (viewer.solarActive || !viewer.deepActive)) viewer.flyToOverview(); else if (viewer.deep) viewer.flyToDeepOverview(); }),
    ...(deepUi ? { milkyWay: () => viaHistory(() => deepUi!.flyScale('milky-way')), localGroup: () => viaHistory(() => deepUi!.flyScale('local-group')), nearbyUniverse: () => viaHistory(() => deepUi!.flyScale('nearby-universe')) } : {}),
  });

  const slider = byId<HTMLInputElement>('mag-limit');
  slider.addEventListener('input', () => viewer.setMagLimit(Number(slider.value)));
  const hideBox = byId<HTMLInputElement>('hide-suspect');
  hideBox.addEventListener('change', () => viewer.setHideSuspect(hideBox.checked));
  byId('suspect-count').textContent = `(${layer.suspectCount.toLocaleString('en-US')} stars, ${((100 * layer.suspectCount) / layer.count).toFixed(0)}%)`;
  byId('btn-home').addEventListener('click', () => viewer.flyTo(DEFAULT_ORBIT));
  byId('btn-reset').addEventListener('click', () => viewer.resetOrientation());
  byId('btn-in').addEventListener('click', () => viewer.zoomBy(-300));
  byId('btn-out').addEventListener('click', () => viewer.zoomBy(300));
  window.addEventListener('resize', () => viewer.resize());

  let lastFrame = performance.now(), lastLive = 0;
  const frame = () => {
    const now = performance.now();
    gotoClock?.advance((now - lastFrame) / 1000);
    lastFrame = now;
    viewer.render(gotoClock?.jd ?? 0);
    solarUi?.update();
    deepUi?.update(now);
    if (selectedBody && solarUi && now - lastLive > 400) { lastLive = now; inspector.updateLive(solarUi.liveSections(selectedBody)[0]!); }
    const vp = viewer.viewport;
    hud.update({
      distancePc: viewer.state.distance, viewportHeight: vp.height,
      fovSpanPc: parsecsPerPixel(viewer.state.distance, vp.height) * vp.height,
      magLimit: viewer.brightness.magLimit, drawCalls: viewer.drawCalls, flying: viewer.flying,
    });
    if (deepUi?.selection) { /* the deep-space ring is drawn by DeepUi.update */ }
    else if (genericPos && selected === null && !selectedBody && !(viewer.selectionProxy && viewer.hasMarkerRenderer)) {
      // A selection shown by the generic inspector (hip:, exo:, host:, other:): a ring at its position (the selection proxy marks the same place for objects too faint to see).
      const s = viewer.projectPc(genericPos);
      ring.style.width = ring.style.height = '28px';
      if (s.visible) { ring.style.display = 'block'; ring.style.transform = `translate(${s.x - 14}px, ${s.y - 14}px)`; } else ring.style.display = 'none';
    } else if (selectedBody) {
      const s = viewer.screenOfBody(selectedBody);
      if (s) { const r = Math.min(Math.max(s.r + 6, 14), 600); ring.style.display = 'block'; ring.style.width = ring.style.height = `${r * 2}px`; ring.style.transform = `translate(${s.x - r}px, ${s.y - r}px)`; }
      else ring.style.display = 'none';
    } else if (selected !== null) {
      ring.style.width = ring.style.height = '28px';
      const s = layerOf[selected]! >= 0 ? viewer.screenOf(layerOf[selected]!) : null;
      if (s) { ring.style.display = 'block'; ring.style.transform = `translate(${s.x - 14}px, ${s.y - 14}px)`; }
      else ring.style.display = 'none';
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  // The engine starts after the first painted frames, in idle time: the page is interactive before any discovery work begins.
  // `?atlas=manual` leaves the start to the caller (window.__atlas.discovery.start()): QA uses it to measure the page with and without the engine running.
  if (atlas && new URLSearchParams(location.search).get('atlas') !== 'manual') {
    const go = () => { void atlas!.start(); };
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const ric = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
      if (typeof ric === 'function') ric(go, { timeout: 1500 }); else window.setTimeout(go, 250);
    }));
  }

  // Test and QA hook: read-only access to live objects. Not used by the application itself.
  Object.assign(window, { __atlas: { viewer, deepData, get deepUi() { return deepUi; }, cat, layer, simbad, selectRow, selectBody, clear, solarData, clock, get solarUi() { return solarUi; }, get selected() { return selected; }, get selectedBody() { return selectedBody; }, get discovery() { return atlas; }, get ui() { return discoveryUi; }, get navHost() { return navHost; }, get discoveryRenderers() { return discoveryRenderers; }, selectById, display } });
}

boot().catch((err) => {
  console.error(err);
  new Hud().status(`Startup failed: ${String(err)}`);
});
