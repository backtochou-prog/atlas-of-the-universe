import { METRES_PER_PARSEC, parsecToLightYear } from '../core/units';
import { formatDistance } from '../core/spatial/scale';
import type { StarLayer } from '../render/starLayer';

const fmt = (pc: number): string => formatDistance(pc * METRES_PER_PARSEC);

const byId = (id: string): HTMLElement => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Missing element #${id}`);
  return e;
};

/** Writes text only when it changes, so the per-frame update does not churn the DOM. */
export class Hud {
  private last = new Map<string, string>();
  private set(id: string, text: string): void {
    if (this.last.get(id) === text) return;
    this.last.set(id, text);
    byId(id).textContent = text;
  }

  setDataset(info: { catalogued: number; layer: StarLayer; simbadMatched: number | null; release: string; retrieved: string }): void {
    const s = info.layer.skipped;
    this.set('ds-line', `${info.layer.count.toLocaleString('en-US')} stars drawn from ${info.catalogued.toLocaleString('en-US')} Gaia ${info.release} records`);
    const notes = [
      `${s.noDistance.toLocaleString('en-US')} have no reliable parallax distance and are not placed in 3D`,
      `${s.noGMagnitude.toLocaleString('en-US')} have no G magnitude and are not drawn`,
      ...(s.outsideExtent ? [`${s.outsideExtent} lie beyond the 10 kpc frame`] : []),
    ];
    this.set('ds-skipped', notes.join(' · '));
    this.set('ds-source', `Gaia ${info.release} · retrieved ${info.retrieved}${info.simbadMatched !== null ? ` · SIMBAD identifications for ${info.simbadMatched.toLocaleString('en-US')} records` : ' · SIMBAD identifications not loaded'}`);
  }

  update(v: { distancePc: number; viewportHeight: number; fovSpanPc: number; magLimit: number; drawCalls: number; flying: boolean }): void {
    this.set('focus-distance', `${fmt(v.distancePc)} · ${(parsecToLightYear(v.distancePc)).toPrecision(3)} ly from focus`);
    this.set('span', `Field of view spans about ${fmt(v.fovSpanPc)} at the focus`);
    this.set('mag-value', v.magLimit.toFixed(1));
    this.set('calls', `${v.drawCalls} draw call${v.drawCalls === 1 ? '' : 's'}${v.flying ? ' · moving' : ''}`);
  }

  status(text: string): void { this.set('status', text); }
}
