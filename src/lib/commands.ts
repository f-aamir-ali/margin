import { copyAsHtml, exportHtml, printDoc } from './export';
import { appWindow, pickFiles, pickFolder, revealInExplorer } from './platform';
import { THEMES, useSettings, type ViewMode } from './settings';
import { sourceApi } from './sourceApi';
import { activeDoc, flushAll, flushEditors, isDirty, openTour, useApp, viewMode } from './store';
import { toast } from './toast';
import { useUi } from './ui';

export interface Command {
  id: string;
  title: string;
  group: 'File' | 'View' | 'Mode' | 'Go' | 'Theme' | 'Export' | 'App';
  /** e.g. "Ctrl+Shift+P". Matched against keyboard events and shown in menus. */
  keys?: string;
  /** Extra words the palette should match on. */
  keywords?: string;
  needsDoc?: boolean;
  run: () => void | Promise<void>;
}

const app = () => useApp.getState();
const ui = () => useUi.getState();
const doc = () => activeDoc(app());

export function setMode(mode: ViewMode) {
  const d = doc();
  if (!d) return;
  if (d.kind === 'text') {
    // A plain-text tab has one view; asking for Read or Edit offers to format it instead.
    if (mode !== 'source') {
      toast.action({
        kind: 'info',
        title: 'This is a plain text file',
        body: 'Format it as markdown to read and edit it formatted.',
        actionLabel: 'Format as markdown',
        onAction: () => app().setKind(d.id, 'markdown'),
      });
    }
    return;
  }
  if (d.mode !== mode) app().setMode(d.id, mode);
}

export function toggleEdit() {
  const d = doc();
  if (d) setMode(d.mode === 'read' ? 'edit' : 'read');
}

/** Notepad's F5: the time and date at the caret. */
function insertTimeDate(): void {
  const now = new Date();
  const text = `${now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} ${now.toLocaleDateString()}`;
  const d = doc();
  if (!d || d.readonly) return;
  if (viewMode(d) === 'read') {
    toast.info('Switch to editing to insert the date', 'Ctrl+E');
    return;
  }
  const view = sourceApi.view;
  if (viewMode(d) === 'source' && view) {
    view.dispatch(view.state.replaceSelection(text));
    view.focus();
    return;
  }
  const editor = document.querySelector<HTMLElement>('.doc-stage[data-visible] .ProseMirror');
  if (editor) {
    editor.focus();
    document.execCommand('insertText', false, text);
  }
}

export function requestClose(id: string) {
  requestCloseTabs([id]);
}

export function requestCloseTabs(ids: string[]) {
  flushEditors();
  const targets = app().docs.filter((d) => ids.includes(d.id));
  if (targets.some(isDirty) && useSettings.getState().settings.confirmClose) {
    ui().setConfirmClose({ ids: targets.map((d) => d.id), thenQuit: false });
  } else {
    targets.forEach((d) => app().closeDoc(d.id));
  }
}

/** Closing the window never asks, like Windows 11 Notepad: every tab, saved or not, comes back next time. */
let quitting = false;
export async function requestQuit() {
  if (quitting) return;
  quitting = true;
  try {
    await flushAll();
    await appWindow.destroy();
  } catch (err) {
    toast.error("Margin couldn't save this session", String(err instanceof Error ? err.message : err));
  } finally {
    quitting = false;
  }
}

export async function openDialog() {
  const paths = await pickFiles();
  if (paths.length) await app().openPaths(paths);
}

function withDoc(fn: (d: NonNullable<ReturnType<typeof doc>>) => void | Promise<void>) {
  return () => {
    flushEditors();
    const d = doc();
    if (d) return fn(d);
  };
}

export const COMMANDS: Command[] = [
  { id: 'file.open', title: 'Open file…', group: 'File', keys: 'Ctrl+O', run: openDialog },
  { id: 'file.new', title: 'New note', group: 'File', keys: 'Ctrl+N', keywords: 'document tab markdown', run: () => app().newDoc() },
  { id: 'file.newTab', title: 'New tab', group: 'File', keys: 'Ctrl+T', keywords: 'note', run: () => app().newDoc() },
  { id: 'file.newText', title: 'New plain text note', group: 'File', keys: 'Ctrl+Alt+N', keywords: 'txt notepad', run: () => app().newDoc('text') },
  { id: 'file.reopenClosed', title: 'Reopen closed tab', group: 'File', keys: 'Ctrl+Shift+T', keywords: 'undo close restore trash', run: () => app().reopenClosed() },
  {
    id: 'file.openFolder',
    title: 'Open folder…',
    group: 'File',
    keys: 'Ctrl+Shift+O',
    run: async () => {
      const folder = await pickFolder();
      if (folder) app().setSidebar({ folder, sidebarOpen: true, sidebarTab: 'files' });
    },
  },
  { id: 'file.save', title: 'Save', group: 'File', keys: 'Ctrl+S', needsDoc: true, run: async () => {
      const d = doc();
      if (!d) return;
      const wasDirty = isDirty(d) || !d.path;
      if ((await app().save()) && wasDirty && d.path) toast.success('Saved', d.name);
    } },
  { id: 'file.saveAs', title: 'Save as…', group: 'File', keys: 'Ctrl+Shift+S', needsDoc: true, run: () => void app().saveAs() },
  { id: 'file.saveAll', title: 'Save all', group: 'File', keys: 'Ctrl+Alt+S', run: () => app().saveAll() },
  { id: 'file.reload', title: 'Reload from disk', group: 'File', needsDoc: true, run: withDoc((d) => app().reload(d.id)) },
  { id: 'file.close', title: 'Close tab', group: 'File', keys: 'Ctrl+W', needsDoc: true, run: withDoc((d) => requestClose(d.id)) },
  {
    id: 'file.reveal',
    title: 'Show in File Explorer',
    group: 'File',
    needsDoc: true,
    run: withDoc((d) => (d.path ? revealInExplorer(d.path) : undefined)),
  },
  {
    id: 'file.copyPath',
    title: 'Copy file path',
    group: 'File',
    needsDoc: true,
    run: withDoc(async (d) => {
      if (!d.path) return;
      await navigator.clipboard.writeText(d.path);
      toast.success('Path copied');
    }),
  },

  { id: 'mode.read', title: 'Reading mode', group: 'Mode', needsDoc: true, keywords: 'view preview', run: () => setMode('read') },
  { id: 'mode.edit', title: 'Editing mode', group: 'Mode', needsDoc: true, keywords: 'write wysiwyg', run: () => setMode('edit') },
  { id: 'mode.source', title: 'Source mode', group: 'Mode', needsDoc: true, keywords: 'raw markdown code', run: () => setMode('source') },
  {
    id: 'mode.formatMarkdown',
    title: 'Format as markdown',
    group: 'Mode',
    needsDoc: true,
    keywords: 'render preview rich',
    run: withDoc((d) => void (d.kind === 'text' ? app().setKind(d.id, 'markdown') : toast.info('Already formatted as markdown'))),
  },
  {
    id: 'mode.plainText',
    title: 'Show as plain text',
    group: 'Mode',
    needsDoc: true,
    keywords: 'raw notepad txt',
    run: withDoc((d) => void (d.kind === 'markdown' ? app().setKind(d.id, 'text') : toast.info('Already plain text'))),
  },
  { id: 'mode.toggle', title: 'Switch between reading and editing', group: 'Mode', keys: 'Ctrl+E', needsDoc: true, run: toggleEdit },
  {
    id: 'mode.toggleSource',
    title: 'Toggle source',
    group: 'Mode',
    keys: 'Ctrl+/',
    needsDoc: true,
    run: withDoc((d) => (d.kind === 'text' ? undefined : app().setMode(d.id, d.mode === 'source' ? 'edit' : 'source'))),
  },

  { id: 'view.palette', title: 'Command palette', group: 'View', keys: 'Ctrl+K', run: () => ui().toggle('palette') },
  { id: 'view.sidebar', title: 'Toggle sidebar', group: 'View', keys: 'Ctrl+B', run: () => app().setSidebar({ sidebarOpen: !app().sidebarOpen }) },
  { id: 'view.outline', title: 'Show outline', group: 'View', keys: 'Ctrl+Shift+L', run: () => app().setSidebar({ sidebarOpen: true, sidebarTab: 'outline' }) },
  { id: 'view.files', title: 'Show files', group: 'View', keys: 'Ctrl+Shift+E', run: () => app().setSidebar({ sidebarOpen: true, sidebarTab: 'files' }) },
  { id: 'view.recent', title: 'Show recent files', group: 'View', keys: 'Ctrl+R', run: () => app().setSidebar({ sidebarOpen: true, sidebarTab: 'recent' }) },
  {
    id: 'view.focus',
    title: 'Focus mode',
    group: 'View',
    keys: 'F11',
    keywords: 'fullscreen zen distraction',
    run: async () => {
      const on = !app().focusMode;
      app().setFocusMode(on);
      await appWindow.setFullscreen(on);
    },
  },
  { id: 'view.zoomIn', title: 'Zoom in', group: 'View', keys: 'Ctrl+=', run: () => app().setZoom(app().zoom + 0.1) },
  { id: 'view.zoomOut', title: 'Zoom out', group: 'View', keys: 'Ctrl+-', run: () => app().setZoom(app().zoom - 0.1) },
  { id: 'view.zoomReset', title: 'Reset zoom', group: 'View', keys: 'Ctrl+0', run: () => app().setZoom(1) },
  {
    id: 'view.wrap',
    title: 'Toggle word wrap',
    group: 'View',
    keys: 'Alt+Z',
    keywords: 'wrap lines plain text',
    run: () => {
      const s = useSettings.getState();
      s.set('sourceWrap', !s.settings.sourceWrap);
      toast.info(`Word wrap ${!s.settings.sourceWrap ? 'on' : 'off'}`, 'Plain text and Source mode');
    },
  },
  {
    id: 'view.typewriter',
    title: 'Toggle typewriter scrolling',
    group: 'View',
    run: () => {
      const s = useSettings.getState();
      s.set('typewriter', !s.settings.typewriter);
      toast.info(`Typewriter scrolling ${!s.settings.typewriter ? 'on' : 'off'}`);
    },
  },
  {
    id: 'view.width',
    title: 'Cycle content width',
    group: 'View',
    keys: 'Ctrl+Shift+W',
    run: () => {
      const s = useSettings.getState();
      const steps = [640, 760, 900, 1100];
      const next = steps.find((w) => w > s.settings.contentWidth) ?? steps[0];
      s.set('contentWidth', next);
    },
  },

  { id: 'go.find', title: 'Find in document', group: 'Go', keys: 'Ctrl+F', needsDoc: true, run: () => ui().openFind(false) },
  { id: 'go.replace', title: 'Find and replace', group: 'Go', keys: 'Ctrl+H', needsDoc: true, run: () => {
      // Replacing works on the raw text, so it lives in Source mode (plain text is always there).
      const d = doc();
      if (d && d.kind === 'markdown') setMode('source');
      ui().openFind(true);
    } },
  {
    id: 'go.line',
    title: 'Go to line…',
    group: 'Go',
    keys: 'Ctrl+G',
    needsDoc: true,
    run: withDoc((d) => {
      if (viewMode(d) !== 'source') setMode('source');
      ui().openPalette(':');
    }),
  },
  { id: 'edit.timeDate', title: 'Insert time and date', group: 'Go', keys: 'F5', needsDoc: true, keywords: 'now today timestamp', run: insertTimeDate },
  ...Array.from({ length: 9 }, (_, i): Command => ({
    id: `go.tab${i + 1}`,
    title: i === 8 ? 'Go to last tab' : `Go to tab ${i + 1}`,
    group: 'Go',
    keys: `Ctrl+${i + 1}`,
    run: () => app().activateIndex(i),
  })),
  { id: 'go.nextTab', title: 'Next tab', group: 'Go', keys: 'Ctrl+Tab', run: () => app().cycle(1) },
  { id: 'go.prevTab', title: 'Previous tab', group: 'Go', keys: 'Ctrl+Shift+Tab', run: () => app().cycle(-1) },
  { id: 'go.top', title: 'Go to top', group: 'Go', needsDoc: true, run: () => ui().jumpTo({ line: 0 }) },

  { id: 'export.html', title: 'Export as HTML…', group: 'Export', needsDoc: true, run: withDoc(exportHtml) },
  { id: 'export.pdf', title: 'Print or save as PDF…', group: 'Export', keys: 'Ctrl+P', needsDoc: true, run: withDoc(printDoc) },
  { id: 'export.copyHtml', title: 'Copy as rich text', group: 'Export', keys: 'Ctrl+Shift+C', needsDoc: true, run: withDoc(copyAsHtml) },
  {
    id: 'export.copyMd',
    title: 'Copy markdown source',
    group: 'Export',
    needsDoc: true,
    run: withDoc(async (d) => {
      await navigator.clipboard.writeText(d.content);
      toast.success('Markdown copied');
    }),
  },

  ...THEMES.map<Command>((t) => ({
    id: `theme.${t.id}`,
    title: `Theme: ${t.name}`,
    group: 'Theme',
    keywords: t.dark ? 'dark colour' : 'light colour',
    run: () => {
      const s = useSettings.getState();
      s.patch(t.dark ? { themeMode: 'dark', darkTheme: t.id } : { themeMode: 'light', lightTheme: t.id });
    },
  })),
  {
    id: 'theme.toggle',
    title: 'Switch between dark and light',
    group: 'Theme',
    run: () => {
      const s = useSettings.getState();
      const dark = s.settings.themeMode === 'dark' || (s.settings.themeMode === 'system' && s.systemDark);
      s.set('themeMode', dark ? 'light' : 'dark');
    },
  },

  { id: 'app.settings', title: 'Settings', group: 'App', keys: 'Ctrl+,', keywords: 'preferences options', run: () => ui().openSettings() },
  { id: 'app.shortcuts', title: 'Keyboard shortcuts', group: 'App', keys: 'Ctrl+Shift+/', run: () => ui().openSettings('shortcuts') },
  { id: 'app.welcome', title: 'Open the welcome tour', group: 'App', keywords: 'help guide sample', run: openTour },
  { id: 'app.quit', title: 'Quit Margin', group: 'App', keys: 'Ctrl+Q', keywords: 'exit close window', run: requestQuit },
];

export const commandById = (id: string) => COMMANDS.find((c) => c.id === id);
export const runCommand = (id: string) => void commandById(id)?.run();

/* ---------- keyboard ---------- */

function eventCombo(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let key = e.key;
  if (key === '+' || e.code === 'Equal') key = '=';
  else if (e.code === 'Minus') key = '-';
  else if (e.code === 'Slash') key = '/';
  else if (e.code === 'Comma') key = ',';
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (key.length === 1) key = key.toUpperCase();
  parts.push(key);
  return parts.join('+');
}

const byCombo = new Map(COMMANDS.filter((c) => c.keys).map((c) => [c.keys as string, c]));

/** Global shortcut handler. Returns true when the event was consumed. */
export function handleShortcut(e: KeyboardEvent): boolean {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return false;
  const combo = eventCombo(e);
  const cmd = byCombo.get(combo);
  if (!cmd) return false;
  // Plain keys never steal typing; every binding here uses Ctrl or a function key.
  if (cmd.needsDoc && !doc()) return false;
  e.preventDefault();
  e.stopPropagation();
  void cmd.run();
  return true;
}
