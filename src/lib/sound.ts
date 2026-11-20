/* Optional interface sounds: very short synthesised ticks, no audio files.
   Off by default (Settings → Appearance → Interface sounds). */

type Sound = 'tap' | 'on' | 'off' | 'open';

let ctx: AudioContext | null = null;

function blip(freq: number, to: number, ms: number, gain: number, type: OscillatorType = 'sine') {
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(to, t + ms / 1000);
  amp.gain.setValueAtTime(0.0001, t);
  amp.gain.exponentialRampToValueAtTime(gain, t + 0.004);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
  osc.connect(amp).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + ms / 1000 + 0.01);
}

export function play(sound: Sound) {
  try {
    if (sound === 'tap') blip(1900, 1300, 28, 0.035, 'triangle');
    else if (sound === 'on') blip(880, 1320, 70, 0.045);
    else if (sound === 'off') blip(990, 620, 70, 0.04);
    else blip(520, 820, 90, 0.035);
  } catch {
    /* audio unavailable: stay silent */
  }
}

const TAPPABLE =
  '.icon-btn, .btn, .segmented-item, .tab, .menu-item, .outline-item, .file-row, .recent-main, .welcome-action, .welcome-recent-row, .theme-card, .accent-dot, .status-btn, .status-save, .palette-row, .settings-nav-item, .toast-action, .wc, .select-trigger, .code-copy, .tab-close, input.task-checkbox';

/** Listen for presses on interactive elements and play the matching sound. Returns a cleanup. */
export function attachSounds(): () => void {
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const el = (e.target as Element).closest?.(`${TAPPABLE}, .switch`);
    if (!el) return;
    if (el.matches('.switch')) play(el.hasAttribute('data-on') ? 'off' : 'on');
    else if (el.matches('input.task-checkbox')) play((el as HTMLInputElement).checked ? 'off' : 'on');
    else play('tap');
  };
  document.addEventListener('pointerdown', onDown, true);
  return () => document.removeEventListener('pointerdown', onDown, true);
}
