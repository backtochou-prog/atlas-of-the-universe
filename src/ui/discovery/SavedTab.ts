/**
 * Saved tab: bookmarks, collections (create, rename, delete, add / remove), history, export / import. Everything lives in this browser only; the tab says so,
 * and warns when local storage is blocked and the data are memory only. A saved id the atlas cannot resolve is shown as unresolved, never dropped.
 */
import type { DiscoveryAtlas } from '../../discovery/atlas';
import { el, frameBatch } from './dom';
import { buildSavedVm, shortDate, type SavedRowVm } from './savedViewModel';
import { note, objectRowButton, sectionHead, type Tab } from './rows';

export class SavedTab implements Tab {
  readonly id = 'saved';
  readonly label = 'Saved';
  readonly root = el('div', 'dr-pane');
  private readonly paint = frameBatch(() => { void this.render(); });
  private shown = false;
  private confirm: string | null = null;      // id of the collection waiting for "Confirm delete"
  private renaming: string | null = null;
  private message = '';
  private readonly openCollections = new Set<string>();

  constructor(private readonly atlas: DiscoveryAtlas, private readonly choose: (id: string, fly: boolean) => void) {
    atlas.saved.subscribe(() => { if (this.shown) this.paint.schedule(); });
    atlas.onStatus((s) => { if (this.shown && s.complete) this.paint.schedule(); });
  }

  onShow(): void { this.shown = true; this.paint.schedule(); }
  onHide(): void { this.shown = false; }

  private async render(): Promise<void> {
    const atlas = this.atlas, store = atlas.saved;
    const state = store.snapshot();
    const ids = [...new Set([...state.bookmarks.map((b) => b.id), ...state.collections.flatMap((c) => c.items), ...state.history.slice(-20).map((h) => h.id)])];
    if (atlas.status.readyForSearch) await atlas.getRecords(ids);
    const vm = buildSavedVm(store.snapshot(), store.persistence(), (id) => atlas.peek(id), { datasetsLoading: !atlas.status.complete });
    const root = this.root;
    const keepScroll = root.scrollTop;
    root.replaceChildren();

    root.append(note(vm.note, 'dr-note stored'));
    if (vm.persistence.warning) { const w = el('p', 'dr-warn', vm.persistence.warning); w.setAttribute('role', 'alert'); root.append(w); }
    if (vm.unresolvedTotal > 0) root.append(note(`${vm.unresolvedTotal} saved id(s) cannot be resolved right now; they are listed below, not removed.`));
    if (this.message) { const m = el('p', 'dr-note', this.message); m.setAttribute('role', 'status'); root.append(m); }

    // bookmarks
    root.append(sectionHead(`Bookmarks (${vm.bookmarks.length})`));
    if (vm.bookmarks.length === 0) root.append(note('No bookmarks yet. Use the Bookmark button in the inspector.'));
    const bl = el('ul', 'obj-list');
    for (const b of vm.bookmarks) bl.append(this.savedRow(b, () => { store.removeBookmark(b.id); }, 'Remove bookmark'));
    root.append(bl);

    // collections
    root.append(sectionHead(`Collections (${vm.collections.length})`));
    const form = el('form', 'coll-new');
    const inp = el('input'); inp.type = 'text'; inp.placeholder = 'New collection name'; inp.maxLength = 60; inp.setAttribute('aria-label', 'New collection name');
    const mk = el('button', 'dr-btn', 'Create'); mk.type = 'submit';
    form.append(inp, mk);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const r = store.createCollection(inp.value);
      this.message = r.ok ? `Created collection “${r.value.name}”.` : r.message;
      if (!r.ok) this.paint.schedule();
    });
    root.append(form);
    for (const c of vm.collections) {
      const d = el('details', 'fl coll');
      d.dataset['collection'] = c.id;
      d.open = this.openCollections.has(c.id);
      d.addEventListener('toggle', () => { if (d.open) this.openCollections.add(c.id); else this.openCollections.delete(c.id); });
      const sum = el('summary');
      sum.append(el('span', 'fl-title', c.name), el('span', 'fl-n', ` ${c.count}${c.unresolvedCount ? ` (${c.unresolvedCount} unresolved)` : ''}`));
      d.append(sum);
      const acts = el('div', 'dr-actions');
      if (this.renaming === c.id) {
        const rf = el('form', 'coll-new');
        const ri = el('input'); ri.type = 'text'; ri.value = c.name; ri.maxLength = 60; ri.setAttribute('aria-label', `New name for ${c.name}`);
        const ok = el('button', 'dr-btn', 'Save name'); ok.type = 'submit';
        rf.append(ri, ok);
        rf.addEventListener('submit', (e) => { e.preventDefault(); const r = store.renameCollection(c.id, ri.value); this.renaming = null; this.message = r.ok ? '' : r.message; this.paint.schedule(); });
        acts.append(rf);
        queueMicrotask(() => ri.focus());
      } else {
        const rn = el('button', 'dr-btn', 'Rename'); rn.type = 'button'; rn.addEventListener('click', () => { this.renaming = c.id; this.paint.schedule(); });
        acts.append(rn);
      }
      const del = el('button', 'dr-btn', this.confirm === c.id ? 'Confirm delete' : 'Delete'); del.type = 'button';
      del.addEventListener('click', () => {
        if (this.confirm === c.id) { store.deleteCollection(c.id); this.confirm = null; this.message = `Deleted collection “${c.name}”. Its objects stay in your bookmarks.`; }
        else { this.confirm = c.id; this.paint.schedule(); }
      });
      acts.append(del);
      d.append(acts);
      const ul = el('ul', 'obj-list');
      if (c.items.length === 0) d.append(note('Empty. Add objects from the inspector: Collections.'));
      for (const it of c.items) ul.append(this.savedRow(it, () => { store.removeFromCollection(c.id, it.id); }, 'Remove from this collection'));
      d.append(ul);
      root.append(d);
    }

    // history
    root.append(sectionHead(`History (${vm.history.length})`));
    const clr = el('button', 'dr-btn', 'Clear history'); clr.type = 'button'; clr.disabled = vm.history.length === 0;
    clr.addEventListener('click', () => { store.clearHistory(); });
    root.append(clr);
    const hl = el('ul', 'obj-list');
    for (const h of vm.history.slice(0, 40)) {
      const li = el('li');
      li.append(objectRowButton({ id: h.id, name: h.name, category: h.categoryLabel, right: shortDate(h.at), ...(h.context ? { sub: h.context } : {}), muted: h.status === 'unresolved', disabled: h.status === 'unresolved' }, this.choose));
      hl.append(li);
    }
    root.append(hl);
    if (vm.history.length > 40) root.append(note(`showing 40 of ${vm.history.length}`));

    // export / import
    root.append(sectionHead('Export and import'));
    const ex = el('button', 'dr-btn', 'Export JSON'); ex.type = 'button';
    ex.addEventListener('click', () => this.download());
    const fileLab = el('label', 'dr-btn file', 'Import JSON');
    const file = el('input'); file.type = 'file'; file.accept = 'application/json,.json'; file.className = 'sr-only';
    file.addEventListener('change', () => { void this.importFile(file); });
    fileLab.append(file);
    const mode = el('select'); mode.setAttribute('aria-label', 'Import mode');
    for (const [v, t] of [['merge', 'Merge into what is here'], ['replace', 'Replace what is here']] as const) { const o = el('option', undefined, t); o.value = v; mode.append(o); }
    mode.id = 'saved-import-mode';
    const acts = el('div', 'dr-actions');
    acts.append(ex, mode, fileLab);
    root.append(acts);
    root.scrollTop = keepScroll;
  }

  private savedRow(r: SavedRowVm, remove: () => void, removeTitle: string): HTMLElement {
    const li = el('li', 'saved-row');
    li.append(objectRowButton({
      id: r.id, name: r.name, category: r.categoryLabel, right: r.savedAt ? shortDate(r.savedAt) : '',
      ...(r.statusText ? { sub: r.statusText } : r.collections.length ? { sub: `In: ${r.collections.join(', ')}` } : {}),
      muted: r.status === 'unresolved', disabled: r.status === 'unresolved',
    }, this.choose));
    const x = el('button', 'row-x', '×'); x.type = 'button'; x.title = removeTitle; x.setAttribute('aria-label', `${removeTitle}: ${r.name}`);
    x.addEventListener('click', remove);
    li.append(x);
    return li;
  }

  private download(): void {
    const blob = new Blob([this.atlas.saved.exportJson()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a'); a.href = url; a.download = 'atlas-saved.json';
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.message = 'Exported atlas-saved.json.';
    this.paint.schedule();
  }

  private async importFile(input: HTMLInputElement): Promise<void> {
    const f = input.files?.[0];
    if (!f) return;
    const text = await f.text();
    const mode = (this.root.querySelector<HTMLSelectElement>('#saved-import-mode')?.value ?? 'merge') as 'merge' | 'replace';
    const r = this.atlas.saved.importJson(text, { mode });
    this.message = r.ok
      ? `Imported (${r.mode}): ${r.bookmarksAdded} bookmarks, ${r.collectionsAdded} collections, ${r.itemsAdded} collection items, ${r.historyAdded} history entries${r.dropped ? `; ${r.dropped} unreadable item(s) skipped` : ''}.`
      : `Import failed: ${r.message ?? 'unknown error'}`;
    this.paint.schedule();
  }
}
