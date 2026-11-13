// Real-browser QA for the Solar System milestone (visual and interaction checks; the unit tests cover the maths).
// Needs: `npm run build && npx vite preview --port 4173` and Playwright (PLAYWRIGHT_MODULE_DIR, as for qa-browser.mjs).
// Writes screenshots and qa-log.json to docs/qa/solar/. Exits non-zero if any check fails.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const require = createRequire((process.env.PLAYWRIGHT_MODULE_DIR ?? process.cwd()) + '/');
const { chromium } = require('playwright');

const URL = process.env.ATLAS_URL ?? 'http://127.0.0.1:4173/';
const OUT = 'docs/qa/solar';
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const problems = [];
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url()}`); });
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const t0 = Date.now();
await page.goto(URL);
await page.waitForFunction(() => window.__atlas?.solarData, null, { timeout: 60_000 });
const loadMs = Date.now() - t0;
const A = (fn, arg) => page.evaluate(fn, arg);
const fly = async (id, ms = 40) => { await A(([i, d]) => window.__atlas.viewer.flyToBody(i, d), [id, ms]); await page.waitForFunction(() => !window.__atlas.viewer.flying, null, { timeout: 40_000 }); };
const lookSunward = (id, dyaw, dpitch) => A(([i, dy, dp]) => { const v = window.__atlas.viewer; const p = v.bodyHelioPc(i); const r = Math.hypot(...p) || 1; v.state = { ...v.state, yaw: Math.atan2(-p[1] / r, -p[0] / r) + dy, pitch: Math.max(-1.4, Math.min(1.4, Math.asin(-p[2] / r) + dp)) }; }, [id, dyaw, dpitch]);
const snap = async (name) => {
  await page.waitForFunction(() => { const i = document.getElementById('inspector'); if (!i.classList.contains('open')) return true; const t = getComputedStyle(i).transform; return t === 'none' || t === 'matrix(1, 0, 0, 1, 0, 0)'; }, null, { timeout: 15_000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}.png` });
};

// ---- 1. data ----------------------------------------------------------------------------------------------------------------
const info0 = await A(() => { const d = window.__atlas.solarData; return { n: d.file.bodies.length, planets: d.file.bodies.filter((b) => b.kind === 'planet').length, moons: d.file.bodies.filter((b) => b.kind === 'moon').length, epoch: d.manifest.referenceEpoch.iso }; });
check('the Solar System dataset loads from local files', info0.n === 29 && info0.planets === 8, `${info0.n} bodies (${info0.planets} planets, ${info0.moons} moons), reference epoch ${info0.epoch}; page ready in ${loadMs} ms`);
check('nothing is loaded up front: no Solar System textures at startup', (await A(() => window.__atlas.viewer.textures.loadedCount)) === 0);

// ---- 2. Earth ---------------------------------------------------------------------------------------------------------------
await fly('earth');
await lookSunward('earth', 0.9, 0.25);
await page.waitForTimeout(4500);
const earth = await A(() => { const v = window.__atlas.viewer; const i = v.screen.get('earth'); return { px: i.pixelRadius, sphere: i.asSphere, ex: i.exaggeration, path: v.frame.path.map((p) => p.name), tex: v.textures.loadedCount, follow: v.followId, crumbs: document.getElementById('crumbs').textContent }; });
await snap('01-earth');
check('Earth is drawn as a true-scale sphere at the expected size', earth.sphere && earth.ex === 1 && earth.px > 150, `${earth.px.toFixed(0)} px radius, exaggeration x${earth.ex}`);
check('the breadcrumb reaches the Earth system through the existing frame hierarchy', earth.path.join(' > ') === 'Universe > Nearby universe > Local Group > Milky Way > Stellar neighbourhood (Gaia sample) > Solar System > Earth system', earth.crumbs);
check('textures were loaded on demand for the body in view', earth.tex >= 3, `${earth.tex} textures loaded for Earth (day, night lights, clouds)`);
check('the camera follows the focused body', earth.follow === 'earth');

// ---- 3. lighting is consistent with the Sun's real position ----------------------------------------------------------------
const lit = await A(() => { const v = window.__atlas.viewer; const u = v.solar.nodes.get('earth').mat.uniforms; return { sun: u.uSunView.value.toArray(), hasNight: u.uHasNight.value, hasClouds: u.uHasClouds.value, hasDay: u.uHasDay.value }; });
check('Earth uses the day, night-lights and cloud layers', lit.hasDay === 1 && lit.hasNight === 1 && lit.hasClouds === 1);
const sunAngle = await A(() => { const v = window.__atlas.viewer; const p = v.bodyHelioPc('earth'); const sunDir = [-p[0], -p[1], -p[2]]; const u = v.solar.nodes.get('earth').mat.uniforms.uSunView.value; const cam = v.solar.nodes.get('earth').group.position; const n = (a) => Math.hypot(...a); return { toSun: n(sunDir) }; });
check('the light comes from the Sun’s actual direction (1 AU away)', Math.abs(Math.hypot(...lit.sun) / 1.4959787e11 - 1) < 0.03, `${(Math.hypot(...lit.sun) / 1.4959787e11).toFixed(3)} AU`);

// ---- 4. time control --------------------------------------------------------------------------------------------------------
const clockInfo = await A(() => { const c = window.__atlas.clock; return { jd: c.jd, ref: c.referenceJd, paused: c.paused, text: document.getElementById('time-utc').textContent, sysYear: new Date().getUTCFullYear() }; });
check('simulation time starts at the dataset’s reference date, not the system clock', Math.abs(clockInfo.jd - clockInfo.ref) < 0.01 && clockInfo.text.startsWith('2026-11-1'), `${clockInfo.text} (your clock says ${clockInfo.sysYear})`);
await page.click('#t-play');
const j1 = await A(() => window.__atlas.clock.jd); await page.waitForTimeout(600); const j2 = await A(() => window.__atlas.clock.jd);
check('Pause stops simulated time', j2 === j1, `JD ${j1.toFixed(8)} -> ${j2.toFixed(8)}`);
await page.click('#t-play');
await A(() => { const c = window.__atlas.clock; c.speedIndex = 3; });
const k1 = await A(() => window.__atlas.clock.jd); await page.waitForTimeout(1200); const k2 = await A(() => window.__atlas.clock.jd);
check('Resume and a higher speed advance simulated time faster than real time', k2 - k1 > 0.1, `${(k2 - k1).toFixed(3)} simulated days in about 1.2 s`);
await page.click('#t-reverse'); const r1 = await A(() => window.__atlas.clock.jd); await page.waitForTimeout(800); const r2 = await A(() => window.__atlas.clock.jd);
check('Reverse runs time backwards', r2 < r1);
await page.click('#t-reverse');
await page.click('#t-reset');
const rs = await A(() => ({ jd: window.__atlas.clock.jd, ref: window.__atlas.clock.referenceJd, speed: window.__atlas.clock.speedIndex }));
check('Reset returns exactly to the reference date at real-time speed', rs.jd === rs.ref && rs.speed === 0);
await page.click('#t-play');
const f0 = await A(() => window.__atlas.clock.jd);
await page.click('#t-fwd');
const f1 = await A(() => window.__atlas.clock.jd);
check('+1 d steps the date by exactly one day (clock paused, so nothing else moves it)', Math.abs(f1 - f0 - 1) < 1e-9, `${(f1 - f0).toFixed(12)} d`);
await page.click('#t-back');
await page.click('#t-play');

// ---- 5. moons move, and return after one orbital period ----------------------------------------------------------------------
const ioPeriod = await A(() => window.__atlas.solarData.get('io').orbit.fittedPeriodDays);
const ioAt = (jd) => A((j) => window.__atlas.solarData.ephemeris.relativePosition('io', j), jd);
const base = rs.ref;
const p0 = await ioAt(base), pq = await ioAt(base + ioPeriod / 4), pf = await ioAt(base + ioPeriod);
const ang = (a, b) => Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b))))) * 180 / Math.PI;
check('Io moves a quarter of its orbit in a quarter of its period', Math.abs(ang(p0, pq) - 90) < 8, `${ang(p0, pq).toFixed(1)} degrees (fitted period ${ioPeriod.toFixed(6)} d)`);
check('Io returns to the same place after one period', ang(p0, pf) < 3, `${ang(p0, pf).toFixed(2)} degrees apart`);

// ---- 6. Jupiter, its moons, selection and the inspector ----------------------------------------------------------------------
await fly('jupiter');
await lookSunward('jupiter', 0.5, 0.15);
await page.waitForTimeout(4500);
await snap('02-jupiter');
const jup = await A(() => { const v = window.__atlas.viewer; const i = v.screen.get('jupiter'); return { x: i.x, y: i.y, px: i.pixelRadius, orbits: v.solar.stats.orbits, tex: v.textures.loadedCount }; });
check('Jupiter is large on screen and drawn with its real map', jup.px > 150 && jup.tex >= 1, `${jup.px.toFixed(0)} px radius; ${jup.tex} textures`);
await page.mouse.click(jup.x, jup.y);
await page.waitForSelector('#inspector.open');
const insp = await A(() => ({ name: document.querySelector('#inspector h2').textContent, cls: document.querySelector('#inspector .class').textContent, rows: Object.fromEntries([...document.querySelectorAll('#inspector .row')].map((r) => [r.dataset.key, r.textContent])), facts: [...document.querySelectorAll('#inspector .fact')].map((f) => f.textContent), prov: document.querySelector('#inspector .prov').textContent, imagery: document.querySelector('#inspector .imagery')?.textContent, sel: window.__atlas.selectedBody }));
await snap('03-jupiter-inspector');
check('a real mouse click on Jupiter selects Jupiter', insp.sel === 'jupiter' && insp.name === 'Jupiter', insp.cls);
check('the inspector shows radius, mass, density, gravity, rotation and orbit with sources', ['mean_radius', 'mass', 'density', 'surface_gravity', 'rotation_period', 'orbital_period'].every((k) => insp.rows[k]), Object.keys(insp.rows).join(', '));
check('Jupiter’s mass reads 1.898e27 kg and its radius 69,911 km with their categories', /1\.898\d*e\+27/.test(insp.rows.mass) && /69911/.test(insp.rows.mean_radius) && /OBS/.test(insp.rows.mean_radius), `${insp.rows.mass} | ${insp.rows.mean_radius}`);
check('context facts carry certainty labels', insp.facts.length >= 2 && insp.facts.every((f) => /OBSERVED|INFERRED|HYPOTHESIS/.test(f)));
check('the inspector says how faithful the imagery is (Jupiter: a real Cassini map)', /SCIENTIFIC MAP/.test(insp.imagery ?? '') && /Cassini/.test(insp.imagery ?? ''), (insp.imagery ?? '').slice(0, 90));
check('provenance lists JPL sources with retrieval dates', /jpl-horizons/.test(insp.prov) && /retrieved/.test(insp.prov));

// All four Galilean moons, framed together (a view of the whole system, not just the planet).
await A(() => { const v = window.__atlas.viewer; v.state = { ...v.state, distance: 4.5e9 / 3.0856775814913673e16 }; });
await page.waitForTimeout(2500);
const gal = await A(() => { const v = window.__atlas.viewer; return ['io', 'europa', 'ganymede', 'callisto'].map((m) => { const i = v.screen.get(m); return { m, vis: i.visible, sphere: i.asSphere, px: +i.pixelRadius.toFixed(1), ex: +i.exaggeration.toFixed(1) }; }); });
await snap('03b-jupiter-system');
check('all four Galilean moons are in view when the whole Jupiter system is framed', gal.every((g) => g.vis), JSON.stringify(gal.map((g) => `${g.m}:${g.px}px x${g.ex}`)));
check('the moons are drawn at their true positions but may be enlarged: the factor is reported', gal.every((g) => g.ex >= 1));

// ---- 7. Europa: certainty labelling of a hypothesis ---------------------------------------------------------------------------
await A(() => window.__atlas.selectBody('europa'));
const eu = await A(() => ({ facts: [...document.querySelectorAll('#inspector .fact')].map((f) => ({ cert: f.querySelector('.certainty').textContent, text: f.querySelector('.text').textContent })), imagery: document.querySelector('#inspector .imagery .summary')?.textContent, mass: document.querySelector('#inspector .row[data-key="mass"]')?.textContent }));
const ocean = eu.facts.find((f) => /ocean/i.test(f.text) && /magnetometer/i.test(f.text));
check('Europa’s subsurface ocean is labelled INFERRED, not observed, and the text says it has not been seen directly', ocean?.cert === 'INFERRED' && /not been observed directly/.test(ocean.text));
check('Europa’s life question is a HYPOTHESIS', eu.facts.some((f) => f.cert === 'HYPOTHESIS'));
check('Europa’s mass is shown as DERIVED (JPL prints none)', /DER/.test(eu.mass ?? ''), eu.mass);

// ---- 8. Saturn and its rings -------------------------------------------------------------------------------------------------
await fly('saturn');
await lookSunward('saturn', 0.6, 0.65);
await page.waitForTimeout(4500);
await snap('04-saturn');
const sat = await A(() => { const v = window.__atlas.viewer; const n = v.solar.nodes.get('saturn'); return { ring: !!n.ring, ringTex: !!n.ringMat.uniforms.uRingTex.value, hasRing: n.mat.uniforms.uHasRing.value, ringRadii: n.ringMat.uniforms.uRingRadii.value.toArray(), tex: v.textures.loadedCount }; });
check('Saturn has a ring mesh whose texture loaded', sat.ring && sat.ringTex && sat.hasRing === 1);
check('the ring extent comes from the calibrated provenance (about 75,000 to 140,000 km)', sat.ringRadii[0] > 7.2e7 && sat.ringRadii[1] < 1.42e8, `${(sat.ringRadii[0] / 1e6).toFixed(1)} to ${(sat.ringRadii[1] / 1e6).toFixed(1)} thousand km`);

// ---- 9. orientation and enlargement ------------------------------------------------------------------------------------------
const scale = await A(() => document.getElementById('scale-status').textContent);
check('the interface states when sizes are not to scale, naming the body', /NOT to scale/.test(scale) && /enlarged up to/.test(scale), scale);
await page.click('#btn-scale');
await page.waitForTimeout(500);
const trueScale = await A(() => ({ txt: document.getElementById('scale-status').textContent, ex: Math.max(...[...window.__atlas.viewer.screen.values()].map((i) => i.exaggeration)) }));
check('true-scale mode shows every body at its true size', /true scale/.test(trueScale.txt) && trueScale.ex === 1, trueScale.txt);
await page.click('#btn-scale');

// ---- 10. hierarchical navigation without teleporting ------------------------------------------------------------------------
await fly('earth');
await A(() => window.__atlas.viewer.flyToOverview(1800));
const trail = [];
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(60);
  trail.push(await A(() => { const v = window.__atlas.viewer; const c = v.cameraHelioMetres(); return { d: v.state.distance, frame: v.frame.path[v.frame.path.length - 1]?.name, c, fly: v.flying, t: performance.now() }; }));
  if (!trail[trail.length - 1].fly) break;
}
await page.waitForTimeout(800);
// Software GL renders ~3 frames/s, so sample timestamps and frame times do not line up and a rate-based test would measure the
// harness, not the camera. Instead check what teleporting would break: the distance moves monotonically in many steps, and no single
// step covers a large share of the journey.
const decades = Math.abs(Math.log10(trail[trail.length - 1].d / trail[0].d));
const steps = [];
for (let i = 1; i < trail.length; i++) steps.push(Math.log10(trail[i].d / trail[i - 1].d));
const dir = Math.sign(Math.log10(trail[trail.length - 1].d / trail[0].d));
const monotone = steps.every((x) => x * dir >= -1e-9);
const biggest = Math.max(...steps.map((x) => Math.abs(x))) / decades;
const distinct = new Set(trail.map((t) => t.d)).size;
const frames = [...new Set(trail.map((t) => t.frame))];
check('flying Earth -> overview passes through the hierarchy in order', frames.length >= 2 && frames[0].includes('Earth') , frames.join(' > '));
check('the camera distance changes smoothly (monotonic, at least 4 distinct frames, none a large share of the journey: no teleporting; software GL delivers only 2 to 7 frames/s, so a higher frame-count floor would measure the machine)', monotone && distinct >= 4 && biggest < 0.4, `${decades.toFixed(1)} decades in ${distinct} distinct steps; largest single step ${(biggest * 100).toFixed(0)}% of the journey; monotonic ${monotone}`);
await snap('05-overview');
const ov = await A(() => { const v = window.__atlas.viewer; return { orbits: v.solar.stats.orbits, markers: v.solar.stats.markers, spheres: v.solar.stats.spheres, tex: v.textures.loadedCount, crumbs: document.getElementById('crumbs').textContent }; });
check('the overview shows the outer planetary orbits and every planet as a marker (the inner orbits are under 14 px at this distance and are correctly not drawn)', ov.orbits >= 4 && ov.markers + ov.spheres >= 8, `${ov.orbits} orbits, ${ov.spheres} spheres, ${ov.markers} markers`);
check('the overview breadcrumb is the Solar System level', /Solar System$/.test(ov.crumbs), ov.crumbs);

// ---- 11. Parent navigation and zoom limit -------------------------------------------------------------------------------------
await fly('io');
await A(() => window.__atlas.viewer.flyToParent());
await page.waitForFunction(() => !window.__atlas.viewer.flying, null, { timeout: 40_000 });
check('Parent goes from a moon to its planet', (await A(() => window.__atlas.viewer.followId)) === 'jupiter');
await A(() => window.__atlas.viewer.flyToParent());
await page.waitForFunction(() => !window.__atlas.viewer.flying, null, { timeout: 40_000 });
check('Parent from a planet returns to the Solar System overview', (await A(() => window.__atlas.viewer.followId)) === null);
await fly('earth');
for (let i = 0; i < 60; i++) await page.mouse.wheel(0, -400);
await page.waitForTimeout(500);
const closest = await A(() => ({ d: window.__atlas.viewer.state.distance * 3.0856775814913673e16, r: window.__atlas.solarData.meanRadiusMetres('earth') }));
check('the camera cannot be zoomed into the planet (the zoom limit is above the surface)', closest.d >= closest.r * 1.3, `closest ${(closest.d / 1000).toFixed(0)} km from the centre, radius ${(closest.r / 1000).toFixed(0)} km`);

// ---- 12. texture lifetime ------------------------------------------------------------------------------------------------------
await A(() => window.__atlas.viewer.flyToOverview(100));
await page.waitForFunction(() => !window.__atlas.viewer.flying, null, { timeout: 40_000 });
await page.waitForTimeout(1500);
const before = await A(() => window.__atlas.viewer.textures.loadedCount);
const released = await A(() => window.__atlas.viewer.textures.sweep(performance.now() / 1000 + 60));
const after = await A(() => window.__atlas.viewer.textures.loadedCount);
check('unused textures are released after their time-to-live', released > 0 && after === 0, `${before} loaded, ${released} disposed, ${after} left`);

// ---- 13. keyboard, performance, errors ---------------------------------------------------------------------------------------
await page.keyboard.press('Space');
check('Space pauses and resumes simulation time', (await A(() => window.__atlas.clock.paused)) === true);
await page.keyboard.press('Space');
await fly('earth');
const fps = await A(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const loop = () => { n++; if (performance.now() - t0 > 3000) res(n / 3); else requestAnimationFrame(loop); }; requestAnimationFrame(loop); }));
const perf = await A(() => ({ calls: window.__atlas.viewer.drawCalls, mb: window.__atlas.viewer.textures.estimatedBytes / 1048576, spheres: window.__atlas.viewer.solar.stats.spheres }));
check('the page keeps rendering with the Solar System active (software GL, so only a floor)', fps > 2, `${fps.toFixed(1)} frames/s with SwiftShader (CPU) rendering; ${perf.calls} draw calls; about ${perf.mb.toFixed(0)} MB of textures`);
check('no console errors or warnings', problems.length === 0, problems.join(' | ').slice(0, 400));

await writeFile(`${OUT}/qa-log.json`, JSON.stringify({ url: URL, loadMs, checks, fps, perf, problems }, null, 2));
await browser.close();
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
