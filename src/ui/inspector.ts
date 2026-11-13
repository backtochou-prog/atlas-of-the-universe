import type { ImageProvenanceBlock, InspectorField, InspectorModel, RepresentationBlock } from '../data/catalogue/inspect';

const KIND_TAG: Record<string, { tag: string; title: string }> = {
  observed: { tag: 'OBS', title: 'Observed: directly measured and published by the catalogue' },
  derived: { tag: 'DER', title: 'Derived: calculated from observed values plus stated assumptions' },
  modelled: { tag: 'MOD', title: 'Modelled: an estimate from a scientific model fitted to data' },
  hypothetical: { tag: 'HYP', title: 'Hypothetical: proposed, not observationally confirmed' },
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function row(f: InspectorField): HTMLElement {
  const r = el('div', f.available ? 'row' : 'row missing');
  r.dataset['key'] = f.key;
  r.append(el('span', 'label', f.label));
  if (!f.available) {
    const v = el('span', 'value', 'Unavailable');
    r.append(v);
    r.append(el('div', 'reason', f.reason ?? ''));
    return r;
  }
  const v = el('span', 'value');
  v.append(el('span', 'num', f.value));
  if (f.unit && f.unit !== 'dimensionless') v.append(el('span', 'unit', ` ${f.unit}`));
  if (f.kind) {
    const k = KIND_TAG[f.kind]!;
    const t = el('span', `kind ${f.kind}`, k.tag);
    t.title = k.title;
    v.append(t);
  }
  r.append(v);
  if (f.uncertainty) r.append(el('div', 'unc', f.uncertainty));
  if (f.detail) r.append(el('div', 'reason', f.detail));
  const lineage = [f.source ? `Source: ${f.source}` : '', f.epoch ? `Epoch: ${f.epoch}` : '', ...(f.transformations ?? []).map((t) => `Transformation: ${t}`), f.note ? `Note: ${f.note}` : '']
    .filter(Boolean);
  if (lineage.length) r.title = lineage.join('\n');
  return r;
}


function link(text: string, url: string): HTMLElement {
  if (!/^https?:\/\//i.test(url)) return el('span', undefined, text);
  const a = el('a', undefined, text);
  a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
  return a;
}
function kv(label: string, value: string | HTMLElement, cls = ''): HTMLElement {
  const r = el('div', `kv ${cls}`.trim());
  r.append(el('span', 'k', label));
  const v = el('span', 'v');
  if (typeof value === 'string') v.textContent = value; else v.append(value);
  r.append(v);
  return r;
}

function representationNode(r: RepresentationBlock): HTMLElement {
  const box = el('div', 'rep');
  const badge = el('span', `rep-badge ${r.tone}`, r.badge);
  badge.title = r.meaning;
  box.append(badge, el('p', 'rep-meaning', r.meaning), el('p', 'rep-summary', r.summary), kv('Depth', r.depth));
  if (r.exaggerations.length) {
    const ul = el('ul', 'exag');
    for (const e of r.exaggerations) ul.append(el('li', undefined, e));
    box.append(el('div', 'k-head', 'Exaggerations and stylisation'), ul);
  }
  return box;
}

function provenanceNode(p: ImageProvenanceBlock): HTMLElement {
  const box = el('div', 'imgprov');
  box.dataset['asset'] = p.assetId;
  box.append(el('div', 'k-head', 'Image'), el('div', 'img-title', p.title));
  if (p.notAnEyeView) box.append(el('div', 'eye-warning', p.notAnEyeView));
  if (p.coverageNote) box.append(el('div', 'coverage-note', p.coverageNote));
  box.append(kv('Archive', p.archive), kv('Image id', link(p.imageId, p.landingUrl)));
  const credit = kv('Credit', p.credit, 'credit-line');
  box.append(credit);
  box.append(kv('Licence', link(p.licenceName, p.licenceUrl)));
  box.append(kv('Telescope', p.instrument ? `${p.telescope} \u00b7 ${p.instrument}` : p.telescope));
  box.append(kv('Observed', p.date ?? 'date not recorded'));
  box.append(kv('Band', p.bandLabel), kv('Filters', p.filters.length ? p.filters.join(', ') : 'not listed'));
  box.append(el('div', 'band-reveals', p.bandReveals));
  box.append(kv('False colour', p.falseColour ? 'yes' : 'no'), kv('Composite', p.composite ? 'yes' : 'no'));
  box.append(el('div', 'band-reveals', `Colour note: ${p.colourNote}`));
  box.append(kv('Field of view', `${p.fovArcmin[0].toPrecision(3)} \u00d7 ${p.fovArcmin[1].toPrecision(3)} arcmin`));
  box.append(kv('Fidelity', p.fidelityLabel));
  if (p.processing.length) { const d = el('details', 'processing'); d.append(el('summary', undefined, 'What was done to the original')); const ul = el('ul'); for (const x of p.processing) ul.append(el('li', undefined, x)); d.append(ul); box.append(d); }
  return box;
}

/** Empty containers the discovery interface fills after each render: actions (bookmark, nearby, parent, back) and the relationships + explanation blocks. */
export interface InspectorSlots { readonly actions: HTMLElement; readonly extra: HTMLElement; readonly model: InspectorModel }

export class Inspector {
  /** Called when the user picks another image band for the shown deep-space object. */
  onBand: ((assetId: string) => void) | null = null;
  /** Called after every show(): the discovery interface fills the slots (it knows which object is shown). */
  onRendered: ((slots: InspectorSlots) => void) | null = null;
  /** Called when the inspector is hidden. */
  onHidden: (() => void) | null = null;
  constructor(private readonly root: HTMLElement, private readonly onFocus: () => void, private readonly onClose: () => void) {}

  show(m: InspectorModel, opts: { canFocus: boolean; focusLabel?: string; keepScroll?: boolean } = { canFocus: true }): void {
    const scroll = this.root.scrollTop;
    this.root.replaceChildren();
    this.root.classList.add('open');
    const head = el('header');
    head.append(el('h2', undefined, m.name));
    const close = el('button', 'close', '×');
    close.setAttribute('aria-label', 'Close inspector');
    close.title = 'Close (Esc)';
    close.addEventListener('click', this.onClose);
    head.append(close);
    this.root.append(head);
    this.root.append(el('p', 'class', m.classification));
    for (const n of m.notices ?? []) {
      const box = el('div', `notice ${n.tone}`);
      box.setAttribute('role', 'note');
      box.append(el('b', undefined, n.label), el('span', undefined, ` ${n.text}`));
      this.root.append(box);
    }

    const ids = el('ul', 'ids');
    for (const d of m.designations.slice(0, 10)) ids.append(el('li', undefined, d));
    if (m.designations.length > 10) ids.append(el('li', 'more', `+ ${m.designations.length - 10} more`));
    this.root.append(ids);

    if (opts.canFocus) {
      const focus = el('button', 'focus', opts.focusLabel ?? 'Centre view on this star');
      focus.addEventListener('click', this.onFocus);
      this.root.append(focus);
    } else if (m.representation) {
      this.root.append(el('p', 'class', 'No fly-to position for this entry.'));
    } else {
      this.root.append(el('p', 'class', 'Not shown in 3D: the catalogue gives this source no usable distance or no brightness.'));
    }

    const actionsSlot = el('div', 'disc-actions');
    actionsSlot.dataset['slot'] = 'actions';
    this.root.append(actionsSlot);

    if (m.representation) {
      const sec = el('section', 'seeing');
      sec.dataset['title'] = 'What you are seeing';
      sec.append(el('h3', undefined, 'What you are seeing'), representationNode(m.representation));
      if (m.bands && m.bands.length > 1) {
        const grp = el('div', 'bands');
        grp.setAttribute('role', 'group'); grp.setAttribute('aria-label', 'Image band');
        for (const b of m.bands) {
          const btn = el('button', 'band', b.label);
          btn.dataset['asset'] = b.assetId;
          const on = m.imageProvenance?.assetId === b.assetId;
          btn.setAttribute('aria-pressed', String(on));
          if (on) btn.classList.add('on');
          btn.title = b.falseColour ? 'False-colour image' : 'Image band';
          btn.addEventListener('click', () => this.onBand?.(b.assetId));
          grp.append(btn);
        }
        sec.append(grp);
      }
      if (m.imageProvenance) sec.append(provenanceNode(m.imageProvenance));
      else if (m.noImageNote) sec.append(el('p', 'rep-summary', m.noImageNote));
      this.root.append(sec);
    }
    for (const s of m.sections) {
      const sec = el('section');
      sec.dataset['title'] = s.title;
      sec.append(el('h3', undefined, s.title));
      for (const f of s.fields) sec.append(row(f));
      this.root.append(sec);
    }
    if (m.facts.length) {
      const sec = el('section', 'facts');
      sec.append(el('h3', undefined, 'Context'));
      for (const f of m.facts) {
        const d = el('div', 'fact');
        d.append(el('span', `certainty ${f.status}`, f.status === 'observed' ? 'OBSERVED' : f.status === 'inferred' ? 'INFERRED' : 'HYPOTHESIS'));
        d.append(el('span', 'text', ` ${f.text}`));
        d.title = `Reference: ${f.reference}${f.url ? `\n${f.url}` : ''}`;
        sec.append(d);
      }
      this.root.append(sec);
    }
    if (m.imagery) {
      const sec = el('section', 'imagery');
      sec.append(el('h3', undefined, 'Surface imagery'));
      sec.append(el('div', `fidelity ${m.imagery.fidelity}`, m.imagery.fidelity.replace('-', ' ').toUpperCase()));
      sec.append(el('div', 'summary', m.imagery.summary));
      if (m.imagery.credit) sec.append(el('div', 'credit', `Credit: ${m.imagery.credit}`));
      if (m.imagery.license) sec.append(el('div', 'credit', `Licence: ${m.imagery.license}`));
      this.root.append(sec);
    }
    if (m.flags.length) {
      const sec = el('section', 'flags');
      sec.append(el('h3', undefined, 'Quality flags'));
      for (const f of m.flags) {
        const li = el('div', 'flag');
        li.append(el('b', undefined, f.flag));
        li.append(el('span', undefined, f.description));
        sec.append(li);
      }
      this.root.append(sec);
    }
    const extraSlot = el('div', 'disc-extra');
    extraSlot.dataset['slot'] = 'extra';
    this.root.append(extraSlot);
    const prov = el('section', 'prov');
    prov.append(el('h3', undefined, 'Provenance'));
    prov.append(el('div', 'frame', `Reference frame: ${m.referenceFrame}`));
    for (const p of m.provenance) prov.append(el('div', undefined, p));
    if (m.notes) prov.append(el('div', 'notes', m.notes));
    this.root.append(prov);
    this.root.scrollTop = opts.keepScroll ? scroll : 0;
    document.body.classList.add('inspector-open');
    this.onRendered?.({ actions: actionsSlot, extra: extraSlot, model: m });
  }

  /** Replace the rows of one section in place (for values that change with simulation time) without resetting scroll position. */
  updateLive(section: { title: string; fields: readonly InspectorField[] }): void {
    const sec = [...this.root.querySelectorAll('section')].find((s) => (s as HTMLElement).dataset['title'] === section.title);
    if (!sec) return;
    for (const r of [...sec.querySelectorAll('.row')]) r.remove();
    for (const f of section.fields) sec.append(row(f));
  }

  hide(): void {
    document.body.classList.remove('inspector-open');
    this.root.classList.remove('open');
    this.root.replaceChildren();
    this.onHidden?.();
  }

  get isOpen(): boolean { return this.root.classList.contains('open'); }
}
