/**
 * The Hipparcos bright-star supplement as renderer-ready arrays (pure: no THREE, no DOM). See BrightStarLayer.ts for the drawing.
 *
 * WHICH STARS ARE DRAWN HERE (only those the Gaia layer does not already draw)
 *  The Gaia point layer draws a Gaia record iff it has an inferred distance (parallax S/N >= 5) and a G magnitude (src/render/starLayer.ts).
 *  A Hipparcos row is skipped ('drawnByGaia') when its gaiaSourceId names a record in `drawnGaiaIds`. It is drawn here when
 *    - it has no Gaia link (312 rows in the shipped file: Sirius, Betelgeuse, Vega, ... Gaia has no usable astrometry that bright), or
 *    - its Gaia record exists but the Gaia layer cannot draw it (no distance / no G magnitude): the Hipparcos astrometry then places it.
 *
 * PLACEMENT (same parallax.ts rule, one explicit exception)
 *  d = 1000/parallax is used when parallax/error >= 10 ('reliable', parallaxQuality 'good'). Parallax/error in [5,10) ('marginal') is placed ONLY for
 *  named stars (an IAU proper name) and carries `lowReliability`: it is drawn at the Gaia layer's marginal opacity (MARGINAL_CONFIDENCE) so it is
 *  never mistaken for a firm position. Every other star (unnamed marginal, S/N < 5, parallax <= 0, missing) is NOT placed in 3D, exactly like the
 *  undrawn Gaia stars; the build counts them in `unplaced`. The file's own caveat says not to invert 'poor' parallaxes: the exception is deliberate,
 *  because the named marginal stars are Betelgeuse (S/N 7.9), Antares (5.9) ... whose absence from the 3D sky would be the larger distortion.
 *
 * EPOCH AND POSITION
 *  Catalogue positions are ICRS at J1991.25 (Hipparcos new reduction). They are propagated to J2016.0 (the Gaia DR3 reference epoch, so both layers share one
 *  epoch) by constant proper motion on a great circle with src/core/astro/coordinates.ts propagateProperMotion (zero radial velocity, i.e. no perspective
 *  acceleration; dt = 24.75 yr). Sirius moves 1.34 arcsec/yr, 33 arcsec over dt. Distance is NOT changed over dt.
 *
 * BRIGHTNESS
 *  The brightness shader wants an absolute magnitude; it gets M_V = V - 5 log10 d + 5 and uses it exactly as the Gaia layer uses M_G. V is a STAND-IN for G
 *  (G - V is within about +-0.3 mag for B to M dwarfs): a visual approximation, not photometry. Variability is not modelled.
 */
import { equatorialToUnit, propagateProperMotion } from '../../core/astro/coordinates';
import { absoluteMagnitude } from '../../core/astro/photometry';
import { parallaxToDistance } from '../../core/astro/parallax';
import type { Vec3 } from '../../core/spatial/vec3';
import type { BrightStarFile } from '../../discovery/types';
import { brightPlacement, NAMED_MIN_SNR, type BrightPlacement } from '../../discovery/brightPlacement';
import { colourFromBv } from './brightStarColour';
import { MISSING_COLOUR } from '../starColour';
import type { StarLayer } from '../starLayer';

/** Hipparcos catalogue epoch (J1991.25) and the Gaia DR3 reference epoch the whole atlas uses. */
export { brightPlacement, NAMED_MIN_SNR };
export type { BrightPlacement };
export const HIPPARCOS_EPOCH = 1991.25;
export const TARGET_EPOCH = 2016.0;
/**
 * Opacity factor of a marginal-named star (the Gaia layer uses 0.55 for ALL its marginal stars). Stars of this class are the bright named ones (Betelgeuse, Antares, the
 * Orion belt ...), whose brightness seen FROM the Sun does not depend on the uncertain distance; dimming them as much as faint Gaia stars would make the naked-eye sky
 * wrong, so the factor is milder. The flag `lowReliability` is what marks them, for the atlas text and the UI.
 */
export const BRIGHT_MARGINAL_CONFIDENCE = 0.85;


export interface PlacedBrightStar {
  /** Universal id 'hip:<n>'. */
  readonly id: string;
  readonly hip: number;
  readonly name: string;
  /** Position at J2016.0, Sun-centred ICRS parsecs, float64. */
  readonly xyzPc: Vec3;
  readonly distancePc: number;
  readonly vMag: number;
  readonly absMag: number;
  readonly bv: number | null;
  readonly placement: BrightPlacement;
  readonly lowReliability: boolean;
  /** The Gaia source id the file links this star to (undrawn by the Gaia layer), or null. */
  readonly gaiaSourceId: string | null;
}

export interface BrightStarSkips {
  /** The linked Gaia record is drawn by the Gaia layer. */
  readonly drawnByGaia: number;
  /** Not placed in 3D: no usable parallax by the rule above. */
  readonly unplaced: number;
  /** No V magnitude, or no usable position. */
  readonly noPhotometryOrPosition: number;
  /** Of `unplaced`, those with a parallax S/N between 5 and 10 but no proper name. */
  readonly unplacedMarginalUnnamed: number;
  /** Names (IAU proper names) of the unplaced stars, for the atlas text ('no reliable distance'). */
  readonly unplacedNamed: readonly string[];
}

export interface BrightStarSet {
  readonly stars: readonly PlacedBrightStar[];
  /** Renderer arrays in the shape StarField expects (suspect = all 0). */
  readonly layer: StarLayer;
  readonly skipped: BrightStarSkips;
  readonly rows: number;
}

const fin = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const txt = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);

/** J1991.25 -> J2016.0 position (degrees) by linear proper motion; a star without proper motion keeps its catalogue position. */
export function propagateToTargetEpoch(raDeg: number, decDeg: number, pmraMasYr: number | null, pmdecMasYr: number | null): { raDeg: number; decDeg: number } {
  if (pmraMasYr === null || pmdecMasYr === null) return { raDeg, decDeg };
  return propagateProperMotion(raDeg, decDeg, { pmraMasYr, pmdecMasYr }, TARGET_EPOCH - HIPPARCOS_EPOCH);
}

export function buildBrightStarSet(file: BrightStarFile, isDrawnByGaia: (gaiaSourceId: string) => boolean, opts: { namedMinSnr?: number } = {}): BrightStarSet {
  const c = file.columns;
  const col = (k: string): readonly (number | string | null)[] => c[k] ?? [];
  const hip = col('hip'), ra = col('raDeg'), dec = col('decDeg'), plx = col('parallaxMas'), plxE = col('parallaxErrMas');
  const pmra = col('pmraMasYr'), pmdec = col('pmdecMasYr'), vmag = col('vMag'), bvc = col('bvColour'), iau = col('iauName'), gaia = col('gaiaSourceId');
  const n = hip.length;
  const stars: PlacedBrightStar[] = [];
  let drawnByGaia = 0, unplaced = 0, noPhot = 0, marginalUnnamed = 0;
  const unplacedNamed: string[] = [];
  for (let i = 0; i < n; i++) {
    const h = fin(hip[i]), r = fin(ra[i]), d = fin(dec[i]), v = fin(vmag[i]);
    if (h === null || r === null || d === null || v === null) { noPhot++; continue; }
    const gid = txt(gaia[i]);
    if (gid !== null && isDrawnByGaia(gid)) { drawnByGaia++; continue; }
    const name = txt(iau[i]);
    const p = brightPlacement(fin(plx[i]), fin(plxE[i]), name !== null, opts.namedMinSnr);
    if (p === null) {
      unplaced++;
      if (name !== null) unplacedNamed.push(name);
      if (parallaxToDistance(fin(plx[i]), fin(plxE[i])).status === 'marginal') marginalUnnamed++;
      continue;
    }
    const pos = propagateToTargetEpoch(r, d, fin(pmra[i]), fin(pmdec[i]));
    const u = equatorialToUnit(pos.raDeg, pos.decDeg);
    stars.push({
      id: `hip:${h}`, hip: h, name: name ?? `HIP ${h}`, xyzPc: [u[0] * p.distancePc, u[1] * p.distancePc, u[2] * p.distancePc], distancePc: p.distancePc,
      vMag: v, absMag: absoluteMagnitude(v, p.distancePc), bv: fin(bvc[i]), placement: p.placement, lowReliability: p.placement !== 'reliable', gaiaSourceId: gid,
    });
  }
  const m = stars.length;
  const catalogueIndex = new Uint32Array(m), positionPc = new Float64Array(m * 3), absMag = new Float32Array(m), colour = new Float32Array(m * 3);
  const confidence = new Float32Array(m), suspect = new Uint8Array(m);
  for (let k = 0; k < m; k++) {
    const s = stars[k]!;
    catalogueIndex[k] = s.hip;
    positionPc[3 * k] = s.xyzPc[0]; positionPc[3 * k + 1] = s.xyzPc[1]; positionPc[3 * k + 2] = s.xyzPc[2];
    absMag[k] = s.absMag;
    const rgb = s.bv === null ? MISSING_COLOUR : colourFromBv(s.bv);
    colour[3 * k] = rgb[0]; colour[3 * k + 1] = rgb[1]; colour[3 * k + 2] = rgb[2];
    confidence[k] = s.lowReliability ? BRIGHT_MARGINAL_CONFIDENCE : 1;
  }
  const layer: StarLayer = { count: m, catalogueIndex, positionPc, absMag, colour, confidence, suspect, suspectCount: 0, skipped: { noDistance: unplaced, noGMagnitude: noPhot, outsideExtent: 0 } };
  return { stars, layer, skipped: { drawnByGaia, unplaced, noPhotometryOrPosition: noPhot, unplacedMarginalUnnamed: marginalUnnamed, unplacedNamed }, rows: n };
}

/** The Gaia source ids the Gaia point layer draws, for `isDrawnByGaia`. */
export function drawnGaiaIdSet(cat: { sourceId(i: number): string }, layer: Pick<StarLayer, 'count' | 'catalogueIndex'>): Set<string> {
  const s = new Set<string>();
  for (let k = 0; k < layer.count; k++) s.add(cat.sourceId(layer.catalogueIndex[k]!));
  return s;
}
