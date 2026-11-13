/** Parse a NAIF text PCK (pck00011.tpc): IAU pole and prime-meridian elements. Later assignments override earlier ones, as in SPICE. */
export interface PckBody {
  readonly poleRa?: readonly number[];
  readonly poleDec?: readonly number[];
  readonly pm?: readonly number[];
  readonly radiiKm?: readonly number[];
}

const num = (s: string): number => Number(s.replace(/[dD]/, 'e'));

export function parsePck(text: string): Map<number, PckBody> {
  const out = new Map<number, { poleRa?: number[]; poleDec?: number[]; pm?: number[]; radiiKm?: number[] }>();
  const re = /BODY(\d+)_(POLE_RA|POLE_DEC|PM|RADII)\s*=\s*\(([^)]*)\)/g;
  for (const m of text.matchAll(re)) {
    const id = Number(m[1]);
    const values = m[3]!.trim().split(/\s+/).filter(Boolean).map(num);
    if (values.some((v) => !Number.isFinite(v))) continue;
    const cur = out.get(id) ?? {};
    if (m[2] === 'POLE_RA') cur.poleRa = values;
    else if (m[2] === 'POLE_DEC') cur.poleDec = values;
    else if (m[2] === 'PM') cur.pm = values;
    else cur.radiiKm = values;
    out.set(id, cur);
  }
  return out;
}
