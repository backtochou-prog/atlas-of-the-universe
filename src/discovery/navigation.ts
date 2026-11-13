/**
 * Viewer-agnostic navigation (Prompt 07). The controller keeps selection history and decides WHAT to look at and HOW CLOSE; it never moves
 * a camera. It asks the host (the viewer) to do that, through NavigationHost. No DOM, no Three.js: a test double implements the host.
 *
 * History model: a bounded list of entries { selection, camera snapshot, frame id } with a cursor. The camera snapshot of an entry is
 * taken when it is LEFT (select / back / forward / deselect), so returning to it restores exactly the view the user left.
 *
 * Call order of select(id) on the host (a contract, asserted by tests):
 *   resolve(id) -> snapshot() -> currentFrame() -> setSelection(id) -> highlight([]) -> [positionOf(record), viewDistance(record)] -> focus(plan)
 * An unknown id touches only resolve(id). Selecting the already selected id is a complete no-op (no history entry, no host call but resolve).
 */
import type { Vec3 } from '../core/spatial/vec3';
import { METRES_PER_PARSEC } from '../core/units';
import type { RelationGraph, RelationLink } from './relations';
import type { DiscoveryRecord, UniversalId } from './types';

export interface CameraSnapshot {
  /** Frame id the camera state is expressed in (host-defined, e.g. 'stellar-neighbourhood'). */
  readonly frame: string;
  /** Orbit focus, parsecs, Sun-centred ICRS. */
  readonly focus: Vec3;
  /** Distance from focus, parsecs. */
  readonly distance: number;
  readonly yaw: number;
  readonly pitch: number;
}

export type FocusTarget =
  | { readonly kind: 'point'; readonly xyzPc: Vec3 }
  | { readonly kind: 'solar-body'; readonly bodyId: string }
  | { readonly kind: 'direction'; readonly raDeg: number; readonly decDeg: number }
  | { readonly kind: 'none' };

export interface FocusPlan {
  readonly id: UniversalId;
  readonly record: DiscoveryRecord;
  readonly target: FocusTarget;
  /** Preferred distance from the target in parsecs; undefined = the host decides. */
  readonly viewDistancePc: number | undefined;
  /** True when the object cannot be drawn at this scale (or has no 3D position): the host should draw a selection proxy marker. */
  readonly proxy: boolean;
  readonly proxyReason?: string;
  readonly transitionMs: number;
  /** One sentence saying why we are going here ("selected from search", "parent of X"). */
  readonly reason: string;
}

export interface NavigationHost {
  focus(plan: FocusPlan): void;
  snapshot(): CameraSnapshot;
  restore(snapshot: CameraSnapshot, ms: number): void;
  setSelection(id: UniversalId | null): void;
  highlight(ids: readonly UniversalId[]): void;
  currentFrame(): string;
  resolve(id: UniversalId): DiscoveryRecord | undefined;
  /** Heliocentric ICRS parsecs, or undefined when the host cannot place the record (Solar System bodies are placed by the host's own ephemeris callback). */
  positionOf(record: DiscoveryRecord): Vec3 | undefined;
  /** The host's own view-distance rule (a planet from its data's view rule, a galaxy at 2.2 x its diameter, ...), parsecs; undefined = use the default rule. */
  viewDistance?(record: DiscoveryRecord): number | undefined;
}

export interface NavigationOptions {
  readonly maxHistory?: number;
  readonly transitionMs?: number;
  readonly restoreMs?: number;
  /** Neighbours of a record for nearbyNavigation (wire src/discovery/nearby.ts here). Nearest first. */
  readonly nearby?: (record: DiscoveryRecord, k: number) => readonly { readonly id: UniversalId; readonly distanceText?: string }[];
}

export interface NavEntry { readonly selection: UniversalId | null; readonly camera: CameraSnapshot | undefined; readonly frame: string | undefined }
export interface NavState { readonly selection: UniversalId | null; readonly canBack: boolean; readonly canForward: boolean; readonly length: number; readonly cursor: number }

export type NavFailure = 'unknown-id' | 'at-start' | 'at-end' | 'no-previous' | 'no-parent' | 'no-selection' | 'no-neighbours' | 'not-available';
export type NavResult =
  | { readonly ok: true; readonly noop: boolean; readonly plan?: FocusPlan; readonly via?: RelationLink }
  | { readonly ok: false; readonly error: NavFailure; readonly message: string };

/**
 * Default view distances when the host supplies none. These are conventions of this application ("a few parsecs" for a star), not data.
 *  star / exoplanet host / exoplanet:  4 pc
 *  planet / moon:                      4 x the mean radius, when the record has a radius
 *  galaxy:                             2.2 x physical size, when known
 *  nebula / cluster / remnant:         3 x physical size, when known
 *  galaxy group / cluster:             1.5 x physical size, when known
 * Otherwise undefined: the host decides.
 */
export function defaultViewDistancePc(r: DiscoveryRecord): number | undefined {
  const size = r.measurements.physicalSizePc?.value;
  switch (r.category) {
    case 'star': case 'exoplanet-host': case 'exoplanet': return 4;
    case 'planet': case 'moon': { const km = r.measurements.radiusKm?.value; return km !== undefined && km > 0 ? (km * 1000 * 4) / METRES_PER_PARSEC : undefined; }
    case 'galaxy': return size !== undefined && size > 0 ? 2.2 * size : undefined;
    case 'nebula': case 'star-cluster': case 'supernova-remnant': return size !== undefined && size > 0 ? 3 * size : undefined;
    case 'galaxy-group': case 'galaxy-cluster': return size !== undefined && size > 0 ? 1.5 * size : undefined;
    default: return undefined;
  }
}

export class NavigationController {
  private entries: { selection: UniversalId | null; camera: CameraSnapshot | undefined; frame: string | undefined }[] = [{ selection: null, camera: undefined, frame: undefined }];
  private cursor = 0;
  private previous = -1;
  private readonly maxHistory: number;
  private readonly transitionMs: number;
  private readonly restoreMs: number;
  private readonly listeners = new Set<(s: NavState) => void>();

  constructor(private readonly host: NavigationHost, private readonly graph: RelationGraph | null = null, private readonly opts: NavigationOptions = {}) {
    this.maxHistory = Math.max(2, Math.floor(opts.maxHistory ?? 50));
    this.transitionMs = opts.transitionMs ?? 1200;
    this.restoreMs = opts.restoreMs ?? 900;
  }

  get selection(): UniversalId | null { return this.entries[this.cursor]!.selection; }
  state(): NavState {
    return { selection: this.selection, canBack: this.cursor > 0, canForward: this.cursor < this.entries.length - 1, length: this.entries.length, cursor: this.cursor };
  }
  history(): readonly NavEntry[] { return this.entries.map((e) => ({ ...e })); }
  subscribe(l: (s: NavState) => void): () => void { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  private emit(): void { const s = this.state(); for (const l of [...this.listeners]) l(s); }

  /** Build the plan for a record without executing it. */
  plan(record: DiscoveryRecord, reason: string): FocusPlan {
    const p = record.position;
    let target: FocusTarget = { kind: 'none' };
    let proxy = !record.drawn;
    let proxyReason = proxy ? 'This object is not drawn at this scale; a marker shows where it is.' : undefined;
    if (p.kind === 'solar') target = { kind: 'solar-body', bodyId: p.bodyId };
    else if (p.kind === 'icrs') target = { kind: 'point', xyzPc: this.host.positionOf(record) ?? p.xyzPc };
    else if (Number.isFinite(p.raDeg) && Number.isFinite(p.decDeg)) {
      target = { kind: 'direction', raDeg: p.raDeg, decDeg: p.decDeg };
      proxy = true;
      proxyReason = 'The distance is unknown, so the object has no 3D position; a marker shows its direction.';
    } else {
      proxy = true;
      proxyReason = 'The object has no position of its own (it is defined by its members); nothing to point at.';
    }
    const viewDistancePc = this.host.viewDistance?.(record) ?? defaultViewDistancePc(record);
    return { id: record.id, record, target, viewDistancePc, proxy, ...(proxyReason ? { proxyReason } : {}), transitionMs: this.transitionMs, reason };
  }

  private leave(): void {
    const e = this.entries[this.cursor]!;
    e.camera = this.host.snapshot();
    e.frame = this.host.currentFrame();
  }

  private push(selection: UniversalId | null): void {
    this.entries.length = this.cursor + 1;           // forward history is discarded
    this.previous = this.cursor;
    this.entries.push({ selection, camera: undefined, frame: undefined });
    this.cursor++;
    while (this.entries.length > this.maxHistory) {
      this.entries.shift();
      this.cursor--;
      this.previous = this.previous <= 0 ? -1 : this.previous - 1;
    }
  }

  select(id: UniversalId, reason = 'selected'): NavResult {
    const rec = this.host.resolve(id);
    if (rec === undefined) return { ok: false, error: 'unknown-id', message: `"${id}" is not an object in the loaded datasets.` };
    if (id === this.selection) return { ok: true, noop: true };
    this.leave();
    this.push(id);
    this.host.setSelection(id);
    this.host.highlight([]);
    const plan = this.plan(rec, reason);
    this.host.focus(plan);
    this.emit();
    return { ok: true, noop: false, plan };
  }

  /** Clear the selection. The camera stays where it is; the history gets an entry so back() returns to the previous selection. */
  deselect(): NavResult {
    if (this.selection === null) return { ok: true, noop: true };
    this.leave();
    this.push(null);
    this.host.setSelection(null);
    this.host.highlight([]);
    this.emit();
    return { ok: true, noop: false };
  }

  private jump(index: number): NavResult {
    this.leave();
    this.previous = this.cursor;
    this.cursor = index;
    const e = this.entries[index]!;
    this.host.setSelection(e.selection);
    this.host.highlight([]);
    let plan: FocusPlan | undefined;
    if (e.camera) this.host.restore(e.camera, this.restoreMs);
    else if (e.selection !== null) {
      const rec = this.host.resolve(e.selection);
      if (rec) { plan = this.plan(rec, 'returned to'); this.host.focus(plan); }
    }
    this.emit();
    return { ok: true, noop: false, ...(plan ? { plan } : {}) };
  }

  back(): NavResult {
    if (this.cursor === 0) return { ok: false, error: 'at-start', message: 'There is nothing earlier in the history.' };
    return this.jump(this.cursor - 1);
  }
  forward(): NavResult {
    if (this.cursor >= this.entries.length - 1) return { ok: false, error: 'at-end', message: 'There is nothing later in the history.' };
    return this.jump(this.cursor + 1);
  }
  /** Jump to the entry that was current before this one (toggles between the last two places, even after back / forward). */
  returnToPrevious(): NavResult {
    if (this.previous < 0 || this.previous >= this.entries.length || this.previous === this.cursor) return { ok: false, error: 'no-previous', message: 'There is no previous place to return to.' };
    return this.jump(this.previous);
  }

  /**
   * Select the physical or structural parent of the current selection from the relation graph (what it orbits, what it is part of).
   * Associations ("listed with") are used only if includeAssociation is true. Parents the host cannot resolve are skipped.
   */
  parent(opts: { readonly includeAssociation?: boolean } = {}): NavResult {
    const sel = this.selection;
    if (sel === null) return { ok: false, error: 'no-selection', message: 'Nothing is selected.' };
    if (!this.graph) return { ok: false, error: 'not-available', message: 'No relation data is loaded.' };
    const basis = opts.includeAssociation ? undefined : (['physical-gravitational', 'structural'] as const);
    for (const link of this.graph.parentsOf(sel, basis ? { basis } : {})) {
      if (this.host.resolve(link.id) === undefined) continue;
      const r = this.select(link.id, `parent: ${link.relation.statement}`);
      return r.ok ? { ...r, via: link } : r;
    }
    return { ok: false, error: 'no-parent', message: 'The relation data lists no parent for this object.' };
  }

  /** Nearest neighbours of the current selection, highlighted in the viewer. Returns them nearest first. */
  nearbyNavigation(k = 8): { readonly ok: true; readonly neighbours: readonly { id: UniversalId; distanceText?: string }[] } | { readonly ok: false; readonly error: NavFailure; readonly message: string } {
    const sel = this.selection;
    if (sel === null) return { ok: false, error: 'no-selection', message: 'Nothing is selected.' };
    if (!this.opts.nearby) return { ok: false, error: 'not-available', message: 'No neighbour search is wired in.' };
    const rec = this.host.resolve(sel);
    if (!rec) return { ok: false, error: 'unknown-id', message: `"${sel}" is no longer available.` };
    const list = this.opts.nearby(rec, Math.max(1, Math.floor(k)));
    if (list.length === 0) return { ok: false, error: 'no-neighbours', message: 'No neighbours were found.' };
    this.host.highlight(list.map((n) => n.id));
    return { ok: true, neighbours: list };
  }
  /** Select the i-th neighbour returned by the last nearbyNavigation. */
  selectNeighbour(id: UniversalId): NavResult { return this.select(id, 'nearby neighbour'); }
}
