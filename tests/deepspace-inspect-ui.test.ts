import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DeepSpaceData } from '../src/data/deepspace';
import type { DeepImageProvenanceFile, DeepSpaceFile } from '../src/data/deepspace/types';
import { closestViewNote, normaliseName, scaleOfCamera, searchDeepObjects, STRUCTURE_NOTE } from '../src/ui/deepUi';
import { fixtureFile, provenanceFixture } from './fixtures/deepspace/fixtures';

describe('deep-space search', () => {
  const data = DeepSpaceData.fromFile(fixtureFile(), provenanceFixture(), { validate: false });
  it('normalises designations so M 31, m31 and M-31 agree', () => {
    expect(normaliseName('M 31')).toBe('m31');
    expect(normaliseName('NGC-224')).toBe('ngc224');
  });
  it('finds by designation, name and id; exact before substring; ignores one-letter queries', () => {
    expect(searchDeepObjects(data, 'M 31')[0]!.id).toBe('m31');
    expect(searchDeepObjects(data, 'andromeda')[0]!.id).toBe('m31');
    expect(searchDeepObjects(data, 'orion')[0]!.id).toBe('orion-nebula');
    expect(searchDeepObjects(data, 'm')).toEqual([]);
    expect(searchDeepObjects(data, 'zzzz')).toEqual([]);
  });
  it('finds the shipped objects', () => {
    if (!existsSync('public/data/deep-space.v1.json') || !existsSync('public/deepspace/provenance.json')) return;
    const real = DeepSpaceData.fromFile(JSON.parse(readFileSync('public/data/deep-space.v1.json', 'utf8')) as DeepSpaceFile, JSON.parse(readFileSync('public/deepspace/provenance.json', 'utf8')) as DeepImageProvenanceFile, { validate: false });
    expect(searchDeepObjects(real, 'M 87')[0]!.id).toBe('m87');
    expect(searchDeepObjects(real, 'pleiades')[0]!.id).toBe('pleiades');
    expect(searchDeepObjects(real, 'NGC 5139')[0]!.id).toBe('omega-centauri');
  });
});

describe('scale of the camera', () => {
  it('maps distance from the Sun to the four named scales', () => {
    expect(scaleOfCamera(60)).toBe('solar-neighbourhood');
    expect(scaleOfCamera(2e4)).toBe('milky-way');
    expect(scaleOfCamera(3e6)).toBe('local-group');
    expect(scaleOfCamera(1e8)).toBe('nearby-universe');
  });
});

describe('closest-view note', () => {
  const base = { name: 'M87', representationKind: 'observed-image' as const, imageId: 'LS-DR10', nativeWidthPx: 4000 };
  it('is derived from the representation and the image resolution, not hard-coded per object', () => {
    expect(closestViewNote({ ...base, displayedWidthPx: 4000 })).toMatch(/Closest view: Atlas has no three-dimensional stellar data for M87; this is the highest-resolution image \(LS-DR10\)/);
    expect(closestViewNote({ ...base, name: 'Orion Nebula', displayedWidthPx: 3600 })).toMatch(/for Orion Nebula;/);
  });
  it('is silent while the image still has resolution to spare, and for non-image representations', () => {
    expect(closestViewNote({ ...base, displayedWidthPx: 1000 })).toBeUndefined();
    expect(closestViewNote({ ...base, representationKind: 'observed-members', displayedWidthPx: 9000 })).toBeUndefined();
    expect(closestViewNote({ ...base, representationKind: 'documented-model', displayedWidthPx: 9000 })).toBeUndefined();
  });
  it('the 2MRS caveat names the Hubble-flow estimate, the flux limit and the zone of avoidance', () => {
    expect(STRUCTURE_NOTE).toMatch(/Hubble-flow/); expect(STRUCTURE_NOTE).toMatch(/flux-limited/); expect(STRUCTURE_NOTE).toMatch(/Filaments and voids are not drawn/);
  });
});
