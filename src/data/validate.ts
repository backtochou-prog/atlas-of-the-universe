import type { CelestialObject, Dataset, Measurement } from './schema';

export interface ValidationIssue {
  readonly objectId: string;
  readonly message: string;
}

const isFiniteNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

function checkMeasurement(o: CelestialObject, label: string, m: Measurement | undefined, out: ValidationIssue[]) {
  if (!m) return;
  if (!isFiniteNumber(m.value)) out.push({ objectId: o.id, message: `${label}.value is not finite` });
  if (m.uncertainty !== undefined && (!isFiniteNumber(m.uncertainty) || m.uncertainty < 0)) {
    out.push({ objectId: o.id, message: `${label}.uncertainty must be a non-negative number` });
  }
  if (!m.source?.source || !m.source.retrieved) {
    out.push({ objectId: o.id, message: `${label} lacks source or retrieval date` });
  }
}

/** Rejects records that would present unsourced or non-physical values as data. */
export function validateDataset(ds: Dataset): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  if (!ds.source?.source || !ds.licence) out.push({ objectId: ds.id, message: 'dataset lacks source or licence' });
  for (const o of ds.objects) {
    if (!o.name.trim()) out.push({ objectId: o.id, message: 'empty name' });
    checkMeasurement(o, 'radius', o.radius, out);
    checkMeasurement(o, 'mass', o.mass, out);
    checkMeasurement(o, 'temperature', o.temperature, out);
    if (o.radius && o.radius.value <= 0) out.push({ objectId: o.id, message: 'radius must be positive' });
    if (o.mass && o.mass.value <= 0) out.push({ objectId: o.id, message: 'mass must be positive' });
    if (o.temperature && o.temperature.value <= 0) out.push({ objectId: o.id, message: 'temperature must be positive (K)' });
    if (o.sky) {
      if (o.sky.raDeg < 0 || o.sky.raDeg >= 360) out.push({ objectId: o.id, message: 'RA out of [0,360)' });
      if (o.sky.decDeg < -90 || o.sky.decDeg > 90) out.push({ objectId: o.id, message: 'Dec out of [-90,90]' });
      checkMeasurement(o, 'sky.distance', o.sky.distance, out);
    }
  }
  return out;
}
