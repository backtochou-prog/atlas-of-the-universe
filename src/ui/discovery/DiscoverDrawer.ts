/**
 * The Discover drawer: a left-side sheet (a bottom sheet on a phone) with the tabs Featured, Filter, Nearby, Saved. Closed, it takes no space and the scene is untouched.
 * Pinned, it is narrower, so the scene keeps more room. Tabs follow the WAI-ARIA tabs pattern (arrow keys, Home, End).
 */
import { el } from './dom';
import type { Tab } from './rows';

export type TabId = 'featured' | 'filter' | 'nearby' | 'saved';
const PIN_KEY = 'atlas.drawer.pinned';

export class DiscoverDrawer {
  readonly root: HTMLElement;
  private readonly tablist: HTMLElement;
  private readonly tabButtons = new Map<string, HTMLButtonElement>();
  private readonly panels = new Map<string, HTMLElement>();
  private current: string;
  private opened = false;
  private pinned = false;
  private returnFocus: HTMLElement | null = null;
  private readonly pinBtn: HTMLButtonElement;
  onChange: ((e: { open: boolean; tab: string; pinned: boolean }) => void) | null = null;

  constructor(root: HTMLElement, private readonly tabs: readonly Tab[], private readonly toggleBtn: HTMLButtonElement | null) {
    this.root = root;
    this.current = tabs[0]!.id;
    root.replaceChildren();
    root.setAttribute('role', 'complementary');
    root.setAttribute('aria-label', 'Discover');
    root.hidden = true;

    const head = el('header', 'dr-head');
    head.append(el('h2', undefined, 'Discover'));
    this.pinBtn = el('button', 'dr-btn', 'Narrow');
    this.pinBtn.type = 'button'; this.pinBtn.setAttribute('aria-pressed', 'false');
    this.pinBtn.title = 'Pin the drawer narrow so the scene keeps more room';
    this.pinBtn.addEventListener('click', () => this.setPinned(!this.pinned));
    const close = el('button', 'close', '×');
    close.type = 'button'; close.setAttribute('aria-label', 'Close the Discover drawer'); close.title = 'Close (Esc or D)';
    close.addEventListener('click', () => this.close());
    head.append(this.pinBtn, close);
    root.append(head);

    this.tablist = el('div', 'dr-tabs');
    this.tablist.setAttribute('role', 'tablist'); this.tablist.setAttribute('aria-label', 'Discover sections');
    root.append(this.tablist);
    const bodies = el('div', 'dr-bodies');
    for (const t of tabs) {
      const b = el('button', 'dr-tab', t.label);
      b.type = 'button'; b.id = `dr-tab-${t.id}`; b.setAttribute('role', 'tab'); b.setAttribute('aria-controls', `dr-panel-${t.id}`);
      b.setAttribute('aria-selected', 'false'); b.tabIndex = -1;
      b.addEventListener('click', () => this.show(t.id));
      this.tablist.append(b); this.tabButtons.set(t.id, b);
      const p = el('div', 'dr-panel');
      p.id = `dr-panel-${t.id}`; p.setAttribute('role', 'tabpanel'); p.setAttribute('aria-labelledby', b.id); p.hidden = true; p.tabIndex = -1;
      p.append(t.root);
      bodies.append(p); this.panels.set(t.id, p);
    }
    root.append(bodies);
    this.tablist.addEventListener('keydown', (e) => this.onTabKey(e));
    try { this.pinned = localStorage.getItem(PIN_KEY) === '1'; } catch { /* storage blocked: the pin is not remembered */ }
    this.applyPin();
    this.select(this.current, false);
    toggleBtn?.addEventListener('click', () => this.toggle());
  }

  get isOpen(): boolean { return this.opened; }
  get tab(): string { return this.current; }
  get isPinned(): boolean { return this.pinned; }
  contains(n: Node | null): boolean { return n !== null && this.root.contains(n); }

  open(tab?: string, focus = true): void {
    if (!this.opened) {
      this.returnFocus = document.activeElement instanceof HTMLElement && !this.root.contains(document.activeElement) ? document.activeElement : null;
      this.opened = true;
      this.root.hidden = false;
      document.body.classList.add('drawer-open');
      this.toggleBtn?.setAttribute('aria-expanded', 'true');
    }
    this.select(tab ?? this.current, true);
    if (focus) this.tabButtons.get(this.current)?.focus();
    this.emit();
  }

  close(restoreFocus = true): void {
    if (!this.opened) return;
    this.opened = false;
    this.root.hidden = true;
    document.body.classList.remove('drawer-open');
    this.toggleBtn?.setAttribute('aria-expanded', 'false');
    this.tabs.find((t) => t.id === this.current)?.onHide?.();
    if (restoreFocus && this.root.contains(document.activeElement)) {
      const back = this.returnFocus && this.returnFocus.isConnected && this.returnFocus !== document.body ? this.returnFocus : this.toggleBtn;
      if (back) back.focus(); else (document.activeElement as HTMLElement | null)?.blur();
    }
    this.returnFocus = null;
    this.emit();
  }

  toggle(): void { if (this.opened) this.close(); else this.open(); }

  show(id: string): void { if (!this.opened) this.open(id); else { this.select(id, true); this.emit(); } }

  private select(id: string, activate: boolean): void {
    const prev = this.current;
    if (prev !== id) this.tabs.find((t) => t.id === prev)?.onHide?.();
    this.current = id;
    for (const [tid, b] of this.tabButtons) {
      const on = tid === id;
      b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1;
      this.panels.get(tid)!.hidden = !on;
    }
    if (activate && this.opened) this.tabs.find((t) => t.id === id)?.onShow();
  }

  private onTabKey(e: KeyboardEvent): void {
    const ids = this.tabs.map((t) => t.id);
    const i = ids.indexOf(this.current);
    let n = i;
    if (e.key === 'ArrowRight') n = (i + 1) % ids.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + ids.length) % ids.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = ids.length - 1;
    else return;
    e.preventDefault();
    this.select(ids[n]!, true);
    this.tabButtons.get(ids[n]!)!.focus();
    this.emit();
  }

  setPinned(v: boolean): void {
    this.pinned = v;
    try { localStorage.setItem(PIN_KEY, v ? '1' : '0'); } catch { /* blocked */ }
    this.applyPin();
    this.emit();
  }

  private applyPin(): void {
    document.body.classList.toggle('drawer-pinned', this.pinned);
    this.pinBtn.setAttribute('aria-pressed', String(this.pinned));
    this.pinBtn.textContent = this.pinned ? 'Wide' : 'Narrow';
    this.pinBtn.title = this.pinned ? 'Make the drawer wide again' : 'Pin the drawer narrow so the scene keeps more room';
  }

  private emit(): void { this.onChange?.({ open: this.opened, tab: this.current, pinned: this.pinned }); }
}
