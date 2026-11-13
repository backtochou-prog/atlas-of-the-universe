/**
 * Deterministic synthetic DiscoveryRecord generators for the discovery tests and benchmarks. Everything here is fake data
 * (so there is no astronomy in it); it exists to exercise scale, never to be shown to a user.
 */
import type { DatasetId, DiscoveryRecord, MeasurementKey, ObjectCategory, RecordMeasurement } from '../../../src/discovery/types';
import { equatorialToUnit } from '../../../src/core/astro/coordinates';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYL = ['ar', 'be', 'cal', 'dor', 'el', 'fa', 'gor', 'hal', 'is', 'jor', 'kel', 'lum', 'mar', 'nor', 'os', 'pel', 'qua', 'rin', 'sa', 'tor', 'ul', 'ver', 'wen', 'xan', 'yor', 'zel'];

/** A pool of `n` distinct pronounceable pseudo-words (4-12 letters). */
export function wordPool(n: number, rnd: () => number): string[] {
  const out = new Set<string>();
  while (out.size < n) {
    const k = 2 + Math.floor(rnd() * 3);
    let w = '';
    for (let i = 0; i < k; i++) w += SYL[Math.floor(rnd() * SYL.length)]!;
    if (w.length >= 4 && w.length <= 12) out.add(w);
  }
  return [...out];
}

export interface SyntheticOptions {
  readonly count: number;
  readonly seed?: number;
  /** Fraction of records with a pseudo-word proper name. Default 0.03. */
  readonly namedFraction?: number;
  readonly words?: number;
}

const CATS: readonly [ObjectCategory, DatasetId][] = [['star', 'gaia-dr3'], ['star', 'hipparcos'], ['exoplanet-host', 'nasa-exoplanet-archive'], ['galaxy', 'twomrs'], ['galaxy', 'ungc'], ['nebula', 'deep-space']];

export function syntheticRecords(opts: SyntheticOptions): { records: DiscoveryRecord[]; words: string[] } {
  const rnd = mulberry32(opts.seed ?? 1);
  const words = wordPool(opts.words ?? 3000, rnd);
  const named = opts.namedFraction ?? 0.03;
  const records: DiscoveryRecord[] = [];
  for (let i = 0; i < opts.count; i++) {
    const catIdx = rnd() < 0.8 ? 0 : Math.floor(rnd() * CATS.length);
    const [category, dataset] = CATS[catIdx]!;
    const gaia = (4_000_000_000_000_000_000n + BigInt(i) * 7_919n + BigInt(Math.floor(rnd() * 1000))).toString();
    const ra = rnd() * 360, dec = Math.asin(rnd() * 2 - 1) * 180 / Math.PI;
    const designations: string[] = [`Gaia DR3 ${gaia}`];
    if (rnd() < 0.15) designations.push(`HIP ${Math.floor(rnd() * 120000)}`);
    if (rnd() < 0.2) designations.push(`HD ${Math.floor(rnd() * 360000)}`);
    if (rnd() < 0.6) designations.push(`2MASS J${String(Math.floor(rnd() * 1e8)).padStart(8, '0')}${rnd() < 0.5 ? '+' : '-'}${String(Math.floor(rnd() * 9e6)).padStart(7, '0')}`);
    if (rnd() < 0.5) designations.push(`TIC ${Math.floor(rnd() * 4e8)}`);
    let name = designations[0]!;
    if (rnd() < named) {
      const w = words[Math.floor(rnd() * words.length)]!;
      name = w[0]!.toUpperCase() + w.slice(1) + (rnd() < 0.3 ? ` ${'ABC'[Math.floor(rnd() * 3)]}` : '');
      designations.push(name);
    }
    const dist = category === 'galaxy' ? 1e6 + rnd() * 1e8 : 1 + rnd() * rnd() * 3000;
    const u = equatorialToUnit(ra, dec);
    const m: Partial<Record<MeasurementKey, RecordMeasurement>> = {};
    if (rnd() < 0.9) m.distancePc = { value: dist, kind: 'derived', uncertainty: dist * (0.01 + rnd() * 0.2) };
    if (rnd() < 0.95) m.apparentMag = { value: 3 + rnd() * 17, kind: 'observed' };
    if (rnd() < 0.5) m.teffK = { value: 2800 + rnd() * 20000, kind: 'modelled' };
    if (rnd() < 0.3) m.pmTotalMasYr = { value: rnd() * rnd() * 2000, kind: 'derived' };
    records.push({
      id: `syn:${i}`, dataset, category, name, designations,
      classification: 'synthetic', ...(rnd() < 0.6 ? { spectralType: ['G2V', 'K5V', 'M3V', 'A0V', 'F8', 'B9', 'DA2', 'M1.5V+M4', 'WN5', 'C-N5'][Math.floor(rnd() * 10)]! } : {}),
      position: m.distancePc ? { kind: 'icrs', xyzPc: [u[0] * dist, u[1] * dist, u[2] * dist], raDeg: ra, decDeg: dec } : { kind: 'sky-only', raDeg: ra, decDeg: dec },
      measurements: m, drawn: m.distancePc !== undefined, sourceKey: dataset,
    });
  }
  return { records, words };
}

/** Tiny hand-written records with real-looking designations for behaviour tests. */
export function rec(id: string, name: string, designations: readonly string[], category: ObjectCategory = 'star', extra: Partial<DiscoveryRecord> = {}): DiscoveryRecord {
  return {
    id, dataset: (extra.dataset ?? 'gaia-dr3'), category, name, designations, classification: 'test',
    position: { kind: 'sky-only', raDeg: 0, decDeg: 0 }, measurements: {}, drawn: false, sourceKey: 'test', ...extra,
  };
}
