import { motion } from 'motion/react';
import { CornerDownLeft, FileText, Hash, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { COMMANDS } from '../lib/commands';
import { useFocusTrap } from '../lib/focusTrap';
import { extractHeadings } from '../lib/markdown';
import { isTauri, listFiles, type DirEntry } from '../lib/platform';
import { useSettings } from '../lib/settings';
import { activeDoc, displayName, pathKey, useApp } from '../lib/store';
import { useUi } from '../lib/ui';
import { Keys, SPRING } from './ui/controls';

/** Most file-name matches listed at once. */
const FILE_RESULTS = 50;

interface Row {
  key: string;
  title: string;
  group: string;
  hint?: string;
  keys?: string;
  icon?: React.ReactNode;
  indent?: number;
  run: () => void | Promise<void>;
  score: number;
  marks: number[];
}

/** Subsequence match that rewards word starts and consecutive hits. */
function fuzzy(query: string, text: string): { score: number; marks: number[] } | null {
  if (!query) return { score: 0, marks: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const marks: number[] = [];
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    if (ch === ' ') continue;
    let found = -1;
    for (let i = ti; i < t.length; i++) {
      if (t[i] === ch) {
        found = i;
        break;
      }
    }
    if (found < 0) return null;
    const wordStart = found === 0 || /[\s:./\\_-]/.test(t[found - 1]);
    score += 1 + (found === prev + 1 ? 3 : 0) + (wordStart ? 4 : 0) - Math.min(3, (found - ti) * 0.15);
    marks.push(found);
    prev = found;
    ti = found + 1;
  }
  return { score: score - t.length * 0.01, marks };
}

/** `path` relative to `folder`, without a leading separator. Paths outside the folder come back unchanged. */
function relativeTo(folder: string, path: string): string {
  const base = folder.replace(/[\\/]+$/, '');
  const inside = path.length > base.length && path.slice(0, base.length).toLowerCase() === base.toLowerCase();
  return (inside ? path.slice(base.length) : path).replace(/^[\\/]+/, '');
}

function Marked({ text, marks }: { text: string; marks: number[] }) {
  if (!marks.length) return <>{text}</>;
  const set = new Set(marks);
  return (
    <>
      {Array.from(text).map((ch, i) => (set.has(i) ? <b key={i}>{ch}</b> : ch))}
    </>
  );
}

export function Palette() {
  const close = () => useUi.getState().close('palette');
  const [query, setQuery] = useState(() => useUi.getState().paletteQuery);
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useFocusTrap(dialogRef, inputRef);
  const doc = useApp(activeDoc);
  const recents = useApp((s) => s.recents);
  const docs = useApp((s) => s.docs);
  const folder = useApp((s) => s.folder);
  const settings = useSettings((st) => st.settings);
  const content = doc?.content;
  const lineMode = query.startsWith(':');
  const headingMode = query.startsWith('#');

  // The folder's file list is read once per palette opening (the palette mounts per opening) and again if the folder changes.
  // A result that arrives after the folder changed or the palette closed is dropped.
  const [folderFiles, setFolderFiles] = useState<{ folder: string; entries: DirEntry[] } | null>(null);
  useEffect(() => {
    if (!folder) return;
    let current = true;
    listFiles(folder, 5000)
      .then((entries) => {
        if (current) setFolderFiles({ folder, entries });
      })
      .catch(() => {
        if (current) setFolderFiles({ folder, entries: [] });
      });
    return () => {
      current = false;
    };
  }, [folder]);
  const files = folder && folderFiles?.folder === folder ? folderFiles.entries : null;

  // Counting lines splits the whole document, so it runs once per document, not once per keystroke.
  const lineTotal = useMemo(
    () => (lineMode && content !== undefined ? content.split(/\r\n|\r|\n/).length : 0),
    [lineMode, content],
  );
  // Parsed once per document, and only while heading search is open. Same options as Reader, so the cache matches.
  const headings = useMemo(
    () =>
      headingMode && content !== undefined
        ? extractHeadings(content, {
            breaks: settings.breaks,
            linkify: settings.linkify,
            typographer: settings.typographer,
            emoji: settings.emoji,
            math: settings.math,
            html: settings.rawHtml,
            localFiles: isTauri,
          })
        : [],
    [headingMode, content, settings.breaks, settings.linkify, settings.typographer, settings.emoji, settings.math, settings.rawHtml],
  );

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (lineMode) {
      if (!doc) return [];
      const n = parseInt(query.slice(1), 10);
      const line = Number.isFinite(n) ? Math.min(Math.max(n, 1), lineTotal) : null;
      return [
        {
          key: 'goto-line',
          title: line ? `Go to line ${line}` : `Type a line number (1–${lineTotal})`,
          group: 'Go to line',
          icon: <Hash size={14} />,
          run: () => (line ? useUi.getState().jumpTo({ line: line - 1 }) : undefined),
          score: 0,
          marks: [],
        },
      ];
    }
    const q = (headingMode ? query.slice(1) : query).trim();

    if (headingMode) {
      if (!doc) return [];
      headings.forEach((h, i) => {
        const m = fuzzy(q, h.text);
        if (m) {
          out.push({
            key: `h${i}`,
            title: h.text,
            group: 'Headings',
            icon: <Hash size={14} />,
            indent: h.level - 1,
            run: () => useUi.getState().jumpTo({ index: i, line: h.line }),
            score: q ? m.score : -i,
            marks: m.marks,
          });
        }
      });
      return q ? out.sort((a, b) => b.score - a.score) : out;
    }

    for (const c of COMMANDS) {
      if (c.needsDoc && !doc) continue;
      if (c.id === 'view.palette') continue;
      const m = fuzzy(q, c.title) ?? (c.keywords ? fuzzy(q, c.keywords) && { score: 0.5, marks: [] } : null);
      if (m) out.push({ key: c.id, title: c.title, group: c.group, keys: c.keys, run: c.run, score: m.score, marks: m.marks });
    }
    const openPaths = new Set(docs.map((d) => d.path));
    for (const d of docs) {
      const name = displayName(d);
      const m = fuzzy(q, name);
      if (m && d.id !== doc?.id) {
        out.push({ key: `tab-${d.id}`, title: name, group: 'Open tabs', icon: <FileText size={14} />, run: () => useApp.getState().activate(d.id), score: m.score + 1, marks: m.marks });
      }
    }
    for (const r of recents) {
      if (openPaths.has(r.path)) continue;
      const m = fuzzy(q, r.name);
      if (m) {
        out.push({ key: `recent-${r.path}`, title: r.name, group: 'Recent files', hint: r.path, icon: <FileText size={14} />, run: () => useApp.getState().openPaths([r.path]), score: m.score, marks: m.marks });
      }
    }
    // File names in the open folder. Typing is needed: an empty query keeps the list to commands, tabs and recents.
    if (q && folder && files) {
      // Files already listed above (open tabs and recents) are not listed twice.
      const listed = new Set<string>();
      for (const d of docs) if (d.path) listed.add(pathKey(d.path));
      for (const r of recents) listed.add(pathKey(r.path));
      const matches: Row[] = [];
      for (const f of files) {
        if (f.isDir || listed.has(pathKey(f.path))) continue;
        const m = fuzzy(q, f.name);
        if (m) {
          matches.push({
            key: `file-${f.path}`,
            title: f.name,
            group: 'Files in folder',
            hint: relativeTo(folder, f.path),
            icon: <FileText size={14} />,
            run: () => useApp.getState().openPaths([f.path]),
            score: m.score,
            marks: m.marks,
          });
        }
      }
      matches.sort((a, b) => b.score - a.score);
      out.push(...matches.slice(0, FILE_RESULTS));
    }
    if (q) out.sort((a, b) => b.score - a.score);
    return out.slice(0, 60);
  }, [query, doc, recents, docs, lineMode, lineTotal, headingMode, headings, folder, files]);

  useEffect(() => setCursor(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('[data-cursor="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const run = (row: Row | undefined) => {
    if (!row) return;
    close();
    // Let the palette start closing before the command opens another surface.
    requestAnimationFrame(() => void row.run());
  };

  const grouped = !query.trim() || query.trim() === '#';
  let lastGroup = '';

  return (
    <motion.div
      className="overlay overlay-top"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <motion.div
        ref={dialogRef}
        className="palette popover"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        initial={{ opacity: 0, y: -14, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -8, scale: 0.98, transition: { duration: 0.12 } }}
        transition={SPRING}
      >
        <div className="palette-input">
          <Search size={16} />
          <input
            ref={inputRef}
            aria-label="Search commands and files"
            spellCheck={false}
            placeholder="Search commands and files, or type # for headings"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setCursor((c) => (rows.length ? (c + 1) % rows.length : 0));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setCursor((c) => (rows.length ? (c - 1 + rows.length) % rows.length : 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(rows[cursor]);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                close();
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" ref={listRef} role="listbox">
          {rows.length === 0 && <div className="palette-empty">No matches for “{query}”</div>}
          {rows.map((row, i) => {
            const header = grouped && row.group !== lastGroup ? row.group : null;
            lastGroup = row.group;
            return (
              <div key={row.key}>
                {header && <div className="palette-group">{header}</div>}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === cursor}
                  className="palette-row"
                  data-cursor={i === cursor}
                  onMouseMove={() => i !== cursor && setCursor(i)}
                  onClick={() => run(row)}
                >
                  {i === cursor && <motion.span layoutId="palette-cursor" className="palette-row-bg" transition={{ type: 'spring', stiffness: 900, damping: 50 }} />}
                  {row.icon && <span className="palette-icon" style={{ marginLeft: (row.indent ?? 0) * 12 }}>{row.icon}</span>}
                  <span className="palette-title">
                    <Marked text={row.title} marks={row.marks} />
                  </span>
                  {row.hint && <span className="palette-hint">{row.hint}</span>}
                  {!grouped && !row.icon && <span className="palette-tag">{row.group}</span>}
                  {row.keys && <Keys combo={row.keys} />}
                  {i === cursor && !row.keys && <CornerDownLeft size={13} className="palette-enter" />}
                </button>
              </div>
            );
          })}
        </div>
      </motion.div>
    </motion.div>
  );
}
