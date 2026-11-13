# Exoplanet data (NASA Exoplanet Archive, pscomppars)

Output: `public/data/exoplanets.v1.json.gz` (type `ExoplanetFile`, `src/discovery/types.ts`), built by `tools/discovery/build_exoplanets.ts`.
Raw downloads and a machine-readable build report are kept in `data/cache/discovery/exoplanets/` (`build-report.json`).

    npx tsx tools/discovery/build_exoplanets.ts              # fetch (cached) and build
    npx tsx tools/discovery/build_exoplanets.ts --offline    # rebuild from the cache only; output is byte-identical
    npx tsx tools/discovery/build_exoplanets.ts --refresh    # ignore the cache and fetch again

## Provenance

- Source: NASA Exoplanet Archive, table `pscomppars` (Planetary Systems Composite Parameters), TAP service
  `https://exoplanetarchive.ipac.caltech.edu/TAP/sync`, `format=csv`. Column names were read from `TAP_SCHEMA.columns` and the archive's
  column definitions page (`/docs/API_PS_columns.html`), both cached.
- Retrieved 2026-11-13 (UTC 06:48). Archive release: the archive home page lists "6,470 Confirmed Planets", last updated 11/12/2026 (MM/DD/YYYY);
  this is recorded as `archiveRelease = 2026-11-12`. `pscomppars` itself has no `rowupdate` / `releasedate` column.
- ADQL (exact text also in `manifest.query`):

      select pl_name,hostname,pl_letter,hip_name,hd_name,tic_id,gaia_dr3_id,gaia_dr2_id,discoverymethod,disc_year,disc_facility,disc_refname,
      pl_controv_flag,pl_orbper,pl_orbpererr1,pl_orbpererr2,pl_orbperlim,pl_orbper_reflink,pl_rade,pl_radeerr1,pl_radeerr2,pl_radelim,
      pl_rade_reflink,pl_bmasse,pl_bmasseerr1,pl_bmasseerr2,pl_bmasselim,pl_bmasse_reflink,pl_bmassprov,pl_eqt,pl_orbsmax,pl_orbeccen,
      ra,dec,ra_reflink,sy_dist,sy_disterr1,sy_disterr2,sy_dist_reflink,sy_pmra,sy_pmdec,sy_plx,sy_vmag,sy_snum,sy_pnum,
      st_spectype,st_teff,st_tefferr1,st_tefferr2,st_rad,st_mass from pscomppars order by pl_name

- Acknowledgement and citation, copied verbatim from `https://exoplanetarchive.ipac.caltech.edu/docs/acknowledge.html` (retrieved 2026-11-13):
  - "Please include the following standard acknowledgment in any published material that makes use of the NASA Exoplanet Archive's services."
  - "This research has made use of the NASA Exoplanet Archive, which is operated by the California Institute of Technology, under contract with the National Aeronautics and Space Administration under the Exoplanet Exploration Program."
  - "In addition, if you use data from a specific literature reference, please acknowledge that reference directly."
  - "Please cite Christiansen et al. (2025), the NASA Exoplanet Archive's published paper accepted by the Planetary Science Journal that provides an extensive overview of the archive's data, services and tools." (https://iopscience.iop.org/article/10.3847/PSJ/ade3c2)
  - The archive publishes no separate licence or data-use statement; none is invented here.
- The same text is stored in `manifest.provenance.acknowledgement`.

## Facts about this table that differ from what one might assume

- No `pl_refname`, `default_flag`, `rowupdate`, `releasedate` or `pl_pubdate` exists in `pscomppars` (they belong to the PS table; each query returned ORA-00904).
  `refName`/`refUrl` are therefore the DISCOVERY reference (`disc_refname`); period, radius and mass have their own `periodRef`, `radiusRef`, `massRef` labels.
- The table is composite: each parameter may come from a different paper ("a more complete, though not necessarily self-consistent, set of parameters").
- The archive documents `ra`/`dec` only as "Right Ascension of the planetary system in decimal degrees"; no equinox or epoch is stated. They are used as ICRS.
  `hosts.coordRef` names the source of each position (4,564 of 4,862 hosts: TICv8; the rest mostly microlensing papers). Proper motions are stored, not applied.
- Gaia: the archive offers `gaia_dr3_id` (a Gaia DR3 source_id) and `gaia_dr2_id` (a Gaia DR2 source_id). Both are stored as digit strings in
  `hosts.gaiaDr3Id` / `hosts.gaiaDr2Id`; the DR3 column is the one to match against the Gaia DR3 subset. No DR3 id is shared by two hosts.
- `pl_bmasse` is the archive's "best mass". Its provenance `pl_bmassprov` is stored as `massKind`: Mass 2,495, Msini 895, Msin(i)/sin(i) 15,
  M-R relationship 3,034 (an estimate from the radius, not a measurement). 6,439 planets have a mass value; 3,034 of those are estimates.
  Always show `massKind` with a mass. `massLim` = 1 (225 planets) marks an upper limit, -1 (13) a lower limit.
- Eccentricity 0 occurs 3,164 times; it is the published value (often an assumed circular orbit), not a missing value. Missing eccentricity is null.

## Format

SoA JSON, gzipped (~647 KiB). `manifest` (ExoplanetFile manifest fields plus an optional `provenance` object), `hosts` (4,862 rows, one per `hostname`),
`planets` (6,470 rows). `planets.hostIndex` indexes the hosts columns. Every column and unit is listed in `manifest.units`.
Missing = null, never 0. Build-time assertions fail the build if any of period, radius, mass, equilibrium temperature, semi-major axis, distance, Teff,
stellar radius or stellar mass is 0 or negative, or if an error exists without a value, or is negative.

Error convention: `xErr = max(|err1|, |err2|)` (conservative symmetrisation) for period, radius, mass, distance (`distErrPc`), Teff; the archive's
signed upper/lower values are kept as `xErr1` / `xErr2` (lower is negative). Error with no value is dropped; no error published = null.
Non-null counts: periodErr 5,614 of 6,114 periods; radiusErr 4,491 of 6,420; massErr 3,128 of 6,439; distErrPc 4,747 of 4,834 distances.

Host rule: each host row is taken from the FIRST planet row of that host in `pl_name` order (there is no default-parameter-set flag in pscomppars).
All rows of a host were compared (`manifest.provenance.hostDisagreements`):
- ra, dec, sy_dist, sy_disterr1, sy_plx, sy_vmag, Gaia ids, HIP/HD/TIC names, sy_snum, sy_pnum: no disagreement (tolerances: ra/dec 1e-5 deg, distance 1e-4 pc, V 1e-3 mag).
- 218 hosts disagree between their planet rows on stellar parameters: st_teff 190 hosts, st_rad 192, st_mass 200, st_spectype 8 (e.g. 55 Cnc: Teff 5198 vs 5172 K).
  Host-level stellar parameters are therefore the first-row values and are not unique per star in the source.
- 16 hosts have `sy_pnum` different from the number of rows in the table (`nPlanets` vs `nPlanetRows`); cause not investigated.

## Verification (this build)

- Row count: 6,470 parsed rows = `select count(*)` (6,470) = archive counts page "All Exoplanets" (6,470) = home page "Confirmed Planets" (6,470). Build aborts on a mismatch.
- Unique `pl_name`; 4,862 hosts; 58 planets carry the controversial flag (`controversial` = 1; kept, not removed).
- Spot checks read from the retrieved rows (period d, radius Earth, mass Earth [kind], host distance pc):
  TRAPPIST-1 b-h present (7 planets, host 12.4299 pc, M8.0 V, Gaia DR3 2635476908753563008; b: 1.5108 d, 1.116, 1.374 [Mass]);
  Proxima Cen b 11.18465 d, 1.02 (R), 1.055 [Msini], 1.30119 pc; Kepler-452 b 384.843 d, 1.63, 3.29 [M-R relationship], 551.727 pc;
  51 Peg b 4.2307966 d, 14.1, 193.88 [Mass], 15.4614 pc; 55 Cnc e 0.7365474 d, 1.875, 7.99 [Mass], 12.5855 pc;
  HD 209458 b 3.52474859 d, 15.58, 232.0 [Mass], 48.3016 pc; TOI-700 d 37.423457 d, 1.145, 1.58 [M-R relationship], 31.1265 pc;
  LHS 1140 b 24.73723 d, 1.73, 5.6 [Mass], 14.9861 pc.
- Discovery years 1992-2026 (all 6,470 have a year). Per method (n, first-last year): Transit 4,799 (2002-2026); Radial Velocity 1,205 (1995-2026);
  Microlensing 294 (2004-2026); Imaging 98 (2004-2026); Transit Timing Variations 29 (2011-2026); Eclipse Timing Variations 17 (2009-2023);
  Orbital Brightness Modulation 9 (2011-2021); Astrometry 8 (2013-2026); Pulsar Timing 8 (1992-2024); Pulsation Timing Variations 2 (2007-2016); Disk Kinematics 1 (2019).
- No distance (cannot be placed in 3D, sky-only): 28 hosts, 28 planets: 2MASS J11011926-7732383, CD-35 2722 B, CFHTWIR-Oph 98 A, G 268-110, Kepler-1676, Kepler-1737,
  Kepler-1756, Kepler-1760, Kepler-1795, Kepler-1813, Kepler-1855, Kepler-1910, Kepler-1945, Kepler-1964, Kepler-1984, Kepler-1985, Luhman 16 A, M62H, MXB 1658-298,
  OGLE-2016-BLG-1227L, OGLE-2017-BLG-1140L, PSR B1620-26, SPECULOOS-3, TOI-2977, TOI-3540 A, V2376 Ori, WISE J033605.05-014350.4, mu2 Sco.
  4,491 hosts have a Gaia DR3 id; 371 do not (28 of those have a DR2 id only; overlap with the no-distance hosts: 14).
- Offline rebuild produces a byte-identical file (sha256 c2ccabae2b83ca304e9e928cafad59622e5bed0bcaab3b7f73c9869ca83de0ac, same as the online build).

## Not done

No distance quality filtering, no ranking, no prose. Gaia DR3 matching against the atlas subset is left to the discovery index. Positions are not
epoch-propagated. The archive's per-parameter errors for eccentricity, semi-major axis and equilibrium temperature are not stored.
