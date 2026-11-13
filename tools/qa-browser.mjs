// Real-browser QA for the star field (visual/interaction checks; the unit tests cover the maths).
// Needs: `npm run build && npx vite preview --port 4173` and Playwright (see PLAYWRIGHT_MODULE_DIR below).
// Writes screenshots and qa-log.json to docs/qa/. Exits non-zero if any check fails.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
// Playwright is not a project dependency. Point PLAYWRIGHT_MODULE_DIR at a directory whose node_modules
// contains it (browsers are expected in ~/.cache/ms-playwright), or install it locally.
const require = createRequire((process.env.PLAYWRIGHT_MODULE_DIR ?? process.cwd()) + '/');
const { chromium } = require('playwright');

const URL = process.env.ATLAS_URL ?? 'http://127.0.0.1:4173/';
const OUT = 'docs/qa';
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const problems = [];
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url()}`); });
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const t0 = Date.now();
await page.goto(URL);
await page.waitForFunction(() => window.__atlas?.layer, null, { timeout: 60_000 });
const loadMs = Date.now() - t0;
await page.waitForTimeout(600);

const frameStats = () => page.evaluate(() => {
  const a = window.__atlas.viewer; a.render();
  const c = document.getElementById('scene');
  const g = document.createElement('canvas'); g.width = c.width; g.height = c.height;
  const ctx = g.getContext('2d'); ctx.drawImage(c, 0, 0);
  const d = ctx.getImageData(0, 0, g.width, g.height).data;
  let lit = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) lit++;
  return { lit, distancePc: a.state.distance, calls: a.drawCalls, mag: a.brightness.magLimit, extraLayers: a.starPassStats().length };
});
const snap = async (name) => {
  // The inspector slides in with a CSS transition on the same (software-GL-loaded) main thread: wait for it to finish.
  await page.waitForFunction(() => {
    const i = document.getElementById('inspector');
    if (!i.classList.contains('open')) return true;
    const t = getComputedStyle(i).transform;
    return t === 'none' || t === 'matrix(1, 0, 0, 1, 0, 0)';
  }, null, { timeout: 15_000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}.png` });
};
const settle = async () => { await page.waitForFunction(() => !window.__atlas.viewer.flying, null, { timeout: 10_000 }); await page.waitForTimeout(250); };

// 0. Frame rate, measured first on a fresh page. (frameStats() below allocates a full-size 2D canvas and reads pixels
// back, which would pollute a later measurement.) Software GL (SwiftShader) is CPU-bound and noisy: 4 to 11 frames/s
// were observed across runs on this machine, so this is only a "not frozen" floor, not a performance claim.
const fps = await page.evaluate(() => new Promise((res) => {
  let n = 0; const t0 = performance.now();
  const loop = () => { n++; if (performance.now() - t0 > 3000) res(n / 3); else requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
}));
check('page keeps rendering (software GL, so only a floor)', fps > 2, `${fps.toFixed(1)} frames/s with SwiftShader (CPU) rendering; no GPU timings exist`);

// 1. Startup state
const s0 = await frameStats();
await snap('01-initial-60pc');
const hudText = await page.textContent('#ds-line');
const layerInfo = await page.evaluate(() => ({ n: window.__atlas.layer.count, cat: window.__atlas.cat.count, sk: window.__atlas.layer.skipped }));
check('dataset loads from local files', layerInfo.n > 30000, `${layerInfo.n} drawn of ${layerInfo.cat}; load ${loadMs} ms`);
check('HUD reports counts that match the layer', hudText.includes(layerInfo.n.toLocaleString('en-US')) && hudText.includes(layerInfo.cat.toLocaleString('en-US')), hudText);
check('stars are visible on the canvas', s0.lit > 1500, `${s0.lit} lit pixels`);
// Expectation updated (F1): the Hipparcos bright-star supplement (Sirius, Betelgeuse ... which the Gaia subset cannot show) is now a real star-pass layer with its own
// single draw call, so the start view is: Gaia field + Sun marker + one supplement layer = 3. The discovery marker meshes (highlights, other objects, hosts) must add NONE.
check('draw calls at the start view: star field + Sun marker + one per extra star-pass layer (the Hipparcos supplement); no marker mesh adds one', s0.extraLayers === 1 && s0.calls === 2 + s0.extraLayers, `calls=${s0.calls}, extra star-pass layers=${s0.extraLayers}`);

// 2. Astrometry end to end: aim the camera at Proxima's catalogue direction; it must land at screen centre.
const aim = await page.evaluate(() => {
  const { cat, layer, viewer } = window.__atlas;
  const i = cat.indexOf('5853498713190525696'); // Proxima Centauri
  const k = [...layer.catalogueIndex].indexOf(i);
  const p = layer.positionPc.subarray(3 * k, 3 * k + 3);
  const d = Math.hypot(p[0], p[1], p[2]); const u = [p[0] / d, p[1] / d, p[2] / d];
  viewer.state = { focus: [0, 0, 0], distance: 1e-3, yaw: Math.atan2(-u[1], -u[0]), pitch: Math.asin(-u[2]) };
  viewer.render(window.__atlas.clock.jd);
  const s = viewer.screenOf(k);
  return { s, vp: viewer.viewport, d };
});
const off = Math.hypot(aim.s.x - aim.vp.width / 2, aim.s.y - aim.vp.height / 2);
check('catalogue RA/Dec direction maps to the right place on screen', off < 1.5, `Proxima centred within ${off.toFixed(3)} px (distance ${aim.d.toFixed(3)} pc)`);

// 3. Click-to-select with a real mouse click on a known star (Barnard's Star), then verify the metadata.
await page.evaluate(() => {
  const { cat, layer, viewer } = window.__atlas;
  const k = [...layer.catalogueIndex].indexOf(cat.indexOf('4472832130942575872'));
  const p = layer.positionPc.subarray(3 * k, 3 * k + 3);
  viewer.state = { focus: [p[0], p[1], p[2]], distance: 4, yaw: 0.7, pitch: 0.4 };
  viewer.setMagLimit(14);
  viewer.render(window.__atlas.clock.jd);
});
await page.waitForTimeout(300);
const click = await page.evaluate(() => {
  const { cat, layer, viewer } = window.__atlas;
  const k = [...layer.catalogueIndex].indexOf(cat.indexOf('4472832130942575872'));
  viewer.render(window.__atlas.clock.jd);
  return { k, s: viewer.screenOf(k) };
});
await page.mouse.click(click.s.x, click.s.y);
await page.waitForSelector('#inspector.open', { timeout: 5000 });
await snap('02-selected-barnards-star');
const insp = await page.evaluate(() => ({
  name: document.querySelector('#inspector h2')?.textContent,
  ids: [...document.querySelectorAll('#inspector ul.ids li')].map((l) => l.textContent),
  rows: Object.fromEntries([...document.querySelectorAll('#inspector .row')].map((r) => [r.dataset.key, r.textContent])),
  prov: document.querySelector('#inspector .prov')?.textContent,
  selectedCatalogueId: window.__atlas.cat.sourceId(window.__atlas.selected), // `selected` is a catalogue row
}));
check('click selected the intended star', insp.selectedCatalogueId === '4472832130942575872', insp.selectedCatalogueId);
check("inspector shows the star's identity", insp.ids.includes('Gaia DR3 4472832130942575872') && /Barnard/.test(insp.name + insp.ids.join()), `${insp.name} | ${insp.ids.slice(0, 3).join(' | ')}`);
check('inspector parallax matches the catalogue value', /546\.9/.test(insp.rows.parallax ?? ''), insp.rows.parallax);
check('inspector distance matches 1000/parallax', /1\.82/.test(insp.rows.distance ?? ''), insp.rows.distance);
check('inspector carries provenance (catalogue, release, SIMBAD)', /gaia-dr3/.test(insp.prov) && /DR3/.test(insp.prov) && /simbad/i.test(insp.prov), insp.prov?.slice(0, 120));
check('selection ring is shown on the star', (await page.evaluate(() => getComputedStyle(document.getElementById('ring')).display)) === 'block');

// 4. A catalogued star with no parallax cannot be drawn, but it must be findable and must read "Unavailable".
await page.keyboard.press('Escape');
await page.fill('#search', 'Alnair');
await page.waitForSelector('#results li');
const resultText = await page.textContent('#results li');
await page.click('#results li');
await page.waitForSelector('#inspector.open');
await snap('03-search-no-parallax-alnair');
const missing = await page.evaluate(() => ({
  name: document.querySelector('#inspector h2')?.textContent,
  parallax: document.querySelector('#inspector .row[data-key="parallax"]')?.textContent,
  distance: document.querySelector('#inspector .row[data-key="distance"]')?.textContent,
  flags: [...document.querySelectorAll('#inspector .flag b')].map((b) => b.textContent),
  notDrawn: document.querySelector('#inspector')?.textContent.includes('Not shown in 3D'),
  focusBtn: !!document.querySelector('#inspector button.focus'),
  ring: getComputedStyle(document.getElementById('ring')).display,
}));
check('search finds a record that is not drawn', /Alnair/i.test(resultText), resultText);
check('missing parallax is shown as Unavailable with a reason (not blank, not 0)', /Unavailable/.test(missing.parallax) && /No parallax/.test(missing.parallax), missing.parallax);
check('no distance is shown for a star without parallax', /Unavailable/.test(missing.distance), missing.distance);
check('the quality flag is shown', missing.flags.includes('no-parallax'), missing.flags.join(','));
check('the inspector says it is not drawn and offers no "centre view"', missing.notDrawn && !missing.focusBtn && missing.ring === 'none');
await page.keyboard.press('Escape');

// 5. Zoom with the mouse wheel; scale and brightness respond sensibly.
await page.keyboard.press('Escape');
await page.keyboard.press('h');
await settle();
const zoomed = [];
const wheelSteps = async (n, dy) => { for (let i = 0; i < n; i++) await page.mouse.wheel(0, dy); await page.waitForTimeout(200); };
const record = async (label) => zoomed.push({ label, ...(await frameStats()) });
await record('start');
await wheelSteps(3, 100); await record('out1');
await wheelSteps(3, 100); await record('out2');
await wheelSteps(6, 100); await record('out3');
await wheelSteps(3, -100); await record('in1');
console.log('zoom steps:', JSON.stringify(zoomed.map((z) => [z.label, +z.distancePc.toFixed(1), z.lit])));
const [z0, z1, z2, z3, z4] = zoomed;
check('wheel zoom out increases distance, zoom in decreases it', z0.distancePc < z1.distancePc && z1.distancePc < z2.distancePc && z2.distancePc < z3.distancePc && z4.distancePc < z3.distancePc);
check('equal scroll gives an equal zoom factor (logarithmic, not linear)', Math.abs(z1.distancePc / z0.distancePc / (z2.distancePc / z1.distancePc) - 1) < 0.02, `${(z1.distancePc / z0.distancePc).toFixed(3)} vs ${(z2.distancePc / z1.distancePc).toFixed(3)}`);
check('three notches in undoes exactly one three-notch step out (predictable)', Math.abs((z4.distancePc * (z1.distancePc / z0.distancePc)) / z3.distancePc - 1) < 0.01, `${z3.distancePc.toFixed(1)} -> ${z4.distancePc.toFixed(1)}`);
await snap('04-zoomed-out');

// 6. Brightness mapping: raising the limiting magnitude reveals more stars, monotonically.
await page.keyboard.press('h'); await settle();
const lits = [];
for (const m of [5, 7.5, 10, 13]) { await page.evaluate((v) => window.__atlas.viewer.setMagLimit(v), m); await page.waitForTimeout(150); lits.push((await frameStats()).lit); }
console.log('lit pixels vs limiting magnitude [5,7.5,10,13]:', lits.join(', '));
check('a fainter limiting magnitude shows more stars (monotonic)', lits[0] < lits[1] && lits[1] < lits[2] && lits[2] <= lits[3] + 5);
await snap('05-faint-limit-13');

// 6b. Suspect-star toggle: hides RUWE>1.4 stars, reduces what is drawn, and they cannot then be picked.
await page.evaluate(() => window.__atlas.viewer.setMagLimit(10));
const withSuspect = (await frameStats()).lit;
await page.check('#hide-suspect');
await page.waitForTimeout(200);
const withoutSuspect = (await frameStats()).lit;
const suspectInfo = await page.evaluate(() => ({ n: window.__atlas.layer.suspectCount, total: window.__atlas.layer.count, label: document.getElementById('suspect-count').textContent }));
check('hiding suspect stars removes some points', withoutSuspect < withSuspect, `${withSuspect} -> ${withoutSuspect} lit pixels`);
check('the toggle reports how many stars it covers', suspectInfo.label.includes(suspectInfo.n.toLocaleString('en-US')), suspectInfo.label);
await page.uncheck('#hide-suspect');

// 7. Keyboard and UI buttons, and responsiveness.
await page.evaluate(() => window.__atlas.viewer.setMagLimit(7.5));
const before = await page.evaluate(() => window.__atlas.viewer.state.yaw);
await page.keyboard.press('ArrowLeft');
const after = await page.evaluate(() => window.__atlas.viewer.state.yaw);
check('keyboard rotates the camera', after !== before);
await page.click('#btn-reset'); await settle();
check('reset orientation returns to the default orientation', await page.evaluate(() => Math.abs(window.__atlas.viewer.state.yaw - 0.6) < 1e-6));
check('no console errors or warnings', problems.length === 0, problems.join(' | '));

await writeFile(`${OUT}/qa-log.json`, JSON.stringify({ url: URL, loadMs, checks, zoomed, litVsMagLimit: lits, problems }, null, 2));
await browser.close();
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
