import { describe, expect, it } from 'vitest';
import type { RelationLinkView, RelationsOutcome } from '../src/discovery/engineApi';
import type { DiscoveryNote, Relation } from '../src/discovery/types';
import { NOTES_POLICY_LINE, NO_NOTE_MESSAGE, STATUS_LABEL, buildNotesVm, claimsWithoutProvenance } from '../src/ui/discovery/notesViewModel';
import { BASIS_TITLE, NO_RELATIONS_MESSAGE, buildRelationsVm } from '../src/ui/discovery/relationsViewModel';
import { inspectDiscoveryRecord } from '../src/data/catalogue/inspect';
import type { DiscoveryRecord } from '../src/discovery/types';
import { placementNotice } from '../src/ui/discovery/labels';
import { flightStatement, navControls } from '../src/ui/discovery/navViewModel';

const ref = { label: 'Bond et al. 2017', url: 'https://arxiv.org/abs/1703.10625', retrieved: '2026-11-13' };
const note: DiscoveryNote = {
  id: 'hip:32349', oneLine: 'A visual binary.',
  sections: {
    what: [{ text: 'Sirius is a visual binary.', status: 'observed', references: [ref] }],
    why: [{ text: 'Brightest star in the sky.', status: 'observed', references: [ref] }],
    discovery: [{ text: 'Sirius B was seen in 1862.', status: 'historical', references: [ref] }],
    uncertain: [{ text: 'Its age is model dependent.', status: 'inferred', references: [ref] }, { text: 'Origin of the white dwarf mass is open.', status: 'hypothesis', references: [ref] }],
  },
  studiedBy: [{ mission: 'Hubble', role: 'imaged Sirius B', reference: { label: 'NASA', url: 'https://science.nasa.gov/x' } }],
};

describe('explanation block model', () => {
  it('oneLine first, sections in the documented order with their titles, studied-by last', () => {
    const vm = buildNotesVm(note);
    if (!vm.hasNote) throw new Error('no note');
    expect(vm.oneLine).toBe('A visual binary.');
    expect(vm.sections.map((s) => s.title)).toEqual(['What it is', 'Why it matters', 'How it was found', 'What is uncertain']);   // absent sections (interesting) are skipped, not invented
    expect(vm.studiedBy).toEqual([{ mission: 'Hubble', role: 'imaged Sirius B', label: 'NASA', url: 'https://science.nasa.gov/x' }]);
    expect(vm.policy).toBe(NOTES_POLICY_LINE);
    expect(NOTES_POLICY_LINE).toBe('Notes paraphrase the cited pages; they are not measurements.');
  });
  it('every claim carries a status label and its references with a retrieved date', () => {
    const vm = buildNotesVm(note);
    if (!vm.hasNote) throw new Error('no note');
    const claims = vm.sections.flatMap((s) => s.claims);
    expect(claims.length).toBe(5);
    for (const c of claims) {
      expect(c.statusLabel).toBeTruthy();
      expect(c.references.length).toBeGreaterThan(0);
      expect(c.references[0]!.text).toMatch(/retrieved 2026-11-13/);
    }
    expect(claims.map((c) => c.statusLabel)).toEqual([STATUS_LABEL.observed, STATUS_LABEL.observed, STATUS_LABEL.historical, STATUS_LABEL.inferred, STATUS_LABEL.hypothesis]);
    expect(STATUS_LABEL.hypothesis).toBe('Hypothesis / open question');
    expect(claimsWithoutProvenance(vm)).toEqual([]);
  });
  it('sources are the distinct references behind the note', () => {
    const vm = buildNotesVm(note);
    if (!vm.hasNote) throw new Error('no note');
    expect(vm.sources).toHaveLength(1);
  });
  it('a claim without a reference is flagged, not trusted', () => {
    const bad: DiscoveryNote = { ...note, sections: { ...note.sections, what: [{ text: 'Unsupported.', status: 'observed', references: [] }] } };
    expect(claimsWithoutProvenance(buildNotesVm(bad))).toEqual(['Unsupported.']);
  });
  it('only http(s) links become links', () => {
    const evil: DiscoveryNote = { ...note, sections: { ...note.sections, what: [{ text: 'x', status: 'observed', references: [{ label: 'js', url: 'javascript:alert(1)', retrieved: '2026-11-13' }] }] } };
    const vm = buildNotesVm(evil);
    if (!vm.hasNote) throw new Error('no note');
    expect(vm.sections[0]!.claims[0]!.references[0]!.url).toBeNull();
  });
  it('an object without a note says so and synthesises nothing', () => {
    const vm = buildNotesVm(undefined);
    expect(vm).toEqual({ hasNote: false, message: NO_NOTE_MESSAGE, policy: NOTES_POLICY_LINE });
    expect(NO_NOTE_MESSAGE).toBe('No curated explanation yet.');
  });
});

const rel = (from: string, to: string, kind: Relation['kind'], basis: Relation['basis'], statement: string): Relation => ({ from, to, kind, basis, statement, source: { label: 'solar-system.parent', url: 'https://ssd.jpl.nasa.gov/' } });
const link = (r: Relation, id: string, name: string | undefined): RelationLinkView => ({ id, relation: r, direction: 'out', name, category: name ? 'planet' : undefined });
describe('relationships block model', () => {
  const groups = (o: Partial<RelationsOutcome['groups']>): RelationsOutcome['groups'] => ({ 'physical-gravitational': [], structural: [], 'spatial-association': [], identity: [], ...o });
  it('groups by basis, in the documented order, with the documented titles; empty groups are omitted', () => {
    const out: RelationsOutcome = {
      id: 'solar:europa', canonical: 'solar:europa', total: 4,
      groups: groups({
        identity: [link(rel('solar:europa', 'gaia:1', 'same-object-as', 'identity', 'Same object.'), 'gaia:1', 'Europa (Gaia)')],
        'spatial-association': [link(rel('solar:europa', 'deep:x', 'near', 'spatial-association', 'Listed together.'), 'deep:x', 'Neighbour')],
        'physical-gravitational': [link(rel('solar:europa', 'solar:jupiter', 'orbits', 'physical-gravitational', 'Europa orbits Jupiter (JPL).'), 'solar:jupiter', 'Jupiter')],
        structural: [link(rel('solar:europa', 'solar:sun', 'part-of', 'structural', 'Part of the Solar System.'), 'solar:sun', 'Sun')],
      }),
    };
    const vm = buildRelationsVm(out);
    expect(vm.groups.map((g) => g.title)).toEqual(['Physical (gravitational)', 'Structural', 'Spatial association (approximate; our selection)', 'Same object in another dataset']);
    expect(vm.groups.map((g) => g.title)).toEqual([BASIS_TITLE['physical-gravitational'], BASIS_TITLE.structural, BASIS_TITLE['spatial-association'], BASIS_TITLE.identity]);
    const phys = vm.groups[0]!;
    expect(phys.rows[0]).toMatchObject({ id: 'solar:jupiter', name: 'Jupiter', statement: 'Europa orbits Jupiter (JPL).', source: 'solar-system.parent', clickable: true });
    expect(phys.rows[0]!.sourceUrl).toBe('https://ssd.jpl.nasa.gov/');
    // basis never mixes
    for (const g of vm.groups) for (const r of g.rows) expect(out.groups[g.basis].map((l) => l.id)).toContain(r.id);
  });
  it('an association is never described as physical', () => {
    const out: RelationsOutcome = { id: 'a', canonical: 'a', total: 1, groups: groups({ 'spatial-association': [link(rel('a', 'b', 'near', 'spatial-association', 'Near b.'), 'b', 'B')] }) };
    const vm = buildRelationsVm(out);
    expect(vm.groups).toHaveLength(1);
    expect(vm.groups[0]!.basis).toBe('spatial-association');
    expect(vm.groups[0]!.note).toMatch(/Not a statement that they are bound/);
  });
  it('an unknown other end is shown but not clickable', () => {
    const out: RelationsOutcome = { id: 'a', canonical: 'a', total: 1, groups: groups({ structural: [link(rel('a', 'deep:ghost', 'part-of', 'structural', 'Part of Ghost.'), 'deep:ghost', undefined)] }) };
    expect(buildRelationsVm(out).groups[0]!.rows[0]).toMatchObject({ clickable: false, name: 'deep:ghost' });
  });
  it('relations not listed because of the per-group limit are counted', () => {
    const out: RelationsOutcome = { id: 'a', canonical: 'a', total: 5, groups: groups({ structural: [link(rel('a', 'b', 'part-of', 'structural', 'x'), 'b', 'B')] }) };
    expect(buildRelationsVm(out).groups[0]!.hiddenCount).toBe(4);
  });
  it('no relations: an explicit message', () => {
    const vm = buildRelationsVm({ id: 'a', canonical: 'a', total: 0, groups: groups({}) });
    expect(vm.empty).toBe(true);
    expect(vm.message).toBe(NO_RELATIONS_MESSAGE);
    expect(buildRelationsVm(null).empty).toBe(true);
  });
});

describe('inspector model additions', () => {
  const base: DiscoveryRecord = {
    id: 'hip:32349', dataset: 'hipparcos', category: 'star', name: 'Sirius', designations: ['HIP 32349'], classification: 'Star', spectralType: 'A0m',
    position: { kind: 'icrs', xyzPc: [1, 2, 3], raDeg: 101.2, decDeg: -16.7, distanceUncertaintyPc: 0.011 }, drawn: true, sourceKey: 'hipparcos',
    measurements: { distancePc: { value: 2.637, kind: 'derived', uncertainty: 0.011 }, apparentMag: { value: -1.44, kind: 'observed' } },
  };
  const fields = (m: ReturnType<typeof inspectDiscoveryRecord>) => m.sections.flatMap((s) => s.fields);
  it('every available measurement has a kind and a source; uncertainty is shown when published', () => {
    const m = inspectDiscoveryRecord(base);
    for (const f of fields(m).filter((x) => x.available && x.key !== 'ra' && x.key !== 'dec' && x.key !== 'spectralType')) { expect(f.kind).toBeTruthy(); expect(f.source).toBeTruthy(); }
    const d = fields(m).find((f) => f.key === 'distancePc')!;
    expect(d.kind).toBe('derived');
    expect(d.uncertainty).toMatch(/^±/);
    expect(m.recordId).toBe('hip:32349');
  });
  it('parallax quality is derived from the record’s own distance and uncertainty', () => {
    const f = fields(inspectDiscoveryRecord(base)).find((x) => x.key === 'distance_snr')!;
    expect(f.kind).toBe('derived');
    expect(Number(f.value)).toBe(240);                // 2.637 / 0.011
    const none = fields(inspectDiscoveryRecord({ ...base, measurements: { distancePc: { value: 2.6, kind: 'derived' } } })).find((x) => x.key === 'distance_snr');
    expect(none).toBeUndefined();                      // no published uncertainty: no invented quality figure
  });
  it('unavailable values say Unavailable with a reason, never blank and never 0', () => {
    const m = inspectDiscoveryRecord(base);
    const t = fields(m).find((f) => f.key === 'teffK')!;
    expect(t.available).toBe(false);
    expect(t.value).toBe('Unavailable');
    expect(t.reason).toMatch(/Not provided by/);
    expect(t.value).not.toBe('0');
  });
  it('a record without a distance explains why and says it is not placed in 3D', () => {
    const sky: DiscoveryRecord = { ...base, id: 'point:twomrs:5', dataset: 'twomrs', category: 'galaxy', name: 'Some galaxy', position: { kind: 'sky-only', raDeg: 1, decDeg: 2 }, drawn: false, measurements: { czKms: { value: 300, kind: 'observed' } } };
    const m = inspectDiscoveryRecord(sky);
    const dist = fields(m).find((f) => f.key === 'distancePc')!;
    expect(dist.available).toBe(false);
    expect(dist.reason).toMatch(/velocity/);
    const n = m.notices!.find((x) => x.label === 'Not placed in 3D')!;
    expect(n.text).toMatch(/^Cannot be placed in 3D: distance unknown/);
  });
  it('low-reliability notes become a visible notice', () => {
    const m = inspectDiscoveryRecord({ ...base, measurements: { distancePc: { value: 900, kind: 'derived', uncertainty: 400, note: 'low reliability: parallax S/N < 5' } } });
    const n = m.notices!.find((x) => x.label === 'Low reliability')!;
    expect(n.tone).toBe('warn');
    expect(n.text).toMatch(/parallax S\/N < 5/);
  });
  it('a record that is not drawn says so', () => {
    expect(placementNotice({ position: base.position, drawn: false })).toMatch(/Not drawn/);
    expect(placementNotice({ position: base.position, drawn: true })).toBeNull();
  });
  it('notes are not copied into the facts (the explanation block owns them)', () => {
    const m = inspectDiscoveryRecord(base);
    expect(m.facts).toEqual([]);
  });
});

describe('navigation context model', () => {
  const hist = [{ selection: null }, { selection: 'hip:32349' }, { selection: 'deep:m31' }];
  const names: Record<string, string> = { 'hip:32349': 'Sirius', 'deep:m31': 'Andromeda Galaxy (M31)' };
  const state = (cursor: number) => ({ selection: hist[cursor]!.selection, canBack: cursor > 0, canForward: cursor < hist.length - 1, length: hist.length, cursor });
  it('Back and Forward are labelled with the name of the object they lead to', () => {
    const c = navControls(hist, state(1), (id) => names[id]);
    expect(c.back.label).toBe('Back: previous view');       // the entry before is a view with nothing selected
    expect(c.forward.label).toBe('Forward: Andromeda Galaxy (M31)');
    const d = navControls(hist, state(2), (id) => names[id]);
    expect(d.back.label).toBe('Back: Sirius');
    expect(d.forward.enabled).toBe(false);
    expect(d.previous.enabled).toBe(true);
  });
  it('without a navigation controller everything is disabled', () => {
    const c = navControls([], null, () => undefined);
    expect([c.back.enabled, c.forward.enabled, c.previous.enabled]).toEqual([false, false, false]);
  });
  it('the flight statement is one honest line; inspect-only records get the notice instead of a flight', () => {
    const star = { position: { kind: 'icrs' as const, xyzPc: [0, 0, 0] as [number, number, number], raDeg: 0, decDeg: 0 }, drawn: true };
    expect(flightStatement('Sirius', star, 'flying')).toBe('Flying to Sirius…');
    expect(flightStatement('Sirius', star, 'arrived')).toBe('At Sirius.');
    expect(flightStatement('Sirius', star, 'no-flight')).toBe('Sirius is selected; the camera did not move.');
    const sky = { position: { kind: 'sky-only' as const, raDeg: 0, decDeg: 0 }, drawn: false };
    expect(flightStatement('X', sky, 'flying')).toMatch(/^Cannot be placed in 3D: distance unknown/);
    expect(flightStatement('X', sky, 'flying')).toMatch(/camera stays where it is/);
  });
});
