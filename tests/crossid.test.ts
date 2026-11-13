import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findHipConflicts, findPositionalDuplicates, mergeSimbad, type SimbadRow } from '../src/data/ingestion/crossid';
import { buildSimbadBatchQuery, parseOtypes, parseSimbadBatch, probeSimbad, selectIdentifiers, SIMBAD_ENDPOINTS } from '../src/data/ingestion/simbad';
import type { GaiaRecord } from '../src/data/catalogue/flags';
import { GAIA_NUMERIC_COLUMNS } from '../src/data/catalogue/columns';

const rec = (id: string, ra: number, dec: number, hip: number | null = null): GaiaRecord => {
  const values = Object.fromEntries(GAIA_NUMERIC_COLUMNS.map((c) => [c, null])) as GaiaRecord['values'];
  return { sourceId: id, duplicatedSource: false, values: { ...values, ra, dec, hip_id: hip } };
};

describe('duplicate and cross-identification detection', () => {
  it('finds two Gaia sources claiming the same Hipparcos star, and does not merge them', () => {
    const c = findHipConflicts([rec('1', 10, 10, 555), rec('2', 10.001, 10, 555), rec('3', 50, 20, 777), rec('4', 60, 20, null)]);
    expect(c).toEqual([{ hipId: 555, sourceIds: ['1', '2'] }]);
  });
  it('finds positional duplicate candidates within 0.5 arcsec and not beyond', () => {
    const near = findPositionalDuplicates([rec('a', 100, 20), rec('b', 100 + 0.2 / 3600 / Math.cos((20 * Math.PI) / 180), 20), rec('c', 100, 20 + 2 / 3600)]);
    expect(near.map((p) => [p.a, p.b])).toEqual([['a', 'b']]);
    expect(near[0]!.separationArcsec).toBeLessThan(0.5);
  });
  it('finds duplicates across the RA 0/360 wrap and near the pole', () => {
    expect(findPositionalDuplicates([rec('w1', 359.99999, 10), rec('w2', 0.00001, 10)])).toHaveLength(1);
    // 0.0001 deg = 0.36 arcsec apart on opposite sides of the pole (RA differs by 180 deg).
    expect(findPositionalDuplicates([rec('p1', 10, 89.99995), rec('p2', 190, 89.99995)])).toHaveLength(1);
    expect(findPositionalDuplicates([rec('s1', 10, -89.99995), rec('s2', 190, -89.99995)])).toHaveLength(1);
    // Same RA offset a bit further from the pole is genuinely far apart.
    expect(findPositionalDuplicates([rec('f1', 10, 89.9), rec('f2', 190, 89.9)])).toEqual([]);
  });
  it('reports nothing for well-separated sources', () => {
    expect(findPositionalDuplicates([rec('x', 10, 10), rec('y', 11, 10)])).toEqual([]);
  });
});

describe('SIMBAD query construction', () => {
  it('builds an exact-identifier batch query and quotes safely', () => {
    const q = buildSimbadBatchQuery(['123', '456']);
    expect(q).toContain("'Gaia DR3 123','Gaia DR3 456'");
    expect(q).toMatch(/FROM ident AS i1/);
  });
  it('refuses anything that is not a numeric Gaia id (no query injection)', () => {
    expect(() => buildSimbadBatchQuery(["1'); DROP TABLE basic;--"])).toThrow(/invalid Gaia id/);
    expect(() => buildSimbadBatchQuery([])).toThrow();
  });
});

describe('SIMBAD parsing (real rows)', () => {
  const rows = parseSimbadBatch(readFileSync('tests/fixtures/simbad-batch.csv', 'utf8'));
  it('parses main id, type, spectral type and coordinate reference', () => {
    const phe = rows.find((r) => r.gaiaIdent === 'Gaia DR3 4993479684438433792')!;
    expect(phe.entry).toMatchObject({ m: '* alf Phe', t: 'SB*', sp: 'K0.5IIIb', c: '2007A&A...474..653V' });
    expect(phe.entry.i).toContain('NAME Ankaa');
    expect(phe.entry.n).toBeGreaterThan(30); // full id count is kept even though the list is capped
  });
  it('prioritises useful identifiers, caps the list and drops the Gaia id itself', () => {
    const phe = rows.find((r) => r.gaiaIdent === 'Gaia DR3 4993479684438433792')!;
    expect(phe.entry.i.length).toBeLessThanOrEqual(12);
    expect(phe.entry.i[0]).toBe('NAME Ankaa');
    expect(phe.entry.i.some((x) => x.startsWith('Gaia DR3'))).toBe(false);
  });
  it('collapses the padded whitespace SIMBAD uses in identifiers', () => {
    expect(selectIdentifiers('HD   2261|HIP 2081|junk thing').selected).toEqual(['HD 2261', 'HIP 2081']);
  });
  it('parses the object-type vocabulary', () => {
    expect(parseOtypes('otype,label,description\n"SB*","SpectroscopicBinary","Spectroscopic binary"\n')['SB*']!.label).toBe('SpectroscopicBinary');
  });
});

describe('merging SIMBAD into Gaia by exact identifier', () => {
  const row = (g: string, oid: number, main: string): SimbadRow => ({ gaiaIdent: `Gaia DR3 ${g}`, oid, entry: { m: main, t: '*', i: [], n: 1 } });
  it('matches by identifier, reports unmatched, and never guesses by position', () => {
    const m = mergeSimbad(['1', '2', '3'], [row('1', 10, 'A'), row('2', 11, 'B')]);
    expect(m.matched).toBe(2);
    expect(m.unmatched).toEqual(['3']);
    expect(m.entries['1']!.m).toBe('A');
  });
  it('leaves a Gaia id unmatched and reports a conflict if SIMBAD returns two different objects for it', () => {
    const m = mergeSimbad(['1'], [row('1', 10, 'A'), row('1', 99, 'B')]);
    expect(m.entries['1']).toBeUndefined();
    expect(m.conflicts).toEqual([{ sourceId: '1', oids: [10, 99] }]);
  });
  it('reports one SIMBAD object matched by two Gaia sources (blended/duplicated sources)', () => {
    const m = mergeSimbad(['1', '2'], [row('1', 10, 'A'), row('2', 10, 'A')]);
    expect(m.sharedObjects).toEqual([{ oid: 10, mainId: 'A', sourceIds: ['1', '2'] }]);
    expect(m.matched).toBe(2);
  });
  it('ignores identifiers that are not Gaia DR3 ids', () => {
    expect(mergeSimbad(['1'], [{ gaiaIdent: 'HIP 1', oid: 1, entry: { m: 'x', t: '*', i: [], n: 1 } }]).matched).toBe(0);
  });
});

describe('SIMBAD endpoint failover (no network)', () => {
  const resp = (text: string, ok = true, status = 200) => ({ ok, status, text: async () => text, redirected: false, url: '' }) as unknown as Response;
  it('falls back to the mirror when the primary returns an unavailable page', async () => {
    const f = (async (url: string) => (String(url).includes('cds.unistra.fr') ? resp('<html>Page unavailable</html>', false, 404) : resp('main_id\n"x"\n'))) as unknown as typeof fetch;
    const r = await probeSimbad(SIMBAD_ENDPOINTS, { fetch: f });
    expect(r.chosen!.endpoint).toContain('cfa.harvard.edu');
    expect(r.attempts[0]!.reachable).toBe(false);
  });
  it('reports no endpoint (and fabricates nothing) when all are down', async () => {
    const f = (async () => resp('<html>down</html>', false, 503)) as unknown as typeof fetch;
    const r = await probeSimbad(SIMBAD_ENDPOINTS, { fetch: f });
    expect(r.chosen).toBeNull();
    expect(r.attempts.every((a) => !a.reachable)).toBe(true);
  });
});
