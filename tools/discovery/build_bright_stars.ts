/**
 * Builds public/data/bright-stars.v1.json.gz (type BrightStarFile, src/discovery/types.ts) and docs/DISCOVERY_DATA_STARS.md.
 *
 *   npx tsx tools/discovery/build_bright_stars.ts            fetch what is not cached, then build
 *   npx tsx tools/discovery/build_bright_stars.ts --offline  rebuild from data/cache/discovery/stars only (fails on a cache miss)
 *
 * Why: Gaia DR3 has no usable astrometry for stars brighter than G ~ 1.5 (Sirius, Vega, Betelgeuse, ...), so the atlas needs a
 * Hipparcos supplement. Sources (all retrieved live, cached verbatim):
 *   astrometry   VizieR I/311/hip2   Hipparcos new reduction (van Leeuwen 2007), epoch J1991.25, ICRS
 *   photometry   VizieR I/239/hip_main  Vmag, B-V, SpType, variability (ESA 1997)
 *   names        IAU WGSN IAU-CSN.txt
 *   identifiers  SIMBAD TAP (ident table)
 * Selection: Vmag <= 6.5 (hip_main)  UNION  every IAU-WGSN named star that carries a HIP number.
 * Gaia de-duplication: see matchGaia() below.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { BrightStarFile } from '../../src/discovery/types';
import { DiscoveryCache, ROOT } from './lib/cache';
import { loadGaiaSubset } from './lib/gaiaSubset';
import { IAU_CSN_URL, parseIauCsn } from './lib/iau';
import { simbadQuery, tidyId, SIMBAD_TAP } from './lib/simbad';
import { num, VIZIER_README, vizier } from './lib/vizier';

const OFFLINE = process.argv.includes('--offline');
const cache = new DiscoveryCache('stars', OFFLINE);
const log = (m: string) => console.log(`[bright-stars] ${m}`);
const OUT = join(ROOT, 'public', 'data', 'bright-stars.v1.json.gz');
const DOC = join(ROOT, 'docs', 'DISCOVERY_DATA_STARS.md');

const V_LIMIT = 6.5;
const HIP_EPOCH = 1991.25;
const GAIA_EPOCH = 2016.0;
const MATCH_RADIUS_ARCSEC = 3;
const MATCH_SIGMA = 5;
const MATCH_FRACTION = 0.1;
const GOOD_PLX_SNR = 10;

const chunk = <T>(a: T[], n: number): T[][] => { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const round = (x: number, d: number) => { const k = 10 ** d; return Math.round(x * k) / k; };

const HIPMAIN_OUT = 'HIP,Vmag,VarFlag,B-V,SpType,Hpmag,Hpmax,HPmin,Period,HvarType,HD';
const HIP2_OUT = 'HIP,RArad,DErad,Plx,e_Plx,pmRA,e_pmRA,pmDE,e_pmDE,Sn,F2';

interface MainRow { hip: number; vMag: number | null; varFlag: string; bv: number | null; spType: string | null; hpMag: number | null; hpMax: number | null; hpMin: number | null; period: number | null; varType: string }
interface AstRow { raDeg: number; decDeg: number; plx: number | null; plxErr: number | null; pmra: number | null; pmraErr: number | null; pmde: number | null; pmdeErr: number | null; sn: string; f2: number | null }

async function main(): Promise<void> {
  const dropped: { what: string; why: string }[] = [];
  const retrievals: Record<string, string> = {};

  // ---- 1. Hipparcos main catalogue: Vmag <= 6.5 ------------------------------------------------------------------------------
  const bright = await vizier(cache, 'I/239/hip_main', { Vmag: `<=${V_LIMIT}` }, HIPMAIN_OUT, 'hip_main V<=6.5');
  retrievals['hip_main'] = bright.retrieved;
  log(`hip_main rows with Vmag <= ${V_LIMIT}: ${bright.rows.length}`);
  const toMain = (r: Record<string, string>): MainRow => ({
    hip: Number(r['HIP']), vMag: num(r['Vmag']), varFlag: r['VarFlag'] ?? '', bv: num(r['B-V']), spType: (r['SpType'] ?? '') === '' ? null : r['SpType']!,
    hpMag: num(r['Hpmag']), hpMax: num(r['Hpmax']), hpMin: num(r['HPmin']), period: num(r['Period']), varType: r['HvarType'] ?? '',
  });
  const main = new Map<number, MainRow>();
  for (const r of bright.rows) main.set(Number(r['HIP']), toMain(r));

  // ---- 2. IAU WGSN names -----------------------------------------------------------------------------------------------------
  const csnText = await cache.get(IAU_CSN_URL, {}, 'IAU-CSN', (t) => { if (!/IAU Catalog of Star Names/.test(t)) throw new Error('IAU-CSN: unexpected content'); });
  const csn = parseIauCsn(csnText);
  retrievals['iau-csn'] = cache.retrieved('GET', IAU_CSN_URL) ?? 'unknown';
  log(`IAU-CSN: ${csn.names.length} names, last updated ${csn.lastUpdated}`);
  const namesByHip = new Map<number, { name: string; ascii: string; designation: string }[]>();
  let namedWithHip = 0;
  for (const n of csn.names) {
    if (n.hip === null) { dropped.push({ what: `IAU name "${n.name}" (${n.designation})`, why: 'no HIP number in the IAU-CSN table; a Hipparcos record cannot be attached' }); continue; }
    namedWithHip++;
    const a = namesByHip.get(n.hip) ?? [];
    a.push({ name: n.name, ascii: n.nameAscii, designation: n.designation });
    namesByHip.set(n.hip, a);
  }
  log(`IAU names with a HIP number: ${namedWithHip} (distinct HIP ${namesByHip.size}); without: ${csn.names.length - namedWithHip}`);

  // ---- 3. Hipparcos main rows for named stars fainter than the V limit ---------------------------------------------------------------
  const extra = [...namesByHip.keys()].filter((h) => !main.has(h)).sort((a, b) => a - b);
  for (const part of chunk(extra, 200)) {
    const t = await vizier(cache, 'I/239/hip_main', { HIP: part.join(',') }, HIPMAIN_OUT, `hip_main named extras ${part[0]}..`);
    for (const r of t.rows) main.set(Number(r['HIP']), toMain(r));
  }
  const missingMain = extra.filter((h) => !main.has(h));
  for (const h of missingMain) dropped.push({ what: `HIP ${h} (${namesByHip.get(h)!.map((x) => x.name).join(', ')})`, why: 'IAU-named but absent from the Hipparcos main catalogue I/239/hip_main' });
  log(`named stars outside V<=${V_LIMIT}: ${extra.length} (absent from hip_main: ${missingMain.length})`);

  // ---- 4. Hipparcos new reduction astrometry for the union ---------------------------------------------------------------------------
  const wanted = [...main.keys()].sort((a, b) => a - b);
  const ast = new Map<number, AstRow>();
  for (const part of chunk(wanted, 400)) {
    const t = await vizier(cache, 'I/311/hip2', { HIP: part.join(',') }, HIP2_OUT, `hip2 ${part[0]}..`);
    retrievals['hip2'] = t.retrieved;
    for (const r of t.rows) {
      const ra = num(r['RArad']), de = num(r['DErad']);
      if (ra === null || de === null) continue;
      ast.set(Number(r['HIP']), { raDeg: ra, decDeg: de, plx: num(r['Plx']), plxErr: num(r['e_Plx']), pmra: num(r['pmRA']), pmraErr: num(r['e_pmRA']), pmde: num(r['pmDE']), pmdeErr: num(r['e_pmDE']), sn: r['Sn'] ?? '', f2: num(r['F2']) });
    }
  }
  const noAst = wanted.filter((h) => !ast.has(h));
  for (const h of noAst) dropped.push({ what: `HIP ${h}`, why: 'selected (V<=6.5 or IAU name) but has no row in the new reduction I/311/hip2, so no new-reduction astrometry' });
  const stars = wanted.filter((h) => ast.has(h));
  log(`selected ${wanted.length}, with hip2 astrometry ${stars.length}, dropped for no hip2 row ${noAst.length}`);

  // ---- 5. SIMBAD identifiers ---------------------------------------------------------------------------------------------------------
  interface Sim { mainId: string; otype: string; ids: string[] }
  const sim = new Map<number, Sim>();
  for (const part of chunk(stars, 250)) {
    const list = part.map((h) => `'HIP ${h}'`).join(',');
    const q = `SELECT i1.id AS q, b.main_id, b.otype, i2.id AS ident FROM ident AS i1 JOIN ident AS i2 ON i1.oidref=i2.oidref JOIN basic AS b ON b.oid=i1.oidref WHERE i1.id IN (${list})`;
    const res = await simbadQuery(cache, q, `SIMBAD idents ${part[0]}..`);
    retrievals['simbad'] = res.retrieved;
    const iq = res.header.indexOf('q'), im = res.header.indexOf('main_id'), io = res.header.indexOf('otype'), ii = res.header.indexOf('ident');
    if ([iq, im, io, ii].some((x) => x < 0)) throw new Error(`SIMBAD: unexpected header ${res.header.join(',')}`);
    for (const r of res.rows) {
      const hip = Number(tidyId(r[iq]!).replace(/^HIP /, ''));
      const e = sim.get(hip) ?? { mainId: tidyId(r[im]!), otype: r[io]!, ids: [] };
      e.ids.push(tidyId(r[ii]!));
      sim.set(hip, e);
    }
  }
  const noSim = stars.filter((h) => !sim.has(h));
  log(`SIMBAD identifier lists: ${sim.size}/${stars.length} stars (no SIMBAD row: ${noSim.length})`);

  // ---- 6. Gaia de-duplication ---------------------------------------------------------------------------------------------------------
  const gaia = loadGaiaSubset();
  const order = [...Array(gaia.n).keys()].filter((i) => gaia.ra[i] !== null && gaia.dec[i] !== null).sort((a, b) => gaia.dec[a]! - gaia.dec[b]!);
  const decSorted = order.map((i) => gaia.dec[i]!);
  const lowerBound = (x: number) => { let lo = 0, hi = decSorted.length; while (lo < hi) { const m = (lo + hi) >> 1; if (decSorted[m]! < x) lo = m + 1; else hi = m; } return lo; };
  const D = Math.PI / 180;
  const sepArcsec = (ra1: number, d1: number, ra2: number, d2: number) => {
    const s = Math.sin(((d2 - d1) * D) / 2) ** 2 + Math.cos(d1 * D) * Math.cos(d2 * D) * Math.sin(((ra2 - ra1) * D) / 2) ** 2;
    return (2 * Math.asin(Math.min(1, Math.sqrt(s))) / D) * 3600;
  };
  const gaiaByHip = new Map<number, number[]>();
  for (let i = 0; i < gaia.n; i++) { const h = gaia.hipId[i]; if (h !== null && h !== undefined) { const a = gaiaByHip.get(h) ?? []; a.push(i); gaiaByHip.set(h, a); } }

  type Basis = 'hip_id' | 'hip_id-no-gaia-parallax' | 'position' | 'simbad-gaia-id';
  interface Match { gi: number; basis: Basis; sepArcsec: number }
  const matches = new Map<number, Match>();
  const issues: string[] = [];
  const stat = { byHipId: 0, byHipIdNoPlx: 0, byPosition: 0, bySimbadId: 0, hipIdFailed: 0, none: 0, noPosCand: 0, conflicts: 0 };
  const simbadGaia = (hip: number): string | null => { const id = sim.get(hip)?.ids.find((x) => x.startsWith('Gaia DR3 ')); return id ? id.slice('Gaia DR3 '.length) : null; };
  let simbadAgree = 0, simbadDisagree = 0;
  const hipIdFailures: string[] = [];

  for (const hip of stars) {
    const a = ast.get(hip)!;
    const dt = GAIA_EPOCH - HIP_EPOCH;
    const cosd = Math.cos(a.decDeg * D);
    const ra2 = a.raDeg + (a.pmra !== null ? (a.pmra * dt) / (3.6e6 * cosd) : 0);
    const de2 = a.decDeg + (a.pmde !== null ? (a.pmde * dt) / 3.6e6 : 0);
    const window = (MATCH_RADIUS_ARCSEC / 3600) * 1.01;
    const cands: { gi: number; sep: number; plxOk: boolean | null }[] = [];
    for (let k = lowerBound(de2 - window); k < order.length && decSorted[k]! <= de2 + window; k++) {
      const gi = order[k]!;
      const sep = sepArcsec(ra2, de2, gaia.ra[gi]!, gaia.dec[gi]!);
      if (sep >= MATCH_RADIUS_ARCSEC) continue;
      const gp = gaia.parallax[gi], ge = gaia.parallaxError[gi];
      let plxOk: boolean | null = null;
      if (gp !== null && gp !== undefined && a.plx !== null && a.plxErr !== null) {
        const d = Math.abs(gp - a.plx);
        const sigma = Math.hypot(a.plxErr, ge ?? 0);
        plxOk = d <= MATCH_SIGMA * sigma || d <= MATCH_FRACTION * Math.abs(a.plx);
      }
      cands.push({ gi, sep, plxOk });
    }
    const byId = (gaiaByHip.get(hip) ?? []).map((gi) => cands.find((c) => c.gi === gi)).filter((c): c is NonNullable<typeof c> => !!c);
    let chosen: Match | null = null;
    const hipIdRows = gaiaByHip.get(hip) ?? [];
    const idOk = byId.filter((c) => c.plxOk === true).sort((x, y) => x.sep - y.sep)[0];
    const idNoPlx = byId.filter((c) => c.plxOk === null).sort((x, y) => x.sep - y.sep)[0];
    if (idOk) { chosen = { gi: idOk.gi, basis: 'hip_id', sepArcsec: idOk.sep }; stat.byHipId++; }
    else if (idNoPlx) { chosen = { gi: idNoPlx.gi, basis: 'hip_id-no-gaia-parallax', sepArcsec: idNoPlx.sep }; stat.byHipIdNoPlx++; }
    else {
      if (hipIdRows.length > 0) { stat.hipIdFailed++; hipIdFailures.push(`HIP ${hip}: Gaia best-neighbour rows ${hipIdRows.map((gi) => `${gaia.sourceId[gi]} (G=${gaia.gMag[gi] ?? 'n/a'}, plx=${gaia.parallax[gi] ?? 'n/a'})`).join(', ')} fail the position/parallax checks`); }
      const alt = cands.filter((c) => c.plxOk === true).sort((x, y) => x.sep - y.sep);
      if (alt.length === 1) { chosen = { gi: alt[0]!.gi, basis: 'position', sepArcsec: alt[0]!.sep }; stat.byPosition++; }
      else {
        // Independent corroboration: SIMBAD's own Gaia DR3 identifier for this HIP star names a candidate that is within the radius.
        // Needed because Hipparcos parallax errors for bright stars are often too small (true matches fail the sigma test) and
        // because bright Gaia sources can be 2-parameter solutions with no parallax.
        const sg = simbadGaia(hip);
        const viaSimbad = sg ? cands.find((c) => gaia.sourceId[c.gi] === sg) : undefined;
        if (viaSimbad) { chosen = { gi: viaSimbad.gi, basis: 'simbad-gaia-id', sepArcsec: viaSimbad.sep }; stat.bySimbadId++; }
        else if (alt.length > 1) issues.push(`HIP ${hip}: ${alt.length} Gaia candidates pass the checks without a hip_id link (${alt.map((c) => gaia.sourceId[c.gi]).join(', ')}); not linked`);
        else { stat.none++; if (cands.length === 0) stat.noPosCand++; }
      }
    }
    if (chosen) matches.set(hip, chosen);
  }
  // one Gaia record must not be claimed by two Hipparcos stars
  const claimed = new Map<number, number[]>();
  for (const [hip, m] of matches) { const a = claimed.get(m.gi) ?? []; a.push(hip); claimed.set(m.gi, a); }
  for (const [gi, hips] of claimed) {
    if (hips.length < 2) continue;
    stat.conflicts++;
    hips.sort((x, y) => matches.get(x)!.sepArcsec - matches.get(y)!.sepArcsec);
    issues.push(`Gaia ${gaia.sourceId[gi]} claimed by HIP ${hips.join(', ')}; kept the nearest (HIP ${hips[0]}), unlinked the rest`);
    for (const h of hips.slice(1)) matches.delete(h);
  }
  for (const [hip, m] of matches) {
    const sg = simbadGaia(hip);
    if (sg) { if (sg === gaia.sourceId[m.gi]) simbadAgree++; else simbadDisagree++; }
  }
  log(`Gaia links: ${matches.size}/${stars.length} (hip_id ${stat.byHipId}, hip_id without Gaia parallax ${stat.byHipIdNoPlx}, position-only ${stat.byPosition}, SIMBAD-id ${stat.bySimbadId}); hip_id links failing the checks: ${stat.hipIdFailed}; unlinked ${stars.length - matches.size}`);
  log(`SIMBAD Gaia DR3 id agrees with our link: ${simbadAgree}, disagrees: ${simbadDisagree}`);

  // ---- 7. assemble columns ---------------------------------------------------------------------------------------------------------------
  const VAR_TYPE: Record<string, string> = { C: 'no variability detected', D: 'duplicity-induced variability', M: 'possibly micro-variable (amplitude < 0.03 mag)', P: 'periodic variable', R: 'V-I colour index revised due to variability analysis', U: 'unsolved variable' };
  const VAR_FLAG: Record<string, string> = { '1': '< 0.06 mag', '2': '0.06-0.6 mag', '3': '> 0.6 mag' };
  const variability = (m: MainRow): string | null => {
    const parts: string[] = [];
    if (m.varType) parts.push(`${VAR_TYPE[m.varType] ?? m.varType} [Hipparcos type ${m.varType}]`);
    if (m.period !== null) parts.push(`period ${m.period} d`);
    if (m.varFlag) parts.push(`coarse amplitude class ${m.varFlag}: ${VAR_FLAG[m.varFlag] ?? '?'}`);
    if (m.hpMax !== null && m.hpMin !== null && m.varType !== 'C') parts.push(`Hp ${m.hpMax}-${m.hpMin} mag (5th-95th percentile)`);
    return parts.length ? parts.join('; ') : null;
  };
  const KEEP = /^(NAME |\* |V\* |HD |HR |HIP |BD[+-]|CD[-+]|CPD[-+]|GJ |Gl |Gaia DR3 |SAO )/;
  const cols: Record<string, (number | string | null)[]> = {};
  const names = ['hip', 'raDeg', 'decDeg', 'parallaxMas', 'parallaxErrMas', 'pmraMasYr', 'pmdecMasYr', 'vMag', 'bvColour', 'spectralType', 'variability', 'iauName', 'designations', 'gaiaSourceId',
    'parallaxQuality', 'pmraErrMasYr', 'pmdecErrMasYr', 'gaiaMatchBasis', 'simbadMainId', 'simbadOtype'];
  for (const n of names) cols[n] = [];
  const push = (n: string, v: number | string | null) => cols[n]!.push(v);
  let iauNamed = 0, poor = 0, good = 0;
  for (const hip of stars) {
    const a = ast.get(hip)!, m = main.get(hip)!, s = sim.get(hip);
    const iau = namesByHip.get(hip);
    const des: string[] = [];
    const seen = new Set<string>();
    const add = (x: string) => { const t = x.trim(); if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); des.push(t); } };
    if (iau) for (const n of iau) { add(n.name); add(n.ascii); }
    add(`HIP ${hip}`);

    for (const id of s?.ids ?? []) {
      if (!KEEP.test(id)) continue;
      add(id.replace(/^NAME /, '').replace(/^\* /, ''));
    }
    if (iau) for (const n of iau) if (n.designation) add(n.designation);
    const snr = a.plx !== null && a.plxErr !== null && a.plxErr > 0 ? a.plx / a.plxErr : null;
    const quality = snr !== null && snr >= GOOD_PLX_SNR ? 'good' : 'poor';
    if (quality === 'good') good++; else poor++;
    const g = matches.get(hip);
    push('hip', hip); push('raDeg', a.raDeg); push('decDeg', a.decDeg); push('parallaxMas', a.plx); push('parallaxErrMas', a.plxErr);
    push('pmraMasYr', a.pmra); push('pmdecMasYr', a.pmde); push('vMag', m.vMag); push('bvColour', m.bv); push('spectralType', m.spType);
    push('variability', variability(m)); push('iauName', iau ? iau.map((n) => n.name).join(' / ') : null); if (iau) iauNamed++;
    push('designations', des.join('|')); push('gaiaSourceId', g ? gaia.sourceId[g.gi]! : null);
    push('parallaxQuality', quality); push('pmraErrMasYr', a.pmraErr); push('pmdecErrMasYr', a.pmdeErr);
    push('gaiaMatchBasis', g ? g.basis : null); push('simbadMainId', s?.mainId ?? null); push('simbadOtype', s?.otype ?? null);
  }
  const count = stars.length;
  const bigPlxGap = stars.filter((h) => { const m = matches.get(h); if (!m) return false; const gp = gaia.parallax[m.gi], ge = gaia.parallaxError[m.gi], a = ast.get(h)!; if (gp === null || gp === undefined || a.plx === null || a.plxErr === null) return false; const d = Math.abs(gp - a.plx); return d > MATCH_SIGMA * Math.hypot(a.plxErr, ge ?? 0) && d > MATCH_FRACTION * Math.abs(a.plx); }).length;

  // ---- 8. manifest + write ---------------------------------------------------------------------------------------------------------------
  const readme239 = await cache.get(VIZIER_README('I/239'), {}, 'I/239 ReadMe');
  const readme311 = await cache.get(VIZIER_README('I/311'), {}, 'I/311 ReadMe');
  const lic = /License:\s*([^\n]+)/.exec(readme239)?.[1]?.trim() ?? 'unknown';
  const ack = /Acknowledgements:\s*\n([\s\S]*?)\n\s*\nReferences:/.exec(readme311)?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
  const ref = /References:\s*\n([\s\S]*?)\n\s*\nHistory:/.exec(readme311)?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
  const iauHeader = 'For use of the contents of the data of this file, we encourage users to cite the official IAU version of the data at: https://www.iau.org/public/themes/naming_stars/. At times there may be a time delay between the posting of names in this file and what is posted on the IAU website. All IAU-produced products (Images, Videos, Texts) are released under Creative Commons Attribution (i.e. free to use in all perpetuity, world-wide, as long as the source is mentioned).';
  if (!csnText.replace(/\s+/g, ' ').replace(/#\s*/g, '').includes('free to use in all perpetuity')) throw new Error('IAU-CSN licence sentence not found; the quoted text must be re-checked');
  const sirius = stars.indexOf(32349);
  const betel = stars.indexOf(27989);
  const betelDist = betel >= 0 && cols['parallaxMas']![betel] ? round(1000 / (cols['parallaxMas']![betel] as number), 0) : null;
  const today = new Date().toISOString().slice(0, 10);
  const file: BrightStarFile = {
    manifest: {
      id: 'bright-stars-hipparcos',
      title: 'Hipparcos bright-star supplement (V <= 6.5 plus IAU-named stars)',
      source: {
        source: 'Hipparcos new reduction (van Leeuwen 2007, VizieR I/311/hip2) for astrometry; Hipparcos main catalogue (ESA 1997, VizieR I/239/hip_main) for Vmag, B-V, spectral type, variability; IAU WGSN IAU-CSN for names; SIMBAD for identifiers',
        release: `I/311/hip2 (CDS, 2008); I/239/hip_main (ESA 1997); IAU-CSN last updated ${csn.lastUpdated}; SIMBAD queried ${retrievals['simbad']}`,
        url: 'https://cdsarc.cds.unistra.fr/viz-bin/cat/I/311',
        retrieved: [retrievals['hip2'], retrievals['hip_main'], retrievals['iau-csn'], retrievals['simbad']].filter(Boolean).sort().at(-1)!,
      },
      licence: `CDS/VizieR tables. I/239 ReadMe (vizier.cfa.harvard.edu/ftp/cats/I/239/ReadMe) states: "License: ${lic}" (the ESA Hipparcos catalogue; non-commercial terms apply, check before any commercial use). I/311 ReadMe acknowledgement: "${ack}"; reference: "${ref}". VizieR response headers give rights_uri=https://cds.unistra.fr/vizier-org/licences_vizier.html, which returned a 404 "Page unavailable" page when fetched on ${today}, so the CDS acknowledgement text itself was NOT retrieved; cite VizieR (Ochsenbein et al. 2000) and SIMBAD (Wenger et al. 2000) as usual. SIMBAD terms page was not fetched. IAU-CSN header, quoted: "${iauHeader}"`,
      query: [
        `VizieR asu-tsv ${bright.params['-source']} Vmag<=${V_LIMIT} -out=${HIPMAIN_OUT} (selection by Johnson V of the main catalogue)`,
        `VizieR asu-tsv I/239/hip_main HIP=<IAU-named HIP numbers with Vmag>${V_LIMIT}> (${extra.length} stars)`,
        `VizieR asu-tsv I/311/hip2 HIP=<union of both> -out=${HIP2_OUT}`,
        `SIMBAD TAP ${SIMBAD_TAP}: SELECT i1.id, b.main_id, b.otype, i2.id FROM ident i1 JOIN ident i2 ON i1.oidref=i2.oidref JOIN basic b ON b.oid=i1.oidref WHERE i1.id IN ('HIP n', ...)`,
        `${IAU_CSN_URL} (454-line fixed-width table; name from columns 1-2, HIP from column 11)`,
        `Gaia de-duplication against public/data/gaia-dr3-subset.v1.json.gz (built ${gaia.manifestBuiltAt}); see caveats`,
      ].join('\n'),
      count,
      caveats: [
        `Selection: every Hipparcos star with Johnson V <= ${V_LIMIT} (naked-eye limit, our choice) UNION every IAU-WGSN-named star that has a HIP number (${extra.length} of them are fainter than V=${V_LIMIT}). This is the set of Hipparcos entries meeting that rule, not a claim that every naked-eye star is present: stars the Hipparcos catalogue lacks are absent.`,
        `Astrometric epoch is J1991.25 (ICRS). Positions are NOT propagated: apply proper motion before drawing at another epoch (the Gaia match below propagates to J2016.0 with linear motion).`,
        `Distance is NOT stored; invert parallax only when parallaxQuality is 'good' (parallax/error >= ${GOOD_PLX_SNR}). ${poor} of ${count} stars are 'poor'. Betelgeuse-like stars (extended red supergiants whose discs are resolved) have a large formal parallax uncertainty and a 1/parallax distance is not reliable for them: the Hipparcos new reduction gives Betelgeuse ${betel >= 0 ? `${cols['parallaxMas']![betel]} +- ${cols['parallaxErrMas']![betel]} mas (1/parallax = ${betelDist} pc, ${(cols['parallaxMas']![betel] as number) / (cols['parallaxErrMas']![betel] as number) >= GOOD_PLX_SNR ? 'good' : 'poor'} quality)` : '(not in file)'}; treat its distance as uncertain.`,
        `${stars.filter((h) => (ast.get(h)!.plx ?? 0) < 0).length} stars have a negative catalogue parallax (an unphysical value from a noisy or poorly fitting solution, e.g. HIP 26220 = theta1 Ori in the Trapezium: -52.82 +- 33.69 mas, goodness-of-fit F2 = 99.00 in I/311). They are kept as published and have parallaxQuality 'poor'; never convert them to a distance.`,
        'Vmag, B-V, spectral type and variability come from the 1997 main catalogue, not the new reduction. For multiple systems the photometry may refer to the combined light (CombMag) or to a component; the astrometry refers to the photocentre or a component as flagged in the source (AstroRef), which this file does not carry.',
        `variability: text built from the main-catalogue fields HvarType (C/D/M/P/R/U meanings quoted from the I/239 ReadMe), Period, VarFlag amplitude class (1: <0.06 mag, 2: 0.06-0.6 mag, 3: >0.6 mag) and Hpmax/HPmin; null = no variability information in the source. VarFlag/Hp ranges are in the Hipparcos Hp band, not V.`,
        `Gaia link (gaiaSourceId): a Hipparcos star is linked to a Gaia subset record only when (a) the record's hip_id (Gaia's best-neighbour match, which can be wrong) points at it, or failing that a unique record exists, and (b) the Hipparcos position propagated to J2016.0 with the Hipparcos proper motion lies < ${MATCH_RADIUS_ARCSEC} arcsec from the Gaia position, and (c) parallaxes agree within ${MATCH_SIGMA} combined sigma or ${MATCH_FRACTION * 100} percent. gaiaMatchBasis: 'hip_id' = all of that; 'hip_id-no-gaia-parallax' = hip_id and position agree but Gaia has no parallax to test (the parallax check could not be applied); 'position' = no hip_id link but exactly one Gaia record passes (b) and (c); 'simbad-gaia-id' = SIMBAD's own Gaia DR3 identifier for the star names a Gaia record within ${MATCH_RADIUS_ARCSEC} arcsec, used when the parallax test fails (Hipparcos parallax errors for bright stars are often too small, so true matches can differ by more than 5 sigma and by more than 10 percent) or when there is no hip_id link and Gaia has no parallax to test; the parallax condition (c) is NOT satisfied for these links, the position condition (b) is. null = no Gaia record in the subset; the Hipparcos record is then the only drawn one.`,
        `Counts: ${matches.size} linked (hip_id ${stat.byHipId}, hip_id-no-gaia-parallax ${stat.byHipIdNoPlx}, position ${stat.byPosition}, simbad-gaia-id ${stat.bySimbadId}); ${count - matches.size} not linked; ${stat.hipIdFailed} Gaia best-neighbour links failed the strict checks (some of these were then linked via simbad-gaia-id).`,
        `IAU names without a HIP number cannot be attached (${dropped.filter((d) => d.what.startsWith('IAU name')).length} names, listed in docs/DISCOVERY_DATA_STARS.md). ${iauNamed} stars in this file carry an IAU name.`,
        'designations are SIMBAD identifiers filtered to common stellar catalogues (names, Bayer/Flamsteed with the leading "* " removed, V*, HD, HR, HIP, BD/CD/CPD, GJ/Gl, SAO, Gaia DR3) plus the IAU names; whitespace collapsed; separated by "|". SIMBAD identifiers can attach to the system rather than to this component.',
        `Observed in this build: for ${bigPlxGap} stars the Hipparcos and Gaia parallaxes differ by more than ${MATCH_SIGMA} combined sigma AND more than ${MATCH_FRACTION * 100} percent although the propagated positions agree within ${MATCH_RADIUS_ARCSEC} arcsec, so Hipparcos formal parallax errors should not be read as the whole uncertainty. The Hipparcos Sn/F2 solution flags are in the source (I/311) but not carried here.`,
      ],
      units: {
        raDeg: 'degrees ICRS, epoch J1991.25', decDeg: 'degrees ICRS, epoch J1991.25', parallaxMas: 'mas', parallaxErrMas: 'mas (1-sigma)', pmraMasYr: 'mas/yr (mu_alpha* = mu_alpha cos delta)', pmdecMasYr: 'mas/yr',
        pmraErrMasYr: 'mas/yr (1-sigma)', pmdecErrMasYr: 'mas/yr (1-sigma)', vMag: 'mag (Johnson V)', bvColour: 'mag (Johnson B-V)', spectralType: 'MK type as published',
        variability: 'text', iauName: 'text (IAU WGSN, diacritics form; " / " separates multiple names for one HIP)', designations: 'text, "|" separated', gaiaSourceId: 'Gaia DR3 source_id as string or null',
        parallaxQuality: "'good' parallax/error >= 10, else 'poor'", gaiaMatchBasis: "'hip_id' | 'hip_id-no-gaia-parallax' | 'position' | 'simbad-gaia-id' | null", simbadMainId: 'text', simbadOtype: 'SIMBAD object type code',
      },
      astrometricEpoch: 'J1991.25 (ICRS)',
      nameSource: `IAU Working Group on Star Names, IAU Catalog of Star Names (IAU-CSN.txt, last updated ${csn.lastUpdated}), ${IAU_CSN_URL}, retrieved ${retrievals['iau-csn']}`,
    },
    columns: cols,
  };
  // optional manifest additions (documented; consumers may ignore)
  const extraManifest = {
    selection: { vLimit: V_LIMIT, hipMainVmagRows: bright.rows.length, iauNamedWithHip: namesByHip.size, iauNamedFainter: extra.length, selected: wanted.length, written: count },
    gaiaDedupe: { ...stat, linked: matches.size, unlinked: count - matches.size, simbadGaiaAgree: simbadAgree, simbadGaiaDisagree: simbadDisagree, radiusArcsec: MATCH_RADIUS_ARCSEC, sigma: MATCH_SIGMA, fraction: MATCH_FRACTION, gaiaEpoch: GAIA_EPOCH },
    dropped: dropped.length,
  };
  Object.assign(file.manifest, extraManifest);
  mkdirSync(join(ROOT, 'public', 'data'), { recursive: true });
  const json = JSON.stringify(file);
  writeFileSync(OUT, gzipSync(Buffer.from(json), { level: 9 }));
  log(`wrote ${OUT}: ${count} stars, ${json.length} bytes JSON`);

  // ---- 9. doc -----------------------------------------------------------------------------------------------------------------------------
  const col = (n: string, hip: number) => cols[n]![stars.indexOf(hip)];
  const spot = [32349, 27989, 91262, 11767, 69673, 24436, 71683, 71681, 80763, 70890, 87937].filter((h) => stars.includes(h) || true);
  const spotRows = spot.map((h) => {
    const i = stars.indexOf(h);
    if (i < 0) return `| HIP ${h} | not in this file (V > ${V_LIMIT}, no IAU name, or not selected) | | | | |`;
    return `| HIP ${h} | ${cols['iauName']![i] ?? cols['simbadMainId']![i]} | ${cols['parallaxMas']![i]} +- ${cols['parallaxErrMas']![i]} | ${cols['vMag']![i]} | ${cols['spectralType']![i]} | ${cols['gaiaSourceId']![i] ?? 'none (Hipparcos-only)'} (${cols['gaiaMatchBasis']![i] ?? '-'}) |`;
  });
  void col;
  const droppedNames = dropped.filter((d) => d.what.startsWith('IAU name'));
  const droppedOther = dropped.filter((d) => !d.what.startsWith('IAU name'));
  const doc = `# Bright-star supplement (Hipparcos) - data notes

Generated by \`tools/discovery/build_bright_stars.ts\` on ${today}. Output: \`public/data/bright-stars.v1.json.gz\` (type \`BrightStarFile\`, \`src/discovery/types.ts\`). Rebuild offline: \`npx tsx tools/discovery/build_bright_stars.ts --offline\` (reads \`data/cache/discovery/stars/\`).

## Why

Gaia DR3 has no usable astrometry for stars brighter than about G = 1.5, so Sirius, Betelgeuse, Vega, Polaris, Rigel, Arcturus, Alpha Centauri A/B and Antares are not in the atlas's Gaia subset. This file adds the Hipparcos entries for them and for the rest of the naked-eye sky.

## Sources (all retrieved ${today} unless stated)

| Role | Source | Retrieved |
|---|---|---|
| Astrometry (J1991.25, ICRS), parallax, proper motion | VizieR I/311/hip2, van Leeuwen (2007), Hipparcos new reduction | ${retrievals['hip2']} |
| Vmag, B-V, spectral type, variability | VizieR I/239/hip_main, ESA (1997) | ${retrievals['hip_main']} |
| Proper names | IAU WGSN IAU-CSN.txt (last updated ${csn.lastUpdated}) | ${retrievals['iau-csn']} |
| Identifiers | SIMBAD TAP (CfA mirror), ident + basic tables | ${retrievals['simbad']} |

## Selection

- Hipparcos main catalogue stars with Johnson V <= ${V_LIMIT}: ${bright.rows.length}.
- Plus every IAU-WGSN named star with a HIP number that is fainter than that: ${extra.length} (${namesByHip.size} named HIP numbers in total).
- Selected ${wanted.length}; written ${count} (${noAst.length} lacked a row in hip2).

The V <= ${V_LIMIT} cut is our definition of naked-eye. It is not a completeness claim for the sky.

## Licence and terms

- I/239 ReadMe: "License: ${lic}" (non-commercial, check before commercial use).
- I/311 ReadMe acknowledgement: "${ack}". Reference: ${ref}
- VizieR headers point to https://cds.unistra.fr/vizier-org/licences_vizier.html; that page returned 404 when fetched, so the CDS acknowledgement text is not quoted here. SIMBAD's terms page was not fetched.
- IAU-CSN header, quoted: "${iauHeader}"

## Distance quality

\`parallaxQuality\` is 'good' when parallax/error >= ${GOOD_PLX_SNR}, else 'poor': ${good} good, ${poor} poor. Distance is not stored; do not invert 'poor' parallaxes. Betelgeuse-like stars (extended, variable red supergiants) have large uncertainty and resolved discs; the formal error probably understates the real one.

## Values read back from the retrieved rows

| HIP | Name | Parallax (mas) | V | Spectral type | Gaia link |
|---|---|---|---|---|---|
${spotRows.join('\n')}

(Sirius expected 379.21 +- 1.58 and Vega about 130.23 per the brief; the table shows what the source returned.)

## Gaia de-duplication

Method: for each Hipparcos star propagate the J1991.25 position to J2016.0 with its own proper motion (linear), find Gaia subset records within ${MATCH_RADIUS_ARCSEC} arcsec, and require parallax agreement within ${MATCH_SIGMA} sigma (combined) or ${MATCH_FRACTION * 100} percent. The Gaia subset's \`hip_id\` (Gaia's best neighbour) is tried first; an alternative record is accepted only if unique and passing the same checks.

- Linked to Gaia: ${matches.size} (hip_id ${stat.byHipId}; hip_id without a Gaia parallax to test ${stat.byHipIdNoPlx}; position only ${stat.byPosition}; SIMBAD Gaia id, parallax test not satisfied ${stat.bySimbadId}).
- Hipparcos-only (not in the Gaia subset): ${count - matches.size}.
- Gaia best-neighbour links that failed the strict position+parallax checks: ${stat.hipIdFailed} (rescued by the SIMBAD id where it agrees; the rest stay unlinked).
- SIMBAD's own Gaia DR3 identifier agrees with our link for ${simbadAgree} stars and disagrees for ${simbadDisagree}.

${issues.length ? `Ambiguities:\n${issues.map((x) => `- ${x}`).join('\n')}\n` : ''}${hipIdFailures.length ? `Failed hip_id links (first 40):\n${hipIdFailures.slice(0, 40).map((x) => `- ${x}`).join('\n')}\n` : ''}
## Dropped

- IAU names without a HIP number (${droppedNames.length}); they are mostly exoplanet-host stars and a few pulsars and cannot be attached to a Hipparcos record:
${droppedNames.map((d) => `  - ${d.what}`).join('\n')}
${droppedOther.length ? `- Other:\n${droppedOther.map((d) => `  - ${d.what}: ${d.why}`).join('\n')}` : '- No selected Hipparcos star was dropped for missing data.'}

## Columns

Required (BrightStarFile): ${names.slice(0, 14).join(', ')}.
Optional additions: ${names.slice(14).join(', ')}, plus manifest keys \`selection\`, \`gaiaDedupe\`, \`dropped\`.
Missing is \`null\`, never 0.
`;
  const OTHER_MARK = '<!-- other-objects:start -->';
  const prev = existsSync(DOC) ? readFileSync(DOC, 'utf8') : '';
  const keep = prev.includes(OTHER_MARK) ? prev.slice(prev.indexOf(OTHER_MARK)) : '';
  writeFileSync(DOC, keep ? `${doc}\n${keep}` : doc);
  log(`wrote ${DOC}`);
  void sirius;
}

main().catch((e) => { console.error(e); process.exit(1); });
