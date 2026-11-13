/**
 * JPL Horizons (https://ssd.jpl.nasa.gov/api/horizons.api) client helpers and text parsers.
 * Horizons physical-data text is semi-structured, two columns of "label = value" per line, and labels differ by body
 * type. Extraction is therefore label-driven and tolerant: a quantity that cannot be found is returned as ABSENT
 * (undefined), never guessed.
 */
export const HORIZONS_API = 'https://ssd.jpl.nasa.gov/api/horizons.api';

const q = (v: string) => `'${v}'`;

function url(params: Record<string, string>): string {
  const parts = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%27/g, "'")}`);
  return `${HORIZONS_API}?${parts.join('&')}`;
}

export function objDataUrl(command: string): string {
  return url({ format: 'text', COMMAND: q(command), OBJ_DATA: q('YES'), MAKE_EPHEM: q('NO') });
}

/** Osculating elements in the ICRF equatorial frame, centred on `center` (for example "@599" for Jupiter). */
export function elementsUrl(command: string, center: string, startIso: string, stopIso: string): string {
  return url({
    format: 'text', COMMAND: q(command), CENTER: q(center), MAKE_EPHEM: q('YES'), TABLE_TYPE: q('ELEMENTS'),
    START_TIME: q(startIso), STOP_TIME: q(stopIso), STEP_SIZE: q('1 d'), REF_PLANE: q('FRAME'), REF_SYSTEM: q('ICRF'),
    OUT_UNITS: q('KM-S'), CSV_FORMAT: q('NO'),
  });
}

export function vectorsUrl(command: string, center: string, startIso: string, stopIso: string, step: string): string {
  return url({
    format: 'text', COMMAND: q(command), CENTER: q(center), MAKE_EPHEM: q('YES'), TABLE_TYPE: q('VECTORS'),
    START_TIME: q(startIso), STOP_TIME: q(stopIso), STEP_SIZE: q(step), REF_PLANE: q('FRAME'), REF_SYSTEM: q('ICRF'),
    OUT_UNITS: q('KM-S'), VEC_TABLE: q('2'), CSV_FORMAT: q('NO'),
  });
}

/** State vectors at an explicit list of Julian dates (TDB), ICRF equatorial axes. */
export function vectorsTlistUrl(command: string, center: string, jds: readonly number[]): string {
  return url({
    format: 'text', COMMAND: q(command), CENTER: q(center), MAKE_EPHEM: q('YES'), TABLE_TYPE: q('VECTORS'),
    TLIST: q(jds.map((j) => j.toFixed(6)).join(' ')), REF_PLANE: q('FRAME'), REF_SYSTEM: q('ICRF'),
    OUT_UNITS: q('KM-S'), VEC_TABLE: q('2'), CSV_FORMAT: q('NO'),
  });
}

/** Osculating elements (ICRF equatorial axes) at explicit Julian dates (TDB). Horizons returns the rows sorted by time. */
export function elementsTlistUrl(command: string, center: string, jd: number | readonly number[]): string {
  const list = (typeof jd === 'number' ? [jd] : jd).map((j) => j.toFixed(6)).join(' ');
  return url({
    format: 'text', COMMAND: q(command), CENTER: q(center), MAKE_EPHEM: q('YES'), TABLE_TYPE: q('ELEMENTS'),
    TLIST: q(list), REF_PLANE: q('FRAME'), REF_SYSTEM: q('ICRF'), OUT_UNITS: q('KM-S'), CSV_FORMAT: q('NO'),
  });
}

/** Osculating elements sampled at a regular step between two Julian dates (TDB). The step is in whole minutes. */
export function elementsRangeUrl(command: string, center: string, jdStart: number, jdStop: number, stepMinutes: number): string {
  return url({
    format: 'text', COMMAND: q(command), CENTER: q(center), MAKE_EPHEM: q('YES'), TABLE_TYPE: q('ELEMENTS'),
    START_TIME: q(`JD ${jdStart.toFixed(6)}`), STOP_TIME: q(`JD ${jdStop.toFixed(6)}`), STEP_SIZE: q(`${Math.max(1, Math.round(stepMinutes))} m`),
    REF_PLANE: q('FRAME'), REF_SYSTEM: q('ICRF'), OUT_UNITS: q('KM-S'), CSV_FORMAT: q('NO'),
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Value parsing

export interface ParsedValue {
  readonly value: number;
  readonly uncertainty?: number;
  /** The text began with "~": JPL marks the value as approximate. */
  readonly approximate: boolean;
}

const NUM = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`;
const VALUE_RE = new RegExp(String.raw`^\s*([~<>]?)\s*(${NUM})\s*(?:(?:\+-|\+/-|\u00b1)\s*(${NUM}))?\s*(?:\(\s*10\^(-?\d+)\s*\))?`);

/**
 * Parse "6371.01+-0.02", "1560.8 +- 0.3", "~1988410", ".0003" and "1.08 (10^-4)" (a decimal scale factor in parentheses).
 * Anything it does not understand yields undefined: a wrong number is worse than a missing one.
 */
export function parseValue(text: string): ParsedValue | undefined {
  const m = VALUE_RE.exec(text);
  if (!m) return undefined;
  const scale = m[4] !== undefined ? Number(m[4]) : 0;
  // Parse "<mantissa>e<exp>" as one decimal so 18.9819e26 is exact (no 18.9819 * 1e26 rounding noise).
  const dec = (mant: string) => Number(`${mant}e${scale}`);
  const value = dec(m[2]!);
  if (!Number.isFinite(value)) return undefined;
  const u = m[3] !== undefined ? dec(m[3]) : undefined;
  return { value, ...(u !== undefined && Number.isFinite(u) ? { uncertainty: Math.abs(u) } : {}), approximate: m[1] === '~' };
}

/** "13.1 x11.1 x9.3" triaxial radii in km, as given for small irregular moons. */
export function parseTriaxial(raw: string): readonly [number, number, number] | undefined {
  const m = /^\s*(\d+\.?\d*)\s*x\s*(\d+\.?\d*)\s*x\s*(\d+\.?\d*)/i.exec(raw);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

const LABEL_AHEAD = /\s{2,}(?=(?:[A-Z]|g_|[a-z]{1,2}\b\s*\()[^=]*=)/;
const INLINE_LABEL = /\s([A-Z][A-Za-z0-9 .,()\/^_*'%-]{2,45}?)\s*=(?!=)/;

/**
 * Split the object-data block into (label, raw value) pairs. Columns are separated by two or more spaces, and a new
 * label begins with an upper-case letter (so a lower-case unit such as "d" or "km" is never mistaken for a label).
 * Some Horizons lines join two pairs with a single space; those are split at the first upper-case word that is
 * followed by "=".
 */
export function labelPairs(block: string): { label: string; raw: string }[] {
  const pairs: { label: string; raw: string }[] = [];
  for (const line of block.split('\n')) {
    if (!line.includes('=')) continue;
    for (const seg of line.trim().split(LABEL_AHEAD)) {
      let rest = seg;
      for (let guard = 0; guard < 4 && rest.includes('='); guard++) {
        const i = rest.indexOf('=');
        if (i <= 0) break;
        const label = rest.slice(0, i).replace(/\s+/g, ' ').trim();
        const after = rest.slice(i + 1);
        const inline = INLINE_LABEL.exec(after);
        const raw = (inline ? after.slice(0, inline.index) : after).trim();
        if (label) pairs.push({ label, raw });
        if (!inline) break;
        rest = after.slice(inline.index + 1);
      }
    }
  }
  return pairs;
}

export interface HorizonsPhysical {
  readonly meanRadiusKm?: ParsedValue;
  readonly equatorialRadiusKm?: ParsedValue;
  /** True when the mean radius came from a plain "Radius (km)" label rather than "Vol. mean radius". */
  readonly radiusFromPlainLabel?: boolean;
  readonly polarRadiusKm?: ParsedValue;
  readonly massKg?: ParsedValue;
  readonly gmKm3S2?: ParsedValue;
  readonly densityGcm3?: ParsedValue;
  readonly geometricAlbedo?: ParsedValue;
  readonly equatorialGravityMs2?: ParsedValue;
  readonly escapeVelocityKmS?: ParsedValue;
  readonly obliquityDeg?: ParsedValue;
  readonly meanTemperatureK?: ParsedValue;
  readonly effectiveTemperatureK?: ParsedValue;
  readonly flattening?: ParsedValue;
  readonly luminosityW?: ParsedValue;
  /** Sidereal rotation period magnitude in hours, when numeric. */
  readonly rotationPeriodHours?: ParsedValue;
  /** Rotation rate in rad/s (signed), when given. */
  readonly rotationRateRadS?: ParsedValue;
  /** Triaxial radii in km (a, b, c) for small irregular bodies. */
  readonly triaxialRadiiKm?: readonly [number, number, number];
  /** Mass that Horizons prints directly (kg). When absent, mass is derived from GM. */
  /** Sign from "Sid. rot. rate": -1 retrograde, +1 prograde. */
  readonly rotationSense?: 1 | -1;
  readonly synchronousRotation?: boolean;
  readonly siderealOrbitPeriodDays?: ParsedValue;
  readonly vMagAt1Au?: ParsedValue;
  /** The label of the body line, e.g. "Earth" or "Europa / (Jupiter)". */
  readonly title?: string;
}

function firstNumber(raw: string): ParsedValue | undefined { return parseValue(raw); }

function find(pairs: readonly { label: string; raw: string }[], ...res: RegExp[]): { label: string; raw: string } | undefined {
  for (const re of res) {
    const p = pairs.find((x) => re.test(x.label));
    if (p) return p;
  }
  return undefined;
}

const SECONDS_PER_HOUR = 3600;

/** Parse a rotation-period field: "23.93 hr", "58.6463 d", "17.24+-0.01 h", "9h 55m 29.711 s", "Synchronous". */
export function parseRotationPeriod(raw: string): { hours?: ParsedValue; synchronous?: boolean } {
  const t = raw.trim();
  if (/^synchronous/i.test(t)) return { synchronous: true };
  const hms = /^(\d+)\s*h\s*(\d+)\s*m\s*([\d.]+)\s*s/i.exec(t);
  if (hms) return { hours: { value: Number(hms[1]) + Number(hms[2]) / 60 + Number(hms[3]) / SECONDS_PER_HOUR, approximate: false } };
  const v = parseValue(t);
  if (!v) return {};
  const unit = /^\s*[~<>]?\s*[-+.\d eE]+?(?:\+-|\+\/-|±)?\s*[-+.\d eE]*\s*(d|days?|hr|h|hours?)\b/i.exec(t)?.[1]?.toLowerCase();
  const rest = t.replace(/^\s*[~<>]?\s*[-+]?[\d.]+(?:[eE][-+]?\d+)?(?:\s*(?:\+-|\+\/-|±)\s*[-+]?[\d.]+)?/, '').trim().toLowerCase();
  const u = rest.startsWith('d') ? 'd' : rest.startsWith('h') ? 'h' : unit;
  if (u === 'd') return { hours: { ...v, value: Math.abs(v.value) * 24, ...(v.uncertainty !== undefined ? { uncertainty: v.uncertainty * 24 } : {}) } };
  if (u === 'h' || u === 'hr') return { hours: { ...v, value: Math.abs(v.value) } };
  return {};
}

/** Obliquity in degrees from "23.4392911", "3.13 deg" or "2.11' +/- 0.1'" (arcminutes). */
export function parseObliquity(raw: string): ParsedValue | undefined {
  const v = parseValue(raw);
  if (!v) return undefined;
  if (/^\s*[~<>]?\s*[-+]?[\d.]+\s*'/.test(raw)) {
    return { ...v, value: v.value / 60, ...(v.uncertainty !== undefined ? { uncertainty: v.uncertainty / 60 } : {}) };
  }
  return v;
}

/** Extract physical properties from the text of a Horizons OBJ_DATA response. */
export function parseObjData(text: string): HorizonsPhysical {
  const start = text.indexOf('*****');
  const end = text.lastIndexOf('*****');
  const block = start >= 0 && end > start ? text.slice(start, end) : text;
  const pairs = labelPairs(block);
  const out: { -readonly [K in keyof HorizonsPhysical]?: HorizonsPhysical[K] } = {};

  const titleLine = block.split('\n').find((l) => /Revised:/.test(l));
  if (titleLine) out.title = titleLine.replace(/^.*?Revised:\s*[A-Za-z]+\.?\s*\d{1,2},\s*\d{4}\s*/, '').replace(/\s{2,}\d+(\s*\/\s*\d+)?\s*$/, '').trim();

  const set = <K extends keyof HorizonsPhysical>(k: K, v: HorizonsPhysical[K] | undefined) => { if (v !== undefined && out[k] === undefined) out[k] = v; };

  set('meanRadiusKm', firstNumber(find(pairs, /^vol\.? mean radius/i, /^mean radius/i)?.raw ?? ''));
  const radiusPair = find(pairs, /^radius \(km\)/i);
  const tri = radiusPair ? parseTriaxial(radiusPair.raw) : undefined;
  if (tri) out.triaxialRadiiKm = tri;
  // Several satellites (Iapetus, Umbriel, Titania, Oberon) are listed as a plain "Radius (km) = 734.5 +- 4.0": JPL's mean radius.
  if (!out.meanRadiusKm && radiusPair && !tri) {
    const plain = parseValue(radiusPair.raw);
    if (plain) { out.meanRadiusKm = plain; out.radiusFromPlainLabel = true; }
  }
  const eq = find(pairs, /^equ(at)?\.? radius/i);
  set('equatorialRadiusKm', eq ? firstNumber(eq.raw) : undefined);
  const pol = find(pairs, /^polar (axis|radius)/i);
  set('polarRadiusKm', pol ? firstNumber(pol.raw) : undefined);

  const massPair = pairs.find((p) => /^mass\b.*(10\^\d+)/i.test(p.label));
  if (massPair) {
    const exp = Number(/10\^(\d+)/.exec(massPair.label)![1]);
    const v = parseValue(massPair.raw);
    // Re-parse with the label exponent applied as a decimal exponent, so 18.9819 with 10^26 is exactly 1.89819e27.
    const num = /^\s*[~<>]?\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/.exec(massPair.raw)?.[1];
    if (v && num) {
      const inner = massPair.raw.match(/\(\s*10\^(-?\d+)\s*\)/);
      const total = exp + (inner ? Number(inner[1]) : 0);
      const value = Number(`${num}e${total}`);
      const uNum = /(?:\+-|\+\/-|\u00b1)\s*([-+]?(?:\d+\.?\d*|\.\d+))/.exec(massPair.raw)?.[1];
      set('massKg', { value, ...(uNum ? { uncertainty: Math.abs(Number(`${uNum}e${exp}`)) } : {}), approximate: v.approximate });
    }
  }

  const gm = pairs.find((p) => /^GM\b(?!.*sigma)/i.test(p.label));
  set('gmKm3S2', gm ? firstNumber(gm.raw) : undefined);
  const gmSigma = pairs.find((p) => /^GM 1-sigma/i.test(p.label));
  if (out.gmKm3S2 && out.gmKm3S2.uncertainty === undefined && gmSigma) {
    const s = parseValue(gmSigma.raw.replace(/^[+-]+\s*/, ''));
    if (s) out.gmKm3S2 = { ...out.gmKm3S2, uncertainty: Math.abs(s.value) };
  }

  const dens = find(pairs, /^(mean )?dens(ity)?\b/i);
  set('densityGcm3', dens ? firstNumber(dens.raw) : undefined);
  const alb = find(pairs, /^geometric albedo/i);
  set('geometricAlbedo', alb ? firstNumber(alb.raw) : undefined);
  const grav = find(pairs, /^g_e\b/i, /^equ\.? grav/i, /^surface accel/i, /^surface gravity/i);
  set('equatorialGravityMs2', grav ? firstNumber(grav.raw) : undefined);
  const esc = find(pairs, /^escape (velocity|vel\.|speed)/i);
  set('escapeVelocityKmS', esc ? firstNumber(esc.raw) : undefined);
  const flat = find(pairs, /^flattening/i, /^flatness/i);
  if (flat) {
    const frac = /^\s*1\s*\/\s*(\d+\.?\d*)/.exec(flat.raw);
    set('flattening', frac ? { value: 1 / Number(frac[1]), approximate: false } : firstNumber(flat.raw));
  }
  const obl = find(pairs, /^obliquity to (orbit|ecliptic)/i);
  set('obliquityDeg', obl ? parseObliquity(obl.raw) : undefined);

  const ts = find(pairs, /^mean surface temp/i, /^mean temperature/i, /^atmos\.? temp/i);
  set('meanTemperatureK', ts ? firstNumber(ts.raw) : undefined);
  const teff = find(pairs, /^effective temp/i);
  set('effectiveTemperatureK', teff ? firstNumber(teff.raw) : undefined);

  const lum = pairs.find((p) => /^luminosity,\s*10\^(\d+)\s*J\/s/i.test(p.label));
  if (lum) {
    const exp = Number(/10\^(\d+)/.exec(lum.label)![1]);
    const num = /^\s*[~<>]?\s*([-+]?(?:\d+\.?\d*|\.\d+))/.exec(lum.raw)?.[1];
    if (num) set('luminosityW', { value: Number(`${num}e${exp}`), approximate: false });
  }

  const rot = find(pairs, /^sid(ereal|\.)? rot(\.|ation)? per/i, /^adopted sid\.? rot/i, /^mean sidereal day/i, /^rotational period/i);
  if (rot) {
    const r = parseRotationPeriod(rot.raw);
    if (r.hours) set('rotationPeriodHours', r.hours);
    if (r.synchronous) out.synchronousRotation = true;
  }
  // The mean sidereal day label is in hours with no unit text.
  if (out.rotationPeriodHours === undefined) {
    const sd = pairs.find((p) => /^mean sidereal day, hr/i.test(p.label));
    const v = sd ? parseValue(sd.raw) : undefined;
    if (v) out.rotationPeriodHours = v;
  }
  const rate = find(pairs, /^sid\.? rot\.?,? rate/i, /^rot\.? rate/i);
  if (rate) { const v = parseValue(rate.raw); if (v) { out.rotationSense = v.value < 0 ? -1 : 1; out.rotationRateRadS = v; } }

  const orbit = pairs.filter((p) => /^sidereal orb(it|\.)? ?per/i.test(p.label));
  for (const p of orbit) {
    // The unit is either in the value ("365.25636 d") or in the label ("Sidereal orb. per., d").
    if (/\bd\b/.test(p.raw) || /,\s*d$/i.test(p.label)) { set('siderealOrbitPeriodDays', firstNumber(p.raw)); break; }
  }
  const v10 = find(pairs, /^v\(1,0\)/i, /^vis\w*\.? mag\w*\.? v\(1,0\)/i, /^visual mag\.? v\(1,0\)/i);
  set('vMagAt1Au', v10 ? firstNumber(v10.raw) : undefined);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// ELEMENTS and VECTORS tables

export interface HorizonsElements {
  readonly jdTdb: number;
  /** km */
  readonly a: number;
  readonly e: number;
  readonly inclinationDeg: number;
  readonly nodeDeg: number;
  readonly argPeriDeg: number;
  readonly meanAnomalyDeg: number;
  /** seconds */
  readonly periodSeconds: number;
}

const SOE = '$$SOE';
const EOE = '$$EOE';

function section(text: string): string[] {
  const i = text.indexOf(SOE), j = text.indexOf(EOE);
  if (i < 0 || j < 0 || j < i) throw new Error('Horizons response has no $$SOE/$$EOE ephemeris block (the request probably failed)');
  return text.slice(i + SOE.length, j).split('\n').map((l) => l.trim()).filter(Boolean);
}

function tokens(lines: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of lines) {
    for (const m of line.matchAll(/([A-Za-z]+)\s*=\s*([-+]?[\d.]+(?:[eE][-+]?\d+)?)/g)) out[m[1]!] = Number(m[2]);
  }
  return out;
}

export function parseElements(text: string): HorizonsElements[] {
  const lines = section(text);
  const out: HorizonsElements[] = [];
  for (let i = 0; i < lines.length; i += 5) {
    const head = lines[i]!;
    const jd = Number(/^([\d.]+)\s*=/.exec(head)?.[1]);
    const t = tokens(lines.slice(i + 1, i + 5));
    const need = ['EC', 'IN', 'OM', 'W', 'MA', 'A', 'PR'] as const;
    for (const k of need) if (!Number.isFinite(t[k])) throw new Error(`Horizons ELEMENTS block is missing ${k}`);
    out.push({ jdTdb: jd, a: t['A']!, e: t['EC']!, inclinationDeg: t['IN']!, nodeDeg: t['OM']!, argPeriDeg: t['W']!, meanAnomalyDeg: t['MA']!, periodSeconds: t['PR']! });
  }
  return out;
}

export interface HorizonsVector {
  readonly jdTdb: number;
  /** km */
  readonly position: readonly [number, number, number];
  /** km/s */
  readonly velocity: readonly [number, number, number];
}

export function parseVectors(text: string): HorizonsVector[] {
  const lines = section(text);
  const out: HorizonsVector[] = [];
  for (let i = 0; i < lines.length; i += 3) {
    const jd = Number(/^([\d.]+)\s*=/.exec(lines[i]!)?.[1]);
    const t = tokens(lines.slice(i + 1, i + 3));
    for (const k of ['X', 'Y', 'Z', 'VX', 'VY', 'VZ']) if (!Number.isFinite(t[k])) throw new Error(`Horizons VECTORS block is missing ${k}`);
    out.push({ jdTdb: jd, position: [t['X']!, t['Y']!, t['Z']!], velocity: [t['VX']!, t['VY']!, t['VZ']!] });
  }
  return out;
}
