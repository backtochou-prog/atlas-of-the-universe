// Measurements for the deep-space layer in a real browser: per scene (draw calls, texture bytes, GPU textures, JS heap, frame rate, catalogue load
// times) and a disposal loop (fly to every object several times; texture bytes must stay under the 192 MB budget and the GPU texture count must
// fall back towards the baseline once the camera flies away and nothing wants the textures any more).
//
// SOFTWARE GL ONLY (SwiftShader, CPU): frame rates here say nothing about a GPU, and no GPU timing is measured. Draw calls, texture bytes and
// texture counts are exact counts and do not depend on the renderer. JS heap is Chromium's performance.memory (precise-memory-info flag on).
// Needs: `npx vite preview --port 4173 --host 127.0.0.1` and Playwright (PLAYWRIGHT_MODULE_DIR=/root/jumanji-vr). Writes docs/qa/deepspace/perf.json.
// The adaptive quality governor is switched off for deterministic frames (qa-deepspace.mjs has one check with it on).
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const require = createRequire((process.env.PLAYWRIGHT_MODULE_DIR ?? process.cwd()) + '/');
const { chromium } = require('playwright');

const URL = process.env.ATLAS_URL ?? 'http://127.0.0.1:4173/';
const OUT = process.env.QA_OUT ?? 'docs/qa/deepspace';
const BUDGET = 192 * 1024 * 1024;
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-precise-memory-info'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const problems = [];
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(`${m.type()}: ${m.text().slice(0, 200)}`); });
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
const A = (fn, arg) => page.evaluate(fn, arg);

const t0 = Date.now();
await page.goto(URL);
await page.waitForFunction(() => window.__atlas?.deepUi && window.__atlas.viewer.deep, null, { timeout: 90_000 });
const loadMs = Date.now() - t0;
await A(() => window.__atlas.viewer.disableQualityGovernor());
await A(() => { window.__texMax = 0; window.__bytesMax = 0; const loop = () => { const v = window.__atlas.viewer; const s = v.deep?.stats(); if (s) { window.__bytesMax = Math.max(window.__bytesMax, s.textureBytes); window.__texMax = Math.max(window.__texMax, v.renderer.info.memory.textures); } requestAnimationFrame(loop); }; loop(); });
const settleFlight = () => page.waitForFunction(() => !window.__atlas.viewer.flying, null, { timeout: 90_000 });
const idle = (ms = 30_000) => page.waitForFunction(() => window.__atlas.viewer.deep.stats().loading === 0, null, { timeout: ms }).catch(() => {});

const measure = async (name, extra = {}) => {
  const r = await A(async () => {
    const a = window.__atlas, v = a.viewer;
    const mem = performance.memory ? { usedMB: performance.memory.usedJSHeapSize / 1048576, totalMB: performance.memory.totalJSHeapSize / 1048576 } : null;
    // frame rate and per-frame time over ~4 s of the real render loop (requestAnimationFrame)
    const dts = [];
    await new Promise((res) => { let last = performance.now(); const t0 = last; const loop = () => { const n = performance.now(); dts.push(n - last); last = n; if (n - t0 > 4000) res(); else requestAnimationFrame(loop); }; requestAnimationFrame(loop); });
    dts.shift();
    const sorted = [...dts].sort((x, y) => x - y);
    const ds = v.deep.stats();
    const store = v.deep.registered.find((r) => r.name === 'star-clusters')?.store;
    return {
      fps: dts.length / (dts.reduce((s, x) => s + x, 0) / 1000), frameMsMedian: sorted[Math.floor(sorted.length / 2)] ?? 0, frames: dts.length,
      drawCallsTotal: v.drawCalls, drawCallsDeepLayer: ds.drawCalls, pointsDrawn: ds.pointsDrawn, objectsVisible: ds.objectsVisible,
      textureBytesLayer: ds.textureBytes, textureMB: ds.textureBytes / 1048576, layerTextures: ds.textures, gpuTextures: v.renderer.info.memory.textures, gpuGeometries: v.renderer.info.memory.geometries,
      heap: mem, quality: ds.quality, cameraDistancePc: v.state.distance, assetStats: v.deep.assets.stats(), catalogues: store ? store.stats() : null,
    };
  });
  const row = { scene: name, ...extra, ...r };
  console.log(`${name.padEnd(30)} calls ${String(r.drawCallsTotal).padStart(3)} (deep ${r.drawCallsDeepLayer}) | tex ${r.textureMB.toFixed(1).padStart(6)} MB, ${r.gpuTextures} GPU textures | heap ${r.heap ? r.heap.usedMB.toFixed(0) + ' MB' : 'n/a'} | ${r.fps.toFixed(1)} fps (${r.frameMsMedian.toFixed(0)} ms median) | points ${r.pointsDrawn}`);
  return row;
};

const scenes = [];
// 1. start view
await A(() => window.__atlas.viewer.flyTo({ focus: [0, 0, 0], distance: 60, yaw: 0.6, pitch: 0.35 })); await settleFlight(); await page.waitForTimeout(1500);
const baseline = { gpuTextures: await A(() => window.__atlas.viewer.renderer.info.memory.textures), geometries: await A(() => window.__atlas.viewer.renderer.info.memory.geometries) };
scenes.push(await measure('start view (60 pc, Gaia)'));
// 2. M31 image
await A(() => window.__atlas.deepUi.selectDeep('m31', { fly: true })); await settleFlight(); await idle(); await page.waitForTimeout(2500);
scenes.push(await measure('M31 image', { lod: await A(() => window.__atlas.viewer.deepScreen.get('m31')?.lod) }));
// 3. Orion image
await A(() => window.__atlas.deepUi.selectDeep('orion-nebula', { fly: true })); await settleFlight(); await idle(); await page.waitForTimeout(2500);
scenes.push(await measure('Orion Nebula image', { lod: await A(() => window.__atlas.viewer.deepScreen.get('orion-nebula')?.lod) }));
// 4. cluster members (lazily loaded catalogues)
for (const [id, label] of [['pleiades', 'Pleiades members'], ['omega-centauri', 'Omega Centauri members']]) {
  await A((i) => window.__atlas.deepUi.selectDeep(i, { fly: true }), id); await settleFlight(); await page.waitForTimeout(3000);
  scenes.push(await measure(label, { lod: await A((i) => window.__atlas.viewer.deepScreen.get(i)?.lod, id) }));
}
// 5. Local Group, 6. 2MRS at 100 Mpc
await A(() => window.__atlas.deepUi.clearSelection());
await A(() => window.__atlas.deepUi.flyScale('local-group')); await settleFlight(); await page.waitForTimeout(4000);
scenes.push(await measure('Local Group (3 Mpc view)'));
await A(() => window.__atlas.deepUi.flyScale('nearby-universe')); await settleFlight(); await page.waitForTimeout(6000);
scenes.push(await measure('2MRS at 100 Mpc'));
// 7. Milky Way from 30 kpc
await A(() => { window.__atlas.viewer.flyToDeep('milky-way', 400); }); await settleFlight();
await A(() => { const v = window.__atlas.viewer; v.state = { ...v.state, distance: 30_000 }; v.selectedDeep = null; }); await page.waitForTimeout(2500);
scenes.push(await measure('Milky Way from 30 kpc'));

// catalogue load times (fetch + decompress + parse, ms; the row-set build of the renderer is separate)
const cat = await A(() => { const store = window.__atlas.viewer.deep.registered.find((r) => r.name === 'star-clusters').store; const s = store.stats(); const res = performance.getEntriesByType('resource').filter((e) => /data\/deepspace\/.*\.json\.gz/.test(e.name)).map((e) => ({ file: e.name.split('/').pop(), transferKB: e.transferSize / 1024, decodedKB: e.decodedBodySize / 1024, fetchMs: e.duration })); return { loadMs: s.loadMs, resources: res }; });
console.log('catalogue load ms:', JSON.stringify(Object.fromEntries(Object.entries(cat.loadMs).map(([k, v]) => [k, +v.toFixed(0)]))));

// ---- disposal loop: fly through every object several times, then fly away and wait ----------------------------------------------------------------------
const ids = await A(() => window.__atlas.viewer.deepData.all().map((o) => o.id));
const texAfterLoop = [];
const loops = Number(process.env.PERF_LOOPS ?? 3);
await A(() => window.__atlas.deepUi.clearSelection());
for (let l = 0; l < loops; l++) {
  for (const id of ids) {
    await A((i) => window.__atlas.viewer.flyToDeep(i, 300), id); await settleFlight(); await idle(8000); await page.waitForTimeout(500); // let the images of the object load before moving on
  }
  texAfterLoop.push(await A(() => { const v = window.__atlas.viewer; const s = v.deep.assets.stats(); return { layerTextures: s.textures, bytesMB: s.textureBytes / 1048576, referencedMB: s.referencedBytes / 1048576, gpuTextures: v.renderer.info.memory.textures, created: s.created, disposed: s.disposed, evictions: s.evictions }; }));
  console.log(`loop ${l + 1}/${loops}:`, JSON.stringify(texAfterLoop[l]));
}
const peak = await A(() => ({ bytes: window.__bytesMax, tex: window.__texMax }));
// fly away to the start view and wait: leases are released after ~4 s, the cold purge drops the cached textures after 30 s
await A(() => { const v = window.__atlas.viewer; v.selectedDeep = null; window.__atlas.deepUi.clearSelection(); v.flyTo({ focus: [0, 0, 0], distance: 60, yaw: 0.6, pitch: 0.35 }); }); await settleFlight();
const away = [];
for (const waitS of [2, 10, 20, 35, 45]) {
  await page.waitForTimeout(waitS === 2 ? 2000 : (waitS - away.at(-1).afterS) * 1000);
  away.push({ afterS: waitS, ...(await A(() => { const v = window.__atlas.viewer; const s = v.deep.assets.stats(); return { layerTextures: s.textures, bytesMB: s.textureBytes / 1048576, referencedMB: s.referencedBytes / 1048576, gpuTextures: v.renderer.info.memory.textures, created: s.created, disposed: s.disposed }; })) });
}
console.log('after flying away:', JSON.stringify(away));
const disposal = { objects: ids.length, loops, baseline, afterEachLoop: texAfterLoop, peakTextureBytes: peak.bytes, peakTextureMB: peak.bytes / 1048576, peakGpuTextures: peak.tex, budgetMB: BUDGET / 1048576, underBudget: peak.bytes <= BUDGET, awayAfterSeconds: away,
  returnedTowardBaseline: away.at(-1).gpuTextures <= baseline.gpuTextures + 2, noGrowthAcrossLoops: texAfterLoop.length < 2 || texAfterLoop.at(-1).created - texAfterLoop.at(-1).disposed <= texAfterLoop.at(-1).layerTextures };

const result = {
  ranAt: new Date().toISOString(), url: URL,
  note: 'SOFTWARE GL (SwiftShader, CPU) in headless Chromium: frame rates and frame times describe this CPU renderer only; there are no GPU timings and nothing here is a GPU performance claim. Draw calls, texture bytes and texture counts are exact counts. JS heap is performance.memory (Chromium, precise-memory-info). Quality governor disabled for these runs.',
  userAgent: await A(() => navigator.userAgent), viewport: { width: 1280, height: 800 }, pageLoadMs: loadMs,
  scenes, catalogueLoads: cat, disposal, problems,
};
await writeFile(`${OUT}/perf.json`, JSON.stringify(result, null, 2));
await browser.close();
console.log(`\nunder budget: ${disposal.underBudget} (peak ${disposal.peakTextureMB.toFixed(1)} MB of ${disposal.budgetMB} MB); GPU textures baseline ${baseline.gpuTextures} -> peak ${peak.tex} -> ${away.at(-1).gpuTextures} after flying away; problems ${problems.length}`);
process.exit(problems.length || !disposal.underBudget ? 1 : 0);
