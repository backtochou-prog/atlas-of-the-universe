// Plain-Node validation of public/data/bright-stars.v1.json.gz and public/data/other-objects.v1.json.
//   node tools/discovery/validate_stars_other.mjs
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log('FAIL', m); } };
const info = (m) => console.log(m);

const f = JSON.parse(gunzipSync(readFileSync(join(ROOT, 'public/data/bright-stars.v1.json.gz'))).toString('utf8'));
const c = f.columns, n = f.manifest.count;
const REQUIRED = ['hip', 'raDeg', 'decDeg', 'parallaxMas', 'parallaxErrMas', 'pmraMasYr', 'pmdecMasYr', 'vMag', 'bvColour', 'spectralType', 'variability', 'iauName', 'designations', 'gaiaSourceId'];
for (const k of REQUIRED) ok(k in c, `missing column ${k}`);
for (const [k, v] of Object.entries(c)) {
  ok(v.length === n, `column ${k} length ${v.length} != count ${n}`);
  for (let i = 0; i < v.length; i++) if (typeof v[i] === 'number' && !Number.isFinite(v[i])) { ok(false, `${k}[${i}] not finite`); break; }
}
const range = (k, lo, hi) => { for (let i = 0; i < n; i++) { const x = c[k][i]; if (x !== null && (x < lo || x > hi)) { ok(false, `${k}[${i}]=${x} outside [${lo},${hi}] (HIP ${c.hip[i]})`); return; } } };
range('raDeg', 0, 360); range('decDeg', -90, 90); range('vMag', -2, 13); range('parallaxMas', -100, 1000); range('parallaxErrMas', 0, 100); range('bvColour', -0.5, 5);
ok(new Set(c.hip).size === n, 'HIP numbers not unique');
ok(new Set(c.gaiaSourceId.filter(Boolean)).size === c.gaiaSourceId.filter(Boolean).length, 'a Gaia source linked twice');
for (let i = 0; i < n; i++) {
  ok(typeof c.designations[i] === 'string' && c.designations[i].split('|').includes(`HIP ${c.hip[i]}`), `designations missing HIP ${c.hip[i]}`);
  ok(c.parallaxQuality[i] === (c.parallaxMas[i] !== null && c.parallaxErrMas[i] > 0 && c.parallaxMas[i] / c.parallaxErrMas[i] >= 10 ? 'good' : 'poor'), `parallaxQuality inconsistent HIP ${c.hip[i]}`);
  ok((c.gaiaSourceId[i] === null) === (c.gaiaMatchBasis[i] === null), `gaiaMatchBasis/gaiaSourceId inconsistent HIP ${c.hip[i]}`);
}
const m = f.manifest;
for (const k of ['id', 'title', 'source', 'licence', 'query', 'count', 'caveats', 'units', 'astrometricEpoch', 'nameSource']) ok(k in m, `manifest.${k} missing`);
ok(m.source.retrieved && /^\d{4}-\d\d-\d\d$/.test(m.source.retrieved), 'manifest.source.retrieved');
info(`bright stars: ${n} rows, ${Object.keys(c).length} columns, ${c.gaiaSourceId.filter(Boolean).length} linked to Gaia, ${c.iauName.filter(Boolean).length} IAU-named, ${c.parallaxQuality.filter((q) => q === 'good').length} good parallaxes`);

const want = [['Sirius', 32349], ['Betelgeuse', 27989], ['Vega', 91262], ['Polaris', 11767], ['Rigel', 24436], ['Arcturus', 69673], ['Rigil Kentaurus (Alpha Cen A)', 71683], ['Toliman (Alpha Cen B)', 71681], ['Antares', 80763]];
for (const [label, hip] of want) {
  const i = c.hip.indexOf(hip);
  ok(i >= 0, `${label} (HIP ${hip}) missing`);
  if (i < 0) continue;
  info(`  ${label.padEnd(30)} HIP ${String(hip).padEnd(6)} V=${c.vMag[i]} plx=${c.parallaxMas[i]}+-${c.parallaxErrMas[i]} (${c.parallaxQuality[i]}) pm=(${c.pmraMasYr[i]},${c.pmdecMasYr[i]}) ${c.spectralType[i]} name=${c.iauName[i]} gaia=${c.gaiaSourceId[i]}`);
  ok(c.gaiaSourceId[i] === null, `${label} should not be in the Gaia subset`);
}
const at = (hip, k) => c[k][c.hip.indexOf(hip)];
ok(at(32349, 'parallaxMas') === 379.21 && at(32349, 'parallaxErrMas') === 1.58, 'Sirius parallax');
ok(at(91262, 'parallaxMas') === 130.23, 'Vega parallax');
ok(Math.abs(at(11767, 'parallaxMas') - 7.54) < 0.01, 'Polaris parallax');
ok(at(27989, 'parallaxQuality') === 'poor', 'Betelgeuse should be poor quality');
ok(at(32349, 'iauName') === 'Sirius', 'Sirius iauName');
ok(at(70890, 'gaiaSourceId') === '5853498713190525696', 'Proxima is a Gaia star');
ok(at(87937, 'gaiaSourceId') === '4472832130942575872', 'Barnard is a Gaia star');
ok(c.vMag.every((v, i) => v === null || v <= 6.5 || c.iauName[i] !== null), 'a star fainter than V=6.5 without IAU name');

const o = JSON.parse(readFileSync(join(ROOT, 'public/data/other-objects.v1.json'), 'utf8'));
ok(o.manifest.schema === 'atlas-other-objects/1', 'other-objects schema');
const sgr = o.objects.find((x) => x.id === 'other:sgr-a-star');
ok(!!sgr && sgr.distance.value === 8178 && sgr.distance.unit === 'pc', 'Sgr A* 8178 pc');
const consts = readFileSync(join(ROOT, 'src/core/astro/constants.ts'), 'utf8');
ok(/SUN_GALACTOCENTRIC_DISTANCE_PC = 8178/.test(consts), 'atlas constant is 8178');
for (const x of o.objects) {
  ok(Number.isFinite(x.raDeg) && Number.isFinite(x.decDeg) && x.raDeg >= 0 && x.raDeg < 360 && Math.abs(x.decDeg) <= 90, `${x.id} coords`);
  ok(x.facts.length > 0 && x.facts.every((t) => t.references.length >= 1 && t.references.every((r) => /^https?:/.test(r.url) && /^\d{4}-\d\d-\d\d$/.test(r.retrieved))), `${x.id} facts need references`);
  ok(x.distance && x.distance.source.url && x.coordinateSource.url, `${x.id} sources`);
  info(`  ${x.id}: ra=${x.raDeg.toFixed(5)} dec=${x.decDeg.toFixed(5)} d=${x.distance.value} ${x.distance.unit} +-${x.distance.uncertainty}, ${x.facts.length} facts`);
}
console.log(fail ? `${fail} FAILURES` : 'ALL CHECKS PASSED');
process.exit(fail ? 1 : 0);
