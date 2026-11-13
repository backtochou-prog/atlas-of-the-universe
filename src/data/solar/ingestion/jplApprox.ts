import type { JplApproxElements, Rate } from '../../../core/orbits/elements';

/** Strip HTML to text, preserving line structure of <pre> blocks. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#8217;/g, "'");
}

export type ApproxPlanetName = 'Mercury' | 'Venus' | 'EM Bary' | 'Mars' | 'Jupiter' | 'Saturn' | 'Uranus' | 'Neptune';
const NAMES: readonly ApproxPlanetName[] = ['Mercury', 'Venus', 'EM Bary', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'];

const FLOAT = /[-+]?\d+\.\d+/g;

/**
 * Parse "Table 1" of https://ssd.jpl.nasa.gov/planets/approx_pos.html: Keplerian elements and rates with respect to the
 * mean ecliptic and equinox of J2000, valid 1800 AD - 2050 AD. Each planet occupies two lines: elements, then rates per century.
 */
export function parseApproxPositionsTable1(html: string): Record<ApproxPlanetName, JplApproxElements> {
  const text = htmlToText(html);
  const i = text.indexOf('Table 1');
  const j = text.indexOf('Table 2a', i);
  if (i < 0 || j < 0) throw new Error('Could not find Table 1 in the JPL approximate-positions page (the page layout may have changed)');
  const lines = text.slice(i, j).split('\n');
  const out: Partial<Record<ApproxPlanetName, JplApproxElements>> = {};
  for (const name of NAMES) {
    const k = lines.findIndex((l) => l.trimStart().startsWith(name + ' '));
    if (k < 0) throw new Error(`Table 1 has no row for ${name}`);
    const v = (lines[k]!.slice(name.length).match(FLOAT) ?? []).map(Number);
    const r = (lines[k + 1]!.match(FLOAT) ?? []).map(Number);
    if (v.length !== 6 || r.length !== 6) throw new Error(`Table 1 row for ${name} does not have 6 elements and 6 rates`);
    const pair = (n: number): Rate => [v[n]!, r[n]!];
    out[name] = { a: pair(0), e: pair(1), I: pair(2), L: pair(3), longPeri: pair(4), longNode: pair(5) };
  }
  return out as Record<ApproxPlanetName, JplApproxElements>;
}
