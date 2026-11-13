/**
 * Relationships block view model (pure): relations grouped by BASIS, never mixed. Physical (gravitational) is kept apart from structural containment,
 * from the approximate spatial association (our own selection) and from "same object in another dataset".
 */
import type { RelationLinkView, RelationsOutcome } from '../../discovery/engineApi';
import type { RelationBasis } from '../../discovery/types';
import { CATEGORY_LABEL } from './labels';

export const NO_RELATIONS_MESSAGE = 'No relationships are recorded for this object in the datasets loaded.';

export const BASIS_ORDER: readonly RelationBasis[] = ['physical-gravitational', 'structural', 'spatial-association', 'identity'];
export const BASIS_TITLE: Readonly<Record<RelationBasis, string>> = {
  'physical-gravitational': 'Physical (gravitational)',
  structural: 'Structural',
  'spatial-association': 'Spatial association (approximate; our selection)',
  identity: 'Same object in another dataset',
};
export const BASIS_NOTE: Readonly<Record<RelationBasis, string>> = {
  'physical-gravitational': 'Bound by gravity: orbits, binary components, bound membership with a published basis.',
  structural: 'Part of a larger structure; not a bound orbit.',
  'spatial-association': 'Listed together by this atlas because they are near each other on the sky or in space. Not a statement that they are bound.',
  identity: 'The same astronomical object as catalogued by another dataset.',
};

export interface RelationRowVm {
  readonly key: string;
  readonly id: string;
  readonly name: string;
  readonly categoryLabel: string | null;
  readonly statement: string;
  readonly source: string;
  readonly sourceUrl: string | null;
  /** False when the other end is not an object this atlas holds (shown, not clickable). */
  readonly clickable: boolean;
  readonly directionText: string;
}
export interface RelationGroupVm { readonly basis: RelationBasis; readonly title: string; readonly note: string; readonly rows: readonly RelationRowVm[]; readonly hiddenCount: number }
export interface RelationsVm { readonly groups: readonly RelationGroupVm[]; readonly total: number; readonly empty: boolean; readonly message: string | null }

const safeUrl = (u: string | undefined): string | null => (u && /^https?:\/\//i.test(u) ? u : null);

export function relationRow(l: RelationLinkView): RelationRowVm {
  const r = l.relation;
  return {
    key: `${r.from}|${r.kind}|${r.to}`, id: l.id, name: l.name ?? l.id,
    categoryLabel: l.category ? CATEGORY_LABEL[l.category] : null,
    statement: r.statement, source: r.source.label, sourceUrl: safeUrl(r.source.url),
    clickable: l.name !== undefined, directionText: l.direction === 'out' ? r.kind.replace(/-/g, ' ') : `has ${r.kind.replace(/-/g, ' ')}`,
  };
}

export function buildRelationsVm(out: RelationsOutcome | null | undefined): RelationsVm {
  if (!out || out.total === 0) return { groups: [], total: 0, empty: true, message: NO_RELATIONS_MESSAGE };
  const groups: RelationGroupVm[] = [];
  let listed = 0;
  for (const basis of BASIS_ORDER) {
    const links = out.groups[basis] ?? [];
    if (links.length === 0) continue;
    listed += links.length;
    groups.push({ basis, title: BASIS_TITLE[basis], note: BASIS_NOTE[basis], rows: links.map(relationRow), hiddenCount: 0 });
  }
  const hidden = Math.max(0, out.total - listed);
  if (hidden > 0 && groups.length > 0) {
    const last = groups[groups.length - 1]!;
    groups[groups.length - 1] = { ...last, hiddenCount: hidden };
  }
  return { groups, total: out.total, empty: false, message: null };
}
