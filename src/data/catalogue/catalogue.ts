import { equatorialToGalactic, equatorialToUnit } from '../../core/astro/coordinates';
import { GAIA_REFERENCE_EPOCH as EPOCH } from './columns';
import { parallaxToDistance, type DistanceStatus, type ParallaxDistance } from '../../core/astro/parallax';
import { absoluteMagnitude, colourIndex, magnitudeErrorFromFluxSnr } from '../../core/astro/photometry';
import { METRES_PER_PARSEC } from '../../core/units';
import type { CelestialObject, Measurement, SourceRef } from '../schema';
import { GAIA_COLUMN_UNITS, GAIA_NUMERIC_COLUMNS, type GaiaNumericColumn } from './columns';
import { qualityFlags, type GaiaRecord, type QualityFlag } from './flags';
import { NEIGHBOURHOOD_FRAME } from './frames';
import { DATASET_FORMAT_VERSION, GAIA_FORMAT, type GaiaDatasetFile, type GaiaManifest, type SimbadCrossIdFile, type SimbadEntry } from './types';

const STATUS_CODE: Readonly<Record<DistanceStatus, number>> = { reliable: 0, marginal: 1, unreliable: 2, invalid: 3, missing: 4 };
const STATUS_NAME: readonly DistanceStatus[] = ['reliable', 'marginal', 'unreliable', 'invalid', 'missing'];

const EPOCH_LABEL = `J${EPOCH.toFixed(1)}`;
const LN10_5 = 5 / Math.LN10;

/** Columnar, browser-side view of the Gaia subset. NaN in a typed array means "not in the catalogue". */
export class GaiaCatalogue {
  readonly count: number;
  private readonly cols = {} as Record<GaiaNumericColumn, Float64Array>;
  private readonly distPc: Float64Array;
  private readonly distStatus: Uint8Array;
  private readonly index = new Map<string, number>();

  private constructor(readonly file: GaiaDatasetFile) {
    this.count = file.sourceId.length;
    for (const c of GAIA_NUMERIC_COLUMNS) {
      const src = file.columns[c];
      if (src.length !== this.count) throw new Error(`Column ${c} has ${src.length} rows, expected ${this.count}`);
      const a = new Float64Array(this.count);
      for (let i = 0; i < this.count; i++) a[i] = src[i] === null ? NaN : (src[i] as number);
      this.cols[c] = a;
    }
    this.distPc = new Float64Array(this.count).fill(NaN);
    this.distStatus = new Uint8Array(this.count);
    for (let i = 0; i < this.count; i++) {
      const d = parallaxToDistance(this.value('parallax', i), this.value('parallax_error', i));
      this.distStatus[i] = STATUS_CODE[d.status];
      if (d.distancePc !== undefined) this.distPc[i] = d.distancePc;
      this.index.set(file.sourceId[i]!, i);
    }
  }

  static fromFile(file: unknown): GaiaCatalogue {
    const f = file as Partial<GaiaDatasetFile> | null;
    if (!f || f.format !== GAIA_FORMAT) throw new Error('Not an Atlas Gaia column dataset');
    if (f.formatVersion !== DATASET_FORMAT_VERSION) throw new Error(`Unsupported dataset format version ${String(f.formatVersion)}`);
    if (!f.manifest || !f.sourceId || !f.columns || !f.duplicatedSource) throw new Error('Dataset file is incomplete');
    if (f.duplicatedSource.length !== f.sourceId.length) throw new Error('duplicatedSource length mismatch');
    return new GaiaCatalogue(f as GaiaDatasetFile);
  }

  get manifest(): GaiaManifest { return this.file.manifest; }
  sourceId(i: number): string { return this.file.sourceId[i]!; }
  indexOf(sourceId: string): number { return this.index.get(sourceId) ?? -1; }

  /** Value or null (never NaN, never a zero stand-in). */
  value(col: GaiaNumericColumn, i: number): number | null {
    const v = this.cols[col][i]!;
    return Number.isNaN(v) ? null : v;
  }

  /** Raw column for bulk work. NaN = missing. */
  column(col: GaiaNumericColumn): Float64Array { return this.cols[col]; }

  record(i: number): GaiaRecord {
    const values = {} as Record<GaiaNumericColumn, number | null>;
    for (const c of GAIA_NUMERIC_COLUMNS) values[c] = this.value(c, i);
    return { sourceId: this.sourceId(i), values, duplicatedSource: this.file.duplicatedSource[i] ?? null };
  }

  distanceStatus(i: number): DistanceStatus { return STATUS_NAME[this.distStatus[i]!]!; }
  distanceInfo(i: number): ParallaxDistance { return parallaxToDistance(this.value('parallax', i), this.value('parallax_error', i)); }
  /** Distance in pc if a distance was inferred (reliable or marginal), else null. */
  distancePc(i: number): number | null { const d = this.distPc[i]!; return Number.isNaN(d) ? null : d; }
  flags(i: number): QualityFlag[] { return qualityFlags(this.record(i), this.distanceInfo(i)); }

  /** Heliocentric ICRS Cartesian position in parsecs, or null when no distance was inferred. */
  positionPc(i: number): [number, number, number] | null {
    const d = this.distancePc(i);
    if (d === null) return null;
    const u = equatorialToUnit(this.cols.ra[i]!, this.cols.dec[i]!);
    return [u[0] * d, u[1] * d, u[2] * d];
  }

  /** Same position in metres in the stellar-neighbourhood frame (origin: the Sun, ICRS axes). */
  positionMetres(i: number): [number, number, number] | null {
    const p = this.positionPc(i);
    return p ? [p[0] * METRES_PER_PARSEC, p[1] * METRES_PER_PARSEC, p[2] * METRES_PER_PARSEC] : null;
  }

  /** Derived absolute G magnitude (no extinction), or null. */
  absoluteGMag(i: number): number | null {
    const d = this.distancePc(i);
    const g = this.value('phot_g_mean_mag', i);
    return d === null || g === null ? null : absoluteMagnitude(g, d);
  }

  bpRp(i: number): number | null {
    const c = colourIndex(this.value('phot_bp_mean_mag', i), this.value('phot_rp_mean_mag', i), null, null);
    return c ? c.value : null;
  }

  private source(sourceId: string): SourceRef {
    const m = this.manifest;
    return { source: 'gaia-dr3', release: m.catalogue.release, recordId: sourceId, url: m.catalogue.archive, retrieved: m.retrieval.retrievedAt.slice(0, 10) };
  }

  /** Full, sourced scientific record for one catalogue entry. Missing quantities are listed in `unavailable`, not zero-filled. */
  toObject(i: number, simbad?: SimbadCrossIdFile | null): CelestialObject {
    const id = this.sourceId(i);
    const src = this.source(id);
    const v = (c: GaiaNumericColumn) => this.value(c, i);
    const m: Record<string, Measurement> = {};
    const unavailable: Record<string, string> = {};
    const flags = this.flags(i);
    const dist = this.distanceInfo(i);

    const observed = (col: GaiaNumericColumn, errCol: GaiaNumericColumn | null, extra: Partial<Measurement> = {}): Measurement | null => {
      const value = v(col);
      if (value === null) return null;
      const unc = errCol ? v(errCol) : null;
      return {
        value, unit: GAIA_COLUMN_UNITS[col], kind: 'observed', source: src, epoch: EPOCH_LABEL,
        ...(unc !== null ? { uncertainty: unc } : {}),
        ...extra,
      };
    };

    const ra = v('ra'), dec = v('dec');
    const raM = observed('ra', 'ra_error', { uncertaintyUnit: 'mas', note: 'Position at the Gaia DR3 reference epoch; uncertainty is on RA*cos(dec).' });
    const decM = observed('dec', 'dec_error', { uncertaintyUnit: 'mas' });
    if (raM) m['ra'] = raM;
    if (decM) m['dec'] = decM;
    if (ra !== null && dec !== null) {
      const g = equatorialToGalactic(ra, dec);
      const t = ['ICRS (alpha, delta) -> Galactic (l, b) by the Hipparcos/Gaia rotation matrix'];
      m['gal_l'] = { value: g.lDeg, unit: 'deg', kind: 'derived', source: src, transformations: t, epoch: EPOCH_LABEL };
      m['gal_b'] = { value: g.bDeg, unit: 'deg', kind: 'derived', source: src, transformations: t, epoch: EPOCH_LABEL };
    }

    const plx = observed('parallax', 'parallax_error', { note: 'No parallax zero-point correction applied.' });
    if (plx) m['parallax']= plx; else unavailable['parallax'] = 'No parallax in the Gaia catalogue for this source.';
    const pmra = observed('pmra', 'pmra_error', { note: 'mu_alpha* = mu_alpha cos(dec)' });
    const pmdec = observed('pmdec', 'pmdec_error');
    if (pmra) m['pmra'] = pmra;
    if (pmdec) m['pmdec'] = pmdec;
    if (!pmra || !pmdec) unavailable['proper_motion'] = 'No proper motion in the catalogue (2-parameter solution or not fitted).';

    for (const [key, col, snr] of [
      ['g_mag', 'phot_g_mean_mag', 'phot_g_mean_flux_over_error'],
      ['bp_mag', 'phot_bp_mean_mag', 'phot_bp_mean_flux_over_error'],
      ['rp_mag', 'phot_rp_mean_mag', 'phot_rp_mean_flux_over_error'],
    ] as const) {
      const value = v(col);
      if (value === null) { unavailable[key] = `No ${key.slice(0, 2).toUpperCase()} photometry in the catalogue.`; continue; }
      const s = v(snr);
      const sigma = s === null ? null : magnitudeErrorFromFluxSnr(s);
      m[key] = {
        value, unit: 'mag', kind: 'observed', source: src,
        ...(sigma !== null ? { uncertainty: sigma, note: `Uncertainty derived from ${snr}: sigma = 1.0857/SNR (excludes zero-point calibration).` } : {}),
      };
    }
    const bp = v('phot_bp_mean_mag'), rp = v('phot_rp_mean_mag');
    if (bp !== null && rp !== null) {
      const sb = v('phot_bp_mean_flux_over_error'), sr = v('phot_rp_mean_flux_over_error');
      const eb = sb === null ? null : magnitudeErrorFromFluxSnr(sb), er = sr === null ? null : magnitudeErrorFromFluxSnr(sr);
      const c = colourIndex(bp, rp, eb, er)!;
      m['bp_rp'] = {
        value: c.value, unit: 'mag', kind: 'derived', source: src,
        transformations: ['BP - RP from phot_bp_mean_mag and phot_rp_mean_mag', ...(c.sigma !== null ? ['uncertainty: quadrature sum of the two magnitude uncertainties'] : [])],
        ...(c.sigma !== null ? { uncertainty: c.sigma } : {}),
      };
    } else unavailable['bp_rp'] = 'Colour needs both BP and RP photometry; at least one is missing.';

    let distance: Measurement | undefined;
    if (dist.status === 'reliable' || dist.status === 'marginal') {
      distance = {
        value: dist.distancePc!, unit: 'pc', uncertainty: dist.sigmaPc!, kind: 'derived', source: src, epoch: EPOCH_LABEL,
        transformations: ['d = 1000 / parallax[mas] (inverse parallax)', 'uncertainty: first order, 1000*sigma_parallax/parallax^2', 'no zero-point correction, no prior'],
        note: dist.note,
      };
      const g = v('phot_g_mean_mag');
      if (g !== null) {
        const sg = v('phot_g_mean_flux_over_error');
        const sigGmaybe = sg === null ? null : magnitudeErrorFromFluxSnr(sg);
        const sigG = sigGmaybe ?? 0;
        const rel = dist.sigmaPc! / dist.distancePc!;
        m['abs_g_mag'] = {
          value: absoluteMagnitude(g, dist.distancePc!), unit: 'mag', kind: 'derived', source: src,
          uncertainty: Math.hypot(sigG, LN10_5 * rel),
          transformations: ['M_G = G - 5 log10(d) + 5', 'd from inverse parallax', 'interstellar extinction NOT applied'],
          ...(sigGmaybe === null ? { note: 'Uncertainty is the parallax contribution only: no usable G flux S/N in the catalogue.' } : {}),
        };
      }
    } else {
      unavailable['distance'] = dist.note;
    }

    const teff = v('teff_gspphot');
    if (teff !== null) {
      const lo = v('teff_gspphot_lower'), hi = v('teff_gspphot_upper');
      m['teff_gspphot'] = {
        value: teff, unit: 'K', kind: 'modelled', source: src,
        ...(lo !== null && hi !== null ? { uncertainty: (hi - lo) / 2, note: `GSP-Phot model estimate; 16th-84th percentile range ${lo.toFixed(0)}-${hi.toFixed(0)} K (uncertainty shown is the half-width).` } : { note: 'GSP-Phot model estimate (no interval available).' }),
      };
    } else unavailable['teff_gspphot'] = 'No GSP-Phot temperature estimate in the catalogue for this source.';

    const ruwe = v('ruwe');
    if (ruwe !== null) {
      m['ruwe'] = { value: ruwe, unit: 'dimensionless', kind: 'observed', source: src, note: 'Fit statistic computed by Gaia DPAC and published in the catalogue (Atlas does not derive it). Near 1 is a good single-star fit; above 1.4 is suspect.' };
    }

    const entry: SimbadEntry | undefined = simbad?.entries[id];
    const hip = v('hip_id');
    const designations = [`Gaia DR3 ${id}`, ...(hip !== null ? [`HIP ${hip}`] : []), ...(entry ? [entry.m, ...entry.i.filter((x) => !x.startsWith('Gaia DR3'))] : [])];
    const proper = entry?.i.find((x) => x.startsWith('NAME '))?.slice(5);
    const otype = entry?.t;
    const star = otype !== undefined && !otype.endsWith('?') && (otype.startsWith('*') || otype.endsWith('*'));

    return {
      id: `gaia-dr3-${id}`,
      name: proper ?? entry?.m ?? `Gaia DR3 ${id}`,
      designations: [...new Set(designations)],
      classification: star ? 'star' : 'other',
      frame: NEIGHBOURHOOD_FRAME,
      ...(ra !== null && dec !== null ? { sky: { raDeg: ra, decDeg: dec, ...(distance ? { distance } : {}) } } : {}),
      referenceFrame: `ICRS, ${EPOCH_LABEL}`,
      measurements: m,
      unavailable,
      qualityFlags: flags,
      confidence: 'catalogued',
      ...(entry
        ? {
            identification: {
              mainId: entry.m, objectType: entry.t,
              ...(simbad?.otypes[entry.t] ? { objectTypeLabel: simbad.otypes[entry.t]!.label } : {}),
              ...(entry.sp ? { spectralType: entry.sp } : {}),
              ...(entry.c ? { coordinateReference: entry.c } : {}),
              source: { source: 'simbad', recordId: `Gaia DR3 ${id}`, url: simbad!.manifest.service.endpoint, retrieved: simbad!.manifest.retrievedAt.slice(0, 10) },
            },
          }
        : {}),
      notes: entry
        ? 'Astrometry and photometry are from Gaia DR3; identification and classification are from SIMBAD.'
        : 'Gaia DR3 source without a SIMBAD identification in this dataset. It is not classified as a star by Atlas.',
    };
  }
}
