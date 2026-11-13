/**
 * Words for the discovery interface (pure). Category labels are always text; colour is never the only carrier of meaning.
 */
import { formatDistance } from '../../core/spatial/scale';
import { METRES_PER_PARSEC } from '../../core/units';
import type { DiscoveryRecord, ObjectCategory } from '../../discovery/types';

export const CATEGORY_LABEL: Readonly<Record<ObjectCategory, string>> = {
  star: 'Star', planet: 'Planet', moon: 'Moon', exoplanet: 'Exoplanet', 'exoplanet-host': 'Exoplanet host star', galaxy: 'Galaxy', nebula: 'Nebula',
  'star-cluster': 'Cluster', 'galaxy-group': 'Galaxy group', 'galaxy-cluster': 'Galaxy cluster', 'supernova-remnant': 'Supernova remnant', other: 'Other',
};

export type CategoryGroupId = 'all' | 'stars' | 'planets' | 'moons' | 'exoplanets' | 'galaxies' | 'nebulae' | 'clusters' | 'groups' | 'other';
export interface CategoryGroup { readonly id: CategoryGroupId; readonly label: string; readonly categories: readonly ObjectCategory[] }

/** The filter chips of the search box. 'all' has no categories (no restriction). */
export const CATEGORY_GROUPS: readonly CategoryGroup[] = [
  { id: 'all', label: 'All', categories: [] },
  { id: 'stars', label: 'Stars', categories: ['star', 'exoplanet-host'] },
  { id: 'planets', label: 'Planets', categories: ['planet'] },
  { id: 'moons', label: 'Moons', categories: ['moon'] },
  { id: 'exoplanets', label: 'Exoplanets', categories: ['exoplanet'] },
  { id: 'galaxies', label: 'Galaxies', categories: ['galaxy'] },
  { id: 'nebulae', label: 'Nebulae', categories: ['nebula', 'supernova-remnant'] },
  { id: 'clusters', label: 'Clusters', categories: ['star-cluster'] },
  { id: 'groups', label: 'Groups', categories: ['galaxy-group', 'galaxy-cluster'] },
  { id: 'other', label: 'Other', categories: ['other'] },
];

export const groupById = (id: CategoryGroupId): CategoryGroup => CATEGORY_GROUPS.find((g) => g.id === id) ?? CATEGORY_GROUPS[0]!;

export const nf = (n: number): string => n.toLocaleString('en-US');

/** A compact distance for a result row, or the honest reason there is none. Never "0". */
export function distanceTextFor(rec: Pick<DiscoveryRecord, 'position' | 'measurements'> | undefined): string {
  if (!rec) return 'distance unknown';
  const d = rec.measurements.distancePc?.value;
  if (d !== undefined && Number.isFinite(d) && d > 0) return formatDistance(d * METRES_PER_PARSEC);
  if (rec.position.kind === 'solar') return 'Solar System';
  return 'distance unknown';
}

/** Why a record cannot be placed in 3D, or null when it can. */
export function placementNotice(rec: Pick<DiscoveryRecord, 'position' | 'drawn'> | undefined): string | null {
  if (!rec) return null;
  if (rec.position.kind === 'sky-only') return 'Cannot be placed in 3D: distance unknown (the dataset gives a direction on the sky only).';
  if (!rec.drawn) return 'Not drawn as an object at any scale in this atlas (inspect only); a marker shows where it is.';
  return null;
}

export function pluralise(n: number, one: string, many = `${one}s`): string { return `${nf(n)} ${n === 1 ? one : many}`; }
