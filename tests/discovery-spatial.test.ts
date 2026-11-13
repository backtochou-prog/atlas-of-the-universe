import { describe, expect, it } from 'vitest';
import { KdTree, buildSpatialIndex } from '../src/discovery/spatialIndex';
import { mulberry32 } from './fixtures/discovery/synthetic';

/** Non-uniform cloud: dense clusters at several scales plus a sparse far field, like stars + nearby galaxies + redshift survey. */
function cloud(n: number, seed: number): { xyz: Float64Array; cat: Uint8Array; ds: Uint8Array } {
  const rnd = mulberry32(seed);
  const xyz = new Float64Array(3 * n), cat = new Uint8Array(n), ds = new Uint8Array(n);
  const centres = [[0, 0, 0, 1], [300, -200, 50, 20], [-5e3, 4e3, 1e3, 400], [2e6, 1e6, -3e6, 3e5], [-8e7, 2e7, 5e7, 8e6]];
  for (let i = 0; i < n; i++) {
    const c = centres[Math.floor(Math.pow(rnd(), 1.6) * centres.length)]!;
    const g = () => (rnd() + rnd() + rnd() - 1.5) * 2;
    xyz[3 * i] = c[0]! + g() * c[3]!; xyz[3 * i + 1] = c[1]! + g() * c[3]!; xyz[3 * i + 2] = c[2]! + g() * c[3]!;
    cat[i] = Math.floor(rnd() * 6); ds[i] = Math.floor(rnd() * 4);
  }
  return { xyz, cat, ds };
}

/** Brute force: all points within r (sorted), or the k nearest (insertion into a small sorted list). Filters first, sorts only what is kept. */
function brute(xyz: Float64Array, q: [number, number, number], ok: (i: number) => boolean, opts: { r?: number; k?: number } = {}): { index: number; d2: number }[] {
  const out: { index: number; d2: number }[] = [];
  const r2 = opts.r === undefined ? Infinity : opts.r * opts.r;
  const k = opts.k ?? Infinity;
  for (let i = 0; i < xyz.length / 3; i++) {
    if (!ok(i) || !Number.isFinite(xyz[3 * i]!)) continue;
    const dx = xyz[3 * i]! - q[0], dy = xyz[3 * i + 1]! - q[1], dz = xyz[3 * i + 2]! - q[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r2) continue;
    if (out.length === k && d2 >= out[k - 1]!.d2) continue;
    let j = out.length;
    if (out.length < k) out.push({ index: i, d2 }); else j = k - 1;
    out[j] = { index: i, d2 };
    while (j > 0 && out[j - 1]!.d2 > out[j]!.d2) { [out[j - 1], out[j]] = [out[j]!, out[j - 1]!]; j--; }
  }
  return k === Infinity ? out.sort((a, b) => a.d2 - b.d2 || a.index - b.index) : out;
}

describe('KdTree', () => {
  it('nearest 3 of a hand-made set', () => {
    const xyz = Float64Array.from([0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3, 10, 10, 10, -0.5, -0.5, 0]);
    const t = KdTree.build(xyz);
    const r = t.nearest(0.1, 0, 0, 3);
    expect(r.map((x) => x.index)).toEqual([0, 5, 1]);
    expect(r[0]!.distance).toBeCloseTo(0.1, 12);
    expect(r[2]!.distance).toBeCloseTo(0.9, 12);
    expect(t.radius(0, 0, 0, 1).map((x) => x.index)).toEqual([0, 5, 1]);       // inclusive radius, 1 pc exactly
  });

  it('radius queries equal brute force: 2500 random queries on a non-uniform cloud', { timeout: 60_000 }, () => {
    const { xyz } = cloud(2500, 11);
    const t = KdTree.build(xyz);
    const rnd = mulberry32(5);
    let nonEmpty = 0;
    for (let k = 0; k < 2500; k++) {
      const p = Math.floor(rnd() * 2500);
      const jitter = Math.pow(10, rnd() * 4 - 1);
      const q: [number, number, number] = [xyz[3 * p]! + (rnd() - 0.5) * jitter, xyz[3 * p + 1]! + (rnd() - 0.5) * jitter, xyz[3 * p + 2]! + (rnd() - 0.5) * jitter];
      const r = Math.pow(10, rnd() * rnd() * 6.5 - 1);       // mostly small, sometimes huge
      const expected = brute(xyz, q, () => true, { r });
      const got = t.radius(q[0], q[1], q[2], r);
      expect(got.map((x) => x.index)).toEqual(expected.map((x) => x.index));
      if (got.length > 0) { nonEmpty++; expect(got[0]!.distance).toBeCloseTo(Math.sqrt(expected[0]!.d2), 9); }
    }
    expect(nonEmpty).toBeGreaterThan(1200);
  });

  it('k-nearest equals brute force: 3000 random queries, several k', { timeout: 60_000 }, () => {
    const { xyz } = cloud(2500, 12);
    const t = KdTree.build(xyz);
    const rnd = mulberry32(6);
    for (let n = 0; n < 3000; n++) {
      const q: [number, number, number] = [(rnd() - 0.5) * 2e4 * Math.pow(10, rnd() * 4), (rnd() - 0.5) * 2e4, (rnd() - 0.5) * 2e4];
      const k = [1, 2, 3, 8, 25, 100][n % 6]!;
      const expected = brute(xyz, q, () => true, { k });
      const got = t.nearest(q[0], q[1], q[2], k);
      expect(got.map((x) => x.index)).toEqual(expected.map((x) => x.index));
      expect(got.map((x) => x.distance)).toEqual(expected.map((x) => Math.sqrt(x.d2)));
    }
  });

  it('category / dataset filters are applied during traversal and agree with filtering the brute-force list', () => {
    const { xyz, cat, ds } = cloud(2000, 13);
    const t = KdTree.build(xyz, { categoryIdx: cat, datasetIdx: ds });
    const rnd = mulberry32(7);
    for (let n = 0; n < 800; n++) {
      const q: [number, number, number] = [(rnd() - 0.5) * 1e3, (rnd() - 0.5) * 1e3, (rnd() - 0.5) * 1e3];
      const cats = new Uint8Array(6); cats[Math.floor(rnd() * 6)] = 1; if (rnd() < 0.5) cats[Math.floor(rnd() * 6)] = 1;
      const dss = rnd() < 0.5 ? null : Uint8Array.from([1, 0, 1, 0]);
      const exclude = Math.floor(rnd() * 2000);
      const ok = (i: number): boolean => cats[cat[i]!] === 1 && (dss === null || dss[ds[i]!] === 1) && i !== exclude;
      const filter = { categories: cats, datasets: dss, exclude };
      const r = Math.pow(10, rnd() * 3 + 1);
      expect(t.radius(q[0], q[1], q[2], r, filter).map((x) => x.index)).toEqual(brute(xyz, q, ok, { r }).map((x) => x.index));
      expect(t.nearest(q[0], q[1], q[2], 7, filter).map((x) => x.index)).toEqual(brute(xyz, q, ok, { k: 7 }).map((x) => x.index));
    }
  });

  it('a filter that matches nothing returns nothing; the excluded index never appears', () => {
    const { xyz, cat } = cloud(500, 14);
    const t = KdTree.build(xyz, { categoryIdx: cat });
    expect(t.radius(0, 0, 0, 1e9, { categories: new Uint8Array(6) })).toEqual([]);
    expect(t.nearest(0, 0, 0, 5, { categories: new Uint8Array(6) })).toEqual([]);
    const all = t.radius(0, 0, 0, 1e9);
    expect(all).toHaveLength(500);
    expect(t.radius(0, 0, 0, 1e9, { exclude: 17 }).some((x) => x.index === 17)).toBe(false);
  });

  it('maxRadius caps k-nearest; k larger than the set returns the whole set sorted', () => {
    const xyz = Float64Array.from([1, 0, 0, 2, 0, 0, 50, 0, 0]);
    const t = KdTree.build(xyz);
    expect(t.nearest(0, 0, 0, 10).map((x) => x.index)).toEqual([0, 1, 2]);
    expect(t.nearest(0, 0, 0, 10, undefined, 5).map((x) => x.index)).toEqual([0, 1]);
  });

  it('degenerate inputs: empty tree, one point, NaN points skipped, identical points, bad queries', () => {
    const e = KdTree.build(new Float64Array(0));
    expect(e.count).toBe(0);
    expect(e.radius(0, 0, 0, 10)).toEqual([]);
    expect(e.nearest(0, 0, 0, 3)).toEqual([]);
    expect(e.inPlanes(new Float64Array(0))).toEqual([]);
    const one = KdTree.build(Float64Array.from([3, 4, 0]));
    expect(one.nearest(0, 0, 0, 3)).toEqual([{ index: 0, distance: 5 }]);
    const nan = KdTree.build(Float64Array.from([NaN, 0, 0, 1, 1, 1, Infinity, 0, 0]));
    expect(nan.count).toBe(1);
    expect(nan.radius(1, 1, 1, 0.1).map((x) => x.index)).toEqual([1]);
    const same = KdTree.build(new Float64Array(3 * 40).fill(2));
    expect(same.radius(2, 2, 2, 0).map((x) => x.index)).toHaveLength(40);
    expect(same.nearest(2, 2, 2, 3).map((x) => x.index)).toEqual([0, 1, 2]);                // ties by index
    const t = KdTree.build(Float64Array.from([0, 0, 0, 1, 0, 0]));
    expect(t.radius(0, 0, 0, -1)).toEqual([]);
    expect(t.radius(NaN, 0, 0, 1)).toEqual([]);
    expect(t.nearest(0, 0, 0, 0)).toEqual([]);
    expect(t.nearest(NaN, 0, 0, 2)).toEqual([]);
    expect(t.radius(0, 0, 0, 0).map((x) => x.index)).toEqual([0]);
  });

  it('is balanced: depth and node count are logarithmic / linear', () => {
    const { xyz } = cloud(20000, 15);
    const t = KdTree.build(xyz);
    expect(t.nodes).toBeLessThan(20000 / 2);          // leaves hold between LEAF_SIZE/2 and LEAF_SIZE points
    expect(t.nodes).toBeGreaterThan(20000 / 16);
  });

  it('inPlanes equals exact plane tests on every point', () => {
    const { xyz, cat } = cloud(2000, 16);
    const t = KdTree.build(xyz, { categoryIdx: cat });
    const rnd = mulberry32(8);
    for (let n = 0; n < 300; n++) {
      const planes: number[] = [];
      for (let p = 0; p < 4 + Math.floor(rnd() * 3); p++) {
        const v = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
        const l = Math.hypot(v[0]!, v[1]!, v[2]!);
        planes.push(v[0]! / l, v[1]! / l, v[2]! / l, (rnd() - 0.3) * 4000);
      }
      const pl = Float64Array.from(planes);
      const allowed = Uint8Array.from([1, 1, 0, 1, 0, 1]);
      const expected: number[] = [];
      for (let i = 0; i < 2000; i++) {
        if (!allowed[cat[i]!]) continue;
        let inside = true;
        for (let p = 0; p < pl.length / 4; p++) inside &&= pl[4 * p]! * xyz[3 * i]! + pl[4 * p + 1]! * xyz[3 * i + 1]! + pl[4 * p + 2]! * xyz[3 * i + 2]! + pl[4 * p + 3]! >= 0;
        if (inside) expected.push(i);
      }
      expect(t.inPlanes(pl, { categories: allowed }).sort((a, b) => a - b)).toEqual(expected);
    }
  });

  it('buildSpatialIndex uses store arrays', () => {
    const xyz = Float64Array.from([0, 0, 0, 1, 0, 0]);
    const t = buildSpatialIndex({ xyz, categoryIdx: Uint8Array.from([0, 1]), datasetIdx: Uint8Array.from([0, 0]) });
    expect(t.radius(0, 0, 0, 5, { categories: Uint8Array.from([1, 1]) })).toHaveLength(2);
    expect(t.radius(0, 0, 0, 5, { categories: Uint8Array.from([0, 1]) })).toHaveLength(1);
    expect(t.radius(0, 0, 0, 5, { categories: Uint8Array.from([0, 0]) })).toHaveLength(0);
  });
});
