/**
 * Lazy loading of the deep-space point catalogues (public/data/deepspace/<id>.v1.json.gz).
 *
 * Nothing is fetched up front. A renderer calls `want(id, now)` every frame in which the camera is inside the catalogue's
 * relevant range; the first call starts the fetch (at most `maxConcurrent` at a time) and returns undefined until the decoded
 * file is ready, so callers draw nothing and show no error while it loads. A catalogue is decoded once and cached; it is
 * dropped from memory when nobody has wanted it for `releaseAfterSeconds`, or (least recently wanted first) when the byte budget
 * is exceeded. `retain`/`release` pin a catalogue (reference count) for as long as a holder needs the arrays derived from it.
 * A failed load is remembered and retried after `retryAfterSeconds`; it never throws into the render loop.
 */
import type { PointCatalogueFile } from '../../data/deepspace/types';
import { loadPointCatalogue } from '../../data/deepspace/deepSpaceData';

export type PointLoader = (id: string) => Promise<PointCatalogueFile>;

export interface StoreOptions {
  readonly budgetBytes?: number;
  readonly releaseAfterSeconds?: number;
  readonly retryAfterSeconds?: number;
  readonly maxConcurrent?: number;
}

interface Entry {
  file: PointCatalogueFile | null;
  bytes: number;
  loading: boolean;
  /** Bumped on eviction/dispose so a late-arriving fetch of an older request is discarded. */
  generation: number;
  lastWanted: number;
  refs: number;
  failedAt: number;
  error: string | null;
  /** Wall-clock ms the last successful load took (fetch + decompress + parse), when a clock is available. */
  loadMs: number | null;
}

/** Rough resident size of a decoded file: doubles 8 bytes, strings 2 bytes per char + header. */
export function estimateBytes(file: PointCatalogueFile): number {
  let b = 2048;
  for (const col of Object.values(file.columns)) {
    b += 16 + col.length * 8;
    for (let i = 0; i < col.length; i++) { const v = col[i]; if (typeof v === 'string') b += 2 * v.length + 24; }
  }
  return b;
}

export class PointCatalogueStore {
  private readonly entries = new Map<string, Entry>();
  private readonly o: Required<StoreOptions>;
  private active = 0;
  private lastEnd = -Infinity;
  private disposed = false;

  constructor(private readonly loader: PointLoader, opts: StoreOptions = {}) {
    this.o = { budgetBytes: opts.budgetBytes ?? 96 * 1024 * 1024, releaseAfterSeconds: opts.releaseAfterSeconds ?? 20, retryAfterSeconds: opts.retryAfterSeconds ?? 30, maxConcurrent: opts.maxConcurrent ?? 2 };
  }

  private entry(id: string): Entry {
    let e = this.entries.get(id);
    if (!e) { e = { file: null, bytes: 0, loading: false, generation: 0, lastWanted: -Infinity, refs: 0, failedAt: -Infinity, error: null, loadMs: null }; this.entries.set(id, e); }
    return e;
  }

  /** The decoded file if it is resident now; never starts a load. */
  peek(id: string): PointCatalogueFile | undefined { return this.entries.get(id)?.file ?? undefined; }

  /** Mark `id` as needed this frame. Starts the load on first use. Returns the file when resident, else undefined. */
  want(id: string, nowSeconds: number): PointCatalogueFile | undefined {
    if (this.disposed) return undefined;
    const e = this.entry(id);
    e.lastWanted = nowSeconds;
    if (e.file) return e.file;
    if (!e.loading && this.active < this.o.maxConcurrent && nowSeconds - e.failedAt >= this.o.retryAfterSeconds) this.start(id, e);
    return undefined;
  }

  private start(id: string, e: Entry): void {
    e.loading = true; e.error = null; this.active++;
    const gen = e.generation;
    const t0 = typeof performance !== 'undefined' ? performance.now() : null;
    let p: Promise<PointCatalogueFile>;
    try { p = this.loader(id); } catch (err) { p = Promise.reject(err); }
    p.then((file) => {
      this.active--; e.loading = false;
      if (this.disposed || e.generation !== gen) return;
      e.file = file; e.bytes = estimateBytes(file);
      e.loadMs = t0 !== null ? performance.now() - t0 : null;
    }, (err: unknown) => {
      this.active--; e.loading = false;
      if (e.generation !== gen) return;
      e.error = err instanceof Error ? err.message : String(err);
      e.failedAt = this.lastEnd > -Infinity ? this.lastEnd : e.lastWanted;
    });
  }

  /** Pin a resident or loading catalogue: it is not evicted while the count is above zero. */
  retain(id: string): void { this.entry(id).refs++; }
  release(id: string): void { const e = this.entries.get(id); if (e && e.refs > 0) e.refs--; }
  refCount(id: string): number { return this.entries.get(id)?.refs ?? 0; }

  /** Drop unreferenced catalogues not wanted for a while, then (LRU) enough others to meet the byte budget. Returns the evicted ids. */
  endFrame(nowSeconds: number): string[] {
    this.lastEnd = nowSeconds;
    const evicted: string[] = [];
    for (const [id, e] of this.entries) {
      if (e.refs === 0 && e.file && nowSeconds - e.lastWanted > this.o.releaseAfterSeconds) { this.evict(e); evicted.push(id); }
    }
    let total = this.residentBytes();
    if (total > this.o.budgetBytes) {
      const cand = [...this.entries].filter(([, e]) => e.file && e.refs === 0 && nowSeconds - e.lastWanted > 0.5).sort((a, b) => a[1].lastWanted - b[1].lastWanted);
      for (const [id, e] of cand) { if (total <= this.o.budgetBytes) break; total -= e.bytes; this.evict(e); evicted.push(id); }
    }
    return evicted;
  }

  private evict(e: Entry): void { e.file = null; e.bytes = 0; e.generation++; }

  residentBytes(): number { let t = 0; for (const e of this.entries.values()) t += e.bytes; return t; }
  stats(): { resident: string[]; loading: string[]; failed: string[]; bytes: number; loadMs: Record<string, number> } {
    const resident: string[] = [], loading: string[] = [], failed: string[] = [], loadMs: Record<string, number> = {};
    for (const [id, e] of this.entries) { if (e.file) resident.push(id); if (e.loading) loading.push(id); if (e.error) failed.push(id); if (e.loadMs !== null) loadMs[id] = e.loadMs; }
    return { resident, loading, failed, bytes: this.residentBytes(), loadMs };
  }
  errorOf(id: string): string | null { return this.entries.get(id)?.error ?? null; }

  dispose(): void { this.disposed = true; for (const e of this.entries.values()) this.evict(e); }
}

/** The store the application uses: fetches `<base>data/deepspace/<id>.v1.json.gz`. */
export function createBrowserPointStore(baseUrl: string, opts: StoreOptions = {}): PointCatalogueStore {
  return new PointCatalogueStore((id) => loadPointCatalogue(baseUrl, id), opts);
}

// ---- when is a catalogue relevant? -----------------------------------------------------------------------------------------

/**
 * Camera distance from the Sun (pc) between which a Sun-centred catalogue is needed. Outside it the catalogue is not wanted, and
 * after `releaseAfterSeconds` it is dropped. Close to the Sun the real Gaia stars are the truth and these galaxies are not drawn.
 */
export const CATALOGUE_RANGES: Readonly<Record<string, { readonly minCamPc: number; readonly maxCamPc: number }>> = {
  'local-group-mcconnachie': { minCamPc: 5e4, maxCamPc: 4e7 },
  ungc: { minCamPc: 5e5, maxCamPc: 3e8 },
  twomrs: { minCamPc: 3e6, maxCamPc: Infinity },
};
/** Cluster member catalogues are wanted within this many cluster diameters of the cluster centre. */
export const MEMBERS_RANGE_DIAMETERS = 30;

export function sunCatalogueWanted(fileId: string, camFromSunPc: number): boolean {
  const r = CATALOGUE_RANGES[fileId];
  return r !== undefined && camFromSunPc >= r.minCamPc && camFromSunPc <= r.maxCamPc;
}
export function membersWanted(camToClusterPc: number, clusterDiameterPc: number): boolean {
  return camToClusterPc <= MEMBERS_RANGE_DIAMETERS * clusterDiameterPc;
}

/** Column accessors for the shared row/pointRow code. */
export function rowValues(file: PointCatalogueFile, row: number): Record<string, number | string | null> {
  const out: Record<string, number | string | null> = {};
  for (const k of Object.keys(file.columns)) out[k] = file.columns[k]![row] ?? null;
  return out;
}
export function parseRowId(id: string): { fileId: string; row: number } | null {
  const i = id.lastIndexOf(':');
  if (i <= 0) return null;
  const row = Number(id.slice(i + 1));
  if (!Number.isInteger(row) || row < 0) return null;
  return { fileId: id.slice(0, i), row };
}
