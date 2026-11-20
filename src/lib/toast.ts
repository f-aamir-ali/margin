import { create } from 'zustand';

export type ToastKind = 'info' | 'success' | 'warn' | 'error';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  body?: string;
  actionLabel?: string;
  onAction?: () => void;
  sticky?: boolean;
}

interface ToastStore {
  items: ToastItem[];
  push: (t: Omit<ToastItem, 'id'>) => number;
  dismiss: (id: number) => void;
}

let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

export const useToasts = create<ToastStore>((set, get) => ({
  items: [],
  push(t) {
    const id = nextId++;
    // Collapse an identical toast that is still on screen instead of stacking duplicates.
    const dup = get().items.find((i) => i.title === t.title && i.body === t.body);
    if (dup) get().dismiss(dup.id);
    set((s) => ({ items: [...s.items, { ...t, id }].slice(-5) }));
    if (!t.sticky) {
      timers.set(
        id,
        setTimeout(() => get().dismiss(id), t.kind === 'error' ? 6500 : 3200),
      );
    }
    return id;
  },
  dismiss(id) {
    clearTimeout(timers.get(id));
    timers.delete(id);
    set((s) => ({ items: s.items.filter((i) => i.id !== id) }));
  },
}));

const push = (kind: ToastKind) => (title: string, body?: string) => useToasts.getState().push({ kind, title, body });

export const toast = {
  info: push('info'),
  success: push('success'),
  warn: push('warn'),
  error: push('error'),
  action: (t: Omit<ToastItem, 'id'>) => useToasts.getState().push(t),
};
