import { describe, expect, it } from 'vitest';
import type { Facets } from '../src/discovery/filters';
import type { FilterOutcome } from '../src/discovery/engineApi';
import { evaluateFilter } from '../src/discovery/filters';
import { RecordStore } from '../src/discovery/recordStore';
import { availableFacets } from '../src/discovery/filters';
import type { DiscoveryRecord } from '../src/discovery/types';
import {
  EMPTY_FILTER, bandBounds, excludedLines, hasFilterParams, isEmptyFilter, offeredBands, offeredCategories, offeredMeasurements, parseBound, parseFilter, serializeFilter, summariseFilter, toSpec, toggle, withRange,
  HIGHLIGHT_MAX,
} from '../src/ui/discovery/filterViewModel';

const rec = (id: string, o: Partial<DiscoveryRecord> = {}): DiscoveryRecord => ({
  id, dataset: 'gaia-dr3', category: 'star', name: id, designations: [id], classification: 'Star', position: { kind: 'icrs', xyzPc: [1, 0, 0], raDeg: 0, decDeg: 0 },
  measurements: {}, drawn: true, sourceKey: 'k', ...o,
});
const m = (value: number, kind: 'observed' | 'derived' | 'modelled' = 'observed') => ({ value, kind });
const records: DiscoveryRecord[] = [
  rec('a', { measurements: { distancePc: m(4, 'derived'), teffK: m(5000, 'modelled') }, spectralType: 'K2V' }),
  rec('b', { measurements: { distancePc: m(10, 'derived'), teffK: m(3300, 'modelled') }, spectralType: 'M1V' }),
  rec('c', { measurements: { distancePc: m(12, 'derived') }, spectralType: 'G2V' }),                  // no temperature
  rec('d', { measurements: { distancePc: m(400, 'derived'), teffK: m(9000, 'modelled') }, spectralType: 'A1V' }),
  rec('e', { category: 'galaxy', dataset: 'ungc', measurements: { distancePc: m(8e5, 'derived') } }),
  rec('f', { category: 'galaxy', dataset: 'ungc', position: { kind: 'sky-only', raDeg: 1, decDeg: 1 } }),   // no distance at all
];
const store = RecordStore.from(records);
const facets = availableFacets(store);

describe('filters offered only where there are data', () => {
  it('numeric ranges are offered for the measurements the facets say have values, with "n of N"', () => {
    const offers = offeredMeasurements(facets);
    const keys = offers.map((o) => o.key);
    expect(keys).toContain('distancePc');
    expect(keys).toContain('teffK');
    expect(keys).not.toContain('radiusKm');          // no record has a radius: not offered at all
    expect(keys).not.toContain('redshift');
    for (const k of facets.unavailableKeys) expect(keys).not.toContain(k);
    const teff = offers.find((o) => o.key === 'teffK')!;
    expect(teff.haveText).toBe('3 of 6 records have this value');
    expect(teff.unit).toBe('K');
  });
  it('categories and bands carry their counts and named bounds', () => {
    expect(offeredCategories(facets).map((c) => c.id).sort()).toEqual(['galaxy', 'star']);
    const bands = offeredBands(facets);
    const nearby = bands.find((b) => b.id === 'nearby-stars')!;
    expect(nearby.bounds).toBe('up to 25 pc');
    expect(nearby.count).toBe(3);
    expect(bandBounds('stellar-neighbourhood')).toBe('25 pc to 1 kpc');
    expect(bandBounds('nearby-galaxies')).toBe('50 kpc to 11 Mpc');
    expect(bandBounds('larger-structures')).toBe('beyond 11 Mpc');
    expect(bandBounds('solar-system')).toBe('Solar System bodies');
  });
});

describe('filter state', () => {
  it('maps to the engine spec and drops empty ranges', () => {
    expect(toSpec(EMPTY_FILTER)).toEqual({});
    const s = withRange({ ...EMPTY_FILTER, categories: ['star'], bands: ['nearby-stars'] }, 'teffK', { min: 3000, max: 6000 });
    expect(toSpec(s)).toEqual({ categories: ['star'], distanceBands: ['nearby-stars'], ranges: { teffK: { min: 3000, max: 6000 } } });
    expect(isEmptyFilter(s)).toBe(false);
    expect(isEmptyFilter(withRange(s, 'teffK', {}))).toBe(false);   // categories and bands remain
    expect(Object.keys(withRange(s, 'teffK', {}).ranges)).toEqual([]);
  });
  it('AND semantics: the engine applies every chosen filter together', () => {
    const s = withRange({ ...EMPTY_FILTER, categories: ['star'], bands: ['nearby-stars'] }, 'teffK', { min: 3000, max: 6000 });
    const out = evaluateFilter(store, toSpec(s));
    expect(out.count).toBe(2);                              // a and b: star AND within 25 pc AND 3000..6000 K; c has no temperature, d is too far
    expect(out.excludedForMissing.teffK).toBe(1);          // c: counted, never treated as 0 K
    const ids = [...out.indices].map((i) => records[i]!.id);
    expect(ids).toEqual(['a', 'b']);
  });
  it('toggle adds and removes', () => {
    expect(toggle(['star'], 'galaxy')).toEqual(['star', 'galaxy']);
    expect(toggle(['star', 'galaxy'], 'star')).toEqual(['galaxy']);
  });
  it('bounds parse: empty is open, numbers with commas or exponents are fine, text is invalid', () => {
    expect(parseBound('')).toEqual({ ok: true, value: undefined });
    expect(parseBound(' 3,000 ')).toEqual({ ok: true, value: 3000 });
    expect(parseBound('1e4')).toEqual({ ok: true, value: 10000 });
    expect(parseBound('-0.5')).toEqual({ ok: true, value: -0.5 });
    expect(parseBound('abc')).toEqual({ ok: false });
    expect(parseBound('NaN')).toEqual({ ok: false });
  });
});

describe('URL hash round trip', () => {
  it('serialises and parses the same state', () => {
    const s = withRange(withRange({ categories: ['star', 'galaxy'] as const, datasets: ['gaia-dr3'] as const, bands: ['nearby-stars'] as const, spectral: ['G', 'K'] as const, ranges: {} }, 'teffK', { min: 3000, max: 6000 }), 'bpRp', { min: -0.5 });
    const h = serializeFilter(s);
    expect(h).toBe('f.cat=star,galaxy&f.ds=gaia-dr3&f.band=nearby-stars&f.sp=G,K&f.r.teffK=3000..6000&f.r.bpRp=-0.5..');
    expect(parseFilter(h)).toEqual(s);
    expect(parseFilter(`#${h}`)).toEqual(s);
    expect(hasFilterParams(`#d=filter&${h}`)).toBe(true);
    expect(hasFilterParams('#other=1')).toBe(false);
  });
  it('empty state is an empty string and round trips', () => {
    expect(serializeFilter(EMPTY_FILTER)).toBe('');
    expect(parseFilter('')).toEqual(EMPTY_FILTER);
  });
  it('unknown names and malformed numbers are ignored, never trusted', () => {
    const p = parseFilter('f.cat=star,nonsense&f.band=made-up&f.sp=Q&f.r.teffK=abc..5&f.r.notAKey=1..2&f.r.radiusKm=..7');
    expect(p.categories).toEqual(['star']);
    expect(p.bands).toEqual([]);
    expect(p.spectral).toEqual([]);
    expect(p.ranges).toEqual({ radiusKm: { max: 7 } });
  });
});

describe('sentences about excluded records', () => {
  it('states plainly how many records without a value are not included', () => {
    const lines = excludedLines({ excludedForMissing: { teffK: 1204, distanceBand: 1, spectralClass: 3 } });
    expect(lines).toEqual([
      '1,204 records without a temperature are not included.',
      '1 record without a distance is not included.',
      '3 records without a usable spectral type are not included.',
    ]);
  });
  it('says nothing when nothing was excluded', () => {
    expect(excludedLines({ excludedForMissing: { teffK: 0 } })).toEqual([]);
  });
  it('a summary reports count, scope, windowing and provisional counts', () => {
    const out: FilterOutcome = { count: 2092, scope: 31781, excludedForMissing: { teffK: 17877 }, excludedAny: 17877, ids: Array.from({ length: 256 }, (_, i) => `gaia:${i}`), truncated: true, complete: false };
    const s = summariseFilter(out);
    expect(s.countText).toBe('2,092 records match');
    expect(s.scopeText).toContain('31,781');
    expect(s.excluded[0]).toBe('17,877 records without a temperature are not included.');
    expect(s.windowText).toBe('showing 40 of 2,092; refine the filters');
    expect(s.provisional).toMatch(/still loading/);
    expect(s.highlightCount).toBe(HIGHLIGHT_MAX);
  });
  it('the facets total is what "n of N" refers to', () => {
    const f: Facets = facets;
    expect(f.total).toBe(6);
  });
});
