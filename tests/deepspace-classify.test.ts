import { describe, expect, it } from 'vitest';
import { classifyCluster, classifyGalaxy, classifyNebula, ClassificationError } from '../src/core/deepspace/classify';

describe('classifyGalaxy', () => {
  const table: [string, string][] = [
    ['SA(s)b', 'spiral'], ['SA(s)a', 'spiral'], ['SB(rs)bc', 'barred-spiral'], ['SAB(rs)bc', 'barred-spiral'], ['(R)SAB(rs)a', 'barred-spiral'],
    ['Sb', 'spiral'], ['Sc', 'spiral'], ['Scd', 'spiral'], ['S', 'spiral'], ['Sbc sp', 'spiral'], ['SB(s)m', 'barred-spiral'], ['SA(s)m', 'spiral'],
    ['S0', 'lenticular'], ['SAB0', 'lenticular'], ['SB0^+', 'lenticular'], ['(R)SA0^+', 'lenticular'], ['S0/a', 'lenticular'], ['SA(r)0', 'lenticular'],
    ['E2', 'elliptical'], ['E', 'elliptical'], ['cE2', 'elliptical'], ['E+0-1', 'elliptical'], ['cD', 'elliptical'], ['E0', 'elliptical'],
    ['E+0-1 pec', 'peculiar'], ['S pec', 'peculiar'], ['SB(rs)bc pec', 'peculiar'], ['Pec', 'peculiar'],
    ['IB(s)m', 'irregular'], ['IAB(s)m', 'irregular'], ['Im', 'irregular'], ['I0', 'irregular'], ['Irr', 'irregular'], ['Irr I', 'irregular'], ['IBm', 'irregular'],
    ['dSph', 'dwarf-spheroidal'], ['dE', 'dwarf-spheroidal'], ['dE3,N', 'dwarf-spheroidal'], ['dSph;N', 'dwarf-spheroidal'], ['dIrr', 'dwarf-irregular'],
    // numeric T-types
    ['-5', 'elliptical'], ['T=-4', 'elliptical'], ['-2', 'lenticular'], ['0', 'lenticular'], ['3', 'spiral'], ['T = 9', 'spiral'], ['10', 'irregular'],
  ];
  it.each(table)('%s -> %s', (label, cls) => { expect(classifyGalaxy(label)).toBe(cls); });

  it('tolerates catalogue uncertainty marks', () => { expect(classifyGalaxy('SA(s)a:')).toBe('spiral'); });
  it.each(['', '   ', 'banana', 'dSph/dIrr', 'dIrr/dSph', 'dTrans', 'Sbc/Sc?x', 'E/S0', '42', '-9', 'Gb'])('refuses %j (never defaults)', (label) => {
    expect(() => classifyGalaxy(label)).toThrow(ClassificationError);
  });
  it('only says peculiar when the label says pec', () => {
    expect(classifyGalaxy('Sb')).not.toBe('peculiar');
    expect(() => classifyGalaxy('weird')).toThrow(/unrecognised/);
  });
  it('error carries the label and reason', () => {
    try { classifyGalaxy('dSph/dIrr'); } catch (e) { expect((e as ClassificationError).reason).toBe('ambiguous'); expect((e as ClassificationError).label).toBe('dSph/dIrr'); }
  });
});

describe('classifyNebula / classifyCluster', () => {
  it.each([['HII', 'emission'], ['RNe', 'reflection'], ['DNe', 'dark'], ['PN', 'planetary'], ['SNR', 'supernova-remnant'], ['MoC', 'molecular-cloud'], ['hii', 'emission'], ['Planetary Nebula', 'planetary']])('nebula %s -> %s', (c, k) => {
    expect(classifyNebula(c)).toBe(k);
  });
  it.each(['Cld', 'ISM', 'Neb', 'BNe', 'PN?', 'SNR?', '', 'Star'])('nebula refuses %j', (c) => { expect(() => classifyNebula(c)).toThrow(ClassificationError); });
  it.each([['OpC', 'open'], ['GlC', 'globular'], ['glc', 'globular'], ['Open Cluster', 'open']])('cluster %s -> %s', (c, k) => { expect(classifyCluster(c)).toBe(k); });
  it.each(['Cl*', 'Cl*..', 'As*', 'OpC?', '', 'HII'])('cluster refuses %j', (c) => { expect(() => classifyCluster(c)).toThrow(ClassificationError); });
});
