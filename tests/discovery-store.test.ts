import { describe, expect, it } from 'vitest';
import { availableFacets, evaluateFilter } from '../src/discovery/filters';
import { DISTANCE_BANDS, MEASUREMENT_KEYS, NO_BAND, RecordStore, bandOfDistance } from '../src/discovery/recordStore';
import { SPECTRAL_CLASSES, UNKNOWN_SPECTRAL_BIT, parseSpectralType, spectralMask } from '../src/discovery/spectral';
import type { DiscoveryRecord, MeasurementKey, RecordMeasurement } from '../src/discovery/types';
import { rec } from './fixtures/discovery/synthetic';

const m = (value: number, kind: RecordMeasurement['kind'] = 'observed', uncertainty?: number): RecordMeasurement => ({ value, kind, ...(uncertainty !== undefined ? { uncertainty } : {}) });
const star = (id: string, over: Partial<DiscoveryRecord>, meas: Partial<Record<MeasurementKey, RecordMeasurement>>): DiscoveryRecord =>
  rec(id, id, [id], 'star', { measurements: meas, ...over });
const icrs = (d: number): DiscoveryRecord['position'] => ({ kind: 'icrs', xyzPc: [d, 0, 0], raDeg: 0, decDeg: 0 });

describe('spectral type parser', () => {
  const classes = (s: string | undefined | null) => parseSpectralType(s).classes;
  it('main sequence and giants', () => {
    for (const c of ['O', 'B', 'A', 'F', 'G', 'K', 'M']) expect(classes(`${c}5V`)).toEqual([c]);
    expect(parseSpectralType('K1V')).toMatchObject({ primary: 'K', subtype: 1, luminosity: 'V' });
    expect(parseSpectralType('M5.5V')).toMatchObject({ primary: 'M', subtype: 5.5, luminosity: 'V' });
    expect(parseSpectralType('G8III')).toMatchObject({ primary: 'G', subtype: 8, luminosity: 'III' });
    expect(parseSpectralType('A0Ib')).toMatchObject({ primary: 'A', luminosity: 'Ib' });
    expect(parseSpectralType('B2IVe')).toMatchObject({ primary: 'B', luminosity: 'IV' });
    expect(parseSpectralType('M2Iab')).toMatchObject({ primary: 'M', luminosity: 'Iab' });
    expect(classes('G2')).toEqual(['G']);
    expect(classes('F')).toEqual(['F']);
  });
  it('brown dwarfs', () => {
    expect(classes('L5')).toEqual(['L']);
    expect(classes('T6.5')).toEqual(['T']);
    expect(classes('Y0')).toEqual(['Y']);
    expect(classes('L')).toEqual(['L']);
  });
  it('Wolf-Rayet, carbon, S-type, white dwarfs', () => {
    expect(classes('WN5')).toEqual(['W']);
    expect(classes('WC8')).toEqual(['W']);
    expect(classes('WR')).toEqual(['W']);
    expect(classes('C-N5')).toEqual(['C']);
    expect(classes('C5,3')).toEqual(['C']);
    expect(classes('CH')).toEqual(['C']);
    expect(classes('R8')).toEqual(['C']);
    expect(classes('N3')).toEqual(['C']);
    expect(classes('S4/2')).toEqual(['S']);
    expect(classes('S5')).toEqual(['S']);
    for (const wd of ['DA', 'DA2.5', 'DB4', 'DC', 'DQ', 'DZ', 'DO', 'DAV']) expect(classes(wd), wd).toEqual(['D']);
  });
  it('qualifiers in lower case are not classes', () => {
    expect(classes('sdB5')).toEqual(['B']);
    expect(parseSpectralType('sdB5').flags).toContain('subdwarf');
    expect(classes('esdM3')).toEqual(['M']);
    expect(classes('kA2hA5mA7')).toEqual(['A']);
    expect(classes('dM3')).toEqual(['M']);
    expect(classes('gK0')).toEqual(['K']);
    expect(classes('cB2')).toEqual(['B']);
  });
  it('alternatives, ranges and composites name every class they mention', () => {
    expect(classes('G8/K0III')).toEqual(['G', 'K']);
    expect(classes('K1V+K5V')).toEqual(['K']);
    expect(classes('M1-M2V')).toEqual(['M']);
    expect(classes('G8-K0')).toEqual(['G', 'K']);
    expect(classes('F8V+M2')).toEqual(['F', 'M']);
    expect(classes('K0-2')).toEqual(['K']);
    expect(classes('K0III-IV')).toEqual(['K']);
    expect(parseSpectralType('G8/K0III').flags).toContain('alternatives');
    expect(parseSpectralType('K1V+K5V').flags).toContain('composite');
  });
  it('uncertainty marks are flagged, not dropped', () => {
    expect(parseSpectralType('G2V:').flags).toContain('uncertain');
    expect(classes('G2V:')).toEqual(['G']);
    expect(classes('(K0)')).toEqual(['K']);
    expect(parseSpectralType('K?').flags).toContain('uncertain');
  });
  it('anything else is unknown, never guessed', () => {
    for (const s of ['', '   ', 'Sy2', 'SBb', 'E', 'Irr', 'xyz', '??', 'Sc', 'Be', '???', '123', 'Planet', 'Q']) expect(classes(s), JSON.stringify(s)).toEqual(s === 'Be' ? ['B'] : ['unknown']);
    expect(classes(undefined)).toEqual(['unknown']);
    expect(classes(null)).toEqual(['unknown']);
    expect(classes('A'.repeat(100))).toEqual(['unknown']);
    expect(parseSpectralType('').primary).toBe('unknown');
  });
  it('mask helpers', () => {
    expect(spectralMask(['unknown'])).toBe(UNKNOWN_SPECTRAL_BIT);
    expect(spectralMask(['O', 'B'])).toBe(0b11);
    expect(SPECTRAL_CLASSES).toHaveLength(15);
  });
});

describe('distance bands', () => {
  it('have documented, contiguous, increasing bounds', () => {
    const real = DISTANCE_BANDS.filter((b) => b.id !== 'solar-system');
    expect(real.map((b) => b.id)).toEqual(['nearby-stars', 'stellar-neighbourhood', 'galactic-region', 'nearby-galaxies', 'larger-structures']);
    for (let i = 1; i < real.length; i++) expect(real[i]!.minPc).toBe(real[i - 1]!.maxPc);
    for (const b of DISTANCE_BANDS) expect(b.definition.length).toBeGreaterThan(20);
    expect(DISTANCE_BANDS[0]!.id).toBe('solar-system');
  });
  it('boundaries: upper bound inclusive', () => {
    expect(bandOfDistance(1.3)).toBe('nearby-stars');
    expect(bandOfDistance(25)).toBe('nearby-stars');
    expect(bandOfDistance(25.0001)).toBe('stellar-neighbourhood');
    expect(bandOfDistance(1000)).toBe('stellar-neighbourhood');
    expect(bandOfDistance(1000.5)).toBe('galactic-region');
    expect(bandOfDistance(8178)).toBe('galactic-region');
    expect(bandOfDistance(50000)).toBe('galactic-region');
    expect(bandOfDistance(761000)).toBe('nearby-galaxies');
    expect(bandOfDistance(11e6)).toBe('nearby-galaxies');
    expect(bandOfDistance(16.5e6)).toBe('larger-structures');
    expect(bandOfDistance(1e9)).toBe('larger-structures');
  });
  it('no band for a missing, zero, negative or non-finite distance', () => {
    for (const d of [0, -1, NaN, Infinity, -Infinity]) expect(bandOfDistance(d)).toBeUndefined();
  });
});

describe('RecordStore', () => {
  const recs: DiscoveryRecord[] = [
    star('a', { position: icrs(1.3), spectralType: 'M5V' }, { distancePc: m(1.3), apparentMag: m(11) }),
    star('b', { position: icrs(300), spectralType: 'G2V' }, { distancePc: m(300), apparentMag: m(5) }),
    star('c', { spectralType: 'K0' }, { apparentMag: m(0, 'observed') }),        // a real zero magnitude is a value
    star('d', {}, {}),
    rec('sun', 'Sun', ['Sun'], 'star', { dataset: 'solar-system', position: { kind: 'solar', bodyId: 'sun' }, spectralType: 'G2V', measurements: { teffK: m(5772) } }),
    rec('g', 'Galaxy', ['Galaxy'], 'galaxy', { dataset: 'deep-space', position: icrs(7.6e5), measurements: { distancePc: m(7.6e5, 'observed', 1.1e4), angularSizeArcmin: m(177.8) } }),
  ];
  const store = RecordStore.from(recs);
  it('stores values with a presence bit; absent is not zero', () => {
    expect(store.value('apparentMag', 2)).toBe(0);
    expect(store.has('apparentMag', 2)).toBe(true);
    expect(store.has('apparentMag', 3)).toBe(false);
    expect(store.value('apparentMag', 3)).toBeUndefined();
    expect(store.value('distancePc', 2)).toBeUndefined();
    expect(store.uncertainty('distancePc', 5)).toBe(1.1e4);
    expect(store.uncertainty('distancePc', 0)).toBeUndefined();
    expect(store.kind('distancePc', 5)).toBe('observed');
    expect(store.kind('distancePc', 3)).toBeUndefined();
  });
  it('only keys with data have a column', () => {
    expect(store.column('redshift')).toBeUndefined();
    expect(store.column('massKg')).toBeUndefined();
    expect(store.column('teffK')).toBeDefined();
    expect(store.keysWithData().sort()).toEqual(['angularSizeArcmin', 'apparentMag', 'distancePc', 'teffK']);
  });
  it('NaN or infinite values are treated as not available', () => {
    const s = RecordStore.from([star('x', {}, { apparentMag: m(NaN), teffK: m(Infinity), distancePc: m(5) })]);
    expect(s.has('apparentMag', 0)).toBe(false);
    expect(s.column('apparentMag')).toBeUndefined();
    expect(s.has('teffK', 0)).toBe(false);
    expect(s.has('distancePc', 0)).toBe(true);
  });
  it('bands, spectral masks, positions', () => {
    expect(store.bandAt(0)).toBe('nearby-stars');
    expect(store.bandAt(1)).toBe('stellar-neighbourhood');
    expect(store.bandAt(2)).toBeUndefined();
    expect(store.bandIdx[3]).toBe(NO_BAND);
    expect(store.bandAt(4)).toBe('solar-system');
    expect(store.bandAt(5)).toBe('nearby-galaxies');
    expect(store.spectral[3]).toBe(UNKNOWN_SPECTRAL_BIT);
    expect(store.hasPosition(0)).toBe(true);
    expect(store.hasPosition(2)).toBe(false);
    expect(store.xyz[3 * 1]).toBe(300);
  });
  it('id lookup', () => {
    expect(store.indexOfId('b')).toBe(1);
    expect(store.indexOfId('nope')).toBe(-1);
    expect(store.recordAt(1).id).toBe('b');
  });
  it('an empty store works', () => {
    const e = RecordStore.from([]);
    expect(e.count).toBe(0);
    expect(evaluateFilter(e, { categories: ['star'] }).count).toBe(0);
    expect(availableFacets(e).measurements).toEqual([]);
    expect(availableFacets(e).unavailableKeys).toEqual([...MEASUREMENT_KEYS]);
  });
  it('a band is taken from the position when the distance measurement is absent', () => {
    const s = RecordStore.from([star('p', { position: icrs(30) }, {})]);
    expect(s.bandAt(0)).toBe('stellar-neighbourhood');
  });
});

describe('filters', () => {
  const recs: DiscoveryRecord[] = [
    star('a', { position: icrs(1.3), spectralType: 'M5V' }, { distancePc: m(1.3), apparentMag: m(11), teffK: m(3000) }),
    star('b', { position: icrs(300), spectralType: 'G2V' }, { distancePc: m(300), apparentMag: m(5), teffK: m(5800) }),
    star('c', { spectralType: 'K0' }, { apparentMag: m(0) }),
    star('d', {}, {}),
    star('e', { position: icrs(20), dataset: 'hipparcos', spectralType: 'G8/K0III' }, { distancePc: m(20), apparentMag: m(3), teffK: m(4800) }),
    rec('g', 'Galaxy', ['Galaxy'], 'galaxy', { dataset: 'deep-space', position: icrs(7.6e5), measurements: { distancePc: m(7.6e5), apparentMag: m(4.4) } }),
  ];
  const store = RecordStore.from(recs);
  const names = (r: { indices: Int32Array }): string[] => [...r.indices].map((i) => store.idAt(i));

  it('no filter returns everything, with no exclusions', () => {
    const r = evaluateFilter(store, {});
    expect(r.count).toBe(6);
    expect(r.scope).toBe(6);
    expect(r.excludedForMissing).toEqual({});
    expect(r.excludedAny).toBe(0);
  });
  it('categories and datasets (AND)', () => {
    expect(names(evaluateFilter(store, { categories: ['galaxy'] }))).toEqual(['g']);
    expect(names(evaluateFilter(store, { categories: ['star'], datasets: ['hipparcos'] }))).toEqual(['e']);
    expect(names(evaluateFilter(store, { categories: ['galaxy'], datasets: ['hipparcos'] }))).toEqual([]);
  });
  it('numeric range: records missing the value are excluded and counted, never treated as 0', () => {
    const r = evaluateFilter(store, { categories: ['star'], ranges: { distancePc: { max: 100 } } });
    expect(names(r)).toEqual(['a', 'e']);
    expect(r.scope).toBe(5);
    expect(r.excludedForMissing).toEqual({ distancePc: 2 });       // c and d have no distance
    expect(r.excludedAny).toBe(2);
    // a range that includes 0 must not rescue records with no value
    const z = evaluateFilter(store, { categories: ['star'], ranges: { apparentMag: { min: -1, max: 1 } } });
    expect(names(z)).toEqual(['c']);                                // the only real 0
    expect(z.excludedForMissing).toEqual({ apparentMag: 1 });       // d
  });
  it('a real zero is a value and passes a range that contains it', () => {
    expect(names(evaluateFilter(store, { ranges: { apparentMag: { max: 0 } } }))).toEqual(['c']);
  });
  it('inclusive bounds, open ends, several ranges combined with AND', () => {
    expect(names(evaluateFilter(store, { categories: ['star'], ranges: { apparentMag: { min: 3, max: 5 } } }))).toEqual(['b', 'e']);
    expect(names(evaluateFilter(store, { categories: ['star'], ranges: { apparentMag: { min: 4 } } }))).toEqual(['a', 'b']);
    const both = evaluateFilter(store, { categories: ['star'], ranges: { apparentMag: { max: 5 }, teffK: { min: 4000 } } });
    expect(names(both)).toEqual(['b', 'e']);
    expect(both.excludedForMissing).toEqual({ apparentMag: 1, teffK: 2 });   // d lacks mag; c and d lack teff
    expect(both.excludedAny).toBe(2);                                          // c, d (d counted once though it misses both)
  });
  it('a range on a key with no data at all excludes the whole scope and says so', () => {
    const r = evaluateFilter(store, { categories: ['star'], ranges: { redshift: { max: 1 } } });
    expect(r.count).toBe(0);
    expect(r.excludedForMissing).toEqual({ redshift: 5 });
  });
  it('NaN bounds are rejected, an inverted range is simply empty', () => {
    expect(() => evaluateFilter(store, { ranges: { distancePc: { min: NaN } } })).toThrow(RangeError);
    expect(evaluateFilter(store, { ranges: { distancePc: { min: 10, max: 1 } } }).count).toBe(0);
    expect(evaluateFilter(store, { ranges: { distancePc: {} } }).count).toBe(6);       // an empty range is no filter
  });
  it('distance bands: records with no distance are excluded and counted under distanceBand', () => {
    const r = evaluateFilter(store, { distanceBands: ['nearby-stars', 'stellar-neighbourhood'] });
    expect(names(r)).toEqual(['a', 'b', 'e']);
    expect(r.excludedForMissing.distanceBand).toBe(2);
    expect(names(evaluateFilter(store, { distanceBands: ['nearby-galaxies'] }))).toEqual(['g']);
    expect(names(evaluateFilter(store, { distanceBands: ['solar-system'] }))).toEqual([]);
  });
  it('spectral classes: any named class matches; unknown is selectable; records without a type are excluded and counted otherwise', () => {
    const k = evaluateFilter(store, { categories: ['star'], spectralClasses: ['K'] });
    expect(names(k)).toEqual(['c', 'e']);                           // e is "G8/K0III": possibly K
    expect(k.excludedForMissing.spectralClass).toBe(1);             // d
    expect(names(evaluateFilter(store, { categories: ['star'], spectralClasses: ['G'] }))).toEqual(['b', 'e']);
    expect(names(evaluateFilter(store, { categories: ['star'], spectralClasses: ['unknown'] }))).toEqual(['d']);
    expect(names(evaluateFilter(store, { categories: ['star'], spectralClasses: ['M', 'unknown'] }))).toEqual(['a', 'd']);
    const g = evaluateFilter(store, { spectralClasses: ['G'] });
    expect(g.excludedForMissing.spectralClass).toBe(2);             // d and the galaxy have no spectral type
  });
  it('everything combines with AND', () => {
    const r = evaluateFilter(store, { categories: ['star'], distanceBands: ['nearby-stars', 'stellar-neighbourhood'], spectralClasses: ['G', 'K'], ranges: { apparentMag: { max: 6 } } });
    expect(names(r)).toEqual(['b', 'e']);
  });
  it('is deterministic and indices are ascending', () => {
    const a = evaluateFilter(store, { categories: ['star'] });
    const b = evaluateFilter(store, { categories: ['star'] });
    expect([...a.indices]).toEqual([...b.indices]);
    expect([...a.indices]).toEqual([...a.indices].sort((x, y) => x - y));
  });
});

describe('facets', () => {
  const recs: DiscoveryRecord[] = [
    star('a', { position: icrs(5), spectralType: 'M5V' }, { distancePc: m(5, 'derived'), apparentMag: m(11), teffK: m(3000, 'modelled') }),
    star('b', { position: icrs(300), spectralType: 'G2V' }, { distancePc: m(300, 'derived'), apparentMag: m(-2) }),
    rec('g', 'G', ['G'], 'galaxy', { dataset: 'deep-space', position: icrs(7.6e5), measurements: { distancePc: m(7.6e5, 'observed') } }),
  ];
  const store = RecordStore.from(recs);
  const f = availableFacets(store);
  it('reports only keys that have data, with counts, min, max and kinds', () => {
    expect(f.measurements.map((x) => x.key)).toEqual(['distancePc', 'apparentMag', 'teffK']);
    const d = f.measurements.find((x) => x.key === 'distancePc')!;
    expect(d).toMatchObject({ count: 3, min: 5, max: 7.6e5, byKind: { observed: 1, derived: 2, modelled: 0 } });
    expect(f.measurements.find((x) => x.key === 'apparentMag')).toMatchObject({ count: 2, min: -2, max: 11 });
    expect(f.measurements.find((x) => x.key === 'teffK')).toMatchObject({ count: 1, byKind: { modelled: 1 } });
  });
  it('lists the keys with no data so the UI does not offer them', () => {
    expect(f.unavailableKeys).toContain('redshift');
    expect(f.unavailableKeys).toContain('massKg');
    expect(f.unavailableKeys).not.toContain('distancePc');
    expect(f.measurements.length + f.unavailableKeys.length).toBe(MEASUREMENT_KEYS.length);
  });
  it('categories, datasets, bands and spectral classes only list what exists', () => {
    expect(f.categories).toEqual([{ id: 'star', count: 2 }, { id: 'galaxy', count: 1 }]);
    expect(f.datasets).toEqual([{ id: 'gaia-dr3', count: 2 }, { id: 'deep-space', count: 1 }]);
    expect(f.distanceBands).toEqual([{ id: 'nearby-stars', count: 1 }, { id: 'stellar-neighbourhood', count: 1 }, { id: 'nearby-galaxies', count: 1 }]);
    expect(f.withoutDistanceBand).toBe(0);
    expect(f.spectralClasses).toEqual([{ id: 'G', count: 1 }, { id: 'M', count: 1 }, { id: 'unknown', count: 1 }]);
    expect(f.total).toBe(3);
  });
});
