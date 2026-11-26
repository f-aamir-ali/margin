/* The single bridge to the outside world.
   In the desktop app every call goes to a Rust command; in a plain browser
   (`npm run dev`) a small fallback keeps the whole UI usable for development. */

export interface FileData {
  path: string;
  name: string;
  content: string;
  mtimeMs: number;
  size: number;
  readonly: boolean;
  /** WHATWG encoding name the file was decoded from: "UTF-8", "UTF-16LE", "windows-1252"… */
  encoding: string;
  bom: boolean;
  binary: boolean;
  /** The file mixed CRLF, LF and CR line endings; they were unified to the most common one. */
  mixedEol?: boolean;
  /** Some bytes weren't valid in `encoding` and were replaced: saving would change them. */
  lossy: boolean;
  /** Identifies the bytes read (size and modification time); a save hands it back to detect changes made elsewhere. */
  version: string;
}

export interface WriteResult {
  mtimeMs: number;
  version: string;
}

export interface FileEncoding {
  encoding: string;
  bom: boolean;
}

export type Eol = '\r\n' | '\n' | '\r';

/** One open tab's unsaved state, kept on disk so nothing is lost on close, crash or shutdown. */
export interface Draft {
  id: string;
  path: string | null;
  name: string;
  content: string;
  /** Untitled notes: the baseline text itself (usually ''). */
  saved?: string;
  /** File-backed notes: hash of the disk text the edits were based on. */
  savedHash?: string;
  mode: string;
  kind: string;
  encoding: string;
  bom: boolean;
  diskEncoding?: string;
  eol?: Eol;
  /** Scroll position, so a tab moved to another window opens where it was. */
  scroll?: number;
  updatedAt: number;
}

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  isMarkdown: boolean;
}

export interface FileMeta {
  exists: boolean;
  mtimeMs: number;
  size: number;
  isDir: boolean;
}

export interface FileChange {
  path: string;
  kind: 'modified' | 'removed' | 'renamed';
}

export interface AppInfo {
  version: string;
  configDir: string;
  tauriVersion: string;
}

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const MARKDOWN_EXTENSIONS = ['md', 'markdown', 'mdown', 'mkd', 'mdx', 'mdwn'];

/** Mixed line endings are normalised to the majority on read, so the editors never see a mix. */
export function normaliseEol(text: string): string {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  const cr = (text.match(/\r(?!\n)/g) ?? []).length;
  const kinds = (crlf ? 1 : 0) + (lf ? 1 : 0) + (cr ? 1 : 0);
  if (kinds <= 1) return text;
  const eol = crlf >= lf && crlf >= cr ? '\r\n' : lf >= cr ? '\n' : '\r';
  return text.replace(/\r\n|\r|\n/g, eol);
}

export function detectEol(text: string, fallback: Eol = '\n'): Eol {
  const i = text.search(/\r\n|\r|\n/);
  if (i < 0) return fallback;
  return text[i] === '\n' ? '\n' : text[i + 1] === '\n' ? '\r\n' : '\r';
}

type Unlisten = () => void;

/* ---------- errors from the desktop side ---------- */

/** Rust prefixes the errors the UI has to tell apart: `NOTFOUND:`, `TOOBIG:`, `CONFLICT:`, `BINARY:`, `UNMAPPABLE:`. */
export type ErrorKind = 'notfound' | 'toobig' | 'conflict' | 'binary' | 'unmappable' | 'other';

export function errorText(err: unknown): string {
  return String(err instanceof Error ? err.message : err);
}

export function errorKind(err: unknown): ErrorKind {
  const m = /^(NOTFOUND|TOOBIG|CONFLICT|BINARY|UNMAPPABLE):/.exec(errorText(err));
  return m ? (m[1].toLowerCase() as ErrorKind) : 'other';
}

/** The error without its machine prefix, for showing to the user. */
export function errorMessage(err: unknown): string {
  return errorText(err).replace(/^(NOTFOUND|TOOBIG|CONFLICT|BINARY|UNMAPPABLE):\s*/, '');
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
  return tauriInvoke<T>(cmd, args);
}

/* ---------- path helpers (Windows and POSIX separators) ---------- */

export function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i >= 0 ? path.slice(i + 1) : path;
}

export function dirName(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i >= 0 ? path.slice(0, i) : '';
}

export function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  const sep = dir.includes('\\') ? '\\' : '/';
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

export function isAbsolutePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\');
}

/** Files worth listing in the sidebar besides markdown: plain text, logs, config and code. */
const TEXT_EXTENSIONS = new Set(
  'txt text log ini cfg conf nfo json jsonc yaml yml toml env csv tsv xml html htm css scss js mjs cjs ts tsx jsx py java c h cpp hpp cs go rs rb php sh ps1 bat cmd sql lua kt swift dart srt properties gitignore editorconfig'.split(' '),
);

export function isTextPath(p: string): boolean {
  return TEXT_EXTENSIONS.has(p.slice(p.lastIndexOf('.') + 1).toLowerCase());
}

/** Prose-like plain text (notes, logs, readmes, untitled notes), where "Format as markdown" makes sense. Code and data files don't get the offer. */
export function isProseName(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return true;
  return ['txt', 'text', 'log', 'nfo', 'me', 'readme', '1st'].includes(name.slice(dot + 1).toLowerCase());
}

export function isMarkdownPath(p: string): boolean {
  const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase();
  return MARKDOWN_EXTENSIONS.includes(ext);
}

/** Resolve a relative reference (image, link) against the folder of a document. */
export function resolveRelative(docDir: string, ref: string): string {
  const sep = docDir.includes('\\') ? '\\' : '/';
  const parts = docDir.split(/[\\/]/);
  const root = docDir.startsWith('\\\\') ? 4 : isAbsolutePath(docDir) || /^[a-z]:$/i.test(docDir) ? 1 : 0;
  for (const seg of ref.split(/[\\/]/)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..' && parts.length > root) parts.pop();
    else if (seg === '..' && root) continue;
    else parts.push(seg);
  }
  return parts.join(sep);
}

export function safeDecode(text: string, decode = decodeURIComponent): string {
  try {
    return decode(text);
  } catch {
    return text;
  }
}

export function asDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

const FILE_URI = /^file:\/\/\/(?![/\\])/i;
const DRIVE_REFERENCE = /^[a-z]:(?:[/\\]|%5c|%2f)/i;

export function isExplicitFileReference(url: string): boolean {
  return FILE_URI.test(url) || DRIVE_REFERENCE.test(url);
}

/** Resolve a Markdown destination, decoding the path separately from its query and fragment. */
export function localReferencePath(url: string, folder: string): string | null {
  if (!url || url.startsWith('//') || url.startsWith('#')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !isExplicitFileReference(url)) return null;
  const fileUri = FILE_URI.test(url);
  const encodedPath = url.split(/[?#]/, 1)[0];
  const withoutScheme = fileUri ? encodedPath.slice('file://'.length) : encodedPath;
  const decoded = safeDecode(withoutScheme);
  const path = fileUri && /^\/[a-z]:[/\\]/i.test(decoded) ? decoded.slice(1) : decoded;
  if (!path || /^(?:[/\\]){2}|[\x00-\x1f\x7f]/.test(path) || /:/.test(path.replace(/^[a-z]:[/\\]/i, ''))) return null;
  if (path.startsWith('/')) {
    const drive = /^[a-z]:/i.exec(folder)?.[0];
    return drive ? drive + path : path;
  }
  return isAbsolutePath(path) ? path : folder ? resolveRelative(folder, path) : null;
}

/* ---------- browser fallback state ---------- */

const webFiles = new Map<string, { content: string; mtimeMs: number }>();
const webVersion = (f: { content: string; mtimeMs: number }) => `${f.content.length}:${f.mtimeMs}`;

function webStoreKey(key: string) {
  return `mdv:${key}`;
}

/* ---------- files ---------- */

export async function readFile(path: string, opts?: { encoding?: string; force?: boolean }): Promise<FileData> {
  if (isTauri) {
    const f = await invoke<FileData>('read_file', { path, encoding: opts?.encoding ?? null, force: opts?.force ?? null });
    const content = normaliseEol(f.content);
    return { ...f, content, mixedEol: content !== f.content };
  }
  const web = (content: string, mtimeMs: number): FileData => ({
    path,
    name: baseName(path),
    content: normaliseEol(content),
    mtimeMs,
    size: content.length,
    readonly: false,
    encoding: 'UTF-8',
    bom: false,
    binary: false,
    lossy: false,
    version: webVersion({ content, mtimeMs }),
  });
  const cached = webFiles.get(path);
  if (cached) return web(cached.content, cached.mtimeMs);
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status === 404 ? 'NOTFOUND: ' : ''}Could not open ${baseName(path)}`);
  const content = await res.text();
  webFiles.set(path, { content, mtimeMs: Date.now() });
  return web(content, Date.now());
}

/**
 * Saves text. With `expected` (the version the text was based on) the save is refused with a
 * `CONFLICT:` error when another program changed the file meanwhile, unless `force` is set.
 */
export async function writeFile(
  path: string,
  content: string,
  enc?: FileEncoding,
  check?: { expected?: string | null; force?: boolean },
): Promise<WriteResult> {
  if (isTauri) {
    return invoke<WriteResult>('write_file', {
      path, content, encoding: enc?.encoding ?? null, bom: enc?.bom ?? null,
      expected: check?.expected ?? null, force: check?.force ?? null,
    });
  }
  const current = webFiles.get(path);
  if (current && check?.expected && !check.force && webVersion(current) !== check.expected) {
    throw new Error(`CONFLICT: ${baseName(path)} changed on disk after Margin last read or saved it.`);
  }
  const file = { content, mtimeMs: Math.max(Date.now(), (current?.mtimeMs ?? 0) + 1) };
  webFiles.set(path, file);
  return { mtimeMs: file.mtimeMs, version: webVersion(file) };
}

/** Browser fallback only: simulate another program changing a file (used by tests). */
export function webSimulateExternalWrite(path: string, content: string): void {
  const prev = webFiles.get(path);
  webFiles.set(path, { content, mtimeMs: Math.max(Date.now(), (prev?.mtimeMs ?? 0) + 1) });
}

export async function writeBinary(path: string, bytes: Uint8Array): Promise<void> {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const base64 = btoa(binary);
  if (isTauri) return invoke<void>('write_binary', { path, base64 });
}

export async function listDir(path: string): Promise<DirEntry[]> {
  if (isTauri) return invoke<DirEntry[]>('list_dir', { path });
  if (path === '/samples') {
    return ['welcome.md', 'syntax-torture.md', 'long.md'].map((name) => ({
      name,
      path: `/samples/${name}`,
      isDir: false,
      isMarkdown: true,
    }));
  }
  return [];
}

/** Markdown and text files anywhere under `folder` (hidden entries and node_modules skipped). */
export async function listFiles(folder: string, limit = 5000): Promise<DirEntry[]> {
  if (isTauri) return invoke<DirEntry[]>('list_files', { path: folder, limit });
  return listDir(folder);
}

export async function fileMeta(path: string): Promise<FileMeta> {
  if (isTauri) return invoke<FileMeta>('file_meta', { path });
  const f = webFiles.get(path);
  return { exists: !!f, mtimeMs: f?.mtimeMs ?? 0, size: f?.content.length ?? 0, isDir: false };
}

export async function watchFile(path: string): Promise<void> {
  if (isTauri) await invoke<void>('watch_file', { path }).catch(() => undefined);
}

export async function unwatchFile(path: string): Promise<void> {
  if (isTauri) await invoke<void>('unwatch_file', { path }).catch(() => undefined);
}

export async function onFileChanged(cb: (change: FileChange) => void): Promise<Unlisten> {
  if (!isTauri) return () => undefined;
  const { listen } = await import('@tauri-apps/api/event');
  return listen<FileChange>('file-changed', (e) => cb(e.payload));
}

/**
 * Later launches (an Explorer double-click, Win+R `note`) queue their files in the desktop side
 * and ping the window. Each request is a list of paths; an empty list asks for a blank note.
 * Requests queued before this listener existed are collected straight away.
 */
export async function onOpenFiles(cb: (paths: string[]) => void): Promise<Unlisten> {
  if (!isTauri) return () => undefined;
  const { listen } = await import('@tauri-apps/api/event');
  const drain = async () => {
    const requests = await invoke<string[][]>('take_open_requests').catch(() => [] as string[][]);
    requests.forEach((paths) => cb(paths));
  };
  const off = await listen('open-files', () => void drain());
  void drain();
  return off;
}

export async function launchFiles(): Promise<string[]> {
  if (isTauri) return invoke<string[]>('launch_files');
  const q = new URLSearchParams(location.search).get('open');
  return q ? [q] : [];
}

/** For each right-click, whether the native spelling menu is showing (`true`) or the page should draw its own. */
export async function onContextMenuRoute(cb: (native: boolean) => void): Promise<Unlisten> {
  if (!isTauri) return () => undefined;
  const { listen } = await import('@tauri-apps/api/event');
  return listen<{ native: boolean }>('context-menu-route', (e) => cb(e.payload.native));
}

/** Files dropped on the window (desktop gives real paths). */
export async function onFilesDropped(
  cb: (paths: string[]) => void,
  onHover: (over: boolean) => void,
): Promise<Unlisten> {
  if (!isTauri) return () => undefined;
  const { getCurrentWebview } = await import('@tauri-apps/api/webview');
  return getCurrentWebview().onDragDropEvent((e) => {
    const p = e.payload;
    if (p.type === 'enter' || p.type === 'over') onHover(true);
    else if (p.type === 'leave') onHover(false);
    else if (p.type === 'drop') {
      onHover(false);
      cb(p.paths);
    }
  });
}

/* ---------- dialogs ---------- */

const mdFilter = { name: 'Markdown', extensions: MARKDOWN_EXTENSIONS };
const textFilter = { name: 'Text', extensions: ['txt', 'text', 'log'] };
const allFilter = { name: 'All files', extensions: ['*'] };

export async function pickFiles(): Promise<string[]> {
  if (isTauri) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const res = await open({
      multiple: true,
      filters: [allFilter, mdFilter, textFilter],
    });
    if (!res) return [];
    return Array.isArray(res) ? res : [res];
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = async () => {
      const out: string[] = [];
      for (const f of Array.from(input.files ?? [])) {
        const path = `/local/${f.name}`;
        webFiles.set(path, { content: await f.text(), mtimeMs: f.lastModified });
        out.push(path);
      }
      resolve(out);
    };
    input.oncancel = () => resolve([]);
    input.click();
  });
}

export async function pickFolder(): Promise<string | null> {
  if (!isTauri) return '/samples';
  const { open } = await import('@tauri-apps/plugin-dialog');
  const res = await open({ directory: true });
  return typeof res === 'string' ? res : null;
}

export async function pickSavePath(
  defaultName: string,
  kind: 'markdown' | 'html' | 'pdf' | 'text' = 'markdown',
  defaultDir?: string,
): Promise<string | null> {
  const filters = {
    markdown: [mdFilter, textFilter, allFilter],
    html: [{ name: 'HTML', extensions: ['html'] }],
    pdf: [{ name: 'PDF', extensions: ['pdf'] }],
    text: [textFilter, mdFilter, allFilter],
  }[kind];
  if (isTauri) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    return save({ defaultPath: defaultDir ? joinPath(defaultDir, defaultName) : defaultName, filters });
  }
  return `/local/${defaultName}`;
}

/** Browser-only: hand the user a file. */
export function downloadText(name: string, content: string, mime = 'text/plain') {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- key/value store (settings, session, recents) ---------- */

export async function storeGet<T>(key: string): Promise<T | null> {
  try {
    if (isTauri) return (await invoke<T | null>('store_get', { key })) ?? null;
    const raw = localStorage.getItem(webStoreKey(key));
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function storeSet(key: string, value: unknown, strict = false): Promise<void> {
  try {
    if (isTauri) await invoke<void>('store_set', { key, value });
    else localStorage.setItem(webStoreKey(key), JSON.stringify(value));
  } catch (err) {
    if (strict) throw err;
  }
}

/** Keys starting with `prefix` (the per-window sessions: `session-w1`…). */
export async function storeKeys(prefix: string): Promise<string[]> {
  if (isTauri) return invoke<string[]>('store_keys', { prefix }).catch(() => [] as string[]);
  const out: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(webStoreKey(prefix))) out.push(key.slice(webStoreKey('').length));
    }
  } catch {
    /* no storage here (tests, private windows) */
  }
  return out.sort();
}

export async function storeDelete(key: string): Promise<void> {
  if (isTauri) await invoke<void>('store_delete', { key }).catch(() => undefined);
  else {
    try {
      localStorage.removeItem(webStoreKey(key));
    } catch {
      /* no storage here */
    }
  }
}

/* ---------- drafts (hot exit) ---------- */

const DRAFT_PREFIX = 'mdv:draft:';

export async function draftWrite(draft: Draft): Promise<void> {
  if (isTauri) return invoke<void>('draft_write', { id: draft.id, value: draft });
  localStorage.setItem(DRAFT_PREFIX + draft.id, JSON.stringify(draft));
}

export async function draftDelete(id: string): Promise<void> {
  if (isTauri) return invoke<void>('draft_delete', { id });
  localStorage.removeItem(DRAFT_PREFIX + id);
}

/** One draft by id, or null (a tab handed to another window reads its text here). */
export async function draftRead(id: string): Promise<Draft | null> {
  if (isTauri) return invoke<Draft | null>('draft_read', { id });
  const raw = localStorage.getItem(DRAFT_PREFIX + id);
  return raw ? (JSON.parse(raw) as Draft) : null;
}

export async function draftList(): Promise<{ drafts: Draft[]; quarantined: string[] }> {
  if (isTauri) return invoke<{ drafts: Draft[]; quarantined: string[] }>('draft_list');
  const drafts: Draft[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(DRAFT_PREFIX)) continue;
    try {
      drafts.push(JSON.parse(localStorage.getItem(key) as string) as Draft);
    } catch {
      /* skip */
    }
  }
  return { drafts, quarantined: [] };
}

/* ---------- windows (tabs can be torn off into their own window, like Chrome) ---------- */

/** This window's label: `main` for the first window, `w1`, `w2`… for torn-off tab windows. */
export const windowLabel: string =
  (typeof window !== 'undefined' &&
    (window as unknown as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } }).__TAURI_INTERNALS__
      ?.metadata?.currentWindow?.label) ||
  'main';

/** Draft ids a torn-off window was opened with (`?adopt=id1,id2`). */
export function adoptedIds(): string[] {
  if (typeof location === 'undefined') return [];
  return (new URLSearchParams(location.search).get('adopt') ?? '').split(',').filter((id) => /^[a-z0-9_-]+$/.test(id));
}

/** True for the one window per process that restores the saved session (every window's tabs). */
export async function claimRestore(): Promise<boolean> {
  return isTauri ? invoke<boolean>('claim_restore') : true;
}

/** Marks a file as open in this window. Returns the label of another window that has it open, or null. */
export async function claimPath(path: string): Promise<string | null> {
  if (!isTauri) return null;
  return invoke<string | null>('claim_path', { path }).catch(() => null);
}

export async function releasePath(path: string): Promise<void> {
  if (isTauri) await invoke<void>('release_path', { path }).catch(() => undefined);
}

/** Brings another window to the front and shows its tab for `path`. */
export async function focusPathIn(label: string, path: string): Promise<void> {
  if (isTauri) await invoke<void>('focus_path_in', { label, path });
}

/** Opens a window for torn-off tabs with its top-left corner at physical screen (x, y). Returns its label. */
export async function openTabWindow(adopt: string[], x: number, y: number): Promise<string> {
  return invoke<string>('open_tab_window', { adopt, x, y });
}

export async function moveWindow(label: string, x: number, y: number): Promise<void> {
  if (isTauri) await invoke<void>('move_window', { label, x, y });
}

/** The window whose tab bar is at physical screen (x, y), skipping `exclude`. */
export async function tabDropTarget(x: number, y: number, exclude: string[]): Promise<{ label: string; clientX: number } | null> {
  if (!isTauri) return null;
  return invoke<{ label: string; clientX: number } | null>('tab_drop_target', { x, y, exclude }).catch(() => null);
}

/** Sends an event to one window. */
export async function emitToWindow(label: string, event: string, payload?: unknown): Promise<void> {
  if (!isTauri) return;
  const { emitTo } = await import('@tauri-apps/api/event');
  await emitTo(label, event, payload);
}

/** Sends an event to every window, this one included. */
export async function emitToAll(event: string, payload?: unknown): Promise<void> {
  if (!isTauri) return;
  const { emit } = await import('@tauri-apps/api/event');
  await emit(event, payload);
}

/** Listens for an event sent to this window (or to every window). */
export async function onWindowEvent<T>(event: string, cb: (payload: T) => void): Promise<Unlisten> {
  if (!isTauri) return () => undefined;
  const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  return getCurrentWebviewWindow().listen<T>(event, (e) => cb(e.payload));
}

/* ---------- shell ---------- */

export async function revealInExplorer(path: string): Promise<void> {
  if (isTauri) await invoke<void>('reveal_in_explorer', { path });
}

export async function openExternal(url: string): Promise<void> {
  if (isTauri) await invoke<void>('open_external', { url });
  else window.open(url, '_blank', 'noopener');
}

export async function openLinkedFile(path: string): Promise<void> {
  if (isTauri) await invoke<void>('open_linked_file', { path });
}

export async function appInfo(): Promise<AppInfo> {
  if (isTauri) return invoke<AppInfo>('app_info');
  return { version: '0.1.0-web', configDir: 'localStorage', tauriVersion: '-' };
}

/** Turn a local file path into a URL the webview can load (images). */
let convert: ((p: string) => string) | null = null;
export async function initAssetUrls(): Promise<void> {
  if (!isTauri) return;
  const { convertFileSrc } = await import('@tauri-apps/api/core');
  convert = convertFileSrc;
}
export function assetUrl(path: string): string {
  return convert ? convert(path) : path;
}

/* ---------- window ---------- */

async function win() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow();
}

export const appWindow = {
  async show() {
    if (!isTauri) return;
    const w = await win();
    await w.show();
    await w.setFocus();
  },
  /** Shows the window without taking focus (a torn-off window while its tab is still being dragged). */
  async reveal() {
    if (isTauri) await (await win()).show();
  },
  async minimize() {
    if (isTauri) await (await win()).minimize();
  },
  async toggleMaximize() {
    if (isTauri) await (await win()).toggleMaximize();
  },
  async close() {
    if (isTauri) await (await win()).close();
    else window.close();
  },
  async destroy() {
    if (isTauri) await (await win()).destroy();
  },
  async isMaximized(): Promise<boolean> {
    return isTauri ? (await win()).isMaximized() : false;
  },
  async setFullscreen(on: boolean) {
    if (isTauri) await (await win()).setFullscreen(on);
    else if (on) await document.documentElement.requestFullscreen().catch(() => undefined);
    else if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
  },
  async setTitle(title: string) {
    document.title = title;
    if (isTauri) await (await win()).setTitle(title).catch(() => undefined);
  },
  async setTheme(dark: boolean) {
    if (isTauri) await invoke<void>('set_window_theme', { dark }).catch(() => undefined);
  },
  async onResized(cb: () => void): Promise<Unlisten> {
    if (!isTauri) return () => undefined;
    return (await win()).onResized(cb);
  },
  async onCloseRequested(cb: (prevent: () => void) => void | Promise<void>): Promise<Unlisten> {
    if (!isTauri) return () => undefined;
    return (await win()).onCloseRequested(async (e) => {
      await cb(() => e.preventDefault());
    });
  },
};
