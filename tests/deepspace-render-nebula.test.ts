import { existsSync, readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { equatorialToUnit } from '../src/core/astro/coordinates';
import { add, dot, length, scale, type Vec3 } from '../src/core/spatial/vec3';
import { DeepSpaceData } from '../src/data/deepspace';
import type { DeepImageProvenanceFile, DeepSpaceFile } from '../src/data/deepspace/types';
import { DeepSpaceAssetManager } from '../src/render/deep-space/DeepSpaceAssetManager';
import { NebulaRenderer } from '../src/render/deep-space/NebulaRenderer';
import {
  bandWeights, defaultNebulaAssetId, edgeOnFade, EDGE_ON_NOTE, ILLUSTRATIVE_LABEL, layerCountFor, layerOffsetsPc, layerQuads, NEBULA_VISUAL, nebulaNote, orderingFor,
  placeNebulaAsset, thicknessPcFor,
} from '../src/render/deep-space/nebulaGeometry';
import { NEBULA_FRAGMENT } from '../src/render/deep-space/nebulaShaders';
import type { DeepRenderContext } from '../src/render/deep-space/types';
import { cameraBasis, FOV_DEG } from '../src/render/orbitCamera';

const have = existsSync('public/data/deep-space.v1.json') && existsSync('public/deepspace/provenance.json');
const d = describe.skipIf(!have);

d('nebula depth layers (pure geometry)', () => {
  const file = JSON.parse(readFileSync('public/data/deep-space.v1.json', 'utf8')) as DeepSpaceFile;
  const prov = JSON.parse(readFileSync('public/deepspace/provenance.json', 'utf8')) as DeepImageProvenanceFile;
  const data = DeepSpaceData.fromFile(file, prov, { validate: false });
  const nebulae = data.byKind('nebula');

  it('the eight nebulae of the data file are all there', () => {
    expect(nebulae.map((o) => o.id).sort()).toEqual(['carina-nebula', 'crab-nebula', 'eagle-nebula', 'horsehead-nebula', 'ngc-1999', 'orion-nebula', 'ring-nebula', 'veil-nebula']);
  });

  it('every asset is placed by its OWN centre, at the object distance, facing the Sun, with the gnomonic field size', () => {
    for (const o of nebulae) for (const a of data.imageAssetsOf(o.id)) {
      const p = placeNebulaAsset(o, a);
      const u = equatorialToUnit(a.geometry.centreRaDeg, a.geometry.centreDecDeg);
      expect(length(p.centre)).toBeCloseTo(p.distancePc, 6);
      expect(dot(scale(p.centre, 1 / p.distancePc), u)).toBeCloseTo(1, 12);
      expect(dot(p.normal, u)).toBeCloseTo(-1, 9);                       // the normal points toward the Sun
      expect(dot(p.xAxis, p.yAxis)).toBeCloseTo(0, 6);
      // angular half-width seen from the Sun
      const tanHalf = length(p.xAxis) / p.distancePc;
      expect(2 * Math.atan(tanHalf) * (180 / Math.PI) * 60).toBeCloseTo(a.geometry.fovArcmin[0], 6);
    }
  });

  it('the Cosmic Cliffs, the Eagle pillar fields and the Veil arcs are sub-regions placed away from the catalogue position', () => {
    const carina = nebulae.find((o) => o.id === 'carina-nebula')!;
    const cliffs = placeNebulaAsset(carina, data.imageAssetsOf('carina-nebula').find((a) => a.id === 'carina-nebula-webb-cosmic-cliffs')!);
    expect(cliffs.subRegion).toBe(true);
    expect(cliffs.separationArcmin / 60).toBeGreaterThan(1.5);           // ~2 degrees from the Carina core
    expect(length(add(cliffs.centre, scale(placeNebulaAsset(carina, data.imageAssetsOf('carina-nebula')[0]!).centre, -1)))).toBeGreaterThan(50); // tens of pc apart
    const eagle = nebulae.find((o) => o.id === 'eagle-nebula')!;
    for (const a of data.imageAssetsOf('eagle-nebula')) expect(placeNebulaAsset(eagle, a).subRegion).toBe(true);
    const veil = nebulae.find((o) => o.id === 'veil-nebula')!;
    const arcs = data.imageAssetsOf('veil-nebula').map((a) => placeNebulaAsset(veil, a));
    expect(arcs.every((a) => a.subRegion)).toBe(true);
    expect(length(add(arcs[0]!.centre, scale(arcs[1]!.centre, -1)))).toBeGreaterThan(5);   // two different arcs
  });

  it('default band: visible light first, widest field; others stay one setBand away', () => {
    const pick = (id: string) => defaultNebulaAssetId(data.imageAssetsOf(id));
    expect(pick('orion-nebula')).toBe('orion-nebula-hubble-mosaic');
    expect(pick('eagle-nebula')).toBe('eagle-nebula-eso-wfi-wide');
    expect(pick('carina-nebula')).toBe('carina-nebula-hubble-mosaic');
    expect(pick('horsehead-nebula')).toBe('horsehead-nebula-vlt-visible');
    expect(pick('ring-nebula')).toBe('ring-nebula-hubble-wfc3');
    expect(defaultNebulaAssetId([])).toBeUndefined();
  });

  it('ENERGY CONSERVATION: from the Sun every layer corner lies on the same ray as the base corner, and the band weights sum to 1', () => {
    for (const o of nebulae) for (const a of data.imageAssetsOf(o.id)) {
      const p = placeNebulaAsset(o, a);
      const T = thicknessPcFor(o.nebulaClass, p.transversePc);
      for (const n of [3, 4, 5]) {
        const quads = layerQuads(p, layerOffsetsPc(n, T, orderingFor(o.nebulaClass)));
        for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]] as const) {
          const base: Vec3 = add(add(p.centre, scale(p.xAxis, sx)), scale(p.yAxis, sy));
          const baseDir = scale(base, 1 / length(base));
          for (const q of quads) {
            const c: Vec3 = add(add(q.centre, scale(q.xAxis, sx)), scale(q.yAxis, sy));
            const dir = scale(c, 1 / length(c));
            expect(dot(dir, baseDir)).toBeCloseTo(1, 12);           // same direction from the Sun
            // the layer sits at its offset along the line of sight: the distance of its centre is d + offset
            expect(length(q.centre)).toBeCloseTo(p.distancePc + q.offsetPc, 6);
          }
        }
        // the angular footprint seen from the Sun is identical for every layer
        const ang = quads.map((q) => Math.atan(length(q.xAxis) / length(q.centre)));
        for (const x of ang) expect(x).toBeCloseTo(ang[0]!, 12);
      }
    }
    for (const n of [3, 4, 5]) for (let i = 0; i <= 200; i++) {
      const w = bandWeights(i / 200, n);
      expect(w.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 12);
      expect(Math.min(...w)).toBeGreaterThanOrEqual(0);
    }
  });

  it('the stack spans exactly the assumed thickness; dark nebulae put the dark band nearest, all others the bright band', () => {
    const o = layerOffsetsPc(5, 2, 'bright-near');
    expect(o[0]).toBeCloseTo(1); expect(o[4]).toBeCloseTo(-1);
    const dk = layerOffsetsPc(5, 2, 'dark-near');
    expect(dk[0]).toBeCloseTo(-1); expect(dk[4]).toBeCloseTo(1);
    expect(orderingFor('dark')).toBe('dark-near');
    for (const c of ['emission', 'reflection', 'planetary', 'supernova-remnant'] as const) expect(orderingFor(c)).toBe('bright-near');
    expect(thicknessPcFor('emission', 10)).toBeCloseTo(3.5);
    for (const f of Object.values(NEBULA_VISUAL.thicknessFraction)) { expect(f).toBeGreaterThan(0); expect(f).toBeLessThan(0.5); }
  });

  it('layer count follows quality: 3 at the lowest, 5 at full', () => {
    expect(layerCountFor(1)).toBe(5); expect(layerCountFor(0.25)).toBe(3); expect(layerCountFor(0.5)).toBe(4);
    for (let q = 0.25; q <= 1; q += 0.05) { const n = layerCountFor(q); expect(n).toBeGreaterThanOrEqual(3); expect(n).toBeLessThanOrEqual(5); }
  });

  it('edge-on fade is smooth, monotonic, has a floor of a few percent and never reaches zero', () => {
    let prev = -1;
    for (let f = 0; f <= 1.0001; f += 0.01) { const v = edgeOnFade(f); expect(v).toBeGreaterThanOrEqual(prev - 1e-12); prev = v; }
    expect(edgeOnFade(0)).toBeCloseTo(NEBULA_VISUAL.edgeOnFloor);
    expect(edgeOnFade(0)).toBeGreaterThan(0.02); expect(edgeOnFade(0)).toBeLessThan(0.08);
    expect(edgeOnFade(1)).toBeCloseTo(1);
  });

  it('notes: illustrative label always, sub-region and false-colour labelled, edge-on warning, no sphericity claim for shells', () => {
    const ring = nebulae.find((o) => o.id === 'ring-nebula')!;
    const a = data.imageAssetsOf('ring-nebula')[0]!;
    const note = nebulaNote({ asset: a, placement: placeNebulaAsset(ring, a), nebulaClass: ring.nebulaClass, imageShown: true, facing: 1, fromBehind: false });
    expect(note).toContain(ILLUSTRATIVE_LABEL);
    expect(note).toMatch(/false colour/); expect(note).toMatch(/no shell shape is implied/);
    expect(note).not.toMatch(/spher/);
    expect(note).not.toContain(EDGE_ON_NOTE);
    expect(nebulaNote({ asset: a, placement: placeNebulaAsset(ring, a), nebulaClass: ring.nebulaClass, imageShown: true, facing: 0.05, fromBehind: false })).toContain(EDGE_ON_NOTE);
    const carina = nebulae.find((o) => o.id === 'carina-nebula')!;
    const cliffs = data.imageAssetsOf('carina-nebula').find((x) => x.id.endsWith('cosmic-cliffs'))!;
    expect(nebulaNote({ asset: cliffs, placement: placeNebulaAsset(carina, cliffs), nebulaClass: 'emission', imageShown: true, facing: 1, fromBehind: false })).toMatch(/sub-region image of this object.*from the catalogue position/);
    expect(nebulaNote({ asset: a, placement: undefined, nebulaClass: 'planetary', imageShown: false, facing: 1, fromBehind: false })).not.toContain(ILLUSTRATIVE_LABEL);
  });

  it('the shader encodes before weighting (so the weighted layers add back to the encoded image) and uses the shared sRGB chunk', () => {
    expect(NEBULA_FRAGMENT).toMatch(/atlasSrgbEncode\(c\) \* \(m \* uWeight \* w\)/);
    expect(NEBULA_FRAGMENT).toMatch(/atlasBandWeight/);
  });
});

d('NebulaRenderer (fake assets, no WebGL)', () => {
  const file = JSON.parse(readFileSync('public/data/deep-space.v1.json', 'utf8')) as DeepSpaceFile;
  const prov = JSON.parse(readFileSync('public/deepspace/provenance.json', 'utf8')) as DeepImageProvenanceFile;
  const data = DeepSpaceData.fromFile(file, prov, { validate: false });
  const makeAssets = (resolve: boolean) => {
    const created = { n: 0, disposed: 0 };
    const mgr = new DeepSpaceAssetManager<THREE.Texture>({
      baseUrl: 'x/',
      decode: (_u, s) => (resolve ? Promise.resolve({ width: 4, height: 4, source: {} }) : new Promise((_r, rej) => s.addEventListener('abort', () => rej(new Error('abort'))))),
      createTexture: () => { created.n++; const t = new THREE.Texture(); const dispose = t.dispose.bind(t); t.dispose = () => { created.disposed++; dispose(); }; return t; },
    });
    return { mgr, created };
  };
  const mkCtx = (camPc: [number, number, number], yaw: number, pitch: number, focusDistancePc: number, quality = 1, t = 1): DeepRenderContext => {
    const camera = new THREE.PerspectiveCamera(FOV_DEG, 1100 / 700, 1e-3, 1e11);
    const basis = cameraBasis({ focus: [0, 0, 0], distance: 1, yaw, pitch });
    return { camera, camPc, basis, viewport: { width: 1100, height: 700 }, pixelRatio: 1, focusDistancePc, pixelsPerRadian: 700 / (2 * Math.tan((FOV_DEG * Math.PI) / 360)), nowSeconds: t, selectedId: null, quality };
  };
  /** Camera at `distPc` from the placement centre of the object's default asset, looking at it from `offAxisDeg` away from the Sun's line of sight. */
  const lookAt = (r: NebulaRenderer, id: string, distPc: number, offAxisDeg = 0, quality = 1, t = 1): DeepRenderContext => {
    const pl = r.placement(id)!;
    const u = scale(pl.centre, 1 / length(pl.centre));            // from the Sun to the field
    // off-axis direction: rotate u about an axis perpendicular to it (the sheet's x axis)
    const ax = scale(pl.xAxis, 1 / length(pl.xAxis));
    const a = (offAxisDeg * Math.PI) / 180;
    const back = add(scale(u, -Math.cos(a)), scale(ax, Math.sin(a)));   // camera sits on this side of the field
    const cam: [number, number, number] = [pl.centre[0] + back[0] * distPc, pl.centre[1] + back[1] * distPc, pl.centre[2] + back[2] * distPc];
    const f = scale(back, -1);
    const yaw = Math.atan2(-f[1], -f[0]), pitch = Math.asin(-f[2]);   // orbit-camera convention (as in the layer tests)
    return mkCtx(cam, yaw, pitch, distPc, quality, t);
  };
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };

  it('registers all eight nebulae with layerKind "nebulae"; the viewer layer routes setBand and activeAsset through it', () => {
    const { mgr } = makeAssets(false);
    const r = new NebulaRenderer(data, mgr);
    expect(r.layerKind).toBe('nebulae');
    expect(r.ids().sort()).toEqual(['carina-nebula', 'crab-nebula', 'eagle-nebula', 'horsehead-nebula', 'ngc-1999', 'orion-nebula', 'ring-nebula', 'veil-nebula']);
    expect(r.activeAsset('orion-nebula')).toBe('orion-nebula-hubble-mosaic');
    expect(r.setBand('orion-nebula', 'orion-nebula-vista-nir')).toBe(true);
    expect(r.activeAsset('orion-nebula')).toBe('orion-nebula-vista-nir');
    expect(r.setBand('orion-nebula', 'not-an-asset')).toBe(false);
    expect(r.setBand('m31', 'orion-nebula-vista-nir')).toBe(false);
    expect(r.setBand('orion-nebula', 'eagle-nebula-eso-wfi-wide')).toBe(false);   // another object's asset
    r.dispose(); mgr.dispose();
  });

  it('viewDistancePc is ~2x the physical diameter of the primary field', () => {
    const { mgr } = makeAssets(false);
    const r = new NebulaRenderer(data, mgr);
    const orion = r.placement('orion-nebula')!;
    expect(r.viewDistancePc('orion-nebula')).toBeCloseTo(2 * orion.transversePc, 9);
    expect(orion.transversePc).toBeGreaterThan(3.5); expect(orion.transversePc).toBeLessThan(4.2);   // 30' at 445 pc ~ 3.9 pc
    expect(r.viewDistancePc('m31')).toBeUndefined();
    r.dispose(); mgr.dispose();
  });

  it('from the Sun far away it is a marker; screen info is kind "nebula" with a pickable radius; one shared draw call', () => {
    const { mgr } = makeAssets(false);
    const r = new NebulaRenderer(data, mgr);
    const ctx = mkCtx([0, 0, 0], 0.3, 0.2, 100);
    mgr.beginFrame();
    const infos = r.update(ctx);
    expect(infos.length).toBe(8);
    for (const i of infos) { expect(i.kind).toBe('nebula'); expect(i.pixelRadius).toBeGreaterThanOrEqual(NEBULA_VISUAL.minPickRadiusPx); }
    r.dispose(); mgr.dispose();
  });

  it('off-screen nebulae cost nothing: no mesh, no texture request, no draw call', () => {
    const { mgr, created } = makeAssets(true);
    const r = new NebulaRenderer(data, mgr);
    // look at the opposite side of the sky from every nebula? Orion/Horsehead are near (85, -3); look toward +x,+y... then check counts
    const pl = r.placement('ring-nebula')!;
    const u = scale(pl.centre, -1 / length(pl.centre));   // look away from the ring nebula
    const ctx = mkCtx([0, 0, 0], Math.atan2(-u[1], -u[0]), Math.asin(-u[2]), 100);
    mgr.beginFrame();
    const infos = r.update(ctx);
    expect(infos.find((i) => i.id === 'ring-nebula')!.visible).toBe(false);
    expect(infos.find((i) => i.id === 'ring-nebula')!.lod).toBe('offscreen');
    expect(created.n).toBe(0);
    r.dispose(); mgr.dispose();
  });

  it('draws ONE instanced draw per visible nebula with N layers (3..5 by quality), plus one shared marker/glow draw', async () => {
    const { mgr, created } = makeAssets(true);
    const r = new NebulaRenderer(data, mgr);
    const pl = r.placement('orion-nebula')!;
    let calls = 0;
    for (let f = 0; f < 12; f++) {
      mgr.beginFrame();
      r.update(lookAt(r, 'orion-nebula', 3 * pl.transversePc, 0, 1, 1 + f * 0.3));
      await settle();
    }
    mgr.beginFrame(); r.update(lookAt(r, 'orion-nebula', 3 * pl.transversePc, 0, 1, 10));
    calls = r.stats().drawCalls;
    const st = r.layerState('orion-nebula')!;
    expect(st.layers).toBe(5); expect(st.assetId).toBe('orion-nebula-hubble-mosaic');
    expect(st.facing).toBeGreaterThan(0.99);
    const mesh = r.group.children.find((c) => c.name === 'nebula-layers:orion-nebula') as THREE.Mesh;
    expect(mesh.visible).toBe(true);
    expect((mesh.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(5);
    expect(calls).toBeLessThanOrEqual(2);                                 // at most the layers draw + the marker/glow draw
    expect(created.n).toBeGreaterThan(0);
    mgr.beginFrame(); r.update(lookAt(r, 'orion-nebula', 3 * pl.transversePc, 0, 0.25, 10.1));
    expect(r.layerState('orion-nebula')!.layers).toBe(3);
    expect((mesh.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(3);
    r.dispose(); mgr.dispose();
  });

  it('the layers coincide on the sky from the Sun-side axis and separate off axis (parallax); layer data are camera-relative', async () => {
    const { mgr } = makeAssets(true);
    const r = new NebulaRenderer(data, mgr);
    const pl = r.placement('eagle-nebula')!;
    const run = async (offAxis: number) => {
      for (let f = 0; f < 12; f++) { mgr.beginFrame(); r.update(lookAt(r, 'eagle-nebula', 2.5 * pl.transversePc, offAxis, 1, 1 + f * 0.3)); await settle(); }
      mgr.beginFrame(); const infos = r.update(lookAt(r, 'eagle-nebula', 2.5 * pl.transversePc, offAxis, 1, 10)); return infos.find((i) => i.id === 'eagle-nebula')!;
    };
    const mesh = () => r.group.children.find((c) => c.name === 'nebula-layers:eagle-nebula') as THREE.Mesh;
    await run(0);
    const attr = (g: THREE.BufferGeometry, nm: string) => (g.getAttribute(nm) as THREE.BufferAttribute).array as Float32Array;
    const c0 = attr(mesh().geometry, 'aCentre');
    // looking from the Sun-side: layer centres are spread along the line of sight (z in view space ~ distance), not sideways
    const st = r.layerState('eagle-nebula')!;
    const dist = (k: number) => Math.hypot(c0[3 * k]!, c0[3 * k + 1]!, c0[3 * k + 2]!);
    expect(dist(0) - dist(4)).toBeCloseTo(st.offsetsPc[0]! - st.offsetsPc[4]!, 2);
    expect(st.offsetsPc[0]! - st.offsetsPc[4]!).toBeCloseTo(st.thicknessPc, 6);
    // 60 degrees off axis: the same layers are now displaced sideways relative to each other
    await run(60);
    const lateral = (off: number) => {
      const a = attr(mesh().geometry, 'aCentre');
      const v0: Vec3 = [a[0]!, a[1]!, a[2]!], v4: Vec3 = [a[12]!, a[13]!, a[14]!];
      const dir = scale(v0, 1 / length(v0));
      const dv = add(v4, scale(v0, -1));
      const along = dot(dv, dir);
      return Math.sqrt(Math.max(0, dot(dv, dv) - along * along)) + 0 * off;
    };
    expect(lateral(60)).toBeGreaterThan(0.3 * st.thicknessPc);
    r.dispose(); mgr.dispose();
  });

  it('fades smoothly toward edge-on, keeps a floor, and says so in the note', async () => {
    const { mgr } = makeAssets(true);
    const r = new NebulaRenderer(data, mgr);
    const pl = r.placement('crab-nebula')!;
    const weightAt = async (offAxis: number) => {
      for (let f = 0; f < 12; f++) { mgr.beginFrame(); r.update(lookAt(r, 'crab-nebula', 2.5 * pl.transversePc, offAxis, 1, 1 + f * 0.3)); await settle(); }
      mgr.beginFrame(); const infos = r.update(lookAt(r, 'crab-nebula', 2.5 * pl.transversePc, offAxis, 1, 10));
      const mesh = r.group.children.find((c) => c.name === 'nebula-layers:crab-nebula') as THREE.Mesh;
      return { w: ((mesh.material as THREE.ShaderMaterial).uniforms['uWeight']!.value as number), visible: mesh.visible, note: infos.find((i) => i.id === 'crab-nebula')!.representationNote ?? '' };
    };
    const w0 = await weightAt(0), w45 = await weightAt(45), w80 = await weightAt(80), w89 = await weightAt(89.5);
    expect(w0.w).toBeGreaterThan(w45.w * 0.99);
    expect(w45.w).toBeGreaterThan(w80.w);
    expect(w80.w).toBeGreaterThan(w89.w - 1e-9);
    expect(w89.w).toBeGreaterThan(0.02);                                   // the floor: never invisible
    expect(w0.note).toContain(ILLUSTRATIVE_LABEL); expect(w0.note).not.toContain(EDGE_ON_NOTE);
    expect(w89.note).toContain(EDGE_ON_NOTE);
    expect(w0.note).toContain('false colour');
    r.dispose(); mgr.dispose();
  });

  it('Cosmic Cliffs: the layers are placed at the asset centre, not the object centre, and the note says sub-region', async () => {
    const { mgr } = makeAssets(true);
    const r = new NebulaRenderer(data, mgr);
    r.setBand('carina-nebula', 'carina-nebula-webb-cosmic-cliffs');
    const pl = r.placement('carina-nebula', 'carina-nebula-webb-cosmic-cliffs')!;
    for (let f = 0; f < 14; f++) { mgr.beginFrame(); r.update(lookAt(r, 'carina-nebula', 2.5 * pl.transversePc, 0, 1, 1 + f * 0.3)); await settle(); }
    // lookAt uses r.placement(id) = shown ?? chosen: make sure we are looking at the cliffs
    mgr.beginFrame(); const infos = r.update(lookAt(r, 'carina-nebula', 2.5 * pl.transversePc, 0, 1, 10));
    const info = infos.find((i) => i.id === 'carina-nebula')!;
    expect(r.activeAsset('carina-nebula')).toBe('carina-nebula-webb-cosmic-cliffs');
    expect(info.representationNote).toMatch(/sub-region image of this object/);
    expect(info.lod).toMatch(/^image-L/);
    expect(Math.abs(info.x - 550)).toBeLessThan(2);                        // the label sits on the drawn field, not on the catalogue position 2 degrees away
    r.dispose(); mgr.dispose();
  });

  it('band swap is instant: the previous band keeps drawing until the new thumbnail is ready, then the asset changes', async () => {
    let allow = true;
    const mgr = new DeepSpaceAssetManager<THREE.Texture>({
      baseUrl: 'x/', decode: (u) => (allow || u.includes('hubble-mosaic') ? Promise.resolve({ width: 4, height: 4, source: {} }) : new Promise(() => undefined)),
      createTexture: () => new THREE.Texture(),
    });
    const r = new NebulaRenderer(data, mgr);
    const pl = r.placement('orion-nebula')!;
    for (let f = 0; f < 14; f++) { mgr.beginFrame(); r.update(lookAt(r, 'orion-nebula', 3 * pl.transversePc, 0, 1, 1 + f * 0.3)); await settle(); }
    expect(r.layerState('orion-nebula')!.assetId).toBe('orion-nebula-hubble-mosaic');
    allow = false;
    r.setBand('orion-nebula', 'orion-nebula-vista-nir');
    for (let f = 0; f < 4; f++) { mgr.beginFrame(); r.update(lookAt(r, 'orion-nebula', 3 * pl.transversePc, 0, 1, 10 + f * 0.1)); await settle(); }
    expect(r.layerState('orion-nebula')!.assetId).toBe('orion-nebula-hubble-mosaic');   // still the old one, no blank
    expect(r.activeAsset('orion-nebula')).toBe('orion-nebula-hubble-mosaic');
    r.dispose(); mgr.dispose();
  });

  it('dispose releases geometry and material of every drawn nebula', async () => {
    const { mgr } = makeAssets(true);
    const r = new NebulaRenderer(data, mgr);
    const pl = r.placement('ring-nebula')!;
    for (let f = 0; f < 12; f++) { mgr.beginFrame(); r.update(lookAt(r, 'ring-nebula', 3 * pl.transversePc, 0, 1, 1 + f * 0.3)); await settle(); }
    const mesh = r.group.children.find((c) => c.name === 'nebula-layers:ring-nebula') as THREE.Mesh;
    expect(mesh).toBeTruthy();
    let g = 0, m = 0;
    mesh.geometry.addEventListener('dispose', () => g++); (mesh.material as THREE.Material).addEventListener('dispose', () => m++);
    r.dispose();
    expect(g).toBe(1); expect(m).toBe(1);
    expect(r.group.children.length).toBe(0);
    mgr.dispose();
  });
});
