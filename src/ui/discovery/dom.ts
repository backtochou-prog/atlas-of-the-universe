/**
 * Small DOM helpers for the discovery interface. No framework: elements are built with textContent only (never innerHTML), lists are
 * reconciled by key so a keystroke never rebuilds a long list, and writes are batched with requestAnimationFrame.
 */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function setAttrs(e: Element, attrs: Readonly<Record<string, string | number | boolean | undefined>>): void {
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) e.removeAttribute(k);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
}

/** Only http(s) links are made clickable; anything else is shown as text. */
export function safeLink(text: string, url: string | null | undefined, cls?: string): HTMLElement {
  if (url && /^https?:\/\//i.test(url)) {
    const a = el('a', cls, text);
    a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    return a;
  }
  return el('span', cls, text);
}

/** Coalesce many `schedule()` calls into one `fn` call on the next animation frame (or timer where there is no frame loop). */
export function frameBatch(fn: () => void): { schedule(): void; cancel(): void } {
  let handle: number | null = null;
  const raf = (cb: () => void): number => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : (setTimeout(cb, 16) as unknown as number));
  const caf = (h: number): void => { if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(h); else clearTimeout(h); };
  return {
    schedule() { if (handle !== null) return; handle = raf(() => { handle = null; fn(); }); },
    cancel() { if (handle !== null) { caf(handle); handle = null; } },
  };
}

export interface KeyedItem {
  readonly key: string;
  /** Anything that changes when the row must be redrawn. */
  readonly sig: string;
  build(): HTMLElement;
}

/** Keeps `root`'s children in step with `items`: a row whose key and signature are unchanged is not touched, so typing does not rebuild a long list. */
export class KeyedList {
  private readonly nodes = new Map<string, { el: HTMLElement; sig: string }>();
  constructor(readonly root: HTMLElement) {}

  update(items: readonly KeyedItem[]): void {
    const keep = new Set<string>();
    items.forEach((item, i) => {
      keep.add(item.key);
      let rec = this.nodes.get(item.key);
      if (!rec || rec.sig !== item.sig) {
        const fresh = item.build();
        if (rec && rec.el.parentNode === this.root) this.root.replaceChild(fresh, rec.el);
        rec = { el: fresh, sig: item.sig };
        this.nodes.set(item.key, rec);
      }
      const at = this.root.children[i] ?? null;
      if (at !== rec.el) this.root.insertBefore(rec.el, at);
    });
    for (const [k, rec] of this.nodes) if (!keep.has(k)) { rec.el.remove(); this.nodes.delete(k); }
  }

  clear(): void { this.root.replaceChildren(); this.nodes.clear(); }
  get size(): number { return this.nodes.size; }
}

/** Polite live-region announcement (one shared element). */
let live: HTMLElement | null = null;
export function announce(text: string): void {
  if (typeof document === 'undefined') return;
  if (!live) {
    live = el('div', 'sr-only');
    live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite');
    document.body.append(live);
  }
  live.textContent = text;
}
