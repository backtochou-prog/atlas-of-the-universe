import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { DeepSpaceData, DeepSpaceValidationError, validateDeepSpaceFile, validateImageProvenance, validatePointCatalogue } from '../src/data/deepspace';
import type { DeepImageAsset, DeepSpaceFile, DeepSpaceObject, PointCatalogueFile } from '../src/data/deepspace/types';
import { IMAGE, lgFixture, LOCAL_GROUP, M31, M42, meas, membersFixture, PLEIADES, provenanceFixture, fixtureFile } from './fixtures/deepspace/fixtures';
import { METRES_PER_PARSEC } from '../src/core/units';
import { length } from '../src/core/spatial/vec3';

const codes = (r: { errors: readonly { code: string }[] }) => r.errors.map((e) => e.code);
const withObj = (o: Partial<DeepSpaceObject>, base: DeepSpaceObject = M31): DeepSpaceFile => fixtureFile({ objects: [{ ...base, ...o } as DeepSpaceObject, LOCAL_GROUP] });
type Mut<T> = { -readonly [K in keyof T]: Mut<T[K]> };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe('validateDeepSpaceFile', () => {
  it('accepts the fixture file with its images and catalogues', () => {
    const r = validateDeepSpaceFile(fixtureFile(), { images: provenanceFixture(), catalogues: { 'local-group-mcconnachie': lgFixture(), 'members-pleiades': membersFixture() } });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });
  it('schema string, duplicate ids, id format', () => {
    expect(codes(validateDeepSpaceFile({ ...fixtureFile(), manifest: { ...fixtureFile().manifest, schema: 'x' as never } }))).toContain('manifest.schema');
    expect(codes(validateDeepSpaceFile(fixtureFile({ objects: [M42, M42] })))).toContain('object.duplicate');
    expect(codes(validateDeepSpaceFile(withObj({ id: 'Bad_Id' })))).toContain('object.id');
  });
  it('kind must match its class field', () => {
    expect(codes(validateDeepSpaceFile(withObj({ galaxyClass: undefined })))).toContain('object.class-missing');
    expect(codes(validateDeepSpaceFile(withObj({ nebulaClass: 'emission' })))).toContain('object.class-extra');
    expect(codes(validateDeepSpaceFile(withObj({ kind: 'galaxy-group' })))).toContain('object.class-extra');
  });
  it('galaxyClass must agree with classifyGalaxy(morphologyLabel); unclassifiable labels are errors', () => {
    expect(codes(validateDeepSpaceFile(withObj({ galaxyClass: 'elliptical' })))).toContain('galaxy.class-mismatch');
    expect(codes(validateDeepSpaceFile(withObj({ morphologyLabel: 'zzz' })))).toContain('galaxy.unclassifiable');
    expect(codes(validateDeepSpaceFile(withObj({ morphologyLabel: undefined })))).toContain('galaxy.morphology-missing');
    expect(validateDeepSpaceFile(withObj({ morphologyLabel: 'E+0-1 pec', galaxyClass: 'peculiar' })).errors).toEqual([]);
  });
  it('sky: ra/dec ranges, distance unit and sign', () => {
    const sky = M31.sky!;
    expect(codes(validateDeepSpaceFile(withObj({ sky: { ...sky, raDeg: 360 } })))).toContain('sky.ra');
    expect(codes(validateDeepSpaceFile(withObj({ sky: { ...sky, decDeg: 91 } })))).toContain('sky.dec');
    expect(codes(validateDeepSpaceFile(withObj({ sky: { ...sky, distance: meas(1, 'km') } })))).toContain('distance.unit');
    expect(codes(validateDeepSpaceFile(withObj({ sky: { ...sky, distance: meas(-1, 'Mpc') } })))).toContain('distance.value');
    expect(codes(validateDeepSpaceFile(withObj({ sky: { ...sky, coordinateSource: undefined as never } })))).toContain('sky.source');
  });
  it('measurements: derived needs transformations, uncertainty >= 0, source required', () => {
    expect(codes(validateDeepSpaceFile(withObj({ measurements: { x: meas(1, 'm', { kind: 'derived' }) } })))).toContain('measurement.derived-needs-transformations');
    expect(codes(validateDeepSpaceFile(withObj({ measurements: { x: meas(1, 'm', { uncertainty: -1 }) } })))).toContain('measurement.uncertainty');
    expect(codes(validateDeepSpaceFile(withObj({ measurements: { x: { ...meas(1, 'm'), source: undefined as never } } })))).toContain('measurement.source');
    expect(codes(validateDeepSpaceFile(withObj({ measurements: { x: meas(NaN, 'm') } })))).toContain('measurement.value');
  });
  it('orientation ranges; deprojected image requires orientation', () => {
    expect(codes(validateDeepSpaceFile(withObj({ orientation: { ...M31.orientation!, inclinationDeg: meas(120, 'deg') } })))).toContain('orientation.inclination');
    expect(codes(validateDeepSpaceFile(withObj({ orientation: undefined })))).toContain('representation.needs-orientation');
  });
  it('angular size must be positive and minor <= major', () => {
    expect(codes(validateDeepSpaceFile(withObj({ angularSize: { ...M31.angularSize!, majorArcmin: 0 } })))).toContain('size.major');
    expect(codes(validateDeepSpaceFile(withObj({ angularSize: { ...M31.angularSize!, minorArcmin: 500 } })))).toContain('size.minor');
  });
  it('representation summary is mandatory', () => {
    expect(codes(validateDeepSpaceFile(withObj({ representation: { ...M31.representation, summary: ' ' } })))).toContain('representation.summary');
  });
  it('every imageAssetId resolves (when images are supplied) and belongs to the object', () => {
    expect(codes(validateDeepSpaceFile(withObj({ imageAssetIds: ['nope'] }), { images: provenanceFixture() }))).toContain('images.unresolved');
    expect(codes(validateDeepSpaceFile(withObj({ imageAssetIds: ['m31-fixture-visible'], id: 'm33' }), { images: provenanceFixture() }))).toContain('images.wrong-object');
    expect(codes(validateDeepSpaceFile(withObj({ imageAssetIds: ['a', 'a'] })))).toContain('images.duplicate');
  });
  it('parentId must exist; pointsFileId and membership names must exist in the supplied catalogue', () => {
    expect(codes(validateDeepSpaceFile(withObj({ parentId: 'ghost' })))).toContain('parent.unresolved');
    expect(codes(validateDeepSpaceFile(fixtureFile({ objects: [PLEIADES] }), { catalogues: ['other'] }))).toContain('points.unresolved');
    expect(validateDeepSpaceFile(fixtureFile({ objects: [PLEIADES] }), { catalogues: ['members-pleiades'] }).errors).toEqual([]);
    const lg = { ...LOCAL_GROUP, membership: { ...LOCAL_GROUP.membership!, names: ['Andromeda', 'Nonexistent'] } };
    expect(codes(validateDeepSpaceFile(fixtureFile({ objects: [lg] }), { catalogues: { 'local-group-mcconnachie': lgFixture() } }))).toContain('membership.unresolved');
    expect(codes(validateDeepSpaceFile(fixtureFile({ objects: [lg] }), { catalogues: { other: lgFixture() } }))).toContain('points.unresolved');
    expect(codes(validateDeepSpaceFile(fixtureFile({ objects: [{ ...lg, membership: { ...lg.membership!, names: [] } }] })))).toContain('membership.names');
  });
  it('observed-members needs a points file or membership; models need limitations and cited parameters', () => {
    expect(codes(validateDeepSpaceFile(fixtureFile({ objects: [{ ...PLEIADES, pointsFileId: undefined }] })))).toContain('representation.needs-points');
    expect(codes(validateDeepSpaceFile(fixtureFile({ models: { mw: { id: 'mw', title: 't', parameters: [{ name: 'a', value: 1, unit: 'kpc', reference: '' }], limitations: [] } } })))).toEqual(expect.arrayContaining(['model.limitations', 'model.parameter']));
  });
});

describe('validateImageProvenance', () => {
  const bad = (mut: (a: Mut<DeepImageAsset>) => void) => { const a = clone(IMAGE) as Mut<DeepImageAsset>; mut(a); return codes(validateImageProvenance(provenanceFixture([a as DeepImageAsset]))); };
  it('accepts a good asset', () => { expect(validateImageProvenance(provenanceFixture()).errors).toEqual([]); });
  it('licence: evidence non-empty, redistribution true, https url, name', () => {
    expect(bad((a) => { a.licence.evidence = '  '; })).toContain('licence.evidence');
    expect(bad((a) => { a.licence.redistributionAllowed = false; })).toContain('licence.redistribution');
    expect(bad((a) => { a.licence.url = 'http://x.org/'; })).toContain('url.https');
    expect(bad((a) => { a.licence.name = ''; })).toContain('licence.name');
  });
  it('band, falseColour and composite must be present and well formed', () => {
    expect(bad((a) => { (a.band as { kind: string }).kind = 'sepia'; })).toContain('band.kind');
    expect(bad((a) => { delete (a.band as unknown as Record<string, unknown>)['falseColour']; })).toContain('band.falseColour');
    expect(bad((a) => { delete (a.band as unknown as Record<string, unknown>)['composite']; })).toContain('band.composite');
    expect(bad((a) => { (a as { band?: unknown }).band = undefined; })).toContain('band.kind');
  });
  it('levels: level 0 <= 256 px, strictly increasing in size', () => {
    expect(bad((a) => { a.levels[0]!.widthPx = 300; })).toContain('levels.first-size');
    expect(bad((a) => { a.levels[1]!.widthPx = 256; a.levels[1]!.heightPx = 100; })).toContain('levels.increasing');
    expect(bad((a) => { a.levels = []; })).toContain('levels.empty');
    expect(bad((a) => { a.levels[2]!.level = 1; })).toContain('levels.index');
  });
  it('geometry numeric, fov > 0', () => {
    expect(bad((a) => { a.geometry.fovArcmin = [0, 10]; })).toContain('geometry.fov');
    expect(bad((a) => { a.geometry.centreRaDeg = NaN; })).toContain('geometry.ra');
    expect(bad((a) => { a.geometry.centreDecDeg = 120; })).toContain('geometry.dec');
    expect(bad((a) => { (a.geometry as unknown as Record<string, unknown>)['upPositionAngleDeg'] = '0'; })).toContain('geometry.pa');
    expect(bad((a) => { (a as { geometry?: unknown }).geometry = undefined; })).toContain('geometry.missing');
  });
  it('sha256 is 64 lowercase hex; source URLs are https; credit and ids required', () => {
    expect(bad((a) => { a.source.sha256 = 'abc'; })).toContain('source.sha256');
    expect(bad((a) => { a.source.sha256 = 'A'.repeat(64); })).toContain('source.sha256');
    expect(bad((a) => { a.source.downloadUrl = 'ftp://x/y'; })).toContain('url.https');
    expect(bad((a) => { a.source.landingUrl = 'not a url'; })).toContain('url.https');
    expect(bad((a) => { a.credit = ''; })).toContain('image.credit');
    expect(bad((a) => { a.source.imageId = ''; })).toContain('source.ids');
  });
  it('duplicate asset ids and a wrong schema string', () => {
    expect(codes(validateImageProvenance(provenanceFixture([IMAGE, IMAGE])))).toContain('image.duplicate');
    expect(codes(validateImageProvenance({ ...provenanceFixture(), manifest: { schema: 'x' as never, generated: 'x' } }))).toContain('manifest.schema');
  });
});

describe('validatePointCatalogue', () => {
  it('accepts members and Local Group fixtures (nulls where allowed)', () => {
    expect(validatePointCatalogue(membersFixture()).errors).toEqual([]);
    expect(validatePointCatalogue(lgFixture()).errors).toEqual([]);
  });
  it('column lengths must be equal and match manifest.count', () => {
    expect(codes(validatePointCatalogue(membersFixture({ gMag: [1] })))).toContain('columns.length');
    const f = membersFixture(); (f.manifest as { count: number }).count = 9;
    expect(codes(validatePointCatalogue(f))).toContain('columns.count');
  });
  it('required columns per id', () => {
    const f = membersFixture(); const { sourceId: _s, ...rest } = f.columns; void _s;
    expect(validatePointCatalogue({ ...f, columns: rest }).errors.map((e) => e.path)).toContain('columns.sourceId');
    const lg = lgFixture(); const { distMethod: _d, ...r2 } = lg.columns; void _d;
    expect(validatePointCatalogue({ ...lg, columns: r2 }).errors.map((e) => e.path)).toContain('columns.distMethod');
    const { vMag: _v, ...r3 } = lg.columns; void _v;
    expect(codes(validatePointCatalogue({ ...lg, columns: r3 }))).toContain('columns.required');
    const tm: PointCatalogueFile = { manifest: { ...lg.manifest, id: 'twomrs' }, columns: { name: ['a'], raDeg: [1], decDeg: [2], czKms: [100], czErrKms: [null], ksMag: [10], morphology: [null] } };
    expect(validatePointCatalogue({ ...tm, manifest: { ...tm.manifest, count: 1 } }).errors).toEqual([]);
    expect(validatePointCatalogue({ manifest: { ...tm.manifest, count: 1 }, columns: { name: ['a'], raDeg: [1], decDeg: [2] } }).errors.map((e) => e.path)).toEqual(expect.arrayContaining(['columns.czKms', 'columns.ksMag']));
  });
  it('ra in [0,360), dec in [-90,90], no NaN, no nulls in mandatory columns, numbers stay numbers', () => {
    expect(codes(validatePointCatalogue(membersFixture({ raDeg: [10, 360] })))).toContain('value.ra');
    expect(codes(validatePointCatalogue(membersFixture({ decDeg: [-91, 0] })))).toContain('value.dec');
    expect(codes(validatePointCatalogue(membersFixture({ gMag: [NaN, 1] })))).toContain('value.type');
    expect(codes(validatePointCatalogue(membersFixture({ pmraMasYr: [1, null] })))).toContain('value.null');
    expect(codes(validatePointCatalogue(membersFixture({ name: ['a', null] })))).toContain('value.null');
    expect(codes(validatePointCatalogue(membersFixture({ gMag: ['5', 6] as never })))).toContain('value.type');
    expect(codes(validatePointCatalogue(membersFixture({ extra: [1, Infinity] })))).toContain('value.nan');
  });
});

describe('DeepSpaceData', () => {
  const mk = () => DeepSpaceData.fromFile(fixtureFile(), provenanceFixture(), { catalogues: { 'local-group-mcconnachie': lgFixture(), 'members-pleiades': membersFixture() } });
  it('refuses invalid data with a typed error', () => {
    expect(() => DeepSpaceData.fromFile(fixtureFile({ objects: [M42, M42] }))).toThrow(DeepSpaceValidationError);
    expect(DeepSpaceData.fromFile(fixtureFile({ objects: [M42, M42] }), [], { validate: false }).all()).toHaveLength(2);
  });
  it('get / all / byKind / children / imageAssetsOf', () => {
    const d = mk();
    expect(d.all().map((o) => o.id)).toEqual(['m31', 'local-group', 'orion-nebula', 'pleiades']);
    expect(d.get('m31')?.name).toMatch(/Andromeda/);
    expect(d.get('zzz')).toBeUndefined();
    expect(d.byKind('nebula').map((o) => o.id)).toEqual(['orion-nebula']);
    expect(d.children('local-group').map((o) => o.id)).toEqual(['m31']);
    expect(d.imageAssetsOf('m31').map((a) => a.id)).toEqual(['m31-fixture-visible']);
    expect(d.imageAssetsOf('orion-nebula')).toEqual([]);
  });
  it('positionPc is derived from sky + distance, cached, and absent without a distance', () => {
    const d = mk();
    const p = d.positionPc('m31')!;
    expect(length(p)).toBeCloseTo(770_000, 4);
    expect(d.positionPc('m31')).toBe(p); // cached: same array
    expect(length(d.positionPc('orion-nebula')!)).toBeCloseTo(1344, 6);
    expect(d.positionPc('local-group')).toBeUndefined();
    expect(d.positionPc('ghost')).toBeUndefined();
  });
  it('toCelestialObject builds the inspector model with provenance, derived size and a representation text', () => {
    const d = mk();
    const o = d.toCelestialObject('m31');
    expect(o.classification).toBe('galaxy');
    expect(o.frame).toBe('stellar-neighbourhood');
    expect(o.parent).toBe('local-group');
    expect(o.sky?.distance?.value).toBe(0.77);
    expect(o.measurements?.['distance']?.unit).toBe('Mpc');
    expect(o.measurements?.['inclination']?.value).toBe(77);
    expect(o.measurements?.['angular_size']?.unit).toBe('arcmin');
    const size = o.measurements!['physical_size']!;
    expect(size.kind).toBe('derived');
    expect(size.transformations!.join(' ')).toMatch(/2 d tan/);
    // 190 arcmin at 770 kpc: 2 * 770 kpc * tan(1.58333 deg) = 42.57 kpc
    expect(size.value / 1000).toBeCloseTo(2 * 770 * Math.tan((190 / 60 / 2) * Math.PI / 180), 6);
    expect(size.uncertainty! / 1000).toBeCloseTo(2 * Math.tan((190 / 60 / 2) * Math.PI / 180) * 40, 6);
    expect(o.imagery?.fidelity).toBe('derived');
    expect(o.imagery?.credit).toBe('Fixture credit');
    expect(o.imagery?.license).toBe('CC BY 4.0');
    expect(o.representation).toMatch(/Fixture representation/);
    expect(o.representation).toMatch(/Depth: published-orientation-model/);
    expect(o.confidence).toBe('catalogued');
    const n = d.toCelestialObject('orion-nebula');
    expect(n.classification).toBe('nebula');
    expect(n.representation).toMatch(/Exaggerations: none/);
    expect(n.imagery?.credit).toBeUndefined();
    const g = d.toCelestialObject('local-group');
    expect(g.classification).toBe('galaxy-group');
    expect(g.sky).toBeUndefined();
    expect(() => d.toCelestialObject('ghost')).toThrow();
  });
  it('does not invent a size uncertainty when the distance has none', () => {
    const d = DeepSpaceData.fromFile(fixtureFile({ objects: [{ ...M31, sky: { ...M31.sky!, distance: meas(0.77, 'Mpc') }, imageAssetIds: [], parentId: undefined }] }));
    const s = d.toCelestialObject('m31').measurements!['physical_size']!;
    expect(s.uncertainty).toBeUndefined();
    expect(s.transformations!.join(' ')).toMatch(/no published uncertainty/);
  });
  it('a size without a distance is listed as unavailable with a reason', () => {
    const d = DeepSpaceData.fromFile(fixtureFile({ objects: [{ ...M31, sky: { ...M31.sky!, distance: undefined }, imageAssetIds: [], parentId: undefined }] }));
    expect(d.toCelestialObject('m31').unavailable?.['physical_size']).toMatch(/distance/);
  });
  it('METRES_PER_PARSEC sanity for the derived size units', () => { expect(METRES_PER_PARSEC).toBeGreaterThan(3e16); });
});

// ---- conformance of the real data, when other agents have delivered it ------------------------------------------------

const objectsPath = 'public/data/deep-space.v1.json';
const provPath = 'public/deepspace/provenance.json';
const haveReal = existsSync(objectsPath) && existsSync(provPath);
const SKIP_REASON = 'SKIPPED: public/data/deep-space.v1.json and/or public/deepspace/provenance.json not delivered yet';
if (!haveReal) console.warn(`[deepspace-data] ${SKIP_REASON}`);
(haveReal ? describe : describe.skip)(haveReal ? 'delivered deep-space data conforms' : SKIP_REASON, () => {
  it('objects file, provenance file and every available point catalogue validate and cross-check', () => {
    const file = JSON.parse(readFileSync(objectsPath, 'utf8')) as DeepSpaceFile;
    const prov = JSON.parse(readFileSync(provPath, 'utf8'));
    const cats: Record<string, PointCatalogueFile> = {};
    for (const id of ['ungc', 'local-group-mcconnachie', 'twomrs', 'members-pleiades', 'members-hyades', 'members-omega-centauri', 'members-m13', 'members-47-tucanae', 'members-m4']) {
      const p = `public/data/deepspace/${id}.v1.json.gz`;
      if (existsSync(p)) {
        cats[id] = JSON.parse(gunzipSync(readFileSync(p)).toString()) as PointCatalogueFile;
        expect(validatePointCatalogue(cats[id]!).errors, id).toEqual([]);
      }
    }
    expect(validateImageProvenance(prov).errors).toEqual([]);
    // Only cross-check catalogues that were delivered; undelivered ones would be reported as unresolved by design.
    const r = validateDeepSpaceFile(file, { images: prov, catalogues: cats });
    const unresolvedOnly = r.errors.filter((e) => !(e.code === 'points.unresolved' && Object.keys(cats).length < 9));
    expect(unresolvedOnly).toEqual([]);
  });
});
