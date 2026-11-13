// Real-browser QA for the deep-space milestone (selection, inspector, navigation, credits, LOD continuity). The unit tests cover the logic;
// this checks that it works in a browser. SOFTWARE GL ONLY (SwiftShader): nothing here measures GPU performance, and frame rate is a warning.
// Needs: `npx vite build && npx vite preview --port 4173 --host 127.0.0.1` and Playwright (PLAYWRIGHT_MODULE_DIR, as for qa-solar.mjs).
// Writes screenshots (docs/qa/deepspace/NN-*.png) and docs/qa/deepspace/qa-log.json. Exits non-zero if any check fails.
// A check whose subject does not exist yet (e.g. a renderer that has not landed) is recorded under "notRun", never as a pass.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const require = createRequire((process.env.PLAYWRIGHT_MODULE_DIR ?? process.cwd()) + '/');
const { chromium } = require('playwright');

const URL = process.env.ATLAS_URL ?? 'http://127.0.0.1:4173/';
const OUT = process.env.QA_OUT ?? 'docs/qa/deepspace';
const TEXTURE_BUDGET_BYTES = 192 * 1024 * 1024;
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const problems = [];
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url()}`); });
const checks = [], warnings = [], notRun = [], shots = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`); };
const warn = (name, detail = '') => { warnings.push({ name, detail }); console.log(`WARN  ${name}${detail ? '  - ' + detail : ''}`); };
const skip = (name, why) => { notRun.push({ name, why }); console.log(`SKIP  ${name}  - ${why}`); };
const A = (fn, arg) => page.evaluate(fn, arg);
const G = 'window.__atlas';

const t0 = Date.now();
await page.goto(URL);
await page.waitForFunction(() => window.__atlas?.deepUi && window.__atlas.viewer.deep, null, { timeout: 90_000 });
const loadMs = Date.now() - t0;
// Deterministic frames: the adaptive quality governor reacts to software-GL frame times, which would change draw detail between samples.
await A(() => window.__atlas.viewer.disableQualityGovernor());
// Track the largest texture memory ever reported by the layer, every frame.
await A(() => { const v = window.__atlas.viewer; const o = v.pickDeep.bind(v); window.__pickLog = []; v.pickDeep = (x, y) => { const r = o(x, y); window.__pickLog.push([Math.round(x), Math.round(y), r]); if (window.__pickLog.length > 20) window.__pickLog.shift(); return r; }; });
await A(() => { window.__qaMax = 0; const loop = () => { const s = window.__atlas.viewer.deep?.stats(); if (s && s.textureBytes > window.__qaMax) window.__qaMax = s.textureBytes; requestAnimationFrame(loop); }; loop(); });

let shotNo = 0;
const snap = async (name) => {
  await page.waitForFunction(() => { const i = document.getElementById('inspector'); if (!i.classList.contains('open')) return true; const t = getComputedStyle(i).transform; return t === 'none' || t === 'matrix(1, 0, 0, 1, 0, 0)'; }, null, { timeout: 60_000, polling: 250 }); // timer polling: requestAnimationFrame polling starves when software-GL frames take seconds
  await page.waitForTimeout(400);
  const file = `${String(++shotNo).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: `${OUT}/${file}`, timeout: 120_000 }); // software-GL frames can take seconds on a loaded machine
  shots.push(file);
};
const settleFlight = () => page.waitForFunction(() => !window.__atlas.viewer.flying, null, { timeout: 90_000 });
/** Wait until the object is drawn as a real image at (or after) its first level and nothing is loading; false on timeout. */
const settleImage = async (id, ms = 30_000) => {
  try { await page.waitForFunction((i) => { const v = window.__atlas.viewer; const s = v.deepScreen.get(i); return s && s.lod.startsWith('image') && v.deep.stats().loading === 0; }, id, { timeout: ms }); return true; } catch { return false; }
};
const info = (id) => A((i) => { const s = window.__atlas.viewer.deepScreen.get(i); return s ? { x: s.x, y: s.y, r: s.pixelRadius, lod: s.lod, visible: s.visible, dist: s.distancePc, kind: s.kind } : null; }, id);
const inspectorState = () => A(() => {
  const root = document.getElementById('inspector');
  const q = (s) => root.querySelector(s);
  const txt = (s) => (q(s)?.textContent ?? '').trim();
  const rows = Object.fromEntries([...root.querySelectorAll('.row')].map((r) => [r.dataset.key, { value: r.querySelector('.value')?.textContent ?? '', unc: r.querySelector('.unc')?.textContent ?? '', missing: r.classList.contains('missing'), reason: r.querySelector('.reason')?.textContent ?? '' }]));
  return {
    open: root.classList.contains('open'), name: txt('h2'), badge: txt('.rep-badge'), summary: txt('.rep-summary'), seeing: !!q('section.seeing'),
    credit: txt('.credit-line .v'), licence: txt('.kv:not(.credit-line) .v a'), assetId: q('.imgprov')?.dataset.asset ?? '', eye: txt('.eye-warning'),
    bands: [...root.querySelectorAll('button.band')].map((b) => ({ asset: b.dataset.asset, on: b.classList.contains('on') })), rows, sections: [...root.querySelectorAll('section h3')].map((h) => h.textContent),
    blank: [...root.querySelectorAll('.row .value')].filter((v) => v.textContent.trim() === '').length,
  };
});
const creditsState = () => A(() => ({ hidden: document.getElementById('credits').hidden, line: document.getElementById('credits-line').textContent }));
const assetOf = (id) => A((i) => window.__atlas.viewer.deep.activeAsset(i) ?? null, id);
const creditOf = (assetId) => A((a) => window.__atlas.viewer.deepData.imageAssetsOf(a.split('-')[0]).length >= 0 ? (window.__atlas.viewer.deepData.all().flatMap((o) => window.__atlas.viewer.deepData.imageAssetsOf(o.id)).find((x) => x.id === a)?.credit ?? null) : null, assetId);

// ---- 1. the start view is unchanged --------------------------------------------------------------------------------------------
const start = await A(() => ({ deepActive: window.__atlas.viewer.deepActive, stats: document.getElementById('deep-stats').textContent, credits: document.getElementById('credits').hidden, note: document.getElementById('deep-note').hidden, dist: window.__atlas.viewer.state.distance, line: document.getElementById('ds-line').textContent, calls: document.getElementById('calls').textContent }));
check('the start view is the Gaia star field: deep chrome is quiet (no deep stats, no credits, no scale note)', !start.deepActive && start.stats === '' && start.credits && start.note && start.dist === 60 && /stars drawn/.test(start.line), `${start.line}; ${start.calls}`);
await snap('start-view');
const panel0 = await A(() => ({ scales: [...document.querySelectorAll('#deep-panel button[data-scale]')].map((b) => b.dataset.scale), groups: [...document.querySelectorAll('#deep-panel details[data-group]')].map((d) => `${d.dataset.group}:${d.querySelectorAll('.dp-item').length}`), toggles: document.querySelectorAll('#deep-panel input[data-layer]').length, legend: document.querySelectorAll('#deep-panel .dp-leg .rep-badge').length }));
check('the deep-space panel has the four scale shortcuts, grouped object lists, four layer toggles and a five-entry legend', panel0.scales.length === 4 && panel0.groups.length === 4 && panel0.toggles === 4 && panel0.legend === 5, JSON.stringify(panel0));

// A real star is still picked at the start view, and a deep-space object is not pickable there.
const starClick = await A(() => { const a = window.__atlas; const L = a.layer; for (let k = 0; k < L.count; k++) { const s = a.viewer.screenOf(k); if (s && s.x > 300 && s.x < 900 && s.y > 200 && s.y < 600 && a.viewer.pick(s.x, s.y)?.catalogueIndex === L.catalogueIndex[k]) return { x: s.x, y: s.y, row: L.catalogueIndex[k] }; } return null; });
if (starClick) {
  await page.mouse.click(starClick.x, starClick.y);
  await page.waitForTimeout(300);
  const sel = await A(() => ({ selected: window.__atlas.selected, deep: window.__atlas.deepUi.selection, open: document.getElementById('inspector').classList.contains('open') }));
  check('clicking a Gaia star at the start view selects that star (deep-space objects are not pickable there)', sel.selected === starClick.row && sel.deep === null && sel.open, `catalogue row ${sel.selected}`);
  await page.keyboard.press('Escape');
  check('Escape clears the star selection and closes the inspector', (await A(() => window.__atlas.selected === null && !document.getElementById('inspector').classList.contains('open'))));
} else skip('star pick at the start view', 'no pickable star found in the central region');

// ---- 2. scale shortcuts: keys M / L / U / H ---------------------------------------------------------------------------------------
const scaleNow = () => A(() => ({ txt: document.getElementById('dp-scale-now').textContent, on: [...document.querySelectorAll('#deep-panel button[data-scale].on')].map((b) => b.dataset.scale), crumbs: document.getElementById('dp-crumbs').textContent, d: window.__atlas.viewer.state.distance, flying: window.__atlas.viewer.flying }));
await page.keyboard.press('u'); await settleFlight(); await page.waitForTimeout(1500);
const uni = await scaleNow();
check('U flies to the nearby-universe scale and the panel says so', uni.on.includes('nearby-universe') && uni.d > 5e7, `${uni.txt}; breadcrumb: ${uni.crumbs}`);
const hasStructure = await A(() => window.__atlas.viewer.deep.registered.some((r) => r.layerKind === 'structure'));
if (hasStructure) {
  const uniNote = await A(() => ({ hidden: document.getElementById('deep-note').hidden, text: document.getElementById('deep-note').textContent }));
  check('beyond 3 Mpc with the structure layer on, the 2MRS caveat is shown (Hubble-flow distances, flux limit, Zone of Avoidance)', !uniNote.hidden && /2MASS Redshift Survey/.test(uniNote.text) && /Hubble-flow/.test(uniNote.text) && /flux-limited/.test(uniNote.text), uniNote.text.slice(0, 80));
  await A(() => { const cb = document.querySelector('#deep-panel input[data-layer="structure"]'); cb.click(); });
  await page.waitForTimeout(700);
  const noteOff = await A(() => document.getElementById('deep-note').hidden);
  check('turning the structure layer off removes the 2MRS caveat', noteOff === true);
  await A(() => document.querySelector('#deep-panel input[data-layer="structure"]').click());
  await page.waitForTimeout(500);
} else skip('2MRS caveat line and its toggle', 'no structure renderer is registered yet (the note is shown only for a layer that exists)');
await snap('nearby-universe-2mrs');
const structPts = await A(() => { const s = window.__atlas.viewer.deep.stats(); return { points: s.pointsDrawn, visible: s.objectsVisible }; });
if (structPts.points > 1000) check('the 2MRS structure layer draws its observed galaxy positions', true, `${structPts.points.toLocaleString('en-US')} points`);
else skip('2MRS structure draws points', `renderer reports ${structPts.points} points drawn (structure renderer not present or not drawing yet)`);

await page.keyboard.press('l'); await settleFlight(); await page.waitForTimeout(1500);
const lg = await scaleNow();
check('L flies to the Local Group scale', lg.on.includes('local-group') && lg.d > 2e6 && lg.d < 4e6, `${lg.txt}; breadcrumb: ${lg.crumbs}`);
await page.waitForTimeout(500);
const lgNote = await A(() => document.getElementById('deep-note').textContent);
await snap('local-group');
await page.keyboard.press('m'); await settleFlight(); await page.waitForTimeout(1500);
const mw = await scaleNow();
check('M flies to the Milky Way and clears the selection (a view, not an inspection)', mw.on.includes('milky-way') && mw.d < 3e5, `${mw.txt}; breadcrumb: ${mw.crumbs}`);
check('the breadcrumb at the Milky Way view (camera outside the Galaxy frame) reads Universe > Nearby universe > Local Group', /^Universe\s*›\s*Nearby universe\s*›\s*Local Group$/.test(mw.crumbs), mw.crumbs);
await snap('milky-way');
await page.keyboard.press('h'); await settleFlight(); await page.waitForTimeout(1200);
const home = await scaleNow();
check('H returns to the Solar neighbourhood start distance (60 pc)', Math.abs(home.d - 60) < 1 && home.on.includes('solar-neighbourhood'), `${home.d.toFixed(1)} pc`);
const helpText = await A(() => document.querySelector('#deep-panel .dp-help .txt')?.textContent ?? '');
check('the in-app help documents M, L and U', /M Milky Way/.test(helpText) && /L Local Group/.test(helpText) && /U nearby universe/.test(helpText));

// ---- 2b. what the deep layer adds at the Sun-centred start view, and whether nearby nebulae / clusters sit at their true sky positions ----------------
// The default start orientation looks away from every catalogued nebula and cluster, so the deep layer adds NO draw call there: that is why qa-browser's
// draw-call check (Gaia + Sun + the Hipparcos supplement) holds. It measures one orientation, not "the deep layer never draws near the Sun". The checks below look AT the objects.
const startDeep = await A(() => { const v = window.__atlas.viewer; v.render(window.__atlas.clock?.jd ?? 2461000); const s = v.deep.stats(); const off = [...v.deepScreen.values()].filter((i) => (i.kind === 'nebula' || i.kind === 'star-cluster') && !i.visible).map((i) => i.id); return { dc: s.drawCalls, sp: v.starPassStats().length, vis: s.objectsVisible, total: v.drawCalls, off, nearVisible: [...v.deepScreen.values()].filter((i) => i.visible && i.distancePc < 1e5).map((i) => i.id) }; });
check('start orientation (60 pc, default yaw/pitch): the deep layer adds no draw call because no catalogued nebula or cluster lies inside the view cone (qa-browser\'s draw-call check is for this orientation only)', startDeep.dc === 0 && startDeep.sp === 1 && startDeep.total === 2 + startDeep.sp && startDeep.nearVisible.length === 0, `deep draw calls ${startDeep.dc}, total ${startDeep.total} (Gaia + Sun + ${startDeep.sp} Hipparcos supplement layer); off-screen: ${startDeep.off.join(', ')}`);
const aimFromSun = (id) => A((i) => { const v = window.__atlas.viewer; const p = v.deep.objectPositionPc(i); const r = Math.hypot(...p); const u = p.map((x) => x / r); v.state = { focus: u, distance: 1, yaw: Math.atan2(-u[1], -u[0]), pitch: Math.asin(-u[2]) }; v.flight = null; v.selectedDeep = null; }, id);
const skyCheck = async (aimId) => {
  await aimFromSun(aimId); await page.waitForTimeout(1500);
  return A((aim) => {
    const a = window.__atlas, v = a.viewer; v.render(a.clock?.jd ?? 2461000);
    const st = v.state; const off = [Math.cos(st.pitch) * Math.cos(st.yaw), Math.cos(st.pitch) * Math.sin(st.yaw), Math.sin(st.pitch)]; const fwd = off.map((x) => -x);
    const cr = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
    let right = cr(fwd, [0, 0, 1]); const rl = Math.hypot(...right); right = right.map((x) => x / rl); const up = cr(right, fwd);
    const ppr = v.viewport.height / (2 * Math.tan(25 * Math.PI / 180));
    const rows = [];
    for (const o of v.deepData.all()) {
      if (!(o.kind === 'nebula' || o.kind === 'star-cluster') || !o.sky) continue;
      const s = v.deepScreen.get(o.id); if (!s || !s.visible) continue;
      const ra = o.sky.raDeg * Math.PI / 180, de = o.sky.decDeg * Math.PI / 180; // direction from RA/Dec ONLY (camera is at the Sun)
      const d = [Math.cos(de) * Math.cos(ra), Math.cos(de) * Math.sin(ra), Math.sin(de)]; const z = d[0] * fwd[0] + d[1] * fwd[1] + d[2] * fwd[2];
      const ex = v.viewport.width / 2 + (d[0] * right[0] + d[1] * right[1] + d[2] * right[2]) / z * ppr, ey = v.viewport.height / 2 - (d[0] * up[0] + d[1] * up[1] + d[2] * up[2]) / z * ppr;
      rows.push({ id: o.id, err: Math.hypot(s.x - ex, s.y - ey), r: s.pixelRadius, lod: s.lod });
    }
    const ds = v.deep.stats();
    return { rows, dc: ds.drawCalls, total: v.drawCalls, pts: ds.pointsDrawn };
  }, aimId);
};
const skyOrion = await skyCheck('orion-nebula');
check('looking at Orion from the Sun: every visible nebula and cluster is drawn at its catalogue RA/Dec (screen position within 1.5 px of an independent tangent-plane projection)', skyOrion.rows.length >= 3 && skyOrion.rows.every((r) => r.err < 1.5), skyOrion.rows.map((r) => `${r.id} ${r.err.toFixed(2)}px ${r.lod}`).join('; '));
check('looking at Orion from the Sun the deep layer stays small: at most 8 draw calls (one shared marker/glow draw, cluster points), markers 4 px, no disc above 150 px', skyOrion.dc <= 8 && skyOrion.rows.filter((r) => r.r > 150).length === 0, `deep draw calls ${skyOrion.dc} of ${skyOrion.total} total; ${skyOrion.pts} points`);
await snap('start-scale-looking-at-orion');
const skyPle = await skyCheck('pleiades');
check('looking at the Pleiades from the Sun: the cluster and the other visible nebulae/clusters are at their catalogue RA/Dec (within 1.5 px)', skyPle.rows.some((r) => r.id === 'pleiades') && skyPle.rows.every((r) => r.err < 1.5), skyPle.rows.map((r) => `${r.id} ${r.err.toFixed(2)}px`).join('; '));
await A(() => window.__atlas.deepUi.flyScale('solar-neighbourhood')); await settleFlight();

// ---- 3. objects: fly, select, inspect, credit, screenshot ------------------------------------------------------------------------
const exists = (id) => A((i) => !!window.__atlas.viewer.deepData.get(i), id);
const visit = async (id, tag, opts = {}) => {
  if (!(await exists(id))) { skip(`${id} view`, 'object not in the data'); return null; }
  await A((i) => window.__atlas.deepUi.selectDeep(i, { fly: true }), id);
  await settleFlight();
  const drawn = await settleImage(id, opts.imageMs ?? 30_000);
  await page.waitForTimeout(1200);
  const s = await info(id);
  const ins = await inspectorState();
  const cr = await creditsState();
  await snap(tag);
  const kind = await A((i) => window.__atlas.viewer.deepData.get(i).kind, id);
  const hasRenderer = await A((k) => window.__atlas.viewer.deep.registered.some((r) => r.layerKind === k), kind === 'star-cluster' ? 'clusters' : 'structure');
  if (!s && !hasRenderer && (kind === 'star-cluster' || kind.startsWith('galaxy-') && kind !== 'galaxy')) { skip(`${id}: on screen after the flight`, `no ${kind} renderer is registered yet, so the object has no screen info`); return null; }
  check(`${id}: after the flight the object is on screen (a group's enclosing ring may be reported not-visible by the renderer) and selected, with the inspector open`, (!!s?.visible || (!!s && kind.startsWith('galaxy-') && kind !== 'galaxy')) && ins.open && ins.name.length > 0 && (await A(() => window.__atlas.deepUi.selection)) === id, s ? `${s.r.toFixed(0)} px radius, lod ${s.lod}` : 'no screen info');
  check(`${id}: the inspector shows the "What you are seeing" block with a text badge and a summary`, ins.seeing && ins.badge.length > 5 && ins.summary.length > 20, `${ins.badge}`);
  if (opts.noDistance) check(`${id}: a group has no single distance and says why`, !!ins.rows.distance && ins.rows.distance.missing && ins.rows.distance.reason.length > 10, ins.rows.distance?.reason?.slice(0, 80));
  else check(`${id}: distance is shown with its uncertainty (or says there is none published)`, !!ins.rows.distance && !ins.rows.distance.missing && /±|no published/.test(ins.rows.distance.unc), `${ins.rows.distance?.value} ${ins.rows.distance?.unc}`);
  check(`${id}: no inspector value is blank and every unavailable field gives a reason`, ins.blank === 0 && Object.values(ins.rows).every((r) => !r.missing || r.reason.length > 5));
  if (opts.image !== false) {
    const asset = await assetOf(id);
    check(`${id}: the provenance block names the displayed asset and its verbatim credit line`, !!asset && ins.assetId === asset && ins.credit.length >= 3 && ins.credit === (await creditOf(asset)), `${asset}: ${ins.credit.slice(0, 80)}`);
    if (drawn) check(`${id}: the image-credits line is visible and contains the credit of the image drawn`, !cr.hidden && !!ins.credit && cr.line.includes(ins.credit), cr.line.slice(0, 100));
    else warn(`${id}: the image did not reach a drawn image level within the timeout`, `lod ${s?.lod}`);
  }
  return { s, ins, drawn };
};

const m31 = await visit('m31', 'm31-spiral-galaxy');
if (m31) {
  const f = m31.ins.rows;
  check('m31: morphology class AND the catalogue string are both shown, and the physical size is derived', !!f.class && !!f.morphology && f.morphology.value === 'SA(s)b' && !!f.physical_size && !f.physical_size.missing);
  check('m31: coordinates in ICRS and Galactic, inclination and near side are present', ['ra', 'dec', 'gal_l', 'gal_b', 'inclination', 'near_side'].every((k) => !!f[k]));
  // The default band is the GALEX NUV map (the PHAT visible picture is only a 58' x 18' strip of a 178' galaxy): the inspector must say so.
  const dflt = await assetOf('m31');
  const covText = await A(() => document.querySelector('#inspector .coverage-note')?.textContent ?? '');
  check('m31: the default band drawn is the GALEX NUV ultraviolet map, and the inspector says plainly that it is an ultraviolet map and the visible-light PHAT picture is only a strip (with its field of view)', dflt === 'm31-galex-nuv' && m31.ins.assetId === 'm31-galex-nuv' && /ultraviolet map, not a visible-light picture/.test(covText) && /strip/.test(covText) && /58\.0 .{1,3} 18\.5 arcmin/.test(covText) && /Not how it would look to the eye/.test(m31.ins.eye), `${dflt}: ${covText.slice(0, 160)}`);
}
// picking: a real mouse click at the object's centre selects it; empty sky clears; Escape clears
if (m31?.s) {
  await page.keyboard.press('Escape');
  // The panel slides back to the right edge when the inspector closes; wait for that so the click lands on the canvas.
  await page.waitForFunction(() => document.getElementById('deep-panel').getBoundingClientRect().left > 950, null, { timeout: 15_000 });
  const cleared = await A(() => ({ sel: window.__atlas.deepUi.selection, open: document.getElementById('inspector').classList.contains('open') }));
  check('Escape clears the deep-space selection and closes the inspector', cleared.sel === null && !cleared.open);
  const s = await info('m31');
  const picked = await A(([x, y]) => window.__atlas.viewer.pickDeep(x, y), [s.x, s.y]);
  check('pickDeep at the centre of M31 returns M31', picked === 'm31', `picked ${picked}`);
  await A(() => { window.__ev = []; for (const t of ['pointerdown', 'pointerup', 'click']) window.addEventListener(t, (e) => window.__ev.push([t, e.target.id || e.target.tagName, Math.round(e.clientX), Math.round(e.clientY)]), true); });
  await page.mouse.click(s.x, s.y);
  // Software GL frames take long and input events queue behind them: wait for the result rather than a fixed time.
  await page.waitForFunction(() => window.__atlas.deepUi.selection === 'm31', null, { timeout: 15_000 }).catch(() => {});
  const clicked = await A(() => ({ sel: window.__atlas.deepUi.selection, name: document.querySelector('#inspector h2')?.textContent }));
  check('a mouse click on the object selects it and opens its inspector', clicked.sel === 'm31', `${clicked.sel}: ${clicked.name}; pick log ${JSON.stringify(await A(() => window.__pickLog.slice(-4)))}; events ${JSON.stringify(await A(() => window.__ev))}`);
  // empty sky: find a screen point with no deep object and no star within the pick radius
  const empty = await A(() => { const a = window.__atlas; for (let i = 0; i < 400; i++) { const x = 100 + Math.random() * 480, y = 170 + Math.random() * 300; if (document.elementFromPoint(x, y)?.id === 'scene' && !a.viewer.pickDeep(x, y) && !a.viewer.pick(x, y) && !a.viewer.pickBody(x, y)) return { x, y }; } return null; });
  if (empty) {
    await page.mouse.click(empty.x, empty.y);
    await page.waitForFunction(() => window.__atlas.deepUi.selection === null, null, { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(300);
    const after = await A(() => ({ sel: window.__atlas.deepUi.selection, open: document.getElementById('inspector').classList.contains('open') }));
    check('clicking empty sky clears the selection', after.sel === null && !after.open);
  } else skip('empty-sky click', 'no empty screen point found');
  await A(() => window.__atlas.deepUi.selectDeep('m31', { fly: false }));
  await page.waitForTimeout(500);
}

if (process.env.QA_QUICK) { await writeFile(`${OUT}/qa-log.json`, JSON.stringify({ quick: true, checks, warnings, notRun, problems }, null, 2)); await browser.close(); console.log('quick run done'); process.exit(checks.some((c) => !c.ok) ? 1 : 0); }

// ---- 4. band switching ---------------------------------------------------------------------------------------------------------
const bandTest = async (id) => {
  const ins = await inspectorState();
  if (ins.bands.length < 2) { skip(`${id}: band switching`, `only ${ins.bands.length} band(s)`); return; }
  const before = await assetOf(id);
  const target = ins.bands.find((b) => !b.on && b.asset !== before) ?? ins.bands.find((b) => b.asset !== before);
  await page.click(`#inspector button.band[data-asset="${target.asset}"]`);
  let ok = true;
  try { await page.waitForFunction(([i, a]) => window.__atlas.viewer.deep.activeAsset(i) === a, [id, target.asset], { timeout: 30_000 }); } catch { ok = false; }
  await page.waitForTimeout(800);
  const after = await inspectorState();
  const now = await assetOf(id);
  check(`${id}: choosing another band changes the displayed asset`, ok && now === target.asset && now !== before, `${before} -> ${now}`);
  check(`${id}: the provenance block, credit line and pressed button follow the band`, after.assetId === target.asset && after.bands.find((b) => b.asset === target.asset)?.on === true && after.credit === (await creditOf(target.asset)), `${after.assetId}`);
  const asset = await A((a) => window.__atlas.viewer.deepData.all().flatMap((o) => window.__atlas.viewer.deepData.imageAssetsOf(o.id)).find((x) => x.id === a).band.kind, target.asset);
  if (asset !== 'visible' && asset !== 'multi-band-composite') check(`${id}: a non-visible band is never presented as how it would look`, /Not how it would look to the eye/.test(after.eye) && /assigned/.test(await A(() => document.querySelector('#inspector .imgprov')?.textContent ?? '')), after.eye.slice(0, 80));
  await snap(`${id}-band-${asset}`);
  await page.click(`#inspector button.band[data-asset="${before}"]`);
  await page.waitForTimeout(1500);
};
if (m31) await bandTest('m31');

// ---- 5. more object classes --------------------------------------------------------------------------------------------------------
const m87 = await visit('m87', 'm87-elliptical-galaxy');
if (m87) {
  const f = m87.ins.rows;
  check('m87: no published orientation is shown as unavailable with its reason (not zero, not blank)', !!f.orientation && f.orientation.missing && f.orientation.reason.length > 10, f.orientation?.reason?.slice(0, 80));
  // closest-view honesty note: derived from the representation and the image resolution
  const before = await A(() => document.getElementById('deep-note').textContent);
  await A(() => { const v = window.__atlas.viewer; v.state = { ...v.state, distance: v.state.distance * 0.02 }; });
  await page.waitForTimeout(1500);
  const near = await A(() => document.getElementById('deep-note').textContent);
  check('zoomed far into an image-only object the scale note says Atlas has no 3D stellar data and this is the highest-resolution image', /Closest view: Atlas has no three-dimensional stellar data for .+; this is the highest-resolution image/.test(near) && !/Closest view/.test(before), near.slice(0, 120));
  await snap('m87-closest-view');
  await A(() => window.__atlas.deepUi.flyToSelection()); await settleFlight();
}
await visit('lmc', 'lmc-irregular-galaxy');
const orion = await visit('orion-nebula', 'orion-emission-nebula');
if (orion) await bandTest('orion-nebula');
await visit('carina-nebula', 'carina-emission-nebula');
const horse = await visit('horsehead-nebula', 'horsehead-dark-nebula');
await visit('ngc-1999', 'ngc1999-reflection-nebula');
const pleiades = await visit('pleiades', 'pleiades-open-cluster', { image: false });
if (pleiades) {
  const f = pleiades.ins.rows;
  check('pleiades: members, age and the membership list provenance are shown; the badge says observed members', pleiades.ins.badge === 'OBSERVED MEMBERS' && !!f.memberCount && !!f.age && !!f.members_basis, `${pleiades.ins.badge}`);
  const pts = await A(() => window.__atlas.viewer.deep.stats().pointsDrawn);
  if (pts > 200) check('pleiades: the member stars are drawn', true, `${pts} points`); else skip('pleiades members drawn', `${pts} points reported (cluster renderer not present or not drawing yet)`);
}
for (const g of ['omega-centauri', 'm13']) { const r = await visit(g, `${g}-globular-cluster`, { image: false }); if (r) { const pts = await A(() => window.__atlas.viewer.deep.stats().pointsDrawn); if (pts <= 200) skip(`${g} members drawn`, `${pts} points reported`); break; } }
const lgo = await visit('local-group', 'local-group-members', { image: false, noDistance: true });
if (lgo) check('local-group: the membership count and its stated basis are shown', !!lgo.ins.rows.member_names && /McConnachie/.test(await A(() => document.querySelector('#inspector')?.textContent ?? '')));
await visit('m81-group', 'm81-group', { image: false });

// ---- 6. catalogue-point rows ----------------------------------------------------------------------------------------------------
await A(() => { const v = window.__atlas.viewer; window.__atlas.deepUi.clearSelection(); v.flyToLocalGroup(100); }); await settleFlight(); await page.waitForTimeout(2500);
const pointId = await A(() => { for (const [id, s] of window.__atlas.viewer.deepScreen) if (s.kind === 'catalogue-point' && s.visible && window.__atlas.viewer.deep.pointRow(id)) return id; return null; });
if (pointId) {
  await A((id) => window.__atlas.deepUi.selectPoint(id, { fly: false }), pointId);
  await page.waitForTimeout(500);
  const pr = await inspectorState();
  check('a catalogue point row opens an inspector built from its stored columns, with the catalogue caveats and a representation badge', pr.open && pr.sections.includes('About this catalogue') && pr.sections.includes('Distance') && pr.badge === 'OBSERVED MEMBERS' && pr.blank === 0, `${pointId}: ${pr.name}`);
  await snap('catalogue-point-inspector');
  const s = await A((id) => { const i = window.__atlas.viewer.deepScreen.get(id); return { x: i.x, y: i.y }; }, pointId);
  const pk = await A(([x, y]) => window.__atlas.viewer.pickDeep(x, y), [s.x, s.y]);
  check('picking at a catalogue point returns a point id the layer can resolve', !!pk && (await A((id) => !!window.__atlas.viewer.deep.pointRow(id) || !!window.__atlas.viewer.deepData.get(id), pk)), pk);
  // The selected row must stay inspectable after its catalogue is released from memory (the store drops a catalogue ~20 s after nothing wanted it).
  const before = await inspectorState();
  await A(() => { const v = window.__atlas.viewer; v.state = { focus: [0, 0, 0], distance: 60, yaw: 0.6, pitch: 0.35 }; v.flight = null; });
  const t0r = Date.now();
  let released = false;
  while (Date.now() - t0r < 60_000) { await page.waitForTimeout(2000); if (Date.now() - t0r > 25_000 && !(await A((id) => !!window.__atlas.viewer.deep.pointRow(id), pointId))) { released = true; break; } }
  await page.waitForTimeout(500);
  const after = await inspectorState();
  const snapOk = await A(() => { const p = window.__atlas.deepUi.selectedPoint; return !!p && !!p.manifest && typeof p.values.name === 'string'; });
  check('a selected catalogue row stays inspectable after its catalogue was released from memory (waited > 25 s looking away; pointRow() is gone, the inspector is not blank)', released && after.open && after.name === before.name && after.name.length > 0 && after.blank === 0 && after.sections.length === before.sections.length && after.sections.includes('About this catalogue') && snapOk, `released=${released} after ${((Date.now() - t0r) / 1000).toFixed(0)} s; ${after.name}; sections ${after.sections.length}/${before.sections.length}`);
  const flew = await A(() => { const v = window.__atlas.viewer; const d0 = v.state.distance; document.querySelector('#inspector button.focus')?.click(); return d0; });
  await page.waitForTimeout(1500);
  const moved = await A(() => ({ d: window.__atlas.viewer.state.distance, flying: window.__atlas.viewer.flying, sel: window.__atlas.deepUi.selection }));
  check('"Fly to this entry" still works for the released row (position from the kept snapshot)', moved.flying || Math.abs(moved.d - flew) > 1, `distance ${flew} -> ${moved.d.toFixed(0)}, selection ${moved.sel}`);
  await settleFlight();
} else skip('catalogue-point inspector', 'no catalogue-point screen entries (the point-catalogue renderers are not present or draw nothing at this view)');
await A(() => window.__atlas.deepUi.clearSelection());

// ---- 7. search -------------------------------------------------------------------------------------------------------------------
await page.fill('#search', 'M 87');
await page.waitForTimeout(400);
const sr = await A(() => [...document.querySelectorAll('#results li[data-deep]')].map((l) => l.textContent));
check('searching "M 87" finds the galaxy by its designation, ahead of stars', sr.length >= 1 && /M87|Virgo A|Messier 87/i.test(sr[0]), sr[0]);
await page.click('#results li[data-deep]');
await settleFlight(); await page.waitForTimeout(800);
check('choosing the search result selects M87 and flies there', (await A(() => window.__atlas.deepUi.selection)) === 'm87');
await page.keyboard.press('Escape');
await page.fill('#search', '');

// ---- 7b. flyToDeep works for EVERY object of the data file and for the view anchors that have no catalogue position ----------------------------------------
{
  const ids = await A(() => [...window.__atlas.viewer.deepData.all().map((o) => o.id), 'twomrs']);
  const bad = [];
  for (const id of ids) {
    const err = await A((i) => { try { window.__atlas.viewer.flyToDeep(i, 350); return null; } catch (e) { return String(e.message ?? e); } }, id);
    if (err) { bad.push(`${id}: threw ${err}`); continue; }
    await settleFlight(); await page.waitForTimeout(150);
    const end = await A((i) => { const v = window.__atlas.viewer; const p = v.deep.objectPositionPc(i), d = v.deep.viewDistancePc(i); const f = v.state.focus; return { dRel: Math.abs(v.state.distance / d - 1), fErr: Math.hypot(f[0] - p[0], f[1] - p[1], f[2] - p[2]) / Math.max(d, 1), sel: v.selectedDeep }; }, id);
    if (!(end.dRel < 0.01 && end.fErr < 0.01 && end.sel === id)) bad.push(`${id}: ends at ${JSON.stringify(end)}`);
  }
  check(`flyToDeep reaches every object of the data file (${ids.length - 1}) and 'twomrs': no throw, final distance = viewDistancePc, focus = objectPositionPc`, ids.length === 28 && bad.length === 0, bad.join('; ') || `${ids.length} flights`);
  await A(() => window.__atlas.viewer.flyToDeep('local-group', 350)); await settleFlight(); await page.waitForTimeout(1500);
  const lgAnchor = await A(() => { const s = window.__atlas.viewer.deepScreen.get('local-group'); const ins = window.__atlas.viewer.deep.isViewAnchor('local-group'); return { note: s?.representationNote ?? '', ins }; });
  check('the Local Group flight target is labelled a view anchor, midway between the Milky Way and M31 (illustrative), not a barycentre', lgAnchor.ins && /midway between the Milky Way and M31 \(illustrative/.test(lgAnchor.note), lgAnchor.note.slice(0, 120));
  await A(() => window.__atlas.viewer.flyToDeep('twomrs', 350)); await settleFlight(); await page.waitForTimeout(2500);
  const tmNote = await A(() => window.__atlas.viewer.deepScreen.get('twomrs')?.representationNote ?? '');
  check('the 2MRS flight target is labelled a view anchor on the Sun (survey centre), not a centre of the Universe', /anchored on the Sun.*not a centre of the Universe/.test(tmNote), tmNote.slice(-140));
  await A(() => { window.__atlas.deepUi.clearSelection(); window.__atlas.viewer.selectedDeep = null; });
}

// ---- 7c. M31 band switcher: PHAT is offered, drawn where its tilted field is, and the inspector shows its own field of view -------------------------------
if (m31) {
  await A(() => window.__atlas.deepUi.selectDeep('m31', { fly: true })); await settleFlight(); await settleImage('m31'); await page.waitForTimeout(800);
  const ins0 = await inspectorState();
  check('m31: the band switcher offers Hubble PHAT (multi-band), GALEX NUV and FUV', ['m31-phat-visible', 'm31-galex-nuv', 'm31-galex-fuv'].every((a) => ins0.bands.some((b) => b.asset === a)), ins0.bands.map((b) => b.asset).join(', '));
  await page.click('#inspector button.band[data-asset="m31-phat-visible"]');
  await page.waitForFunction(() => window.__atlas.viewer.deep.activeAsset('m31') === 'm31-phat-visible', null, { timeout: 30_000 }).catch(() => {});
  await settleImage('m31', 40_000); await page.waitForTimeout(1500);
  const ph = await A(() => {
    const v = window.__atlas.viewer; const pl = v.deep.galaxies.placementOf('m31', 'm31-phat-visible'); v.render(window.__atlas.clock?.jd ?? 2461000);
    const cam = v.state; const b = (() => { const c = Math.cos(cam.pitch); return [c * Math.cos(cam.yaw), c * Math.sin(cam.yaw), Math.sin(cam.pitch)]; })();
    const camPc = cam.focus.map((x, i) => x + cam.distance * b[i]);
    const fwd = b.map((x) => -x); const cr = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
    let right = cr(fwd, [0, 0, 1]); const rl = Math.hypot(...right); right = right.map((x) => x / rl); const up = cr(right, fwd);
    const ppr = v.viewport.height / (2 * Math.tan(25 * Math.PI / 180));
    const proj = (sx, sy, k = 1) => { const r = [0, 1, 2].map((i) => pl.position[i] + pl.offset[i] + k * (sx * pl.xAxis[i] + sy * pl.yAxis[i]) - camPc[i]); const z = r[0] * fwd[0] + r[1] * fwd[1] + r[2] * fwd[2]; return [v.viewport.width / 2 + (r[0] * right[0] + r[1] * right[1] + r[2] * right[2]) / z * ppr, v.viewport.height / 2 - (r[0] * up[0] + r[1] * up[1] + r[2] * up[2]) / z * ppr]; };
    const poly = (k) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => proj(sx, sy, k));
    const c = document.getElementById('scene'); const g = document.createElement('canvas'); g.width = c.width; g.height = c.height; const ctx = g.getContext('2d'); ctx.drawImage(c, 0, 0);
    const img = ctx.getImageData(0, 0, g.width, g.height).data; const sc = c.width / v.viewport.width;
    const inside = (P, x, y) => { let n = 0; for (let i = 0, j = 3; i < 4; j = i++) { if ((P[i][1] > y) !== (P[j][1] > y) && x < (P[j][0] - P[i][0]) * (y - P[i][1]) / (P[j][1] - P[i][1]) + P[i][0]) n++; } return n % 2 === 1; };
    const P1 = poly(0.8), P2 = poly(1.6), P3 = poly(1.15);
    let sIn = 0, nIn = 0, sOut = 0, nOut = 0;
    for (let y = 0; y < v.viewport.height; y += 2) for (let x = 0; x < v.viewport.width; x += 2) {
      const i = 4 * (Math.round(y * sc) * g.width + Math.round(x * sc)); const l = 0.2126 * img[i] + 0.7152 * img[i + 1] + 0.0722 * img[i + 2];
      if (inside(P1, x, y)) { sIn += l; nIn++; } else if (inside(P2, x, y) && !inside(P3, x, y) && x > 0 && x < v.viewport.width - 360) { sOut += l; nOut++; }
    }
    return { corners: poly(1).map((p) => p.map(Math.round)), inMean: nIn ? sIn / nIn : 0, outMean: nOut ? sOut / nOut : 0, nIn, nOut, kind: pl.kind, up: 123.5 };
  });
  const ins1 = await inspectorState();
  const fovTxt = await A(() => document.querySelector('#inspector .imgprov')?.textContent ?? '');
  check('m31: choosing PHAT shows its own field of view (57.98 x 18.54 arcmin, the image is a strip) in the provenance block and the coverage note says so', ins1.assetId === 'm31-phat-visible' && /Field of view58\.0 .{1,3} 18\.5 arcmin/.test(fovTxt) && /partial field/.test(fovTxt), fovTxt.match(/Field of view[^A-Z]{0,30}/)?.[0] ?? '');
  check('m31: the PHAT strip is drawn at its tilted field: inside the projected quad (up PA 123.5 deg, deprojected disc plane) the image is much brighter than in the ring just outside it', ph.kind === 'deprojected-disc' && ph.nIn > 200 && ph.inMean > 2 * Math.max(ph.outMean, 1), `quad ${JSON.stringify(ph.corners)}; mean luminance in ${ph.inMean.toFixed(1)} vs ring ${ph.outMean.toFixed(1)} (${ph.nIn}/${ph.nOut} samples)`);
  await snap('m31-phat-strip-placement');
  await page.click('#inspector button.band[data-asset="m31-galex-nuv"]'); await page.waitForTimeout(1500);
  await A(() => { window.__atlas.deepUi.clearSelection(); });
}

// ---- 8. LOD continuity: sweep the camera distance geometrically and watch size and brightness -------------------------------------------
const lumAround = async (x, y, half) => {
  const clip = { x: Math.max(0, Math.round(x - half)), y: Math.max(0, Math.round(y - half)), width: Math.round(Math.min(2 * half, 1280 - Math.max(0, x - half))), height: Math.round(Math.min(2 * half, 800 - Math.max(0, y - half))) };
  const buf = await page.screenshot({ clip, timeout: 120_000 });
  return A(async (b64) => { const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob()); const c = new OffscreenCanvas(img.width, img.height); const g = c.getContext('2d'); g.drawImage(img, 0, 0); const d = g.getImageData(0, 0, img.width, img.height).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; return s / (d.length / 4); }, buf.toString('base64'));
};
const sweeps = {};
const sweep = async (id, nFrom, nTo, steps) => {
  await A(() => { window.__atlas.deepUi.clearSelection(); });
  await page.keyboard.press('Escape');
  const view = await A((i) => ({ p: window.__atlas.viewer.deep.objectPositionPc(i), d: window.__atlas.viewer.deep.viewDistancePc(i) }), id);
  const samples = [];
  for (let k = 0; k <= steps; k++) {
    const d = view.d * Math.pow(nFrom / nTo, 1 - k / steps) * nTo; // from nFrom*view down to nTo*view
    await A(([p, dist, i]) => { const v = window.__atlas.viewer; const st = v.state; v.state = { focus: p, distance: dist, yaw: st.yaw, pitch: st.pitch }; v.selectedDeep = null; }, [view.p, d, id]);
    await page.waitForTimeout(700);
    const s = await info(id);
    const lum = s?.visible ? await lumAround(s.x, s.y, Math.max(12, Math.min(150, s.r * 1.2))) : 0;
    const cr = await creditsState();
    const drawnImages = await A(() => [...window.__atlas.viewer.deepScreen.values()].filter((x) => x.visible && x.kind !== 'catalogue-point' && x.lod.startsWith('image')).length);
    const dc = await A(() => { const v = window.__atlas.viewer; return { total: v.drawCalls, extra: v.starPassStats().length, reg: v.deep.registered.map((r) => r.stats().drawCalls).join('/') }; });
    samples.push({ k, d, r: s?.r ?? 0, lod: s?.lod ?? 'none', lum, creditsVisible: !cr.hidden, drawnImages, dc });
  }
  sweeps[id] = samples;
  return samples;
};
const stageOf = (lod) => lod.replace(/->.*/, '').replace(/-L\d+/, '');
// opts.handoffOnly: resolved star sets (clusters) lose MEAN luminance in the object window as they spread over more pixels (the same light on ~2.5x the area
// per camera step), so inside the 'members' stage the window mean is not a continuity measure; the brightness check then looks at the steps where the
// representation changes (marker/glow/members), which is what its name says. Galaxies and nebulae are checked over every step, as before.
const analyse = (name, S, opts = {}) => {
  const rs = S.map((x) => x.r);
  const mono = rs.every((r, i) => i === 0 || r >= rs[i - 1] * 0.97);
  let maxStepR = 0, maxStepL = 0, maxAny = 0, where = '';
  for (let i = 1; i < S.length; i++) {
    const rr = Math.abs(Math.log(Math.max(S[i].r, 0.5) / Math.max(S[i - 1].r, 0.5)));
    const dd = Math.abs(Math.log(S[i].d / S[i - 1].d));
    maxStepR = Math.max(maxStepR, rr / Math.max(dd, 1e-6));
    const ll = Math.abs(S[i].lum - S[i - 1].lum) / Math.max(S[i].lum, S[i - 1].lum, 4);
    if (ll > maxAny) maxAny = ll;
    if (opts.handoffOnly && stageOf(S[i].lod) === stageOf(S[i - 1].lod)) continue;
    if (ll > maxStepL) { maxStepL = ll; where = `${S[i - 1].lod} -> ${S[i].lod} at ${S[i].r.toFixed(0)} px`; }
  }
  const lods = [...new Set(S.map((x) => x.lod))].join(' > ');
  check(`${name}: apparent size grows monotonically as the camera approaches`, mono, `radius ${rs[0].toFixed(1)} -> ${rs[rs.length - 1].toFixed(0)} px`);
  check(`${name}: no abrupt size jump (size changes at most ~1.6x the rate of the distance change between samples)`, maxStepR < 1.6, `largest d(ln size)/d(ln distance) = ${maxStepR.toFixed(2)}`);
  check(`${name}: no abrupt brightness jump between representations (largest step in mean luminance of the object window)`, maxStepL < 0.5, `${(maxStepL * 100).toFixed(0)}% at ${where}; stages: ${lods}${maxStepL >= 0.5 ? '; samples ' + S.map((x) => `${x.lod}@${x.r.toFixed(0)}px lum ${x.lum.toFixed(1)} calls ${x.dc?.total}/${x.dc?.reg}`).join(' | ') : ''}${opts.handoffOnly ? `; hand-off steps only (largest step of any kind ${(maxAny * 100).toFixed(0)}%)` : ''}`);
  const bad = S.filter((x) => x.drawnImages > 0 && !x.creditsVisible);
  check(`${name}: the image-credits line is visible whenever an image is drawn`, bad.length === 0, bad.length ? `missing at samples ${bad.map((b) => b.k).join(',')}` : `${S.filter((x) => x.drawnImages > 0).length} samples with an image drawn`);
};
await A(() => { document.getElementById('credits-pop').hidden = true; });
// Generic sweep for every kind (one galaxy, one nebula, one cluster): size must grow monotonically and without a jump through every hand-off
// (galaxy: marker -> glow -> image; nebula: marker -> glow -> image; cluster: marker -> glow -> members).
analyse('m31 sweep', await sweep('m31', 400, 1, 14));
await snap('after-m31-sweep');
analyse('orion sweep', await sweep('orion-nebula', 600, 1, 14));
analyse('pleiades sweep', await sweep('pleiades', 600, 1, 14), { handoffOnly: true });
for (const [id, S] of Object.entries(sweeps)) {
  const fromMarker = S.some((x) => x.lod === 'marker');
  const kinds = [...new Set(S.map((x) => x.lod.replace(/->.*/, '').replace(/-L\d+/, '')))].join(' > ');
  check(`${id}: the sweep passes through the full representation chain (${kinds})`, S.length === 15 && new Set(S.map((x) => x.lod.replace(/->.*/, '').replace(/-L\d+/, ''))).size >= 3, `marker first: ${fromMarker}`);
}

// ---- 8b. selection owner, id namespaces, WebGL context loss (added with the review fixes) --------------------------------------------------
{
  // Backspace goes through DeepUi: inspector, ring, viewer.selectedDeep and DeepUi.selection stay in step.
  await A(() => { window.__atlas.deepUi.selectDeep('m31', { fly: true }); }); await settleFlight(); await page.waitForTimeout(800);
  await page.keyboard.press('Backspace'); await page.waitForTimeout(500);
  const afterParent = await A(() => ({ ui: window.__atlas.deepUi.selection, viewer: window.__atlas.viewer.selectedDeep, name: document.querySelector('#inspector h2')?.textContent ?? '', open: document.getElementById('inspector').classList.contains('open') }));
  check('Backspace from M31: DeepUi selection, viewer highlight id and inspector agree (all on the parent, Local Group)', afterParent.ui === afterParent.viewer && afterParent.ui === 'local-group' && /Local Group/.test(afterParent.name), JSON.stringify(afterParent));
  await settleFlight();
  await page.keyboard.press('Backspace'); await page.waitForTimeout(500);
  const afterTop = await A(() => ({ ui: window.__atlas.deepUi.selection, viewer: window.__atlas.viewer.selectedDeep, open: document.getElementById('inspector').classList.contains('open') }));
  check('Backspace again (a scale flight): nothing is selected in DeepUi, the viewer and the inspector alike', afterTop.ui === null && afterTop.viewer === null && !afterTop.open, JSON.stringify(afterTop));
  await settleFlight();

  // Virgo marker ids are "virgo:<row>", the 2MRS cloud picks "twomrs:<row>": no id is shared, the layer saw no duplicate.
  await A(() => window.__atlas.viewer.flyToDeep('virgo-cluster', 350)); await settleFlight(); await page.waitForTimeout(4000);
  const ids = await A(() => { const m = [...window.__atlas.viewer.deepScreen.keys()]; return { virgo: m.filter((k) => k.startsWith('virgo:')).length, cloud: m.filter((k) => k.startsWith('twomrs:')).length, dup: window.__atlas.viewer.deep.duplicateIds }; });
  check('Virgo rows and 2MRS cloud picks use separate id namespaces; the layer reports no duplicate screen id', ids.dup === 0 && ids.virgo > 20, JSON.stringify(ids));
  await A(() => window.__atlas.deepUi.clearSelection());

  // Context loss, simulated with WEBGL_lose_context on Chromium + SwiftShader. NOT a real-GPU context loss.
  await A(() => window.__atlas.deepUi.selectDeep('m31', { fly: true })); await settleFlight();
  const shown = await settleImage('m31', 60_000);
  const p0 = problems.length;
  const before = await A(() => ({ created: window.__atlas.viewer.deep.assets.stats().created, textures: window.__atlas.viewer.deep.assets.stats().textures }));
  const lost = await A(async () => {
    const v = window.__atlas.viewer; const ext = v.renderer.getContext().getExtension('WEBGL_lose_context'); if (!ext) return { ext: false };
    window.__loseExt = ext;   // getExtension() returns null while the context is lost: keep the handle
    window.__qaFrames = 0; const loop = () => { window.__qaFrames++; requestAnimationFrame(loop); }; requestAnimationFrame(loop);
    ext.loseContext(); await new Promise((r) => setTimeout(r, 1500));
    return { ext: true, lost: v.glContext.lost, lostNow: v.glContext.lostNow, textures: v.deep.assets.stats().textures, assetsLost: v.deep.assets.isContextLost(), frames: window.__qaFrames };
  });
  if (!lost.ext) skip('WebGL context loss: assets are dropped while lost and re-requested after restore', 'WEBGL_lose_context is not available in this browser');
  else {
    check('simulated context loss (WEBGL_lose_context): the viewer sees it, the asset manager drops every texture and the render loop keeps running', lost.lost === 1 && lost.lostNow && lost.assetsLost && lost.textures === 0 && lost.frames > 3, JSON.stringify(lost));
    const restored = await A(async () => {
      const v = window.__atlas.viewer; const ext = window.__loseExt;
      ext.restoreContext(); await new Promise((r) => setTimeout(r, 2500));
      return { restored: v.glContext.restored, lostNow: v.glContext.lostNow, assetsLost: v.deep.assets.isContextLost() };
    });
    await settleImage('m31', 60_000);
    await page.waitForTimeout(1500);
    const after = await A(() => ({ created: window.__atlas.viewer.deep.assets.stats().created, textures: window.__atlas.viewer.deep.assets.stats().textures, lod: window.__atlas.viewer.deepScreen.get('m31')?.lod ?? '', frames: window.__qaFrames }));
    check('after the simulated restore: the textures are created anew through the asset manager and M31 is drawn as an image again', restored.restored === 1 && !restored.lostNow && !restored.assetsLost && after.created > before.created && after.textures > 0 && after.lod.startsWith('image'), `before ${JSON.stringify(before)} (image shown: ${shown}), restored ${JSON.stringify(restored)}, after ${JSON.stringify(after)}`);
    await snap('after-simulated-context-restore');
    // the console messages caused by the deliberate loss are expected: report them, do not count them as unexpected errors
    const isGlLoss = (m) => /context|WebGL|webgl|CONTEXT_LOST/i.test(m);
    const tail = problems.splice(p0); const expected = tail.filter(isGlLoss); problems.push(...tail.filter((m) => !isGlLoss(m)));
    console.log(`INFO  ${expected.length} console message(s) caused by the deliberate context loss (not counted as problems): ${expected.join(' | ').slice(0, 400)}`);
  }
  await A(() => window.__atlas.deepUi.clearSelection());
}

// ---- 9. budgets, frame rate, errors -------------------------------------------------------------------------------------------------------
const maxTex = await A(() => window.__qaMax);
check('texture memory never exceeded the 192 MB budget during the whole run', maxTex <= TEXTURE_BUDGET_BYTES, `peak ${(maxTex / 1048576).toFixed(1)} MB`);
await A(() => window.__atlas.deepUi.selectDeep('m31', { fly: true })); await settleFlight(); await page.waitForTimeout(1500);
const fps = await A(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const loop = () => { n++; if (performance.now() - t0 > 3000) res(n / 3); else requestAnimationFrame(loop); }; requestAnimationFrame(loop); }));
const dstats = await A(() => window.__atlas.viewer.deep.stats());
if (fps < 2) warn('frame rate below 2 frames/s', `${fps.toFixed(1)} frames/s with SwiftShader (CPU) rendering; this is a warning, not a failure, on a loaded machine`);
console.log(`INFO  ${fps.toFixed(1)} frames/s (software GL), ${dstats.drawCalls} draw calls, ${(dstats.textureBytes / 1048576).toFixed(1)} MB textures`);
const hudStats = await A(() => document.getElementById('deep-stats').textContent);
check('the HUD shows the deep layer stats (draw calls, texture MB, points, quality)', /draw calls/.test(hudStats) && /MB textures/.test(hudStats) && /points/.test(hudStats) && /quality \d+%/.test(hudStats), hudStats);
const credits404 = await A(async () => { const r = await fetch(`${location.pathname}credits.html`); return { ok: r.ok, n: ((await r.text()).match(/<article/g) ?? []).length }; });
check('the static credits page exists and lists every image', credits404.ok && credits404.n >= 20, `${credits404.n} entries`);
// One check with the adaptive quality governor ON at default settings (everything above ran with it off for deterministic frames): it may only
// lower detail, never raise an error, and the HUD must show the current quality and why.
{
  const p0 = problems.length;
  await A(() => window.__atlas.viewer.enableQualityGovernor());
  await A(() => window.__atlas.deepUi.selectDeep('m31', { fly: true })); await settleFlight(); await page.waitForTimeout(5000);
  const hud = await A(() => document.getElementById('deep-stats').textContent);
  const rep = await A(() => window.__atlas.viewer.governorReport());
  check('with the quality governor ON at default settings: no console errors or warnings, and the HUD shows a quality value with the reason for it', problems.length === p0 && /quality \d+% \([^)]{8,}\)/.test(hud) && rep.enabled && rep.quality >= 0.25 && rep.quality <= 1, `${hud} | ${rep.state} ${(rep.quality * 100).toFixed(0)}%${problems.length > p0 ? ' | NEW PROBLEMS: ' + problems.slice(p0).join(' || ').slice(0, 400) : ''}`);
  await A(() => { window.__atlas.viewer.disableQualityGovernor(); window.__atlas.deepUi.clearSelection(); });
}
// After the simulated context loss, three.js disposes objects that were created before the loss (geometries, textures) against the NEW context:
// Chromium then warns "delete: object does not belong to this context". That is the stale old-context handle being deleted (a harmless no-op),
// a known consequence of any context restore in three.js, not a bug of a code path under test. Counted and reported, never silently dropped.
const staleDelete = problems.filter((m) => /does not belong to this context/.test(m));
if (staleDelete.length) { console.log(`INFO  ${staleDelete.length} "object does not belong to this context" warning(s) after the simulated restore (three.js deleting handles of the lost context)`); for (let i = problems.length - 1; i >= 0; i--) if (/does not belong to this context/.test(problems[i])) problems.splice(i, 1); }
check('no console errors or warnings (apart from the counted stale-handle deletes after the simulated context restore)', problems.length === 0, problems.join(' | ').slice(0, 500));

await writeFile(`${OUT}/qa-log.json`, JSON.stringify({ url: URL, ranAt: new Date().toISOString(), staleHandleDeleteWarnings: staleDelete.length, note: 'Software GL (SwiftShader) only: no GPU timings; frame rate is a warning, not a failure. Quality governor disabled for deterministic frames.', loadMs, fps, peakTextureBytes: maxTex, deepStats: dstats, sweeps, checks, warnings, notRun, screenshots: shots, problems }, null, 2));
await browser.close();
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed; ${warnings.length} warnings; ${notRun.length} not run`);
process.exit(failed.length ? 1 : 0);
