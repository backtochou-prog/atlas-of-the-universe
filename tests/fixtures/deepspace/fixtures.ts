/** TEST FIXTURES ONLY. Synthetic, small, hand-written: not catalogue data and never shipped. Sources are labelled 'test-fixture'. */
import type { Measurement, SourceRef } from '../../../src/data/schema';
import type { DeepImageAsset, DeepImageProvenanceFile, DeepSpaceFile, DeepSpaceObject, PointCatalogueFile } from '../../../src/data/deepspace/types';

export const SRC: SourceRef = { source: 'test-fixture', retrieved: '2026-01-01' };
export const meas = (value: number, unit: string, extra: Partial<Measurement> = {}): Measurement => ({ value, unit, kind: 'observed', source: SRC, ...extra });

export const M31: DeepSpaceObject = {
  id: 'm31', name: 'Andromeda Galaxy (fixture)', designations: ['M 31'], kind: 'galaxy', galaxyClass: 'spiral', morphologyLabel: 'SA(s)b',
  sky: { raDeg: 10.6847, decDeg: 41.2688, distance: meas(0.77, 'Mpc', { uncertainty: 0.04 }), coordinateSource: SRC },
  angularSize: { majorArcmin: 190, minorArcmin: 60, positionAngleDeg: 35, source: SRC, definition: 'D25' },
  orientation: { inclinationDeg: meas(77, 'deg'), positionAngleDeg: meas(38, 'deg'), nearSide: 'north-west' },
  measurements: {}, imageAssetIds: ['m31-fixture-visible'], parentId: 'local-group',
  representation: { kind: 'deprojected-image', summary: 'Fixture representation of a deprojected image.', depth: 'published-orientation-model' },
};
export const LOCAL_GROUP: DeepSpaceObject = {
  id: 'local-group', name: 'Local Group (fixture)', designations: [], kind: 'galaxy-group', measurements: {}, imageAssetIds: [],
  membership: { pointsFileId: 'local-group-mcconnachie', names: ['Andromeda', 'LMC'], basis: 'fixture', source: SRC },
  representation: { kind: 'observed-members', summary: 'Fixture members.', depth: 'measured-per-object' },
};
export const M42: DeepSpaceObject = {
  id: 'orion-nebula', name: 'Orion Nebula (fixture)', designations: ['M 42'], kind: 'nebula', nebulaClass: 'emission', morphologyLabel: 'HII',
  sky: { raDeg: 83.8221, decDeg: -5.3911, distance: meas(1344, 'pc', { uncertainty: 20 }), coordinateSource: SRC },
  angularSize: { majorArcmin: 85, source: SRC, definition: 'optical-extent' },
  measurements: {}, imageAssetIds: [],
  representation: { kind: 'observed-image', summary: 'Fixture image on the sky plane.', depth: 'sky-plane-only', exaggerations: ['none'] },
};
export const PLEIADES: DeepSpaceObject = {
  id: 'pleiades', name: 'Pleiades (fixture)', designations: ['M 45'], kind: 'star-cluster', clusterClass: 'open',
  sky: { raDeg: 56.75, decDeg: 24.1167, distance: meas(136, 'pc'), coordinateSource: SRC }, measurements: {}, imageAssetIds: [], pointsFileId: 'members-pleiades',
  representation: { kind: 'observed-members', summary: 'Fixture members.', depth: 'measured-per-object' },
};

export function fixtureFile(over: Partial<DeepSpaceFile> = {}): DeepSpaceFile {
  return {
    manifest: { schema: 'atlas-deep-space/1', generated: '2026-01-01', builtBy: 'fixture', sources: [] },
    objects: [M31, LOCAL_GROUP, M42, PLEIADES],
    models: {},
    ...over,
  };
}

export const IMAGE: DeepImageAsset = {
  id: 'm31-fixture-visible', objectId: 'm31', title: 'Fixture image',
  band: { kind: 'visible', filters: ['F555W'], falseColour: false, composite: true, colourNote: 'fixture' },
  source: { archive: 'fixture', imageId: 'fx0001', landingUrl: 'https://example.org/fx0001', downloadUrl: 'https://example.org/fx0001.jpg', retrieved: '2026-01-01', sha256: 'a'.repeat(64) },
  credit: 'Fixture credit',
  licence: { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/', evidence: 'Fixture evidence sentence.', attributionRequired: true, redistributionAllowed: true },
  observation: { telescope: 'fixture' },
  geometry: { originalWidthPx: 4000, originalHeightPx: 2000, fovArcmin: [190, 95], centreRaDeg: 10.6847, centreDecDeg: 41.2688, upPositionAngleDeg: 0, wcsSource: 'archive-metadata' },
  processing: ['resized'],
  levels: [
    { level: 0, file: 'img/a-0.webp', widthPx: 256, heightPx: 128, bytes: 4000, format: 'webp' },
    { level: 1, file: 'img/a-1.webp', widthPx: 1024, heightPx: 512, bytes: 40000, format: 'webp' },
    { level: 2, file: 'img/a-2.webp', widthPx: 4000, heightPx: 2000, bytes: 400000, format: 'webp' },
  ],
  fidelity: 'scientific-image',
};
export const provenanceFixture = (assets: DeepImageAsset[] = [IMAGE]): DeepImageProvenanceFile => ({ manifest: { schema: 'atlas-deep-images/1', generated: '2026-01-01' }, assets });

export function membersFixture(over: Partial<PointCatalogueFile['columns']> = {}): PointCatalogueFile {
  return {
    manifest: { id: 'members-pleiades', title: 'fixture', source: SRC, licence: 'fixture', count: 2, query: 'fixture', distanceBasis: 'per-object-parallax', caveats: [], units: {} },
    columns: {
      name: ['a', 'b'], raDeg: [56.1, 57.2], decDeg: [24.0, 24.3], sourceId: ['1', '2'], gMag: [5.1, 6.2], bpRp: [0.1, null],
      parallaxMas: [7.3, 7.4], pmraMasYr: [20, 21], pmdecMasYr: [-45, -44], probability: [null, 0.9], ...over,
    },
  };
}
export function lgFixture(): PointCatalogueFile {
  return {
    manifest: { id: 'local-group-mcconnachie', title: 'fixture', source: SRC, licence: 'fixture', count: 2, query: 'fixture', distanceBasis: 'per-object-direct', caveats: [], units: {} },
    columns: { name: ['Andromeda', 'LMC'], raDeg: [10.68, 80.89], decDeg: [41.27, -69.76], distMpc: [0.77, 0.05], distErrMpc: [0.04, null], distMethod: ['TRGB', 'x'], morphology: ['SA(s)b', 'SB(s)m'], vMag: [3.4, 0.4], diameterArcmin: [190, null] },
  };
}
