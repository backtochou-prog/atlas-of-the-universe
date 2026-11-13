// Real-browser QA of the discovery API (window.__atlas.discovery): search, selection with flights, history, nearby, saved, and what indexing costs the page thread.
// SOFTWARE GL ONLY (SwiftShader): nothing here measures GPU performance. Needs `npx vite build && npx vite preview --port 4173 --host 127.0.0.1`,
// and Playwright (PLAYWRIGHT_MODULE_DIR=/root/jumanji-vr). Screenshots go to QA_OUT (default docs/qa/discovery) and, if set, QA_OUT2.
// Exits non-zero if a check fails. Two page loads: the first with `?atlas=manual` (the engine does not start by itself) measures the main thread idle, then starts the
// engine and measures it again; the second is a normal load for the behavioural checks.
import { createRequire } from 'node:module';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
const require = createRequire((process.env.PLAYWRIGHT_MODULE_DIR ?? process.cwd()) + '/');
const { chromium } = require('playwright');

const URL = process.env.ATLAS_URL ?? 'http://127.0.0.1:4173/';
const OUT = process.env.QA_OUT ?? 'docs/qa/discovery';
const OUT2 = process.env.QA_OUT2 ?? '/tmp/claude-0/-root/5e13bb46-3246-5137-893e-4ec35ecb5ea4/scratchpad/r2a';
await mkdir(OUT, { recursive: true });
await mkdir(OUT2, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const checks = [], warnings = [], shots = [], log = {};
const problems = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`); };
const warn = (name, detail = '') => { warnings.push({ name, detail }); console.log(`WARN  ${name}${detail ? '  - ' + detail : ''}`); };

async function newPage() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url()}`); });
  // long tasks from the very start of the page (buffered observer)
  await page.addInitScript(() => {
    window.__long = [];
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push({ start: e.startTime, dur: e.duration }); }).observe({ type: 'longtask', buffered: true }); } catch { /* unsupported */ }
  });
  return page;
}

// ======================================================================================================================================
// Part 1: main-thread cost of indexing (page otherwise idle)
// ======================================================================================================================================
{
  const page = await newPage();
  await page.goto(URL + '?atlas=manual');
  await page.waitForFunction(() => window.__atlas?.discovery && window.__atlas.viewer, null, { timeout: 90_000 });
  await page.evaluate(() => window.__atlas.viewer.disableQualityGovernor());
  await page.waitForTimeout(6000);                                       // let the page settle (textures, first frames)
  const t0 = await page.evaluate(() => performance.now());
  await page.waitForTimeout(12_000);                                     // baseline: atlas NOT started, the page renders its star field
  const t1 = await page.evaluate(() => performance.now());
  await page.evaluate(() => {
    window.__times = {}; window.__lat = [];
    const a = window.__atlas.discovery;
    a.onStatus((s) => { const t = performance.now(); for (const k of ['readyForSearch', 'readyForQueries', 'complete']) if (s[k] && window.__times[k] === undefined) window.__times[k] = t; });
    window.__startedAt = performance.now();
    // probe: a search every 150 ms; latency = the time until the answer reaches the page (includes the engine being busy in its worker)
    window.__probe = setInterval(async () => { const s = performance.now(); const ready = a.status.readyForSearch; try { await a.search('sirius', { limit: 5 }); } catch { /* counted below */ } window.__lat.push({ t: s, ms: performance.now() - s, ready }); }, 150);
    a.start();
  });
  await page.waitForFunction(() => window.__times.complete !== undefined, null, { timeout: 240_000, polling: 500 });
  await page.evaluate(() => clearInterval(window.__probe));
  const t2 = await page.evaluate(() => performance.now());
  await page.waitForTimeout(2000);
  const r = await page.evaluate(([b0, b1]) => {
    const long = window.__long, times = window.__times, start = window.__startedAt, lat = window.__lat;
    const inWin = (a, b) => long.filter((e) => e.start >= a && e.start <= b);
    const stat = (l) => ({ count: l.length, longest: l.reduce((m, e) => Math.max(m, e.dur), 0), over100: l.filter((e) => e.dur > 100).length, totalMs: l.reduce((m, e) => m + e.dur, 0) });
    const during = inWin(start, times.complete);
    const base = inWin(b0, b1);
    const phase = (a, b) => stat(inWin(a, b));
    return {
      baseline: { ...stat(base), seconds: (b1 - b0) / 1000 }, indexing: { ...stat(during), seconds: (times.complete - start) / 1000 },
      toSearchReady: (times.readyForSearch - start) / 1000, toQueriesReady: (times.readyForQueries - start) / 1000, toComplete: (times.complete - start) / 1000,
      stage0: phase(start, times.readyForSearch), stage1: phase(times.readyForSearch, times.readyForQueries), stage2: phase(times.readyForQueries, times.complete),
      probes: lat.length, probeMax: lat.reduce((m, e) => Math.max(m, e.ms), 0), probeMaxBeforeReady: lat.filter((e) => !e.ready).reduce((m, e) => Math.max(m, e.ms), 0),
      probeMaxAfterReady: lat.filter((e) => e.ready).reduce((m, e) => Math.max(m, e.ms), 0),
      probeMedian: [...lat].map((e) => e.ms).sort((a, b) => a - b)[Math.floor(lat.length / 2)] ?? null,
    };
  }, [t0, t1]);
  log.mainThread = r;
  console.log('main thread:', JSON.stringify(r));
  const stats = await page.evaluate(() => window.__atlas.discovery.stats());
  log.engineStats = stats;
  console.log('engine: longest blocking step', stats.longestBlockingStepMs.toFixed(0), 'ms (worker thread); longest sliced chunk', stats.longestSliceMs.toFixed(0), 'ms (worker thread); records', stats.records, 'searchable', stats.searchable);
  check('indexing completed in the Worker with every dataset ready', await page.evaluate(() => { const s = window.__atlas.discovery.status; return s.complete && s.failed.length === 0 && s.records > 90000; }), `records ${stats.records}`);
  check('the page thread was not blocked by indexing: longest long task during indexing is no longer than the idle baseline + 100 ms', r.indexing.longest <= r.baseline.longest + 100, `indexing longest ${r.indexing.longest.toFixed(0)} ms (${r.indexing.count} long tasks in ${r.indexing.seconds.toFixed(1)} s), idle baseline longest ${r.baseline.longest.toFixed(0)} ms (${r.baseline.count} in ${r.baseline.seconds.toFixed(0)} s)`);
  await page.close();
}

// ======================================================================================================================================
// Part 2: behaviour
// ======================================================================================================================================
const page = await newPage();
const A = (fn, arg) => page.evaluate(fn, arg);
await page.goto(URL);
await page.waitForFunction(() => window.__atlas?.discovery && window.__atlas.viewer, null, { timeout: 90_000 });
await A(() => window.__atlas.viewer.disableQualityGovernor());
const searchBeforeReady = await A(() => window.__atlas.discovery.status.readyForSearch);
await page.waitForFunction(() => window.__atlas.discovery.status.complete, null, { timeout: 240_000, polling: 500 });
check('status: complete, nothing failed, 12 datasets reported', await A(() => { const s = window.__atlas.discovery.status; return s.complete && s.failed.length === 0 && s.datasets.length === 12 && s.datasets.every((d) => d.state === 'ready'); }));
log.searchReadyAtLoad = searchBeforeReady;

let shotNo = 0;
const snap = async (name) => {
  await page.waitForTimeout(500);
  const file = `${String(++shotNo).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: `${OUT}/${file}`, timeout: 120_000 });
  await copyFile(`${OUT}/${file}`, `${OUT2}/${file}`);
  shots.push(file);
};
const settle = () => page.waitForFunction(() => !window.__atlas.viewer.flying, null, { timeout: 120_000, polling: 250 });

const topId = (q) => A(async (q) => { const r = await window.__atlas.discovery.search(q, { limit: 5 }); return { id: r.hits[0]?.id ?? null, name: r.hits[0]?.name ?? null, ids: r.hits.map((h) => h.id), kind: r.hits[0]?.matchKind ?? null }; }, q);

// ---- search ---------------------------------------------------------------------------------------------------------------------
const sirius = await topId('Sirius');
check("search 'Sirius' -> hip:32349 named Sirius", sirius.id === 'hip:32349' && sirius.name === 'Sirius', JSON.stringify(sirius));
const expect = { 'TRAPPIST-1': (id) => id?.startsWith('gaia:') || id === 'host:TRAPPIST-1', 'Kepler-452b': (id) => id === 'exo:Kepler-452 b', 'Sagittarius A*': (id) => id === 'other:sgr-a-star', Europa: (id) => id === 'solar:europa', Proxima: (id) => id?.startsWith('gaia:') || id === 'hip:70890', Betelgeuse: (id) => id === 'hip:27989' };
for (const [q, ok] of Object.entries(expect)) { const r = await topId(q); check(`search '${q}' finds its object first`, ok(r.id), `${r.id} (${r.name}, ${r.kind})`); }
const m31 = await topId('M31'); check("search 'M31' -> deep:m31", m31.id === 'deep:m31', JSON.stringify(m31));
const andr = await topId('Andromeda'); check("search 'Andromeda' lists deep:m31 among its hits", andr.ids.includes('deep:m31'), `first ${andr.ids[0]} ids ${andr.ids.join(',')}`);
const bad = await A(async () => {
  const a = window.__atlas.discovery, out = [];
  for (const q of ['', ' ', 'a', '!!', 'x'.repeat(400), '\u0000\u0001', "'; drop table--", '<script>alert(1)</script>', '日本語', '💥']) {
    try { const r = await a.search(q); out.push(Array.isArray(r.hits)); } catch (e) { out.push(String(e)); }
  }
  try { await a.suggest(''); out.push(true); } catch (e) { out.push(String(e)); }
  return out;
});
check('invalid and empty queries return empty/normal results without throwing', bad.every((x) => x === true), JSON.stringify(bad));
const sug = await A(async () => { const s = await window.__atlas.discovery.suggest(''); return { kind: s.kind, featured: s.featured.length, history: s.history.length }; });
check('suggest(empty) offers the featured objects (those with explanations)', sug.kind === 'empty' && sug.featured >= 5, JSON.stringify(sug));
const note = await A(async () => { const a = window.__atlas.discovery; const id = await a.resolve('hip:70890'); return { id, note: a.noteFor(id)?.id ?? null }; });
check('alias-aware note: the note keyed hip:70890 is found from the merged (Gaia) Proxima record', note.id?.startsWith('gaia:') && note.note === 'hip:70890', JSON.stringify(note));

// ---- canvas click feeds the atlas history -----------------------------------------------------------------------------------------
await A(() => window.__atlas.viewer.flyTo({ focus: [0, 0, 0], distance: 60, yaw: 0.6, pitch: 0.35 }, 1));
await settle();
const clickInfo = await A(() => {
  const v = window.__atlas.viewer;
  // pick the brightest drawn star near the middle of the screen, then click exactly its projected position
  const layer = window.__atlas.layer;
  let best = null;
  for (let k = 0; k < layer.count; k++) {
    const s = v.screenOf(k);
    if (!s || s.x < 400 || s.x > 880 || s.y < 250 || s.y > 550) continue;
    const m = layer.absMag[k];
    if (best === null || m < best.m) best = { k, m, x: s.x, y: s.y };
  }
  if (!best) return null;
  const hit = v.pick(best.x, best.y);
  const canvas = document.getElementById('scene').getBoundingClientRect();
  return { x: best.x + canvas.left, y: best.y + canvas.top, hit: hit ? { catalogueIndex: hit.catalogueIndex, layerId: hit.layerId ?? null } : null, sid: hit && hit.layerId === undefined ? window.__atlas.cat.sourceId(hit.catalogueIndex) : null };
});
if (clickInfo?.hit && clickInfo.sid) {
  await page.mouse.click(clickInfo.x, clickInfo.y);
  await page.waitForFunction((id) => window.__atlas.discovery.selection === id, `gaia:${clickInfo.sid}`, { timeout: 30_000 }).catch(() => {});
  const sel = await A(() => ({ sel: window.__atlas.discovery.selection, inspector: document.getElementById('inspector').classList.contains('open'), hist: window.__atlas.discovery.saved.history().length, nav: window.__atlas.discovery.navState() }));
  check('clicking a star on the canvas selects it through the atlas (selection, inspector open, history entry)', sel.sel === `gaia:${clickInfo.sid}` && sel.inspector && sel.hist >= 1 && sel.nav.length >= 2, JSON.stringify(sel));
  await A(() => window.__atlas.clear());
  check('clear() deselects through the atlas', await A(() => window.__atlas.discovery.selection === null));
} else warn('canvas click test skipped: no star was found near the centre of the screen', JSON.stringify(clickInfo));
const histBefore = await A(() => window.__atlas.discovery.navState().length);

// ---- select Sirius with focus: flight is monotonic and ends at the host's view distance ---------------------------------------------
await A(() => window.__atlas.viewer.flyTo({ focus: [0, 0, 0], distance: 60, yaw: 0.6, pitch: 0.35 }, 1));
await settle();
const target = await A(async () => (await window.__atlas.discovery.getRecord('hip:32349')).position.xyzPc);
await A((tgt) => {
  const v = window.__atlas.viewer; window.__samples = [];
  window.__sampler = setInterval(() => { const s = v.state; window.__samples.push({ d: s.distance, f: Math.hypot(s.focus[0] - tgt[0], s.focus[1] - tgt[1], s.focus[2] - tgt[2]), flying: v.flying }); }, 60);
}, target);
const selRes = await A(() => window.__atlas.discovery.select('hip:32349', { focus: true, context: 'qa' }).then((r) => ({ ok: r.ok, noop: r.noop ?? null, error: r.error ?? null })));
check('select(hip:32349, focus) succeeds', selRes.ok && selRes.noop === false, JSON.stringify(selRes));
await settle();
await A(() => clearInterval(window.__sampler));
const fl = await A(() => ({ samples: window.__samples, state: window.__atlas.viewer.state, frame: window.__atlas.viewer.frame, sel: window.__atlas.discovery.selection }));
const mono = (xs) => xs.every((x, i) => i === 0 || x <= xs[i - 1] * (1 + 1e-9) + 1e-12);
const dists = fl.samples.map((s) => s.d), fdist = fl.samples.map((s) => s.f);
check('flight to Sirius: distance and distance-to-target decrease monotonically', mono(dists) && mono(fdist) && fl.samples.length >= 3, `${fl.samples.length} samples, distance ${dists[0]?.toFixed(2)} -> ${dists[dists.length - 1]?.toFixed(3)} pc`);
check('flight ends at the host view distance (4 pc) centred on Sirius', Math.abs(fl.state.distance - 4) < 1e-6 && Math.hypot(fl.state.focus[0] - target[0], fl.state.focus[1] - target[1], fl.state.focus[2] - target[2]) < 1e-9, `distance ${fl.state.distance}`);
check('viewer.frame and its breadcrumb are sane after the flight', typeof fl.frame.id === 'string' && fl.frame.id.length > 0 && Array.isArray(fl.frame.path), JSON.stringify({ id: fl.frame.id, path: fl.frame.path.map((p) => p.name) }));
check('selection is hip:32349 and the inspector shows Sirius', fl.sel === 'hip:32349' && await A(() => document.querySelector('#inspector h2')?.textContent?.includes('Sirius') ?? false), '');
const siriusState = fl.state;
await snap('sirius-selected');

// ---- nearby --------------------------------------------------------------------------------------------------------------------------
const nb = await A(() => window.__atlas.discovery.nearby({ origin: 'hip:32349', k: 5 }));
check('nearby(k=5) from Sirius returns 5 real neighbours with increasing distances', nb.ok && nb.neighbours.length === 5 && nb.neighbours.every((n, i) => i === 0 || n.distanceMetres >= nb.neighbours[i - 1].distanceMetres) && nb.neighbours.every((n) => n.distanceMetres > 0 && n.name), nb.ok ? nb.neighbours.map((n) => `${n.name} ${n.distanceText}`).join('; ') : JSON.stringify(nb));
const nbCam = await A(() => window.__atlas.discovery.nearby({ origin: 'camera', k: 3, categories: ['star'] }));
check("nearby from the camera focus (at Sirius) returns Sirius first", nbCam.ok && nbCam.neighbours[0].id === 'hip:32349', nbCam.ok ? nbCam.neighbours.map((n) => n.name).join(', ') : JSON.stringify(nbCam));
const nbSolar = await A(() => window.__atlas.discovery.nearby({ origin: 'solar:jupiter', k: 3 }));
check('nearby from Jupiter uses the Solar System frame at the simulation time (its moons come first)', nbSolar.ok && nbSolar.originFrame === 'solar-system' && nbSolar.neighbours.slice(0, 2).every((n) => n.category === 'moon'), nbSolar.ok ? nbSolar.neighbours.map((n) => `${n.name} ${n.distanceText}`).join('; ') : JSON.stringify(nbSolar));

// ---- save ------------------------------------------------------------------------------------------------------------------------------
const saved = await A(() => { const s = window.__atlas.discovery.saved; const r = s.addBookmark('hip:32349', 'qa'); return { ok: r.ok, is: s.isBookmarked('hip:32349'), n: s.bookmarks().length, mode: s.persistence().mode, ls: window.localStorage.getItem('atlas.saved')?.includes('hip:32349') ?? false }; });
check('save: bookmark stored and persisted to localStorage', saved.ok && saved.is && saved.n >= 1 && saved.mode === 'persistent' && saved.ls, JSON.stringify(saved));

// ---- select Andromeda (deep:m31): flight to the layer's view distance ------------------------------------------------------------------
const m31Res = await A(() => window.__atlas.discovery.select('deep:m31', { focus: true }).then((r) => r.ok));
await settle();
const m31State = await A(() => { const v = window.__atlas.viewer; return { dist: v.state.distance, want: v.deep.viewDistancePc('m31'), selectedDeep: v.selectedDeep, sel: window.__atlas.discovery.selection, insp: document.querySelector('#inspector h2')?.textContent ?? '' }; });
check('select(deep:m31): flight ends at the deep layer view distance, deep selection set, inspector shows the galaxy', m31Res && Math.abs(m31State.dist / m31State.want - 1) < 1e-6 && m31State.selectedDeep === 'm31' && m31State.sel === 'deep:m31', JSON.stringify(m31State));
await snap('andromeda-selected');

// ---- back() returns to the Sirius camera snapshot ----------------------------------------------------------------------------------------
const back = await A(() => { const r = window.__atlas.discovery.back(); return { ok: r.ok, sel: window.__atlas.discovery.selection }; });
await settle();
const afterBack = await A(() => ({ state: window.__atlas.viewer.state, sel: window.__atlas.discovery.selection, shown: document.querySelector('#inspector h2')?.textContent ?? '' }));
const dFocus = Math.hypot(...afterBack.state.focus.map((x, i) => x - siriusState.focus[i]));
check('back() returns to the Sirius camera snapshot (focus, distance, angles) and shows Sirius again', back.ok && afterBack.sel === 'hip:32349' && dFocus < 1e-6 && Math.abs(afterBack.state.distance / siriusState.distance - 1) < 1e-6 && Math.abs(afterBack.state.yaw - siriusState.yaw) < 1e-6 && /Sirius/.test(afterBack.shown), `focus off by ${dFocus.toExponential(2)} pc, distance ${afterBack.state.distance}, inspector "${afterBack.shown}"`);
const fwd = await A(() => { const r = window.__atlas.discovery.forward(); return r.ok; });
await settle();
check('forward() goes to Andromeda again', fwd && await A(() => window.__atlas.discovery.selection === 'deep:m31'));
const nav = await A(() => window.__atlas.discovery.navState());
check('history grew by the selections made (Sirius, M31) beyond the click test', nav.length >= histBefore + 2, JSON.stringify(nav));

// ---- other selections: Europa (body flight), Kepler-452 b (host flight + proxy), Sagittarius A*, TRAPPIST-1 --------------------------------------------
await A(() => window.__atlas.discovery.select('solar:europa', { focus: true })); await settle();
const eu = await A(() => ({ sel: window.__atlas.discovery.selection, body: window.__atlas.viewer.selectedBody, d: window.__atlas.viewer.state.distance, want: window.__atlas.viewer.viewDistancePc('europa'), h2: document.querySelector('#inspector h2')?.textContent }));
check('select(solar:europa) flies to the body at the viewer\'s own view distance', eu.sel === 'solar:europa' && eu.body === 'europa' && Math.abs(eu.d / eu.want - 1) < 1e-3, JSON.stringify(eu));
await snap('europa-selected');
await A(() => window.__atlas.discovery.select('exo:Kepler-452 b', { focus: true })); await settle();
const kp = await A(async () => { const a = window.__atlas.discovery, v = window.__atlas.viewer; const host = (await a.getRecord('exo:Kepler-452 b')).position.xyzPc; return { sel: a.selection, proxy: v.selectionProxy?.id ?? null, reason: v.selectionProxy?.reason ?? '', d: v.state.distance, off: Math.hypot(v.state.focus[0] - host[0], v.state.focus[1] - host[1], v.state.focus[2] - host[2]), h2: document.querySelector('#inspector h2')?.textContent, rows: [...document.querySelectorAll('#inspector .row')].map((r) => r.dataset.key + '=' + r.querySelector('.value')?.textContent).join(' | ') }; });
check('select(exo:Kepler-452 b): flies to the HOST star, a selection proxy is set, the generic inspector shows the planet', kp.sel === 'exo:Kepler-452 b' && kp.proxy === 'exo:Kepler-452 b' && kp.off < 1e-6 && /Kepler-452/.test(kp.h2 ?? ''), JSON.stringify(kp));
await snap('kepler-452b-selected');
await A(() => window.__atlas.discovery.select('other:sgr-a-star', { focus: true })); await settle();
const sg = await A(() => ({ sel: window.__atlas.discovery.selection, proxy: window.__atlas.viewer.selectionProxy?.id ?? null, d: window.__atlas.viewer.state.distance, h2: document.querySelector('#inspector h2')?.textContent }));
check('select(other:sgr-a-star): flies there with a selection proxy', sg.sel === 'other:sgr-a-star' && sg.proxy === 'other:sgr-a-star', JSON.stringify(sg));
const tp = await A(async () => { const a = window.__atlas.discovery; const id = (await a.search('TRAPPIST-1')).hits[0].id; await a.select(id, { focus: true }); const rel = await a.relationsOf(id); return { id, planets: rel.groups['physical-gravitational'].filter((l) => l.direction === 'in').length }; });
await settle();
check('TRAPPIST-1: selected via search, relationsOf lists its 7 planets as physical relations', tp.planets === 7, JSON.stringify(tp));
const par = await A(async () => { const a = window.__atlas.discovery; await a.select('exo:TRAPPIST-1 e', { focus: false }); const r = await a.parent(); return { ok: r.ok, sel: a.selection }; });
check('parent() of a planet is its host star', par.ok && par.sel.startsWith('gaia:'), JSON.stringify(par));

// ---- an unplaceable record: no flight, an explicit result ------------------------------------------------------------------------------
await settle();
const sky = await A(async () => {
  const a = window.__atlas.discovery;
  const f = await a.filter({ categories: ['galaxy'], datasets: ['twomrs'] }, { limit: 5000 });
  let id = null;
  for (const i of f.ids) { const r = await a.getRecord(i); if (r.position.kind === 'sky-only') { id = i; break; } }
  if (!id) return { id: null };
  const before = window.__atlas.viewer.state.distance;
  const r = await a.select(id, { focus: true });
  const p = window.__atlas.navHost.lastPlacement;
  return { id, ok: r.ok, flying: window.__atlas.viewer.flying, before, after: window.__atlas.viewer.state.distance, placement: p, inspector: document.querySelector('#inspector h2')?.textContent ?? '', rows: [...document.querySelectorAll('#inspector .row.missing')].map((x) => x.dataset.key + ': ' + (x.querySelector('.reason')?.textContent ?? '')).join(' | ') };
});
if (sky.id) check('a sky-only 2MRS row (cz < 1000 km/s) is selectable, the camera does not fly, the result says "cannot place in 3D: distance unknown", and the inspector says why the distance is unavailable', sky.ok && sky.flying === false && Math.abs(sky.before - sky.after) < 1e-9 && sky.placement?.kind === 'inspect-only' && /distance unknown/.test(sky.placement.reason) && /distance/.test(sky.rows), JSON.stringify(sky));
else warn('no sky-only 2MRS row found to test the inspect-only path');

// ---- search box UI ------------------------------------------------------------------------------------------------------------------------
await page.fill('#search', 'betelgeuse');
await page.waitForFunction(() => document.getElementById('results') && !document.getElementById('results').hidden && document.querySelectorAll('#results li').length > 0, null, { timeout: 20_000 });
const boxTop = await A(() => document.querySelector('#results li')?.textContent ?? '');
check('the search box shows atlas results (Betelgeuse first)', /Betelgeuse/.test(boxTop), boxTop);
await page.keyboard.press('Enter');
await page.waitForFunction(() => window.__atlas.discovery.selection === 'hip:27989', null, { timeout: 30_000 }).catch(() => {});
check('Enter on the first result selects Betelgeuse through the atlas and flies there', await A(() => window.__atlas.discovery.selection === 'hip:27989'));
await settle();
await snap('betelgeuse-from-search-box');

// ---- the pre-existing UI paths feed the atlas history (deep panel, solar bar, Escape) -----------------------------------------------------------
const feeds = await A(async () => {
  const w = window.__atlas, a = w.discovery, out = {};
  w.deepUi.selectDeep('m33', { fly: false });
  await new Promise((r) => setTimeout(r, 400));
  out.deep = a.selection;
  w.selectById('solar:mars', { fly: false });
  await new Promise((r) => setTimeout(r, 400));
  out.solar = a.selection;
  w.clear();
  out.cleared = a.selection;
  w.selectById('gaia:' + w.cat.sourceId(0), { fly: false });
  await new Promise((r) => setTimeout(r, 400));
  out.gaia = a.selection;
  w.clear();
  return out;
});
check('the deep panel, the router and clear() all go through the atlas (selection and history follow)', feeds.deep === 'deep:m33' && feeds.solar === 'solar:mars' && feeds.cleared === null && feeds.gaia?.startsWith('gaia:'), JSON.stringify(feeds));

// ---- viewer additions: projectPc, flyToPointPc guards, addStarPassLayer (draw calls, update, pick, dispose) -----------------------------------------
await settle();
await A(() => window.__atlas.viewer.flyTo({ focus: [0, 0, 0], distance: 60, yaw: 0.6, pitch: 0.35 }, 1));
await settle();
const vw = await A(() => {
  const v = window.__atlas.viewer;
  const out = {};
  // projectPc: the Sun-centred origin is the focus, so it projects to the screen centre; a point behind the camera reports `behind`
  const c = v.projectPc([0, 0, 0]);
  out.centre = { x: c.x, y: c.y, visible: c.visible, behind: c.behind, w: v.viewport.width, h: v.viewport.height };
  const cam = v.camera3();
  out.behind = v.projectPc([cam[0] * 2, cam[1] * 2, cam[2] * 2]).behind;   // twice as far from the focus on the camera side = behind the camera
  // flyToPointPc rejects non-finite input without starting a flight
  out.nan = [v.flyToPointPc([NaN, 0, 0], 4), v.flyToPointPc([0, 0, 0], Infinity), v.flyToPointPc([0, 0, 0], -1)];
  out.flyingAfterNan = v.flying;
  // a minimal star-pass layer built from the classes the Sun marker already uses
  const sun = v.sun, Points = sun.constructor, Geo = sun.geometry.constructor, Attr = sun.geometry.getAttribute('position').constructor, Mat = sun.material.constructor;
  const g = new Geo(); const pos = new Float32Array(3); g.setAttribute('position', new Attr(pos, 3));
  const obj = new Points(g, new Mat({ color: 0x66ff66, size: 11, sizeAttenuation: false, depthTest: false }));
  obj.frustumCulled = false;
  const target = [3, 2, 1];
  window.__qaLayer = { updates: 0, disposed: false, fade: null, mag: null };
  const layer = {
    name: 'qa-layer', object: obj,
    update: (camPc) => { window.__qaLayer.updates++; pos[0] = target[0] - camPc[0]; pos[1] = target[1] - camPc[1]; pos[2] = target[2] - camPc[2]; g.getAttribute('position').needsUpdate = true; },
    setFade: (f) => { window.__qaLayer.fade = f; }, setMagLimit: (m) => { window.__qaLayer.mag = m; },
    pick: (x, y) => { const p = v.projectPc(target); return Math.hypot(p.x - x, p.y - y) < 8 ? 'qa:star-1' : null; },
    stats: () => ({ points: 1 }), dispose: () => { window.__qaLayer.disposed = true; g.dispose(); },
  };
  out.callsBefore = v.drawCalls;
  window.__qaRemove = v.addStarPassLayer(layer);
  window.__qaTarget = target;
  return out;
});
await page.waitForTimeout(2500);
const vw2 = await A(() => {
  const v = window.__atlas.viewer;
  const p = v.projectPc(window.__qaTarget);
  const hit = v.pick(p.x, p.y);
  const far = v.pick(p.x + 300, p.y + 200);
  return { calls: v.drawCalls, stats: v.starPassStats(), layer: window.__qaLayer, p, hit: hit ? { source: hit.source, layerId: hit.layerId ?? null, layer: hit.layer ?? null, cat: hit.catalogueIndex } : null, farSource: far ? far.source : null };
});
check('projectPc: the focus projects to the screen centre; a point behind the camera is reported behind', Math.abs(vw.centre.x - vw.centre.w / 2) < 1 && Math.abs(vw.centre.y - vw.centre.h / 2) < 1 && vw.centre.visible && !vw.centre.behind && vw.behind === true, JSON.stringify(vw.centre));
check('flyToPointPc refuses NaN / infinite / non-positive input and does not start a flight', vw.nan.every((x) => x === false) && vw.flyingAfterNan === false, JSON.stringify(vw.nan));
check('addStarPassLayer: update() runs every frame, fade and magnitude limit are forwarded, its points are listed', vw2.layer.updates >= 2 && typeof vw2.layer.fade === 'number' && typeof vw2.layer.mag === 'number' && vw2.stats.some((x) => x.name === 'qa-layer' && x.points === 1), JSON.stringify({ layer: vw2.layer, stats: vw2.stats }));
check('addStarPassLayer: the layer adds a draw call to the frame total', vw2.calls === vw.callsBefore + 1, `${vw.callsBefore} -> ${vw2.calls}`);
check('pick(): a layer star is returned with its id string (source layer, catalogueIndex -1); away from it the layer does not answer', vw2.hit?.source === 'layer' && vw2.hit.layerId === 'qa:star-1' && vw2.hit.layer === 'qa-layer' && vw2.hit.cat === -1 && vw2.farSource !== 'layer', JSON.stringify({ hit: vw2.hit, far: vw2.farSource }));
await snap('star-pass-layer-qa');
await A(() => window.__qaRemove());
await page.waitForTimeout(800);
const vw3 = await A(() => ({ disposed: window.__qaLayer.disposed, stats: window.__atlas.viewer.starPassStats().length }));
// Expectation updated (F1): the real Hipparcos supplement layer ('hipparcos-bright-stars') is attached for the whole session, so after the QA layer is removed ONE layer remains (was 0 when no layer existed).
check('removing the layer disposes it and leaves only the real Hipparcos supplement', vw3.disposed && vw3.stats === 1, JSON.stringify(vw3));


// ======================================================================================================================================
// F1 integration: real renderers wired, supplement stars clickable, host layer, parent / history, merged search, consistency
// ======================================================================================================================================
const lookFromSun = (u) => A((u) => { const v = window.__atlas.viewer; const e = 1e-4; v.flight = null; v.followId = null; v.selectedBody = null; v.state = { focus: [u[0] * e, u[1] * e, u[2] * e], distance: e, yaw: Math.atan2(-u[1], -u[0]), pitch: Math.asin(-u[2]) }; }, u);
const unitOf = (p) => { const r = Math.hypot(...p); return p.map((x) => x / r); };
const blur = () => A(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
await settle();
await A(() => window.__atlas.clear());

// ---- 2. the real renderers are wired --------------------------------------------------------------------------------------------------------
const wired = await A(() => { const w = window.__atlas, v = w.viewer, r = w.discoveryRenderers; return { r: r && { markers: r.markers, hostsLoaded: r.hostsLoaded, othersLoaded: r.othersLoaded, failed: r.failed, bright: !!r.bright }, stats: v.starPassStats(), counts: v.discoveryMarkerCounts(), hostsOn: v.exoplanetHostsVisible }; });
check('the Hipparcos supplement is a real star-pass layer (457 stars at J2016 positions), the host and other-object markers have their data, the host layer is OFF by default', wired.r?.bright && wired.r.markers && wired.r.hostsLoaded && wired.r.othersLoaded && wired.r.failed.length === 0 && wired.stats.some((x) => x.name === 'hipparcos-bright-stars' && x.points > 400) && wired.counts?.hostsDrawable === 4834 && wired.counts.others === 6 && wired.hostsOn === false && wired.counts.hostsDrawnNow === 0, JSON.stringify(wired));

// ---- 2. clicking a supplement star selects it through the atlas, true nearest wins ------------------------------------------------------------
const sirRec = await A(async () => { const r = await window.__atlas.discovery.getRecord('hip:32349'); return { xyz: r.position.xyzPc, note: r.measurements.distancePc.note ?? null, d: r.measurements.distancePc.value }; });
await lookFromSun(unitOf(sirRec.xyz));
await page.waitForTimeout(1200);
const sirScreen = await A(() => { const v = window.__atlas.viewer; const p = v.projectPc(window.__atlas.discovery.peek('hip:32349').position.xyzPc); const c = document.getElementById('scene').getBoundingClientRect(); const near = v.pick(p.x + 4, p.y + 3); return { x: p.x + c.left, y: p.y + c.top, vis: p.visible, near: near ? { source: near.source, id: near.layerId ?? null } : null }; });
check('viewer.pick near Sirius returns the supplement star (source layer, hip:32349): the true nearest of Gaia and the layer', sirScreen.vis && sirScreen.near?.source === 'layer' && sirScreen.near.id === 'hip:32349', JSON.stringify(sirScreen));
await page.mouse.click(sirScreen.x + 2, sirScreen.y + 2);
await page.waitForFunction(() => window.__atlas.discovery.selection === 'hip:32349', null, { timeout: 30_000 }).catch(() => {});
await page.waitForTimeout(800);
const sirClick = await A(() => ({ sel: window.__atlas.discovery.selection, h2: document.querySelector('#inspector h2')?.textContent ?? '', open: document.getElementById('inspector').classList.contains('open'), ring: getComputedStyle(document.getElementById('ring')).display }));
check('clicking Sirius on the canvas selects hip:32349 through atlas.select; the inspector shows it and the selection ring is drawn', sirClick.sel === 'hip:32349' && /Sirius/.test(sirClick.h2) && sirClick.open && sirClick.ring !== 'none', JSON.stringify(sirClick));
await snap('f1-sky-from-sun-sirius-selected');
await A(() => window.__atlas.clear());

// ---- 3. Betelgeuse (low reliability, placed) and Alnilam (not placed) ----------------------------------------------------------------------------
const betel = await A(async () => { const r = await window.__atlas.discovery.getRecord('hip:27989'); return { xyz: r.position.xyzPc, kind: r.position.kind, note: r.measurements.distancePc?.note ?? null, unc: r.measurements.distancePc?.uncertainty ?? null, k: r.measurements.distancePc?.kind ?? null, drawn: r.drawn }; });
check('Betelgeuse: placed in 3D with a derived distance, a parallax-error uncertainty and the note "low reliability: parallax S/N < 10"', betel.kind === 'icrs' && betel.k === 'derived' && betel.unc > 10 && betel.note === 'low reliability: parallax S/N < 10' && betel.drawn, JSON.stringify(betel));
await lookFromSun(unitOf(betel.xyz));
await A(() => window.__atlas.discovery.select('hip:27989', { focus: false }));
await page.waitForTimeout(1500);
const betelUi = await A(() => ({ h2: document.querySelector('#inspector h2')?.textContent ?? '', text: document.getElementById('inspector').textContent, ring: getComputedStyle(document.getElementById('ring')).display }));
check('the inspector for Betelgeuse says the distance has low reliability', /Betelgeuse/.test(betelUi.h2) && /low reliability: parallax S\/N < 10/.test(betelUi.text) && betelUi.ring !== 'none', betelUi.text.slice(0, 300));
await snap('f1-betelgeuse-selected');
await A(() => window.__atlas.clear());
const aln = await A(async () => {
  const a = window.__atlas, v = a.viewer, s = a.discovery;
  const sr = await s.search('Alnilam');
  const before = { ...v.state, focus: [...v.state.focus] };
  await s.select('hip:26311', { focus: true });
  const p = a.navHost.lastPlacement;
  const nb = await s.nearby({ origin: { positionPc: [0, 0, 0] }, radiusPc: 400, categories: ['star'] });
  return { found: sr.hits[0]?.id, drawn: sr.hits[0]?.drawn, placement: p, flying: v.flying, moved: Math.abs(v.state.distance - before.distance) > 1e-9, inNearby: nb.ok && nb.neighbours.some((n) => n.id === 'hip:26311'), betelNearby: nb.ok && nb.neighbours.some((n) => n.id === 'hip:27989'), insp: document.getElementById('inspector').textContent };
});
check('Alnilam (S/N 3.7): search finds it, it is not drawn, select says "cannot place in 3D", the camera does not fly, it is not in nearby(); Betelgeuse is', aln.found === 'hip:26311' && aln.drawn === false && aln.placement?.kind === 'inspect-only' && /cannot place in 3D/.test(aln.placement.reason) && !aln.flying && !aln.moved && !aln.inNearby && aln.betelNearby, JSON.stringify({ ...aln, insp: undefined }));
await A(() => window.__atlas.clear());

// ---- 2. the exoplanet host layer: toggle API, one draw call, labels, picking -------------------------------------------------------------------------
const kep = await A(async () => (await window.__atlas.discovery.getRecord('exo:Kepler-452 b')).position.xyzPc);
await lookFromSun(unitOf(kep));
await page.waitForTimeout(1200);
const hostsDc = await A(() => {
  const v = window.__atlas.viewer;
  const jd = window.__atlas.clock?.jd ?? 2461000; v.render(jd); const off = { calls: v.drawCalls, drawn: v.discoveryMarkerCounts().hostsDrawnNow };
  v.setExoplanetHostsVisible(true); v.render(jd); const on = { calls: v.drawCalls, drawn: v.discoveryMarkerCounts().hostsDrawnNow, vis: v.exoplanetHostsVisible };
  v.setExoplanetHostsVisible(false); v.render(jd); const back = { calls: v.drawCalls, drawn: v.discoveryMarkerCounts().hostsDrawnNow };
  return { off, on, back };
});
check('host layer toggle: OFF draws nothing, ON adds exactly one draw call and thousands of halos, OFF again removes them', hostsDc.off.drawn === 0 && hostsDc.on.vis && hostsDc.on.drawn > 100 && hostsDc.on.calls === hostsDc.off.calls + 1 && hostsDc.back.calls === hostsDc.off.calls && hostsDc.back.drawn === 0, JSON.stringify(hostsDc));
await A(() => { window.__atlas.viewer.setExoplanetHostsVisible(true); });
await page.waitForTimeout(1500);
const hostInfo = await A(() => {
  const v = window.__atlas.viewer; v.render(window.__atlas.clock?.jd ?? 2461000);
  const hosts = [...v.deepScreen.values()].filter((i) => i.kind === 'exoplanet-host' && i.visible);
  const c = document.getElementById('scene').getBoundingClientRect();
  // a host with no Gaia / supplement star within 16 px and no other host within 14 px, so a click is unambiguous
  const pick = hosts.find((h) => v.pick(h.x, h.y) === null && h.x > 40 && h.x < v.viewport.width - 40 && h.y > 40 && h.y < v.viewport.height - 40 && hosts.every((o) => o === h || Math.hypot(o.x - h.x, o.y - h.y) > 14));
  const ui = window.__atlas.deepUi; ui.update(performance.now());
  return { n: hosts.length, pick: pick ? { id: pick.id, x: pick.x + c.left, y: pick.y + c.top, deep: v.pickDeep(pick.x, pick.y) } : null, labels: ui.labelCandidates };
});
check('with the host layer on, the deep UI label slots take no discovery markers (hosts / other objects / selection proxy)', hostInfo.n > 0 && hostInfo.labels.every((id) => !/^(host|other|selection):/.test(id)), JSON.stringify({ n: hostInfo.n, labels: hostInfo.labels }));
await snap('f1-exoplanet-hosts-layer-on');
if (hostInfo.pick) {
  await page.mouse.click(hostInfo.pick.x, hostInfo.pick.y);
  const want = await A(async (id) => window.__atlas.discovery.resolve(id), hostInfo.pick.deep);
  await page.waitForFunction((w) => window.__atlas.discovery.selection === w, want, { timeout: 30_000 }).catch(() => {});
  const hs = await A(() => ({ sel: window.__atlas.discovery.selection, h2: document.querySelector('#inspector h2')?.textContent ?? '' }));
  check('clicking a host halo (lowest pick tier) selects that host star through the atlas; the id comes from viewer.pickDeep', /^host:/.test(hostInfo.pick.deep ?? '') && hs.sel === want && hs.h2.length > 0, JSON.stringify({ pick: hostInfo.pick.deep, want, hs }));
} else warn('host click test skipped: no isolated host halo on screen', JSON.stringify(hostInfo));
await A(() => { window.__atlas.clear(); window.__atlas.viewer.setExoplanetHostsVisible(false); });

// ---- 4. merged search: one curated result ---------------------------------------------------------------------------------------------------------
const merged = await A(async () => {
  const a = window.__atlas.discovery, out = {};
  for (const [q, want] of [['Andromeda', 'deep:m31'], ['NGC 224', 'deep:m31'], ['Triangulum', 'deep:m33'], ['Large Magellanic Cloud', 'deep:lmc'], ['SMC', 'deep:smc'], ['M32', 'deep:m32'], ['M81', 'deep:m81'], ['Virgo A', 'deep:m87'], ['Centaurus A', 'deep:cen-a']]) {
    const r = await a.search(q, { limit: 8 });
    out[q] = { first: r.hits[0]?.id, exact: r.hits.filter((h) => h.matchKind === 'exact').map((h) => h.id), want };
  }
  return out;
});
check('search: Andromeda, NGC 224, Triangulum, LMC, SMC, M32, M81, Virgo A, Centaurus A each return ONE exact result, the curated record, first', Object.values(merged).every((m) => m.first === m.want && m.exact.length === 1 && m.exact[0] === m.want), JSON.stringify(merged));
const first = async (q) => (await topId(q)).id;
const rank = { 'Orion Nebula': 'deep:orion-nebula', M42: 'deep:orion-nebula', 'Sagittarius A*': 'other:sgr-a-star', 'Sgr A*': 'other:sgr-a-star', 'Kepler-452b': 'exo:Kepler-452 b', Europa: 'solar:europa', Sirius: 'hip:32349', Betelgeuse: 'hip:27989', 'HIP 32349': 'hip:32349' };
const rankRes = {}; for (const q of Object.keys(rank)) rankRes[q] = await first(q);
check('search ranking: Orion Nebula, M42, Sagittarius A*, Sgr A*, Kepler-452b, Europa, Sirius, Betelgeuse, HIP 32349 return the intended record first', Object.entries(rank).every(([q, w]) => rankRes[q] === w), JSON.stringify(rankRes));
const rank2 = await A(async () => { const a = window.__atlas.discovery, cat = window.__atlas.cat; const gid = `gaia:${cat.sourceId(777)}`; const g = (await a.search(`Gaia DR3 ${cat.sourceId(777)}`)).hits[0]?.id; const t = (await a.search('TRAPPIST-1')).hits[0]?.id, p = (await a.search('Proxima')).hits[0]?.id; return { g: g === await a.resolve(gid), t: t === await a.resolve('host:TRAPPIST-1'), p: p === await a.resolve('hip:70890') }; });
check('search ranking: a real Gaia DR3 id, TRAPPIST-1 (the merged host star) and Proxima return their own record first', rank2.g && rank2.t && rank2.p, JSON.stringify(rank2));

// ---- 5. nearby: the origin's own system is not a neighbour ----------------------------------------------------------------------------------------
const sysNb = await A(async () => {
  const a = window.__atlas.discovery;
  const r = await a.nearby({ origin: 'exo:TRAPPIST-1 e', radiusPc: 6 });
  const h = await a.nearby({ origin: 'host:TRAPPIST-1', k: 4 });
  return { ok: r.ok, system: r.ok ? r.system.map((m) => `${m.role}:${m.id}`) : null, zero: r.ok ? r.neighbours.filter((n) => n.distanceMetres === 0).length : null, inNb: r.ok ? r.neighbours.filter((n) => /TRAPPIST-1/.test(n.name)).length : null, hostOk: h.ok, hostSys: h.ok ? h.system?.length : null, hostK: h.ok ? h.neighbours.length : null, hostZero: h.ok ? h.neighbours.filter((n) => n.distanceMetres === 0).length : null };
});
check('nearby from an exoplanet / its host: the host and the six sibling planets come back as `system`, no neighbour is at distance 0', sysNb.ok && sysNb.system.length === 7 && sysNb.system.filter((x) => x.startsWith('host:')).length === 1 && sysNb.zero === 0 && sysNb.inNb === 0 && sysNb.hostOk && sysNb.hostSys === 7 && sysNb.hostK === 4 && sysNb.hostZero === 0, JSON.stringify(sysNb));

// ---- 6. parent / overview / home through the atlas history --------------------------------------------------------------------------------------
await blur();
await A(() => window.__atlas.discovery.select('solar:europa', { focus: true })); await settle();
await page.waitForTimeout(500);
await page.keyboard.press('Backspace');
await page.waitForFunction(() => window.__atlas.discovery.selection === 'solar:jupiter', null, { timeout: 30_000 }).catch(() => {});
await settle(); await page.waitForTimeout(500);
const up1 = await A(() => ({ sel: window.__atlas.discovery.selection, follow: window.__atlas.viewer.followId, body: window.__atlas.viewer.selectedBody, h2: document.querySelector('#inspector h2')?.textContent ?? '' }));
check('Backspace from Europa goes to Jupiter (moon -> planet), through the atlas selection and history', up1.sel === 'solar:jupiter' && up1.follow === 'jupiter' && /Jupiter/.test(up1.h2), JSON.stringify(up1));
await page.keyboard.press('Backspace');
await page.waitForFunction(() => window.__atlas.discovery.selection === null, null, { timeout: 30_000 }).catch(() => {});
await settle(); await page.waitForTimeout(500);
const up2 = await A(() => { const v = window.__atlas.viewer; return { sel: window.__atlas.discovery.selection, follow: v.followId, body: v.selectedBody, d: v.state.distance, canBack: window.__atlas.discovery.navState().canBack }; });
check('Backspace from Jupiter goes to the Solar System overview (planet -> overview), nothing selected, recorded in the history', up2.sel === null && up2.follow === null && up2.body === null && Math.abs(up2.d / 3.4e-4 - 1) < 0.1 && up2.canBack, JSON.stringify(up2));
await A(() => window.__atlas.discovery.back()); await settle(); await page.waitForTimeout(500);
check('atlas.back() after the overview returns to Jupiter (one history for select / parent / back)', await A(() => window.__atlas.discovery.selection === 'solar:jupiter'));
await A(() => window.__atlas.clear());
await A(() => window.__atlas.viewer.flyTo({ focus: [0, 0, 0], distance: 60, yaw: 0.6, pitch: 0.35 }, 1)); await settle();

await A(() => window.__atlas.deepUi.selectDeep('m31', { fly: true })); await settle(); await page.waitForTimeout(800);
await page.keyboard.press('Backspace'); await page.waitForTimeout(1200);
const dp1 = await A(() => ({ ui: window.__atlas.deepUi.selection, viewer: window.__atlas.viewer.selectedDeep, atlas: window.__atlas.discovery.selection, name: document.querySelector('#inspector h2')?.textContent ?? '' }));
check('Backspace from M31 selects the Local Group (DeepUi, viewer highlight, inspector and the atlas history agree)', dp1.ui === 'local-group' && dp1.viewer === 'local-group' && dp1.atlas === 'deep:local-group' && /Local Group/.test(dp1.name), JSON.stringify(dp1));
await page.keyboard.press('Backspace'); await page.waitForTimeout(1200);
const dp2 = await A(() => ({ ui: window.__atlas.deepUi.selection, viewer: window.__atlas.viewer.selectedDeep, atlas: window.__atlas.discovery.selection, open: document.getElementById('inspector').classList.contains('open') }));
check('Backspace again is a scale flight: nothing selected in DeepUi, the viewer, the atlas and the inspector', dp2.ui === null && dp2.viewer === null && dp2.atlas === null && !dp2.open, JSON.stringify(dp2));
await settle();
await A(() => window.__atlas.viewer.flyTo({ focus: [0, 0, 0], distance: 60, yaw: 0.6, pitch: 0.35 }, 1)); await settle();
await A(() => window.__atlas.discovery.select('hip:32349', { focus: false })); await page.waitForTimeout(500);
await page.keyboard.press('h'); await settle(); await page.waitForTimeout(600);
const home = await A(() => ({ sel: window.__atlas.discovery.selection, canBack: window.__atlas.discovery.navState().canBack }));
await A(() => window.__atlas.discovery.back()); await page.waitForTimeout(600);
check('the home key records a step in the same history: selection cleared, back() returns to Sirius', home.sel === null && home.canBack && await A(() => window.__atlas.discovery.selection === 'hip:32349'), JSON.stringify(home));
await A(() => window.__atlas.clear());

// ---- shutdown --------------------------------------------------------------------------------------------------------------------------------
const filtered = problems.filter((p) => !/favicon/i.test(p));
check('no console errors, warnings or failed requests during the whole run', filtered.length === 0, filtered.slice(0, 5).join(' || '));
await writeFile(`${OUT}/qa-api-log.json`, JSON.stringify({ when: new Date().toISOString(), checks, warnings, shots, log, problems: filtered }, null, 2));
await browser.close();
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed, ${warnings.length} warnings`);
process.exit(failed.length ? 1 : 0);
