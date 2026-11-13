/**
 * In-memory search index over DiscoveryRecord[] (Prompt 07). Replaces the per-keystroke linear scan of src/data/catalogue/search.ts.
 *
 * Structures (all built from the canonical keys of src/discovery/normalize.ts, so index and query always agree):
 *  - key segments      sorted arrays of unique canonical designation keys, with CSR lists of entry ids (binary search for exact / prefix)
 *  - token index       token -> posting list of entry ids, plus sorted token segments (binary search for token prefixes)
 *  - trigram index     over NAME-LIKE words only (>= 3 letters) for the substring stage
 *  - delete index      symmetric-delete dictionary over purely alphabetic words >= 4 letters for the typo stage
 *  add(records) creates new segments (LSM style, merged when comparable in size); nothing is rebuilt, so a lazily loaded
 *  dataset joins the index without touching what is already there.
 *
 * Match kinds, best first (ranking is by kind FIRST, so a typo match can never outrank an exact or prefix match):
 *  exact         the query's canonical key equals a designation's key ("alf CMa" finds "alpha CMa", "M31" finds "M 31")
 *  prefix        a designation's key starts with the query's key ("sirius" -> "sirius b")
 *  token-prefix  every query word is the start of some word of one designation, any order ("cma alp")
 *  substring     the query occurs inside a name-like word ("geuse" -> "betelgeuse"); never applied to catalogue numbers
 *  fuzzy         only when too few non-fuzzy hits exist: alphabetic words >= 4 letters within edit distance 1 (4-7 letters)
 *                or 2 (8+). Hits carry fuzzy = { typed, matched, distance }. Identifiers and numbers are NEVER fuzzy-matched:
 *                a mistyped catalogue number must not silently open a different object.
 *
 * Prior (applied only inside a match kind; documented, no per-dataset weights): see CATEGORY_ORDER and priorKeyOf.
 *   1. category rank   (CATEGORY_ORDER, an editorial order from familiar to remote, overridable via options)
 *   2. proper name before catalogue identifier ("Sirius" before "HIP 32349")
 *   3. brighter apparent magnitude first (any band; records without a magnitude after those with one)
 *   4. insertion order (stable)
 *
 * Bounds (no per-keystroke full scans): a prefix range or posting list is scanned only up to SCAN_CAP entries; when more exist the
 * result says totalIsLowerBound = true. Counts are over distinct records among scanned candidates.
 */
import { isProperKey, MAX_QUERY_LENGTH, normalizeName, normalizeQuery, splitParenthetical } from './normalize';
import type { DiscoveryRecord, ObjectCategory, UniversalId } from './types';

export type MatchKind = 'exact' | 'prefix' | 'token-prefix' | 'substring' | 'fuzzy';
const QUALITY: Readonly<Record<MatchKind, number>> = { exact: 0, prefix: 1, 'token-prefix': 2, substring: 3, fuzzy: 4 };
const KINDS: readonly MatchKind[] = ['exact', 'prefix', 'token-prefix', 'substring', 'fuzzy'];

/** Editorial prior: category order used to break ties INSIDE a match kind. Not a ranking of importance, and no dataset appears in it. */
export const CATEGORY_ORDER: readonly ObjectCategory[] = [
  'planet', 'moon', 'star', 'exoplanet-host', 'exoplanet', 'galaxy', 'nebula', 'supernova-remnant', 'star-cluster', 'galaxy-group', 'galaxy-cluster', 'other',
];
export const ALL_CATEGORIES: readonly ObjectCategory[] = CATEGORY_ORDER;

/** Upper bound on entries examined per stage. */
export const SCAN_CAP = 6_000;
const TOKEN_EXPANSION_CAP = 256;
/** Words with this many digits or more are not put in the token index (they stay findable through the key index). */
const MAX_INDEXED_DIGITS = 7;
/** Catalogue prefixes occur in a large share of all designations; as a driver they are useless and they are always followed by a number that is indexed. */
const NOT_INDEXED: ReadonlySet<string> = new Set(['gaia', 'dr3', 'dr2', 'hip', 'hd', 'tic', '2mass', 'tyc', 'gj', 'sao', 'hr', 'bd', 'cd', 'cpd', 'lhs', 'ltt', 'kic', 'koi', 'toi', 'pgc', 'ugc']);
const MAX_QUERY_TOKENS = 8;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 200;

export interface SearchOptions {
  /** Only hits in these categories. Counts are always reported for all categories. */
  readonly categories?: readonly ObjectCategory[];
  readonly limit?: number;
  readonly offset?: number;
  /** Disable the typo stage. Default true. */
  readonly fuzzy?: boolean;
}

export interface SearchHit {
  readonly id: UniversalId;
  /** Position of the record in the index (insertion order). */
  readonly index: number;
  readonly name: string;
  readonly category: ObjectCategory;
  readonly dataset: DiscoveryRecord['dataset'];
  /** The designation (exactly as published) that produced the match. */
  readonly matchedDesignation: string;
  readonly matchKind: MatchKind;
  /** Higher is better. 1000 per match-kind step, plus 0..999 from the prior. For display/debug; order is the contract. */
  readonly score: number;
  /** [start, end) ranges inside matchedDesignation that correspond to what was typed. May be empty when the match was made through canonicalisation ("alpha" vs "alf"). */
  readonly highlight: readonly (readonly [number, number])[];
  /** Present iff matchKind === 'fuzzy': what was typed, which word it was matched to, and the edit distance. */
  readonly fuzzy?: { readonly typed: string; readonly matched: string; readonly distance: number };
}

export interface SearchResult {
  readonly query: string;
  /** Canonical key searched for; null when the query was rejected (empty, 1 character, over-long, no letter or digit). */
  readonly normalized: string | null;
  readonly hits: readonly SearchHit[];
  /** Distinct matching records within the requested categories among the candidates examined. */
  readonly total: number;
  /** True when a stage hit SCAN_CAP, so total and counts are lower bounds. */
  readonly totalIsLowerBound: boolean;
  readonly categoryCounts: Readonly<Partial<Record<ObjectCategory, number>>>;
  readonly fuzzyUsed: boolean;
}

const EMPTY_RESULT = (query: string, normalized: string | null): SearchResult =>
  ({ query, normalized, hits: [], total: 0, totalIsLowerBound: false, categoryCounts: {}, fuzzyUsed: false });

// ---- small helpers --------------------------------------------------------------------------------------------------------------

function lowerBound(a: readonly string[], x: string): number {
  let lo = 0, hi = a.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (a[mid]! < x) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Optimal-string-alignment distance (adjacent transposition = 1), early exit above `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev2: number[] = new Array<number>(lb + 1).fill(0);
  let prev: number[] = Array.from({ length: lb + 1 }, (_, j) => j);
  let cur: number[] = new Array<number>(lb + 1).fill(0);
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = cur[0]!;
    for (let j = 1; j <= lb; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a.charCodeAt(i - 1) === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) v = Math.min(v, prev2[j - 2]! + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    [prev2, prev, cur] = [prev, cur, prev2];
  }
  return prev[lb]!;
}

function deletes(word: string, maxD: number): Set<string> {
  const out = new Set<string>([word]);
  let frontier = [word];
  for (let d = 0; d < maxD; d++) {
    const next: string[] = [];
    for (const w of frontier) {
      if (w.length <= 1) continue;
      for (let i = 0; i < w.length; i++) {
        const v = w.slice(0, i) + w.slice(i + 1);
        if (!out.has(v)) { out.add(v); next.push(v); }
      }
    }
    frontier = next;
  }
  return out;
}

const maxEdits = (len: number): number => (len >= 8 ? 2 : len >= 4 ? 1 : 0);
const RE_ALPHA_WORD = /^[a-z]{4,24}$/;
const RE_NAME_WORD = /[a-z]{3}/;

/** Does `key` contain a word that starts with `prefix` (words are separated by space, '*', '-' or '+')? No allocation. */
function hasTokenPrefix(key: string, prefix: string): boolean {
  let from = 0;
  for (;;) {
    const i = key.indexOf(prefix, from);
    if (i < 0) return false;
    if (i === 0) return true;
    const c = key.charCodeAt(i - 1);
    if (c === 32 || c === 42 || c === 45 || c === 43) return true;
    from = i + 1;
  }
}

function hasToken(key: string, word: string): boolean {
  let from = 0;
  for (;;) {
    const i = key.indexOf(word, from);
    if (i < 0) return false;
    const before = i === 0 ? 32 : key.charCodeAt(i - 1);
    const after = i + word.length >= key.length ? 32 : key.charCodeAt(i + word.length);
    const sep = (c: number): boolean => c === 32 || c === 42 || c === 45 || c === 43;
    if (sep(before) && sep(after)) return true;
    from = i + 1;
  }
}

/** Per-character fold that keeps string length (for highlight offsets). */
function foldKeepLength(s: string): string {
  let out = '';
  for (const ch of s) {
    let c = ch.toLowerCase();
    if (c.length !== 1 || c.charCodeAt(0) > 127) { const d = c.normalize('NFD'); c = d.length > 0 ? d[0]! : c; if (c.length !== 1) c = ch; }
    out += c;
    for (let k = ch.length - 1; k > 0; k--) out += ' ';   // astral characters keep their UTF-16 width
  }
  return out;
}

function mergeRanges(r: [number, number][]): [number, number][] {
  r.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  for (const x of r) {
    const last = out[out.length - 1];
    if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]); else out.push([x[0], x[1]]);
  }
  return out;
}

/** Ranges of `text` that correspond to the typed query (see SearchHit.highlight). */
export function highlightRanges(text: string, typed: string, kind: MatchKind): [number, number][] {
  if (kind === 'fuzzy') return [];
  const folded = foldKeepLength(text);
  const q = foldKeepLength(typed).replace(/[^a-z0-9]+/g, ' ').trim();
  if (q.length === 0) return [];
  if (kind === 'exact' || kind === 'prefix') {
    const qa = q.replace(/ /g, '');
    let ta = '';
    const map: number[] = [];
    for (let i = 0; i < folded.length; i++) { const c = folded.charCodeAt(i); if ((c >= 48 && c <= 57) || (c >= 97 && c <= 122)) { ta += folded[i]; map.push(i); } }
    const at = ta.indexOf(qa);
    if (at >= 0 && qa.length > 0) return [[map[at]!, map[at + qa.length - 1]! + 1]];
  }
  const out: [number, number][] = [];
  for (const w of q.split(' ')) {
    if (w.length === 0) continue;
    if (kind === 'substring') {
      const i = folded.indexOf(w);
      if (i >= 0) out.push([i, i + w.length]);
    } else {
      let from = 0;
      for (;;) {
        const i = folded.indexOf(w, from);
        if (i < 0) break;
        if (i === 0 || !/[a-z0-9]/.test(folded[i - 1]!)) { out.push([i, i + w.length]); break; }
        from = i + 1;
      }
    }
  }
  return mergeRanges(out);
}

// ---- segments -------------------------------------------------------------------------------------------------------------------

interface KeySegment {
  /** Canonical keys in ascending order, duplicates allowed (two designations may share a key). */
  readonly keys: string[];
  /** ents[i] is the entry whose key is keys[i]. */
  readonly ents: Int32Array;
}
interface TokenSegment { readonly strs: string[]; readonly tids: Int32Array }

function buildKeySegment(entKey: readonly string[], from: number, to: number): KeySegment {
  const n = to - from;
  const ord = new Int32Array(n);
  for (let i = 0; i < n; i++) ord[i] = from + i;
  ord.sort((a, b) => { const x = entKey[a]!, y = entKey[b]!; return x < y ? -1 : x > y ? 1 : a - b; });
  const keys = new Array<string>(n);
  for (let i = 0; i < n; i++) keys[i] = entKey[ord[i]!]!;
  return { keys, ents: ord };
}

function mergeKeySegments(a: KeySegment, b: KeySegment): KeySegment {
  const n = a.keys.length + b.keys.length;
  const keys = new Array<string>(n);
  const ents = new Int32Array(n);
  let i = 0, j = 0, p = 0;
  while (i < a.keys.length && j < b.keys.length) {
    if (b.keys[j]! < a.keys[i]!) { keys[p] = b.keys[j]!; ents[p++] = b.ents[j++]!; }
    else { keys[p] = a.keys[i]!; ents[p++] = a.ents[i++]!; }
  }
  while (i < a.keys.length) { keys[p] = a.keys[i]!; ents[p++] = a.ents[i++]!; }
  while (j < b.keys.length) { keys[p] = b.keys[j]!; ents[p++] = b.ents[j++]!; }
  return { keys, ents };
}

function mergeTokenSegments(a: TokenSegment, b: TokenSegment): TokenSegment {
  const strs: string[] = [];
  const tids: number[] = [];
  let i = 0, j = 0;
  while (i < a.strs.length || j < b.strs.length) {
    if (j >= b.strs.length || (i < a.strs.length && a.strs[i]! < b.strs[j]!)) { strs.push(a.strs[i]!); tids.push(a.tids[i++]!); }
    else { strs.push(b.strs[j]!); tids.push(b.tids[j++]!); }
  }
  return { strs, tids: Int32Array.from(tids) };
}

// ---- top-k heap -----------------------------------------------------------------------------------------------------------------

interface Cand { score: number; rec: number; ent: number; fuzzy: number }

class TopK {
  readonly items: Cand[] = [];
  constructor(private readonly k: number) {}
  private worse(a: Cand, b: Cand): boolean { return a.score > b.score || (a.score === b.score && a.rec > b.rec); }
  push(c: Cand): void {
    const h = this.items;
    if (this.k <= 0) return;
    if (h.length < this.k) {
      h.push(c);
      let i = h.length - 1;
      while (i > 0) { const p = (i - 1) >> 1; if (this.worse(h[i]!, h[p]!)) { [h[i], h[p]] = [h[p]!, h[i]!]; i = p; } else break; }
    } else if (this.worse(h[0]!, c)) {
      h[0] = c;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < h.length && this.worse(h[l]!, h[m]!)) m = l;
        if (r < h.length && this.worse(h[r]!, h[m]!)) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m]!, h[i]!];
        i = m;
      }
    }
  }
  sorted(): Cand[] { return [...this.items].sort((a, b) => a.score - b.score || a.rec - b.rec); }
}

// ---- the index --------------------------------------------------------------------------------------------------------------------

const SRC_NAME = -1;          // entry text = the record's name (outer part)
const SRC_PAREN_BASE = -2;    // -2 - j: j-th parenthesised part of the name; >= 0: designations[src]

export interface IndexStats {
  readonly records: number;
  readonly entries: number;
  readonly keySegments: number;
  readonly tokens: number;
  readonly words: number;
}

export class SearchIndex {
  private readonly records: DiscoveryRecord[] = [];
  private readonly idToIndex = new Map<UniversalId, number>();
  private readonly catRank: number[] = [];
  private readonly catIndex: number[] = [];
  private readonly priorKey: number[] = [];
  private seen = new Uint32Array(1024);
  private stamp = 0;

  private readonly entKey: string[] = [];
  private entRec = new Int32Array(1024);
  private entSrc = new Int32Array(1024);
  private entCount = 0;

  private keySegs: KeySegment[] = [];
  private tokenSegs: TokenSegment[] = [];
  private readonly tokenId = new Map<string, number>();
  private readonly tokenStr: string[] = [];
  /** Posting lists: first entry inline (most words occur once), further entries in an overflow array created on demand. */
  private readonly postFirst: number[] = [];
  private readonly postMore: (number[] | undefined)[] = [];
  private readonly trigram = new Map<string, number[]>();
  private readonly deleteIndex = new Map<string, number[]>();
  private readonly categoryRank: ReadonlyMap<ObjectCategory, number>;

  constructor(opts: { readonly categoryOrder?: readonly ObjectCategory[] } = {}) {
    const order = opts.categoryOrder ?? CATEGORY_ORDER;
    const rank = new Map<ObjectCategory, number>();
    order.forEach((c, i) => rank.set(c, i));
    for (const c of CATEGORY_ORDER) if (!rank.has(c)) rank.set(c, rank.size);
    this.categoryRank = rank;
  }

  get size(): number { return this.records.length; }
  stats(): IndexStats {
    return { records: this.records.length, entries: this.entKey.length, keySegments: this.keySegs.length, tokens: this.tokenStr.length, words: this.deleteIndex.size };
  }

  get(id: UniversalId): DiscoveryRecord | undefined {
    const i = this.idToIndex.get(id);
    return i === undefined ? undefined : this.records[i];
  }
  at(index: number): DiscoveryRecord | undefined { return this.records[index]; }
  has(id: UniversalId): boolean { return this.idToIndex.has(id); }

  /** Add records. A record whose id is already indexed is skipped (counted in `skipped`): ids are unique. */
  add(records: readonly DiscoveryRecord[]): { readonly added: number; readonly skipped: number } {
    const firstEnt = this.entKey.length;
    const newTokens: number[] = [];
    let added = 0, skipped = 0;
    const recKeys: string[] = [];
    let nKeys = 0;
    for (const rec of records) {
      if (this.idToIndex.has(rec.id)) { skipped++; continue; }
      const r = this.records.length;
      this.records.push(rec);
      this.idToIndex.set(rec.id, r);
      added++;

      let properName = false;
      nKeys = 0;
      const nameParts = rec.name.indexOf('(') < 0 ? null : splitParenthetical(rec.name);
      const total = (nameParts ? nameParts.length : 1) + rec.designations.length;
      for (let ti = 0; ti < total; ti++) {
        let text: string, src: number;
        if (ti === 0) { text = nameParts ? nameParts[0]! : rec.name; src = SRC_NAME; }
        else if (nameParts && ti < nameParts.length) { text = nameParts[ti]!; src = SRC_PAREN_BASE - (ti - 1); }
        else { src = ti - (nameParts ? nameParts.length : 1); text = rec.designations[src]!; }
        const n = normalizeName(text);
        const key = n.key;
        if (key.length === 0) continue;
        let dup = false;
        for (let q = 0; q < nKeys; q++) if (recKeys[q] === key) { dup = true; break; }
        if (dup) continue;
        recKeys[nKeys++] = key;
        if (src === SRC_NAME) properName = isProperKey(key);
        this.addEntry(r, key, src, n.tokens, newTokens);
      }
      const rank = this.categoryRank.get(rec.category) ?? this.categoryRank.size;
      this.catRank.push(rank);
      this.catIndex.push(CATEGORY_ORDER.indexOf(rec.category));
      const mag = rec.measurements.apparentMag?.value;
      const magRank = mag !== undefined && Number.isFinite(mag) ? ((Math.min(40, Math.max(-30, mag)) + 30) / 70) * 4999 : 4999.5;
      this.priorKey.push(rank * 10_000 + (properName ? 0 : 5_000) + magRank);
    }
    if (added === 0) return { added, skipped };
    if (this.seen.length < this.records.length) {
      const grown = new Uint32Array(Math.max(this.records.length, this.seen.length * 2));
      grown.set(this.seen);
      this.seen = grown;
    }
    if (this.entKey.length > firstEnt) { this.keySegs.push(buildKeySegment(this.entKey, firstEnt, this.entKey.length)); this.compactKeys(); }
    if (newTokens.length > 0) {
      const strs = newTokens.map((t) => this.tokenStr[t]!).sort();
      this.tokenSegs.push({ strs, tids: Int32Array.from(strs, (w) => this.tokenId.get(w)!) });
      this.compactTokens();
      for (const tid of newTokens) this.indexWord(tid);
    }
    return { added, skipped };
  }

  private addEntry(r: number, key: string, src: number, toks: readonly string[], newTokens: number[]): void {
    const e = this.entCount++;
    if (e >= this.entRec.length) this.growEntries();
    this.entKey.push(key);
    this.entRec[e] = r;
    this.entSrc[e] = src;
    for (let k = 0; k < toks.length; k++) this.indexToken(toks[k]!, e, newTokens);
  }

  /**
   * Replace an indexed record by a version of itself that has MORE designations (appended after the existing ones; name and the existing designations must be
   * unchanged). The new designations become searchable; ranking keys stay. Used when a catalogue row is merged into a curated record after the record was indexed.
   * Returns the number of designations added (0 when the id is unknown or the record does not extend the old one).
   */
  extend(rec: DiscoveryRecord): number {
    const r = this.idToIndex.get(rec.id);
    if (r === undefined) return 0;
    const old = this.records[r]!;
    if (rec.name !== old.name || rec.designations.length < old.designations.length) return 0;
    for (let i = 0; i < old.designations.length; i++) if (old.designations[i] !== rec.designations[i]) return 0;
    this.records[r] = rec;
    const have = new Set<string>();
    for (const t of [old.name, ...old.designations]) { const k = normalizeName(t).key; if (k.length > 0) have.add(k); }
    const firstEnt = this.entKey.length;
    const newTokens: number[] = [];
    let added = 0;
    for (let src = old.designations.length; src < rec.designations.length; src++) {
      const n = normalizeName(rec.designations[src]!);
      if (n.key.length === 0 || have.has(n.key)) continue;
      have.add(n.key);
      this.addEntry(r, n.key, src, n.tokens, newTokens);
      added++;
    }
    if (this.entKey.length > firstEnt) { this.keySegs.push(buildKeySegment(this.entKey, firstEnt, this.entKey.length)); this.compactKeys(); }
    if (newTokens.length > 0) {
      const strs = newTokens.map((t) => this.tokenStr[t]!).sort();
      this.tokenSegs.push({ strs, tids: Int32Array.from(strs, (w) => this.tokenId.get(w)!) });
      this.compactTokens();
      for (const tid of newTokens) this.indexWord(tid);
    }
    return added;
  }

  private compactKeys(): void {
    const s = this.keySegs;
    while (s.length > 1 && (s[s.length - 2]!.keys.length <= 2 * s[s.length - 1]!.keys.length || s.length > 8)) {
      const b = s.pop()!, a = s.pop()!;
      s.push(mergeKeySegments(a, b));
    }
  }
  private compactTokens(): void {
    const s = this.tokenSegs;
    while (s.length > 1 && (s[s.length - 2]!.strs.length <= 2 * s[s.length - 1]!.strs.length || s.length > 8)) {
      const b = s.pop()!, a = s.pop()!;
      s.push(mergeTokenSegments(a, b));
    }
  }

  private growEntries(): void {
    const n = this.entRec.length * 2;
    const r = new Int32Array(n); r.set(this.entRec); this.entRec = r;
    const c = new Int32Array(n); c.set(this.entSrc); this.entSrc = c;
  }

  private postSize(tid: number): number { const m = this.postMore[tid]; return m === undefined ? 1 : m.length + 1; }
  private postAt(tid: number, i: number): number { return i === 0 ? this.postFirst[tid]! : this.postMore[tid]![i - 1]!; }

  private indexToken(tok: string, entry: number, newTokens: number[]): void {
    if (tok.length > 24 || NOT_INDEXED.has(tok)) return;
    // Long digit runs (Gaia / TIC ids, 2MASS coordinates) are found through the key index; they would only bloat the token index.
    let digits = 0;
    for (let i = 0; i < tok.length; i++) { const c = tok.charCodeAt(i); if (c >= 48 && c <= 57) digits++; }
    if (digits >= MAX_INDEXED_DIGITS) return;
    let tid = this.tokenId.get(tok);
    if (tid === undefined) {
      tid = this.tokenStr.length;
      this.tokenStr.push(tok);
      this.postFirst.push(entry);
      this.postMore.push(undefined);
      this.tokenId.set(tok, tid);
      newTokens.push(tid);
    } else {
      const more = this.postMore[tid];
      if (more === undefined) this.postMore[tid] = [entry]; else more.push(entry);
    }
  }

  private indexWord(tid: number): void {
    const w = this.tokenStr[tid]!;
    if (RE_NAME_WORD.test(w)) {
      const seen = new Set<string>();
      for (let i = 0; i + 3 <= w.length; i++) {
        const g = w.slice(i, i + 3);
        if (seen.has(g)) continue;
        seen.add(g);
        const l = this.trigram.get(g);
        if (l) l.push(tid); else this.trigram.set(g, [tid]);
      }
    }
    if (RE_ALPHA_WORD.test(w)) {
      for (const d of deletes(w, w.length >= 6 ? 2 : 1)) {
        const l = this.deleteIndex.get(d);
        if (l) l.push(tid); else this.deleteIndex.set(d, [tid]);
      }
    }
  }

  /** All records one of whose designations has exactly this canonical key. Used to resolve alternative identifiers. */
  resolveDesignation(raw: string): DiscoveryRecord[] {
    const key = normalizeName(raw).key;
    if (key.length === 0) return [];
    const out: DiscoveryRecord[] = [];
    const seen = new Set<number>();
    for (const seg of this.keySegs) {
      for (let i = lowerBound(seg.keys, key); i < seg.keys.length && seg.keys[i] === key; i++) {
        const r = this.entRec[seg.ents[i]!]!;
        if (!seen.has(r)) { seen.add(r); out.push(this.records[r]!); }
      }
    }
    return out;
  }

  private entryText(ent: number): string {
    const rec = this.records[this.entRec[ent]!]!;
    const src = this.entSrc[ent]!;
    if (src >= 0) return rec.designations[src]!;
    const parts = splitParenthetical(rec.name);
    return src === SRC_NAME ? parts[0]! : (parts[-src - 1] ?? rec.name);
  }

  // ---- query ------------------------------------------------------------------------------------------------------------------

  search(query: string, opts: SearchOptions = {}): SearchResult {
    const q = typeof query === 'string' ? normalizeQuery(query) : null;
    if (q === null || this.records.length === 0) return EMPTY_RESULT(typeof query === 'string' ? query.slice(0, MAX_QUERY_LENGTH) : '', null);
    const limit = Math.max(0, Math.min(MAX_LIMIT, Math.floor(opts.limit ?? DEFAULT_LIMIT)));
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    const allowed: Uint8Array | null = (() => {
      if (!opts.categories || opts.categories.length === 0) return null;   // none given = all categories
      const a = new Uint8Array(CATEGORY_ORDER.length);
      for (const c of opts.categories) { const i = CATEGORY_ORDER.indexOf(c); if (i >= 0) a[i] = 1; }
      return a;
    })();

    if (++this.stamp >= 0xffff_fff0) { this.seen.fill(0); this.stamp = 1; }
    const stamp = this.stamp;
    const seen = this.seen;
    const top = new TopK(offset + limit);
    const counts = new Array<number>(CATEGORY_ORDER.length).fill(0);
    let total = 0;
    let lower = false;
    const fuzzyMeta: { typed: string; matched: string; distance: number }[] = [];

    const consider = (ent: number, quality: number, fuzzy: number): void => {
      const rec = this.entRec[ent]!;
      if (seen[rec] === stamp) return;
      seen[rec] = stamp;
      const ci = this.catIndex[rec]!;
      counts[ci]!++;
      if (allowed !== null && allowed[ci] !== 1) return;
      total++;
      const dist = fuzzy >= 0 ? fuzzyMeta[fuzzy]!.distance : 0;
      top.push({ score: quality * 1e7 + dist * 1e6 + this.priorKey[rec]!, rec, ent, fuzzy });
    };

    const key = q.key;
    // 1. exact
    for (const seg of this.keySegs) {
      for (let i = lowerBound(seg.keys, key); i < seg.keys.length && seg.keys[i] === key; i++) consider(seg.ents[i]!, 0, -1);
    }
    // 2. prefix (query key and alternatives)
    let scanned = 0;
    for (const p of [key, ...q.alternatives]) {
      for (const seg of this.keySegs) {
        let i = lowerBound(seg.keys, p);
        while (i < seg.keys.length && seg.keys[i]!.startsWith(p)) {
          consider(seg.ents[i]!, p === key && seg.keys[i] === key ? 0 : 1, -1);
          if (++scanned >= SCAN_CAP) { lower = true; break; }
          i++;
        }
        if (scanned >= SCAN_CAP) break;
      }
      if (scanned >= SCAN_CAP) break;
    }
    // 3. all words are word-prefixes of one designation
    const qTokens = q.tokens.slice(0, MAX_QUERY_TOKENS);
    if (this.tokenStr.length > 0 && qTokens.length > 0) {
      if (this.tokenPrefixStage(qTokens, (ent) => consider(ent, 2, -1))) lower = true;
    }
    // 4. substring inside name-like words
    if (key.length >= 3) {
      if (this.substringStage(key, qTokens, (ent) => consider(ent, 3, -1))) lower = true;
    }
    // 5. typos, only when the better stages did not fill the page
    let fuzzyUsed = false;
    if (opts.fuzzy !== false && total < offset + limit) {
      const before = total;
      this.fuzzyStage(qTokens, (ent, typed, matched, distance) => {
        const m = fuzzyMeta.length;
        fuzzyMeta.push({ typed, matched, distance });
        consider(ent, 4, m);
      });
      fuzzyUsed = total > before || fuzzyMeta.length > 0;
    }

    const sorted = top.sorted().slice(offset, offset + limit);
    const hits: SearchHit[] = sorted.map((c) => {
      const rec = this.records[c.rec]!;
      const text = this.entryText(c.ent);
      const kind = KINDS[Math.min(4, Math.floor(c.score / 1e7))]!;
      const prior = this.priorKey[c.rec]!;
      const hit: SearchHit = {
        id: rec.id, index: c.rec, name: rec.name, category: rec.category, dataset: rec.dataset,
        matchedDesignation: text, matchKind: kind,
        score: (4 - QUALITY[kind]) * 1000 + Math.round(999 * (1 - Math.min(prior, 129_999) / 130_000)),
        highlight: highlightRanges(text, query, kind),
        ...(c.fuzzy >= 0 ? { fuzzy: fuzzyMeta[c.fuzzy]! } : {}),
      };
      return hit;
    });
    const categoryCounts: Partial<Record<ObjectCategory, number>> = {};
    CATEGORY_ORDER.forEach((c, i) => { if (counts[i]! > 0) categoryCounts[c] = counts[i]!; });
    return { query, normalized: key, hits, total, totalIsLowerBound: lower, categoryCounts, fuzzyUsed };
  }

  /** Token expansions: for each query word, the token ids whose text starts with it (capped). */
  private expand(prefix: string): { tids: number[]; broad: boolean; size: number } {
    const tids: number[] = [];
    let broad = false;
    let size = 0;
    for (const seg of this.tokenSegs) {
      let i = lowerBound(seg.strs, prefix);
      while (i < seg.strs.length && seg.strs[i]!.startsWith(prefix)) {
        if (tids.length >= TOKEN_EXPANSION_CAP) { broad = true; break; }
        const tid = seg.tids[i]!;
        tids.push(tid);
        size += this.postSize(tid);
        i++;
      }
    }
    return { tids, broad, size };
  }

  private tokenPrefixStage(qTokens: readonly string[], emit: (ent: number) => void): boolean {
    const exp = qTokens.map((t) => this.expand(t));
    if (exp.some((e) => e.tids.length === 0)) return false;
    // Driver: the word with the smallest candidate set that is not truncated; else the smallest (result then flagged lower bound).
    let d = -1;
    for (let i = 0; i < exp.length; i++) if (!exp[i]!.broad && (d < 0 || exp[i]!.size < exp[d]!.size)) d = i;
    let truncated = false;
    if (d < 0) { d = 0; for (let i = 1; i < exp.length; i++) if (exp[i]!.size < exp[d]!.size) d = i; truncated = true; }
    let budget = SCAN_CAP;
    for (const tid of exp[d]!.tids) {
      for (let pi = 0, pn = this.postSize(tid); pi < pn; pi++) {
        const ent = this.postAt(tid, pi);
        if (--budget < 0) return true;
        const k = this.entKey[ent]!;
        let ok = true;
        for (let i = 0; i < qTokens.length && ok; i++) if (i !== d) ok = hasTokenPrefix(k, qTokens[i]!);
        if (ok) emit(ent);
      }
    }
    return truncated || exp[d]!.broad;
  }

  private substringStage(key: string, qTokens: readonly string[], emit: (ent: number) => void): boolean {
    // Anchor on the longest query word of >= 3 letters; candidate words come from the trigram index, entries are verified on the whole key.
    let anchor = '';
    for (const t of qTokens) if (/^[a-z]{3,}$/.test(t) && t.length > anchor.length) anchor = t;
    if (anchor.length < 3) return false;
    let best: number[] | null = null;
    for (let i = 0; i + 3 <= anchor.length; i++) {
      const l = this.trigram.get(anchor.slice(i, i + 3));
      if (!l) return false;
      if (best === null || l.length < best.length) best = l;
    }
    if (best === null) return false;
    let budget = SCAN_CAP;
    let words = 0;
    for (const tid of best) {
      const w = this.tokenStr[tid]!;
      if (w.indexOf(anchor) < 0) continue;
      if (++words > TOKEN_EXPANSION_CAP * 4) return true;
      for (let pi = 0, pn = this.postSize(tid); pi < pn; pi++) {
        const ent = this.postAt(tid, pi);
        if (--budget < 0) return true;
        if (this.entKey[ent]!.indexOf(key) >= 0) emit(ent);
      }
    }
    return false;
  }

  private fuzzyStage(qTokens: readonly string[], emit: (ent: number, typed: string, matched: string, distance: number) => void): void {
    // A word is a typo candidate only if it is alphabetic, long enough, and NOT already the start of a known word.
    const sets: { typed: string; words: { tid: number; d: number }[]; exact: boolean }[] = [];
    let anyFuzzy = false;
    for (const t of qTokens) {
      const exp = this.expand(t);
      if (exp.tids.length > 0) { sets.push({ typed: t, words: exp.tids.map((tid) => ({ tid, d: 0 })), exact: true }); continue; }
      if (!RE_ALPHA_WORD.test(t)) return;                    // numbers / identifiers are never corrected
      const maxD = maxEdits(t.length);
      const cand = new Map<number, number>();
      for (const del of deletes(t, maxD)) {
        const l = this.deleteIndex.get(del);
        if (!l) continue;
        for (const tid of l) {
          if (cand.has(tid)) continue;
          const dist = editDistance(t, this.tokenStr[tid]!, maxD);
          if (dist >= 1 && dist <= maxD) cand.set(tid, dist);
        }
      }
      if (cand.size === 0) return;
      anyFuzzy = true;
      const words = [...cand.entries()].map(([tid, d]) => ({ tid, d })).sort((a, b) => a.d - b.d || this.postSize(b.tid) - this.postSize(a.tid) || a.tid - b.tid).slice(0, 8);
      sets.push({ typed: t, words, exact: false });
    }
    if (!anyFuzzy) return;
    // Driver: the smallest total posting among the sets.
    const sizes = sets.map((s) => s.words.reduce((n, w) => n + this.postSize(w.tid), 0));
    let d = 0;
    for (let i = 1; i < sets.length; i++) if (sizes[i]! < sizes[d]!) d = i;
    let budget = SCAN_CAP;
    for (const w of sets[d]!.words) {
      for (let pi = 0, pn = this.postSize(w.tid); pi < pn; pi++) {
        const ent = this.postAt(w.tid, pi);
        if (--budget < 0) return;
        const k = this.entKey[ent]!;
        let ok = true;
        let worst: { typed: string; matched: string; distance: number } | null = null;
        for (let i = 0; i < sets.length && ok; i++) {
          const s = sets[i]!;
          if (s.exact) { ok = hasTokenPrefix(k, s.typed); continue; }
          let found: { tid: number; d: number } | undefined;
          for (const cw of s.words) if (hasToken(k, this.tokenStr[cw.tid]!)) { found = cw; break; }
          if (!found) ok = false;
          else if (worst === null || found.d > worst.distance) worst = { typed: s.typed, matched: this.tokenStr[found.tid]!, distance: found.d };
        }
        if (ok && worst !== null) emit(ent, worst.typed, worst.matched, worst.distance);
      }
    }
  }
}

/** Build an index in one call. */
export function buildSearchIndex(records: readonly DiscoveryRecord[], opts: { readonly categoryOrder?: readonly ObjectCategory[] } = {}): SearchIndex {
  const idx = new SearchIndex(opts);
  idx.add(records);
  return idx;
}
