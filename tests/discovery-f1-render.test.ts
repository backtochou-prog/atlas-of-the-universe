/**
 * F1 integration fixes, renderer side: the highlight marker draws NOTHING when there is nothing to draw (a visible mesh of hidden instances still costs a draw
 * call), the bright-star pick distance, and the shared bright-star placement rule (engine == renderer).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { cameraBasis, FOV_DEG, type OrbitState } from '../src/render/orbitCamera';
import { HighlightMarkers, OtherObjectMarkers } from '../src/render/deep-space/DiscoveryMarkers';
import type { DeepRenderContext } from '../src/render/deep-space/types';
import { BrightStarLayer } from '../src/render/discovery/BrightStarLayer';
import { buildBrightStarSet } from '../src/render/discovery/brightStarSet';
import { brightPlacement } from '../src/discovery/brightPlacement';
import { recordsFromBrightStars } from '../src/discovery/records';
import type { BrightStarFile, OtherObjectsFile } from '../src/discovery/types';
import { have, readGz } from './fixtures/discovery/real';

const VP = { width: 1280, height: 800 };
const PPR = VP.height / (2 * Math.tan((FOV_DEG * Math.PI) / 360));
function ctx(state: OrbitState): DeepRenderContext {
  const b = cameraBasis(state);
  const cam: [number, number, number] = [state.focus[0] - b.forward[0] * state.distance, state.focus[1] - b.forward[1] * state.distance, state.focus[2] - b.forward[2] * state.distance];
  return { camera: new THREE.PerspectiveCamera(FOV_DEG, VP.width / VP.height), camPc: cam, basis: b, viewport: VP, pixelRatio: 1, focusDistancePc: state.distance, pixelsPerRadian: PPR, nowSeconds: 1, selectedId: null, quality: 1 };
}
const lookX: OrbitState = { focus: [1e-6, 0, 0], distance: 1e-6, yaw: Math.PI, pitch: 0 };

/** A DOM canvas stand-in so LabelAtlas is `available` (the real browser case where the bug was visible). */
function stubDocument(): void {
  const g = { clearRect() {}, fillRect() {}, fillText() {}, measureText: () => ({ width: 40 }), set font(_v: string) {}, set textBaseline(_v: string) {}, set fillStyle(_v: string) {} };
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => g }) });
}
afterEach(() => { vi.unstubAllGlobals(); });

function meshes(h: HighlightMarkers): THREE.Mesh[] { return h.group.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh); }

describe('HighlightMarkers: nothing to draw -> no visible mesh and no draw call', () => {
  for (const withDom of [false, true]) {
    it(`${withDom ? 'with a DOM (labels available)' : 'without a DOM'}: empty, then highlights, then empty again`, () => {
      if (withDom) stubDocument();
      const hl = new HighlightMarkers();
      hl.update(ctx(lookX));
      expect(hl.stats().drawCalls).toBe(0);
      expect(meshes(hl).filter((m) => m.visible)).toHaveLength(0);
      // a labelled highlight in view: rings (+ label when available)
      hl.setHighlights([{ id: 'gaia:1', xyzPc: [10, 0, 0], label: 'Alpha' }]);
      hl.update(ctx(lookX));
      expect(hl.stats().drawCalls).toBe(withDom ? 2 : 1);
      // cleared: back to zero, including the label mesh and the stale label box
      hl.setHighlights([]);
      hl.update(ctx(lookX));
      expect(hl.stats().drawCalls).toBe(0);
      expect(meshes(hl).filter((m) => m.visible)).toHaveLength(0);
      // a highlight that is off screen (behind the camera) draws nothing either
      hl.setHighlights([{ id: 'gaia:2', xyzPc: [-10, 0, 0], label: 'Behind' }]);
      hl.update(ctx(lookX));
      expect(hl.stats().drawCalls).toBe(0);
      expect(meshes(hl).filter((m) => m.visible)).toHaveLength(0);
    });
  }
  it('a selection proxy with a label is one ring + one halo + one label draw; cleared, zero again', () => {
    stubDocument();
    const hl = new HighlightMarkers();
    hl.setSelection({ id: 'gaia:9', xyzPc: [20, 0, 0], label: 'Faint dwarf', absoluteMag: 16.5 });
    hl.update(ctx(lookX));
    expect(hl.stats().drawCalls).toBe(3);
    hl.setSelection(null);
    hl.update(ctx(lookX));
    expect(hl.stats().drawCalls).toBe(0);
    expect(meshes(hl).filter((m) => m.visible)).toHaveLength(0);
  });
});

describe.skipIf(!have('bright-stars.v1.json.gz'))('bright stars: the engine and the renderer agree on what is placed', () => {
  const file = readGz<BrightStarFile>('bright-stars.v1.json.gz');
  const recs = recordsFromBrightStars(file);
  const set = buildBrightStarSet(file, () => false);                  // nothing is drawn by Gaia: every placeable star is placed by the supplement
  const placed = new Map(set.stars.map((s) => [s.id, s] as const));

  it('a record has a distance iff the renderer places the star; the distances are identical; low-reliability stars carry the note', () => {
    expect(placed.size).toBeGreaterThan(5000);
    let withDistance = 0;
    for (const r of recs) {
      const s = placed.get(r.id);
      expect(r.measurements.distancePc !== undefined, r.id).toBe(s !== undefined);
      if (s) {
        withDistance++;
        expect(r.measurements.distancePc!.value, r.id).toBeCloseTo(s.distancePc, 9);
        expect(r.measurements.distancePc!.kind).toBe('derived');
        expect(r.position.kind).toBe('icrs');
        expect(r.measurements.distancePc!.note === 'low reliability: parallax S/N < 10', r.id).toBe(s.lowReliability);
        if (s.lowReliability) expect(r.measurements.distancePc!.uncertainty, r.id).toBeGreaterThan(0);
      } else {
        expect(r.position.kind, r.id).toBe('sky-only');
      }
    }
    expect(withDistance).toBe(placed.size);
  });

  it('Betelgeuse: placed and flagged (S/N 7.9) with an uncertainty from the parallax error; Alnilam (S/N 3.7): not drawn, sky-only', () => {
    const b = placed.get('hip:27989')!;
    expect(b.lowReliability).toBe(true);
    const rb = recs.find((r) => r.id === 'hip:27989')!;
    expect(rb.measurements.distancePc!.note).toBe('low reliability: parallax S/N < 10');
    expect(rb.measurements.distancePc!.uncertainty!).toBeCloseTo((1000 * 0.83) / (6.55 * 6.55), 6);
    expect(rb.drawn).toBe(true);
    expect(placed.has('hip:26311')).toBe(false);
    const ra = recs.find((r) => r.id === 'hip:26311')!;
    expect(ra.position.kind).toBe('sky-only');
    expect(ra.measurements.distancePc).toBeUndefined();
    expect(ra.drawn).toBe(false);
    expect(set.skipped.unplacedNamed).toContain('Alnilam');
  });

  it('the shared brightPlacement rule is what both use', () => {
    expect(brightPlacement(6.55, 0.83, true)!.placement).toBe('marginal-named');
    expect(brightPlacement(6.55, 0.83, false)).toBeNull();
    expect(brightPlacement(1.65, 0.45, true)).toBeNull();
  });

  it('pickDistance: the screen distance of the star as drawn; Infinity for an unknown id', () => {
    const layer = new BrightStarLayer(file, () => false);
    const state: OrbitState = { focus: [1e-6, 0, 0], distance: 1e-6, yaw: Math.PI, pitch: 0 };
    const c = ctx(state);
    layer.update(c.camPc);
    // look straight at Sirius: it sits at the screen centre
    const sirius = layer.starOf('hip:32349')!;
    const u = sirius.xyzPc.map((v) => v / sirius.distancePc) as [number, number, number];
    const look: OrbitState = { focus: [u[0] * 1e-6, u[1] * 1e-6, u[2] * 1e-6], distance: 1e-6, yaw: Math.atan2(-u[1], -u[0]), pitch: Math.asin(-u[2]) };
    const c2 = ctx(look);
    layer.update(c2.camPc);
    const vp = { width: VP.width, height: VP.height };
    expect(layer.pickDistance('hip:32349', VP.width / 2, VP.height / 2, { basis: c2.basis, viewport: vp })).toBeLessThan(1);
    expect(layer.pickDistance('hip:32349', VP.width / 2 + 30, VP.height / 2 + 40, { basis: c2.basis, viewport: vp })).toBeCloseTo(50, 0);
    expect(layer.pickDistance('hip:nope', 0, 0, { basis: c2.basis, viewport: vp })).toBe(Infinity);
    expect(layer.pickDistance('gaia:1', 0, 0, { basis: c2.basis, viewport: vp })).toBe(Infinity);
    expect(layer.pick(VP.width / 2 + 3, VP.height / 2 + 2, { basis: c2.basis, viewport: vp, camPc: c2.camPc })).toBe('hip:32349');
    layer.dispose();
  });
});

describe('OtherObjectMarkers: no label placed -> the label mesh is not visible (it would cost a draw call for hidden instances)', () => {
  const others: OtherObjectsFile = {
    manifest: { schema: 'atlas-other-objects/1', generated: 'x', note: 'x' },
    objects: [{ id: 'other:a', name: 'Alpha Obj', designations: [], category: 'other', classification: 'x', raDeg: 0, decDeg: 0, distance: { value: 2, unit: 'kpc', kind: 'observed', source: { label: 'x', url: 'x', retrieved: 'x' } }, coordinateSource: { label: 'x', url: 'x', retrieved: 'x' }, facts: [] }],
  };
  it('looking away from every object: zero draw calls and no visible mesh; looking at one: points + label', () => {
    stubDocument();
    const o = new OtherObjectMarkers();
    o.setOthers(others);
    const away: OrbitState = { focus: [-1e-6, 0, 0], distance: 1e-6, yaw: 0, pitch: 0 };
    o.update(ctx(away));
    expect(o.stats().drawCalls).toBe(0);
    expect(o.group.children.filter((c) => c instanceof THREE.Mesh && c.visible)).toHaveLength(0);
    o.update(ctx({ focus: [1e-6, 0, 0], distance: 1e-6, yaw: Math.PI, pitch: 0 }));
    expect(o.stats().drawCalls).toBe(2);
    expect(o.group.children.filter((c) => c instanceof THREE.Mesh && c.visible)).toHaveLength(2);
  });
});

describe('the inspector model states the low-reliability caveat of a distance in the row itself', () => {
  it('Betelgeuse-like record: the distance field carries the note as visible detail', async () => {
    const { inspectDiscoveryRecord } = await import('../src/data/catalogue/inspect');
    const f: BrightStarFile = { manifest: {} as never, columns: { hip: [27989], raDeg: [88.79], decDeg: [7.4], parallaxMas: [6.55], parallaxErrMas: [0.83], vMag: [0.45], iauName: ['Betelgeuse'] } };
    const rec = recordsFromBrightStars(f)[0]!;
    const model = inspectDiscoveryRecord(rec);
    const dist = model.sections.flatMap((s) => s.fields).filter((x) => x.key === 'distancePc');
    expect(dist.length).toBeGreaterThan(0);
    for (const d of dist) { expect(d.available).toBe(true); expect(d.detail).toBe('low reliability: parallax S/N < 10'); expect(d.kind).toBe('derived'); expect(d.uncertainty).toBeDefined(); }
  });
});
