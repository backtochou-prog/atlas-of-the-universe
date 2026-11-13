/**
 * Navigation context view model (pure): labels of the back / forward / return controls and the one-line statement of what the camera is doing.
 */
import type { NavState } from '../../discovery/navigation';
import { placementNotice } from './labels';
import type { DiscoveryRecord } from '../../discovery/types';

export interface NavEntryLite { readonly selection: string | null }
export interface NavButtonVm { readonly enabled: boolean; readonly label: string; readonly title: string }
export interface NavControlsVm { readonly back: NavButtonVm; readonly forward: NavButtonVm; readonly previous: NavButtonVm }

const NO_SELECTION = 'previous view';

/** Back / Forward are labelled with the NAME of the object they lead to (or "previous view" when that history entry is a view with nothing selected). */
export function navControls(history: readonly NavEntryLite[], state: NavState | null, nameOf: (id: string) => string | undefined): NavControlsVm {
  const label = (idx: number): string => {
    const sel = history[idx]?.selection ?? null;
    return sel === null ? NO_SELECTION : (nameOf(sel) ?? sel);
  };
  if (!state) {
    const off: NavButtonVm = { enabled: false, label: 'Back', title: 'Nothing to go back to' };
    return { back: off, forward: { ...off, label: 'Forward', title: 'Nothing to go forward to' }, previous: { ...off, label: 'Return to previous view', title: 'No previous view yet' } };
  }
  const b = state.canBack ? label(state.cursor - 1) : null;
  const f = state.canForward ? label(state.cursor + 1) : null;
  return {
    back: { enabled: state.canBack, label: b !== null ? `Back: ${b}` : 'Back', title: b !== null ? `Back to ${b} (and the camera view you left)` : 'Nothing to go back to' },
    forward: { enabled: state.canForward, label: f !== null ? `Forward: ${f}` : 'Forward', title: f !== null ? `Forward to ${f}` : 'Nothing to go forward to' },
    previous: { enabled: state.length > 1, label: 'Return to previous view', title: 'Fly back to where the camera was before the last move' },
  };
}

/** What the camera is doing, in one line. */
export function flightStatement(name: string, rec: Pick<DiscoveryRecord, 'position' | 'drawn'> | undefined, phase: 'flying' | 'arrived' | 'no-flight'): string {
  const place = placementNotice(rec);
  if (rec?.position.kind === 'sky-only') return `${place ?? 'Cannot be placed in 3D.'} The camera stays where it is.`;
  if (phase === 'flying') return `Flying to ${name}…`;
  if (phase === 'arrived') return `At ${name}.${place ? ` ${place}` : ''}`;
  return `${name} is selected; the camera did not move.`;
}
