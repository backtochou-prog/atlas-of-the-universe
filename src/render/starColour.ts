/**
 * Colour ramp keyed on the Gaia BP-RP colour index. A VISUALISATION CHOICE: a smooth blue-white-yellow-orange
 * ramp anchored to the general trend of stellar colour with temperature. It is not calibrated photometry and
 * not a blackbody conversion. A source with no BP-RP gets a neutral grey so missing colour is visible.
 */
export type Rgb = readonly [number, number, number];

const ANCHORS: readonly (readonly [number, Rgb])[] = [
  [-0.5, [0.6, 0.7, 1.0]],
  [0.0, [0.76, 0.83, 1.0]],
  [0.5, [0.95, 0.96, 1.0]],
  [0.82, [1.0, 0.95, 0.82]], // approximately solar colour
  [1.2, [1.0, 0.84, 0.62]],
  [1.8, [1.0, 0.68, 0.42]],
  [2.6, [1.0, 0.52, 0.3]],
  [3.5, [0.95, 0.38, 0.22]],
];

export const MISSING_COLOUR: Rgb = [0.62, 0.62, 0.64];

export function colourFromBpRp(bpRp: number | null): Rgb {
  if (bpRp === null || !Number.isFinite(bpRp)) return MISSING_COLOUR;
  const first = ANCHORS[0]!, last = ANCHORS[ANCHORS.length - 1]!;
  if (bpRp <= first[0]) return first[1];
  if (bpRp >= last[0]) return last[1];
  for (let i = 1; i < ANCHORS.length; i++) {
    const [x1, c1] = ANCHORS[i]!;
    if (bpRp <= x1) {
      const [x0, c0] = ANCHORS[i - 1]!;
      const t = (bpRp - x0) / (x1 - x0);
      return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t];
    }
  }
  return last[1];
}
