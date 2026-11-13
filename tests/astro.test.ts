import { describe, expect, it } from 'vitest';
import {
  absoluteMagnitude, angularSeparationDeg, apparentMagnitudeAt, colourIndex, equatorialToGalactic,
  equatorialToUnit, fluxRatio, galacticToEquatorial, magnitudeErrorFromFluxSnr, parallaxToDistance,
  propagateProperMotion, sphericalToCartesian, tangentialVelocityKmS, unitToEquatorial, validEquatorial,
  icrsToGalacticVector, galacticToIcrsVector, ICRS_TO_GALACTIC, MAS_PER_DEG,
} from '../src/core/astro';
import { length } from '../src/core/spatial/vec3';

describe('equatorial <-> cartesian', () => {
  it('maps cardinal directions', () => {
    expect(equatorialToUnit(0, 0)).toEqual([1, 0, 0]);
    const y = equatorialToUnit(90, 0);
    expect(y[1]).toBeCloseTo(1, 12);
    expect(equatorialToUnit(0, 90)[2]).toBeCloseTo(1, 12);
    expect(equatorialToUnit(0, -90)[2]).toBeCloseTo(-1, 12);
  });
  it('round-trips random directions and keeps RA in [0,360)', () => {
    for (const [ra, dec] of [[0.5, 0], [359.9, 12], [180, -89.9], [123.456, 45.678], [270, 0]] as const) {
      const back = unitToEquatorial(equatorialToUnit(ra, dec));
      expect(back.raDeg).toBeCloseTo(ra, 9);
      expect(back.decDeg).toBeCloseTo(dec, 9);
      expect(back.raDeg).toBeGreaterThanOrEqual(0);
      expect(back.raDeg).toBeLessThan(360);
    }
  });
  it('scales to the requested distance and preserves unit choice', () => {
    expect(length(sphericalToCartesian(40, 20, 25))).toBeCloseTo(25, 10);
    expect(length(sphericalToCartesian(40, 20, 1e19))).toBeCloseTo(1e19, 3);
  });
  it('rejects a zero vector', () => {
    expect(() => unitToEquatorial([0, 0, 0])).toThrow();
  });
  it('validates ranges (degrees, not radians)', () => {
    expect(validEquatorial(10, 20)).toBe(true);
    expect(validEquatorial(360, 0)).toBe(false);
    expect(validEquatorial(-1, 0)).toBe(false);
    expect(validEquatorial(10, 90.5)).toBe(false);
    expect(validEquatorial(NaN, 0)).toBe(false);
  });
});

describe('galactic transformation', () => {
  it('matrix is orthonormal with determinant +1', () => {
    const m = ICRS_TO_GALACTIC;
    for (let i = 0; i < 3; i++) {
      expect(length(m[i]!)).toBeCloseTo(1, 12);
      for (let j = i + 1; j < 3; j++) {
        const dot = m[i]![0] * m[j]![0] + m[i]![1] * m[j]![1] + m[i]![2] * m[j]![2];
        expect(Math.abs(dot)).toBeLessThan(1e-12);
      }
    }
    const [a, b, c] = m;
    const det =
      a![0] * (b![1] * c![2] - b![2] * c![1]) - a![1] * (b![0] * c![2] - b![2] * c![0]) + a![2] * (b![0] * c![1] - b![1] * c![0]);
    expect(det).toBeCloseTo(1, 12);
  });
  it('places the Galactic centre direction at RA ~266.405, Dec ~-28.936 (IAU definition)', () => {
    const gc = galacticToEquatorial(0, 0);
    expect(gc.raDeg).toBeCloseTo(266.405, 2);
    expect(gc.decDeg).toBeCloseTo(-28.936, 2);
  });
  it('places the north galactic pole at RA ~192.859, Dec ~+27.128 (IAU definition)', () => {
    const ngp = galacticToEquatorial(0, 90);
    expect(ngp.raDeg).toBeCloseTo(192.8595, 3);
    expect(ngp.decDeg).toBeCloseTo(27.1283, 3);
  });
  it('round-trips equatorial -> galactic -> equatorial', () => {
    const { lDeg, bDeg } = equatorialToGalactic(83.633, 22.0145);
    const back = galacticToEquatorial(lDeg, bDeg);
    expect(back.raDeg).toBeCloseTo(83.633, 8);
    expect(back.decDeg).toBeCloseTo(22.0145, 8);
    // The Crab Nebula direction is near l=184.56, b=-5.78 (catalogue values).
    expect(lDeg).toBeCloseTo(184.56, 1);
    expect(bDeg).toBeCloseTo(-5.78, 1);
  });
  it('vector transforms are inverses', () => {
    const v = [0.3, -0.5, 0.81] as const;
    const back = galacticToIcrsVector(icrsToGalacticVector(v));
    expect(back[0]).toBeCloseTo(0.3, 12);
    expect(back[1]).toBeCloseTo(-0.5, 12);
    expect(back[2]).toBeCloseTo(0.81, 12);
  });
});

describe('angular separation', () => {
  it('is zero for identical points, 180 for antipodes, and small-angle accurate', () => {
    expect(angularSeparationDeg(10, 20, 10, 20)).toBe(0);
    expect(angularSeparationDeg(0, 0, 180, 0)).toBeCloseTo(180, 10);
    expect(angularSeparationDeg(0, 0, 1 / 3600, 0) * 3600).toBeCloseTo(1, 8); // 1 arcsec
  });
});

describe('parallax -> distance', () => {
  it('converts a real Gaia DR3 parallax (alpha Phe, 39.918 mas) to ~25 pc', () => {
    const r = parallaxToDistance(39.91825815729799, 0.7283222);
    expect(r.status).toBe('reliable');
    expect(r.distancePc).toBeCloseTo(25.05, 1);
    expect(r.lowerPc!).toBeLessThan(r.distancePc!);
    expect(r.upperPc!).toBeGreaterThan(r.distancePc!);
    expect(r.sigmaPc!).toBeCloseTo((1000 * 0.7283222) / 39.91825815729799 ** 2, 9);
  });
  it('returns missing (not zero, not infinite) when parallax is absent', () => {
    for (const p of [null, undefined, NaN]) {
      const r = parallaxToDistance(p, 0.5);
      expect(r.status).toBe('missing');
      expect(r.distancePc).toBeUndefined();
    }
  });
  it('does not produce a distance for zero or negative parallax', () => {
    for (const p of [0, -0.4]) {
      const r = parallaxToDistance(p, 0.2);
      expect(r.status).toBe('unreliable');
      expect(r.distancePc).toBeUndefined();
    }
  });
  it('classifies by signal-to-noise: reliable >= 10, marginal 5..10, unreliable < 5', () => {
    expect(parallaxToDistance(10, 1).status).toBe('reliable');
    expect(parallaxToDistance(9.99, 1).status).toBe('marginal');
    expect(parallaxToDistance(5, 1).status).toBe('marginal');
    expect(parallaxToDistance(4.99, 1).status).toBe('unreliable');
    expect(parallaxToDistance(4.99, 1).distancePc).toBeUndefined();
  });
  it('marks a parallax without a valid uncertainty as invalid', () => {
    expect(parallaxToDistance(10, null).status).toBe('invalid');
    expect(parallaxToDistance(10, 0).status).toBe('invalid');
    expect(parallaxToDistance(10, -1).status).toBe('invalid');
  });
  it('keeps units honest: 1000 mas = 1 arcsec -> 1 pc; light-year factor is separate', () => {
    expect(parallaxToDistance(1000, 1).distancePc).toBeCloseTo(1, 12);
    expect(MAS_PER_DEG).toBe(3.6e6);
  });
});

describe('proper motion', () => {
  it('moves 1000 mas east in one year at the equator (pmra* is already multiplied by cos dec)', () => {
    const r = propagateProperMotion(10, 0, { pmraMasYr: 1000, pmdecMasYr: 0 }, 1);
    expect(r.raDeg - 10).toBeCloseTo(1000 / MAS_PER_DEG, 9);
    expect(r.decDeg).toBeCloseTo(0, 9);
  });
  it('changes RA by 1/cos(dec) more at high declination for the same pmra*', () => {
    const r = propagateProperMotion(10, 60, { pmraMasYr: 1000, pmdecMasYr: 0 }, 1);
    expect(r.raDeg - 10).toBeCloseTo(1000 / MAS_PER_DEG / Math.cos((60 * Math.PI) / 180), 7);
  });
  it('moves north for positive pmdec and does nothing for zero motion', () => {
    expect(propagateProperMotion(10, 20, { pmraMasYr: 0, pmdecMasYr: 3600000 }, 1).decDeg).toBeCloseTo(21, 4);
    const same = propagateProperMotion(77.7, -33.3, { pmraMasYr: 0, pmdecMasYr: 0 }, 5);
    expect(same.raDeg).toBeCloseTo(77.7, 10);
    expect(same.decDeg).toBeCloseTo(-33.3, 10);
  });
  it('computes tangential velocity (mu=1000 mas/yr at 1 pc = 4.74 km/s)', () => {
    expect(tangentialVelocityKmS(1000, 0, 1)).toBeCloseTo(4.740470446 * 1, 6 - 3);
    expect(tangentialVelocityKmS(3000, 4000, 10)).toBeCloseTo(4.740470446 * 5 * 10, 3);
  });
});

describe('photometry', () => {
  it('distance modulus: m - M = 5 log10(d) - 5, and it is invertible', () => {
    expect(absoluteMagnitude(5, 10)).toBeCloseTo(5, 12);
    expect(absoluteMagnitude(5, 100)).toBeCloseTo(0, 12);
    expect(apparentMagnitudeAt(absoluteMagnitude(7.3, 42.5), 42.5)).toBeCloseTo(7.3, 12);
    expect(() => absoluteMagnitude(5, 0)).toThrow();
  });
  it('five magnitudes is a factor 100 in flux', () => {
    expect(fluxRatio(0, 5)).toBeCloseTo(100, 10);
  });
  it('derives magnitude uncertainty from flux S/N, and null when S/N is unusable', () => {
    expect(magnitudeErrorFromFluxSnr(100)).toBeCloseTo(0.010857, 5);
    expect(magnitudeErrorFromFluxSnr(0)).toBeNull();
    expect(magnitudeErrorFromFluxSnr(NaN)).toBeNull();
  });
  it('computes BP-RP with propagated error and returns null if either band is missing', () => {
    const c = colourIndex(3.0, 2.0, 0.03, 0.04);
    expect(c!.value).toBeCloseTo(1, 12);
    expect(c!.sigma).toBeCloseTo(0.05, 12);
    expect(colourIndex(null, 2, null, null)).toBeNull();
    expect(colourIndex(3, 2, null, 0.1)!.sigma).toBeNull();
  });
});
