/**
 * What the discovery interface adds to the inspector: actions (bookmark, collections, find nearby, go to parent, back), the relationships block and the
 * explanation block. The inspector provides two empty slots after each render; this class fills them for the object that is shown.
 */
import type { DiscoveryAtlas } from '../../discovery/atlas';
import type { InspectorSlots } from '../inspector';
import { el, safeLink } from './dom';
import { buildNotesVm, claimsWithoutProvenance, type ClaimVm, type NotesVm } from './notesViewModel';
import { buildRelationsVm, type RelationGroupVm } from './relationsViewModel';
import { collectionMenu } from './savedViewModel';
import { navControls } from './navViewModel';
import { LatestGuard } from './latest';

export interface InspectorExtrasDeps {
  readonly atlas: DiscoveryAtlas;
  choose(id: string, o: { fly: boolean; context: string }): void;
  goParent(): void;
  findNearby(id: string): void;
  /** Id of the object the inspector shows. */
  shownId(): string | null;
}

const STATUS_CLASS: Record<string, string> = { observed: 'obs', inferred: 'inf', hypothesis: 'hyp', historical: 'his' };

export function claimNode(c: ClaimVm): HTMLElement {
  const d = el('div', 'claim');
  const head = el('div', 'claim-text');
  const tag = el('span', `cstat ${STATUS_CLASS[c.status] ?? ''}`, c.statusLabel);
  tag.title = c.meaning;
  head.append(tag, el('span', undefined, ` ${c.text}`));
  d.append(head);
  const refs = el('ul', 'refs');
  for (const r of c.references) {
    const li = el('li');
    li.append(safeLink(r.label, r.url), el('span', 'ret', ` · retrieved ${r.retrieved}`));
    refs.append(li);
  }
  d.append(refs);
  return d;
}

export function notesNode(vm: NotesVm): HTMLElement {
  const box = el('section', 'disc-notes');
  box.dataset['block'] = 'explanation';
  box.append(el('h3', undefined, 'Explanation'));
  if (!vm.hasNote) {
    box.append(el('p', 'no-note', vm.message));
    return box;
  }
  const one = el('p', 'one-line', vm.oneLine);
  box.append(one);
  box.append(el('p', 'policy', vm.policy));
  vm.sections.forEach((s, i) => {
    const d = el('details', 'note-sec');
    d.dataset['section'] = s.key;
    if (i === 0) d.open = true;
    d.append(el('summary', undefined, s.title));
    for (const c of s.claims) d.append(claimNode(c));
    box.append(d);
  });
  if (vm.studiedBy.length > 0) {
    const d = el('details', 'note-sec');
    d.dataset['section'] = 'studiedBy';
    d.append(el('summary', undefined, 'Studied by'));
    const ul = el('ul', 'studied');
    for (const s of vm.studiedBy) {
      const li = el('li');
      li.append(el('b', undefined, s.mission), el('span', undefined, `: ${s.role} `), safeLink(`(${s.label})`, s.url));
      ul.append(li);
    }
    d.append(ul);
    box.append(d);
  }
  // A claim without a status or a reference must never be shown as fact: say so instead of hiding it silently.
  const bad = claimsWithoutProvenance(vm);
  if (bad.length > 0) box.append(el('p', 'policy', `${bad.length} statement(s) in this note lack a reference and should not be relied on.`));
  return box;
}

export function relationGroupNode(g: RelationGroupVm, choose: (id: string) => void): HTMLElement {
  const d = el('div', 'rel-group');
  d.dataset['basis'] = g.basis;
  d.append(el('h4', undefined, g.title));
  d.append(el('p', 'rel-note', g.note));
  const ul = el('ul');
  for (const r of g.rows) {
    const li = el('li', 'rel-row');
    const btn = el('button', 'rel-link');
    btn.type = 'button';
    if (!r.clickable) { btn.disabled = true; btn.title = 'This object is not in the loaded datasets'; }
    btn.append(el('span', 'rel-name', r.name), r.categoryLabel ? el('span', 'rel-cat', r.categoryLabel) : el('span'));
    btn.addEventListener('click', () => choose(r.id));
    li.append(btn, el('div', 'rel-stmt', r.statement));
    const src = el('div', 'rel-src');
    src.append('Source: ', safeLink(r.source, r.sourceUrl));
    li.append(src);
    ul.append(li);
  }
  d.append(ul);
  if (g.hiddenCount > 0) d.append(el('p', 'rel-note', `and ${g.hiddenCount} more not listed`));
  return d;
}

export class InspectorExtras {
  private slots: InspectorSlots | null = null;
  private id: string | null = null;
  private readonly guard = new LatestGuard();
  private pendingQueries = false;

  constructor(private readonly deps: InspectorExtrasDeps) {
    deps.atlas.saved.subscribe(() => this.refreshActions());
    deps.atlas.onStatus((s) => { if (s.readyForQueries && this.pendingQueries && this.slots) { this.pendingQueries = false; this.fillExtra(); } });
    deps.atlas.onSelectionChange(() => this.retarget());
  }

  /** Called after every inspector render. */
  render(slots: InspectorSlots): void {
    this.slots = slots;
    this.id = this.deps.shownId() ?? this.deps.atlas.selection;
    this.refreshActions();
    this.fillExtra();
  }

  /** The selected object changed but the inspector was not re-rendered by anyone else. */
  retarget(): void {
    const id = this.deps.shownId() ?? this.deps.atlas.selection;
    if (!this.slots || !id) return;
    const changed = id !== this.id;
    this.id = id;
    this.refreshActions();
    if (changed) this.fillExtra();
  }

  release(): void { this.slots = null; this.id = null; this.guard.cancel(); }

  private canonical(): string | null { return this.id ? this.deps.atlas.canonical(this.id) : null; }

  // ---- actions -----------------------------------------------------------------------------------------------------------------

  refreshActions(): void {
    const s = this.slots;
    if (!s || !s.actions.isConnected) return;
    const atlas = this.deps.atlas;
    const id = this.canonical();
    s.actions.replaceChildren();
    if (!id) return;
    const row = el('div', 'act-row');
    const saved = atlas.saved.isBookmarked(id);
    const bm = el('button', 'act bookmark', `${saved ? '★' : '☆'} ${saved ? 'Bookmarked' : 'Bookmark'}`);
    bm.type = 'button'; bm.setAttribute('aria-pressed', String(saved));
    bm.title = saved ? 'Remove the bookmark' : 'Save this object in your bookmarks (stored in this browser only)';
    bm.addEventListener('click', () => { if (atlas.saved.isBookmarked(id)) atlas.saved.removeBookmark(id); else atlas.saved.addBookmark(id); });
    row.append(bm);

    const near = el('button', 'act', 'Find nearby');
    near.type = 'button'; near.title = 'List the objects near this one (opens the Discover drawer)';
    near.addEventListener('click', () => this.deps.findNearby(id));
    row.append(near);

    const parent = el('button', 'act', 'Go to parent');
    parent.type = 'button'; parent.title = 'Select what this object orbits or belongs to (Backspace)';
    parent.addEventListener('click', () => this.deps.goParent());
    row.append(parent);

    const nav = navControls(atlas.navHistory(), atlas.navState(), (i) => atlas.peek(i)?.name);
    const back = el('button', 'act', nav.back.label);
    back.type = 'button'; back.disabled = !nav.back.enabled; back.title = nav.back.title;
    back.addEventListener('click', () => { void atlas.back(); });
    row.append(back);
    s.actions.append(row);

    // collections menu
    const det = el('details', 'coll-menu');
    det.append(el('summary', undefined, 'Collections'));
    const state = atlas.saved.snapshot();
    const menu = collectionMenu(state, id);
    const ul = el('ul');
    if (menu.length === 0) ul.append(el('li', 'muted', 'No collections yet. Create one below.'));
    for (const c of menu) {
      const li = el('li');
      const lab = el('label');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = c.has;
      cb.addEventListener('change', () => {
        if (cb.checked) { atlas.saved.addBookmark(id); atlas.saved.addToCollection(c.id, id); } else atlas.saved.removeFromCollection(c.id, id);
      });
      lab.append(cb, el('span', undefined, ` ${c.name}`));
      li.append(lab);
      ul.append(li);
    }
    det.append(ul);
    const form = el('form', 'coll-new');
    const inp = el('input'); inp.type = 'text'; inp.placeholder = 'New collection name'; inp.maxLength = 60; inp.setAttribute('aria-label', 'New collection name');
    const add = el('button', undefined, 'Create and add'); add.type = 'submit';
    const err = el('div', 'coll-err'); err.setAttribute('role', 'alert');
    form.append(inp, add, err);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const r = atlas.saved.createCollection(inp.value);
      if (!r.ok) { err.textContent = r.message; return; }
      atlas.saved.addBookmark(id);
      atlas.saved.addToCollection(r.value.id, id);
    });
    det.append(form);
    // keep the menu open across re-renders caused by its own changes
    if (this.menuOpen) det.open = true;
    det.addEventListener('toggle', () => { this.menuOpen = det.open; });
    s.actions.append(det);
  }
  private menuOpen = false;

  // ---- relationships + explanation ---------------------------------------------------------------------------------------------

  private fillExtra(): void {
    const s = this.slots;
    const id = this.canonical();
    if (!s || !id || !s.extra.isConnected) return;
    const atlas = this.deps.atlas;
    const token = this.guard.next();
    s.extra.replaceChildren();

    const rel = el('section', 'disc-rel');
    rel.dataset['block'] = 'relationships';
    rel.append(el('h3', undefined, 'Relationships'));
    const body = el('div', 'rel-body');
    rel.append(body);
    s.extra.append(rel);
    const loading = (text: string): void => { body.replaceChildren(el('p', 'muted', text)); };
    if (!atlas.status.readyForQueries) {
      this.pendingQueries = true;
      loading(`Relationships need the full index (indexing ${Math.round(atlas.status.progress * 100)}%).`);
    } else {
      loading('Loading relationships…');
      void atlas.relationsOf(id, 12).then((out) => {
        if (!this.guard.isCurrent(token) || !rel.isConnected) return;
        const vm = buildRelationsVm(out);
        body.replaceChildren();
        if (vm.empty) { body.append(el('p', 'muted', vm.message ?? '')); return; }
        for (const g of vm.groups) body.append(relationGroupNode(g, (to) => this.deps.choose(to, { fly: true, context: 'relation' })));
      });
    }
    s.extra.append(notesNode(buildNotesVm(atlas.noteFor(id))));
  }
}
