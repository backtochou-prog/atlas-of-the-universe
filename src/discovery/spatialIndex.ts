/**
 * Static balanced KD-tree over float64 heliocentric ICRS parsec positions (Prompt 07).
 *
 * Why a KD-tree (see tools/discovery/bench_spatial.ts for the measurements): the data are extremely non-uniform (35k Gaia stars within
 * ~1 kpc, a few hundred nearby galaxies, 43k redshift-survey galaxies out to ~150 Mpc, spread over 8 orders of magnitude in radius).
 * A uniform grid sized for the dense core is empty and useless at large radius, and one sized for the far field puts the whole core in a
 * few cells. The median-split KD-tree adapts to the density and never degrades with the dynamic range.
 *
 * Layout: leaf buckets of <= LEAF_SIZE points; every node stores its tight bounding box and OR-ed category/dataset bit masks, so a
 * category or dataset filter prunes whole subtrees DURING traversal instead of post-filtering. Points are copied into tree order
 * (cache-friendly); `ids` maps back to the caller's indices (record-store indices).
 *
 * All coordinates are parsecs in the heliocentric ICRS frame. The tree knows nothing about frames: src/discovery/nearby.ts converts
 * any origin into this frame with FrameTree.convert before querying.
 */
export interface SpatialFilter {
  /** Allowed category ids (index = category id of the build input); absent = all. */
  readonly categories?: Uint8Array | null;
  /** Allowed dataset ids; absent = all. */
  readonly datasets?: Uint8Array | null;
  /** One point index (caller's index) to skip, typically the query object itself. */
  readonly exclude?: number;
}

export interface Neighbour { readonly index: number; /** parsecs */ readonly distance: number }

export const LEAF_SIZE = 8;

interface PreparedFilter { readonly catBits: number; readonly dsBits: number; readonly exclude: number }

function toBits(allowed: Uint8Array | null | undefined): number {
  if (!allowed) return 0xffff;
  let b = 0;
  for (let i = 0; i < allowed.length && i < 16; i++) if (allowed[i]) b |= 1 << i;
  return b;
}

export class KdTree {
  readonly count: number;
  private readonly pts: Float64Array;
  private readonly ids: Int32Array;
  private readonly cat: Uint8Array;
  private readonly ds: Uint8Array;
  // nodes
  private readonly lo: Int32Array;
  private readonly hi: Int32Array;
  private readonly left: Int32Array;   // -1 = leaf
  private readonly right: Int32Array;
  private readonly box: Float64Array;  // 6 per node: minx miny minz maxx maxy maxz
  private readonly catMask: Uint16Array;
  private readonly dsMask: Uint16Array;
  private readonly nodeCount: number;

  private constructor(p: { pts: Float64Array; ids: Int32Array; cat: Uint8Array; ds: Uint8Array; lo: Int32Array; hi: Int32Array; left: Int32Array; right: Int32Array; box: Float64Array; catMask: Uint16Array; dsMask: Uint16Array; nodeCount: number }) {
    this.count = p.ids.length;
    this.pts = p.pts; this.ids = p.ids; this.cat = p.cat; this.ds = p.ds;
    this.lo = p.lo; this.hi = p.hi; this.left = p.left; this.right = p.right; this.box = p.box;
    this.catMask = p.catMask; this.dsMask = p.dsMask; this.nodeCount = p.nodeCount;
  }

  /**
   * @param xyz   3 floats per point (parsecs); points with a non-finite coordinate are skipped
   * @param opts  per-point category / dataset ids (< 16 distinct values each) for traversal-time filtering
   */
  static build(xyz: Float64Array, opts: { readonly categoryIdx?: Uint8Array; readonly datasetIdx?: Uint8Array; readonly leafSize?: number } = {}): KdTree {
    const leafSize = Math.max(1, opts.leafSize ?? LEAF_SIZE);
    const total = Math.floor(xyz.length / 3);
    let m = 0;
    const ord = new Int32Array(total);
    for (let i = 0; i < total; i++) if (Number.isFinite(xyz[3 * i]!) && Number.isFinite(xyz[3 * i + 1]!) && Number.isFinite(xyz[3 * i + 2]!)) ord[m++] = i;
    const maxNodes = Math.max(1, 2 * Math.ceil(m / Math.max(1, leafSize >> 1)) + 1);
    const lo = new Int32Array(maxNodes), hi = new Int32Array(maxNodes), left = new Int32Array(maxNodes).fill(-1), right = new Int32Array(maxNodes).fill(-1);
    const box = new Float64Array(6 * maxNodes);
    let nodeCount = 0;
    const stack: number[] = [];
    if (m > 0) {
      const root = nodeCount++;
      lo[root] = 0; hi[root] = m;
      stack.push(root);
    }
    while (stack.length > 0) {
      const nd = stack.pop()!;
      const a = lo[nd]!, b = hi[nd]!;
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let i = a; i < b; i++) {
        const o = 3 * ord[i]!;
        const x = xyz[o]!, y = xyz[o + 1]!, z = xyz[o + 2]!;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
      const bo = 6 * nd;
      box[bo] = x0; box[bo + 1] = y0; box[bo + 2] = z0; box[bo + 3] = x1; box[bo + 4] = y1; box[bo + 5] = z1;
      if (b - a <= leafSize || (x1 === x0 && y1 === y0 && z1 === z0)) continue;     // leaf (identical points cannot be split)
      const ex = x1 - x0, ey = y1 - y0, ez = z1 - z0;
      const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
      const mid = (a + b) >>> 1;
      select(ord, xyz, axis, a, b - 1, mid);
      const l = nodeCount++, r = nodeCount++;
      lo[l] = a; hi[l] = mid; lo[r] = mid; hi[r] = b;
      left[nd] = l; right[nd] = r;
      stack.push(r, l);
    }
    // copy into tree order
    const pts = new Float64Array(3 * m);
    const ids = new Int32Array(m);
    const cat = new Uint8Array(m), ds = new Uint8Array(m);
    for (let i = 0; i < m; i++) {
      const src = ord[i]!;
      pts[3 * i] = xyz[3 * src]!; pts[3 * i + 1] = xyz[3 * src + 1]!; pts[3 * i + 2] = xyz[3 * src + 2]!;
      ids[i] = src;
      cat[i] = opts.categoryIdx ? opts.categoryIdx[src]! : 0;
      ds[i] = opts.datasetIdx ? opts.datasetIdx[src]! : 0;
    }
    // node masks, children are created after parents, so a reverse sweep sees children first
    const catMask = new Uint16Array(maxNodes), dsMask = new Uint16Array(maxNodes);
    for (let nd = nodeCount - 1; nd >= 0; nd--) {
      if (left[nd]! < 0) {
        let cm = 0, dm = 0;
        for (let i = lo[nd]!; i < hi[nd]!; i++) { cm |= 1 << (cat[i]! & 15); dm |= 1 << (ds[i]! & 15); }
        catMask[nd] = cm; dsMask[nd] = dm;
      } else {
        catMask[nd] = catMask[left[nd]!]! | catMask[right[nd]!]!;
        dsMask[nd] = dsMask[left[nd]!]! | dsMask[right[nd]!]!;
      }
    }
    return new KdTree({ pts, ids, cat, ds, lo, hi, left, right, box, catMask, dsMask, nodeCount });
  }

  private prep(f: SpatialFilter | undefined): PreparedFilter {
    return { catBits: toBits(f?.categories), dsBits: toBits(f?.datasets), exclude: f?.exclude ?? -1 };
  }

  private boxDist2(nd: number, x: number, y: number, z: number): number {
    const b = this.box, o = 6 * nd;
    const dx = x < b[o]! ? b[o]! - x : x > b[o + 3]! ? x - b[o + 3]! : 0;
    const dy = y < b[o + 1]! ? b[o + 1]! - y : y > b[o + 4]! ? y - b[o + 4]! : 0;
    const dz = z < b[o + 2]! ? b[o + 2]! - z : z > b[o + 5]! ? z - b[o + 5]! : 0;
    return dx * dx + dy * dy + dz * dz;
  }

  private accepts(i: number, f: PreparedFilter): boolean {
    return ((f.catBits >> (this.cat[i]! & 15)) & 1) === 1 && ((f.dsBits >> (this.ds[i]! & 15)) & 1) === 1 && this.ids[i] !== f.exclude;
  }

  /** All points within `radiusPc` (inclusive) of (x, y, z), nearest first; ties by index. */
  radius(x: number, y: number, z: number, radiusPc: number, filter?: SpatialFilter): Neighbour[] {
    if (this.count === 0 || !(radiusPc >= 0) || !Number.isFinite(x + y + z)) return [];
    const f = this.prep(filter);
    const r2 = radiusPc * radiusPc;
    const found: { index: number; d2: number }[] = [];
    const stack: number[] = [0];
    const pts = this.pts;
    while (stack.length > 0) {
      const nd = stack.pop()!;
      if ((this.catMask[nd]! & f.catBits) === 0 || (this.dsMask[nd]! & f.dsBits) === 0) continue;
      if (this.boxDist2(nd, x, y, z) > r2) continue;
      const l = this.left[nd]!;
      if (l >= 0) { stack.push(this.right[nd]!, l); continue; }
      for (let i = this.lo[nd]!; i < this.hi[nd]!; i++) {
        const dx = pts[3 * i]! - x, dy = pts[3 * i + 1]! - y, dz = pts[3 * i + 2]! - z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 <= r2 && this.accepts(i, f)) found.push({ index: this.ids[i]!, d2 });
      }
    }
    found.sort((a, b) => a.d2 - b.d2 || a.index - b.index);
    return found.map((p) => ({ index: p.index, distance: Math.sqrt(p.d2) }));
  }

  /** Number of points within `radiusPc` (inclusive). No allocation: use it for "N objects within r" displays and for benchmarks. */
  countWithin(x: number, y: number, z: number, radiusPc: number, filter?: SpatialFilter): number {
    if (this.count === 0 || !(radiusPc >= 0) || !Number.isFinite(x + y + z)) return 0;
    const f = this.prep(filter);
    const r2 = radiusPc * radiusPc;
    let n = 0;
    const stack: number[] = [0];
    const pts = this.pts;
    while (stack.length > 0) {
      const nd = stack.pop()!;
      if ((this.catMask[nd]! & f.catBits) === 0 || (this.dsMask[nd]! & f.dsBits) === 0) continue;
      if (this.boxDist2(nd, x, y, z) > r2) continue;
      const l = this.left[nd]!;
      if (l >= 0) { stack.push(this.right[nd]!, l); continue; }
      for (let i = this.lo[nd]!; i < this.hi[nd]!; i++) {
        const dx = pts[3 * i]! - x, dy = pts[3 * i + 1]! - y, dz = pts[3 * i + 2]! - z;
        if (dx * dx + dy * dy + dz * dz <= r2 && this.accepts(i, f)) n++;
      }
    }
    return n;
  }

  /** The k nearest points (fewer if fewer exist within maxRadiusPc), nearest first; ties by index. */
  nearest(x: number, y: number, z: number, k: number, filter?: SpatialFilter, maxRadiusPc = Infinity): Neighbour[] {
    if (this.count === 0 || !(k >= 1) || !Number.isFinite(x + y + z)) return [];
    const f = this.prep(filter);
    k = Math.floor(k);
    const heapD = new Float64Array(k), heapI = new Int32Array(k);   // max-heap on (d2, index)
    let size = 0;
    let bound = maxRadiusPc === Infinity ? Infinity : maxRadiusPc * maxRadiusPc;
    const worse = (d2a: number, ia: number, d2b: number, ib: number): boolean => d2a > d2b || (d2a === d2b && ia > ib);
    const pts = this.pts;
    const stackNode: number[] = [0];
    const stackD: number[] = [this.boxDist2(0, x, y, z)];
    while (stackNode.length > 0) {
      const nd = stackNode.pop()!;
      const nd2 = stackD.pop()!;
      if (nd2 > bound) continue;
      if ((this.catMask[nd]! & f.catBits) === 0 || (this.dsMask[nd]! & f.dsBits) === 0) continue;
      const l = this.left[nd]!;
      if (l >= 0) {
        const r = this.right[nd]!;
        const dl = this.boxDist2(l, x, y, z), dr = this.boxDist2(r, x, y, z);
        if (dl <= dr) { stackNode.push(r, l); stackD.push(dr, dl); } else { stackNode.push(l, r); stackD.push(dl, dr); }
        continue;
      }
      for (let i = this.lo[nd]!; i < this.hi[nd]!; i++) {
        const dx = pts[3 * i]! - x, dy = pts[3 * i + 1]! - y, dz = pts[3 * i + 2]! - z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > bound || !this.accepts(i, f)) continue;
        const id = this.ids[i]!;
        if (size < k) {
          let c = size++;
          while (c > 0) { const p = (c - 1) >> 1; if (worse(d2, id, heapD[p]!, heapI[p]!)) { heapD[c] = heapD[p]!; heapI[c] = heapI[p]!; c = p; } else break; }
          heapD[c] = d2; heapI[c] = id;
          if (size === k) bound = Math.min(bound, heapD[0]!);
        } else if (worse(heapD[0]!, heapI[0]!, d2, id)) {
          let c = 0;
          for (;;) {
            const a = 2 * c + 1, b = a + 1;
            let m = -1;
            if (a < size && worse(heapD[a]!, heapI[a]!, d2, id)) m = a;
            if (b < size && worse(heapD[b]!, heapI[b]!, m < 0 ? d2 : heapD[m]!, m < 0 ? id : heapI[m]!)) m = b;
            if (m < 0) break;
            heapD[c] = heapD[m]!; heapI[c] = heapI[m]!; c = m;
          }
          heapD[c] = d2; heapI[c] = id;
          bound = Math.min(bound, heapD[0]!);
        }
      }
    }
    const out: { index: number; d2: number }[] = [];
    for (let i = 0; i < size; i++) out.push({ index: heapI[i]!, d2: heapD[i]! });
    out.sort((a, b) => a.d2 - b.d2 || a.index - b.index);
    return out.map((p) => ({ index: p.index, distance: Math.sqrt(p.d2) }));
  }

  /**
   * Points inside a convex region given as inward-facing planes (n.p + d >= 0 is inside), 4 numbers per plane (nx, ny, nz, d).
   * Subtrees whose box is entirely outside any plane are skipped; subtrees entirely inside all planes are taken whole; only
   * boundary leaves test points one by one (exact plane tests).
   */
  inPlanes(planes: Float64Array, filter?: SpatialFilter, limit = Infinity): number[] {
    if (this.count === 0) return [];
    const f = this.prep(filter);
    const np = Math.floor(planes.length / 4);
    const out: number[] = [];
    const pts = this.pts, b = this.box;
    const stack: number[] = [0];
    while (stack.length > 0 && out.length < limit) {
      const nd = stack.pop()!;
      if ((this.catMask[nd]! & f.catBits) === 0 || (this.dsMask[nd]! & f.dsBits) === 0) continue;
      const o = 6 * nd;
      let allInside = true, outside = false;
      for (let p = 0; p < np; p++) {
        const nx = planes[4 * p]!, ny = planes[4 * p + 1]!, nz = planes[4 * p + 2]!, d = planes[4 * p + 3]!;
        const pvx = nx >= 0 ? b[o + 3]! : b[o]!, pvy = ny >= 0 ? b[o + 4]! : b[o + 1]!, pvz = nz >= 0 ? b[o + 5]! : b[o + 2]!;
        if (nx * pvx + ny * pvy + nz * pvz + d < 0) { outside = true; break; }
        const nvx = nx >= 0 ? b[o]! : b[o + 3]!, nvy = ny >= 0 ? b[o + 1]! : b[o + 4]!, nvz = nz >= 0 ? b[o + 2]! : b[o + 5]!;
        if (nx * nvx + ny * nvy + nz * nvz + d < 0) allInside = false;
      }
      if (outside) continue;
      const l = this.left[nd]!;
      if (l >= 0) { stack.push(this.right[nd]!, l); continue; }
      for (let i = this.lo[nd]!; i < this.hi[nd]!; i++) {
        if (!this.accepts(i, f)) continue;
        if (!allInside) {
          const x = pts[3 * i]!, y = pts[3 * i + 1]!, z = pts[3 * i + 2]!;
          let inside = true;
          for (let p = 0; p < np && inside; p++) inside = planes[4 * p]! * x + planes[4 * p + 1]! * y + planes[4 * p + 2]! * z + planes[4 * p + 3]! >= 0;
          if (!inside) continue;
        }
        out.push(this.ids[i]!);
      }
    }
    return out;
  }

  /** Caller index -> position (parsecs) for a point in the tree. O(n): for tests and tooling only. */
  positionOf(index: number): [number, number, number] | undefined {
    for (let i = 0; i < this.count; i++) if (this.ids[i] === index) return [this.pts[3 * i]!, this.pts[3 * i + 1]!, this.pts[3 * i + 2]!];
    return undefined;
  }

  get nodes(): number { return this.nodeCount; }
}

/** Quickselect (Hoare, median-of-three) of ord[a..b] so that ord[k] holds the element of rank k by coordinate `axis`. */
function select(ord: Int32Array, xyz: Float64Array, axis: number, a: number, b: number, k: number): void {
  while (b > a) {
    const mid = (a + b) >>> 1;
    // median of three as pivot value
    const va = xyz[3 * ord[a]! + axis]!, vm = xyz[3 * ord[mid]! + axis]!, vb = xyz[3 * ord[b]! + axis]!;
    const pivot = va < vm ? (vm < vb ? vm : va < vb ? vb : va) : (va < vb ? va : vm < vb ? vb : vm);
    let i = a, j = b;
    while (i <= j) {
      while (xyz[3 * ord[i]! + axis]! < pivot) i++;
      while (xyz[3 * ord[j]! + axis]! > pivot) j--;
      if (i <= j) { const t = ord[i]!; ord[i] = ord[j]!; ord[j] = t; i++; j--; }
    }
    if (k <= j) b = j; else if (k >= i) a = i; else return;
  }
}

/** Build the tree for every record of a store that has a 3D position; query indices are store indices. */
export function buildSpatialIndex(store: { readonly xyz: Float64Array; readonly categoryIdx: Uint8Array; readonly datasetIdx: Uint8Array }, leafSize?: number): KdTree {
  return KdTree.build(store.xyz, { categoryIdx: store.categoryIdx, datasetIdx: store.datasetIdx, ...(leafSize !== undefined ? { leafSize } : {}) });
}
