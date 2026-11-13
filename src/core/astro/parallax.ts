import { PC_MAS } from './constants';

/**
 * Parallax -> distance, with explicit reliability classes.
 *
 * Rules (documented in docs/SCIENTIFIC_DATA.md):
 *  - Missing parallax is NEVER zero distance and NEVER infinity: the star has no distance here.
 *  - A parallax <= 0 has no physical distance (noise), so no distance is produced.
 *  - The simple inverse d = 1000/parallax is only used when parallax/error >= 5. It is a biased
 *    estimator at low signal-to-noise (Bailer-Jones 2015, PASP 127, 994); 'marginal' (5..10)
 *    values are therefore flagged and never presented as confirmed.
 *  - No parallax zero-point correction is applied (the Lindegren et al. 2021 correction needs
 *    extra columns). The global offset is about -0.017 mas.
 */
export type DistanceStatus = 'reliable' | 'marginal' | 'unreliable' | 'invalid' | 'missing';

export const RELIABLE_PARALLAX_SNR = 10;
export const MARGINAL_PARALLAX_SNR = 5;

export interface ParallaxDistance {
  readonly status: DistanceStatus;
  /** Distance in parsecs; present only for 'reliable' and 'marginal'. */
  readonly distancePc?: number;
  /** 1-sigma interval from 1000/(plx +/- sigma). */
  readonly lowerPc?: number;
  readonly upperPc?: number;
  /** First-order symmetric uncertainty 1000*sigma/plx^2, pc. */
  readonly sigmaPc?: number;
  readonly parallaxOverError?: number;
  readonly note: string;
}

const present = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x);

export function parallaxToDistance(
  parallaxMas: number | null | undefined,
  errorMas: number | null | undefined,
): ParallaxDistance {
  if (!present(parallaxMas)) return { status: 'missing', note: 'No parallax in the catalogue for this source.' };
  if (!present(errorMas) || errorMas <= 0) {
    return { status: 'invalid', note: 'Parallax present but its uncertainty is missing or non-positive.' };
  }
  const snr = parallaxMas / errorMas;
  if (parallaxMas <= 0) {
    return { status: 'unreliable', parallaxOverError: snr, note: 'Parallax is not positive; no physical distance can be inferred.' };
  }
  if (snr < MARGINAL_PARALLAX_SNR) {
    return { status: 'unreliable', parallaxOverError: snr, note: `Parallax/error = ${snr.toFixed(2)} (< ${MARGINAL_PARALLAX_SNR}); distance not inferred.` };
  }
  const distancePc = PC_MAS / parallaxMas;
  const lowerPc = PC_MAS / (parallaxMas + errorMas);
  const upperPc = PC_MAS / (parallaxMas - errorMas);
  const sigmaPc = (PC_MAS * errorMas) / (parallaxMas * parallaxMas);
  const status: DistanceStatus = snr >= RELIABLE_PARALLAX_SNR ? 'reliable' : 'marginal';
  return {
    status,
    distancePc,
    lowerPc,
    upperPc,
    sigmaPc,
    parallaxOverError: snr,
    note:
      status === 'reliable'
        ? 'd = 1000 / parallax (no zero-point correction).'
        : `Marginal: parallax/error = ${snr.toFixed(2)}; the inverse-parallax distance is biased at this precision.`,
  };
}
