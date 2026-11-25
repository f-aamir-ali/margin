import { AnimatePresence, motion } from 'motion/react';
import { Check, CircleAlert, Lock, Minus, Moon, Plus, Sun } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { runCommand } from '../lib/commands';
import { activeTheme, isDarkTheme, useSettings } from '../lib/settings';
import { formatMinutes } from '../lib/stats';
import { useDocStats } from '../lib/useDocStats';
import { hasEncodingChange, isDirty, useApp, viewMode, type Doc, type Eol } from '../lib/store';
import { useView } from '../lib/viewSync';
import { Menu, type MenuItem } from './ui/controls';

const fmt = new Intl.NumberFormat('en-CA');

/** Narrow windows (a vertical monitor, a snapped half) get the short line-ending and encoding labels. */
const NARROW = '(max-width: 860px)';
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  useEffect(() => {
    const mq = window.matchMedia(NARROW);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

export function StatusBar({ doc }: { doc: Doc | null }) {
  const zoom = useApp((s) => s.zoom);
  const settings = useSettings((s) => s.settings);
  const systemDark = useSettings((s) => s.systemDark);
  const dark = isDarkTheme(activeTheme(settings, systemDark));
  const stats = useDocStats(doc?.content ?? '', doc?.kind === 'text');
  const progress = useView((s) => s.progress);
  const selectionWords = useView((s) => s.selectionWords);
  const selectionChars = useView((s) => s.selectionChars);
  const cursor = useView((s) => s.cursor);

  return (
    <footer className="statusbar">
      <div className="status-left">
        {doc && (
          <>
            <SaveState doc={doc} />
            <span className="status-item" data-tip={`${fmt.format(stats.chars)} characters · ${fmt.format(stats.lines)} lines`} data-tip-side="top">
              {selectionWords > 0 ? `${fmt.format(Math.min(selectionWords, stats.words))} of ${fmt.format(stats.words)} words` : `${fmt.format(stats.words)} words`}
            </span>
            {doc.kind === 'markdown' && <span className="status-item status-dim status-optional">{formatMinutes(stats.minutes)}</span>}
            {viewMode(doc) !== 'source' && stats.words > 0 && <span className="status-item status-dim status-num">{Math.round(progress * 100)}%</span>}
          </>
        )}
      </div>
      <div className="status-right">
        {doc && cursor && viewMode(doc) === 'source' && (
          <button type="button" className="status-btn status-num status-cursor" data-tip="Go to line" data-tip-keys="Ctrl+G" data-tip-side="top" onClick={() => runCommand('go.line')}>
            Ln {fmt.format(cursor.line)}, Col {fmt.format(cursor.col)}
            {selectionChars > 0 && <span className="status-dim status-optional"> · {fmt.format(selectionChars)} selected</span>}
          </button>
        )}
        {doc && <FormatMenus key={doc.id} doc={doc} />}
        <div className="zoom">
          <button type="button" className="status-btn" aria-label="Zoom out" data-tip="Zoom out" data-tip-keys="Ctrl+-" data-tip-side="top" onClick={() => runCommand('view.zoomOut')}>
            <Minus size={13} />
          </button>
          <button type="button" className="status-btn zoom-value" data-tip="Reset zoom" data-tip-keys="Ctrl+0" data-tip-side="top" onClick={() => runCommand('view.zoomReset')}>
            {Math.round(zoom * 100)}%
          </button>
          <button type="button" className="status-btn" aria-label="Zoom in" data-tip="Zoom in" data-tip-keys="Ctrl+=" data-tip-side="top" onClick={() => runCommand('view.zoomIn')}>
            <Plus size={13} />
          </button>
        </div>
        <button
          type="button"
          className="status-btn"
          aria-label="Switch theme"
          data-tip={dark ? 'Switch to light' : 'Switch to dark'}
          data-tip-side="top"
          onClick={() => runCommand('theme.toggle')}
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={dark ? 'moon' : 'sun'}
              className="status-icon"
              initial={{ rotate: -70, scale: 0.4, opacity: 0 }}
              animate={{ rotate: 0, scale: 1, opacity: 1 }}
              exit={{ rotate: 70, scale: 0.4, opacity: 0 }}
              transition={{ duration: 0.18 }}
            >
              {dark ? <Moon size={13} /> : <Sun size={13} />}
            </motion.span>
          </AnimatePresence>
        </button>
      </div>
    </footer>
  );
}

const ENCODINGS: { value: string; bom: boolean; label: string }[] = [
  { value: 'UTF-8', bom: false, label: 'UTF-8' },
  { value: 'UTF-8', bom: true, label: 'UTF-8 with BOM' },
  { value: 'UTF-16LE', bom: true, label: 'UTF-16 LE' },
  { value: 'UTF-16BE', bom: true, label: 'UTF-16 BE' },
  { value: 'windows-1252', bom: false, label: 'ANSI (Windows-1252)' },
];

export function encodingLabel(encoding: string, bom: boolean): string {
  const known = ENCODINGS.find((e) => e.value.toLowerCase() === encoding.toLowerCase() && (e.bom === bom || !e.value.startsWith('UTF-8')));
  if (known) return known.label;
  return encoding.startsWith('windows-') ? `ANSI (${encoding.replace('windows-', 'Windows-')})` : encoding;
}

/** Compact label for narrow windows (a vertical monitor): "UTF-8", "UTF-8 BOM", "ANSI", "UTF-16 LE". */
function encodingShort(encoding: string, bom: boolean): string {
  const full = encodingLabel(encoding, bom);
  if (full.startsWith('ANSI')) return 'ANSI';
  return full.replace(' with BOM', ' BOM');
}

const EOLS: { value: Eol; label: string; short: string }[] = [
  { value: '\r\n', label: 'Windows (CRLF)', short: 'CRLF' },
  { value: '\n', label: 'Unix (LF)', short: 'LF' },
  { value: '\r', label: 'Classic Mac (CR)', short: 'CR' },
];

/** Notepad's status bar: line endings and encoding, each a menu. */
function FormatMenus({ doc }: { doc: Doc }) {
  const [open, setOpen] = useState<'eol' | 'enc' | null>(null);
  const eolRef = useRef<HTMLButtonElement>(null);
  const encodingRef = useRef<HTMLButtonElement>(null);
  const eol = doc.eol;
  const narrow = useNarrow();
  const app = useApp.getState();
  const eolItems: MenuItem[] = EOLS.map((e) => ({ id: e.short, label: e.label, checked: e.value === eol, disabled: doc.readonly, run: () => app.setEol(doc.id, e.value) }));
  const encItems: MenuItem[] = [
    ...ENCODINGS.map((e, i) => ({
      id: `save-${i}`,
      label: `Save as ${e.label}`,
      checked: e.value.toLowerCase() === doc.encoding.toLowerCase() && e.bom === doc.bom,
      disabled: doc.readonly,
      run: () => app.setEncoding(doc.id, e.value, e.bom),
    })),
    ...(doc.path
      ? ENCODINGS.filter((_, i) => i !== 1).map((e, i) => ({
          id: `reopen-${i}`,
          label: `Reopen as ${e.label}`,
          separatorBefore: i === 0,
          run: () => void app.reopenWithEncoding(doc.id, e.value),
        }))
      : []),
  ];
  return (
    <>
      <div className="menu-anchor">
        <button ref={eolRef} type="button" className="status-btn" aria-haspopup="menu" aria-expanded={open === 'eol'} data-tip="Line endings" data-tip-side="top" onClick={() => setOpen(open === 'eol' ? null : 'eol')}>
          {narrow ? (EOLS.find((e) => e.value === eol)?.short ?? 'CRLF') : (EOLS.find((e) => e.value === eol)?.label ?? 'Windows (CRLF)')}
        </button>
        <AnimatePresence>{open === 'eol' && <Menu anchor={eolRef} side="top" items={eolItems} onClose={() => setOpen(null)} />}</AnimatePresence>
      </div>
      <div className="menu-anchor">
        <button ref={encodingRef} type="button" className="status-btn" aria-haspopup="menu" aria-expanded={open === 'enc'} data-tip={hasEncodingChange(doc) ? 'Encoding (changes on next save)' : 'Encoding'} data-tip-side="top" onClick={() => setOpen(open === 'enc' ? null : 'enc')}>
          {narrow ? encodingShort(doc.encoding, doc.bom) : encodingLabel(doc.encoding, doc.bom)}
        </button>
        <AnimatePresence>{open === 'enc' && <Menu anchor={encodingRef} side="top" items={encItems} onClose={() => setOpen(null)} />}</AnimatePresence>
      </div>
    </>
  );
}

function SaveState({ doc }: { doc: Doc }) {
  const draftTrouble = useApp((s) => s.draftTrouble);
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const dirty = isDirty(doc);
  const state = doc.transient
    ? 'compare'
    : doc.diskError
      ? 'unreadable'
      : doc.readonly
        ? 'readonly'
        : doc.conflict
          ? 'conflict'
          : dirty && draftTrouble
            ? 'unsafe'
            : dirty
              ? (doc.path ? (doc.missing ? 'missing' : 'dirty') : 'new')
              : doc.path
                ? 'saved'
                : 'scratch';
  const label = {
    compare: 'Version on disk',
    unreadable: "Can't read file",
    readonly: 'Read-only',
    conflict: 'Changed on disk',
    unsafe: 'Not backed up',
    missing: 'File missing',
    dirty: 'Unsaved',
    new: 'Draft',
    saved: 'Saved',
    scratch: doc.content ? 'Scratch copy' : 'New note',
  }[state];
  // Hot exit makes "unsaved" safe: say so where the worry would be.
  const tip = {
    compare: 'Read-only copy of the file on disk, for comparing. Close it when done.',
    unreadable: `${doc.diskError ?? ''} Click to try again.`,
    readonly: undefined,
    conflict: 'Another program changed this file. Click to choose which version to keep.',
    unsafe: `Your unsaved text couldn't be written to the drafts folder: ${draftTrouble ?? ''} Save it to a file to be safe.`,
    missing: 'The file was moved or deleted. Save to write it back.',
    dirty: 'Kept safe even if you close Margin. Save to write the file.',
    new: 'Kept safe even if you close Margin. Save to put it in a file.',
    saved: undefined,
    scratch: undefined,
  }[state];
  const app = useApp.getState();
  const conflictItems: MenuItem[] = [
    { id: 'compare', label: 'Compare with the file on disk', run: () => void app.resolveConflict(doc.id, 'compare') },
    { id: 'mine', label: 'Keep mine (overwrite the file)', run: () => void app.resolveConflict(doc.id, 'overwrite') },
    { id: 'disk', label: "Use the file's version (yours goes to closed tabs)", run: () => void app.resolveConflict(doc.id, 'disk') },
    { id: 'copy', label: 'Save mine as a copy…', separatorBefore: true, run: () => void app.resolveConflict(doc.id, 'copy') },
  ];
  return (
    <div className="menu-anchor">
      <button
        ref={ref}
        type="button"
        className="status-item status-save"
        data-state={state}
        data-tip={menu ? undefined : tip}
        data-tip-keys={state === 'dirty' || state === 'new' || state === 'missing' || state === 'unsafe' ? 'Ctrl+S' : undefined}
        data-tip-side="top"
        aria-haspopup={state === 'conflict' ? 'menu' : undefined}
        aria-expanded={state === 'conflict' ? menu : undefined}
        onClick={() => {
          if (state === 'dirty' || state === 'new' || state === 'missing' || state === 'unsafe') runCommand('file.save');
          else if (state === 'conflict') setMenu((m) => !m);
          else if (state === 'unreadable') void app.retryDisk(doc.id);
        }}
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={state}
            className="status-save-inner"
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            transition={{ duration: 0.14 }}
          >
            {state === 'saved' && <Check size={12} />}
            {(state === 'readonly' || state === 'compare') && <Lock size={12} />}
            {(state === 'conflict' || state === 'unreadable' || state === 'unsafe' || state === 'missing') && <CircleAlert size={12} />}
            {(state === 'dirty' || state === 'new') && <span className="status-dot" />}
            {label}
          </motion.span>
        </AnimatePresence>
      </button>
      <AnimatePresence>{menu && state === 'conflict' && <Menu anchor={ref} side="top" align="left" items={conflictItems} onClose={() => setMenu(false)} />}</AnimatePresence>
    </div>
  );
}
