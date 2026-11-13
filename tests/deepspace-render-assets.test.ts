import { describe, expect, it } from 'vitest';
import { COLD_TTL_S, DOWNGRADE_HOLD_S, DeepSpaceAssetManager, GPU_BYTES_FACTOR, IDLE_TTL_S, statsFromRgba, type DecodedImage } from '../src/render/deep-space/DeepSpaceAssetManager';
import type { DeepImageAsset } from '../src/data/deepspace/types';

// Dependency-injected fakes: these tests exercise the loading POLICY (levels, leases, budget, disposal). They do not touch WebGL.
const SIZES = [256, 1024, 2048, 4096];
const asset = (id: string, sizes = SIZES): DeepImageAsset => ({
  id, objectId: 'x', title: id,
  band: { kind: 'visible', filters: [], falseColour: false, composite: false, colourNote: '' },
  source: { archive: 'a', imageId: id, landingUrl: '', downloadUrl: '', retrieved: '', sha256: '' }, credit: '',
  licence: { name: '', url: '', evidence: '', attributionRequired: false, redistributionAllowed: true },
  observation: { telescope: '' }, geometry: { originalWidthPx: 1, originalHeightPx: 1, fovArcmin: [1, 1], centreRaDeg: 0, centreDecDeg: 0, upPositionAngleDeg: 0, wcsSource: 'fits-header' },
  processing: [], fidelity: 'scientific-image',
  levels: sizes.map((s, i) => ({ level: i, file: `img/${id}.L${i}.webp`, widthPx: s, heightPx: s, bytes: 1, format: 'webp' as const })),
});

interface FakeTex { id: string; disposed: number; dispose(): void }
function harness(budgetBytes = 1e12, ids = ['a']) {
  const pending = new Map<string, { resolve(): void; reject(e: unknown): void; signal: AbortSignal }>();
  const created: FakeTex[] = [];
  const m = new DeepSpaceAssetManager<FakeTex>({
    baseUrl: 'base/', budgetBytes,
    decode: (url, signal) => new Promise<DecodedImage>((resolve, reject) => {
      const size = Number(/L(\d)/.exec(url)![1]);
      const img: DecodedImage = { width: SIZES[size]!, height: SIZES[size]!, source: url };
      pending.set(url, { resolve: () => resolve(img), reject, signal });
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }),
    createTexture: (img, info) => { const t: FakeTex = { id: `${info.assetId}#${info.level}`, disposed: 0, dispose() { this.disposed++; } }; created.push(t); void img; return t; },
    analyse: () => ({ mean: [0.1, 0.1, 0.1], median: 0.05, p95: 0.2, p99: 0.3, peak: 0.5 }),
  });
  m.registerAssets(ids.map((i) => asset(i)));
  const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const finish = async (url: string) => { pending.get(url)!.resolve(); pending.delete(url); await settle(); };
  return { m, pending, created, settle, finish };
}
const want = (m: DeepSpaceAssetManager<FakeTex>, id: string, px: number, now: number, extra: object = {}) => m.want(id, { onScreenPx: px, devicePixelRatio: 1, quality: 1, nowSeconds: now, ...extra });

describe('DeepSpaceAssetManager (fake decoder and textures)', () => {
  it('loads only the level-0 thumbnail for a small object, and shares one load between repeated requests', async () => {
    const h = harness();
    h.m.beginFrame(); want(h.m, 'a', 100, 0); want(h.m, 'a', 100, 0); h.m.beginFrame(); want(h.m, 'a', 100, 0.1);
    expect([...h.pending.keys()]).toEqual(['base/img/a.L0.webp']);
    await h.finish('base/img/a.L0.webp');
    h.m.beginFrame();
    const v = want(h.m, 'a', 100, 0.2)!;
    expect(v.level).toBe(0);
    expect(v.stats?.p95).toBe(0.2);
    expect(h.created).toHaveLength(1);
  });

  it('chooses the smallest level that covers the on-screen size, scaled by devicePixelRatio and quality', async () => {
    const h = harness();
    h.m.beginFrame(); expect(want(h.m, 'a', 900, 0)!.wantedLevel).toBe(1);
    h.m.beginFrame(); expect(h.m.want('a', { onScreenPx: 900, devicePixelRatio: 2, quality: 1, nowSeconds: 0 })!.wantedLevel).toBe(2); // 1800 px needed
    const h2 = harness(); h2.m.beginFrame();
    expect(h2.m.want('a', { onScreenPx: 900, devicePixelRatio: 2, quality: 0.5, nowSeconds: 0 })!.wantedLevel).toBe(1);
    await h.settle();
  });

  it('upgrades progressively: the thumbnail stays on screen until the better level has arrived, then it swaps', async () => {
    const h = harness();
    h.m.beginFrame(); want(h.m, 'a', 3000, 0);
    await h.finish('base/img/a.L0.webp');
    h.m.beginFrame(); let v = want(h.m, 'a', 3000, 0.1)!;
    expect(v.level).toBe(0); expect(v.wantedLevel).toBe(3);
    expect(h.pending.has('base/img/a.L3.webp')).toBe(true);
    h.m.beginFrame(); v = want(h.m, 'a', 3000, 0.2)!; expect(v.level).toBe(0); // still loading: never blank, never blocked
    await h.finish('base/img/a.L3.webp');
    h.m.beginFrame(); v = want(h.m, 'a', 3000, 0.3)!;
    expect(v.level).toBe(3);
    // the thumbnail is kept as the floor, nothing in between was ever loaded
    expect(h.created.map((t) => t.id).sort()).toEqual(['a#0', 'a#3']);
  });

  it('activates at most one big texture per frame (the GPU upload is the expensive part)', async () => {
    const h = harness(1e12, ['a', 'b']);
    h.m.beginFrame(); want(h.m, 'a', 3000, 0); want(h.m, 'b', 3000, 0);
    await h.finish('base/img/a.L0.webp'); await h.finish('base/img/b.L0.webp');
    h.m.beginFrame(); want(h.m, 'a', 3000, 0.1); want(h.m, 'b', 3000, 0.1);
    await h.finish('base/img/a.L3.webp'); await h.finish('base/img/b.L3.webp');
    h.m.beginFrame();
    const va = want(h.m, 'a', 3000, 0.2)!, vb = want(h.m, 'b', 3000, 0.2)!;
    expect([va.level, vb.level].sort()).toEqual([0, 3]);
    h.m.beginFrame();
    expect(want(h.m, 'a', 3000, 0.3)!.level).toBe(3); expect(want(h.m, 'b', 3000, 0.3)!.level).toBe(3);
  });

  it('downgrades only after the smaller size has persisted (hysteresis), and releases the higher level afterwards', async () => {
    const h = harness();
    h.m.beginFrame(); want(h.m, 'a', 3000, 0); await h.finish('base/img/a.L0.webp');
    h.m.beginFrame(); want(h.m, 'a', 3000, 0.1); await h.finish('base/img/a.L3.webp');
    h.m.beginFrame(); want(h.m, 'a', 3000, 0.2);
    let t = 1;
    h.m.beginFrame(); let v = want(h.m, 'a', 100, t)!; // object shrank: wanted stays 3 for now
    expect(v.wantedLevel).toBe(3); expect(v.level).toBe(3);
    t += DOWNGRADE_HOLD_S - 0.5; h.m.beginFrame(); v = want(h.m, 'a', 100, t)!;
    expect(v.wantedLevel).toBe(3);
    t += 1; h.m.beginFrame(); v = want(h.m, 'a', 100, t)!;
    expect(v.wantedLevel).toBe(0);
    h.m.beginFrame(); v = want(h.m, 'a', 100, t + 0.1)!;
    expect(v.level).toBe(0);
    await h.settle();
    h.m.beginFrame(); want(h.m, 'a', 100, t + 0.2);
    // released but cached (under budget): still alive, disposed only when evicted or at dispose()
    expect(h.m.stats().textures).toBe(2);
    expect(h.created.every((x) => x.disposed === 0)).toBe(true);
  });

  it('gives up every lease of an asset that is not wanted for IDLE_TTL_S, and aborts loads in flight', async () => {
    const h = harness();
    h.m.beginFrame(); want(h.m, 'a', 3000, 0); await h.finish('base/img/a.L0.webp');
    h.m.beginFrame(); want(h.m, 'a', 3000, 0.1); // L3 now loading
    const ctrl = h.pending.get('base/img/a.L3.webp')!;
    h.m.beginFrame(); h.m.endFrame(IDLE_TTL_S + 1);
    expect(ctrl.signal.aborted).toBe(true);
    await h.settle();
    h.m.beginFrame(); want(h.m, 'a', 3000, IDLE_TTL_S + 2);
    await h.settle();
    h.m.beginFrame(); const v = want(h.m, 'a', 3000, IDLE_TTL_S + 2.1)!;
    expect(v.level).toBe(0); // the thumbnail is still in the cache (under budget): re-leased without a new decode
    expect(h.created.filter((t) => t.id === 'a#0')).toHaveLength(1);
  });

  it('keeps total bytes under the budget by evicting unreferenced textures once, and never evicts one in use', async () => {
    const l0 = Math.floor(256 * 256 * GPU_BYTES_FACTOR);
    const h = harness(l0 * 2.5, ['a', 'b', 'c', 'd']);
    for (const id of ['a', 'b', 'c', 'd']) {
      h.m.beginFrame(); want(h.m, id, 100, 0); await h.finish(`base/img/${id}.L0.webp`);
      h.m.beginFrame(); want(h.m, id, 100, 0.1);
    }
    // all four are in use (wanted): over budget is reported, nothing in use is freed
    expect(h.m.stats().overBudget).toBe(true);
    expect(h.created.every((x) => x.disposed === 0)).toBe(true);
    for (const id of ['a', 'b', 'c']) h.m.release(id);
    expect(h.m.stats().overBudget).toBe(false);
    expect(h.created.filter((x) => x.disposed > 0)).toHaveLength(2);
    expect(h.created.every((x) => x.disposed <= 1)).toBe(true);
    h.m.dispose();
    expect(h.created.every((x) => x.disposed === 1)).toBe(true); // exactly once, including the one that was in use
    h.m.dispose();
    expect(h.created.every((x) => x.disposed === 1)).toBe(true);
  });

  it('a texture that arrives after everyone gave up is disposed and never cached', async () => {
    const h = harness();
    h.m.beginFrame(); want(h.m, 'a', 100, 0);
    h.m.release('a');
    h.pending.get('base/img/a.L0.webp')!; // the decoder was aborted by the release
    await h.settle();
    expect(h.m.stats().textures).toBe(0);
  });
});

describe('statsFromRgba', () => {
  it('computes linear-light mean, median and percentiles', () => {
    const px = new Uint8ClampedArray(4 * 100);
    for (let i = 0; i < 100; i++) { const v = i < 90 ? 0 : 255; px.set([v, v, v, 255], 4 * i); }
    const s = statsFromRgba(px);
    expect(s.median).toBe(0); expect(s.p99).toBeCloseTo(1, 6); expect(s.mean[0]).toBeCloseTo(0.1, 6); expect(s.peak).toBeCloseTo(1, 6);
  });
  it('cold purge: after nothing has wanted an asset for COLD_TTL_S its textures are disposed (count falls to zero), not before', async () => {
    const h = harness();
    h.m.beginFrame(); want(h.m, 'a', 100, 0);
    await h.finish('base/img/a.L0.webp');
    h.m.beginFrame(); want(h.m, 'a', 100, 0.1); h.m.endFrame(0.1);
    expect(h.m.stats().textures).toBe(1);
    h.m.beginFrame(); h.m.endFrame(IDLE_TTL_S + 1); // leases released, but the warm cache keeps the texture
    expect(h.m.stats().textures).toBe(1); expect(h.created.every((t) => t.disposed === 0)).toBe(true);
    h.m.beginFrame(); h.m.endFrame(COLD_TTL_S + 1);
    expect(h.m.stats().textures).toBe(0); expect(h.m.stats().textureBytes).toBe(0);
    expect(h.created.every((t) => t.disposed === 1)).toBe(true); // exactly one dispose per texture
    h.m.beginFrame(); h.m.endFrame(COLD_TTL_S + 5); // idempotent
    expect(h.created.every((t) => t.disposed === 1)).toBe(true);
    // flying back works: it loads again
    h.m.beginFrame(); want(h.m, 'a', 100, COLD_TTL_S + 6);
    await h.finish('base/img/a.L0.webp');
    h.m.beginFrame(); expect(want(h.m, 'a', 100, COLD_TTL_S + 6.1)!.level).toBe(0);
    expect(h.created).toHaveLength(2);
  });
});

// ---- decoded-bitmap lifetime and WebGL context loss (fakes only: no WebGL, no real ImageBitmap) ------------------------------
describe('DeepSpaceAssetManager: bitmap lifetime and context loss (fakes)', () => {
  interface FakeImg extends DecodedImage { closed: number }
  function bitmapHarness() {
    const pending = new Map<string, { resolve(): void; signal: AbortSignal; img: FakeImg }>();
    const images: FakeImg[] = [];
    const textures: FakeTex[] = [];
    const m = new DeepSpaceAssetManager<FakeTex>({
      baseUrl: 'base/',
      decode: (url, signal) => new Promise<DecodedImage>((resolve) => {
        const img: FakeImg = { width: 256, height: 256, source: url, closed: 0, close() { this.closed++; } };
        images.push(img);
        pending.set(url, { resolve: () => resolve(img), signal, img });
        // like the real decoder: the abort is only seen BEFORE decoding finishes; a late abort resolves with a decoded bitmap
      }),
      createTexture: (_img, info) => { const t: FakeTex = { id: `${info.assetId}#${info.level}`, disposed: 0, dispose() { this.disposed++; } }; textures.push(t); return t; },
    });
    m.registerAssets([asset('a')]);
    const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
    return { m, pending, images, textures, settle };
  }

  it('closes the decoded bitmap when the load was aborted while it was being decoded (no texture is created)', async () => {
    const h = bitmapHarness();
    h.m.beginFrame(); want(h.m, 'a', 100, 0);
    const p = h.pending.get('base/img/a.L0.webp')!;
    h.m.release('a');                       // abort arrives while the decoder is still working
    expect(p.signal.aborted).toBe(true);
    p.resolve(); await h.settle();          // the decoder finishes anyway and hands over a bitmap
    expect(p.img.closed).toBe(1);
    expect(h.textures).toHaveLength(0);
    expect(h.m.stats().textures).toBe(0);
  });

  it('closes the bitmap of a texture that is evicted before it was ever uploaded; a texture already uploaded stays valid until evicted', async () => {
    const h = bitmapHarness();
    h.m.beginFrame(); want(h.m, 'a', 100, 0);
    const p = h.pending.get('base/img/a.L0.webp')!; p.resolve(); await h.settle();
    h.m.beginFrame(); expect(want(h.m, 'a', 100, 0.1)!.level).toBe(0);
    expect(p.img.closed).toBe(0);                      // held and wanted: still open (the renderer uploads it later)
    h.m.endFrame(0.1);
    h.m.beginFrame(); h.m.endFrame(IDLE_TTL_S + 1);    // idle: lease released
    h.m.beginFrame(); h.m.endFrame(COLD_TTL_S + 5);    // cold: unreferenced textures are purged
    expect(h.textures[0]!.disposed).toBe(1);
    expect(p.img.closed).toBe(1);
  });

  it('a failing analyse/createTexture does not leak the decoded bitmap', async () => {
    const images: { closed: number; close(): void; width: number; height: number; source: string }[] = [];
    const m = new DeepSpaceAssetManager<FakeTex>({
      baseUrl: 'base/',
      decode: async (url) => { const img = { width: 256, height: 256, source: url, closed: 0, close() { this.closed++; } }; images.push(img); return img; },
      createTexture: () => { throw new Error('no GL'); },
    });
    m.registerAssets([asset('a')]);
    m.beginFrame(); m.want('a', { onScreenPx: 100, devicePixelRatio: 1, quality: 1, nowSeconds: 0 });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(images[0]!.closed).toBe(1);
  });

  it('context loss: every texture is disposed, nothing is requested while lost, and the images are re-decoded and re-created after restore', async () => {
    const h = bitmapHarness();
    h.m.beginFrame(); want(h.m, 'a', 100, 0);
    h.pending.get('base/img/a.L0.webp')!.resolve(); h.pending.delete('base/img/a.L0.webp'); await h.settle();
    h.m.beginFrame(); expect(want(h.m, 'a', 100, 0.1)!.texture).toBe(h.textures[0]);
    // a load for a bigger level is in flight when the context goes
    h.m.beginFrame(); want(h.m, 'a', 3000, 0.2);
    expect(h.pending.size).toBe(1);
    const inflight = [...h.pending.values()][0]!;

    h.m.onContextLost();
    expect(h.m.isContextLost()).toBe(true);
    expect(h.textures[0]!.disposed).toBe(1);            // GPU texture dropped; its bitmap was closed too
    expect(h.images[0]!.closed).toBeGreaterThanOrEqual(1);
    expect(inflight.signal.aborted).toBe(true);
    expect(h.m.stats().textures).toBe(0);
    const before = h.images.length;
    h.m.beginFrame(); expect(want(h.m, 'a', 100, 1)).toBeNull();   // no view, no request while lost
    expect(h.images.length).toBe(before);

    h.m.onContextRestored();
    expect(h.m.isContextLost()).toBe(false);
    h.m.beginFrame(); const v0 = want(h.m, 'a', 100, 2)!;
    expect(v0.texture).toBeNull();                      // nothing stale is handed out: the old (closed) bitmap is never reused
    const url = 'base/img/a.L0.webp';
    expect(h.pending.has(url)).toBe(true);              // re-requested through the manager
    h.pending.get(url)!.resolve(); await h.settle();
    h.m.beginFrame(); const v1 = want(h.m, 'a', 100, 2.1)!;
    expect(v1.texture).not.toBeNull();
    expect(v1.texture).not.toBe(h.textures[0]);         // a NEW texture
    expect(h.textures.length).toBeGreaterThanOrEqual(2);
  });
});
