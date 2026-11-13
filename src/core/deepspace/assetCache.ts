/**
 * Byte-budget LRU cache with reference counting. Pure logic: the loader is injected (texture decode, fetch, anything).
 *
 * - acquire(key) returns a Lease. While at least one lease is held the entry can never be evicted.
 * - Unreferenced entries are evicted least-recently-used first whenever the total exceeds the budget. Referenced entries
 *   may push the cache over budget; that is reported in stats (`overBudget`), never "fixed" by freeing something in use.
 * - Concurrent acquires of one key share one load (in-flight de-duplication).
 * - If every acquirer of a loading key gives up (AbortSignal), the loader's signal is aborted; a value that arrives late
 *   is disposed immediately and never cached.
 * - dispose(key, value) is called exactly once per loaded value (eviction, clear, destroy, or late arrival after abort).
 * - A failed load is not cached; the next acquire retries.
 */
export interface Loaded<T> { readonly value: T; readonly bytes: number }
export type Loader<T> = (key: string, signal: AbortSignal) => Promise<Loaded<T>>;
export interface AssetCacheOptions<T> {
  readonly budgetBytes: number;
  readonly loader: Loader<T>;
  readonly dispose?: (key: string, value: T) => void;
}
export interface Lease<T> { readonly key: string; readonly value: T; readonly bytes: number; release(): void }
export interface CacheStats {
  readonly entries: number;
  readonly loading: number;
  readonly bytes: number;
  readonly referencedBytes: number;
  readonly budgetBytes: number;
  readonly overBudget: boolean;
  readonly hits: number;
  readonly misses: number;
  readonly dedupedLoads: number;
  readonly evictions: number;
  readonly cancelled: number;
  readonly failures: number;
}
export class CacheAbortError extends Error { constructor(key: string) { super(`Load of "${key}" was cancelled`); this.name = 'AbortError'; } }

interface Waiter<T> { resolve(l: Lease<T>): void; reject(e: unknown): void; detach?: () => void; done: boolean }
interface Entry<T> {
  key: string;
  state: 'loading' | 'ready';
  refs: number;
  bytes: number;
  value?: T;
  lastUsed: number;
  controller: AbortController;
  waiters: Waiter<T>[];
  cancelled: boolean;
}

export class AssetCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private clock = 0;
  private totalBytes = 0;
  private s = { hits: 0, misses: 0, deduped: 0, evictions: 0, cancelled: 0, failures: 0 };
  private destroyed = false;

  constructor(private readonly opts: AssetCacheOptions<T>) {
    if (!(opts.budgetBytes >= 0)) throw new RangeError('budgetBytes must be >= 0');
  }

  acquire(key: string, o: { signal?: AbortSignal } = {}): Promise<Lease<T>> {
    if (this.destroyed) return Promise.reject(new Error('AssetCache destroyed'));
    if (o.signal?.aborted) return Promise.reject(new CacheAbortError(key));
    let e = this.entries.get(key);
    if (e && e.state === 'ready') {
      this.s.hits++;
      e.refs++;
      e.lastUsed = ++this.clock;
      return Promise.resolve(this.lease(e));
    }
    if (e) this.s.deduped++;
    else {
      this.s.misses++;
      e = this.startLoad(key);
    }
    e.refs++;
    const entry = e;
    return new Promise<Lease<T>>((resolve, reject) => {
      const w: Waiter<T> = { resolve, reject, done: false };
      if (o.signal) {
        const onAbort = () => {
          if (w.done) return;
          w.done = true;
          entry.waiters = entry.waiters.filter((x) => x !== w);
          entry.refs--;
          reject(new CacheAbortError(key));
          if (entry.refs === 0 && entry.state === 'loading') this.cancelLoad(entry);
        };
        o.signal.addEventListener('abort', onAbort, { once: true });
        w.detach = () => o.signal!.removeEventListener('abort', onAbort);
      }
      entry.waiters.push(w);
    });
  }

  /** Cached value without taking a reference or touching recency. For diagnostics and tests. */
  peek(key: string): T | undefined { const e = this.entries.get(key); return e?.state === 'ready' ? e.value : undefined; }
  has(key: string): boolean { return this.entries.get(key)?.state === 'ready'; }
  refCount(key: string): number { return this.entries.get(key)?.refs ?? 0; }
  /** Keys of ready entries, least recently used first. */
  keysByRecency(): string[] {
    return [...this.entries.values()].filter((e) => e.state === 'ready').sort((a, b) => a.lastUsed - b.lastUsed).map((e) => e.key);
  }

  /** Evict every unreferenced entry. */
  clear(): void {
    for (const e of [...this.entries.values()]) if (e.state === 'ready' && e.refs === 0) this.evict(e);
  }

  /** Dispose everything, including referenced entries (leases become dangling), cancel loads, refuse further use. */
  destroy(): void {
    this.destroyed = true;
    for (const e of [...this.entries.values()]) {
      if (e.state === 'loading') {
        for (const w of e.waiters) { w.done = true; w.detach?.(); w.reject(new CacheAbortError(e.key)); }
        e.waiters = [];
        this.cancelLoad(e);
      } else this.evict(e, false);
    }
  }

  stats(): CacheStats {
    let referencedBytes = 0, loading = 0, ready = 0;
    for (const e of this.entries.values()) {
      if (e.state === 'loading') loading++;
      else { ready++; if (e.refs > 0) referencedBytes += e.bytes; }
    }
    return {
      entries: ready, loading, bytes: this.totalBytes, referencedBytes, budgetBytes: this.opts.budgetBytes,
      overBudget: this.totalBytes > this.opts.budgetBytes,
      hits: this.s.hits, misses: this.s.misses, dedupedLoads: this.s.deduped, evictions: this.s.evictions, cancelled: this.s.cancelled, failures: this.s.failures,
    };
  }

  // ---- internals ----

  private startLoad(key: string): Entry<T> {
    const e: Entry<T> = { key, state: 'loading', refs: 0, bytes: 0, lastUsed: ++this.clock, controller: new AbortController(), waiters: [], cancelled: false };
    this.entries.set(key, e);
    let p: Promise<Loaded<T>>;
    try { p = this.opts.loader(key, e.controller.signal); } catch (err) { p = Promise.reject(err); }
    p.then(
      (loaded) => this.finishLoad(e, loaded),
      (err) => this.failLoad(e, err),
    );
    return e;
  }

  private finishLoad(e: Entry<T>, loaded: Loaded<T>): void {
    if (e.cancelled || this.destroyed) {
      this.opts.dispose?.(e.key, loaded.value); // arrived after everyone gave up: never cached, disposed once
      return;
    }
    if (!(loaded.bytes >= 0) || !Number.isFinite(loaded.bytes)) {
      this.opts.dispose?.(e.key, loaded.value);
      this.failLoad(e, new Error(`Loader for "${e.key}" returned an invalid byte size ${loaded.bytes}`));
      return;
    }
    e.state = 'ready';
    e.value = loaded.value;
    e.bytes = loaded.bytes;
    e.lastUsed = ++this.clock;
    this.totalBytes += e.bytes;
    const waiters = e.waiters;
    e.waiters = [];
    for (const w of waiters) { if (w.done) continue; w.done = true; w.detach?.(); w.resolve(this.lease(e)); }
    this.enforceBudget();
  }

  private failLoad(e: Entry<T>, err: unknown): void {
    if (e.cancelled) return;
    this.s.failures++;
    if (this.entries.get(e.key) === e) this.entries.delete(e.key);
    for (const w of e.waiters) { if (w.done) continue; w.done = true; w.detach?.(); w.reject(err); }
    e.waiters = [];
  }

  private cancelLoad(e: Entry<T>): void {
    e.cancelled = true;
    this.s.cancelled++;
    if (this.entries.get(e.key) === e) this.entries.delete(e.key);
    e.controller.abort();
  }

  private lease(e: Entry<T>): Lease<T> {
    let released = false;
    return {
      key: e.key, value: e.value as T, bytes: e.bytes,
      release: () => {
        if (released) return;
        released = true;
        e.refs--;
        e.lastUsed = ++this.clock;
        this.enforceBudget();
      },
    };
  }

  private enforceBudget(): void {
    if (this.totalBytes <= this.opts.budgetBytes) return;
    const victims = [...this.entries.values()].filter((e) => e.state === 'ready' && e.refs === 0).sort((a, b) => a.lastUsed - b.lastUsed);
    for (const v of victims) {
      if (this.totalBytes <= this.opts.budgetBytes) break;
      this.evict(v);
    }
  }

  private evict(e: Entry<T>, count = true): void {
    this.entries.delete(e.key);
    this.totalBytes -= e.bytes;
    if (count) this.s.evictions++;
    this.opts.dispose?.(e.key, e.value as T);
  }
}
