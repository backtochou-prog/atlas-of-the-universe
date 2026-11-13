import { describe, expect, it } from 'vitest';
import { CATEGORY_ORDER, SCAN_CAP, SearchIndex, buildSearchIndex, editDistance, highlightRanges } from '../src/discovery/searchIndex';
import type { DiscoveryRecord, ObjectCategory } from '../src/discovery/types';
import { rec } from './fixtures/discovery/synthetic';

const mag = (v: number) => ({ apparentMag: { value: v, kind: 'observed' as const } });
const corpus = (): DiscoveryRecord[] => [
  rec('hip:32349', 'Sirius', ['HIP 32349', 'alf CMa', '* alf CMa', 'HD 48915', 'HR 2491', 'Gaia DR3 2947050466531873024', 'Dog Star'], 'star', { dataset: 'hipparcos', measurements: mag(-1.46) }),
  rec('hip:27989', 'Betelgeuse', ['HIP 27989', 'alf Ori', 'HD 39801', 'HR 2061'], 'star', { dataset: 'hipparcos', measurements: mag(0.42) }),
  rec('gaia:1', 'HD 48915 B', ['Gaia DR3 1', 'HIP 99999', 'HD 48915'], 'star', { measurements: mag(8.5) }),
  rec('deep:m31', 'Andromeda Galaxy (M31)', ['M 31', 'NGC 224', 'UGC 454'], 'galaxy', { dataset: 'deep-space' }),
  rec('deep:m32', 'M32', ['M 32', 'NGC 221'], 'galaxy', { dataset: 'deep-space' }),
  rec('deep:m3', 'M3', ['M 3', 'NGC 5272'], 'star-cluster', { dataset: 'deep-space' }),
  rec('point:ungc:7', 'NGC 22', ['NGC 22'], 'galaxy', { dataset: 'ungc' }),
  rec('deep:crab', 'Crab Nebula', ['M 1', 'NGC 1952', 'Taurus A'], 'supernova-remnant', { dataset: 'deep-space' }),
  rec('deep:orion', 'Orion Nebula', ['M 42', 'NGC 1976'], 'nebula', { dataset: 'deep-space' }),
  rec('solar:mars', 'Mars', ['Mars', 'NAIF 499'], 'planet', { dataset: 'solar-system' }),
  rec('solar:earth', 'Earth', ['Earth', 'Terra'], 'planet', { dataset: 'solar-system' }),
  rec('host:TRAPPIST-1', 'TRAPPIST-1', ['TRAPPIST-1', '2MASS J23062928-0502285'], 'exoplanet-host', { dataset: 'nasa-exoplanet-archive' }),
  rec('exo:TRAPPIST-1 e', 'TRAPPIST-1 e', ['TRAPPIST-1 e'], 'exoplanet', { dataset: 'nasa-exoplanet-archive' }),
  rec('exo:Kepler-452 b', 'Kepler-452 b', ['Kepler-452 b'], 'exoplanet', { dataset: 'nasa-exoplanet-archive' }),
  rec('other:sgr', 'Sagittarius A*', ['Sagittarius A*', 'Sgr A*', 'NAME Sgr A*'], 'other', { dataset: 'curated-other' }),
  rec('other:crabpsr', 'Crab Pulsar', ['Crab Pulsar', 'PSR B0531+21', 'V* CM Tau'], 'other', { dataset: 'curated-other' }),
  rec('hip:11767', 'Polaris', ['HIP 11767', 'alf UMi', 'HD 8890'], 'star', { dataset: 'hipparcos', measurements: mag(1.98) }),
  rec('hip:1', 'Boötes Star', ['HIP 1001'], 'star', { dataset: 'hipparcos' }),
  rec('gaia:2', 'Gaia DR3 4472832130942575872', ['Gaia DR3 4472832130942575872', 'HIP 87937', "Barnard's star", 'GJ 699'], 'star'),
];

const ids = (r: { hits: readonly { id: string }[] }): string[] => r.hits.map((h) => h.id);

describe('search index: match kinds and normalisation', () => {
  const idx = buildSearchIndex(corpus());
  it('exact: every spelling of a designation finds the record, kind exact', () => {
    for (const q of ['alpha CMa', 'α CMa', 'alf cma', 'alpha Canis Majoris', 'ALF CMA']) {
      const r = idx.search(q);
      expect(ids(r), q).toContain('hip:32349');
      const h = r.hits.find((x) => x.id === 'hip:32349')!;
      expect(h.matchKind, q).toBe('exact');
    }
  });
  it('identifier search finds every designation of a record', () => {
    for (const q of ['HIP 32349', 'hip32349', 'HD 48915', 'HR 2491', 'Gaia DR3 2947050466531873024', '2947050466531873024', 'gaia 2947050466531873024', 'Dog Star', 'Sirius']) {
      expect(ids(idx.search(q)), q).toContain('hip:32349');
    }
  });
  it('M31 finds the galaxy through the bracketed part of its name and through its other designations', () => {
    for (const q of ['M31', 'M 31', 'Messier 31', 'NGC 224', 'NGC224', 'UGC 454', 'Andromeda Galaxy', 'andromeda']) expect(ids(idx.search(q)), q).toContain('deep:m31');
    expect(idx.search('M31').hits[0]!.id).toBe('deep:m31');
    expect(idx.search('M31').hits[0]!.matchKind).toBe('exact');
  });
  it('M3 is not M31; NGC 22 is not NGC 224; HIP 3 is not HIP 32349 (exact hits never mix them)', () => {
    const m3 = idx.search('M3');
    expect(m3.hits[0]!.id).toBe('deep:m3');
    expect(m3.hits[0]!.matchKind).toBe('exact');
    expect(m3.hits.filter((h) => h.matchKind === 'exact').map((h) => h.id)).toEqual(['deep:m3']);
    const ngc22 = idx.search('NGC 22');
    expect(ngc22.hits.filter((h) => h.matchKind === 'exact').map((h) => h.id)).toEqual(['point:ungc:7']);
    const hip3 = idx.search('HIP 3');
    expect(hip3.hits.every((h) => h.matchKind !== 'exact')).toBe(true);        // no HIP 3 in the corpus
    expect(hip3.hits.find((h) => h.id === 'hip:32349')?.matchKind).toBe('prefix');   // a prefix hit is allowed and is labelled as such
  });
  it('exoplanet names: hyphen and space spellings are one designation', () => {
    for (const q of ['Kepler-452b', 'Kepler-452 b', 'kepler 452 b', 'kepler452b']) expect(idx.search(q).hits[0]!.id, q).toBe('exo:Kepler-452 b');
    for (const q of ['TRAPPIST-1e', 'trappist 1 e', 'TRAPPIST 1e']) expect(idx.search(q).hits[0]!.id, q).toBe('exo:TRAPPIST-1 e');
    expect(idx.search('TRAPPIST 1').hits[0]!.id).toBe('host:TRAPPIST-1');
    expect(ids(idx.search('TRAPPIST-1'))).toEqual(expect.arrayContaining(['host:TRAPPIST-1', 'exo:TRAPPIST-1 e']));
  });
  it('Sgr A*, pulsars and diacritics', () => {
    expect(idx.search('Sagittarius A*').hits[0]!.id).toBe('other:sgr');
    expect(idx.search('sgr a*').hits[0]!.id).toBe('other:sgr');
    expect(idx.search('PSR B0531+21').hits[0]!.id).toBe('other:crabpsr');
    expect(idx.search('psrb0531+21').hits[0]!.id).toBe('other:crabpsr');
    expect(ids(idx.search('Bootes'))).toContain('hip:1');
    expect(ids(idx.search('boötes'))).toContain('hip:1');
    expect(idx.search("Barnard's star").hits[0]!.id).toBe('gaia:2');
    expect(idx.search('barnards star').hits[0]!.id).toBe('gaia:2');
  });
  it('prefix: typing the start of a name', () => {
    const r = idx.search('betel');
    expect(r.hits[0]!.id).toBe('hip:27989');
    expect(r.hits[0]!.matchKind).toBe('prefix');
  });
  it('token-prefix: words in any order, each a prefix of a word of one designation', () => {
    const r = idx.search('cma alp');
    expect(r.hits[0]!.id).toBe('hip:32349');
    expect(r.hits[0]!.matchKind).toBe('token-prefix');
    expect(ids(idx.search('galaxy andro'))).toContain('deep:m31');
  });
  it('substring inside a name-like word', () => {
    const r = idx.search('geuse');
    expect(r.hits[0]!.id).toBe('hip:27989');
    expect(r.hits[0]!.matchKind).toBe('substring');
    expect(idx.search('rometh').hits).toHaveLength(0 + idx.search('rometh').hits.length);   // no throw on odd substrings
  });
  it('catalogue numbers are never matched as substrings', () => {
    const r = idx.search('9272');                       // inside NGC 5272 only
    expect(r.hits.filter((h) => h.matchKind === 'substring')).toHaveLength(0);
  });
  it('the matched designation is reported as published, with highlight ranges', () => {
    const r = idx.search('hd48915');
    const h = r.hits.find((x) => x.id === 'hip:32349')!;
    expect(h.matchedDesignation).toBe('HD 48915');
    expect(h.highlight).toEqual([[0, 8]]);
    const s = idx.search('Siri');
    expect(s.hits[0]!.matchedDesignation).toBe('Sirius');
    expect(s.hits[0]!.highlight).toEqual([[0, 4]]);
    const a = idx.search('alpha cma').hits.find((x) => x.id === 'hip:32349')!;
    expect(a.matchedDesignation).toBe('alf CMa');         // matched through the Bayer rule
  });
  it('same designation on two records: both returned', () => {
    expect(ids(idx.search('HD 48915'))).toEqual(expect.arrayContaining(['hip:32349', 'gaia:1']));
    const both = idx.search('HD 48915').hits.filter((h) => h.matchKind === 'exact').map((h) => h.id);
    expect(both).toContain('hip:32349');
  });
});

describe('typo tolerance', () => {
  const idx = buildSearchIndex(corpus());
  it('a typo finds the word, flagged fuzzy with what it matched', () => {
    const r = idx.search('betelgeuze');
    expect(r.fuzzyUsed).toBe(true);
    expect(r.hits[0]!.id).toBe('hip:27989');
    expect(r.hits[0]!.matchKind).toBe('fuzzy');
    expect(r.hits[0]!.fuzzy).toEqual({ typed: 'betelgeuze', matched: 'betelgeuse', distance: 1 });
    expect(r.hits[0]!.highlight).toEqual([]);
  });
  it('distance 1 for 4-7 letters, 2 for 8 or more', () => {
    expect(idx.search('sirus').hits[0]?.fuzzy?.distance).toBe(1);               // 5 letters, one deletion
    expect(idx.search('sirus').hits[0]?.id).toBe('hip:32349');
    expect(idx.search('sirrus').hits[0]?.id).toBe('hip:32349');                 // insertion
    expect(idx.search('mats').hits.filter((h) => h.id === 'solar:mars')).toHaveLength(1);   // 4 letters, substitution
    expect(idx.search('mxts').hits.filter((h) => h.id === 'solar:mars')).toHaveLength(0);   // two edits at 4 letters: not allowed
    expect(idx.search('betelgxuze').hits[0]?.fuzzy?.distance).toBe(2);          // 10 letters, two edits
    expect(idx.search('betelgxuzx').hits.filter((h) => h.id === 'hip:27989')).toHaveLength(0);   // three edits
  });
  it('a transposition counts as one edit', () => {
    expect(idx.search('sirisu').hits[0]?.id).toBe('hip:32349');
    expect(idx.search('sirisu').hits[0]?.fuzzy?.distance).toBe(1);
    expect(editDistance('vega', 'vgea', 2)).toBe(1);
    expect(editDistance('abc', 'abc', 2)).toBe(0);
    expect(editDistance('abcdef', 'ghijkl', 2)).toBeGreaterThan(2);
  });
  it('words shorter than 4 letters are never corrected', () => {
    expect(idx.search('mrs').hits).toHaveLength(0);
    expect(editDistance('mrs', 'mars', 1)).toBe(1);   // it would be within reach; the index must still not do it
  });
  it('a typo match is never ranked above an exact or prefix match', () => {
    const extra = [...corpus(), rec('x:near', 'Sirus', ['Sirus'], 'other')];            // a REAL object whose name is the typo
    const i2 = buildSearchIndex(extra);
    const r = i2.search('sirus');
    expect(r.hits[0]!.id).toBe('x:near');
    expect(r.hits[0]!.matchKind).toBe('exact');
    const kinds = r.hits.map((h) => h.matchKind);
    expect(kinds).toEqual([...kinds].sort((a, b) => ['exact', 'prefix', 'token-prefix', 'substring', 'fuzzy'].indexOf(a) - ['exact', 'prefix', 'token-prefix', 'substring', 'fuzzy'].indexOf(b)));
    expect(r.hits.some((h) => h.matchKind === 'fuzzy')).toBe(false);                    // enough real hits: the typo stage did not run
  });
  it('identifiers and numbers are never fuzzy-matched', () => {
    expect(idx.search('HIP 32350').hits.filter((h) => h.id === 'hip:32349')).toHaveLength(0);
    expect(idx.search('hd 48916').hits.filter((h) => h.id === 'hip:32349')).toHaveLength(0);
    expect(idx.search('hip 3234').hits.every((h) => h.matchKind !== 'fuzzy')).toBe(true);
  });
  it('the typo stage can be switched off', () => {
    expect(idx.search('betelgeuze', { fuzzy: false }).hits).toHaveLength(0);
  });
  it('multi-word typos need every word to be found', () => {
    expect(idx.search('crab nebuls').hits[0]?.id).toBe('deep:crab');
    expect(idx.search('crab nebuls').hits[0]?.matchKind).toBe('fuzzy');
    expect(idx.search('crab zzzzzzz').hits).toHaveLength(0);
  });
});

describe('ranking', () => {
  it('match quality first, then category order, then proper name before identifier, then brighter magnitude, then insertion order', () => {
    const recs = [
      rec('a:gal', 'Alpha Galaxy', ['Alpha Galaxy'], 'galaxy'),
      rec('a:star-faint', 'Alpha Faint', ['Alpha Faint'], 'star', { measurements: mag(9) }),
      rec('a:star-bright', 'Alpha Bright', ['Alpha Bright'], 'star', { measurements: mag(1) }),
      rec('a:star-id', 'HIP 55', ['HIP 55', 'Alpha 55'], 'star', { measurements: mag(0) }),
      rec('a:planet', 'Alpha Planet', ['Alpha Planet'], 'planet'),
      rec('a:star-nomag', 'Alpha Nomag', ['Alpha Nomag'], 'star'),
      rec('a:star-nomag2', 'Alpha Nomag Two', ['Alpha Nomag Two'], 'star'),
    ];
    const r = buildSearchIndex(recs).search('alpha');
    expect(ids(r)).toEqual(['a:planet', 'a:star-bright', 'a:star-faint', 'a:star-nomag', 'a:star-nomag2', 'a:star-id', 'a:gal']);
    expect(r.hits.every((h) => h.matchKind === 'prefix')).toBe(true);
  });
  it('exact beats prefix beats token-prefix regardless of the prior', () => {
    const recs = [
      rec('p:1', 'Mars Bar', ['Mars Bar'], 'planet', { measurements: mag(-30) }),
      rec('p:2', 'Ceres Mars', ['Ceres Mars'], 'planet', { measurements: mag(-30) }),
      rec('p:3', 'Mars', ['Mars'], 'other'),
    ];
    const r = buildSearchIndex(recs).search('mars');
    expect(r.hits.map((h) => [h.id, h.matchKind])).toEqual([['p:3', 'exact'], ['p:1', 'prefix'], ['p:2', 'token-prefix']]);
    expect(r.hits[0]!.score).toBeGreaterThan(r.hits[1]!.score);
    expect(r.hits[1]!.score).toBeGreaterThan(r.hits[2]!.score);
  });
  it('a custom category order is honoured and no dataset appears in the default one', () => {
    const recs = [rec('s', 'Zed One', ['Zed One'], 'star', { dataset: 'gaia-dr3' }), rec('g', 'Zed Two', ['Zed Two'], 'galaxy', { dataset: 'deep-space' })];
    expect(ids(buildSearchIndex(recs).search('zed'))[0]).toBe('s');
    expect(ids(buildSearchIndex(recs, { categoryOrder: ['galaxy', 'star'] }).search('zed'))[0]).toBe('g');
    expect(CATEGORY_ORDER).toHaveLength(12);
    expect(new Set(CATEGORY_ORDER).size).toBe(12);
  });
  it('ties are stable: insertion order, and the same query gives the same answer every time', () => {
    const recs = Array.from({ length: 30 }, (_, i) => rec(`t:${i}`, `Twin ${i}`, [`Twin ${i}`], 'star'));
    const idx = buildSearchIndex(recs);
    const a = ids(idx.search('twin', { limit: 30 }));
    expect(a).toEqual(recs.map((r) => r.id));
    expect(ids(idx.search('twin', { limit: 30 }))).toEqual(a);
  });
});

describe('result shape: paging, categories, counts', () => {
  const recs: DiscoveryRecord[] = [];
  const cats: ObjectCategory[] = ['star', 'galaxy', 'nebula', 'planet'];
  for (let i = 0; i < 40; i++) recs.push(rec(`c:${i}`, `Cygnus ${i}`, [`Cygnus ${i}`], cats[i % 4]!, { measurements: mag(i) }));
  const idx = buildSearchIndex(recs);
  it('limit and offset page through the same ordering', () => {
    const all = ids(idx.search('cygnus', { limit: 40 }));
    expect(all).toHaveLength(40);
    expect([...ids(idx.search('cygnus', { limit: 10, offset: 0 })), ...ids(idx.search('cygnus', { limit: 10, offset: 10 })), ...ids(idx.search('cygnus', { limit: 20, offset: 20 }))]).toEqual(all);
    expect(idx.search('cygnus', { limit: 0 }).hits).toHaveLength(0);
    expect(idx.search('cygnus', { offset: 1000 }).hits).toHaveLength(0);
    expect(idx.search('cygnus', { limit: 100000 }).hits.length).toBeLessThanOrEqual(200);
    expect(idx.search('cygnus', { limit: -5, offset: -3 }).hits).toHaveLength(0);
  });
  it('category filter restricts hits but counts stay for every category', () => {
    const r = idx.search('cygnus', { categories: ['galaxy'], limit: 50 });
    expect(r.hits.every((h) => h.category === 'galaxy')).toBe(true);
    expect(r.hits).toHaveLength(10);
    expect(r.total).toBe(10);
    expect(r.categoryCounts).toEqual({ planet: 10, star: 10, galaxy: 10, nebula: 10 });
    const two = idx.search('cygnus', { categories: ['galaxy', 'nebula'], limit: 50 });
    expect(two.total).toBe(20);
    expect(idx.search('cygnus', { categories: [] , limit: 5}).hits).toHaveLength(5);
  });
  it('counts are over distinct records (a record with two matching designations counts once)', () => {
    const i2 = buildSearchIndex([rec('d:1', 'Duo', ['Duo', 'Duo Prime', 'Duo Second'], 'star')]);
    const r = i2.search('duo');
    expect(r.total).toBe(1);
    expect(r.categoryCounts).toEqual({ star: 1 });
    expect(r.hits).toHaveLength(1);
  });
});

describe('safety: empty, very short, garbage and over-long queries', () => {
  const idx = buildSearchIndex(corpus());
  it('return no hits and never throw', () => {
    const bad = ['', ' ', 'a', 'M', '*', '()', '!!!', '\u0000\u0001', '\t\n', '😀', '....', '- - -', 'x'.repeat(129), 'y'.repeat(100000), '%00', '${', '/(/', '[[[', '\\'];
    for (const q of bad) {
      const r = idx.search(q);
      expect(r.hits, JSON.stringify(q.slice(0, 20))).toHaveLength(0);
      expect(r.total).toBe(0);
    }
    expect(idx.search('x'.repeat(129)).normalized).toBeNull();
    expect(idx.search(undefined as unknown as string).hits).toHaveLength(0);
    expect(idx.search(42 as unknown as string).hits).toHaveLength(0);
  });
  it('an empty index answers every query with nothing', () => {
    const e = new SearchIndex();
    expect(e.search('sirius').hits).toHaveLength(0);
    expect(e.size).toBe(0);
  });
  it('records with no usable designation are still addable and not found', () => {
    const e = buildSearchIndex([rec('z:1', '***', ['()', ''], 'other'), rec('z:2', '', [], 'other')]);
    expect(e.size).toBe(2);
    expect(e.search('zz').hits).toHaveLength(0);
  });
  it('a very long designation list does not break the index', () => {
    const many = Array.from({ length: 500 }, (_, i) => `ALT ${i}`);
    const e = buildSearchIndex([rec('m:1', 'Many', many, 'star')]);
    expect(ids(e.search('alt 499'))).toEqual(['m:1']);
  });
});

describe('incremental add', () => {
  it('later datasets join without rebuilding; earlier results are unchanged', () => {
    const idx = new SearchIndex();
    idx.add(corpus().slice(0, 10));
    const before = ids(idx.search('m31'));
    const segsBefore = idx.stats().keySegments;
    const r = idx.add([rec('late:1', 'Late Comer', ['Late Comer', 'HIP 700000'], 'star'), rec('late:2', 'M31 Companion', ['M31 Companion'], 'other')]);
    expect(r).toEqual({ added: 2, skipped: 0 });
    expect(idx.size).toBe(12);
    expect(ids(idx.search('late comer'))).toEqual(['late:1']);
    expect(ids(idx.search('hip 700000'))).toEqual(['late:1']);
    expect(ids(idx.search('m31'))).toEqual(expect.arrayContaining(before));
    expect(ids(idx.search('m31'))).toContain('late:2');
    expect(idx.stats().keySegments).toBeGreaterThanOrEqual(1);
    expect(segsBefore).toBeGreaterThanOrEqual(1);
  });
  it('many small adds are merged into a bounded number of segments and stay correct', () => {
    const idx = new SearchIndex();
    const all: DiscoveryRecord[] = [];
    for (let b = 0; b < 40; b++) {
      const batch = Array.from({ length: 25 }, (_, i) => rec(`b:${b}:${i}`, `Batch ${b} Item ${i}`, [`Batch ${b} Item ${i}`, `HIP ${b * 1000 + i + 5}`], 'star'));
      all.push(...batch);
      idx.add(batch);
    }
    expect(idx.stats().keySegments).toBeLessThanOrEqual(9);
    for (const r of [all[0]!, all[333]!, all[999]!]) {
      expect(idx.search(r.designations[1]!).hits[0]!.id).toBe(r.id);
      expect(idx.search(r.name).hits[0]!.id).toBe(r.id);
    }
    const one = buildSearchIndex(all);
    for (const q of ['batch 3', 'item 7', 'hip 2005', 'batch 39 item 24', 'hip 3900']) expect(ids(idx.search(q, { limit: 50 })), q).toEqual(ids(one.search(q, { limit: 50 })));
  });
  it('a duplicate id is skipped and counted, never indexed twice', () => {
    const idx = new SearchIndex();
    expect(idx.add([rec('d:1', 'First', ['First'], 'star')])).toEqual({ added: 1, skipped: 0 });
    expect(idx.add([rec('d:1', 'Second', ['Second'], 'star'), rec('d:2', 'Third', ['Third'], 'star')])).toEqual({ added: 1, skipped: 1 });
    expect(idx.size).toBe(2);
    expect(idx.search('second').hits).toHaveLength(0);
    expect(idx.get('d:1')!.name).toBe('First');
  });
  it('resolveDesignation returns every record with exactly that designation', () => {
    const idx = buildSearchIndex(corpus());
    expect(idx.resolveDesignation('HD48915').map((r) => r.id).sort()).toEqual(['gaia:1', 'hip:32349']);
    expect(idx.resolveDesignation('hd 48915 b').map((r) => r.id)).toEqual(['gaia:1']);
    expect(idx.resolveDesignation('nonexistent thing')).toEqual([]);
    expect(idx.resolveDesignation('')).toEqual([]);
  });
});

describe('highlight ranges', () => {
  it('align a compact query to a spaced designation', () => {
    expect(highlightRanges('M 31', 'm31', 'exact')).toEqual([[0, 4]]);
    expect(highlightRanges('NGC 224', 'ngc2', 'prefix')).toEqual([[0, 5]]);
  });
  it('mark each word for token-prefix and the substring for substring matches', () => {
    expect(highlightRanges('alf CMa', 'cma alp', 'token-prefix')).toEqual([[4, 7]]);
    expect(highlightRanges('Betelgeuse', 'geuse', 'substring')).toEqual([[5, 10]]);
  });
  it('keep the width of accented text and never throw on odd input', () => {
    expect(highlightRanges('Boötes Void', 'bootes', 'prefix')).toEqual([[0, 6]]);
    expect(highlightRanges('x', '', 'prefix')).toEqual([]);
    expect(highlightRanges('x', 'betelgeuze', 'fuzzy')).toEqual([]);
    expect(() => highlightRanges('😀 Sirius', 'sirius', 'prefix')).not.toThrow();
  });
});

describe('scan bound', () => {
  it('a very broad prefix reports a lower bound instead of scanning everything', () => {
    const n = SCAN_CAP + 2000;
    const recs = Array.from({ length: n }, (_, i) => rec(`s:${i}`, `Star ${i}`, [`SCAN ${i}`], 'star'));
    const r = buildSearchIndex(recs).search('scan');
    expect(r.totalIsLowerBound).toBe(true);
    expect(r.total).toBeLessThanOrEqual(3 * SCAN_CAP);          // bounded by a small multiple of the cap (one scan per stage)
    expect(r.hits).toHaveLength(20);
  });
});
