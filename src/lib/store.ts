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
  errorKind,
  errorMessage,
  joinPath,
  writeBinary,
  windowLabel,
  adoptedIds,
  claimRestore,
  claimPath,
  releasePath,
  focusPathIn,
  storeKeys,
  storeDelete,
  draftRead,
  type Draft,
  type Eol,
  type FileData,
} from './platform';
import { dashLinesAsSeparators, extractDataImages } from './editorText';
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
  /** Disk version (size and modification time) that `saved` came from; a save is refused if the file moved on. */
  version: string | null;
  /** The file exists but couldn't be read when the tab was restored (locked, no access, too large). */
  diskError: string | null;
  /** Decoding replaced malformed bytes: the first save asks before writing the changed bytes. */
  lossy: boolean;
  /** A temporary view (the disk version shown for comparison): never drafted, restored or kept as closed. */
  transient?: boolean;
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
  /** Set while unsaved text couldn't be written to the drafts folder (disk full, no access). */
  draftTrouble: string | null;

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
  /** `force` overwrites a file that changed on disk (the user chose "Keep mine"). */
  save: (id?: string, opts?: { force?: boolean }) => Promise<boolean>;
  saveAs: (id?: string) => Promise<boolean>;
  saveAll: () => Promise<void>;
  reload: (id: string, silent?: boolean) => Promise<void>;
  /** Settle a tab whose file changed on disk. Every choice keeps the other text recoverable. */
  resolveConflict: (id: string, how: 'compare' | 'overwrite' | 'disk' | 'copy') => Promise<void>;
  /** Try reading a file that couldn't be read at startup again. */
  retryDisk: (id: string) => Promise<void>;
  handleExternalChange: (path: string, kind: string) => Promise<void>;
  clearClosed: () => void;
  /** Hands a tab to another window: its whole state goes to its draft, then it leaves this window. */
  detachDoc: (id: string) => Promise<boolean>;
  /** Takes in a tab handed over by another window (or opened with a torn-off window). */
  adoptDoc: (id: string, index?: number) => Promise<boolean>;
  /** Shows the tab for a file (another window asked, because the file is open here). */
  activatePath: (path: string) => void;
  removeRecent: (path: string) => void;
  clearRecents: () => void;
  setSidebar: (patch: Partial<Pick<AppStore, 'sidebarOpen' | 'sidebarTab' | 'sidebarWidth' | 'folder'>>) => void;
  setFocusMode: (on: boolean) => void;
  setZoom: (zoom: number) => void;
}

const newId = () => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** Windows paths: case, separator style, doubled or trailing separators and `.` segments don't matter. */
export function pathKey(p: string): string {
  return p
    .replace(/\//g, '\\')
    .replace(/^\\\\\?\\(UNC\\)?/i, (_m, unc?: string) => (unc ? '\\\\' : ''))
    .replace(/(?!^)\\{2,}/g, '\\')
    .replace(/\\\.(?=\\|$)/g, '')
    .replace(/\\+$/, '')
    .toLowerCase();
}
export const samePath = (a: string, b: string) => pathKey(a) === pathKey(b);

/**
 * Each window keeps its own tab list and closed tabs. The first window of the next launch reads
 * every window's lists and brings all their tabs back together in one window.
 */
const SESSION_KEY = windowLabel === 'main' ? 'session' : `session-${windowLabel}`;
const CLOSED_KEY = windowLabel === 'main' ? 'closed' : `closed-${windowLabel}`;

/** Resolves once a torn-off window has taken in the tabs it was opened with. */
export let adoption: Promise<void> = Promise.resolve();

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
    tabs: s.docs.filter((d) => !d.transient).map((d) => ({
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
    activeId: s.docs.find((d) => d.id === s.activeId)?.transient ? s.docs.find((d) => !d.transient)?.id ?? null : s.activeId,
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
    const task = sessionWrite.then(() => storeSet(SESSION_KEY, session, true));
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
const needsDraft = (d: Doc) => !d.transient && (!d.path || isDirty(d));

/** The baseline only changes on open, save or reload, so its hash is worked out once per version. */
const savedHashes = new Map<string, { saved: string; hash: string }>();
function savedHash(d: Doc): string {
  const cached = savedHashes.get(d.id);
  if (cached?.saved === d.saved) return cached.hash;
  const hash = hashText(d.saved);
  savedHashes.set(d.id, { saved: d.saved, hash });
  return hash;
}

function toDraft(d: Doc): Draft {
  return {
    id: d.id,
    path: d.path,
    name: d.name,
    content: d.content,
    ...(d.path ? { savedHash: savedHash(d) } : { saved: d.saved }),
    mode: d.mode,
    kind: d.kind,
    encoding: d.encoding,
    bom: d.bom,
    diskEncoding: d.diskEncoding,
    eol: d.eol,
    scroll: d.scroll,
    updatedAt: Date.now(),
  };
}

/** Runs draft disk operations for one id strictly in order. */
function chain(id: string, op: () => Promise<void>): Promise<void> {
  const next = (chains.get(id) ?? Promise.resolve()).then(async () => {
    try {
      await op();
      if (failedDrafts.delete(id)) reportDraftTrouble();
    } catch (err) {
      failedDrafts.set(id, err);
      console.warn('Could not save a draft', err);
      reportDraftTrouble();
    }
  });
  chains.set(id, next);
  void next.then(() => {
    if (chains.get(id) === next) chains.delete(id);
  });
  return next;
}

/** From here on, every change to a tab reaches the drafts folder on its own. Safe to call twice. */
let draftSyncing = false;
export function startDraftSync() {
  if (draftSyncing) return;
  draftSyncing = true;
  useApp.subscribe((s, prev) => {
    if (s.docs !== prev.docs) syncDrafts(s.docs);
  });
}

/** The status bar warns while any open tab's unsaved text isn't safely on disk. */
function reportDraftTrouble() {
  const docs = useApp.getState().docs;
  const failed = docs.find((d) => failedDrafts.has(d.id));
  const trouble = failed ? errorMessage(failedDrafts.get(failed.id)) || 'The drafts folder could not be written.' : null;
  if (useApp.getState().draftTrouble !== trouble) useApp.setState({ draftTrouble: trouble });
  // Keep retrying in the background: the disk may have been full for a moment.
  if (failed && !retryTimer) {
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      for (const d of useApp.getState().docs) if (failedDrafts.has(d.id)) void writeDraftNow(d.id);
    }, 5000);
  }
}
let retryTimer: ReturnType<typeof setTimeout> | undefined;

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

/** Above this size a draft is a big write, so it is taken less often while typing (still within seconds). */
const BIG_DRAFT = 2 * 1024 * 1024;

function scheduleDraft(id: string) {
  const now = Date.now();
  const p = pending.get(id);
  if (p) clearTimeout(p.timer);
  const since = p?.since ?? now;
  const size = useApp.getState().docs.find((d) => d.id === id)?.content.length ?? 0;
  const debounce = size > BIG_DRAFT ? 2000 : DRAFT_DEBOUNCE;
  const maxWait = size > BIG_DRAFT ? 6000 : DRAFT_MAX_WAIT;
  // Debounced, but never held back longer than the max wait during continuous typing.
  const wait = Math.max(0, Math.min(debounce, since + maxWait - now));
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
    if (prev && (prev.content !== next.content || prev.encoding !== next.encoding || prev.bom !== next.bom)) scheduleAutosave(d.id);
  }
}

/* ---------- autosave: per document, so a tab in the background still gets written ---------- */

const autosaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Autosave only writes a file Margin can safely overwrite; anything doubtful waits for an explicit Ctrl+S. */
export const canAutosave = (d: Doc) =>
  !!d.path && !d.readonly && !d.conflict && !d.missing && !d.diskError && !d.lossy && !d.binary && !d.transient && isDirty(d);

function scheduleAutosave(id: string) {
  clearTimeout(autosaveTimers.get(id));
  autosaveTimers.delete(id);
  const s = useSettings.getState().settings;
  if (s.autoSave !== 'delay') return;
  autosaveTimers.set(id, setTimeout(() => {
    autosaveTimers.delete(id);
    const d = useApp.getState().docs.find((x) => x.id === id);
    if (d && canAutosave(d)) void useApp.getState().save(id);
  }, s.autoSaveDelay * 1000));
}

function dropDraft(id: string) {
  const p = pending.get(id);
  if (p) clearTimeout(p.timer);
  pending.delete(id);
  clearTimeout(autosaveTimers.get(id));
  autosaveTimers.delete(id);
  savedHashes.delete(id);
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
/** Closed-tab history is loaded at every start, so its text is capped (the newest entry always stays). */
const CLOSED_BYTES = 8 * 1024 * 1024;

/** Trims closed-tab history to the newest entries that fit the count and size budgets. */
export function trimClosed(closed: ClosedTab[]): ClosedTab[] {
  const kept: ClosedTab[] = [];
  let bytes = 0;
  for (let i = closed.length - 1; i >= 0 && kept.length < CLOSED_KEEP; i--) {
    bytes += (closed[i].content?.length ?? 0) * 2;
    if (kept.length && bytes > CLOSED_BYTES) break;
    kept.unshift(closed[i]);
  }
  return kept;
}

/**
 * Writes the closed-tab history. Writes run one after another and each writes the latest list,
 * so a slow earlier write can never land after (and undo) a later one. Rejects when the write
 * fails, so a caller can keep a draft until its text is safely recorded.
 */
let closedWrite: Promise<void> = Promise.resolve();
function persistClosed(): Promise<void> {
  const task = closedWrite.then(() => storeSet(CLOSED_KEY, useApp.getState().closed, true));
  closedWrite = task.catch(() => undefined);
  return task;
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
  // A file that grew past the limit opens as text even if it was markdown last time.
  const k = f.size > BIG_FILE ? 'text' : kind ?? kindFor(f.path, f.size);
  return {
    ...makeDoc(f.path, f.name, f.content, f.mtimeMs, mode, f.readonly, scroll, k, id),
    encoding: f.encoding,
    bom: f.bom,
    diskEncoding: f.encoding,
    diskBom: f.bom,
    binary: f.binary,
    version: f.version,
    lossy: f.lossy,
  };
}

function refreshedFile(d: Doc, f: FileData): Doc {
  const big = f.size > BIG_FILE && d.kind !== 'text';
  return {
    ...d, content: f.content, saved: f.content, mtimeMs: f.mtimeMs,
    encoding: f.encoding, bom: f.bom, diskEncoding: f.encoding, diskBom: f.bom,
    eol: detectEol(f.content, d.eol), readonly: f.readonly, binary: f.binary,
    rev: d.rev + 1, conflict: false, missing: false, version: f.version, diskError: null, lossy: f.lossy,
    ...(big ? { kind: 'text' as const } : {}),
  };
}

/** Says so when what is shown isn't byte for byte what is on disk. */
function noteFileQuirks(f: FileData) {
  if (f.lossy) {
    toast.warn(
      `${f.name} has bytes that aren't valid ${f.encoding}`,
      'They show as � and saving would replace them. Try another encoding from the status bar.',
    );
  } else if (f.mixedEol) {
    toast.info(
      `${f.name} mixed different line endings`,
      `They show as ${detectEol(f.content) === '\r\n' ? 'Windows (CRLF)' : detectEol(f.content) === '\n' ? 'Unix (LF)' : 'Mac (CR)'}. Saving writes every line that way.`,
    );
  }
}

function sameEdit(before: Doc, current: Doc): boolean {
  return before.path === current.path && before.rev === current.rev && before.content === current.content &&
    before.saved === current.saved && before.encoding === current.encoding && before.bom === current.bom;
}

const saving = new Set<string>();
/** Tabs whose file changed on disk while they were being saved: checked again after the save. */
const recheck = new Set<string>();

/** The one prompt for a file that changed on disk under unsaved edits. The status bar holds every choice. */
function conflictToast(id: string, title: string, body: string) {
  toast.action({
    kind: 'warn',
    title,
    body: `${body} The status bar has Keep mine and Use the file's.`,
    actionLabel: 'Compare',
    onAction: () => void useApp.getState().resolveConflict(id, 'compare'),
    sticky: true,
  });
}

function savedFile(current: Doc, snapshot: Doc, text: string, { mtimeMs, version }: { mtimeMs: number; version: string }, { encoding, bom }: { encoding: string; bom: boolean }): Doc {
  return {
    ...current, saved: text, mtimeMs, version, conflict: false, missing: false, diskError: null, lossy: false,
    content: current.content === snapshot.content && current.eol === snapshot.eol ? text : current.content,
    encoding: current.encoding === snapshot.encoding ? encoding : current.encoding,
    bom: current.bom === snapshot.bom ? bom : current.bom,
    diskEncoding: encoding, diskBom: bom,
  };
}

const VIEW_MODES: ViewMode[] = ['read', 'edit', 'source'];
const asMode = (m: unknown, fallback: ViewMode): ViewMode => (VIEW_MODES.includes(m as ViewMode) ? (m as ViewMode) : fallback);
const asKind = (k: unknown, fallback: DocKind): DocKind => (k === 'markdown' || k === 'text' ? k : fallback);
const asEol = (e: unknown): Eol | undefined => (e === '\r\n' || e === '\n' || e === '\r' ? e : undefined);
const asText = (t: unknown, fallback = ''): string => (typeof t === 'string' ? t : fallback);

/** A draft as the desktop side found it, with every field checked: one odd record must never stop Margin starting. */
export function cleanDraft(raw: unknown): Draft | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.id !== 'string' || !d.id || typeof d.content !== 'string') return null;
  const path = typeof d.path === 'string' && d.path ? d.path : null;
  return {
    id: d.id,
    path,
    name: asText(d.name, path ? baseName(path) : 'Untitled'),
    content: d.content,
    saved: typeof d.saved === 'string' ? d.saved : undefined,
    savedHash: typeof d.savedHash === 'string' ? d.savedHash : undefined,
    mode: asMode(d.mode, 'edit'),
    kind: asKind(d.kind, path && !isMarkdownPath(path) ? 'text' : 'markdown'),
    encoding: asText(d.encoding, 'UTF-8') || 'UTF-8',
    bom: d.bom === true,
    diskEncoding: typeof d.diskEncoding === 'string' ? d.diskEncoding : undefined,
    eol: asEol(d.eol),
    scroll: typeof d.scroll === 'number' && Number.isFinite(d.scroll) ? d.scroll : undefined,
    updatedAt: typeof d.updatedAt === 'number' ? d.updatedAt : 0,
  };
}

function cleanTab(raw: unknown): SessionTab | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.id !== 'string' || !t.id) return null;
  const path = typeof t.path === 'string' && t.path ? t.path : null;
  return {
    id: t.id,
    path,
    name: asText(t.name, path ? baseName(path) : 'Untitled'),
    mode: asMode(t.mode, 'read'),
    kind: asKind(t.kind, path ? kindFor(path) : 'markdown'),
    scroll: typeof t.scroll === 'number' && Number.isFinite(t.scroll) ? t.scroll : 0,
    encoding: asText(t.encoding, 'UTF-8') || 'UTF-8',
    eol: asEol(t.eol),
    binary: t.binary === true,
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
    } catch (err) {
      const gone = errorKind(err) === 'notfound';
      // The file is gone and nothing was unsaved: drop the tab quietly.
      if (gone && !draft) return null;
      const doc = makeDoc(tab.path, tab.name, draft?.content ?? '', 0, tab.mode, false, tab.scroll, tab.kind, tab.id);
      const restored: Doc = {
        ...doc,
        saved: draft ? '' : doc.content,
        encoding: draft?.encoding ?? tab.encoding,
        bom: draft?.bom ?? false,
        diskEncoding: draft?.diskEncoding ?? tab.encoding,
        eol: detectEol(doc.content, draft?.eol ?? tab.eol),
      };
      // A file that is there but can't be read (locked, no access, grown too large) is never
      // treated as deleted: autosave stays off, and saving first checks what is on disk.
      if (gone) return { ...restored, missing: true };
      return { ...restored, diskError: errorMessage(err), readonly: !draft };
    }
  }
  const doc = makeDoc(null, draft?.name ?? tab.name, draft?.content ?? '', 0, tab.mode, false, tab.scroll, tab.kind, tab.id);
  return { ...doc, saved: draft?.saved ?? '', encoding: draft?.encoding ?? 'UTF-8', bom: draft?.bom ?? false, eol: detectEol(doc.content, draft?.eol ?? tab.eol) };
}

/** Runs `fn` over `items` with at most `limit` running at once, keeping the results in order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** A copy of a tab's unsaved text with no file behind it: used when that file is already open in another tab. */
function recoveredCopy(name: string, content: string, kind: DocKind, mode: ViewMode, id = newId()): Doc {
  const title = `${name.replace(/\.[^.]+$/, '')} (recovered)`;
  return { ...makeDoc(null, title, content, 0, mode, false, 0, kind, id), saved: '' };
}

/** Starts a window opened for torn-off tabs: shared preferences, then only the tabs it was given. */
async function initAdopted(): Promise<void> {
  const [recents, zoom, kinds, mainSession] = await Promise.all([
    storeGet<RecentFile[]>('recents'),
    storeGet<number>('zoom'),
    storeGet<Record<string, DocKind>>('file-kinds'),
    storeGet<Session>('session'),
  ]);
  kindOverrides = kinds && typeof kinds === 'object' && !Array.isArray(kinds) ? kinds : {};
  useApp.setState({
    recents: Array.isArray(recents) ? recents.filter((r) => r && typeof r.path === 'string') : [],
    zoom: typeof zoom === 'number' && Number.isFinite(zoom) ? zoom : 1,
    sidebarOpen: mainSession?.sidebarOpen ?? true,
    sidebarTab: mainSession?.sidebarTab ?? 'outline',
    sidebarWidth: mainSession?.sidebarWidth ?? 248,
    folder: typeof mainSession?.folder === 'string' ? mainSession.folder : null,
    lastMode: asMode(mainSession?.lastMode, 'read'),
  });
  startDraftSync();
  adoption = (async () => {
    for (const id of adoptedIds()) await useApp.getState().adoptDoc(id);
  })();
  await adoption;
  useApp.setState({ ready: true });
  void persistSession();
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
  draftTrouble: null,

  async init() {
    if (!(await claimRestore())) return initAdopted();
    const [recents, rawSession, zoom, kinds, ownClosed, list, otherSessionKeys, otherClosedKeys] = await Promise.all([
      storeGet<RecentFile[]>('recents'),
      storeGet<Session>(SESSION_KEY),
      storeGet<number>('zoom'),
      storeGet<Record<string, DocKind>>('file-kinds'),
      storeGet<ClosedTab[]>(CLOSED_KEY),
      draftList().catch((err) => {
        console.warn('Could not list the drafts', err);
        return { drafts: [] as Draft[], quarantined: [] as string[] };
      }),
      storeKeys('session-').then((keys) => keys.filter((k) => k !== SESSION_KEY)),
      storeKeys('closed-').then((keys) => keys.filter((k) => k !== CLOSED_KEY)),
    ]);
    // Windows that were open alongside this one last time: their tabs come back here too.
    const [otherSessions, otherClosed] = await Promise.all([
      Promise.all(otherSessionKeys.map((k) => storeGet<Session>(k))),
      Promise.all(otherClosedKeys.map((k) => storeGet<ClosedTab[]>(k))),
    ]);
    const closed = [ownClosed, ...otherClosed]
      .flatMap((list) => (Array.isArray(list) ? list : []))
      .sort((a, b) => (a?.closedAt ?? 0) - (b?.closedAt ?? 0));
    const session = rawSession && typeof rawSession === 'object' ? rawSession : null;
    kindOverrides = kinds && typeof kinds === 'object' && !Array.isArray(kinds) ? kinds : {};
    const cutoff = Date.now() - CLOSED_DAYS * 864e5;
    set({
      recents: Array.isArray(recents) ? recents.filter((r) => r && typeof r.path === 'string') : [],
      closed: Array.isArray(closed)
        ? trimClosed(closed.filter((c) => c && typeof c.closedAt === 'number' && c.closedAt > cutoff && (typeof c.path === 'string' || typeof c.content === 'string')))
        : [],
      zoom: typeof zoom === 'number' && Number.isFinite(zoom) ? zoom : 1,
      ...(session
        ? {
            sidebarOpen: session.sidebarOpen ?? true,
            sidebarTab: session.sidebarTab ?? 'outline',
            sidebarWidth: session.sidebarWidth ?? 248,
            folder: typeof session.folder === 'string' ? session.folder : null,
            lastMode: asMode(session.lastMode, 'read'),
          }
        : {}),
    });

    const cleaned = (Array.isArray(list.drafts) ? list.drafts : []).map(cleanDraft);
    const drafts = new Map(cleaned.filter((d): d is Draft => !!d).map((d) => [d.id, d]));
    drafts.forEach((_d, id) => onDisk.add(id));
    const restore = useSettings.getState().settings.restoreSession;
    const tabs: SessionTab[] = [
      ...(session?.version === 2 && Array.isArray(session.tabs)
        ? session.tabs.map(cleanTab)
        : (Array.isArray(session?.open) ? session.open : [])
            .filter((o) => o && typeof o.path === 'string')
            .map((o) => cleanTab({ id: newId(), path: o.path, mode: o.mode, kind: kindFor(o.path), scroll: o.scroll }))),
      ...otherSessions.flatMap((other) => (other?.version === 2 && Array.isArray(other.tabs) ? other.tabs.map(cleanTab) : [])),
    ].filter((t, i, all): t is SessionTab => !!t && all.findIndex((x) => x?.id === t.id) === i);

    // Which tabs come back: listed tabs (all of them, or only those with unsaved text when
    // "restore session" is off), then drafts the session doesn't list (a crash between
    // creating a tab and saving the session).
    const jobs: { tab: SessionTab; draft: Draft | undefined }[] = [];
    for (const tab of tabs) {
      const draft = drafts.get(tab.id);
      drafts.delete(tab.id);
      if (restore || draft) jobs.push({ tab, draft });
    }
    for (const draft of [...drafts.values()].sort((a, b) => a.updatedAt - b.updatedAt)) {
      jobs.push({
        draft,
        tab: {
          id: draft.id,
          path: draft.path,
          name: draft.name,
          mode: asMode(draft.mode, 'edit'),
          kind: asKind(draft.kind, 'markdown'),
          scroll: draft.scroll ?? 0,
          encoding: draft.diskEncoding ?? draft.encoding ?? 'UTF-8',
        },
      });
    }

    // Files are read side by side, so a session with many tabs opens as fast as its slowest file.
    const conflicts: string[] = [];
    const restored = await mapLimit(jobs, 6, ({ tab, draft }) =>
      restoreTab(tab, draft, conflicts).catch((err) => {
        // One broken tab must never stop the others: keep its text as an untitled note.
        console.error('Could not restore a tab', err);
        return draft ? recoveredCopy(draft.name, draft.content, asKind(draft.kind, 'markdown'), asMode(draft.mode, 'edit'), draft.id) : null;
      }),
    );

    // One writable tab per file. A second tab for the same file keeps its own unsaved text as
    // an untitled copy, so neither version is lost and saves can't overwrite each other.
    const docs: Doc[] = [];
    for (const doc of restored) {
      if (!doc) continue;
      const twin = doc.path ? docs.find((d) => d.path && samePath(d.path, doc.path as string)) : undefined;
      if (!twin) docs.push(doc);
      else if (isDirty(doc) && doc.content !== twin.content) docs.push(recoveredCopy(doc.name, doc.content, doc.kind, doc.mode, doc.id));
    }
    const activeId =
      (session?.activeId && docs.find((d) => d.id === session.activeId)?.id) ??
      (session?.active && docs.find((d) => d.path && samePath(d.path, session.active as string))?.id) ??
      docs[docs.length - 1]?.id ??
      null;
    set({ docs, activeId, ready: true });
    // This window now holds these files; another window opening one of them shows it here.
    for (const d of docs) if (d.path) void claimPath(d.path);

    // From here on, every change reaches disk on its own.
    docs.forEach((d) => {
      seen.set(d.id, snapshotOf(d));
      if (!needsDraft(d) && onDisk.has(d.id)) scheduleDraft(d.id);
    });
    // Drafts of duplicate tabs whose text another tab already holds.
    for (const id of [...onDisk]) {
      if (!docs.some((d) => d.id === id)) void chain(id, async () => {
        await draftDelete(id);
        onDisk.delete(id);
      });
    }
    startDraftSync();
    if (!session || session.version !== 2 || otherSessionKeys.length) void persistSession(true).then(() => {
      // The other windows' lists live in this window's now.
      otherSessionKeys.forEach((k) => void storeDelete(k));
    });
    if (otherClosedKeys.length) void persistClosed().then(() => otherClosedKeys.forEach((k) => void storeDelete(k))).catch(() => undefined);

    for (const id of conflicts) {
      const d = get().docs.find((x) => x.id === id);
      if (!d) continue;
      toast.action({
        kind: 'warn',
        title: `${d.name} changed while Margin was closed`,
        body: "Your unsaved version is showing. Compare them, or choose Keep mine or Use the file's in the status bar.",
        actionLabel: 'Compare',
        onAction: () => void get().resolveConflict(id, 'compare'),
        sticky: true,
      });
    }
    for (const d of docs.filter((x) => x.diskError)) {
      toast.action({
        kind: 'warn',
        title: `Couldn't read ${d.name}`,
        body: isDirty(d)
          ? `${d.diskError} Your unsaved text is showing. Saving checks the file first.`
          : `${d.diskError}`,
        actionLabel: 'Try again',
        onAction: () => void get().retryDisk(d.id),
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
      // One window per file: if another window has it open, show it there.
      const owner = await claimPath(path);
      if (owner) {
        void focusPathIn(owner, path).catch(() => undefined);
        continue;
      }
      try {
        const f = await readForOpen(path, opts?.force);
        if (!f) {
          void releasePath(path);
          continue;
        }
        flushEditors();
        const alreadyOpen = get().docs.find((d) => d.path && samePath(d.path, f.path));
        if (alreadyOpen) {
          lastId = alreadyOpen.id;
          continue;
        }
        const kind = kindFor(f.path, f.size);
        const doc = docFromFile(f, kind === 'markdown' ? initialMode(get().lastMode) : 'source', 0, newId(), kind);
        if (f.size > BIG_FILE) toast.info(`${f.name} is large`, 'Opened as plain text so it stays fast.');
        noteFileQuirks(f);
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
    const next = docs.filter((d) => d.id !== id);
    // Only unwatch when no other tab shows the same file.
    if (doc.path && !next.some((d) => d.path && samePath(d.path, doc.path as string))) {
      void unwatchFile(doc.path);
      void releasePath(doc.path);
    }
    const keepText = !doc.path || isDirty(doc);
    const worthKeeping = !doc.transient && (!!doc.path || doc.content.trim() !== '');
    const record: ClosedTab | null = worthKeeping
      ? {
          path: doc.path,
          name: displayName(doc),
          kind: doc.kind,
          mode: doc.mode,
          encoding: doc.encoding,
          bom: doc.bom,
          diskEncoding: doc.diskEncoding,
          eol: doc.eol,
          savedHash: keepText && doc.path ? savedHash(doc) : undefined,
          content: keepText ? doc.content : undefined,
          closedAt: Date.now(),
        }
      : null;
    set({
      docs: next,
      closed: record ? trimClosed([...get().closed, record]) : get().closed,
      activeId: activeId === id ? (next[idx] ?? next[idx - 1] ?? null)?.id ?? null : activeId,
    });
    void persistSession();
    if (!record || !keepText) {
      if (record) void persistClosed().catch((err) => console.warn('Could not save closed tabs', err));
      dropDraft(id);
      return;
    }
    // The tab's text now lives in two places: its draft, and the closed-tab history. The draft
    // is deleted only once the history is safely on disk; if that write fails the draft stays,
    // and the note comes back as a tab at the next start instead of being lost.
    const p = pending.get(id);
    if (p) clearTimeout(p.timer);
    pending.delete(id);
    clearTimeout(autosaveTimers.get(id));
    autosaveTimers.delete(id);
    seen.delete(id);
    const hadDraft = onDisk.has(id) || needsDraft(doc);
    void chain(id, async () => {
      try {
        await persistClosed();
      } catch (err) {
        if (!onDisk.has(id) && hadDraft) {
          // Nothing on disk yet (closed within a second of typing): write the draft now.
          await draftWrite(toDraft(doc));
          onDisk.add(id);
        }
        toast.warn(`Couldn't add ${displayName(doc)} to closed tabs`, 'Its text is kept and reopens as a tab the next time Margin starts.');
        throw err;
      }
      await draftDelete(id);
      onDisk.delete(id);
      savedHashes.delete(id);
    });
  },

  async reopenClosed() {
    const last = get().closed[get().closed.length - 1];
    if (!last) {
      toast.info('No closed tabs to reopen');
      return;
    }
    // The record stays in the history until the tab is back.
    const done = () => {
      set((s) => ({ closed: s.closed.filter((c) => c !== last) }));
      void persistClosed().catch((err) => console.warn('Could not save closed tabs', err));
    };
    const open = last.path ? get().docs.find((d) => d.path && samePath(d.path, last.path as string)) : undefined;
    if (open) {
      // The file is open again already: never make a second writable tab for it. Unsaved text
      // that differs comes back as its own untitled copy.
      flushEditors();
      if (last.content !== undefined && last.content !== open.content) {
        const copy = recoveredCopy(last.name, last.content, last.kind, last.mode);
        set((s) => ({ docs: [...s.docs, copy], activeId: copy.id }));
        toast.info(`${last.name} is already open`, 'Your closed version opened as a separate note.');
      } else get().activate(open.id);
      done();
      void persistSession();
      return;
    }
    const owner = !open && last.path ? await claimPath(last.path) : null;
    if (owner && last.path) {
      // The file is open in another window: never a second writable tab for it.
      if (last.content !== undefined) {
        const copy = recoveredCopy(last.name, last.content, last.kind, last.mode);
        set((s) => ({ docs: [...s.docs, copy], activeId: copy.id }));
        toast.info(`${last.name} is open in another window`, 'Your closed version opened here as a separate note.');
      } else void focusPathIn(owner, last.path).catch(() => undefined);
      done();
      void persistSession();
      return;
    }
    if (last.content === undefined && last.path) {
      await get().openPaths([last.path]);
      if (get().docs.some((d) => d.path && samePath(d.path, last.path as string))) done();
      return;
    }
    let doc = makeDoc(last.path, last.name, last.content ?? '', 0, last.mode, false, 0, last.kind);
    doc = { ...doc, encoding: last.encoding, bom: last.bom, eol: detectEol(doc.content, last.eol) };
    if (last.path) {
      try {
        const f = await readFile(last.path, { encoding: last.diskEncoding ?? last.encoding });
        doc = {
          ...doc, name: f.name, saved: f.content, mtimeMs: f.mtimeMs, readonly: f.readonly,
          diskEncoding: f.encoding, diskBom: f.bom, version: f.version,
          conflict: !!last.savedHash && last.savedHash !== hashText(f.content) && doc.content !== f.content,
        };
        void watchFile(f.path);
      } catch (err) {
        doc = errorKind(err) === 'notfound'
          ? { ...doc, saved: '', missing: true }
          : { ...doc, saved: '', diskError: errorMessage(err), diskEncoding: last.diskEncoding ?? last.encoding };
      }
    } else doc = { ...doc, saved: '' };
    // Another reopen may have opened the same file while this one was reading it.
    if (doc.path && get().docs.some((d) => d.path && samePath(d.path, doc.path as string))) return get().reopenClosed();
    set((s) => ({ docs: [...s.docs, doc], activeId: doc.id }));
    done();
    void persistSession();
  },

  async detachDoc(id) {
    flushEditors();
    const doc = get().docs.find((d) => d.id === id);
    if (!doc) return false;
    // Nothing else may write or delete this tab's draft from here on.
    const p = pending.get(id);
    if (p) clearTimeout(p.timer);
    pending.delete(id);
    clearTimeout(autosaveTimers.get(id));
    autosaveTimers.delete(id);
    seen.delete(id);
    // The draft carries everything the other window needs, saved or not.
    await chain(id, () => draftWrite(toDraft(doc)));
    if (failedDrafts.has(id)) {
      seen.set(id, snapshotOf(doc));
      toast.error("Couldn't move the tab", 'Its text stays here.');
      return false;
    }
    failedDrafts.delete(id);
    onDisk.delete(id);
    savedHashes.delete(id);
    const { docs, activeId } = get();
    const idx = docs.findIndex((d) => d.id === id);
    const next = docs.filter((d) => d.id !== id);
    set({ docs: next, activeId: activeId === id ? (next[idx] ?? next[idx - 1] ?? null)?.id ?? null : activeId });
    if (doc.path && !next.some((d) => d.path && samePath(d.path, doc.path as string))) {
      void unwatchFile(doc.path);
      await releasePath(doc.path);
    }
    await persistSession(true).catch(() => undefined);
    return true;
  },

  async adoptDoc(id, index) {
    if (get().docs.some((d) => d.id === id)) return true;
    const draft = cleanDraft(await draftRead(id).catch(() => null));
    if (!draft) {
      toast.error("Couldn't move the tab", 'Its text is safe in the drafts folder and comes back the next time Margin starts.');
      return false;
    }
    const tab: SessionTab = {
      id,
      path: draft.path,
      name: draft.name,
      mode: asMode(draft.mode, 'edit'),
      kind: asKind(draft.kind, 'markdown'),
      scroll: draft.scroll ?? 0,
      encoding: draft.diskEncoding ?? draft.encoding ?? 'UTF-8',
      eol: draft.eol,
    };
    const owner = draft.path ? await claimPath(draft.path) : null;
    const conflicts: string[] = [];
    // If another window opened the file meanwhile, this text comes in as a separate note.
    const doc = owner
      ? recoveredCopy(draft.name, draft.content, tab.kind, tab.mode, id)
      : await restoreTab(tab, draft, conflicts).catch(() => recoveredCopy(draft.name, draft.content, tab.kind, tab.mode, id));
    if (!doc) return false;
    set((s) => {
      const docs = [...s.docs];
      const at = index === undefined ? docs.length : Math.max(0, Math.min(index, docs.length));
      docs.splice(at, 0, doc);
      return { docs, activeId: doc.id };
    });
    onDisk.add(id);
    seen.set(id, snapshotOf(doc));
    // A saved file needs no draft: the one used for the move is removed.
    if (!needsDraft(doc)) scheduleDraft(id);
    void persistSession();
    for (const c of conflicts) conflictToast(c, `${doc.name} changed on disk`, 'Your unsaved version is showing.');
    return true;
  },

  activatePath(path) {
    const doc = get().docs.find((d) => d.path && samePath(d.path, path));
    if (doc) get().activate(doc.id);
  },

  clearClosed() {
    set({ closed: [] });
    void persistClosed().catch((err) => toast.error("Couldn't clear closed tabs", errorMessage(err)));
    toast.success('Closed tab history cleared');
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
      docs: s.docs.map((d) => {
        if (d.id !== id) return d;
        // Plain text's `---` separator lines would otherwise turn the line above into a big heading.
        const content = kind === 'markdown' && !d.readonly ? dashLinesAsSeparators(d.content) : d.content;
        return { ...d, kind, content, mode: kind === 'markdown' ? 'read' : 'source', rev: d.rev + 1 };
      }),
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

  async save(id, opts) {
    flushEditors();
    const doc = get().docs.find((d) => d.id === (id ?? get().activeId));
    if (!doc || doc.transient) return false;
    if (!doc.path || doc.readonly) return get().saveAs(doc.id);
    if (!isDirty(doc)) return true;
    if (saving.has(doc.id)) return false;
    if (doc.lossy && !opts?.force) {
      toast.action({
        kind: 'warn',
        title: `Save ${doc.name} anyway?`,
        body: `Some bytes weren't valid ${doc.diskEncoding} and show as �. Saving writes � in their place.`,
        actionLabel: 'Save anyway',
        onAction: () => void get().save(doc.id, { force: true }),
      });
      return false;
    }
    saving.add(doc.id);
    try {
      const text = normaliseForSave(doc);
      // The version this text was based on. A tab whose file was missing or unreadable expects
      // no file at all, so a file that has appeared since is never overwritten unseen.
      const expected = doc.version ?? 'absent';
      const result = await writeFile(doc.path, text, doc, { expected, force: opts?.force });
      flushEditors();
      set((s) => ({
        docs: s.docs.map((d) => d.id === doc.id ? savedFile(d, doc, text, result, doc) : d),
      }));
      void persistSession();
      return true;
    } catch (err) {
      const kind = errorKind(err);
      if (kind === 'unmappable') {
        toast.action({
          kind: 'warn',
          title: `${doc.name} has characters ${doc.encoding} can't hold`,
          body: errorMessage(err),
          actionLabel: 'Save as UTF-8',
          onAction: () => {
            get().setEncoding(doc.id, 'UTF-8', false);
            void get().save(doc.id);
          },
        });
      } else if (kind === 'conflict') {
        set((s) => ({ docs: s.docs.map((d) => (d.id === doc.id ? { ...d, conflict: true } : d)) }));
        conflictToast(doc.id, `${doc.name} changed on disk`, 'It was not saved, so the other version is safe. Choose which to keep.');
      } else toast.error(`Couldn't save ${doc.name}`, errorMessage(err));
      return false;
    } finally {
      saving.delete(doc.id);
      // A change on disk reported while saving was held back: look at it now.
      if (recheck.delete(doc.id) && doc.path) void get().handleExternalChange(doc.path, 'modified');
    }
  },

  async saveAs(id) {
    flushEditors();
    const doc = get().docs.find((d) => d.id === (id ?? get().activeId));
    if (!doc || saving.has(doc.id)) return false;
    if (doc.transient) {
      toast.info('This is the version on disk, shown for comparing', 'Copy what you need into your own tab.');
      return false;
    }
    const suggested = doc.path && !doc.binary ? doc.name : fileNameFor(doc);
    saving.add(doc.id);
    try {
      const path = await pickSavePath(suggested, doc.kind === 'text' ? 'text' : 'markdown', doc.path ? dirName(doc.path) : get().folder ?? undefined);
      if (!path) return false;
      flushEditors();
      const snapshot = get().docs.find((d) => d.id === doc.id);
      if (!snapshot) return false;
      const owner = snapshot.path && samePath(snapshot.path, path) ? null : await claimPath(path);
      if (owner) {
        toast.warn('That file is open in another window', 'Choose a different name or save from that window.');
        return false;
      }
      if (get().docs.some((d) => d.id !== doc.id && d.path && samePath(d.path, path))) {
        toast.warn('That file is already open', 'Choose a different name or save from its open tab.');
        return false;
      }
      // Images pasted into a note before it had a file were kept inline; now that it has a
      // folder they become files beside it, like images pasted into a saved note.
      let source = snapshot;
      if (isTauri && snapshot.kind === 'markdown' && snapshot.content.includes('](data:image/')) {
        const folderSetting = useSettings.getState().settings.imageFolder.trim();
        const { text: relinked, images } = extractDataImages(snapshot.content, folderSetting);
        if (images.length) {
          for (const image of images) await writeBinary(joinPath(dirName(path), image.path.replace(/\//g, '\\')), image.bytes);
          source = { ...snapshot, content: relinked };
        }
      }
      const text = normaliseForSave(source);
      const encoding = snapshot.binary ? 'UTF-8' : snapshot.encoding;
      const bom = snapshot.binary ? false : snapshot.bom;
      const result = await writeFile(path, text, { encoding, bom });
      if (!isTauri) downloadText(baseName(path), text, snapshot.kind === 'text' ? 'text/plain' : 'text/markdown');
      flushEditors();
      if (get().docs.some((d) => d.id === doc.id)) {
        if (snapshot.path && !samePath(snapshot.path, path)) {
          void unwatchFile(snapshot.path);
          void releasePath(snapshot.path);
        }
        void watchFile(path);
      }
      const relinked = source !== snapshot;
      set((s) => ({
        docs: s.docs.map((d) =>
          d.id === doc.id
            ? {
                ...savedFile(d, snapshot, text, result, { encoding, bom }),
                // Edits typed while saving are kept; otherwise the editor shows the linked images.
                ...(relinked && d.content === snapshot.content ? { content: text, rev: d.rev + 1 } : {}),
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
      if (d.path && !d.readonly && !d.conflict && !d.diskError && !d.lossy && !d.transient && isDirty(d)) await get().save(d.id);
    }
  },

  async reload(id, silent) {
    flushEditors();
    const doc = get().docs.find((d) => d.id === id);
    if (!doc?.path) return;
    // Reloading over unsaved text keeps that text in closed tabs, so it can come back.
    if (!silent && isDirty(doc) && !doc.missing) return get().resolveConflict(id, 'disk');
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

  async resolveConflict(id, how) {
    flushEditors();
    const doc = get().docs.find((d) => d.id === id);
    if (!doc?.path) return;
    if (how === 'overwrite') {
      if (await get().save(id, { force: true })) toast.success('Saved your version', doc.name);
      return;
    }
    if (how === 'copy') {
      await get().saveAs(id);
      return;
    }
    let disk: FileData;
    try {
      disk = await readFile(doc.path, { encoding: doc.diskEncoding, force: doc.binary });
    } catch (err) {
      toast.error(`Couldn't read ${doc.name}`, errorMessage(err));
      return;
    }
    if (how === 'compare') {
      // The disk version opens beside yours, read-only, so the two can be compared tab to tab.
      const name = `${doc.name} (on disk)`;
      const existing = get().docs.find((d) => d.transient && d.name === name);
      const view: Doc = {
        ...makeDoc(null, name, disk.content, disk.mtimeMs, 'source', true, 0, doc.kind),
        transient: true,
        eol: detectEol(disk.content, doc.eol),
      };
      set((s) => {
        const docs = existing ? s.docs.filter((d) => d.id !== existing.id) : s.docs;
        const at = docs.findIndex((d) => d.id === id);
        return { docs: [...docs.slice(0, at + 1), view, ...docs.slice(at + 1)], activeId: view.id };
      });
      return;
    }
    // Take the disk version. Your text goes to closed tabs first, so Ctrl+Shift+T brings it back.
    flushEditors();
    const current = get().docs.find((d) => d.id === id);
    if (!current) return;
    if (current.content !== disk.content) {
      const record: ClosedTab = {
        path: null,
        name: `${displayName(current)} (your version)`,
        kind: current.kind,
        mode: current.mode,
        encoding: current.encoding,
        bom: current.bom,
        eol: current.eol,
        content: current.content,
        closedAt: Date.now(),
      };
      set((s) => ({ closed: trimClosed([...s.closed, record]) }));
      try {
        await persistClosed();
      } catch (err) {
        toast.error("Couldn't keep a copy of your version, so nothing was replaced", errorMessage(err));
        return;
      }
    }
    set((s) => ({ docs: s.docs.map((d) => (d.id === id ? refreshedFile(d, disk) : d)) }));
    void persistSession();
    toast.action({
      kind: 'info',
      title: 'Showing the version on disk',
      body: 'Your version is in closed tabs.',
      actionLabel: 'Bring mine back',
      onAction: () => void get().reopenClosed(),
    });
  },

  async retryDisk(id) {
    const doc = get().docs.find((d) => d.id === id);
    if (!doc?.path) return;
    let f: FileData;
    try {
      f = await readFile(doc.path, { encoding: doc.diskEncoding, force: doc.binary });
    } catch (err) {
      if (errorKind(err) === 'notfound') {
        set((s) => ({ docs: s.docs.map((d) => (d.id === id ? { ...d, diskError: null, missing: true, readonly: false } : d)) }));
        toast.warn(`${doc.name} isn't there any more`, 'Save to write your copy back.');
      } else toast.error(`Still couldn't read ${doc.name}`, errorMessage(err));
      return;
    }
    flushEditors();
    const current = get().docs.find((d) => d.id === id);
    if (!current) return;
    void watchFile(f.path);
    const hadText = isDirty(current) && current.content !== '';
    set((s) => ({
      docs: s.docs.map((d) => {
        if (d.id !== id) return d;
        const fresh = refreshedFile(d, f);
        // Unsaved text stays on screen; it becomes a conflict if the file differs from it.
        return hadText ? { ...fresh, content: d.content, rev: d.rev + 1, conflict: d.content !== f.content } : fresh;
      }),
    }));
    void persistSession();
    if (hadText && current.content !== f.content) {
      conflictToast(id, `${doc.name} can be read again`, 'It differs from your unsaved text. Choose which to keep.');
    } else toast.success(`Opened ${doc.name}`);
  },

  async handleExternalChange(path, kind) {
    const doc = get().docs.find((d) => d.path && samePath(d.path, path));
    if (!doc) return;
    if (saving.has(doc.id)) {
      // Looked at again once the save finishes, against the version it wrote.
      recheck.add(doc.id);
      return;
    }
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
    if (!current || current.path !== doc.path || current.diskEncoding !== doc.diskEncoding) return;
    if (saving.has(doc.id)) {
      recheck.add(doc.id);
      return;
    }
    if (disk.content === current.saved && disk.bom === current.diskBom && !current.missing && disk.readonly === current.readonly) {
      // Same text (touched, or rewritten identically): just remember the new version, so the
      // next save isn't mistaken for overwriting someone else's change.
      if (disk.version !== current.version) {
        set((s) => ({ docs: s.docs.map((d) => (d.id === doc.id ? { ...d, version: disk.version, mtimeMs: disk.mtimeMs } : d)) }));
      }
      return;
    }
    const dirty = isDirty(current);
    if (!dirty && useSettings.getState().settings.autoReload) {
      set((s) => ({ docs: s.docs.map((d) => d.id === doc.id ? refreshedFile(d, disk) : d) }));
      void persistSession();
      toast.info('Updated from disk', doc.name);
    } else if (!current.conflict) {
      set((s) => ({ docs: s.docs.map((d) => (d.id === doc.id ? { ...d, conflict: true } : d)) }));
      if (dirty) conflictToast(doc.id, `${doc.name} changed on disk`, 'You have unsaved edits here. Choose which version to keep.');
      else {
        toast.action({
          kind: 'warn',
          title: `${doc.name} changed on disk`,
          body: 'Reload to see the new version.',
          actionLabel: 'Reload',
          onAction: () => void get().reload(doc.id),
          sticky: true,
        });
      }
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
    version: null,
    diskError: null,
    lossy: false,
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
