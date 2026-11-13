/**
 * Name and identifier normalisation (Prompt 07). Used by BOTH the search index (at build time, for every designation)
 * and the query path (for what the user types), so the two always agree.
 *
 * A raw name goes through one deterministic pipeline and comes out as a canonical key such as "m 31", "ngc 224",
 * "hip 32349", "gaia dr3 4472832130942575872", "alpha cma", "kepler 452b", "psr b0531+21", "sgr a*".
 * Two raw names are the SAME designation if and only if their keys are equal. The rules are listed in NORMALIZATION_RULES
 * (every row has examples that the test-suite executes), and the pairs in MUST_STAY_DISTINCT must never become equal.
 *
 * What this module deliberately does NOT do:
 *  - it never guesses a catalogue from a bare number ("224" stays "224"; the search layer finds it through the token index),
 *  - it never fuses different numbers ("m 3" and "m 31", "ngc 22" and "ngc 224", "hip 3" and "hip 32349" stay different),
 *  - it never treats Gaia DR2 and DR3 source ids as the same ("gaia dr2 N" is not "gaia dr3 N"),
 *  - it does not correct typos; that is the search index's fuzzy stage, which is visibly flagged there.
 */
import { CONSTELLATION_PHRASES } from './constellations';

/** Names longer than this are not normalised (the key is ''): bounds the cost of any single call. */
export const MAX_NAME_LENGTH = 200;
/** Queries longer than this are rejected by normalizeQuery. */
export const MAX_QUERY_LENGTH = 128;

// ---- character folding ----------------------------------------------------------------------------------------------------

const GREEK_CHAR: Readonly<Record<string, string>> = {
  α: 'alpha', β: 'beta', γ: 'gamma', δ: 'delta', ε: 'epsilon', ϵ: 'epsilon', ζ: 'zeta', η: 'eta', θ: 'theta', ϑ: 'theta', ι: 'iota', κ: 'kappa', ϰ: 'kappa',
  λ: 'lambda', μ: 'mu', ν: 'nu', ξ: 'xi', ο: 'omicron', π: 'pi', ϖ: 'pi', ρ: 'rho', ϱ: 'rho', σ: 'sigma', ς: 'sigma', τ: 'tau', υ: 'upsilon', φ: 'phi', ϕ: 'phi', χ: 'chi', ψ: 'psi', ω: 'omega',
};
const LATIN_SPECIAL: Readonly<Record<string, string>> = { ø: 'o', ł: 'l', đ: 'd', æ: 'ae', ß: 'ss', œ: 'oe', ı: 'i', þ: 'th', ð: 'd' };

/** Greek letter names (the canonical spelling of a Bayer letter). */
export const GREEK_NAMES: ReadonlySet<string> = new Set(Object.values(GREEK_CHAR));
/** SIMBAD / catalogue three-letter Bayer abbreviations that differ from the full name. Those equal to the name (eta, mu, nu, xi, pi, rho, tau, phi, chi, psi) need no entry. */
export const GREEK_ABBREVIATIONS: ReadonlyMap<string, string> = new Map([
  ['alf', 'alpha'], ['bet', 'beta'], ['gam', 'gamma'], ['del', 'delta'], ['eps', 'epsilon'], ['zet', 'zeta'], ['tet', 'theta'], ['iot', 'iota'],
  ['kap', 'kappa'], ['lam', 'lambda'], ['ksi', 'xi'], ['omi', 'omicron'], ['sig', 'sigma'], ['ups', 'upsilon'], ['ome', 'omega'],
]);

const ASCII_ONLY = /^[\x20-\x7e]*$/;
const SIMPLE = /^[a-z0-9 +\-*]*$/;
const NON_ASCII_GREEK = /([\u0370-\u03ff\u1f00-\u1fff])(\d{0,2})/g;

function fold(raw: string): string {
  let s = raw;
  if (!ASCII_ONLY.test(s)) {
    s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    s = s.replace(NON_ASCII_GREEK, (m, ch: string, digits: string) => (GREEK_CHAR[ch] ? ` ${GREEK_CHAR[ch]}${digits} ` : m));
    s = s.replace(/[øłđæßœıþð]/g, (c) => LATIN_SPECIAL[c] ?? c);
    s = s.replace(/[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g, '-');
  } else {
    s = s.toLowerCase();
  }
  if (!SIMPLE.test(s)) {
    // apostrophes disappear ("Barnard's Star" = "barnards star"); every other character outside the kept set is a separator.
    s = s.replace(/['\u2019`\u00b4]/g, '');
    s = s.replace(/[^a-z0-9+\-*. ]/g, ' ');
    // '.' only survives between digits (decimal part of a coordinate-style name); "mu. Cen" -> "mu  Cen".
    s = s.replace(/\.(?!\d)|(?<!\d)\./g, ' ');
  }
  if (s.indexOf('  ') >= 0 || s.charCodeAt(0) === 32 || s.charCodeAt(s.length - 1) === 32) s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// ---- catalogue prefix table ---------------------------------------------------------------------------------------------------

interface CatalogueRule {
  readonly canon: string;
  readonly aliases: readonly string[];
  /** Number part is a plain integer (optionally followed by letters): leading zeros are not significant. */
  readonly numeric: boolean;
}

/**
 * Catalogue prefixes whose spelling variants are the same catalogue. "gj/gl/gliese" share one number series (the Gliese-Jahreiss
 * extension continues the Gliese numbers), "hd/hde" likewise, so they are merged; "ngc" and "ic" are NOT merged.
 */
const CATALOGUES: readonly CatalogueRule[] = [
  { canon: 'm', aliases: ['m', 'messier'], numeric: true },
  { canon: 'ngc', aliases: ['ngc'], numeric: true },
  { canon: 'ic', aliases: ['ic'], numeric: true },
  { canon: 'hip', aliases: ['hip'], numeric: true },
  { canon: 'hd', aliases: ['hd', 'hde'], numeric: true },
  { canon: 'hr', aliases: ['hr'], numeric: true },
  { canon: 'sao', aliases: ['sao'], numeric: true },
  { canon: 'gj', aliases: ['gj', 'gl', 'gliese'], numeric: true },
  { canon: 'lhs', aliases: ['lhs'], numeric: true },
  { canon: 'ltt', aliases: ['ltt'], numeric: true },
  { canon: 'lp', aliases: ['lp'], numeric: false },
  { canon: 'tic', aliases: ['tic'], numeric: true },
  { canon: 'kic', aliases: ['kic'], numeric: true },
  { canon: 'koi', aliases: ['koi'], numeric: true },
  { canon: 'toi', aliases: ['toi'], numeric: true },
  { canon: 'ugc', aliases: ['ugc'], numeric: true },
  { canon: 'pgc', aliases: ['pgc'], numeric: true },
  { canon: 'eso', aliases: ['eso'], numeric: false },
  { canon: 'mrk', aliases: ['mrk', 'markarian'], numeric: true },
  { canon: 'mel', aliases: ['mel', 'melotte'], numeric: true },
  { canon: 'cr', aliases: ['cr', 'collinder'], numeric: true },
  { canon: 'ross', aliases: ['ross'], numeric: true },
  { canon: 'wolf', aliases: ['wolf'], numeric: true },
  { canon: 'tyc', aliases: ['tyc'], numeric: false },
  { canon: 'kepler', aliases: ['kepler'], numeric: true },
  { canon: 'k2', aliases: ['k2'], numeric: true },
  { canon: 'trappist', aliases: ['trappist'], numeric: true },
  { canon: 'wasp', aliases: ['wasp'], numeric: true },
  { canon: 'kelt', aliases: ['kelt'], numeric: true },
  { canon: 'xo', aliases: ['xo'], numeric: true },
  { canon: 'tres', aliases: ['tres'], numeric: true },
  { canon: 'qatar', aliases: ['qatar'], numeric: true },
  { canon: 'corot', aliases: ['corot'], numeric: true },
  { canon: 'hat', aliases: ['hat'], numeric: false },
  { canon: 'ogle', aliases: ['ogle'], numeric: false },
  { canon: 'gaia', aliases: ['gaia'], numeric: false },
];
const PREFIX_ALIAS = new Map<string, CatalogueRule>();
for (const c of CATALOGUES) for (const a of c.aliases) PREFIX_ALIAS.set(a, c);
/** First-token prefixes that may be glued to their number ("m31", "hip32349", "kepler452b"). */
const GLUE_PREFIXES: ReadonlySet<string> = new Set([...PREFIX_ALIAS.keys(), 'gaiadr3', 'sh']);

const stripZeros = (digits: string): string => digits.replace(/^0+(?=\d)/, '');

// ---- whole-string rules (first match wins) ------------------------------------------------------------------------------------

const RE_GAIA = /^gaia\s*(?:(dr[23]|edr3))?\s*(\d{1,20})$/;
const RE_BARE_GAIA = /^\d{16,19}$/;
const RE_PSR = /^psr\s*([bj])\s*(\d{4}[+-]\d{2,4}[a-z]?)$/;
const RE_ZONE = /^(bd|cd|cpd)\s*([+-])\s*(\d{1,2})(?:\s*(\d+[a-z]?))?$/;
const RE_2MASS = /^2mass\s*j?\s*([0-9+-]*)$/;
const RE_SHARPLESS = /^(?:sh|sharpless)\s*2[\s-]*(\d+[a-z]?)$/;
const RE_SGRA = /^(?:sgr|sagittarius)\s*a\s*(?:\*|star)$/;
const RE_STAR_PREFIX = /^(?:name|[a-z]{0,4}\*{1,2})\s+(?=\S)/;

function wholeStringRules(s: string): string | null {
  const c = s.charCodeAt(0);
  let m: RegExpExecArray | null;
  if (c >= 48 && c <= 57) {                                  // digit
    if (RE_BARE_GAIA.test(s)) return `gaia dr3 ${s}`;
    if (c === 50 && s.startsWith('2mass')) { m = RE_2MASS.exec(s); if (m) return m[1] ? `2mass j${m[1]}` : '2mass'; }
    return null;
  }
  switch (c) {
    case 103: // g
      m = RE_GAIA.exec(s);
      return m ? `gaia ${m[1] === 'dr2' ? 'dr2' : 'dr3'} ${m[2]}` : null;
    case 112: // p
      m = RE_PSR.exec(s);
      return m ? `psr ${m[1]}${m[2]}` : null;
    case 98: case 99: // b, c
      m = RE_ZONE.exec(s);
      return m ? `${m[1]}${m[2]}${m[3]!.padStart(2, '0')}${m[4] ? ` ${stripZeros(m[4])}` : ''}` : null;
    case 115: // s
      m = RE_SHARPLESS.exec(s);
      if (m) return `sh2 ${stripZeros(m[1]!)}`;
      return RE_SGRA.test(s) ? 'sgr a*' : null;
    default:
      return null;
  }
}

// ---- token pipeline ------------------------------------------------------------------------------------------------------------

const RE_GLUE = /^([a-z]+)(\d.*)$/;
const RE_COORD_HYPHEN = /^[a-z]\d{3,}(?:\.\d+)?-\d/;
const RE_NUMERIC_PARTS = /^\d+(?:\.\d+)?$/;
const RE_COORD_PLUS = /^[a-z]*\d[\d.]*\+\d[\d.]*[a-z]?$/;

function splitToken(t: string): string[] {
  if (t.indexOf('-') >= 0) {
    const parts = t.split('-');
    const nonEmpty = parts.filter((p) => p.length > 0);
    if (nonEmpty.length === 0) return [];
    if (nonEmpty.every((p) => RE_NUMERIC_PARTS.test(p))) return [nonEmpty.join('-')];   // "592-4", "55-745-1": hyphen is structure
    if (RE_COORD_HYPHEN.test(t)) return [t];                                            // "j0306-0157": declination sign
    return nonEmpty.flatMap((p) => splitToken(p));
  }
  if (t.indexOf('+') >= 0 && !RE_COORD_PLUS.test(t)) return t.split('+').filter((p) => p.length > 0);
  return [t];
}

interface ConstellationMatch { readonly abbr: string; readonly words: number }
function matchConstellation(tokens: readonly string[], at: number): ConstellationMatch | null {
  const a = tokens[at];
  if (a === undefined) return null;
  const b = tokens[at + 1];
  if (b !== undefined) {
    const two = CONSTELLATION_PHRASES.get(`${a} ${b}`);
    if (two) return { abbr: two, words: 2 };
  }
  const one = CONSTELLATION_PHRASES.get(a);
  return one ? { abbr: one, words: 1 } : null;
}

const RE_BAYER_TOKEN = /^([a-z]+?)(\d{1,2})?$/;
const RE_VARIABLE_LETTERS = /^(?:v\d{3,4}|[a-z]{1,2})$/;

/** Bayer ("alf CMa", "alpha Canis Majoris"), Flamsteed ("61 Cygni") and variable-star ("RR Lyrae") designations -> letters + 3-letter constellation abbreviation. */
function constellationDesignation(tokens: string[], queryMode: boolean): string[] {
  const t0 = tokens[0];
  if (t0 === undefined || tokens.length < 2) return tokens;
  const m = RE_BAYER_TOKEN.exec(t0);
  if (m) {
    const name = m[1]!;
    const full = GREEK_NAMES.has(name) ? name : GREEK_ABBREVIATIONS.get(name);
    if (full) {
      let digits = m[2];
      let at = 1;
      if (digits === undefined && /^\d{1,2}$/.test(tokens[1]!) && matchConstellation(tokens, 2)) { digits = tokens[1]!; at = 2; }
      const c = matchConstellation(tokens, at);
      const letter = full + (digits !== undefined ? stripZeros(digits) : '');
      if (c) return [letter, c.abbr, ...tokens.slice(at + c.words)];
      // While typing ("alf cm") the constellation is incomplete: still canonicalise an unambiguous 3-letter abbreviation.
      if (queryMode && GREEK_ABBREVIATIONS.has(name)) return [letter, ...tokens.slice(at)];
      return tokens;
    }
  }
  if (/^\d{1,3}$/.test(t0)) {
    const c = matchConstellation(tokens, 1);
    if (c) return [stripZeros(t0), c.abbr, ...tokens.slice(1 + c.words)];
    return tokens;
  }
  if (RE_VARIABLE_LETTERS.test(t0) && !PREFIX_ALIAS.has(t0)) {
    const c = matchConstellation(tokens, 1);
    if (c) return [t0, c.abbr, ...tokens.slice(1 + c.words)];
  }
  return tokens;
}

function generalPipeline(s: string, queryMode: boolean): string {
  let tokens = s.split(' ');
  // glue: "m31" -> "m 31", "kepler452b" -> "kepler 452b"
  const g = RE_GLUE.exec(tokens[0]!);
  if (g && GLUE_PREFIXES.has(g[1]!)) tokens = [g[1] === 'gaiadr3' ? 'gaia' : g[1]!, g[2]!, ...tokens.slice(1)];
  if (tokens.some((t) => t.indexOf('-') >= 0 || t.indexOf('+') >= 0)) tokens = tokens.flatMap(splitToken);
  if (tokens.length === 0) return '';

  const rule = PREFIX_ALIAS.get(tokens[0]!);
  if (rule) {
    tokens[0] = rule.canon;
    if (rule.canon === 'tyc') {
      const parts = tokens.slice(1).join('-').replace(/-+/g, '-');
      if (/^\d+(?:-\d+){0,2}[a-z]?$/.test(parts)) return `tyc ${parts.split('-').map(stripZeros).join('-')}`;
    } else if (rule.numeric && tokens[1] !== undefined && /^\d/.test(tokens[1])) {
      tokens[1] = stripZeros(tokens[1]);
    }
  } else {
    tokens = constellationDesignation(tokens, queryMode);
  }

  // component / planet letter: "kepler 452 b" -> "kepler 452b", "ngc 224 a" -> "ngc 224a"
  const n = tokens.length;
  if (n >= 2 && /^[a-z]$/.test(tokens[n - 1]!) && /\d$/.test(tokens[n - 2]!) && rule) {
    tokens.splice(n - 2, 2, tokens[n - 2]! + tokens[n - 1]!);
  }
  return tokens.join(' ');
}

// ---- fast path (the bulk of catalogue designations are already canonical apart from case) -----------------------------------------

const FAST_NUMERIC_PREFIX: ReadonlySet<string> = new Set(CATALOGUES.filter((c) => c.numeric && c.aliases.includes(c.canon) && c.canon !== 'k2' && c.canon !== 'kepler' && c.canon !== 'trappist' && c.canon !== 'wasp').map((c) => c.canon));

const isDigit = (c: number): boolean => c >= 48 && c <= 57;

/**
 * Same result as the full pipeline for the shapes "<numeric catalogue> <n>[a-z]", "gaia dr3 <n>" and "2mass j<...>"
 * that are already canonical after lower-casing; null for everything else (the full pipeline then runs). Equality with the
 * full pipeline (key AND tokens) is asserted by the tests on random designations.
 */
function fastNormalize(raw: string): NormalizedName | null {
  const sp = raw.indexOf(' ');
  if (sp <= 0 || sp > 8) return null;
  const lower = raw.toLowerCase();
  const n = lower.length;
  const first = lower.charCodeAt(sp + 1);
  if (lower.startsWith('gaia dr3 ')) {
    if (n < 10) return null;
    for (let i = 9; i < n; i++) if (!isDigit(lower.charCodeAt(i))) return null;
    return { key: lower, tokens: ['gaia', 'dr3', lower.slice(9)] };
  }
  if (lower.startsWith('2mass j')) {
    if (n < 9) return null;
    let sign = -1;
    for (let i = 7; i < n; i++) { const c = lower.charCodeAt(i); if (c === 43 || c === 45) { if (sign >= 0 || i === 7) return null; sign = i; } else if (!isDigit(c)) return null; }
    const j = lower.slice(6);
    const tokens = ['2mass', j];
    if (sign > 0) { tokens.push(lower.slice(6, sign), lower.slice(sign + 1)); }
    return sign === n - 1 ? null : { key: lower, tokens };
  }
  if (first < 49 || first > 57) return null;
  const prefix = lower.slice(0, sp);
  if (!FAST_NUMERIC_PREFIX.has(prefix)) return null;
  let i = sp + 2;
  while (i < n && isDigit(lower.charCodeAt(i))) i++;
  if (i === n) return { key: lower, tokens: [prefix, lower.slice(sp + 1)] };
  if (i === n - 1) { const c = lower.charCodeAt(i); if (c >= 97 && c <= 122) return { key: lower, tokens: [prefix, lower.slice(sp + 1)] }; }
  return null;
}

// ---- public API -------------------------------------------------------------------------------------------------------------------

export interface NormalizedName {
  /** Canonical key; '' when the input has no usable content or is longer than MAX_NAME_LENGTH. */
  readonly key: string;
  readonly tokens: readonly string[];
}

const EMPTY: NormalizedName = { key: '', tokens: [] };

/** Canonical key and search tokens of a raw name or identifier. `queryMode` additionally canonicalises half-typed Bayer abbreviations. */
export function normalizeName(raw: string, opts: { readonly queryMode?: boolean } = {}): NormalizedName {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_NAME_LENGTH) return EMPTY;
  const fast = fastNormalize(raw);
  if (fast !== null) return fast;
  let s = fold(raw);
  if (s.length === 0) return EMPTY;
  // SIMBAD type prefixes ("* alf CMa", "V* RR Lyr", "NAME Sirius") are not part of the designation.
  for (let i = 0; i < 2 && (s.indexOf('*') >= 0 || s.startsWith('name ')); i++) {
    const p = RE_STAR_PREFIX.exec(s);
    if (!p) break;
    s = s.slice(p[0].length);
  }
  let key = wholeStringRules(s);
  if (key === null) key = generalPipeline(s, opts.queryMode === true);
  key = key.replace(/ +/g, ' ').trim();
  if (!/[a-z0-9]/.test(key)) return EMPTY;
  return { key, tokens: tokenize(key) };
}

/** Canonical key only. */
export const canonicalKey = (raw: string): string => normalizeName(raw).key;

/** Two raw names denote the same designation iff their canonical keys are equal and non-empty. */
export function sameDesignation(a: string, b: string): boolean {
  const ka = canonicalKey(a);
  return ka.length > 0 && ka === canonicalKey(b);
}

/**
 * Search tokens of a canonical key: whitespace-separated words, plus the parts of hyphenated or signed tokens
 * ("592-4" -> "592-4", "592", "4"; "bd+01" -> "bd+01", "bd", "01"). '*' separates tokens. Unique, order preserved.
 */
export function tokenize(key: string): string[] {
  const hasSign = key.indexOf('-') >= 0 || key.indexOf('+') >= 0;
  const hasStar = key.indexOf('*') >= 0;
  const words = hasStar ? key.split(/[ *]+/) : key.split(' ');
  if (!hasSign) {
    for (let i = 1; i < words.length; i++) for (let j = 0; j < i; j++) if (words[i] === words[j]) return [...new Set(words.filter((w) => w.length > 0))];
    return hasStar ? words.filter((w) => w.length > 0) : words;
  }
  const out: string[] = [];
  const push = (t: string): void => { if (t.length > 0 && !out.includes(t)) out.push(t); };
  for (const w of words) {
    push(w);
    let from = 0;
    for (let i = 0; i <= w.length; i++) {
      const c = i < w.length ? w.charCodeAt(i) : 45;
      if (c === 45 || c === 43) { if (from > 0 || i < w.length) { if (i > from) push(w.slice(from, i)); } from = i + 1; }
    }
  }
  return out;
}

/**
 * "Andromeda Galaxy (M31)" -> ["Andromeda Galaxy", "M31"]. The outer text first, then each parenthesised part, raw spelling kept.
 * A name without brackets returns itself.
 */
export function splitParenthetical(raw: string): string[] {
  if (raw.indexOf('(') < 0) return [raw];
  const inner: string[] = [];
  const outer = raw.replace(/\(([^()]*)\)/g, (_m, g: string) => { if (g.trim().length > 0) inner.push(g.trim()); return ' '; }).replace(/\s+/g, ' ').trim();
  return outer.length > 0 ? [outer, ...inner] : inner.length > 0 ? inner : [raw];
}

const RE_BAYER_KEY = /^(?:[a-z]+\d{0,2}) [a-z]{3}(?: [a-z])?$/;
/** Proper-name test on an already canonical key (see isProperName). */
export function isProperKey(key: string): boolean {
  if (key.length === 0 || /\d/.test(key)) return false;
  if (key.indexOf(' ') > 0 && RE_BAYER_KEY.test(key)) {
    const t = key.split(' ');
    if (CONSTELLATION_PHRASES.has(t[1]!) && (GREEK_NAMES.has(t[0]!) || /^[a-z]{1,2}$/.test(t[0]!))) return false;
  }
  return true;
}
/**
 * Is this text a proper name ("Sirius", "Crab Nebula") rather than a catalogue identifier ("HIP 32349", "alf CMa", "Kepler-452b")?
 * Used only by the search prior ("named before unnamed"). A name with digits is an identifier, as is a Bayer / variable-star form.
 */
export function isProperName(raw: string): boolean {
  return isProperKey(canonicalKey(splitParenthetical(raw)[0] ?? raw));
}

export interface NormalizedQuery {
  readonly key: string;
  readonly tokens: readonly string[];
  /** Further keys to try as PREFIXES (e.g. a bare 8+ digit string may be the start of a Gaia id). */
  readonly alternatives: readonly string[];
}

/** Normalise what the user typed. Returns null for input the search must ignore: empty, too short, too long, or no letter/digit. */
export function normalizeQuery(raw: string): NormalizedQuery | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_QUERY_LENGTH) return null;
  const n = normalizeName(raw, { queryMode: true });
  if (n.key.length < 2) return null;
  const alternatives: string[] = [];
  if (/^\d{8,15}$/.test(n.key)) alternatives.push(`gaia dr3 ${n.key}`);
  return { key: n.key, tokens: n.tokens, alternatives };
}

// ---- documented rules (executed by the tests) -----------------------------------------------------------------------------------

export interface NormalizationRule {
  readonly id: string;
  readonly summary: string;
  /** [raw input, expected canonical key]; every example is asserted by the tests. */
  readonly examples: readonly (readonly [string, string])[];
}

export const NORMALIZATION_RULES: readonly NormalizationRule[] = [
  { id: 'case-space', summary: 'Case folded; runs of white space, underscores and other separators become one space; leading/trailing space dropped.', examples: [['  Sirius  ', 'sirius'], ['CRAB_nebula', 'crab nebula'], ['Orion\tNebula', 'orion nebula']] },
  { id: 'diacritics', summary: 'Diacritics removed (NFKD), ligatures and special letters transliterated; apostrophes dropped.', examples: [['Bootes', 'bootes'], ['Boötes', 'bootes'], ['Barnard’s Star', 'barnards star'], ['Æsir', 'aesir']] },
  { id: 'punctuation', summary: 'Punctuation other than + - * and decimal points is a separator; a trailing "." (as in "mu. Cen") disappears.', examples: [['Crab Nebula (M 1)', 'crab nebula m 1'], ['mu. Cen', 'mu cen']] },
  { id: 'simbad-prefix', summary: 'SIMBAD type prefixes ("* ", "** ", "V* ", "NAME ") are not part of the designation.', examples: [['* alf CMa', 'alpha cma'], ['V* RR Lyr', 'rr lyr'], ['NAME Sirius', 'sirius'], ['** WDS J12345+1234A', 'wds j12345+1234a']] },
  { id: 'messier', summary: 'M / Messier + number, glued or spaced, leading zeros dropped.', examples: [['M31', 'm 31'], ['M 31', 'm 31'], ['Messier 31', 'm 31'], ['messier031', 'm 31'], ['M-31', 'm 31']] },
  { id: 'ngc-ic', summary: 'NGC and IC are separate series; number glued or spaced, leading zeros dropped, trailing component letter joined.', examples: [['NGC 224', 'ngc 224'], ['NGC224', 'ngc 224'], ['ngc 0224', 'ngc 224'], ['NGC 224 A', 'ngc 224a'], ['IC 1396', 'ic 1396']] },
  { id: 'hip-hd', summary: 'HIP, HD (HDE is the same numbering), HR, SAO, TIC and similar numeric catalogues: glued or spaced, leading zeros dropped.', examples: [['HIP32349', 'hip 32349'], ['HIP 032349', 'hip 32349'], ['HD 48915', 'hd 48915'], ['HDE 48915', 'hd 48915'], ['HD48915', 'hd 48915'], ['HIP 32349 A', 'hip 32349a']] },
  { id: 'gliese', summary: 'Gl, GJ and Gliese share one number series and canonicalise to "gj".', examples: [['Gl 551', 'gj 551'], ['GJ551', 'gj 551'], ['Gliese 551', 'gj 551']] },
  { id: 'gaia', summary: 'Gaia DR3 / EDR3 source id, with or without the release, glued or spaced; a bare 16-19 digit number is a Gaia DR3 id. DR2 ids are a different series and stay different.', examples: [['Gaia DR3 4472832130942575872', 'gaia dr3 4472832130942575872'], ['gaia 4472832130942575872', 'gaia dr3 4472832130942575872'], ['4472832130942575872', 'gaia dr3 4472832130942575872'], ['GaiaDR3 4472832130942575872', 'gaia dr3 4472832130942575872'], ['Gaia EDR3 4472832130942575872', 'gaia dr3 4472832130942575872'], ['Gaia DR2 4472832130942575872', 'gaia dr2 4472832130942575872']] },
  { id: 'exoplanet-names', summary: 'Hyphens between a name and its number are separators; a single trailing lower-case letter (planet / component) joins the number.', examples: [['TRAPPIST-1', 'trappist 1'], ['TRAPPIST 1', 'trappist 1'], ['TRAPPIST-1e', 'trappist 1e'], ['Kepler-452b', 'kepler 452b'], ['Kepler-452 b', 'kepler 452b'], ['Kepler 452 b', 'kepler 452b'], ['kepler452b', 'kepler 452b'], ['K2-18 b', 'k2 18b'], ['HAT-P-7 b', 'hat p 7b'], ['WASP-12b', 'wasp 12b'], ['GJ 1214 b', 'gj 1214b'], ['HD 209458 b', 'hd 209458b']] },
  { id: 'bayer', summary: 'Bayer letters: Greek characters, full names and three-letter SIMBAD abbreviations all become the full name; the constellation (abbreviation, nominative or genitive) becomes the IAU three-letter abbreviation; a fused or separated index ("alf01", "α1") becomes "alpha1".', examples: [['α CMa', 'alpha cma'], ['alpha CMa', 'alpha cma'], ['alf CMa', 'alpha cma'], ['alpha Canis Majoris', 'alpha cma'], ['α Canis Majoris', 'alpha cma'], ['* bet Ori', 'beta ori'], ['ε Eri', 'epsilon eri'], ['alf01 Cap', 'alpha1 cap'], ['α¹ Cap', 'alpha1 cap'], ['tau Ceti', 'tau cet'], ['alpha Centauri', 'alpha cen'], ['ups And', 'upsilon and']] },
  { id: 'flamsteed-variable', summary: 'Flamsteed numbers and variable-star letters followed by a constellation use the abbreviation.', examples: [['61 Cygni', '61 cyg'], ['61 Cyg A', '61 cyg a'], ['55 Cancri e', '55 cnc e'], ['RR Lyrae', 'rr lyr'], ['V1500 Cygni', 'v1500 cyg']] },
  { id: 'pulsar', summary: 'PSR B/J designations: the sign and digits are one token.', examples: [['PSR B0531+21', 'psr b0531+21'], ['psrb0531+21', 'psr b0531+21'], ['PSR B 0531+21', 'psr b0531+21'], ['PSR J0534+2200', 'psr j0534+2200']] },
  { id: 'zone-catalogues', summary: 'BD, CD and CPD zone names keep the declination sign and a two-digit zone.', examples: [['BD+01 543', 'bd+01 543'], ['BD +1 543', 'bd+01 543'], ['CPD-55 1116', 'cpd-55 1116'], ['CD -47 672', 'cd-47 672']] },
  { id: 'tycho', summary: 'TYC region-number-component joined by hyphens, leading zeros dropped.', examples: [['TYC 55-745-1', 'tyc 55-745-1'], ['TYC 0055-0745-1', 'tyc 55-745-1'], ['TYC 55 745 1', 'tyc 55-745-1']] },
  { id: '2mass', summary: '2MASS J designations with or without the J and the space.', examples: [['2MASS J03062676+0157538', '2mass j03062676+0157538'], ['2MASS 03062676+0157538', '2mass j03062676+0157538'], ['2MASSJ03062676+0157538', '2mass j03062676+0157538']] },
  { id: 'sharpless', summary: 'Sharpless 2 catalogue.', examples: [['Sh 2-103', 'sh2 103'], ['Sharpless 2-103', 'sh2 103'], ['Sh2 103', 'sh2 103']] },
  { id: 'cluster-catalogues', summary: 'Melotte / Collinder / Markarian long and short forms.', examples: [['Melotte 22', 'mel 22'], ['Mel 22', 'mel 22'], ['Collinder 50', 'cr 50'], ['Markarian 421', 'mrk 421']] },
  { id: 'galactic-centre', summary: 'Sagittarius A* and Sgr A*.', examples: [['Sgr A*', 'sgr a*'], ['Sagittarius A*', 'sgr a*'], ['sgr a *', 'sgr a*'], ['NAME Sgr A*', 'sgr a*']] },
  { id: 'hyphenated-numbers', summary: 'A hyphen between two pure numbers is structure and is kept ("LP 592-4").', examples: [['LP 592-4', 'lp 592-4'], ['G 74-8', 'g 74-8']] },
];

/** Pairs that differ by a number (or release) and must NEVER be conflated by normalisation. */
export const MUST_STAY_DISTINCT: readonly (readonly [string, string])[] = [
  ['M3', 'M31'], ['M 1', 'M 10'], ['NGC 22', 'NGC 224'], ['NGC 224', 'IC 224'], ['HIP 3', 'HIP 32349'], ['HD 1', 'HD 10'],
  ['Gaia DR2 4472832130942575872', 'Gaia DR3 4472832130942575872'], ['4472832130942575872', '4472832130942575873'],
  ['Kepler-452b', 'Kepler-452c'], ['Kepler-45b', 'Kepler-452b'], ['TRAPPIST-1', 'TRAPPIST-2'], ['alpha CMa', 'alpha CMi'], ['alpha CMa', 'beta CMa'],
  ['alpha1 Cap', 'alpha2 Cap'], ['Sgr A*', 'Sgr A'], ['PSR B0531+21', 'PSR B0531+22'], ['BD+01 543', 'BD-01 543'], ['NGC 224', 'NGC 224A'],
];
