/**
 * The Milky Way DocumentedModel. Every number is read from a fetched source and carries an evidence string that is
 * checked against the cached text (ar5iv full text of Bland-Hawthorn & Gerhard 2016 and Reid et al. 2019, arXiv abstracts):
 * the build aborts if a string is not found, so nothing here is recalled from memory.
 */
import type { DocumentedModel, ModelParameter } from '../../../../src/data/deepspace/types';
import { SUN_GALACTOCENTRIC_DISTANCE_PC } from '../../../../src/core/astro/constants';
import { retrievalDate } from './cache';
import { ar5ivCell, ar5ivHtml, ar5ivText, arxivEntry, requireEvidence } from './sources';

const BHG = '1602.07702';
const REID = '1910.03357';
const BHG_REF = 'Bland-Hawthorn & Gerhard 2016, ARA&A 54, 529 (arXiv:1602.07702), recommended value from the review\'s margin-note summary';
const BHG_URL = 'https://arxiv.org/abs/1602.07702';
const REID_REF = 'Reid et al. 2019, ApJ 885, 131 (arXiv:1910.03357)';
const REID_URL = 'https://arxiv.org/abs/1910.03357';

interface P { name: string; value: number; unit: string; unc?: number; needle: string; note?: string }

// needle strings are the review's own wording (glyphs as rendered by ar5iv; whitespace and zero-width characters ignored)
const BHG_PARAMS: P[] = [
  { name: 'Sun-Galactic Centre distance R0 (review best estimate)', value: 8.2, unit: 'kpc', unc: 0.1, needle: '8.2±0.1 kpc, Sun' },
  { name: 'Sun height above the local disc midplane z0', value: 25, unit: 'pc', unc: 5, needle: '25±5 pc, solar offset from local disk midplane' },
  { name: 'Circular rotation speed at the Sun Theta0', value: 238, unit: 'km/s', unc: 15, needle: '238±15 km s-1, circular rotation velocity at the Sun' },
  { name: 'Circular orbit frequency at the Sun Omega0', value: 29.0, unit: 'km/s/kpc', unc: 1.8, needle: '29.0±1.8 km s-1 kpc-1, circular orbit frequency at the Sun' },
  { name: 'Solar peculiar motion U (towards the Galactic Centre) relative to the LSR', value: 10.0, unit: 'km/s', unc: 1, needle: '10.0±1 km s-1, solar motion in U' },
  { name: 'Solar peculiar motion V (rotation direction) relative to the LSR', value: 11.0, unit: 'km/s', unc: 2, needle: '11.0±2 km s-1, solar motion in V' },
  { name: 'Solar peculiar motion W (towards the north Galactic pole) relative to the LSR', value: 7.0, unit: 'km/s', unc: 0.5, needle: '7.0±0.5 km s-1, solar motion in W' },
  { name: 'Thin disc exponential scale height z_t at R0', value: 300, unit: 'pc', unc: 50, needle: '300±50 pc, thin disk vertical scalelength at R0' },
  { name: 'Thick disc exponential scale height z_T at R0', value: 900, unit: 'pc', unc: 180, needle: '900±180 pc, thick disk vertical scalelength at R0' },
  { name: 'Thin disc exponential scale length R_t', value: 2.6, unit: 'kpc', unc: 0.5, needle: '2.6±0.5 kpc, thin disk radial scalelength' },
  { name: 'Thick disc exponential scale length R_T', value: 2.0, unit: 'kpc', unc: 0.2, needle: '2.0±0.2 kpc, thick disk radial scalelength' },
  { name: 'Thick/thin disc local density ratio f_rho at R0', value: 0.04, unit: 'dimensionless', unc: 0.02, needle: '4%±2%, thick / thin disk local density ratio at R0' },
  { name: 'Thick/thin disc surface density ratio f_Sigma at R0', value: 0.12, unit: 'dimensionless', unc: 0.04, needle: '12%±4%, thick / thin disk surface density ratio at R0' },
  { name: 'Thin disc stellar mass M_t', value: 3.5e10, unit: 'Msun', unc: 1e10, needle: '3.5±1×1010 M⊙, thin disk stellar mass', note: 'exponent read from the flattened "1010" in the source text (10^10)' },
  { name: 'Thick disc stellar mass M_T', value: 6e9, unit: 'Msun', unc: 3e9, needle: '6±3×109 M⊙, thick disk stellar mass', note: 'exponent read from the flattened "109" in the source text (10^9)' },
  { name: 'Total stellar mass of the Galaxy M_star', value: 5e10, unit: 'Msun', unc: 1e10, needle: '5±1×1010M⊙, total stellar mass of the Galaxy', note: 'exponent read from the flattened "1010" in the source text (10^10)' },
  { name: 'Box/peanut bulge bar angle phi_bp (between major axis and the Sun-Galactic Centre line; near side in the first Galactic quadrant)', value: 27, unit: 'deg', unc: 2, needle: '27±2∘, b/p bulge bar angle' },
  { name: 'Box/peanut bulge axis ratio b/a seen from the top', value: 0.5, unit: 'dimensionless', unc: 0.05, needle: '0.5±0.05, axis ratio from top' },
  { name: 'Box/peanut bulge edge-on axis ratio c/a (x~0)', value: 0.26, unit: 'dimensionless', needle: '0.26, edge-on axis ratio' },
  { name: 'Box/peanut bulge vertical scale height (x~0)', value: 180, unit: 'pc', needle: '180 pc, vertical scale-height' },
  { name: 'Radius of maximum X-shape in the bulge x_X', value: 1.5, unit: 'kpc', unc: 0.2, needle: '1.5±0.2 kpc, radius of max. X' },
  { name: 'Dynamical mass in the VVV bulge region', value: 1.84e10, unit: 'Msun', unc: 0.07e10, needle: '1.84±0.07×1010 M⊙, dynamical mass in vvv bulge region', note: 'exponent read from the flattened "1010" (10^10)' },
  { name: 'Stellar mass in the VVV bulge region (lower end of the published range)', value: 1.4e10, unit: 'Msun', needle: '(1.4−1.7)×1010 M⊙, stellar mass in vvv bulge region', note: 'the review quotes a range 1.4-1.7e10 Msun; no 1-sigma' },
  { name: 'Stellar mass in the VVV bulge region (upper end of the published range)', value: 1.7e10, unit: 'Msun', needle: '(1.4−1.7)×1010 M⊙, stellar mass in vvv bulge region', note: 'see the lower end' },
  { name: 'Long bar angle phi_lb (lower end of published range)', value: 28, unit: 'deg', needle: '28∘−33∘, long bar angle', note: 'range 28-33 deg as published' },
  { name: 'Long bar angle phi_lb (upper end of published range)', value: 33, unit: 'deg', needle: '28∘−33∘, long bar angle', note: 'range 28-33 deg as published' },
  { name: 'Long bar half-length R_lb', value: 5.0, unit: 'kpc', unc: 0.2, needle: '5.0±0.2 kpc, bar half-length' },
  { name: 'Thin long bar vertical scale height', value: 180, unit: 'pc', needle: '180 pc, thin bar scale-height' },
  { name: 'Superthin long bar vertical scale height', value: 45, unit: 'pc', needle: '45 pc, superthin bar scale-height' },
  { name: 'Thin long bar stellar mass', value: 7e9, unit: 'Msun', unc: 1e9, needle: '7±1×109 M⊙, stellar mass of thin bar', note: 'published as ~7±1e9; exponent from the flattened "109"' },
  { name: 'Bar pattern speed Omega_b', value: 43, unit: 'km/s/kpc', unc: 9, needle: '43±9 km s-1 kpc-1 Bar pattern speed' },
  { name: 'Nuclear stellar disc break radius', value: 90, unit: 'pc', needle: '90 pc, NSD break radius', note: 'published as ~90 pc' },
  { name: 'Nuclear stellar disc vertical scale height', value: 45, unit: 'pc', needle: '45 pc, NSD vertical scale-height' },
  { name: 'Nuclear stellar disc stellar mass', value: 1.4e9, unit: 'Msun', unc: 0.6e9, needle: '(1.4±0.6)×109 M⊙, stellar mass of NSD', note: 'exponent from the flattened "109"' },
  { name: 'Nuclear star cluster half-light radius', value: 4.2, unit: 'pc', unc: 0.4, needle: '4.2±0.4 pc, half-light radius' },
  { name: 'Nuclear star cluster mass', value: 1.8e7, unit: 'Msun', unc: 0.3e7, needle: '(1.8±0.3)×107 M⊙, NSC mass', note: 'exponent from the flattened "107"' },
  { name: 'Supermassive black hole mass (Sgr A*)', value: 4.2e6, unit: 'Msun', unc: 0.2e6, needle: '(4.2±0.2×106) M⊙, mass of Galactic SMBH', note: 'exponent from the flattened "106"' },
  { name: 'Virial mass M_vir', value: 1.3e12, unit: 'Msun', unc: 0.3e12, needle: '1.3±0.3×1012 M⊙, Galactic virial mass', note: 'exponent from the flattened "1012"' },
  { name: 'Virial radius r_vir (scaled to Omega_M = 0.3)', value: 282, unit: 'kpc', unc: 30, needle: '282±30 kpc, Galactic virial radius scaled to' },
  { name: 'Total baryonic mass', value: 8.5e10, unit: 'Msun', unc: 1.3e10, needle: '8.5±1.3×1010 M⊙; Galactic total baryonic mass', note: 'exponent from the flattened "1010"' },
  { name: 'Local total mass surface density within |z| <= 1.1 kpc at R0', value: 70, unit: 'Msun/pc^2', unc: 5, needle: '70±5 M⊙ pc-2, total mass surface density' },
  { name: 'Local total mass density at R0', value: 0.097, unit: 'Msun/pc^3', unc: 0.013, needle: '0.097±0.013 M⊙ pc-3, local mass density at R0' },
];

export interface MilkyWayBuild {
  model: DocumentedModel;
  params: Record<string, ModelParameter>;
  distance: { value: number; unit: 'pc'; unc: number; note: string };
  sources: { key: string; title: string; url: string; retrieved: string; licence: string; note?: string }[];
  morphology: { label: string; evidence: string; cite: string };
  armRows: (number | string)[][];
}

export async function buildMilkyWay(): Promise<MilkyWayBuild> {
  const bhgHtml = await ar5ivHtml(BHG);
  const bhgText = ar5ivText(bhgHtml);
  const reidHtml = await ar5ivHtml(REID);
  const reidText = ar5ivText(reidHtml);
  const gravity = await arxivEntry('1904.05721');
  const reidAbs = await arxivEntry(REID);
  const kormendy = await arxivEntry('1810.10073');

  // --- GRAVITY ---
  requireEvidence(gravity.summary, 'R0 = 8178 +- 13(stat.) +- 22(sys.) pc', 'GRAVITY R0');
  if (Math.round(SUN_GALACTOCENTRIC_DISTANCE_PC) !== 8178) throw new Error('constants.ts SUN_GALACTOCENTRIC_DISTANCE_PC no longer matches GRAVITY 2019 (8178 pc)');
  const gravUnc = Math.hypot(13, 22);

  const parameters: ModelParameter[] = [];
  const params: Record<string, ModelParameter> = {};
  const add = (p: ModelParameter) => { parameters.push(p); params[p.name] = p; };

  add({ name: 'Sun-Galactic Centre distance R0 (GRAVITY 2019, geometric orbit of S2)', value: 8178, unit: 'pc', uncertainty: Math.round(gravUnc * 10) / 10, reference: 'GRAVITY Collaboration (Abuter et al.) 2019, A&A 625, L10 (arXiv:1904.05721): R0 = 8178 +- 13 (stat) +- 22 (sys) pc; uncertainty here = the two terms added in quadrature (our step); equals SUN_GALACTOCENTRIC_DISTANCE_PC in src/core/astro/constants.ts', url: 'https://arxiv.org/abs/1904.05721' });
  for (const p of BHG_PARAMS) {
    requireEvidence(bhgText, p.needle, `BHG16 ${p.name}`);
    add({ name: p.name, value: p.value, unit: p.unit, ...(p.unc !== undefined ? { uncertainty: p.unc } : {}), reference: `${BHG_REF}${p.note ? '; ' + p.note : ''}`, url: BHG_URL });
  }

  // --- Reid et al. 2019 abstract numbers ---
  const reidAbsNeedles: { name: string; value: number; unit: string; unc: number; needle: string }[] = [
    { name: 'Sun-Galactic Centre distance R0 (Reid 2019 maser fit)', value: 8.15, unit: 'kpc', unc: 0.15, needle: 'R0=8.15±0.15 kpc' },
    { name: 'Circular rotation speed at the Sun Theta0 (Reid 2019 maser fit)', value: 236, unit: 'km/s', unc: 7, needle: 'Θ0=236±7 km s-1' },
    { name: 'Full circular velocity of the Sun Theta0 + V_sun (Reid 2019)', value: 247, unit: 'km/s', unc: 4, needle: 'Θ0+V⊙=247±4 km s-1' },
  ];
  for (const r of reidAbsNeedles) {
    requireEvidence(reidText, r.needle, `Reid2019 ${r.name}`);
    add({ name: r.name, value: r.value, unit: r.unit, uncertainty: r.unc, reference: `${REID_REF}, abstract`, url: REID_URL });
  }
  requireEvidence(reidText, 'width of 336 pc at 8.15 kpc radius and a slope of 36 pc kpc-1', 'Reid arm width law');
  add({ name: 'Spiral-arm in-plane width at Galactocentric radius 8.15 kpc (best-fit linear law)', value: 336, unit: 'pc', reference: `${REID_REF}, Fig. 4 caption: width of 336 pc at 8.15 kpc radius and a slope of 36 pc/kpc`, url: REID_URL });
  add({ name: 'Spiral-arm width slope with Galactocentric radius', value: 36, unit: 'pc/kpc', reference: `${REID_REF}, Fig. 4 caption`, url: REID_URL });

  // --- Reid et al. 2019 Table 2: spiral arm fits ---
  const tables = (reidHtml.match(/<table[\s\S]*?<\/table>/g) ?? []).filter((t) => t.includes('kink') && t.includes('Sct-Cen'));
  const t2 = tables[0];
  if (!t2) throw new Error('Reid 2019 Table 2 not found in the ar5iv page');
  const rows = (t2.match(/<tr[\s\S]*?<\/tr>/g) ?? []).map((r) => (r.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/g) ?? []).map((c) => ar5ivCell(c)));
  const dataRows = rows.filter((r) => ['3-kpc(N)', 'Norma', 'Sct-Cen', 'Sgr-Car', 'Local', 'Perseus', 'Outer'].includes(r[0] ?? ''));
  if (dataRows.length !== 7) throw new Error(`Reid Table 2: expected 7 arm rows, got ${dataRows.length}`);
  const num = (s: string): [number | string, number | string] => {
    const m = /^([-−]?\d+(?:\.\d+)?)\s*(?:±\s*(\d+(?:\.\d+)?))?$/.exec(s.replace('−', '-'));
    if (!m) return ['', ''];
    return [Number(m[1]), m[2] !== undefined ? Number(m[2]) : ''];
  };
  const range = (s: string): [number | string, number | string] => {
    const m = /^([-−]?\d+)\s*→\s*([-−]?\d+)$/.exec(s.replace('−', '-'));
    return m ? [Number(m[1]!.replace('−', '-')), Number(m[2]!.replace('−', '-'))] : ['', ''];
  };
  const armRows: (number | string)[][] = dataRows.map((r) => {
    const [name, n, tang, br, bk, rk, pl, pg, w] = r as [string, string, string, string, string, string, string, string, string];
    const tangN = Number.isFinite(Number(tang)) && tang !== '' ? Number(tang) : '';
    const [b0, b1] = range(br);
    const [bkv, bke] = num(bk); const [rkv, rke] = num(rk); const [plv, ple] = num(pl); const [pgv, pge] = num(pg); const [wv, we] = num(w);
    if ([rkv, plv, pgv, wv, b0, b1, bkv].some((v) => v === '')) throw new Error(`Reid Table 2: unparsed cell in row ${name}: ${JSON.stringify(r)}`);
    return [name, Number(n), tangN, b0, b1, bkv, bke, rkv, rke, plv, ple, pgv, pge, wv, we];
  });
  // spot checks against the fitted-text values printed in the paper (Sgr-Car kink at 24 deg, Perseus R_kink 8.87 kpc)
  const sgr = armRows.find((r) => r[0] === 'Sgr-Car');
  if (!sgr || sgr[5] !== 24 || sgr[7] !== 6.04) throw new Error('Reid Table 2 spot check failed (Sgr-Car)');
  requireEvidence(reidText, 'which gave a value of 24∘', 'Reid Sgr-Car kink azimuth in text');
  requireEvidence(reidText, 'Priors for Galactic longitudes of arm tangencies in quadrant 4 from Bronfman et al. 2000 (3-kpc(N): 337', 'Reid tangency priors');
  requireEvidence(reidText, 'Sct-Cen: 308', 'Reid tangency priors Sct-Cen');
  requireEvidence(reidText, 'defined as 0 toward the Sun and increasing in the direction of Galactic rotation', 'Reid beta convention');

  const model: DocumentedModel = {
    id: 'milky-way',
    title: 'Milky Way structure: literature parameters (not a measurement of every star)',
    parameters,
    tables: {
      'spiral-arms-reid2019': {
        columns: ['arm', 'nParallaxes', 'tangencyLongitude', 'betaMin', 'betaMax', 'betaKink', 'betaKinkErr', 'Rkink', 'RkinkErr', 'psiBelowKink', 'psiBelowKinkErr', 'psiAboveKink', 'psiAboveKinkErr', 'width', 'widthErr'],
        units: ['', 'count', 'deg', 'deg', 'deg', 'deg', 'deg', 'kpc', 'kpc', 'deg', 'deg', 'deg', 'deg', 'kpc', 'kpc'],
        rows: armRows,
        reference: `${REID_REF}, Table 2 (log-periodic spiral fits to maser parallaxes; '' = not given / not applicable)`,
        url: REID_URL,
      },
      'spiral-arm-model-reid2019': {
        columns: ['item', 'definition'],
        units: ['', ''],
        rows: [
          ['equation', 'ln(R/R_kink) = -(beta - beta_kink) * tan(psi); psi = psiBelowKink for beta < beta_kink and psiAboveKink for beta > beta_kink (pitch angles in degrees)'],
          ['R', 'Galactocentric radius, kpc'],
          ['beta', 'Galactocentric azimuth, defined as 0 toward the Sun and increasing in the direction of Galactic rotation (Reid et al. 2019, sect. 3); beta is the angle between the line from the Galactic Centre to the Sun and the line from the centre to the source'],
          ['betaMin..betaMax', 'range of beta covered by the parallax data used for the fit; outside it the arm is an extrapolation of the fitted spiral'],
          ['width', 'the fit includes a Gaussian 1-sigma intrinsic arm width; the table value is the width at R_kink; across arms w(R) = 336 pc + 36 pc/kpc * (R - 8.15 kpc)'],
          ['tangencyLongitude', 'Galactic longitude of the arm tangency in the fourth quadrant implied by the fit (blank where not listed); the fits were constrained by priors on these tangencies of 337, 328, 308 and 283 deg (3-kpc(N), Norma, Sct-Cen, Sgr-Car) with +-2 deg from Bronfman et al. 2000, because no southern-hemisphere parallaxes existed'],
        ],
        reference: `${REID_REF}, sect. 3 and Table 2 notes`,
        url: REID_URL,
      },
    },
    limitations: [
      'Spiral arms are log-periodic fits to ~200 maser parallaxes of high-mass star-forming regions (Reid et al. 2019); they describe the young, gas-rich tracers only, and the old stellar disc is not spiral in this model.',
      'Arm centre lines are only constrained over the azimuth range betaMin..betaMax in the table; everywhere else (including most of the far side of the Galaxy, behind the Galactic Centre) the drawn arms are extrapolations of the fitted spiral, not observations.',
      'In the fourth Galactic quadrant no maser parallaxes existed for the 2019 fits; arm positions there are constrained by tangency-longitude priors from CO and H I emission (Reid et al. 2019, Table 2 notes).',
      'Dust extinction hides much of the disc and bulge from optical surveys; the far-side and obscured structure is inferred from infrared star counts, kinematics and models (Bland-Hawthorn & Gerhard 2016), and several parameters differ between methods.',
      'Disc scale lengths and heights are described by the review itself as uncertain ("we are not able to present a fully consistent picture for the disk at this time"); the values here are the review\'s recommended means with its stated errors, not a fit to one data set.',
      'Different parameters come from sources that assume different Sun-Galactic Centre distances (8.15 kpc Reid 2019, 8.2 kpc Bland-Hawthorn & Gerhard 2016, 8.178 kpc GRAVITY 2019); they are listed separately and not rescaled to a common value.',
      'No warp, flare, or individual-star positions are included: drawing them would require data this model does not contain.',
    ],
  };

  requireEvidence(bhgText, 'Sb−Sbc', 'BHG16 traditional class');
  requireEvidence(bhgText, 'The Galaxy is a luminous (L⋆) barred spiral', 'BHG16 barred spiral');
  requireEvidence(kormendy.summary, 'All three are giant, SBb - SBbc galaxies', 'Kormendy Milky Way class');
  return {
    model, params, armRows,
    distance: { value: 8178, unit: 'pc', unc: Math.round(gravUnc * 10) / 10, note: 'R0 = 8178 +- 13 (stat) +- 22 (sys) pc; uncertainty = quadrature sum (our step)' },
    morphology: { label: 'SBbc', evidence: 'Kormendy (2019, arXiv:1810.10073): the Milky Way and its structural analogues are "giant, SBb - SBbc galaxies"; Bland-Hawthorn & Gerhard (2016): "a luminous (L*) barred spiral", traditionally Sb-Sbc. The single string "SBbc" is the upper end of Kormendy\'s range, chosen so that it parses as a barred spiral; it is not a catalogue entry.', cite: 'Kormendy 2019 (arXiv:1810.10073); Bland-Hawthorn & Gerhard 2016 (arXiv:1602.07702)' },
    sources: [
      { key: 'bhg16', title: 'Bland-Hawthorn & Gerhard 2016, The Galaxy in Context: Structural, Kinematic and Integrated Properties, ARA&A 54, 529', url: 'https://arxiv.org/abs/1602.07702', retrieved: retrievalDate('https://ar5iv.labs.arxiv.org/html/1602.07702') ?? 'unknown', licence: 'arXiv e-print (values quoted with attribution; no text reproduced beyond short evidence strings)', note: 'full text read through ar5iv.labs.arxiv.org/html/1602.07702' },
      { key: 'reid2019', title: `${reidAbs.title} (Reid et al. 2019, ApJ 885, 131)`, url: 'https://arxiv.org/abs/1910.03357', retrieved: retrievalDate('https://ar5iv.labs.arxiv.org/html/1910.03357') ?? 'unknown', licence: 'arXiv e-print (Table 2 values quoted with attribution)', note: 'Table 2 parsed from ar5iv.labs.arxiv.org/html/1910.03357; the VizieR table J/ApJ/885/131 holds the maser parallaxes (Table 1), not the arm fits' },
      { key: 'gravity2019', title: 'GRAVITY Collaboration 2019, A geometric distance measurement to the Galactic Center black hole with 0.3% uncertainty, A&A 625, L10', url: 'https://arxiv.org/abs/1904.05721', retrieved: gravity.retrieved, licence: 'arXiv e-print' },
      { key: 'kormendy2019', title: 'Kormendy 2019, Structural Analogs of the Milky Way Galaxy: Stellar Populations in the Boxy Bulges of NGC 4565 and NGC 5746', url: 'https://arxiv.org/abs/1810.10073', retrieved: kormendy.retrieved, licence: 'arXiv e-print' },
    ],
  };
}
