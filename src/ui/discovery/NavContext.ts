/**
 * Navigation context: back / forward / return-to-previous-view controls (labelled with the name of the object they lead to) and a one-line statement of
 * what the camera is doing. No per-frame work: it reacts to atlas selection events and polls the flight flag every 250 ms only while a flight runs.
 */
import type { DiscoveryAtlas, AtlasNavResult, SelectionEvent } from '../../discovery/atlas';
import { announce } from './dom';
import { flightStatement, navControls } from './navViewModel';

export class NavContext {
  private readonly back: HTMLButtonElement;
  private readonly fwd: HTMLButtonElement;
  private readonly prev: HTMLButtonElement;
  private readonly line: HTMLElement;
  private poll: ReturnType<typeof setInterval> | undefined;
  private lastLine = '';

  constructor(private readonly root: HTMLElement, private readonly atlas: DiscoveryAtlas, private readonly isFlying: () => boolean) {
    this.back = root.querySelector<HTMLButtonElement>('#nav-back')!;
    this.fwd = root.querySelector<HTMLButtonElement>('#nav-fwd')!;
    this.prev = root.querySelector<HTMLButtonElement>('#nav-prev')!;
    this.line = root.querySelector<HTMLElement>('#nav-line')!;
    this.back.addEventListener('click', () => this.report(this.atlas.back()));
    this.fwd.addEventListener('click', () => this.report(this.atlas.forward()));
    this.prev.addEventListener('click', () => this.report(this.atlas.returnToPrevious()));
    atlas.onSelectionChange((e) => this.onSelection(e));
    this.refresh();
  }

  backAction(): void { this.report(this.atlas.back()); }
  forwardAction(): void { this.report(this.atlas.forward()); }

  private report(r: AtlasNavResult): void {
    if (!r.ok) this.say(r.message);
    this.refresh();
  }

  private say(text: string): void {
    if (text === this.lastLine) return;
    this.lastLine = text;
    this.line.textContent = text;
    this.line.hidden = text === '';
    if (text !== '') this.root.hidden = false;
  }

  refresh(): void {
    const c = navControls(this.atlas.navHistory(), this.atlas.navState(), (id) => this.atlas.peek(id)?.name);
    for (const [btn, vm] of [[this.back, c.back], [this.fwd, c.forward], [this.prev, c.previous]] as const) {
      if (btn.textContent !== vm.label) btn.textContent = vm.label;
      btn.disabled = !vm.enabled; btn.title = vm.title;
    }
    const st = this.atlas.navState();
    this.root.hidden = st === null || (!st.canBack && !st.canForward && st.length <= 1 && this.lastLine === '');
  }

  private onSelection(e: SelectionEvent): void {
    this.refresh();
    clearInterval(this.poll);
    if (e.id === null || !e.record) { this.say(''); return; }
    const rec = e.record;
    if (!e.focus) { this.say(flightStatement(rec.name, rec, 'no-flight')); return; }
    if (rec.position.kind === 'sky-only') { this.say(flightStatement(rec.name, rec, 'flying')); announce(this.lastLine); return; }
    this.say(flightStatement(rec.name, rec, 'flying'));
    let idle = 0, ticks = 0;
    this.poll = setInterval(() => {
      ticks++;
      idle = this.isFlying() ? 0 : idle + 1;
      if (idle >= 2 || ticks > 120) { clearInterval(this.poll); this.say(flightStatement(rec.name, rec, 'arrived')); }
    }, 250);
  }
}
