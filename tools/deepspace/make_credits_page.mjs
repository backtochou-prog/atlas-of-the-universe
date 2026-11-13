// Generates public/credits.html from public/deepspace/provenance.json: every deep-space image, its verbatim credit line, licence,
// archive id, band and fidelity. Run after the image build:  node tools/deepspace/make_credits_page.mjs
// The page is static (no scripts) and is linked from the application footer and from the image-credits popover.
import { readFile, writeFile } from 'node:fs/promises';

const SRC = process.argv[2] ?? 'public/deepspace/provenance.json';
const OUT = process.argv[3] ?? 'public/credits.html';
const prov = JSON.parse(await readFile(SRC, 'utf8'));

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeUrl = (u) => (/^https?:\/\//i.test(u ?? '') ? u : '');
const link = (text, url) => (safeUrl(url) ? `<a href="${esc(safeUrl(url))}" rel="noopener noreferrer">${esc(text)}</a>` : esc(text));

const BAND = { visible: 'Visible light', 'near-infrared': 'Near-infrared', 'mid-infrared': 'Mid-infrared', 'far-infrared': 'Far-infrared', ultraviolet: 'Ultraviolet', 'x-ray': 'X-ray', radio: 'Radio', 'gamma-ray': 'Gamma-ray', 'multi-band-composite': 'Multi-band composite' };
const FID = { 'scientific-image': 'Scientific image (processed for display)', 'multi-band-composite': 'Multi-band composite', 'artist-processed': 'Artist-processed' };

const byObject = new Map();
for (const a of prov.assets) { if (!byObject.has(a.objectId)) byObject.set(a.objectId, []); byObject.get(a.objectId).push(a); }

const sections = [...byObject.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([obj, list]) => {
  const items = list.map((a) => `
      <article id="${esc(a.id)}">
        <h3>${esc(a.title)}</h3>
        <p class="credit">${esc(a.credit)}</p>
        <dl>
          <dt>Archive</dt><dd>${esc(a.source.archive)} · ${link(a.source.imageId, a.source.landingUrl)}</dd>
          <dt>Licence</dt><dd>${link(a.licence.name, a.licence.url)}${a.licence.attributionRequired ? ' (credit required)' : ''}</dd>
          <dt>Telescope</dt><dd>${esc(a.observation.telescope)}${a.observation.instrument ? ' · ' + esc(a.observation.instrument) : ''}${a.observation.date ? ' · ' + esc(a.observation.date) : ''}</dd>
          <dt>Band</dt><dd>${esc(BAND[a.band.kind] ?? a.band.kind)}${a.band.filters?.length ? ' (' + esc(a.band.filters.join(', ')) + ')' : ''}${a.band.falseColour ? ' · false colour' : ''}${a.band.composite ? ' · composite' : ''}</dd>
          <dt>Fidelity</dt><dd>${esc(FID[a.fidelity] ?? a.fidelity)}</dd>
          <dt>Retrieved</dt><dd>${esc(a.source.retrieved)}</dd>
        </dl>
        <p class="note">${esc(a.band.colourNote)}</p>
      </article>`).join('');
  return `    <section><h2>${esc(obj)}</h2>${items}\n    </section>`;
}).join('\n');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Image credits and licences - Atlas of the Universe</title>
<style>
  :root { color-scheme: dark; --bg:#03050a; --fg:#c4ccd8; --mut:#6f7a8c; --rule:#1b2230; --amber:#d9b97a; --link:#8fb0d2; font: 14px/1.55 ui-sans-serif, system-ui, sans-serif; }
  body { background:var(--bg); color:var(--fg); margin:0; padding:24px 16px 64px; }
  main { max-width:820px; margin:0 auto; }
  h1 { font-size:12px; letter-spacing:.22em; color:var(--mut); font-weight:600; margin:0 0 12px; }
  h2 { font-size:11px; letter-spacing:.18em; text-transform:uppercase; color:var(--mut); border-top:1px solid var(--rule); padding-top:12px; margin:28px 0 8px; }
  h3 { font-size:14px; margin:14px 0 2px; font-weight:600; }
  a { color:var(--link); }
  .credit { margin:2px 0 6px; } .note, .lead { color:var(--mut); font-size:12.5px; }
  dl { display:grid; grid-template-columns:90px 1fr; gap:1px 12px; margin:4px 0; font-size:12.5px; } dt { color:var(--mut); } dd { margin:0; }
  article { margin-bottom:14px; }
</style>
</head>
<body>
<main>
  <h1>ATLAS OF THE UNIVERSE · IMAGE CREDITS</h1>
  <p class="lead">${prov.assets.length} images of ${byObject.size} objects are shown in the deep-space view. Each is a real archive image; its credit line is reproduced exactly as published, with the licence and the archive's own identifier. Images outside visible light, and composites, carry colours chosen by the image makers: they are not how the objects would look to the eye. Processing done here (resizing, cropping, tiling) is listed in the application's inspector. Provenance file generated ${esc(prov.manifest?.generated ?? '')}.</p>
  <section><h2>Catalogue and data acknowledgements</h2>
    <p class="credit">This research has made use of the NASA Exoplanet Archive, which is operated by the California Institute of Technology, under contract with the National Aeronautics and Space Administration under the Exoplanet Exploration Program. (Standard acknowledgement from exoplanetarchive.ipac.caltech.edu/docs/acknowledge.html, retrieved 2026-11-13; please also cite Christiansen et al. 2025, Planetary Science Journal, doi 10.3847/PSJ/ade3c2.)</p>
    <p class="credit">Stars: ESA Gaia DR3 (ESA/Gaia/DPAC); ESA Hipparcos new reduction (van Leeuwen 2007; VizieR I/311) and the Hipparcos main catalogue (VizieR I/239, stated licence CC-BY-NC-3.0 IGO: non-commercial terms apply). Names and identifiers: SIMBAD and VizieR (CDS, Strasbourg), IAU Working Group on Star Names. Galaxies: McConnachie 2012, Karachentsev et al. 2013, 2MASS Redshift Survey (Huchra et al. 2012). Solar System: NASA/JPL (Horizons, SSD), NAIF.</p>
  </section>
  <p class="lead"><a href="./">Back to the Atlas</a></p>
${sections}
</main>
</body>
</html>
`;
await writeFile(OUT, html);
console.log(`wrote ${OUT}: ${prov.assets.length} images, ${byObject.size} objects`);
