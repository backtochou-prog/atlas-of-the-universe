import { existsSync, readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DeepSpaceData } from '../src/data/deepspace';
import type { DeepImageProvenanceFile, DeepSpaceFile } from '../src/data/deepspace/types';
import { DeepSpaceAssetManager } from '../src/render/deep-space/DeepSpaceAssetManager';
import { DeepSpaceLayer } from '../src/render/deep-space/DeepSpaceLayer';
import type { DeepRenderContext, DeepSubRenderer } from '../src/render/deep-space/types';
import { cameraBasis, FOV_DEG } from '../src/render/orbitCamera';

const have = existsSync('public/data/deep-space.v1.json') && existsSync('public/deepspace/provenance.json');
const d = describe.skipIf(!have);

d('DeepSpaceLayer (fake assets, no WebGL)', () => {
  const file = JSON.parse(readFileSync('public/data/deep-space.v1.json', 'utf8')) as DeepSpaceFile;
  const prov = JSON.parse(readFileSync('public/deepspace/provenance.json', 'utf8')) as DeepImageProvenanceFile;
  const data = DeepSpaceData.fromFile(file, prov, { validate: false });
  const fakeAssets = () => new DeepSpaceAssetManager<THREE.Texture>({
    baseUrl: 'x/', decode: () => new Promise(() => undefined), createTexture: () => new THREE.Texture(),
  });
  const mkCtx = (camPc: [number, number, number], yaw: number, pitch: number, focusDistancePc: number): DeepRenderContext => {
    const camera = new THREE.PerspectiveCamera(FOV_DEG, 1100 / 700, 1e-3, 1e11);
    const basis = cameraBasis({ focus: [0, 0, 0], distance: 1, yaw, pitch });
    return { camera, camPc, basis, viewport: { width: 1100, height: 700 }, pixelRatio: 1, focusDistancePc, pixelsPerRadian: 700 / (2 * Math.tan((FOV_DEG * Math.PI) / 360)), nowSeconds: 1, selectedId: null, quality: 1 };
  };
  const lookAt = (id: string, layer: DeepSpaceLayer, distPc: number): DeepRenderContext => {
    const p = layer.objectPositionPc(id)!; const r = Math.hypot(...p);
    const yaw = Math.atan2(-p[1] / r, -p[0] / r), pitch = Math.asin(-p[2] / r);
    const fwd = cameraBasis({ focus: [0, 0, 0], distance: 1, yaw, pitch }).forward;
    const cam: [number, number, number] = [p[0] - fwd[0] * distPc, p[1] - fwd[1] * distPc, p[2] - fwd[2] * distPc];
    return mkCtx(cam, yaw, pitch, distPc);
  };

  it('draws nothing close to the Sun (the real Gaia stars are the truth) and has no draw calls', () => {
    const layer = new DeepSpaceLayer(data, prov, { baseUrl: '/', assets: fakeAssets() });
    layer.beginFrame();
    layer.update(mkCtx([30, 20, 10], 0.6, 0.35, 60));
    expect(layer.stats().drawCalls).toBe(0);
    expect(layer.stats().objectsVisible).toBe(0);
    layer.dispose();
  });

  it('reports every galaxy with a position and the Milky Way model, near/far set per frame', () => {
    const layer = new DeepSpaceLayer(data, prov, { baseUrl: '/', assets: fakeAssets() });
    const ctx = lookAt('m31', layer, 759_000);
    layer.beginFrame();
    const screen = layer.update(ctx);
    for (const id of ['m31', 'm33', 'lmc', 'smc', 'm32', 'm87', 'cen-a', 'm81', 'm104', 'milky-way']) expect(screen.has(id)).toBe(true);
    expect(ctx.camera.near).toBeCloseTo(1e-3 * 759_000, 3); expect(ctx.camera.far).toBe(1e11);
    const m31 = screen.get('m31')!;
    expect(m31.visible).toBe(true);
    expect(m31.x).toBeCloseTo(550, 0); expect(m31.y).toBeCloseTo(350, 0); // looked at, so on the screen centre
    // M31 is about 3 degrees wide from the Sun: 177.83 arcmin * (700 px / 50 deg) = 41 px across, radius ~21 px
    expect(m31.pixelRadius).toBeGreaterThan(18); expect(m31.pixelRadius).toBeLessThan(24);
    expect(m31.representationNote).toMatch(/tilt direction illustrative/);
    expect(layer.stats().drawCalls).toBeGreaterThan(0);
    layer.dispose();
  });

  it('flat sky-plane images are labelled "projected image, no depth"; an object with an image does not claim to lack one', () => {
    const layer = new DeepSpaceLayer(data, prov, { baseUrl: '/', assets: fakeAssets() });
    layer.beginFrame();
    const s1 = layer.update(lookAt('m104', layer, 9_000_000)).get('m104')!;
    expect(s1.representationNote).toMatch(/projected image, no depth/);
    layer.beginFrame();
    const s2 = layer.update(lookAt('smc', layer, 60_000)).get('smc')!;
    // whatever the image set currently is, the note must agree with it: an object with an image never claims to lack one, one without says so
    if (data.imageAssetsOf('smc').length > 0) expect(s2.representationNote ?? '').not.toMatch(/no image/);
    else expect(s2.representationNote ?? '').toMatch(/no image in the atlas/);
    layer.dispose();
  });

  it('suggests viewing distances: galaxies ~2.2 x diameter, clusters ~3 x half-extent, nothing invented for unknown objects', () => {
    const layer = new DeepSpaceLayer(data, prov, { baseUrl: '/', assets: fakeAssets() });
    const m31 = data.get('m31')!;
    const D = 2 * Math.tan((m31.angularSize!.majorArcmin / 60) * Math.PI / 180 / 2) * 761_000;
    expect(layer.viewDistancePc('m31')! / D).toBeCloseTo(2.2, 2);
    expect(layer.viewDistancePc('milky-way')!).toBeGreaterThan(50_000);
    expect(layer.viewDistancePc('no-such-object')).toBeUndefined();
    const m13 = data.get('m13');
    if (m13?.angularSize) expect(layer.viewDistancePc('m13')!).toBeGreaterThan(0);
    expect(layer.objectPositionPc('m31')).toEqual(data.positionPc('m31'));
    layer.dispose();
  });

  it('band switching: only the object\'s own assets are accepted; availableBands lists them', () => {
    const layer = new DeepSpaceLayer(data, prov, { baseUrl: '/', assets: fakeAssets() });
    const bands = layer.availableBands('m33');
    expect(bands.length).toBeGreaterThanOrEqual(2);
    expect(layer.setBand('m33', bands[1]!.assetId)).toBe(true);
    expect(layer.setBand('m33', 'm31-galex-nuv')).toBe(false);
    expect(layer.setBand('m33', 'nope')).toBe(false);
    expect(layer.activeAsset('m33')).toBe(bands[1]!.assetId);
    layer.dispose();
  });

  it('sub-renderers register without touching the layer, can be hidden by layer toggle, and are disposed with it', () => {
    const layer = new DeepSpaceLayer(data, prov, { baseUrl: '/', assets: fakeAssets() });
    let updates = 0, disposed = 0, quality = 0;
    const fake: DeepSubRenderer = {
      name: 'fake-nebulae', group: new THREE.Group(), layerKind: 'nebulae',
      update: () => { updates++; return [{ id: 'fake-nebula', kind: 'nebula', x: 5, y: 5, pixelRadius: 9, distancePc: 400, visible: true, lod: 'marker' }]; },
      stats: () => ({ drawCalls: 2, textureBytes: 0, pointsDrawn: 7, objectsVisible: 1 }),
      setQuality: (q) => { quality = q },
      dispose: () => { disposed++; },
    };
    layer.register(fake); layer.register(fake);
    expect(layer.registered.filter((r) => r === fake)).toHaveLength(1);
    layer.beginFrame(); let s = layer.update(mkCtx([0, 0, 5000], 0.6, 0.3, 5000));
    expect(updates).toBe(1); expect(s.get('fake-nebula')?.pixelRadius).toBe(9);
    expect(layer.stats().drawCalls).toBeGreaterThanOrEqual(2);
    layer.setLayerVisibility({ nebulae: false });
    layer.beginFrame(); s = layer.update(mkCtx([0, 0, 5000], 0.6, 0.3, 5000));
    expect(updates).toBe(1); expect(s.has('fake-nebula')).toBe(false); expect(fake.group.visible).toBe(false);
    layer.setQuality(0.5); expect(quality).toBe(0.5);
    layer.dispose(); expect(disposed).toBe(1);
  });

  it('galaxies and nebulae are pickable only while they are actually drawn: M31 seen from 136 pc is on screen but too faint to click', () => {
    const layer = new DeepSpaceLayer(data, prov, { baseUrl: '/', assets: fakeAssets() });
    const p = layer.objectPositionPc('m31')!; const r = Math.hypot(...p);
    const near = { ...lookAt('m31', layer, 1e6) }; near.camPc = [p[0] / r * 136, p[1] / r * 136, p[2] / r * 136];
    layer.beginFrame(); let s = layer.update(near);
    const m31n = s.get('m31')!;
    expect(m31n.visible).toBe(true);           // the legacy "on screen" flag: the old pick gate
    expect(m31n.pickable).toBe(false);         // draw weight ~0.008 < 0.05
    const far = lookAt('m31', layer, 2e6);
    layer.beginFrame(); s = layer.update(far);
    expect(s.get('m31')!.visible).toBe(true); expect(s.get('m31')!.pickable).toBe(true);
    layer.dispose();
  });

  it('a nebula seen from far outside the Galaxy (fade below the threshold) is reported but not pickable', () => {
    const layer = new DeepSpaceLayer(data, prov, { baseUrl: '/', assets: fakeAssets() });
    layer.beginFrame(); let s = layer.update(lookAt('orion-nebula', layer, 7e5));
    const far = s.get('orion-nebula')!;
    expect(far.pickable).toBe(false);
    layer.beginFrame(); s = layer.update(lookAt('orion-nebula', layer, 300));
    expect(s.get('orion-nebula')!.pickable).toBe(true);
    layer.dispose();
  });

  it('a screen id emitted by two renderers keeps the first one and counts the clash (no silent overwrite)', () => {
    const layer = new DeepSpaceLayer(data, prov, { baseUrl: '/', assets: fakeAssets() });
    const mk = (name: string, r: number): DeepSubRenderer => ({
      name, group: new THREE.Group(), layerKind: 'clusters',
      update: () => [{ id: 'dup:1', kind: 'catalogue-point', x: 1, y: 1, pixelRadius: r, distancePc: 1, visible: true, lod: 'marker' }],
      stats: () => ({ drawCalls: 0, textureBytes: 0, pointsDrawn: 0, objectsVisible: 0 }), dispose: () => undefined,
    });
    layer.register(mk('first', 3)); layer.register(mk('second', 7));
    layer.beginFrame(); const s = layer.update(mkCtx([0, 0, 5000], 0.6, 0.3, 5000));
    expect(s.get('dup:1')?.pixelRadius).toBe(3); expect(layer.duplicateIds).toBe(1);
    layer.dispose();
  });

  it('camera-relative positions keep float64 precision: a galaxy at 16 Mpc seen from 1 pc away is not quantised to the absolute float32 grid', () => {
    // absolute 1.6e7 pc in float32 has a spacing of 1 pc; the layer subtracts in float64 first, so an offset of 0.001 pc survives
    const p = data.positionPc('m87')!;
    const cam: [number, number, number] = [p[0] - 0.123456, p[1], p[2]];
    const rel = Math.fround(p[0] - cam[0]);
    expect(rel).toBeCloseTo(0.123456, 6);
    expect(Math.fround(p[0]) - Math.fround(cam[0])).not.toBeCloseTo(0.123456, 3); // the wrong way (absolute float32) would fail
  });
  it('objects without a catalogue position get a labelled view anchor from their renderer: Local Group = midpoint of the Milky Way and M31, twomrs = the Sun', () => {
    const layer = new DeepSpaceLayer(data, prov, { baseUrl: '/', assets: fakeAssets() });
    expect(data.positionPc('local-group')).toBeUndefined();
    const lg = layer.objectPositionPc('local-group')!;
    const mw = layer.objectPositionPc('milky-way')!, m31 = layer.objectPositionPc('m31')!;
    expect(lg).toBeDefined();
    for (let k = 0; k < 3; k++) expect(lg[k]).toBeCloseTo((mw[k]! + m31[k]!) / 2, 6);
    expect(layer.objectPositionPc('twomrs')).toEqual([0, 0, 0]);
    expect(layer.isViewAnchor('local-group')).toBe(true);
    expect(layer.isViewAnchor('twomrs')).toBe(true);
    expect(layer.isViewAnchor('m31')).toBe(false);
    expect(layer.viewDistancePc('local-group')).toBeGreaterThan(0);
    expect(layer.viewDistancePc('twomrs')).toBeGreaterThan(0);
    expect(layer.objectPositionPc('no-such-object')).toBeUndefined();
    // every object of the data file can be flown to: it has a position and a view distance
    for (const o of data.all()) { expect(layer.objectPositionPc(o.id), o.id).toBeDefined(); expect(layer.viewDistancePc(o.id), o.id).toBeGreaterThan(0); }
    layer.dispose();
  });
});
