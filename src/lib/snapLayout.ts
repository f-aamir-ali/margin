import { isTauri } from './platform';

/** How long the pointer has to rest on the button before Snap Layouts opens. */
const HOVER_DELAY_MS = 450;

/** Browser dev builds have no window to snap, so this only does something in the desktop app. */
async function showSnapLayout(): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('show_snap_layout');
}

/**
 * Makes a custom maximize button open Windows 11 Snap Layouts when the pointer rests on it,
 * as a native caption button does. Returns a function that removes the listeners.
 */
export function attachSnapLayout(button: HTMLElement): () => void {
  let timer: number | undefined;
  // Set once the flyout has opened for this hover. Cleared when the pointer leaves.
  let shown = false;

  const cancel = () => {
    window.clearTimeout(timer);
    timer = undefined;
  };
  const onEnter = () => {
    cancel();
    if (shown) return;
    timer = window.setTimeout(() => {
      timer = undefined;
      shown = true;
      showSnapLayout().catch(() => undefined);
    }, HOVER_DELAY_MS);
  };
  const onLeave = () => {
    cancel();
    shown = false;
  };
  // A press means a click on maximize, so the flyout shouldn't open over it.
  const onPointerDown = () => cancel();
  const onBlur = () => cancel();

  button.addEventListener('pointerenter', onEnter);
  button.addEventListener('pointerleave', onLeave);
  button.addEventListener('pointerdown', onPointerDown);
  button.addEventListener('blur', onBlur);

  return () => {
    cancel();
    button.removeEventListener('pointerenter', onEnter);
    button.removeEventListener('pointerleave', onLeave);
    button.removeEventListener('pointerdown', onPointerDown);
    button.removeEventListener('blur', onBlur);
  };
}
