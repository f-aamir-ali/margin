import { AnimatePresence } from 'motion/react';
import {
  BookOpen,
  ClipboardPaste,
  Copy,
  ExternalLink,
  FolderOpen,
  Link2,
  PencilLine,
  Printer,
  Scissors,
  Search,
  TextSelect,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { requestClose, requestCloseTabs, runCommand } from '../lib/commands';
import { isTauri, onContextMenuRoute, openExternal, revealInExplorer } from '../lib/platform';
import { useSettings } from '../lib/settings';
import { activeDoc, useApp } from '../lib/store';
import { toast } from '../lib/toast';
import { Menu, type MenuItem } from './ui/controls';

interface Open {
  x: number;
  y: number;
  items: MenuItem[];
}

const copyText = async (text: string, done = 'Copied') => {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(done);
  } catch {
    toast.error("Couldn't copy");
  }
};

/** Replaces the browser's right-click menu with one that fits what was clicked. */
export function ContextMenu() {
  const [open, setOpen] = useState<Open | null>(null);

  useEffect(() => {
    // In a text field the desktop side decides: a right-click on a misspelled word gets the
    // native menu with spelling suggestions (WebView2 can't hand those to a page), anything else
    // gets this menu. The menu is built now and shown when the answer arrives.
    let pending: { open: Open | null; timer: ReturnType<typeof setTimeout> } | null = null;
    const show = (open: Open | null) => {
      if (pending) clearTimeout(pending.timer);
      pending = null;
      setOpen(open);
    };
    const onContext = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const items = build(target);
      const height = items.length * 32 + items.filter((i) => i.separatorBefore).length * 11 + 12;
      const open: Open | null = items.length
        ? {
            x: Math.max(8, Math.min(e.clientX, window.innerWidth - 252)),
            y: Math.max(8, Math.min(e.clientY, window.innerHeight - height - 8)),
            items,
          }
        : null;
      const spelling = isTauri && !!target.closest('[contenteditable="true"], textarea, input') &&
        useSettings.getState().settings.spellcheck;
      if (!spelling) {
        e.preventDefault();
        return show(open);
      }
      setOpen(null);
      if (pending) clearTimeout(pending.timer);
      // If no answer comes (an older WebView2), show this menu anyway.
      pending = { open, timer: setTimeout(() => show(pending?.open ?? null), 350) };
    };
    let offRoute: (() => void) | undefined;
    let alive = true;
    void onContextMenuRoute((native) => {
      if (!pending) return;
      if (native) {
        clearTimeout(pending.timer);
        pending = null;
      } else show(pending.open);
    }).then((off) => (alive ? (offRoute = off) : off()));
    const close = () => show(null);
    window.addEventListener('contextmenu', onContext);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    window.addEventListener('wheel', close, { passive: true });
    return () => {
      alive = false;
      offRoute?.();
      if (pending) clearTimeout(pending.timer);
      window.removeEventListener('contextmenu', onContext);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('wheel', close);
    };
  }, []);

  return (
    <AnimatePresence>
      {open && (
        <Menu
          key={`${open.x}-${open.y}`}
          items={open.items}
          onClose={() => setOpen(null)}
          align="left"
          style={{ position: 'fixed', left: open.x, top: open.y, right: 'auto', zIndex: 180 }}
        />
      )}
    </AnimatePresence>
  );
}

function build(target: HTMLElement): MenuItem[] {
  const app = useApp.getState();
  const doc = activeDoc(app);

  // A tab
  const tabEl = target.closest<HTMLElement>('.tab');
  if (tabEl) {
    const index = Array.from(tabEl.parentElement?.querySelectorAll('.tab') ?? []).indexOf(tabEl);
    const d = app.docs[index];
    if (!d) return [];
    const others = app.docs.filter((x) => x.id !== d.id);
    const right = app.docs.slice(index + 1);
    return [
      { id: 'close', label: 'Close', icon: <X size={15} />, keys: 'Ctrl+W', run: () => requestClose(d.id) },
      { id: 'others', label: 'Close others', disabled: !others.length, run: () => requestCloseTabs(others.map((x) => x.id)) },
      { id: 'right', label: 'Close tabs to the right', disabled: !right.length, run: () => requestCloseTabs(right.map((x) => x.id)) },
      { id: 'path', label: 'Copy path', icon: <Copy size={15} />, disabled: !d.path, separatorBefore: true, run: () => void copyText(d.path ?? '', 'Path copied') },
      { id: 'reveal', label: 'Show in File Explorer', icon: <FolderOpen size={15} />, disabled: !d.path, run: () => void (d.path && revealInExplorer(d.path)) },
    ];
  }

  // Text fields anywhere, and the two editors
  const field = target.closest<HTMLElement>('input, textarea, [contenteditable="true"]');
  const selection = document.getSelection()?.toString() ?? '';
  if (field) {
    const input = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? field : null;
    const hasSel = input ? input.selectionStart !== input.selectionEnd : selection.length > 0;
    const items: MenuItem[] = [
      { id: 'cut', label: 'Cut', icon: <Scissors size={15} />, keys: 'Ctrl+X', disabled: !hasSel, run: () => void document.execCommand('cut') },
      { id: 'copy', label: 'Copy', icon: <Copy size={15} />, keys: 'Ctrl+C', disabled: !hasSel, run: () => void document.execCommand('copy') },
      {
        id: 'paste',
        label: 'Paste',
        icon: <ClipboardPaste size={15} />,
        keys: 'Ctrl+V',
        run: () => {
          field.focus();
          void navigator.clipboard
            .readText()
            .then((text) => text && document.execCommand('insertText', false, text))
            .catch(() => toast.info('Press Ctrl+V to paste'));
        },
      },
      {
        id: 'all',
        label: 'Select all',
        icon: <TextSelect size={15} />,
        keys: 'Ctrl+A',
        separatorBefore: true,
        run: () => {
          field.focus();
          if (input) input.select();
          else document.execCommand('selectAll');
        },
      },
    ];
    if (doc && field.closest('.doc-view')) {
      items.push(
        { id: 'find', label: 'Find', icon: <Search size={15} />, keys: 'Ctrl+F', separatorBefore: true, run: () => runCommand('go.find') },
        { id: 'read', label: 'Switch to reading', icon: <BookOpen size={15} />, keys: 'Ctrl+E', run: () => runCommand('mode.read') },
      );
    }
    return items;
  }

  // The page in Reading mode
  if (doc && target.closest('.doc-view')) {
    const link = target.closest<HTMLAnchorElement>('.prose a[href]');
    const href = link?.getAttribute('href') ?? '';
    const img = target.closest<HTMLImageElement>('.prose img');
    const code = target.closest<HTMLElement>('.prose pre');
    const items: MenuItem[] = [];
    if (selection) items.push({ id: 'copy', label: 'Copy', icon: <Copy size={15} />, keys: 'Ctrl+C', run: () => void copyText(selection) });
    if (link && /^(https?:|mailto:)/i.test(href)) {
      items.push(
        { id: 'open', label: 'Open link', icon: <ExternalLink size={15} />, run: () => void openExternal(href) },
        { id: 'copylink', label: 'Copy link', icon: <Link2 size={15} />, run: () => void copyText(href, 'Link copied') },
      );
    }
    if (img) items.push({ id: 'img', label: 'Copy image address', icon: <Link2 size={15} />, run: () => void copyText(img.getAttribute('src') ?? '', 'Address copied') });
    if (code) items.push({ id: 'code', label: 'Copy code block', icon: <Copy size={15} />, run: () => void copyText(code.innerText) });
    items.push(
      {
        id: 'all',
        label: 'Select all',
        icon: <TextSelect size={15} />,
        keys: 'Ctrl+A',
        separatorBefore: items.length > 0,
        run: () => {
          const prose = document.querySelector('.doc-view .prose');
          if (prose) document.getSelection()?.selectAllChildren(prose);
        },
      },
      { id: 'md', label: 'Copy as markdown', run: () => runCommand('export.copyMd') },
      { id: 'edit', label: 'Edit this document', icon: <PencilLine size={15} />, keys: 'Ctrl+E', separatorBefore: true, run: () => runCommand('mode.edit') },
      { id: 'find', label: 'Find', icon: <Search size={15} />, keys: 'Ctrl+F', run: () => runCommand('go.find') },
      { id: 'print', label: 'Print or save as PDF…', icon: <Printer size={15} />, keys: 'Ctrl+P', run: () => runCommand('export.pdf') },
    );
    return items;
  }

  return [];
}
