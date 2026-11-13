/**
 * Build-time import of the Solar System dataset from JPL and NAIF sources, with model validation against JPL Horizons.
 *   npx tsx tools/solar-import.ts            fetch (cached) and build
 *   npx tsx tools/solar-import.ts --offline  rebuild only from data/cache/solar (exact reproduction)
 *   npx tsx tools/solar-import.ts --refresh  ignore cached downloads
 * No credentials are used. Raw downloads are cached in data/cache/solar (git-ignored).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { FileCache } from '../src/data/ingestion/cache';
import { buildSolarDataset, ephemerisBodies, type SolarInputs } from '../src/data/solar/ingestion/build';
import { elementsRangeUrl, elementsTlistUrl, objDataUrl, parseElements, parseVectors, vectorsTlistUrl } from '../src/data/solar/ingestion/horizons';
import { BODY_SPECS, MOON_CENTRES } from '../src/data/solar/bodies';
import type { ValidationRow } from '../src/data/solar/types';
import { SolarSystemEphemeris } from '../src/core/orbits/ephemeris';
import { jdTdbFromIso } from '../src/core/orbits/time';
import { sub, length } from '../src/core/spatial/vec3';
import { renderSolarValidationMarkdown } from '../src/data/solar/ingestion/report';
import { fitMeanLongitudeRate, sampleSpacingDays, type MeanLongitudeFit } from '../src/data/solar/ingestion/fit';
import { parseSatMeanElements } from '../src/data/solar/ingestion/satMean';

const OFFLINE = process.argv.includes('--offline');
const REFRESH = process.argv.includes('--refresh');
const CACHE = new FileCache('data/cache/solar');
const UA = 'AtlasOfTheUniverse-ingest/0.1 (open-source astronomy visualisation; build-time import)';
const log = (m: string) => console.log(`[solar] ${m}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const REFERENCE_ISO = '2026-11-12T00:00:00Z';

async function get(url: string, expect: RegExp): Promise<string> {
  const key = FileCache.key('solar', url);
  if (!REFRESH) { const hit = await CACHE.get(key); if (hit) return hit.text; }
  if (OFFLINE) throw new Error(`--offline: no cache entry for ${url}`);
  await sleep(250);
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(90_000) });
  const text = await res.text();
  if (!res.ok || !expect.test(text)) throw new Error(`Unexpected response (${res.status}) for ${url}: ${text.slice(0, 200)}`);
  await CACHE.put(key, text, { endpoint: 'solar', query: url, retrievedAt: new Date().toISOString(), rows: 0 });
  return text;
}

async function status(url: string): Promise<number> {
  const key = FileCache.key('solar-head', url);
  const hit = await CACHE.get(key);
  if (hit && !REFRESH) return Number(hit.text);
  if (OFFLINE) return 0;
  try {
    await sleep(150);
    const r = await fetch(url, { method: 'GET', headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
    await CACHE.put(key, String(r.status), { endpoint: 'solar-head', query: url, retrievedAt: new Date().toISOString(), rows: 0 });
    return r.status;
  } catch { return -1; }
}

async function sunSpectralType(): Promise<{ value: string; source: string; url: string } | undefined> {
  // SIMBAD does not catalogue the Sun (a query by main_id returns no row), so the spectral type comes from NASA.
  const url = 'https://science.nasa.gov/sun/facts/';
  const text = await get(url, /Star type/);
  const m = /Star type\s*:\s*(G\s?\d\s?V)/i.exec(text.replace(/<[^>]+>/g, ' '));
  return m ? { value: m[1]!.replace(/\s+/g, ''), source: 'NASA Science, Our Sun: Facts', url } : undefined;
}

function matchByJd<T extends { jdTdb: number }>(rows: readonly T[], jd: number): T {
  const hit = rows.find((r) => Math.abs(r.jdTdb - jd) < 1e-4);
  if (!hit) throw new Error(`Horizons returned no row for JD ${jd}`);
  return hit;
}

async function main() {
  const retrieved = new Date().toISOString().slice(0, 10);
  const referenceJd = jdTdbFromIso(REFERENCE_ISO);
  log(`reference epoch ${REFERENCE_ISO} = JD ${referenceJd.toFixed(6)} (TDB)`);

  const approxHtml = await get('https://ssd.jpl.nasa.gov/planets/approx_pos.html', /Table 1/);
  const satElemHtml = await get('https://ssd.jpl.nasa.gov/sats/elem/', /Mean Elements/);
  const pckText = await get('https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc', /BODY399_POLE_RA/);

  const objData: Record<number, string> = {};
  for (const b of BODY_SPECS) objData[b.naifId] = await get(objDataUrl(String(b.naifId)), /Revised:/);
  log(`fetched physical data for ${BODY_SPECS.length} bodies`);

  const moonElements: SolarInputs['moonElements'] = Object.fromEntries(await Promise.all([]));
  const moons: Record<string, ReturnType<typeof parseElements>[number]> = {};
  for (const b of BODY_SPECS.filter((x) => x.kind === 'moon')) {
    const text = await get(elementsTlistUrl(String(b.naifId), MOON_CENTRES[b.id]!, referenceJd), /\$\$SOE/);
    moons[b.id] = parseElements(text)[0]!;
  }
  log(`fetched osculating elements for ${Object.keys(moons).length} satellites`);
  void moonElements;

  // Fit each satellite's mean-longitude rate to Horizons osculating elements sampled around the epoch.
  const meanRows = parseSatMeanElements(satElemHtml);
  const fits: Record<string, MeanLongitudeFit> = {};
  for (const b of BODY_SPECS.filter((x) => x.kind === 'moon')) {
    const guessPeriod = meanRows.find((r) => r.naifId === b.naifId)?.periodDays ?? moons[b.id]!.periodSeconds / 86400;
    const dt = sampleSpacingDays(guessPeriod);
    const N = 121;
    const half = ((N - 1) / 2) * dt;
    const text = await get(elementsRangeUrl(String(b.naifId), MOON_CENTRES[b.id]!, referenceJd - half, referenceJd + half, dt * 1440), /\$\$SOE/);
    fits[b.id] = fitMeanLongitudeRate(parseElements(text), 360 / guessPeriod);
  }
  log(`fitted mean-longitude rates: ${Object.entries(fits).map(([k, v]) => `${k} ${v.periodDays.toFixed(6)} d (rms ${v.rmsDeg.toFixed(2)} deg)`).slice(0, 4).join('; ')} ...`);

  const sun = await sunSpectralType();
  const inputs: SolarInputs = { retrieved, referenceJdTdb: referenceJd, referenceIso: REFERENCE_ISO, approxHtml, pckText, satElemHtml, objData, moonElements: moons, moonFits: fits, ...(sun ? { sunSpectralType: sun } : {}) };

  // 1) Build without validation so the ephemeris exists; 2) validate against Horizons; 3) rebuild with the table.
  const draft = buildSolarDataset(inputs, [], {}, new Date().toISOString());
  const eph = new SolarSystemEphemeris(ephemerisBodies(draft));
  const validation: ValidationRow[] = [];

  const planetDates: [string, number][] = [['1850-01-01', 2396758.5], ['1900-01-01', 2415020.5], ['1950-01-01', 2433282.5], ['2000-01-01', 2451544.5], ['reference epoch (2026-11-12)', referenceJd], ['2040-01-01', 2466154.5], ['2050-01-01', 2469807.5]];
  for (const b of BODY_SPECS.filter((x) => x.kind === 'planet')) {
    const text = await get(vectorsTlistUrl(String(b.naifId), '@sun', planetDates.map((d) => d[1])), /\$\$SOE/);
    const vec = parseVectors(text);
    // Horizons returns TLIST rows sorted by time, not in request order: match every row by its Julian date.
    for (const [label, jd] of planetDates) {
      const v = matchByJd(vec, jd);
      const truth = [v.position[0] * 1000, v.position[1] * 1000, v.position[2] * 1000] as const;
      const model = eph.heliocentricPosition(b.id, jd);
      const err = length(sub(model, truth));
      const dist = length(truth);
      validation.push({ body: b.id, label, jdTdb: jd, errorKm: err / 1000, errorArcsec: (err / dist) * 206264.806, relativeError: err / dist });
    }
  }
  const offsets: [string, number][] = [['epoch', 0], ['+1 d', 1], ['+7 d', 7], ['+30 d', 30], ['+90 d', 90], ['+1 yr', 365.25], ['+5 yr', 1826.25], ['-1 yr', -365.25]];
  for (const b of BODY_SPECS.filter((x) => x.kind === 'moon')) {
    const jds = offsets.map((o) => referenceJd + o[1]);
    const text = await get(vectorsTlistUrl(String(b.naifId), MOON_CENTRES[b.id]!, jds), /\$\$SOE/);
    const vecs = parseVectors(text);
    offsets.forEach(([label], i) => {
      const v = matchByJd(vecs, jds[i]!);
      const truth = [v.position[0] * 1000, v.position[1] * 1000, v.position[2] * 1000] as const;
      const model = eph.relativePosition(b.id, jds[i]!);
      const err = length(sub(model, truth));
      const dist = length(truth);
      validation.push({ body: b.id, label, jdTdb: jds[i]!, errorKm: err / 1000, errorArcsec: (err / dist) * 206264.806, relativeError: err / dist });
    });
  }
  log(`validated against Horizons: ${validation.length} comparisons`);

  const urls = [...new Set(BODY_SPECS.flatMap((b) => b.facts.map((f) => f.url).filter((u): u is string => !!u)))];
  const checks: Record<string, number> = {};
  for (const u of urls) checks[u] = await status(u);
  const bad = Object.entries(checks).filter(([, s]) => s !== 200);
  log(`reference URLs: ${urls.length - bad.length}/${urls.length} returned HTTP 200${bad.length ? `; not 200: ${bad.map(([u, s]) => `${s} ${u}`).join(', ')}` : ''}`);

  const file = buildSolarDataset(inputs, validation, checks, new Date().toISOString());
  await mkdir('public/data', { recursive: true });
  await writeFile('public/data/solar-system.v1.json', JSON.stringify(file));
  await writeFile('docs/SOLAR_SYSTEM_VALIDATION.md', renderSolarValidationMarkdown(file));
  log(`wrote public/data/solar-system.v1.json (${file.bodies.length} bodies) and docs/SOLAR_SYSTEM_VALIDATION.md`);
}

await main();
