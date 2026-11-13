import { describe, expect, it } from 'vitest';
import { AssetCache, type Loaded } from '../src/core/deepspace/assetCache';

interface Probe { loads: string[]; disposed: string[]; pending: Map<string, { resolve(l: Loaded<string>): void; reject(e: unknown): void; signal: AbortSignal }> }
function setup(budget: number, mode: 'immediate' | 'manual' = 'immediate', sizes: Record<string, number> = {}) {
  const probe: Probe = { loads: [], disposed: [], pending: new Map() };
  const cache = new AssetCache<string>({
    budgetBytes: budget,
    loader: (key, signal) => {
      probe.loads.push(key);
      if (mode === 'immediate') return Promise.resolve({ value: `v:${key}`, bytes: sizes[key] ?? 100 });
      return new Promise((resolve, reject) => probe.pending.set(key, { resolve, reject, signal }));
    },
    dispose: (key) => { probe.disposed.push(key); },
  });
  return { cache, probe };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('AssetCache', () => {
  it('loads once, serves hits, and reports stats', async () => {
    const { cache, probe } = setup(1000);
    const a = await cache.acquire('a'); const b = await cache.acquire('a');
    expect(a.value).toBe('v:a'); expect(probe.loads).toEqual(['a']);
    expect(cache.refCount('a')).toBe(2);
    const s = cache.stats();
    expect(s).toMatchObject({ entries: 1, bytes: 100, hits: 1, misses: 1, referencedBytes: 100, overBudget: false });
    a.release(); b.release(); b.release(); // double release is harmless
    expect(cache.refCount('a')).toBe(0);
  });

  it('evicts least-recently-used unreferenced entries to meet the byte budget, in order', async () => {
    const { cache, probe } = setup(300);
    for (const k of ['a', 'b', 'c']) (await cache.acquire(k)).release();
    expect(cache.stats().bytes).toBe(300);
    (await cache.acquire('a')).release(); // a is now most recent: order b, c, a
    expect(cache.keysByRecency()).toEqual(['b', 'c', 'a']);
    (await cache.acquire('d')).release();
    expect(probe.disposed).toEqual(['b']);
    (await cache.acquire('e')).release();
    expect(probe.disposed).toEqual(['b', 'c']);
    expect(cache.has('a')).toBe(true);
    expect(cache.stats().evictions).toBe(2);
  });

  it('never evicts a referenced entry, even over budget, then evicts after release', async () => {
    const { cache, probe } = setup(150);
    const a = await cache.acquire('a');
    const b = await cache.acquire('b'); // 200 > 150, both referenced
    expect(probe.disposed).toEqual([]);
    expect(cache.stats().overBudget).toBe(true);
    const c = await cache.acquire('c');
    expect(probe.disposed).toEqual([]);
    a.release();
    expect(probe.disposed).toEqual(['a']);
    expect(cache.has('b')).toBe(true); expect(cache.has('c')).toBe(true);
    b.release(); c.release();
    expect(probe.disposed).toEqual(['a', 'b']); // 100 left <= 150
    expect(cache.stats().overBudget).toBe(false);
  });

  it('respects different sizes', async () => {
    const { cache, probe } = setup(500, 'immediate', { big: 450, s1: 100 });
    (await cache.acquire('big')).release();
    (await cache.acquire('s1')).release();
    expect(probe.disposed).toEqual(['big']);
  });

  it('de-duplicates concurrent loads', async () => {
    const { cache, probe } = setup(1000, 'manual');
    const p1 = cache.acquire('x'), p2 = cache.acquire('x'), p3 = cache.acquire('x');
    expect(probe.loads).toEqual(['x']);
    probe.pending.get('x')!.resolve({ value: 'X', bytes: 10 });
    const [l1, l2, l3] = await Promise.all([p1, p2, p3]);
    expect([l1.value, l2.value, l3.value]).toEqual(['X', 'X', 'X']);
    expect(cache.refCount('x')).toBe(3);
    expect(cache.stats()).toMatchObject({ misses: 1, dedupedLoads: 2, entries: 1, loading: 0 });
  });

  it('cancels the load when every acquirer aborts; a late value is disposed once and never cached', async () => {
    const { cache, probe } = setup(1000, 'manual');
    const c1 = new AbortController(), c2 = new AbortController();
    const p1 = cache.acquire('x', { signal: c1.signal }); const p2 = cache.acquire('x', { signal: c2.signal });
    c1.abort();
    await expect(p1).rejects.toMatchObject({ name: 'AbortError' });
    expect(probe.pending.get('x')!.signal.aborted).toBe(false); // someone still wants it
    c2.abort();
    await expect(p2).rejects.toMatchObject({ name: 'AbortError' });
    expect(probe.pending.get('x')!.signal.aborted).toBe(true);
    probe.pending.get('x')!.resolve({ value: 'late', bytes: 10 });
    await tick();
    expect(probe.disposed).toEqual(['x']);
    expect(cache.has('x')).toBe(false);
    expect(cache.stats()).toMatchObject({ entries: 0, bytes: 0, cancelled: 1 });
  });

  it('an already-aborted signal rejects without loading', async () => {
    const { cache, probe } = setup(1000);
    const c = new AbortController(); c.abort();
    await expect(cache.acquire('x', { signal: c.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(probe.loads).toEqual([]);
  });

  it('a failed load rejects all waiters, is not cached, and can be retried', async () => {
    const { cache, probe } = setup(1000, 'manual');
    const p1 = cache.acquire('x'), p2 = cache.acquire('x');
    probe.pending.get('x')!.reject(new Error('boom'));
    await expect(p1).rejects.toThrow('boom'); await expect(p2).rejects.toThrow('boom');
    expect(cache.refCount('x')).toBe(0); expect(cache.stats().failures).toBe(1);
    const p3 = cache.acquire('x');
    expect(probe.loads).toEqual(['x', 'x']);
    probe.pending.get('x')!.resolve({ value: 'ok', bytes: 5 });
    expect((await p3).value).toBe('ok');
  });

  it('calls dispose exactly once per loaded value across eviction, clear and destroy', async () => {
    const { cache, probe } = setup(100);
    (await cache.acquire('a')).release();
    (await cache.acquire('b')).release(); // evicts a
    const c = await cache.acquire('c'); // evicts b? c referenced
    cache.clear(); // c is referenced: survives
    expect(probe.disposed).toEqual(['a', 'b']);
    c.release(); // over budget? 100 <= 100, stays
    cache.clear();
    expect(probe.disposed).toEqual(['a', 'b', 'c']);
    (await cache.acquire('d')).release();
    cache.destroy(); cache.destroy();
    expect(probe.disposed).toEqual(['a', 'b', 'c', 'd']);
    await expect(cache.acquire('e')).rejects.toThrow(/destroyed/);
    const counts = new Map<string, number>(); for (const k of probe.disposed) counts.set(k, (counts.get(k) ?? 0) + 1);
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
  });

  it('rejects an invalid byte size from the loader and disposes the value', async () => {
    const cache = new AssetCache<string>({ budgetBytes: 100, loader: async () => ({ value: 'v', bytes: -1 }), dispose: (k) => { disposed.push(k); } });
    const disposed: string[] = [];
    await expect(cache.acquire('k')).rejects.toThrow(/byte size/);
    expect(disposed).toEqual(['k']);
  });
});
