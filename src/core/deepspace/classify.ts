import type { ClusterClass, GalaxyClass, NebulaClass } from '../../data/deepspace/types';

/**
 * Classification of deep-space objects from the catalogue's OWN labels.
 *
 * Rule: never guess. A label that cannot be read unambiguously throws a ClassificationError. The only way to obtain
 * 'peculiar' is a label that says "pec" (or a numeric T-type that the scheme itself defines as peculiar, none do).
 * The catalogue string is kept untouched elsewhere (DeepSpaceObject.morphologyLabel); this only derives the coarse class
 * used to choose a rendering strategy.
 */
export class ClassificationError extends Error {
  constructor(
    readonly what: 'galaxy' | 'nebula' | 'cluster',
    readonly label: string,
    readonly reason: 'unrecognised' | 'ambiguous' | 'empty',
  ) {
    super(`Cannot classify ${what} label "${label}": ${reason}`);
    this.name = 'ClassificationError';
  }
}

/**
 * Galaxy morphology. Accepts de Vaucouleurs / RC3 / NED strings and Hubble-style strings:
 *   "SA(s)b" "SB(rs)bc" "(R)SAB(rs)a" "SAB0" "S0" "S0/a" "Sb" "Sbc sp"      -> spiral / barred-spiral / lenticular
 *   "E2" "E+0-1" "cE2" "cD"                                                  -> elliptical
 *   "IB(s)m" "IAB(s)m" "Im" "I0" "Irr" "Irr I"                                -> irregular
 *   "dSph" "dE" "dE3,N" "dIrr"                                               -> dwarf-spheroidal / dwarf-irregular
 *   any label containing "pec"                                               -> peculiar (the label says so; wins over the rest)
 *   NED/HyperLEDA numeric T-types: "T=3", "3", "-5" (RC3 scale: <=-4 E, -3..0 S0/S0a, 1..9 spirals, 10 Im)
 *
 * Mapping choices (documented because they are choices):
 *  - SAB (weak bar) is reported as 'barred-spiral', as is SB. SA and plain S are 'spiral'.
 *  - Magellanic types (Sm, SBm, Im, IBm) follow the label's family letter: SBm is 'barred-spiral', Im/IB is 'irregular'.
 *  - dE is 'dwarf-spheroidal' (dwarf elliptical and dwarf spheroidal are one family at this level of detail).
 *  - Mixed dwarf types such as "dSph/dIrr", "dTrans" are ambiguous and throw.
 *  - A numeric T-type carries no bar information: T 1..9 gives 'spiral'. T-types cannot identify dwarfs or peculiars.
 */
export function classifyGalaxy(morphologyLabel: string): GalaxyClass {
  const raw = (morphologyLabel ?? '').trim();
  if (raw === '') throw new ClassificationError('galaxy', morphologyLabel, 'empty');

  // Numeric T-type ("T=3", "T 3", "3", "-5", "3.0").
  const tMatch = /^(?:T\s*=?\s*)?([+-]?\d+(?:\.\d+)?)$/i.exec(raw);
  if (tMatch) return classifyTType(Number(tMatch[1]), raw);

  if (/pec/i.test(raw)) return 'peculiar';

  // Strip nucleus/extras after a comma or semicolon ("dE3,N"), uncertainty marks, spaces.
  let s = raw.replace(/\s*[,;].*$/, '').replace(/[:?]/g, '').replace(/\s+/g, '');
  if (s === '') throw new ClassificationError('galaxy', raw, 'unrecognised');

  // Dwarfs first (they start with a lower-case d).
  if (/^d(?:SPH|Sph|sph)/.test(s) || /^dE/.test(s)) {
    if (/\//.test(s) || /dirr/i.test(s.slice(1))) throw new ClassificationError('galaxy', raw, 'ambiguous');
    return 'dwarf-spheroidal';
  }
  if (/^dIrr/i.test(s)) {
    if (/\//.test(s)) throw new ClassificationError('galaxy', raw, 'ambiguous');
    return 'dwarf-irregular';
  }
  if (/^dTrans/i.test(s) || /^d[A-Za-z]/.test(s) && !/^dm/.test(s)) throw new ClassificationError('galaxy', raw, 'ambiguous');

  // Outer ring prefix "(R)" "(R')" "(L)" "(RL)".
  s = s.replace(/^\((?:R'?|L|RL)\)/, '');

  // Elliptical family: E, E2, E+0-1, cE2, cD, D.
  if (/^(?:cE|E)[+\-0-9.^]*$/.test(s) || /^c?D$/.test(s)) return 'elliptical';

  // Irregular family: I0, Im, IB(s)m, IAB(s)m, Irr, IrrI, IrrII.
  if (/^Irr(?:I{1,2})?$/.test(s)) return 'irregular';
  if (/^(?:IAB|IA|IB|I)/.test(s)) {
    const rest = s.replace(/^(?:IAB|IA|IB|I)/, '').replace(/^\([^)]*\)/, '');
    if (/^(?:0|m|[+\-^]*)$/.test(rest) || /^m[+\-]?$/.test(rest) || rest === '') return 'irregular';
    throw new ClassificationError('galaxy', raw, 'unrecognised');
  }

  // Disc family: S, SA, SB, SAB with optional variety "(s)" "(rs)" "(r'l)" and stage.
  const fam = /^(SAB|SA|SB|S)/.exec(s);
  if (fam) {
    const family = fam[1] as 'SAB' | 'SA' | 'SB' | 'S';
    let rest = s.slice(family.length);
    rest = rest.replace(/^\([^)]*\)/, ''); // variety
    rest = rest.replace(/sp$/, '').replace(/p$/, ''); // spindle (edge-on) marker
    const stage = /^(0\/a|0|ab|a|bc|b|cd|c|dm|d|m)?[+\-^]*$/.exec(rest);
    if (!stage) throw new ClassificationError('galaxy', raw, 'unrecognised');
    const st = stage[1];
    if (st === '0' || st === '0/a') return 'lenticular';
    return family === 'SB' || family === 'SAB' ? 'barred-spiral' : 'spiral';
  }
  throw new ClassificationError('galaxy', raw, 'unrecognised');
}

function classifyTType(t: number, label: string): GalaxyClass {
  // RC3 / HyperLEDA T scale. T=11 and above are defined differently between catalogues -> refuse.
  if (t < -6 || t > 10.5) throw new ClassificationError('galaxy', label, 'unrecognised');
  if (t <= -3.5) return 'elliptical'; // -6 cE, -5 E, -4 E+
  if (t <= 0.5) return 'lenticular'; // -3..-1 S0, 0 S0/a
  if (t < 9.5) return 'spiral'; // 1 Sa .. 9 Sm
  return 'irregular'; // 10 Im
}

const NEBULA_CODES: Readonly<Record<string, NebulaClass>> = {
  hii: 'emission', 'h ii region': 'emission', 'hii region': 'emission', 'emission nebula': 'emission',
  rne: 'reflection', 'reflection nebula': 'reflection',
  dne: 'dark', 'dark nebula': 'dark', 'dark cloud': 'dark', 'dark cloud (nebula)': 'dark',
  pn: 'planetary', 'planetary nebula': 'planetary',
  snr: 'supernova-remnant', 'supernova remnant': 'supernova-remnant',
  moc: 'molecular-cloud', 'molecular cloud': 'molecular-cloud',
};

/**
 * SIMBAD object type -> nebula class. Recognised: HII, RNe, DNe, PN, SNR, MoC (and their long labels).
 * Throws for generic or uncertain types (Cld, ISM, Neb, BNe, "PN?", "SNR?"): a bright nebula cannot be called emission
 * or reflection without further data, and candidates ("?") are not confirmed.
 */
export function classifyNebula(simbadOtype: string): NebulaClass {
  const key = (simbadOtype ?? '').trim().toLowerCase();
  if (key === '') throw new ClassificationError('nebula', simbadOtype, 'empty');
  const hit = NEBULA_CODES[key];
  if (hit) return hit;
  if (/^(cld|ism|neb|bne|hii\?|pn\?|snr\?|rne\?|dne\?|moc\?|sfr)$/.test(key)) throw new ClassificationError('nebula', simbadOtype, 'ambiguous');
  throw new ClassificationError('nebula', simbadOtype, 'unrecognised');
}

const CLUSTER_CODES: Readonly<Record<string, ClusterClass>> = {
  opc: 'open', 'open cluster': 'open',
  glc: 'globular', 'globular cluster': 'globular',
};

/**
 * SIMBAD object type -> cluster class. OpC = open, GlC = globular. The generic "Cl*" / "Cl*.." ("Cluster of Stars") and
 * association codes ("As*") do not say which, so they throw: the caller must use a specific code or the catalogue's
 * specific classification.
 */
export function classifyCluster(otype: string): ClusterClass {
  const key = (otype ?? '').trim().toLowerCase();
  if (key === '') throw new ClassificationError('cluster', otype, 'empty');
  const hit = CLUSTER_CODES[key];
  if (hit) return hit;
  if (key === 'cl*' || key === 'cl*..' || key === 'as*' || key === 'cluster of stars' || key === 'opc?' || key === 'glc?') {
    throw new ClassificationError('cluster', otype, 'ambiguous');
  }
  throw new ClassificationError('cluster', otype, 'unrecognised');
}
