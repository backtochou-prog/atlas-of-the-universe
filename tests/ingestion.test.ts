import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCsv, parseCsvObjects } from '../src/data/ingestion/csv';
import { assertCsvResponse, tapAsync, tapSync, TapError } from '../src/data/ingestion/tap';
import { buildGaiaQuery, describeSelection, parseGaiaCsv, DEFAULT_GAIA_SELECTION } from '../src/data/ingestion/gaia';
import { normalizeGaia } from '../src/data/ingestion/normalize';
import { buildGaiaDataset } from '../src/data/ingestion/build';
import { buildQualityReport } from '../src/data/ingestion/quality';
import { GAIA_NUMERIC_COLUMNS, GAIA_QUERY_COLUMNS } from '../src/data/catalogue/columns';
import { FileCache, sha256 } from '../src/data/ingestion/cache';

const gaiaCsv = readFileSync('tests/fixtures/gaia-sample.csv', 'utf8');
const retrieval = { retrievedAt: '2026-11-12T12:00:00.000Z', endpoint: 'test', adql: 'q', rawSha256: 'x', rawBytes: gaiaCsv.length, rawRows: 10 };

describe('CSV parser', () => {
  it('handles quotes, escaped quotes, commas inside quotes and CRLF', () => {
    expect(parseCsv('a,b\r\n"x,y","he said ""hi"""\r\n')).toEqual([['a', 'b'], ['x,y', 'he said "hi"']]);
  });
  it('keeps empty cells as empty strings (the Gaia "no value" case)', () => {
    expect(parseCsv('a,b,c\n1,,3\n')).toEqual([['a', 'b', 'c'], ['1', '', '3']]);
  });
  it('rejects ragged rows and unterminated quotes instead of guessing', () => {
    expect(() => parseCsvObjects('a,b\n1\n')).toThrow(/expected 2/);
    expect(() => parseCsv('a\n"oops')).toThrow(/quoted/);
  });
});

describe('TAP client (injected fetch, no network)', () => {
  const ok = (body: string, extra: Partial<Response> = {}) => ({ ok: true, status: 200, text: async () => body, redirected: false, url: '', ...extra }) as unknown as Response;
  it('returns CSV from a sync query and sends the ADQL as a form field', async () => {
    let sent = '';
    const text = await tapSync({ endpoint: 'https://x/tap', fetch: (async (_u: string, init: RequestInit) => { sent = String(init.body); return ok('a\n1\n'); }) as unknown as typeof fetch }, 'SELECT 1');
    expect(text).toBe('a\n1\n');
    const form = new URLSearchParams(sent);
    expect(form.get('LANG')).toBe('ADQL');
    expect(form.get('QUERY')).toBe('SELECT 1');
  });
  it('turns HTTP errors and markup-instead-of-CSV into TapError', () => {
    expect(() => assertCsvResponse(500, false, '<VOTABLE><INFO name="QUERY_STATUS">bad adql</INFO></VOTABLE>')).toThrow(TapError);
    expect(() => assertCsvResponse(200, true, '<html>Page unavailable</html>')).toThrow(/markup instead of CSV/);
    expect(() => assertCsvResponse(200, true, 'a,b\n')).not.toThrow();
  });
  it('runs the async UWS flow: submit, poll phases, download', async () => {
    const phases = ['QUEUED', 'EXECUTING', 'COMPLETED'];
    const calls: string[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/async')) return ok('', { redirected: true, url: 'https://x/tap/async/job1' });
      if (url.endsWith('/phase')) return ok(phases.shift()!);
      if (url.endsWith('/results/result')) return ok('id\n7\n');
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;
    const out = await tapAsync({ endpoint: 'https://x/tap', fetch: f, sleep: async () => {}, pollIntervalMs: 0 }, 'SELECT 1');
    expect(out).toBe('id\n7\n');
    expect(calls.filter((c) => c.endsWith('/phase')).length).toBe(3);
  });
  it('surfaces a failed async job with the server message', async () => {
    const f = (async (url: string) => {
      if (url.endsWith('/async')) return ok('', { redirected: true, url: 'https://x/tap/async/j' });
      if (url.endsWith('/phase')) return ok('ERROR');
      return ok('<INFO name="QUERY_STATUS">syntax error near FROM</INFO>');
    }) as unknown as typeof fetch;
    await expect(tapAsync({ endpoint: 'https://x/tap', fetch: f, sleep: async () => {} }, 'bad')).rejects.toThrow(/syntax error/);
  });
});

describe('Gaia query builder', () => {
  const q = buildGaiaQuery();
  it('uses the documented selection, joins and deterministic ordering', () => {
    expect(q).toContain('gaiadr3.gaia_source');
    expect(q).toContain('g.phot_g_mean_mag < 6.5');
    expect(q).toContain('g.parallax >= 25 AND g.parallax_over_error >= 5');
    expect(q).toContain('hipparcos2_best_neighbour');
    expect(q).toContain('astrophysical_parameters');
    expect(q).toMatch(/ORDER BY g\.source_id$/);
    for (const c of GAIA_QUERY_COLUMNS) expect(q).toContain(c);
  });
  it('rejects non-finite selection parameters (no string interpolation of garbage)', () => {
    expect(() => buildGaiaQuery({ ...DEFAULT_GAIA_SELECTION, brightGMagLimit: NaN })).toThrow();
  });
  it('describes the selection in words for the provenance report', () => {
    expect(describeSelection().join(' ')).toMatch(/phot_g_mean_mag < 6\.5/);
    expect(describeSelection().join(' ')).toMatch(/40 pc/);
  });
});

describe('Gaia CSV parsing', () => {
  const rows = parseGaiaCsv(gaiaCsv);
  it('parses every fixture row', () => { expect(rows).toHaveLength(10); });
  it('keeps empty cells as null, never as 0', () => {
    const alnair = rows.find((r) => r.sourceId === '6560604777055249536')!;
    expect(alnair.values.parallax).toBeNull();
    expect(alnair.values.pmra).toBeNull();
    expect(alnair.values.phot_g_mean_mag).not.toBeNull();
  });
  it('preserves the original numeric precision of the archive value', () => {
    const alpha = rows.find((r) => r.sourceId === '4993479684438433792')!;
    expect(alpha.values.parallax).toBe(39.91825815729799);
    expect(alpha.values.ra).toBe(6.57215550145885);
  });
  it('keeps the 64-bit source_id as a string (it exceeds 2^53)', () => {
    expect(rows[2]!.sourceId).toBe('4472832130942575872');
    expect(Number.isSafeInteger(Number(rows[2]!.sourceId))).toBe(false);
  });
  it('throws a clear error if expected columns are missing', () => {
    expect(() => parseGaiaCsv('source_id,ra\n1,2\n')).toThrow(/missing expected columns/);
  });
  it('flags non-numeric text in a numeric column instead of coercing it', () => {
    const bad = gaiaCsv.replace('39.91825815729799', 'N/A');
    const r = parseGaiaCsv(bad).find((x) => x.sourceId === '4993479684438433792')!;
    expect(r.values.parallax).toBeNull();
    expect(r.parseIssues.join()).toMatch(/non-numeric parallax/);
  });
});

describe('normalisation and validation', () => {
  const raw = parseGaiaCsv(gaiaCsv);
  it('imports every real fixture row, including those with no G magnitude or no parallax', () => {
    const { records, rejected } = normalizeGaia(raw);
    expect(rejected).toEqual([]);
    expect(records).toHaveLength(10);
  });
  const mutate = (id: string, patch: (r: ReturnType<typeof parseGaiaCsv>[number]) => ReturnType<typeof parseGaiaCsv>[number]) =>
    raw.map((r) => (r.sourceId === id ? patch(r) : r));
  const withValues = (r: (typeof raw)[number], v: Partial<Record<(typeof GAIA_NUMERIC_COLUMNS)[number], number | null>>) => ({ ...r, values: { ...r.values, ...v } });
  const reasonsFor = (rows: typeof raw, id: string) => normalizeGaia(rows).rejected.find((x) => x.sourceId === id)?.reasons ?? [];

  it('rejects invalid coordinates (RA of 360 and Dec beyond 90 are not valid)', () => {
    expect(reasonsFor(mutate('4472832130942575872', (r) => withValues(r, { ra: 360 })), '4472832130942575872')).toContain('invalid-coordinates');
    expect(reasonsFor(mutate('4472832130942575872', (r) => withValues(r, { dec: 91 })), '4472832130942575872')).toContain('invalid-coordinates');
    expect(reasonsFor(mutate('4472832130942575872', (r) => withValues(r, { ra: null })), '4472832130942575872')).toContain('invalid-coordinates');
  });
  it('rejects an implausible G magnitude but KEEPS a missing one', () => {
    expect(reasonsFor(mutate('4472832130942575872', (r) => withValues(r, { phot_g_mean_mag: 99 })), '4472832130942575872')).toContain('invalid-g-magnitude');
    expect(normalizeGaia(raw).records.some((r) => r.sourceId === '268449582148460928' && r.values.phot_g_mean_mag === null)).toBe(true);
  });
  it('rejects negative uncertainties', () => {
    expect(reasonsFor(mutate('4472832130942575872', (r) => withValues(r, { parallax_error: -0.1 })), '4472832130942575872')).toContain('negative-parallax_error');
  });
  it('rejects a second record with the same source_id, keeping the first', () => {
    const dup = [...raw, raw[2]!];
    const { records, rejected } = normalizeGaia(dup);
    expect(records.filter((r) => r.sourceId === raw[2]!.sourceId)).toHaveLength(1);
    expect(rejected[0]!.reasons).toContain('duplicate-source-id');
  });
  it('rejects malformed identifiers and an unexpected reference epoch', () => {
    expect(reasonsFor(raw.map((r, i) => (i === 0 ? { ...r, sourceId: 'abc' } : r)), 'abc')).toContain('invalid-source-id');
    expect(reasonsFor(raw.map((r, i) => (i === 0 ? { ...r, refEpoch: 2015.5 } : r)), raw[0]!.sourceId).join()).toMatch(/unexpected-reference-epoch/);
  });
  it('never drops a rejected record silently: values are kept for audit', () => {
    const r = normalizeGaia(mutate('4472832130942575872', (x) => withValues(x, { ra: 400 }))).rejected[0]!;
    expect(r.values.dec).not.toBeNull();
  });
});

describe('dataset build and provenance', () => {
  const a = buildGaiaDataset({ rawCsv: gaiaCsv, retrieval, builtAt: '2026-11-12T12:00:00Z' });
  const b = buildGaiaDataset({ rawCsv: gaiaCsv, retrieval, builtAt: '2030-01-01T00:00:00Z' });
  it('records the catalogue, release, epoch, frame, exact ADQL and raw checksum', () => {
    const m = a.file.manifest;
    expect(m.catalogue).toMatchObject({ name: 'Gaia DR3', release: 'DR3', referenceFrame: 'ICRS', referenceEpoch: 2016 });
    expect(m.retrieval.retrievedAt).toBe('2026-11-12T12:00:00.000Z');
    expect(m.attribution.join(' ')).toMatch(/European Space Agency/);
    expect(m.selection.length).toBeGreaterThan(2);
  });
  it('is reproducible: the same raw download gives the same content hash, whatever the build time', () => {
    expect(a.file.manifest.contentSha256).toBe(b.file.manifest.contentSha256);
    expect(a.file.manifest.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it('changes the content hash when a single value changes', () => {
    const c = buildGaiaDataset({ rawCsv: gaiaCsv.replace('39.91825815729799', '39.91825815729798'), retrieval, builtAt: 'x' });
    expect(c.file.manifest.contentSha256).not.toBe(a.file.manifest.contentSha256);
  });
  it('stores null for missing values and preserves a genuine zero as 0', () => {
    expect(a.file.columns.parallax[a.file.sourceId.indexOf('6560604777055249536')]).toBeNull();
    const zero = buildGaiaDataset({ rawCsv: gaiaCsv.replace('-398.87213472266046', '0'), retrieval, builtAt: 'x' });
    expect(zero.file.columns.pmdec[zero.file.sourceId.indexOf('4993479684438433792')]).toBe(0);
  });
  it('keeps catalogue units per column and survives a JSON round trip unchanged', () => {
    expect(a.file.manifest.units).toMatchObject({ parallax: 'mas', pmra: 'mas/yr', ra: 'deg', phot_g_mean_mag: 'mag', teff_gspphot: 'K' });
    expect(JSON.parse(JSON.stringify(a.file)).columns.parallax).toEqual(a.file.columns.parallax);
  });
});

describe('quality report', () => {
  const built = buildGaiaDataset({ rawCsv: gaiaCsv, retrieval, builtAt: 'x' });
  const q = built.quality;
  it('accounts for every record: distance classes sum to the imported count', () => {
    const d = q.distance;
    expect(d.reliable + d.marginal + d.unreliable + d.invalid + d.missing).toBe(q.counts.imported);
    expect(q.counts.queryRows).toBe(q.counts.imported + q.counts.rejected);
  });
  it('counts the real edge cases in the fixture', () => {
    // Two fixture sources have no parallax, and both are 2-parameter solutions (Alnair and one other):
    // a position-only fit never yields a parallax.
    expect(q.distance.missing).toBe(2);
    expect(q.flags['two-parameter-solution']).toBe(2);
    expect(q.flags['no-g-magnitude']).toBe(2);
    expect(q.flags['no-parallax']).toBe(2);
    expect(q.flags['high-ruwe']).toBeGreaterThanOrEqual(1);
    expect(q.flags['duplicated-source']).toBe(1);
    expect(q.flags['parallax-marginal']).toBe(1);
    expect(q.missingValues.parallax).toBe(2);
  });
  it('drawable stars need both a distance and a G magnitude', () => {
    expect(q.distance.drawable).toBeLessThanOrEqual(q.distance.placedIn3d);
    expect(q.distance.placedIn3d - q.distance.drawable).toBe(2); // the two null-G sources have parallaxes
  });
  it('lists rejections and cross-id issues in full', () => {
    const r = buildQualityReport({ datasetId: 'x', generatedAt: 'x', queryRows: 1, records: [], rejected: [{ sourceId: '1', reasons: ['invalid-coordinates'], values: built.records[0]!.values }], hipConflicts: [], positionalDuplicates: [], maxPlacementDistancePc: 1e4 });
    expect(r.counts.rejectedByReason).toEqual({ 'invalid-coordinates': 1 });
    expect(r.rejected).toHaveLength(1);
  });
});

describe('cache (build-time)', () => {
  it('computes stable keys and checksums', () => {
    expect(FileCache.key('e', 'q')).toBe(FileCache.key('e', 'q'));
    expect(FileCache.key('e', 'q')).not.toBe(FileCache.key('e', 'q2'));
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('review fixes: robustness of parsing and TAP error handling', () => {
  const resp = (text: string, ok = true, status = 200, extra: Partial<Response> = {}) => ({ ok, status, text: async () => text, redirected: false, url: '', ...extra }) as unknown as Response;
  it('strips a UTF-8 byte-order mark instead of corrupting the first header name', () => {
    expect(parseCsvObjects('﻿a,b\n1,2\n').header).toEqual(['a', 'b']);
  });
  it('rejects stray characters after a closing quote instead of accepting them', () => {
    expect(() => parseCsv('a\n"x"junk\n')).toThrow(/after a closing quote/);
    expect(parseCsv('a,b\n"x","y"\n')).toEqual([['a', 'b'], ['x', 'y']]);
  });
  it('reports an HTML error page by its title only, never its CSS', () => {
    const html = '<!doctype html><html><head><title>Page unavailable — CDS</title><style>:root { color-scheme: light; }</style></head><body>x</body></html>';
    expect(() => assertCsvResponse(404, false, html)).toThrow(/Page unavailable/);
    try { assertCsvResponse(404, false, html); } catch (e) { expect(String((e as Error).message)).not.toMatch(/color-scheme/); }
  });
  it('fails an async job whose phase request is an HTTP error', async () => {
    const f = (async (url: string) => (url.endsWith('/async') ? resp('', true, 200, { redirected: true, url: 'https://x/tap/async/j' } as never) : resp('server error', false, 503))) as unknown as typeof fetch;
    await expect(tapAsync({ endpoint: 'https://x/tap', fetch: f, sleep: async () => {} }, 'q')).rejects.toThrow(/phase request failed with HTTP 503/);
  });
  it('fails on an unrecognised job phase instead of polling forever', async () => {
    const f = (async (url: string) => (url.endsWith('/async') ? resp('', true, 200, { redirected: true, url: 'https://x/tap/async/j' } as never) : resp('ARCHIVED'))) as unknown as typeof fetch;
    await expect(tapAsync({ endpoint: 'https://x/tap', fetch: f, sleep: async () => {} }, 'q')).rejects.toThrow(/unexpected phase "ARCHIVED"/);
  });
});
