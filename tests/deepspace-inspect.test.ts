import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { DeepSpaceData } from '../src/data/deepspace';
import type { DeepImageProvenanceFile, DeepSpaceFile, PointCatalogueFile, WavelengthBand } from '../src/data/deepspace/types';
import { describeTType, inspectDeepObject, inspectPointRow, type InspectorModel } from '../src/data/catalogue/inspect';
import { WAVELENGTH_INFO, describeBand, isNonVisibleBand, wavelengthInfo } from '../src/data/deepspace/wavelengths';
import { fixtureFile, provenanceFixture } from './fixtures/deepspace/fixtures';

const have = existsSync('public/data/deep-space.v1.json') && existsSync('public/deepspace/provenance.json');
const d = describe.skipIf(!have);

const allFields = (m: InspectorModel) => m.sections.flatMap((s) => s.fields);
const expectNoBlanks = (m: InspectorModel) => {
  for (const f of allFields(m)) {
    expect(f.value, `${f.key} value`).not.toBe('');
    expect(f.label, `${f.key} label`).not.toBe('');
    if (f.available) { expect(f.value, `${f.key}`).not.toMatch(/^(NaN|undefined|null)$/); expect(f.value).not.toBe('Unavailable'); }
    else expect((f.reason ?? '').length, `${f.key} reason`).toBeGreaterThan(5);
  }
};

describe('wavelength explanations', () => {
  const kinds: WavelengthBand[] = ['visible', 'near-infrared', 'mid-infrared', 'far-infrared', 'ultraviolet', 'x-ray', 'radio', 'gamma-ray', 'multi-band-composite'];
  it('has a complete entry for every band kind', () => {
    for (const k of kinds) { const w = wavelengthInfo(k); expect(w.label.length).toBeGreaterThan(2); expect(w.reveals.length).toBeGreaterThan(20); expect(w.range.length).toBeGreaterThan(5); expect(w.colour.length).toBeGreaterThan(20); }
    expect(Object.keys(WAVELENGTH_INFO).sort()).toEqual([...kinds].sort());
  });
  it('says that colours are assigned for every non-visible band, and never claims an eye view', () => {
    for (const k of kinds.filter((b) => b !== 'visible' && b !== 'multi-band-composite')) { expect(describeBand(k)).toMatch(/assigned/); expect(isNonVisibleBand(k)).toBe(true); }
    expect(isNonVisibleBand('visible')).toBe(false);
    expect(describeBand('ultraviolet')).toMatch(/hot, young/i);
    expect(describeBand('near-infrared')).toMatch(/dust/i);
    expect(describeBand('x-ray')).toMatch(/hot gas/i);
    expect(describeBand('radio')).toMatch(/synchrotron/i);
  });
  d('covers every band kind used in public/deepspace/provenance.json', () => {
    it('every asset band has an explanation', () => {
      const prov = JSON.parse(readFileSync('public/deepspace/provenance.json', 'utf8')) as DeepImageProvenanceFile;
      for (const a of prov.assets) expect(WAVELENGTH_INFO[a.band.kind], a.id).toBeDefined();
    });
  });
});

describe('T-type lookup', () => {
  it('explains the RC3 convention', () => {
    expect(describeTType('T=3')).toMatch(/Sb.*RC3/);
    expect(describeTType('T=8')).toMatch(/Sdm/);
    expect(describeTType(10)).toMatch(/Im/);
    expect(describeTType('T=-5')).toMatch(/elliptical/);
    expect(describeTType('Ir')).toBeUndefined();
    expect(describeTType('T=99')).toBeUndefined();
    expect(describeTType(null)).toBeUndefined();
  });
});

describe('inspectDeepObject (fixtures)', () => {
  const data = DeepSpaceData.fromFile(fixtureFile(), provenanceFixture(), { validate: false });
  it('builds a galaxy model with representation, provenance and credit', () => {
    const m = inspectDeepObject(data, 'm31');
    expect(m.representation!.badge).toBe('DEPROJECTED IMAGE');
    expect(m.imageProvenance!.credit).toBe('Fixture credit');
    expect(m.imageProvenance!.licenceName).toBe('CC BY 4.0');
    expectNoBlanks(m);
  });
  it('a group with no images says why', () => {
    const m = inspectDeepObject(data, 'local-group');
    expect(m.imageProvenance).toBeUndefined();
    expect(m.noImageNote).toMatch(/No picture/);
    expectNoBlanks(m);
  });
});

d('inspectDeepObject (shipped data)', () => {
  const file = JSON.parse(readFileSync('public/data/deep-space.v1.json', 'utf8')) as DeepSpaceFile;
  const prov = JSON.parse(readFileSync('public/deepspace/provenance.json', 'utf8')) as DeepImageProvenanceFile;
  const data = DeepSpaceData.fromFile(file, prov, { validate: false });
  const labelsOf = (m: InspectorModel) => Object.fromEntries(allFields(m).map((f) => [f.key, f]));

  it('every object builds a model with no blank values, a badge and unavailable reasons', () => {
    for (const o of data.all()) {
      const m = inspectDeepObject(data, o.id);
      expectNoBlanks(m);
      expect(m.representation!.badge.length).toBeGreaterThan(3);
      expect(m.representation!.summary).toBe(o.representation.summary);
      expect(m.sections.length).toBeGreaterThan(2);
    }
  });

  it('M31 (galaxy): classes, string, distance with uncertainty and method, derived physical size, orientation, redshift, credit', () => {
    const m = inspectDeepObject(data, 'm31');
    const f = labelsOf(m);
    expect(f['class']!.value).toBe('Spiral');
    expect(f['class']!.kind).toBe('derived');
    expect(f['morphology']!.value).toBe('SA(s)b');
    expect(f['distance']!.uncertainty).toMatch(/±/);
    expect(f['distance']!.kind).toBe('observed');
    expect(f['distance']!.detail).toMatch(/Cepheid/);
    expect(f['physical_size']!.kind).toBe('derived');
    expect(f['physical_size']!.transformations!.join(' ')).toMatch(/2 d tan/);
    expect(f['ra']!.kind).toBe('observed');
    expect(f['gal_l']!.kind).toBe('derived');
    expect(Number(f['gal_l']!.value)).toBeGreaterThan(120); expect(Number(f['gal_l']!.value)).toBeLessThan(122);
    expect(f['inclination']!.kind).toBe('modelled');
    expect(f['near_side']).toBeDefined();
    expect(f['redshift']!.kind).toBe('derived');
    expect(Number(f['redshift']!.value)).toBeLessThan(0);
    expect(m.representation!.badge).toBe('DEPROJECTED IMAGE');
    expect(m.representation!.exaggerations.length).toBeGreaterThan(0);
    const ip = m.imageProvenance!;
    expect(ip.credit.length).toBeGreaterThan(5);
    expect(ip.licenceName.length).toBeGreaterThan(2);
    expect(ip.imageId.length).toBeGreaterThan(1);
    expect(ip.landingUrl).toMatch(/^https?:/);
    expect(ip.fovArcmin[0]).toBeGreaterThan(0);
    expect(m.bands!.length).toBeGreaterThan(1);
  });

  it('M87 (no orientation): the missing orientation has a reason, distance flags no published error', () => {
    const m = inspectDeepObject(data, 'm87');
    const f = labelsOf(m);
    expect(f['orientation']!.available).toBe(false);
    expect(f['orientation']!.reason).toMatch(/flat|orientation/i);
    expect(m.representation!.badge).toBe('OBSERVED IMAGE');
    expect(m.imageProvenance).toBeDefined();
  });

  it('band switching: provenance follows the requested asset and non-visible bands are not presented as an eye view', () => {
    const m = inspectDeepObject(data, 'm31', { activeAssetId: 'm31-galex-fuv' });
    expect(m.imageProvenance!.assetId).toBe('m31-galex-fuv');
    expect(m.imageProvenance!.bandLabel).toBe('Ultraviolet');
    expect(m.imageProvenance!.notAnEyeView).toMatch(/Not how it would look to the eye/);
    expect(m.imageProvenance!.bandReveals).toMatch(/hot, young/i);
    expect(m.bands!.map((b) => b.assetId)).toContain('m31-phat-visible');
  });

  it('M31: the default (GALEX NUV) says it is an ultraviolet map and that the visible-light PHAT picture is a strip; PHAT says it is a partial field', () => {
    const uv = inspectDeepObject(data, 'm31', { activeAssetId: 'm31-galex-nuv' }).imageProvenance!;
    expect(uv.coverageNote).toMatch(/ultraviolet map, not a visible-light picture/);
    expect(uv.coverageNote).toMatch(/strip/);
    expect(uv.coverageNote).toMatch(/58\.0 .* 18\.5 arcmin/);
    const phat = inspectDeepObject(data, 'm31', { activeAssetId: 'm31-phat-visible' }).imageProvenance!;
    expect(phat.coverageNote).toMatch(/partial field/);
    expect(phat.fovArcmin[0]).toBeCloseTo(57.98, 2);
    expect(inspectDeepObject(data, 'm87').imageProvenance!.coverageNote ?? '').not.toMatch(/strip/);
  });

  it('Orion (nebula): classification, distance, physical size, emission reasons, wavelengths', () => {
    const m = inspectDeepObject(data, 'orion-nebula');
    const f = labelsOf(m);
    expect(m.classification).toMatch(/Emission nebula/);
    expect(f['distance']!.available).toBe(true);
    expect(f['physical_size']!.kind).toBe('derived');
    expect(f['magV']).toBeDefined(); expect(f['magV']!.available).toBe(false); expect(f['magV']!.reason).toMatch(/extended/);
    expect(m.sections.map((s) => s.title)).toContain('Emission');
    expect(m.sections.map((s) => s.title)).toContain('Observational wavelengths');
    expect(m.bands!.length).toBeGreaterThan(1);
  });

  it('Carina (no angular size): unavailable fields explain themselves', () => {
    const m = inspectDeepObject(data, 'carina-nebula');
    const f = labelsOf(m);
    expect(f['angular_size']!.available).toBe(false);
    expect(f['angular_size']!.reason!.length).toBeGreaterThan(10);
    expect(f['physical_size']!.available).toBe(false);
  });

  it('Pleiades (cluster): members, age (modelled/derived), size, membership provenance', () => {
    const m = inspectDeepObject(data, 'pleiades');
    const f = labelsOf(m);
    expect(m.representation!.badge).toBe('OBSERVED MEMBERS');
    expect(f['memberCount']!.value).toBe('1721');
    expect(f['logAge']!.kind).toBe('modelled');
    expect(f['age']!.kind).toBe('derived');
    expect(f['members_basis']!.detail).toMatch(/members-pleiades/);
    expect(f['mass']!.available).toBe(false);
    expect(m.imageProvenance).toBeUndefined();
    expect(m.noImageNote).toMatch(/catalogued members/);
  });

  it('Local Group (group): member count and the stated basis; no single position', () => {
    const m = inspectDeepObject(data, 'local-group');
    const f = labelsOf(m);
    expect(f['sky']!.available).toBe(false);
    expect(f['member_names']!.detail).toMatch(/McConnachie/);
    expect(f['distance']!.available).toBe(false);
  });

  it('Milky Way (documented model): model badge, parameters labelled modelled, magnitude unavailable with reason', () => {
    const m = inspectDeepObject(data, 'milky-way');
    const f = labelsOf(m);
    expect(m.representation!.badge).toBe('DOCUMENTED MODEL');
    expect(f['stellarMass']!.kind).toBe('modelled');
    expect(f['sunGalacticCentreDistance']!.kind).toBe('observed');
    expect(f['magV']!.available).toBe(false);
    expect(m.sections.map((s) => s.title)).toContain('Model parameters (documented)');
    expectNoBlanks(m);
  });

  it('every shipped image asset is credited verbatim in the model', () => {
    for (const o of data.all()) {
      for (const a of data.imageAssetsOf(o.id)) {
        const m = inspectDeepObject(data, o.id, { activeAssetId: a.id });
        expect(m.imageProvenance!.credit).toBe(a.credit);
        expect(m.imageProvenance!.licenceName).toBe(a.licence.name);
      }
    }
  });
});

d('inspectPointRow (shipped catalogues)', () => {
  const load = (id: string): PointCatalogueFile => JSON.parse(gunzipSync(readFileSync(`public/data/deepspace/${id}.v1.json.gz`)).toString('utf8')) as PointCatalogueFile;
  const rowOf = (fileId: string, row: number) => {
    const c = load(fileId);
    const values: Record<string, number | string | null> = {};
    for (const [k, col] of Object.entries(c.columns)) values[k] = col[row] ?? null;
    return { id: `${fileId}:${row}`, fileId, row, values, manifest: c.manifest };
  };
  it('UNGC row: T-type explained, distance method, no published error flagged, caveats listed', () => {
    const c = load('ungc');
    const row = c.columns['morphology']!.findIndex((v) => v === 'T=8');
    const m = inspectPointRow(rowOf('ungc', row));
    const f = Object.fromEntries(allFields(m).map((x) => [x.key, x]));
    expect(f['morphology']!.detail).toMatch(/Sdm.*RC3/);
    expect(f['distMpc']!.kind).toBe('observed');
    expect(f['distMpc']!.detail).toMatch(/Method/);
    expect(m.representation!.badge).toBe('OBSERVED MEMBERS');
    expect(m.sections.map((s) => s.title)).toContain('About this catalogue');
    expectNoBlanks(m);
  });
  it('UNGC row with unpublished error: says so', () => {
    const c = load('ungc');
    const row = c.columns['distErrMpc']!.findIndex((v) => v === null);
    const f = Object.fromEntries(allFields(inspectPointRow(rowOf('ungc', row))).map((x) => [x.key, x]));
    expect(f['distMpc']!.uncertainty).toBe('no published error');
    expect(f['distErrMpc']!.available).toBe(false);
    expect(f['distErrMpc']!.reason).toMatch(/no published error/);
  });
  it('2MRS row: Hubble-flow distance is labelled derived with the peculiar-velocity caveat', () => {
    const m = inspectPointRow(rowOf('twomrs', 0));
    const f = Object.fromEntries(allFields(m).map((x) => [x.key, x]));
    expect(f['distance_basis']!.kind).toBe('derived');
    expect(f['distance_basis']!.detail).toMatch(/peculiar/);
    expect(f['czKms']!.kind).toBe('observed');
    expectNoBlanks(m);
  });
  it('McConnachie row and cluster member row build with no blanks', () => {
    expectNoBlanks(inspectPointRow(rowOf('local-group-mcconnachie', 3)));
    const m = inspectPointRow(rowOf('members-pleiades', 5));
    const f = Object.fromEntries(allFields(m).map((x) => [x.key, x]));
    expect(f['plx_distance']!.kind).toBe('derived');
    expect(m.classification).toMatch(/cluster member/);
    expectNoBlanks(m);
  });
});
