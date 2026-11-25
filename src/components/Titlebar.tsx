import { AnimatePresence, Reorder, motion, useMotionValue } from 'motion/react';
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
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { requestClose, requestQuit, runCommand, setMode } from '../lib/commands';
import { appWindow, isProseName, isTauri } from '../lib/platform';
import { attachSnapLayout } from '../lib/snapLayout';
import type { ViewMode } from '../lib/settings';
import { activeDoc, displayName, isDirty, useApp, type Doc } from '../lib/store';
import { IconButton, Menu, Segmented, SPRING, type MenuItem } from './ui/controls';

/** How far a tab's drag may travel: from the first tab's left edge to the last tab's right edge. */
interface DragBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Breathing room kept between the active tab and the edge of the strip when it is scrolled into view. */
const EDGE_GAP = 32;

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
  // Mutated in place on drag start (see measureDrag) and read by motion, so it needs no re-render.
  const dragBounds = useRef<DragBounds>({ left: 0, right: 0, top: 0, bottom: 0 }).current;
  const [overflow, setOverflow] = useState({ left: false, right: false });
  // Windows 11: resting on Maximise shows the Snap Layouts flyout, as in every native app.
  useEffect(() => (maximizeRef.current ? attachSnapLayout(maximizeRef.current) : undefined), []);
  // While the pointer stays on the tab strip after closing a tab, tabs keep their width
  // (as in Chrome), so the next tab's close button slides under the cursor.
  // `pad` stands in for the closed tabs so the strip keeps its length: a scrolled strip would
  // otherwise jump sideways when it gets shorter.
  const [frozen, setFrozen] = useState<{ width: number; pad: number } | null>(null);
  const frozenWidth = frozen?.width ?? null;

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

  /** Scrolls the strip, and only the strip, so the titlebar and its clipped parents never move. */
  const scrollTabIntoView = (el: HTMLElement, behavior: ScrollBehavior) => {
    const strip = tabsRef.current;
    if (!strip) return;
    const bar = strip.getBoundingClientRect();
    const tab = el.getBoundingClientRect();
    const delta =
      tab.left < bar.left + EDGE_GAP ? tab.left - bar.left - EDGE_GAP : tab.right > bar.right - EDGE_GAP ? tab.right - bar.right + EDGE_GAP : 0;
    if (delta !== 0) strip.scrollTo({ left: strip.scrollLeft + delta, behavior });
  };

  /** A document's tab element. A closing tab can linger in the DOM for a moment, so never match by position. */
  const tabEl = (id: string) => [...(tabsRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])].find((t) => t.dataset.docId === id);
  // Until this time (performance.now()), focus stays on the active tab. Set by keyboard moves.
  const keyboardMove = useRef(0);
  // The document of the tab that focus was last on ('' for a tab without one, null when focus was elsewhere).
  const lastStripDoc = useRef<string | null>(null);
  // Switching documents mounts the editor, which takes focus a moment after the commit. Within the
  // window after a keyboard move, that focus goes back to the tab.
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const strip = tabsRef.current;
      if (!strip) return;
      const inStrip = strip.contains(e.target as Node);
      lastStripDoc.current = inStrip ? ((e.target as HTMLElement).dataset.docId ?? '') : null;
      if (!inStrip && performance.now() <= keyboardMove.current) tabEl(useApp.getState().activeId ?? '')?.focus({ preventScroll: true });
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, []);
  // Keep the active tab in view when it changes or a tab is added. Not when one closes:
  // scrolling then would move the close button that is under the pointer.
  const lastCount = useRef(docs.length);
  useEffect(() => {
    const added = docs.length > lastCount.current;
    lastCount.current = docs.length;
    const strip = tabsRef.current;
    const el = activeId ? tabEl(activeId) : undefined;
    if (!strip || !el) return;
    // Focus follows the active tab. Ctrl+W is global and always closes the active tab, so a focused
    // tab has to be the active one for Ctrl+W to close the tab that has focus. This effect runs after
    // the editor's own focus effect (children's effects run first), so it has the last word.
    const focused = lastStripDoc.current;
    if (focused && !docs.some((d) => d.id === focused)) keyboardMove.current = performance.now() + 600;
    const focusLost = !document.activeElement || document.activeElement === document.body;
    if (performance.now() <= keyboardMove.current || (focused !== null && (focusLost || (strip.contains(document.activeElement) && document.activeElement !== el)))) {
      el.focus({ preventScroll: true });
    }
    if (frozenWidth !== null && !added) return;
    scrollTabIntoView(el, 'smooth');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, docs.length]);

  /**
   * Limits a dragged tab to the first and last slots, measured at pointer down from the tab's layout
   * box (offsetLeft ignores transforms and scroll). Motion reads these once, when the drag starts, and
   * keeps them for the whole drag, so each Tab also clamps its own position on every drag frame.
   */
  const measureDrag = (el: HTMLElement) => {
    const strip = tabsRef.current;
    if (!strip) return;
    // scrollWidth would count the translation of a tab that is already dragged, so use the last tab's layout box.
    const tabs = strip.querySelectorAll<HTMLElement>('.tab');
    const last = tabs[tabs.length - 1];
    const contentRight = last ? last.offsetLeft + last.offsetWidth : strip.clientWidth;
    dragBounds.left = -el.offsetLeft;
    dragBounds.right = contentRight - el.offsetLeft - el.offsetWidth;
  };

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

  /** Roving focus, like a native tab strip. Focus and activation move together, so Ctrl+W always matches the focused tab. */
  const onTabKey = (e: ReactKeyboardEvent<HTMLElement>, id: string) => {
    if (e.target !== e.currentTarget || e.altKey || e.ctrlKey || e.metaKey) return;
    const index = docs.findIndex((d) => d.id === id);
    const count = docs.length;
    const focusDoc = (target: Doc) => {
      keyboardMove.current = performance.now() + 600;
      useApp.getState().activate(target.id);
      tabEl(target.id)?.focus({ preventScroll: true });
    };
    let target = -1;
    if (e.key === 'ArrowRight') target = (index + 1) % count;
    else if (e.key === 'ArrowLeft') target = (index - 1 + count) % count;
    else if (e.key === 'Home') target = 0;
    else if (e.key === 'End') target = count - 1;
    if (target >= 0) {
      e.preventDefault();
      focusDoc(docs[target]);
    } else if (e.key === 'Enter' || e.key === ' ') {
      // Space is motion's keyboard grab; here it activates the tab instead.
      e.preventDefault();
      useApp.getState().activate(id);
    } else if (e.key === 'Delete') {
      e.preventDefault();
      // Move focus off the tab first, so it isn't left on nothing when the tab unmounts.
      const next = docs[index + 1] ?? docs[index - 1];
      if (next) focusDoc(next);
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
        <Reorder.Group
          as="div"
          axis="x"
          role="tablist"
          aria-label="Open notes"
          className="tabs"
          ref={tabsRef}
          values={docs}
          data-frozen={frozenWidth !== null || undefined}
          style={frozenWidth !== null ? ({ '--tab-frozen': `${frozenWidth}px` } as React.CSSProperties) : undefined}
          onReorder={(next: Doc[]) => useApp.setState({ docs: next })}
          onPointerLeave={() => setFrozen(null)}
          onWheel={onWheel}
        >
          <AnimatePresence initial={false} mode="popLayout">
            {docs.map((d) => (
              <Tab
                key={d.id}
                doc={d}
                active={d.id === activeId}
                dragBounds={dragBounds}
                onMeasureDrag={measureDrag}
                onKey={onTabKey}
                onCloseClick={(w) => setFrozen((f) => ({ width: f?.width ?? w, pad: (f?.pad ?? 0) + w + 2 }))}
              />
            ))}
          </AnimatePresence>
          {frozen && <div className="tabs-hold" style={{ flex: `0 0 ${frozen.pad}px`, width: frozen.pad }} aria-hidden />}
        </Reorder.Group>
        {/* Overlaid on the strip's edges, and only shown while tabs are hidden past that edge. */}
        <button type="button" className="tabs-nav tabs-nav-left" aria-label="Scroll tabs left" onClick={() => scrollStrip(-1)}>
          <ChevronLeft size={14} />
        </button>
        <button type="button" className="tabs-nav tabs-nav-right" aria-label="Scroll tabs right" onClick={() => scrollStrip(1)}>
          <ChevronRight size={14} />
        </button>
      </div>
      {/* Outside the scrolling strip, so it never scrolls out of sight. */}
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
  dragBounds,
  onMeasureDrag,
  onKey,
  onCloseClick,
}: {
  doc: Doc;
  active: boolean;
  dragBounds: DragBounds;
  onMeasureDrag: (el: HTMLElement) => void;
  onKey: (e: ReactKeyboardEvent<HTMLElement>, id: string) => void;
  onCloseClick: (width: number) => void;
}) {
  const dirty = isDirty(doc);
  const name = displayName(doc);
  const activate = useApp((s) => s.activate);
  // From the store, not the prop: a closing tab keeps its last props while it animates out.
  const selected = useApp((s) => s.activeId === doc.id);
  // Our own x, so every drag frame can be held between the first and last slot. The bounds are
  // measured from the tab's current slot each frame, so they stay right after it passes others.
  const x = useMotionValue(0);
  const itemRef = useRef<HTMLDivElement>(null);
  const clampToStrip = () => {
    const el = itemRef.current;
    if (!el) return;
    const strip = el.parentElement;
    const tabs = strip?.querySelectorAll<HTMLElement>('.tab');
    const last = tabs?.[tabs.length - 1];
    if (!strip || !last) return;
    const right = last.offsetLeft + last.offsetWidth;
    const min = -el.offsetLeft;
    const max = right - el.offsetLeft - el.offsetWidth;
    const value = x.get();
    if (value < min) x.set(min);
    else if (value > max) x.set(max);
  };
  return (
    <Reorder.Item
      as="div"
      role="tab"
      aria-selected={selected}
      aria-label={dirty ? `${name}, unsaved` : name}
      // Roving tab stop: only the active tab is in the Tab order. Passed explicitly, it overrides motion's own.
      tabIndex={selected ? 0 : -1}
      data-doc-id={doc.id}
      value={doc}
      className="tab"
      data-active={active}
      data-dirty={dirty || undefined}
      title={doc.path ?? name}
      initial={{ opacity: 0, scale: 0.94 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.12 } }}
      transition={SPRING}
      whileDrag={{ scale: 1.03, zIndex: 5 }}
      // A hard stop at the strip's ends: the tab can't be dragged past the last slot or into the + button.
      dragConstraints={dragBounds}
      dragElastic={0}
      style={{ x }}
      ref={itemRef}
      onDrag={clampToStrip}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        onMeasureDrag(e.currentTarget);
        activate(doc.id);
      }}
      onKeyDown={(e) => onKey(e, doc.id)}
      onAuxClick={(e) => {
        if (e.button === 1) requestClose(doc.id);
      }}
    >
      {active && <motion.span layoutId="tab-active" className="tab-bg" transition={SPRING} />}
      <span className="tab-name">{name}</span>
      <button
        type="button"
        className="tab-close"
        // Not in the Tab order: a tab closes with Delete or Ctrl+W. Pointer clicks still work.
        tabIndex={-1}
        aria-label={`Close ${name}`}
        // A click must not move focus off the tab that has it.
        onMouseDown={(e) => e.preventDefault()}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          // A real mouse click (not the keyboard): hold the tab widths still.
          if (e.detail > 0) onCloseClick((e.currentTarget.parentElement as HTMLElement).getBoundingClientRect().width);
          requestClose(doc.id);
        }}
      >
        <span className="tab-dot" />
        <X size={13} />
      </button>
    </Reorder.Item>
  );
}
