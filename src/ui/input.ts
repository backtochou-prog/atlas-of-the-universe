export interface InputHandlers {
  zoom(delta: number): void;
  rotate(dyaw: number, dpitch: number): void;
  pan(dx: number, dy: number): void;
  pick(x: number, y: number): void;
  resetOrientation(): void;
  home(): void;
  clearSelection(): void;
  toggleTime(): void;
  slower(): void;
  faster(): void;
  reverseTime(): void;
  parent(): void;
  overview(): void;
  /** Optional deep-space scale shortcuts: M = Milky Way, L = Local Group, U = nearby universe. */
  milkyWay?(): void;
  localGroup?(): void;
  nearbyUniverse?(): void;
}

/** Mouse and keyboard bindings. A click that does not move is a pick; a drag rotates (or pans with right button / Shift). */
export function bindInput(canvas: HTMLCanvasElement, h: InputHandlers): () => void {
  let drag: { x: number; y: number; moved: number; pan: boolean } | null = null;
  const onDown = (e: PointerEvent) => {
    canvas.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, moved: 0, pan: e.button === 2 || e.shiftKey };
  };
  const onMove = (e: PointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY; drag.moved += Math.abs(dx) + Math.abs(dy);
    if (drag.pan) h.pan(dx, dy);
    else h.rotate(-dx * 0.005, dy * 0.005);
  };
  const onUp = (e: PointerEvent) => {
    if (drag && drag.moved < 4) {
      const r = canvas.getBoundingClientRect();
      h.pick(e.clientX - r.left, e.clientY - r.top);
    }
    drag = null;
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
    h.zoom(Math.max(-400, Math.min(400, e.deltaY * unit)));
  };
  const onKey = (e: KeyboardEvent) => {
    // Let text boxes and sliders keep their own keys; a focused checkbox or button must not swallow shortcuts.
    if (e.target instanceof HTMLInputElement && e.target.type !== 'checkbox') return;
    // Drop-downs (the Nearby category) and multi-line boxes use the arrow keys themselves.
    if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement || (e.target instanceof HTMLElement && e.target.isContentEditable)) return;
    // Alt+Arrow is atlas history navigation (Back / Forward), not a camera rotation.
    if (e.altKey) return;
    switch (e.key) {
      case '+': case '=': h.zoom(-120); break;
      case '-': case '_': h.zoom(120); break;
      case 'ArrowLeft': h.rotate(0.06, 0); break;
      case 'ArrowRight': h.rotate(-0.06, 0); break;
      case 'ArrowUp': h.rotate(0, -0.05); break;
      case 'ArrowDown': h.rotate(0, 0.05); break;
      case 'r': case 'R': h.resetOrientation(); break;
      case 'h': case 'H': h.home(); break;
      case 'Escape': h.clearSelection(); break;
      case ' ': h.toggleTime(); break;
      case '[': h.slower(); break;
      case ']': h.faster(); break;
      case '\\': h.reverseTime(); break;
      case 'Backspace': h.parent(); break;
      case 'o': case 'O': h.overview(); break;
      case 'm': case 'M': if (!h.milkyWay) return; h.milkyWay(); break;
      case 'l': case 'L': if (!h.localGroup) return; h.localGroup(); break;
      case 'u': case 'U': if (!h.nearbyUniverse) return; h.nearbyUniverse(); break;
      default: return;
    }
    e.preventDefault();
  };
  const noMenu = (e: Event) => e.preventDefault();
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', noMenu);
  window.addEventListener('keydown', onKey);
  return () => {
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('contextmenu', noMenu);
    window.removeEventListener('keydown', onKey);
  };
}
