import { create } from 'zustand';

export type SettingsSection =
  | 'appearance'
  | 'typography'
  | 'reading'
  | 'editor'
  | 'markdown'
  | 'files'
  | 'export'
  | 'shortcuts'
  | 'advanced'
  | 'about';

interface UiStore {
  palette: boolean;
  /** Text the palette opens with (":" = go to line, "#" = headings). */
  paletteQuery: string;
  settings: SettingsSection | null;
  find: boolean;
  findReplace: boolean;
  /** Bumped on every Ctrl+F, so an open find bar takes the focus again. */
  findFocus: number;
  lightbox: { src: string; alt: string } | null;
  dropHover: boolean;
  /** Ask the user before closing a dirty tab (or the window). */
  confirmClose: { ids: string[]; thenQuit: boolean } | null;
  /** A request for the visible document view to scroll to a heading / line. */
  jump: { index?: number; line?: number; nonce: number } | null;

  open: (what: 'palette' | 'find') => void;
  close: (what: 'palette' | 'find' | 'settings' | 'lightbox') => void;
  toggle: (what: 'palette') => void;
  openPalette: (query?: string) => void;
  openSettings: (section?: SettingsSection) => void;
  openFind: (replace?: boolean) => void;
  setLightbox: (v: UiStore['lightbox']) => void;
  setDropHover: (v: boolean) => void;
  setConfirmClose: (v: UiStore['confirmClose']) => void;
  jumpTo: (target: { index?: number; line?: number }) => void;
}

let nonce = 0;

export const useUi = create<UiStore>((set) => ({
  palette: false,
  paletteQuery: '',
  settings: null,
  find: false,
  findReplace: false,
  findFocus: 0,
  lightbox: null,
  dropHover: false,
  confirmClose: null,
  jump: null,

  open: (what) => set({ [what]: true } as Partial<UiStore>),
  close: (what) => set(what === 'settings' || what === 'lightbox' ? ({ [what]: null } as Partial<UiStore>) : ({ [what]: false } as Partial<UiStore>)),
  toggle: (what) => set((s) => ({ [what]: !s[what], paletteQuery: '' }) as Partial<UiStore>),
  openPalette: (query = '') => set({ palette: true, paletteQuery: query }),
  openSettings: (section = 'appearance') => set({ settings: section, palette: false }),
  openFind: (replace = false) => set((s) => ({ find: true, findReplace: replace, findFocus: s.findFocus + 1 })),
  setLightbox: (lightbox) => set({ lightbox }),
  setDropHover: (dropHover) => set({ dropHover }),
  setConfirmClose: (confirmClose) => set({ confirmClose }),
  jumpTo: (target) => set({ jump: { ...target, nonce: ++nonce } }),
}));

/**
 * True when the keyboard is working somewhere an editor must not pull focus from as it opens:
 * a tab reached with the arrow keys, the find bar or a dialog. A tab clicked with the mouse
 * doesn't count, so clicking a tab still lets you type straight away.
 */
export function focusIsElsewhere(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  if (el.closest('.findbar, [role="dialog"], [role="alertdialog"]')) return true;
  return !!el.closest('[role="tab"]') && el.matches(':focus-visible');
}
