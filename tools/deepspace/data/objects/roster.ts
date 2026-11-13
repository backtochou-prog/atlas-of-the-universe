/**
 * Curated roster of the named deep-space objects: WHICH catalogue records and WHICH papers each value is taken from.
 * No measured number lives here except where it is paired with an `evidence` string that tools/deepspace/build_objects.ts
 * checks against the fetched source text (arXiv abstract / ar5iv full text); a mismatch aborts the build.
 */

export type Unit = 'pc' | 'kpc' | 'Mpc';

/** How the primary distance of an object is obtained. */
export type DistSpec =
  /** Number quoted in a paper's abstract; `evidence` must occur in the fetched abstract. */
  | { kind: 'arxiv'; arxiv: string; value: number; unit: Unit; stat?: number; sys?: number; total?: number; lower?: number; upper?: number; method: string; evidence: string; note?: string }
  /** A NED-D (v17.1.2) record, selected by galaxy name + REFCODE + distance modulus; everything is read from the cached CSV. */
  | { kind: 'ned-d'; nedName: string; refcode: string; mM: number; method: string }
  /** McConnachie (2012) VizieR row. */
  | { kind: 'mcconnachie'; name: string }
  /** Zucker et al. (2020) nearest sightline to the object. */
  | { kind: 'zucker' }
  /** Hunt & Reffert (2023) open-cluster table, by catalogue name. */
  | { kind: 'hr23'; name: string }
  /** Baumgardt & Vasiliev (2021) distance as listed in Baumgardt's parameter table. */
  | { kind: 'baumgardt'; ngc: string }
  /** Bailer-Jones et al. (2021) geometric distance of one Gaia EDR3 source. */
  | { kind: 'bailer-jones'; sourceId: string; ra: number; dec: number };

export interface GalaxySpec {
  id: string; name: string; designations: string[]; simbad: string; leda: string; ned: string[];
  dist: DistSpec;
  /** 'leda' = HyperLEDA inclination/PA (deprojected-image); 'sky-plane' = no usable disc model; or a literature orientation */
  orientation: 'leda' | 'sky-plane' | { arxiv: string; inclEvidence: string; paEvidence: string; incl: number; inclStat: number; inclSys: number; pa: number; paStat: number; paSys: number; tracer: string };
  parentId?: string;
  notes?: string;
}

export const GALAXIES: GalaxySpec[] = [
  { id: 'm31', name: 'Andromeda Galaxy (M31)', designations: ['M 31', 'NGC 224', 'UGC 454', 'PGC 2557'], simbad: 'M  31', leda: 'M31', ned: ['MESSIER 031'], parentId: 'local-group', orientation: 'leda',
    dist: { kind: 'arxiv', arxiv: '2107.08029', value: 761, unit: 'kpc', total: 11, method: 'Cepheid period-luminosity relation (HST WFC3 F555W/F814W/F160W), absolute zero point from LMC Cepheids (Riess et al. 2019) tied to the LMC eclipsing-binary distance', evidence: 'distance modulus to M31 of $μ_0$ = 24.407 $\\pm$ 0.032, corresponding to 761 $\\pm$ 11 kpc and 1.49$\\%$ uncertainty including all error sources' } },
  { id: 'm33', name: 'Triangulum Galaxy (M33)', designations: ['M 33', 'NGC 598', 'UGC 1117', 'PGC 5818'], simbad: 'M  33', leda: 'M33', ned: ['MESSIER 033'], parentId: 'local-group', orientation: 'leda',
    dist: { kind: 'arxiv', arxiv: '2304.00037', value: 840, unit: 'kpc', total: 11, method: 'Cepheid period-luminosity relation (154 Cepheids, HST/PHATTER), zero point from LMC Cepheids and the LMC eclipsing-binary distance', evidence: 'μ = 24.622 $\\pm$ 0.030 mag (d = 840 $\\pm$ 11 kpc)' } },
  { id: 'lmc', name: 'Large Magellanic Cloud', designations: ['LMC', 'ESO 56-115', 'PGC 17223'], simbad: 'NAME LMC', leda: 'LMC', ned: ['Large Magellanic Cloud', 'LMC'], parentId: 'local-group',
    orientation: { arxiv: '1609.03554', incl: 25.05, inclStat: 0.02, inclSys: 0.55, pa: 150.76, paStat: 0.02, paSys: 0.07, tracer: 'classical Cepheids (young population)',
      inclEvidence: 'We found an inclination i=25.05 $\\pm$ 0.02 (stat.) $\\pm$ 0.55 (syst.) deg', paEvidence: 'position angle of the lines of nodes P.A.=150.76 $\\pm$ 0.02(stat.) $\\pm$ 0.07(syst.) deg' },
    dist: { kind: 'arxiv', arxiv: '1903.08096', value: 49.59, unit: 'kpc', stat: 0.09, sys: 0.54, method: 'geometric: 20 detached eclipsing binaries, surface-brightness-colour relation', evidence: 'The final distane is 49.59 +/- 0.09 (statistical) +/- 0.54 (systematic) kiloparsecs.' } },
  { id: 'smc', name: 'Small Magellanic Cloud', designations: ['SMC', 'NGC 292', 'PGC 3085'], simbad: 'NAME SMC', leda: 'SMC', ned: ['Small Magellanic Cloud', 'SMC'], parentId: 'local-group', orientation: 'sky-plane',
    dist: { kind: 'arxiv', arxiv: '2010.08754', value: 62.44, unit: 'kpc', stat: 0.47, sys: 0.81, method: 'geometric: 15 late-type detached eclipsing binaries, surface-brightness-colour relation (distance to the SMC centre)', evidence: 'D_SMC=62.44 +/- 0.47 (stat.) +/- 0.81 (syst.) kpc' },
    notes: 'The SMC is strongly elongated along the line of sight (Graczyk et al. 2020: the distance difference between the nearest and most distant binary is 10 kpc), so the single distance is the distance to its centre.' },
  { id: 'm32', name: 'Messier 32', designations: ['M 32', 'NGC 221', 'PGC 2555'], simbad: 'M  32', leda: 'M32', ned: ['MESSIER 032'], parentId: 'local-group', orientation: 'sky-plane',
    dist: { kind: 'mcconnachie', name: 'M32' } },
  { id: 'm87', name: 'Messier 87 (Virgo A)', designations: ['M 87', 'NGC 4486', 'Virgo A', 'PGC 41361'], simbad: 'M  87', leda: 'M87', ned: ['MESSIER 087'], parentId: 'virgo-cluster', orientation: 'sky-plane',
    dist: { kind: 'ned-d', nedName: 'MESSIER 087', refcode: '2009ApJ...694..556B', mM: 31.11, method: 'surface brightness fluctuations (HST/ACS)' } },
  { id: 'cen-a', name: 'Centaurus A (NGC 5128)', designations: ['NGC 5128', 'Cen A', 'PGC 46957'], simbad: 'NGC  5128', leda: 'NGC5128', ned: ['NGC 5128'], orientation: 'sky-plane',
    dist: { kind: 'arxiv', arxiv: '0911.3180', value: 3.8, unit: 'Mpc', stat: 0.1, method: 'best-estimate mean of Cepheid, TRGB, PNLF, SBF and Mira distances (a published evaluation, not one measurement)', evidence: 'we derive a best-estimate distance of 3.8 +- 0.1 Mpc to NGC 5128' } },
  { id: 'm81', name: "Bode's Galaxy (M81)", designations: ['M 81', 'NGC 3031', 'UGC 5318', 'PGC 28630'], simbad: 'M  81', leda: 'M81', ned: ['MESSIER 081'], parentId: 'm81-group', orientation: 'leda',
    dist: { kind: 'ned-d', nedName: 'MESSIER 081', refcode: '2009ApJS..183...67D', mM: 27.78, method: 'tip of the red giant branch (TRGB), HST/ACS' } },
  { id: 'm104', name: 'Sombrero Galaxy (M104)', designations: ['M 104', 'NGC 4594', 'PGC 42407'], simbad: 'M 104', leda: 'M104', ned: ['MESSIER 104'], orientation: 'sky-plane',
    dist: { kind: 'arxiv', arxiv: '1610.03857', value: 9.55, unit: 'Mpc', stat: 0.13, sys: 0.31, method: 'tip of the red giant branch (TRGB), HST/ACS', evidence: 'the distance to M104 to be 9.55 +/- 0.13 +/- 0.31 Mpc' } },
];

export interface NebulaSpec {
  id: string; name: string; designations: string[]; simbad: string; dist: DistSpec; parentId?: string; notes?: string;
  facts?: { text: string; status: 'observed' | 'inferred' | 'hypothesis'; arxiv: string; evidence: string }[];
  /** SIMBAD merges some nebulae with their central cluster (M 16 is typed OpC): the nebula class then comes from a paper's wording. */
  otypeOverride?: { otype: string; arxiv: string; evidence: string };
}
export const NEBULAE: NebulaSpec[] = [
  { id: 'orion-nebula', name: 'Orion Nebula (M42)', designations: ['M 42', 'NGC 1976'], simbad: 'M  42', dist: { kind: 'zucker' }, parentId: 'milky-way',
    facts: [{ text: 'Spatially resolved emission-line atlas of the nebula exists in [O I] 6300, [S II] 6716/6731, [N II] 6584, [S III] 6312, H-alpha 6563 and [O III] 5007.', status: 'observed', arxiv: '0802.0518', evidence: '[O I] 6300, [S II] 6716,6731, [N II] 6584, [S III] 6312, H alpha 6563, and [O III] 5007' }] },
  { id: 'eagle-nebula', name: 'Eagle Nebula (M16)', designations: ['M 16', 'NGC 6611', 'IC 4703'], simbad: 'M  16', dist: { kind: 'zucker' }, parentId: 'milky-way',
    otypeOverride: { otype: 'HII', arxiv: '1706.06002', evidence: 'M16, the Eagle Nebula, is an outstanding HII region' },
    facts: [
      { text: 'The "Pillars of Creation" are in the southern part of M16 and the nebula is largely under the influence of the nearby NGC 6611 high-mass star cluster; Herschel maps show a dust-temperature gradient running away from the cavity carved by the OB cluster.', status: 'observed', arxiv: '1204.6317', evidence: 'M16, home to the Pillars of Creation, is largely under the influence of the nearby NGC6611 high-mass star cluster' }] },
  { id: 'carina-nebula', name: 'Carina Nebula (NGC 3372)', designations: ['NGC 3372', 'Carina Nebula', 'RCW 53', 'Gum 33'], simbad: 'NAME Carina Nebula', parentId: 'milky-way',
    dist: { kind: 'arxiv', arxiv: '2103.07922', value: 2.35, unit: 'kpc', total: 0.08, method: 'Gaia EDR3 parallaxes (offset-corrected) of 69 massive stars in Carina OB1 and its clusters', evidence: 'lie at essentially the same distance ($2.35\\pm0.08$ kpc), quoting mean and rms variance', note: 'The quoted +-0.08 kpc is the rms scatter of the O-star distances ("mean and rms variance"), not an error of the mean.' },
    facts: [{ text: 'The O-type stars in the Great Carina Nebula (Trumpler 14, 15, 16, Bochum 11 and the South Pillars) lie at essentially the same distance; photoionizing radiation from Tr 14 and Tr 16 illuminates photodissociation regions.', status: 'observed', arxiv: '2103.07922', evidence: 'The O-type stars in the Great Carina Nebula lie at essentially the same distance' }] },
  { id: 'crab-nebula', name: 'Crab Nebula (M1)', designations: ['M 1', 'NGC 1952', 'Crab Nebula', 'Taurus A', 'SNR G184.6-05.8'], simbad: 'M   1', parentId: 'milky-way',
    dist: { kind: 'arxiv', arxiv: '2306.01617', value: 1.9, unit: 'kpc', lower: 0.18, upper: 0.22, method: 'VLBI radio parallax of the Crab pulsar (pi = 0.53 +- 0.06 mas)', evidence: 'd=1.90^{+0.22}_{-0.18}', note: 'Geometric distance to the pulsar at the centre of the nebula.' },
    facts: [
      { text: 'Optical filaments of the ejecta emit in [O III] 4959,5007 (imaged with Subaru); molecular hydrogen (H2 2.12 micron) and Br-gamma (2.17 micron) lines are detected from knots in or next to the filaments.', status: 'observed', arxiv: '1103.6043', evidence: 'in the H2 2.12 micron and Br-gamma 2.17 micron lines' },
      { text: 'Deep [O III] 4959,5007 imaging of the northern filamentary jet is used to measure proper motions of the ejecta.', status: 'observed', arxiv: '0801.0893', evidence: 'We present a deep [O III] 4959,5007 image of the northern filamentary jet in the Crab Nebula' }] },
  { id: 'ring-nebula', name: 'Ring Nebula (M57)', designations: ['M 57', 'NGC 6720'], simbad: 'M  57', parentId: 'milky-way',
    dist: { kind: 'bailer-jones', sourceId: '2090486618786534784', ra: 283.39623652, dec: 33.02913425 },
    facts: [
      { text: 'Spatially resolved spectroscopy shows the [O III] emission follows the H-beta emission measure, while O II recombination-line emission peaks closer to the central star.', status: 'observed', arxiv: 'astro-ph/0105206', evidence: 'The [O III] emission follows the H-beta emission measure' },
      { text: 'HST images in [O III] 5007 and [N II] 6583 show the nebula expanding homologously (velocity increases with distance from the central star).', status: 'observed', arxiv: '0901.3185', evidence: 'Scaled ratio images argue for homologous expansion, that is, larger velocities scale with increasing distance from the central star' }] },
  { id: 'horsehead-nebula', name: 'Horsehead Nebula (Barnard 33)', designations: ['Barnard 33', 'Horsehead Nebula'], simbad: 'NAME Horsehead Nebula', dist: { kind: 'zucker' }, parentId: 'milky-way',
    notes: 'B33 is a dark nebula seen in silhouette against the emission nebula IC 434; the distance is that of the nearest Zucker et al. (2020) sightline (Orion B), not a measurement of B33 itself.' },
  { id: 'veil-nebula', name: 'Veil Nebula (Cygnus Loop)', designations: ['Cygnus Loop', 'SNR G074.0-08.5', 'Sh 2-103', 'W 78'], simbad: 'SNR G074.0-08.5', parentId: 'milky-way',
    dist: { kind: 'arxiv', arxiv: '2109.05368', value: 725, unit: 'pc', total: 15, method: 'Gaia EDR3 parallaxes of stars shown by high-velocity absorption lines to lie in or behind the remnant', evidence: 'a revised distance to the Cygnus Loop supernova remnant of $725\\pm15$ pc' },
    facts: [{ text: 'An atlas of the remnant exists in the light of [O III] 5007, H-alpha and [S II] 6717,6731; the optical emission traces interactions of the blast wave with clumps of gas.', status: 'observed', arxiv: 'astro-ph/9805008', evidence: 'in the light of [O III] (5007), H alpha, and [S II] (6717, 6731)' }] },
];
/** Reflection nebula candidates; the one actually used is chosen from what the image manifest provides (default: first). */
export const REFLECTION_CANDIDATES: NebulaSpec[] = [
  { id: 'ngc-1999', name: 'NGC 1999', designations: ['NGC 1999'], simbad: 'NGC  1999', dist: { kind: 'zucker' }, parentId: 'milky-way',
    notes: 'Reflection nebula in the Orion A cloud. The distance is that of the nearest Zucker et al. (2020) sightline, not a measurement of NGC 1999 or of its illuminating star.',
    facts: [{ text: 'The nebula features a dark patch about 10,000 AU across that had been interpreted as a small foreground globule; Herschel PACS 70 and 160 micron maps show a flux deficit at its location (the study\'s title concludes that it is not a globule).', status: 'observed', arxiv: '1005.2202', evidence: 'The NGC 1999 reflection nebula features a dark patch with a size of ~10,000 AU' }] },
  { id: 'm78', name: 'Messier 78 (NGC 2068)', designations: ['M 78', 'NGC 2068'], simbad: 'M  78', dist: { kind: 'zucker' }, parentId: 'milky-way',
    notes: 'Reflection nebula in the Orion B cloud. Distance from the nearest Zucker et al. (2020) sightline; an independent VLBA parallax value for the NGC 2068 region is listed in the facts.',
    facts: [{ text: 'VLBA trigonometric parallaxes of young stellar objects give a mean distance of 405 +- 16 pc for NGC 2068 (Orion B).', status: 'observed', arxiv: '2602.22048', evidence: 'mean distances of $405\\pm16$ pc for NGC 2068' }] },
];

export interface ClusterSpec { id: string; name: string; designations: string[]; simbad: string; kind: 'open' | 'globular'; hr23?: string; ngc?: string; pointsFileId: string; dias?: string }
export const CLUSTERS: ClusterSpec[] = [
  { id: 'pleiades', name: 'Pleiades (M45)', designations: ['M 45', 'Melotte 22'], simbad: 'M  45', kind: 'open', hr23: 'Melotte_22', dias: 'Melotte_22', pointsFileId: 'members-pleiades' },
  { id: 'hyades', name: 'Hyades (Melotte 25)', designations: ['Melotte 25', 'Collinder 50', 'Hyades'], simbad: 'NAME Hyades', kind: 'open', hr23: 'Melotte_25', dias: 'Melotte_25', pointsFileId: 'members-hyades' },
  { id: 'omega-centauri', name: 'Omega Centauri (NGC 5139)', designations: ['NGC 5139', 'GCl 24'], simbad: 'NGC  5139', kind: 'globular', ngc: 'NGC 5139', pointsFileId: 'members-omega-centauri' },
  { id: 'm13', name: 'Hercules Cluster (M13)', designations: ['M 13', 'NGC 6205'], simbad: 'M  13', kind: 'globular', ngc: 'NGC 6205', pointsFileId: 'members-m13' },
  { id: '47-tucanae', name: '47 Tucanae (NGC 104)', designations: ['NGC 104', '47 Tuc Cluster', 'GCl 1'], simbad: 'NGC   104', kind: 'globular', ngc: 'NGC 104', pointsFileId: 'members-47-tucanae' },
  { id: 'm4', name: 'Messier 4 (NGC 6121)', designations: ['M 4', 'NGC 6121'], simbad: 'M   4', kind: 'globular', ngc: 'NGC 6121', pointsFileId: 'members-m4' },
];
