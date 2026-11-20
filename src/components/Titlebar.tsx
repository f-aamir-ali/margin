import { AnimatePresence, Reorder, motion } from 'motion/react';
import {
  BookOpen,
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
import { useEffect, useRef, useState } from 'react';
import { requestClose, requestQuit, runCommand, setMode } from '../lib/commands';
import { appWindow, isProseName, isTauri } from '../lib/platform';
import type { ViewMode } from '../lib/settings';
import { activeDoc, displayName, isDirty, useApp, type Doc } from '../lib/store';
import { IconButton, Menu, Segmented, SPRING, type MenuItem } from './ui/controls';

export function Titlebar() {
  const docs = useApp((s) => s.docs);
  const activeId = useApp((s) => s.activeId);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const doc = useApp(activeDoc);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const [maximized, setMaximized] = useState(false);
  const tabsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let off: (() => void) | undefined;
    const sync = () => void appWindow.isMaximized().then(setMaximized);
    sync();
    void appWindow.onResized(sync).then((u) => (off = u));
    return () => off?.();
  }, []);

  // Keep the active tab in view.
  useEffect(() => {
    tabsRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
  }, [activeId, docs.length]);

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

      <Reorder.Group
        as="div"
        axis="x"
        className="tabs"
        ref={tabsRef}
        values={docs}
        onReorder={(next: Doc[]) => useApp.setState({ docs: next })}
        onWheel={(e) => {
          if (e.deltaY !== 0 && tabsRef.current) tabsRef.current.scrollLeft += e.deltaY;
        }}
      >
        <AnimatePresence initial={false}>
          {docs.map((d) => (
            <Tab key={d.id} doc={d} active={d.id === activeId} />
          ))}
        </AnimatePresence>
        <IconButton label="New note" keys="Ctrl+N" className="tab-new" onClick={() => runCommand('file.new')}>
          <Plus size={15} />
        </IconButton>
        <div className="tabs-drag" data-tauri-drag-region />
      </Reorder.Group>

      <div className="titlebar-right">
        {doc && doc.kind === 'text' && (!doc.path || isProseName(doc.name)) && (
          <button type="button" className="format-md" data-tip="Show this file formatted, with Read and Edit" data-tip-side="bottom" onClick={() => runCommand('mode.formatMarkdown')}>
            <Sparkles size={13} />
            <span className="mode-text">Format as markdown</span>
          </button>
        )}
        {doc && doc.kind === 'markdown' && (
          <Segmented<ViewMode>
            ariaLabel="View mode"
            size="sm"
            value={doc.mode}
            onChange={setMode}
            options={[
              { value: 'read', label: <ModeLabel icon={<BookOpen size={14} />} text="Read" />, title: 'Reading mode', keys: 'Ctrl+E' },
              { value: 'edit', label: <ModeLabel icon={<PencilLine size={14} />} text="Edit" />, title: 'Editing mode', keys: 'Ctrl+E' },
              { value: 'source', label: <ModeLabel icon={<Code2 size={14} />} text="Source" />, title: 'Markdown source', keys: 'Ctrl+/' },
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
            <button type="button" className="wc" aria-label={maximized ? 'Restore' : 'Maximise'} onClick={() => void appWindow.toggleMaximize()}>
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

function ModeLabel({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <>
      {icon}
      <span className="mode-text">{text}</span>
    </>
  );
}

function Tab({ doc, active }: { doc: Doc; active: boolean }) {
  const dirty = isDirty(doc);
  const activate = useApp((s) => s.activate);
  return (
    <Reorder.Item
      as="div"
      value={doc}
      className="tab"
      data-active={active}
      data-dirty={dirty || undefined}
      title={doc.path ?? displayName(doc)}
      initial={{ opacity: 0, scale: 0.9, width: 0 }}
      animate={{ opacity: 1, scale: 1, width: 'auto' }}
      exit={{ opacity: 0, scale: 0.9, width: 0, transition: { duration: 0.16 } }}
      transition={SPRING}
      whileDrag={{ scale: 1.03, zIndex: 5 }}
      onPointerDown={(e) => {
        if (e.button === 0) activate(doc.id);
      }}
      onAuxClick={(e) => {
        if (e.button === 1) requestClose(doc.id);
      }}
    >
      {active && <motion.span layoutId="tab-active" className="tab-bg" transition={SPRING} />}
      <span className="tab-name">{displayName(doc)}</span>
      <button
        type="button"
        className="tab-close"
        aria-label={`Close ${displayName(doc)}`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          requestClose(doc.id);
        }}
      >
        <span className="tab-dot" />
        <X size={13} />
      </button>
    </Reorder.Item>
  );
}
