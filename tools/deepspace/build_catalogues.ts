/**
 * Deep-space point catalogues -> public/data/deepspace/<id>.v1.json.gz  (PointCatalogueFile, structure of arrays).
 *
 *   npx tsx tools/deepspace/build_catalogues.ts            # fetch (cached) + build all
 *   npx tsx tools/deepspace/build_catalogues.ts --offline  # rebuild from data/cache/deepspace/catalogues only
 *   npx tsx tools/deepspace/build_catalogues.ts --only ungc,twomrs
 *   npx tsx tools/deepspace/build_catalogues.ts --refresh  # ignore cache, fetch again
 *
 * Sources (all public, no credentials):
 *   VizieR (ASU tsv interface; mirrors tried in order): J/AJ/144/4, J/AJ/145/101, J/ApJS/199/26, J/A+A/673/A114
 *   Zenodo record 4891252 (Vasiliev & Baumgardt 2021 per-star Gaia EDR3 membership catalogue, CC-BY-4.0)
 * Every raw response is cached verbatim in data/cache/deepspace/catalogues/ with a .meta.json (URL, date, sha256).
 * Nothing is invented: rows that lack a required value are dropped and counted in the manifest caveats.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gzipSync, inflateRawSync } from 'node:zlib';
import type { PointCatalogueFile, PointCatalogueManifest } from '../../src/data/deepspace/types';

const args = process.argv.slice(2);
const OFFLINE = args.includes('--offline');
const REFRESH = args.includes('--refresh');
const onlyArg = args.indexOf('--only');
const ONLY = onlyArg >= 0 ? new Set((args[onlyArg + 1] ?? '').split(',')) : null;

const CACHE_DIR = 'data/cache/deepspace/catalogues';
const OUT_DIR = 'public/data/deepspace';
const MIRRORS = ['https://vizier.cfa.harvard.edu', 'https://vizier.cds.unistra.fr'];
const ASU = '/viz-bin/asu-tsv';
const ZENODO_RECORD = 'https://zenodo.org/api/records/4891252';
const ZENODO_ZIP = `${ZENODO_RECORD}/files/clusters.zip/content`;
const log = (m: string) => console.log(`[catalogues] ${m}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

// ---- cache + fetch -----------------------------------------------------------------------------------------------------

interface Meta { name: string; url: string; retrievedAt: string; sha256: string; bytes: number; note?: string }

async function readMeta(name: string): Promise<Meta | null> {
  try { return JSON.parse(await readFile(join(CACHE_DIR, `${name}.meta.json`), 'utf8')) as Meta; } catch { return null; }
}

async function fetchBytes(url: string, timeoutMs: number): Promise<Buffer> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow', headers: { 'User-Agent': 'curl/8 atlas-catalogue-builder' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) { lastErr = e; log(`  attempt ${attempt} failed for ${url.slice(0, 110)}: ${(e as Error).message}`); await sleep(1500 * attempt); }
  }
  throw new Error(`gave up on ${url}: ${(lastErr as Error).message}`);
}

/** Cached VizieR ASU tsv query. `query` is the part after '?'. */
async function vizier(name: string, query: string): Promise<{ text: string; meta: Meta }> {
  const file = join(CACHE_DIR, `${name}.tsv`);
  const meta = await readMeta(name);
  if (!REFRESH && meta) {
    const text = await readFile(file, 'utf8');
    if (sha(text) !== meta.sha256) throw new Error(`cache entry ${name} fails its checksum`);
    return { text, meta };
  }
  if (OFFLINE) throw new Error(`--offline: no cache entry for ${name}`);
  await mkdir(CACHE_DIR, { recursive: true });
  let lastErr: unknown;
  for (const host of MIRRORS) {
    const url = `${host}${ASU}?${query}`;
    try {
      const text = (await fetchBytes(url, 180_000)).toString('utf8');
      if (!/^#RESOURCE=/m.test(text) || /^#\s*(Error|Warning)/im.test(text.split('\n#RESOURCE')[0] ?? '')) throw new Error('response is not a VizieR table');
      await writeFile(file, text);
      const m: Meta = { name, url, retrievedAt: new Date().toISOString().slice(0, 10), sha256: sha(text), bytes: Buffer.byteLength(text) };
      await writeFile(join(CACHE_DIR, `${name}.meta.json`), JSON.stringify(m, null, 2));
      log(`fetched ${name} (${m.bytes} bytes) from ${host}`);
      return { text, meta: m };
    } catch (e) { lastErr = e; log(`  mirror ${host} failed for ${name}: ${(e as Error).message}`); }
  }
  throw new Error(`all mirrors failed for ${name}: ${(lastErr as Error).message}`);
}

async function binary(name: string, url: string, timeoutMs: number): Promise<{ buf: Buffer; meta: Meta }> {
  const file = join(CACHE_DIR, name);
  const meta = await readMeta(name);
  if (!REFRESH && meta) {
    const buf = await readFile(file);
    if (sha(buf) !== meta.sha256) throw new Error(`cache entry ${name} fails its checksum`);
    return { buf, meta };
  }
  if (OFFLINE) throw new Error(`--offline: no cache entry for ${name}`);
  await mkdir(dirname(file), { recursive: true });
  const buf = await fetchBytes(url, timeoutMs);
  await writeFile(file, buf);
  const m: Meta = { name, url, retrievedAt: new Date().toISOString().slice(0, 10), sha256: sha(buf), bytes: buf.length };
  await writeFile(join(CACHE_DIR, `${name}.meta.json`), JSON.stringify(m, null, 2));
  log(`fetched ${name} (${buf.length} bytes)`);
  return { buf, meta: m };
}

// ---- parsing helpers ----------------------------------------------------------------------------------------------------

interface Table { header: string[]; rows: string[][]; col(name: string): number }

function parseTsv(text: string): Table {
  const lines = text.split('\n').filter((l) => !l.startsWith('#') && l.trim() !== '');
  const header = (lines[0] ?? '').split('\t').map((s) => s.trim());
  // lines[1] = units, lines[2] = dashes
  const rows = lines.slice(3).map((l) => l.split('\t').map((s) => s.trim()));
  return {
    header, rows,
    col(name: string): number {
      const i = header.indexOf(name);
      if (i < 0) throw new Error(`column ${name} missing; have ${header.join(',')}`);
      return i;
    },
  };
}

const cell = (r: readonly string[], i: number): string => r[i] ?? '';
const num = (s: string): number | null => {
  if (s === '' || s === ' ') return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
};
const nz = (s: string): string | null => (s === '' ? null : s);
const round = (v: number, d: number): number => Number(v.toFixed(d));

/** "17 45 40.0" (hours) -> degrees. */
function raHmsToDeg(s: string): number | null {
  const p = s.trim().split(/\s+/).map(Number);
  if (p.length < 2 || p.some((x) => !Number.isFinite(x))) return null;
  const [h = 0, m = 0, sec = 0] = p;
  return (h + m / 60 + sec / 3600) * 15;
}
/** "-29 00 28" -> degrees (sign applies to the whole value, also for -00). */
function decDmsToDeg(s: string): number | null {
  const t = s.trim();
  const neg = t.startsWith('-');
  const p = t.replace(/^[+-]/, '').split(/\s+/).map(Number);
  if (p.length < 2 || p.some((x) => !Number.isFinite(x))) return null;
  const [d = 0, m = 0, sec = 0] = p;
  const v = d + m / 60 + sec / 3600;
  return neg ? -v : v;
}

// ---- minimal zip reader (central directory + raw inflate) ------------------------------------------------------------------

function zipEntry(zip: Buffer, wanted: string): Buffer {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 70_000); i--) if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('zip: end of central directory not found');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('zip: bad central header');
    const method = zip.readUInt16LE(p + 10);
    const csize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const lho = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (name === wanted) {
      const lhName = zip.readUInt16LE(lho + 26);
      const lhExtra = zip.readUInt16LE(lho + 28);
      const data = zip.subarray(lho + 30 + lhName + lhExtra, lho + 30 + lhName + lhExtra + csize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new Error(`zip: unsupported method ${method}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`zip: entry ${wanted} not found`);
}

// ---- writing ---------------------------------------------------------------------------------------------------------------

type Cols = Record<string, (number | string | null)[]>;

function mkCols(names: readonly string[]): Cols {
  const c: Cols = {};
  for (const n of names) c[n] = [];
  return c;
}
function push(c: Cols, rec: Record<string, number | string | null>): void {
  for (const k of Object.keys(c)) (c[k] as (number | string | null)[]).push(rec[k] ?? null);
}

async function write(file: PointCatalogueFile): Promise<void> {
  const n = file.manifest.count;
  for (const [k, v] of Object.entries(file.columns)) if (v.length !== n) throw new Error(`${file.manifest.id}: column ${k} has ${v.length} != ${n}`);
  await mkdir(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, `${file.manifest.id}.v1.json.gz`);
  const gz = gzipSync(JSON.stringify(file), { level: 9 });
  await writeFile(path, gz);
  log(`wrote ${path}: ${n} rows, ${gz.length} bytes gz`);
}

const LICENCE_VIZIER = 'Data served by CDS VizieR (https://cds.unistra.fr/vizier-org/licences_vizier.html); original publication data. Cite the paper and acknowledge VizieR (Ochsenbein et al. 2000, A&AS 143, 23).';

// ---- 1. McConnachie 2012 ---------------------------------------------------------------------------------------------------

async function buildMcConnachie(): Promise<void> {
  const cat = await vizier('vizier_J_AJ_144_4_catalog', '-source=J/AJ/144/4/catalog&-out.max=unlimited&-out.all=1');
  const refsT = await vizier('vizier_J_AJ_144_4_refs', '-source=J/AJ/144/4/refs&-out.max=unlimited&-out.all=1');
  const t = parseTsv(cat.text);
  const refs = parseTsv(refsT.text);
  const refBib = new Map<string, string>();
  for (const r of refs.rows) refBib.set(cell(r, refs.col('Ref')), cell(r, refs.col('BibCode')));

  const c = t.col.bind(t);
  const names = ['name', 'raDeg', 'decDeg', 'distMpc', 'distErrMpc', 'distMethod', 'morphology', 'vMag', 'diameterArcmin',
    'distErrUpMpc', 'distErrLowMpc', 'distRefs', 'subgroup', 'halfLightRadiusArcmin'];
  const cols = mkCols(names);
  let noDist = 0, noPos = 0;
  const droppedNames: string[] = [];
  for (const r of t.rows) {
    const name = cell(r, c('Name'));
    const ra = raHmsToDeg(cell(r, c('RAJ2000')));
    const dec = decDmsToDeg(cell(r, c('DEJ2000')));
    const dKpc = num(cell(r, c('D')));
    if (ra === null || dec === null) { noPos++; droppedNames.push(name); continue; }
    if (dKpc === null) { noDist++; droppedNames.push(name); continue; }
    const up = num(cell(r, c('E_D'))), low = num(cell(r, c('e_D')));
    const refCodes = cell(r, c('Ref2')).split(',').map((s) => s.trim()).filter(Boolean);
    const bibs = refCodes.map((k) => refBib.get(k) ?? `ref#${k}`);
    push(cols, {
      name, raDeg: round(ra, 5), decDeg: round(dec, 5),
      distMpc: round(dKpc / 1000, 6),
      distErrMpc: up !== null && low !== null ? round((up + low) / 2 / 1000, 6) : null,
      distMethod: 'literature compilation of distance moduli (McConnachie 2012; no per-object method column)',
      morphology: nz(cell(r, c('MType'))),
      vMag: num(cell(r, c('Vmag'))),
      diameterArcmin: null,
      distErrUpMpc: up === null ? null : round(up / 1000, 6),
      distErrLowMpc: low === null ? null : round(low / 1000, 6),
      distRefs: bibs.length ? bibs.join(';') : null,
      subgroup: nz(cell(r, c('SubG'))),
      halfLightRadiusArcmin: num(cell(r, c('R1'))),
    });
  }
  const count = cols['name']?.length ?? 0;
  log(`mcconnachie: ${t.rows.length} catalogue rows, ${count} kept; dropped without distance: ${droppedNames.join(', ') || 'none'}; without position: ${noPos}`);
  const manifest: PointCatalogueManifest = {
    id: 'local-group-mcconnachie',
    title: 'Local Group and nearby dwarf galaxies (McConnachie 2012)',
    source: { source: 'vizier', release: 'J/AJ/144/4 (McConnachie 2012, AJ 144, 4; bibcode 2012AJ....144....4M)', recordId: 'J/AJ/144/4/catalog', url: 'https://cdsarc.cds.unistra.fr/viz-bin/cat/J/AJ/144/4', retrieved: cat.meta.retrievedAt },
    licence: LICENCE_VIZIER,
    count,
    query: `VizieR ASU (asu-tsv): -source=J/AJ/144/4/catalog -out.max=unlimited -out.all=1 (all ${t.rows.length} rows; mirror ${new URL(cat.meta.url).host}). Rows with no published heliocentric distance are dropped (${droppedNames.join(', ') || 'none'}): the Galaxy row has no distance because the catalogue measures from it. Sexagesimal J2000 positions converted to degrees; D converted kpc -> Mpc (/1000).`,
    distanceBasis: 'per-object-direct',
    caveats: [
      `The catalogue is a compilation of published values for galaxies in and around the Local Group (${t.rows.length} rows in the VizieR table; the paper describes it as nearby dwarfs including the large members M31 and M33). It is not a complete census: faint dwarfs beyond the Milky Way halo are incomplete and surveys have covered only parts of the sky.`,
      'The catalogue gives no distance-method column; distMethod is therefore a fixed label, and the literature sources per galaxy are in distRefs (bibcodes resolved from the catalogue refs table). Distances are derived by the authors from published distance moduli (m-M); distance uncertainties are the catalogue upper/lower errors (distErrUpMpc, distErrLowMpc); distErrMpc is their arithmetic mean, our simplification, and is null if either is missing.',
      'diameterArcmin is null for every row: the catalogue gives a half-light radius (R1, major axis), not an isophotal diameter, kept as halfLightRadiusArcmin. vMag is the catalogue apparent V magnitude (some are uncertain, see the paper).',
      'Positions are the catalogue J2000 positions converted from sexagesimal; they are catalogue-native and not epoch-propagated. Morphology strings are the catalogue MType (Hubble-type as published, "?" marks uncertain).',
    ],
    units: {
      name: 'string, catalogue Name', raDeg: 'deg, J2000', decDeg: 'deg, J2000', distMpc: 'Mpc, heliocentric (catalogue kpc / 1000)',
      distErrMpc: 'Mpc, mean of the published upper and lower distance errors; null if unpublished', distMethod: 'string', morphology: 'string, McConnachie MType',
      vMag: 'mag, apparent V (catalogue Vmag)', diameterArcmin: 'arcmin, null (not published; see halfLightRadiusArcmin)',
      distErrUpMpc: 'Mpc, catalogue E_D / 1000', distErrLowMpc: 'Mpc, catalogue e_D / 1000', distRefs: 'string, semicolon-separated bibcodes of the distance references (catalogue column Ref2 resolved through its refs table)',
      subgroup: 'string, catalogue SubG (MW, M31 or Rest)', halfLightRadiusArcmin: 'arcmin, half-light radius along the major axis (catalogue R1)',
    },
  };
  await write({ manifest, columns: cols });
}

// ---- 2. UNGC -----------------------------------------------------------------------------------------------------------------

async function buildUngc(): Promise<void> {
  const cat = await vizier('vizier_J_AJ_145_101_catalog', '-source=J/AJ/145/101/catalog&-out.max=unlimited&-out.all=1');
  const dm = await vizier('vizier_J_AJ_145_101_table6', '-source=J/AJ/145/101/table6&-out.max=unlimited&-out.all=1');
  const t = parseTsv(cat.text);
  const d6 = parseTsv(dm.text);
  const dmByName = new Map<string, { dm: number; err: number | null; method: string }[]>();
  for (const r of d6.rows) {
    const nm = cell(r, d6.col('Name'));
    const v = num(cell(r, d6.col('DM')));
    if (v === null) continue;
    const arr = dmByName.get(nm) ?? [];
    arr.push({ dm: v, err: num(cell(r, d6.col('e_DM'))), method: cell(r, d6.col('n_DM')) });
    dmByName.set(nm, arr);
  }
  const c = t.col.bind(t);
  const names = ['name', 'raDeg', 'decDeg', 'distMpc', 'distErrMpc', 'distMethod', 'morphology', 'bMag', 'diameterArcmin',
    'tType', 'dwarfMorphology', 'surfaceBrightnessClass', 'mainDisturber', 'tidalIndex', 'kMag', 'hrvKms', 'distModulusMag', 'distModulusErrMag', 'ngcSimbadName'];
  const cols = mkCols(names);
  let dropped = 0, errFilled = 0;
  for (const r of t.rows) {
    const ra = raHmsToDeg(cell(r, c('RAJ2000')));
    const dec = decDmsToDeg(cell(r, c('DEJ2000')));
    const dist = num(cell(r, c('Dist')));
    if (ra === null || dec === null || dist === null) { dropped++; continue; }
    const name = cell(r, c('Name'));
    const method = cell(r, c('f_Dist'));
    // Distance error: the catalogue publishes DM errors in table6 (per measurement), not an error on the adopted Dist.
    // Use it only when exactly one table6 measurement with the same method exists AND it reproduces Dist (within rounding).
    const list = dmByName.get(name) ?? [];
    let dmMag: number | null = null, dmErr: number | null = null, errMpc: number | null = null;
    if (list.length === 1) {
      const e = list[0];
      if (e && e.method === method && Math.abs(10 ** ((e.dm - 25) / 5) - dist) <= 0.006 + 0.0005 * dist) {
        dmMag = e.dm; dmErr = e.err;
        if (e.err !== null) { errMpc = round(dist * Math.LN10 / 5 * e.err, 4); errFilled++; }
      }
    }
    const tt = num(cell(r, c('TT')));
    const mcl = cell(r, c('Mcl'));
    push(cols, {
      name, raDeg: round(ra, 5), decDeg: round(dec, 5),
      distMpc: dist, distErrMpc: errMpc, distMethod: nz(method) ?? 'unspecified',
      morphology: mcl !== '' ? mcl : tt !== null ? `T=${tt}` : null,
      bMag: num(cell(r, c('Bmag'))),
      diameterArcmin: num(cell(r, c('a26'))),
      tType: tt, dwarfMorphology: nz(mcl), surfaceBrightnessClass: nz(cell(r, c('Tdw'))),
      mainDisturber: nz(cell(r, c('MD'))), tidalIndex: num(cell(r, c('Ti1'))),
      kMag: num(cell(r, c('Kmag'))), hrvKms: num(cell(r, c('HRV'))),
      distModulusMag: dmMag, distModulusErrMag: dmErr, ngcSimbadName: nz(cell(r, c('SimbadName'))),
    });
  }
  const count = cols['name']?.length ?? 0;
  log(`ungc: ${t.rows.length} rows, ${count} kept, dropped ${dropped}; distErr filled for ${errFilled}`);
  const manifest: PointCatalogueManifest = {
    id: 'ungc',
    title: 'Updated Nearby Galaxy Catalog (Karachentsev et al. 2013)',
    source: { source: 'vizier', release: 'J/AJ/145/101 (Karachentsev, Makarov & Kaisina 2013, AJ 145, 101; bibcode 2013AJ....145..101K)', recordId: 'J/AJ/145/101/catalog (+ table6 for distance-modulus errors)', url: 'https://cdsarc.cds.unistra.fr/viz-bin/cat/J/AJ/145/101', retrieved: cat.meta.retrievedAt },
    licence: LICENCE_VIZIER,
    count,
    query: `VizieR ASU (asu-tsv): -source=J/AJ/145/101/catalog -out.max=unlimited -out.all=1 (all ${t.rows.length} rows; mirror ${new URL(cat.meta.url).host}); table J/AJ/145/101/table6 (distance moduli, ${d6.rows.length} measurements) joined by galaxy Name for errors. No rows removed unless position or distance is missing (${dropped}). Sexagesimal J2000 positions converted to degrees.`,
    distanceBasis: 'per-object-direct',
    caveats: [
      'Distances (Dist, Mpc) are the catalogue-adopted values; distMethod is the catalogue code f_Dist exactly as published (e.g. TRGB tip of the red giant branch, Cep Cepheids, SBF surface-brightness fluctuations, TF Tully-Fisher, BS brightest stars, SN supernova, RR RR Lyrae, HB horizontal branch, CMD colour-magnitude fitting, FP fundamental plane, PNLF planetary-nebula luminosity function). The codes "mem", "h", "h\'" and "txt" are NOT independent distance measurements of that galaxy (mem = assigned from group membership, h = Hubble-flow based, txt = see the paper\'s text); treat them as lower-quality; consult the paper (Note G1).',
      `The catalogue does not publish an uncertainty on the adopted distance. distErrMpc is therefore null except where table6 has exactly one measurement with the same method reproducing Dist and a published DM error: then distErrMpc = Dist * ln(10)/5 * e_DM (first-order propagation, our derivation, ${errFilled} rows); the underlying DM and error are kept in distModulusMag / distModulusErrMag.`,
      'The sample is a compilation, not a volume-limited survey: completeness falls with distance and surface brightness and the Zone of Avoidance is poorly covered. It covers the Local Volume (the paper: galaxies within about 11 Mpc, plus a few with velocity-based distances beyond).',
      'morphology is the catalogue dwarf-morphology class (Mcl: BCD, HIcld, Im, Ir, S0em, Sm, Sph, Tr, dE, dEem, dS0em) when present, otherwise the numeric de Vaucouleurs T-type as "T=<n>" (catalogue column TT, range -3..11); both are also kept separately (dwarfMorphology, tType). Many galaxies have neither blank, in which case morphology is null.',
      'diameterArcmin is the catalogue major angular diameter a26 (as defined in Note 1 of the catalogue / paper). bMag is the apparent integral B magnitude as published (some corrected/estimated values; see the paper).',
      'Group/membership information: the catalogue has no explicit group-ID column. We kept the closest columns as extras: mainDisturber (MD, the name of the galaxy with the largest tidal influence, per the paper) and tidalIndex (Ti1, tidal index Theta_1); these describe dynamical environment, not a formal group list.',
    ],
    units: {
      name: 'string, catalogue Name', raDeg: 'deg, J2000', decDeg: 'deg, J2000', distMpc: 'Mpc, heliocentric, as published (Dist)',
      distErrMpc: 'Mpc, derived from the table6 DM error where unambiguous (see caveats); otherwise null', distMethod: 'string, catalogue code f_Dist', morphology: 'string, see caveats',
      bMag: 'mag, apparent integral B (Bmag)', diameterArcmin: 'arcmin, major angular diameter (a26)',
      tType: 'de Vaucouleurs T-type code (TT), dimensionless', dwarfMorphology: 'string, catalogue Mcl', surfaceBrightnessClass: 'string, catalogue Tdw (H/N/L/X)',
      mainDisturber: 'string, catalogue MD (name of main tidal disturber)', tidalIndex: 'tidal index Theta_1 (Ti1), dimensionless',
      kMag: 'mag, 2MASS Ks (Kmag)', hrvKms: 'km/s, heliocentric radial velocity (HRV)', distModulusMag: 'mag, table6 DM when used for distErrMpc', distModulusErrMag: 'mag, table6 e_DM', ngcSimbadName: 'string, SIMBAD name column added by CDS',
    },
  };
  await write({ manifest, columns: cols });
}

// ---- 3. 2MRS ------------------------------------------------------------------------------------------------------------------

async function buildTwomrs(): Promise<void> {
  const q = '-source=J/ApJS/199/26/table3&-out.max=unlimited&-out=ID,RAJ2000,DEJ2000,GLON,GLAT,Kcmag,e_Kcmag,Ktmag,type,r_type,cz,e_cz,n_cz,r_cz';
  const cat = await vizier('vizier_J_ApJS_199_26_table3', q);
  const t = parseTsv(cat.text);
  const c = t.col.bind(t);
  const names = ['name', 'raDeg', 'decDeg', 'czKms', 'czErrKms', 'ksMag', 'morphology', 'ktMag', 'glonDeg', 'glatDeg', 'czSource'];
  const cols = mkCols(names);
  let noCz = 0, brightest = Infinity, faintest = -Infinity, negCz = 0;
  for (const r of t.rows) {
    const ra = num(cell(r, c('RAJ2000'))), dec = num(cell(r, c('DEJ2000')));
    const cz = num(cell(r, c('cz')));
    const ks = num(cell(r, c('Kcmag')));
    if (ra === null || dec === null || ks === null) continue;
    if (cz === null) { noCz++; continue; }
    if (cz < 0) negCz++;
    brightest = Math.min(brightest, ks); faintest = Math.max(faintest, ks);
    push(cols, {
      name: cell(r, c('ID')), raDeg: round(ra, 5), decDeg: round(dec, 5),
      czKms: cz, czErrKms: num(cell(r, c('e_cz'))), ksMag: ks, morphology: nz(cell(r, c('type'))),
      ktMag: num(cell(r, c('Ktmag'))), glonDeg: num(cell(r, c('GLON'))), glatDeg: num(cell(r, c('GLAT'))),
      czSource: nz(cell(r, c('n_cz'))),
    });
  }
  const count = cols['name']?.length ?? 0;
  log(`twomrs: ${t.rows.length} rows, ${count} kept (no cz: ${noCz}); Ks range ${brightest}..${faintest}; negative cz: ${negCz}`);
  const manifest: PointCatalogueManifest = {
    id: 'twomrs',
    title: '2MASS Redshift Survey (Huchra et al. 2012)',
    source: { source: 'vizier', release: 'J/ApJS/199/26 (Huchra et al. 2012, ApJS 199, 26; bibcode 2012ApJS..199...26H)', recordId: 'J/ApJS/199/26/table3', url: 'https://cdsarc.cds.unistra.fr/viz-bin/cat/J/ApJS/199/26', retrieved: cat.meta.retrievedAt },
    licence: LICENCE_VIZIER,
    count,
    query: `VizieR ASU (asu-tsv): ${q} (all ${t.rows.length} rows of the main catalogue table3; mirror ${new URL(cat.meta.url).host}). Rows missing position, Ks or cz would be dropped (cz missing: ${noCz}).`,
    distanceBasis: 'per-object-redshift-hubble-flow',
    caveats: [
      'Flux limit: the main 2MRS catalogue is complete to extinction-corrected Ks < 11.75 (2MASS isophotal magnitude); fainter galaxies are absent, so the number density of points falls with distance (a selection effect, not a physical void) and only luminous galaxies are seen far away. Ks range in this file: ' + `${brightest} to ${faintest}.`,
      'Zone of Avoidance: the Milky Way plane (roughly |b| < 5 deg, wider toward the bulge) obscures galaxies; the survey is incomplete there and the empty band in the map is a selection effect.',
      'Only cz (km/s, barycentre-corrected heliocentric redshift as published) is stored. Distances are NOT in the file: if converted, d = cz/H0 is a Hubble-flow estimate. An application may choose H0 = 70 km/s/Mpc as a convenience constant; that value is an application choice, not a measurement in this catalogue, and it carries a roughly 10% systematic uncertainty. At cz of a few thousand km/s peculiar velocities (several hundred km/s, up to ~1000 km/s in clusters) are a large fraction of cz, so individual distances are unreliable: dense clusters are stretched along the line of sight (fingers of God) and infall onto large attractors compresses structure. Nearby galaxies (cz below ~1000 km/s) have the worst fractional distance error.',
      'czErrKms is the catalogue e_cz, null where unpublished. czSource is the catalogue code for the redshift source (n_cz). ksMag is Kcmag (extinction-corrected 2MASS Ks magnitude used for the selection); ktMag is the extinction-corrected total extrapolated Ks magnitude.',
      'morphology is the catalogue "type" column in the ZCAT convention as published (numeric code stored as string; null if absent); sources of types differ (r_type) and many are crude.',
    ],
    units: {
      name: 'string, 2MASS XSC/LGA ID (catalogue ID)', raDeg: 'deg, J2000', decDeg: 'deg, J2000', czKms: 'km/s, redshift cz (c*z) corrected to the solar-system barycentre, as published',
      czErrKms: 'km/s, catalogue e_cz; null if unpublished', ksMag: 'mag, extinction-corrected 2MASS Ks (Kcmag)', morphology: 'string, ZCAT-convention type code (catalogue "type"); null allowed',
      ktMag: 'mag, extinction-corrected total extrapolated Ks (Ktmag)', glonDeg: 'deg, Galactic longitude', glatDeg: 'deg, Galactic latitude', czSource: 'string, catalogue n_cz code',
    },
  };
  await write({ manifest, columns: cols });
}

// ---- 4. open clusters (Hunt & Reffert 2023) ---------------------------------------------------------------------------------

async function buildOpenCluster(id: string, clusterName: string, label: string): Promise<void> {
  const base = `vizier_J_AA_673_A114_${clusterName}`;
  const members = await vizier(`${base}_members`, `-source=J/A+A/673/A114/members&-out.max=unlimited&Name==${clusterName}&-out.all=1`);
  const info = await vizier(`${base}_clusters`, `-source=J/A+A/673/A114/clusters&-out.max=unlimited&Name==${clusterName}&-out.all=1`);
  const t = parseTsv(members.text);
  const ci = parseTsv(info.text);
  if (ci.rows.length !== 1) throw new Error(`${clusterName}: expected 1 cluster row, got ${ci.rows.length}`);
  const crow = ci.rows[0] ?? [];
  const nStated = num(cell(crow, ci.col('N')));
  const ntStated = num(cell(crow, ci.col('Nt')));
  const distPc = num(cell(crow, ci.col('dist50')));
  const c = t.col.bind(t);
  const names = ['name', 'raDeg', 'decDeg', 'sourceId', 'gMag', 'bpRp', 'parallaxMas', 'pmraMasYr', 'pmdecMasYr', 'probability', 'insideTidalRadius', 'parallaxErrMas'];
  const cols = mkCols(names);
  for (const r of t.rows) {
    const gid = cell(r, c('GaiaDR3'));
    const ra = num(cell(r, c('RA_ICRS'))), dec = num(cell(r, c('DE_ICRS'))), g = num(cell(r, c('Gmag')));
    if (!gid || ra === null || dec === null || g === null) continue;
    push(cols, {
      name: `Gaia DR3 ${gid}`, raDeg: round(ra, 7), decDeg: round(dec, 7), sourceId: gid, gMag: round(g, 4),
      bpRp: num(cell(r, c('BP-RP'))) === null ? null : round(num(cell(r, c('BP-RP'))) as number, 4),
      parallaxMas: num(cell(r, c('Plx'))) === null ? null : round(num(cell(r, c('Plx'))) as number, 5),
      pmraMasYr: num(cell(r, c('pmRA'))) === null ? null : round(num(cell(r, c('pmRA'))) as number, 4),
      pmdecMasYr: num(cell(r, c('pmDE'))) === null ? null : round(num(cell(r, c('pmDE'))) as number, 4),
      probability: num(cell(r, c('Prob'))) === null ? null : round(num(cell(r, c('Prob'))) as number, 4),
      insideTidalRadius: cell(r, c('inrt')).startsWith('T') ? 1 : 0,
      parallaxErrMas: num(cell(r, c('e_Plx'))) === null ? null : round(num(cell(r, c('e_Plx'))) as number, 5),
    });
  }
  const count = cols['name']?.length ?? 0;
  const inside = (cols['insideTidalRadius'] as number[]).reduce((a, b) => a + b, 0);
  log(`${id}: ${t.rows.length} member rows, ${count} kept; catalogue N=${nStated}, Nt=${ntStated}, inside tidal radius in file=${inside}`);
  const manifest: PointCatalogueManifest = {
    id,
    title: `${label} members (Hunt & Reffert 2023, Gaia DR3)`,
    source: { source: 'vizier', release: 'J/A+A/673/A114 (Hunt & Reffert 2023, A&A 673, A114; bibcode 2023A&A...673A.114H); Gaia DR3', recordId: `J/A+A/673/A114/members, Name=${clusterName}`, url: 'https://cdsarc.cds.unistra.fr/viz-bin/cat/J/A+A/673/A114', retrieved: members.meta.retrievedAt },
    licence: LICENCE_VIZIER + ' Gaia data: ESA/Gaia/DPAC, CC BY-SA 3.0 IGO.',
    count,
    query: `VizieR ASU (asu-tsv): -source=J/A+A/673/A114/members Name==${clusterName} -out.max=unlimited -out.all=1 (mirror ${new URL(members.meta.url).host}); cluster summary from .../clusters Name==${clusterName}. All listed members kept (no probability cut).`,
    distanceBasis: 'per-object-parallax',
    caveats: [
      `Membership catalogue: Hunt & Reffert (2023), the "members" table, cluster Name = ${clusterName}. Membership is the catalogue's own (HDBSCAN clustering with a probability in column "Prob", stored as "probability"; it is a clustering-membership probability, not a calibrated Bayesian probability). The catalogue summary lists N = ${nStated} members, ${ntStated} of them within the tidal radius (column Nt); this file has ${count} rows, ${inside} flagged insideTidalRadius. We applied NO additional probability cut: the file keeps every listed member; filter on "probability" if wanted.`,
      'Individual parallaxes are used here as published by Gaia DR3 (parallaxMas, mas). For stars of an open cluster at this distance the parallaxes are good enough to place members in depth, but for faint members the parallax error (parallaxErrMas) can approach the cluster depth, so the line-of-sight scatter of the faintest stars is partly measurement noise. Gaia DR3 parallaxes carry a zero-point offset of order -0.02 to -0.04 mas that is not corrected here (values as published in the catalogue).',
      `The very brightest stars are missing or have poor astrometry (in this file the brightest member has G = ${Math.min(...(cols['gMag'] as number[]))}${clusterName === 'Melotte_22' ? '; e.g. Alcyone and Merope are absent' : clusterName === 'Melotte_25' ? '; e.g. Aldebaran (a foreground star, not a member) is not expected here' : ''}); a star only appears if it is in the catalogue and passed its membership analysis. The faintest member in the file has G = ${Math.max(...(cols['gMag'] as number[]))}; fainter members are not in the list.`,
      `Cluster-level summary from the same catalogue: median distance ${distPc === null ? 'unavailable' : distPc + ' pc'} (dist50).${clusterName === 'Melotte_25' ? ' The Hyades member list covers a large volume (the catalogue counts only ' + ntStated + ' of ' + nStated + ' within its tidal radius), so many listed members lie in the extended halo/tidal tails.' : ''}`,
      'Extra columns: insideTidalRadius (1 if the catalogue flag inrt is true) and parallaxErrMas (e_Plx).',
    ],
    units: {
      name: 'string, "Gaia DR3 <source_id>"', raDeg: 'deg, ICRS at epoch 2016.0 (Gaia DR3)', decDeg: 'deg, ICRS at epoch 2016.0', sourceId: 'string, Gaia DR3 source_id', gMag: 'mag, Gaia G',
      bpRp: 'mag, Gaia BP-RP; null if unavailable', parallaxMas: 'mas, Gaia DR3 parallax (no zero-point correction)', pmraMasYr: 'mas/yr, pmRA*cos(dec)', pmdecMasYr: 'mas/yr',
      probability: 'catalogue membership probability (Prob) in [0,1]', insideTidalRadius: '0/1, catalogue inrt flag', parallaxErrMas: 'mas, e_Plx',
    },
  };
  await write({ manifest, columns: cols });
}

// ---- 5. globular clusters (Vasiliev & Baumgardt 2021) --------------------------------------------------------------------------

const PROB_CUT = 0.9;
const MAX_ROWS = 20_000;

async function buildGlobular(id: string, zipName: string, label: string, vizierName: string): Promise<void> {
  const { buf, meta } = await binary('zenodo_4891252_clusters.zip', ZENODO_ZIP, 900_000);
  const text = zipEntry(buf, `catalogues/${zipName}.txt`).toString('utf8');
  const lines = text.split('\n');
  const head = (lines.find((l) => l.startsWith('#')) ?? '').replace(/^#/, '').trim().split(/\s+/);
  const ix = (n: string): number => { const i = head.indexOf(n); if (i < 0) throw new Error(`${zipName}: column ${n} missing in ${head.join(',')}`); return i; };
  const iId = ix('source_id'), iRa = ix('ra'), iDec = ix('dec'), iPlx = ix('plx'), iPmra = ix('pmra'), iPmde = ix('pmdec'), iPlxe = ix('plxe'), iG = ix('g_mag'), iBr = ix('bp_rp'), iQ = ix('qflag'), iP = ix('memberprob');
  type Rec = { id: string; ra: number; dec: number; plx: number | null; pmra: number | null; pmde: number | null; plxe: number | null; g: number; br: number | null; q: number; p: number };
  const recs: Rec[] = [];
  let total = 0, noG = 0;
  const na = (s: string | undefined): number | null => { if (s === undefined || s === '' || s.toLowerCase() === 'nan') return null; const v = Number(s); return Number.isFinite(v) ? v : null; };
  for (const line of lines) {
    if (!line.trim() || line.startsWith('#')) continue;
    total++;
    const f = line.trim().split(/\s+/);
    const p = na(f[iP]);
    if (p === null || p < PROB_CUT) continue;
    const g = na(f[iG]), ra = na(f[iRa]), dec = na(f[iDec]);
    if (g === null || ra === null || dec === null) { noG++; continue; }
    recs.push({ id: f[iId] ?? '', ra, dec, plx: na(f[iPlx]), pmra: na(f[iPmra]), pmde: na(f[iPmde]), plxe: na(f[iPlxe]), g, br: na(f[iBr]), q: na(f[iQ]) ?? -1, p });
  }
  const aboveCut = recs.length;
  recs.sort((a, b) => a.g - b.g);
  const kept = recs.slice(0, MAX_ROWS);
  const truncated = aboveCut > MAX_ROWS;
  const names = ['name', 'raDeg', 'decDeg', 'sourceId', 'gMag', 'bpRp', 'parallaxMas', 'pmraMasYr', 'pmdecMasYr', 'probability', 'qualityFlag', 'parallaxErrMas'];
  const cols = mkCols(names);
  for (const r of kept) {
    push(cols, {
      name: `Gaia EDR3 ${r.id}`, raDeg: round(r.ra, 6), decDeg: round(r.dec, 6), sourceId: r.id, gMag: round(r.g, 4), bpRp: r.br === null ? null : round(r.br, 4),
      parallaxMas: r.plx === null ? null : round(r.plx, 4), pmraMasYr: r.pmra === null ? null : round(r.pmra, 4), pmdecMasYr: r.pmde === null ? null : round(r.pmde, 4),
      probability: round(r.p, 5), qualityFlag: r.q, parallaxErrMas: r.plxe === null ? null : round(r.plxe, 4),
    });
  }
  const faintestG = kept.length ? (kept[kept.length - 1] as Rec).g : null;
  log(`${id}: ${total} Gaia sources in field, ${aboveCut} with probability >= ${PROB_CUT}, kept ${kept.length}${truncated ? ` (20000 brightest; faintest G=${faintestG})` : ''}`);
  const manifest: PointCatalogueManifest = {
    id,
    title: `${label} member stars (Vasiliev & Baumgardt 2021, Gaia EDR3)`,
    source: { source: 'zenodo', release: 'Vasiliev & Baumgardt 2021, MNRAS 505, 5978 (bibcode 2021MNRAS.505.5978V; VizieR J/MNRAS/505/5978); per-star catalogue = Zenodo record 4891252 (doi:10.5281/zenodo.4891252, published 2021-06-01, clusters.zip), Gaia EDR3', recordId: `catalogues/${zipName}.txt`, url: 'https://zenodo.org/records/4891252', retrieved: meta.retrievedAt },
    licence: 'Zenodo record licence CC-BY-4.0 (Vasiliev & Baumgardt 2021). Underlying Gaia EDR3: ESA/Gaia/DPAC, CC BY-SA 3.0 IGO.',
    count: kept.length,
    query: `Zenodo ${ZENODO_ZIP} -> catalogues/${zipName}.txt (${total} Gaia sources with 5/6-parameter astrometry in the field of ${label}). Selection (ours): memberprob >= ${PROB_CUT} (${aboveCut} stars)${truncated ? `; then the ${MAX_ROWS} brightest by G kept` : '; all kept (fewer than 20 000)'}. The VizieR J/MNRAS/505/5978 table (tablea1) holds cluster-level parameters only (cluster ${vizierName}), not per-star membership.`,
    distanceBasis: 'cluster-mean',
    caveats: [
      `Membership probabilities are the authors' (column memberprob, stored as "probability"), computed from Gaia EDR3 proper motions and parallaxes plus position. The cut probability >= ${PROB_CUT} is OUR choice (${aboveCut} of ${total} sources in the field pass). The set is incomplete in crowded cores (Gaia misses or degrades sources there) and contains a few field contaminants.`,
      truncated
        ? `Truncation (our choice): ${aboveCut} stars pass the cut, so only the ${MAX_ROWS} BRIGHTEST by G magnitude are kept (faintest G in the file = ${faintestG}). This biases the sample toward bright giants and horizontal-branch stars and makes the cluster look less dense in faint stars, especially in the core, than the full member list.`
        : `All ${aboveCut} stars passing the cut are kept (under the 20 000 cap), so no brightness truncation applies.`,
      'Per-member parallaxes of globular clusters (several kpc away: parallax of order 0.1-0.2 mas against errors of 0.02-0.3 mas, plus a systematic zero-point) are far too imprecise to place individual stars in depth, so this file carries NO measured line-of-sight position per star (distanceBasis cluster-mean means: the only measured distance is the single cluster-mean distance in the object record). A renderer that spreads the stars in depth must label that spread ILLUSTRATIVE: the Atlas draws each star at a deterministic hash-of-source_id offset from the cluster-mean distance, drawn from a Plummer-like profile scaled by the projected half-light radius; those offsets are not measurements. ra/dec, magnitudes, colours and proper motions are the catalogue data.',
      'Parallaxes here are the catalogue values "corrected for zero-point offset using the Lindegren et al. prescription" (per the catalogue readme); proper motions are Gaia EDR3 values (epoch 2016.0). qualityFlag is the catalogue qflag bit-field (lowest bit: 5-parameter solution; next bit: passed all quality filters).',
    ],
    units: {
      name: 'string, "Gaia EDR3 <source_id>"', raDeg: 'deg, ICRS (Gaia EDR3, epoch 2016.0)', decDeg: 'deg', sourceId: 'string, Gaia source_id (EDR3 = DR3 ids)', gMag: 'mag, Gaia G',
      bpRp: 'mag, Gaia BP-RP; null if unavailable', parallaxMas: 'mas, zero-point-corrected parallax (Lindegren et al. prescription, as in the source file)', pmraMasYr: 'mas/yr, pmra*cos(dec)', pmdecMasYr: 'mas/yr',
      probability: 'authors\' membership probability memberprob in [0,1]', qualityFlag: 'integer bit-field qflag (see caveats)', parallaxErrMas: 'mas, plxe',
    },
  };
  await write({ manifest, columns: cols });
}

// ---- main ----------------------------------------------------------------------------------------------------------------------------

const JOBS: [string, () => Promise<void>][] = [
  ['local-group-mcconnachie', buildMcConnachie],
  ['ungc', buildUngc],
  ['twomrs', buildTwomrs],
  ['members-pleiades', () => buildOpenCluster('members-pleiades', 'Melotte_22', 'Pleiades (M45, Melotte 22)')],
  ['members-hyades', () => buildOpenCluster('members-hyades', 'Melotte_25', 'Hyades (Melotte 25)')],
  ['members-omega-centauri', () => buildGlobular('members-omega-centauri', 'NGC_5139_oCen', 'Omega Centauri (NGC 5139)', 'NGC 5139')],
  ['members-m13', () => buildGlobular('members-m13', 'NGC_6205_M_13', 'M13 (NGC 6205)', 'NGC 6205')],
  ['members-47-tucanae', () => buildGlobular('members-47-tucanae', 'NGC_104_47Tuc', '47 Tucanae (NGC 104)', 'NGC 104')],
  ['members-m4', () => buildGlobular('members-m4', 'NGC_6121_M_4', 'M4 (NGC 6121)', 'NGC 6121')],
];

async function main(): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  try { await stat(CACHE_DIR); } catch { /* created above */ }
  let failed = 0;
  for (const [id, fn] of JOBS) {
    if (ONLY && !ONLY.has(id)) continue;
    try { await fn(); } catch (e) { failed++; console.error(`[catalogues] FAILED ${id}: ${(e as Error).message}`); }
  }
  if (failed) process.exitCode = 1;
}
void main();
