import * as THREE from 'three';
import { AssetCache, type Lease } from '../../core/deepspace/assetCache';
import { selectTextureLevel } from '../../core/deepspace/lod';
import type { DeepImageAsset } from '../../data/deepspace/types';

/**
 * Image-level loader for the deep-space layer. Policy only; decoding and texture creation are injected so the policy is
 * testable without WebGL (tests/deepspace-render-assets.test.ts uses a fake decoder and fake textures).
 *
 *  - Budget: GPU bytes counted as width * height * 4 * 1.33 (RGBA + mip chain), default 192 MB (core AssetCache, LRU of
 *    unreferenced textures, ref-counted leases, in-flight de-duplication, abort on release, one dispose per texture).
 *  - Level 0 (a tiny thumbnail) is held for every asset that is wanted at all (tint, exposure, glow). The working level
 *    comes from core selectTextureLevel(on-screen px, devicePixelRatio, quality).
 *  - Upgrades are progressive: the better level loads in the background while the current one stays on screen; the swap
 *    happens in the frame after the new texture is ready, and at most `maxActivationsPerFrame` big textures are activated
 *    per frame (their first GPU upload is the expensive part). The image is the same, only sharper: nothing flashes.
 *  - Downgrades have hysteresis: the wanted level may only fall after being lower for DOWNGRADE_HOLD_S; higher levels are
 *    released only after the lower one is on screen. Assets not wanted for IDLE_TTL_S release every lease (the cache then
 *    evicts least-recently-used textures only when over budget).
 */
export const DEFAULT_BUDGET_BYTES = 192 * 1024 * 1024;
export const GPU_BYTES_FACTOR = 4 * 1.33;
export const DOWNGRADE_HOLD_S = 2.5;
export const IDLE_TTL_S = 4;
/**
 * An asset that has been wanted by nobody for this long is "cold": the unreferenced textures of the cache are then dropped
 * (cache.clear()), so that the GPU texture count and memory fall back towards the baseline after the camera has flown away.
 * Until then they stay as a warm LRU cache (flying back to a nearby object does not reload it).
 */
export const COLD_TTL_S = 30;

export interface Disposable { dispose(): void }
export interface DecodedImage { readonly width: number; readonly height: number; readonly source: unknown; close?(): void }

/** Statistics of the level-0 thumbnail, linear light, used for the glow tint and a per-object exposure. */
export interface ImageStats {
  /** Mean colour, linear, 0..1. */
  readonly mean: readonly [number, number, number];
  /** Median linear luminance (the sky/background level of the image), 0..1. */
  readonly median: number;
  /** 95th percentile of linear luminance, 0..1. */
  readonly p95: number;
  /** 99th percentile of linear luminance, 0..1. */
  readonly p99: number;
  /** Largest linear luminance, 0..1. */
  readonly peak: number;
}

export interface AssetManagerOptions<T extends Disposable> {
  /** Folder of the image files, with trailing slash (e.g. `${BASE_URL}deepspace/`). */
  readonly baseUrl: string;
  readonly budgetBytes?: number;
  readonly decode: (url: string, signal: AbortSignal) => Promise<DecodedImage>;
  readonly createTexture: (img: DecodedImage, info: { assetId: string; level: number }) => T;
  /** Optional: statistics of the level-0 image (called once per asset). */
  readonly analyse?: (img: DecodedImage) => ImageStats | null;
  readonly maxActivationsPerFrame?: number;
}

export interface AssetView<T> {
  /** The texture to draw now (null until the first level arrives). */
  texture: T | null;
  /** Level of `texture`, -1 if none. */
  level: number;
  /** Level the policy wants. */
  wantedLevel: number;
  /** Larger side of the drawn level in pixels. */
  levelSizePx: number;
  stats: ImageStats | null;
  /** Seconds since the first texture became available (for fade-in), or -1. */
  ageSeconds: number;
}

export interface WantOptions {
  /** Larger side of the image as it appears on screen, CSS px. */
  readonly onScreenPx: number;
  readonly devicePixelRatio: number;
  readonly quality: number;
  /** Only the level-0 thumbnail is needed. */
  readonly thumbnailOnly?: boolean;
  readonly nowSeconds: number;
}

interface AssetState<T> {
  asset: DeepImageAsset;
  sizes: number[];
  levelNums: number[];
  wanted: number;
  lowerSince: number;
  lastWantedAt: number;
  lastWantedFrame: number;
  leases: Map<number, Lease<T>>;
  pending: Map<number, AbortController>;
  active: number;
  activatedLevels: Set<number>;
  stats: ImageStats | null;
  statsDone: boolean;
  firstTextureAt: number;
  /** True once the cold purge has run for this asset's idle period. */
  purged: boolean;
  view: AssetView<T>;
}

export class DeepSpaceAssetManager<T extends Disposable = THREE.Texture> {
  private readonly cache: AssetCache<T>;
  private readonly states = new Map<string, AssetState<T>>();
  private readonly assets = new Map<string, DeepImageAsset>();
  private frame = 0;
  private activationsLeft = 1;
  private disposed = false;
  private readonly textureCount = { created: 0, disposed: 0 };
  private readonly statsByKey = new Map<string, ImageStats | null>();
  /** The decoded image behind each created texture, so that a texture that is evicted/cancelled before its first upload still frees its bitmap. */
  private readonly imageOf = new WeakMap<object, DecodedImage>();
  /** True between a WebGL context loss and its restoration: nothing is requested, nothing is drawn from this manager. */
  private contextLost = false;

  constructor(private readonly opts: AssetManagerOptions<T>) {
    this.cache = new AssetCache<T>({
      budgetBytes: opts.budgetBytes ?? DEFAULT_BUDGET_BYTES,
      loader: async (key, signal) => {
        const [assetId, lv] = splitKey(key);
        const asset = this.assets.get(assetId);
        const level = asset?.levels.find((l) => l.level === lv);
        if (!asset || !level) throw new Error(`Unknown image level ${key}`);
        const img = await opts.decode(`${opts.baseUrl}${level.file}`, signal);
        // The abort can arrive while the browser was decoding: free the bitmap now, nothing will ever upload it.
        if (signal.aborted) { img.close?.(); throw new DOMException('aborted', 'AbortError'); }
        let texture: T;
        try {
          if (lv === 0 && opts.analyse) this.statsByKey.set(assetId, opts.analyse(img));
          texture = opts.createTexture(img, { assetId, level: lv });
        } catch (err) { img.close?.(); throw err; }
        this.imageOf.set(texture, img);
        this.textureCount.created++;
        return { value: texture, bytes: Math.floor(level.widthPx * level.heightPx * GPU_BYTES_FACTOR) };
      },
      // Evicted, or arrived after everyone gave up: free the GPU texture AND the decoded bitmap (closing twice is harmless).
      dispose: (_key, texture) => { this.textureCount.disposed++; texture.dispose(); this.imageOf.get(texture)?.close?.(); this.imageOf.delete(texture); },
    });
  }

  registerAssets(assets: readonly DeepImageAsset[]): void {
    for (const a of assets) {
      if (a.levels.length === 0) continue;
      this.assets.set(a.id, a);
    }
  }
  has(assetId: string): boolean { return this.assets.has(assetId); }
  asset(assetId: string): DeepImageAsset | undefined { return this.assets.get(assetId); }

  beginFrame(): void { this.frame++; this.activationsLeft = this.opts.maxActivationsPerFrame ?? 1; }

  /** Declare that `assetId` is needed this frame; returns the view to draw (the same object every call, updated in place). */
  want(assetId: string, o: WantOptions): AssetView<T> | null {
    if (this.disposed || this.contextLost) return null;
    const asset = this.assets.get(assetId);
    if (!asset) return null;
    let st = this.states.get(assetId);
    if (!st) {
      const levels = [...asset.levels].sort((a, b) => a.level - b.level);
      st = {
        asset, sizes: levels.map((l) => Math.max(l.widthPx, l.heightPx)), levelNums: levels.map((l) => l.level), wanted: 0, lowerSince: -1, lastWantedAt: o.nowSeconds, lastWantedFrame: this.frame,
        leases: new Map(), pending: new Map(), active: -1, activatedLevels: new Set(), stats: null, statsDone: false, firstTextureAt: -1, purged: false,
        view: { texture: null, level: -1, wantedLevel: 0, levelSizePx: 0, stats: null, ageSeconds: -1 },
      };
      this.states.set(assetId, st);
    }
    st.lastWantedAt = o.nowSeconds;
    st.lastWantedFrame = this.frame;
    st.purged = false;

    // 1. the level the policy wants, with hysteresis on the way down
    const levelIdx = o.thumbnailOnly ? 0 : selectTextureLevel(st.sizes, o.onScreenPx, o.devicePixelRatio, o.quality);
    const target = st.levelNums[levelIdx] ?? 0;
    if (st.leases.size === 0 && st.pending.size === 0) { st.wanted = target; st.lowerSince = -1; }
    else if (target > st.wanted) { st.wanted = target; st.lowerSince = -1; }
    else if (target < st.wanted) {
      if (st.lowerSince < 0) st.lowerSince = o.nowSeconds;
      else if (o.nowSeconds - st.lowerSince >= DOWNGRADE_HOLD_S) { st.wanted = target; st.lowerSince = -1; }
    } else st.lowerSince = -1;

    // 2. make sure the floor (level 0) and the wanted level are held or loading
    const floor = st.levelNums[0] ?? 0;
    this.ensure(st, floor);
    if (st.wanted !== floor) this.ensure(st, st.wanted);

    // 3. choose what to draw: the wanted level when it is ready, otherwise the closest level that is
    let chosen = -1;
    if (st.leases.has(st.wanted)) chosen = st.wanted;
    else {
      let bestBelow = -1, bestAbove = Infinity;
      for (const lv of st.leases.keys()) { if (lv < st.wanted) bestBelow = Math.max(bestBelow, lv); else bestAbove = Math.min(bestAbove, lv); }
      chosen = bestBelow >= 0 ? bestBelow : Number.isFinite(bestAbove) ? bestAbove : -1;
    }
    if (chosen >= 0 && chosen !== st.active) {
      const firstUse = !st.activatedLevels.has(chosen);
      const big = chosen > floor;
      if (st.active < 0 || !firstUse || !big || this.activationsLeft > 0) {
        if (firstUse && big && st.active >= 0) this.activationsLeft--;
        st.active = chosen;
        st.activatedLevels.add(chosen);
      }
    }
    if (st.active >= 0 && !st.leases.has(st.active)) st.active = chosen;

    // 4. release what is no longer useful
    for (const lv of [...st.leases.keys()]) {
      if (lv === floor || lv === st.active || lv === st.wanted) continue;
      st.leases.get(lv)!.release(); st.leases.delete(lv);
    }
    for (const [lv, ctrl] of [...st.pending]) {
      if (lv !== floor && lv !== st.wanted) { ctrl.abort(); st.pending.delete(lv); }
    }
    // A level above the wanted one that is not on screen any more is also released (handled by the loop above).

    if (!st.statsDone && st.leases.has(floor)) { st.stats = this.statsByKey.get(st.asset.id) ?? null; st.statsDone = true; }
    const v = st.view;
    const lease = st.active >= 0 ? st.leases.get(st.active) : undefined;
    v.texture = lease ? lease.value : null;
    v.level = lease ? st.active : -1;
    v.wantedLevel = st.wanted;
    v.levelSizePx = lease ? (st.sizes[st.levelNums.indexOf(st.active)] ?? 0) : 0;
    v.stats = st.stats;
    if (lease && st.firstTextureAt < 0) st.firstTextureAt = o.nowSeconds;
    v.ageSeconds = st.firstTextureAt < 0 ? -1 : o.nowSeconds - st.firstTextureAt;
    return v;
  }

  /** Call once per frame after all want() calls: assets that were not wanted for IDLE_TTL_S give up their leases. */
  endFrame(nowSeconds: number): void {
    for (const st of this.states.values()) {
      if (st.lastWantedFrame === this.frame) continue;
      if (nowSeconds - st.lastWantedAt > IDLE_TTL_S) this.releaseAll(st);
      if (!st.purged && nowSeconds - st.lastWantedAt > COLD_TTL_S) { st.purged = true; this.cache.clear(); }
    }
  }

  /** Release everything held for an asset (it is no longer drawn). */
  release(assetId: string): void { const st = this.states.get(assetId); if (st) this.releaseAll(st); }

  stats() {
    const c = this.cache.stats();
    return { textureBytes: c.bytes, textures: c.entries, loading: c.loading, referencedBytes: c.referencedBytes, budgetBytes: c.budgetBytes, overBudget: c.overBudget, evictions: c.evictions, created: this.textureCount.created, disposed: this.textureCount.disposed, failures: c.failures, hits: c.hits, misses: c.misses };
  }

  /**
   * WebGL context lost: every GPU texture is gone, and the CPU bitmaps behind them were closed after their first upload (the
   * ImageBitmap cannot be uploaded again). Drop every lease and every load; nothing is requested until `onContextRestored()`.
   */
  onContextLost(): void {
    this.contextLost = true;
    this.invalidateAll();
  }
  /** WebGL context restored: start from an empty cache. The next want() re-decodes each image from its file and creates a fresh texture. */
  onContextRestored(): void {
    this.invalidateAll();
    this.contextLost = false;
  }
  isContextLost(): boolean { return this.contextLost; }

  /** Release every lease, abort every load and dispose every cached texture (referenced or not). Asset registrations and statistics are kept. */
  invalidateAll(): void {
    for (const st of this.states.values()) this.releaseAll(st);
    this.cache.clear();   // all leases are released, so this evicts (and disposes) every texture
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const st of this.states.values()) { for (const c of st.pending.values()) c.abort(); st.pending.clear(); st.leases.clear(); }
    this.cache.destroy();
    this.states.clear();
  }

  private releaseAll(st: AssetState<T>): void {
    for (const l of st.leases.values()) l.release();
    st.leases.clear();
    for (const c of st.pending.values()) c.abort();
    st.pending.clear();
    st.active = -1;
    st.activatedLevels.clear();
    st.view.texture = null; st.view.level = -1; st.view.ageSeconds = -1;
    st.firstTextureAt = -1;
    st.wanted = 0;
    st.lowerSince = -1;
  }

  private ensure(st: AssetState<T>, level: number): void {
    if (st.leases.has(level) || st.pending.has(level)) return;
    const ctrl = new AbortController();
    st.pending.set(level, ctrl);
    this.cache.acquire(`${st.asset.id}#${level}`, { signal: ctrl.signal }).then(
      (lease) => {
        if (st.pending.get(level) === ctrl) st.pending.delete(level);
        if (this.disposed || ctrl.signal.aborted || st.leases.has(level)) { lease.release(); return; }
        st.leases.set(level, lease);
      },
      () => { if (st.pending.get(level) === ctrl) st.pending.delete(level); },
    );
  }
}

function splitKey(key: string): [string, number] {
  const i = key.lastIndexOf('#');
  return [key.slice(0, i), Number(key.slice(i + 1))];
}

// ---- browser implementation (WebGL texture, fetch + createImageBitmap) ----------------------------------------------------

/** Fetch and decode off the main thread where the browser supports it. Orientation is flipped at decode, so texture.flipY stays false. */
export async function decodeImageBitmap(url: string, signal: AbortSignal): Promise<DecodedImage> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const blob = await res.blob();
  if (signal.aborted) throw new DOMException('aborted', 'AbortError');
  const bmp = await createImageBitmap(blob, { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  if (signal.aborted) { bmp.close(); throw new DOMException('aborted', 'AbortError'); }   // aborted while decoding: do not leak the bitmap
  return { width: bmp.width, height: bmp.height, source: bmp, close: () => bmp.close() };
}

export function makeThreeTexture(img: DecodedImage, maxAnisotropy: number): THREE.Texture {
  const t = new THREE.Texture(img.source as ImageBitmap);
  t.colorSpace = THREE.SRGBColorSpace;
  t.flipY = false;
  t.premultiplyAlpha = false;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = maxAnisotropy;
  t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
  // The CPU copy of the bitmap is released right after the first upload (it would double the memory of a 4096 px image).
  t.onUpdate = () => { img.close?.(); t.onUpdate = () => undefined; };
  t.needsUpdate = true;
  return t;
}

/** Mean colour and 95th-percentile luminance of an image, from a 32 px downscale. Linear light. */
export function analyseWithCanvas(img: DecodedImage): ImageStats | null {
  try {
    const w = 32, h = Math.max(1, Math.round((32 * img.height) / img.width));
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) return null;
    ctx.drawImage(img.source as CanvasImageSource, 0, 0, w, h);
    return statsFromRgba(ctx.getImageData(0, 0, w, h).data);
  } catch { return null; }
}

const srgbToLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
export function statsFromRgba(data: ArrayLike<number>): ImageStats {
  const n = Math.floor(data.length / 4);
  const lum = new Float32Array(n);
  let r = 0, g = 0, b = 0, peak = 0;
  for (let i = 0; i < n; i++) {
    const lr = srgbToLinear((data[4 * i] as number) / 255), lg = srgbToLinear((data[4 * i + 1] as number) / 255), lb = srgbToLinear((data[4 * i + 2] as number) / 255);
    r += lr; g += lg; b += lb;
    const l = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
    lum[i] = l; if (l > peak) peak = l;
  }
  const sorted = Array.from(lum).sort((a, c) => a - c);
  const q = (f: number) => sorted[Math.min(n - 1, Math.floor(f * n))] ?? 0;
  const m = Math.max(1, n);
  return { mean: [r / m, g / m, b / m], median: q(0.5), p95: q(0.95), p99: q(0.99), peak };
}

/** The manager used by the application: real fetch + ImageBitmap + THREE.Texture. */
export function createBrowserAssetManager(baseUrl: string, maxAnisotropy: number, budgetBytes = DEFAULT_BUDGET_BYTES): DeepSpaceAssetManager<THREE.Texture> {
  return new DeepSpaceAssetManager<THREE.Texture>({
    baseUrl, budgetBytes,
    decode: decodeImageBitmap,
    createTexture: (img) => makeThreeTexture(img, maxAnisotropy),
    analyse: analyseWithCanvas,
  });
}
