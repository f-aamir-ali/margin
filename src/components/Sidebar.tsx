import { AnimatePresence, motion } from 'motion/react';
import { ChevronRight, Clock, FileText, Folder, FolderOpen, ListTree, RefreshCw, X } from 'lucide-react';
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { runCommand } from '../lib/commands';
import { extractHeadings } from '../lib/markdown';
import { baseName, dirName, isProseName, isTextPath, listDir, type DirEntry } from '../lib/platform';
import { activeDoc, useApp, type SidebarTab } from '../lib/store';
import { useUi } from '../lib/ui';
import { useView } from '../lib/viewSync';
import { Button, IconButton, Segmented, SPRING, SPRING_SOFT } from './ui/controls';

export function Sidebar() {
  const tab = useApp((s) => s.sidebarTab);
  const width = useApp((s) => s.sidebarWidth);
  const setSidebar = useApp((s) => s.setSidebar);
  const [dragging, setDragging] = useState(false);

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const right = document.documentElement.dataset.sidebar === 'right';
    setDragging(true);
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) * (right ? -1 : 1);
      useApp.setState({ sidebarWidth: Math.min(420, Math.max(190, startW + dx)) });
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setSidebar({});
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <motion.aside
      className="sidebar tile"
      initial={{ width: 0, opacity: 0 }}
      animate={{ width, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={dragging ? { duration: 0 } : SPRING_SOFT}
    >
      <div className="sidebar-inner" style={{ width }}>
        <div className="sidebar-head">
          <Segmented<SidebarTab>
            ariaLabel="Sidebar section"
            size="sm"
            value={tab}
            onChange={(v) => setSidebar({ sidebarTab: v })}
            options={[
              { value: 'outline', label: <ListTree size={14} />, title: 'Outline', keys: 'Ctrl+Shift+L' },
              { value: 'files', label: <Folder size={14} />, title: 'Files', keys: 'Ctrl+Shift+E' },
              { value: 'recent', label: <Clock size={14} />, title: 'Recent', keys: 'Ctrl+R' },
            ]}
          />
        </div>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={tab}
            className="sidebar-body"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.08 } }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          >
            {tab === 'outline' && <Outline />}
            {tab === 'files' && <Files />}
            {tab === 'recent' && <Recent />}
          </motion.div>
        </AnimatePresence>
      </div>
      <div className="sidebar-resize" data-dragging={dragging || undefined} onPointerDown={startResize} />
    </motion.aside>
  );
}

/* ---------- Outline ---------- */

function Outline() {
  const doc = useApp(activeDoc);
  // Plain text has no headings, even if a line starts with "#".
  const content = useDeferredValue(doc?.kind === 'markdown' ? doc.content : '');
  const headings = useMemo(() => extractHeadings(content), [content]);
  const active = useView((s) => s.activeHeading);
  const listRef = useRef<HTMLDivElement>(null);
  const minLevel = useMemo(() => headings.reduce((m, h) => Math.min(m, h.level), 6), [headings]);

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [active]);

  if (!doc) return <Empty icon={<ListTree size={20} />} title="No document" hint="Open a file to see its outline." />;
  if (doc.kind === 'text') {
    return doc.path && !isProseName(doc.name) ? (
      <Empty icon={<ListTree size={20} />} title="Code file" hint="Outlines are for markdown documents." />
    ) : (
      <Empty icon={<ListTree size={20} />} title="Plain text" hint="No outline here. Format as markdown to get headings." />
    );
  }
  if (!headings.length) {
    return <Empty icon={<ListTree size={20} />} title="No headings yet" hint="Headings you add with # appear here." />;
  }

  return (
    <div className="outline" ref={listRef} role="tree">
      {headings.map((h, i) => (
        <button
          key={`${i}-${h.id}`}
          type="button"
          role="treeitem"
          className="outline-item"
          data-level={h.level - minLevel}
          data-active={i === active}
          style={{ paddingLeft: 12 + (h.level - minLevel) * 13 }}
          onClick={() => useUi.getState().jumpTo({ index: i, line: h.line })}
        >
          {i === active && <motion.span layoutId="outline-active" className="outline-bar" transition={SPRING} />}
          <span className="outline-text">{h.text}</span>
        </button>
      ))}
    </div>
  );
}

/* ---------- Files ---------- */

function Files() {
  const folder = useApp((s) => s.folder);
  const activePath = useApp((s) => activeDoc(s)?.path ?? null);
  const [nonce, setNonce] = useState(0);

  if (!folder) {
    return (
      <Empty icon={<FolderOpen size={20} />} title="No folder open" hint="Pick a folder to browse its markdown files.">
        <Button size="sm" onClick={() => runCommand('file.openFolder')}>
          Open folder
        </Button>
      </Empty>
    );
  }

  return (
    <div className="files">
      <div className="files-head">
        <span className="files-root" title={folder}>
          {baseName(folder) || folder}
        </span>
        <IconButton label="Refresh" tipSide="top" onClick={() => setNonce((n) => n + 1)}>
          <RefreshCw size={13} />
        </IconButton>
        <IconButton label="Open another folder" tipSide="top" onClick={() => runCommand('file.openFolder')}>
          <FolderOpen size={13} />
        </IconButton>
      </div>
      <div className="files-tree" role="tree">
        <DirChildren key={`${folder}-${nonce}`} path={folder} depth={0} activePath={activePath} />
      </div>
    </div>
  );
}

function DirChildren({ path, depth, activePath }: { path: string; depth: number; activePath: string | null }) {
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    listDir(path)
      .then((e) => alive && setEntries(e.filter((x) => x.isDir || x.isMarkdown || isTextPath(x.name))))
      .catch((err) => alive && setError(String(err)));
    return () => {
      alive = false;
    };
  }, [path]);

  if (error) return <div className="files-note" style={{ paddingLeft: 14 + depth * 14 }}>Can't read this folder</div>;
  if (!entries) return null;
  if (!entries.length) return <div className="files-note" style={{ paddingLeft: 14 + depth * 14 }}>No markdown files</div>;

  return (
    <>
      {entries.map((e) =>
        e.isDir ? <DirNode key={e.path} entry={e} depth={depth} activePath={activePath} /> : <FileNode key={e.path} entry={e} depth={depth} active={!!activePath && same(activePath, e.path)} />,
      )}
    </>
  );
}

const same = (a: string, b: string) => a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase();

function DirNode({ entry, depth, activePath }: { entry: DirEntry; depth: number; activePath: string | null }) {
  // Open automatically when it contains the active document.
  const containsActive = !!activePath && same(dirName(activePath).slice(0, entry.path.length), entry.path);
  const [open, setOpen] = useState(containsActive);
  return (
    <>
      <button type="button" className="file-row" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <motion.span className="file-chevron" animate={{ rotate: open ? 90 : 0 }} transition={SPRING}>
          <ChevronRight size={13} />
        </motion.span>
        <span className="file-name">{entry.name}</span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={SPRING_SOFT}
            style={{ overflow: 'hidden' }}
          >
            <DirChildren path={entry.path} depth={depth + 1} activePath={activePath} />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function FileNode({ entry, depth, active }: { entry: DirEntry; depth: number; active: boolean }) {
  return (
    <button
      type="button"
      className="file-row"
      data-active={active}
      style={{ paddingLeft: 8 + depth * 14 }}
      title={entry.path}
      onClick={() => void useApp.getState().openPaths([entry.path])}
    >
      <span className="file-chevron">
        <FileText size={13} />
      </span>
      <span className="file-name">{entry.name.replace(/\.(md|markdown|mdown|mkd|mdx|mdwn)$/i, '')}</span>
    </button>
  );
}

/* ---------- Recent ---------- */

function Recent() {
  const recents = useApp((s) => s.recents);
  const removeRecent = useApp((s) => s.removeRecent);
  const clear = useApp((s) => s.clearRecents);
  const open = useCallback((path: string) => void useApp.getState().openPaths([path]), []);

  if (!recents.length) return <Empty icon={<Clock size={20} />} title="Nothing recent" hint="Files you open are remembered here." />;

  return (
    <div className="recent">
      <AnimatePresence initial={false}>
        {recents.map((r) => (
          <motion.div
            key={r.path}
            layout
            className="recent-row"
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, height: 0, transition: { duration: 0.15 } }}
            transition={SPRING}
          >
            <button type="button" className="recent-main" title={r.path} onClick={() => open(r.path)}>
              <span className="recent-name">{r.name}</span>
              <span className="recent-dir">{shortDir(r.path)}</span>
            </button>
            <button type="button" className="recent-remove" aria-label={`Forget ${r.name}`} onClick={() => removeRecent(r.path)}>
              <X size={13} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
      <button type="button" className="recent-clear" onClick={clear}>
        Clear list
      </button>
    </div>
  );
}

function shortDir(path: string): string {
  const parts = dirName(path).split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? parts.join(' › ') : `… › ${parts.slice(-2).join(' › ')}`;
}

function Empty({ icon, title, hint, children }: { icon: React.ReactNode; title: string; hint: string; children?: React.ReactNode }) {
  return (
    <div className="side-empty">
      <span className="side-empty-icon">{icon}</span>
      <p className="side-empty-title">{title}</p>
      <p className="side-empty-hint">{hint}</p>
      {children}
    </div>
  );
}
