import { galacticToIcrsVector } from '../../core/astro/coordinates';
import type { DocumentedModel, ModelParameter } from '../../data/deepspace/types';
import type { Vec3 } from '../../core/spatial/vec3';

/**
 * Density sampler for the Milky Way DOCUMENTED MODEL (public/data/deep-space.v1.json, models['milky-way']).
 *
 * Every scientific number comes from that file (looked up by the parameter's name, so a renamed or missing parameter throws
 * instead of silently falling back to a made-up value). Numbers this file adds itself are in VISUAL below and are
 * presentation choices (how many soft blobs, how soft, how bright), never measurements.
 *
 * What is drawn is a smooth glowing DENSITY made of large soft overlapping splats: NO splat is a star, and no splat position is
 * an observation. The output is deterministic (seeded PRNG).
 *
 * Coordinates. Galactocentric Cartesian g (pc): x from the Galactic Centre toward the Sun's side of the line GC-Sun is NEGATIVE
 * (the Sun is at g = (-R0, 0, 0)), y toward Galactic rotation (l = 90 deg), z toward the north Galactic pole. Sun-centred Galactic
 * Cartesian is s = g + (R0, 0, 0); the renderer rotates s to ICRS with the standard Galactic-ICRS matrix.
 * Reid et al. (2019) azimuth beta is 0 toward the Sun and increases with Galactic rotation: g = (-R cos beta, R sin beta).
 */
export const VISUAL = {
  /** Visual outer edge of the drawn disc, pc. The model gives scale lengths, not a boundary. */
  discRadiusPc: 16_000,
  /** Number of splats (before the quality scaling). */
  splatCount: 6500,
  /** Fractions of the splats in the spiral arms vs. smooth components (arm contrast is a presentation choice). */
  armShare: 0.34,
  /** Splat radii, pc, per component (soft blobs; they must overlap into a smooth glow). */
  radius: { bulge: 450, bar: 420, thin: 1000, thick: 1200, arm: 650 },
  /** Splat peak alpha per component before the view-dependent gain. */
  alpha: { bulge: 0.8, bar: 0.7, thin: 0.9, thick: 0.5, arm: 1.2 },
  /** Colour (linear-ish display values): warm old population, cooler arms. Restrained, not saturated. */
  colour: { bulge: [1.0, 0.8, 0.55], bar: [1.0, 0.82, 0.58], thin: [0.93, 0.86, 0.75], thick: [0.92, 0.78, 0.6], arm: [0.7, 0.8, 0.98] } as Readonly<Record<string, readonly [number, number, number]>>,
  /** Arms are drawn this many degrees beyond the azimuth range of the maser data, with `armExtrapolationGain` of the intensity. */
  armExtrapolationDeg: 75,
  armExtrapolationGain: 0.45,
  /** Axis ratio (minor/major) of the long bar seen from above: the data give length, angle and heights but not its width. */
  longBarAxisRatio: 0.16,
  /** Bulge major scale length as a multiple of the X-shape radius x_X (the review gives the X radius, not a Gaussian scale). */
  bulgeScaleOverXRadius: 0.55,
  /** Peak brightness the view-dependent gain aims for (display value before colour). */
  targetPeak: 0.62,
  /** The exposure gain aims this percentile of the lit pixels (not the maximum) at `targetPeak`, so the core may saturate softly and the disc stays visible. */
  gainPercentile: 0.98,
  seed: 20260511,
} as const;

export type MwComponent = 'bulge' | 'bar' | 'thin' | 'thick' | 'arm';
export const MW_COMPONENTS: readonly MwComponent[] = ['bulge', 'bar', 'thin', 'thick', 'arm'];

export interface MilkyWayParams {
  readonly r0Pc: number;
  readonly thinLengthPc: number; readonly thinHeightPc: number;
  readonly thickLengthPc: number; readonly thickHeightPc: number;
  readonly thinMass: number; readonly thickMass: number;
  readonly bulgeMass: number; readonly barMass: number;
  readonly bulgeAngleDeg: number; readonly bulgeAxisRatioTop: number; readonly bulgeAxisRatioEdge: number;
  readonly bulgeHeightPc: number; readonly xRadiusPc: number;
  readonly barAngleDeg: number; readonly barHalfLengthPc: number; readonly barHeightPc: number;
  readonly armWidthAt8150Pc: number; readonly armWidthSlopePcPerKpc: number;
  readonly arms: readonly ArmFit[];
}
export interface ArmFit {
  readonly name: string; readonly betaMinDeg: number; readonly betaMaxDeg: number; readonly betaKinkDeg: number; readonly rKinkKpc: number;
  readonly psiBelowDeg: number; readonly psiAboveDeg: number; readonly widthKpc: number;
}

function param(model: DocumentedModel, re: RegExp): ModelParameter {
  const hit = model.parameters.filter((p) => re.test(p.name));
  if (hit.length !== 1) throw new Error(`Milky Way model: expected exactly one parameter matching ${re}, found ${hit.length}`);
  return hit[0] as ModelParameter;
}
const toPc = (p: ModelParameter): number => {
  if (p.unit === 'pc') return p.value;
  if (p.unit === 'kpc') return p.value * 1000;
  throw new Error(`Milky Way model: parameter "${p.name}" has unit ${p.unit}, expected pc or kpc`);
};

/** Read every scientific input from the data file's model. */
export function readMilkyWayParams(model: DocumentedModel): MilkyWayParams {
  const t = model.tables?.['spiral-arms-reid2019'];
  if (!t) throw new Error('Milky Way model: table spiral-arms-reid2019 is missing');
  const col = (name: string) => { const i = t.columns.indexOf(name); if (i < 0) throw new Error(`Milky Way model: arm table has no column ${name}`); return i; };
  const num = (v: number | string | undefined): number => (typeof v === 'number' ? v : NaN);
  const ci = { arm: col('arm'), bmin: col('betaMin'), bmax: col('betaMax'), bk: col('betaKink'), rk: col('Rkink'), pb: col('psiBelowKink'), pa: col('psiAboveKink'), w: col('width') };
  const arms: ArmFit[] = t.rows.map((r) => ({
    name: String(r[ci.arm]), betaMinDeg: num(r[ci.bmin]), betaMaxDeg: num(r[ci.bmax]), betaKinkDeg: num(r[ci.bk]), rKinkKpc: num(r[ci.rk]),
    psiBelowDeg: num(r[ci.pb]), psiAboveDeg: num(r[ci.pa]), widthKpc: num(r[ci.w]),
  }));
  for (const a of arms) for (const [k, v] of Object.entries(a)) if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(`Milky Way model: arm ${a.name} has no ${k}`);
  const vvvLow = param(model, /VVV bulge region \(lower end/), vvvHigh = param(model, /VVV bulge region \(upper end/);
  const barLo = param(model, /Long bar angle phi_lb \(lower/), barHi = param(model, /Long bar angle phi_lb \(upper/);
  return {
    r0Pc: toPc(param(model, /GRAVITY 2019/)),
    thinLengthPc: toPc(param(model, /Thin disc exponential scale length/)), thinHeightPc: toPc(param(model, /Thin disc exponential scale height/)),
    thickLengthPc: toPc(param(model, /Thick disc exponential scale length/)), thickHeightPc: toPc(param(model, /Thick disc exponential scale height/)),
    thinMass: param(model, /Thin disc stellar mass/).value, thickMass: param(model, /Thick disc stellar mass/).value,
    bulgeMass: (vvvLow.value + vvvHigh.value) / 2, barMass: param(model, /Thin long bar stellar mass/).value,
    bulgeAngleDeg: param(model, /bar angle phi_bp/).value, bulgeAxisRatioTop: param(model, /bulge axis ratio b\/a seen from the top/).value,
    bulgeAxisRatioEdge: param(model, /bulge edge-on axis ratio c\/a/).value, bulgeHeightPc: toPc(param(model, /bulge vertical scale height/)),
    xRadiusPc: toPc(param(model, /Radius of maximum X-shape/)),
    barAngleDeg: (barLo.value + barHi.value) / 2, barHalfLengthPc: toPc(param(model, /Long bar half-length/)), barHeightPc: toPc(param(model, /Thin long bar vertical scale height/)),
    armWidthAt8150Pc: param(model, /Spiral-arm in-plane width at Galactocentric radius 8\.15 kpc/).value,
    armWidthSlopePcPerKpc: param(model, /Spiral-arm width slope/).value,
    arms,
  };
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = (rnd: () => number): number => { const u = Math.max(rnd(), 1e-12), v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const laplace = (rnd: () => number, scale: number): number => { const u = rnd() - 0.5; return -scale * Math.sign(u) * Math.log(1 - 2 * Math.abs(u) + 1e-12); };

/** Arm centre line R(beta) (kpc) for the log-periodic spiral, beta in radians. */
export function armRadiusKpc(a: ArmFit, betaRad: number): number {
  const bk = (a.betaKinkDeg * Math.PI) / 180;
  const psi = ((betaRad < bk ? a.psiBelowDeg : a.psiAboveDeg) * Math.PI) / 180;
  return a.rKinkKpc * Math.exp(-(betaRad - bk) * Math.tan(psi));
}

export interface MwSplats {
  readonly count: number;
  /** Sun-centred ICRS, parsecs, float64 (3 per splat). */
  readonly positionIcrs: Float64Array;
  /** Galactocentric Cartesian, parsecs (3 per splat), kept for the view-gain table. */
  readonly galactocentric: Float64Array;
  readonly radiusPc: Float32Array;
  readonly alpha: Float32Array;
  readonly colour: Float32Array;
  readonly component: Uint8Array;
}

/** Galactocentric -> Sun-centred ICRS pc (float64). */
export function galactocentricToIcrs(g: Vec3, r0Pc: number): Vec3 {
  return galacticToIcrsVector([g[0] + r0Pc, g[1], g[2]]);
}

/** Sample the model into soft splats. Component weights are the model's stellar masses (equal mass-to-light assumed: VISUAL choice). */
export function sampleMilkyWay(p: MilkyWayParams, count: number = VISUAL.splatCount, seed: number = VISUAL.seed): MwSplats {
  const rnd = mulberry32(seed);
  const Rmax = VISUAL.discRadiusPc;
  const armShare = VISUAL.armShare;
  const smooth = 1 - armShare;
  const mThin = p.thinMass, mThick = p.thickMass, mBulge = p.bulgeMass, mBar = p.barMass;
  const mSum = mThin + mThick + mBulge + mBar;
  const nOf = (m: number) => Math.round((smooth * count * m) / mSum);
  const nThin = nOf(mThin), nThick = nOf(mThick), nBulge = nOf(mBulge), nBar = nOf(mBar);
  const armLenTotal = p.arms.reduce((s, a) => s + armSpanRad(a) * a.rKinkKpc, 0);
  const nArmTotal = Math.round(armShare * count);

  const g: number[] = [], rad: number[] = [], alp: number[] = [], col: number[] = [], comp: number[] = [];
  const push = (c: MwComponent, x: number, y: number, z: number, w = 1) => {
    g.push(x, y, z); rad.push(VISUAL.radius[c]); alp.push(VISUAL.alpha[c] * w); col.push(...VISUAL.colour[c]!); comp.push(MW_COMPONENTS.indexOf(c));
  };
  const disc = (n: number, c: 'thin' | 'thick', L: number, H: number) => {
    for (let i = 0; i < n; i++) {
      let R = 0;
      do { R = -L * (Math.log(Math.max(rnd(), 1e-12)) + Math.log(Math.max(rnd(), 1e-12))); } while (R > Rmax); // surface density ~ exp(-R/L): R is Gamma(2, L)
      const th = rnd() * 2 * Math.PI;
      push(c, R * Math.cos(th), R * Math.sin(th), laplace(rnd, H));
    }
  };
  disc(nThin, 'thin', p.thinLengthPc, p.thinHeightPc);
  disc(nThick, 'thick', p.thickLengthPc, p.thickHeightPc);

  // Triaxial Gaussian with its major axis at angle phi from the GC-Sun line, near end toward positive longitude (+y, -x side).
  const triaxial = (n: number, c: 'bulge' | 'bar', a: number, b: number, h: number, phiDeg: number) => {
    const phi = (phiDeg * Math.PI) / 180;
    const mx = -Math.cos(phi), my = Math.sin(phi); // major axis direction (near end)
    for (let i = 0; i < n; i++) {
      const u = gauss(rnd) * a, v = gauss(rnd) * b, w = gauss(rnd) * h;
      push(c, u * mx - v * my, u * my + v * mx, w);
    }
  };
  const bulgeA = p.xRadiusPc * VISUAL.bulgeScaleOverXRadius;
  triaxial(nBulge, 'bulge', bulgeA, bulgeA * p.bulgeAxisRatioTop, bulgeA * p.bulgeAxisRatioEdge, p.bulgeAngleDeg);
  // Long bar: uniform-ish along its half length (soft ends), thin; the width is a VISUAL ratio.
  {
    const phi = (p.barAngleDeg * Math.PI) / 180, mx = -Math.cos(phi), my = Math.sin(phi);
    for (let i = 0; i < nBar; i++) {
      const u = (rnd() * 2 - 1) * p.barHalfLengthPc, v = gauss(rnd) * p.barHalfLengthPc * VISUAL.longBarAxisRatio * 0.5, w = laplace(rnd, p.barHeightPc);
      push('bar', u * mx - v * my, u * my + v * mx, w);
    }
  }

  // Spiral arms: points along each fitted arm, the Gaussian width law of Reid et al. (2019) across it.
  for (const a of p.arms) {
    const span = armSpanRad(a);
    const n = Math.max(1, Math.round((nArmTotal * span * a.rKinkKpc) / armLenTotal));
    const ext = (VISUAL.armExtrapolationDeg * Math.PI) / 180;
    const b0 = (a.betaMinDeg * Math.PI) / 180, b1 = (a.betaMaxDeg * Math.PI) / 180;
    const fitted = b1 - b0;
    const extend = fitted < (10 * Math.PI) / 180 ? 0 : ext; // a 3-degree fit is not extended into a speculative full spiral
    for (let i = 0; i < n; i++) {
      const beta = b0 - extend + rnd() * (fitted + 2 * extend);
      const inside = beta >= b0 && beta <= b1;
      const R = armRadiusKpc(a, beta);
      if (R * 1000 > Rmax || R < 1) continue;
      // Reid et al. (2019): the across-arm 1-sigma width follows w(R) = w0 + slope (R - 8.15 kpc); each arm's tabulated width is its value at R_kink.
      const law = (r: number) => p.armWidthAt8150Pc + p.armWidthSlopePcPerKpc * (r - 8.15);
      const wKpc = a.widthKpc * (law(R) / law(a.rKinkKpc));
      const dR = gauss(rnd) * wKpc; // across the arm
      const Rp = Math.max(0.2, R + dR);
      push('arm', -Rp * 1000 * Math.cos(beta), Rp * 1000 * Math.sin(beta), laplace(rnd, p.thinHeightPc * 0.5), inside ? 1 : VISUAL.armExtrapolationGain);
    }
  }

  // Shuffle so that a prefix is a representative subsample (used for the quality scaling).
  const n = comp.length;
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j]!, order[i]!]; }
  const out: MwSplats = {
    count: n, positionIcrs: new Float64Array(n * 3), galactocentric: new Float64Array(n * 3), radiusPc: new Float32Array(n), alpha: new Float32Array(n), colour: new Float32Array(n * 3), component: new Uint8Array(n),
  };
  for (let k = 0; k < n; k++) {
    const i = order[k]!;
    const gx = g[3 * i]!, gy = g[3 * i + 1]!, gz = g[3 * i + 2]!;
    out.galactocentric[3 * k] = gx; out.galactocentric[3 * k + 1] = gy; out.galactocentric[3 * k + 2] = gz;
    const ic = galactocentricToIcrs([gx, gy, gz], p.r0Pc);
    out.positionIcrs[3 * k] = ic[0]; out.positionIcrs[3 * k + 1] = ic[1]; out.positionIcrs[3 * k + 2] = ic[2];
    out.radiusPc[k] = rad[i]!; out.alpha[k] = alp[i]!;
    out.colour[3 * k] = col[3 * i]!; out.colour[3 * k + 1] = col[3 * i + 1]!; out.colour[3 * k + 2] = col[3 * i + 2]!;
    out.component[k] = comp[i]!;
  }
  return out;
}

function armSpanRad(a: ArmFit): number {
  const fitted = ((a.betaMaxDeg - a.betaMinDeg) * Math.PI) / 180;
  const ext = fitted < (10 * Math.PI) / 180 ? 0 : (VISUAL.armExtrapolationDeg * Math.PI) / 180;
  return Math.max(fitted + 2 * ext, 0.05);
}

// ---- view-dependent exposure ---------------------------------------------------------------------------------------------

export const GAIN_ELEVATIONS_DEG = [0, 10, 20, 35, 50, 70, 90] as const;

/**
 * Additive splats pile up differently seen edge-on (long line of sight through the disc) than face-on. For several
 * elevations above the disc plane this estimates the peak of the summed splat profile on a coarse grid and returns the gain
 * that brings that peak to VISUAL.targetPeak. The renderer interpolates this table by the camera's elevation.
 */
export function buildViewGainTable(s: MwSplats, targetPeak: number = VISUAL.targetPeak): Float32Array {
  const gains = new Float32Array(GAIN_ELEVATIONS_DEG.length);
  const N = 80, half = VISUAL.discRadiusPc * 1.05, cell = (2 * half) / N;
  const grid = new Float32Array(N * N);
  GAIN_ELEVATIONS_DEG.forEach((elDeg, ei) => {
    const el = (elDeg * Math.PI) / 180;
    // view direction from the galaxy toward the camera: elevation `el` above the plane, azimuth along the Sun line.
    const ce = Math.cos(el), se = Math.sin(el);
    // screen axes: u along the horizontal in-plane direction perpendicular to the view azimuth, v = projected z.
    grid.fill(0);
    for (let i = 0; i < s.count; i++) {
      const x = s.galactocentric[3 * i]!, y = s.galactocentric[3 * i + 1]!, z = s.galactocentric[3 * i + 2]!;
      const u = y, v = -x * se + z * ce; // camera azimuth = -x direction (the Sun side)
      const gu = (u + half) / cell, gv = (v + half) / cell;
      const rr = Math.max(1, s.radiusPc[i]! / cell);
      const r = Math.ceil(rr);
      const i0 = Math.floor(gu), j0 = Math.floor(gv);
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        const ii = i0 + di, jj = j0 + dj;
        if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
        const d2 = ((ii + 0.5 - gu) ** 2 + (jj + 0.5 - gv) ** 2) / (rr * rr);
        if (d2 >= 1) continue;
        grid[jj * N + ii]! += s.alpha[i]! * (1 - d2) ** 1.5 * (rr * cell) / 600;
      }
    }
    const lit: number[] = [];
    for (const v of grid) if (v > 1e-4) lit.push(v);
    lit.sort((a, b) => a - b);
    const peak = lit.length ? lit[Math.min(lit.length - 1, Math.floor(VISUAL.gainPercentile * lit.length))]! : 0;
    gains[ei] = peak > 0 ? targetPeak / peak : 1;
  });
  return gains;
}

/** Gain for a camera at `elevationDeg` (0..90, absolute) above the Galactic plane. Linear interpolation of the table. */
export function viewGain(table: Float32Array, elevationDeg: number): number {
  const e = Math.min(90, Math.max(0, Math.abs(elevationDeg)));
  for (let i = 1; i < GAIN_ELEVATIONS_DEG.length; i++) {
    const hi = GAIN_ELEVATIONS_DEG[i]!;
    if (e <= hi) { const lo = GAIN_ELEVATIONS_DEG[i - 1]!; const t = (e - lo) / (hi - lo); return table[i - 1]! * (1 - t) + table[i]! * t; }
  }
  return table[table.length - 1]!;
}
