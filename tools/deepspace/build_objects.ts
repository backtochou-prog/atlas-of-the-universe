/**
 * Builds public/data/deep-space.v1.json (type DeepSpaceFile, src/data/deepspace/types.ts) and docs/DEEP_SPACE_DATA_OBJECTS.md.
 *
 *   npx tsx tools/deepspace/build_objects.ts            fetch what is not cached, then build
 *   npx tsx tools/deepspace/build_objects.ts --offline  rebuild from data/cache/deepspace/objects only (fails on a cache miss)
 *
 * Every raw response (SIMBAD TAP, VizieR, HyperLEDA, NED-D csv, arXiv, ar5iv, Baumgardt table) is cached verbatim.
 * Values come from those responses; the few numbers that are typed into tools/deepspace/data/objects/roster.ts and milkyway.ts
 * are paired with evidence strings that are checked against the fetched text, and the build aborts on a mismatch.
 * A quantity that cannot be retrieved is not guessed: it goes to `unavailable[key]` with the reason and into the docs.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import type { Fact, Measurement, SourceRef } from '../../src/data/schema';
import type {
  AngularSize, ClusterClass, DeepSpaceFile, DeepSpaceObject, DiscOrientation, DocumentedModel, GalaxyClass, NebulaClass, PointCatalogueFile, Representation,
} from '../../src/data/deepspace/types';
import { classifyCluster, classifyGalaxy, classifyNebula } from '../../src/core/deepspace/classify';
import { validateDeepSpaceFile } from '../../src/data/deepspace/validate';
import { NEBULA_VISUAL } from '../../src/render/deep-space/nebulaGeometry';
import { retrievalDate, ROOT, setOffline } from './data/objects/cache';
import { buildMilkyWay } from './data/objects/milkyway';
import { CLUSTERS, GALAXIES, NEBULAE, REFLECTION_CANDIDATES, type ClusterSpec, type DistSpec, type GalaxySpec, type NebulaSpec } from './data/objects/roster';
import {
  arxivEntry, ar5ivHtml, ar5ivText, baumgardtRow, BAUMGARDT_URL, ledaRow, nedDRows, numOrNull, requireEvidence, simbadObject, vizier,
  type ArxivEntry, type SimbadObject,
} from './data/objects/sources';

const args = process.argv.slice(2);
const OFFLINE = args.includes('--offline');
setOffline(OFFLINE);
const log = (m: string) => console.log(`[objects] ${m}`);
const OUT = join(ROOT, 'public', 'data', 'deep-space.v1.json');
const DOC = join(ROOT, 'docs', 'DEEP_SPACE_DATA_OBJECTS.md');
const CAT_DIR = join(ROOT, 'public', 'data', 'deepspace');
import { readdirSync } from 'node:fs';
const IMG_MANIFESTS = readdirSync(join(ROOT, 'tools', 'deepspace', 'images')).filter((f) => f.endsWith('.json')).sort((a, b) => (['galaxies.json', 'nebulae.json'].indexOf(b) + 1) - (['galaxies.json', 'nebulae.json'].indexOf(a) + 1) || a.localeCompare(b)).map((f) => join(ROOT, 'tools', 'deepspace', 'images', f));
const TODAY = new Date().toISOString().slice(0, 10);

// ---- bookkeeping: sources used, everything left out ----------------------------------------------------------------

type Src = { key: string; title: string; url: string; retrieved: string; licence: string; note?: string };
const sources = new Map<string, Src>();
const useSource = (s: Src) => { if (!sources.has(s.key)) sources.set(s.key, s); };
const CDS_LICENCE = 'CDS data: free to use with acknowledgement (VizieR terms: https://cds.unistra.fr/vizier-org/licences_vizier.html; the SIMBAD terms page was not fetched in this build). Only individual catalogue values with attribution are stored here.';
const dropped: { id: string; what: string; why: string }[] = [];
const drop = (id: string, what: string, why: string) => { dropped.push({ id, what, why }); log(`unavailable ${id}.${what}: ${why}`); };

// ---- generic helpers -----------------------------------------------------------------------------------------------

const KPC_PER: Record<string, number> = { pc: 1e-3, kpc: 1, Mpc: 1e3 };
const round = (x: number, d = 6) => { const k = 10 ** d; return Math.round(x * k) / k; };
const sig = (x: number, n = 4) => (x === 0 ? 0 : Number(x.toPrecision(n)));
const ARCMIN_RAD = Math.PI / (180 * 60);
const normName = (s: string) => s.replace(/\s+/g, '').toUpperCase();

function angSepDeg(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const d = Math.PI / 180;
  const a = Math.sin(((dec2 - dec1) * d) / 2) ** 2 + Math.cos(dec1 * d) * Math.cos(dec2 * d) * Math.sin(((ra2 - ra1) * d) / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(a))) / d;
}

const arxivCache = new Map<string, ArxivEntry>();
async function arxiv(id: string): Promise<ArxivEntry> {
  let e = arxivCache.get(id);
  if (!e) { e = await arxivEntry(id); arxivCache.set(id, e); }
  useSource({ key: `arxiv-${id}`, title: `${e.authors[0]?.split(' ').slice(-1)[0] ?? 'arXiv'} et al. ${e.published.slice(0, 4)}: ${e.title}`, url: e.url, retrieved: e.retrieved, licence: 'arXiv e-print abstract; numbers quoted with attribution', note: e.journalRef ? `journal reference given by arXiv: ${e.journalRef}` : 'no journal reference given by arXiv at retrieval' });
  return e;
}
function citeOf(e: ArxivEntry): string {
  const first = (e.authors[0] ?? 'arXiv').split(' ').slice(-1)[0]!;
  const who = `${first}${e.authors.length > 1 ? ' et al.' : ''}`;
  if (!e.journalRef) return `${who} ${e.published.slice(0, 4)} (arXiv:${e.id}; arXiv lists no journal reference)`;
  return /^\d{4}\b/.test(e.journalRef) ? `${who} ${e.journalRef}` : `${who} ${e.published.slice(0, 4)}, ${e.journalRef}`;
}

const simbadSrc = (o: SimbadObject, record: string, extra: Partial<SourceRef> = {}): SourceRef => {
  useSource({ key: 'simbad', title: 'SIMBAD astronomical database (CDS), TAP service on the CfA mirror', url: 'https://simbad.cfa.harvard.edu/simbad/sim-tap', retrieved: o.retrieved, licence: CDS_LICENCE });
  return { source: 'simbad', release: 'TAP via simbad.cfa.harvard.edu', recordId: record, url: o.url, retrieved: o.retrieved, ...extra };
};

const idMap = new Map<string, SimbadObject>();
async function simbad(ident: string): Promise<SimbadObject> {
  let o = idMap.get(ident);
  if (!o) { o = await simbadObject(ident); idMap.set(ident, o); }
  return o;
}

/** Designations: keep only those that SIMBAD lists for the object (so none is typed from memory). */
async function verifiedDesignations(ident: string, wanted: readonly string[], id: string): Promise<string[]> {
  const { simbadQuery } = await import('./data/objects/cache');
  const rows = await simbadQuery(`SELECT i2.id FROM ident AS i1 JOIN ident AS i2 ON i1.oidref=i2.oidref WHERE i1.id='${ident.replace(/'/g, "''")}'`, `simbad ids ${ident}`);
  const n2 = (x: string) => normName(x).replace(/([A-Z]+)0+(\d)/g, '$1$2'); // SIMBAD zero-pads PGC numbers
  const have = new Set(rows.map((r) => n2(String(r['id']))));
  const keep: string[] = [];
  for (const w of wanted) {
    const n = n2(w);
    if ([n, 'NAME' + n, 'CL' + n, n.replace(/^PGC/, 'LEDA')].some((k) => have.has(k))) keep.push(w); // SIMBAD lists PGC numbers as LEDA <n>
    else drop(id, `designation "${w}"`, 'not among the SIMBAD identifiers of the object (kept out rather than typed from memory)');
  }
  return keep;
}

// ---- distances ------------------------------------------------------------------------------------------------------


const ZUCKER_RADIUS_DEG = 1.0;
function gaiaNearM42(raDeg: number, decDeg: number): { n: number; medianPc: number } | null {
  const f = join(ROOT, 'public/data/gaia-dr3-subset.v1.json.gz');
  if (!existsSync(f)) return null;
  const c = (JSON.parse(gunzipSync(readFileSync(f)).toString('utf8')) as { columns: Record<string, (number | null)[]> }).columns;
  const ra = c['ra']!, dec = c['dec']!, plx = c['parallax']!;
  const out: number[] = [];
  for (let i = 0; i < ra.length; i++) {
    const p = plx[i]; if (p === null || p === undefined || p < 2.0 || p > 3.2) continue;
    if (angSepDeg(raDeg, decDeg, ra[i]!, dec[i]!) < 0.6) out.push(1000 / p);
  }
  if (out.length < 2) return null;
  out.sort((a, b) => a - b);
  return { n: out.length, medianPc: out.length % 2 ? out[(out.length - 1) / 2]! : (out[out.length / 2 - 1]! + out[out.length / 2]!) / 2 };
}

interface Dist { m: Measurement; extra?: Record<string, Measurement>; facts: Fact[]; label: string }

async function resolveDistance(spec: DistSpec, id: string, sim: SimbadObject): Promise<Dist> {
  switch (spec.kind) {
    case 'arxiv': {
      const e = await arxiv(spec.arxiv);
      requireEvidence(e.summary, spec.evidence, `${id} distance (arXiv:${spec.arxiv})`);
      const nums = [spec.value, spec.stat, spec.sys, spec.total, spec.lower, spec.upper].filter((x): x is number => x !== undefined);
      for (const n of nums) if (!spec.evidence.includes(String(n)) && !spec.evidence.includes(n.toFixed(2)) && !spec.evidence.includes(n.toFixed(1))) throw new Error(`${id}: number ${n} does not occur in the evidence string`);
      let unc: number | undefined; let uncNote = '';
      if (spec.stat !== undefined && spec.sys !== undefined) { unc = Math.hypot(spec.stat, spec.sys); uncNote = `published statistical ${spec.stat} and systematic ${spec.sys} ${spec.unit} (given separately); uncertainty stored = their quadrature sum (our step)`; }
      else if (spec.total !== undefined) { unc = spec.total; uncNote = `published uncertainty ${spec.total} ${spec.unit}`; }
      else if (spec.stat !== undefined) { unc = spec.stat; uncNote = `published statistical uncertainty ${spec.stat} ${spec.unit}; no systematic term published in the abstract`; }
      else if (spec.lower !== undefined && spec.upper !== undefined) { unc = (spec.lower + spec.upper) / 2; uncNote = `asymmetric published uncertainty +${spec.upper}/-${spec.lower} ${spec.unit}; stored uncertainty = their mean`; }
      const m: Measurement = {
        value: spec.value, unit: spec.unit, ...(unc !== undefined ? { uncertainty: sig(unc, 4) } : {}), kind: 'observed',
        source: { source: 'arxiv', release: citeOf(e), recordId: `arXiv:${e.id}`, url: e.url, retrieved: e.retrieved },
        note: `Redshift-independent distance. Method: ${spec.method}. ${uncNote}.${spec.note ? ' ' + spec.note : ''} Value read from the paper's abstract.`,
      };
      return { m, facts: [], label: citeOf(e) };
    }
    case 'ned-d': {
      const { rows, retrieved } = await nedDRows([spec.nedName]);
      const hit = rows.filter((r) => r.refcode === spec.refcode && r.mM !== null && Math.abs(r.mM - spec.mM) < 1e-6);
      if (hit.length !== 1) throw new Error(`${id}: expected exactly one NED-D row for ${spec.nedName} ${spec.refcode} m-M=${spec.mM}, found ${hit.length}`);
      const r = hit[0]!;
      useSource({ key: 'ned-d', title: 'NED-D: A Master List of Redshift-Independent Extragalactic Distances, v17.1.2 (NED30.5.1-D-17.1.2-20200415.csv)', url: 'https://ned.ipac.caltech.edu/Library/Distances/', retrieved, licence: 'File header: "Copyright (C) 2012-2020 California Institute of Technology - All Rights Reserved"; acknowledgement: "This research has made use of the NASA/IPAC Extragalactic Database (NED) which is operated by the Jet Propulsion Laboratory, California Institute of Technology, under contract with the National Aeronautics and Space Administration." Only individual published distances are stored here, with attribution; the csv is cached locally and not redistributed.', note: 'NED-D v17.1.2 dates from April 2020: later measurements (e.g. after 2020) are not in it' });
      const pc = 10 ** ((r.mM! + 5) / 5);
      const errPc = r.mMerr !== null ? (pc * Math.LN10 / 5) * r.mMerr : undefined;
      const unit = pc >= 1e6 ? 'Mpc' : pc >= 1e3 ? 'kpc' : 'pc';
      const f = KPC_PER[unit]! * 1e3; // pc per unit
      const src: SourceRef = { source: 'ned-d', release: 'v17.1.2 (2020-04-15)', recordId: `NED-D record ${r.recordIndex} (galaxy index ${r.objectIndex}, ${r.galaxy}), REFCODE ${r.refcode}`, url: 'https://ned.ipac.caltech.edu/Library/Distances/', retrieved };
      const modulus: Measurement = { value: r.mM!, unit: 'mag', ...(r.mMerr !== null ? { uncertainty: r.mMerr } : {}), kind: 'observed', source: src, note: `distance modulus as tabulated in NED-D; method "${r.method}" (${spec.method}); the uncertainty is NED-D's quoted one-sigma statistical error` };
      const m: Measurement = {
        value: sig(pc / f, 6), unit, ...(errPc !== undefined ? { uncertainty: sig(errPc / f, 3) } : {}), kind: 'derived', source: src,
        transformations: [`d = 10^((m-M)/5 + 1) pc with m-M = ${r.mM} mag from NED-D (NED-D's own D column lists ${r.dMpc} Mpc, rounded)`, ...(errPc !== undefined ? [`sigma_d = d * ln(10)/5 * sigma_(m-M) = ${sig(errPc, 3)} pc`] : [])],
        note: `Redshift-independent distance, method: ${spec.method}. Reference: bibcode ${r.refcode}. Statistical error only: no systematic term is given by NED-D.`,
      };
      return { m, extra: { distanceModulus: modulus }, facts: [], label: `NED-D ${r.refcode}` };
    }
    case 'mcconnachie': {
      const t = await vizier({ '-source': 'J/AJ/144/4/catalog', Name: spec.name, '-out.all': '1', '-out.max': '5' }, `vizier mcconnachie ${spec.name}`);
      const row = t.rows[0];
      if (!row) throw new Error(`McConnachie 2012: no row for ${spec.name}`);
      const refs = await vizier({ '-source': 'J/AJ/144/4/refs', '-out.max': '200' }, 'vizier mcconnachie refs');
      const codes = (row['Ref2'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const bib = codes.map((c) => refs.rows.find((r) => r['Ref'] === c)?.['BibCode'] ?? `ref ${c}`).join(', ');
      const D = numOrNull(row['D']); const up = numOrNull(row['E_D']); const lo = numOrNull(row['e_D']);
      const mM = numOrNull(row['(m-M)']); const mUp = numOrNull(row['E_(m-M)']); const mLo = numOrNull(row['e_(m-M)']);
      if (D === null || mM === null) throw new Error('McConnachie row without distance');
      useSource({ key: 'mcconnachie2012', title: 'McConnachie 2012, The observed properties of dwarf galaxies in and around the Local Group, AJ 144, 4 (VizieR J/AJ/144/4)', url: 'https://cdsarc.cds.unistra.fr/viz-bin/cat/J/AJ/144/4', retrieved: t.retrieved, licence: CDS_LICENCE });
      const src: SourceRef = { source: 'vizier', release: 'J/AJ/144/4 (McConnachie 2012, bibcode 2012AJ....144....4M)', recordId: `J/AJ/144/4/catalog, Name=${spec.name}`, url: 'https://cdsarc.cds.unistra.fr/viz-bin/cat/J/AJ/144/4', retrieved: t.retrieved };
      const unc = up !== null && lo !== null ? (up + lo) / 2 : undefined;
      const m: Measurement = { value: D, unit: 'kpc', ...(unc !== undefined ? { uncertainty: unc } : {}), kind: 'observed', source: src,
        note: `Redshift-independent distance as compiled by McConnachie (2012) from the original measurements ${bib} (RR Lyrae distance of Fiorentino et al. 2010 is reference 42 in the catalogue's refs table). The catalogue lists +${up}/-${lo} kpc; the stored uncertainty is their mean.` };
      const modulus: Measurement = { value: mM, unit: 'mag', ...(mUp !== null && mLo !== null ? { uncertainty: (mUp + mLo) / 2 } : {}), kind: 'observed', source: src, note: 'distance modulus (m-M)_0 as tabulated by McConnachie (2012); asymmetric errors averaged' };
      return { m, extra: { distanceModulus: modulus }, facts: [], label: `McConnachie 2012 (${bib})` };
    }
    case 'zucker': {
      const t = await vizier({ '-source': 'J/A+A/633/A51/handbook', '-c': `${sim.basic.ra} ${sim.basic.dec}`, '-c.r': '3', '-c.u': 'deg', '-out.all': '1', '-out.max': '300' }, `vizier zucker sightlines near ${id}`);
      const cand = t.rows.map((r) => ({ r, sep: angSepDeg(sim.basic.ra, sim.basic.dec, Number(r['_RA.icrs']), Number(r['_DE.icrs'])) })).filter((x) => Number.isFinite(x.sep)).sort((a, b) => a.sep - b.sep);
      const near = cand.filter((x) => x.sep <= ZUCKER_RADIUS_DEG && Number.isFinite(Number(x.r['d50'])));
      if (near.length === 0) throw new Error(`${id}: no Zucker et al. 2020 sightline within ${ZUCKER_RADIUS_DEG} deg (nearest: ${cand[0] ? cand[0].sep.toFixed(2) : 'none'})`);
      const med = (v: number[]) => { const s = [...v].sort((a, b) => a - b); const n = s.length; return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2; };
      const d50s = near.map((x) => Number(x.r['d50']));
      const errs = near.map((x) => (Number(x.r['d84']) - Number(x.r['d16'])) / 2).filter((e) => Number.isFinite(e));
      const dMed = med(d50s), lo = Math.min(...d50s), hi = Math.max(...d50s);
      const spreadHalf = (hi - lo) / 2, medErr = errs.length ? med(errs) : 0;
      const unc = Math.hypot(spreadHalf, medErr);
      useSource({ key: 'zucker2020', title: 'Zucker et al. 2020, A compendium of distances to molecular clouds in the Star Formation Handbook, A&A 633, A51 (VizieR J/A+A/633/A51, table A1)', url: 'https://cdsarc.cds.unistra.fr/viz-bin/cat/J/A+A/633/A51', retrieved: t.retrieved, licence: CDS_LICENCE });
      const names = near.map((x) => `recno ${x.r['recno']} "${x.r['Name']}" ${x.sep.toFixed(2)} deg: ${x.r['d50']} pc (${x.r['d16']}-${x.r['d84']})`);
      const src: SourceRef = { source: 'vizier', release: 'J/A+A/633/A51 (Zucker et al. 2020)', recordId: `J/A+A/633/A51/handbook, ${near.length} sightlines within ${ZUCKER_RADIUS_DEG} deg: recno ${near.map((x) => x.r['recno']).join(', ')}`, url: 'https://cdsarc.cds.unistra.fr/viz-bin/cat/J/A+A/633/A51', retrieved: t.retrieved };
      const m: Measurement = { value: sig(dMed, 4), unit: 'pc', uncertainty: sig(unc, 3), kind: 'modelled', source: src,
        transformations: [
          `Zucker et al. (2020) distances are from a 3D dust-extinction model along each sightline, not a measured distance to this nebula`,
          `selection rule (ours): all ${near.length} catalogued sightlines within ${ZUCKER_RADIUS_DEG} deg of the SIMBAD position; value = median of their d50`,
          `per-sightline d50 (16th-84th percentile): ${names.join('; ')}`,
          ...(near.length === 1 ? ['only ONE sightline lies within the radius, so the sightline-to-sightline spread cannot be estimated: the stored uncertainty is that single sightline\'s own error and probably underestimates the true scatter of cloud distances across the field'] : []),
          `spread of the per-sightline medians: ${lo}-${hi} pc, half the full range = ${sig(spreadHalf, 3)} pc; median catalogue error (half the 16th-84th interval) = ${sig(medErr, 3)} pc`,
          `stored uncertainty = sqrt(spread^2 + median error^2) = ${sig(unc, 3)} pc (our rule; a descriptive scatter, not a statistical confidence interval)`,
        ],
        note: `Modelled distance to the dust cloud (3D dust-extinction model of Zucker et al. 2020, built from stellar photometry with Gaia DR2 parallaxes) along ${near.length} sightlines within ${ZUCKER_RADIUS_DEG} deg of the object; it is NOT a distance to the nebula itself or to its illuminating stars. The sightlines disagree by more than any single sightline's error bar, which is why the uncertainty includes their spread.` };
      const facts: Fact[] = [];
      if (id === 'orion-nebula') {
        const g = gaiaNearM42(sim.basic.ra, sim.basic.dec);
        if (g) facts.push({ text: `Rough cross-check, small sample: in this app's own Gaia DR3 subset (which is limited to stars with G < 6.5 or parallax >= 25 mas with parallax_over_error >= 5, so it is NOT a complete or unbiased sample) ${g.n} stars with parallax 2.0-3.2 mas lie within 0.6 deg of M42; the median of 1000/parallax is ${Math.round(g.medianPc)} pc. This uses uncorrected raw parallaxes (no zero-point correction), says nothing about the nebula's own distance and is not an independent measurement.`, status: 'observed', reference: 'Gaia DR3 subset in this application (public/data/gaia-dr3-subset.v1.json.gz); our computation' });
      }
      return { m, facts, label: 'Zucker et al. 2020' };
    }
    case 'hr23': {
      const t = await vizier({ '-source': 'J/A+A/673/A114/clusters', Name: `==${spec.name}`, '-out.all': '1', '-out.max': '5' }, `vizier hr23 ${spec.name}`);
      const r = t.rows[0];
      if (!r) throw new Error(`Hunt & Reffert 2023: no row ${spec.name}`);
      useSource({ key: 'hr23', title: 'Hunt & Reffert 2023, Improving the open cluster census II, A&A 673, A114 (VizieR J/A+A/673/A114)', url: 'https://cdsarc.cds.unistra.fr/viz-bin/cat/J/A+A/673/A114', retrieved: t.retrieved, licence: CDS_LICENCE });
      const d16 = Number(r['dist16']), d50 = Number(r['dist50']), d84 = Number(r['dist84']);
      const src: SourceRef = { source: 'vizier', release: 'J/A+A/673/A114 (Hunt & Reffert 2023, Gaia DR3)', recordId: `J/A+A/673/A114/clusters, Name=${spec.name}`, url: 'https://cdsarc.cds.unistra.fr/viz-bin/cat/J/A+A/673/A114', retrieved: t.retrieved };
      const m: Measurement = { value: d50, unit: 'pc', uncertainty: round((d84 - d16) / 2, 4), kind: 'observed', source: src,
        note: `Maximum-likelihood distance of the cluster from its Gaia DR3 member parallaxes (${r['Ndist']} stars), 50th percentile with 16th-84th percentile ${d16}-${d84} pc (stored uncertainty = half that interval). Statistical only: it does not contain Gaia's parallax zero-point/systematic uncertainty.` };
      return { m, extra: { _hr23row: { value: 0, unit: '', kind: 'observed', source: src, note: JSON.stringify(r) } }, facts: [], label: 'Hunt & Reffert 2023' };
    }
    case 'baumgardt': {
      const b = await baumgardtRow(spec.ngc);
      useSource({ key: 'baumgardt', title: 'Baumgardt & Vasiliev 2021 (MNRAS 505, 5957) distances and Baumgardt et al. N-body mass fits: "Structural Parameters of Galactic Globular Clusters" table, people.smp.uq.edu.au/HolgerBaumgardt/globular', url: BAUMGARDT_URL, retrieved: b.retrieved, licence: 'Table on the author\'s web page; terms not stated on the page; individual values quoted with attribution' });
      const src: SourceRef = { source: 'baumgardt-gc-table', release: b.distTitle || 'Baumgardt & Vasiliev (2021)', recordId: `parameter.html row ${spec.ngc}`, url: BAUMGARDT_URL, retrieved: b.retrieved };
      const m: Measurement = { value: b.distKpc, unit: 'kpc', ...(b.distErrKpc !== null ? { uncertainty: b.distErrKpc } : {}), kind: 'observed', source: src,
        note: `Heliocentric distance as listed in Baumgardt's table; the cell's source tag reads "${b.distTitle}" (Baumgardt & Vasiliev 2021: mean of HST/Gaia-EDR3 kinematic, parallax, main-sequence-fitting and other literature distances). The quoted error is the table's.` };
      return { m, facts: [], label: 'Baumgardt & Vasiliev 2021' };
    }
    case 'bailer-jones': {
      const t = await vizier({ '-source': 'I/352/gedr3dis', '-c': `${spec.ra} ${spec.dec}`, '-c.r': '5', '-c.u': 'arcsec', '-out.all': '1', '-out.max': '20' }, `vizier bailer-jones ${id}`);
      const r = t.rows.find((x) => x['Source'] === spec.sourceId);
      if (!r) throw new Error(`${id}: Gaia EDR3 ${spec.sourceId} not found in Bailer-Jones 2021`);
      const lo = Number(r['b_rgeo']), med = Number(r['rgeo']), hi = Number(r['B_rgeo']);
      useSource({ key: 'bailer-jones2021', title: 'Bailer-Jones et al. 2021, Estimating distances from parallaxes V: geometric and photogeometric distances to 1.47 billion stars in Gaia EDR3, AJ 161, 147 (VizieR I/352)', url: 'https://cdsarc.cds.unistra.fr/viz-bin/cat/I/352', retrieved: t.retrieved, licence: CDS_LICENCE });
      const src: SourceRef = { source: 'vizier', release: 'I/352 (Bailer-Jones et al. 2021, Gaia EDR3)', recordId: `I/352/gedr3dis, Gaia EDR3 ${spec.sourceId}`, url: 'https://cdsarc.cds.unistra.fr/viz-bin/cat/I/352', retrieved: t.retrieved };
      const plx = sim.basic.plx_value; const plxE = sim.basic.plx_err;
      const m: Measurement = { value: med, unit: 'pc', uncertainty: round((hi - lo) / 2, 3), kind: 'derived', source: src,
        transformations: ['Gaia EDR3 parallax of the central star (SIMBAD: ' + (plx !== null ? `${plx} +- ${plxE} mas` : 'n/a') + ') converted to a geometric distance with the Bailer-Jones et al. (2021) prior: median of the posterior r_med_geo, 16th-84th percentile ' + `${lo}-${hi} pc`],
        note: `Geometric distance of the planetary nebula's central star (Gaia EDR3 ${spec.sourceId}); stored uncertainty = half the 16th-84th percentile interval (asymmetric: -${round(med - lo, 1)}/+${round(hi - med, 1)} pc).` };
      return { m, facts: [], label: 'Bailer-Jones et al. 2021' };
    }
  }
}

/** "Other published distances" from SIMBAD mesDistance (all rows, nothing filtered except the one used). */
function otherDistancesFact(sim: SimbadObject): Fact | undefined {
  const rows = sim.distances;
  if (rows.length === 0) return undefined;
  const fmt = (d: (typeof rows)[number]) => `${d.dist} ${d.unit}${d.minus_err !== null && d.plus_err !== null ? ` (${d.minus_err}/+${d.plus_err})` : ''}${d.method ? ` [${d.method}]` : ''} ${d.bibcode}`;
  return { text: `Other published distance values listed by SIMBAD (mesDistance, ${rows.length} rows, method flags as in SIMBAD): ${rows.slice(0, 24).map(fmt).join('; ')}${rows.length > 24 ? '; ...' : ''}. They are not used for the drawn position; they show how much published values differ.`, status: 'observed', reference: `SIMBAD mesDistance for ${sim.basic.main_id}`, url: sim.url };
}

// ---- measurement builders -------------------------------------------------------------------------------------------

function physicalSize(angMajorArcmin: number, dist: Measurement, sizeSrc: SourceRef, what: string, opts?: { noUncertainty?: boolean }): Measurement {
  const dPc = dist.value * (dist.unit === 'pc' ? 1 : dist.unit === 'kpc' ? 1e3 : 1e6);
  const th = angMajorArcmin * ARCMIN_RAD;
  const sizePc = 2 * dPc * Math.tan(th / 2);
  const relErr = dist.uncertainty !== undefined && !opts?.noUncertainty ? dist.uncertainty / dist.value : undefined;
  const unit = sizePc >= 1e3 ? 'kpc' : 'pc';
  const f = unit === 'kpc' ? 1e3 : 1;
  return { value: sig(sizePc / f, 4), unit, ...(relErr !== undefined ? { uncertainty: sig((sizePc / f) * relErr, 2) } : {}), kind: 'derived', source: sizeSrc,
    transformations: [`${what} angular size ${angMajorArcmin.toFixed(3)} arcmin = ${(th).toExponential(4)} rad`, `linear diameter = 2 * d * tan(theta/2) with d = ${dist.value} ${dist.unit} (${dist.source.release ?? dist.source.source})`, ...(relErr !== undefined ? [`uncertainty propagated from the distance only (relative ${(relErr * 100).toFixed(2)} %); no angular-size uncertainty is published`] : opts?.noUncertainty ? ['no uncertainty is given: this size is defined by cluster membership (a half-number or half-light radius), whose uncertainty is not published; the distance uncertainty alone would give a misleadingly small error bar'] : [])],
    note: 'Projected linear extent along the major axis. Not corrected for inclination or foreshortening; depends on the angular-size definition stated with the angular size.' };
}
function absMag(app: Measurement, dist: Measurement, band: string): Measurement {
  const dPc = dist.value * (dist.unit === 'pc' ? 1 : dist.unit === 'kpc' ? 1e3 : 1e6);
  const mu = 5 * Math.log10(dPc) - 5;
  const relErr = dist.uncertainty !== undefined ? dist.uncertainty / dist.value : 0;
  const err = Math.hypot(app.uncertainty ?? 0, (5 / Math.LN10) * relErr);
  return { value: sig(app.value - mu, 4), unit: 'mag', ...(err > 0 ? { uncertainty: sig(err, 2) } : {}), kind: 'derived', source: app.source,
    transformations: [`M_${band} = m_${band} - (5 log10(d/pc) - 5) with m = ${app.value} mag and d = ${dist.value} ${dist.unit}`, `distance modulus ${sig(mu, 5)} mag`, 'NO correction for Galactic or internal extinction, and no K-correction (the apparent magnitude is the catalogue value)'],
    note: 'Absolute magnitude of the whole object, uncorrected for extinction.' };
}

function fluxMeasurements(sim: SimbadObject): Record<string, Measurement> {
  const out: Record<string, Measurement> = {};
  for (const f of sim.fluxes) {
    const key = `mag${f.filter}`;
    out[key] = { value: f.flux, unit: 'mag', ...(f.flux_err !== null ? { uncertainty: f.flux_err } : {}), kind: 'observed', source: simbadSrc(sim, `${sim.basic.main_id}, flux table, filter ${f.filter}`, { release: `bibcode ${f.bibcode}` }), note: `${f.filter}-band apparent magnitude (integrated) as listed in SIMBAD; reference ${f.bibcode}${f.qual ? `, quality ${f.qual}` : ''}. SIMBAD does not state whether it is corrected for extinction (it is normally not).` };
  }
  return out;
}

// ---- galaxies -------------------------------------------------------------------------------------------------------

function pickMorphology(sim: SimbadObject, ledaType: string, id: string): { label: string; classes: GalaxyClass; from: string; other: string } {
  const cands: { label: string; from: string }[] = [];
  const s = sim.basic.morph_type;
  if (s && !/^[-+]?\d+(\.\d+)?$/.test(s)) cands.push({ label: s, from: `SIMBAD morph_type (bibcode ${sim.basic.morph_bibcode})` });
  if (ledaType) cands.push({ label: ledaType, from: 'HyperLEDA type' });
  for (const c of cands) {
    try {
      const cls = classifyGalaxy(c.label);
      const other = cands.filter((x) => x !== c).map((x) => `${x.from}: "${x.label}"`).join('; ') || (s ? `SIMBAD morph_type: "${s}"` : 'none');
      return { label: c.label, classes: cls, from: c.from, other };
    } catch { drop(id, `morphology string "${c.label}" from ${c.from}`, 'cannot be classified unambiguously by classifyGalaxy; next candidate used'); }
  }
  throw new Error(`${id}: no classifiable morphology string`);
}

async function buildGalaxy(g: GalaxySpec): Promise<DeepSpaceObject> {
  const sim = await simbad(g.simbad);
  const leda = await ledaRow(g.leda);
  useSource({ key: 'hyperleda', title: 'HyperLEDA (Makarov et al. 2014), ledacat.cgi extraction', url: 'http://atlas.obs-hp.fr/hyperleda/', retrieved: leda.retrieved, licence: 'Terms not retrieved in this build; individual catalogue values quoted with attribution (HyperLEDA asks to cite Makarov et al. 2014, A&A 570, A13 - not verified here)' });
  const dist = await resolveDistance(g.dist, g.id, sim);
  const morph = pickMorphology(sim, leda.type, g.id);
  const ledaSrc: SourceRef = { source: 'hyperleda', release: 'ledacat.cgi', recordId: `PGC ${leda.pgc} (${leda.objname})`, url: leda.url, retrieved: leda.retrieved };

  const measurements: Record<string, Measurement> = { distance: dist.m, ...(dist.extra ?? {}) };
  const unavailable: Record<string, string> = {};
  Object.assign(measurements, fluxMeasurements(sim));
  if (leda.bt !== null) measurements['magB_total_hyperleda'] = { value: leda.bt, unit: 'mag', kind: 'observed', source: ledaSrc, note: 'HyperLEDA "bt": total B magnitude (as published; extinction treatment not retrieved)' };
  if (sim.basic.rvz_radvel !== null) measurements['radialVelocity'] = { value: sig(sim.basic.rvz_radvel, 6), unit: 'km/s', kind: 'observed', source: simbadSrc(sim, `${sim.basic.main_id}, rvz_radvel`, { release: sim.basic.rvz_bibcode ? `bibcode ${sim.basic.rvz_bibcode}` : undefined }), note: `heliocentric radial velocity from SIMBAD (type flag "${sim.basic.rvz_type}")` };
  else unavailable['radialVelocity'] = 'not given by SIMBAD';

  // angular size: HyperLEDA D25
  let angularSize: AngularSize | undefined;
  if (leda.logd25 !== null) {
    const major = (10 ** leda.logd25) * 0.1;
    const minor = leda.logr25 !== null ? major / 10 ** leda.logr25 : undefined;
    angularSize = { majorArcmin: sig(major, 5), ...(minor !== undefined ? { minorArcmin: sig(minor, 5) } : {}), ...(leda.pa !== null ? { positionAngleDeg: leda.pa } : {}), source: ledaSrc,
      definition: `D25: HyperLEDA "logd25" is the log10 of the apparent diameter in units of 0.1 arcmin (25 mag/arcsec^2 isophote, B band per the HyperLEDA convention); major = 10^logd25 * 0.1 arcmin = ${sig(major, 5)}; minor = major / 10^logr25 (logr25 = ${leda.logr25 ?? 'n/a'}); position angle of the major axis from HyperLEDA ${leda.pa !== null ? `(${leda.pa} deg, north through east)` : '(not published)'}` };
    measurements['physicalDiameterD25'] = physicalSize(major, dist.m, ledaSrc, 'D25');
    const s = sim.basic;
    if (s.galdim_majaxis !== null) measurements['angularMajorAxisSimbad'] = { value: s.galdim_majaxis, unit: 'arcmin', kind: 'observed', source: simbadSrc(sim, `${s.main_id}, galdim_majaxis`, { release: s.galdim_bibcode ? `bibcode ${s.galdim_bibcode}` : undefined }), note: `SIMBAD major-axis diameter (wavelength flag "${s.galdim_wavelength}"), for comparison with D25 above; its isophote definition is that of the cited paper and was not retrieved` };
  } else { unavailable['angularSize'] = 'HyperLEDA gives no logd25'; drop(g.id, 'angularSize', 'HyperLEDA gives no logd25'); }

  for (const f of ['B', 'V'] as const) { const k = `mag${f}`; if (measurements[k]) measurements[`absMag${f}`] = absMag(measurements[k]!, dist.m, f); else unavailable[`absMag${f}`] = `SIMBAD lists no ${f} magnitude for this object`; }
  if (!measurements['magK']) unavailable['magK'] = 'SIMBAD lists no K magnitude for this object';

  // orientation
  let orientation: DiscOrientation | undefined;
  let orientationNote = '';
  if (g.orientation === 'leda') {
    if (leda.incl !== null && leda.pa !== null) {
      orientation = {
        inclinationDeg: { value: leda.incl, unit: 'deg', kind: 'modelled', source: ledaSrc, note: 'HyperLEDA "incl": inclination between the line of sight and the polar axis (0 = face-on, 90 = edge-on). HyperLEDA publishes no uncertainty and its response does not say how the value is obtained; the documented HyperLEDA procedure derives it from the isophotal axis ratio (logr25) and the morphological type (not verified in this build), so treat it as a photometric estimate, not a dynamical measurement.' },
        positionAngleDeg: { value: leda.pa, unit: 'deg', kind: 'observed', source: ledaSrc, note: 'HyperLEDA "pa": major-axis position angle, north through east; no uncertainty published' },
        nearSide: 'unknown',
      };
      orientationNote = `HyperLEDA inclination ${leda.incl} deg and PA ${leda.pa} deg; near side not published in any source retrieved here`;
    } else { unavailable['orientation'] = 'HyperLEDA gives no inclination and position angle'; drop(g.id, 'orientation', 'HyperLEDA gives no incl/pa'); }
  } else if (g.orientation !== 'sky-plane') {
    const o = g.orientation;
    const e = await arxiv(o.arxiv);
    requireEvidence(e.summary, o.inclEvidence, `${g.id} inclination`);
    requireEvidence(e.summary, o.paEvidence, `${g.id} position angle`);
    const src: SourceRef = { source: 'arxiv', release: citeOf(e), recordId: `arXiv:${e.id}`, url: e.url, retrieved: e.retrieved };
    orientation = {
      inclinationDeg: { value: o.incl, unit: 'deg', uncertainty: round(Math.hypot(o.inclStat, o.inclSys), 3), kind: 'modelled', source: src, note: `Disc inclination fitted to ${o.tracer}: i = ${o.incl} +- ${o.inclStat} (stat) +- ${o.inclSys} (syst) deg; stored uncertainty = quadrature sum (our step). The paper reports that old (RR Lyrae) tracers give significantly different values.` },
      positionAngleDeg: { value: o.pa, unit: 'deg', uncertainty: round(Math.hypot(o.paStat, o.paSys), 3), kind: 'modelled', source: src, note: `Position angle of the line of nodes (= the disc's major axis) fitted to ${o.tracer}: ${o.pa} +- ${o.paStat} (stat) +- ${o.paSys} (syst) deg` },
      nearSide: 'unknown',
    };
    orientationNote = `Cepheid-disc fit (${citeOf(e)}); near side not stated in the abstract`;
  }

  const facts: Fact[] = [];
  facts.push({ text: `SIMBAD main identifier "${sim.basic.main_id}", object type ${sim.basic.otype_txt}${sim.basic.otype === 'AGN' || sim.basic.otype === 'Sy2' || sim.basic.otype === 'LIN' || sim.basic.otype === 'BLL' ? ' (SIMBAD types galaxies by their nuclear activity class; it does not describe the whole galaxy)' : ''}; morphology string used: "${morph.label}" from ${morph.from}. Other strings: ${morph.other}.`, status: 'observed', reference: `SIMBAD ${sim.basic.main_id}; HyperLEDA PGC ${leda.pgc}`, url: sim.url });
  const od = otherDistancesFact(sim); if (od) facts.push(od);
  const ned = await nedDRows(g.ned);
  const peer = ned.rows.filter((r) => r.exclusion === '' && r.dMpc !== null);
  if (peer.length > 0) {
    const ds = peer.map((r) => r.dMpc!).sort((a, b) => a - b);
    const methods = [...new Set(peer.map((r) => r.method))].sort();
    facts.push({ text: `NED-D v17.1.2 (April 2020) lists ${peer.length} redshift-independent distance records for this galaxy (excluding records flagged R/N), spanning ${ds[0]} to ${ds[ds.length - 1]} Mpc (median ${ds[Math.floor(ds.length / 2)]} Mpc) over ${methods.length} methods (${methods.join(', ')}). The spread is a reminder that single-method distances carry systematic differences.`, status: 'observed', reference: `NED-D v17.1.2, galaxy name(s) ${g.ned.join(' / ')}`, url: 'https://ned.ipac.caltech.edu/Library/Distances/' });
  } else if (g.ned.length > 0) { log(`${g.id}: no NED-D rows under ${g.ned.join(' / ')}`); }
  if (g.notes) facts.push({ text: g.notes, status: 'observed', reference: dist.label });

  const deproject = orientation !== undefined;
  const representation: Representation = deproject
    ? { kind: 'deprojected-image', depth: 'published-orientation-model', summary: `A real image of the galaxy, re-mapped onto a flat disc plane using the published inclination (${orientation!.inclinationDeg.value} deg) and position angle (${orientation!.positionAngleDeg.value} deg). The sky position, distance and orientation are measured/published; which side of the disc is nearer is NOT known here, and the disc thickness, bulge and halo are not measured in 3D.`,
        exaggerations: ['Deprojection stretches the image by 1/cos(inclination) along the minor axis: noise, foreground stars and everything above the disc plane (bulge, halo, dust) are mapped onto the plane.', 'The tilt direction (which edge is nearer) is a presentation choice, because the near side is not published here.'] }
    : { kind: 'observed-image', depth: 'sky-plane-only', summary: `A real image of the galaxy placed at its catalogue position and redshift-independent distance. Its depth structure is not measured: it is shown as a flat image facing the Sun. ${g.id === 'm104' ? 'The Sombrero is seen nearly edge-on, so no disc deprojection is attempted.' : g.orientation === 'sky-plane' ? 'No usable published disc orientation (elliptical, irregular, peculiar or edge-on), so no deprojection is attempted.' : ''}`,
        exaggerations: [] };

  return {
    id: g.id, name: g.name, designations: await verifiedDesignations(g.simbad, g.designations, g.id), kind: 'galaxy', galaxyClass: morph.classes, morphologyLabel: morph.label,
    sky: { raDeg: sim.basic.ra, decDeg: sim.basic.dec, distance: dist.m, coordinateSource: simbadSrc(sim, `${sim.basic.main_id}, ra/dec`, { release: sim.basic.coo_bibcode ? `ICRS; coordinate bibcode ${sim.basic.coo_bibcode}` : 'ICRS' }) },
    ...(angularSize ? { angularSize } : {}), ...(orientation ? { orientation } : {}), measurements, ...(Object.keys(unavailable).length ? { unavailable } : {}), facts, representation, imageAssetIds: [],
    ...(g.parentId ? { parentId: g.parentId } : {}), notes: [orientationNote, `Primary distance: ${dist.label}.`].filter(Boolean).join(' '),
  };
}

// ---- nebulae --------------------------------------------------------------------------------------------------------

async function buildNebula(n: NebulaSpec, nebulaClassOverride?: NebulaClass): Promise<DeepSpaceObject> {
  const sim = await simbad(n.simbad);
  let cls: NebulaClass;
  let clsNote = `SIMBAD object type ${sim.basic.otype_txt} for "${sim.basic.main_id}"`;
  if (n.otypeOverride) {
    const e = await arxiv(n.otypeOverride.arxiv);
    requireEvidence(e.summary, n.otypeOverride.evidence, `${n.id} class`);
    cls = classifyNebula(n.otypeOverride.otype);
    clsNote = `SIMBAD types "${sim.basic.main_id}" as ${sim.basic.otype_txt} (the central open cluster is merged with the nebula there); the nebula class comes from ${citeOf(e)}: "${n.otypeOverride.evidence}"`;
  } else cls = nebulaClassOverride ?? classifyNebula(sim.basic.otype);
  const dist = await resolveDistance(n.dist, n.id, sim);
  const measurements: Record<string, Measurement> = { distance: dist.m, ...Object.fromEntries(Object.entries(dist.extra ?? {})) };
  const unavailable: Record<string, string> = {};
  let angularSize: AngularSize | undefined;
  const b = sim.basic;
  const starRecord = b.sp_type !== null; // SIMBAD record of a planetary nebula can be the central star's
  if (!starRecord) Object.assign(measurements, fluxMeasurements(sim));
  if (b.galdim_majaxis !== null && b.galdim_majaxis > 0) {
    const src = simbadSrc(sim, `${b.main_id}, galdim_majaxis/minaxis/angle`, { release: b.galdim_bibcode ? `bibcode ${b.galdim_bibcode}` : undefined });
    angularSize = { majorArcmin: b.galdim_majaxis, ...(b.galdim_minaxis !== null && b.galdim_minaxis > 0 ? { minorArcmin: Math.min(b.galdim_minaxis, b.galdim_majaxis) } : {}), ...(b.galdim_angle !== null ? { positionAngleDeg: b.galdim_angle } : {}), source: src,
      definition: `catalogue-diameter: the extent listed by SIMBAD from ${b.galdim_bibcode ?? 'an unstated reference'} (wavelength flag "${b.galdim_wavelength ?? 'n/a'}"); the paper's own isophote or visual-extent definition was not retrieved, so the number is an indicative extent, not a calibrated edge` };
    measurements['physicalDiameter'] = physicalSize(b.galdim_majaxis, dist.m, src, 'catalogue');
  } else { unavailable['angularSize'] = 'SIMBAD lists no angular size for this object'; drop(n.id, 'angularSize', 'SIMBAD lists no angular size'); }
  if (b.rvz_radvel !== null) measurements['radialVelocity'] = { value: b.rvz_radvel, unit: 'km/s', kind: 'observed', source: simbadSrc(sim, `${b.main_id}, rvz_radvel`, { release: b.rvz_bibcode ? `bibcode ${b.rvz_bibcode}` : undefined }), note: `radial velocity from SIMBAD (type flag "${b.rvz_type}")` };
  if (!measurements['magV']) unavailable['magV'] = starRecord ? 'the SIMBAD magnitudes for this record belong to the central star, not the nebula; no integrated nebular magnitude was retrieved' : 'extended object: SIMBAD lists no integrated V magnitude';
  const facts: Fact[] = [{ text: `${clsNote}.`, status: 'observed', reference: `SIMBAD ${b.main_id}`, url: sim.url }];
  if (starRecord) facts.push({ text: `SIMBAD's record for "${b.main_id}" carries a stellar spectral type (${b.sp_type}) and a Gaia parallax (${b.plx_value} +- ${b.plx_err} mas), i.e. its position, magnitudes and parallax refer to the central star at the middle of the nebula; they are not nebular values.`, status: 'observed', reference: `SIMBAD ${b.main_id}`, url: sim.url });
  for (const f of n.facts ?? []) {
    const e = await arxiv(f.arxiv);
    requireEvidence(e.summary, f.evidence, `${n.id} fact (arXiv:${f.arxiv})`);
    facts.push({ text: f.text, status: f.status, reference: `${citeOf(e)}: "${e.title}"`, url: e.url });
  }
  if (!facts.some((f) => /\[[A-Z][a-z]? ?[IV]+\]|H-?alpha|H-?beta|Br-gamma/.test(f.text))) unavailable['emissionLines'] = 'no published statement of dominant emission lines for this object was retrieved in this build (not guessed)';
  facts.push(...dist.facts);
  const od = otherDistancesFact(sim); if (od) facts.push(od);
  if (n.notes) facts.push({ text: n.dist.kind === 'zucker' ? n.notes.replace(/(?:[Tt]he distance is that of |Distance from )the nearest Zucker et al\. \(2020\) sightline/, (m) => (m.startsWith('t') ? 't' : 'T') + 'he distance is the Zucker et al. (2020) modelled dust-cloud distance (median of all sightlines within 1 deg; see the distance measurement)') : n.notes, status: 'inferred', reference: dist.label });
  const thick = NEBULA_VISUAL.thicknessFraction[cls];
  const representation: Representation = {
    kind: 'observed-image', depth: 'illustrative-layers',
    summary: `A real telescope image placed at the object's catalogue sky position and stated distance (the image is real and its position on the sky is measured). The depth is NOT measured: to let you move around, the same picture is split by brightness (for emission nebulae also a little by colour) into ${NEBULA_VISUAL.layersMin}-${NEBULA_VISUAL.layersMax} soft layers drawn on sheets at different distances along the line of sight. The layer offsets are an assumed visual thickness, not a 3D structure of the nebula. The picture may combine several filters; see the image's own provenance for bands and colours.`,
    exaggerations: [
      `Illustrative depth layers: the image is split into ${NEBULA_VISUAL.layersMin}-${NEBULA_VISUAL.layersMax} brightness bands (count follows the quality setting) placed along the line of sight over an ASSUMED total thickness of ${Math.round(thick * 100)}% of the picture's transverse size (class "${cls}"); the real depth is not known from the image.`,
      cls === 'dark' ? 'Layer order: the darkest (absorbing) band is placed nearest the Sun, because a dark nebula seen in silhouette must lie in front of the light behind it; the offsets themselves are still assumed.' : 'Layer order: brightest band nearest the Sun is a plain convention with no claim that it is the true order.',
      'All layers are scaled about the Sun so that, seen from the Sun, they add up to the original image; the layers separate (parallax) only when the camera moves off that line of sight.',
    ],
  };
  return {
    id: n.id, name: n.name, designations: await verifiedDesignations(n.simbad, n.designations, n.id), kind: 'nebula', nebulaClass: cls,
    sky: { raDeg: b.ra, decDeg: b.dec, distance: dist.m, coordinateSource: simbadSrc(sim, `${b.main_id}, ra/dec`, { release: b.coo_bibcode ? `ICRS; coordinate bibcode ${b.coo_bibcode}` : 'ICRS' }) },
    ...(angularSize ? { angularSize } : {}), measurements, ...(Object.keys(unavailable).length ? { unavailable } : {}), facts, representation, imageAssetIds: [], ...(n.parentId ? { parentId: n.parentId } : {}),
    notes: `Primary distance: ${dist.label}. SIMBAD position is the catalogue reference point, which for extended nebulae is not necessarily the geometric centre of any particular image.`,
  };
}

// ---- clusters -------------------------------------------------------------------------------------------------------

async function buildCluster(c: ClusterSpec): Promise<DeepSpaceObject> {
  const sim = await simbad(c.simbad);
  const cls: ClusterClass = classifyCluster(sim.basic.otype);
  if (cls !== c.kind) throw new Error(`${c.id}: SIMBAD type ${sim.basic.otype} disagrees with roster kind ${c.kind}`);
  const measurements: Record<string, Measurement> = {};
  const unavailable: Record<string, string> = {};
  const facts: Fact[] = [];
  let dist: Dist;
  let angularSize: AngularSize | undefined;
  Object.assign(measurements, fluxMeasurements(sim));

  if (c.kind === 'open') {
    dist = await resolveDistance({ kind: 'hr23', name: c.hr23! }, c.id, sim);
    const r = JSON.parse(dist.extra!['_hr23row']!.note!) as Record<string, string>;
    delete dist.extra!['_hr23row'];
    const src = dist.m.source;
    const num = (k: string) => { const v = numOrNull(r[k]); if (v === null) throw new Error(`HR23 ${c.id}: missing ${k}`); return v; };
    measurements['distance'] = dist.m;
    measurements['memberCount'] = { value: num('N'), unit: 'count', kind: 'observed', source: src, note: 'number of member stars in the Hunt & Reffert (2023) membership list (HDBSCAN on Gaia DR3 astrometry; contamination and incompleteness are not quantified here)' };
    const la16 = num('logAge16'), la50 = num('logAge50'), la84 = num('logAge84');
    measurements['logAge'] = { value: la50, unit: 'log10(yr)', uncertainty: round((la84 - la16) / 2, 4), kind: 'modelled', source: src, note: `50th percentile (16th-84th: ${la16}-${la84}) of the age from a neural-network isochrone-fit to the member photometry (Hunt & Reffert 2023); a model estimate, not a direct measurement` };
    const ageMyr = (10 ** la50) / 1e6;
    measurements['age'] = { value: sig(ageMyr, 3), unit: 'Myr', uncertainty: sig(((10 ** la84 - 10 ** la16) / 2) / 1e6, 2), kind: 'derived', source: src, transformations: [`age = 10^logAge yr = 10^${la50} yr`, 'uncertainty from the 16th/84th percentile ages, half the interval'], note: 'convenience conversion of logAge (model estimate)' };
    measurements['extinctionAV'] = { value: num('AV50'), unit: 'mag', kind: 'modelled', source: src, note: `V-band extinction, 50th percentile (16th-84th: ${r['AV16']}-${r['AV84']}); modelled` };
    measurements['halfNumberRadius'] = { value: num('r50pc'), unit: 'pc', kind: 'derived', source: src, transformations: ['Hunt & Reffert r50 (deg, radius containing 50% of members within the tidal radius) converted to parsecs with their distance'], note: 'radius containing 50% of members within the tidal radius' };
    measurements['tidalRadius'] = { value: num('rtpc'), unit: 'pc', kind: 'derived', source: src, transformations: ['Hunt & Reffert rt (deg, approximate tidal radius) converted to parsecs'], note: 'approximate tidal radius' };
    measurements['totalRadius'] = { value: num('rtotpc'), unit: 'pc', kind: 'derived', source: src, transformations: ['Hunt & Reffert rtot (deg, total radius including tidal tails/coma) converted to parsecs'], note: 'total radius including tidal tails and coma' };
    measurements['meanParallax'] = { value: num('Plx'), unit: 'mas', uncertainty: num('e_Plx'), kind: 'observed', source: src, note: 'mean Gaia DR3 parallax of the members (standard error); not corrected here for the parallax zero-point' };
    measurements['meanPmRa'] = { value: num('pmRA'), unit: 'mas/yr', uncertainty: num('e_pmRA'), kind: 'observed', source: src, note: 'mean proper motion in RA*cos(dec), members' };
    measurements['meanPmDec'] = { value: num('pmDE'), unit: 'mas/yr', uncertainty: num('e_pmDE'), kind: 'observed', source: src, note: 'mean proper motion in Dec, members' };
    const rv = numOrNull(r['RV']);
    if (rv !== null) measurements['radialVelocity'] = { value: rv, unit: 'km/s', ...(numOrNull(r['e_RV']) !== null ? { uncertainty: numOrNull(r['e_RV'])! } : {}), kind: 'observed', source: src, note: `mean Gaia DR3 radial velocity of ${r['n_RV']} members` };
    const r50deg = num('r50');
    angularSize = { majorArcmin: sig(2 * r50deg * 60, 5), source: src, definition: 'half-number diameter: 2 x r50, where r50 (Hunt & Reffert 2023) is the angular radius containing 50% of the members within the tidal radius; the cluster extends further (see totalRadius, tidalRadius)' };
    measurements['physicalDiameter'] = physicalSize(angularSize.majorArcmin, dist.m, src, 'half-number', { noUncertainty: true });
    // Dias et al. 2021 metallicity
    if (c.dias) {
      const dt = await vizier({ '-source': 'J/MNRAS/504/356/table12', Cluster: `==${c.dias}`, '-out.all': '1', '-out.max': '3' }, `vizier dias ${c.dias}`);
      const d = dt.rows[0];
      if (d) {
        useSource({ key: 'dias2021', title: 'Dias et al. 2021, Updated parameters of 1743 open clusters based on Gaia DR2, MNRAS 504, 356 (VizieR J/MNRAS/504/356)', url: 'https://cdsarc.cds.unistra.fr/viz-bin/cat/J/MNRAS/504/356', retrieved: dt.retrieved, licence: CDS_LICENCE });
        const fe = numOrNull(d['[Fe/H]']);
        if (fe !== null) measurements['metallicityFeH'] = { value: fe, unit: 'dex', ...(numOrNull(d['e_[Fe/H]']) !== null ? { uncertainty: numOrNull(d['e_[Fe/H]'])! } : {}), kind: 'modelled', source: { source: 'vizier', release: 'J/MNRAS/504/356 (Dias et al. 2021, Gaia DR2)', recordId: `J/MNRAS/504/356/table12, Cluster=${c.dias}`, url: 'https://cdsarc.cds.unistra.fr/viz-bin/cat/J/MNRAS/504/356', retrieved: dt.retrieved }, note: '[Fe/H] as tabulated by Dias et al. (2021); the table describes it only as "Metallicity" (derivation per the paper, not re-checked here); "rms uncertainty" as published' };
        else unavailable['metallicityFeH'] = 'Dias et al. 2021 lists no [Fe/H] for this cluster';
        const la = numOrNull(d['logage']);
        if (la !== null) facts.push({ text: `Independent age estimate: Dias et al. (2021) give log(age/yr) = ${la}${numOrNull(d['e_logage']) !== null ? ` +- ${d['e_logage']}` : ''}, distance ${d['Dist']} +- ${d['e_Dist']} pc (Gaia DR2). Hunt & Reffert (2023) used above: log(age/yr) = ${la50}.`, status: 'observed', reference: 'Dias et al. 2021 (J/MNRAS/504/356)' });
      } else unavailable['metallicityFeH'] = 'cluster not in Dias et al. 2021 table 12';
    }
    unavailable['mass'] = 'no cluster mass was retrieved from a source in this build (Hunt & Reffert 2023 give none; a dynamical or luminosity mass would need a separate published value)';
  } else {
    const ngc = c.ngc!;
    dist = await resolveDistance({ kind: 'baumgardt', ngc }, c.id, sim);
    const b = await baumgardtRow(ngc);
    const src = dist.m.source;
    measurements['distance'] = dist.m;
    if (b.massMsun !== null) measurements['mass'] = { value: sig(b.massMsun, 5), unit: 'Msun', ...(b.massErrMsun !== null ? { uncertainty: sig(b.massErrMsun, 3) } : {}), kind: 'modelled', source: src, note: 'present-day mass from N-body/Plummer-type model fits to velocity-dispersion and surface-density profiles (Baumgardt table); not a direct count of stars' };
    if (b.nPm !== null) measurements['memberCountProperMotion'] = { value: b.nPm, unit: 'count', kind: 'observed', source: src, note: 'number of stars with proper-motion measurements used in the kinematic fits (Baumgardt table column NPM) - a count of fitted stars, NOT the total number of cluster members' };
    if (b.nRv !== null) measurements['memberCountRadialVelocity'] = { value: b.nRv, unit: 'count', kind: 'observed', source: src, note: 'number of stars with radial-velocity measurements used (column NRV) - not the total number of members' };
    if (b.rhlPc !== null) measurements['halfLightRadiusProjected'] = { value: b.rhlPc, unit: 'pc', kind: 'modelled', source: src, note: 'projected half-light radius r_h,l from the fits' };
    const ht = await vizier({ '-source': 'VII/195/catalog', '-out.all': '1', '-out.max': '500' }, 'vizier harris 2010 all');
    const h = ht.rows.find((r) => normName(r['ID'] ?? '') === normName(ngc));
    if (h) {
      useSource({ key: 'harris1996', title: 'Harris 1996 (2010 edition), A catalog of parameters for globular clusters in the Milky Way, AJ 112, 1487 (VizieR VII/195)', url: 'https://cdsarc.cds.unistra.fr/viz-bin/cat/VII/195', retrieved: ht.retrieved, licence: CDS_LICENCE });
      const hs: SourceRef = { source: 'vizier', release: 'VII/195 (Harris 1996, 2010 edition)', recordId: `VII/195/catalog, ID=${ngc}`, url: 'https://cdsarc.cds.unistra.fr/viz-bin/cat/VII/195', retrieved: ht.retrieved };
      const fe = numOrNull(h['[Fe/H]']);
      if (fe !== null) measurements['metallicityFeH'] = { value: fe, unit: 'dex', kind: 'observed', source: hs, note: `[Fe/H] on the Harris catalogue's metallicity scale (Harris compilation of spectroscopic and photometric indices; no uncertainty is published in this column)` };
      else unavailable['metallicityFeH'] = 'Harris catalogue lists no [Fe/H]';
      const vt = numOrNull(h['Vt']); if (vt !== null) measurements['magV_total_harris'] = { value: vt, unit: 'mag', kind: 'observed', source: hs, note: 'integrated V magnitude, Harris catalogue' };
      const eb = numOrNull(h['E(B-V)']); if (eb !== null) measurements['colourExcessEBV'] = { value: eb, unit: 'mag', kind: 'observed', source: hs, note: 'foreground reddening E(B-V), Harris catalogue' };
      const rh = numOrNull(h['Rh']);
      if (rh !== null) {
        angularSize = { majorArcmin: sig(2 * rh, 4), source: hs, definition: 'half-mass diameter: 2 x Rh, with Rh the Harris (2010 edition) column "Rh" in arcmin (the VizieR column description reads "Half-mass radius"); the cluster extends well beyond this (tidal radius is several times larger). It is a different definition from the projected half-light radius of Baumgardt (halfLightRadiusProjected, a modelled value), so the two sizes are not expected to agree and are not reconciled here' };
        measurements['physicalDiameter'] = physicalSize(angularSize.majorArcmin, dist.m, hs, 'Harris Rh (VizieR column: half-mass radius)', { noUncertainty: true });
      }
    } else { unavailable['metallicityFeH'] = 'cluster not found in Harris catalogue VII/195'; }
    unavailable['age'] = 'no globular-cluster age table was retrievable in this build (VizieR J/ApJ/775/134 was not served by the mirror); not guessed';
    facts.push({ text: 'The globular class follows the SIMBAD object type (GlC). Member counts here are the numbers of stars with measurements in Baumgardt\'s fits, not complete censuses.', status: 'observed', reference: `SIMBAD ${sim.basic.main_id}; Baumgardt table`, url: sim.url });
  }
  if (!angularSize && sim.basic.galdim_majaxis !== null) { /* fall through to SIMBAD size */ }
  if (!angularSize) { unavailable['angularSize'] = 'no angular size retrieved'; drop(c.id, 'angularSize', 'no size from catalogues'); }
  const od = otherDistancesFact(sim); if (od) facts.push(od);
  facts.unshift({ text: `SIMBAD main identifier "${sim.basic.main_id}", object type ${sim.basic.otype_txt}.`, status: 'observed', reference: `SIMBAD ${sim.basic.main_id}`, url: sim.url });

  const open = c.kind === 'open';
  const rhl = measurements['halfLightRadiusProjected'];
  const rhlText = rhl ? `${rhl.value} ${rhl.unit} (Baumgardt's projected half-light radius, a modelled value)` : 'the catalogued size (no projected half-light radius was retrieved)';
  const representation: Representation = {
    kind: 'observed-members',
    depth: open ? 'measured-per-object' : 'illustrative',
    summary: open
      ? 'Each point is a real Gaia DR3 member star of the cluster (Hunt & Reffert 2023 membership) at its catalogued sky position; its distance comes from its own parallax, whose uncertainty is small for a nearby cluster but not zero. Colour/brightness follow the catalogued photometry; no star is invented.'
      : `Each point is a real Gaia-EDR3 star with a high membership probability (Vasiliev & Baumgardt 2021) at its catalogued sky position (measured). The depth is NOT measured: at several kpc individual parallaxes cannot resolve the cluster. Each star's line-of-sight offset from the cluster-mean distance is instead a deterministic draw (seeded by a hash of its Gaia source id) from a Plummer-like profile whose scale is ${rhlText}, evaluated at the star's projected radius. The offsets are illustrative, the same for every run, and say nothing about where an individual star really is. Only the brightest members are in the file.`,
    exaggerations: open ? [] : [`Illustrative depth: each star's line-of-sight offset from the cluster-mean distance is a hash-seeded pseudo-random draw from a Plummer-like profile scaled by the projected half-light radius; it is NOT measured. Only the sky positions, brightnesses and colours are catalogue data.`],
  };
  return {
    id: c.id, name: c.name, designations: await verifiedDesignations(c.simbad, c.designations, c.id), kind: 'star-cluster', clusterClass: cls,
    sky: { raDeg: sim.basic.ra, decDeg: sim.basic.dec, distance: dist.m, coordinateSource: simbadSrc(sim, `${sim.basic.main_id}, ra/dec`, { release: sim.basic.coo_bibcode ? `ICRS; coordinate bibcode ${sim.basic.coo_bibcode}` : 'ICRS' }) },
    ...(angularSize ? { angularSize } : {}), measurements, ...(Object.keys(unavailable).length ? { unavailable } : {}), facts, representation, imageAssetIds: [], pointsFileId: c.pointsFileId, parentId: 'milky-way',
    notes: `Primary distance: ${dist.label}.`,
  };
}

// ---- catalogue helpers (A2's files) ----------------------------------------------------------------------------------

function readCatalogue(id: string): PointCatalogueFile | undefined {
  const p = join(CAT_DIR, `${id}.v1.json.gz`);
  if (!existsSync(p)) return undefined;
  return JSON.parse(gunzipSync(readFileSync(p)).toString('utf8')) as PointCatalogueFile;
}
const col = <T extends string | number | null>(f: PointCatalogueFile, k: string): readonly T[] => (f.columns[k] ?? []) as readonly T[];

// ---- image manifests -------------------------------------------------------------------------------------------------

function readImageIds(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of IMG_MANIFESTS) {
    if (!existsSync(p)) { log(`image manifest missing: ${p}`); continue; }
    const j = JSON.parse(readFileSync(p, 'utf8')) as { assets: { id: string; objectId: string }[] };
    for (const a of j.assets) { const l = out.get(a.objectId) ?? []; if (!l.includes(a.id)) l.push(a.id); out.set(a.objectId, l); }
  }
  // Preferred default image first (the application shows the first asset unless the user picks another band): the choice is ours,
  // made because the alternative covers the object poorly (GALEX NUV of the LMC has large no-data holes; M87 has no other optical image).
  const preferFirst: Record<string, string> = { m87: 'm87-legacysurvey-grz' };
  for (const [obj, id] of Object.entries(preferFirst)) { const l = out.get(obj); if (l?.includes(id)) out.set(obj, [id, ...l.filter((x) => x !== id)]); }
  return out;
}

// ---- main -----------------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const images = readImageIds();
  const objects: DeepSpaceObject[] = [];

  // Milky Way
  log('Milky Way');
  const mw = await buildMilkyWay();
  for (const s of mw.sources) useSource(s);
  const sgr = await simbad('Sgr A*').catch(() => undefined);
  const gravity = await arxiv('1904.05721');
  const gcDist: Measurement = { value: 8178, unit: 'pc', uncertainty: mw.distance.unc, kind: 'observed', source: { source: 'arxiv', release: citeOf(gravity), recordId: 'arXiv:1904.05721', url: gravity.url, retrieved: gravity.retrieved }, note: `${mw.distance.note}. This is the distance from the Sun to the Galactic Centre (Sgr A*), not a distance to "the Milky Way": we are inside it.` };
  const mwMeasurements: Record<string, Measurement> = { sunGalacticCentreDistance: gcDist };
  for (const [name, key] of [['Total stellar mass of the Galaxy M_star', 'stellarMass'], ['Thin disc exponential scale length R_t', 'thinDiscScaleLength'], ['Thin disc exponential scale height z_t at R0', 'thinDiscScaleHeight'], ['Thick disc exponential scale length R_T', 'thickDiscScaleLength'], ['Thick disc exponential scale height z_T at R0', 'thickDiscScaleHeight'], ['Long bar half-length R_lb', 'longBarHalfLength'], ['Box/peanut bulge bar angle phi_bp (between major axis and the Sun-Galactic Centre line; near side in the first Galactic quadrant)', 'barAngle'], ['Virial mass M_vir', 'virialMass']] as const) {
    const p = mw.params[name]!;
    mwMeasurements[key] = { value: p.value, unit: p.unit === 'Msun' ? 'Msun' : p.unit, ...(p.uncertainty !== undefined ? { uncertainty: p.uncertainty } : {}), kind: 'modelled', source: { source: 'arxiv', release: 'Bland-Hawthorn & Gerhard 2016, ARA&A 54, 529', recordId: 'arXiv:1602.07702, margin-note summary value', url: 'https://arxiv.org/abs/1602.07702', retrieved: retrievalDate('https://ar5iv.labs.arxiv.org/html/1602.07702') ?? TODAY }, note: 'recommended literature value; see models["milky-way"] for the full parameter list with references' };
  }
  objects.push({
    id: 'milky-way', name: 'Milky Way', designations: ['The Galaxy', 'Milky Way Galaxy'], kind: 'galaxy', galaxyClass: classifyGalaxy(mw.morphology.label), morphologyLabel: 'SBb - SBbc', morphologyClassBasis: mw.morphology.label,
    morphologyNote: 'Not a catalogue string. This is the literature range quoted by Kormendy (2019, arXiv:1810.10073: the Milky Way and its structural analogues are "giant, SBb - SBbc galaxies"), adopted by the Atlas. The coarse class "barred spiral" is derived from the range\'s upper end (SBbc) because that parses as a barred spiral; the Galaxy has no entry in a galaxy catalogue because we are inside it.',
    ...(sgr ? { sky: { raDeg: sgr.basic.ra, decDeg: sgr.basic.dec, distance: gcDist, coordinateSource: simbadSrc(sgr, `${sgr.basic.main_id}, ra/dec`, { release: 'position of Sgr A*, the Galactic Centre radio source' }) } } : {}),
    measurements: mwMeasurements,
    unavailable: { angularSize: 'we are inside the Galaxy: it has no angular size', orientation: 'not applicable: observed from inside; the structure is described by the documented model', magV: 'not applicable (observed from inside)' },
    facts: [
      { text: `Morphology: ${mw.morphology.evidence}`, status: 'observed', reference: mw.morphology.cite },
      { text: 'The Galaxy is a luminous barred spiral with a central box/peanut bulge, a dominant disc and a diffuse stellar halo.', status: 'observed', reference: 'Bland-Hawthorn & Gerhard 2016, ARA&A 54, 529 (abstract)', url: 'https://arxiv.org/abs/1602.07702' },
      { text: 'The sky position given is that of the Galactic Centre (Sgr A*), the reference point of the structural model; the Sun is 8.178 kpc from it.', status: 'observed', reference: 'GRAVITY Collaboration 2019 (arXiv:1904.05721)', url: 'https://arxiv.org/abs/1904.05721' },
    ],
    representation: {
      kind: 'documented-model', depth: 'documented-model',
      summary: 'An analytic model assembled from cited literature: spiral arms are Reid et al. (2019) log-periodic fits to maser parallaxes; disc, bar and bulge parameters are the Bland-Hawthorn & Gerhard (2016) recommended values. Only the Sun-Galactic-Centre distance is a direct geometric measurement; the far side and dust-obscured structure are model extrapolations, and no individual star is placed by this model.',
      exaggerations: ['Spiral arms are drawn as smooth curves of fixed width; real arms are irregular and partly extrapolated beyond the azimuth range of the maser data.'],
    },
    imageAssetIds: [], notes: 'We live inside this galaxy; there is no external image of it. The model parameters are in models["milky-way"] (tables: spiral-arms-reid2019, spiral-arm-model-reid2019).',
  });

  log('Galaxies');
  for (const g of GALAXIES) { log(`  ${g.id}`); objects.push(await buildGalaxy(g)); }

  log('Nebulae');
  const nebulae: NebulaSpec[] = [...NEBULAE];
  // reflection nebula: take the first candidate unless the nebula image manifest names another reflection-nebula object id
  let refl = REFLECTION_CANDIDATES[0]!;
  const nebManifest = join(ROOT, 'tools', 'deepspace', 'images', 'nebulae.json');
  if (existsSync(nebManifest)) {
    const known = new Set(NEBULAE.map((n) => n.id));
    const ids = [...new Set((JSON.parse(readFileSync(nebManifest, 'utf8')) as { assets: { objectId: string }[] }).assets.map((a) => a.objectId))].filter((i) => !known.has(i));
    const hit = REFLECTION_CANDIDATES.find((c) => ids.includes(c.id));
    if (hit) refl = hit; else if (ids.length) log(`nebula manifest has object ids not in the roster (unhandled): ${ids.join(', ')}`);
  }
  nebulae.push(refl);
  for (const n of nebulae) { log(`  ${n.id}`); objects.push(await buildNebula(n)); }

  log('Clusters');
  for (const c of CLUSTERS) { log(`  ${c.id}`); objects.push(await buildCluster(c)); }

  // ---- groups ----
  log('Groups');
  const m87 = objects.find((o) => o.id === 'm87')!;
  const m81 = objects.find((o) => o.id === 'm81')!;
  const lgCat = readCatalogue('local-group-mcconnachie');
  const ungc = readCatalogue('ungc');
  const twomrs = readCatalogue('twomrs');
  const catSrc = (f: PointCatalogueFile): SourceRef => f.manifest.source;

  // Local Group
  const mcE = await arxiv('1204.1562');
  requireEvidence(mcE.summary, 'Over 100 nearby galaxies that have distance estimates placing them within 3Mpc of the Sun are identified', 'McConnachie 3 Mpc sample');
  const lg: DeepSpaceObject = {
    id: 'local-group', name: 'Local Group', designations: ['Local Group'], kind: 'galaxy-group',
    measurements: lgCat ? { memberCount: { value: col<string>(lgCat, 'name').length, unit: 'count', kind: 'derived', source: catSrc(lgCat), transformations: ['number of rows of public/data/deepspace/local-group-mcconnachie.v1.json.gz (McConnachie 2012 rows with a published heliocentric distance); the Milky Way itself has no row'], note: 'a count of catalogue rows, not a statement about true membership' } } : {},
    unavailable: { sky: 'a group has no single catalogue position: its members are drawn from the catalogue positions; no barycentre is published in the sources used here', distance: 'a group has no single distance; each member has its own', },
    facts: [{ text: 'The catalogue (McConnachie 2012) is a compilation of the nearby dwarf galaxies in and around the Local Group plus the large members; it flags each galaxy as associated with the Milky Way, with M31, with the Local Group at large, or as a nearby neighbour. The point file carries that subgroup flag.', status: 'observed', reference: 'McConnachie 2012, AJ 144, 4 (VizieR J/AJ/144/4)', url: 'https://cdsarc.cds.unistra.fr/viz-bin/cat/J/AJ/144/4' }],
    representation: { kind: 'observed-members', depth: 'measured-per-object', summary: 'Every point is a catalogued galaxy at its catalogue sky position and its own published (redshift-independent) distance. The Milky Way is not a row of the catalogue and is drawn from the documented model. The catalogue is a compilation, incomplete for faint dwarfs and the Zone of Avoidance.', exaggerations: ['Marker size is a drawing choice, not a measurement: the catalogue gives an angular diameter for only some of the galaxies, so no marker should be read as a galaxy size.'] },
    imageAssetIds: [], ...(lgCat ? { pointsFileId: 'local-group-mcconnachie' } : {}),
    notes: 'Membership is exactly the rows of the McConnachie (2012) table as provided in the point file (all rows, including the nearby-neighbour rows); the table\'s own subgroup flag distinguishes proper Local Group members from neighbours.',
  };
  if (lgCat) {
    (lg as { membership?: DeepSpaceObject['membership'] }).membership = { pointsFileId: 'local-group-mcconnachie', names: col<string>(lgCat, 'name'), basis: `All rows of the McConnachie (2012) catalogue ("Over 100 nearby galaxies that have distance estimates placing them within 3Mpc of the Sun are identified", ${citeOf(mcE)}). The point file also carries the catalogue\'s subgroup flag, so proper Local Group members and nearby neighbours can be told apart.`, source: catSrc(lgCat) };
  } else drop('local-group', 'membership', 'public/data/deepspace/local-group-mcconnachie.v1.json.gz not found');
  objects.push(lg);

  // M81 group
  const m81Dist = m81.sky!.distance!;
  const ungcPaper = await ar5ivHtml('1303.5328');
  const ungcText = ar5ivText(ungcPaper);
  requireEvidence(ungcText, 'the set of objects in Table 2 with the same MD and Θ1>0 corresponds to a definition of physical group of galaxies', 'UNGC group definition');
  requireEvidence(ungcText, 'Name of the “main disturber”(=MD), i.e. the neighboring galaxy, producing the maximal tidal influence on this galaxy', 'UNGC MD definition');
  useSource({ key: 'ungc-paper', title: 'Karachentsev, Makarov & Kaisina 2013, Updated Nearby Galaxy Catalog, AJ 145, 101 (arXiv:1303.5328), read via ar5iv', url: 'https://arxiv.org/abs/1303.5328', retrieved: retrievalDate('https://ar5iv.labs.arxiv.org/html/1303.5328') ?? TODAY, licence: 'arXiv e-print; sentences quoted as evidence only' });
  let m81Names: string[] = [];
  if (ungc) {
    const names = col<string>(ungc, 'name'), md = col<string | null>(ungc, 'mainDisturber'), ti = col<number | null>(ungc, 'tidalIndex');
    const ra = col<number>(ungc, 'raDeg'), dec = col<number>(ungc, 'decDeg');
    const self = names.findIndex((_, i) => angSepDeg(ra[i]!, dec[i]!, m81.sky!.raDeg, m81.sky!.decDeg) < 0.02);
    const members = names.filter((_, i) => md[i] === 'MESSIER081' && (ti[i] ?? -1) > 0);
    m81Names = [...(self >= 0 ? [names[self]!] : []), ...members.filter((n) => n !== names[self])];
    if (self < 0) log('WARNING: M81 itself not found in the UNGC point file by position');
  } else drop('m81-group', 'membership', 'public/data/deepspace/ungc.v1.json.gz not found');
  const m81g: DeepSpaceObject = {
    id: 'm81-group', name: 'M81 Group', designations: ['M81 Group'], kind: 'galaxy-group',
    sky: { raDeg: m81.sky!.raDeg, decDeg: m81.sky!.decDeg, distance: m81Dist, coordinateSource: m81.sky!.coordinateSource },
    measurements: { distance: m81Dist, ...(ungc ? { memberCount: { value: m81Names.length, unit: 'count', kind: 'derived', source: catSrc(ungc), transformations: ['UNGC rows (public/data/deepspace/ungc.v1.json.gz) with mainDisturber = MESSIER081 and tidal index Theta_1 > 0, plus the M81 row itself'], note: 'count of catalogue rows meeting the published criterion; not a dynamical membership analysis' } } : {}) },
    facts: [{ text: 'Karachentsev et al. (2013) state that "the set of objects in Table 2 with the same MD and Theta_1 > 0 corresponds to a definition of physical group of galaxies" (MD = main disturber: the neighbour producing the maximal tidal influence). The membership list applies that rule with MD = M81.', status: 'observed', reference: 'Karachentsev, Makarov & Kaisina 2013, AJ 145, 101 (arXiv:1303.5328), notes to Table 2', url: 'https://arxiv.org/abs/1303.5328' },
      { text: 'The position and distance shown for the group are those of its dominant galaxy M81 (a presentation reference, not a group barycentre).', status: 'inferred', reference: dist_label(m81) }],
    representation: { kind: 'observed-members', depth: 'measured-per-object', summary: 'Points are catalogued galaxies of the Updated Nearby Galaxy Catalog at their catalogue positions. Distances are per-galaxy catalogue values: many are TRGB/Cepheid measurements, but the catalogue also contains distances assigned from group membership or from the Hubble flow, which are lower quality (flagged by distMethod in the point file). The catalogue has no uncertainty column; errors in the file are our propagation where unambiguous.', exaggerations: ['Marker size is a drawing choice, not a measurement: the catalogue gives an angular diameter for only some of the galaxies, so no marker should be read as a galaxy size.'] },
    imageAssetIds: [], ...(ungc ? { pointsFileId: 'ungc' } : {}),
    notes: 'Group membership is the published Theta_1/main-disturber criterion applied to the UNGC; it is a tidal-influence criterion, not a measurement of gravitational binding.',
  };
  if (ungc && m81Names.length) (m81g as { membership?: DeepSpaceObject['membership'] }).membership = { pointsFileId: 'ungc', names: m81Names, basis: 'Updated Nearby Galaxy Catalog (Karachentsev et al. 2013): galaxies whose "main disturber" (column MD) is M81 and whose tidal index Theta_1 is positive - the paper\'s own definition of a physical group ("the set of objects in Table 2 with the same MD and Theta_1>0 corresponds to a definition of physical group of galaxies") - plus M81 itself.', source: catSrc(ungc) };
  objects.push(m81g);

  // Virgo
  const virgoE = await arxiv('astro-ph/0702510');
  requireEvidence(virgoE.summary, 'our adopted mean distance of 16.5+/-0.1 (random mean error) +/-1.1 Mpc (systematic)', 'Virgo distance');
  requireEvidence(virgoE.summary, 'The M87 (cluster A) and M49 (cluster B) subclusters are found to lie at distances of 16.7+/-0.2 and 16.4+/-0.2 Mpc', 'Virgo subclusters');
  requireEvidence(virgoE.summary, 'The back-to-front depth of the cluster measured from our sample of galaxies is 2.4+/-0.4 Mpc', 'Virgo depth');
  const virgoDist: Measurement = { value: 16.5, unit: 'Mpc', uncertainty: round(Math.hypot(0.1, 1.1), 3), kind: 'observed', source: { source: 'arxiv', release: citeOf(virgoE), recordId: 'arXiv:astro-ph/0702510', url: virgoE.url, retrieved: virgoE.retrieved }, note: 'Mean surface-brightness-fluctuation (SBF) distance of 79 Virgo early-type galaxies: 16.5 +- 0.1 (random mean error) +- 1.1 Mpc (systematic); stored uncertainty = quadrature sum (our step). The cluster\'s back-to-front depth is 2.4 +- 0.4 Mpc, and M87 (cluster A) lies at 16.7 +- 0.2 Mpc.' };
  let virgoNames: string[] = [];
  const CONE_DEG = 6, CZ_MIN = -500, CZ_MAX = 2500;
  const CZ_WHY = `The window ${CZ_MIN} to ${CZ_MAX} km/s is ours: it brackets the cluster's mean velocity (about 1100 km/s, with a velocity dispersion of order 600-700 km/s) roughly symmetrically, and it includes the blueshifted members that fall toward M87 (M86, M90, M98 have cz of order -100 to -250 km/s). It is still contaminated by foreground galaxies (low cz) and by background galaxies (W' cloud and beyond).`;
  if (twomrs) {
    const n = col<string>(twomrs, 'name'), ra = col<number>(twomrs, 'raDeg'), dec = col<number>(twomrs, 'decDeg'), cz = col<number>(twomrs, 'czKms');
    for (let i = 0; i < n.length; i++) if (cz[i]! >= CZ_MIN && cz[i]! <= CZ_MAX && angSepDeg(ra[i]!, dec[i]!, m87.sky!.raDeg, m87.sky!.decDeg) <= CONE_DEG) virgoNames.push(n[i]!);
  } else drop('virgo-cluster', 'membership', 'public/data/deepspace/twomrs.v1.json.gz not found');
  const virgo: DeepSpaceObject = {
    id: 'virgo-cluster', name: 'Virgo Cluster', designations: ['Virgo Cluster'], kind: 'galaxy-cluster',
    sky: { raDeg: m87.sky!.raDeg, decDeg: m87.sky!.decDeg, distance: virgoDist, coordinateSource: m87.sky!.coordinateSource },
    measurements: { distance: virgoDist, ...(twomrs ? { memberCount: { value: virgoNames.length, unit: 'count', kind: 'derived', source: catSrc(twomrs), transformations: [`2MRS rows within ${CONE_DEG} deg of M87 with ${CZ_MIN} <= cz <= ${CZ_MAX} km/s (our window)`], note: 'count of 2MRS galaxies passing OUR cut; not a published membership count' } } : {}) },
    facts: [
      { text: 'Cluster distance, subcluster distances and depth from the ACS Virgo Cluster Survey SBF catalogue: mean 16.5 +- 0.1 (random) +- 1.1 (systematic) Mpc; M87 subcluster 16.7 +- 0.2 Mpc; back-to-front depth 2.4 +- 0.4 Mpc; five galaxies at ~23 Mpc belong to the background W\' cloud.', status: 'observed', reference: `${citeOf(virgoE)}: "${virgoE.title}"`, url: virgoE.url },
      { text: `The listed member galaxies are NOT a published membership list. Selection (ours): 2MASS Redshift Survey galaxies within ${CONE_DEG} deg of M87 on the sky (about ${sig(16.5 * Math.tan((CONE_DEG * Math.PI) / 180), 2)} Mpc projected radius at 16.5 Mpc) and with heliocentric cz between ${CZ_MIN} and ${CZ_MAX} km/s. ${CZ_WHY} It may contain foreground and background galaxies (a redshift cut cannot separate them from members; the survey of Mei et al. finds some Virgo-direction galaxies at ~23 Mpc in the W' cloud) and it misses members beyond the cone.`, status: 'inferred', reference: 'this build (tools/deepspace/build_objects.ts, constants CONE_DEG, CZ_MIN, CZ_MAX)' },
    ],
    representation: { kind: 'observed-members', depth: 'measured-cluster-mean', summary: `Points are 2MASS Redshift Survey galaxies at their measured sky positions. Their line-of-sight positions are NOT taken from their redshifts: peculiar velocities inside a cluster (hundreds of km/s) smear redshift distances over tens of Mpc ("fingers of God"), so every point is placed at the cluster-mean SBF distance (16.5 Mpc). The membership cut is ours, not a published list.`, exaggerations: ['Line-of-sight depth is flattened to the cluster-mean distance; the real cluster is about 2.4 Mpc deep (back-to-front).'] },
    imageAssetIds: [], ...(twomrs ? { pointsFileId: 'twomrs' } : {}),
    notes: `Position and distance: M87 (cluster A) and the SBF cluster mean. Membership names are the 2MRS rows passing the cut documented in the facts.`,
  };
  if (twomrs && virgoNames.length) (virgo as { membership?: DeepSpaceObject['membership'] }).membership = { pointsFileId: 'twomrs', names: virgoNames, basis: `Our cut, not a published membership: 2MRS galaxies within ${CONE_DEG} deg of M87 (RA ${round(m87.sky!.raDeg, 4)}, Dec ${round(m87.sky!.decDeg, 4)}) with heliocentric cz between ${CZ_MIN} and ${CZ_MAX} km/s (symmetric about the cluster mean of roughly 1100 km/s only approximately; includes blueshifted infalling members such as M86, M90, M98; still contaminated by foreground and background galaxies).`, source: catSrc(twomrs) };
  objects.push(virgo);

  // ---- image ids ----
  const noImage: string[] = [];
  const withImages = objects.map((o) => {
    const ids = images.get(o.id) ?? [];
    if (ids.length === 0 && !['local-group', 'm81-group', 'virgo-cluster', 'milky-way'].includes(o.id)) noImage.push(o.id);
    return { ...o, imageAssetIds: ids };
  });
  const unknownImageObjects = [...images.keys()].filter((k) => !objects.some((o) => o.id === k));

  const file: DeepSpaceFile = {
    manifest: {
      schema: 'atlas-deep-space/1', generated: TODAY, builtBy: 'tools/deepspace/build_objects.ts',
      sources: [...sources.values()].sort((a, b) => a.key.localeCompare(b.key)),
    },
    objects: withImages,
    models: { 'milky-way': mw.model as DocumentedModel },
  };

  // ---- validate ----
  const cats: Record<string, PointCatalogueFile> = {};
  for (const id of ['ungc', 'local-group-mcconnachie', 'twomrs', ...CLUSTERS.map((c) => c.pointsFileId)]) { const f = readCatalogue(id); if (f) cats[id] = f; }
  const rep = validateDeepSpaceFile(file, { catalogues: cats });
  for (const w of rep.warnings) log(`warning ${w.path}: ${w.message}`);
  if (!rep.ok) { for (const e of rep.errors) console.error(`ERROR ${e.path} [${e.code}] ${e.message}`); throw new Error(`validation failed with ${rep.errors.length} error(s)`); }

  mkdirSync(join(ROOT, 'public', 'data'), { recursive: true });
  writeFileSync(OUT, JSON.stringify(file, null, 1) + '\n');
  log(`wrote ${OUT} (${objects.length} objects, ${(readFileSync(OUT).length / 1024).toFixed(0)} kB)`);
  writeDoc(file, { noImage, unknownImageObjects, virgoCount: virgoNames.length, m81Count: m81Names.length, reflectionId: refl.id });
  log(`wrote ${DOC}`);
  if (noImage.length) log(`objects without any image asset id: ${noImage.join(', ')}`);
  if (unknownImageObjects.length) log(`image manifests name object ids that are not in this file: ${unknownImageObjects.join(', ')}`);
}

function dist_label(o: DeepSpaceObject): string {
  const d = o.sky?.distance; return d ? `${o.name} distance: ${d.source.release ?? d.source.source} (${d.source.recordId ?? ''})` : o.name;
}

// ---- documentation ---------------------------------------------------------------------------------------------------

function fmtM(m: Measurement | undefined): string {
  if (!m) return '-';
  return `${m.value}${m.uncertainty !== undefined ? ` ± ${m.uncertainty}` : ''} ${m.unit}`;
}
function writeDoc(file: DeepSpaceFile, ctx: { noImage: string[]; unknownImageObjects: string[]; virgoCount: number; m81Count: number; reflectionId: string }): void {
  const L: string[] = [];
  L.push('# Deep-space named objects: data, sources and omissions', '', `Generated by \`tools/deepspace/build_objects.ts\` on ${TODAY}. Output: \`public/data/deep-space.v1.json\` (type \`DeepSpaceFile\`, \`src/data/deepspace/types.ts\`). This page is regenerated by the build; edit the build, not the page.`, '');
  L.push('## Rebuild', '', '```', 'npx tsx tools/deepspace/build_objects.ts            # fetches what is not cached', 'npx tsx tools/deepspace/build_objects.ts --offline  # exact rebuild from data/cache/deepspace/objects (fails on a cache miss)', '```', '', 'Every raw response (SIMBAD TAP answers, VizieR TSV, HyperLEDA csv, NED-D csv, arXiv API entries, ar5iv pages, the Baumgardt table) is stored verbatim in `data/cache/deepspace/objects/` and listed, with its URL and retrieval date, in `index.json` there. The cache is not committed. The output is validated with `validateDeepSpaceFile` (`src/data/deepspace/validate.ts`) before it is written; the build fails on any error.', '');
  L.push('## How values are obtained', '',
    '- **Positions, object type, morphology string, magnitudes, radial velocity**: SIMBAD (CfA mirror TAP service), tables `basic`, `flux`, `mesDistance`, `ident`. The morphology string is the catalogue\'s own; `galaxyClass` is derived from it by `classifyGalaxy` (`src/core/deepspace/classify.ts`). When SIMBAD\'s string is numeric-only or cannot be classified, HyperLEDA\'s `type` is used and the other string is recorded in the object\'s facts.',
    '- **Galaxy angular size (D25), axis ratio, position angle, inclination**: HyperLEDA `ledacat.cgi`. D25 = 10^logd25 × 0.1 arcmin. HyperLEDA publishes no uncertainty for these. Its inclination is, per the documented HyperLEDA procedure (not verified in this build), computed from the axis ratio and type; it is **not** used for ellipticals or for the Sombrero (whose HyperLEDA axis ratio gives an inclination far from the edge-on appearance).',
    '- **Distances**: always redshift-independent for the named objects. One primary measurement per object, chosen as described below; the values are read from the paper\'s abstract (checked against the fetched text), from a NED-D record, or from a VizieR catalogue row. The other values SIMBAD lists, and the spread of NED-D records, are given in each object\'s facts so that the single drawn value is not mistaken for the only one.',
    '- **Derived values** (physical diameter = 2 d tan(θ/2), absolute magnitude, age in Myr, distances from a distance modulus) are `kind: "derived"` with their `transformations`. Uncertainty is propagated from the distance only (no angular-size or photometric-calibration uncertainty is published for those inputs). Absolute magnitudes are **not** corrected for extinction.',
    '- **Combined uncertainties**: where a paper gives statistical and systematic terms, the stored uncertainty is their quadrature sum and the note says so; asymmetric intervals are stored as their mean half-width and the note gives the asymmetric values.', '');
  L.push('## Sources used', '', '| key | what | retrieved | licence / terms |', '|---|---|---|---|');
  for (const s of file.manifest.sources) L.push(`| ${s.key} | [${s.title.replace(/\|/g, '/')}](${s.url})${s.note ? ` - ${s.note}` : ''} | ${s.retrieved} | ${s.licence.replace(/\|/g, '/')} |`);
  L.push('', 'The NED TAP service (`ned.ipac.caltech.edu/tap`) was reachable but its `objdir` table has no morphology or distance columns; NED is therefore used only through NED-D. The Strasbourg VizieR host returned 404 for the ASU interface; the CfA mirror was used.', '');
  L.push('## Primary distance of every object', '', '| id | kind | distance | kind of value | reference |', '|---|---|---|---|---|');
  for (const o of file.objects) { const d = o.sky?.distance; L.push(`| ${o.id} | ${o.kind} | ${d ? fmtM(d) : 'none (see unavailable)'} | ${d?.kind ?? '-'} | ${d ? `${d.source.release ?? d.source.source}${d.source.recordId ? ' - ' + d.source.recordId : ''}`.replace(/\|/g, '/') : '-'} |`); }
  L.push('', '## Representation of every object', '', '| id | representation | depth | image ids |', '|---|---|---|---|');
  for (const o of file.objects) L.push(`| ${o.id} | ${o.representation.kind} | ${o.representation.depth} | ${o.imageAssetIds.length ? o.imageAssetIds.join(', ') : '(none yet)'} |`);
  L.push('', '## What each value is', '',
    '| measurement key | meaning |', '|---|---|',
    '| `distance` | primary distance (same object as `sky.distance`) |', '| `distanceModulus` | (m-M) as tabulated by the source, when the distance was computed from it |', '| `magB`, `magV`, `magK` | SIMBAD apparent integrated magnitudes (bibcode in the source) |', '| `magB_total_hyperleda`, `magV_total_harris` | catalogue total magnitudes |', '| `absMagB`, `absMagV` | derived, **no extinction correction** |',
    '| `physicalDiameterD25` / `physicalDiameter` | derived projected linear diameter from the stated angular size definition |', '| `radialVelocity` | heliocentric, SIMBAD (type flag in the note) |', '| `memberCount` | open clusters: Hunt & Reffert 2023 member stars; groups: rows passing the stated rule |', '| `memberCountProperMotion`/`...RadialVelocity` | globular clusters: stars with measurements used in Baumgardt\'s fits (not a census) |',
    '| `logAge`, `age` | Hunt & Reffert 2023 model estimate (open clusters); `age` is the derived Myr conversion |', '| `mass` | globular clusters: Baumgardt N-body fit mass (modelled) |', '| `metallicityFeH` | [Fe/H] from Dias et al. 2021 (open) or the Harris catalogue (globular) |', '| `halfNumberRadius`, `tidalRadius`, `totalRadius` | Hunt & Reffert radii converted to pc |', '');
  L.push('## Choices that are ours (not published)', '',
    '- The reflection nebula is **' + ctx.reflectionId + '** (the roster allowed any of M78, NGC 1999, NGC 7023, Pleiades nebulosity). The build uses the first candidate unless the nebula image manifest names a different reflection-nebula object id that the roster knows.',
    '- The Zucker et al. (2020) distance of a nebula is **modelled** (a 3D dust-extinction model along sightlines): the median of d50 over ALL catalogued sightlines within 1° of the object\'s SIMBAD position; the stored uncertainty is sqrt((half the full range of those medians)² + (median catalogue error)²), a descriptive scatter by our rule. All sightlines are listed in the measurement\'s transformations. It is the distance of the dust cloud, not of the nebula or its illuminating stars.',
    `- Virgo Cluster members (${ctx.virgoCount} galaxies) are the 2MRS rows within 6° of M87 with −500 ≤ cz ≤ 2500 km/s. This window is ours, not a published membership: it includes the blueshifted infalling members (M86, M90, M98) but is still contaminated by foreground and background galaxies.`,
    `- M81 Group members (${ctx.m81Count} galaxies) are M81 plus the UNGC rows with main disturber M81 and tidal index Θ1 > 0, which is the group definition printed in the UNGC paper (verified against the paper text by the build).`,
    '- Local Group members are all rows of the McConnachie (2012) file, including the "nearby neighbour" rows; the subgroup flag stays in the point file.',
    '- Disc orientation: `nearSide` is `unknown` for every galaxy: none of the sources retrieved here states which side is nearer. M31, M33 and M81 use HyperLEDA inclination/PA; the LMC uses the classical-Cepheid fit of Inno et al. 2016 (an old-population tracer would give different values, as that paper reports).',
    '- Exaggerations: the data apply no size boost to any object. Listed under `representation.exaggerations`: deprojection (stretching by 1/cos i), the flattening of Virgo depth to a cluster-mean distance, the hash-seeded illustrative line-of-sight offsets of globular-cluster stars (depth `illustrative`), the brightness-split illustrative depth layers of the nebulae (depth `illustrative-layers`) and the smooth drawing of Milky Way arms. A renderer that enlarges markers must declare that itself.',
    '- Milky Way morphology: the stored label is the literature range "SBb - SBbc" (Kormendy 2019), not a catalogue string (`morphologyNote`); the coarse class is derived from its upper end "SBbc" (`morphologyClassBasis`).', '');
  L.push('## Left out or unavailable', '', '| object | quantity | reason |', '|---|---|---|');
  const seen = new Set<string>();
  for (const o of file.objects) for (const [k, v] of Object.entries(o.unavailable ?? {})) { const key = `${o.id}.${k}`; seen.add(key); L.push(`| ${o.id} | ${k} | ${v.replace(/\|/g, '/')} |`); }
  for (const d of dropped) { const key = `${d.id}.${d.what}`; if (seen.has(key)) continue; L.push(`| ${d.id} | ${d.what} | ${d.why.replace(/\|/g, '/')} |`); }
  L.push('', '### Objects that are not in the file', '', 'None of the roster objects was dropped as an object. Per-quantity gaps are in the table above.', '');
  L.push('## Image asset ids', '', ctx.noImage.length ? `At build time no image asset id existed for: ${ctx.noImage.join(', ')}. Re-run the build after the image manifests (\`tools/deepspace/images/galaxies.json\`, \`nebulae.json\`) change; ids are read from them and matched by \`objectId\`.` : 'Every galaxy and nebula has at least one image asset id.', ctx.unknownImageObjects.length ? `\n\nThe manifests name object ids that are not in this file: ${ctx.unknownImageObjects.join(', ')}.` : '', '');
  L.push('## Per-object summary', '');
  for (const o of file.objects) {
    L.push(`### ${o.name} (\`${o.id}\`)`, '', `- kind: ${o.kind}${o.galaxyClass ? ` / ${o.galaxyClass}` : ''}${o.nebulaClass ? ` / ${o.nebulaClass}` : ''}${o.clusterClass ? ` / ${o.clusterClass}` : ''}${o.morphologyLabel ? `; catalogue morphology "${o.morphologyLabel}"` : ''}`);
    if (o.sky) L.push(`- position (ICRS): RA ${o.sky.raDeg.toFixed(5)}°, Dec ${o.sky.decDeg.toFixed(5)}°; distance ${fmtM(o.sky.distance)}`);
    if (o.angularSize) L.push(`- angular size: ${o.angularSize.majorArcmin}′${o.angularSize.minorArcmin ? ` × ${o.angularSize.minorArcmin}′` : ''} - ${o.angularSize.definition}`);
    if (o.orientation) L.push(`- orientation: inclination ${fmtM(o.orientation.inclinationDeg)}, PA ${fmtM(o.orientation.positionAngleDeg)}, near side ${o.orientation.nearSide}`);
    L.push(`- representation: ${o.representation.summary}`);
    if (o.representation.exaggerations?.length) L.push(`- exaggerations: ${o.representation.exaggerations.join(' | ')}`);
    L.push('');
  }
  L.push('## Milky Way model', '', `\`models["milky-way"]\`: ${file.models['milky-way']!.parameters.length} parameters, ${Object.keys(file.models['milky-way']!.tables ?? {}).length} tables. Every parameter value was matched to a string in the fetched source text during the build (Bland-Hawthorn & Gerhard 2016 through ar5iv, Reid et al. 2019 through ar5iv, GRAVITY 2019 and Reid 2019 abstracts). Table \`spiral-arms-reid2019\` is Reid et al. (2019) Table 2 parsed from the ar5iv page. Limitations are listed in the model and shown below.`, '');
  for (const l of file.models['milky-way']!.limitations) L.push(`- ${l}`);
  L.push('', 'The VizieR table J/ApJ/885/131 holds the maser parallaxes (Reid et al. 2019 Table 1), not the arm fits; the arm table therefore comes from the paper text.', '');
  writeFileSync(DOC, L.join('\n'));
}

main().catch((e) => { console.error(e); process.exit(1); });
