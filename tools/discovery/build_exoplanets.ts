/**
 * Build public/data/exoplanets.v1.json.gz from the NASA Exoplanet Archive composite planetary systems table (pscomppars).
 *
 *   npx tsx tools/discovery/build_exoplanets.ts [--offline] [--refresh]
 *
 * --offline  never touch the network: rebuild from data/cache/discovery/exoplanets/ (fails if an entry is missing).
 * --refresh  ignore the cache and fetch again.
 *
 * Raw downloads (kept so the build is reproducible): TAP csv result, TAP_SCHEMA column list, archive home page
 * (release date), counts page (confirmed-planet count), acknowledgement page (citation text). No credentials are used.
 * Output type: ExoplanetFile (src/discovery/types.ts); extra provenance lives under manifest.provenance (optional field).
 */
import { gzipSync, gunzipSync } from 'node:zlib';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const OFFLINE = args.includes('--offline');
const REFRESH = args.includes('--refresh');
const CACHE_DIR = 'data/cache/discovery/exoplanets';
const OUT = 'public/data/exoplanets.v1.json.gz';
const TAP = 'https://exoplanetarchive.ipac.caltech.edu/TAP/sync';
const SITE = 'https://exoplanetarchive.ipac.caltech.edu';
const log = (m: string) => console.log(`[exoplanets] ${m}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---- ADQL ------------------------------------------------------------------------------------------------------------------------

const SELECT_COLUMNS = [
  // names / identity
  'pl_name', 'hostname', 'pl_letter', 'hip_name', 'hd_name', 'tic_id', 'gaia_dr3_id', 'gaia_dr2_id',
  // discovery
  'discoverymethod', 'disc_year', 'disc_facility', 'disc_refname', 'pl_controv_flag',
  // planet
  'pl_orbper', 'pl_orbpererr1', 'pl_orbpererr2', 'pl_orbperlim', 'pl_orbper_reflink',
  'pl_rade', 'pl_radeerr1', 'pl_radeerr2', 'pl_radelim', 'pl_rade_reflink',
  'pl_bmasse', 'pl_bmasseerr1', 'pl_bmasseerr2', 'pl_bmasselim', 'pl_bmasse_reflink', 'pl_bmassprov',
  'pl_eqt', 'pl_orbsmax', 'pl_orbeccen',
  // host star / system
  'ra', 'dec', 'ra_reflink', 'sy_dist', 'sy_disterr1', 'sy_disterr2', 'sy_dist_reflink',
  'sy_pmra', 'sy_pmdec', 'sy_plx', 'sy_vmag', 'sy_snum', 'sy_pnum',
  'st_spectype', 'st_teff', 'st_tefferr1', 'st_tefferr2', 'st_rad', 'st_mass',
];
const ADQL = `select ${SELECT_COLUMNS.join(',')} from pscomppars order by pl_name`;

// ---- cache + network -------------------------------------------------------------------------------------------------------------

async function fetchText(url: string, tries = 4): Promise<string> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000), headers: { 'User-Agent': 'atlas-data-build/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.slice(0, 120)}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      await sleep(1500 * (i + 1));
    }
  }
  throw new Error(`fetch failed: ${String(lastErr)}`);
}

interface CacheMeta { url: string; retrieved: string; bytes: number }
async function cached(name: string, url: string): Promise<{ text: string; meta: CacheMeta }> {
  const file = `${CACHE_DIR}/${name}`;
  const metaFile = `${file}.meta.json`;
  if (!REFRESH && existsSync(file) && existsSync(metaFile)) {
    return { text: await readFile(file, 'utf8'), meta: JSON.parse(await readFile(metaFile, 'utf8')) as CacheMeta };
  }
  if (OFFLINE) throw new Error(`--offline: cache entry missing: ${file}`);
  log(`fetching ${name}`);
  const text = await fetchText(url);
  const meta: CacheMeta = { url, retrieved: new Date().toISOString(), bytes: Buffer.byteLength(text) };
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(file, text);
  await writeFile(metaFile, JSON.stringify(meta, null, 2));
  return { text, meta };
}

// ---- parsing helpers -------------------------------------------------------------------------------------------------------------

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const num = (s: string | undefined): number | null => {
  if (s === undefined || s.trim() === '') return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
};
const str = (s: string | undefined): string | null => {
  if (s === undefined) return null;
  const t = s.trim();
  return t === '' ? null : t;
};
const largest = (a: number | null, b: number | null): number | null => {
  if (a === null && b === null) return null;
  return Math.max(a === null ? 0 : Math.abs(a), b === null ? 0 : Math.abs(b));
};
/** err only when there is a value; error with no value is dropped. */
const gate = (v: number | null, e: number | null): number | null => (v === null ? null : e);

interface Ref { label: string | null; url: string | null }
/** The archive stores references as `<a refstr=KEY href=URL target=ref>Label</a>`. */
function parseRef(s: string | undefined): Ref {
  const t = str(s);
  if (t === null) return { label: null, url: null };
  const m = /<a\s+refstr=\S*\s+href=(\S+)\s+target=ref>(.*?)<\/a>/is.exec(t);
  if (!m) return { label: t.replace(/<[^>]+>/g, '').trim() || null, url: null };
  return { label: (m[2] ?? '').trim().replace(/&amp;/g, '&'), url: (m[1] ?? '').replace(/&amp;/g, '&') };
}

function stripHtml(h: string): string {
  return h
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ');
}

// ---- main ------------------------------------------------------------------------------------------------------------------------

type Col = (number | string | null)[];

async function main(): Promise<void> {
  // 1. Data + documentation, all cached.
  const csvUrl = `${TAP}?format=csv&query=${encodeURIComponent(ADQL)}`;
  const data = await cached('pscomppars.csv', csvUrl);
  const schemaAdql = "select column_name,datatype,unit,description from TAP_SCHEMA.columns where table_name='pscomppars'";
  await cached('tap_schema_columns.csv', `${TAP}?format=csv&query=${encodeURIComponent(schemaAdql)}`);
  const countAdql = 'select count(*) as n from pscomppars';
  const tapCount = await cached('tap_count.csv', `${TAP}?format=csv&query=${encodeURIComponent(countAdql)}`);
  const home = await cached('archive_home.html', `${SITE}/index.html`);
  const counts = await cached('counts_detail.html', `${SITE}/docs/counts_detail.html`);
  const ack = await cached('acknowledge.html', `${SITE}/docs/acknowledge.html`);
  const colDocs = await cached('API_PS_columns.html', `${SITE}/docs/API_PS_columns.html`);

  // 2. Archive-stated facts: release date, confirmed count, acknowledgement sentences.
  const homeText = stripHtml(home.text);
  const relM = /([\d,]+) Confirmed Planets (\d\d)\/(\d\d)\/(\d{4})/.exec(homeText);
  if (!relM) throw new Error('could not read the archive home page confirmed-planets update date');
  const homeCount = Number((relM[1] ?? '').replace(/,/g, ''));
  const archiveReleaseDate = `${relM[4]}-${relM[2]}-${relM[3]}`;
  const countsText = stripHtml(counts.text);
  const cM = /All Exoplanets\s+(\d+)/.exec(countsText);
  if (!cM) throw new Error('could not read the archive counts page');
  const countsPageN = Number(cM[1]);
  const tapN = Number(parseCsv(tapCount.text)[1]?.[0]);

  const ackText = stripHtml(ack.text);
  const ackM = /This research has made use of the NASA Exoplanet Archive, which is operated by the California Institute of Technology, under contract with the National Aeronautics and Space Administration under the Exoplanet Exploration Program\./.exec(ackText);
  const litM = /In addition, if you use data from a specific literature reference, please acknowledge that reference directly\./.exec(ackText);
  const citeM = /Please cite Christiansen et al\. \(2025\) ?, the NASA Exoplanet Archive's published paper accepted by the Planetary Science Journal that provides an extensive overview of the archive's data, services and tools\./.exec(ackText);
  const whenM = /Please include the following standard acknowledgment in any published material that makes use of the NASA Exoplanet Archive's services\./.exec(ackText);
  if (!ackM || !litM || !citeM || !whenM) throw new Error('acknowledgement sentences not found verbatim on the archive page (page changed?)');
  const citeUrl = /<a href="([^"]+)"[^>]*>Christiansen et al\. \(2025\)<\/a>/.exec(ack.text)?.[1] ?? null;

  const docText = stripHtml(colDocs.text);
  const raDoc = /ra RA \[decimal\] (Right Ascension of the planetary system in decimal degrees)/.exec(docText)?.[1] ?? null;
  const provDoc = /pl_bmassprov\S* Planet Mass or Mass\*sin\(i\) Provenance (Provenance of the measurement of the best mass\. Options are: [^X]*)/.exec(docText)?.[1]?.trim() ?? null;

  // 3. Parse the data table.
  const table = parseCsv(data.text);
  const header = table[0] ?? [];
  if (header.join(',') !== SELECT_COLUMNS.join(',')) throw new Error('unexpected csv header (columns differ from the ADQL select list)');
  const idx = new Map(header.map((h, i) => [h, i]));
  const rows = table.slice(1).filter((r) => r.length === header.length);
  if (rows.length !== table.length - 1) throw new Error('csv rows with the wrong column count');
  const g = (r: string[], c: string): string => r[idx.get(c) as number] ?? '';

  // 4. Verification of the row count against the archive's own statements.
  const checks = {
    rowsParsed: rows.length, tapCountStar: tapN, archiveCountsPage: countsPageN, archiveHomePage: homeCount,
  };
  const allEqual = new Set(Object.values(checks)).size === 1;
  if (!allEqual) throw new Error(`row count mismatch: ${JSON.stringify(checks)}`);

  // 5. Host table: one row per hostname, taken from the FIRST planet row of that host in pl_name order (the order of the
  // query). pscomppars carries no default-parameter-set flag, so this is the stated deterministic rule.
  const hostOrder: string[] = [];
  const hostFirst = new Map<string, string[]>();
  const hostRows = new Map<string, string[][]>();
  for (const r of rows) {
    const h = g(r, 'hostname').trim();
    if (!hostFirst.has(h)) { hostFirst.set(h, r); hostOrder.push(h); hostRows.set(h, []); }
    hostRows.get(h)!.push(r);
  }
  hostOrder.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const hostIndex = new Map(hostOrder.map((h, i) => [h, i]));

  const stripGaia = (s: string | null, prefix: string): string | null => {
    if (s === null) return null;
    if (!s.startsWith(prefix)) throw new Error(`gaia id without expected prefix "${prefix}": ${s}`);
    const id = s.slice(prefix.length).trim();
    if (!/^\d+$/.test(id)) throw new Error(`gaia id not numeric: ${s}`);
    return id;
  };

  const hostCols = [
    'hostname', 'raDeg', 'decDeg', 'distPc', 'distErrPc', 'distErr1Pc', 'distErr2Pc', 'distRef', 'distRefUrl', 'coordRef',
    'parallaxMas', 'pmRaMasYr', 'pmDecMasYr', 'spectralType', 'teffK', 'teffErrK', 'stRadiusSun', 'stMassSun', 'vMag',
    'gaiaDr3Id', 'gaiaDr2Id', 'hipName', 'hdName', 'ticId', 'nPlanets', 'nStars', 'nPlanetRows',
  ] as const;
  const hosts = {} as Record<string, Col> & Record<(typeof hostCols)[number], Col>;
  for (const c of hostCols) hosts[c] = [];
  for (const h of hostOrder) {
    const r = hostFirst.get(h)!;
    const dist = num(g(r, 'sy_dist'));
    const e1 = num(g(r, 'sy_disterr1'));
    const e2 = num(g(r, 'sy_disterr2'));
    const dRef = parseRef(g(r, 'sy_dist_reflink'));
    const cRef = parseRef(g(r, 'ra_reflink'));
    const teff = num(g(r, 'st_teff'));
    const push = (c: string, v: number | string | null) => hosts[c]!.push(v);
    push('hostname', h);
    push('raDeg', num(g(r, 'ra')));
    push('decDeg', num(g(r, 'dec')));
    push('distPc', dist);
    push('distErrPc', gate(dist, largest(e1, e2)));
    push('distErr1Pc', gate(dist, e1));
    push('distErr2Pc', gate(dist, e2));
    push('distRef', dist === null ? null : dRef.label);
    push('distRefUrl', dist === null ? null : dRef.url);
    push('coordRef', cRef.label);
    push('parallaxMas', num(g(r, 'sy_plx')));
    push('pmRaMasYr', num(g(r, 'sy_pmra')));
    push('pmDecMasYr', num(g(r, 'sy_pmdec')));
    push('spectralType', str(g(r, 'st_spectype')));
    push('teffK', teff);
    push('teffErrK', gate(teff, largest(num(g(r, 'st_tefferr1')), num(g(r, 'st_tefferr2')))));
    push('stRadiusSun', num(g(r, 'st_rad')));
    push('stMassSun', num(g(r, 'st_mass')));
    push('vMag', num(g(r, 'sy_vmag')));
    push('gaiaDr3Id', stripGaia(str(g(r, 'gaia_dr3_id')), 'Gaia DR3 '));
    push('gaiaDr2Id', stripGaia(str(g(r, 'gaia_dr2_id')), 'Gaia DR2 '));
    push('hipName', str(g(r, 'hip_name')));
    push('hdName', str(g(r, 'hd_name')));
    push('ticId', str(g(r, 'tic_id')));
    push('nPlanets', num(g(r, 'sy_pnum')));
    push('nStars', num(g(r, 'sy_snum')));
    push('nPlanetRows', hostRows.get(h)!.length);
  }

  // 5b. All rows of one host must agree on the host-level parameters (within rounding).
  type Dis = { host: string; field: string; values: string[] };
  const disagreements: Dis[] = [];
  const numFields: [string, string, number][] = [
    ['ra', 'ra', 1e-5], ['dec', 'dec', 1e-5], ['sy_dist', 'sy_dist', 1e-4], ['sy_disterr1', 'sy_disterr1', 1e-4],
    ['st_teff', 'st_teff', 1], ['st_rad', 'st_rad', 1e-4], ['st_mass', 'st_mass', 1e-4], ['sy_vmag', 'sy_vmag', 1e-3],
    ['sy_plx', 'sy_plx', 1e-4], ['sy_pnum', 'sy_pnum', 0], ['sy_snum', 'sy_snum', 0],
  ];
  const strFields = ['st_spectype', 'gaia_dr3_id', 'gaia_dr2_id', 'hip_name', 'hd_name', 'tic_id'];
  for (const h of hostOrder) {
    const rs = hostRows.get(h)!;
    if (rs.length < 2) continue;
    for (const [field, col, tol] of numFields) {
      const vals = rs.map((r) => num(g(r, col)));
      const nn = vals.filter((v): v is number => v !== null);
      const anyNull = nn.length !== vals.length && nn.length > 0;
      const spread = nn.length ? Math.max(...nn) - Math.min(...nn) : 0;
      if (anyNull || spread > tol) disagreements.push({ host: h, field, values: vals.map((v) => String(v)) });
    }
    for (const f of strFields) {
      const vals = rs.map((r) => str(g(r, f)));
      if (new Set(vals).size > 1) disagreements.push({ host: h, field: f, values: vals.map((v) => String(v)) });
    }
  }
  const disByField: Record<string, number> = {};
  for (const d of disagreements) disByField[d.field] = (disByField[d.field] ?? 0) + 1;
  const disHosts = new Set(disagreements.map((d) => d.host));

  // 6. Planet table.
  const planetCols = [
    'plName', 'hostname', 'hostIndex', 'discoveryMethod', 'discoveryYear', 'discoveryFacility', 'refName', 'refUrl',
    'periodDays', 'periodErr', 'periodErr1', 'periodErr2', 'periodLim', 'periodRef',
    'radiusEarth', 'radiusErr', 'radiusErr1', 'radiusErr2', 'radiusLim', 'radiusRef',
    'massEarth', 'massErr', 'massErr1', 'massErr2', 'massLim', 'massKind', 'massRef',
    'eqTempK', 'semiMajorAxisAu', 'eccentricity', 'controversial',
  ] as const;
  const planets = {} as Record<string, Col> & Record<(typeof planetCols)[number], Col>;
  for (const c of planetCols) planets[c] = [];
  const names = new Set<string>();
  const zeroViolations: string[] = [];
  const noZero: Record<string, string[]> = {
    periodDays: [], radiusEarth: [], massEarth: [], eqTempK: [], semiMajorAxisAu: [],
  };
  void noZero;
  for (const r of rows) {
    const name = g(r, 'pl_name').trim();
    if (names.has(name)) throw new Error(`duplicate pl_name ${name}`);
    names.add(name);
    const push = (c: string, v: number | string | null) => planets[c]!.push(v);
    const per = num(g(r, 'pl_orbper'));
    const rad = num(g(r, 'pl_rade'));
    const mas = num(g(r, 'pl_bmasse'));
    const disc = parseRef(g(r, 'disc_refname'));
    const lim = (c: string) => num(g(r, c));
    push('plName', name);
    push('hostname', g(r, 'hostname').trim());
    push('hostIndex', hostIndex.get(g(r, 'hostname').trim()) as number);
    push('discoveryMethod', str(g(r, 'discoverymethod')));
    push('discoveryYear', num(g(r, 'disc_year')));
    push('discoveryFacility', str(g(r, 'disc_facility')));
    push('refName', disc.label);
    push('refUrl', disc.url);
    push('periodDays', per);
    push('periodErr', gate(per, largest(num(g(r, 'pl_orbpererr1')), num(g(r, 'pl_orbpererr2')))));
    push('periodErr1', gate(per, num(g(r, 'pl_orbpererr1'))));
    push('periodErr2', gate(per, num(g(r, 'pl_orbpererr2'))));
    push('periodLim', per === null ? null : lim('pl_orbperlim'));
    push('periodRef', per === null ? null : parseRef(g(r, 'pl_orbper_reflink')).label);
    push('radiusEarth', rad);
    push('radiusErr', gate(rad, largest(num(g(r, 'pl_radeerr1')), num(g(r, 'pl_radeerr2')))));
    push('radiusErr1', gate(rad, num(g(r, 'pl_radeerr1'))));
    push('radiusErr2', gate(rad, num(g(r, 'pl_radeerr2'))));
    push('radiusLim', rad === null ? null : lim('pl_radelim'));
    push('radiusRef', rad === null ? null : parseRef(g(r, 'pl_rade_reflink')).label);
    push('massEarth', mas);
    push('massErr', gate(mas, largest(num(g(r, 'pl_bmasseerr1')), num(g(r, 'pl_bmasseerr2')))));
    push('massErr1', gate(mas, num(g(r, 'pl_bmasseerr1'))));
    push('massErr2', gate(mas, num(g(r, 'pl_bmasseerr2'))));
    push('massLim', mas === null ? null : lim('pl_bmasselim'));
    push('massKind', mas === null ? null : str(g(r, 'pl_bmassprov')));
    push('massRef', mas === null ? null : parseRef(g(r, 'pl_bmasse_reflink')).label);
    push('eqTempK', num(g(r, 'pl_eqt')));
    push('semiMajorAxisAu', num(g(r, 'pl_orbsmax')));
    push('eccentricity', num(g(r, 'pl_orbeccen')));
    push('controversial', num(g(r, 'pl_controv_flag')));
  }

  // 7. Validation: missing is null, never 0, wherever the physical quantity cannot be zero.
  const mustBePositive: [Record<string, Col>, string][] = [
    [planets, 'periodDays'], [planets, 'radiusEarth'], [planets, 'massEarth'], [planets, 'eqTempK'], [planets, 'semiMajorAxisAu'],
    [hosts, 'distPc'], [hosts, 'teffK'], [hosts, 'stRadiusSun'], [hosts, 'stMassSun'],
  ];
  for (const [tbl, c] of mustBePositive) {
    tbl[c]!.forEach((v, i) => { if (v !== null && (typeof v !== 'number' || !(v > 0))) zeroViolations.push(`${c}[${i}]=${String(v)}`); });
  }
  const errCols: [Record<string, Col>, string, string][] = [
    [planets, 'periodErr', 'periodDays'], [planets, 'radiusErr', 'radiusEarth'], [planets, 'massErr', 'massEarth'], [hosts, 'distErrPc', 'distPc'],
  ];
  for (const [tbl, e, v] of errCols) {
    tbl[e]!.forEach((x, i) => {
      if (x !== null && tbl[v]![i] === null) zeroViolations.push(`${e}[${i}] has no value`);
      if (x !== null && (typeof x !== 'number' || x < 0)) zeroViolations.push(`${e}[${i}]=${String(x)} negative`);
    });
  }
  if (zeroViolations.length) throw new Error(`zero/negative where impossible: ${zeroViolations.slice(0, 10).join('; ')} (n=${zeroViolations.length})`);
  const zeroEcc = planets.eccentricity.filter((v) => v === 0).length;   // 0 is a legitimate published value for eccentricity
  for (const t of [planets, hosts]) {
    const lens = new Set(Object.values(t).map((c) => c.length));
    if (lens.size !== 1) throw new Error('table columns have unequal length');
  }

  // 8. Statistics (per method, years, coverage).
  const nonNull = (t: Record<string, Col>): Record<string, number> =>
    Object.fromEntries(Object.entries(t).map(([k, c]) => [k, c.filter((v) => v !== null).length]));
  const perMethod: Record<string, { n: number; yearMin: number | null; yearMax: number | null }> = {};
  planets.discoveryMethod.forEach((m, i) => {
    const k = String(m);
    const y = planets.discoveryYear[i] as number | null;
    const e = perMethod[k] ?? { n: 0, yearMin: null, yearMax: null };
    e.n++;
    if (y !== null) { e.yearMin = e.yearMin === null ? y : Math.min(e.yearMin, y); e.yearMax = e.yearMax === null ? y : Math.max(e.yearMax, y); }
    perMethod[k] = e;
  });
  const years = planets.discoveryYear.filter((v): v is number => v !== null);
  const massKinds: Record<string, number> = {};
  planets.massKind.forEach((v) => { if (v !== null) massKinds[String(v)] = (massKinds[String(v)] ?? 0) + 1; });
  const limCounts: Record<string, Record<string, number>> = {};
  for (const c of ['periodLim', 'radiusLim', 'massLim']) {
    limCounts[c] = {};
    planets[c]!.forEach((v) => { if (v !== null) limCounts[c]![String(v)] = (limCounts[c]![String(v)] ?? 0) + 1; });
  }
  const noDistHosts: string[] = [];
  hostOrder.forEach((h, i) => { if (hosts.distPc[i] === null) noDistHosts.push(h); });
  const noDistPlanets = planets.hostIndex.filter((hi) => hosts.distPc[hi as number] === null).length;
  const gaiaDr3Hosts = hosts.gaiaDr3Id.filter((v) => v !== null).length;
  const gaiaDr2OnlyHosts = hostOrder.filter((_, i) => hosts.gaiaDr3Id[i] === null && hosts.gaiaDr2Id[i] !== null).length;
  const coordRefs: Record<string, number> = {};
  hosts.coordRef.forEach((v) => { const k = String(v); coordRefs[k] = (coordRefs[k] ?? 0) + 1; });
  const pnumMismatch = hostOrder.filter((_, i) => hosts.nPlanets[i] !== hosts.nPlanetRows[i]).length;
  const dupGaia = new Map<string, string[]>();
  hostOrder.forEach((h, i) => { const id = hosts.gaiaDr3Id[i] as string | null; if (id) dupGaia.set(id, [...(dupGaia.get(id) ?? []), h]); });
  const sharedGaia = [...dupGaia.entries()].filter(([, v]) => v.length > 1).map(([k, v]) => ({ gaiaDr3Id: k, hosts: v }));

  // 9. Spot checks read back from the retrieved rows.
  const pl = (n: string) => planets.plName.indexOf(n);
  const spot = (n: string) => {
    const i = pl(n);
    if (i < 0) return null;
    const o: Record<string, number | string | null> = {};
    for (const c of ['plName', 'discoveryMethod', 'discoveryYear', 'periodDays', 'radiusEarth', 'massEarth', 'massKind', 'eqTempK', 'semiMajorAxisAu']) o[c] = planets[c]![i] ?? null;
    const hi = planets.hostIndex[i] as number;
    for (const c of ['distPc', 'spectralType', 'teffK', 'nPlanets', 'gaiaDr3Id', 'raDeg', 'decDeg']) o[`host.${c}`] = hosts[c]![hi] ?? null;
    return o;
  };
  const spotNames = ['TRAPPIST-1 b', 'TRAPPIST-1 c', 'TRAPPIST-1 d', 'TRAPPIST-1 e', 'TRAPPIST-1 f', 'TRAPPIST-1 g', 'TRAPPIST-1 h',
    'Proxima Cen b', 'Kepler-452 b', '51 Peg b', '55 Cnc e', 'HD 209458 b', 'TOI-700 d', 'LHS 1140 b'];
  const spots = Object.fromEntries(spotNames.map((n) => [n, spot(n)]));
  const trappist = planets.plName.filter((n) => /^TRAPPIST-1 [b-h]$/.test(String(n))).length;
  const missingSpot = spotNames.filter((n) => spots[n] === null);

  // 10. Manifest + output.
  const units: Record<string, string> = {
    'hosts.hostname': 'archive hostname (unique per host row; key of the hosts table)',
    'hosts.raDeg': 'deg; archive "ra", decimal degrees, treated as ICRS (see caveats: the archive states no epoch)',
    'hosts.decDeg': 'deg; archive "dec", decimal degrees, treated as ICRS',
    'hosts.distPc': 'pc; archive sy_dist (system distance, mostly 1/Gaia parallax); null = no distance',
    'hosts.distErrPc': 'pc; larger of |sy_disterr1|,|sy_disterr2|; null if the archive gives no error',
    'hosts.distErr1Pc': 'pc; sy_disterr1 (upper, positive)', 'hosts.distErr2Pc': 'pc; sy_disterr2 (lower, negative sign as published)',
    'hosts.distRef': 'label of sy_dist_reflink', 'hosts.distRefUrl': 'ADS url of sy_dist_reflink', 'hosts.coordRef': 'label of ra_reflink (source of ra/dec)',
    'hosts.parallaxMas': 'mas; sy_plx', 'hosts.pmRaMasYr': 'mas/yr; sy_pmra', 'hosts.pmDecMasYr': 'mas/yr; sy_pmdec',
    'hosts.spectralType': 'string exactly as st_spectype', 'hosts.teffK': 'K; st_teff', 'hosts.teffErrK': 'K; larger of |st_tefferr1|,|st_tefferr2|',
    'hosts.stRadiusSun': 'solar radii; st_rad', 'hosts.stMassSun': 'solar masses; st_mass', 'hosts.vMag': 'mag; sy_vmag (Johnson V)',
    'hosts.gaiaDr3Id': 'string, digits only; archive gaia_dr3_id with the "Gaia DR3 " prefix removed; this is a Gaia DR3 source_id',
    'hosts.gaiaDr2Id': 'string, digits only; archive gaia_dr2_id with the "Gaia DR2 " prefix removed; a Gaia DR2 source_id (NOT comparable to DR3 ids)',
    'hosts.hipName': 'archive hip_name', 'hosts.hdName': 'archive hd_name', 'hosts.ticId': 'archive tic_id',
    'hosts.nPlanets': 'sy_pnum, planets in the system per the archive', 'hosts.nStars': 'sy_snum, gravitationally bound stars per the archive',
    'hosts.nPlanetRows': 'rows of this host in the planets table',
    'planets.plName': 'archive pl_name', 'planets.hostname': 'archive hostname', 'planets.hostIndex': 'index into the hosts table columns',
    'planets.discoveryMethod': 'archive discoverymethod', 'planets.discoveryYear': 'year; archive disc_year',
    'planets.discoveryFacility': 'archive disc_facility', 'planets.refName': 'label of disc_refname (discovery reference)', 'planets.refUrl': 'url of disc_refname',
    'planets.periodDays': 'days; pl_orbper', 'planets.periodErr': 'days; larger of |err1|,|err2|', 'planets.periodErr1': 'days; upper (positive)', 'planets.periodErr2': 'days; lower (negative as published)',
    'planets.periodLim': 'pl_orbperlim: 0 = measured, 1 = upper limit, -1 = lower limit', 'planets.periodRef': 'label of pl_orbper_reflink',
    'planets.radiusEarth': 'Earth radii; pl_rade', 'planets.radiusErr': 'Earth radii; larger of |err1|,|err2|', 'planets.radiusErr1': 'Earth radii; upper', 'planets.radiusErr2': 'Earth radii; lower (negative)',
    'planets.radiusLim': 'pl_radelim flag as above', 'planets.radiusRef': 'label of pl_rade_reflink',
    'planets.massEarth': 'Earth masses; pl_bmasse = best mass: true mass, M*sin(i) or an M-R-relationship estimate, see massKind',
    'planets.massErr': 'Earth masses; larger of |err1|,|err2|', 'planets.massErr1': 'Earth masses; upper', 'planets.massErr2': 'Earth masses; lower (negative)',
    'planets.massLim': 'pl_bmasselim flag as above',
    'planets.massKind': 'pl_bmassprov exactly as published (e.g. Mass, Msini, M*sin(i)/sin(i), M-R relationship)', 'planets.massRef': 'label of pl_bmasse_reflink',
    'planets.eqTempK': 'K; pl_eqt', 'planets.semiMajorAxisAu': 'au; pl_orbsmax', 'planets.eccentricity': 'dimensionless; pl_orbeccen (0 is a published value, often an assumed circular orbit)',
    'planets.controversial': 'pl_controv_flag: 1 = confirmation questioned in the literature',
    'err convention': 'xErr = max(|err1|,|err2|) (symmetrised, conservative); xErr1/xErr2 keep the archive values with their signs; error with no value is dropped; missing error = null, never 0',
  };
  const caveats = [
    'pscomppars is a composite table: each parameter of a planet is taken from a possibly different publication, so a row is "more complete, though not necessarily self-consistent" (archive wording). Per-parameter references are in the *Ref columns.',
    'The composite table has no default-parameter-set flag, no per-row reference name (pl_refname), no rowupdate and no releasedate column (checked against the TAP_SCHEMA and by query). refName is therefore the DISCOVERY reference (disc_refname); the release is the archive-wide update date shown on the archive home page.',
    'Host-level parameters (position, distance, spectral type, Teff, radius, mass, V, Gaia ids, counts) come from the first planet row of the host in pl_name order; every other row of the host is compared and disagreements are reported in manifest.provenance.hostDisagreements.',
    `ra/dec are the archive's decimal-degree system position; the archive documents them only as "${raDoc ?? 'Right Ascension of the planetary system in decimal degrees'}" and does NOT state an equinox or epoch. They are used as ICRS; the source of each position is hosts.coordRef (mostly Gaia or TICv8-derived). Proper motion is provided but not applied.`,
    'Distance sy_dist is mostly derived from Gaia parallax (see distRef); hosts without sy_dist cannot be placed in 3D (distPc = null; they are sky-only).',
    'Mass columns mix true masses, M*sin(i) minimum masses and relationship-based estimates; massKind carries the archive provenance label and must be shown with any mass.',
    'Limit flags: a value with Lim = 1 or -1 is an upper or lower limit, not a measurement.',
    'Gaia ids: gaiaDr3Id is the archive gaia_dr3_id (Gaia DR3 source_id); gaiaDr2Id is a separate Gaia DR2 source_id and must not be matched against DR3 records.',
  ];

  const manifest = {
    id: 'nasa-exoplanet-archive-pscomppars',
    title: 'NASA Exoplanet Archive: Planetary Systems Composite Parameters (confirmed planets) and their host stars',
    source: {
      source: 'NASA Exoplanet Archive (operated by Caltech/IPAC for NASA)',
      release: `archive update ${archiveReleaseDate}`,
      url: `${SITE}/cgi-bin/TblView/nph-tblView?app=ExoTbls&config=PSCompPars`,
      retrieved: data.meta.retrieved,
    },
    licence: 'No explicit licence text on the archive acknowledgement page; public data, acknowledgement and citation requested (see provenance.acknowledgement / citation).',
    query: ADQL,
    count: rows.length,
    caveats,
    units,
    table: 'pscomppars',
    archiveRelease: archiveReleaseDate,
    provenance: {
      tapEndpoint: TAP,
      tapRequest: `${TAP}?format=csv&query=<ADQL>`,
      adql: ADQL,
      retrievedAt: data.meta.retrieved,
      archiveReleaseDate,
      archiveReleaseSource: `${SITE}/index.html: "Confirmed Planets" entry, last-updated date ${relM[2]}/${relM[3]}/${relM[4]} (MM/DD/YYYY), listed count ${homeCount}`,
      acknowledgement: {
        pageUrl: `${SITE}/docs/acknowledge.html`,
        retrieved: ack.meta.retrieved,
        whenToUse: whenM[0],
        text: ackM[0],
        literatureStatement: litM[0],
        citation: citeM[0].replace(' ,', ','),
        citationUrl: citeUrl,
      },
      dataUseStatement: 'The archive publishes no separate data-use or licence statement beyond the acknowledgement page above; the requested acknowledgement and citation are reproduced verbatim.',
      rowCounts: { ...checks, planets: planets.plName.length, hosts: hostOrder.length },
      rowCountSources: {
        rowsParsed: 'csv rows returned by the ADQL query', tapCountStar: 'select count(*) from pscomppars (TAP)',
        archiveCountsPage: `${SITE}/docs/counts_detail.html "All Exoplanets"`, archiveHomePage: `${SITE}/index.html confirmed planets`,
      },
      gaia: { dr3IdColumn: 'gaia_dr3_id', dr2IdColumn: 'gaia_dr2_id', note: 'hosts.gaiaDr3Id = Gaia DR3 source_id as given by the archive; hosts.gaiaDr2Id = Gaia DR2 source_id.', hostsWithDr3: gaiaDr3Hosts, hostsWithDr2Only: gaiaDr2OnlyHosts },
      massKindDocumentation: provDoc,
      hostRule: 'first planet row of the host in pl_name order (pscomppars has no default parameter set flag)',
      hostDisagreements: { hostsWithDisagreement: disHosts.size, byField: disByField, examples: disagreements.slice(0, 25) },
      nonNullCounts: { hosts: nonNull(hosts), planets: nonNull(planets) },
    },
  };

  const file = { manifest, hosts, planets };
  await mkdir('public/data', { recursive: true });
  await writeFile(OUT, gzipSync(JSON.stringify(file), { level: 9 }));
  // read back
  const back = JSON.parse(gunzipSync(await readFile(OUT)).toString('utf8')) as typeof file;
  if (back.planets.plName.length !== rows.length || back.hosts.hostname.length !== hostOrder.length) throw new Error('read-back mismatch');

  const report = {
    outputBytes: gzipSync(JSON.stringify(file), { level: 9 }).length,
    checks, hosts: hostOrder.length, planets: rows.length, archiveReleaseDate, retrieved: data.meta.retrieved,
    discoveryYearRange: [Math.min(...years), Math.max(...years)], planetsWithoutYear: planets.discoveryYear.length - years.length,
    perMethod, massKinds, limCounts, zeroEccentricity: zeroEcc,
    hostsWithoutDistance: noDistHosts.length, planetsWithoutDistance: noDistPlanets, noDistHostsList: noDistHosts,
    gaiaDr3Hosts, gaiaDr2OnlyHosts, coordRefs, pnumMismatchHosts: pnumMismatch, sharedGaiaDr3Id: sharedGaia,
    hostDisagreementHosts: disHosts.size, hostDisagreementsByField: disByField, hostDisagreementExamples: disagreements.slice(0, 40),
    controversial: planets.controversial.filter((v) => v === 1).length,
    trappist1Planets: trappist, missingSpotChecks: missingSpot, spots,
    nonNull: { hosts: nonNull(hosts), planets: nonNull(planets) },
  };
  await writeFile(`${CACHE_DIR}/build-report.json`, JSON.stringify(report, null, 2));
  log(`wrote ${OUT}: ${rows.length} planets, ${hostOrder.length} hosts, ${(report.outputBytes / 1024).toFixed(0)} KiB gz`);
  log(`counts agree: ${JSON.stringify(checks)}; TRAPPIST-1 planets ${trappist}; missing spot checks: ${missingSpot.join(', ') || 'none'}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
