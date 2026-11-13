/**
 * Which Hipparcos bright stars get a 3D position: ONE rule shared by the engine (records.ts recordsFromBrightStars) and the renderer
 * (src/render/discovery/brightStarSet.ts), so the atlas never reports a distance for a star it does not draw, nor draws one it calls "sky only".
 *
 *  parallax S/N >= 10             'reliable'        placed.
 *  S/N in [5, 10) and an IAU name 'marginal-named'  placed, flagged low reliability (Betelgeuse 7.9, Antares 5.9 ...): the simple inverse is biased at this S/N
 *                                                   (Bailer-Jones 2015), so the engine records a 'derived' distance with its parallax-error uncertainty and a note.
 *  everything else                not placed (unnamed marginal, S/N < 5, parallax <= 0, missing): sky-only, inspect-only.
 */
import { parallaxToDistance, type DistanceStatus } from '../core/astro/parallax';

export type BrightPlacement = 'reliable' | 'marginal-named';

/** Parallax S/N below which a NAMED star is still not placed (default 5 = the parallax.ts marginal limit). */
export const NAMED_MIN_SNR = 5;

/** The statement attached to the distance of a marginal-named star. */
export const LOW_RELIABILITY_NOTE = 'low reliability: parallax S/N < 10';

/** Decide the placement class of one parallax measurement (pure). null = not placed. `sigmaPc` is the first-order uncertainty from the parallax error. */
export function brightPlacement(parallaxMas: number | null, errMas: number | null, named: boolean, namedMinSnr = NAMED_MIN_SNR): { placement: BrightPlacement; distancePc: number; sigmaPc: number | undefined; status: DistanceStatus } | null {
  const d = parallaxToDistance(parallaxMas, errMas);
  if (d.status === 'reliable') return { placement: 'reliable', distancePc: d.distancePc!, sigmaPc: d.sigmaPc, status: d.status };
  if (d.status === 'marginal' && named) return { placement: 'marginal-named', distancePc: d.distancePc!, sigmaPc: d.sigmaPc, status: d.status };
  // optional looser limit for named stars (the default 5 never reaches this branch)
  if (named && namedMinSnr < NAMED_MIN_SNR && parallaxMas !== null && errMas !== null && parallaxMas > 0 && errMas > 0 && parallaxMas / errMas >= namedMinSnr) {
    return { placement: 'marginal-named', distancePc: 1000 / parallaxMas, sigmaPc: (1000 * errMas) / (parallaxMas * parallaxMas), status: 'unreliable' };
  }
  return null;
}
