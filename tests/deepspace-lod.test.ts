import { describe, expect, it } from 'vitest';
import { continuousLevel, DOWN_FACTOR, FADE_FACTOR, LEVEL_UP_PX, QualityGovernor, selectRepresentation, selectTextureLevel } from '../src/core/deepspace/lod';

const sel = (px: number, prev?: number, size: number | undefined = 1e21) => selectRepresentation({ apparentPixels: px, physicalSizeMetres: size, distance: 1e24, previousLevel: prev });

describe('selectRepresentation', () => {
  it('constants keep hysteresis inside the crossfade band', () => { expect(DOWN_FACTOR).toBeGreaterThan(1 / FADE_FACTOR); });

  it('is monotonic in apparent size (no previous level)', () => {
    let last = -1;
    for (let px = 0; px < 5000; px += 0.5) { const r = sel(px).level; expect(r).toBeGreaterThanOrEqual(last); last = r; }
    expect(last).toBe(3);
    expect(sel(1).name).toBe('point'); expect(sel(20).name).toBe('sprite'); expect(sel(100).name).toBe('image'); expect(sel(1000).name).toBe('detail');
  });

  it('has hysteresis: jitter around a threshold does not flip the level', () => {
    for (const t of LEVEL_UP_PX) {
      let level = sel(t * 0.5).level;
      const flips: number[] = [];
      for (let k = 0; k < 200; k++) {
        const px = t * (1 + 0.1 * Math.sin(k)); // +-10 % around the threshold
        const next = sel(px, level).level;
        if (next !== level) flips.push(k);
        level = next;
      }
      expect(flips.length).toBeLessThanOrEqual(1); // at most the one upward transition
    }
  });
  it('goes up at the threshold and down only after DOWN_FACTOR * threshold', () => {
    const t = LEVEL_UP_PX[1]!;
    expect(sel(t, 1).level).toBe(2);
    expect(sel(t * 0.9, 2).level).toBe(2);
    expect(sel(t * DOWN_FACTOR * 0.99, 2).level).toBe(1);
  });
  it('no oscillation over a smooth zoom in then out', () => {
    let level = 0; const trace: number[] = [];
    const px = (k: number) => Math.exp(Math.log(0.5) + (k / 400) * Math.log(5000 / 0.5));
    for (let k = 0; k <= 400; k++) { level = sel(px(k), level).level; trace.push(level); }
    for (let k = 400; k >= 0; k--) { level = sel(px(k), level).level; trace.push(level); }
    let changes = 0; for (let i = 1; i < trace.length; i++) if (trace[i] !== trace[i - 1]) changes++;
    expect(changes).toBe(6); // 3 up + 3 down, nothing else
  });
  it('the discrete level is always one of the two crossfaded levels, and the weight is continuous (no popping)', () => {
    let level = 0; let prevCont = 0;
    for (let k = 0; k <= 4000; k++) {
      const px = Math.exp(Math.log(0.5) + (k / 4000) * Math.log(5000 / 0.5));
      const r = sel(px, level); level = r.level;
      expect(level === r.lower || level === r.upper).toBe(true);
      const cont = r.lower + r.weight;
      expect(cont).toBeGreaterThanOrEqual(prevCont - 1e-12);
      expect(cont - prevCont).toBeLessThan(0.02); // small steps: continuous
      prevCont = cont;
    }
    expect(prevCont).toBeCloseTo(3, 6);
    // and the invariant holds on the way back down too
    for (let k = 4000; k >= 0; k--) {
      const px = Math.exp(Math.log(0.5) + (k / 4000) * Math.log(5000 / 0.5));
      const r = sel(px, level); level = r.level;
      expect(level === r.lower || level === r.upper).toBe(true);
    }
  });
  it('continuousLevel is monotonic and in [0, 3]', () => {
    let last = -1;
    for (let px = 0; px < 10000; px += 1) { const c = continuousLevel(px); expect(c).toBeGreaterThanOrEqual(last); expect(c).toBeLessThanOrEqual(3); last = c; }
    expect(continuousLevel(0)).toBe(0);
  });
  it('an object without a known physical size never gets beyond sprite', () => {
    const r = selectRepresentation({ apparentPixels: 3000, distance: 1e22 });
    expect(r.level).toBe(1);
    expect(r.lower + r.weight).toBeLessThanOrEqual(1);
  });
  it('a camera inside the object forces detail', () => {
    const r = selectRepresentation({ apparentPixels: 1e5, physicalSizeMetres: 1e21, distance: 1e20 });
    expect(r.inside).toBe(true); expect(r.level).toBe(3);
  });
  it('validates input', () => {
    expect(() => selectRepresentation({ apparentPixels: 1, distance: 0 })).toThrow();
    expect(() => selectRepresentation({ apparentPixels: -1, distance: 1 })).toThrow();
  });
});

describe('selectTextureLevel', () => {
  const sizes = [256, 1024, 4096];
  it('picks the smallest level that is big enough, never larger', () => {
    expect(selectTextureLevel(sizes, 100, 1, 1)).toBe(0);
    expect(selectTextureLevel(sizes, 256, 1, 1)).toBe(0);
    expect(selectTextureLevel(sizes, 257, 1, 1)).toBe(1);
    expect(selectTextureLevel(sizes, 1000, 1, 1)).toBe(1);
    expect(selectTextureLevel(sizes, 1025, 1, 1)).toBe(2);
    expect(selectTextureLevel(sizes, 50000, 1, 1)).toBe(2);
  });
  it('accounts for devicePixelRatio and the quality scale', () => {
    expect(selectTextureLevel(sizes, 600, 1, 1)).toBe(1);
    expect(selectTextureLevel(sizes, 600, 2, 1)).toBe(2);
    expect(selectTextureLevel(sizes, 600, 2, 0.5)).toBe(1);
    expect(selectTextureLevel(sizes, 600, 2, 0.1)).toBe(0);
  });
  it('is monotonic in on-screen size and quality', () => {
    let last = 0; for (let px = 0; px < 6000; px += 7) { const l = selectTextureLevel(sizes, px, 2, 1); expect(l).toBeGreaterThanOrEqual(last); last = l; }
    let lastQ = 0; for (let q = 0.05; q <= 1; q += 0.05) { const l = selectTextureLevel(sizes, 900, 2, q); expect(l).toBeGreaterThanOrEqual(lastQ); lastQ = l; }
  });
  it('rejects empty or non-increasing level lists', () => {
    expect(() => selectTextureLevel([], 10)).toThrow();
    expect(() => selectTextureLevel([256, 256], 10)).toThrow();
  });
});

describe('QualityGovernor', () => {
  it('stays at 1 on target and in the dead band', () => {
    const g = new QualityGovernor({ targetMs: 20 });
    for (let i = 0; i < 500; i++) g.update(20 + (i % 2 ? 2 : -2));
    expect(g.scale).toBe(1);
  });
  it('drops under sustained load, never below the floor, and recovers slowly', () => {
    const g = new QualityGovernor({ targetMs: 20 });
    for (let i = 0; i < 300; i++) g.update(60);
    expect(g.scale).toBeLessThan(0.5);
    expect(g.scale).toBeGreaterThanOrEqual(0.25);
    const low = g.scale;
    let drops = 0;
    for (let i = 0; i < 60; i++) { const before = g.scale; g.update(8); if (g.scale < before) drops++; }
    expect(drops).toBe(0);
    expect(g.scale).toBeGreaterThan(low);
    // recovery is much slower than the fall: 60 good frames recover far less than the 300 bad ones lost
    expect(g.scale - low).toBeLessThan(0.15);
    for (let i = 0; i < 5000; i++) g.update(8);
    expect(g.scale).toBe(1);
  });
  it('one hitch does not slam the quality', () => {
    const g = new QualityGovernor({ targetMs: 20 });
    for (let i = 0; i < 100; i++) g.update(20);
    g.update(2000);
    expect(g.scale).toBe(1);
  });
  it('ignores garbage and validates options', () => {
    const g = new QualityGovernor({ targetMs: 20 });
    expect(g.update(NaN)).toBe(1); expect(g.update(-5)).toBe(1);
    expect(() => new QualityGovernor({ targetMs: 0 })).toThrow();
  });
  it('does not oscillate when load sits just at the edge', () => {
    const g = new QualityGovernor({ targetMs: 20 });
    const trace: number[] = [];
    for (let i = 0; i < 2000; i++) { g.update(26 * (g.scale)); trace.push(g.scale); } // frame time falls as quality falls
    let ups = 0, downs = 0; for (let i = 1; i < trace.length; i++) { if (trace[i]! > trace[i - 1]!) ups++; else if (trace[i]! < trace[i - 1]!) downs++; }
    expect(Math.min(ups, downs)).toBeLessThan(200);
    const tail = trace.slice(-300);
    expect(Math.max(...tail) - Math.min(...tail)).toBeLessThan(0.05);
  });
});
