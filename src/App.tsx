import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { Upload } from 'lucide-react';
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ContextMenu } from './components/ContextMenu';
import { FindBar } from './components/FindBar';
import { Palette } from './components/Palette';
import { Reader } from './components/Reader';
import { SettingsPanel } from './components/Settings';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { Titlebar } from './components/Titlebar';
import { Toasts } from './components/Toasts';
import { Welcome } from './components/Welcome';
import { Button, SPRING, TooltipLayer } from './components/ui/controls';
import { handleShortcut, requestQuit, runCommand } from './lib/commands';
import { appWindow, onFileChanged, onFilesDropped, onOpenFiles } from './lib/platform';
import { activeTheme, applySettings, isDarkTheme, useSettings, type ViewMode } from './lib/settings';
import { activeDoc, displayName, flushAll, isDirty, useApp, viewMode, type Doc } from './lib/store';
import { attachSounds, play } from './lib/sound';
import { toast } from './lib/toast';
import { useUi } from './lib/ui';
import { useView } from './lib/viewSync';

// The editors are heavy and Reading mode is the default: load them only when first used.
const Source = lazy(() => import('./components/Source').then((m) => ({ default: m.Source })));
type RichEditor = typeof import('./components/Editor').Editor;
let editorLoad: Promise<RichEditor> | undefined;

export function preloadEditor(): Promise<RichEditor> {
  return editorLoad ??= import('./components/Editor').then(({ Editor }) => Editor).catch((error) => {
    editorLoad = undefined;
    throw error;
  });
}

export default function App() {
  const doc = useApp(activeDoc);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const focusMode = useApp((s) => s.focusMode);
  const zoom = useApp((s) => s.zoom);
  const settings = useSettings((s) => s.settings);
  const systemDark = useSettings((s) => s.systemDark);
  const palette = useUi((s) => s.palette);
  const settingsOpen = useUi((s) => s.settings);
  const find = useUi((s) => s.find);
  const lightbox = useUi((s) => s.lightbox);
  const dropHover = useUi((s) => s.dropHover);
  const confirmClose = useUi((s) => s.confirmClose);

  // Settings → CSS variables.
  useEffect(() => {
    applySettings(settings, systemDark);
    document.documentElement.dataset.sidebar = settings.sidebarSide;
    void appWindow.setTheme(isDarkTheme(activeTheme(settings, systemDark)));
  }, [settings, systemDark]);

  useEffect(() => {
    document.documentElement.style.setProperty('--zoom', String(zoom));
  }, [zoom]);

  useEffect(() => (settings.sounds ? attachSounds() : undefined), [settings.sounds]);
  const overlayOpen = palette || !!settingsOpen;
  useEffect(() => {
    if (overlayOpen && useSettings.getState().settings.sounds) play('open');
  }, [overlayOpen]);

  useEffect(() => {
    void appWindow.setTitle(doc ? `${isDirty(doc) ? '• ' : ''}${displayName(doc)} - Margin` : 'Margin');
  }, [doc && displayName(doc), doc && isDirty(doc)]); // eslint-disable-line react-hooks/exhaustive-deps

  // Global keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (handleShortcut(e)) return;
      // Keys that mean something to a web browser but nothing here (reload, caret browsing, history…).
      const browserOnly =
        e.key === 'F5' || e.key === 'F7' || e.key === 'F3' || e.key === 'F12' ||
        ((e.ctrlKey || e.metaKey) && !e.altKey && ['r', 'g', 'j', 'u', 'd', 'l'].includes(e.key.toLowerCase())) ||
        (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight'));
      if (browserOnly && !import.meta.env.DEV) {
        e.preventDefault();
        return;
      }
      if (e.key === 'Escape') {
        const ui = useUi.getState();
        if (ui.lightbox) ui.setLightbox(null);
        else if (ui.palette) ui.close('palette');
        else if (ui.confirmClose) ui.setConfirmClose(null);
        else if (ui.settings) ui.close('settings');
        else if (ui.find) ui.close('find');
        else if (useApp.getState().focusMode) runCommand('view.focus');
        else return;
        e.preventDefault();
      }
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const app = useApp.getState();
      app.setZoom(app.zoom + (e.deltaY < 0 ? 0.05 : -0.05));
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('wheel', onWheel);
    };
  }, []);

  // Outside world: files opened from Explorer, dropped, or changed on disk.
  useEffect(() => {
    const offs: (() => void)[] = [];
    let alive = true;
    const keep = (p: Promise<() => void>) => void p.then((off) => (alive ? offs.push(off) : off()));
    // An empty list is a second launch with nothing to open (Win+R `note`): give a blank note.
    keep(onOpenFiles((paths) => (paths.length ? void useApp.getState().openPaths(paths) : useApp.getState().newDocIfNeeded())));
    keep(onFileChanged((c) => void useApp.getState().handleExternalChange(c.path, c.kind)));
    keep(
      onFilesDropped(
        (paths) => void useApp.getState().openPaths(paths),
        (over) => useUi.getState().setDropHover(over),
      ),
    );
    keep(
      appWindow.onCloseRequested((prevent) => {
        prevent();
        void requestQuit();
      }),
    );
    // Hot exit: unsaved text is on disk within a second anyway; these make it immediate.
    const flush = () => void flushAll().catch((err) => console.warn('Could not flush the session', err));
    const onVisibility = () => document.visibilityState === 'hidden' && flush();
    window.addEventListener('blur', flush);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      alive = false;
      offs.forEach((off) => off());
      window.removeEventListener('blur', flush);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // Auto-save.
  const content = doc?.content;
  const encoding = doc?.encoding;
  const bom = doc?.bom;
  const autoSaveId = doc?.path && !doc.readonly && !doc.conflict && isDirty(doc) ? doc.id : null;
  useEffect(() => {
    if (settings.autoSave !== 'delay' || !autoSaveId) return;
    const t = setTimeout(() => {
      const app = useApp.getState();
      const current = app.docs.find((d) => d.id === autoSaveId);
      if (current && !current.conflict && !current.readonly) void app.save(autoSaveId);
    }, settings.autoSaveDelay * 1000);
    return () => clearTimeout(t);
  }, [content, encoding, bom, settings.autoSave, settings.autoSaveDelay, autoSaveId]);

  useEffect(() => {
    if (settings.autoSave !== 'blur') return;
    const onBlur = () => void useApp.getState().saveAll();
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [settings.autoSave]);

  // The selection word count shown in the status bar (reading and editing modes).
  useEffect(() => {
    const onSel = () => {
      const sel = document.getSelection();
      const inDoc = sel?.anchorNode && document.querySelector('.doc-view')?.contains(sel.anchorNode);
      const text = inDoc && sel && !sel.isCollapsed ? sel.toString() : '';
      const words = text ? text.trim().split(/\s+/).filter(Boolean).length : 0;
      if (useView.getState().selectionWords !== words && !document.querySelector('.doc-view .cm-editor.cm-focused')) {
        useView.getState().set({ selectionWords: words });
      }
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, []);

  const chromeHidden = focusMode;

  return (
    <MotionConfig reducedMotion={settings.motion === 'reduced' ? 'always' : 'user'}>
      <div className="app" data-focus={focusMode || undefined}>
        <AnimatePresence initial={false}>
          {!chromeHidden && (
            <motion.div key="titlebar" className="titlebar-shell" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={SPRING}>
              <Titlebar />
            </motion.div>
          )}
        </AnimatePresence>

        <div className="workspace">
          <AnimatePresence initial={false}>{sidebarOpen && !chromeHidden && <Sidebar key="sidebar" />}</AnimatePresence>

          <main className="doc-view tile">
            {settings.showProgress && doc && viewMode(doc) !== 'source' && <ProgressLine />}
            <AnimatePresence>{find && doc && <FindBar key={`find-${doc.id}-${viewMode(doc)}`} doc={doc} />}</AnimatePresence>
            {doc ? <DocumentStage key={`${doc.id}-${doc.kind}`} doc={doc} /> : <div className="doc-stage"><Welcome /></div>}
          </main>
        </div>

        <AnimatePresence initial={false}>
          {settings.showStatusBar && !chromeHidden && (
            <motion.div key="status" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={SPRING} style={{ overflow: 'hidden', flex: 'none' }}>
              <StatusBar doc={doc} />
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {palette && <Palette key="palette" />}
          {settingsOpen && <SettingsPanel key="settings" />}
          {lightbox && <Lightbox key="lightbox" />}
          {confirmClose && <ConfirmClose key="confirm" />}
          {dropHover && <DropOverlay key="drop" />}
        </AnimatePresence>
        <ContextMenu />
        <Toasts />
        <TooltipLayer />
      </div>
    </MotionConfig>
  );
}

function DocumentStage({ doc }: { doc: Doc }) {
  const mode = viewMode(doc);
  const [lastMode, setLastMode] = useState<ViewMode | null>(mode === 'edit' ? null : mode);
  const [prepared, setPrepared] = useState<{ revision: number; Editor: RichEditor }>();
  const [ready, setReady] = useState<number>();
  const Editor = prepared?.revision === doc.rev ? prepared.Editor : undefined;
  const editing = mode === 'edit';
  const editorReady = ready === doc.rev;
  const waiting = editing && !editorReady;
  const visible = waiting ? (lastMode === 'edit' ? null : lastMode) : mode;

  useLayoutEffect(() => {
    if (!waiting) setLastMode(mode);
  }, [mode, waiting]);

  const fallback = lastMode === 'read' ? 'read' : 'source';
  const onEditorError = useCallback(() => {
    const app = useApp.getState();
    if (app.docs.some((d) => d.id === doc.id && d.mode === 'edit' && d.rev === doc.rev)) {
      app.setMode(doc.id, fallback);
    }
  }, [doc.id, doc.rev, fallback]);

  // Paint the outgoing view and the busy indicator before Milkdown starts parsing.
  useEffect(() => {
    if (!waiting || Editor) return;
    let alive = true;
    let timer: number | undefined;
    const frame = requestAnimationFrame(() => {
      timer = window.setTimeout(() => {
        void preloadEditor().then((Editor) => {
          if (alive) setPrepared({ revision: doc.rev, Editor });
        }).catch(() => {
          if (!alive) return;
          toast.error("Couldn't load Edit");
          onEditorError();
        });
      }, 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      alive = false;
    };
  }, [doc.rev, Editor, onEditorError, waiting]);

  return (
    <>
      {visible === 'read' && <div className="doc-stage" data-visible inert={waiting}><Reader doc={doc} /></div>}
      {visible === 'source' && (
        <div className="doc-stage" data-visible inert={waiting}>
          <Suspense fallback={<div className="editor-loading" role="status">Opening Source…</div>}>
            <Source doc={doc} />
          </Suspense>
        </div>
      )}
      {Editor && (editing || editorReady) && (
        <div className="doc-stage" hidden={!editing} data-preparing={waiting || undefined}
          data-visible={visible === 'edit' || undefined} inert={visible !== 'edit'}>
          <Editor key={doc.rev} doc={doc} active={visible === 'edit'} onPreparing={() => setReady(undefined)}
            onReady={() => setReady(doc.rev)} onError={onEditorError} />
        </div>
      )}
      {waiting && <div className="editor-loading" role="status">Opening Edit…</div>}
    </>
  );
}

function ProgressLine() {
  const progress = useView((s) => s.progress);
  return (
    <div className="progress" aria-hidden>
      <div className="progress-fill" style={{ transform: `scaleX(${progress})` }} />
    </div>
  );
}

function Lightbox() {
  const lightbox = useUi((s) => s.lightbox);
  const close = () => useUi.getState().setLightbox(null);
  if (!lightbox) return null;
  return (
    <motion.div className="overlay lightbox" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.14 } }} onClick={close}>
      <motion.img
        src={lightbox.src}
        alt={lightbox.alt}
        onError={() => {
          if (useUi.getState().lightbox !== lightbox) return;
          close();
          toast.error("Couldn't load the image", lightbox.alt || undefined);
        }}
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0, transition: { duration: 0.14 } }}
        transition={SPRING}
      />
      {lightbox.alt && <p className="lightbox-caption">{lightbox.alt}</p>}
    </motion.div>
  );
}

function DropOverlay() {
  return (
    <motion.div className="overlay drop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.12 } }}>
      <motion.div className="drop-card" initial={{ scale: 0.94 }} animate={{ scale: 1 }} exit={{ scale: 0.97 }} transition={SPRING}>
        <span className="drop-icon">
          <Upload size={22} />
        </span>
        <p>Drop to open</p>
      </motion.div>
    </motion.div>
  );
}

function ConfirmClose() {
  const req = useUi((s) => s.confirmClose);
  const docs = useApp((s) => s.docs);
  const saveRef = useRef<HTMLButtonElement>(null);
  useEffect(() => saveRef.current?.focus(), []);
  if (!req) return null;
  const targets = docs.filter((d) => req.ids.includes(d.id));
  const done = () => useUi.getState().setConfirmClose(null);

  const finish = async (save: boolean) => {
    const app = useApp.getState();
    for (const d of targets) {
      if (save && isDirty(d) && !(await app.save(d.id))) return done(); // save cancelled or failed: keep everything open
    }
    done();
    targets.forEach((d) => app.closeDoc(d.id));
  };

  const one = targets.length === 1;
  return (
    <motion.div className="overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.12 } }} onMouseDown={(e) => e.target === e.currentTarget && done()}>
      <motion.div
        className="dialog popover"
        role="alertdialog"
        aria-label="Unsaved changes"
        initial={{ opacity: 0, y: 14, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.12 } }}
        transition={SPRING}
      >
        <h2>{one ? `Save ${displayName(targets[0])}?` : `Save changes to ${targets.length} notes?`}</h2>
        <p>
          {one ? (targets[0].path ? 'This tab has edits that are not in the file yet.' : 'This note is not in a file yet.') : targets.map(displayName).join(', ')}{' '}
          <span className="dialog-hint">If you close without saving, Ctrl+Shift+T brings it back.</span>
        </p>
        <div className="dialog-actions">
          <Button variant="ghost" onClick={done}>
            Cancel
          </Button>
          <Button variant="soft" onClick={() => void finish(false)}>
            Don't save
          </Button>
          <Button variant="solid" ref={saveRef} onClick={() => void finish(true)}>
            Save
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}
