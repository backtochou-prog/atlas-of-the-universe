/**
 * Explanation block view model (pure). Every claim carries its status label and its references; an object without a note says so and nothing is synthesised.
 */
import type { DiscoveryNote, NoteClaim } from '../../discovery/types';

export const NOTES_POLICY_LINE = 'Notes paraphrase the cited pages; they are not measurements.';
export const NO_NOTE_MESSAGE = 'No curated explanation yet.';

export type ClaimStatus = NoteClaim['status'];
export const STATUS_LABEL: Readonly<Record<ClaimStatus, string>> = {
  observed: 'Observed', inferred: 'Inferred', hypothesis: 'Hypothesis / open question', historical: 'Historical',
};
export const STATUS_MEANING: Readonly<Record<ClaimStatus, string>> = {
  observed: 'Reported as a measurement or direct observation in the cited source.',
  inferred: 'Follows from observations through a stated model or assumption.',
  hypothesis: 'Proposed in the cited source; not settled.',
  historical: 'A statement about past events, discoveries or names.',
};

export interface RefVm { readonly label: string; readonly url: string | null; readonly retrieved: string; readonly text: string }
export interface ClaimVm { readonly text: string; readonly status: ClaimStatus; readonly statusLabel: string; readonly meaning: string; readonly references: readonly RefVm[] }
export interface NoteSectionVm { readonly key: 'what' | 'why' | 'discovery' | 'interesting' | 'uncertain'; readonly title: string; readonly claims: readonly ClaimVm[] }
export interface StudiedByVm { readonly mission: string; readonly role: string; readonly label: string; readonly url: string | null }

export type NotesVm =
  | { readonly hasNote: false; readonly message: string; readonly policy: string }
  | {
    readonly hasNote: true; readonly id: string; readonly oneLine: string; readonly sources: readonly RefVm[];
    readonly sections: readonly NoteSectionVm[]; readonly studiedBy: readonly StudiedByVm[]; readonly policy: string;
  };

const SECTION_TITLES: readonly (readonly [NoteSectionVm['key'], string])[] = [
  ['what', 'What it is'], ['why', 'Why it matters'], ['discovery', 'How it was found'], ['interesting', 'What is interesting'], ['uncertain', 'What is uncertain'],
];

const safeUrl = (u: string | undefined): string | null => (u && /^https?:\/\//i.test(u) ? u : null);

function refVm(r: { readonly label: string; readonly url?: string; readonly retrieved?: string }): RefVm {
  const retrieved = r.retrieved ?? 'date not recorded';
  return { label: r.label, url: safeUrl(r.url), retrieved, text: `${r.label} (retrieved ${retrieved})` };
}

function claimVm(c: NoteClaim): ClaimVm {
  return { text: c.text, status: c.status, statusLabel: STATUS_LABEL[c.status] ?? c.status, meaning: STATUS_MEANING[c.status] ?? '', references: c.references.map(refVm) };
}

export function buildNotesVm(note: DiscoveryNote | undefined): NotesVm {
  if (!note) return { hasNote: false, message: NO_NOTE_MESSAGE, policy: NOTES_POLICY_LINE };
  const sections: NoteSectionVm[] = [];
  const seen = new Map<string, RefVm>();
  for (const [key, title] of SECTION_TITLES) {
    const claims = (note.sections[key] ?? []).map(claimVm);
    if (claims.length === 0) continue;
    sections.push({ key, title, claims });
    for (const c of claims) for (const r of c.references) { const k = `${r.url ?? r.label}`; if (!seen.has(k)) seen.set(k, r); }
  }
  return {
    hasNote: true, id: note.id, oneLine: note.oneLine, sources: [...seen.values()], sections, policy: NOTES_POLICY_LINE,
    studiedBy: (note.studiedBy ?? []).map((s) => ({ mission: s.mission, role: s.role, label: s.reference.label, url: safeUrl(s.reference.url) })),
  };
}

/** Claims that would break the rule "every claim has a status and at least one reference" (used by tests and by the view as a guard). */
export function claimsWithoutProvenance(vm: NotesVm): string[] {
  if (!vm.hasNote) return [];
  const bad: string[] = [];
  for (const s of vm.sections) for (const c of s.claims) if (!c.statusLabel || c.references.length === 0) bad.push(c.text.slice(0, 60));
  return bad;
}
