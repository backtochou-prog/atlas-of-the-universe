/**
 * Least-squares fit of a satellite's MEAN-LONGITUDE RATE from osculating elements sampled over a window.
 *
 * The mean longitude lambda = node + argPeri + M advances almost linearly even when the apsidal line and the node
 * precess and M alone does not (the anomalistic period differs from the sidereal period). Fitting lambda(t) removes
 * the short-period oscillations of the osculating elements and gives a rate that keeps the satellite's position
 * in phase over years. The fit is data-derived from JPL Horizons and validated against it (see the dataset).
 */
export interface ElementSample {
  readonly jdTdb: number;
  readonly nodeDeg: number;
  readonly argPeriDeg: number;
  readonly meanAnomalyDeg: number;
}

export interface MeanLongitudeFit {
  readonly rateDegPerDay: number;
  readonly periodDays: number;
  /** RMS of the residuals about the fitted line, degrees (reflects the short-period oscillation amplitude). */
  readonly rmsDeg: number;
  readonly samples: number;
  readonly windowDays: number;
}

const wrap180 = (x: number): number => ((((x + 180) % 360) + 360) % 360) - 180;

export function meanLongitudeDeg(s: ElementSample): number {
  return s.nodeDeg + s.argPeriDeg + s.meanAnomalyDeg;
}

/**
 * `guessDegPerDay` only has to be good enough to resolve whole revolutions between consecutive samples:
 * |guess - truth| * spacing must stay below 180 degrees.
 */
export function fitMeanLongitudeRate(samples: readonly ElementSample[], guessDegPerDay: number): MeanLongitudeFit {
  if (samples.length < 4) throw new Error('Need at least 4 samples to fit a mean-longitude rate');
  const sorted = [...samples].sort((a, b) => a.jdTdb - b.jdTdb);
  const t0 = sorted[0]!.jdTdb;
  // Unwrap: choose the revolution count that makes each step closest to the predicted advance.
  const ts: number[] = [], ls: number[] = [];
  let prev = meanLongitudeDeg(sorted[0]!);
  ts.push(0); ls.push(prev);
  for (let i = 1; i < sorted.length; i++) {
    const dt = sorted[i]!.jdTdb - sorted[i - 1]!.jdTdb;
    const predicted = prev + guessDegPerDay * dt;
    const l = meanLongitudeDeg(sorted[i]!);
    const unwrapped = predicted + wrap180(l - predicted);
    ts.push(sorted[i]!.jdTdb - t0); ls.push(unwrapped); prev = unwrapped;
  }
  const n = ts.length;
  const mt = ts.reduce((a, b) => a + b, 0) / n, ml = ls.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (ts[i]! - mt) ** 2; sxy += (ts[i]! - mt) * (ls[i]! - ml); }
  const rate = sxy / sxx;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (ls[i]! - (ml + rate * (ts[i]! - mt))) ** 2;
  return { rateDegPerDay: rate, periodDays: 360 / rate, rmsDeg: Math.sqrt(ss / n), samples: n, windowDays: ts[n - 1]! - ts[0]! };
}

/** Sample spacing (days) that keeps revolution counting unambiguous: a few periods for fast moons, at most 30 days. */
export function sampleSpacingDays(approxPeriodDays: number): number {
  return Math.min(30, Math.max(0.5, 5 * approxPeriodDays));
}
