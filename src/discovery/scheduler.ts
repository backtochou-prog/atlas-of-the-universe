/**
 * Cooperative time slicing (Prompt 07, R2a). Used by the discovery engine for every loop that can be cut into pieces (SearchIndex.add, record
 * hand-over); work that cannot be cut (an adapter over a whole catalogue, mergeRecords, RecordStore.from) runs in the Web Worker instead
 * (workerEngine.ts) so it never blocks the page.
 *
 * runSliced processes `items` in batches whose size ADAPTS to the measured cost per item so that one slice lasts about `targetMs` (default 8 ms,
 * half a 60 Hz frame), then yields to the event loop. A slice never contains less than `minBatch` items, so a single very slow item is the lower bound.
 * The statistics (slices, longest slice) are returned so callers and tests can state what the main thread actually experienced.
 *
 * Yield strategies:
 *   macrotaskYield  setImmediate (node) -> MessageChannel (browsers: no 4 ms timer clamping) -> setTimeout(0). For Workers and node.
 *   idleYield       requestIdleCallback with a timeout, falling back to macrotaskYield. For main-thread use ("lowest priority": runs only when the page is idle,
 *                   but never later than `timeoutMs`, so indexing still progresses while the user keeps interacting).
 */
export type Yielder = () => Promise<void>;

interface Chan { port1: MessagePort; port2: MessagePort }
let channel: Chan | null = null;
const waiters: (() => void)[] = [];

/** Resolve on the next macrotask. */
export function macrotaskYield(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof setImmediate === 'function') { setImmediate(resolve); return; }       // node: does not starve timers the way a busy MessagePort can
    if (typeof MessageChannel !== 'undefined') {
      if (channel === null) {
        const c = new MessageChannel();
        c.port1.onmessage = () => { const w = waiters.shift(); if (w) w(); };
        (c.port1 as unknown as { unref?: () => void }).unref?.();     // node: do not keep the process alive
        channel = c;
      }
      waiters.push(resolve);
      channel.port2.postMessage(0);
      return;
    }
    setTimeout(resolve, 0);
  });
}

/** Resolve when the browser is idle, or after `timeoutMs` at the latest. Falls back to macrotaskYield where requestIdleCallback does not exist. */
export function idleYield(timeoutMs = 120): Yielder {
  return () => new Promise<void>((resolve) => {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (typeof ric === 'function') { ric(() => resolve(), { timeout: timeoutMs }); return; }
    void macrotaskYield().then(resolve);
  });
}

export interface SliceOptions {
  /** Target duration of one slice, ms. Default 8. */
  readonly targetMs?: number;
  readonly initialBatch?: number;
  readonly minBatch?: number;
  readonly maxBatch?: number;
  readonly yield?: Yielder;
  /** Clock, injectable for tests. Default performance.now. */
  readonly now?: () => number;
  /** Called after every slice with the number of items done so far. */
  readonly onProgress?: (done: number, total: number) => void;
  /** Return true to stop early (the stats then have `aborted: true`). */
  readonly shouldStop?: () => boolean;
}

export interface SliceStats {
  readonly items: number;
  readonly slices: number;
  readonly totalMs: number;
  /** The longest single slice, ms: the longest the thread was blocked by this loop. */
  readonly maxSliceMs: number;
  readonly aborted: boolean;
}

const defaultNow = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export async function runSliced<T>(items: readonly T[], work: (batch: readonly T[], from: number) => void, opts: SliceOptions = {}): Promise<SliceStats> {
  const now = opts.now ?? defaultNow;
  const target = Math.max(0.5, opts.targetMs ?? 8);
  const minB = Math.max(1, Math.floor(opts.minBatch ?? 1));
  const maxB = Math.max(minB, Math.floor(opts.maxBatch ?? 20_000));
  const yielder = opts.yield ?? macrotaskYield;
  let batch = Math.min(maxB, Math.max(minB, Math.floor(opts.initialBatch ?? 100)));
  let done = 0, slices = 0, maxSlice = 0;
  const t0 = now();
  let aborted = false;
  while (done < items.length) {
    if (opts.shouldStop?.()) { aborted = true; break; }
    const end = Math.min(items.length, done + batch);
    const s = now();
    work(items.slice(done, end), done);
    const ms = Math.max(0, now() - s);
    const n = end - done;
    done = end;
    slices++;
    if (ms > maxSlice) maxSlice = ms;
    // next batch: aim at 90% of the target using the measured cost per item (smoothed so one noisy slice does not whipsaw the size)
    const perItem = ms / n;
    if (perItem > 0) {
      const want = Math.floor((0.9 * target) / perItem);
      batch = Math.min(maxB, Math.max(minB, Math.round(0.5 * batch + 0.5 * want)));
    } else batch = Math.min(maxB, batch * 2);
    opts.onProgress?.(done, items.length);
    if (done < items.length) await yielder();
  }
  return { items: done, slices, totalMs: now() - t0, maxSliceMs: maxSlice, aborted };
}
