/**
 * Parsers and fetchers for the deep-space named-object build. Everything goes through ./cache (raw responses are kept),
 * nothing here invents a value: a failed parse throws, and the caller decides whether the quantity becomes `unavailable`.
 */
import { readFileSync } from 'node:fs';
import { cachedFile, cachedGet, fileRetrievalDate, retrievalDate, simbadQuery } from './cache';

// ---- text helpers ---------------------------------------------------------------------------------------------------

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', plusmn: '±', middot: '·', minus: '−', mdash: '—', ndash: '–', times: '×', deg: '°', rarr: '→' };
export function unescapeHtml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return ENT[e.toLowerCase()] ?? m;
  });
}
/** Whitespace/zero-width/LaTeX-insensitive form used to check that an evidence string occurs in a fetched text. */
export function squash(s: string): string {
  return unescapeHtml(s)
    .replace(/\$/g, '').replace(/\\pm/g, '±').replace(/\+\/-/g, '±').replace(/\+-/g, '±').replace(/\\sim/g, '~').replace(/\\,/g, '')
    .replace(/[\s​   ]+/g, '').replace(/[−–]/g, '-');
}
export function requireEvidence(haystack: string, needle: string, what: string): void {
  if (!squash(haystack).includes(squash(needle))) throw new Error(`evidence not found for ${what}: "${needle}"`);
}
export function stripTags(html: string): string {
  return unescapeHtml(html.replace(/<annotation[^>]*>[\s\S]*?<\/annotation>/g, '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

// ---- SIMBAD ---------------------------------------------------------------------------------------------------------

export interface SimbadFlux { filter: string; flux: number; flux_err: number | null; bibcode: string; qual: string | null }
export interface SimbadDist { dist: number; unit: string; minus_err: number | null; plus_err: number | null; method: string | null; bibcode: string }
export interface SimbadBasic {
  main_id: string; ra: number; dec: number; otype: string; otype_txt: string; morph_type: string | null; morph_bibcode: string | null;
  coo_bibcode: string | null; rvz_radvel: number | null; rvz_bibcode: string | null; rvz_type: string | null; sp_type: string | null;
  galdim_majaxis: number | null; galdim_minaxis: number | null; galdim_angle: number | null; galdim_bibcode: string | null; galdim_wavelength: string | null;
  plx_value: number | null; plx_err: number | null; plx_bibcode: string | null;
}
export interface SimbadObject { ident: string; basic: SimbadBasic; fluxes: SimbadFlux[]; distances: SimbadDist[]; retrieved: string; url: string }

const trim = (v: unknown): string | null => (typeof v === 'string' ? v.trim() || null : null);
const SIMBAD_URL = 'https://simbad.cfa.harvard.edu/simbad/sim-tap/sync';

export async function simbadObject(ident: string): Promise<SimbadObject> {
  const q = ident.replace(/'/g, "''");
  const rows = await simbadQuery(
    `SELECT main_id,ra,dec,otype,otype_txt,morph_type,morph_bibcode,coo_bibcode,rvz_radvel,rvz_bibcode,rvz_type,sp_type,galdim_majaxis,galdim_minaxis,galdim_angle,galdim_bibcode,galdim_wavelength,plx_value,plx_err,plx_bibcode FROM basic JOIN ident ON oid=oidref WHERE id='${q}'`,
    `simbad basic ${ident}`);
  const b = rows[0];
  if (!b) throw new Error(`SIMBAD: no object for identifier "${ident}"`);
  const flux = await simbadQuery(`SELECT filter,flux,flux_err,qual,bibcode FROM flux JOIN ident ON flux.oidref=ident.oidref WHERE id='${q}' AND filter IN ('B','V','K')`, `simbad flux ${ident}`);
  const dist = await simbadQuery(`SELECT dist,unit,minus_err,plus_err,method,bibcode FROM mesDistance JOIN ident ON mesDistance.oidref=ident.oidref WHERE id='${q}' ORDER BY bibcode`, `simbad dist ${ident}`);
  const basicQuery = { request: 'doQuery', lang: 'adql', format: 'json', query: `SELECT main_id,ra,dec,otype,otype_txt,morph_type,morph_bibcode,coo_bibcode,rvz_radvel,rvz_bibcode,rvz_type,sp_type,galdim_majaxis,galdim_minaxis,galdim_angle,galdim_bibcode,galdim_wavelength,plx_value,plx_err,plx_bibcode FROM basic JOIN ident ON oid=oidref WHERE id='${q}'` };
  const retrieved = retrievalDate(SIMBAD_URL, basicQuery) ?? 'unknown';
  const n = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  return {
    ident,
    basic: {
      main_id: String(b['main_id']).replace(/\s+/g, ' ').trim(), ra: Number(b['ra']), dec: Number(b['dec']), otype: String(b['otype']).trim(), otype_txt: String(b['otype_txt']).trim(),
      morph_type: trim(b['morph_type']), morph_bibcode: trim(b['morph_bibcode']), coo_bibcode: trim(b['coo_bibcode']),
      rvz_radvel: n(b['rvz_radvel']), rvz_bibcode: trim(b['rvz_bibcode']), rvz_type: trim(b['rvz_type']), sp_type: trim(b['sp_type']),
      galdim_majaxis: n(b['galdim_majaxis']), galdim_minaxis: n(b['galdim_minaxis']), galdim_angle: n(b['galdim_angle']),
      galdim_bibcode: trim(b['galdim_bibcode']), galdim_wavelength: trim(b['galdim_wavelength']),
      plx_value: n(b['plx_value']), plx_err: n(b['plx_err']), plx_bibcode: trim(b['plx_bibcode']),
    },
    fluxes: flux.map((r) => ({ filter: String(r['filter']).trim(), flux: Number(r['flux']), flux_err: n(r['flux_err']), bibcode: String(r['bibcode']).trim(), qual: trim(r['qual']) })),
    distances: dist.map((r) => ({ dist: Number(r['dist']), unit: String(r['unit']).trim(), minus_err: n(r['minus_err']), plus_err: n(r['plus_err']), method: trim(r['method']), bibcode: String(r['bibcode']).trim() })),
    retrieved,
    url: `https://simbad.cfa.harvard.edu/simbad/sim-id?Ident=${encodeURIComponent(ident)}`,
  };
}

// ---- VizieR (asu-tsv on the CfA mirror) ----------------------------------------------------------------------------

export const VIZIER_URL = 'https://vizier.cfa.harvard.edu/viz-bin/asu-tsv';
export interface VizierTable { rows: Record<string, string>[]; retrieved: string }
export async function vizier(params: Record<string, string>, label: string): Promise<VizierTable> {
  const text = await cachedGet(VIZIER_URL, params, label);
  const err = /^#INFO\s+Error=(.*)$/m.exec(text);
  if (err) throw new Error(`VizieR error for ${label}: ${err[1]}`);
  const lines = text.split('\n').filter((l) => !l.startsWith('#') && l.trim() !== '');
  if (lines.length < 3) return { rows: [], retrieved: retrievalDate(VIZIER_URL, params) ?? 'unknown' };
  const head = lines[0]!.split('\t').map((s) => s.trim());
  const rows = lines.slice(3).map((l) => { const c = l.split('\t'); return Object.fromEntries(head.map((h, i) => [h, (c[i] ?? '').trim()])); });
  return { rows, retrieved: retrievalDate(VIZIER_URL, params) ?? 'unknown' };
}
export const numOrNull = (s: string | undefined): number | null => { if (s === undefined || s.trim() === '') return null; const v = Number(s); return Number.isFinite(v) ? v : null; };

// ---- HyperLEDA ------------------------------------------------------------------------------------------------------

export interface LedaRow { objname: string; pgc: number; type: string; t: number | null; bt: number | null; logd25: number | null; logr25: number | null; pa: number | null; incl: number | null; mod0: number | null; url: string; retrieved: string }
const LEDA = 'http://atlas.obs-hp.fr/hyperleda/ledacat.cgi';
export async function ledaRow(name: string): Promise<LedaRow> {
  const params = { o: name, d: 'objname,pgc,type,t,bt,logd25,logr25,pa,incl,mod0,al2000,de2000', a: 'csv' };
  const text = await cachedGet(LEDA, params, `hyperleda ${name}`);
  const lines = text.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#') && !l.trimStart().startsWith('<'));
  const hi = lines.findIndex((l) => l.startsWith('objname'));
  if (hi < 0 || !lines[hi + 1]) throw new Error(`HyperLEDA: no row for ${name}`);
  const h = lines[hi]!.split(/\s+/);
  const c = lines[hi + 1]!.split('\t');
  const get = (k: string) => c[h.indexOf(k)]?.trim() ?? '';
  const n = (k: string) => numOrNull(get(k));
  return { objname: get('objname'), pgc: Number(get('pgc')), type: get('type'), t: n('t'), bt: n('bt'), logd25: n('logd25'), logr25: n('logr25'), pa: n('pa'), incl: n('incl'), mod0: n('mod0'),
    url: `http://atlas.obs-hp.fr/hyperleda/ledacat.cgi?o=${encodeURIComponent(name)}`, retrieved: retrievalDate(LEDA, params) ?? 'unknown' };
}

// ---- NED-D ----------------------------------------------------------------------------------------------------------

export const NED_D_URL = 'https://ned.ipac.caltech.edu/Archive/Distances/NED30.5.1-D-17.1.2-20200415.csv';
export interface NedDRow { exclusion: string; recordIndex: number; objectIndex: number; galaxy: string; mM: number | null; mMerr: number | null; dMpc: number | null; method: string; refcode: string; hubble: string; lmcMod: string; notes: string }
let nedD: NedDRow[] | null = null;
function parseCsvLine(l: string): string[] {
  const out: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < l.length; i++) {
    const ch = l[i]!;
    if (ch === '"') { if (q && l[i + 1] === '"') { cur += '"'; i++; } else q = !q; } else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}
export async function nedDRows(names: readonly string[]): Promise<{ rows: NedDRow[]; retrieved: string }> {
  const path = await cachedFile(NED_D_URL, 'NED-D-17.1.2-20200415.csv');
  if (!nedD) {
    nedD = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.startsWith('"')) continue;
      const c = parseCsvLine(line);
      if (c.length < 15 || c[0] === 'FRN' || c[1] === 'D') continue;
      const rec = Number(c[1]);
      if (!Number.isFinite(rec)) continue;
      nedD.push({ exclusion: c[0]!, recordIndex: rec, objectIndex: Number(c[2]), galaxy: c[3]!, mM: numOrNull(c[4]), mMerr: numOrNull(c[5]), dMpc: numOrNull(c[6]), method: c[7]!, refcode: c[8]!, hubble: c[11]!, lmcMod: c[12]!, notes: c[14]! });
    }
  }
  const want = new Set(names);
  return { rows: nedD.filter((r) => want.has(r.galaxy)), retrieved: fileRetrievalDate(NED_D_URL) ?? 'unknown' };
}

// ---- arXiv ----------------------------------------------------------------------------------------------------------

export interface ArxivEntry { id: string; title: string; authors: string[]; published: string; summary: string; url: string; journalRef: string | null; doi: string | null; retrieved: string }
export async function arxivEntry(id: string): Promise<ArxivEntry> {
  const t = await cachedGet('https://export.arxiv.org/api/query', { id_list: id }, `arxiv ${id}`);
  const e = t.split('<entry>')[1];
  if (!e) throw new Error(`arXiv: no entry for ${id}`);
  const g = (k: string) => unescapeHtml((e.match(new RegExp(`<${k}[^>]*>([\\s\\S]*?)</${k}>`)) ?? [, ''])[1]!).replace(/\s+/g, ' ').trim();
  return { id, title: g('title'), authors: [...e.matchAll(/<name>(.*?)<\/name>/g)].map((m) => m[1]!), published: g('published').slice(0, 10), summary: g('summary'), url: `https://arxiv.org/abs/${id}`,
    journalRef: g('arxiv:journal_ref') || null, doi: g('arxiv:doi') || null, retrieved: retrievalDate('https://export.arxiv.org/api/query', { id_list: id }) ?? 'unknown' };
}
/** Full text of an arXiv paper as rendered by ar5iv, tags stripped (used for the Milky Way tables). */
export async function ar5ivHtml(id: string): Promise<string> {
  return cachedGet(`https://ar5iv.labs.arxiv.org/html/${id}`, undefined, `ar5iv ${id}`);
}
export function ar5ivText(html: string): string {
  return stripTags(html);
}

/** Cleans one ar5iv table cell (LaTeX annotation text wins over the rendered glyphs). */
export function ar5ivCell(c: string): string {
  const x = c.replace(/<math[^>]*>[\s\S]*?<annotation encoding="application\/x-tex">([\s\S]*?)<\/annotation>[\s\S]*?<\/math>/g, (_m, tex: string) => tex);
  return unescapeHtml(x.replace(/<[^>]+>/g, '')).replace(/\\phantom\{.\}/g, '').replace(/\\pm/g, '±').replace(/\\rightarrow/g, '→').replace(/\\,/g, '').replace(/\s+/g, ' ').trim();
}

// ---- Baumgardt globular-cluster parameter table (HTML) ------------------------------------------------------------

export const BAUMGARDT_URL = 'https://people.smp.uq.edu.au/HolgerBaumgardt/globular/parameter.html';
export interface BaumgardtRow { name: string; ra: number; dec: number; distKpc: number; distErrKpc: number | null; nRv: number | null; nPm: number | null; massMsun: number | null; massErrMsun: number | null; rhlPc: number | null; distTitle: string; retrieved: string }
export async function baumgardtRow(ngc: string): Promise<BaumgardtRow> {
  const html = await cachedGet(BAUMGARDT_URL, undefined, 'baumgardt parameter table');
  const rows = html.match(/<tr>[\s\S]*?<\/tr>/g) ?? [];
  for (const r of rows) {
    const cells = [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]!);
    if (cells.length < 12) continue;
    const name = stripTags(cells[0]!.replace(/&nbsp;/g, ' ')).split(' ').slice(0, 2).join(' ');
    if (name !== ngc) continue;
    const plain = (c: string) => stripTags(c.replace(/<sup>(\d+)<\/sup>/g, '^$1'));
    const pm = (s: string): [number | null, number | null] => { const m = /^([-+]?\d+(?:\.\d+)?)\s*(?:±\s*(\d+(?:\.\d+)?))?/.exec(s); return m ? [Number(m[1]), m[2] ? Number(m[2]) : null] : [null, null]; };
    const [d, de] = pm(plain(cells[3]!));
    const massS = plain(cells[7]!); // "8.53 ± 0.05 · 10^5"
    const mm = /^([-+]?\d+(?:\.\d+)?)\s*(?:±\s*(\d+(?:\.\d+)?))?\s*·\s*10\^(\d+)/.exec(massS);
    return {
      name, ra: Number(plain(cells[1]!)), dec: Number(plain(cells[2]!)), distKpc: d ?? NaN, distErrKpc: de,
      nRv: numOrNull(plain(cells[5]!)), nPm: numOrNull(plain(cells[6]!)),
      massMsun: mm ? Number(mm[1]) * 10 ** Number(mm[3]) : null, massErrMsun: mm && mm[2] ? Number(mm[2]) * 10 ** Number(mm[3]) : null,
      rhlPc: numOrNull(plain(cells[11]!)), distTitle: (/title="([^"]*)"/.exec(cells[3]!) ?? [, ''])[1]!, retrieved: retrievalDate(BAUMGARDT_URL) ?? 'unknown',
    };
  }
  throw new Error(`Baumgardt table: no row for ${ngc}`);
}
