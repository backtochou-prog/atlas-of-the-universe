/**
 * Spectral-type parser for filters. Input is the spectral type string exactly as published (SIMBAD, Hipparcos, NASA Exoplanet Archive);
 * output is the set of classes it names, so a record can be filtered by class without inventing anything.
 *
 * Rules (each exercised by tests):
 *  - Main sequence / giants: O B A F G K M. Brown dwarfs: L T Y (must be followed by a digit or end of text, so "Sy2" or "SBb" are not read as a class).
 *  - W Wolf-Rayet (WN, WC, WO, WR), C carbon stars (C, C-N, CH, CN, CR, CJ, and the historical R and N types followed by a digit), S (S followed by a digit or end),
 *    D white dwarfs (DA, DB, DC, DO, DQ, DZ, DX, ...).
 *  - Lower-case qualifiers before the class are not classes: "sdB5" (subdwarf) is B, "kA2hA5mA7" (metallic-line) is A.
 *  - Alternatives and composites name every class they mention: "G8/K0III" is G and K, "K1V+K5V" is K, "M1-M2V" is M, "G8-K0" is G and K.
 *    A class that is merely possible is therefore matched by a filter for it. `uncertain` is true if the text has ':' or '?'.
 *  - Anything else (empty, galaxy morphology, garbage) is 'unknown': never guessed.
 */
export type SpectralClass = 'O' | 'B' | 'A' | 'F' | 'G' | 'K' | 'M' | 'L' | 'T' | 'Y' | 'W' | 'C' | 'S' | 'D' | 'unknown';

export const SPECTRAL_CLASSES: readonly SpectralClass[] = ['O', 'B', 'A', 'F', 'G', 'K', 'M', 'L', 'T', 'Y', 'W', 'C', 'S', 'D', 'unknown'];

export interface ParsedSpectralType {
  /** Distinct classes named, in order of appearance; ['unknown'] if none. */
  readonly classes: readonly SpectralClass[];
  readonly primary: SpectralClass;
  /** Numeric subtype of the primary class ("K1V" -> 1, "DA2.5" -> 2.5), when present. */
  readonly subtype?: number;
  /** Luminosity class of the first component as written ("V", "III", "Iab"). */
  readonly luminosity?: string;
  readonly flags: readonly ('subdwarf' | 'uncertain' | 'composite' | 'alternatives')[];
}

const UNKNOWN: ParsedSpectralType = { classes: ['unknown'], primary: 'unknown', flags: [] };
const RE_LUM = /^[ \-]?(Ia0|Ia\+|Iab|Ia|Ib|III|II|IV|VII|VI|V|I|0)/;

function classOf(part: string): { cls: SpectralClass; rest: string } | null {
  const c = part[0];
  if (c === undefined) return null;
  if ('OBAFGKM'.includes(c)) return { cls: c as SpectralClass, rest: part.slice(1) };
  if (c === 'L' || c === 'T' || c === 'Y') return /^[LTY](?:\d|$|\s|\.|:)/.test(part) ? { cls: c, rest: part.slice(1) } : null;
  if (c === 'S') return /^S(?:\d|$|\s|\/)/.test(part) ? { cls: 'S', rest: part.slice(1) } : null;
  if (c === 'D') { const m = /^D[ABCOQZXPHV]*/.exec(part); return m ? { cls: 'D', rest: part.slice(m[0].length) } : null; }
  if (c === 'W') return /^W(?:[NCOR]|\d)/.test(part) ? { cls: 'W', rest: part.slice(part[1] && /[NCOR]/.test(part[1]) ? 2 : 1) } : null;
  if (c === 'C') return /^C(?:-|\d|[NHRJ]|\s|$)/.test(part) ? { cls: 'C', rest: part.slice(1).replace(/^-?[NRJH]?/, '') } : null;
  if (c === 'R' || c === 'N') return /^[RN]\d/.test(part) ? { cls: 'C', rest: part.slice(1) } : null;
  return null;
}

export function parseSpectralType(raw: string | null | undefined): ParsedSpectralType {
  if (typeof raw !== 'string') return UNKNOWN;
  let s = raw.trim();
  if (s.length === 0 || s.length > 64) return UNKNOWN;
  const flags = new Set<ParsedSpectralType['flags'][number]>();
  if (/[:?]/.test(s)) flags.add('uncertain');
  s = s.replace(/[():?]/g, '');
  const subdwarf = /^(?:esd|usd|sd)(?=[A-Z])/.test(s);
  if (subdwarf) flags.add('subdwarf');
  // carbon-star "C-N5" must not be split at its hyphen
  s = s.replace(/\bC-([NRJH])/g, 'C$1');
  const parts = s.split(/[+/,;]|-(?=[A-Z])/).map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length > 1) flags.add(/\+/.test(s) ? 'composite' : 'alternatives');
  const classes: SpectralClass[] = [];
  let subtype: number | undefined;
  let luminosity: string | undefined;
  let first = true;
  for (const part of parts) {
    const stripped = part.replace(/^[a-z]+(?=[A-Z])/, '');
    const hit = classOf(stripped);
    if (!hit) continue;
    if (!classes.includes(hit.cls)) classes.push(hit.cls);
    if (first) {
      first = false;
      const num = /^(\d+(?:\.\d+)?)/.exec(hit.rest);
      if (num) subtype = Number(num[1]);
      const lum = RE_LUM.exec(num ? hit.rest.slice(num[0].length) : hit.rest);
      if (lum) luminosity = lum[1]!;
    }
  }
  if (classes.length === 0) return { ...UNKNOWN, flags: [...flags] };
  return { classes, primary: classes[0]!, ...(subtype !== undefined ? { subtype } : {}), ...(luminosity !== undefined ? { luminosity } : {}), flags: [...flags] };
}

/** Bit mask over SPECTRAL_CLASSES (bit i = class i). 'unknown' alone means no usable spectral type. */
export function spectralMask(classes: readonly SpectralClass[]): number {
  let m = 0;
  for (const c of classes) m |= 1 << SPECTRAL_CLASSES.indexOf(c);
  return m;
}
export const UNKNOWN_SPECTRAL_BIT = 1 << (SPECTRAL_CLASSES.length - 1);
