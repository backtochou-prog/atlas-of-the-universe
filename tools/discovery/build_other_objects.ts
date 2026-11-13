/**
 * Builds public/data/other-objects.v1.json (type OtherObjectsFile, src/discovery/types.ts).
 *
 *   npx tsx tools/discovery/build_other_objects.ts            fetch what is not cached, then build
 *   npx tsx tools/discovery/build_other_objects.ts --offline  rebuild from data/cache/discovery/other only
 *
 * Positions: SIMBAD TAP (basic.ra/dec, ICRS, SIMBAD's epoch-2000 coordinate) with SIMBAD's own coordinate bibcode.
 * Distances and facts: the abstract of a retrievable arXiv paper. Every typed number/phrase carries `evidence` strings that
 * must appear in the fetched abstract; the build aborts on a mismatch, so a claim can never drift from its source.
 * Anything without both a SIMBAD position and a cited distance is dropped (listed at the end of the run and in the manifest note).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUN_GALACTOCENTRIC_DISTANCE_PC } from '../../src/core/astro/constants';
import type { NoteClaim, OtherObject, OtherObjectsFile, ValueKind } from '../../src/discovery/types';
import { arxivAbs, type ArxivAbs } from './lib/arxiv';
import { DiscoveryCache, ROOT } from './lib/cache';
import { simbadQuery, SIMBAD_TAP, tidyId } from './lib/simbad';

const OFFLINE = process.argv.includes('--offline');
const cache = new DiscoveryCache('other', OFFLINE);
const log = (m: string) => console.log(`[other-objects] ${m}`);
const OUT = join(ROOT, 'public', 'data', 'other-objects.v1.json');
const DOC = join(ROOT, 'docs', 'DISCOVERY_DATA_STARS.md');

interface ClaimSpec { text: string; status: NoteClaim['status']; paper: string; evidence: string[] }
interface Spec {
  id: string; name: string; simbadId: string; category: OtherObject['category']; classification: string; extraDesignations: string[];
  paper: string; distance: { value: number; unit: 'pc' | 'kpc' | 'Mpc'; uncertainty?: number; kind: ValueKind; evidence: string[]; note: string };
  claims: ClaimSpec[];
}

const SPECS: Spec[] = [
  {
    id: 'other:sgr-a-star', name: 'Sagittarius A*', simbadId: 'Sgr A*', category: 'other', classification: 'Massive black hole (Galactic Center)',
    extraDesignations: ['Sagittarius A*'],
    paper: '1904.05721',
    distance: { value: SUN_GALACTOCENTRIC_DISTANCE_PC, unit: 'pc', uncertainty: Math.round(Math.hypot(13, 22) * 10) / 10, kind: 'derived', evidence: ['R0 = 8178 +- 13(stat.) +- 22(sys.) pc'], note: 'R0 = 8178 pc, the distance of the Sun from Sgr A*, geometric (orbit of S2). Uncertainty stored = statistical 13 pc and systematic 22 pc added in quadrature (our arithmetic).' },
    claims: [
      { text: 'The distance from the Sun to the Galactic Center, R0, is 8178 pc with a statistical uncertainty of 13 pc and a systematic uncertainty of 22 pc, a geometric estimate from the orbit of the star S2 around Sgr A*.', status: 'inferred', paper: '1904.05721', evidence: ['R0 = 8178 +- 13(stat.) +- 22(sys.) pc', 'geometric distance estimate', 'S2'] },
      { text: 'S2 follows a 16-year orbit around the massive black hole Sgr A*; it was followed astrometrically and spectroscopically for 27 years.', status: 'observed', paper: '1904.05721', evidence: ['16-year orbit around the massive black hole Sgr A*', '27 years'] },
      { text: 'S2 passed the pericenter of its highly eccentric orbit in May 2018, and the passage was followed with dense sampling throughout the year.', status: 'observed', paper: '1904.05721', evidence: ['pericenter of its highly eccentric orbit in May 2018'] },
      { text: 'The gravitational redshift term in the S2 data is detected at a significance level of 20 sigma, with f_redshift = 1.04 +- 0.05.', status: 'observed', paper: '1904.05721', evidence: ['20 sigma', 'f_redshift = 1.04 +- 0.05'] },
    ],
  },
  {
    id: 'other:cyg-x-1', name: 'Cygnus X-1', simbadId: 'Cyg X-1', category: 'other', classification: 'High-mass X-ray binary containing a black hole',
    extraDesignations: ['Cygnus X-1'],
    paper: '2102.09091',
    distance: { value: 2.22, unit: 'kpc', uncertainty: 0.18, kind: 'derived', evidence: ['2.22^{+0.18}_{-0.17}', 'kiloparsecs', 'radio astrometry'], note: 'Radio-astrometry distance 2.22 +0.18 -0.17 kpc; the larger side (0.18) is stored as the uncertainty.' },
    claims: [
      { text: 'Radio astrometry gives a distance to the black hole X-ray binary Cygnus X-1 of 2.22 (+0.18, -0.17) kiloparsecs.', status: 'inferred', paper: '2102.09091', evidence: ['radio astrometry', 'black hole X-ray binary Cygnus X-1', '2.22^{+0.18}_{-0.17}'] },
      { text: 'Combined with previous optical data, this distance implies a black hole mass of 21.2 +- 2.2 solar masses, higher than previous measurements.', status: 'inferred', paper: '2102.09091', evidence: ['21.2\\pm2.2', 'higher than previous measurements'] },
    ],
  },
  {
    id: 'other:crab-pulsar', name: 'Crab Pulsar', simbadId: 'PSR B0531+21', category: 'other', classification: 'Pulsar',
    extraDesignations: ['Crab Pulsar'],
    paper: '2306.01617',
    distance: { value: 1.90, unit: 'kpc', uncertainty: 0.22, kind: 'derived', evidence: ['1.90^{+0.22}_{-0.18}', 'kpc'], note: 'VLBI radio parallax 0.53 +- 0.06 mas giving d = 1.90 +0.22 -0.18 kpc; the larger side (0.22) is stored as the uncertainty.' },
    claims: [
      { text: 'A VLBI radio parallax of the Crab Pulsar, 0.53 +- 0.06 mas, yields a distance of 1.90 (+0.22, -0.18) kpc.', status: 'inferred', paper: '2306.01617', evidence: ['parallax of $\\pi=0.53\\pm0.06', 'd=1.90^{+0.22}_{-0.18}'] },
      { text: 'Its proper motion is (-11.34 +- 0.06, 2.65 +- 0.14) mas/yr in (RA, Dec), giving a transverse velocity of 104 (+13, -11) km/s.', status: 'observed', paper: '2306.01617', evidence: ['-11.34\\pm0.06', '2.65\\pm0.14', '104^{+13}_{-11}'] },
      { text: 'The radio parallax and proper motion are consistent with the Gaia 3 measurements.', status: 'observed', paper: '2306.01617', evidence: ['consistent with the Gaia 3 measurements'] },
    ],
  },
  {
    id: 'other:sn-1987a', name: 'SN 1987A', simbadId: 'SN 1987A', category: 'supernova-remnant', classification: 'Supernova (Large Magellanic Cloud)',
    extraDesignations: ['Supernova 1987A'],
    paper: 'astro-ph/0309416',
    distance: { value: 51.4, unit: 'kpc', uncertainty: 1.2, kind: 'derived', evidence: ['d(SN1987A) = 51.4 +/- 1.2 kpc'], note: 'Geometric distance to the supernova from the circumstellar ring size, 51.4 +- 1.2 kpc.' },
    claims: [
      { text: 'From the absolute size of the circumstellar ring, R = (6.23 +/- 0.08)e17 cm, and its angular size, 808 +/- 17 mas, the distance to SN 1987A is 51.4 +/- 1.2 kpc (distance modulus 18.55 +/- 0.05).', status: 'inferred', paper: 'astro-ph/0309416', evidence: ['(6.23 +/- 0.08)e17 cm', '808 +/- 17 mas', 'd(SN1987A) = 51.4 +/- 1.2 kpc', '18.55 +/- 0.05'] },
      { text: 'Allowing for the displacement of SN 1987A from the LMC centre, the distance to the barycenter of the Large Magellanic Cloud is estimated as 51.7 +/- 1.3 kpc.', status: 'inferred', paper: 'astro-ph/0309416', evidence: ['d(LMC)=51.7 +/- 1.3 kpc', 'barycenter of the Large Magellanic Cloud'] },
    ],
  },
  {
    id: 'other:eta-carinae', name: 'Eta Carinae', simbadId: 'eta Car', category: 'star', classification: 'Massive star surrounded by the Homunculus nebula',
    extraDesignations: ['Eta Carinae'],
    paper: 'astro-ph/0602464',
    distance: { value: 2350, unit: 'pc', uncertainty: 50, kind: 'derived', evidence: ['2350pm50 pc'], note: 'Distance 2350 +- 50 pc from the shape of the Homunculus nebula; a later paper argues the oft-quoted distance may be too small, see facts.' },
    claims: [
      { text: 'Near-infrared long-slit spectra of the Homunculus nebula resolve it into a thin outer shell seen in H2 and a warmer, thicker inner layer seen in [Fe II]; the H2 emission yields the shape of the nebula, a distance of 2350 +- 50 pc and an inclination angle of 41 degrees.', status: 'inferred', paper: 'astro-ph/0602464', evidence: ['2350pm50 pc', 'inclination angle of 41deg', 'thin outer shell seen in H2'] },
      { text: 'Gaia parallaxes for the star cluster Trumpler 16 reveal a discrepancy in the oft-quoted distance of Eta Carinae; the authors state it is probably more distant and more luminous.', status: 'hypothesis', paper: '1808.02073', evidence: ['Gaia parallaxes for the star cluster Tr 16 reveal a discrepancy in the oft-quoted distance of Eta Carinae', 'probably more distant and more luminous'] },
    ],
  },
  {
    id: 'other:vela-pulsar', name: 'Vela Pulsar', simbadId: 'PSR B0833-45', category: 'other', classification: 'Pulsar',
    extraDesignations: ['Vela Pulsar'],
    paper: 'astro-ph/0302374',
    distance: { value: 293, unit: 'pc', uncertainty: 19, kind: 'derived', evidence: ['293_{-17}^{+19}', 'parallax of $3.4 \\pm 0.2$ mas'], note: 'VLBI parallax 3.4 +- 0.2 mas equivalent to 293 (+19, -17) pc; the larger side (19) is stored as the uncertainty.' },
    claims: [
      { text: 'VLBI observations at 2.3 and 8.4 GHz over 6.8 years (eleven epochs) give a parallax for the Vela pulsar of 3.4 +- 0.2 mas, equivalent to a distance of 293 (+19, -17) pc.', status: 'inferred', paper: 'astro-ph/0302374', evidence: ['parallax of $3.4 \\pm 0.2$ mas', '293_{-17}^{+19}', '6.8 years', 'eleven epochs'] },
      { text: 'Its proper motion is -49.61 +- 0.06 mas/yr in RA (times cos dec) and 29.8 +- 0.1 mas/yr in Dec.', status: 'observed', paper: 'astro-ph/0302374', evidence: ['-49.61 \\pm 0.06', '29.8 \\pm 0.1'] },
      { text: 'The Vela pulsar is the brightest pulsar at radio wavelengths.', status: 'observed', paper: 'astro-ph/0302374', evidence: ['brightest pulsar at radio wavelengths'] },
    ],
  },
];

const norm = (s: string) => s.replace(/\s+/g, ' ');

async function main(): Promise<void> {
  const papers = new Map<string, ArxivAbs>();
  const need = [...new Set(SPECS.flatMap((s) => [s.paper, ...s.claims.map((c) => c.paper)]))];
  const dropped: { id: string; why: string }[] = [];
  const paperFailed = new Set<string>();
  for (const id of need) {
    try { papers.set(id, await arxivAbs(cache, id)); log(`arXiv ${id}: ${papers.get(id)!.title}`); }
    catch (e) { paperFailed.add(id); log(`arXiv ${id} FAILED: ${(e as Error).message}`); }
  }
  // SIMBAD positions + otype descriptions
  const esc = (x: string) => x.replace(/'/g, "''");
  const HDR = ['q', 'main_id', 'otype', 'ra', 'dec', 'coo_bibcode', 'coo_err_maj', 'coo_wavelength'];
  const h = HDR;
  const byQ = new Map<string, string[]>();
  const idsByQ = new Map<string, string[]>();
  const posRows: string[][] = [];
  let retrievedPos = '';
  for (const spec of SPECS) {
    const k = spec.simbadId.toLowerCase();
    // one query per object: SIMBAD returns the stored identifier in `id`, not the spelling queried, so rows are keyed by the query that produced them
    const r1 = await simbadQuery(cache, `SELECT b.main_id, b.otype, b.ra, b.dec, b.coo_bibcode, b.coo_err_maj, b.coo_wavelength FROM basic AS b JOIN ident AS i ON i.oidref=b.oid WHERE i.id='${esc(spec.simbadId)}'`, `SIMBAD position ${spec.simbadId}`);
    retrievedPos = r1.retrieved;
    if (r1.rows[0]) { const row = [spec.simbadId, ...r1.rows[0]]; byQ.set(k, row); posRows.push(row); }
    const r2 = await simbadQuery(cache, `SELECT i2.id FROM ident AS i1 JOIN ident AS i2 ON i1.oidref=i2.oidref WHERE i1.id='${esc(spec.simbadId)}'`, `SIMBAD identifiers ${spec.simbadId}`);
    idsByQ.set(k, r2.rows.map((r) => tidyId(r[0]!)));
  }
  const pos = { rows: posRows, retrieved: retrievedPos };
  const KEEP = /^(NAME |\* |V\* |HD |HIP |HR |PSR [BJ]|SN |SNR |GJ |Gl |HR |LBV )/;
  const otypes = [...new Set(pos.rows.map((r) => r[h.indexOf('otype')]!))];
  const od = await simbadQuery(cache, `SELECT otype, description FROM otypedef WHERE otype IN (${otypes.map((o) => `'${o}'`).join(',')})`, 'SIMBAD otype descriptions');
  const otypeDesc = new Map(od.rows.map((r) => [r[0]!, r[1]!]));
  const simbadRef = (label: string) => ({ label, url: SIMBAD_TAP, retrieved: pos.retrieved });

  const objects: OtherObject[] = [];
  for (const spec of SPECS) {
    const row = byQ.get(spec.simbadId.toLowerCase());
    const fail = (why: string) => { dropped.push({ id: spec.id, why }); log(`DROPPED ${spec.id}: ${why}`); };
    if (!row) { fail(`SIMBAD returned no row for identifier "${spec.simbadId}"`); continue; }
    const paper = papers.get(spec.paper);
    if (!paper) { fail(`distance paper arXiv:${spec.paper} could not be retrieved`); continue; }
    const ra = Number(row[h.indexOf('ra')]), dec = Number(row[h.indexOf('dec')]);
    if (!Number.isFinite(ra) || !Number.isFinite(dec)) { fail('SIMBAD gives no coordinates'); continue; }
    const check = (ev: string[], p: ArxivAbs, what: string): string | null => {
      const text = norm(p.abstract);
      const miss = ev.filter((e) => !text.includes(norm(e)));
      return miss.length ? `${what}: evidence not found in arXiv:${p.id} abstract: ${miss.join(' | ')}` : null;
    };
    const dErr = check(spec.distance.evidence, paper, 'distance');
    if (dErr) throw new Error(`${spec.id}: ${dErr}`);
    const mainId = tidyId(row[h.indexOf('main_id')]!);
    const otype = row[h.indexOf('otype')]!;
    const bib = row[h.indexOf('coo_bibcode')] ?? '';
    const err = row[h.indexOf('coo_err_maj')] ?? '';
    const wl = row[h.indexOf('coo_wavelength')] ?? '';
    const paperRef = (p: ArxivAbs) => ({ label: `${p.authors[0] ?? ''}${p.authors.length > 1 ? ' et al.' : ''} (${p.date.slice(0, 4)}), "${p.title}", arXiv:${p.id}${p.doi ? `, doi:${p.doi}` : ''}`, url: p.url, retrieved: p.retrieved });
    const claims: NoteClaim[] = [];
    let skipObject = false;
    for (const c of spec.claims) {
      const p = papers.get(c.paper);
      if (!p) { dropped.push({ id: `${spec.id} claim`, why: `paper arXiv:${c.paper} not retrievable; claim "${c.text.slice(0, 60)}..." dropped` }); continue; }
      const e = check(c.evidence, p, 'claim');
      if (e) throw new Error(`${spec.id}: ${e}`);
      claims.push({ text: c.text, status: c.status, references: [paperRef(p)] });
    }
    if (skipObject) continue;
    // classification fact straight from SIMBAD (a catalogue statement, labelled as such)
    claims.push({
      text: `SIMBAD's main identifier for this object is "${mainId}" and its main object type is ${otype} (${otypeDesc.get(otype) ?? 'description not retrieved'}).`,
      status: 'observed', references: [simbadRef('SIMBAD basic + otypedef tables')],
    });
    const coordNote = `SIMBAD main object "${mainId}"; SIMBAD ICRS position (epoch 2000 coordinate as given by SIMBAD), coordinate reference ${bib || 'n/a'}${wl ? `, wavelength ${wl}` : ''}${err ? `, major error axis ${err} mas` : ''}`;
    objects.push({
      id: spec.id, name: spec.name, designations: [...new Set([spec.name, ...spec.extraDesignations, spec.simbadId, mainId, ...(idsByQ.get(spec.simbadId.toLowerCase()) ?? []).filter((x) => KEEP.test(x)).map((x) => x.replace(/^NAME /, '').replace(/^\* /, ''))])], category: spec.category, classification: spec.classification,
      raDeg: ra, decDeg: dec,
      distance: { value: spec.distance.value, unit: spec.distance.unit, uncertainty: spec.distance.uncertainty, kind: spec.distance.kind, source: paperRef(paper) },
      coordinateSource: { label: coordNote, url: SIMBAD_TAP, retrieved: pos.retrieved },
      facts: claims,
    });
    log(`${spec.id}: ra=${ra.toFixed(6)} dec=${dec.toFixed(6)} d=${spec.distance.value} ${spec.distance.unit}; ${spec.distance.note}`);
  }
  // consistency with the atlas constant
  const sgr = objects.find((o) => o.id === 'other:sgr-a-star');
  if (sgr && sgr.distance && sgr.distance.value !== SUN_GALACTOCENTRIC_DISTANCE_PC) throw new Error('Sgr A* distance differs from SUN_GALACTOCENTRIC_DISTANCE_PC');

  const file: OtherObjectsFile = {
    manifest: {
      schema: 'atlas-other-objects/1',
      generated: new Date().toISOString().slice(0, 10),
      note: `Objects that fit no other dataset. Each has a SIMBAD position and a distance from a cited paper abstract (retrieved via arxiv.org/abs pages and SIMBAD TAP at ${SIMBAD_TAP}). Distances are published estimates with the paper's method (geometric / VLBI parallax / expansion geometry), uncertainties as published (asymmetric ones store the larger side, the text of each fact has both). Positions are SIMBAD epoch-2000 ICRS coordinates; moving objects (pulsars, Cyg X-1) are not propagated. Considered and dropped: ${dropped.length ? dropped.map((d) => `${d.id} (${d.why})`).join('; ') : 'none of the six candidates; no other candidate was examined'}. Candidates were Sagittarius A*, Cygnus X-1, Crab Pulsar, SN 1987A, Eta Carinae, Vela Pulsar. Eta Carinae's distance is contested (see its facts). SIMBAD terms and CDS acknowledgement text were not retrieved (cds.unistra.fr licence page returned 404).`,
    },
    objects,
  };
  mkdirSync(join(ROOT, 'public', 'data'), { recursive: true });
  writeFileSync(OUT, JSON.stringify(file, null, 1) + '\n');
  const MARK = '<!-- other-objects:start -->';
  const sec = `${MARK}
## Other objects (public/data/other-objects.v1.json)

Built by \`tools/discovery/build_other_objects.ts\` on ${file.manifest.generated}. Position: SIMBAD TAP (${SIMBAD_TAP}). Distance and facts: the arXiv abstract named in each fact. Every typed number/phrase is checked against the fetched abstract during the build.

| Object | RA, Dec (deg, ICRS, SIMBAD) | Distance (as published) | Distance source |
|---|---|---|---|
${objects.map((o) => `| ${o.name} | ${o.raDeg.toFixed(6)}, ${o.decDeg.toFixed(6)} | ${o.distance!.value} ${o.distance!.unit} (stored uncertainty ${o.distance!.uncertainty}) | ${o.distance!.source.label} |`).join('\n')}

Notes: Sagittarius A* uses the same 8178 pc as \`SUN_GALACTOCENTRIC_DISTANCE_PC\` (the build asserts equality). Asymmetric published errors are stored as the larger side; both sides are in the fact text. Cygnus X-1's SIMBAD position is that of its optical component HD 226868. Pulsar and star positions are SIMBAD epoch-2000 values and are not propagated. Eta Carinae's distance is contested (second fact). Candidates dropped: ${dropped.length ? dropped.map((d) => `${d.id} (${d.why})`).join('; ') : 'none (all six candidates were supported); no further candidates were examined'}.
`;
  const prevDoc = existsSync(DOC) ? readFileSync(DOC, 'utf8') : '';
  const base = prevDoc.includes(MARK) ? prevDoc.slice(0, prevDoc.indexOf(MARK)).trimEnd() : prevDoc.trimEnd();
  if (base) writeFileSync(DOC, `${base}\n\n${sec}`);
  log(`wrote ${OUT}: ${objects.length} objects, ${objects.reduce((n, o) => n + o.facts.length, 0)} facts; dropped ${dropped.length}`);
  for (const d of dropped) log(`dropped ${d.id}: ${d.why}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
