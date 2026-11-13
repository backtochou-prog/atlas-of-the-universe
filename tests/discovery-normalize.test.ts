import { describe, expect, it } from 'vitest';
import { CONSTELLATIONS, CONSTELLATION_PHRASES } from '../src/discovery/constellations';
import {
  MAX_NAME_LENGTH, MAX_QUERY_LENGTH, MUST_STAY_DISTINCT, NORMALIZATION_RULES, canonicalKey, isProperName, normalizeName, normalizeQuery, sameDesignation, splitParenthetical, tokenize,
} from '../src/discovery/normalize';
import { mulberry32, syntheticRecords } from './fixtures/discovery/synthetic';

describe('normalisation rule table (every documented example is executed)', () => {
  for (const rule of NORMALIZATION_RULES) {
    it(`rule ${rule.id}: ${rule.examples.length} examples`, () => {
      expect(rule.examples.length).toBeGreaterThan(0);
      for (const [raw, expected] of rule.examples) expect(canonicalKey(raw), `${rule.id}: ${JSON.stringify(raw)}`).toBe(expected);
    });
  }
  it('every rule has a summary and a unique id', () => {
    const ids = NORMALIZATION_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of NORMALIZATION_RULES) expect(r.summary.length).toBeGreaterThan(20);
  });
  it('canonical keys are fixed points (normalising a key changes nothing)', () => {
    for (const rule of NORMALIZATION_RULES) for (const [, key] of rule.examples) expect(canonicalKey(key), key).toBe(key);
  });
});

describe('equivalences required by the brief', () => {
  const groups: string[][] = [
    ['M31', 'M 31', 'Messier 31', 'm31', 'MESSIER 031', 'M-31'],
    ['NGC 224', 'NGC224', 'ngc 224', 'NGC 0224', 'NGC-224'],
    ['HIP32349', 'HIP 32349', 'hip 32349', 'HIP 032349', 'hip32349'],
    ['Gaia DR3 4472832130942575872', 'gaia 4472832130942575872', '4472832130942575872', 'GAIA DR3 4472832130942575872', 'Gaia EDR3 4472832130942575872', 'gaiadr3 4472832130942575872'],
    ['TRAPPIST 1', 'TRAPPIST-1', 'trappist-1', 'Trappist1'],
    ['Kepler-452b', 'Kepler-452 b', 'kepler 452 b', 'KEPLER452B', 'Kepler 452b'],
    ['Sgr A*', 'Sagittarius A*', 'sgr a *', 'SGR A*', 'NAME Sgr A*'],
    ['PSR B0531+21', 'psr b0531+21', 'PSRB0531+21', 'PSR B 0531+21'],
    ['α CMa', 'alpha CMa', 'alf CMa', 'alpha Canis Majoris', '* alf CMa', 'Alpha CMA', 'α Canis Majoris'],
    ['61 Cygni', '61 Cyg', '61 CYGNI'],
    ['Gl 551', 'GJ 551', 'Gliese 551', 'GJ551'],
  ];
  for (const g of groups) {
    it(`all spellings of ${g[0]} give one key`, () => {
      const keys = new Set(g.map(canonicalKey));
      expect([...keys], g.join(' | ')).toHaveLength(1);
      expect(sameDesignation(g[0]!, g[g.length - 1]!)).toBe(true);
    });
  }
  it('Greek letters in every form', () => {
    const forms: [string, string][] = [['β', 'beta'], ['γ', 'gamma'], ['δ', 'delta'], ['ε', 'epsilon'], ['ζ', 'zeta'], ['η', 'eta'], ['θ', 'theta'], ['ι', 'iota'], ['κ', 'kappa'], ['λ', 'lambda'], ['μ', 'mu'], ['ν', 'nu'], ['ξ', 'xi'], ['π', 'pi'], ['ρ', 'rho'], ['σ', 'sigma'], ['ς', 'sigma'], ['τ', 'tau'], ['υ', 'upsilon'], ['φ', 'phi'], ['χ', 'chi'], ['ψ', 'psi'], ['ω', 'omega']];
    for (const [ch, name] of forms) expect(canonicalKey(`${ch} Ori`), ch).toBe(`${name} ori`);
    for (const [abbr, name] of [['alf', 'alpha'], ['bet', 'beta'], ['gam', 'gamma'], ['del', 'delta'], ['eps', 'epsilon'], ['zet', 'zeta'], ['tet', 'theta'], ['iot', 'iota'], ['kap', 'kappa'], ['lam', 'lambda'], ['sig', 'sigma'], ['ups', 'upsilon'], ['ome', 'omega'], ['omi', 'omicron']]) {
      expect(canonicalKey(`${abbr} Cen`), abbr).toBe(`${name} cen`);
    }
    expect(canonicalKey('ά Cen')).toBe('alpha cen');          // accented Greek
  });
  it('a Greek word that is also a name stays a name when no constellation follows', () => {
    expect(canonicalKey('Tau')).toBe('tau');
    expect(canonicalKey('Delta')).toBe('delta');
    expect(canonicalKey('alf')).toBe('alf');                  // half-typed abbreviation is not rewritten outside query mode
  });
  it('half-typed Bayer abbreviations are canonicalised in query mode so the prefix still matches', () => {
    expect(normalizeName('alf cm', { queryMode: true }).key).toBe('alpha cm');
    expect('alpha cma'.startsWith(normalizeName('alf cm', { queryMode: true }).key)).toBe(true);
  });
});

describe('things that must NOT be conflated', () => {
  for (const [a, b] of MUST_STAY_DISTINCT) {
    it(`${a}  !=  ${b}`, () => {
      expect(canonicalKey(a)).not.toBe(canonicalKey(b));
      expect(sameDesignation(a, b)).toBe(false);
    });
  }
  it('a bare number is not given a catalogue', () => {
    expect(canonicalKey('224')).toBe('224');
    expect(canonicalKey('32349')).toBe('32349');
    expect(canonicalKey('1234567')).toBe('1234567');           // fewer than 16 digits: not a Gaia id
  });
  it('different catalogues with the same number stay different', () => {
    const keys = ['NGC 1', 'IC 1', 'HD 1', 'HIP 1', 'M 1', 'HR 1', 'TIC 1', 'GJ 1'].map(canonicalKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('leading zeros are insignificant but the number itself is not changed', () => {
    expect(canonicalKey('NGC 0001')).toBe('ngc 1');
    expect(canonicalKey('NGC 10')).toBe('ngc 10');
    expect(canonicalKey('NGC 100')).toBe('ngc 100');
    expect(canonicalKey('NGC 0')).toBe('ngc 0');
  });
  it('component letters are kept apart from the system', () => {
    expect(canonicalKey('HD 10700 A')).not.toBe(canonicalKey('HD 10700'));
    expect(canonicalKey('HD 10700 A')).not.toBe(canonicalKey('HD 10700 B'));
  });
});

describe('robust input handling', () => {
  it('empty, whitespace, punctuation-only and control-only text has an empty key', () => {
    for (const s of ['', '   ', '***', '()[]{}', '\u0000\u0001\u0002', '!!!???', '-', '+', '.', '\t\n']) expect(canonicalKey(s), JSON.stringify(s)).toBe('');
  });
  it('over-long names have an empty key instead of costing time', () => {
    expect(canonicalKey('a'.repeat(MAX_NAME_LENGTH + 1))).toBe('');
    expect(canonicalKey('a'.repeat(MAX_NAME_LENGTH))).toBe('a'.repeat(MAX_NAME_LENGTH));
  });
  it('non-string input does not throw', () => {
    expect(canonicalKey(undefined as unknown as string)).toBe('');
    expect(canonicalKey(null as unknown as string)).toBe('');
    expect(canonicalKey(42 as unknown as string)).toBe('');
  });
  it('fuzz: random unicode never throws, always returns a bounded key without double spaces', () => {
    const rnd = mulberry32(99);
    const alphabet = ['a', 'Z', '7', ' ', '-', '+', '*', '.', '(', ')', 'α', 'β', 'é', 'ñ', '́', 'ß', '😀', '‮', '\u0000', '\t', 'М', '漢', 'M', 'N', 'G', 'C', 'H', 'I', 'P', 'D'];
    for (let n = 0; n < 4000; n++) {
      let s = '';
      const len = Math.floor(rnd() * 40);
      for (let i = 0; i < len; i++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      const k = canonicalKey(s);
      expect(k.length).toBeLessThanOrEqual(MAX_NAME_LENGTH + 10);
      expect(k.includes('  ')).toBe(false);
      expect(k).toBe(k.trim());
    }
  });
  it('fuzz: normalising a canonical key is idempotent for catalogue-shaped input', () => {
    const rnd = mulberry32(7);
    const prefixes = ['M', 'NGC', 'IC', 'HIP', 'HD', 'HR', 'Gaia DR3', 'TIC', 'GJ', 'TYC', 'Kepler-', 'WASP-', 'TOI-', 'BD+', 'CD-', 'LHS', 'Melotte', 'alf', 'bet'];
    for (let n = 0; n < 2000; n++) {
      const p = prefixes[Math.floor(rnd() * prefixes.length)]!;
      const s = `${p}${rnd() < 0.5 ? ' ' : ''}${Math.floor(rnd() * 5000)}${rnd() < 0.3 ? ' b' : ''}${rnd() < 0.2 ? ' Cen' : ''}`;
      const k = canonicalKey(s);
      expect(canonicalKey(k), `${s} -> ${k}`).toBe(k);
    }
  });
  it('the fast path agrees with the full pipeline on catalogue designations (key and tokens)', () => {
    const { records } = syntheticRecords({ count: 3000, seed: 5 });
    let n = 0;
    for (const r of records) for (const d of r.designations) {
      const a = normalizeName(d);
      const b = normalizeName(`${d} `);               // the trailing blank takes the full pipeline
      expect(a.key, d).toBe(b.key);
      expect(a.tokens, d).toEqual(b.tokens);
      n++;
    }
    expect(n).toBeGreaterThan(6000);
  });
});

describe('tokens, brackets, proper names, queries', () => {
  it('tokenize splits on space and star and keeps the parts of signed and hyphenated words', () => {
    expect(tokenize('alpha cma')).toEqual(['alpha', 'cma']);
    expect(tokenize('sgr a*')).toEqual(['sgr', 'a']);
    expect(tokenize('lp 592-4')).toEqual(['lp', '592-4', '592', '4']);
    expect(tokenize('bd+01 543')).toEqual(['bd+01', 'bd', '01', '543']);
    expect(tokenize('psr b0531+21')).toEqual(['psr', 'b0531+21', 'b0531', '21']);
    expect(tokenize('a a')).toEqual(['a']);
  });
  it('splitParenthetical returns the outer text first, then each bracketed part', () => {
    expect(splitParenthetical('Andromeda Galaxy (M31)')).toEqual(['Andromeda Galaxy', 'M31']);
    expect(splitParenthetical('Bootes (I)')).toEqual(['Bootes', 'I']);
    expect(splitParenthetical('Sirius')).toEqual(['Sirius']);
    expect(splitParenthetical('(M31)')).toEqual(['M31']);
    expect(splitParenthetical('()')).toEqual(['()']);
  });
  it('isProperName separates names from identifiers', () => {
    for (const n of ['Sirius', 'Crab Nebula', 'Barnard’s Star', 'Andromeda Galaxy (M31)', 'Sagittarius A*']) expect(isProperName(n), n).toBe(true);
    for (const n of ['HIP 32349', 'Gaia DR3 123', 'alf CMa', '* alf CMa', 'RR Lyr', 'Kepler-452b', 'NGC 224', 'TRAPPIST-1']) expect(isProperName(n), n).toBe(false);
  });
  it('normalizeQuery rejects what the search must ignore', () => {
    for (const q of ['', ' ', 'a', '*', '()', '!!', '\u0000']) expect(normalizeQuery(q), JSON.stringify(q)).toBeNull();
    expect(normalizeQuery('x'.repeat(MAX_QUERY_LENGTH + 1))).toBeNull();
    expect(normalizeQuery(undefined as unknown as string)).toBeNull();
    expect(normalizeQuery('m3')?.key).toBe('m 3');
  });
  it('a long bare number may also be the start of a Gaia id', () => {
    expect(normalizeQuery('44728321309')?.alternatives).toEqual(['gaia dr3 44728321309']);
    expect(normalizeQuery('4472')?.alternatives).toEqual([]);
  });
});

describe('constellation table', () => {
  it('has the 88 IAU constellations with unique abbreviations', () => {
    expect(CONSTELLATIONS).toHaveLength(88);
    expect(new Set(CONSTELLATIONS.map((c) => c.abbr)).size).toBe(88);
    for (const c of CONSTELLATIONS) {
      expect(CONSTELLATION_PHRASES.get(c.abbr.toLowerCase())).toBe(c.abbr.toLowerCase());
      expect(CONSTELLATION_PHRASES.get(c.name.toLowerCase())).toBe(c.abbr.toLowerCase());
      expect(CONSTELLATION_PHRASES.get(c.genitive.toLowerCase())).toBe(c.abbr.toLowerCase());
    }
  });
  it('multi-word constellations map to their abbreviation', () => {
    expect(canonicalKey('alpha Canum Venaticorum')).toBe('alpha cvn');
    expect(canonicalKey('beta Triangulum Australe')).toBe('beta tra');
    expect(canonicalKey('alpha Ursae Majoris')).toBe('alpha uma');
    expect(canonicalKey('gamma Coma Berenices')).toBe('gamma com');
  });
});
