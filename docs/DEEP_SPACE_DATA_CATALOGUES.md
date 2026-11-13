# Deep-space point catalogues

Nine gzipped structure-of-arrays files (`PointCatalogueFile`, `src/data/deepspace/types.ts`) in `public/data/deepspace/<id>.v1.json.gz`.
Built by `tools/deepspace/build_catalogues.ts`. Retrieval date for every source: **2026-11-12**.
Each file carries its own `manifest` (source, licence, query, distanceBasis, caveats, units); this document summarises them.
The manifest text is the authority for the application: it is what the UI should quote.

## Rebuild

```
npx tsx tools/deepspace/build_catalogues.ts             # fetch (cached) and build all nine
npx tsx tools/deepspace/build_catalogues.ts --offline   # rebuild byte-identical from data/cache/deepspace/catalogues
npx tsx tools/deepspace/build_catalogues.ts --only ungc,twomrs
npx tsx tools/deepspace/build_catalogues.ts --refresh   # ignore the cache
```

Suggested package.json scripts: `"data:deepspace:catalogues": "tsx tools/deepspace/build_catalogues.ts"`, `"data:deepspace:catalogues:offline": "tsx tools/deepspace/build_catalogues.ts --offline"`.

Raw responses are cached verbatim (with `.meta.json`: URL, retrieval date, sha256) in `data/cache/deepspace/catalogues/` (about 122 MB, mostly the 119 MB Zenodo zip). A checksum mismatch aborts the build.
VizieR access: ASU `asu-tsv` interface on `vizier.cfa.harvard.edu` (fallback `vizier.cds.unistra.fr`). Findings: the CfA mirror answered; the CDS Strasbourg hosts (`cdsarc`, TAP) timed out and the CfA mirror has no TAP endpoint, so ASU was used. No credentials are used.

## Files

| id | rows | gz size | source (table) | distanceBasis |
|---|---|---|---|---|
| `local-group-mcconnachie` | 101 | 5 066 B | McConnachie 2012, AJ 144, 4 — VizieR J/AJ/144/4/catalog (+ refs) | per-object-direct |
| `ungc` | 869 | 34 364 B | Karachentsev et al. 2013, AJ 145, 101 — J/AJ/145/101/catalog (+ table6) | per-object-direct |
| `twomrs` | 43 533 | 1 380 664 B | Huchra et al. 2012, ApJS 199, 26 — J/ApJS/199/26/table3 | per-object-redshift-hubble-flow |
| `members-pleiades` | 1 721 | 84 477 B | Hunt & Reffert 2023, A&A 673, A114 — J/A+A/673/A114/members, Name=Melotte_22 | per-object-parallax |
| `members-hyades` | 927 | 50 788 B | same, Name=Melotte_25 | per-object-parallax |
| `members-omega-centauri` | 20 000 | 715 216 B | Vasiliev & Baumgardt 2021, MNRAS 505, 5978 — Zenodo 4891252, `catalogues/NGC_5139_oCen.txt` | cluster-mean |
| `members-m13` | 20 000 | 672 809 B | same, `NGC_6205_M_13.txt` | cluster-mean |
| `members-47-tucanae` | 20 000 | 693 782 B | same, `NGC_104_47Tuc.txt` | cluster-mean |
| `members-m4` | 20 000 | 664 241 B | same, `NGC_6121_M_4.txt` | cluster-mean |

Total about 4.3 MB.

### local-group-mcconnachie
- Query: `-source=J/AJ/144/4/catalog -out.max=unlimited -out.all=1`: 102 rows. One dropped: "The Galaxy" (no heliocentric distance; the catalogue measures from it). 101 kept.
- Columns: required set plus `distErrUpMpc`, `distErrLowMpc` (catalogue E_D / e_D), `distRefs` (bibcodes resolved from the catalogue `refs` table), `subgroup` (MW / M31 / Rest), `halfLightRadiusArcmin` (R1).
- `distMpc` = catalogue D (kpc) / 1000. `distErrMpc` = mean of the published upper and lower errors (our simplification, null if either missing).
- `distMethod` is a fixed label ("literature compilation of distance moduli"): the catalogue has **no per-object distance-method column**; the per-object literature is in `distRefs`.
- `diameterArcmin` is **null for every row**: only a half-light radius is published.
- Names are the catalogue's: `Andromeda` (M31), `Triangulum` (M33), `LMC`, `SMC`, `M32`.

### ungc
- Query: `-source=J/AJ/145/101/catalog ... -out.all=1`: 869 rows (equals the 869 galaxies stated for the catalogue), all kept; `table6` (788 distance-modulus measurements) joined by Name.
- `distMethod` = catalogue code `f_Dist` unchanged (TRGB 272, TF 204, mem 170, h 86, BS 40, SBF 25, Cep 20, ...). The codes `mem`, `h`, `h'`, `txt` are not independent measurements for that galaxy.
- `distErrMpc`: the catalogue publishes no error on the adopted distance. It is filled (299 rows) only when `table6` has exactly one measurement of the same method that reproduces `Dist`; then distErr = Dist x ln10/5 x e_DM (our first-order propagation). Otherwise null.
- `morphology` = dwarf class `Mcl` if present, else `T=<TT>` (numeric de Vaucouleurs code), else null. Both parts kept as `dwarfMorphology`, `tType`.
- Group/membership: the catalogue has no group-ID column. Extras kept: `mainDisturber` (MD) and `tidalIndex` (Ti1). Also `kMag`, `hrvKms`, `surfaceBrightnessClass`, `distModulusMag`/`distModulusErrMag`, `ngcSimbadName`.
- `diameterArcmin` = a26; `bMag` = Bmag. Max distance 26.2 Mpc (a few velocity-based entries beyond 11 Mpc). M87 is not in this catalogue (too far); Virgo comes from 2MRS.

### twomrs
- Query: `-source=J/ApJS/199/26/table3 -out.max=unlimited -out=ID,RAJ2000,DEJ2000,GLON,GLAT,Kcmag,e_Kcmag,Ktmag,type,r_type,cz,e_cz,n_cz,r_cz`: 44 599 catalogue rows; 1 066 have no redshift and are dropped; **43 533** kept (matches the published number of 2MRS galaxies with redshifts).
- `czKms` is stored; **no distance is stored**. Hubble-flow distance d = cz/H0 is distorted by peculiar velocities (fingers of God, infall). If an application converts, H0 = 70 km/s/Mpc is an application choice, not a catalogue value, and must be flagged as such.
- Flux limit K < 11.75 (max Kcmag in file 11.754 from rounding). Zone of Avoidance (|b| < ~5 deg and wider toward the bulge) is incomplete. Density falls with distance because of the flux limit.
- `ksMag` = Kcmag (extinction-corrected isophotal Ks); `ktMag` = total extrapolated Ks. `czErrKms` = e_cz (always present in this table). 25 galaxies have negative cz (e.g. M31 -300 km/s): at these distances cz/H0 is meaningless.
- `morphology` = ZCAT-convention type string as published.

### members-pleiades, members-hyades (Hunt & Reffert 2023, Gaia DR3)
- Pleiades = catalogue name Melotte_22 (aliases include M45), N = 1 721 (all kept; 1 014 within the tidal radius). Hyades = Melotte_25, N = 927 (386 within tidal radius). The separate catalogue entry CWNU_1242 (also aliased Hyades) is not used.
- No probability cut was applied; the catalogue column `Prob` is stored as `probability`. `insideTidalRadius` (inrt) and `parallaxErrMas` are extras. Cluster median distance from the catalogue: Pleiades 134.84 pc, Hyades 47.19 pc.
- Cantat-Gaudin et al. 2020 was not needed.

### members-omega-centauri, -m13, -47-tucanae, -m4 (Vasiliev & Baumgardt 2021, Gaia EDR3)
- The VizieR table J/MNRAS/505/5978 holds only cluster-level parameters; the per-star membership catalogue the paper points to is Zenodo record 4891252 (doi 10.5281/zenodo.4891252, CC-BY-4.0, published 2021-06-01), file `clusters.zip`.
- Selection (ours): `memberprob >= 0.9`; if above 20 000, the 20 000 **brightest** by G are kept. Counts passing the cut: Omega Cen 156 530 of 228 055 field sources (faintest kept G = 17.43), M13 31 035 of 37 720 (G = 19.85), 47 Tuc 107 056 of 144 761 (G = 17.63), M4 26 109 of 69 417 (G = 19.63). This biases toward bright giants and makes crowded cores look sparse in faint stars; Omega Cen and 47 Tuc are cut at relatively bright limits.
- Per-member parallaxes are far too imprecise for depth: use the cluster-mean distance (distanceBasis `cluster-mean`). Parallax in the source file is zero-point corrected by the authors (Lindegren et al. prescription).
- Extras: `qualityFlag` (qflag), `parallaxErrMas`.

## Verification performed
- Row counts: UNGC 869 and 2MRS 43 533 equal the numbers in the papers; McConnachie 102 table rows (101 + The Galaxy); Hunt & Reffert N per cluster equals the catalogue's stated N.
- Spot checks: M31 0.783 Mpc (McConnachie) and 0.77 Mpc Cepheids (UNGC); M33 0.809 / 0.85 Mpc; LMC 0.051 / 0.050, SMC 0.064 / 0.060 Mpc; M81 3.63 Mpc (Cep); Cen A 3.75 Mpc (TRGB); Sombrero NGC 4594 9.3 Mpc (SBF). 2MRS: M87 cz = 1307 km/s, Ks = 5.90; M31 -300; M81 -34; Cen A 547; Sombrero 1024; Coma NGC 4889 6446. Pleiades: Electra and Maia present, Alcyone and Merope absent, median parallax 7.36 mas (about 136 pc). Hyades: theta1 Tau and eps Tau present, median parallax 20.5 mas (about 49 pc), median PM (93.5, -23.6) mas/yr. Globular medians match known clusters (Omega Cen plx 0.19, pm (-3.25, -6.74); M13 pm (-3.14, -2.57); 47 Tuc pm (5.25, -2.55); M4 plx 0.56, pm (-12.5, -19.0)).
- Offline rebuild is byte-identical to the online build; `tsc --noEmit` reports no error in the build script.
- Not tested: no rendering of these files; GPU performance is not claimed.
