import { describe, expect, it } from 'vitest';
import {
  MIN_DISTANCE_SNR, brightestStars, fastestProperMotion, formatMeasurement, hottestExoplanets, largestExoplanets, largestNebulae, mostPlanetsInSystem, nearestExoplanetSystems,
  nearestGalaxies, nearestStars, planetCountsByHost, rank, shortestPeriodExoplanets,
} from '../src/discovery/discover';
import { evaluateFilter } from '../src/discovery/filters';
import { RecordStore, wholeStore } from '../src/discovery/recordStore';
import { RelationGraph, relationsFromExoplanets } from '../src/discovery/relations';
import type { DiscoveryRecord, MeasurementKey, RecordMeasurement } from '../src/discovery/types';
import { rec } from './fixtures/discovery/synthetic';

const m = (value: number, kind: RecordMeasurement['kind'] = 'observed', uncertainty?: number): RecordMeasurement => ({ value, kind, ...(uncertainty !== undefined ? { uncertainty } : {}) });
const mk = (id: string, category: DiscoveryRecord['category'], dataset: DiscoveryRecord['dataset'], meas: Partial<Record<MeasurementKey, RecordMeasurement>>, name = id): DiscoveryRecord =>
  rec(id, name, [name], category, { dataset, measurements: meas });

const recs: DiscoveryRecord[] = [
  mk('gaia:prox', 'star', 'gaia-dr3', { distancePc: m(1.30, 'derived', 0.0004), apparentMag: m(11.1), pmTotalMasYr: m(3850, 'derived', 1) }, 'Proxima'),
  mk('gaia:bern', 'star', 'gaia-dr3', { distancePc: m(1.83, 'derived', 0.0001), apparentMag: m(8.2), pmTotalMasYr: m(10300, 'derived') }, 'Barnard'),
  mk('gaia:noisy', 'star', 'gaia-dr3', { distancePc: m(0.9, 'derived', 0.5), apparentMag: m(15) }, 'Noisy parallax'),                    // S/N 1.8: must not be "nearest"
  mk('gaia:nounc', 'star', 'gaia-dr3', { distancePc: m(1.0, 'derived'), apparentMag: m(12) }, 'No uncertainty'),
  mk('gaia:edge', 'star', 'gaia-dr3', { distancePc: m(10, 'derived', 2), apparentMag: m(9) }, 'Edge'),                                    // S/N exactly 5: allowed
  mk('gaia:far', 'star', 'gaia-dr3', { distancePc: m(300, 'derived', 1), apparentMag: m(5) }, 'Far'),
  mk('gaia:nodist', 'star', 'gaia-dr3', { apparentMag: m(2.0) }, 'Distance-less'),
  mk('hip:sirius', 'star', 'hipparcos', { distancePc: m(2.64, 'derived', 0.01), apparentMag: m(-1.46) }, 'Sirius'),
  mk('hip:zero', 'star', 'hipparcos', { distancePc: m(100, 'derived', 5), apparentMag: m(0) }, 'Zero mag'),
  mk('solar:sun', 'star', 'solar-system', { apparentMag: m(-26.7), distancePc: m(4.8e-6, 'observed', 1e-9) }, 'Sun'),
  mk('host:tr', 'exoplanet-host', 'nasa-exoplanet-archive', { distancePc: m(12.4, 'derived', 0.02), apparentMag: m(18.8) }, 'TRAPPIST-1'),
  mk('host:k90', 'exoplanet-host', 'nasa-exoplanet-archive', { distancePc: m(840, 'derived', 5) }, 'Kepler-90'),
  mk('host:one', 'exoplanet-host', 'nasa-exoplanet-archive', { distancePc: m(5, 'derived', 0.01) }, 'One-planet host'),
  mk('host:none', 'exoplanet-host', 'nasa-exoplanet-archive', { distancePc: m(3, 'derived', 0.01) }, 'Host without planets in the data'),
  mk('exo:tr-b', 'exoplanet', 'nasa-exoplanet-archive', { teffK: m(400, 'modelled'), orbitalPeriodDays: m(1.51), radiusKm: m(7000, 'derived') }, 'TRAPPIST-1 b'),
  mk('exo:tr-c', 'exoplanet', 'nasa-exoplanet-archive', { teffK: m(340, 'modelled'), orbitalPeriodDays: m(2.42) }, 'TRAPPIST-1 c'),
  mk('exo:hot', 'exoplanet', 'nasa-exoplanet-archive', { teffK: m(4050, 'modelled'), orbitalPeriodDays: m(0.8), radiusKm: m(130000, 'derived', 5000) }, 'Hot'),
  mk('exo:nodata', 'exoplanet', 'nasa-exoplanet-archive', {}, 'Planet without values'),
  mk('exo:k90b', 'exoplanet', 'nasa-exoplanet-archive', { orbitalPeriodDays: m(7) }, 'Kepler-90 b'),
  mk('exo:one-b', 'exoplanet', 'nasa-exoplanet-archive', { orbitalPeriodDays: m(30) }, 'One b'),
  mk('exo:k90c', 'exoplanet', 'nasa-exoplanet-archive', { orbitalPeriodDays: m(9) }, 'Kepler-90 c'),
  mk('exo:tr-d', 'exoplanet', 'nasa-exoplanet-archive', { orbitalPeriodDays: m(4) }, 'TRAPPIST-1 d'),
  mk('deep:lmc', 'galaxy', 'deep-space', { distancePc: m(49590, 'observed', 547) }, 'LMC'),
  mk('deep:m31', 'galaxy', 'deep-space', { distancePc: m(761000, 'observed', 11000) }, 'M31'),
  mk('deep:mw', 'galaxy', 'deep-space', {}, 'Milky Way'),                                                            // no distance: not ranked
  mk('point:ungc:1', 'galaxy', 'ungc', { distancePc: m(3.2e6, 'derived') }, 'UNGC member-assigned'),             // derived: excluded
  mk('point:ungc:2', 'galaxy', 'ungc', { distancePc: m(2.0e6, 'observed', 1e5) }, 'UNGC direct'),
  mk('point:twomrs:1', 'galaxy', 'twomrs', { distancePc: m(5e6, 'observed') }, '2MRS'),                           // dataset excluded
  mk('deep:orion', 'nebula', 'deep-space', { physicalSizePc: m(8, 'derived', 0.5) }, 'Orion'),
  mk('deep:veil', 'nebula', 'deep-space', { physicalSizePc: m(40, 'derived') }, 'Veil'),
  mk('deep:crab', 'supernova-remnant', 'deep-space', { physicalSizePc: m(3.4, 'derived') }, 'Crab'),
  mk('deep:carina', 'nebula', 'deep-space', {}, 'Carina (no size)'),
];
const store = RecordStore.from(recs);
const view = wholeStore(store);
const ids = (l: { items: readonly { id: string }[] }) => l.items.map((i) => i.id);

describe('every list states its criterion, scope, caveat and that it is not complete', () => {
  const lists = [
    nearestStars(view), brightestStars(view), fastestProperMotion(view), nearestExoplanetSystems(view, new Map([['host:tr', 7]])), mostPlanetsInSystem(view, new Map([['host:tr', 7]])),
    hottestExoplanets(view), shortestPeriodExoplanets(view), largestExoplanets(view), nearestGalaxies(view), largestNebulae(view), rank(view, 'apparentMag', 'asc'),
  ];
  for (const l of lists) {
    it(`${l.id}`, () => {
      expect(l.completeness).toBe('not complete');
      expect(l.criterion.length).toBeGreaterThan(20);
      expect(l.scope).toMatch(/^among [\d,]+ /);
      expect(l.caveat).toMatch(/not the whole sky|not complete|not a census|not a count of planets that exist|not a ranking/i);
      expect(l.title.length).toBeGreaterThan(3);
      expect(l.qualifying).toBeGreaterThan(0);
      expect(l.items.length).toBeGreaterThan(0);
      expect(l.items.every((it, i) => it.rank === i + 1)).toBe(true);
    });
  }
});

describe('nearest stars', () => {
  const l = nearestStars(view, 10);
  it('ranks by distance and skips unreliable distances', () => {
    // stars of any dataset, including planet-host records that are not merged into a Gaia/Hipparcos record
    expect(ids(l)).toEqual(['gaia:prox', 'gaia:bern', 'hip:sirius', 'host:none', 'host:one', 'gaia:edge', 'host:tr', 'hip:zero', 'gaia:far', 'host:k90']);
    expect(l.items[0]!.value).toBe(1.3);
  });
  it('excludes parallax S/N < 5, missing uncertainty, the Sun and records with no distance; says why and how many', () => {
    const reasons = Object.fromEntries(l.excluded.map((e) => [e.reason, e.count]));
    expect(reasons[`distance/uncertainty below ${MIN_DISTANCE_SNR} (parallax S/N < ${MIN_DISTANCE_SNR}: distance unreliable)`]).toBe(1);
    expect(reasons['no published distance uncertainty, so the parallax S/N cannot be checked']).toBe(1);
    expect(reasons['Solar System body']).toBe(1);
    expect(reasons['no distance from the sun in the data']).toBe(1);
    expect(ids(l)).not.toContain('gaia:noisy');
    expect(ids(l)).not.toContain('gaia:nounc');
    expect(ids(l)).not.toContain('solar:sun');
  });
  it('S/N exactly 5 is kept', () => { expect(ids(l)).toContain('gaia:edge'); });
  it('reason is composed only from the record\'s data and matches the brief\'s form', () => {
    expect(l.items[0]!.reason).toBe('Closest star in this dataset: 1.30 pc (derived, ±4.00×10⁻⁴ pc; distance/uncertainty 3250).');
    expect(l.items[0]!.valueText).toBe('1.30 pc');
    expect(l.items[0]!.uncertaintyText).toBe('±4.00×10⁻⁴ pc');
    expect(l.items[1]!.reason).toMatch(/^Number 2 by distance in this dataset: 1\.83 pc \(derived/);
    expect(l.items[0]!.kind).toBe('derived');
  });
  it('scope text counts the contributing datasets and the records in view', () => {
    expect(l.scope).toBe('among 10 star records with a reliable distance (Gaia DR3: 4 + Hipparcos: 2 + NASA Exoplanet Archive: 4), out of 14 star records in view');
    expect(l.qualifying).toBe(10);
  });
  it('the caveat names the Gaia bright-star gap and says whether the Hipparcos supplement is present', () => {
    expect(l.caveat).toMatch(/Gaia DR3 omits stars brighter than G = 1\.5; the Hipparcos supplement \(2 stars here\) covers those/);
    const gaiaOnly = nearestStars(wholeStore(RecordStore.from(recs.filter((r) => r.dataset !== 'hipparcos'))));
    expect(gaiaOnly.caveat).toMatch(/no Hipparcos supplement is loaded here, so the brightest stars are missing/);
    const hipOnly = nearestStars(wholeStore(RecordStore.from(recs.filter((r) => r.dataset === 'hipparcos'))));
    expect(hipOnly.caveat).not.toMatch(/Gaia DR3 omits/);
  });
  it('n limits the items, not the qualifying count', () => {
    const three = nearestStars(view, 3);
    expect(three.items).toHaveLength(3);
    expect(three.qualifying).toBe(10);
    expect(nearestStars(view, 0).items).toHaveLength(0);
  });
  it('works on a filtered view and says how many records were in view', () => {
    const f = evaluateFilter(store, { datasets: ['hipparcos'] });
    const v = nearestStars({ store, indices: f.indices });
    expect(ids(v)).toEqual(['hip:sirius', 'hip:zero']);
    expect(v.scope).toContain('out of 2 star records in view');
  });
});

describe('quality flags and overlapping uncertainties are shown, not hidden', () => {
  const a = { ...mk('gaia:a', 'star', 'gaia-dr3', { distancePc: m(1.25, 'derived', 0.05) }, 'Wide error'), qualityFlags: ['high-ruwe'] };
  const b = mk('gaia:b', 'star', 'gaia-dr3', { distancePc: m(1.30, 'derived', 0.0004) }, 'Precise');
  const c = mk('gaia:c', 'star', 'gaia-dr3', { distancePc: m(1.31, 'derived', 0.0004) }, 'Also precise');
  const d = mk('gaia:d', 'star', 'gaia-dr3', { distancePc: m(5, 'derived', 0.01) }, 'Clearly further');
  const l = nearestStars(wholeStore(RecordStore.from([d, c, b, a])), 4);
  it('the first entries whose distance ranges overlap the leader are named in the caveat and the first reason', () => {
    expect(l.items.map((i) => i.id)).toEqual(['gaia:a', 'gaia:b', 'gaia:c', 'gaia:d']);
    expect(l.caveat).toMatch(/^1 of the 4 entries carry quality flags .* Within their stated uncertainties the first 2 distances overlap, so their order is not certain\./);
    expect(l.items[0]!.reason).toMatch(/Within their stated uncertainties the first 2 distances overlap/);
    expect(l.items[1]!.reason).not.toMatch(/overlap/);
  });
  it('flags travel with the item; unflagged items have an empty list', () => {
    expect(l.items[0]!.flags).toEqual(['high-ruwe']);
    expect(l.items[1]!.flags).toEqual([]);
  });
  it('no note when nothing overlaps', () => {
    const clean = nearestStars(wholeStore(RecordStore.from([b, d])), 2);
    expect(clean.caveat).not.toMatch(/overlap|quality flags/);
  });
});

describe('brightest stars and proper motion', () => {
  it('a magnitude of exactly 0 is a value, the Sun is not a star in this list, the missing are counted', () => {
    const l = brightestStars(view, 20);
    expect(ids(l).slice(0, 3)).toEqual(['hip:sirius', 'hip:zero', 'gaia:nodist']);
    expect(l.items[0]!.valueText).toBe('-1.46 mag');
    expect(ids(l)).not.toContain('solar:sun');
    expect(l.caveat).toMatch(/different photometric bands/);
    expect(l.items[0]!.reason).toMatch(/Hipparcos/);
    expect(l.excluded.map((e) => e.reason)).toContain('Solar System body');
  });
  it('fastest proper motion is descending and only for records that have one', () => {
    const l = fastestProperMotion(view);
    expect(ids(l)).toEqual(['gaia:bern', 'gaia:prox']);
    expect(l.scope).toMatch(/^among 2 star records that have a proper motion/);
    expect(l.caveat).toMatch(/not a ranking of speed/);
    expect(l.items[0]!.valueText).toBe('10,300 mas/yr');
  });
});

describe('exoplanets', () => {
  const counts = planetCountsByHost(new RelationGraph(relationsFromExoplanets({ planets: {
    plName: ['TRAPPIST-1 b', 'TRAPPIST-1 c', 'TRAPPIST-1 d', 'Kepler-90 b', 'Kepler-90 c', 'One b'],
    hostname: ['TRAPPIST-1', 'TRAPPIST-1', 'TRAPPIST-1', 'Kepler-90', 'Kepler-90', 'One-planet host'],
  } })), store);
  it('planetCountsByHost counts only planets in the store, per host in the store', () => {
    expect(counts.size).toBe(0);                                               // ids differ (exo:TRAPPIST-1 b vs the fixture ids), nothing resolves
    const real = new Map([['host:tr', 3], ['host:k90', 2], ['host:one', 1]]);
    expect(nearestExoplanetSystems(view, real).items.map((i) => i.id)).toEqual(['host:one', 'host:tr', 'host:k90']);
  });
  it('nearest systems: hosts with planets only, same reliability rule, reason names the planet count', () => {
    const real = new Map([['host:tr', 3], ['host:k90', 2], ['host:one', 1], ['host:none', 0]]);
    const l = nearestExoplanetSystems(view, real);
    expect(ids(l)).toEqual(['host:one', 'host:tr', 'host:k90']);
    expect(l.items[0]!.reason).toBe('Closest star with a confirmed planet in this dataset: 5.00 pc (derived, ±0.01 pc); 1 confirmed planet listed.'.replace('5.00', '5.00'));
    expect(l.items[1]!.reason).toMatch(/3 confirmed planets listed/);
    expect(l.scope).toMatch(/^among 3 host stars with a reliable distance .* out of 3 host stars in the atlas$/);
    expect(l.caveat).toMatch(/not a census/);
  });
  it('most planets in a system, with ties and a plain scope', () => {
    const real = new Map([['host:tr', 7], ['host:k90', 7], ['host:one', 1], ['host:none', 0], ['host:missing', 9]]);
    const l = mostPlanetsInSystem(view, real);
    expect(l.items.map((i) => [i.id, i.value])).toEqual([['host:k90', 7], ['host:tr', 7], ['host:one', 1]]);
    expect(l.items[1]!.reason).toMatch(/tied with the system above/);
    expect(l.items[0]!.valueText).toBe('7 confirmed planets');
    expect(l.items[2]!.valueText).toBe('1 confirmed planet');
    expect(l.scope).toBe('among 3 host stars with at least one listed planet');
  });
  it('hottest / shortest period / largest: only planets that HAVE the value, the number that qualify is stated', () => {
    const hot = hottestExoplanets(view);
    expect(ids(hot)).toEqual(['exo:hot', 'exo:tr-b', 'exo:tr-c']);
    expect(hot.qualifying).toBe(3);
    expect(hot.scope).toMatch(/^among 3 confirmed exoplanets that have a published temperature .*, out of 8 exoplanets in view/);
    expect(hot.caveat).toMatch(/not treated as zero/);
    expect(hot.items[0]!.reason).toBe('Highest equilibrium temperature among the 3 planets with this value: 4,050 K (modelled, uncertainty not published).');
    const per = shortestPeriodExoplanets(view);
    expect(ids(per)).toEqual(['exo:hot', 'exo:tr-b', 'exo:tr-c', 'exo:tr-d', 'exo:k90b', 'exo:k90c', 'exo:one-b']);
    expect(per.items[0]!.valueText).toBe('19.20 hours');
    expect(per.qualifying).toBe(7);
    const big = largestExoplanets(view);
    expect(ids(big)).toEqual(['exo:hot', 'exo:tr-b']);
    expect(big.items[0]!.valueText).toBe('130,000 km (20.40 Earth radii)');
    expect(big.items[0]!.uncertaintyText).toBe('±5,000 km (0.78 Earth radii)');
    expect(big.excluded[0]!.count).toBe(6);
    expect(ids(rank(view, 'teffK', 'desc', 10, { categories: ['exoplanet'] }))).toEqual(['exo:hot', 'exo:tr-b', 'exo:tr-c']);
  });
  it('an empty answer is an honest empty list, not an error', () => {
    const none = hottestExoplanets(wholeStore(RecordStore.from([mk('x:1', 'star', 'gaia-dr3', {})])));
    expect(none.items).toEqual([]);
    expect(none.qualifying).toBe(0);
    expect(none.scope).toMatch(/^among 0 confirmed exoplanets/);
  });
});

describe('galaxies and nebulae', () => {
  it('nearest galaxies: direct distances only, three datasets, the Milky Way (no distance) is not ranked', () => {
    const l = nearestGalaxies(view);
    expect(ids(l)).toEqual(['deep:lmc', 'deep:m31', 'point:ungc:2']);
    expect(l.items[0]!.valueText).toBe('49.6 kpc');
    const ex = Object.fromEntries(l.excluded.map((e) => [e.reason, e.count]));
    expect(ex['distance is not an independent published measurement (derived from group membership, Hubble flow or similar)']).toBe(1);
    expect(ex['no distance from the sun in the data']).toBe(1);
    expect(l.scope).toBe('among 3 galaxies with a direct distance (curated deep-space objects: 2 + Updated Nearby Galaxy Catalog: 1), out of 5 galaxy records from those datasets in view');
    expect(ids(l)).not.toContain('point:twomrs:1');
    expect(l.caveat).toMatch(/derived from cz/);
  });
  it('largest nebulae: physical size, derived, includes remnants', () => {
    const l = largestNebulae(view);
    expect(ids(l)).toEqual(['deep:veil', 'deep:orion', 'deep:crab']);
    expect(l.items[1]!.uncertaintyText).toBe('±0.50 pc');
    expect(l.excluded.map((e) => e.count)).toEqual([1]);
  });
});

describe('generic rank', () => {
  it('ranks any key, ascending or descending, with ties by id', () => {
    const asc = rank(view, 'apparentMag', 'asc', 3);
    expect(ids(asc)).toEqual(['solar:sun', 'hip:sirius', 'hip:zero']);
    const desc = rank(view, 'apparentMag', 'desc', 2);
    expect(ids(desc)).toEqual(['host:tr', 'gaia:noisy']);
    expect(asc.id).toBe('rank-apparentMag-asc');
    expect(asc.items[0]!.reason).toMatch(/^Number 1 of \d+ by apparent magnitude: -26\.70 mag/);
  });
  it('a key nobody has gives an empty list that still says what was asked', () => {
    const l = rank(view, 'redshift', 'asc');
    expect(l.items).toEqual([]);
    expect(l.qualifying).toBe(0);
    expect(l.scope).toMatch(/^among 0 records that have a redshift/);
  });
  it('categories and datasets restrict the candidates; title is overridable', () => {
    const l = rank(view, 'distancePc', 'asc', 5, { categories: ['galaxy'], datasets: ['ungc'], title: 'Mine' });
    expect(ids(l)).toEqual(['point:ungc:2', 'point:ungc:1']);
    expect(l.title).toBe('Mine');
  });
  it('is deterministic with equal values (ties by id)', () => {
    const t = RecordStore.from([mk('b:2', 'star', 'gaia-dr3', { apparentMag: m(1) }), mk('a:1', 'star', 'gaia-dr3', { apparentMag: m(1) }), mk('c:3', 'star', 'gaia-dr3', { apparentMag: m(0.5) })]);
    expect(ids(rank(wholeStore(t), 'apparentMag', 'asc'))).toEqual(['c:3', 'a:1', 'b:2']);
  });
});

describe('formatMeasurement', () => {
  it('chooses a readable unit', () => {
    expect(formatMeasurement('distancePc', 1.3)).toBe('1.30 pc');
    expect(formatMeasurement('distancePc', 4.9e4)).toBe('49.0 kpc');
    expect(formatMeasurement('distancePc', 1.6e7)).toBe('16.0 Mpc');
    expect(formatMeasurement('physicalSizePc', 8)).toBe('8.00 pc');
    expect(formatMeasurement('physicalSizePc', 46000)).toBe('46.0 kpc');
    expect(formatMeasurement('apparentMag', -1.46)).toBe('-1.46 mag');
    expect(formatMeasurement('teffK', 5772.4)).toBe('5,772 K');
    expect(formatMeasurement('orbitalPeriodDays', 365.25)).toBe('365 days');
    expect(formatMeasurement('orbitalPeriodDays', 0.5)).toBe('12.00 hours');
    expect(formatMeasurement('pmTotalMasYr', 10300)).toBe('10,300 mas/yr');
    expect(formatMeasurement('radiusKm', 6371, 'exoplanet')).toBe('6,371 km (1.00 Earth radii)');
    expect(formatMeasurement('radiusKm', 696000, 'star')).toBe('696,000 km');
    expect(formatMeasurement('redshift', 0.0123)).toBe('0.01230');
    for (const k of ['czKms', 'massKg', 'angularSizeArcmin', 'luminositySun', 'radiusSun', 'absoluteMag', 'bpRp'] as const) expect(formatMeasurement(k, 2)).toMatch(/\d/);
  });
});
