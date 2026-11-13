/**
 * End to end on the REAL datasets held by the atlas: adapters -> merge -> search index -> store -> filters/facets -> discovery lists ->
 * relation graph -> nearby. Skipped, with a visible reason, when a data file is absent. Assertions are about structure and about facts the
 * data files themselves state; there are no hand-typed astronomy claims beyond what the datasets contain.
 */
import { describe, expect, it } from 'vitest';
import { createUniverseFrames, NEIGHBOURHOOD_FRAME } from '../src/data/catalogue/frames';
import { METRES_PER_PARSEC } from '../src/core/units';
import { brightestStars, mostPlanetsInSystem, nearestExoplanetSystems, nearestGalaxies, nearestStars, planetCountsByHost } from '../src/discovery/discover';
import { availableFacets, evaluateFilter } from '../src/discovery/filters';
import { SOLAR_SYSTEM_FRAME, findNearby, heliocentricDomain, originOf, solarDomain } from '../src/discovery/nearby';
import { NavigationController, type NavigationHost, type FocusPlan, type CameraSnapshot } from '../src/discovery/navigation';
import {
  mergeRecords, recordsFromBrightStars, recordsFromDeep, recordsFromExoplanets, recordsFromGaia, recordsFromOther, recordsFromPoints, recordsFromSolar,
} from '../src/discovery/records';
import { RecordStore, wholeStore } from '../src/discovery/recordStore';
import { RelationGraph, parseRelationsFile, relationsFromDeep, relationsFromExoplanets, relationsFromSameAs, relationsFromSolar } from '../src/discovery/relations';
import { SearchIndex } from '../src/discovery/searchIndex';
import { buildSpatialIndex } from '../src/discovery/spatialIndex';
import type { BrightStarFile, DiscoveryRecord, ExoplanetFile, OtherObjectsFile, UniversalId } from '../src/discovery/types';
import { have, loadDeep, loadGaia, loadPoints, loadSolar, readGz, readJson } from './fixtures/discovery/real';

const ALL = ['gaia-dr3-subset.v1.json.gz', 'simbad-crossid.v1.json.gz', 'solar-system.v1.json', 'deep-space.v1.json', 'deepspace/ungc.v1.json.gz', 'deepspace/local-group-mcconnachie.v1.json.gz', 'deepspace/twomrs.v1.json.gz', 'bright-stars.v1.json.gz', 'exoplanets.v1.json.gz', 'other-objects.v1.json'];
const missing = ALL.filter((f) => !have(f));

describe.skipIf(missing.length > 0)(`atlas end to end${missing.length ? ` (SKIPPED: missing ${missing.join(', ')})` : ''}`, () => {
  const solar = loadSolar(), deep = loadDeep();
  const { cat, simbad } = loadGaia();
  const raw: DiscoveryRecord[] = [
    ...recordsFromGaia(cat, simbad), ...recordsFromBrightStars(readGz<BrightStarFile>('bright-stars.v1.json.gz')), ...recordsFromSolar(solar), ...recordsFromDeep(deep),
    ...['ungc', 'local-group-mcconnachie', 'twomrs'].flatMap((id) => recordsFromPoints(loadPoints(id))),
    ...recordsFromExoplanets(readGz<ExoplanetFile>('exoplanets.v1.json.gz')), ...recordsFromOther(readJson<OtherObjectsFile>('other-objects.v1.json')),
  ];
  const exoFile = readGz<ExoplanetFile>('exoplanets.v1.json.gz');
  const followHost = new Map(relationsFromExoplanets(exoFile).map((r) => [r.from, r.to] as const));
  const merged = mergeRecords(raw, { followHost });
  const records = merged.records;
  const index = new SearchIndex();
  index.add(records);
  const store = RecordStore.from(records);

  const exoRels = relationsFromExoplanets(exoFile);
  const loaded = new Set(records.map((r) => r.id));
  const names = new Map<string, Map<string, number>>();
  for (const id of ['ungc', 'local-group-mcconnachie', 'twomrs']) {
    const m = new Map<string, number>();
    (loadPoints(id).columns['name'] ?? []).forEach((n, i) => { if (typeof n === 'string' && !m.has(n)) m.set(n, i); });
    names.set(id, m);
  }
  const graph = new RelationGraph(
    [...relationsFromSolar(solar), ...relationsFromDeep(deep.all() as never, { pointRow: (f, n) => names.get(f)?.get(n) }), ...exoRels, ...relationsFromSameAs(records, { known: (id) => loaded.has(id) })],
    merged.aliases,
  );

  it('the merged atlas has one record per object and valid relations', () => {
    expect(merged.warnings).toEqual([]);
    expect(new Set(records.map((r) => r.id)).size).toBe(records.length);
    const known = new Set(records.map((r) => r.id));
    for (const a of merged.aliases.keys()) known.add(a);
    const issues = graph.validate(known);
    expect(issues.map((i) => `${i.code}: ${i.message}`).slice(0, 5)).toEqual([]);
    console.log(`[atlas] ${records.length.toLocaleString('en-US')} records (${raw.length.toLocaleString('en-US')} before merging, ${merged.aliases.size.toLocaleString('en-US')} duplicates folded), ${graph.size.toLocaleString('en-US')} relations`);
  });

  it.skipIf(!have('relations.v1.json'))('the curated relations file (public/data/relations.v1.json) parses, validates, and every id resolves in the merged atlas', () => {
    const parsed = parseRelationsFile(readJson('relations.v1.json'));
    expect(parsed.issues.map((i) => i.message)).toEqual([]);
    expect(parsed.relations.length).toBeGreaterThan(0);
    const known = new Set(records.map((r) => r.id));
    for (const a of merged.aliases.keys()) known.add(a);
    const g = new RelationGraph(parsed.relations, merged.aliases);
    expect(g.validate(known).map((i) => `${i.code}: ${i.message}`)).toEqual([]);
    // physical relations all carry a source; association relations are never stated as physical
    expect(parsed.relations.filter((r) => r.basis === 'physical-gravitational').every((r) => r.source.label.length > 0)).toBe(true);
    // together with the dataset-derived relations the whole graph still has no cycles
    const all = new RelationGraph([...graph.all(), ...parsed.relations], merged.aliases);
    expect(all.validate(known).filter((i) => i.code === 'cycle')).toEqual([]);
  });

  it('the identifiers named in the brief all find their object', () => {
    const first = (q: string): string => index.search(q).hits[0]?.id ?? '(none)';
    expect(first('Sirius')).toBe('hip:32349');
    expect(first('alf CMa')).toBe('hip:32349');
    expect(first('alpha CMa')).toBe('hip:32349');
    expect(first('α CMa')).toBe('hip:32349');
    expect(first('HIP 32349')).toBe('hip:32349');
    expect(first('HIP32349')).toBe('hip:32349');
    expect(first('M31')).toBe('deep:m31');
    expect(first('M 31')).toBe('deep:m31');
    expect(first('Messier 31')).toBe('deep:m31');
    expect(first('NGC 224')).toBe('deep:m31');
    expect(first('NGC224')).toBe('deep:m31');
    expect(first('Gaia DR3 4472832130942575872')).toBe('gaia:4472832130942575872');
    expect(first('gaia 4472832130942575872')).toBe('gaia:4472832130942575872');
    expect(first('4472832130942575872')).toBe('gaia:4472832130942575872');
    const trappist = merged.aliases.get('host:TRAPPIST-1') ?? 'host:TRAPPIST-1';          // the archive host is folded into the Gaia record when the star is in the Gaia subset
    expect(first('TRAPPIST-1')).toBe(trappist);
    expect(first('TRAPPIST 1')).toBe(trappist);
    expect(first('Kepler-452b')).toBe('exo:Kepler-452 b');
    expect(first('Kepler-452 b')).toBe('exo:Kepler-452 b');
    expect(first('Sgr A*')).toBe('other:sgr-a-star');
    expect(first('Sagittarius A*')).toBe('other:sgr-a-star');
    expect(first('PSR B0531+21')).toBe('other:crab-pulsar');
    expect(first('Betelgeuse')).toBe('hip:27989');
    expect(first('Betelgeuze')).toBe('hip:27989');     // a typo, flagged fuzzy
    expect(index.search('Betelgeuze').hits[0]!.matchKind).toBe('fuzzy');
    expect(first('Mars')).toBe('solar:mars');
    expect(first('Crab Nebula')).toBe('deep:crab-nebula');
  });

  it('M3 / NGC 22 / HIP 3 are not conflated with M31 / NGC 224 / HIP 32349 in the real index', () => {
    for (const [q, notId] of [['M3', 'deep:m31'], ['NGC 22', 'deep:m31'], ['HIP 3', 'hip:32349']] as const) {
      const exact = index.search(q).hits.filter((h) => h.matchKind === 'exact').map((h) => h.id);
      expect(exact, q).not.toContain(notId);
    }
  });

  it('a star known under several designations is searchable by all of them and is listed once', () => {
    const sirius = index.get('hip:32349')!;
    expect(sirius.designations.length).toBeGreaterThan(3);
    for (const d of sirius.designations.slice(0, 8)) expect(index.search(d, { limit: 50 }).hits.map((h) => h.id), d).toContain('hip:32349');
    const alpha = index.search('Proxima Centauri', { limit: 10 }).hits.filter((h) => h.category === 'star' || h.category === 'exoplanet-host');
    expect(new Set(alpha.map((h) => h.id)).size).toBe(alpha.length);
    const proxima = index.resolveDesignation('Proxima Centauri');
    expect(proxima.length).toBeGreaterThanOrEqual(1);
    expect(merged.aliases.size).toBeGreaterThan(5000);
  });

  it('facets offer only keys that have data, with counts', () => {
    const f = availableFacets(store);
    expect(f.unavailableKeys).toContain('redshift');
    expect(f.measurements.map((m) => m.key)).toContain('distancePc');
    for (const m of f.measurements) { expect(m.count).toBeGreaterThan(0); expect(m.min).toBeLessThanOrEqual(m.max); expect(m.byKind.observed + m.byKind.derived + m.byKind.modelled).toBe(m.count); }
    expect(f.categories.map((c) => c.id)).toEqual(expect.arrayContaining(['star', 'planet', 'moon', 'exoplanet', 'exoplanet-host', 'galaxy', 'nebula', 'star-cluster', 'galaxy-group', 'galaxy-cluster', 'supernova-remnant', 'other']));
    expect(f.distanceBands.map((b) => b.id)).toEqual(['solar-system', 'nearby-stars', 'stellar-neighbourhood', 'galactic-region', 'nearby-galaxies', 'larger-structures']);
    expect(f.total).toBe(records.length);
  });

  it('filters: AND semantics, counts of excluded records, never treating missing as zero', () => {
    const r = evaluateFilter(store, { categories: ['star'], distanceBands: ['nearby-stars'], ranges: { apparentMag: { max: 12 } } });
    expect(r.count).toBeGreaterThan(5);
    for (const i of r.indices) { expect(store.categoryAt(i)).toBe('star'); expect(store.bandAt(i)).toBe('nearby-stars'); expect(store.value('apparentMag', i)!).toBeLessThanOrEqual(12); expect(store.value('distancePc', i)!).toBeLessThanOrEqual(25); }
    const k = evaluateFilter(store, { categories: ['exoplanet'], ranges: { radiusKm: { min: 0 } } });
    const planets = store.categoryIdx.reduce((n, c) => n + (c === 3 ? 1 : 0), 0);
    expect(k.scope).toBe(planets);
    expect(k.count + (k.excludedForMissing.radiusKm ?? 0)).toBe(planets);       // every planet either has a radius >= 0 or is counted as missing
    expect(k.excludedForMissing.radiusKm).toBeGreaterThan(0);
  });

  it('discovery lists: sensible ranks, honest scope', () => {
    const view = wholeStore(store);
    const ns = nearestStars(view, 5);
    console.log(`[atlas] nearest stars: ${ns.items.map((i) => `${i.name} ${i.valueText}`).join('; ')}`);
    console.log(`[atlas] ${ns.scope}`);
    expect(ns.items[0]!.value).toBeLessThan(2);
    expect(ns.items.map((i) => i.value)).toEqual([...ns.items.map((i) => i.value)].sort((a, b) => a - b));
    expect(ns.items.every((i) => i.value / store.uncertainty('distancePc', store.indexOfId(i.id))! >= 5)).toBe(true);
    expect(ns.items.every((i) => i.id !== 'solar:sun')).toBe(true);
    const bs = brightestStars(view, 5);
    console.log(`[atlas] brightest: ${bs.items.map((i) => `${i.name} ${i.valueText}`).join('; ')}`);
    expect(bs.items[0]!.name).toBe('Sirius');
    expect(bs.caveat).toMatch(/Hipparcos supplement \([\d,]+ stars here\) covers those/);
    const counts = planetCountsByHost(graph, store);
    expect(counts.size).toBeGreaterThan(3000);
    const most = mostPlanetsInSystem(view, counts, 3);
    console.log(`[atlas] most planets: ${most.items.map((i) => `${i.name} ${i.valueText}`).join('; ')}`);
    expect(most.items[0]!.value).toBeGreaterThanOrEqual(8);
    const nes = nearestExoplanetSystems(view, counts, 5);
    console.log(`[atlas] nearest planet hosts: ${nes.items.map((i) => `${i.name} ${i.valueText}`).join('; ')}`);
    expect(nes.items.length).toBeGreaterThan(0);
    expect(nes.items.every((i) => (counts.get(i.id) ?? 0) > 0)).toBe(true);
    const ng = nearestGalaxies(view, 5);
    console.log(`[atlas] nearest galaxies: ${ng.items.map((i) => `${i.name} ${i.valueText}`).join('; ')}`);
    expect(ng.items.length).toBe(5);
    expect(ng.items.every((i) => store.kind('distancePc', store.indexOfId(i.id)) === 'observed')).toBe(true);
    expect(ng.items.some((i) => /milky way/i.test(i.name))).toBe(false);          // we are inside it
  });

  it('nearby: neighbours of a star across the solar and stellar domains, origin excluded', () => {
    const tree = buildSpatialIndex(store);
    const frames = createUniverseFrames();
    frames.add({ id: SOLAR_SYSTEM_FRAME, parent: NEIGHBOURHOOD_FRAME, origin: [0, 0, 0], radius: 1e14 });
    const hel = heliocentricDomain(store, tree);
    const bodies = recordsFromSolar(solar).map((r) => ({ id: r.id, category: r.category, dataset: r.dataset, offsetMetres: [1.495978707e11 * (r.id === 'solar:sun' ? 0 : 1), 0, 0] as [number, number, number] }));
    const sol = solarDomain(() => bodies);
    const bi = store.indexOfId('gaia:4472832130942575872');
    expect(bi).toBeGreaterThanOrEqual(0);
    const r = findNearby({ origin: originOf(store, bi)!, frames, domains: [sol, hel], k: 6, originId: 'gaia:4472832130942575872' });
    expect(r.neighbours).toHaveLength(6);
    expect(r.neighbours.map((n) => n.id)).not.toContain('gaia:4472832130942575872');
    expect(r.neighbours.every((n) => n.distanceMetres > 0)).toBe(true);
    expect(r.neighbours[0]!.distanceMetres).toBeLessThan(5 * METRES_PER_PARSEC);
    // the planets of a merged star sit exactly at the star (followHost), not a few hundred AU off because two catalogues disagree on its distance
    const barnardPlanets = r.neighbours.filter((n) => n.id.startsWith('exo:Barnard'));
    expect(barnardPlanets.length).toBeGreaterThan(0);
    expect(barnardPlanets.every((n) => n.distanceMetres < 1e6)).toBe(true);
    expect(r.neighbours.map((n) => n.distanceMetres)).toEqual([...r.neighbours.map((n) => n.distanceMetres)].sort((a, b) => a - b));
    console.log(`[atlas] nearest to Barnard's star: ${r.neighbours.slice(0, 4).map((n) => `${records.find((x) => x.id === n.id)!.name} ${n.distanceText}`).join('; ')}`);
  });

  it('navigation: select, parent through the real relation graph, back', () => {
    const calls: string[] = [];
    let cam: CameraSnapshot = { frame: NEIGHBOURHOOD_FRAME, focus: [0, 0, 0], distance: 10, yaw: 0, pitch: 0 };
    const host: NavigationHost = {
      focus: (p: FocusPlan) => { calls.push(`focus:${p.id}:${p.proxy ? 'proxy' : 'real'}`); },
      snapshot: () => cam, restore: (s) => { cam = s; calls.push('restore'); }, setSelection: () => undefined, highlight: () => undefined,
      currentFrame: () => NEIGHBOURHOOD_FRAME, resolve: (id: UniversalId) => index.get(id), positionOf: () => undefined,
    };
    const nav = new NavigationController(host, graph);
    expect(nav.select('solar:io').ok).toBe(true);
    expect(nav.parent().ok).toBe(true);
    expect(nav.selection).toBe('solar:jupiter');
    expect(nav.parent().ok).toBe(true);
    expect(nav.selection).toBe('solar:sun');
    expect(nav.back().ok).toBe(true);
    expect(nav.selection).toBe('solar:jupiter');
    expect(nav.select('exo:TRAPPIST-1 e').ok).toBe(true);
    expect(calls[calls.length - 1]).toBe('focus:exo:TRAPPIST-1 e:proxy');             // planets are not drawn: the host draws a selection proxy at the host star
    expect(nav.parent().ok).toBe(true);
    expect(nav.selection).toBe(merged.aliases.get('host:TRAPPIST-1') ?? 'host:TRAPPIST-1');
    expect(nav.select('deep:m31').ok).toBe(true);
    expect(nav.parent().ok).toBe(false);                                              // only an association (Local Group) is listed
    expect(nav.parent({ includeAssociation: true }).ok).toBe(true);
    expect(nav.selection).toBe('deep:local-group');
  });
});

describe.skipIf(missing.length === 0)('atlas end to end', () => {
  it('SKIPPED: some data files are absent', () => { expect(missing.length).toBeGreaterThan(0); });
});
