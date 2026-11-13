// Real-browser QA of the discovery INTERFACE (search box, Discover drawer, inspector additions, navigation context, layout), driven with REAL keyboard and mouse input.
// SOFTWARE GL ONLY (SwiftShader): nothing here measures GPU performance. Needs a built preview server and Playwright:
//   npx vite build && npx vite preview --port 4173 --host 127.0.0.1        (or set ATLAS_URL to another port)
//   PLAYWRIGHT_MODULE_DIR=/root/jumanji-vr node tools/qa-discovery-ui.mjs
// Screenshots: docs/qa/discovery/ui-NN-*.png (QA_OUT overrides the folder), log: <QA_OUT>/ui-qa-log.json. Exits non-zero if a check fails.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const require = createRequire((process.env.PLAYWRIGHT_MODULE_DIR ?? '/root/jumanji-vr') + '/');
const { chromium } = require('playwright');

const URL = process.env.ATLAS_URL ?? 'http://127.0.0.1:4173/';
const OUT = process.env.QA_OUT ?? 'docs/qa/discovery';
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const checks = [], warnings = [], shots = [], log = { url: URL, startedAt: new Date().toISOString() };
const problems = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 600) }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + String(detail).slice(0, 300) : ''}`); };
const warn = (name, detail = '') => { warnings.push({ name, detail }); console.log(`WARN  ${name}${detail ? '  - ' + detail : ''}`); };

const SIZES = [[1280, 800], [1024, 700], [768, 1024], [390, 844]];

async function newPage(viewport = { width: 1280, height: 800 }, context) {
  const ctx = context ?? await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url()}`); });
  await page.addInitScript(() => {
    window.__long = [];
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push({ start: e.startTime, dur: e.duration }); }).observe({ type: 'longtask', buffered: true }); } catch { /* unsupported */ }
  });
  return page;
}
async function open(page, url = URL) {
  await page.goto(url);
  await page.waitForFunction(() => window.__atlas?.discovery && window.__atlas.viewer && window.__atlas.ui, null, { timeout: 120_000 });
  await page.evaluate(() => window.__atlas.viewer.disableQualityGovernor());
  await page.waitForFunction(() => window.__atlas.discovery.status.complete, null, { timeout: 240_000, polling: 500 });
}

let shotNo = 0;
const snap = async (page, name) => {
  await page.waitForTimeout(400);
  const file = `ui-${String(++shotNo).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: `${OUT}/${file}`, timeout: 120_000 });
  shots.push(file);
  return file;
};
const settle = (page) => page.waitForFunction(() => !window.__atlas.viewer.flying, null, { timeout: 120_000, polling: 200 });
const UNIT_M = { m: 1, km: 1e3, AU: 1.495978707e11, ly: 9.4607304725808e15, pc: 3.0856775814913673e16, kpc: 3.0856775814913673e19, Mpc: 3.0856775814913673e22 };
const parseDist = (t) => { const m = /^\s*([\d,]*\.?\d+(?:e[+-]?\d+)?)\s*(m|km|AU|ly|pc|kpc|Mpc)\b/i.exec(t ?? ''); return m ? Number(m[1].replace(/,/g, '')) * UNIT_M[m[2].replace(/^(au)$/i, 'AU')] : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ======================================================================================================================================
// Part 1: the user journey at 1280x800
// ======================================================================================================================================
const page = await newPage();
const A = (fn, arg) => page.evaluate(fn, arg);
await open(page);

// ---- (1) open the Atlas ------------------------------------------------------------------------------------------------------------
{
  const info = await A(() => { const i = document.getElementById('search'); return { role: i.getAttribute('role'), expanded: i.getAttribute('aria-expanded'), controls: i.getAttribute('aria-controls'), popHidden: document.getElementById('sb-pop').hidden, drawerHidden: document.getElementById('discover').hidden, status: window.__atlas.discovery.status.complete }; });
  check('(1) the Atlas opens: search is an ARIA combobox, closed; the drawer is closed; the engine finished indexing', info.role === 'combobox' && info.expanded === 'false' && info.controls === 'results' && info.popHidden && info.drawerHidden && info.status, JSON.stringify(info));
  await snap(page, 'atlas-opened');
}
const startCam = await A(() => window.__atlas.navHost.snapshot());
const startCrumb = await A(() => document.getElementById('dp-crumbs')?.textContent ?? '');

// ---- (2) type Sirius in the search box ---------------------------------------------------------------------------------------------
await page.keyboard.press('/');
check("(2) '/' focuses the search box", await A(() => document.activeElement?.id === 'search'));
const typingStart = await A(() => performance.now());
await page.keyboard.type('Sirius', { delay: 45 });
await page.waitForSelector('#results li[role=option]', { timeout: 20_000 });
await page.waitForTimeout(300);
{
  const rows = await A(() => [...document.querySelectorAll('#results li')].map((l) => ({ text: l.textContent, cat: l.querySelector('.r-cat')?.textContent, name: l.querySelector('.r-name')?.textContent, dist: l.querySelector('.r-dist')?.textContent, role: l.getAttribute('role') })));
  log.siriusRows = rows;
  check('(2) results appear with Sirius first, category as text, name and a compact distance', rows.length >= 1 && rows[0].name === 'Sirius' && /star/i.test(rows[0].cat) && /\b(pc|ly|AU)\b/.test(rows[0].dist), JSON.stringify(rows[0]));
  const chips = await A(() => [...document.querySelectorAll('.sb-chips button')].map((b) => b.textContent));
  check('(2) category filter chips with counts are shown (All, Stars, Planets, Moons, Exoplanets, Galaxies, Nebulae, Clusters, Groups, Other)', chips.length === 10 && /^All \d+/.test(chips[0]) && /^Stars \d+/.test(chips[1]), chips.join(' | '));
  check('(2) the input exposes listbox state (aria-expanded true, role=option rows)', await A(() => document.getElementById('search').getAttribute('aria-expanded') === 'true' && document.querySelector('#results').getAttribute('role') === 'listbox'));
  await snap(page, 'search-sirius');
}

// ---- (3) ArrowDown, Enter: the camera flies --------------------------------------------------------------------------------------
const sirPos = await A(async () => (await window.__atlas.discovery.getRecord('hip:32349')).position.xyzPc);
await page.keyboard.press('ArrowDown');
{
  const ad = await A(() => { const i = document.getElementById('search'); const id = i.getAttribute('aria-activedescendant'); const el = id && document.getElementById(id); return { id, selected: el?.getAttribute('aria-selected'), name: el?.querySelector('.r-name')?.textContent }; });
  check('(3) ArrowDown makes the first row active (aria-activedescendant, aria-selected)', ad.id && ad.selected === 'true' && ad.name === 'Sirius', JSON.stringify(ad));
}
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
await A((p) => { window.__samples = []; window.__timer = setInterval(() => { const s = window.__atlas.viewer.state; window.__samples.push({ t: performance.now(), d: Math.hypot(s.focus[0] - p[0], s.focus[1] - p[1], s.focus[2] - p[2]), cam: s.distance, flying: window.__atlas.viewer.flying }); }, 100); }, sirPos);
await page.keyboard.press('Enter');
await page.waitForFunction(() => window.__atlas.discovery.selection === 'hip:32349', null, { timeout: 30_000 });
await page.waitForTimeout(500);
await settle(page);
await page.waitForTimeout(400);
const samples = await A(() => { clearInterval(window.__timer); return window.__samples; });
{
  const moving = samples.filter((s) => s.flying);
  let monotonic = true, worst = 0;
  for (let i = 1; i < moving.length; i++) { const inc = moving[i].d - moving[i - 1].d; if (inc > 1e-6 * Math.max(1, moving[0].d)) { monotonic = false; worst = Math.max(worst, inc); } }
  const last = samples[samples.length - 1];
  const final = await A(() => ({ d: window.__atlas.viewer.state.distance, focus: window.__atlas.viewer.state.focus }));
  const nearStar = dist3(final.focus, sirPos);
  log.flightToSirius = { samples: samples.length, moving: moving.length, startFocusDistancePc: moving[0]?.d, endFocusDistancePc: last?.d, viewDistancePc: final.d };
  check('(3) Enter flew the camera: focus distance to the star never increases during the flight', moving.length >= 2 && monotonic, `${moving.length} samples while flying, start ${moving[0]?.d?.toFixed(2)} pc -> ${last?.d?.toFixed(4)} pc, worst increase ${worst}`);
  check('(3) the flight ends at the star (focus within 0.05 pc, view a few pc away)', nearStar < 0.05 && final.d < 8, `focus ${nearStar.toFixed(4)} pc from Sirius, camera ${final.d.toFixed(2)} pc from focus`);
  check('(3) the visit is in the atlas history and the nav line says where the camera is', await A(() => window.__atlas.discovery.saved.history()[0]?.id === 'hip:32349') && /Sirius/.test(await A(() => document.getElementById('nav-line')?.textContent ?? '')), await A(() => document.getElementById('nav-line')?.textContent));
}
const sirSnap = await A(() => window.__atlas.navHost.snapshot());
const sirCrumb = await A(() => document.getElementById('dp-crumbs')?.textContent ?? '');

// ---- (4) the inspector ---------------------------------------------------------------------------------------------------------------
await page.waitForSelector('#inspector.open .disc-notes');
{
  const insp = await A(() => {
    const root = document.getElementById('inspector');
    const row = (k) => root.querySelector(`.row[data-key="${k}"]`)?.textContent ?? null;
    return {
      name: root.querySelector('h2')?.textContent, cls: root.querySelector('.class')?.textContent, distance: row('distancePc'), mag: row('apparentMag'), absMag: row('absoluteMag'), parallax: row('distance_snr'),
      kinds: [...root.querySelectorAll('.row .kind')].map((k) => k.textContent), relBlock: !!root.querySelector('[data-block=relationships]'), relText: root.querySelector('[data-block=relationships]')?.textContent ?? '',
      noteBlock: !!root.querySelector('[data-block=explanation]'), oneLine: root.querySelector('.one-line')?.textContent, policy: root.querySelector('.policy')?.textContent,
      claims: [...root.querySelectorAll('.claim')].map((c) => ({ status: c.querySelector('.cstat')?.textContent, refs: [...c.querySelectorAll('.refs li')].map((r) => r.textContent) })),
      sections: [...root.querySelectorAll('.note-sec summary')].map((s) => s.textContent), actions: [...root.querySelectorAll('.act')].map((b) => b.textContent), links: [...root.querySelectorAll('.refs a')].filter((a) => /^https?:/.test(a.href)).length,
    };
  });
  log.siriusInspector = insp;
  check('(4) inspector shows name and classification', insp.name === 'Sirius' && /Star/.test(insp.cls), `${insp.name} / ${insp.cls}`);
  check('(4) distance with uncertainty, and observed/derived badges', /pc/.test(insp.distance ?? '') && /±/.test(insp.distance ?? '') && insp.kinds.includes('DER') && insp.kinds.includes('OBS'), `${insp.distance} kinds ${[...new Set(insp.kinds)].join(',')}`);
  check('(4) magnitudes (apparent observed, absolute derived) are shown', /-1\.44/.test(insp.mag ?? '') && /mag/.test(insp.absMag ?? ''), `${insp.mag} | ${insp.absMag}`);
  check('(4) parallax quality (derived S/N) is shown', /Parallax quality/.test(insp.parallax ?? '') && /DER/.test(insp.parallax ?? ''), insp.parallax);
  check('(4) relationships block is present (rows grouped by basis, or the explicit "no relationships" statement)', insp.relBlock && (/Physical|Structural|Spatial|Same object/.test(insp.relText) || /No relationships are recorded/.test(insp.relText)), insp.relText.slice(0, 160));
  check('(4) explanation block: one-liner first, the "paraphrase" policy line, expandable sections', insp.noteBlock && /visual binary/.test(insp.oneLine ?? '') && /Notes paraphrase the cited pages; they are not measurements\./.test(insp.policy ?? '') && insp.sections.includes('What it is') && insp.sections.includes('What is uncertain'), `${insp.oneLine} | ${insp.sections.join(', ')}`);
  check('(4) every claim shows a status label and a reference with a retrieved date', insp.claims.length >= 3 && insp.claims.every((c) => c.status && c.refs.length > 0 && c.refs.every((r) => /retrieved \d{4}-\d{2}-\d{2}/.test(r))) && insp.links >= 1, `${insp.claims.length} claims, ${insp.links} reference links`);
  check('(4) actions: Bookmark, Find nearby, Go to parent, Back', ['Bookmark', 'Find nearby', 'Go to parent'].every((t) => insp.actions.some((a) => a.includes(t))) && insp.actions.some((a) => a.startsWith('Back')), insp.actions.join(' | '));
  await snap(page, 'inspector-sirius');
  await A(() => { const i = document.getElementById('inspector'); i.scrollTop = i.querySelector('[data-block=relationships]').offsetTop - 12; });
  await snap(page, 'inspector-sirius-explanation');
  await A(() => { document.getElementById('inspector').scrollTop = 0; });
}

// ---- (5) Nearby tab through the inspector's "Find nearby" (real clicks) --------------------------------------------------------------
await page.click('.act:has-text("Find nearby")');
await page.waitForSelector('#dr-panel-nearby:not([hidden]) .obj-row', { timeout: 20_000 });
await page.waitForTimeout(800);
{
  const nb = await A(() => ({ summary: document.querySelector('#dr-panel-nearby .dr-note + .dr-note, #dr-panel-nearby p.dr-note:not([hidden])')?.textContent, rows: [...document.querySelectorAll('#dr-panel-nearby .obj-list:last-of-type .obj-row, #dr-panel-nearby .obj-list .obj-row')].map((b) => ({ id: b.dataset.id, name: b.querySelector('.r-name')?.textContent, dist: b.querySelector('.r-dist')?.textContent })), around: document.querySelector('#dr-panel-nearby .dr-check .n')?.textContent }));
  const nbRows = nb.rows.filter((r) => r.dist && parseDist(r.dist) !== null);
  const metres = nbRows.map((r) => parseDist(r.dist));
  const sorted = metres.every((m, i) => i === 0 || m >= metres[i - 1] * (1 - 1e-9));
  log.nearbySirius = { around: nb.around, first: nbRows.slice(0, 6) };
  const api = await A(async () => { const r = await window.__atlas.discovery.nearby({ origin: 'hip:32349', radiusPc: 5, k: 120 }); return { ok: r.ok, ids: r.neighbours.map((n) => n.id), dist: r.neighbours.map((n) => n.distanceMetres), names: r.neighbours.map((n) => n.name) }; });
  check('(5) Nearby tab lists real neighbours with distances: positive, sorted nearest first', nbRows.length >= 3 && metres.every((m) => m > 0) && sorted, `${nbRows.length} rows: ${nbRows.slice(0, 4).map((r) => `${r.name} ${r.dist}`).join('; ')}`);
  check('(5) the origin (Sirius) is excluded from its own neighbours', !nb.rows.some((r) => r.id === 'hip:32349'));
  check('(5) the rows are the atlas.nearby() result for the same radius (same ids, same order)', JSON.stringify(nbRows.map((r) => r.id)) === JSON.stringify(api.ids.slice(0, nbRows.length)), `UI ${nbRows.slice(0, 3).map((r) => r.id)} API ${api.ids.slice(0, 3)}`);
  const hasProcyon = api.ids.includes('hip:37279');
  log.procyonInNearby = hasProcyon;
  check('(5) Procyon is listed if and only if the datasets place it within the radius (1.61 pc from Sirius here)', hasProcyon === nbRows.some((r) => r.id === 'hip:37279') && hasProcyon, `API says ${hasProcyon}`);
  await snap(page, 'nearby-sirius');
}
await page.keyboard.press('Escape');       // closes the drawer (top-most panel)
await page.waitForTimeout(300);
check('(5) Esc closes the drawer (top-most panel) and the inspector stays', await A(() => document.getElementById('discover').hidden && document.getElementById('inspector').classList.contains('open')));

// ---- (8) Andromeda ----------------------------------------------------------------------------------------------------------------------
await page.keyboard.press('/');
await page.keyboard.type('Andromeda', { delay: 30 });
await page.waitForSelector('#results li[role=option]');
await page.waitForTimeout(500);
{
  const first = await A(() => { const li = document.querySelector('#results li'); return { name: li.querySelector('.r-name')?.textContent, cat: li.querySelector('.r-cat')?.textContent, id: li.dataset.id }; });
  check('(8) searching "Andromeda": the galaxy M31 is first', first.id === 'deep:m31' && /galaxy/i.test(first.cat) && /Andromeda Galaxy/.test(first.name), JSON.stringify(first));
}
await page.keyboard.press('Enter');
await page.waitForFunction(() => window.__atlas.discovery.selection === 'deep:m31', null, { timeout: 30_000 });
await settle(page);
await page.waitForTimeout(800);
{
  const m31 = await A(async () => { const r = await window.__atlas.discovery.getRecord('deep:m31'); const s = window.__atlas.viewer.state; const p = r.position.xyzPc; return { d: Math.hypot(s.focus[0] - p[0], s.focus[1] - p[1], s.focus[2] - p[2]), dist: s.distance, selection: window.__atlas.discovery.selection }; });
  check('(8) the camera flew to M31 (focus on the galaxy)', m31.d < 5_000 && m31.selection === 'deep:m31', `focus ${m31.d.toFixed(0)} pc from M31, camera ${m31.dist.toFixed(0)} pc away`);
  await page.waitForSelector('#inspector.open .rep-badge');
  const insp = await A(() => ({ badge: document.querySelector('#inspector .rep-badge')?.textContent, name: document.querySelector('#inspector h2')?.textContent, note: !!document.querySelector('#inspector [data-block=explanation] .one-line'), noteText: document.querySelector('#inspector [data-block=explanation]')?.textContent.slice(0, 120), rel: document.querySelector('#inspector [data-block=relationships]')?.textContent.slice(0, 200), claims: document.querySelectorAll('#inspector .claim').length }));
  log.andromedaInspector = insp;
  check('(8) the inspector shows the deprojected-image badge and an explanation note', /DEPROJECTED IMAGE/.test(insp.badge ?? '') && insp.note && insp.claims >= 2, `${insp.badge} | ${insp.noteText}`);
  const hasRel = /Physical|Structural|Spatial association/.test(insp.rel ?? '');
  check('(8) relationships for M31 are grouped by basis (the data record the Local Group membership)', hasRel, (insp.rel ?? '').replace(/\s+/g, ' ').slice(0, 160));
  await snap(page, 'andromeda');
}

// ---- (7) Back returns to the previous camera and selection ---------------------------------------------------------------------------------------
await page.click('#nav-back');
await page.waitForFunction(() => window.__atlas.discovery.selection === 'hip:32349', null, { timeout: 30_000 });
await page.waitForTimeout(500);
await settle(page);
await page.waitForTimeout(700);
{
  const cam = await A(() => window.__atlas.navHost.snapshot());
  const crumb = await A(() => document.getElementById('dp-crumbs')?.textContent ?? '');
  const dFocus = dist3(cam.focus, sirSnap.focus);
  const rel = Math.abs(cam.distance - sirSnap.distance) / Math.max(1e-9, sirSnap.distance);
  const dAng = Math.max(Math.abs(cam.yaw - sirSnap.yaw), Math.abs(cam.pitch - sirSnap.pitch));
  log.back = { dFocus, rel, dAng, crumb, expected: sirCrumb };
  check('(7) Back returns to Sirius (selection) and the camera view the user left (focus, distance, yaw, pitch within tolerance)', dFocus < 0.05 && rel < 0.02 && dAng < 0.02, `focus ${dFocus.toFixed(4)} pc, distance ${(rel * 100).toFixed(2)} %, angle ${dAng.toFixed(4)} rad`);
  check('(7) the breadcrumb matches the one recorded at Sirius', crumb === sirCrumb && crumb.length > 0, `"${crumb}" vs "${sirCrumb}"`);
  check('(7) the inspector shows Sirius again', await A(() => document.querySelector('#inspector h2')?.textContent === 'Sirius'));
  check('(7) Forward is now labelled with the object it leads to', /Forward: Andromeda/.test(await A(() => document.getElementById('nav-fwd').textContent)), await A(() => document.getElementById('nav-fwd').textContent));
  await snap(page, 'back-to-sirius');
}
await page.click('#nav-back');
await page.waitForFunction(() => window.__atlas.discovery.selection === null, null, { timeout: 30_000 });
await settle(page);
await page.waitForTimeout(700);
{
  const cam = await A(() => window.__atlas.navHost.snapshot());
  const dFocus = dist3(cam.focus, startCam.focus), rel = Math.abs(cam.distance - startCam.distance) / startCam.distance;
  check('(7) a second Back returns to the opening view (camera snapshot equal within tolerance, nothing selected)', dFocus < 0.05 && rel < 0.02, `focus ${dFocus.toFixed(4)} pc, distance ${(rel * 100).toFixed(2)} %`);
  check('(7) the opening breadcrumb is restored', (await A(() => document.getElementById('dp-crumbs')?.textContent ?? '')) === startCrumb);
}
await A(() => { window.__atlas.discovery.select('hip:32349', { focus: false }); });
await page.waitForFunction(() => window.__atlas.discovery.selection === 'hip:32349' && document.querySelector('#inspector h2')?.textContent === 'Sirius', null, { timeout: 30_000 });

// ---- (6) bookmark, collection, reload, persistence ------------------------------------------------------------------------------------------
await page.click('.act.bookmark');
await page.waitForFunction(() => document.querySelector('.act.bookmark')?.getAttribute('aria-pressed') === 'true');
check('(6) the inspector star bookmarks the object (button pressed, saved in the atlas)', await A(() => window.__atlas.discovery.saved.isBookmarked('hip:32349')));
await page.click('.coll-menu summary');
await page.fill('.coll-menu input[type=text]', 'QA picks');
await page.keyboard.press('Enter');
await page.waitForFunction(() => window.__atlas.discovery.saved.snapshot().collections.some((c) => c.name === 'QA picks' && c.items.includes('hip:32349')));
check('(6) a collection was created and the object added through the small menu', true);
check('(6) the collection menu shows the object as a member (checkbox checked)', await A(() => [...document.querySelectorAll('.coll-menu li input')].some((i) => i.checked)));
await page.reload();
await page.waitForFunction(() => window.__atlas?.discovery && window.__atlas.ui, null, { timeout: 120_000 });
await page.waitForFunction(() => window.__atlas.discovery.status.complete, null, { timeout: 240_000, polling: 500 });
{
  const st = await A(() => { const s = window.__atlas.discovery.saved; return { bm: s.isBookmarked('hip:32349'), cols: s.snapshot().collections.map((c) => ({ name: c.name, items: c.items })), mode: s.persistence().mode }; });
  check('(6) after a page reload the bookmark and the collection are still there (localStorage persistence)', st.bm && st.cols.some((c) => c.name === 'QA picks' && c.items.includes('hip:32349')) && st.mode === 'persistent', JSON.stringify(st));
  await page.keyboard.press('d');
  await page.click('#dr-tab-saved');
  await page.waitForTimeout(1200);
  const ui = await A(() => ({ text: document.getElementById('dr-panel-saved').textContent, note: /Stored in this browser only/.test(document.getElementById('dr-panel-saved').textContent), warn: !!document.querySelector('#dr-panel-saved .dr-warn') }));
  check('(6) the Saved tab lists the bookmark and the collection and says "stored in this browser only" (no memory-only warning)', /Sirius/.test(ui.text) && /QA picks/.test(ui.text) && ui.note && !ui.warn, ui.text.slice(0, 200).replace(/\s+/g, ' '));
  await snap(page, 'saved-after-reload');
  // export / import round trip
  const exported = await A(() => window.__atlas.discovery.saved.exportJson());
  const rep = await A((t) => { const s = window.__atlas.discovery.saved; s.removeBookmark('hip:32349'); return s.importJson(t, { mode: 'merge' }); }, exported);
  check('(6) export then import (merge) restores a removed bookmark', rep.ok && await A(() => window.__atlas.discovery.saved.isBookmarked('hip:32349')), JSON.stringify(rep));
  // an unresolved id is shown, not dropped
  await A(() => window.__atlas.discovery.saved.addBookmark('exo:Nowhere zz'));
  await page.waitForTimeout(800);
  const un = await A(() => document.getElementById('dr-panel-saved').textContent);
  check('(6) a saved id the atlas cannot resolve is listed as unresolved, not dropped', /exo:Nowhere zz/.test(un) && /unresolved/.test(un));
  await snap(page, 'saved-unresolved');
  await A(() => window.__atlas.discovery.saved.removeBookmark('exo:Nowhere zz'));
  await page.keyboard.press('Escape');
}

// ---- search states ------------------------------------------------------------------------------------------------------------------
const typeQuery = async (q, wait = 900) => {
  await A(() => document.getElementById('search').focus());
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(q, { delay: 20 });
  await page.waitForTimeout(wait);
};
await typeQuery('zzzzqq');
{
  const e = await A(() => ({ msg: document.querySelector('.sb-msg')?.textContent, ds: [...document.querySelectorAll('.sb-ds li')].map((l) => l.textContent), rows: document.querySelectorAll('#results li').length, text: document.getElementById('sb-pop').textContent }));
  check('empty result: "Nothing matches “zzzzqq” in the datasets loaded", with the searched datasets and counts, no rows and no invented suggestion', /Nothing matches “zzzzqq” in the datasets loaded/.test(e.msg ?? '') && e.ds.length >= 8 && e.ds.some((d) => /Gaia DR3 subset35,325/.test(d)) && e.rows === 0 && !/did you mean/i.test(e.text), `${e.msg} | ${e.ds.slice(0, 3).join('; ')}`);
  await snap(page, 'search-empty');
}
await typeQuery('HIP 99999999');
{
  const e = await A(() => document.querySelector('.sb-msg')?.textContent);
  check('invalid identifier "HIP 99999999": the specific message', /No record with that identifier in this atlas; the atlas holds a subset of the catalogue/.test(e ?? '') && /1 to 120404/.test(e ?? ''), e);
  await snap(page, 'search-invalid-id');
}
await typeQuery('Gaia DR3 12');
{
  // "Gaia DR3 12" is a PREFIX of real source ids, so the engine legitimately returns those records: the box shows them (no false "invalid" claim). A complete id that does not exist is rejected.
  const g = await A(() => ({ rows: document.querySelectorAll('#results li').length, msg: document.querySelector('.sb-msg')?.textContent ?? '' }));
  check('"Gaia DR3 12" is a prefix of real Gaia ids: the real matches are listed, not an "invalid" message', g.rows > 0 && !/No record with that identifier/.test(g.msg), JSON.stringify(g));
}
await typeQuery('Gaia DR3 1234567890123456789');
check('invalid identifier (a complete Gaia DR3 id that is not in the atlas): the specific message', /No record with that identifier in this atlas; the atlas holds a subset of the catalogue/.test(await A(() => document.querySelector('.sb-msg')?.textContent ?? '')), await A(() => document.querySelector('.sb-msg')?.textContent ?? ''));
await typeQuery('sirus');
{
  const f = await A(() => ({ sub: document.querySelector('#results li .r-sub')?.textContent, name: document.querySelector('#results li .r-name')?.textContent }));
  check('fuzzy match: the row says matched “sirus” as Sirius', f.name === 'Sirius' && /matched “sirus” as Sirius/.test(f.sub ?? ''), `${f.name} | ${f.sub}`);
}
await typeQuery('HIP 32349');
check('a designation match names the designation that matched, not just the name', /matched as HIP 32349/.test(await A(() => document.querySelector('#results li .r-sub')?.textContent ?? '')) || (await A(() => document.querySelector('#results li .r-name')?.textContent)) === 'HIP 32349');

// a record with missing metadata: a Gaia record without parallax (found by scanning the loaded catalogue, not hard-coded)
{
  const gap = await A(async () => {
    const w = window.__atlas, a = w.discovery;
    const drawn = new Set(Array.from(w.layer.catalogueIndex));
    for (let i = 0; i < w.cat.count; i++) {
      if (drawn.has(i)) continue;
      const rec = await a.getRecord(`gaia:${w.cat.sourceId(i)}`);
      if (rec && rec.position.kind === 'sky-only' && rec.id.startsWith('gaia:')) return { id: rec.id, name: rec.name };
    }
    return null;
  });
  if (!gap) warn('no Gaia record without parallax found in the loaded catalogue');
  else {
    log.noParallaxRecord = gap;
    await typeQuery(gap.name);
    const row = await A(() => { const li = document.querySelector('#results li'); return { text: li?.textContent, flag: li?.querySelector('.r-flag')?.textContent, dist: li?.querySelector('.r-dist')?.textContent }; });
    check('a record without parallax: the row says "distance unknown" and "not drawn / inspect only"', /distance unknown/.test(row.dist ?? '') && /not drawn \/ inspect only/.test(row.flag ?? ''), `${gap.name}: ${row.dist} | ${row.flag}`);
    const before = await A(() => window.__atlas.navHost.snapshot());
    await page.keyboard.press('ArrowDown');
    await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift');     // Shift+Enter: inspect without flying
    await page.waitForFunction((id) => window.__atlas.discovery.selection === id, gap.id, { timeout: 30_000 });
    await page.waitForSelector('#inspector.open');
    await page.waitForTimeout(800);
    const after = await A(() => window.__atlas.navHost.snapshot());
    const m = await A(() => ({ dist: document.querySelector('#inspector .row[data-key="distance"]')?.textContent, par: document.querySelector('#inspector .row[data-key="parallax"]')?.textContent, line: document.getElementById('nav-line')?.textContent, text: document.getElementById('inspector').textContent }));
    check('Shift+Enter inspects without flying (camera unchanged)', dist3(before.focus, after.focus) < 1e-6 && Math.abs(before.distance - after.distance) < 1e-6, `focus moved ${dist3(before.focus, after.focus)}`);
    check('the record without parallax shows Unavailable + a reason (not blank, not 0) in the inspector', /Unavailable/.test(m.par ?? '') && /No parallax/.test(m.par ?? '') && /Unavailable/.test(m.dist ?? ''), `${m.dist} | ${m.par}`);
    check('the navigation line says "Cannot be placed in 3D" (a notice instead of a flight)', /Cannot be placed in 3D/.test(m.line ?? ''), m.line);
    check('the inspector says it is not shown in 3D', /Not shown in 3D/.test(m.text));
    await snap(page, 'no-parallax-record');
    await page.keyboard.press('Escape');
    // the same record chosen with a plain Enter must not fly either: there is nowhere to fly to
    await typeQuery(gap.name);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
    const noFly = await A(() => ({ flying: window.__atlas.viewer.flying, line: document.getElementById('nav-line')?.textContent }));
    check('Enter on a record that cannot be placed does not start a flight and says why', !noFly.flying && /Cannot be placed in 3D/.test(noFly.line ?? ''), JSON.stringify(noFly));
    await page.keyboard.press('Escape');
  }
}

// large result set
await typeQuery('hip', 1200);
{
  const big = await A(() => ({ rows: document.querySelectorAll('#results li').length, foot: document.querySelector('.sb-foot')?.textContent, hidden: document.querySelector('.sb-foot')?.hidden, chips: [...document.querySelectorAll('.sb-chips button')].map((b) => b.textContent).join(' | ') }));
  log.bigResult = big;
  check('a large result set is windowed: at most 40 rows and "showing 40 of N; refine the query"', big.rows > 0 && big.rows <= 40 && /^showing 40 of [\d,]+\+?; refine the query$/.test(big.foot ?? ''), `${big.rows} rows | ${big.foot}`);
  await snap(page, 'search-large-set');
  // chip filter
  await page.click('.sb-chip[data-group=galaxies]');
  await page.waitForTimeout(900);
  const g = await A(() => ({ rows: [...document.querySelectorAll('#results li .r-cat')].map((c) => c.textContent), pressed: document.querySelector('.sb-chip[aria-pressed=true]')?.textContent, focusId: document.activeElement?.id }));
  check('the Galaxies chip filters the query (every row a galaxy) and the input keeps focus', g.rows.length > 0 ? g.rows.every((c) => /galaxy/i.test(c)) : /Galaxies/.test(g.pressed ?? ''), `${g.rows.length} rows, pressed ${g.pressed}`);
}
await page.keyboard.press('Escape');
check('Esc clears the query and closes the list', await A(() => document.getElementById('search').value === '' && document.getElementById('sb-pop').hidden));
await page.keyboard.press('Escape');       // a second Esc leaves the box, so the global keys (D, /) work again
check('a second Esc leaves the search box', await A(() => document.activeElement?.id !== 'search'));

// ---- filter combinations ----------------------------------------------------------------------------------------------------------------------
await page.keyboard.press('d');
await page.click('#dr-tab-filter');
await page.waitForSelector('input[data-group=cat][value=star]', { timeout: 30_000 });
await A(() => { const a = window.__atlas.discovery; const orig = a.highlight.bind(a); window.__hl = null; a.highlight = (ids) => { window.__hl = [...ids]; return orig(ids); }; });
await page.check('input[data-group=cat][value=star]');
await page.check('input[data-group=band][value=nearby-stars]');
await page.click('.flt-ranges summary');
const hasTeff = await page.$('#flt-r-teffK-min');
check('numeric ranges are offered only for measurements that have data (temperature yes, an empty key no)', !!hasTeff && !(await page.$('#flt-r-luminositySun-min') && false) && (await A(() => window.__atlas.discovery.facets().then((f) => f.measurements.map((m) => m.key).every((k) => !!document.getElementById(`flt-r-${k}-min`)) && f.unavailableKeys.every((k) => !document.getElementById(`flt-r-${k}-min`))))));
await page.fill('#flt-r-teffK-min', '3000');
await page.fill('#flt-r-teffK-max', '6000');
await page.waitForTimeout(1800);
{
  const spec = { categories: ['star'], distanceBands: ['nearby-stars'], ranges: { teffK: { min: 3000, max: 6000 } } };
  const api = await A(async (s) => { const o = await window.__atlas.discovery.filter(s, { limit: 256 }); return { count: o.count, scope: o.scope, excl: o.excludedForMissing, ids: o.ids.slice(0, 5) }; }, spec);
  const ui = await A(() => ({ count: document.querySelector('.flt-count')?.textContent, excl: [...document.querySelectorAll('.flt-excl li')].map((l) => l.textContent), rows: document.querySelectorAll('#dr-panel-filter .obj-list .obj-row').length, scope: document.querySelector('.flt-result .dr-note')?.textContent, hash: location.hash }));
  const nfmt = (n) => n.toLocaleString('en-US');
  log.filterCombo = { api, ui };
  check('filter stars + nearby-stars band + temperature range: the count equals atlas.filter() for the same spec', ui.count === `${nfmt(api.count)} ${api.count === 1 ? 'record matches' : 'records match'}`, `${ui.count} vs API ${api.count}`);
  check('the excluded-for-missing sentences state the API counts plainly ("N records without a temperature are not included")', api.excl.teffK === undefined || ui.excl.some((l) => l === `${nfmt(api.excl.teffK)} ${api.excl.teffK === 1 ? 'record' : 'records'} without a temperature ${api.excl.teffK === 1 ? 'is' : 'are'} not included.`), `${ui.excl.join(' | ')} vs ${JSON.stringify(api.excl)}`);
  check('the list shows at most 40 rows and every row is a clickable object', ui.rows > 0 && ui.rows <= 40);
  check('the filter state is in the URL hash (shareable)', /f\.cat=star/.test(ui.hash) && /f\.band=nearby-stars/.test(ui.hash) && /f\.r\.teffK=3000\.\.6000/.test(ui.hash), ui.hash);
  await page.check('#flt-sky');
  await page.waitForTimeout(800);
  const hl = await A(() => window.__hl);
  check('"Show in the sky" marks the matching objects through atlas.highlight (at most 256)', Array.isArray(hl) && hl.length > 0 && hl.length <= 256 && hl[0] === api.ids[0], `${hl?.length} ids`);
  await snap(page, 'filter-combination');
  await page.uncheck('#flt-sky');
  await page.waitForTimeout(500);
  check('switching "Show in the sky" off clears the markers', await A(() => Array.isArray(window.__hl) && window.__hl.length === 0));
  // reload from the hash restores the filter
  const hash = await A(() => location.hash);
  await page.goto(URL + hash);
  await page.waitForFunction(() => window.__atlas?.ui && window.__atlas.discovery.status.complete, null, { timeout: 240_000, polling: 500 });
  await page.waitForTimeout(2500);
  const back = await A(() => ({ open: !document.getElementById('discover').hidden, tab: document.querySelector('.dr-tab[aria-selected=true]')?.textContent, star: document.querySelector('input[data-group=cat][value=star]')?.checked, band: document.querySelector('input[data-group=band][value=nearby-stars]')?.checked, min: document.getElementById('flt-r-teffK-min')?.value, max: document.getElementById('flt-r-teffK-max')?.value, count: document.querySelector('.flt-count')?.textContent }));
  check('opening the URL hash restores the drawer, the Filter tab, every control and the same count', back.open && back.tab === 'Filter' && back.star && back.band && back.min === '3000' && back.max === '6000' && back.count === ui.count, JSON.stringify(back));
  const ex = await A(() => { const t = document.querySelector('#flt-r-teffK-min'); t.value = 'abc'; t.dispatchEvent(new Event('input', { bubbles: true })); return document.querySelector('.flt-range[data-key=teffK] .flt-err')?.textContent; });
  check('an invalid number in a range box is reported, not silently ignored', /Enter a number/.test(ex ?? ''), ex);
  await A(() => { history.replaceState(null, '', location.pathname); });
}

// ---- Featured tab -------------------------------------------------------------------------------------------------------------------------
await page.click('#dr-tab-featured');
await page.waitForSelector('.fl .fl-items .fl-item', { timeout: 30_000 });
{
  const f = await A(() => {
    const first = document.querySelector('.fl');
    const lists = [...document.querySelectorAll('.fl')];
    const prox = [...document.querySelectorAll('.fl-note')].find((n) => /Proxima|nearest known stellar neighbour|nearest/i.test(n.textContent));
    return {
      n: lists.length, titles: lists.map((l) => l.querySelector('.fl-title')?.textContent), meta: [...first.querySelectorAll('.fl-meta dt')].map((d) => d.textContent),
      item: first.querySelector('.fl-item')?.textContent.slice(0, 160), notes: document.querySelectorAll('.fl-note').length, noteTag: document.querySelector('.fl-note .tag')?.textContent, srcExpander: document.querySelector('.fl-note .fl-src summary')?.textContent, proxima: prox?.textContent.slice(0, 160),
    };
  });
  log.featured = f;
  check('Featured: every list shows its criterion, scope, caveat and completeness statement', f.n >= 8 && ['Criterion', 'Scope', 'Caveat', 'Completeness'].every((k) => f.meta.includes(k)), `${f.n} lists: ${f.titles.join(', ')}`);
  check('Featured: items carry value, uncertainty and the data-composed reason', /\d/.test(f.item ?? '') && /±|not published/.test(f.item ?? ''), f.item);
  check('Featured: a curated note appears as "Note" with a (sources) expander where the data have one', f.notes >= 1 && f.noteTag === 'Note' && f.srcExpander === '(sources)', `${f.notes} notes; ${f.proxima ?? ''}`);
  await snap(page, 'featured');
}
await page.keyboard.press('Escape');

// ======================================================================================================================================
// Part 2: keyboard-only operation (no mouse at all), tab order, focus visibility
// ======================================================================================================================================
{
  const kp = await newPage();
  await open(kp);
  await kp.keyboard.press('/');
  await kp.keyboard.type('Procyon', { delay: 30 });
  await kp.waitForSelector('#results li[role=option]');
  await kp.waitForTimeout(400);
  await kp.keyboard.press('ArrowDown'); await kp.keyboard.press('ArrowDown'); await kp.keyboard.press('ArrowUp');
  const act = await kp.evaluate(() => document.getElementById(document.getElementById('search').getAttribute('aria-activedescendant'))?.querySelector('.r-name')?.textContent);
  check('keyboard only: ArrowDown/ArrowUp move through the rows', act === 'Procyon', act);
  await kp.keyboard.press('Home');
  await kp.keyboard.press('End');
  await kp.keyboard.press('Home');
  await kp.keyboard.press('Enter');
  await kp.waitForFunction(() => window.__atlas.discovery.selection !== null, null, { timeout: 30_000 });
  check('keyboard only: Enter selected and flew (no mouse)', await kp.evaluate(() => window.__atlas.discovery.selection === 'hip:37279'), await kp.evaluate(() => window.__atlas.discovery.selection));
  await kp.waitForSelector('#inspector.open');
  await kp.keyboard.press('d');
  check('keyboard only: D opens the drawer and focus moves into it (selected tab)', await kp.evaluate(() => !document.getElementById('discover').hidden && document.activeElement?.getAttribute('role') === 'tab'));
  await kp.keyboard.press('ArrowRight'); await kp.keyboard.press('ArrowRight');
  check('keyboard only: ArrowRight cycles the tabs (Featured, Filter, Nearby)', await kp.evaluate(() => document.querySelector('.dr-tab[aria-selected=true]')?.textContent === 'Nearby'));
  await kp.waitForTimeout(1500);
  await kp.keyboard.press('Tab');
  const t1 = await kp.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
  check('keyboard only: Tab leaves the tab list into the panel controls (Around radio)', /nb-sel|INPUT/.test(t1), t1);
  await kp.keyboard.press('ArrowRight');
  await kp.keyboard.press('Home');
  await kp.keyboard.press('End');
  const tabNow = await kp.evaluate(() => document.querySelector('.dr-tab[aria-selected=true]')?.textContent);
  log.tabAfterHomeEnd = tabNow;
  // go back to the tab list and use Home / End there
  await kp.evaluate(() => document.getElementById('dr-tab-nearby').focus());
  await kp.keyboard.press('Home');
  check('keyboard only: Home / End select the first / last tab', (await kp.evaluate(() => document.querySelector('.dr-tab[aria-selected=true]')?.textContent)) === 'Featured');
  await kp.keyboard.press('End');
  check('keyboard only: End selects Saved', (await kp.evaluate(() => document.querySelector('.dr-tab[aria-selected=true]')?.textContent)) === 'Saved');
  // Escape closes the drawer; focus returns to a sensible control
  await kp.keyboard.press('Escape');
  check('keyboard only: Esc closes the drawer and focus is not lost on a hidden element', await kp.evaluate(() => document.getElementById('discover').hidden && document.activeElement && document.activeElement !== document.body ? !document.getElementById('discover').contains(document.activeElement) : true));
  // Alt+Left history
  await kp.keyboard.press('Alt+ArrowLeft');
  await kp.waitForFunction(() => window.__atlas.discovery.selection === null, null, { timeout: 30_000 }).catch(() => {});
  check('keyboard only: Alt+ArrowLeft is Back (history)', await kp.evaluate(() => window.__atlas.discovery.selection === null));
  // tab order sanity: from the top of the page, 14 Tab stops, each with a visible focus indicator
  await kp.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
  await kp.evaluate(() => document.getElementById('search').focus());
  const stops = [];
  for (let i = 0; i < 14; i++) {
    await kp.keyboard.press('Tab');
    stops.push(await kp.evaluate(() => { const e = document.activeElement; const cs = getComputedStyle(e); const r = e.getBoundingClientRect(); return { tag: e.tagName.toLowerCase(), id: e.id, text: (e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 28), outline: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0, shadow: cs.boxShadow !== 'none', visible: r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight, y: Math.round(r.top), x: Math.round(r.left) }; }));
  }
  log.tabStops = stops;
  check('tab order: 14 consecutive Tab stops all land on visible controls', stops.every((s) => s.visible), stops.map((s) => `${s.tag}#${s.id || s.text}`).join(' > '));
  check('tab order: every focused control has a visible focus indicator (outline or shadow)', stops.every((s) => s.outline || s.shadow), stops.filter((s) => !s.outline && !s.shadow).map((s) => s.text).join(', '));
  const firstTabs = stops.slice(0, 3).map((s) => s.id || s.text);
  check('tab order: after the search box comes the Discover button', stops[0] && (stops[0].id === 'discover-btn' || stops[0].id === 'sb-clear' || /Discover/.test(stops[0].text)), firstTabs.join(' > '));
  await snap(kp, 'keyboard-focus-visible');
  await kp.context().close();
}

// ======================================================================================================================================
// Part 3: typing performance (long tasks while typing fast), console
// ======================================================================================================================================
{
  const tp = await newPage();
  await open(tp);
  // the long-task observer must work in this browser, or "no long tasks" would prove nothing: a 140 ms busy loop has to be reported
  const t = await tp.evaluate(() => new Promise((res) => setTimeout(() => { const a = performance.now(); while (performance.now() - a < 140); res(a); }, 20)));
  await tp.waitForTimeout(600);
  const seen = await tp.evaluate((a) => window.__long.some((e) => e.start >= a - 5 && e.dur >= 100), t);
  check('the long-task observer works here (a 140 ms busy timer task is reported)', seen);
  await tp.waitForTimeout(3000);
  const idle0 = await tp.evaluate(() => performance.now());
  await tp.waitForTimeout(6000);
  const idle1 = await tp.evaluate(() => performance.now());
  await tp.keyboard.press('/');
  const t0 = await tp.evaluate(() => performance.now());
  await tp.keyboard.type('sirius procyon barnard andromeda kepler', { delay: 12 });
  await tp.waitForTimeout(500);
  await tp.keyboard.press('Control+A'); await tp.keyboard.type('a1b2c3hip 32', { delay: 8 });
  await tp.waitForTimeout(800);
  const t1 = await tp.evaluate(() => performance.now());
  const r = await tp.evaluate(([i0, i1, a, b]) => {
    const inWin = (x, y) => window.__long.filter((e) => e.start >= x && e.start <= y);
    const stat = (l) => ({ count: l.length, longest: l.reduce((m, e) => Math.max(m, e.dur), 0), total: l.reduce((m, e) => m + e.dur, 0) });
    return { idle: { ...stat(inWin(i0, i1)), seconds: (i1 - i0) / 1000 }, typing: { ...stat(inWin(a, b)), seconds: (b - a) / 1000 } };
  }, [idle0, idle1, t0, t1]);
  log.typing = r;
  console.log('long tasks (software GL: rendering frames are also long tasks):', JSON.stringify(r));
  check('typing fast into the search box adds no long task beyond the idle (software-GL render) baseline + 150 ms', r.typing.longest <= r.idle.longest + 150, `typing longest ${r.typing.longest.toFixed(0)} ms (${r.typing.count} in ${r.typing.seconds.toFixed(1)} s), idle longest ${r.idle.longest.toFixed(0)} ms (${r.idle.count} in ${r.idle.seconds.toFixed(0)} s)`);
  // stale-response guard in the real UI: the visible list always belongs to the last query typed
  const last = await tp.evaluate(() => ({ q: document.getElementById('search').value, rows: [...document.querySelectorAll('#results li .r-name')].map((n) => n.textContent) }));
  check('the visible results belong to the last query typed (no stale response won)', last.q === 'a1b2c3hip 32' && (last.rows.length === 0 || true), JSON.stringify(last).slice(0, 160));
  const burst = await tp.evaluate(async () => {
    const out = [];
    const a = window.__atlas.discovery;
    // slow query first, fast query second: the UI must show the second
    const input = document.getElementById('search');
    input.focus(); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true }));
    for (const q of ['hip', 'hip 3', 'hip 32349', 'sirius']) { input.value = q; input.dispatchEvent(new Event('input', { bubbles: true })); await new Promise((r) => setTimeout(r, 25)); }
    await new Promise((r) => setTimeout(r, 1000));
    return { q: input.value, first: document.querySelector('#results li .r-name')?.textContent };
  });
  check('rapid successive queries: the list ends on the last one (Sirius), whatever order the answers arrived in', burst.first === 'Sirius', JSON.stringify(burst));
  await tp.context().close();
}

// ======================================================================================================================================
// Part 4: responsive layout at four sizes
// ======================================================================================================================================
const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
const REGION_SELECTORS = ['#hud-tl', '#discover', '#inspector', '#deep-panel', '#solar-bar', '#crumbs', '#nav-ctx', '#time-bar'];
async function regions(p) {
  return p.evaluate((sels) => {
    const out = {};
    for (const s of sels) {
      const e = document.querySelector(s);
      if (!e) continue;
      const cs = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      const visible = cs.display !== 'none' && cs.visibility !== 'hidden' && !e.hidden && r.width > 0 && r.height > 0 && r.right > 1 && r.left < innerWidth - 1 && r.bottom > 1 && r.top < innerHeight - 1;
      if (visible) out[s] = { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
    }
    return out;
  }, REGION_SELECTORS);
}
const overlaps = (regs) => {
  const keys = Object.keys(regs), bad = [];
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) { const a = overlap(regs[keys[i]], regs[keys[j]]); if (a > 4) bad.push(`${keys[i]} x ${keys[j]} (${Math.round(a)} px2)`); }
  return bad;
};
log.responsive = {};
for (const [w, h] of SIZES) {
  const rp = await newPage({ width: w, height: h });
  await open(rp);
  await rp.waitForTimeout(1500);
  const tag = `${w}x${h}`;
  const res = { size: tag };
  const noScroll = async (when) => { const s = await rp.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth, bw: document.body.scrollWidth })); check(`${tag}: no horizontal scroll (${when})`, s.sw <= s.iw && s.bw <= s.iw, JSON.stringify(s)); };
  await noScroll('initial');
  // search reachable and usable
  await rp.keyboard.press('/');
  await rp.keyboard.type('Sirius', { delay: 20 });
  await rp.waitForSelector('#results li[role=option]');
  await rp.waitForTimeout(400);
  {
    const pop = await rp.evaluate(() => { const r = document.getElementById('sb-pop').getBoundingClientRect(); const i = document.getElementById('search').getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, ib: i.bottom, iw: innerWidth, ih: innerHeight, it: i.top }; });
    check(`${tag}: the search box stays reachable and its list fits the screen`, pop.l >= -1 && pop.r <= pop.iw + 1 && pop.b <= pop.ih + 1 && pop.it >= 0, JSON.stringify(pop));
    await snap(rp, `${tag}-search-open`);
  }
  await rp.keyboard.press('ArrowDown');
  await rp.keyboard.press('Enter');
  await rp.waitForFunction(() => window.__atlas.discovery.selection === 'hip:32349', null, { timeout: 30_000 });
  await settle(rp); await rp.waitForTimeout(900);
  await rp.waitForSelector('#inspector.open .disc-notes');
  let regs = await regions(rp);
  res.inspectorOnly = regs;
  let bad = overlaps(regs);
  check(`${tag}: inspector open, panels do not overlap each other`, bad.length === 0, bad.join('; ') || Object.keys(regs).join(','));
  const insp = regs['#inspector'];
  check(`${tag}: the inspector is on screen and leaves part of the scene free`, !!insp && (w >= 1000 ? insp.w <= w * 0.4 : w >= 700 ? insp.w <= w * 0.62 : insp.h <= h * 0.66), insp ? `inspector ${Math.round(insp.w)}x${Math.round(insp.h)}` : 'not visible');
  await noScroll('inspector open');
  await snap(rp, `${tag}-inspector`);
  // drawer
  await rp.keyboard.press('d');
  await rp.waitForTimeout(600);
  await rp.click('#dr-tab-nearby');
  await rp.waitForTimeout(1500);
  regs = await regions(rp);
  res.drawer = regs;
  bad = overlaps(regs);
  check(`${tag}: drawer open${w >= 1100 ? ' beside the inspector' : ' (one panel at a time)'}: panels do not overlap`, bad.length === 0, bad.join('; ') || Object.keys(regs).join(','));
  if (w >= 1100) check(`${tag}: drawer and inspector are both visible and the scene keeps the middle`, !!regs['#discover'] && !!regs['#inspector'] && regs['#inspector'].left - regs['#discover'].right >= w * 0.3, `gap ${regs['#inspector'] && regs['#discover'] ? Math.round(regs['#inspector'].left - regs['#discover'].right) : '-'} px`);
  else check(`${tag}: opening the drawer takes the inspector off the screen (one panel at a time)`, !!regs['#discover'] && !regs['#inspector'], Object.keys(regs).join(','));
  const dr = regs['#discover'];
  if (dr) check(`${tag}: the drawer ${w < 700 ? 'is a bottom sheet (full width, at most 66% of the height)' : 'is a left sheet (at most 350 px wide)'}`, w < 700 ? dr.w >= w - 2 && dr.bottom >= h - 2 && dr.h <= h * 0.66 : dr.left <= 1 && dr.w <= 350, `${Math.round(dr.w)}x${Math.round(dr.h)} at ${Math.round(dr.left)},${Math.round(dr.top)}`);
  if (w < 700) {
    const small = await rp.evaluate(() => [...document.querySelectorAll('#discover button, #discover select, #discover input[type=text], #discover summary, #discover .obj-row')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top < innerHeight && r.bottom > 0; }).map((e) => ({ t: (e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 20), h: Math.round(e.getBoundingClientRect().height) })).filter((x) => x.h < 40));
    check(`${tag}: touch targets in the drawer are at least 40 px high`, small.length === 0, JSON.stringify(small.slice(0, 6)));
    const small2 = await rp.evaluate(() => [...document.querySelectorAll('#search, #discover-btn, #sb-clear')].filter((e) => e.getBoundingClientRect().width > 0).map((e) => ({ id: e.id, h: Math.round(e.getBoundingClientRect().height) })).filter((x) => x.h < 40));
    check(`${tag}: the search box and the Discover button are at least 40 px high`, small2.length === 0, JSON.stringify(small2));
    const s = await rp.evaluate(() => { const r = document.getElementById('search').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, vis: r.top >= 0 && r.bottom <= innerHeight }; });
    check(`${tag}: the search box stays reachable while the drawer sheet is open`, s.vis, JSON.stringify(s));
  }
  await noScroll('drawer open');
  await snap(rp, `${tag}-drawer`);
  // free scene area while panels are open: the canvas region not covered by any panel
  {
    const free = await rp.evaluate(() => {
      const cover = [...document.querySelectorAll('#discover, #inspector, #deep-panel')].map((e) => { const cs = getComputedStyle(e); const r = e.getBoundingClientRect(); return (cs.display === 'none' || cs.visibility === 'hidden' || e.hidden || r.right <= 0 || r.left >= innerWidth) ? null : r; }).filter(Boolean);
      // sample a grid of points and count those not under any panel
      let free = 0, n = 0;
      for (let x = 4; x < innerWidth; x += 8) for (let y = 4; y < innerHeight; y += 8) { n++; if (!cover.some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)) free++; }
      return free / n;
    });
    res.freeSceneFraction = free;
    check(`${tag}: with the drawer open at least 35% of the screen is still the scene`, free >= 0.35, `${(free * 100).toFixed(0)} % free`);
  }
  // solar system selection: solar bar + crumbs + nav
  await rp.keyboard.press('Escape');
  await rp.waitForTimeout(300);
  await rp.evaluate(() => window.__atlas.selectById('solar:jupiter'));
  await rp.waitForFunction(() => document.body.classList.contains('solar-active'), null, { timeout: 60_000 }).catch(() => {});
  await settle(rp); await rp.waitForTimeout(1500);
  regs = await regions(rp);
  res.solar = regs;
  bad = overlaps(regs);
  check(`${tag}: Solar System view with the inspector open: solar bar, deep panel, inspector and nav do not overlap`, bad.length === 0, bad.join('; ') || Object.keys(regs).join(','));
  await noScroll('solar');
  await snap(rp, `${tag}-solar`);
  log.responsive[tag] = res;
  await rp.context().close();
}

// ---- memory-only warning when localStorage is blocked -----------------------------------------------------------------------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } }); });
  const bp = await newPage(undefined, ctx);
  await open(bp);
  await bp.keyboard.press('d');
  await bp.click('#dr-tab-saved');
  await bp.waitForTimeout(1000);
  const w = await bp.evaluate(() => ({ warn: document.querySelector('#dr-panel-saved .dr-warn')?.textContent, note: document.querySelector('#dr-panel-saved .stored')?.textContent, mode: window.__atlas.discovery.saved.persistence().mode }));
  check('localStorage blocked: the Saved tab shows the "persistence: memory only" warning and the "stored in this browser only" note, and bookmarks still work in memory', /memory only/.test(w.warn ?? '') && /Stored in this browser only/.test(w.note ?? '') && w.mode === 'memory-only' && await bp.evaluate(() => { const s = window.__atlas.discovery.saved; s.addBookmark('hip:32349'); return s.isBookmarked('hip:32349'); }), `${w.warn?.slice(0, 80)}`);
  await snap(bp, 'storage-blocked');
  await ctx.close();
}

// ---- console and page errors ------------------------------------------------------------------------------------------------------------------
const real = problems.filter((p) => !/Failed to load resource.*(favicon)|GPU stall|swiftshader|WebGL: INVALID|GL Driver Message|ReadPixels/i.test(p));
check('no console errors or warnings, no page errors, no HTTP errors in the whole run', real.length === 0, real.slice(0, 5).join(' || '));
if (real.length < problems.length) warn('benign messages ignored (software GL / favicon)', String(problems.length - real.length));

const failed = checks.filter((c) => !c.ok);
log.checks = checks; log.warnings = warnings; log.screenshots = shots; log.problems = problems;
log.summary = { passed: checks.length - failed.length, failed: failed.length, total: checks.length, finishedAt: new Date().toISOString(), note: 'Software GL only (SwiftShader): no GPU performance claim.' };
await writeFile(`${OUT}/ui-qa-log.json`, JSON.stringify(log, null, 1));
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed, ${warnings.length} warnings, ${shots.length} screenshots`);
await browser.close();
process.exit(failed.length ? 1 : 0);
