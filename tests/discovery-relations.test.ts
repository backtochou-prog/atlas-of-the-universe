import { describe, expect, it } from 'vitest';
import {
  BASIS_PREFERENCE, RelationGraph, classifyMembershipBasis, parseRelationsFile, relationsFromDeep, relationsFromExoplanets, relationsFromSameAs, relationsFromSolar,
} from '../src/discovery/relations';
import { recordsFromDeep, recordsFromExoplanets, recordsFromOther, recordsFromPoints, recordsFromSolar } from '../src/discovery/records';
import type { Relation, RelationBasis, RelationKind } from '../src/discovery/types';
import type { ExoplanetFile, OtherObjectsFile } from '../src/discovery/types';
import type { PointCatalogueFile } from '../src/data/deepspace/types';
import { have, loadDeep, loadPoints, loadSolar, readGz, readJson } from './fixtures/discovery/real';

const src = { label: 'test' };
const rel = (from: string, to: string, kind: RelationKind = 'orbits', basis: RelationBasis = 'physical-gravitational', over: Partial<Relation> = {}): Relation =>
  ({ from, to, kind, basis, statement: `${from} ${kind} ${to}`, source: src, ...over });

describe('RelationGraph queries', () => {
  const g = new RelationGraph([
    rel('solar:io', 'solar:jupiter'), rel('solar:europa', 'solar:jupiter'), rel('solar:jupiter', 'solar:sun'), rel('solar:earth', 'solar:sun'), rel('solar:moon', 'solar:earth'),
    rel('deep:sun-in-mw', 'deep:milky-way', 'part-of', 'structural'),
    rel('deep:m32', 'deep:local-group', 'member-of', 'spatial-association'),
    rel('deep:m31', 'deep:local-group', 'member-of', 'spatial-association'),
    rel('deep:m81', 'deep:m81-group', 'member-of', 'physical-gravitational'),
    rel('deep:m81', 'deep:some-region', 'part-of', 'structural'),
    rel('gaia:1', 'hip:1', 'same-object-as', 'identity'),
    rel('deep:m31', 'deep:m32', 'near', 'spatial-association'),
  ]);
  it('parentsOf and childrenOf always carry the basis, physical first', () => {
    expect(g.parentsOf('solar:io').map((l) => [l.id, l.relation.basis, l.direction])).toEqual([['solar:jupiter', 'physical-gravitational', 'out']]);
    expect(g.childrenOf('solar:jupiter').map((l) => l.id).sort()).toEqual(['solar:europa', 'solar:io']);
    const m81 = g.parentsOf('deep:m81');
    expect(m81.map((l) => l.relation.basis)).toEqual(['physical-gravitational', 'structural']);
    expect(g.parentsOf('deep:m81', { basis: ['structural'] }).map((l) => l.id)).toEqual(['deep:some-region']);
    expect(g.parentsOf('solar:sun')).toEqual([]);
    expect(g.parentsOf('unknown:id')).toEqual([]);
  });
  it('near and identity are not hierarchy', () => {
    expect(g.parentsOf('deep:m31').map((l) => l.id)).toEqual(['deep:local-group']);
    expect(g.childrenOf('hip:1')).toEqual([]);
    expect(g.parentsOf('gaia:1')).toEqual([]);
  });
  it('siblings share a parent and name it', () => {
    const s = g.siblings('solar:io');
    expect(s.map((x) => [x.id, x.via])).toEqual([['solar:europa', 'solar:jupiter']]);
    expect(g.siblings('deep:m31').map((x) => x.id)).toEqual(['deep:m32']);
    expect(g.siblings('solar:sun')).toEqual([]);
    expect(g.siblings('solar:jupiter').map((x) => x.id)).toEqual(['solar:earth']);
  });
  it('relatedBy returns both directions with the requested basis only (physical and association shown separately)', () => {
    const assoc = g.relatedBy('deep:m31', 'spatial-association');
    expect(assoc.map((l) => [l.id, l.direction, l.relation.kind]).sort()).toEqual([['deep:local-group', 'out', 'member-of'], ['deep:m32', 'out', 'near']]);
    expect(g.relatedBy('deep:m31', 'physical-gravitational')).toEqual([]);
    expect(g.relatedBy('solar:jupiter', 'physical-gravitational').map((l) => [l.id, l.direction]).sort()).toEqual([['solar:europa', 'in'], ['solar:io', 'in'], ['solar:sun', 'out']]);
    expect(g.relatedBy('gaia:1', 'identity').map((l) => l.id)).toEqual(['hip:1']);
    expect(g.relatedBy('hip:1', 'identity').map((l) => [l.id, l.direction])).toEqual([['gaia:1', 'in']]);
  });
  it('pathToRoot follows the preferred parent and stops at the root', () => {
    expect(g.pathToRoot('solar:moon').path.map((l) => l.id)).toEqual(['solar:earth', 'solar:sun']);
    expect(g.pathToRoot('solar:moon').complete).toBe(true);
    expect(g.pathToRoot('deep:m81').path.map((l) => l.id)).toEqual(['deep:m81-group']);                  // physical before structural
    expect(g.pathToRoot('deep:m81', { prefer: ['structural'] }).path.map((l) => l.id)).toEqual(['deep:some-region']);
    expect(g.pathToRoot('deep:m31', { prefer: ['physical-gravitational', 'structural'] }).path).toEqual([]);   // association excluded
    expect(g.pathToRoot('solar:sun').path).toEqual([]);
  });
  it('pathToRoot terminates on a cycle', () => {
    const c = new RelationGraph([rel('a:1', 'a:2'), rel('a:2', 'a:1')]);
    const p = c.pathToRoot('a:1');
    expect(p.complete).toBe(false);
    expect(p.path.length).toBeLessThanOrEqual(2);
  });
  it('systemMembers lists everything bound to a host, transitively, with depth', () => {
    const m = g.systemMembers('solar:sun');
    expect(m.map((x) => [x.id, x.depth]).sort()).toEqual([['solar:earth', 1], ['solar:europa', 2], ['solar:io', 2], ['solar:jupiter', 1], ['solar:moon', 2]]);
    expect(g.systemMembers('solar:io')).toEqual([]);
    expect(g.systemMembers('deep:local-group')).toEqual([]);                    // associations are not a system
  });
  it('preference order is physical, structural, association', () => {
    expect(BASIS_PREFERENCE).toEqual(['physical-gravitational', 'structural', 'spatial-association']);
  });
});

describe('RelationGraph.validate', () => {
  const codes = (rels: Relation[], known?: Set<string>) => new RelationGraph(rels).validate(known).map((i) => i.code);
  it('a clean graph validates', () => {
    expect(codes([rel('a:1', 'a:2'), rel('a:3', 'a:2')], new Set(['a:1', 'a:2', 'a:3']))).toEqual([]);
  });
  it('every edge needs a source; a physical edge without one is its own error', () => {
    expect(codes([rel('a:1', 'a:2', 'orbits', 'physical-gravitational', { source: { label: '' } })])).toEqual(['physical-without-source']);
    expect(codes([rel('a:1', 'a:2', 'member-of', 'spatial-association', { source: { label: '  ' } })])).toEqual(['missing-source']);
    expect(codes([rel('a:1', 'a:2', 'orbits', 'physical-gravitational', { source: undefined as never })])).toEqual(['physical-without-source']);
  });
  it('detects an empty statement, self relations and kind/basis mismatches', () => {
    expect(codes([rel('a:1', 'a:2', 'orbits', 'physical-gravitational', { statement: ' ' })])).toEqual(['empty-statement']);
    expect(codes([rel('a:1', 'a:1')])).toEqual(expect.arrayContaining(['self-relation']));
    expect(codes([rel('a:1', 'a:2', 'orbits', 'spatial-association')])).toEqual(['kind-basis-mismatch']);
    expect(codes([rel('a:1', 'a:2', 'part-of', 'physical-gravitational')])).toEqual(['kind-basis-mismatch']);
    expect(codes([rel('a:1', 'a:2', 'same-object-as', 'structural')])).toEqual(['kind-basis-mismatch']);
    expect(codes([rel('a:1', 'a:2', 'near', 'physical-gravitational')])).toEqual(['kind-basis-mismatch']);
  });
  it('detects cycles in orbits / part-of / component-of, once each', () => {
    expect(codes([rel('a:1', 'a:2'), rel('a:2', 'a:3'), rel('a:3', 'a:1')])).toEqual(['cycle']);
    expect(codes([rel('a:1', 'a:2', 'part-of', 'structural'), rel('a:2', 'a:1', 'part-of', 'structural')])).toEqual(['cycle']);
    expect(codes([rel('a:1', 'a:2', 'component-of'), rel('a:2', 'a:1', 'component-of')])).toEqual(['cycle']);
    expect(codes([rel('a:1', 'a:2', 'member-of', 'spatial-association'), rel('a:2', 'a:1', 'member-of', 'spatial-association')])).toEqual([]);   // membership cycles are not orbits
    const issues = new RelationGraph([rel('a:1', 'a:2'), rel('a:2', 'a:1')]).validate();
    expect(issues[0]!.ids).toEqual(expect.arrayContaining(['a:1', 'a:2']));
  });
  it('detects ids that are not known objects', () => {
    const issues = new RelationGraph([rel('a:1', 'a:2'), rel('a:9', 'a:2')]).validate(new Set(['a:1', 'a:2']));
    expect(issues.map((i) => [i.code, i.ids])).toEqual([['dangling-id', ['a:9']]]);
    expect(new RelationGraph([rel('a:1', 'a:2')]).validate((id) => id === 'a:1').map((i) => i.ids)).toEqual([['a:2']]);
  });
  it('the same edge stated with two bases is reported; an exact duplicate is merged', () => {
    const g = new RelationGraph([rel('a:1', 'a:2', 'member-of', 'physical-gravitational'), rel('a:1', 'a:2', 'member-of', 'spatial-association'), rel('a:3', 'a:4'), rel('a:3', 'a:4')]);
    expect(g.validate().map((i) => i.code)).toEqual(['duplicate-conflict']);
    expect(g.size).toBe(2);
  });
});

describe('aliases (merged records)', () => {
  it('edges written against a merged-away id attach to the canonical record; self relations that result are dropped and listed', () => {
    const aliases = new Map([['host:Barnard', 'gaia:1'], ['hip:9', 'gaia:1']]);
    const g = new RelationGraph([rel('exo:Barnard b', 'host:Barnard'), rel('hip:9', 'gaia:1', 'same-object-as', 'identity')], aliases);
    expect(g.childrenOf('gaia:1').map((l) => l.id)).toEqual(['exo:Barnard b']);
    expect(g.childrenOf('host:Barnard').map((l) => l.id)).toEqual(['exo:Barnard b']);       // querying by the old id works too
    expect(g.systemMembers('hip:9').map((l) => l.id)).toEqual(['exo:Barnard b']);
    expect(g.droppedSelfAfterAlias).toHaveLength(1);
    expect(g.size).toBe(1);
  });
});

describe('membership basis rule', () => {
  it('a distance cut or "all rows" is an association', () => {
    expect(classifyMembershipBasis('All rows of the McConnachie (2012) catalogue ("Over 100 nearby galaxies that have distance estimates placing them within 3Mpc of the Sun are identified")').basis).toBe('spatial-association');
    expect(classifyMembershipBasis('galaxies within 5 Mpc of the Sun').basis).toBe('spatial-association');
  });
  it('our own selection is an association even if it mentions a cluster', () => {
    expect(classifyMembershipBasis('Our cut, not a published membership: 2MRS galaxies within 6 deg of M87').basis).toBe('spatial-association');
  });
  it('a published physical-group definition is physical', () => {
    expect(classifyMembershipBasis('galaxies whose main disturber is M81 and whose tidal index Theta_1 is positive - the paper\'s own definition of a physical group of galaxies').basis).toBe('physical-gravitational');
    expect(classifyMembershipBasis('members are gravitationally bound to the cluster (virial analysis)').basis).toBe('physical-gravitational');
  });
  it('a negative signal wins; silence is an association; empty is an association', () => {
    expect(classifyMembershipBasis('physical group, but our cut of the catalogue').basis).toBe('spatial-association');
    expect(classifyMembershipBasis('Members are listed in the catalogue.').basis).toBe('spatial-association');
    expect(classifyMembershipBasis(undefined).basis).toBe('spatial-association');
    expect(classifyMembershipBasis('  ').basis).toBe('spatial-association');
    expect(classifyMembershipBasis('x').reason.length).toBeGreaterThan(5);
  });
});

describe('builders on small fixtures', () => {
  it('relationsFromSolar: parent -> orbits, physical, sourced', () => {
    const r = relationsFromSolar({ file: { bodies: [{ id: 'sun', name: 'Sun', parent: null }, { id: 'earth', name: 'Earth', parent: 'sun' }, { id: 'moon', name: 'Moon', parent: 'earth' }] } });
    expect(r.map((x) => [x.from, x.to, x.kind, x.basis])).toEqual([['solar:earth', 'solar:sun', 'orbits', 'physical-gravitational'], ['solar:moon', 'solar:earth', 'orbits', 'physical-gravitational']]);
    expect(r[1]!.statement).toBe('Moon orbits Earth (Solar System dataset: parent body).');
    expect(r.every((x) => x.source.label === 'solar-system.parent')).toBe(true);
  });
  it('relationsFromExoplanets: planet orbits host, physical; rows with missing names are skipped', () => {
    const r = relationsFromExoplanets({ planets: { plName: ['A b', 'A c', null, 'B b', ''], hostname: ['A', 'A', 'X', 'B', 'Y'] } });
    expect(r.map((x) => [x.from, x.to])).toEqual([['exo:A b', 'host:A'], ['exo:A c', 'host:A'], ['exo:B b', 'host:B']]);
    expect(new RelationGraph(r).systemMembers('host:A').map((l) => l.id)).toEqual(['exo:A b', 'exo:A c']);
    expect(relationsFromExoplanets({ planets: {} })).toEqual([]);
  });
  it('relationsFromSameAs can keep only links whose far end is loaded', () => {
    const recs = [{ id: 'hip:1', sameAs: ['gaia:1', 'gaia:ghost'] }, { id: 'gaia:1' }];
    expect(relationsFromSameAs(recs)).toHaveLength(2);
    const kept = relationsFromSameAs(recs, { known: (id) => id === 'gaia:1' });
    expect(kept.map((r) => r.to)).toEqual(['gaia:1']);
    expect(new RelationGraph(kept).validate(new Set(['hip:1', 'gaia:1']))).toEqual([]);
  });
  it('relationsFromSameAs: one identity link per pair', () => {
    const r = relationsFromSameAs([{ id: 'gaia:1', sameAs: ['hip:1', 'host:A'] }, { id: 'hip:1', sameAs: ['gaia:1'] }, { id: 'x:1' }]);
    expect(r).toHaveLength(2);
    expect(r.every((x) => x.kind === 'same-object-as' && x.basis === 'identity')).toBe(true);
  });
  it('relationsFromDeep: group membership by the group\'s own basis, containment as structural', () => {
    const objs = [
      { id: 'milky-way', name: 'Milky Way', kind: 'galaxy' },
      { id: 'orion', name: 'Orion Nebula', kind: 'nebula', parentId: 'milky-way' },
      { id: 'lg', name: 'Local Group', kind: 'galaxy-group', membership: { pointsFileId: 'f', names: ['A', 'B'], basis: 'All rows of the catalogue', source: { source: 's' } } },
      { id: 'm31', name: 'M31', kind: 'galaxy', parentId: 'lg' },
      { id: 'grp', name: 'Physical group', kind: 'galaxy-group', membership: { pointsFileId: 'f', names: ['C'], basis: 'a definition of physical group', source: { source: 's', url: 'https://example.org' } } },
      { id: 'm81', name: 'M81', kind: 'galaxy', parentId: 'grp' },
      { id: 'orphan', name: 'Orphan', kind: 'galaxy', parentId: 'ghost' },
    ];
    const rows = new Map([['f:A', 0], ['f:B', 1], ['f:C', 2]]);
    const r = relationsFromDeep(objs, { pointRow: (f, n) => rows.get(`${f}:${n}`) });
    const by = (from: string, to: string) => r.find((x) => x.from === from && x.to === to)!;
    expect(by('deep:orion', 'deep:milky-way')).toMatchObject({ kind: 'part-of', basis: 'structural' });
    expect(by('deep:m31', 'deep:lg')).toMatchObject({ kind: 'member-of', basis: 'spatial-association' });
    expect(by('deep:m81', 'deep:grp')).toMatchObject({ kind: 'member-of', basis: 'physical-gravitational' });
    expect(by('point:f:0', 'deep:lg')).toMatchObject({ kind: 'member-of', basis: 'spatial-association' });
    expect(by('point:f:2', 'deep:grp')).toMatchObject({ kind: 'member-of', basis: 'physical-gravitational' });
    expect(by('point:f:2', 'deep:grp').source.url).toBe('https://example.org');
    expect(by('deep:orphan', 'deep:ghost')).toMatchObject({ kind: 'part-of', basis: 'structural' });      // unknown parent: containment, no group claim
    expect(new RelationGraph(r).validate().map((i) => i.code)).toEqual([]);
  });
});

describe('parseRelationsFile never trusts its shape', () => {
  const good = { manifest: { schema: 'atlas-relations/1', generated: '2026-11-13' }, relations: [rel('a:1', 'a:2'), rel('a:1', 'a:3', 'near', 'spatial-association', { source: { label: 'paper', url: 'https://x.org', derivedFrom: 'table 2' } })] };
  it('accepts a valid file', () => {
    const r = parseRelationsFile(good);
    expect(r.issues).toEqual([]);
    expect(r.relations).toHaveLength(2);
    expect(r.relations[1]!.source).toEqual({ label: 'paper', url: 'https://x.org', derivedFrom: 'table 2' });
  });
  it('rejects non-files', () => {
    for (const bad of [null, undefined, 3, 'x', [], {}, { manifest: {}, relations: [] }, { manifest: { schema: 'other' }, relations: [] }, { manifest: { schema: 'atlas-relations/1' }, relations: 'no' }]) {
      const r = parseRelationsFile(bad);
      expect(r.relations).toEqual([]);
      expect(r.issues[0]!.code).toBe('invalid-shape');
    }
  });
  it('skips bad entries individually and says why', () => {
    const r = parseRelationsFile({
      manifest: good.manifest,
      relations: [
        null, 5, { from: 'a:1' },
        rel('a:1', 'a:2', 'orbits'),
        { ...rel('a:1', 'a:2'), kind: 'loves' }, { ...rel('a:1', 'a:2'), basis: 'vibes' },
        { ...rel('a:1', 'a:4'), source: { label: '' } }, { ...rel('a:1', 'a:5', 'near', 'spatial-association'), source: {} },
        { ...rel('a:1', 'a:6'), source: undefined },
        { ...rel('a:1', 'a:7'), statement: '' },
        { ...rel('a:1', 'a:8'), extra: { evil: true } },
      ],
    });
    expect(r.relations.map((x) => x.to)).toEqual(['a:2', 'a:8']);
    expect(r.relations[1]).not.toHaveProperty('extra');
    expect(r.issues.map((i) => i.code).sort()).toEqual(['invalid-shape', 'invalid-shape', 'invalid-shape', 'invalid-shape', 'invalid-shape', 'invalid-shape', 'missing-source', 'physical-without-source', 'physical-without-source']);
  });
});

describe.skipIf(!have('solar-system.v1.json'))('real data: Solar System', () => {
  const solar = loadSolar();
  const rels = relationsFromSolar(solar);
  const known = new Set(recordsFromSolar(solar).map((r) => r.id));
  it('every body except the Sun orbits its parent; the graph validates against the solar records', () => {
    expect(rels).toHaveLength(solar.file.bodies.length - 1);
    const g = new RelationGraph(rels);
    expect(g.validate(known)).toEqual([]);
    expect(g.pathToRoot('solar:io').path.map((l) => l.id)).toEqual(['solar:jupiter', 'solar:sun']);
    expect(g.systemMembers('solar:sun')).toHaveLength(solar.file.bodies.length - 1);
    expect(g.childrenOf('solar:jupiter').map((l) => l.id)).toEqual(['solar:callisto', 'solar:europa', 'solar:ganymede', 'solar:io']);
    expect(g.siblings('solar:io').map((l) => l.id)).toEqual(['solar:callisto', 'solar:europa', 'solar:ganymede']);
  });
});

describe.skipIf(!have('deep-space.v1.json'))('real data: deep space', () => {
  const deep = loadDeep();
  const pointNames = new Map<string, Map<string, number>>();
  for (const id of ['ungc', 'local-group-mcconnachie', 'twomrs']) {
    if (!have(`deepspace/${id}.v1.json.gz`)) continue;
    const f = loadPoints(id);
    const m = new Map<string, number>();
    (f.columns['name'] ?? []).forEach((n, i) => { if (typeof n === 'string' && !m.has(n)) m.set(n, i); });
    pointNames.set(id, m);
  }
  const rels = relationsFromDeep(deep.all() as never, { pointRow: (f, n) => pointNames.get(f)?.get(n) });
  const g = new RelationGraph(rels);
  it('each stated basis follows the rule and is readable from the data', () => {
    const by = (from: string, to: string) => rels.find((x) => x.from === `deep:${from}` && x.to === `deep:${to}`)!;
    expect(by('m31', 'local-group')).toMatchObject({ kind: 'member-of', basis: 'spatial-association' });         // McConnachie: "within 3 Mpc of the Sun", not a bound-membership criterion
    expect(by('m81', 'm81-group')).toMatchObject({ kind: 'member-of', basis: 'physical-gravitational' });         // UNGC: "definition of physical group"
    expect(by('m87', 'virgo-cluster')).toMatchObject({ kind: 'member-of', basis: 'spatial-association' });       // "Our cut, not a published membership"
    expect(by('orion-nebula', 'milky-way')).toMatchObject({ kind: 'part-of', basis: 'structural' });
    expect(by('pleiades', 'milky-way')).toMatchObject({ kind: 'part-of', basis: 'structural' });
  });
  it('validates against the deep records and the point records', () => {
    const known = new Set<string>(recordsFromDeep(deep).map((r) => r.id));
    for (const id of ['ungc', 'local-group-mcconnachie', 'twomrs']) if (have(`deepspace/${id}.v1.json.gz`)) for (const r of recordsFromPoints(loadPoints(id) as PointCatalogueFile)) known.add(r.id);
    expect(g.validate(known)).toEqual([]);
    expect(rels.length).toBeGreaterThan(deep.all().filter((o) => o.parentId).length);               // plus the membership rows
  });
  it('membership rows carry the group\'s basis; physical and association are separable for the UI', () => {
    const lg = g.childrenOf('deep:local-group');
    expect(lg.length).toBeGreaterThan(90);
    expect(lg.every((l) => l.relation.basis === 'spatial-association')).toBe(true);
    const m81 = g.childrenOf('deep:m81-group');
    expect(m81.length).toBeGreaterThan(20);
    expect(m81.every((l) => l.relation.basis === 'physical-gravitational')).toBe(true);
    expect(g.relatedBy('deep:m81', 'physical-gravitational').map((l) => l.id)).toEqual(['deep:m81-group']);
    expect(g.relatedBy('deep:m81', 'spatial-association')).toEqual([]);
  });
});

describe.skipIf(!have('exoplanets.v1.json.gz'))('real data: exoplanets', () => {
  const file = readGz<ExoplanetFile>('exoplanets.v1.json.gz');
  const rels = relationsFromExoplanets(file);
  const recs = recordsFromExoplanets(file);
  it('every planet orbits its host and all ids resolve', () => {
    expect(rels).toHaveLength(file.planets['plName']!.length);
    const g = new RelationGraph(rels);
    expect(g.validate(new Set(recs.map((r) => r.id)))).toEqual([]);
    const trappist = g.systemMembers('host:TRAPPIST-1').map((l) => l.id);
    expect(trappist).toHaveLength(7);
    expect(trappist).toContain('exo:TRAPPIST-1 e');
    expect(g.parentsOf('exo:TRAPPIST-1 e')[0]).toMatchObject({ id: 'host:TRAPPIST-1', direction: 'out' });
  });
});

describe.skipIf(!have('other-objects.v1.json'))('real data: other objects are loadable as records', () => {
  it('records exist for every curated object', () => {
    const f = readJson<OtherObjectsFile>('other-objects.v1.json');
    expect(recordsFromOther(f)).toHaveLength(f.objects.length);
  });
});
