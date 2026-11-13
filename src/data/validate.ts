import type { CelestialObject, Dataset, Measurement, MeasurementKind } from './schema';

export interface ValidationIssue {
  readonly objectId: string;
  readonly message: string;
}

/** Units the application understands. A measurement with any other unit is rejected, not guessed. */
export const ALLOWED_UNITS: ReadonlySet<string> = new Set([
  'm', 'km', 'kg', 'K', 's', 'h', 'd', 'yr', 'deg', 'rad', 'arcsec', 'mas', 'mas/yr', 'km/s', 'pc', 'kpc', 'ly', 'AU', 'mag', 'dimensionless',
  'g/cm3', 'm/s2', 'W', 'km3/s2',
]);

const KINDS: ReadonlySet<MeasurementKind> = new Set(['observed', 'derived', 'modelled', 'hypothetical']);

const isFiniteNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

function checkMeasurement(o: CelestialObject, label: string, m: Measurement | undefined, out: ValidationIssue[]) {
  if (!m) return;
  if (!isFiniteNumber(m.value)) out.push({ objectId: o.id, message: `${label}.value is not finite` });
  if (m.uncertainty !== undefined && (!isFiniteNumber(m.uncertainty) || m.uncertainty < 0)) {
    out.push({ objectId: o.id, message: `${label}.uncertainty must be a non-negative number` });
  }
  if (!ALLOWED_UNITS.has(m.unit)) out.push({ objectId: o.id, message: `${label}.unit "${m.unit}" is not a recognised unit` });
  if (m.uncertaintyUnit !== undefined && !ALLOWED_UNITS.has(m.uncertaintyUnit)) {
    out.push({ objectId: o.id, message: `${label}.uncertaintyUnit "${m.uncertaintyUnit}" is not a recognised unit` });
  }
  if (!KINDS.has(m.kind)) out.push({ objectId: o.id, message: `${label}.kind must be observed, derived, modelled or hypothetical` });
  if (!m.source?.source || !m.source.retrieved) {
    out.push({ objectId: o.id, message: `${label} lacks source or retrieval date` });
  }
  if (m.kind === 'derived' && (!m.transformations || m.transformations.length === 0)) {
    out.push({ objectId: o.id, message: `${label} is derived but records no transformations` });
  }
}

/** Rejects records that would present unsourced, unit-less or non-physical values as data. */
export function validateDataset(ds: Dataset): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  if (!ds.source?.source || !ds.licence) out.push({ objectId: ds.id, message: 'dataset lacks source or licence' });
  const seen = new Set<string>();
  for (const o of ds.objects) {
    if (!o.id.trim()) out.push({ objectId: '(empty id)', message: 'object has no identifier' });
    if (seen.has(o.id)) out.push({ objectId: o.id, message: 'duplicate object id in dataset' });
    seen.add(o.id);
    if (!o.name.trim()) out.push({ objectId: o.id, message: 'empty name' });
    checkMeasurement(o, 'radius', o.radius, out);
    checkMeasurement(o, 'mass', o.mass, out);
    checkMeasurement(o, 'temperature', o.temperature, out);
    for (const [key, m] of Object.entries(o.measurements ?? {})) checkMeasurement(o, key, m, out);
    if (o.radius && o.radius.value <= 0) out.push({ objectId: o.id, message: 'radius must be positive' });
    if (o.mass && o.mass.value <= 0) out.push({ objectId: o.id, message: 'mass must be positive' });
    if (o.temperature && o.temperature.value <= 0) out.push({ objectId: o.id, message: 'temperature must be positive (K)' });
    if (o.sky) {
      if (!isFiniteNumber(o.sky.raDeg) || !isFiniteNumber(o.sky.decDeg)) {
        out.push({ objectId: o.id, message: 'coordinates are not finite' });
      } else {
        if (o.sky.raDeg < 0 || o.sky.raDeg >= 360) out.push({ objectId: o.id, message: 'RA out of [0,360)' });
        if (o.sky.decDeg < -90 || o.sky.decDeg > 90) out.push({ objectId: o.id, message: 'Dec out of [-90,90]' });
      }
      checkMeasurement(o, 'sky.distance', o.sky.distance, out);
      if (o.sky.distance && o.sky.distance.value <= 0) out.push({ objectId: o.id, message: 'distance must be positive' });
    }
  }
  return out;
}
