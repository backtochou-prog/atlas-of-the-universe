/**
 * Time scales and the simulation clock.
 *
 * Julian dates here are TDB-like (continuous, uniform). UTC differs from TT by (leap seconds + 32.184 s);
 * TT and TDB differ by under 2 ms and that difference is ignored. Simulation time is entirely separate from the
 * user's system clock: nothing in this module reads Date.now().
 */
export const JD_J2000 = 2451545.0;
export const DAYS_PER_CENTURY = 36525;
export const SECONDS_PER_DAY = 86400;
export const TT_MINUS_TAI_SECONDS = 32.184;

/** TAI-UTC (leap seconds), by the UTC date from which each value applies. Dates before 1972 use 10 s; after the table, 37 s. */
const LEAP_SECONDS: readonly (readonly [number, number])[] = [
  [2441317.5, 10], [2441499.5, 11], [2441683.5, 12], [2442048.5, 13], [2442413.5, 14], [2442778.5, 15], [2443144.5, 16],
  [2443509.5, 17], [2443874.5, 18], [2444239.5, 19], [2444786.5, 20], [2445151.5, 21], [2445516.5, 22], [2446247.5, 23],
  [2447161.5, 24], [2447892.5, 25], [2448257.5, 26], [2448804.5, 27], [2449169.5, 28], [2449534.5, 29], [2450083.5, 30],
  [2450630.5, 31], [2451179.5, 32], [2453736.5, 33], [2454832.5, 34], [2456109.5, 35], [2457204.5, 36], [2457754.5, 37],
];

/** TAI - UTC in seconds at a UTC Julian date. No future leap seconds are predicted. */
export function taiMinusUtc(jdUtc: number): number {
  let v = LEAP_SECONDS[0]![1];
  for (const [jd, s] of LEAP_SECONDS) if (jdUtc >= jd) v = s;
  return v;
}

/** TT - UTC in seconds. */
export const ttMinusUtc = (jdUtc: number): number => taiMinusUtc(jdUtc) + TT_MINUS_TAI_SECONDS;

/** Julian date (UTC scale) from a proleptic Gregorian calendar date (Meeus, Astronomical Algorithms, ch. 7). */
export function jdFromCalendar(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  let y = year, m = month;
  if (m <= 2) { y -= 1; m += 12; }
  const A = Math.floor(y / 100);
  const B = 2 - A + Math.floor(A / 4);
  const dayFraction = (hour + (minute + second / 60) / 60) / 24;
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day + B - 1524.5 + dayFraction;
}

const ISO = /^(-?\d{4,6})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?Z?$/;

/** Parse an ISO 8601 UTC timestamp. Throws on anything else (no silent local-time interpretation). */
export function jdUtcFromIso(iso: string): number {
  const m = ISO.exec(iso.trim());
  if (!m) throw new Error(`Not an ISO 8601 UTC date: "${iso}"`);
  const [, y, mo, d, h, mi, s] = m;
  const month = Number(mo), day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) throw new Error(`Invalid calendar date: "${iso}"`);
  return jdFromCalendar(Number(y), month, day, Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0));
}

/** TDB-like Julian date for a UTC Julian date. */
export const jdTdbFromUtc = (jdUtc: number): number => jdUtc + ttMinusUtc(jdUtc) / SECONDS_PER_DAY;
export const jdUtcFromTdb = (jdTdb: number): number => {
  let jdUtc = jdTdb - 69.184 / SECONDS_PER_DAY;
  jdUtc = jdTdb - ttMinusUtc(jdUtc) / SECONDS_PER_DAY; // one refinement is enough: the correction varies only at leap seconds
  return jdUtc;
};

export const jdTdbFromIso = (iso: string): number => jdTdbFromUtc(jdUtcFromIso(iso));

/** Calendar fields (UTC) from a UTC Julian date (Meeus ch. 7). */
export function calendarFromJd(jd: number): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const z0 = jd + 0.5;
  const Z = Math.floor(z0);
  const F = z0 - Z;
  let A = Z;
  if (Z >= 2299161) { const alpha = Math.floor((Z - 1867216.25) / 36524.25); A = Z + 1 + alpha - Math.floor(alpha / 4); }
  const B = A + 1524;
  const C = Math.floor((B - 122.1) / 365.25);
  const D = Math.floor(365.25 * C);
  const E = Math.floor((B - D) / 30.6001);
  const day = B - D - Math.floor(30.6001 * E);
  const month = E < 14 ? E - 1 : E - 13;
  const year = month > 2 ? C - 4716 : C - 4715;
  const secs = Math.round(F * SECONDS_PER_DAY * 1000) / 1000;
  const hour = Math.floor(secs / 3600), minute = Math.floor((secs - hour * 3600) / 60);
  return { year, month, day, hour, minute, second: secs - hour * 3600 - minute * 60 };
}

export function isoFromJdUtc(jdUtc: number): string {
  const c = calendarFromJd(jdUtc);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(c.year, 4)}-${p(c.month)}-${p(c.day)}T${p(c.hour)}:${p(c.minute)}:${p(Math.floor(c.second))}Z`;
}

/** Julian centuries of TDB since J2000.0. */
export const centuriesSinceJ2000 = (jdTdb: number): number => (jdTdb - JD_J2000) / DAYS_PER_CENTURY;
export const daysSinceJ2000 = (jdTdb: number): number => jdTdb - JD_J2000;

/** Simulation speed presets, in simulated seconds per real second. */
export const SPEED_PRESETS: readonly number[] = [1, 60, 3600, 86400, 10 * 86400, 100 * 86400, 365.25 * 86400];

/**
 * The simulation clock. The Julian date is held as an integer day plus a fraction in [0, 1) so that adding many small
 * steps never loses precision the way repeatedly adding to a single large double (about 2.46e6) would.
 * `maxStepSeconds` bounds one real-time step, so a stalled tab cannot make the simulation jump.
 */
export class SimClock {
  private day: number;
  private frac: number;
  private readonly referenceDay: number;
  private readonly referenceFrac: number;
  paused = false;
  /** Index into SPEED_PRESETS. */
  speedIndex = 0;
  /** +1 forward, -1 backward. */
  direction: 1 | -1 = 1;

  constructor(readonly referenceJd: number, readonly maxStepSeconds = 0.25) {
    if (!Number.isFinite(referenceJd)) throw new Error('Reference Julian date must be finite');
    this.referenceDay = Math.floor(referenceJd);
    this.referenceFrac = referenceJd - this.referenceDay;
    this.day = this.referenceDay;
    this.frac = this.referenceFrac;
  }

  get jd(): number { return this.day + this.frac; }
  get speed(): number { return SPEED_PRESETS[this.speedIndex]!; }
  /** Simulated seconds per real second, signed. */
  get signedSpeed(): number { return this.paused ? 0 : this.direction * this.speed; }

  /** Advance by a real-time step (seconds). Returns the simulated days applied. */
  advance(realSeconds: number): number {
    if (this.paused || !(realSeconds > 0)) return 0;
    const dt = Math.min(realSeconds, this.maxStepSeconds);
    const dDays = (this.direction * this.speed * dt) / SECONDS_PER_DAY;
    this.shiftDays(dDays);
    return dDays;
  }

  shiftDays(dDays: number): void {
    this.frac += dDays;
    const carry = Math.floor(this.frac);
    this.day += carry;
    this.frac -= carry;
  }

  setJd(jd: number): void {
    this.day = Math.floor(jd);
    this.frac = jd - this.day;
  }

  faster(): void { this.speedIndex = Math.min(SPEED_PRESETS.length - 1, this.speedIndex + 1); }
  slower(): void { this.speedIndex = Math.max(0, this.speedIndex - 1); }
  reverse(): void { this.direction = this.direction === 1 ? -1 : 1; }
  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }
  toggle(): void { this.paused = !this.paused; }

  reset(): void {
    this.day = this.referenceDay;
    this.frac = this.referenceFrac;
    this.paused = false;
    this.speedIndex = 0;
    this.direction = 1;
  }
}
