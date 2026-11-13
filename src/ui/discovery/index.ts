/**
 * Mounts the discovery interface: search box, Discover drawer, navigation context and the inspector additions. Everything here talks to the atlas
 * (src/discovery/atlas.ts) only through its public API; nothing runs per frame.
 */
import type { DiscoveryAtlas } from '../../discovery/atlas';
import type { Inspector } from '../inspector';
import { DiscoverDrawer, type TabId } from './DiscoverDrawer';
import { FeaturedTab } from './FeaturedTab';
import { FilterTab } from './FilterTab';
import { InspectorExtras } from './InspectorExtras';
import { NavContext } from './NavContext';
import { NearbyTab } from './NearbyTab';
import { SavedTab } from './SavedTab';
import { SearchBox, type FallbackHit } from './SearchBox';
import { hasFilterParams } from './filterViewModel';

export interface DiscoveryUiDeps {
  readonly atlas: DiscoveryAtlas;
  readonly inspector: Inspector;
  /** The one entry point for "the user chose this object" (main.ts selectById). */
  select(id: string, o: { fly: boolean; context: string }): void;
  /** The universal id the inspector shows now. */
  shownId(): string | null;
  isFlying(): boolean;
  /** Backspace / "Go to parent" (atlas.parent with the viewer's scale flights as fallback). */
  goParent(): void;
  /** Search before the engine has an index: the Gaia sample and the curated deep-space objects. */
  fallbackSearch?(query: string): readonly FallbackHit[];
}

export interface DiscoveryUi {
  readonly search: SearchBox;
  readonly drawer: DiscoverDrawer;
  readonly nav: NavContext;
  readonly extras: InspectorExtras;
  readonly filter: FilterTab;
  readonly nearby: NearbyTab;
  /** Re-attach relations / explanation / actions for the shown object (after the page re-rendered the inspector some other way). */
  retarget(): void;
}

const isEditable = (t: EventTarget | null): boolean => {
  if (!(t instanceof HTMLElement)) return false;
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t.isContentEditable) return true;
  return t instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'range', 'file'].includes(t.type);
};

export function mountDiscoveryUi(d: DiscoveryUiDeps): DiscoveryUi {
  const { atlas, inspector } = d;
  const choose = (id: string, o: { fly: boolean; context: string }): void => d.select(id, o);
  const chooseRow = (id: string, fly: boolean): void => choose(id, { fly, context: 'discover drawer' });

  const input = document.getElementById('search') as HTMLInputElement;
  const search = new SearchBox({ atlas, choose, ...(d.fallbackSearch ? { fallback: d.fallbackSearch } : {}) }, input);

  const featured = new FeaturedTab(atlas, chooseRow);
  const filter = new FilterTab(atlas, chooseRow);
  const nearby = new NearbyTab(atlas, chooseRow);
  const saved = new SavedTab(atlas, chooseRow);
  const drawer = new DiscoverDrawer(document.getElementById('discover')!, [featured, filter, nearby, saved], document.getElementById('discover-btn') as HTMLButtonElement | null);
  const nav = new NavContext(document.getElementById('nav-ctx')!, atlas, d.isFlying);

  const extras = new InspectorExtras({
    atlas, choose,
    goParent: d.goParent,
    findNearby: (id) => { nearby.setOrigin(id); drawer.show('nearby'); },
    shownId: d.shownId,
  });
  inspector.onRendered = (slots) => extras.render(slots);
  inspector.onHidden = () => extras.release();

  // ---- layout helpers (no per-frame work): the drawer starts below the HUD text, whatever height it has ----------------------------------------
  const hud = document.getElementById('hud-tl');
  if (hud) {
    const setTop = (): void => { document.documentElement.style.setProperty('--drawer-top', `${Math.ceil(hud.getBoundingClientRect().bottom + 8)}px`); };
    setTop();
    if (typeof ResizeObserver === 'function') new ResizeObserver(setTop).observe(hud);
    window.addEventListener('resize', setTop);
  }
  // On a phone the scene comes first: the deep-space panel and the long data note start collapsed (the user can open them).
  if (window.matchMedia('(max-width: 700px)').matches) {
    document.querySelector<HTMLButtonElement>('#deep-panel .dp-head button[aria-expanded="true"]')?.click();
    const nd = document.getElementById('note-details') as HTMLDetailsElement | null;
    if (nd) nd.open = false;
  }

  // ---- URL hash: the filter state and the drawer tab are shareable ---------------------------------------------------------------
  const writeHash = (): void => {
    const keep = new URLSearchParams(location.hash.replace(/^#/, ''));
    for (const k of [...keep.keys()]) if (k === 'd' || k.startsWith('f.')) keep.delete(k);
    const f = filter.hash();
    const parts: string[] = [];
    if (drawer.isOpen && (drawer.tab === 'filter' || f)) parts.push(`d=${drawer.tab}`);
    if (f) parts.push(f);
    const rest = keep.toString();
    const h = [rest, ...parts].filter(Boolean).join('&');
    try { history.replaceState(null, '', `${location.pathname}${location.search}${h ? `#${h}` : ''}`); } catch { /* sandboxed */ }
  };
  filter.onStateChange = writeHash;
  drawer.onChange = writeHash;
  if (hasFilterParams(location.hash)) {
    filter.loadHash(location.hash);
    drawer.open('filter', false);
  }

  // ---- narrow screens: one panel at a time ---------------------------------------------------------------------------------------
  const narrow = window.matchMedia('(max-width: 1099px)');
  atlas.onSelectionChange((ev) => { if (ev.id !== null && narrow.matches && drawer.isOpen) drawer.close(false); });
  let inspectorShownAt = 0, drawerOpenedAt = 0;
  const prevRendered = inspector.onRendered;
  inspector.onRendered = (s) => { inspectorShownAt = performance.now(); prevRendered?.(s); };
  const prevChange = drawer.onChange;
  drawer.onChange = (e) => { if (e.open) drawerOpenedAt = performance.now(); prevChange?.(e); };

  // ---- keyboard: '/' search, D drawer, Alt+Left / Alt+Right history, Esc closes the top-most panel -------------------------------------
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey) return;
    if (e.key === 'Escape') {
      if (search.isOpen || e.target === search.input) return;          // the search box handles its own Escape
      const t = e.target as Node | null;
      const inDrawer = drawer.contains(t);
      const inInspector = t instanceof Node && document.getElementById('inspector')!.contains(t);
      if (drawer.isOpen && (inDrawer || (!inInspector && (!inspector.isOpen || drawerOpenedAt >= inspectorShownAt)))) {
        drawer.close(); e.preventDefault(); e.stopPropagation();
      }
      return;
    }
    if (isEditable(e.target)) return;
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      if (e.key === 'ArrowLeft') nav.backAction(); else nav.forwardAction();
      e.preventDefault(); e.stopPropagation();
      return;
    }
    if (e.altKey) return;
    if (e.key === '/') { e.preventDefault(); e.stopPropagation(); search.focus(); }
    else if (e.key === 'd' || e.key === 'D') {
      // inside the drawer's own controls D is a plain letter only in text boxes (handled above); elsewhere it toggles
      e.preventDefault(); e.stopPropagation(); drawer.toggle();
    }
  }, true);

  return { search, drawer, nav, extras, filter, nearby, retarget: () => extras.retarget() };
}

export type { TabId };
