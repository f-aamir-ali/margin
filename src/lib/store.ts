import { create } from 'zustand';
import {
  baseName,
  detectEol,
  dirName,
  draftDelete,
  draftList,
  draftWrite,
  fileMeta,
  isMarkdownPath,
  isTauri,
  pickSavePath,
  readFile,
  storeGet,
  storeSet,
  unwatchFile,
  watchFile,
  writeFile,
  downloadText,
  type Draft,
  type Eol,
  type FileData,
} from './platform';
import { useSettings, type ViewMode } from './settings';
import { toast } from './toast';

/** Markdown gets Read / Edit / Source. Everything else opens as plain text, shown and saved literally. */
export type DocKind = 'markdown' | 'text';
export type { Eol } from './platform';

export interface Doc {
  /** Stable for the life of the tab, across restarts: it names the tab's draft file. */
  id: string;
  path: string | null;
  name: string;
  /** Current text. Identical to `saved` until the user really edits. */
  content: string;
  saved: string;
  mtimeMs: number;
  mode: ViewMode;
  kind: DocKind;
  /** Encoding and byte order mark to write back with (kept from the file as opened). */
  encoding: string;
  bom: boolean;
  diskEncoding: string;
  diskBom: boolean;
  eol: Eol;
  /** Bumped whenever content changes from outside the WYSIWYG editor, so it remounts with fresh text. */
  rev: number;
  /** Scroll position as a fraction of the document, shared across modes. */
  scroll: number;
  readonly: boolean;
  binary: boolean;
  /** The file changed on disk while we hold unsaved edits. */
  conflict: boolean;
  missing: boolean;
}

export interface RecentFile {
  path: string;
  name: string;
  openedAt: number;
}

interface SessionTab {
  id: string;
  path: string | null;
  name: string;
  mode: ViewMode;
  kind: DocKind;
  scroll: number;
  encoding: string;
  eol?: Eol;
  binary?: boolean;
}

interface Session {
  version: 2;
  tabs: SessionTab[];
  activeId: string | null;
  sidebarOpen: boolean;
  sidebarTab: SidebarTab;
  sidebarWidth: number;
  folder: string | null;
  lastMode: ViewMode;
  /** Version 1 (MD Viewer) kept only file-backed tabs. */
  open?: { path: string; mode: ViewMode; scroll: number }[];
  active?: string | null;
}

/** A closed tab, kept so Ctrl+Shift+T can bring it back (and a mis-clicked "Don't save" is never final). */
interface ClosedTab {
  path: string | null;
  name: string;
  kind: DocKind;
  mode: ViewMode;
  encoding: string;
  bom: boolean;
  diskEncoding?: string;
  eol?: Eol;
  savedHash?: string;
  /** Present when the tab held text that wasn't in a file. */
  content?: string;
  closedAt: number;
}

export type SidebarTab = 'outline' | 'files' | 'recent';

interface AppStore {
  docs: Doc[];
  activeId: string | null;
  recents: RecentFile[];
  closed: ClosedTab[];
  sidebarOpen: boolean;
  sidebarTab: SidebarTab;
  sidebarWidth: number;
  folder: string | null;
  focusMode: boolean;
  zoom: number;
  lastMode: ViewMode;
  ready: boolean;

  init: () => Promise<void>;
  openPaths: (paths: string[], opts?: { activate?: boolean; force?: boolean }) => Promise<void>;
  newDoc: (kind?: DocKind) => void;
  /** A second launch with nothing to open (Win+R `note`): show a blank note, reusing an empty one. */
  newDocIfNeeded: () => void;
  /** Open text that has no file behind it yet (the tour). Saving asks where to put it. */
  openScratch: (name: string, content: string, mode: ViewMode) => void;
  closeDoc: (id: string) => void;
  reopenClosed: () => Promise<void>;
  activate: (id: string) => void;
  activateIndex: (index: number) => void;
  cycle: (dir: 1 | -1) => void;
  moveDoc: (from: number, to: number) => void;
  setContent: (id: string, content: string, fromEditor?: boolean) => void;
  setMode: (id: string, mode: ViewMode) => void;
  setKind: (id: string, kind: DocKind) => void;
  setEol: (id: string, eol: Eol) => void;
  setEncoding: (id: string, encoding: string, bom: boolean) => void;
  reopenWithEncoding: (id: string, encoding: string) => Promise<void>;
  setScroll: (id: string, scroll: number) => void;
  save: (id?: string) => Promise<boolean>;
  saveAs: (id?: string) => Promise<boolean>;
  saveAll: () => Promise<void>;
  reload: (id: string, silent?: boolean) => Promise<void>;
  handleExternalChange: (path: string, kind: string) => Promise<void>;
  removeRecent: (path: string) => void;
  clearRecents: () => void;
  setSidebar: (patch: Partial<Pick<AppStore, 'sidebarOpen' | 'sidebarTab' | 'sidebarWidth' | 'folder'>>) => void;
  setFocusMode: (on: boolean) => void;
  setZoom: (zoom: number) => void;
}

const newId = () => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

const samePath = (a: string, b: string) => a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase();

/** Above this size a file opens as plain text: the markdown views would be slow. */
const BIG_FILE = 5 * 1024 * 1024;

function initialMode(lastMode: ViewMode): ViewMode {
  const pref = useSettings.getState().settings.defaultMode;
  return pref === 'last' ? lastMode : pref;
}

/* ---------- kinds: markdown or plain text, remembered per file ---------- */

let kindOverrides: Record<string, DocKind> = {};

function kindFor(path: string, size = 0): DocKind {
  if (size > BIG_FILE) return 'text';
  return kindOverrides[path.toLowerCase()] ?? (isMarkdownPath(path) ? 'markdown' : 'text');
}

function rememberKind(path: string, kind: DocKind) {
  const key = path.toLowerCase();
  const natural: DocKind = isMarkdownPath(path) ? 'markdown' : 'text';
  if (kind === natural) delete kindOverrides[key];
  else kindOverrides[key] = kind;
  const entries = Object.entries(kindOverrides);
  if (entries.length > 500) kindOverrides = Object.fromEntries(entries.slice(-500));
  void storeSet('file-kinds', kindOverrides);
}

/** What a tab shows: plain text always uses the source view (in plain styling). */
export const viewMode = (d: Doc): ViewMode => (d.kind === 'text' ? 'source' : d.mode);

/* ---------- titles ---------- */

/** Untitled notes are named after their first line, like Notepad. */
export function noteTitle(content: string): string | null {
  for (const raw of content.slice(0, 4000).split(/\r\n|\r|\n/)) {
    const line = raw
      .replace(/^\s*(#{1,6}\s+|[-*+>]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
      .replace(/[*_`~]|<[^>]+>/g, '')
      .trim();
    if (line) return line.length > 40 ? `${line.slice(0, 39).trimEnd()}…` : line;
  }
  return null;
}

export const displayName = (d: Doc): string => (d.path ? d.name : noteTitle(d.content) ?? d.name);

function fileNameFor(d: Doc): string {
  const base = (noteTitle(d.content) ?? 'Untitled').replace(/…$/, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim().slice(0, 60);
  return `${base || 'Untitled'}.${d.kind === 'text' ? 'txt' : 'md'}`;
}

/* ---------- hashing (a draft remembers which disk text its edits were based on) ---------- */

export function hashText(text: string): string {
  // cyrb53: fast, well-distributed, good enough to tell two versions of a file apart.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${text.length}:${(h2 >>> 0).toString(36)}${(h1 >>> 0).toString(36)}`;
}

function normaliseForSave({ content, kind, eol }: Doc): string {
  const s = useSettings.getState().settings;
  let out = content;
  if (s.trimTrailingWhitespace) {
    // Two trailing spaces are a markdown hard break: keep exactly those.
    out = out.replace(/[ \t]+$/gm, (m) => (kind === 'markdown' && m === '  ' ? m : ''));
  }
  if (s.finalNewline && kind === 'markdown' && out.length > 0 && !/[\r\n]$/.test(out)) out += eol;
  return out;
}

/* ---------- session (tab order) ---------- */

let sessionTimer: ReturnType<typeof setTimeout> | undefined;
let sessionWrite = Promise.resolve();
function sessionSnapshot(): Session {
  const s = useApp.getState();
  return {
    version: 2,
    tabs: s.docs.map((d) => ({
      id: d.id,
      path: d.path,
      name: d.name,
      mode: d.mode,
      kind: d.kind,
      scroll: d.scroll,
      encoding: d.diskEncoding,
      eol: d.eol,
      binary: d.binary || undefined,
    })),
    activeId: s.activeId,
    sidebarOpen: s.sidebarOpen,
    sidebarTab: s.sidebarTab,
    sidebarWidth: s.sidebarWidth,
    folder: s.folder,
    lastMode: s.lastMode,
  };
}
function persistSession(now = false) {
  clearTimeout(sessionTimer);
  const write = () => {
    const session = sessionSnapshot();
    const task = sessionWrite.then(() => storeSet('session', session, true));
    sessionWrite = task.catch((err) => console.warn('Could not save the session', err));
    return task;
  };
  if (now) return write();
  sessionTimer = setTimeout(() => void write(), 300);
  return Promise.resolve();
}

/* ---------- drafts: every tab's unsaved text is on disk within a second ---------- */

interface Seen {
  content: string;
  saved: string;
  path: string | null;
  name: string;
  mode: ViewMode;
  kind: DocKind;
  encoding: string;
  bom: boolean;
  diskEncoding: string;
  diskBom: boolean;
  eol: Eol;
  missing: boolean;
}
const seen = new Map<string, Seen>();
const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; since: number }>();
const onDisk = new Set<string>();
const chains = new Map<string, Promise<void>>();
const failedDrafts = new Map<string, unknown>();
const DRAFT_DEBOUNCE = 700;
const DRAFT_MAX_WAIT = 2000;

/** Untitled notes always keep a draft; file tabs only while they hold unsaved edits. */
const needsDraft = (d: Doc) => !d.path || isDirty(d);

function toDraft(d: Doc): Draft {
  return {
    id: d.id,
    path: d.path,
    name: d.name,
    content: d.content,
    ...(d.path ? { savedHash: hashText(d.saved) } : { saved: d.saved }),
    mode: d.mode,
    kind: d.kind,
    encoding: d.encoding,
    bom: d.bom,
    diskEncoding: d.diskEncoding,
    eol: d.eol,
    updatedAt: Date.now(),
  };
}

/** Runs draft disk operations for one id strictly in order. */
function chain(id: string, op: () => Promise<void>): Promise<void> {
  const next = (chains.get(id) ?? Promise.resolve()).then(async () => {
    try {
      await op();
      failedDrafts.delete(id);
    } catch (err) {
      failedDrafts.set(id, err);
      console.warn('Could not save a draft', err);
    }
  });
  chains.set(id, next);
  void next.then(() => {
    if (chains.get(id) === next) chains.delete(id);
  });
  return next;
}

function writeDraftNow(id: string): Promise<void> {
  const p = pending.get(id);
  if (p) clearTimeout(p.timer);
  pending.delete(id);
  return chain(id, async () => {
    const d = useApp.getState().docs.find((x) => x.id === id);
    if (!d) return;
    if (needsDraft(d)) {
      await draftWrite(toDraft(d));
      onDisk.add(id);
    } else if (onDisk.has(id)) {
      await draftDelete(id);
      onDisk.delete(id);
    }
  });
}

function scheduleDraft(id: string) {
  const now = Date.now();
  const p = pending.get(id);
  if (p) clearTimeout(p.timer);
  const since = p?.since ?? now;
  // Debounced, but never held back longer than DRAFT_MAX_WAIT during continuous typing.
  const wait = Math.max(0, Math.min(DRAFT_DEBOUNCE, since + DRAFT_MAX_WAIT - now));
  pending.set(id, { timer: setTimeout(() => void writeDraftNow(id), wait), since });
}

function snapshotOf(d: Doc): Seen {
  const { content, saved, path, name, mode, kind, encoding, bom, diskEncoding, diskBom, eol, missing } = d;
  return { content, saved, path, name, mode, kind, encoding, bom, diskEncoding, diskBom, eol, missing };
}

function syncDrafts(docs: Doc[]) {
  for (const d of docs) {
    const prev = seen.get(d.id);
    const next = snapshotOf(d);
    if (prev && (Object.keys(next) as (keyof Seen)[]).every((k) => prev[k] === next[k])) continue;
    seen.set(d.id, next);
    scheduleDraft(d.id);
  }
}

function dropDraft(id: string) {
  const p = pending.get(id);
  if (p) clearTimeout(p.timer);
  pending.delete(id);
  seen.delete(id);
  void chain(id, async () => {
    await draftDelete(id);
    onDisk.delete(id);
  });
}

/**
 * Editors that may hold text the store hasn't seen yet: the WYSIWYG editor reports changes after a
 * short pause, so anything that reads `doc.content` (save, close, quit) asks them to report now.
 */
export const liveEditors = new Set<() => void>();
export function flushEditors() {
  for (const flush of liveEditors) {
    try {
      flush();
    } catch (err) {
      console.error('editor flush', err);
    }
  }
}

/** Write every pending draft and the session now (window closing, losing focus, shutting down). */
export async function flushAll(): Promise<void> {
  flushEditors();
  const docs = useApp.getState().docs;
  syncDrafts(docs);
  const retry = docs.filter((d) => failedDrafts.has(d.id)).map((d) => d.id);
  await Promise.all([...new Set([...pending.keys(), ...retry])].map(writeDraftNow));
  await Promise.all([...chains.values()]);
  const failed = useApp.getState().docs.find((d) => failedDrafts.has(d.id));
  if (failed) throw failedDrafts.get(failed.id);
  // A close may have started while a draft was being written.
  if (pending.size) return flushAll();
  await persistSession(true);
}

/* ---------- recents and closed tabs ---------- */

function pushRecent(recents: RecentFile[], path: string): RecentFile[] {
  const next = [{ path, name: baseName(path), openedAt: Date.now() }, ...recents.filter((r) => !samePath(r.path, path))].slice(0, 30);
  void storeSet('recents', next);
  return next;
}

const CLOSED_KEEP = 20;
const CLOSED_DAYS = 30;

function persistClosed(closed: ClosedTab[]) {
  void storeSet('closed', closed);
}

/* ---------- reading files ---------- */

/** Reads a file, turning "looks binary" into an offer to open it anyway. */
async function readForOpen(path: string, force = false, encoding?: string): Promise<FileData | null> {
  try {
    return await readFile(path, { force, encoding });
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err);
    if (msg.startsWith('BINARY:')) {
      toast.action({
        kind: 'warn',
        title: `${baseName(path)} looks like a binary file`,
        body: 'It may show as garbage. It opens read-only, so it can never be damaged.',
        actionLabel: 'Open anyway',
        onAction: () => void useApp.getState().openPaths([path], { force: true }),
      });
      return null;
    }
    throw err;
  }
}

function docFromFile(f: FileData, mode: ViewMode, scroll: number, id = newId(), kind?: DocKind): Doc {
  return {
    ...makeDoc(f.path, f.name, f.content, f.mtimeMs, mode, f.readonly, scroll, kind ?? kindFor(f.path, f.size), id),
    encoding: f.encoding,
    bom: f.bom,
    diskEncoding: f.encoding,
    diskBom: f.bom,
    binary: f.binary,
  };
}

function refreshedFile(d: Doc, f: FileData): Doc {
  return {
    ...d, content: f.content, saved: f.content, mtimeMs: f.mtimeMs,
    encoding: f.encoding, bom: f.bom, diskEncoding: f.encoding, diskBom: f.bom,
    eol: detectEol(f.content, d.eol), readonly: f.readonly, binary: f.binary,
    rev: d.rev + 1, conflict: false, missing: false,
  };
}

function sameEdit(before: Doc, current: Doc): boolean {
  return before.path === current.path && before.rev === current.rev && before.content === current.content &&
    before.saved === current.saved && before.encoding === current.encoding && before.bom === current.bom;
}

const saving = new Set<string>();

function savedFile(current: Doc, snapshot: Doc, text: string, mtimeMs: number, { encoding, bom }: { encoding: string; bom: boolean }): Doc {
  return {
    ...current, saved: text, mtimeMs, conflict: false, missing: false,
    content: current.content === snapshot.content && current.eol === snapshot.eol ? text : current.content,
    encoding: current.encoding === snapshot.encoding ? encoding : current.encoding,
    bom: current.bom === snapshot.bom ? bom : current.bom,
    diskEncoding: encoding, diskBom: bom,
  };
}

async function restoreTab(tab: SessionTab, draft: Draft | undefined, conflicts: string[]): Promise<Doc | null> {
  if (tab.path) {
    try {
      const f = await readFile(tab.path, { encoding: draft?.diskEncoding ?? tab.encoding, force: tab.binary });
      const doc = docFromFile(f, tab.mode, tab.scroll, tab.id, tab.kind);
      void watchFile(f.path);
      if (draft) {
        doc.content = draft.content;
        doc.encoding = draft.encoding;
        doc.bom = draft.bom;
        if (draft.savedHash && draft.savedHash !== hashText(f.content) && draft.content !== f.content) {
          doc.conflict = true;
          conflicts.push(doc.id);
        }
      }
      doc.eol = detectEol(doc.content, draft?.eol ?? tab.eol);
      return doc;
    } catch {
      if (!draft) return null; // the file is gone and nothing unsaved: drop it quietly
      const doc = makeDoc(tab.path, tab.name, draft.content, 0, tab.mode, false, tab.scroll, tab.kind, tab.id);
      return { ...doc, saved: '', missing: true, encoding: draft.encoding, bom: draft.bom, eol: detectEol(doc.content, draft.eol ?? tab.eol) };
    }
  }
  const doc = makeDoc(null, draft?.name ?? tab.name, draft?.content ?? '', 0, tab.mode, false, tab.scroll, tab.kind, tab.id);
  return { ...doc, saved: draft?.saved ?? '', encoding: draft?.encoding ?? 'UTF-8', bom: draft?.bom ?? false, eol: detectEol(doc.content, draft?.eol ?? tab.eol) };
}

export const useApp = create<AppStore>((set, get) => ({
  docs: [],
  activeId: null,
  recents: [],
  closed: [],
  sidebarOpen: true,
  sidebarTab: 'outline',
  sidebarWidth: 248,
  folder: null,
  focusMode: false,
  zoom: 1,
  lastMode: 'read',
  ready: false,

  async init() {
    const [recents, session, zoom, kinds, closed, list] = await Promise.all([
      storeGet<RecentFile[]>('recents'),
      storeGet<Session>('session'),
      storeGet<number>('zoom'),
      storeGet<Record<string, DocKind>>('file-kinds'),
      storeGet<ClosedTab[]>('closed'),
      draftList().catch(() => ({ drafts: [] as Draft[], quarantined: [] as string[] })),
    ]);
    kindOverrides = kinds && typeof kinds === 'object' ? kinds : {};
    const cutoff = Date.now() - CLOSED_DAYS * 864e5;
    set({
      recents: Array.isArray(recents) ? recents : [],
      closed: Array.isArray(closed) ? closed.filter((c) => c.closedAt > cutoff).slice(-CLOSED_KEEP) : [],
      zoom: typeof zoom === 'number' ? zoom : 1,
      ...(session
        ? {
            sidebarOpen: session.sidebarOpen ?? true,
            sidebarTab: session.sidebarTab ?? 'outline',
            sidebarWidth: session.sidebarWidth ?? 248,
            folder: session.folder ?? null,
            lastMode: session.lastMode ?? 'read',
          }
        : {}),
    });

    const drafts = new Map(list.drafts.filter((d) => d && typeof d.id === 'string').map((d) => [d.id, d]));
    list.drafts.forEach((d) => onDisk.add(d.id));
    const restore = useSettings.getState().settings.restoreSession;
    const tabs: SessionTab[] =
      session?.version === 2 && Array.isArray(session.tabs)
        ? session.tabs
        : (session?.open ?? []).map((o) => ({
            id: newId(),
            path: o.path,
            name: baseName(o.path),
            mode: o.mode,
            kind: kindFor(o.path),
            scroll: o.scroll,
            encoding: 'UTF-8',
          }));
    const docs: Doc[] = [];
    const conflicts: string[] = [];
    for (const tab of tabs) {
      const draft = drafts.get(tab.id);
      drafts.delete(tab.id);
      // Unsaved text always comes back, even with "restore session" off.
      if (!restore && !draft) continue;
      const doc = await restoreTab(tab, draft, conflicts);
      if (doc) docs.push(doc);
    }
    // Drafts the session doesn't list (a crash between creating a tab and saving the session).
    for (const draft of [...drafts.values()].sort((a, b) => a.updatedAt - b.updatedAt)) {
      const tab: SessionTab = {
        id: draft.id,
        path: draft.path,
        name: draft.name,
        mode: (draft.mode as ViewMode) ?? 'edit',
        kind: (draft.kind as DocKind) ?? 'markdown',
        scroll: 0,
        encoding: draft.diskEncoding ?? draft.encoding ?? 'UTF-8',
      };
      const doc = await restoreTab(tab, draft, conflicts);
      if (doc) docs.push(doc);
    }
    const activeId =
      (session?.activeId && docs.find((d) => d.id === session.activeId)?.id) ??
      (session?.active && docs.find((d) => d.path && samePath(d.path, session.active as string))?.id) ??
      docs[docs.length - 1]?.id ??
      null;
    set({ docs, activeId, ready: true });

    // From here on, every change reaches disk on its own.
    docs.forEach((d) => {
      seen.set(d.id, snapshotOf(d));
      if (!needsDraft(d) && onDisk.has(d.id)) scheduleDraft(d.id);
    });
    useApp.subscribe((s, prev) => {
      if (s.docs !== prev.docs) syncDrafts(s.docs);
    });
    if (!session || session.version !== 2) void persistSession();

    for (const id of conflicts) {
      const d = get().docs.find((x) => x.id === id);
      if (!d) continue;
      toast.action({
        kind: 'warn',
        title: `${d.name} changed while Margin was closed`,
        body: 'Your unsaved version is showing. Save to keep it, or take the version on disk.',
        actionLabel: "Take the file's",
        onAction: () => void get().reload(id),
        sticky: true,
      });
    }
    if (list.quarantined.length) {
      toast.warn(
        `${list.quarantined.length} unsaved note${list.quarantined.length > 1 ? 's were' : ' was'} damaged`,
        `Kept as .bad files in the drafts folder: ${list.quarantined.join(', ')}`,
      );
    }
  },

  async openPaths(paths, opts) {
    let lastId: string | null = null;
    for (const path of paths) {
      const existing = get().docs.find((d) => d.path && samePath(d.path, path));
      if (existing) {
        lastId = existing.id;
        continue;
      }
      try {
        const f = await readForOpen(path, opts?.force);
        if (!f) continue;
        flushEditors();
        const alreadyOpen = get().docs.find((d) => d.path && samePath(d.path, f.path));
        if (alreadyOpen) {
          lastId = alreadyOpen.id;
          continue;
        }
        const kind = kindFor(f.path, f.size);
        const doc = docFromFile(f, kind === 'markdown' ? initialMode(get().lastMode) : 'source', 0, newId(), kind);
        if (f.size > BIG_FILE) toast.info(`${f.name} is large`, 'Opened as plain text so it stays fast.');
        // Replace a pristine untitled tab rather than leaving it behind.
        const blank = get().docs.find((d) => !d.path && d.content === '' && d.saved === '');
        if (blank) dropDraft(blank.id);
        set((s) => ({
          docs: blank ? s.docs.map((d) => (d.id === blank.id ? doc : d)) : [...s.docs, doc],
          recents: pushRecent(s.recents, f.path),
          folder: s.folder ?? (isTauri ? dirName(f.path) : s.folder),
        }));
        void watchFile(f.path);
        lastId = doc.id;
      } catch (err) {
        toast.error(`Couldn't open ${baseName(path)}`, String(err instanceof Error ? err.message : err));
        set((s) => ({ recents: s.recents.filter((r) => !samePath(r.path, path)) }));
      }
    }
    if (lastId && opts?.activate !== false) set({ activeId: lastId });
    void persistSession();
  },

  newDoc(kind = useSettings.getState().settings.newNoteKind) {
    const doc = makeDoc(null, 'Untitled', '', 0, kind === 'markdown' ? 'edit' : 'source', false, 0, kind);
    set((s) => ({ docs: [...s.docs, doc], activeId: doc.id }));
    void persistSession();
  },

  newDocIfNeeded() {
    flushEditors();
    const active = get().docs.find((d) => d.id === get().activeId);
    if (active && !active.path && active.content === '') return;
    const blank = get().docs.find((d) => !d.path && d.content === '' && d.saved === '');
    if (blank) get().activate(blank.id);
    else get().newDoc();
  },

  openScratch(name, content, mode) {
    const existing = get().docs.find((d) => !d.path && d.name === name);
    if (existing) return set({ activeId: existing.id });
    const doc = makeDoc(null, name, content, 0, mode, false, 0, 'markdown');
    set((s) => ({ docs: [...s.docs, doc], activeId: doc.id }));
    void persistSession();
  },

  closeDoc(id) {
    flushEditors();
    const { docs, activeId } = get();
    const idx = docs.findIndex((d) => d.id === id);
    if (idx < 0) return;
    const doc = docs[idx];
    if (doc.path) void unwatchFile(doc.path);
    const next = docs.filter((d) => d.id !== id);
    const keepText = !doc.path || isDirty(doc);
    const worthKeeping = doc.path || doc.content.trim() !== '';
    const closed = worthKeeping
      ? [
          ...get().closed,
          {
            path: doc.path,
            name: displayName(doc),
            kind: doc.kind,
            mode: doc.mode,
            encoding: doc.encoding,
            bom: doc.bom,
            diskEncoding: doc.diskEncoding,
            eol: doc.eol,
            savedHash: keepText && doc.path ? hashText(doc.saved) : undefined,
            content: keepText ? doc.content : undefined,
            closedAt: Date.now(),
          },
        ].slice(-CLOSED_KEEP)
      : get().closed;
    set({
      docs: next,
      closed,
      activeId: activeId === id ? (next[idx] ?? next[idx - 1] ?? null)?.id ?? null : activeId,
    });
    if (worthKeeping) persistClosed(closed);
    dropDraft(id);
    void persistSession();
  },

  async reopenClosed() {
    const closed = [...get().closed];
    const last = closed.pop();
    if (!last) {
      toast.info('No closed tabs to reopen');
      return;
    }
    set({ closed });
    persistClosed(closed);
    if (last.content === undefined && last.path) return get().openPaths([last.path]);
    let doc = makeDoc(last.path, last.name, last.content ?? '', 0, last.mode, false, 0, last.kind);
    doc = { ...doc, encoding: last.encoding, bom: last.bom, eol: detectEol(doc.content, last.eol) };
    if (last.path) {
      const f = await readFile(last.path, { encoding: last.diskEncoding ?? last.encoding }).catch(() => null);
      if (f) {
        doc = {
          ...doc, name: f.name, saved: f.content, mtimeMs: f.mtimeMs, readonly: f.readonly,
          diskEncoding: f.encoding, diskBom: f.bom,
          conflict: !!last.savedHash && last.savedHash !== hashText(f.content) && doc.content !== f.content,
        };
        void watchFile(f.path);
      } else doc = { ...doc, saved: '', missing: true };
    } else doc = { ...doc, saved: '' };
    set((s) => ({ docs: [...s.docs, doc], activeId: doc.id }));
    void persistSession();
  },

  activate(id) {
    if (get().activeId !== id) {
      set({ activeId: id });
      void persistSession();
    }
  },

  activateIndex(index) {
    const { docs } = get();
    if (!docs.length) return;
    // Ctrl+9 is always the last tab, as in browsers.
    const target = index >= 8 ? docs[docs.length - 1] : docs[index];
    if (target) get().activate(target.id);
  },

  cycle(dir) {
    const { docs, activeId } = get();
    if (docs.length < 2) return;
    const i = docs.findIndex((d) => d.id === activeId);
    set({ activeId: docs[(i + dir + docs.length) % docs.length].id });
    void persistSession();
  },

  moveDoc(from, to) {
    set((s) => {
      const docs = [...s.docs];
      const [d] = docs.splice(from, 1);
      docs.splice(to, 0, d);
      return { docs };
    });
    void persistSession();
  },

  setContent(id, content, fromEditor) {
    set((s) => ({
      docs: s.docs.map((d) =>
        d.id === id && d.content !== content ? { ...d, content, rev: fromEditor ? d.rev : d.rev + 1 } : d,
      ),
    }));
  },

  setMode(id, mode) {
    flushEditors();
    set((s) => ({ docs: s.docs.map((d) => (d.id === id ? { ...d, mode } : d)), lastMode: mode }));
    void persistSession();
  },

  setKind(id, kind) {
    const doc = get().docs.find((d) => d.id === id);
    if (!doc || doc.kind === kind) return;
    if (doc.path) rememberKind(doc.path, kind);
    set((s) => ({
      docs: s.docs.map((d) => (d.id === id ? { ...d, kind, mode: kind === 'markdown' ? 'read' : 'source', rev: d.rev + 1 } : d)),
    }));
    void persistSession();
  },

  setEol(id, eol) {
    flushEditors();
    set((s) => ({
      docs: s.docs.map((d) =>
        d.id === id && !d.readonly && d.eol !== eol
          ? { ...d, eol, content: d.content.replace(/\r\n|\r|\n/g, eol), rev: d.rev + 1 }
          : d,
      ),
    }));
    void persistSession();
  },

  setEncoding(id, encoding, bom) {
    set((s) => ({
      docs: s.docs.map((d) => (d.id === id && !d.readonly && (d.encoding !== encoding || d.bom !== bom) ? { ...d, encoding, bom } : d)),
    }));
  },

  async reopenWithEncoding(id, encoding) {
    flushEditors();
    const doc = get().docs.find((d) => d.id === id);
    if (!doc?.path) return;
    if (isDirty(doc)) {
      toast.warn('Save or undo your edits first', 'Reopening reads the file again from disk.');
      return;
    }
    try {
      const f = await readFile(doc.path, { encoding, force: doc.binary });
      flushEditors();
      const current = get().docs.find((d) => d.id === id);
      if (!current) return;
      if (!sameEdit(doc, current)) {
        toast.warn('Reopen cancelled because the note changed', 'Save or undo your edits first.');
        return;
      }
      set((s) => ({
        docs: s.docs.map((d) => d.id === id ? refreshedFile(d, f) : d),
      }));
      void persistSession();
    } catch (err) {
      toast.error("Couldn't reopen", String(err instanceof Error ? err.message : err));
    }
  },

  setScroll(id, scroll) {
    const doc = get().docs.find((d) => d.id === id);
    if (!doc || Math.abs(doc.scroll - scroll) < 0.0005) return;
    // Mutate in place: scroll position must not re-render the tree on every frame.
    doc.scroll = scroll;
    void persistSession();
  },

  async save(id) {
    flushEditors();
    const doc = get().docs.find((d) => d.id === (id ?? get().activeId));
    if (!doc) return false;
    if (!doc.path || doc.readonly) return get().saveAs(doc.id);
    if (!isDirty(doc)) return true;
    if (saving.has(doc.id)) return false;
    saving.add(doc.id);
    try {
      const text = normaliseForSave(doc);
      const { mtimeMs } = await writeFile(doc.path, text, doc);
      flushEditors();
      set((s) => ({
        docs: s.docs.map((d) => d.id === doc.id ? savedFile(d, doc, text, mtimeMs, doc) : d),
      }));
      void persistSession();
      return true;
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      if (msg.startsWith('UNMAPPABLE:')) {
        toast.action({
          kind: 'warn',
          title: `${doc.name} has characters ${doc.encoding} can't hold`,
          body: msg.replace(/^UNMAPPABLE:\s*/, ''),
          actionLabel: 'Save as UTF-8',
          onAction: () => {
            get().setEncoding(doc.id, 'UTF-8', false);
            void get().save(doc.id);
          },
        });
      } else toast.error(`Couldn't save ${doc.name}`, msg);
      return false;
    } finally {
      saving.delete(doc.id);
    }
  },

  async saveAs(id) {
    flushEditors();
    const doc = get().docs.find((d) => d.id === (id ?? get().activeId));
    if (!doc || saving.has(doc.id)) return false;
    const suggested = doc.path && !doc.binary ? doc.name : fileNameFor(doc);
    saving.add(doc.id);
    try {
      const path = await pickSavePath(suggested, doc.kind === 'text' ? 'text' : 'markdown', doc.path ? dirName(doc.path) : get().folder ?? undefined);
      if (!path) return false;
      flushEditors();
      const snapshot = get().docs.find((d) => d.id === doc.id);
      if (!snapshot) return false;
      if (get().docs.some((d) => d.id !== doc.id && d.path && samePath(d.path, path))) {
        toast.warn('That file is already open', 'Choose a different name or save from its open tab.');
        return false;
      }
      const text = normaliseForSave(snapshot);
      const encoding = snapshot.binary ? 'UTF-8' : snapshot.encoding;
      const bom = snapshot.binary ? false : snapshot.bom;
      const { mtimeMs } = await writeFile(path, text, { encoding, bom });
      if (!isTauri) downloadText(baseName(path), text, snapshot.kind === 'text' ? 'text/plain' : 'text/markdown');
      flushEditors();
      if (get().docs.some((d) => d.id === doc.id)) {
        if (snapshot.path && !samePath(snapshot.path, path)) void unwatchFile(snapshot.path);
        void watchFile(path);
      }
      set((s) => ({
        docs: s.docs.map((d) =>
          d.id === doc.id
            ? {
                ...savedFile(d, snapshot, text, mtimeMs, { encoding, bom }),
                path,
                name: baseName(path),
                binary: false,
                readonly: false,
              }
            : d,
        ),
        recents: pushRecent(s.recents, path),
      }));
      void persistSession();
      toast.success('Saved', baseName(path));
      return true;
    } catch (err) {
      toast.error("Couldn't save", String(err instanceof Error ? err.message : err));
      return false;
    } finally {
      saving.delete(doc.id);
    }
  },

  async saveAll() {
    flushEditors();
    for (const d of get().docs) {
      if (d.path && !d.readonly && !d.conflict && isDirty(d)) await get().save(d.id);
    }
  },

  async reload(id, silent) {
    flushEditors();
    const doc = get().docs.find((d) => d.id === id);
    if (!doc?.path) return;
    try {
      const f = await readFile(doc.path, { encoding: doc.diskEncoding, force: doc.binary });
      flushEditors();
      const current = get().docs.find((d) => d.id === id);
      if (!current || !sameEdit(doc, current)) {
        if (current && !silent) toast.warn('Reload cancelled because the note changed');
        return;
      }
      set((s) => ({
        docs: s.docs.map((d) => d.id === id ? refreshedFile(d, f) : d),
      }));
      void persistSession();
      if (!silent) toast.info('Reloaded from disk', doc.name);
    } catch (err) {
      toast.error(`Couldn't reload ${doc.name}`, String(err instanceof Error ? err.message : err));
    }
  },

  async handleExternalChange(path, kind) {
    const doc = get().docs.find((d) => d.path && samePath(d.path, path));
    if (!doc) return;
    if (kind === 'removed') {
      const meta = await fileMeta(path).catch(() => null);
      if (meta?.exists) return get().handleExternalChange(path, 'modified');
      if (!doc.missing) {
        set((s) => ({ docs: s.docs.map((d) => (d.id === doc.id ? { ...d, missing: true } : d)) }));
        toast.warn(`${doc.name} was moved or deleted`, 'Your copy is still open. Save to write it back.');
      }
      return;
    }
    let disk: FileData;
    try {
      disk = await readFile(path, { encoding: doc.diskEncoding, force: doc.binary });
    } catch {
      return;
    }
    flushEditors();
    const current = get().docs.find((d) => d.id === doc.id);
    if (!current || current.path !== doc.path || current.diskEncoding !== doc.diskEncoding || saving.has(doc.id)) return;
    if (disk.content === current.saved && disk.bom === current.diskBom && !current.missing && disk.readonly === current.readonly) return;
    const dirty = isDirty(current);
    if (!dirty && useSettings.getState().settings.autoReload) {
      set((s) => ({ docs: s.docs.map((d) => d.id === doc.id ? refreshedFile(d, disk) : d) }));
      void persistSession();
      toast.info('Updated from disk', doc.name);
    } else if (!current.conflict) {
      set((s) => ({ docs: s.docs.map((d) => (d.id === doc.id ? { ...d, conflict: true } : d)) }));
      toast.action({
        kind: 'warn',
        title: `${doc.name} changed on disk`,
        body: dirty ? 'You have unsaved edits here.' : 'Reload to see the new version.',
        actionLabel: 'Reload',
        onAction: () => void get().reload(doc.id),
        sticky: true,
      });
    }
  },

  removeRecent(path) {
    set((s) => {
      const recents = s.recents.filter((r) => !samePath(r.path, path));
      void storeSet('recents', recents);
      return { recents };
    });
  },

  clearRecents() {
    set({ recents: [] });
    void storeSet('recents', []);
  },

  setSidebar(patch) {
    set(patch);
    void persistSession();
  },

  setFocusMode(on) {
    set({ focusMode: on });
  },

  setZoom(zoom) {
    const z = Math.min(2, Math.max(0.6, Math.round(zoom * 20) / 20));
    set({ zoom: z });
    void storeSet('zoom', z);
  },
}));

function makeDoc(
  path: string | null,
  name: string,
  content: string,
  mtimeMs: number,
  mode: ViewMode,
  readonly: boolean,
  scroll: number,
  kind: DocKind,
  id = newId(),
): Doc {
  return {
    id,
    path,
    name,
    content,
    saved: content,
    mtimeMs,
    mode,
    kind,
    encoding: 'UTF-8',
    bom: false,
    diskEncoding: 'UTF-8',
    diskBom: false,
    eol: detectEol(content),
    rev: 0,
    scroll,
    readonly,
    binary: false,
    conflict: false,
    missing: false,
  };
}

export const hasEncodingChange = (d: Doc) => d.encoding !== d.diskEncoding || d.bom !== d.diskBom;
export const isDirty = (d: Doc) => d.content !== d.saved || d.missing || hasEncodingChange(d);

/** Show the built-in tour as a scratch document. */
export async function openTour(): Promise<void> {
  try {
    const res = await fetch('/samples/welcome.md');
    if (!res.ok) throw new Error(String(res.status));
    useApp.getState().openScratch('Welcome to Margin', (await res.text()).replace(/\r\n/g, '\n'), 'read');
  } catch {
    toast.error("Couldn't load the tour");
  }
}

export const activeDoc = (s: AppStore) => s.docs.find((d) => d.id === s.activeId) ?? null;
