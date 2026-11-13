/**
 * Atlas staging and status (Prompt 07, R2a): the engine on the calling thread with REAL data files and injected failures / delays. Covers the scheduler's slicing,
 * the order in which things become available, degradation when datasets fail, and the absence of unhandled rejections.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInlineAtlas } from '../src/discovery/atlas';
import type { AtlasStatus } from '../src/discovery/engineApi';
import { runSliced } from '../src/discovery/scheduler';
import { have } from './fixtures/discovery/real';
import { FileDataSource } from './fixtures/discovery/source';

describe('runSliced', () => {
  it('processes every item once, in order, and keeps each slice near the target using a fake clock', async () => {
    let clock = 0;
    const seen: number[] = [];
    const items = Array.from({ length: 5000 }, (_, i) => i);
    // each item costs 0.05 ms of fake time
    const stats = await runSliced(items, (batch) => { for (const x of batch) seen.push(x); clock += batch.length * 0.05; }, { targetMs: 8, now: () => clock, initialBatch: 10, yield: async () => { clock += 0.01; } });
    expect(seen).toEqual(items);
    expect(stats.items).toBe(5000);
    expect(stats.slices).toBeGreaterThan(20);                      // 250 ms of work cannot fit in a few slices of 8 ms
    expect(stats.maxSliceMs).toBeLessThanOrEqual(8.5);             // the adaptive batch size converges below the target
    expect(stats.aborted).toBe(false);
  });
  it('yields between slices (other tasks run) and can be stopped', async () => {
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 1);
    const items = Array.from({ length: 300 }, (_, i) => i);
    let done = 0;
    const stats = await runSliced(items, (b) => { const t = performance.now(); while (performance.now() - t < 1) { /* spin 1 ms per slice */ } done += b.length; }, { targetMs: 1, minBatch: 1, maxBatch: 5, shouldStop: () => done >= 100 });
    clearInterval(timer);
    expect(stats.aborted).toBe(true);
    expect(done).toBeGreaterThanOrEqual(100);
    expect(done).toBeLessThan(300);
    expect(ticks).toBeGreaterThan(0);                              // the interval ran in between: the loop does yield
  });
  it('an empty list is a no-op', async () => {
    const s = await runSliced([], () => { throw new Error('never'); });
    expect(s.items).toBe(0);
    expect(s.slices).toBe(0);
  });
});

const NEED = ['bright-stars.v1.json.gz', 'solar-system.v1.json', 'deep-space.v1.json', 'deepspace/ungc.v1.json.gz', 'deepspace/local-group-mcconnachie.v1.json.gz', 'other-objects.v1.json', 'discovery-notes.v1.json', 'relations.v1.json'];
const missing = NEED.filter((f) => !have(f));

describe.skipIf(missing.length > 0)(`atlas staging with failing datasets${missing.length ? ` (SKIPPED: missing ${missing.join(', ')})` : ''}`, () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown): void => { unhandled.push(e); };
  const timeline: { t: number; s: AtlasStatus }[] = [];
  const src = new FileDataSource({ fail: ['gaia', 'simbad', 'exoplanets', 'twomrs'], delayMs: { 'bright-stars': 60, ungc: 60 } });
  const atlas = createInlineAtlas(src);
  let first: AtlasStatus | undefined;

  beforeAll(async () => {
    process.on('unhandledRejection', onUnhandled);
    first = atlas.status;
    const t0 = performance.now();
    atlas.onStatus((s) => timeline.push({ t: performance.now() - t0, s }));
    await atlas.start();
  }, 120_000);
  afterAll(() => { process.off('unhandledRejection', onUnhandled); });

  it('starts idle with every dataset pending or unknown, not ready', () => {
    expect(first!.readyForSearch).toBe(false);
    expect(first!.complete).toBe(false);
  });

  it('search is available (stage 0) before the stage 1 datasets are in', () => {
    const firstSearchable = timeline.find((x) => x.s.readyForSearch);
    expect(firstSearchable).toBeDefined();
    const st = firstSearchable!.s;
    expect(st.datasets.find((d) => d.key === 'bright-stars')!.state).not.toBe('ready');        // Hipparcos had not arrived yet (delayed 60 ms)
    expect(st.readyForQueries).toBe(false);
    expect(st.complete).toBe(false);
  });

  it('the queries (nearby, filters, lists) become available at stage 1, and completion comes last', () => {
    const q = timeline.find((x) => x.s.readyForQueries)!;
    const c = timeline.find((x) => x.s.complete)!;
    expect(q).toBeDefined();
    expect(c.t).toBeGreaterThanOrEqual(q.t);
    expect(c.s.progress).toBe(1);
  });

  it('progress never goes backwards and stays within 0..1', () => {
    let prev = 0;
    for (const { s } of timeline) { expect(s.progress).toBeGreaterThanOrEqual(prev - 1e-9); expect(s.progress).toBeLessThanOrEqual(1); prev = s.progress; }
  });

  it('failed datasets are reported with the reason; the others are ready with counts', () => {
    const s = atlas.status;
    expect([...s.failed].sort()).toEqual(['exoplanets', 'gaia', 'simbad', 'twomrs']);
    const gaia = s.datasets.find((d) => d.key === 'gaia')!;
    expect(gaia.state).toBe('failed');
    expect(gaia.error).toMatch(/injected failure/);
    for (const k of ['solar', 'deep', 'bright-stars', 'other-objects', 'relations', 'ungc', 'mcconnachie', 'notes'] as const) {
      const d = s.datasets.find((x) => x.key === k)!;
      expect(d.state, k).toBe('ready');
      expect(d.count, k).toBeGreaterThan(0);
    }
    expect(s.complete).toBe(true);
    expect(s.readyForSearch && s.readyForQueries).toBe(true);
  });

  it('search degrades: what loaded is found, what failed is not, nothing throws', async () => {
    expect((await atlas.search('Sirius')).hits[0]!.id).toBe('hip:32349');
    expect((await atlas.search('Europa')).hits[0]!.id).toBe('solar:europa');
    expect((await atlas.search('Sagittarius A*')).hits[0]!.id).toBe('other:sgr-a-star');
    expect((await atlas.search('Kepler-452b')).hits.some((h) => h.id.startsWith('exo:'))).toBe(false);        // the exoplanet archive failed
    expect((await atlas.search('2MASX J12262708+3113247')).hits.some((h) => h.id.startsWith('point:twomrs'))).toBe(false);
  });

  it('nearby, filters and facets work on the datasets that loaded', async () => {
    const n = await atlas.nearby({ origin: 'hip:32349', k: 3 });
    expect(n.ok).toBe(true);
    if (n.ok) { expect(n.neighbours).toHaveLength(3); expect(n.neighbours.every((x) => x.distanceMetres > 0)).toBe(true); }
    const f = await atlas.facets();
    expect(f).not.toBeNull();
    expect(f!.total).toBe(atlas.status.records);
    const fl = await atlas.filter({ categories: ['star'], ranges: { apparentMag: { max: 1 } } });
    expect(fl!.ids).toContain('hip:32349');
    expect(fl!.complete).toBe(true);
  });

  it('a failure to load the notes does not stop anything either', async () => {
    const a2 = createInlineAtlas(new FileDataSource({ fail: ['notes', 'gaia', 'simbad', 'exoplanets', 'bright-stars', 'twomrs', 'ungc', 'mcconnachie', 'other-objects', 'relations'] }));
    await a2.start();
    expect(a2.status.datasets.find((d) => d.key === 'notes')!.state).toBe('failed');
    expect(a2.noteFor('hip:32349')).toBeUndefined();
    expect((await a2.search('Europa')).hits[0]!.id).toBe('solar:europa');         // Solar System and deep space alone still make an atlas
    expect(a2.status.complete).toBe(true);
    const sug = await a2.suggest('');
    expect(sug.kind).toBe('empty');
  }, 60_000);

  it('no unhandled rejection happened anywhere', () => { expect(unhandled).toEqual([]); });
});
