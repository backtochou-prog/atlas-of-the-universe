/** Shared row builders of the drawer: an object row is one button (select + fly), so it is keyboard reachable and has a large touch target. */
import { el } from './dom';

export interface ObjectRowOpts {
  readonly id: string;
  readonly name: string;
  readonly category?: string | null;
  readonly right?: string;
  readonly sub?: string;
  readonly muted?: boolean;
  readonly disabled?: boolean;
  readonly title?: string;
}

export function objectRowButton(o: ObjectRowOpts, onChoose: (id: string, fly: boolean) => void): HTMLButtonElement {
  const b = el('button', `obj-row${o.muted ? ' muted' : ''}`);
  b.type = 'button'; b.dataset['id'] = o.id;
  if (o.disabled) b.disabled = true;
  if (o.title) b.title = o.title;
  b.append(el('span', 'r-cat', o.category ?? ''), el('span', 'r-name', o.name), el('span', 'r-dist', o.right ?? ''));
  if (o.sub) b.append(el('span', 'r-sub', o.sub));
  b.addEventListener('click', (e) => onChoose(o.id, !e.shiftKey));
  return b;
}

export function sectionHead(text: string): HTMLElement { return el('h3', 'dr-h', text); }
export function note(text: string, cls = 'dr-note'): HTMLElement { return el('p', cls, text); }
export interface Tab { readonly id: string; readonly label: string; readonly root: HTMLElement; onShow(): void; onHide?(): void }
