# Discovery notes: sources for stars, exoplanets and Sagittarius A*

Author: N2. Retrieval date for every source below: 2026-11-13. Notes live in `tools/discovery/notes/stars-exo.json` (DiscoveryNote[]), relations in `tools/discovery/notes/relations.json` (Relation[]); the lead merges them into `public/data/discovery-notes.v1.json` and `public/data/relations.v1.json`. Check with `node tools/discovery/notes/validate_relations.mjs`.

## Method and rules applied

- Each claim is one short sentence with a status (observed, inferred, hypothesis, historical) and at least one reference that was fetched in the authoring session. No claim was written from memory; where a source did not state something, the claim was dropped.
- Sources used: arXiv abstract pages (`arxiv.org/abs/...`, read as the page metadata), SIMBAD TAP queries on `simbad.cfa.harvard.edu` (the URL given is the exact query), NASA Exoplanet Archive TAP queries on the Planetary Systems Composite Parameters table (`pscomppars`; the URL is the exact query), the archive column definitions page, and the Nobel Prize 2019 press release. No Wikipedia.
- Only the abstracts were read for the arXiv papers, not the full texts; every claim is limited to what the abstract states.
- HIP numbers were verified against SIMBAD (`ident` table) before use: Sirius 32349, Betelgeuse 27989, Proxima 70890, Alpha Cen A 71683, Alpha Cen B 71681, Barnard's Star 87937, Vega 91262, Polaris 11767, Rigel 24436, Arcturus 69673, Antares 80763, Tau Ceti 8102, Epsilon Eridani 16537, Mira 10826.
- Parallaxes and spectral types are quoted from SIMBAD as listed; SIMBAD's per-value bibliographic source was not retrieved, so the notes do not name the catalogue behind a SIMBAD value.
- Planet values quoted from the archive are the archive's current default parameter set, which can differ from the discovery paper; where they differ, the note says so (LHS 1140 b, TOI-700 d, eps Eri b, Proxima b).
- NASA Science planet-catalogue pages were fetched but carry almost no body text without scripts, so they are not cited.

## Notes and their references

### hip:32349

One line: A visual binary: the brightest star in the sky, orbited by a white dwarf every 50.13 years.

- Bond et al. 2017, The Sirius System and its Astrophysical Puzzles (arXiv:1703.10625): <https://arxiv.org/abs/1703.10625>
- SIMBAD (CDS), SIMBAD basic data for HIP 32349: <https://simbad.cfa.harvard.edu/simbad/sim-tap/sync?request=doQuery&lang=adql&format=text&query=SELECT+b.main_id%2C+b.otype%2C+b.sp_type%2C+b.plx_value%2C+b.plx_err%2C+b.pmra%2C+b.pmdec%2C+b.ra%2C+b.dec+FROM+ident+AS+i+JOIN+basic+AS+b+ON+b.oid%3Di.oidref+WHERE+i.id+%3D+%27HIP+32349%27>
- Joyce et al. 2018, The gravitational redshift of Sirius B (arXiv:1809.01240): <https://arxiv.org/abs/1809.01240>

### hip:27989

One line: A red supergiant; published distance estimates differ, from about 168 pc to about 220 pc.

- Montarges et al. 2021/2022, A dusty veil shading Betelgeuse during its Great Dimming (arXiv:2201.10551): <https://arxiv.org/abs/2201.10551>
- SIMBAD (CDS), SIMBAD basic data for HIP 27989: <https://simbad.cfa.harvard.edu/simbad/sim-tap/sync?request=doQuery&lang=adql&format=text&query=SELECT+b.main_id%2C+b.otype%2C+b.sp_type%2C+b.plx_value%2C+b.plx_err%2C+b.pmra%2C+b.pmdec%2C+b.ra%2C+b.dec+FROM+ident+AS+i+JOIN+basic+AS+b+ON+b.oid%3Di.oidref+WHERE+i.id+%3D+%27HIP+27989%27>
- Joyce et al. 2020, New mass and distance estimates for Betelgeuse (arXiv:2006.09837): <https://arxiv.org/abs/2006.09837>
- Dupree et al. 2020, Spatially resolved ultraviolet spectroscopy of the Great Dimming of Betelgeuse (arXiv:2008.04945): <https://arxiv.org/abs/2008.04945>

### hip:70890

One line: The Sun's closest known stellar neighbour, a red dwarf about 1.3 parsecs away.

- Anglada-Escude et al. 2016, A terrestrial planet candidate in a temperate orbit around Proxima Centauri (arXiv:1609.03449): <https://arxiv.org/abs/1609.03449>
- SIMBAD (CDS), SIMBAD basic data for HIP 70890: <https://simbad.cfa.harvard.edu/simbad/sim-tap/sync?request=doQuery&lang=adql&format=text&query=SELECT+b.main_id%2C+b.otype%2C+b.sp_type%2C+b.plx_value%2C+b.plx_err%2C+b.pmra%2C+b.pmdec%2C+b.ra%2C+b.dec+FROM+ident+AS+i+JOIN+basic+AS+b+ON+b.oid%3Di.oidref+WHERE+i.id+%3D+%27HIP+70890%27>
- Kervella, Thevenin & Lovis 2017, Proxima's orbit around Alpha Centauri (arXiv:1611.03495): <https://arxiv.org/abs/1611.03495>
- NASA Exoplanet Archive, Planetary Systems Composite Parameters table, host Proxima Cen: <https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=select+pl_name%2Chostname%2Cdiscoverymethod%2Cdisc_year%2Cdisc_facility%2Cpl_orbper%2Cpl_rade%2Cpl_bmasse%2Cpl_bmassprov%2Cpl_eqt%2Cpl_orbsmax%2Csy_dist%2Csy_pnum+from+pscomppars+where+hostname%3D%27Proxima+Cen%27&format=csv>

### hip:71683

One line: A G2 V star in a close binary with Alpha Centauri B; mass about 1.13 solar masses.

- SIMBAD (CDS), SIMBAD basic data for HIP 71683: <https://simbad.cfa.harvard.edu/simbad/sim-tap/sync?request=doQuery&lang=adql&format=text&query=SELECT+b.main_id%2C+b.otype%2C+b.sp_type%2C+b.plx_value%2C+b.plx_err%2C+b.pmra%2C+b.pmdec%2C+b.ra%2C+b.dec+FROM+ident+AS+i+JOIN+basic+AS+b+ON+b.oid%3Di.oidref+WHERE+i.id+%3D+%27HIP+71683%27>
- Pourbaix & Boffin 2016, Parallax and masses of alpha Centauri revisited (arXiv:1601.01636): <https://arxiv.org/abs/1601.01636>
- Kervella, Thevenin & Lovis 2017, Proxima's orbit around Alpha Centauri (arXiv:1611.03495): <https://arxiv.org/abs/1611.03495>

### hip:71681

One line: A K1 V star in a close binary with Alpha Centauri A; mass about 0.97 solar masses.

- SIMBAD (CDS), SIMBAD basic data for HIP 71681: <https://simbad.cfa.harvard.edu/simbad/sim-tap/sync?request=doQuery&lang=adql&format=text&query=SELECT+b.main_id%2C+b.otype%2C+b.sp_type%2C+b.plx_value%2C+b.plx_err%2C+b.pmra%2C+b.pmdec%2C+b.ra%2C+b.dec+FROM+ident+AS+i+JOIN+basic+AS+b+ON+b.oid%3Di.oidref+WHERE+i.id+%3D+%27HIP+71681%27>
- Pourbaix & Boffin 2016, Parallax and masses of alpha Centauri revisited (arXiv:1601.01636): <https://arxiv.org/abs/1601.01636>
- Kervella, Thevenin & Lovis 2017, Proxima's orbit around Alpha Centauri (arXiv:1611.03495): <https://arxiv.org/abs/1611.03495>
- SIMBAD (CDS), SIMBAD basic data for HIP 71683: <https://simbad.cfa.harvard.edu/simbad/sim-tap/sync?request=doQuery&lang=adql&format=text&query=SELECT+b.main_id%2C+b.otype%2C+b.sp_type%2C+b.plx_value%2C+b.plx_err%2C+b.pmra%2C+b.pmdec%2C+b.ra%2C+b.dec+FROM+ident+AS+i+JOIN+basic+AS+b+ON+b.oid%3Di.oidref+WHERE+i.id+%3D+%27HIP+71683%27>

### hip:87937

One line: A red dwarf 1.8 pc away with the largest apparent motion of any known stellar object.

- Ribas et al. 2018, A candidate super-Earth planet orbiting near the snow line of Barnard's star (arXiv:1811.05955): <https://arxiv.org/abs/1811.05955>
- SIMBAD (CDS), SIMBAD basic data for HIP 87937: <https://simbad.cfa.harvard.edu/simbad/sim-tap/sync?request=doQuery&lang=adql&format=text&query=SELECT+b.main_id%2C+b.otype%2C+b.sp_type%2C+b.plx_value%2C+b.plx_err%2C+b.pmra%2C+b.pmdec%2C+b.ra%2C+b.dec+FROM+ident+AS+i+JOIN+basic+AS+b+ON+b.oid%3Di.oidref+WHERE+i.id+%3D+%27HIP+87937%27>
- Gonzalez Hernandez et al. 2024, A sub-Earth-mass planet orbiting Barnard's star (arXiv:2410.00569): <https://arxiv.org/abs/2410.00569>
- Basant et al. 2025, Four sub-Earth planets orbiting Barnard's Star from MAROON-X and ESPRESSO (arXiv:2503.08095): <https://arxiv.org/abs/2503.08095>
- NASA Exoplanet Archive, Planetary Systems Composite Parameters table, host Barnard's star: <https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=select+pl_name%2Chostname%2Cdiscoverymethod%2Cdisc_year%2Cdisc_facility%2Cpl_orbper%2Cpl_rade%2Cpl_bmasse%2Cpl_bmassprov%2Cpl_eqt%2Cpl_orbsmax%2Csy_dist%2Csy_pnum+from+pscomppars+where+hostname%3D%27Barnard%27%27s+star%27&format=csv>

### hip:91262

One line: A bright A0 V standard star that spins at over 90% of break-up speed and is seen nearly pole-on.

- Peterson et al. 2006, Vega is a rapidly rotating star (arXiv:astro-ph/0603520): <https://arxiv.org/abs/astro-ph/0603520>
- SIMBAD (CDS), SIMBAD basic data for HIP 91262: <https://simbad.cfa.harvard.edu/simbad/sim-tap/sync?request=doQuery&lang=adql&format=text&query=SELECT+b.main_id%2C+b.otype%2C+b.sp_type%2C+b.plx_value%2C+b.plx_err%2C+b.pmra%2C+b.pmdec%2C+b.ra%2C+b.dec+FROM+ident+AS+i+JOIN+basic+AS+b+ON+b.oid%3Di.oidref+WHERE+i.id+%3D+%27HIP+91262%27>
- Aufdenberg et al. 2006, First Results from the CHARA Array VII: Vega (arXiv:astro-ph/0603327): <https://arxiv.org/abs/astro-ph/0603327>
- Heinze et al. 2008, Deep L and M-band Imaging for Planets Around Vega and epsilon Eridani (arXiv:0807.3975): <https://arxiv.org/abs/0807.3975>

### hip:11767

One line: The nearest and brightest classical Cepheid; its distance is contested between Hipparcos and Hubble.

- Evans et al. 2008, Direct Detection of the Close Companion of Polaris with the Hubble Space Telescope (arXiv:0806.4904): <https://arxiv.org/abs/0806.4904>
- SIMBAD (CDS), SIMBAD basic data for HIP 11767: <https://simbad.cfa.harvard.edu/simbad/sim-tap/sync?request=doQuery&lang=adql&format=text&query=SELECT+b.main_id%2C+b.otype%2C+b.sp_type%2C+b.plx_value%2C+b.plx_err%2C+b.pmra%2C+b.pmdec%2C+b.ra%2C+b.dec+FROM+ident+AS+i+JOIN+basic+AS+b+ON+b.oid%3Di.oidref+WHERE+i.id+%3D+%27HIP+11767%27>
- Bond et al. 2017, Hubble Space Telescope Trigonometric Parallax of Polaris B (arXiv:1712.08139): <https://arxiv.org/abs/1712.08139>
- Evans et al. 2018, The Orbit of the Close Companion of Polaris (arXiv:1807.06115): <https://arxiv.org/abs/1807.06115>

### hip:24436

One line: A nearby blue supergiant (B8 Ia) with alpha Cygni-type pulsation variability.

- Moravveji et al. 2012, Asteroseismology of the Nearby SN-II Progenitor: Rigel Part I (arXiv:1201.0843): <https://arxiv.org/abs/1201.0843>
- SIMBAD (CDS), SIMBAD basic data for HIP 24436: <https://simbad.cfa.harvard.edu/simbad/sim-tap/sync?request=doQuery&lang=adql&format=text&query=SELECT+b.main_id%2C+b.otype%2C+b.sp_type%2C+b.plx_value%2C+b.plx_err%2C+b.pmra%2C+b.pmdec%2C+b.ra%2C+b.dec+FROM+ident+AS+i+JOIN+basic+AS+b+ON+b.oid%3Di.oidref+WHERE+i.id+%3D+%27HIP+24436%27>

### hip:69673

One line: A red giant of about 25 solar radii and 1.08 solar masses (Ramirez & Allende Prieto 2011).

- Ramirez & Allende Prieto 2011, Fundamental Parameters and Chemical Composition of Arcturus (arXiv:1109.4425): <https://arxiv.org/abs/1109.4425>
- SIMBAD (CDS), SIMBAD basic data for HIP 69673: <https://simbad.cfa.harvard.edu/simbad/sim-tap/sync?request=doQuery&lang=adql&format=text&query=SELECT+b.main_id%2C+b.otype%2C+b.sp_type%2C+b.plx_value%2C+b.plx_err%2C+b.pmra%2C+b.pmdec%2C+b.ra%2C+b.dec+FROM+ident+AS+i+JOIN+basic+AS+b+ON+b.oid%3Di.oidref+WHERE+i.id+%3D+%27HIP+69673%27>

### hip:80763

One line: A red supergiant whose atmosphere has been resolved by ALMA, the VLA and the VLTI.

- O'Gorman et al. 2020, ALMA and VLA reveal the lukewarm chromospheres of the nearby red supergiants Antares and Betelgeuse (arXiv:2006.08023): <https://arxiv.org/abs/2006.08023>
- SIMBAD (CDS), SIMBAD basic data for HIP 80763: <https://simbad.cfa.harvard.edu/simbad/sim-tap/sync?request=doQuery&lang=adql&format=text&query=SELECT+b.main_id%2C+b.otype%2C+b.sp_type%2C+b.plx_value%2C+b.plx_err%2C+b.pmra%2C+b.pmdec%2C+b.ra%2C+b.dec+FROM+ident+AS+i+JOIN+basic+AS+b+ON+b.oid%3Di.oidref+WHERE+i.id+%3D+%27HIP+80763%27>
- Ohnaka et al. 2013, High spectral resolution imaging of the dynamical atmosphere of Antares (arXiv:1304.4800): <https://arxiv.org/abs/1304.4800>
- Montarges et al. 2017, The convective surface of the red supergiant Antares (arXiv:1705.07829): <https://arxiv.org/abs/1705.07829>

### hip:8102

One line: A nearby Sun-like (G8 V) star with radial-velocity planet signals whose number differs by source.

- SIMBAD (CDS), SIMBAD basic data for HIP 8102: <https://simbad.cfa.harvard.edu/simbad/sim-tap/sync?request=doQuery&lang=adql&format=text&query=SELECT+b.main_id%2C+b.otype%2C+b.sp_type%2C+b.plx_value%2C+b.plx_err%2C+b.pmra%2C+b.pmdec%2C+b.ra%2C+b.dec+FROM+ident+AS+i+JOIN+basic+AS+b+ON+b.oid%3Di.oidref+WHERE+i.id+%3D+%27HIP+8102%27>
- Dietrich & Apai 2020, An Integrated Analysis with Predictions on the Architecture of the tau Ceti Planetary System (arXiv:2010.14675): <https://arxiv.org/abs/2010.14675>
- Feng et al. 2017, Color difference makes a difference: four planet candidates around tau Ceti (arXiv:1708.02051): <https://arxiv.org/abs/1708.02051>
- NASA Exoplanet Archive, Planetary Systems Composite Parameters table, host tau Cet: <https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=select+pl_name%2Chostname%2Cdiscoverymethod%2Cdisc_year%2Cdisc_facility%2Cpl_orbper%2Cpl_rade%2Cpl_bmasse%2Cpl_bmassprov%2Cpl_eqt%2Cpl_orbsmax%2Csy_dist%2Csy_pnum+from+pscomppars+where+hostname%3D%27tau+Cet%27&format=csv>

### hip:16537

One line: A nearby K2 V star (3.22 pc) with a long-period giant planet seen by radial velocity and HST astrometry.

- Hatzes et al. 2000, Evidence for a Long-period Planet Orbiting Epsilon Eridani (arXiv:astro-ph/0009423): <https://arxiv.org/abs/astro-ph/0009423>
- SIMBAD (CDS), SIMBAD basic data for HIP 16537: <https://simbad.cfa.harvard.edu/simbad/sim-tap/sync?request=doQuery&lang=adql&format=text&query=SELECT+b.main_id%2C+b.otype%2C+b.sp_type%2C+b.plx_value%2C+b.plx_err%2C+b.pmra%2C+b.pmdec%2C+b.ra%2C+b.dec+FROM+ident+AS+i+JOIN+basic+AS+b+ON+b.oid%3Di.oidref+WHERE+i.id+%3D+%27HIP+16537%27>
- Benedict et al. 2006, The Extrasolar Planet epsilon Eridani b - Orbit and Mass (arXiv:astro-ph/0610247): <https://arxiv.org/abs/astro-ph/0610247>
- NASA Exoplanet Archive, Planetary Systems Composite Parameters table, host eps Eri: <https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=select+pl_name%2Chostname%2Cdiscoverymethod%2Cdisc_year%2Cdisc_facility%2Cpl_orbper%2Cpl_rade%2Cpl_bmasse%2Cpl_bmassprov%2Cpl_eqt%2Cpl_orbsmax%2Csy_dist%2Csy_pnum+from+pscomppars+where+hostname%3D%27eps+Eri%27&format=csv>

### hip:10826

One line: The prototype of the Mira-type long-period variables, with a hot companion detected at radio wavelengths.

- Fabas et al. 2011, Shock-Induced Polarized Hydrogen Emission Lines in the Mira Star omicron Ceti (arXiv:1109.6500): <https://arxiv.org/abs/1109.6500>
- SIMBAD (CDS), SIMBAD basic data for HIP 10826: <https://simbad.cfa.harvard.edu/simbad/sim-tap/sync?request=doQuery&lang=adql&format=text&query=SELECT+b.main_id%2C+b.otype%2C+b.sp_type%2C+b.plx_value%2C+b.plx_err%2C+b.pmra%2C+b.pmdec%2C+b.ra%2C+b.dec+FROM+ident+AS+i+JOIN+basic+AS+b+ON+b.oid%3Di.oidref+WHERE+i.id+%3D+%27HIP+10826%27>
- Matthews et al. 2015, New Measurements of the Radio Photosphere of Mira (arXiv:1506.03075): <https://arxiv.org/abs/1506.03075>
- Zamanov et al. 2026, Is Mira B a low mass white dwarf? (arXiv:2602.21725): <https://arxiv.org/abs/2602.21725>

### exo:Proxima Cen b

One line: A planet with minimum mass about 1.1-1.3 Earth masses orbiting Proxima Centauri every 11.2 days.

- Anglada-Escude et al. 2016, A terrestrial planet candidate in a temperate orbit around Proxima Centauri (arXiv:1609.03449): <https://arxiv.org/abs/1609.03449>
- NASA Exoplanet Archive, Planetary Systems Composite Parameters table, row Proxima Cen b: <https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=select+pl_name%2Chostname%2Cdiscoverymethod%2Cdisc_year%2Cdisc_facility%2Cpl_orbper%2Cpl_rade%2Cpl_bmasse%2Cpl_bmassprov%2Cpl_eqt%2Cpl_orbsmax%2Csy_dist%2Csy_pnum+from+pscomppars+where+pl_name%3D%27Proxima+Cen+b%27&format=csv>
- Dittmann et al. 2017, A temperate rocky super-Earth transiting a nearby cool star (arXiv:1704.05556): <https://arxiv.org/abs/1704.05556>
- NASA Exoplanet Archive, Planetary Systems Composite Parameters column definitions: <https://exoplanetarchive.ipac.caltech.edu/docs/API_PS_columns.html>

### host:TRAPPIST-1

One line: An ultracool dwarf 12 pc away with seven Earth-sized planets, six of them in a near-resonant chain.

- Gillon et al. 2017, Seven temperate terrestrial planets around the nearby ultracool dwarf star TRAPPIST-1 (arXiv:1703.01424): <https://arxiv.org/abs/1703.01424>
- SIMBAD (CDS), SIMBAD basic data for TRAPPIST-1: <https://simbad.cfa.harvard.edu/simbad/sim-tap/sync?request=doQuery&lang=adql&format=text&query=SELECT+b.main_id%2C+b.otype%2C+b.sp_type%2C+b.plx_value%2C+b.plx_err%2C+b.pmra%2C+b.pmdec%2C+b.ra%2C+b.dec+FROM+ident+AS+i+JOIN+basic+AS+b+ON+b.oid%3Di.oidref+WHERE+i.id+%3D+%27TRAPPIST-1%27>
- NASA Exoplanet Archive, Planetary Systems Composite Parameters table, host TRAPPIST-1: <https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=select+pl_name%2Chostname%2Cdiscoverymethod%2Cdisc_year%2Cdisc_facility%2Cpl_orbper%2Cpl_rade%2Cpl_bmasse%2Cpl_bmassprov%2Cpl_eqt%2Cpl_orbsmax%2Csy_dist%2Csy_pnum+from+pscomppars+where+hostname%3D%27TRAPPIST-1%27&format=csv>
- Zieba et al. 2023, No thick carbon dioxide atmosphere on the rocky exoplanet TRAPPIST-1 c (arXiv:2306.10150): <https://arxiv.org/abs/2306.10150>
- Gillon et al. 2025, First JWST thermal phase curves of temperate terrestrial exoplanets (arXiv:2509.02128): <https://arxiv.org/abs/2509.02128>

### exo:TRAPPIST-1 e

One line: An Earth-sized transiting planet of TRAPPIST-1; JWST data so far neither confirm nor rule out an atmosphere.

- NASA Exoplanet Archive, Planetary Systems Composite Parameters table, row TRAPPIST-1 e: <https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=select+pl_name%2Chostname%2Cdiscoverymethod%2Cdisc_year%2Cdisc_facility%2Cpl_orbper%2Cpl_rade%2Cpl_bmasse%2Cpl_bmassprov%2Cpl_eqt%2Cpl_orbsmax%2Csy_dist%2Csy_pnum+from+pscomppars+where+pl_name%3D%27TRAPPIST-1+e%27&format=csv>
- Gillon et al. 2017, Seven temperate terrestrial planets around the nearby ultracool dwarf star TRAPPIST-1 (arXiv:1703.01424): <https://arxiv.org/abs/1703.01424>
- Glidden et al. 2025, JWST-TST DREAMS: Secondary Atmosphere Constraints for TRAPPIST-1 e (arXiv:2509.05407): <https://arxiv.org/abs/2509.05407>
- NASA Exoplanet Archive, Planetary Systems Composite Parameters column definitions: <https://exoplanetarchive.ipac.caltech.edu/docs/API_PS_columns.html>

### exo:51 Peg b

One line: The first planet found orbiting a solar-type star beyond the Solar System, announced in 1995.

- NASA Exoplanet Archive, Planetary Systems Composite Parameters table, row 51 Peg b: <https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=select+pl_name%2Chostname%2Cdiscoverymethod%2Cdisc_year%2Cdisc_facility%2Cpl_orbper%2Cpl_rade%2Cpl_bmasse%2Cpl_bmassprov%2Cpl_eqt%2Cpl_orbsmax%2Csy_dist%2Csy_pnum+from+pscomppars+where+pl_name%3D%2751+Peg+b%27&format=csv>
- The Nobel Prize in Physics 2019, press release (Royal Swedish Academy of Sciences): <https://www.nobelprize.org/prizes/physics/2019/press-release/>
- NASA Exoplanet Archive, Planetary Systems Composite Parameters column definitions: <https://exoplanetarchive.ipac.caltech.edu/docs/API_PS_columns.html>

### exo:Kepler-452 b

One line: A 1.6 Earth-radius planet on a 384.8-day orbit around a G2 star, validated from Kepler transits.

- Jenkins et al. 2015, Discovery and Validation of Kepler-452b (arXiv:1507.06723): <https://arxiv.org/abs/1507.06723>
- NASA Exoplanet Archive, Planetary Systems Composite Parameters table, row Kepler-452 b: <https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=select+pl_name%2Chostname%2Cdiscoverymethod%2Cdisc_year%2Cdisc_facility%2Cpl_orbper%2Cpl_rade%2Cpl_bmasse%2Cpl_bmassprov%2Cpl_eqt%2Cpl_orbsmax%2Csy_dist%2Csy_pnum+from+pscomppars+where+pl_name%3D%27Kepler-452+b%27&format=csv>

### exo:55 Cnc e

One line: A hot transiting super-Earth with a 0.74-day orbit and a strongly hotter dayside, observed in the infrared.

- NASA Exoplanet Archive, Planetary Systems Composite Parameters table, row 55 Cnc e: <https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=select+pl_name%2Chostname%2Cdiscoverymethod%2Cdisc_year%2Cdisc_facility%2Cpl_orbper%2Cpl_rade%2Cpl_bmasse%2Cpl_bmassprov%2Cpl_eqt%2Cpl_orbsmax%2Csy_dist%2Csy_pnum+from+pscomppars+where+pl_name%3D%2755+Cnc+e%27&format=csv>
- Demory et al. 2016, A map of the large day-night temperature gradient of a super-Earth exoplanet (arXiv:1604.05725): <https://arxiv.org/abs/1604.05725>

### exo:HD 209458 b

One line: A gas giant detected transiting a Sun-like star; Hubble saw Lyman-alpha absorption during its transits.

- Charbonneau et al. 2000, Detection of Planetary Transits Across a Sun-like Star (arXiv:astro-ph/9911436): <https://arxiv.org/abs/astro-ph/9911436>
- NASA Exoplanet Archive, Planetary Systems Composite Parameters table, row HD 209458 b: <https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=select+pl_name%2Chostname%2Cdiscoverymethod%2Cdisc_year%2Cdisc_facility%2Cpl_orbper%2Cpl_rade%2Cpl_bmasse%2Cpl_bmassprov%2Cpl_eqt%2Cpl_orbsmax%2Csy_dist%2Csy_pnum+from+pscomppars+where+pl_name%3D%27HD+209458+b%27&format=csv>
- Desert et al. 2004, The data analysis of HD209458 Ly-alpha transit occultation (arXiv:astro-ph/0312383): <https://arxiv.org/abs/astro-ph/0312383>

### exo:LHS 1140 b

One line: A rocky-density super-Earth transiting a nearby M dwarf, in the stellar liquid-water habitable zone by flux.

- Dittmann et al. 2017, A temperate rocky super-Earth transiting a nearby cool star (arXiv:1704.05556): <https://arxiv.org/abs/1704.05556>
- NASA Exoplanet Archive, Planetary Systems Composite Parameters table, row LHS 1140 b: <https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=select+pl_name%2Chostname%2Cdiscoverymethod%2Cdisc_year%2Cdisc_facility%2Cpl_orbper%2Cpl_rade%2Cpl_bmasse%2Cpl_bmassprov%2Cpl_eqt%2Cpl_orbsmax%2Csy_dist%2Csy_pnum+from+pscomppars+where+pl_name%3D%27LHS+1140+b%27&format=csv>

### exo:TOI-700 d

One line: An Earth-sized (about 1.2 Earth radii) planet in the habitable zone of an M2 dwarf, validated from TESS data.

- Gilbert et al. 2020, The First Habitable Zone Earth-sized Planet from TESS. I: Validation of the TOI-700 System (arXiv:2001.00952): <https://arxiv.org/abs/2001.00952>
- NASA Exoplanet Archive, Planetary Systems Composite Parameters table, row TOI-700 d: <https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=select+pl_name%2Chostname%2Cdiscoverymethod%2Cdisc_year%2Cdisc_facility%2Cpl_orbper%2Cpl_rade%2Cpl_bmasse%2Cpl_bmassprov%2Cpl_eqt%2Cpl_orbsmax%2Csy_dist%2Csy_pnum+from+pscomppars+where+pl_name%3D%27TOI-700+d%27&format=csv>

### other:sgr-a-star

One line: The compact radio source at the Galactic Centre, a massive black hole of about 4.3 million solar masses.

- GRAVITY Collaboration 2019, A geometric distance measurement to the Galactic Center black hole with 0.3% uncertainty (arXiv:1904.05721): <https://arxiv.org/abs/1904.05721>
- SIMBAD (CDS), SIMBAD basic data for Sgr A*: <https://simbad.cfa.harvard.edu/simbad/sim-tap/sync?request=doQuery&lang=adql&format=text&query=SELECT+b.main_id%2C+b.otype%2C+b.sp_type%2C+b.plx_value%2C+b.plx_err%2C+b.pmra%2C+b.pmdec%2C+b.ra%2C+b.dec+FROM+ident+AS+i+JOIN+basic+AS+b+ON+b.oid%3Di.oidref+WHERE+i.id+%3D+%27Sgr+A%2A%27>
- Genzel, Eisenhauer & Gillessen 2010, The Galactic Center Massive Black Hole and Nuclear Star Cluster (arXiv:1006.0064): <https://arxiv.org/abs/1006.0064>
- GRAVITY Collaboration 2022, The mass distribution in the Galactic Centre from interferometric astrometry of multiple stellar orbits (arXiv:2112.07478): <https://arxiv.org/abs/2112.07478>
- Ghez et al. 2008, Measuring Distance and Properties of the Milky Way's Central Supermassive Black Hole with Stellar Orbits (arXiv:0808.2870): <https://arxiv.org/abs/0808.2870>

## Relations

- `hip:70890` -> `hip:71683` (orbits, physical-gravitational): Proxima Centauri is gravitationally bound to the Alpha Centauri AB pair (this record is component A) with a high degree of confidence; Kervella et al. 2017 find an orbital period of about 550,000 years and an eccentricity of 0.50 (+0.08, -0.09). Source: Kervella, Thevenin & Lovis 2017, Proxima's orbit around Alpha Centauri (arXiv:1611.03495) [retrieved 2026-11-13] <https://arxiv.org/abs/1611.03495>
- `hip:70890` -> `hip:71681` (orbits, physical-gravitational): Proxima Centauri is gravitationally bound to the Alpha Centauri AB pair (this record is component B) with a high degree of confidence; Kervella et al. 2017 find an orbital period of about 550,000 years and an eccentricity of 0.50 (+0.08, -0.09). Source: Kervella, Thevenin & Lovis 2017, Proxima's orbit around Alpha Centauri (arXiv:1611.03495) [retrieved 2026-11-13] <https://arxiv.org/abs/1611.03495>
- `hip:71683` -> `hip:71681` (component-of, physical-gravitational): Alpha Centauri A and B are the two components of one binary, for which Pourbaix & Boffin 2016 derive a full three-dimensional orbit and masses of 1.13 and 0.97 solar masses. Source: Pourbaix & Boffin 2016, Parallax and masses of alpha Centauri revisited (arXiv:1601.01636) [retrieved 2026-11-13] <https://arxiv.org/abs/1601.01636>
- `solar:sun` -> `deep:milky-way` (part-of, structural): The Sun lies inside the Milky Way, about 8178 pc from the Galactic Centre in the atlas model (GRAVITY Collaboration 2019 for the distance; Bland-Hawthorn & Gerhard 2016 for the Galaxy structure). Source: GRAVITY Collaboration 2019, A geometric distance measurement to the Galactic Center black hole with 0.3% uncertainty (arXiv:1904.05721) [retrieved 2026-11-13]; structure: Bland-Hawthorn & Gerhard 2016, The Galaxy in Context (arXiv:1602.07702), used by the atlas Milky Way model [retrieved 2026-11-13] <https://arxiv.org/abs/1904.05721>
- `other:sgr-a-star` -> `deep:milky-way` (part-of, structural): Sgr A*, a massive black hole, sits at the Galactic Centre of the Milky Way; the star S2 orbits it (GRAVITY Collaboration 2019) and the radio source is argued to be a massive black hole of about 4.4 million solar masses (Genzel et al. 2010). Source: GRAVITY Collaboration 2019, A geometric distance measurement to the Galactic Center black hole with 0.3% uncertainty (arXiv:1904.05721) [retrieved 2026-11-13]; Genzel, Eisenhauer & Gillessen 2010, The Galactic Center Massive Black Hole and Nuclear Star Cluster (arXiv:1006.0064) [retrieved 2026-11-13] <https://arxiv.org/abs/1904.05721>

Not written, by design: exoplanet-orbits-host relations (derived by the engine), TRAPPIST-1 planets orbiting TRAPPIST-1, cluster and Local Group membership (dataset-derived).

## Dropped or weakened

- Planet pages from NASA Science: fetched, no usable body text; replaced by arXiv abstracts and the archive.
- Discovery paper of 51 Peg b (Mayor & Queloz 1995): not on arXiv and not retrieved; the note rests on the Nobel Prize press release and the archive entry, and says so.
- Original 55 Cnc e discovery paper (McArthur et al. 2004) and the HD 209458 b radial-velocity discovery papers: not retrieved; the notes cite only the archive entry for the discovery method and year.
- Betelgeuse distance from radio measurements (Harper et al. 2017): not retrieved; only the two retrieved estimates (168 and about 220 pc) and the SIMBAD parallax are given.
- Proper-motion discovery history (Barnard 1916, Halley and Arcturus): no retrieved source, dropped.
- Habitability statements: kept only as hypotheses with the authors' own caveats; no claim that any planet is habitable.
- Alpha Centauri Bb: a transit search paper exists (arXiv:1503.07528) but the planet's status was not checked, so it is not mentioned.
- Rigel, Arcturus and Mira have thinner source lists (one to three references) than the others; Arcturus has no mission-level reference.
