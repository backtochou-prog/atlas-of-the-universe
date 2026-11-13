import * as THREE from 'three';
import type { TextureProvenanceEntry } from '../../data/solar/solarCatalogue';

export type TextureLevel = '512' | '2k';

interface Slot { texture: THREE.Texture | null; loading: boolean; lastUsed: number; bytes: number; failed: boolean }

/**
 * Lazy, reference-free texture cache. A texture is requested only when a body is large enough on screen to need it, at
 * the smallest adequate resolution, and is disposed after `ttlSeconds` without use. Nothing is loaded up front.
 */
export class TextureManager {
  private readonly slots = new Map<string, Slot>();
  private readonly loader = new THREE.TextureLoader();
  private readonly byId = new Map<string, TextureProvenanceEntry>();
  loadedCount = 0;
  estimatedBytes = 0;

  constructor(private readonly baseUrl: string, entries: readonly TextureProvenanceEntry[], private readonly maxAnisotropy = 8, private readonly ttlSeconds = 15) {
    for (const e of entries) this.byId.set(e.id, e);
  }

  entry(id: string): TextureProvenanceEntry | undefined { return this.byId.get(id); }
  has(id: string): boolean { return this.byId.has(id); }

  /** Longitude (radians) at the left edge of the map, from the provenance record. */
  lonLeftRadians(id: string): number {
    const lon = (this.byId.get(id) as unknown as { lon_left_deg?: number } | undefined)?.lon_left_deg;
    return ((lon ?? -180) * Math.PI) / 180;
  }

  ringRadiiMetres(id: string): [number, number] | null {
    const cal = (this.byId.get(id) as unknown as { ring_calibration?: { inner_km: number; outer_km: number } } | undefined)?.ring_calibration;
    return cal ? [cal.inner_km * 1000, cal.outer_km * 1000] : null;
  }

  /** The texture at the requested level if loaded, else any loaded level (so a body never flashes blank), else null while loading. */
  get(id: string, level: TextureLevel, nowSeconds: number, kind: 'colour' | 'data' = 'colour'): THREE.Texture | null {
    const entry = this.byId.get(id);
    if (!entry) return null;
    // Maps have outputs per resolution ({file}); the ring strip has a single PNG path string.
    const outs = entry.outputs as Record<string, { file: string } | string> | undefined;
    const out = outs?.[level] ?? outs?.['png'];
    const file = typeof out === 'string' ? out : out?.file;
    if (!file) return null;
    const key = `${id}:${level}`;
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { texture: null, loading: false, lastUsed: nowSeconds, bytes: 0, failed: false };
      this.slots.set(key, slot);
    }
    slot.lastUsed = nowSeconds;
    if (!slot.texture && !slot.loading && !slot.failed) {
      slot.loading = true;
      this.loader.load(`${this.baseUrl}${file}`, (t) => {
        t.colorSpace = kind === 'colour' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        t.anisotropy = this.maxAnisotropy;
        t.generateMipmaps = true;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
        slot!.texture = t; slot!.loading = false;
        slot!.bytes = t.image.width * t.image.height * 4 * 1.33;
        this.loadedCount++; this.estimatedBytes += slot!.bytes;
      }, undefined, () => { slot!.loading = false; slot!.failed = true; });
    }
    if (slot.texture) return slot.texture;
    for (const other of ['2k', '512'] as const) {
      const s = this.slots.get(`${id}:${other}`);
      if (s?.texture) { s.lastUsed = nowSeconds; return s.texture; }
    }
    return null;
  }

  /** Dispose textures not used within the TTL. Returns how many were released. */
  sweep(nowSeconds: number): number {
    let n = 0;
    for (const [key, s] of this.slots) {
      if (s.texture && nowSeconds - s.lastUsed > this.ttlSeconds) {
        s.texture.dispose(); this.estimatedBytes -= s.bytes; this.loadedCount--;
        this.slots.delete(key); n++;
      }
    }
    return n;
  }

  dispose(): void { for (const s of this.slots.values()) s.texture?.dispose(); this.slots.clear(); this.loadedCount = 0; this.estimatedBytes = 0; }
}
