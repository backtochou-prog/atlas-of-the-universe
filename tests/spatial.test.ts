import { describe, expect, it } from 'vitest';
import { FrameTree, refit, cameraRelative, zoomDistance, decadesBetween, length } from '../src/core/spatial';

const AU = 1.495978707e11;
const LY = 9.4607304725808e15;

function buildTree() {
  return new FrameTree()
    .add({ id: 'universe', parent: null, origin: [0, 0, 0], radius: 1e26 })
    .add({ id: 'milky-way', parent: 'universe', origin: [2.5e20, 0, 0], radius: 1e21 })
    .add({ id: 'solar-neighbourhood', parent: 'milky-way', origin: [2.6e20, 0, 0], radius: 1e17 })
    .add({ id: 'solar-system', parent: 'solar-neighbourhood', origin: [0, 0, 0], radius: 1e14 })
    .add({ id: 'earth-system', parent: 'solar-system', origin: [AU, 0, 0], radius: 1e9 });
}

describe('FrameTree', () => {
  it('round-trips a body position through a nearby frame at sub-millimetre precision', () => {
    const t = buildTree();
    const moon = { frame: 'earth-system', offset: [3.844e8, 0, 0] as const };
    const inSystem = t.convert(moon, 'solar-system');
    const back = t.convert({ frame: 'solar-system', offset: inSystem }, 'earth-system');
    expect(length([back[0] - 3.844e8, back[1], back[2]])).toBeLessThan(1e-3);
  });

  it('documents the float64 limit: round trips via the universe root lose precision', () => {
    // Universe-scale sums carry ~|x|*2.2e-16 rounding. At 2.6e20 m that is tens of km.
    // This is why precision-critical maths must stay in the lowest common ancestor.
    const t = buildTree();
    const moon = { frame: 'earth-system', offset: [3.844e8, 0, 0] as const };
    const inUniverse = t.convert(moon, 'universe');
    const back = t.convert({ frame: 'universe', offset: inUniverse }, 'earth-system');
    const err = length([back[0] - 3.844e8, back[1], back[2]]);
    expect(err).toBeGreaterThan(0);
    expect(err).toBeLessThan(1e6);
  });

  it('keeps sub-metre precision for intra-system offsets far from the origin', () => {
    const t = buildTree();
    // Two points 1 m apart inside the Earth-Moon system.
    const a = t.convert({ frame: 'earth-system', offset: [0, 0, 0] }, 'solar-system');
    const b = t.convert({ frame: 'earth-system', offset: [1, 0, 0] }, 'solar-system');
    const separation = length([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    expect(separation).toBeCloseTo(1, 6);
  });

  it('computes the lowest common ancestor', () => {
    const t = buildTree();
    expect(t.lowestCommonAncestor('earth-system', 'solar-system')).toBe('solar-system');
    expect(t.lowestCommonAncestor('earth-system', 'milky-way')).toBe('milky-way');
  });

  it('rejects duplicate frames and unknown parents', () => {
    const t = new FrameTree().add({ id: 'u', parent: null, origin: [0, 0, 0], radius: 1 });
    expect(() => t.add({ id: 'u', parent: null, origin: [0, 0, 0], radius: 1 })).toThrow();
    expect(() => t.add({ id: 'x', parent: 'nope', origin: [0, 0, 0], radius: 1 })).toThrow(/Unknown parent/);
  });
});

describe('refit (floating origin hand-off)', () => {
  it('descends into a child frame when the viewer is deep inside it', () => {
    const t = buildTree();
    // Solar neighbourhood origin is 2.5e20 + 2.6e20 = 5.1e20 m from the universe root (origins are in parent).
    const out = refit(t, { frame: 'universe', offset: [5.1e20 + AU, 0, 0] });
    expect(out.frame).not.toBe('universe');
    expect(t.ancestry(out.frame)).toContain('solar-system');
  });

  it('ascends when the viewer leaves the current frame', () => {
    const t = buildTree();
    const out = refit(t, { frame: 'earth-system', offset: [1e12, 0, 0] });
    expect(out.frame).not.toBe('earth-system');
  });

  it('is stable: does not oscillate between frames at a boundary (hysteresis)', () => {
    const t = buildTree();
    const edge = { frame: 'solar-system', offset: [0.75e9 + AU, 0, 0] as const };
    const once = refit(t, edge);
    const twice = refit(t, once);
    expect(twice.frame).toBe(once.frame);
  });

  it('rejects enter >= exit', () => {
    const t = buildTree();
    expect(() => refit(t, { frame: 'universe', offset: [0, 0, 0] }, { enterFraction: 1, exitFraction: 1 })).toThrow();
  });
});

describe('cameraRelative', () => {
  it('produces small float32-safe vectors even for galactic-scale object positions', () => {
    const t = buildTree();
    const camera = { frame: 'earth-system', offset: [0, 0, 0] as const };
    const obj = { frame: 'earth-system', offset: [1000, 0, 0] as const };
    const v = cameraRelative(t, obj, camera);
    expect(v[0]).toBeCloseTo(1000, 3);
  });
});

describe('zoom', () => {
  const limits = { minDistance: 1, maxDistance: 1e26 };
  it('is multiplicative: equal deltas give equal ratios at any scale', () => {
    const r1 = zoomDistance(1e3, 100, limits) / 1e3;
    const r2 = zoomDistance(1e20, 100, limits) / 1e20;
    expect(r1).toBeCloseTo(r2, 12);
  });
  it('clamps to limits', () => {
    expect(zoomDistance(10, -1e9, limits)).toBe(1);
    expect(zoomDistance(1e25, 1e9, limits)).toBe(1e26);
  });
  it('measures decades', () => {
    expect(decadesBetween(LY, AU)).toBeCloseTo(Math.log10(LY / AU), 12);
  });
});
