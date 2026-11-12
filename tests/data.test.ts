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
        radius: { value: -1, unit: 'm', source: { source: '', retrieved: '' } },
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

describe('DataRegistry', () => {
  it('registers datasets and rejects duplicate object ids', () => {
    const r = new DataRegistry().register(SEED_SOLAR);
    expect(r.get('earth')?.name).toBe('Earth');
    expect(() => r.register({ ...SEED_SOLAR, id: 'other' })).toThrow(/Duplicate object id/);
  });
});
