import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DeepSpaceData } from '../src/data/deepspace';
import type { DeepImageProvenanceFile, DeepSpaceFile } from '../src/data/deepspace/types';
import { eastUnit, northUnit } from '../src/core/astro/coordinates';
import { placeImage } from '../src/render/deep-space/galaxyGeometry';
import { distanceMetres } from '../src/core/deepspace/geometry';
import { METRES_PER_PARSEC } from '../src/core/units';

const have = existsSync('public/data/deep-space.v1.json') && existsSync('public/deepspace/provenance.json');
const d = describe.skipIf(!have);

/**
 * The Hubble PHAT picture of M31 is a tilted 58' x 18.5' strip (archive: "North is 123.5 deg right of vertical"). Seen from the Sun, the deprojected
 * placement must put each corner of the strip at the sky position the archive metadata gives it, i.e. the strip must lie where the real
 * field is, along the major axis, north-east of the nucleus.
 */
d('M31 PHAT strip placement', () => {
  const file = JSON.parse(readFileSync('public/data/deep-space.v1.json', 'utf8')) as DeepSpaceFile;
  const prov = JSON.parse(readFileSync('public/deepspace/provenance.json', 'utf8')) as DeepImageProvenanceFile;
  const data = DeepSpaceData.fromFile(file, prov, { validate: false });
  const m31 = data.get('m31')!;
  const phat = data.imageAssetsOf('m31').find((a) => a.id === 'm31-phat-visible')!;
  const distM = distanceMetres(m31.sky!.distance!).metres;
  const E = eastUnit(m31.sky!.raDeg), N = northUnit(m31.sky!.raDeg, m31.sky!.decDeg);
  const PC = METRES_PER_PARSEC;
  const pl = placeImage(m31, phat);
  const proj = (v: readonly number[]) => [((v[0]! * E[0] + v[1]! * E[1] + v[2]! * E[2]) * PC) / distM * (180 / Math.PI) * 60, ((v[0]! * N[0] + v[1]! * N[1] + v[2]! * N[2]) * PC) / distM * (180 / Math.PI) * 60] as const; // arcmin east, north
  const g = phat.geometry;
  const pa = (g.upPositionAngleDeg * Math.PI) / 180;
  // expected: centre offset on the sky (arcmin, small-angle) plus the rotated half-axes
  const cE = (g.centreRaDeg - m31.sky!.raDeg) * Math.cos((m31.sky!.decDeg * Math.PI) / 180) * 60, cN = (g.centreDecDeg - m31.sky!.decDeg) * 60;
  const upE = Math.sin(pa), upN = Math.cos(pa), rE = -Math.cos(pa), rN = Math.sin(pa);
  const hw = g.fovArcmin[0] / 2, hh = g.fovArcmin[1] / 2;

  it('the strip centre and all four corners project (from the Sun) onto the archive sky positions, within 0.3 arcmin', () => {
    for (const [sx, sy] of [[0, 0], [-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      const p = [0, 1, 2].map((k) => pl.offset[k]! + sx * pl.xAxis[k]! + sy * pl.yAxis[k]!);
      const [pe, pn] = proj(p);
      expect(pe, `east ${sx},${sy}`).toBeCloseTo(cE + sx * hw * rE + sy * hh * upE, 0);
      expect(pn, `north ${sx},${sy}`).toBeCloseTo(cN + sx * hw * rN + sy * hh * upN, 0);
      expect(Math.hypot(pe - (cE + sx * hw * rE + sy * hh * upE), pn - (cN + sx * hw * rN + sy * hh * upN))).toBeLessThan(0.3);
    }
  });

  it('the strip lies along the major axis (PA 35 deg) and north-east of the nucleus, and is tilted with the disc (not facing the Sun)', () => {
    const longPa = (Math.atan2(rE, rN) * 180) / Math.PI;
    expect(Math.abs(longPa - 35)).toBeLessThan(3);
    expect(cE).toBeGreaterThan(0); expect(cN).toBeGreaterThan(0);
    expect(pl.kind).toBe('deprojected-disc');
    expect(pl.tiltIsChoice).toBe(true); // near side unknown: the sign of the tilt is a flagged choice
  });
});
