/**
 * Scale and timing checks on a synthetic 250,000-record index (tests/fixtures/discovery/synthetic.ts: fake data, real scale).
 *
 * The machine these run on is shared and noisy, so the asserted bounds are LOOSE multiples of the targets (build < 2 s, query p95 < 8 ms,
 * filter < 20 ms); the measured values are printed and are what docs/DISCOVERY_ENGINE.md quotes. A failure here means an order-of-magnitude
 * regression (for example a per-keystroke scan), not noise.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { availableFacets, evaluateFilter } from '../src/discovery/filters';
import { RecordStore } from '../src/discovery/recordStore';
import { SearchIndex } from '../src/discovery/searchIndex';
import { KdTree, buildSpatialIndex } from '../src/discovery/spatialIndex';
import type { DiscoveryRecord } from '../src/discovery/types';
import { mulberry32, syntheticRecords } from './fixtures/discovery/synthetic';

const N = 250_000;
const ms = (f: () => void): number => { const t = performance.now(); f(); return performance.now() - t; };
const pct = (a: number[], p: number): number => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]!; };
const report = (label: string, a: number[]): string => `${label}: n=${a.length} p50=${pct(a, 0.5).toFixed(3)} ms p95=${pct(a, 0.95).toFixed(3)} ms p99=${pct(a, 0.99).toFixed(3)} ms max=${Math.max(...a).toFixed(2)} ms`;

let records: DiscoveryRecord[] = [];
let words: string[] = [];
let index: SearchIndex;
let buildMs = 0;
let store: RecordStore;
let storeMs = 0;

beforeAll(() => {
  const g = syntheticRecords({ count: N, seed: 3, namedFraction: 0.04, words: 3000 });
  records = g.records; words = g.words;
  index = new SearchIndex();
  buildMs = ms(() => { index.add(records); });
  storeMs = ms(() => { store = RecordStore.from(records); });
  console.log(`[perf] ${N.toLocaleString('en-US')} records, ${index.stats().entries.toLocaleString('en-US')} designation entries, ${index.stats().tokens.toLocaleString('en-US')} indexed words`);
  console.log(`[perf] search index build ${buildMs.toFixed(0)} ms (single add); record store build ${storeMs.toFixed(0)} ms`);
}, 120_000);

describe('250k-record search index', () => {
  it('builds (target < 2 s on an idle machine; asserted loosely)', () => {
    expect(index.size).toBe(N);
    expect(buildMs).toBeLessThan(15_000);
  });

  it('keystroke-by-keystroke queries: p95 stays small (target < 8 ms)', { timeout: 120_000 }, () => {
    const rnd = mulberry32(77);
    const times: number[] = [];
    for (let s = 0; s < 400; s++) {
      const r = records[Math.floor(rnd() * records.length)]!;
      const text = r.designations[Math.floor(rnd() * r.designations.length)]!;
      for (let len = 3; len <= Math.min(text.length, 14); len++) {
        const q = text.slice(0, len);
        let hits = 0;
        times.push(ms(() => { hits = index.search(q).hits.length; }));
        if (len === text.length) expect(hits).toBeGreaterThan(0);
      }
    }
    console.log(`[perf] ${report('keystroke prefixes of designations', times)}`);
    expect(pct(times, 0.95)).toBeLessThan(30);
    expect(pct(times, 0.5)).toBeLessThan(8);
  });

  it('name queries: exact words, prefixes, substrings, typos', { timeout: 120_000 }, () => {
    const rnd = mulberry32(78);
    const times: number[] = [];
    let found = 0;
    for (let i = 0; i < 600; i++) {
      const w = words[Math.floor(rnd() * words.length)]!;
      const mode = i % 4;
      const q = mode === 0 ? w : mode === 1 ? w.slice(0, Math.max(3, Math.ceil(w.length * 0.6))) : mode === 2 ? w.slice(1, Math.min(w.length, 5)) : w.slice(0, 2) + w.slice(3);
      let h = 0;
      times.push(ms(() => { h = index.search(q).hits.length; }));
      if (h > 0) found++;
    }
    console.log(`[perf] ${report('name queries (exact/prefix/substring/typo)', times)}; ${found}/600 found something`);
    expect(found).toBeGreaterThan(450);
    expect(pct(times, 0.95)).toBeLessThan(30);
  });

  it('queries that match nothing and junk are fast', () => {
    const times: number[] = [];
    for (const q of ['qqqqqqqq', 'zzzz zzzz', 'hip 99999999', '!!!', 'x', '', 'a'.repeat(200), 'gaia dr3 1']) times.push(ms(() => { index.search(q); }));
    console.log(`[perf] ${report('no-match and junk queries', times)}`);
    expect(Math.max(...times)).toBeLessThan(100);
  });

  it('a lazily added second dataset joins without a rebuild and the first one is untouched', { timeout: 120_000 }, () => {
    const extra = syntheticRecords({ count: 5000, seed: 9 }).records.map((r, i) => ({ ...r, id: `late:${i}`, name: `Latecomer ${i}`, designations: [`Latecomer ${i}`, `LATE ${i}`] }));
    const before = index.search('hip 12', { limit: 5 }).hits.map((h) => h.id);
    const t = ms(() => { index.add(extra); });
    console.log(`[perf] add 5,000 records to the 250,000-record index: ${t.toFixed(0)} ms; key segments now ${index.stats().keySegments}`);
    expect(index.size).toBe(N + 5000);
    expect(index.search('latecomer 4999').hits[0]!.id).toBe('late:4999');
    expect(index.search('late 17').hits[0]!.id).toBe('late:17');
    expect(index.search('hip 12', { limit: 5 }).hits.map((h) => h.id)).toEqual(before);
    expect(t).toBeLessThan(5000);
  });

  it('chunked adds (the way the app loads datasets) give the same answers as one add', { timeout: 120_000 }, () => {
    const sample = records.slice(0, 20_000);
    const one = new SearchIndex();
    one.add(sample);
    const chunked = new SearchIndex();
    const times: number[] = [];
    for (let i = 0; i < sample.length; i += 2000) times.push(ms(() => { chunked.add(sample.slice(i, i + 2000)); }));
    console.log(`[perf] ${report('2,000-record add chunks (what one main-thread slice costs)', times)}`);
    const rnd = mulberry32(5);
    for (let k = 0; k < 150; k++) {
      const r = sample[Math.floor(rnd() * sample.length)]!;
      const q = r.designations[r.designations.length - 1]!.slice(0, 9);
      expect(chunked.search(q, { limit: 30 }).hits.map((h) => h.id), q).toEqual(one.search(q, { limit: 30 }).hits.map((h) => h.id));
    }
    expect(chunked.stats().keySegments).toBeLessThanOrEqual(9);
    expect(Math.max(...times)).toBeLessThan(2000);
  });
});

describe('250k-record store, filters, facets', () => {
  it('the store builds', () => {
    expect(store.count).toBe(N);
    expect(storeMs).toBeLessThan(10_000);
  });
  it('a combined filter evaluates in well under a frame budget (target < 20 ms)', () => {
    const spec = { categories: ['star' as const, 'galaxy' as const], distanceBands: ['nearby-stars' as const, 'stellar-neighbourhood' as const], spectralClasses: ['G' as const, 'K' as const, 'M' as const], ranges: { apparentMag: { max: 12 }, teffK: { min: 3000, max: 6500 }, pmTotalMasYr: { min: 10 } } };
    const times: number[] = [];
    let count = 0;
    for (let i = 0; i < 25; i++) times.push(ms(() => { count = evaluateFilter(store, spec).count; }));
    const r = evaluateFilter(store, spec);
    console.log(`[perf] ${report('combined filter (2 categories, 2 bands, 3 spectral classes, 3 ranges) over 250k', times)}; ${r.count} of ${r.scope} in scope match; excluded for missing ${JSON.stringify(r.excludedForMissing)}`);
    expect(count).toBe(r.count);
    expect(r.count).toBeGreaterThan(0);
    expect(r.count).toBeLessThan(r.scope);
    expect(pct(times, 0.5)).toBeLessThan(60);
  });
  it('a single numeric range', () => {
    const times: number[] = [];
    for (let i = 0; i < 25; i++) times.push(ms(() => { evaluateFilter(store, { ranges: { apparentMag: { max: 8 } } }); }));
    console.log(`[perf] ${report('one numeric range over 250k', times)}`);
    expect(pct(times, 0.5)).toBeLessThan(40);
  });
  it('facets over 250k', () => {
    let f!: ReturnType<typeof availableFacets>;
    const t = ms(() => { f = availableFacets(store); });
    console.log(`[perf] availableFacets over 250k: ${t.toFixed(1)} ms`);
    expect(f.measurements.length).toBeGreaterThan(3);
    expect(f.unavailableKeys).toContain('redshift');
    expect(t).toBeLessThan(500);
  });
  it('filtering is consistent with a straightforward loop (spot check on 250k)', () => {
    const r = evaluateFilter(store, { categories: ['star'], ranges: { teffK: { min: 5000, max: 6000 } } });
    let expected = 0;
    for (const rec of records) { const v = rec.measurements.teffK?.value; if (rec.category === 'star' && v !== undefined && v >= 5000 && v <= 6000) expected++; }
    expect(r.count).toBe(expected);
    let starsWithout = 0;
    for (const rec of records) if (rec.category === 'star' && rec.measurements.teffK === undefined) starsWithout++;
    expect(r.excludedForMissing.teffK).toBe(starsWithout);
  });
});

describe('250k-point KD-tree', () => {
  let tree: KdTree;
  let buildT = 0;
  beforeAll(() => { buildT = ms(() => { tree = buildSpatialIndex(store); }); console.log(`[perf] KD-tree build over ${tree.count.toLocaleString('en-US')} positioned records: ${buildT.toFixed(0)} ms`); });
  it('builds', () => { expect(tree.count).toBeGreaterThan(200_000); expect(buildT).toBeLessThan(10_000); });
  it('k-nearest and radius queries are sub-millisecond-ish and correct against brute force', { timeout: 120_000 }, () => {
    const rnd = mulberry32(12);
    const tk: number[] = [], tr: number[] = [];
    for (let i = 0; i < 300; i++) {
      const p = Math.floor(rnd() * N);
      if (!store.hasPosition(p)) continue;
      const x = store.xyz[3 * p]! + rnd(), y = store.xyz[3 * p + 1]!, z = store.xyz[3 * p + 2]!;
      tk.push(ms(() => { tree.nearest(x, y, z, 8); }));
      tr.push(ms(() => { tree.radius(x, y, z, 2); }));
      if (i % 50 === 0) {
        const got = tree.nearest(x, y, z, 5);
        let best = Infinity;
        for (let q = 0; q < N; q++) if (store.hasPosition(q)) { const d = Math.hypot(store.xyz[3 * q]! - x, store.xyz[3 * q + 1]! - y, store.xyz[3 * q + 2]! - z); if (d < best) best = d; }
        expect(got[0]!.distance).toBeCloseTo(best, 9);
      }
    }
    console.log(`[perf] ${report('KD k=8 nearest', tk)}`);
    console.log(`[perf] ${report('KD radius 2 pc', tr)}`);
    expect(pct(tk, 0.95)).toBeLessThan(10);
  });
});
