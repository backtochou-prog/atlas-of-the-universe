import { describeScale } from '../core/solar/displayScale';
import { SPEED_PRESETS, isoFromJdUtc, jdUtcFromTdb, type SimClock } from '../core/orbits/time';
import { sub, length } from '../core/spatial/vec3';
import type { InspectorField, InspectorSection } from '../data/catalogue/inspect';
import type { SolarSystemData } from '../data/solar/solarCatalogue';
import type { Viewer } from '../render/viewer';
import { formatDistance } from '../core/spatial/scale';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const speedLabel = (s: number): string => {
  if (s < 60) return 'real time';
  if (s < 3600) return `${s / 60} min per second`;
  if (s < 86400) return `${s / 3600} h per second`;
  if (s < 365 * 86400) return `${(s / 86400).toFixed(0)} d per second`;
  return '1 yr per second';
};

export interface SolarUiHooks { select(id: string): void }

/**
 * The Solar System controls: body navigator, time controller, scale status, breadcrumb and name labels.
 * Simulation time is separate from the user's clock: it starts at the dataset's reference epoch and moves only when told to.
 */
export class SolarUi {
  private readonly labels = new Map<string, HTMLButtonElement>();
  private labelsShown = false;
  private readonly last = new Map<string, string>();
  private moonRow: HTMLElement;
  private shownParent = '';

  constructor(private readonly viewer: Viewer, private readonly data: SolarSystemData, private readonly clock: SimClock, private readonly hooks: SolarUiHooks) {
    const bar = document.getElementById('solar-bar')!;
    bar.replaceChildren();
    const planets = el('div', 'row');
    const mk = (id: string, name: string) => {
      const b = el('button', 'chip', name);
      b.dataset['body'] = id;
      b.addEventListener('click', () => { hooks.select(id); viewer.flyToBody(id); });
      return b;
    };
    planets.append(mk('sun', 'Sun'));
    for (const p of data.file.bodies.filter((b) => b.kind === 'planet')) planets.append(mk(p.id, p.name));
    const ov = el('button', 'chip strong', 'Overview');
    ov.title = 'Solar System overview (O)';
    ov.addEventListener('click', () => viewer.flyToOverview());
    const up = el('button', 'chip', 'Parent');
    up.title = 'Back to the parent: moon to planet, planet to overview (Backspace)';
    up.addEventListener('click', () => viewer.flyToParent());
    planets.append(ov, up);
    this.moonRow = el('div', 'row moons');
    bar.append(planets, this.moonRow);

    const t = (id: string, fn: () => void) => document.getElementById(id)!.addEventListener('click', fn);
    t('t-play', () => clock.toggle());
    t('t-slower', () => clock.slower());
    t('t-faster', () => clock.faster());
    t('t-reverse', () => clock.reverse());
    t('t-reset', () => clock.reset());
    t('t-back', () => clock.shiftDays(-1));
    t('t-fwd', () => clock.shiftDays(1));
    t('btn-scale', () => {
      this.viewer.setScaleMode(this.viewer.scalePolicy.mode === 'enhanced' ? 'true' : 'enhanced');
    });
  }

  private set(id: string, text: string): void {
    if (this.last.get(id) === text) return;
    this.last.set(id, text);
    const e = document.getElementById(id);
    if (e) e.textContent = text;
  }

  private syncMoons(): void {
    const sel = this.viewer.selectedBody ?? this.viewer.followId;
    const rec = sel ? this.data.get(sel) : undefined;
    const parent = rec ? (rec.kind === 'moon' ? rec.parent! : rec.kind === 'planet' ? rec.id : '') : '';
    if (parent === this.shownParent) return;
    this.shownParent = parent;
    this.moonRow.replaceChildren();
    if (!parent) return;
    for (const m of this.data.children(parent)) {
      const b = el('button', 'chip small', m.name);
      b.addEventListener('click', () => { this.hooks.select(m.id); this.viewer.flyToBody(m.id); });
      this.moonRow.append(b);
    }
  }

  /** Per-frame refresh of text and labels. */
  update(): void {
    const v = this.viewer;
    const active = v.solarActive;
    document.body.classList.toggle('solar-active', active);
    if (!active) {
      // Leaving the Solar System: the name labels must not stay frozen on screen (they are clickable and would sit on top of deep space).
      if (this.labelsShown) { for (const b of this.labels.values()) b.style.display = 'none'; this.labelsShown = false; }
      return;
    }
    this.labelsShown = true;
    this.syncMoons();
    const jdUtc = jdUtcFromTdb(this.clock.jd);
    this.set('time-utc', `${isoFromJdUtc(jdUtc).replace('T', ' ').replace('Z', '')} UTC`);
    this.set('time-speed', this.clock.paused ? 'paused' : `${this.clock.direction === 1 ? '▶' : '◀'} ${speedLabel(this.clock.speed)}`);
    document.getElementById('t-play')!.textContent = this.clock.paused ? 'Play' : 'Pause';
    const s = describeScale(v.scalePolicy, v.solar?.maxExaggeration ?? 1, v.solar?.maxExaggerationBody ? this.data.get(v.solar.maxExaggerationBody)?.name : undefined);
    this.set('scale-status', s.label);
    document.getElementById('scale-status')!.classList.toggle('warn', s.notToScale);
    this.set('btn-scale', v.scalePolicy.mode === 'enhanced' ? 'Show true scale' : 'Enlarge small bodies');
    this.set('crumbs', v.frame.path.map((p) => p.name).join('  ›  '));
    if (v.solar) {
      const st = v.solar.stats;
      const mb = (v.textures?.estimatedBytes ?? 0) / 1048576;
      this.set('solar-stats', `${st.spheres} spheres · ${st.markers} markers · ${st.orbits} orbits · ${v.textures?.loadedCount ?? 0} textures (${mb.toFixed(0)} MB)`);
    }
    this.syncLabels();
  }

  private syncLabels(): void {
    const v = this.viewer;
    const layer = document.getElementById('labels')!;
    const wanted = new Set<string>();
    for (const info of v.screen.values()) {
      if (!info.visible) continue;
      const rec = this.data.get(info.id)!;
      const parent = rec.parent ? v.screen.get(rec.parent) : undefined;
      // Moons are labelled only when their planet is large on screen (you are in that planet's system) or selected.
      const show = rec.kind !== 'moon' || info.id === v.selectedBody || (parent && parent.pixelRadius > 25 && parent.asSphere) || (parent && parent.pixelRadius > 6 && info.pixelRadius > 1.2);
      if (!show) continue;
      // Hide a label whose body is behind a nearer, larger disc (a distant planet seen through the body you are looking at).
      let hidden = false;
      for (const o of v.screen.values()) {
        if (o === info || !o.asSphere || o.distance >= info.distance) continue;
        if (Math.hypot(o.x - info.x, o.y - info.y) < o.pixelRadius) { hidden = true; break; }
      }
      if (hidden) continue;
      wanted.add(info.id);
      let b = this.labels.get(info.id);
      if (!b) {
        b = el('button', 'label', rec.name); b.dataset['body'] = info.id;
        b.addEventListener('click', (e) => { e.stopPropagation(); this.hooks.select(info.id); v.flyToBody(info.id); });
        layer.append(b); this.labels.set(info.id, b);
      }
      b.style.transform = `translate(${info.x + Math.max(info.pixelRadius, 4) + 6}px, ${info.y - 8}px)`;
      b.style.display = 'block';
      b.classList.toggle('selected', info.id === v.selectedBody);
    }
    for (const [id, b] of this.labels) if (!wanted.has(id)) b.style.display = 'none';
  }

  /** Live rows for the inspector: the current geometry and how the body is being DRAWN versus how big it IS. */
  liveSections(id: string): InspectorSection[] {
    const v = this.viewer;
    const info = v.screen.get(id);
    const rec = this.data.get(id)!;
    const fields: InspectorField[] = [];
    const row = (key: string, label: string, value: string, note?: string): void => { fields.push({ key, label, available: true, value, unit: '', ...(note ? { note } : {}) }); };
    if (rec.parent) {
      const d = length(sub(v.solarData!.ephemeris.heliocentricPosition(id, v.jdTdb), v.solarData!.ephemeris.heliocentricPosition(rec.parent, v.jdTdb)));
      row('distance_parent_now', 'Distance from parent now', `${formatDistance(d)}`, rec.kind === 'planet' ? 'Heliocentric distance at the simulation time (Keplerian model, see Solar System validation).' : 'At the simulation time, from the Keplerian satellite model.');
    }
    if (info) {
      row('camera_distance', 'Distance from camera', formatDistance(info.distance));
      row('drawn_radius', 'Drawn radius vs true radius', info.exaggeration > 1.02 ? `×${info.exaggeration.toPrecision(3)} (ENLARGED for visibility)` : 'true scale', 'The true radius is the measurement above; the drawn size follows the display-scale setting. Orbits and positions are never altered.');
    }
    row('sim_time', 'Simulation time', `${isoFromJdUtc(jdUtcFromTdb(v.jdTdb)).replace('T', ' ').replace('Z', '')} UTC`, `Reference epoch ${isoFromJdUtc(jdUtcFromTdb(this.clock.referenceJd)).slice(0, 10)}; separate from your computer's clock.`);
    return [{ title: 'In this view', fields }];
  }
}

export { SPEED_PRESETS };
