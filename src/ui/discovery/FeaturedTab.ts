/** Featured tab: the discovery lists of the engine, each with its criterion, scope, caveat and completeness statement, and a source-backed note where one exists. */
import type { DiscoveryAtlas } from '../../discovery/atlas';
import type { DiscoveryItem, DiscoveryList } from '../../discovery/discover';
import { el, safeLink } from './dom';
import { buildNotesVm } from './notesViewModel';
import { nf } from './labels';
import { note, objectRowButton, type Tab } from './rows';

const KIND_TAG: Readonly<Record<string, { tag: string; title: string }>> = {
  observed: { tag: 'OBS', title: 'Observed: directly measured and published by the catalogue' },
  derived: { tag: 'DER', title: 'Derived: calculated from observed values plus stated assumptions' },
  modelled: { tag: 'MOD', title: 'Modelled: an estimate from a scientific model fitted to data' },
};

/** The one sentence under a list: what "not complete" means here. */
export const COMPLETENESS_TEXT = 'This list is not complete: it ranks only the records held in this atlas, by the criterion above and by nothing else.';

export function listNode(l: DiscoveryList, atlas: Pick<DiscoveryAtlas, 'noteFor'>, choose: (id: string, fly: boolean) => void, open: boolean): HTMLElement {
  const d = el('details', 'fl');
  d.dataset['list'] = l.id;
  d.open = open;
  const sum = el('summary');
  sum.append(el('span', 'fl-title', l.title), el('span', 'fl-n', ` ${l.items.length} of ${nf(l.qualifying)}`));
  d.append(sum);
  const meta = el('dl', 'fl-meta');
  const add = (k: string, v: string): void => { meta.append(el('dt', undefined, k), el('dd', undefined, v)); };
  add('Criterion', l.criterion);
  add('Scope', l.scope);
  add('Caveat', l.caveat);
  add('Completeness', COMPLETENESS_TEXT);
  for (const x of l.excluded) add('Excluded', `${nf(x.count)}: ${x.reason}`);
  d.append(meta);
  const ol = el('ol', 'fl-items');
  for (const it of l.items) ol.append(itemNode(it, atlas, choose));
  d.append(ol);
  return d;
}

function itemNode(it: DiscoveryItem, atlas: Pick<DiscoveryAtlas, 'noteFor'>, choose: (id: string, fly: boolean) => void): HTMLElement {
  const li = el('li', 'fl-item');
  li.append(objectRowButton({ id: it.id, name: `${it.rank}. ${it.name}`, category: null, right: `${it.valueText}${it.uncertaintyText ? ` ${it.uncertaintyText}` : ''}` }, choose));
  const k = it.kind ? KIND_TAG[it.kind] : undefined;
  const line = el('div', 'fl-reason');
  if (k) { const t = el('span', `kind ${it.kind}`, k.tag); t.title = k.title; line.append(t, ' '); }
  line.append(it.reason);
  if (it.flags.length > 0) line.append(el('span', 'fl-flags', ` Flags: ${it.flags.join(', ')}.`));
  li.append(line);
  const vm = buildNotesVm(atlas.noteFor(it.id));
  if (vm.hasNote) {
    const n = el('div', 'fl-note');
    n.append(el('span', 'tag', 'Note'), ` ${vm.oneLine} `);
    const d = el('details', 'fl-src');
    d.append(el('summary', undefined, '(sources)'));
    const ul = el('ul', 'refs');
    for (const r of vm.sources) { const r1 = el('li'); r1.append(safeLink(r.label, r.url), el('span', 'ret', ` · retrieved ${r.retrieved}`)); ul.append(r1); }
    d.append(ul);
    n.append(d);
    li.append(n);
  }
  return li;
}

export class FeaturedTab implements Tab {
  readonly id = 'featured';
  readonly label = 'Featured';
  readonly root = el('div', 'dr-pane');
  private loaded = false;
  private provisional = false;
  private shown = false;
  private statusLine = el('p', 'dr-note');
  private body = el('div', 'fl-body');

  constructor(private readonly atlas: DiscoveryAtlas, private readonly choose: (id: string, fly: boolean) => void) {
    this.root.append(note('Lists are computed from the records in this atlas, by the stated criterion only. They are not rankings of the sky.'), this.statusLine, this.body);
    atlas.onStatus((s) => { if (this.shown && (!this.loaded || (this.provisional && s.complete)) && s.readyForQueries) void this.load(); });
  }

  onShow(): void {
    this.shown = true;
    if (!this.loaded || (this.provisional && this.atlas.status.complete)) void this.load();
    else if (!this.loaded) this.statusLine.textContent = 'Lists need the full index.';
  }
  onHide(): void { this.shown = false; }

  private async load(): Promise<void> {
    if (!this.atlas.status.readyForQueries) { this.statusLine.textContent = `The lists appear when the index is built (indexing ${Math.round(this.atlas.status.progress * 100)}%).`; return; }
    const out = await this.atlas.lists();
    if (!out) { this.statusLine.textContent = 'The lists could not be computed.'; return; }
    this.loaded = true; this.provisional = !out.complete;
    this.statusLine.textContent = out.complete ? '' : 'Provisional: the point catalogues are still loading, so these lists may change when indexing finishes.';
    this.body.replaceChildren(...out.lists.map((l, i) => listNode(l, this.atlas, this.choose, i === 0)));
  }
}
