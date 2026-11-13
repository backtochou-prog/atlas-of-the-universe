import { describe, expect, it } from 'vitest';
import { DataRegistry, SEED_SOLAR, validateDataset, type Dataset } from '../src/data';

describe('seed dataset', () => {
  it('passes validation with no issues', () => {
    expect(validateDataset(SEED_SOLAR)).toEqual([]);
  });
  it('every measurement carries a source and retrieval date', () => {
    for (const o of SEED_SOLAR.objects)
      for (const m of [o.radius, o.mass, o.temperature])
        if (m) {
          expect(m.source.source).toBeTruthy();
          expect(m.source.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
  });
});

describe('validateDataset', () => {
  const bad: Dataset = {
    id: 'bad',
    title: 'bad',
    source: { source: 'x', retrieved: '2026-01-01' },
    licence: 'test',
    objects: [
      {
        id: 'ghost',
        name: 'Ghost',
        designations: [],
        classification: 'other',
        frame: 'f',
        radius: { value: -1, unit: 'm', kind: 'observed', source: { source: '', retrieved: '' } },
        sky: { raDeg: 400, decDeg: 0 },
        confidence: 'hypothetical',
      },
    ],
  };
  it('flags negative radius, missing provenance and out-of-range RA', () => {
    const msgs = validateDataset(bad).map((i) => i.message);
    expect(msgs).toEqual(expect.arrayContaining(['radius must be positive', 'radius lacks source or retrieval date', 'RA out of [0,360)']));
  });
});

describe('measurement categories, units and transformations', () => {
  const base = (m: Record<string, unknown>): Dataset => ({
    id: 'k', title: 'k', source: { source: 'x', retrieved: '2026-01-01' }, licence: 'test',
    objects: [{ id: 'o', name: 'O', designations: [], classification: 'star', frame: 'f', confidence: 'catalogued',
      measurements: { m: { value: 1, unit: 'mas', kind: 'observed', source: { source: 'gaia-dr3', retrieved: '2026-01-01' }, ...m } as never } }],
  });
  const msgs = (ds: Dataset) => validateDataset(ds).map((i) => i.message);
  it('accepts a well-formed observed measurement', () => {
    expect(msgs(base({}))).toEqual([]);
  });
  it('rejects unknown units rather than guessing', () => {
    expect(msgs(base({ unit: 'furlong' }))).toContain('m.unit "furlong" is not a recognised unit');
  });
  it('rejects an unknown measurement kind', () => {
    expect(msgs(base({ kind: 'guessed' }))).toContain('m.kind must be observed, derived, modelled or hypothetical');
  });
  it('requires transformations for derived values', () => {
    expect(msgs(base({ kind: 'derived' }))).toContain('m is derived but records no transformations');
    expect(msgs(base({ kind: 'derived', transformations: ['d = 1000/parallax'] }))).toEqual([]);
  });
  it('rejects negative or non-finite uncertainty and non-finite values', () => {
    expect(msgs(base({ uncertainty: -1 }))).toContain('m.uncertainty must be a non-negative number');
    expect(msgs(base({ value: NaN }))).toContain('m.value is not finite');
  });
  it('treats a legitimate zero as a valid value (zero is not "missing")', () => {
    expect(msgs(base({ value: 0 }))).toEqual([]);
  });
  it('flags duplicate object ids inside a dataset', () => {
    const ds = base({});
    const dup: Dataset = { ...ds, objects: [...ds.objects, ...ds.objects] };
    expect(msgs(dup)).toContain('duplicate object id in dataset');
  });
});

describe('DataRegistry', () => {
  it('registers datasets and rejects duplicate object ids', () => {
    const r = new DataRegistry().register(SEED_SOLAR);
    expect(r.get('earth')?.name).toBe('Earth');
    expect(() => r.register({ ...SEED_SOLAR, id: 'other' })).toThrow(/Duplicate object id/);
  });
});
