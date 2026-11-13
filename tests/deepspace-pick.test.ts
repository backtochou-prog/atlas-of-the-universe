import { describe, expect, it } from 'vitest';
import { isPickableWeight, MIN_PICKABLE_DRAW_WEIGHT, pick, type PickCandidate } from '../src/core/deepspace/pick';

const c = (id: string, x: number, y: number, r: number, extra: Partial<PickCandidate> = {}): PickCandidate => ({ id, x, y, radiusPx: r, ...extra });

describe('pick', () => {
  it('returns null when nothing is near', () => { expect(pick([c('a', 0, 0, 10)], { x: 100, y: 100 })).toBeNull(); expect(pick([], { x: 0, y: 0 })).toBeNull(); });
  it('picks the object under the cursor', () => {
    expect(pick([c('a', 0, 0, 10), c('b', 100, 0, 10)], { x: 98, y: 1 })).toMatchObject({ id: 'b', kind: 'inside' });
  });
  it('prefers a smaller object inside a larger one (nebula inside a galaxy-sized region)', () => {
    const r = pick([c('galaxy', 200, 200, 300), c('nebula', 230, 210, 12)], { x: 232, y: 212 });
    expect(r?.id).toBe('nebula');
    // away from the nebula the galaxy is picked
    expect(pick([c('galaxy', 200, 200, 300), c('nebula', 230, 210, 12)], { x: 100, y: 100 })?.id).toBe('galaxy');
  });
  it('gives a tiny object a minimum hit radius', () => {
    expect(pick([c('dot', 50, 50, 0.5)], { x: 55, y: 50 })?.id).toBe('dot');
    expect(pick([c('dot', 50, 50, 0.5)], { x: 57, y: 50 })?.id).toBe('dot');
    expect(pick([c('dot', 50, 50, 0.5)], { x: 65, y: 50 })).toBeNull();
  });
  it('slop: near misses count, but inside beats near even if the near one is smaller', () => {
    const r = pick([c('big', 0, 0, 100), c('small', 120, 0, 10)], { x: 116, y: 0 }); // inside small? 4 px from small centre: inside
    expect(r?.id).toBe('small');
    const r2 = pick([c('big', 0, 0, 100), c('small', 120, 0, 10)], { x: 95, y: 0 }); // 25 px from small: out of range; inside big
    expect(r2?.id).toBe('big');
    const r3 = pick([c('big', 0, 0, 100), c('small', 111, 0, 8)], { x: 100, y: 0 }); // on big's edge (inside) and 11 px from small (near: 8+6)
    expect(r3).toMatchObject({ id: 'big', kind: 'inside' });
  });
  it('tie-breaks: size (>=1 px), then priority, then relative closeness, then id', () => {
    const cur = { x: 0, y: 0 };
    expect(pick([c('b', 0, 0, 20.4, { priority: 0 }), c('a', 0, 0, 20, { priority: 5 })], cur)?.id).toBe('a'); // equal size within 1px -> priority
    expect(pick([c('p', 0, 0, 20, { priority: 5 }), c('q', 0, 0, 20.9, { priority: 9 })], cur)?.id).toBe('q'); // within 1 px: priority decides
    expect(pick([c('p', 0, 0, 20, { priority: 9 }), c('q', 0, 0, 22, { priority: 100 })], cur)?.id).toBe('p'); // >= 1px bigger loses regardless of priority
    expect(pick([c('far', 5, 0, 20), c('near', 1, 0, 20)], cur)?.id).toBe('near');
    expect(pick([c('z', 0, 0, 20), c('y', 0, 0, 20)], cur)?.id).toBe('y');
  });
  it('skips unpickable and non-finite candidates', () => {
    expect(pick([c('x', 0, 0, 10, { pickable: false })], { x: 0, y: 0 })).toBeNull();
    expect(pick([c('x', NaN, 0, 10)], { x: 0, y: 0 })).toBeNull();
  });
  it('is order independent', () => {
    const list = [c('a', 0, 0, 50), c('b', 5, 5, 10), c('c', -3, 2, 10, { priority: 1 })];
    const r1 = pick(list, { x: 0, y: 0 }); const r2 = pick([...list].reverse(), { x: 0, y: 0 });
    expect(r1?.id).toBe(r2?.id);
  });
});

describe('pick: backdrop discs (2MRS structure volume, group rings) never steal a pick', () => {
  const disc = c('twomrs', 400, 300, 1000, { backdrop: true, slopPx: 0 });
  const ring = c('local-group', 400, 300, 5e4, { backdrop: true });
  it('a catalogue point within the slop radius wins over the full-screen 2MRS disc (was: the disc won with class "inside")', () => {
    // the point is 10 px from the cursor with radius 6 => only "near"; the disc contains the cursor => "inside" without the backdrop rule
    const point = c('twomrs:77', 410, 300, 6, { priority: 0 });
    expect(pick([disc, point], { x: 400, y: 300 })).toMatchObject({ id: 'twomrs:77', kind: 'near' });
    expect(pick([point, disc], { x: 400, y: 300 })?.id).toBe('twomrs:77');
  });
  it('a near-miss on a galaxy inside a group ring picks the galaxy, not the group', () => {
    const m31 = c('m31', 410, 300, 5);
    expect(pick([ring, m31], { x: 400, y: 300 })?.id).toBe('m31');
  });
  it('the backdrop is picked only when nothing real is hit or within slop', () => {
    const point = c('twomrs:77', 410, 300, 6);
    expect(pick([disc, point], { x: 300, y: 100 })).toMatchObject({ id: 'twomrs', kind: 'inside' });
    expect(pick([ring], { x: 100, y: 100 })?.id).toBe('local-group');
    // 17 px from the point (radius 6 -> min hit 8, slop 6 => 14 reach): too far, so the backdrop gets the pick
    expect(pick([disc, point], { x: 427, y: 300 })?.id).toBe('twomrs');
  });
  it('the 2MRS disc has no slop of its own: just outside its edge nothing is picked', () => {
    const small = c('twomrs', 0, 0, 20, { backdrop: true, slopPx: 0 });
    expect(pick([small], { x: 24, y: 0 })).toBeNull();
    expect(pick([small], { x: 19, y: 0 })?.id).toBe('twomrs');
  });
  it('a real candidate always beats a backdrop even when the backdrop is much smaller on screen', () => {
    expect(pick([c('backdrop', 0, 0, 9, { backdrop: true }), c('real', 0, 0, 200)], { x: 0, y: 0 })?.id).toBe('real');
  });
});

describe('pickable draw weight', () => {
  it('requires a draw weight above the documented threshold', () => {
    expect(MIN_PICKABLE_DRAW_WEIGHT).toBe(0.05);
    expect(isPickableWeight(0.008)).toBe(false);   // M31 seen from 136 pc: logSmoothstep ~ 0.008
    expect(isPickableWeight(0.05)).toBe(false);
    expect(isPickableWeight(0.0501)).toBe(true);
    expect(isPickableWeight(1)).toBe(true);
    expect(isPickableWeight(NaN)).toBe(false);
  });
});

