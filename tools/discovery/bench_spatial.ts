/**
 * Spatial index benchmark (Prompt 07): KD-tree vs uniform grid vs brute force on a synthetic, strongly non-uniform 500k-point cloud.
 *
 *   npx tsx tools/discovery/bench_spatial.ts            # full run (500k points)
 *   npx tsx tools/discovery/bench_spatial.ts 100000     # smaller
 *
 * The cloud mimics the atlas: a dense local core (Gaia-like stars within ~1 kpc), a Galactic halo of globular-cluster-like blobs out to ~50 kpc,
 * the Local Group / nearby galaxies out to ~10 Mpc, and a redshift-survey shell out to ~150 Mpc. Positions are heliocentric parsecs, so the
 * dynamic range is about 8 orders of magnitude. Everything is deterministic (fixed seed). The numbers are timings on whatever machine runs it
 * (a shared one in our case): compare the methods against each other, not against a clock.
 */
import { KdTree } from '../../src/discovery/spatialIndex';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function makeCloud(n: number, seed = 42): Float64Array {
  const r = rng(seed);
  const xyz = new Float64Array(3 * n);
  const gauss = (): number => (r() + r() + r() + r() - 2) * 1.7;
  for (let i = 0; i < n; i++) {
    const u = r();
    let x: number, y: number, z: number;
    if (u < 0.70) {            // local stars: exponential-ish density to ~1 kpc, thin disc
      const rad = -Math.log(1 - r()) * 220, th = r() * 2 * Math.PI;
      x = rad * Math.cos(th); y = rad * Math.sin(th); z = gauss() * 60;
    } else if (u < 0.78) {     // clusters and halo blobs out to 50 kpc
      const c = Math.floor(r() * 60);
      const cr = rng(c + 1000);
      const R = 2000 + cr() * 48000, th = cr() * 2 * Math.PI, ph = Math.acos(2 * cr() - 1), s = 5 + cr() * 80;
      x = R * Math.sin(ph) * Math.cos(th) + gauss() * s; y = R * Math.sin(ph) * Math.sin(th) + gauss() * s; z = R * Math.cos(ph) + gauss() * s;
    } else if (u < 0.80) {     // Local Group and nearby galaxies, 50 kpc - 10 Mpc, filament-like
      const R = 5e4 * Math.pow(200, r()), th = r() * 2 * Math.PI, ph = Math.acos(2 * r() - 1);
      x = R * Math.sin(ph) * Math.cos(th); y = R * Math.sin(ph) * Math.sin(th); z = R * Math.cos(ph);
    } else {                   // redshift-survey shell with clustering, 10 - 150 Mpc
      const c = Math.floor(r() * 400);
      const cr = rng(c + 5000);
      const R = 1e7 + cr() * 1.4e8, th = cr() * 2 * Math.PI, ph = Math.acos(2 * cr() - 1);
      x = R * Math.sin(ph) * Math.cos(th) + gauss() * 4e5; y = R * Math.sin(ph) * Math.sin(th) + gauss() * 4e5; z = R * Math.cos(ph) + gauss() * 4e5;
    }
    xyz[3 * i] = x; xyz[3 * i + 1] = y; xyz[3 * i + 2] = z;
  }
  return xyz;
}

// ---- uniform grid (hashed cells), one cell size --------------------------------------------------------------------------------------------

class Grid {
  /** Hashed cells. Two distinct cells can share a bucket (hash collision): the distance test keeps the answer exact, the stamp stops a bucket being counted twice. */
  private readonly cells = new Map<number, { list: number[]; stamp: number }>();
  private stamp = 0;
  constructor(private readonly xyz: Float64Array, readonly cell: number) {
    for (let i = 0; i < xyz.length / 3; i++) {
      const k = this.key(Math.floor(xyz[3 * i]! / cell), Math.floor(xyz[3 * i + 1]! / cell), Math.floor(xyz[3 * i + 2]! / cell));
      const b = this.cells.get(k);
      if (b) b.list.push(i); else this.cells.set(k, { list: [i], stamp: 0 });
    }
  }
  private key(ix: number, iy: number, iz: number): number { return ((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)) | 0; }
  /** Radius query. If the query box spans more cells than there are occupied buckets, the grid degenerates to scanning every bucket. */
  radius(x: number, y: number, z: number, r: number): { count: number; cellsVisited: number } {
    const c = this.cell;
    const x0 = Math.floor((x - r) / c), x1 = Math.floor((x + r) / c), y0 = Math.floor((y - r) / c), y1 = Math.floor((y + r) / c), z0 = Math.floor((z - r) / c), z1 = Math.floor((z + r) / c);
    const span = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
    let count = 0, visited = 0;
    const r2 = r * r;
    const st = ++this.stamp;
    const test = (b: { list: number[]; stamp: number }): void => {
      if (b.stamp === st) return;
      b.stamp = st;
      for (const i of b.list) { const dx = this.xyz[3 * i]! - x, dy = this.xyz[3 * i + 1]! - y, dz = this.xyz[3 * i + 2]! - z; if (dx * dx + dy * dy + dz * dz <= r2) count++; }
    };
    if (span > this.cells.size) { for (const b of this.cells.values()) { visited++; test(b); } return { count, cellsVisited: visited }; }
    for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) for (let iz = z0; iz <= z1; iz++) { visited++; const b = this.cells.get(this.key(ix, iy, iz)); if (b) test(b); }
    return { count, cellsVisited: visited };
  }
}

function bruteRadius(xyz: Float64Array, x: number, y: number, z: number, r: number): number {
  let n = 0; const r2 = r * r;
  for (let i = 0; i < xyz.length; i += 3) { const dx = xyz[i]! - x, dy = xyz[i + 1]! - y, dz = xyz[i + 2]! - z; if (dx * dx + dy * dy + dz * dz <= r2) n++; }
  return n;
}
function bruteKnn(xyz: Float64Array, x: number, y: number, z: number, k: number): number {
  const best = new Float64Array(k).fill(Infinity);
  for (let i = 0; i < xyz.length; i += 3) {
    const dx = xyz[i]! - x, dy = xyz[i + 1]! - y, dz = xyz[i + 2]! - z; const d = dx * dx + dy * dy + dz * dz;
    if (d < best[k - 1]!) { let j = k - 1; while (j > 0 && best[j - 1]! > d) { best[j] = best[j - 1]!; j--; } best[j] = d; }
  }
  return best[0]!;
}

function stats(ms: number[]): string {
  const s = [...ms].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return `mean ${mean.toFixed(4)} ms  p50 ${s[Math.floor(s.length * 0.5)]!.toFixed(4)}  p95 ${s[Math.floor(s.length * 0.95)]!.toFixed(4)}  max ${s[s.length - 1]!.toFixed(3)}`;
}
function time(f: () => void): number { const t = performance.now(); f(); return performance.now() - t; }

const N = Number(process.argv[2] ?? 500_000);
console.log(`points: ${N.toLocaleString('en-US')} (heliocentric parsecs, 8 orders of magnitude of radius)`);
let xyz: Float64Array = new Float64Array(0);
console.log(`generate: ${time(() => { xyz = makeCloud(N); }).toFixed(0)} ms`);

let kd!: KdTree;
console.log(`KD-tree build: ${time(() => { kd = KdTree.build(xyz); }).toFixed(0)} ms  (${kd.nodes} nodes, leaf size 8)`);
const grids: Grid[] = [];
for (const cell of [2, 200, 20000, 2e6]) {
  let g!: Grid;
  const ms = time(() => { g = new Grid(xyz, cell); });
  grids.push(g);
  console.log(`grid build, cell ${cell} pc: ${ms.toFixed(0)} ms`);
}

// query centres in two regimes: the dense local core, and the far field (galaxies beyond 10 Mpc)
const r = rng(7);
const core: [number, number, number][] = [[0, 0, 0]];
const far: [number, number, number][] = [];
for (let tries = 0; core.length < 301 || far.length < 101; tries++) {
  const p = Math.floor(r() * N);
  const d = Math.hypot(xyz[3 * p]!, xyz[3 * p + 1]!, xyz[3 * p + 2]!);
  const c: [number, number, number] = [xyz[3 * p]! + (r() - 0.5), xyz[3 * p + 1]! + (r() - 0.5), xyz[3 * p + 2]! + (r() - 0.5)];
  if (d < 1000 && core.length < 301) core.push(c); else if (d > 1e7 && far.length < 101) far.push(c);
  if (tries > 50 * N) break;
}
console.log(`query centres: ${core.length} in the core (< 1 kpc), ${far.length} in the far field (> 10 Mpc)`);

const regimes: { name: string; centres: [number, number, number][]; radius: number }[] = [
  { name: 'core, r = 5 pc', centres: core, radius: 5 },
  { name: 'core, r = 25 pc', centres: core, radius: 25 },
  { name: 'far field, r = 2 Mpc', centres: far, radius: 2e6 },
];
for (const reg of regimes) {
  const bruteSample = reg.centres.slice(0, 30);
  console.log(`\nradius query, ${reg.name}`);
  const counts: number[] = reg.centres.map((c) => kd.countWithin(c[0], c[1], c[2], reg.radius));
  console.log(`  mean hits ${(counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(1)}`);
  console.log(`  kd-tree, sorted list   ${stats(reg.centres.map((c) => time(() => { kd.radius(c[0], c[1], c[2], reg.radius); })))}`);
  console.log(`  kd-tree, count only    ${stats(reg.centres.map((c) => time(() => { kd.countWithin(c[0], c[1], c[2], reg.radius); })))}`);
  for (const g of grids) {
    const cv: number[] = [];
    const ms = bruteSample.map((c, i) => { let res = { count: 0, cellsVisited: 0 }; const t = time(() => { res = g.radius(c[0], c[1], c[2], reg.radius); }); if (res.count !== counts[i]) throw new Error('grid disagrees with the tree'); cv.push(res.cellsVisited); return t; });
    console.log(`  grid ${String(g.cell).padStart(7)} pc, count   ${stats(ms)}   mean cells visited ${(cv.reduce((a, b) => a + b, 0) / cv.length).toFixed(0)}`);
  }
  const bms = bruteSample.map((c, i) => { let n = 0; const t = time(() => { n = bruteRadius(xyz, c[0], c[1], c[2], reg.radius); }); if (n !== counts[i]) throw new Error('brute disagrees with the tree'); return t; });
  console.log(`  brute force, count     ${stats(bms)}`);
}

for (const reg of [{ name: 'core', centres: core }, { name: 'far field', centres: far }]) {
  for (const k of [3, 10, 100]) {
    console.log(`\nk-nearest, k = ${k}, ${reg.name}`);
    console.log(`  kd-tree       ${stats(reg.centres.map((c) => time(() => { kd.nearest(c[0], c[1], c[2], k); })))}`);
    console.log(`  brute force   ${stats(reg.centres.slice(0, 30).map((c) => time(() => { bruteKnn(xyz, c[0], c[1], c[2], k); })))}`);
  }
}

// a filtered query: only one category out of 6, applied during traversal vs unfiltered
const cat = new Uint8Array(N); for (let i = 0; i < N; i++) cat[i] = i % 6;
const kdc = KdTree.build(xyz, { categoryIdx: cat });
const allowed = Uint8Array.from([0, 0, 1, 0, 0, 0]);
console.log('\nk = 10 restricted to 1 of 6 categories, filter applied during traversal (core centres)');
console.log(`  kd-tree, filtered    ${stats(core.map((c) => time(() => { kdc.nearest(c[0], c[1], c[2], 10, { categories: allowed }); })))}`);
console.log(`  kd-tree, unfiltered  ${stats(core.map((c) => time(() => { kdc.nearest(c[0], c[1], c[2], 10); })))}`);
