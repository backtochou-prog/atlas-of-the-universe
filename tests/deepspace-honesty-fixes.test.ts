import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { DeepSpaceData } from '../src/data/deepspace';
import type { DeepImageAsset, DeepImageProvenanceFile, DeepSpaceFile, PointCatalogueFile } from '../src/data/deepspace/types';
import { imageProvenanceBlock, inspectDeepObject, inspectPointRow, nonVisibleContent } from '../src/data/catalogue/inspect';
import { validateDeepSpaceFile } from '../src/data/deepspace/validate';
import type { PointRowInfo } from '../src/render/deep-space/types';

const have = existsSync('public/data/deep-space.v1.json') && existsSync('public/deepspace/provenance.json');
const d = describe.skipIf(!have);
const text = (m: ReturnType<typeof inspectDeepObject>) => JSON.stringify(m);

d('honesty fixes in the shipped data', () => {
  const file = JSON.parse(readFileSync('public/data/deep-space.v1.json', 'utf8')) as DeepSpaceFile;
  const prov = JSON.parse(readFileSync('public/deepspace/provenance.json', 'utf8')) as DeepImageProvenanceFile;
  const data = DeepSpaceData.fromFile(file, prov, { validate: false });
  const obj = (id: string) => file.objects.find((o) => o.id === id)!;

  it('the shipped file still validates', () => {
    expect(validateDeepSpaceFile(file).errors).toEqual([]);
  });

  it('globular clusters: depth is labelled illustrative and the text states the hash-seeded Plummer draw, not "cluster-mean measured"', () => {
    for (const id of ['omega-centauri', 'm13', '47-tucanae', 'm4']) {
      const r = obj(id).representation;
      expect(r.depth, id).toBe('illustrative');
      expect(r.summary).toMatch(/NOT measured/);
      expect(r.summary).toMatch(/hash/i);
      expect(r.summary).toMatch(/Plummer/);
      expect((r.exaggerations ?? []).join(' ')).toMatch(/NOT measured/);
      const inspected = text(inspectDeepObject(data, id));
      expect(inspected).not.toMatch(/measured-cluster-mean|one measured mean distance for the whole set|CLUSTER-MEAN distance;/);
      expect(inspected).toMatch(/illustrative/i);
    }
  });

  it('globular members file caveats no longer say that positions must use the cluster mean only', () => {
    for (const id of ['members-m13', 'members-omega-centauri']) {
      const f = JSON.parse(gunzipSync(readFileSync(`public/data/deepspace/${id}.v1.json.gz`)).toString('utf8')) as PointCatalogueFile;
      const c = f.manifest.caveats.join(' ');
      expect(c).toMatch(/ILLUSTRATIVE/);
      expect(c).not.toMatch(/must therefore use the single cluster-mean distance/);
    }
  });

  it('member-row inspector says the depth is illustrative for a globular row, and "own parallax" for an open-cluster row', () => {
    const load = (id: string): PointCatalogueFile => JSON.parse(gunzipSync(readFileSync(`public/data/deepspace/${id}.v1.json.gz`)).toString('utf8')) as PointCatalogueFile;
    const row = (f: PointCatalogueFile, i: number): PointRowInfo => ({ id: `${f.manifest.id}:${i}`, fileId: f.manifest.id, row: i, manifest: f.manifest, values: Object.fromEntries(Object.keys(f.columns).map((k) => [k, f.columns[k]![i] ?? null])) });
    const g = inspectPointRow(row(load('members-m13'), 3));
    expect(g.representation!.depth).toMatch(/not measured/);
    expect(g.representation!.exaggerations.join(' ')).toMatch(/illustrative/i);
    const o = inspectPointRow(row(load('members-pleiades'), 3));
    expect(o.representation!.depth).toBe('measured for each object');
  });

  it('Orion-region distances: modelled, median of all sightlines within 1 deg, uncertainty >= the spread, per-sightline values listed', () => {
    for (const id of ['orion-nebula', 'horsehead-nebula', 'ngc-1999']) {
      const m = obj(id).sky!.distance!;
      expect(m.kind, id).toBe('modelled');
      expect(m.note).toMatch(/NOT a distance to the nebula itself/);
      const tr = (m.transformations ?? []).join(' | ');
      expect(tr).toMatch(/all \d+ catalogued sightlines within 1 deg/);
      expect(tr).toMatch(/per-sightline d50/);
      expect(tr).toMatch(/sqrt\(spread/);
    }
    const o = obj('orion-nebula').sky!.distance!;
    const tr = (o.transformations ?? []).join(' ');
    expect(tr).toMatch(/394-445 pc/);                       // the four sightlines, 394..445 pc
    expect(o.value).toBeGreaterThan(400); expect(o.value).toBeLessThan(440);
    expect(o.uncertainty!).toBeGreaterThanOrEqual(25.5);    // not the single-sightline 22.5
    // derived size follows the new distance
    const size = obj('orion-nebula').measurements['physicalDiameter']!;
    expect(size.transformations!.join(' ')).toContain(`d = ${o.value} pc`);
    // the Gaia cross-check is a small-sample fact, worded as such, and only for M42
    const facts = (obj('orion-nebula').facts ?? []).map((f) => f.text).join(' ');
    expect(facts).toMatch(/small sample/); expect(facts).toMatch(/3 stars/); expect(facts).toMatch(/400 pc/); expect(facts).toMatch(/NOT a complete or unbiased sample/);
    expect((obj('horsehead-nebula').facts ?? []).map((f) => f.text).join(' ')).not.toMatch(/small sample/);
    // a lone sightline says that the spread cannot be estimated
    expect((obj('ngc-1999').sky!.distance!.transformations ?? []).join(' ')).toMatch(/only ONE sightline/);
  });

  it('Virgo membership uses the symmetric-ish window -500..2500 km/s and includes the blueshifted members M86, M90 and M98', () => {
    const v = obj('virgo-cluster');
    const tw = JSON.parse(gunzipSync(readFileSync('public/data/deepspace/twomrs.v1.json.gz')).toString('utf8')) as PointCatalogueFile;
    const names = tw.columns['name'] as string[]; const cz = tw.columns['czKms'] as number[];
    const members = new Set(v.membership!.names);
    for (const n of ['12261181+1256454', '12364981+1309463', '12134829+1454016']) {
      const i = names.indexOf(n); expect(i, n).toBeGreaterThanOrEqual(0);
      expect(cz[i]!).toBeLessThan(0); expect(members.has(n), n).toBe(true);
    }
    const czOf = new Map(names.map((n, i) => [n, cz[i]!]));
    for (const n of v.membership!.names) { const z = czOf.get(n)!; expect(z).toBeGreaterThanOrEqual(-500); expect(z).toBeLessThanOrEqual(2500); }
    expect(v.membership!.basis).toMatch(/-500 and 2500/);
    expect(v.membership!.basis).toMatch(/foreground and background/);
    expect(v.measurements['memberCount']!.value).toBe(v.membership!.names.length);
  });

  it('Milky Way morphology is shown as a literature range adopted by the Atlas, not as a catalogue string', () => {
    const o = obj('milky-way');
    expect(o.morphologyLabel).toBe('SBb - SBbc');
    expect(o.morphologyNote).toMatch(/Not a catalogue string/);
    expect(o.galaxyClass).toBe('barred-spiral');
    const m = inspectDeepObject(data, 'milky-way');
    const f = m.sections.flatMap((s) => s.fields).find((x) => x.key === 'morphology')!;
    expect(f.label).toMatch(/literature range/);
    expect(f.detail).toMatch(/Not a catalogue string/);
    expect(f.detail).not.toMatch(/As given by the catalogue/);
    expect(m.classification).toMatch(/literature morphology range SBb - SBbc \(not a catalogue string\)/);
    // other galaxies keep the catalogue wording
    expect(inspectDeepObject(data, 'm31').sections.flatMap((s) => s.fields).find((x) => x.key === 'morphology')!.label).toBe('Morphology (catalogue string)');
  });

  it('nebula data describe what is drawn: the real image on the sky plane plus illustrative depth layers; nothing says "flat image only"', () => {
    const nebulae = file.objects.filter((o) => o.kind === 'nebula');
    expect(nebulae.length).toBeGreaterThanOrEqual(8);
    for (const o of nebulae) {
      expect(o.representation.depth, o.id).toBe('illustrative-layers');
      expect(o.representation.summary).toMatch(/real telescope image/);
      expect(o.representation.summary).toMatch(/layers drawn on sheets at different distances/);
      expect(o.representation.summary).not.toMatch(/flat image facing the Sun/);
      expect((o.representation.exaggerations ?? []).join(' ')).toMatch(/ASSUMED total thickness of \d+%/);
      const t = text(inspectDeepObject(data, o.id));
      expect(t).not.toMatch(/the image is flat, facing the Sun/);
    }
    expect((obj('horsehead-nebula').representation.exaggerations ?? []).join(' ')).toMatch(/darkest \(absorbing\) band is placed nearest the Sun/);
  });

  it('cluster physical diameters carry no distance-only error bar; the two globular "half" radii are labelled as different definitions', () => {
    for (const id of ['pleiades', 'hyades', 'omega-centauri', 'm13', '47-tucanae', 'm4']) {
      const m = obj(id).measurements['physicalDiameter'];
      if (!m) continue;
      expect(m.uncertainty, id).toBeUndefined();
      expect(m.transformations!.join(' ')).toMatch(/no uncertainty is given/);
    }
    // a galaxy still carries its distance-propagated error, flagged as distance-only
    const g = obj('m31').measurements['physicalDiameterD25'];
    if (g?.uncertainty !== undefined) expect(g.transformations!.join(' ')).toMatch(/distance only/);
    expect(obj('omega-centauri').angularSize!.definition).toMatch(/half-mass/);
    expect(obj('omega-centauri').angularSize!.definition).toMatch(/not expected to agree/);
  });

  it('every asset in provenance.json: a non-visible-light content warning appears exactly when a band or filter is outside 380-750 nm', () => {
    const assets = prov.assets as readonly DeepImageAsset[];
    expect(assets.length).toBeGreaterThan(30);
    let flagged = 0;
    for (const a of assets) {
      const nv = nonVisibleContent(a);
      const block = imageProvenanceBlock(a);
      if (a.band.kind !== 'visible' && a.band.kind !== 'multi-band-composite') {
        expect(nv.any && nv.all, a.id).toBe(true);
        expect(block.notAnEyeView, a.id).toMatch(/not visible light/);
      }
      if (nv.any) { flagged++; expect(block.notAnEyeView, a.id).toMatch(/not visible light|Part of this image is not visible light/); }
      else if (!a.band.falseColour) expect(block.notAnEyeView, a.id).toBeUndefined();
    }
    expect(flagged).toBeGreaterThan(15);
    const by = (id: string) => nonVisibleContent(assets.find((a) => a.id === id)!);
    // the cases of the review: infrared-only and X-ray / submm composites, and a near-infrared channel in a "visible" composite
    expect(by('crab-nebula-webb-nircam-miri')).toMatchObject({ any: true, all: true });
    expect(imageProvenanceBlock(assets.find((a) => a.id === 'crab-nebula-webb-nircam-miri')!).notAnEyeView).toMatch(/contains no visible light/);
    expect(imageProvenanceBlock(assets.find((a) => a.id === 'crab-nebula-webb-nircam-miri')!).bandLabel).toMatch(/infrared only/);
    const cena = by('cen-a-eso-multiband');
    expect(cena.any).toBe(true); expect(cena.all).toBe(false); expect(cena.regions).toEqual(expect.arrayContaining(['X-ray', 'submillimetre/radio']));
    expect(imageProvenanceBlock(assets.find((a) => a.id === 'cen-a-eso-multiband')!).notAnEyeView).toMatch(/includes [^)]*X-ray/);
    expect(by('m31-phat-visible').regions).toContain('near-infrared');
    expect(by('m104-hubble-acs-mosaic').regions).toContain('near-infrared');
    expect(by('m81-hubble-acs').regions).toContain('near-infrared');
    expect(by('orion-nebula-hubble-mosaic').regions).toContain('near-infrared');
    expect(by('m87-legacysurvey-grz').regions).toContain('near-infrared');
    // purely optical images are not flagged
    for (const id of ['eagle-nebula-eso-wfi-wide', 'horsehead-nebula-vlt-visible', 'm33-vst-visible', 'crab-nebula-hubble-wfpc2', 'veil-nebula-hubble-wfpc2-a']) expect(by(id).any, id).toBe(false);
  });

  it('Virgo member rows: the inspector says they are drawn at the cluster-mean distance, not at their redshift distance', () => {
    const tw = JSON.parse(gunzipSync(readFileSync('public/data/deepspace/twomrs.v1.json.gz')).toString('utf8')) as PointCatalogueFile;
    const mk = (id: string, placement?: 'cluster-mean'): PointRowInfo => ({ id, fileId: 'twomrs', row: 5, manifest: tw.manifest, values: Object.fromEntries(Object.keys(tw.columns).map((k) => [k, tw.columns[k]![5] ?? null])), ...(placement ? { placement } : {}) });
    const virgo = JSON.stringify(inspectPointRow(mk('virgo:5', 'cluster-mean')));
    const cloud = JSON.stringify(inspectPointRow(mk('twomrs:5')));
    expect(virgo).toMatch(/cluster-mean distance, not this galaxy/);
    expect(cloud).toMatch(/Hubble-flow estimate from cz/);
  });
});
