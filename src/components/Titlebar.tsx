import { AnimatePresence } from 'motion/react';
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Code2,
  Copy,
  Download,
  FileText,
  FolderOpen,
  Maximize2,
  Minus,
  MoreHorizontal,
  PanelLeft,
  PencilLine,
  Plus,
  Printer,
  RotateCcw,
  Sparkles,
  Save,
  Search,
  Settings2,
  Square,
  X,
  Command as CommandIcon,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { requestClose, requestQuit, runCommand, setMode } from '../lib/commands';
import {
  appWindow,
  emitToWindow,
  isProseName,
  isTauri,
  moveWindow,
  onWindowEvent,
  openTabWindow,
  tabDropTarget,
  windowLabel,
} from '../lib/platform';
import { attachSnapLayout } from '../lib/snapLayout';
import type { ViewMode } from '../lib/settings';
import { activeDoc, displayName, flushAll, isDirty, useApp, type Doc } from '../lib/store';
import { toast } from '../lib/toast';
import { IconButton, Menu, Segmented, type MenuItem } from './ui/controls';

/** Pointer travel (px) before a press on a tab becomes a drag, as in Chrome. */
const DRAG_START = 5;
/** How far above or below its start (px) a dragged tab must go to leave the bar for its own window. */
const TEAR_OFF = 40;
/** The slide every tab uses to settle into its slot. */
const SETTLE = 'transform 200ms cubic-bezier(0.22, 1, 0.36, 1)';
/** Breathing room kept between the active tab and the edge of the strip when it is scrolled into view. */
const EDGE_GAP = 32;

interface Tear {
  /** The window that follows the pointer: a new one, or this one when it only has this tab. */
  label: string | null;
  own: boolean;
  ready: Promise<string | null>;
  /** Where in that window (CSS px from its top-left corner) the pointer holds it. */
  offX: number;
  offY: number;
  screenX: number;
  screenY: number;
  raf: number;
}

interface Drag {
  pointerId: number;
  id: string;
  el: HTMLElement;
  startX: number;
  startY: number;
  startScroll: number;
  grabX: number;
  grabY: number;
  started: boolean;
  /** Tabs in order when the drag started, with their layout positions in the strip. */
  slots: HTMLElement[];
  lefts: number[];
  width: number;
  step: number;
  from: number;
  to: number;
  dx: number;
  tear?: Tear;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Physical screen pixels, which is what the window manager works in. */
const physical = (cssPx: number) => cssPx * window.devicePixelRatio;

export function Titlebar() {
  const docs = useApp((s) => s.docs);
  const activeId = useApp((s) => s.activeId);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const doc = useApp(activeDoc);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const [maximized, setMaximized] = useState(false);
  const tabsRef = useRef<HTMLDivElement>(null);
  const maximizeRef = useRef<HTMLButtonElement>(null);
  const drag = useRef<Drag | null>(null);
  /** Set when a drop reorders the tabs: the dropped tab slides from where it was let go. */
  const flip = useRef<{ id: string; visual: number } | null>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });
  // Tabs present at first paint don't play the "new tab" animation.
  const known = useRef<Set<string> | null>(null);
  if (!known.current) known.current = new Set(docs.map((d) => d.id));
  // While the pointer stays on the tab strip after closing a tab, tabs keep their width (as in
  // Chrome), so the next tab's close button slides under the cursor. `pad` stands in for the
  // closed tabs, so a scrolled strip keeps its length and doesn't jump sideways.
  const [frozen, setFrozen] = useState<{ width: number; pad: number } | null>(null);

  // Windows 11: resting on Maximise shows the Snap Layouts flyout, as in every native app.
  useEffect(() => (maximizeRef.current ? attachSnapLayout(maximizeRef.current) : undefined), []);

  useEffect(() => {
    let off: (() => void) | undefined;
    const sync = () => void appWindow.isMaximized().then(setMaximized);
    sync();
    void appWindow.onResized(sync).then((u) => (off = u));
    return () => off?.();
  }, []);

  // Which edges have tabs hidden past them. Scrolling, resizing and tabs coming or going all change that.
  useLayoutEffect(() => {
    const strip = tabsRef.current;
    if (!strip) return;
    const sync = () =>
      setOverflow((o) => {
        const next = { left: strip.scrollLeft > 1, right: strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1 };
        return o.left === next.left && o.right === next.right ? o : next;
      });
    sync();
    strip.addEventListener('scroll', sync, { passive: true });
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(sync);
    resize?.observe(strip);
    const children = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(sync);
    children?.observe(strip, { childList: true });
    return () => {
      strip.removeEventListener('scroll', sync);
      resize?.disconnect();
      children?.disconnect();
    };
  }, []);

  /** A document's tab element. */
  const tabEl = (id: string) =>
    [...(tabsRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])].find((t) => t.dataset.docId === id);

  /** Scrolls the strip, and only the strip, so the title bar itself never moves. */
  const scrollTabIntoView = (el: HTMLElement, behavior: ScrollBehavior) => {
    const strip = tabsRef.current;
    if (!strip) return;
    const bar = strip.getBoundingClientRect();
    const tab = el.getBoundingClientRect();
    const delta =
      tab.left < bar.left + EDGE_GAP ? tab.left - bar.left - EDGE_GAP : tab.right > bar.right - EDGE_GAP ? tab.right - bar.right + EDGE_GAP : 0;
    if (delta !== 0) strip.scrollTo({ left: strip.scrollLeft + delta, behavior });
  };

  // Keep the active tab in view, and keep keyboard focus on the strip following the active tab.
  const lastCount = useRef(docs.length);
  useEffect(() => {
    const added = docs.length > lastCount.current;
    lastCount.current = docs.length;
    const el = activeId ? tabEl(activeId) : undefined;
    if (!el) return;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused !== el && focused.closest('.tabs [role="tab"]')) el.focus({ preventScroll: true });
    // Not right after a close with the mouse: that would move the close button under the pointer.
    if (frozen !== null && !added) return;
    scrollTabIntoView(el, 'smooth');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, docs.length]);

  // After a drop has reordered the tabs, every tab is already at its new slot except the dropped
  // one, which slides from where the pointer let go of it. This runs before the browser paints.
  useLayoutEffect(() => {
    const f = flip.current;
    if (!f) return;
    flip.current = null;
    const strip = tabsRef.current;
    if (!strip) return;
    const tabs = [...strip.querySelectorAll<HTMLElement>('[role="tab"]')];
    for (const t of tabs) {
      t.style.transition = 'none';
      t.style.transform = '';
    }
    const el = tabEl(f.id);
    if (el) {
      el.style.transform = `translateX(${f.visual - el.offsetLeft}px)`;
      void el.offsetWidth;
      el.style.transition = SETTLE;
      el.style.transform = '';
    }
    window.setTimeout(() => tabs.forEach((t) => (t.style.transition = '')), 240);
  }, [docs]);

  /* ---------- dragging tabs: reorder, tear off into a window, drop on another window ---------- */

  const resetSlots = (d: Drag, animate: boolean) => {
    for (const t of d.slots) {
      t.style.transition = animate ? SETTLE : 'none';
      t.style.transform = '';
    }
    delete d.el.dataset.dragged;
    delete tabsRef.current?.dataset.dragging;
    window.setTimeout(() => d.slots.forEach((t) => (t.style.transition = '')), animate ? 240 : 0);
  };

  const beginDrag = (d: Drag) => {
    const strip = tabsRef.current;
    if (!strip) return;
    d.started = true;
    d.slots = [...strip.querySelectorAll<HTMLElement>('[role="tab"]')];
    d.lefts = d.slots.map((t) => t.offsetLeft);
    d.from = d.slots.indexOf(d.el);
    d.to = d.from;
    d.width = d.el.offsetWidth;
    d.step = d.slots.length > 1 ? d.lefts[1] - d.lefts[0] : d.width + 2;
    for (const t of d.slots) t.style.transition = t === d.el ? 'none' : SETTLE;
    d.el.dataset.dragged = '';
    strip.dataset.dragging = '';
  };

  const onStripPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || drag.current) return;
    const target = e.target as HTMLElement;
    const tab = target.closest<HTMLElement>('[role="tab"]');
    if (!tab || target.closest('.tab-close')) return;
    const id = tab.dataset.docId;
    if (!id) return;
    useApp.getState().activate(id);
    // The strip holds the pointer for the whole drag: it outlives a tab that leaves for a new window.
    e.currentTarget.setPointerCapture(e.pointerId);
    const r = tab.getBoundingClientRect();
    drag.current = {
      pointerId: e.pointerId,
      id,
      el: tab,
      startX: e.clientX,
      startY: e.clientY,
      startScroll: e.currentTarget.scrollLeft,
      grabX: e.clientX - r.left,
      grabY: e.clientY - r.top,
      started: false,
      slots: [],
      lefts: [],
      width: 0,
      step: 0,
      from: 0,
      to: 0,
      dx: 0,
    };
  };

  const onStripPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const strip = tabsRef.current;
    if (!d || !strip || e.pointerId !== d.pointerId) return;
    if (d.tear) {
      followTear(d.tear, e.screenX, e.screenY);
      return;
    }
    const dy = e.clientY - d.startY;
    let dx = e.clientX - d.startX + (strip.scrollLeft - d.startScroll);
    if (!d.started) {
      if (Math.hypot(dx, dy) < DRAG_START) return;
      beginDrag(d);
    }
    // Far enough above or below the bar: the tab leaves it, like a Chrome tab.
    if (isTauri && Math.abs(dy) > TEAR_OFF) {
      tearOff(d, e);
      return;
    }
    // Near an edge of a strip that scrolls: scroll it along.
    const bar = strip.getBoundingClientRect();
    if (strip.scrollWidth > strip.clientWidth) {
      if (e.clientX < bar.left + 24) strip.scrollLeft -= 10;
      else if (e.clientX > bar.right - 24) strip.scrollLeft += 10;
      dx = e.clientX - d.startX + (strip.scrollLeft - d.startScroll);
    }
    // The tab stays inside the strip: from the first slot to the last, never under the + button.
    const last = d.lefts.length - 1;
    dx = Math.max(-d.lefts[d.from], Math.min(d.lefts[last] - d.lefts[d.from], dx));
    d.dx = dx;
    d.el.style.transform = `translateX(${dx}px)`;
    // Its new slot is the one it is nearest, so it swaps with a neighbour once it covers half of
    // it, as in Chrome. (Slots are equal steps apart: every tab has the same width.)
    const to = Math.max(0, Math.min(last, Math.round((d.lefts[d.from] + dx - d.lefts[0]) / d.step)));
    if (to === d.to) return;
    d.to = to;
    d.slots.forEach((t, i) => {
      if (i === d.from) return;
      const shift = d.from < to && i > d.from && i <= to ? -d.step : to < d.from && i >= to && i < d.from ? d.step : 0;
      t.style.transform = shift ? `translateX(${shift}px)` : '';
    });
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    drag.current = null;
    if (tabsRef.current?.hasPointerCapture(e.pointerId)) tabsRef.current.releasePointerCapture(e.pointerId);
    if (d.tear) {
      void finishTear(d, e.screenX, e.screenY, cancelled);
      return;
    }
    if (!d.started) return;
    if (cancelled || d.to === d.from) {
      resetSlots(d, true);
      return;
    }
    delete d.el.dataset.dragged;
    delete tabsRef.current?.dataset.dragging;
    flip.current = { id: d.id, visual: d.lefts[d.from] + d.dx };
    useApp.getState().moveDoc(d.from, d.to);
  };

  const followTear = (t: Tear, screenX: number, screenY: number) => {
    t.screenX = screenX;
    t.screenY = screenY;
    if (t.raf || !t.label) return;
    t.raf = requestAnimationFrame(() => {
      t.raf = 0;
      if (t.label) void moveWindow(t.label, physical(t.screenX - t.offX), physical(t.screenY - t.offY));
    });
  };

  const tearOff = (d: Drag, e: ReactPointerEvent<HTMLDivElement>) => {
    resetSlots(d, false);
    const own = useApp.getState().docs.length === 1;
    const strip = tabsRef.current as HTMLElement;
    const tabTop = d.el.getBoundingClientRect().top;
    // A new window opens with this tab first in its strip, so the pointer holds it where it
    // holds the tab now. A window with only this tab moves as it is, from the point grabbed.
    const offX = own ? e.clientX : strip.getBoundingClientRect().left + d.grabX;
    const offY = own ? e.clientY : tabTop + d.grabY;
    const tear: Tear = { label: own ? windowLabel : null, own, ready: Promise.resolve(windowLabel), offX, offY, screenX: e.screenX, screenY: e.screenY, raf: 0 };
    d.tear = tear;
    if (own) return;
    tear.ready = (async () => {
      if (!(await useApp.getState().detachDoc(d.id))) return null;
      try {
        const label = await openTabWindow([d.id], physical(tear.screenX - offX), physical(tear.screenY - offY));
        tear.label = label;
        followTear(tear, tear.screenX, tear.screenY);
        return label;
      } catch (err) {
        toast.error("Couldn't open a new window", String(err instanceof Error ? err.message : err));
        await useApp.getState().adoptDoc(d.id, d.from);
        return null;
      }
    })();
  };

  const finishTear = async (d: Drag, screenX: number, screenY: number, cancelled: boolean) => {
    const t = d.tear as Tear;
    cancelAnimationFrame(t.raf);
    t.raf = 0;
    const label = await t.ready;
    if (!label) return;
    if (!cancelled) await moveWindow(label, physical(screenX - t.offX), physical(screenY - t.offY)).catch(() => undefined);
    const target = cancelled ? null : await tabDropTarget(physical(screenX), physical(screenY), [label]);
    // For the desktop tests: where the last drop landed.
    (window as unknown as { __marginLastDrop?: unknown }).__marginLastDrop = { screenX, screenY, dpr: window.devicePixelRatio, label, own: t.own, target };
    if (t.own) {
      // This window's only tab was dropped on another window: it joins that window, and this
      // window closes, as in Chrome.
      if (!target) return;
      if (await useApp.getState().detachDoc(d.id)) {
        await emitToWindow(target.label, 'adopt-tab', { id: d.id, clientX: target.clientX });
        await flushAll().catch(() => undefined);
        await appWindow.destroy();
      }
      return;
    }
    if (!target) {
      // Left on its own: the new window comes to the front.
      void emitToWindow(label, 'take-focus');
      return;
    }
    // Dropped on a tab bar (this window's or another's): the new window hands the tab over and
    // closes. It may still be starting up, so keep asking until it answers.
    const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    let acked = false;
    const off = await onWindowEvent<string>('transfer-ack', (n) => {
      if (n === nonce) acked = true;
    });
    try {
      for (let i = 0; i < 40 && !acked; i++) {
        await emitToWindow(label, 'transfer-out', { target: target.label, clientX: target.clientX, nonce });
        await sleep(150);
      }
    } finally {
      off();
    }
  };

  // Escape while dragging puts the tab back.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const d = drag.current;
      if (e.key !== 'Escape' || !d || !d.started || d.tear) return;
      e.preventDefault();
      e.stopPropagation();
      drag.current = null;
      if (tabsRef.current?.hasPointerCapture(d.pointerId)) tabsRef.current.releasePointerCapture(d.pointerId);
      resetSlots(d, true);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const strip = tabsRef.current;
    // A vertical wheel scrolls the strip sideways. Horizontal wheel (trackpads) and Ctrl+wheel (zoom) keep their own jobs.
    if (!strip || e.ctrlKey || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    strip.scrollLeft += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  };

  const scrollStrip = (direction: 1 | -1) => {
    const strip = tabsRef.current;
    strip?.scrollTo({ left: strip.scrollLeft + direction * strip.clientWidth * 0.7, behavior: 'smooth' });
  };

  /** Keyboard, like a native tab strip: arrows, Home and End move between tabs, Delete closes. */
  const onTabKey = (e: ReactKeyboardEvent<HTMLElement>, id: string) => {
    if (e.target !== e.currentTarget || e.altKey || e.ctrlKey || e.metaKey) return;
    const index = docs.findIndex((d) => d.id === id);
    const count = docs.length;
    const go = (target: Doc) => {
      useApp.getState().activate(target.id);
      requestAnimationFrame(() => tabEl(target.id)?.focus({ preventScroll: true }));
    };
    let target = -1;
    if (e.key === 'ArrowRight') target = (index + 1) % count;
    else if (e.key === 'ArrowLeft') target = (index - 1 + count) % count;
    else if (e.key === 'Home') target = 0;
    else if (e.key === 'End') target = count - 1;
    if (target >= 0) {
      e.preventDefault();
      go(docs[target]);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      useApp.getState().activate(id);
    } else if (e.key === 'Delete') {
      e.preventDefault();
      const next = docs[index + 1] ?? docs[index - 1];
      if (next) go(next);
      requestClose(id);
    }
  };

  const menuItems: MenuItem[] = [
    { id: 'open', label: 'Open file…', icon: <FolderOpen size={15} />, keys: 'Ctrl+O', run: () => runCommand('file.open') },
    { id: 'new', label: 'New note', icon: <Plus size={15} />, keys: 'Ctrl+N', run: () => runCommand('file.new') },
    { id: 'newText', label: 'New plain text note', icon: <FileText size={15} />, keys: 'Ctrl+Alt+N', run: () => runCommand('file.newText') },
    { id: 'reopen', label: 'Reopen closed tab', icon: <RotateCcw size={15} />, keys: 'Ctrl+Shift+T', run: () => runCommand('file.reopenClosed') },
    { id: 'save', label: 'Save', icon: <Save size={15} />, keys: 'Ctrl+S', disabled: !doc, separatorBefore: true, run: () => runCommand('file.save') },
    { id: 'saveas', label: 'Save as…', icon: <Download size={15} />, keys: 'Ctrl+Shift+S', disabled: !doc, run: () => runCommand('file.saveAs') },
    { id: 'find', label: 'Find', icon: <Search size={15} />, keys: 'Ctrl+F', disabled: !doc, separatorBefore: true, run: () => runCommand('go.find') },
    { id: 'pdf', label: 'Print or save as PDF…', icon: <Printer size={15} />, keys: 'Ctrl+P', disabled: !doc, run: () => runCommand('export.pdf') },
    { id: 'html', label: 'Export as HTML…', icon: <FileText size={15} />, disabled: !doc, run: () => runCommand('export.html') },
    { id: 'rich', label: 'Copy as rich text', icon: <Copy size={15} />, disabled: !doc, run: () => runCommand('export.copyHtml') },
    { id: 'focus', label: 'Focus mode', icon: <Maximize2 size={15} />, keys: 'F11', separatorBefore: true, run: () => runCommand('view.focus') },
    { id: 'palette', label: 'Command palette', icon: <CommandIcon size={15} />, keys: 'Ctrl+K', run: () => runCommand('view.palette') },
    { id: 'settings', label: 'Settings', icon: <Settings2 size={15} />, keys: 'Ctrl+,', run: () => runCommand('app.settings') },
  ];

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-left">
        <IconButton label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'} keys="Ctrl+B" active={sidebarOpen} onClick={() => runCommand('view.sidebar')}>
          <PanelLeft size={16} />
        </IconButton>
      </div>

      <div className="tabs-wrap" data-overflow-left={overflow.left || undefined} data-overflow-right={overflow.right || undefined}>
        <div
          role="tablist"
          aria-label="Open notes"
          className="tabs"
          ref={tabsRef}
          data-frozen={frozen !== null || undefined}
          style={frozen !== null ? ({ '--tab-frozen': `${frozen.width}px` } as React.CSSProperties) : undefined}
          onPointerDown={onStripPointerDown}
          onPointerMove={onStripPointerMove}
          onPointerUp={(e) => endDrag(e, false)}
          onPointerCancel={(e) => endDrag(e, true)}
          onLostPointerCapture={(e) => endDrag(e, false)}
          onPointerLeave={() => setFrozen(null)}
          onWheel={onWheel}
        >
          {docs.map((d) => (
            <Tab
              key={d.id}
              doc={d}
              active={d.id === activeId}
              fresh={!known.current?.has(d.id)}
              onKey={onTabKey}
              onCloseClick={(w) => setFrozen((f) => ({ width: f?.width ?? w, pad: (f?.pad ?? 0) + w + 2 }))}
            />
          ))}
          {frozen && <div className="tabs-hold" style={{ flex: `0 0 ${frozen.pad}px`, width: frozen.pad }} aria-hidden />}
        </div>
        {/* Overlaid on the strip's edges, and only shown while tabs are hidden past that edge. */}
        <button type="button" className="tabs-nav tabs-nav-left" aria-label="Scroll tabs left" tabIndex={-1} onClick={() => scrollStrip(-1)}>
          <ChevronLeft size={14} />
        </button>
        <button type="button" className="tabs-nav tabs-nav-right" aria-label="Scroll tabs right" tabIndex={-1} onClick={() => scrollStrip(1)}>
          <ChevronRight size={14} />
        </button>
      </div>
      {/* Right after the last tab, outside the scrolling strip, so it never scrolls out of sight. */}
      <IconButton label="New note" keys="Ctrl+N" className="tab-new" onClick={() => runCommand('file.new')}>
        <Plus size={15} />
      </IconButton>
      {/* Always some empty title bar to drag the window by, however many tabs are open. */}
      <div className="tabs-drag" data-tauri-drag-region />

      <div className="titlebar-right">
        {doc && doc.kind === 'text' && (!doc.path || isProseName(doc.name)) && (
          <IconButton label="Format as markdown" className="format-md" onClick={() => runCommand('mode.formatMarkdown')}>
            <Sparkles size={16} />
          </IconButton>
        )}
        {doc && doc.kind === 'markdown' && (
          <Segmented<ViewMode>
            ariaLabel="View mode"
            size="sm"
            tipSide="bottom"
            value={doc.mode}
            onChange={setMode}
            options={[
              { value: 'read', label: <BookOpen size={15} />, title: 'Read', keys: 'Ctrl+E' },
              { value: 'edit', label: <PencilLine size={15} />, title: 'Edit', keys: 'Ctrl+E' },
              { value: 'source', label: <Code2 size={15} />, title: 'Source', keys: 'Ctrl+/' },
            ]}
          />
        )}
        <div className="menu-anchor">
          <IconButton ref={menuRef} label="Menu" active={menu} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
            <MoreHorizontal size={16} />
          </IconButton>
          <AnimatePresence>{menu && <Menu anchor={menuRef} items={menuItems} onClose={() => setMenu(false)} />}</AnimatePresence>
        </div>
        {isTauri && (
          <div className="window-controls">
            <button type="button" className="wc" aria-label="Minimise" onClick={() => void appWindow.minimize()}>
              <Minus size={15} />
            </button>
            <button ref={maximizeRef} type="button" className="wc" aria-label={maximized ? 'Restore' : 'Maximise'} onClick={() => void appWindow.toggleMaximize()}>
              {maximized ? <Copy size={12} style={{ transform: 'scaleX(-1)' }} /> : <Square size={12} />}
            </button>
            <button type="button" className="wc wc-close" aria-label="Close" onClick={() => void requestQuit()}>
              <X size={16} />
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

function Tab({
  doc,
  active,
  fresh,
  onKey,
  onCloseClick,
}: {
  doc: Doc;
  active: boolean;
  fresh: boolean;
  onKey: (e: ReactKeyboardEvent<HTMLElement>, id: string) => void;
  onCloseClick: (width: number) => void;
}) {
  const dirty = isDirty(doc);
  const name = displayName(doc);
  return (
    <div
      role="tab"
      aria-selected={active}
      aria-label={dirty ? `${name}, unsaved` : name}
      // Roving tab stop: only the active tab is in the Tab order.
      tabIndex={active ? 0 : -1}
      data-doc-id={doc.id}
      className="tab"
      data-active={active}
      data-dirty={dirty || undefined}
      data-fresh={fresh || undefined}
      title={doc.path ?? name}
      onKeyDown={(e) => onKey(e, doc.id)}
      onAuxClick={(e) => {
        if (e.button === 1) requestClose(doc.id);
      }}
      onMouseDown={(e) => {
        // Middle-click closes; it must not start Windows' autoscroll.
        if (e.button === 1) e.preventDefault();
      }}
    >
      <span className="tab-name">{name}</span>
      <button
        type="button"
        className="tab-close"
        // Not in the Tab order: a tab closes with Delete or Ctrl+W. Pointer clicks still work.
        tabIndex={-1}
        aria-label={`Close ${name}`}
        // A click must not move focus off the tab that has it.
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation();
          // A real mouse click (not the keyboard): hold the tab widths still while the pointer stays.
          if (e.detail > 0) onCloseClick((e.currentTarget.parentElement as HTMLElement).getBoundingClientRect().width);
          requestClose(doc.id);
        }}
      >
        <span className="tab-dot" />
        <X size={13} />
      </button>
    </div>
  );
}
