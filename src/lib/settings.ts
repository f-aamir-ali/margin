import { create } from 'zustand';
import { emitToAll, storeGet, storeSet, windowLabel } from './platform';

export type ThemeId = 'carbon' | 'graphite' | 'midnight' | 'ember' | 'paper' | 'linen' | 'sepia' | 'mist';
export type ViewMode = 'read' | 'edit' | 'source';

export interface Settings {
  // Appearance
  themeMode: 'dark' | 'light' | 'system';
  darkTheme: ThemeId;
  lightTheme: ThemeId;
  accent: string;
  motion: 'full' | 'reduced';
  sounds: boolean;
  sidebarSide: 'left' | 'right';
  showStatusBar: boolean;
  showProgress: boolean;
  // Typography
  docFont: string;
  headingFont: string;
  codeFont: string;
  fontSize: number;
  lineHeight: number;
  contentWidth: number;
  paragraphSpacing: number;
  justify: boolean;
  hyphens: boolean;
  headingStyle: 'clean' | 'underlined' | 'numbered';
  // Reading
  defaultMode: ViewMode | 'last';
  smoothScroll: boolean;
  zoomImages: boolean;
  /** Off: notes can't contact websites when opened. Blocked images show as their alt text. */
  remoteImages: boolean;
  // Editor
  spellcheck: boolean;
  smoothCaret: boolean;
  typewriter: boolean;
  focusParagraph: boolean;
  slashMenu: boolean;
  selectionToolbar: boolean;
  sourceLineNumbers: boolean;
  sourceWrap: boolean;
  // Plain text (.txt, .log, code)
  plainFont: string;
  plainLineNumbers: boolean;
  /** What Ctrl+N makes. */
  newNoteKind: 'markdown' | 'text';
  // Markdown
  breaks: boolean;
  linkify: boolean;
  typographer: boolean;
  emoji: boolean;
  math: boolean;
  diagrams: boolean;
  rawHtml: boolean;
  // Code
  codeLineNumbers: boolean;
  codeWrap: boolean;
  codeLigatures: boolean;
  // Files
  autoSave: 'off' | 'delay' | 'blur';
  autoSaveDelay: number;
  autoReload: boolean;
  restoreSession: boolean;
  confirmClose: boolean;
  imageFolder: string;
  trimTrailingWhitespace: boolean;
  finalNewline: boolean;
  // Export
  exportTheme: 'current' | 'paper';
  exportIncludeTitle: boolean;
  printMargins: 'narrow' | 'normal' | 'wide';
  // Advanced
  customCss: string;
}

export const DEFAULT_SETTINGS: Settings = {
  themeMode: 'dark',
  darkTheme: 'carbon',
  lightTheme: 'paper',
  accent: '#6aa3ff',
  motion: 'full',
  sounds: false,
  sidebarSide: 'left',
  showStatusBar: true,
  showProgress: true,
  docFont: 'geist',
  headingFont: 'same',
  codeFont: 'geist-mono',
  fontSize: 17,
  lineHeight: 1.7,
  contentWidth: 760,
  paragraphSpacing: 1,
  justify: false,
  hyphens: false,
  headingStyle: 'clean',
  defaultMode: 'read',
  smoothScroll: true,
  zoomImages: true,
  remoteImages: true,
  spellcheck: false,
  smoothCaret: true,
  typewriter: false,
  focusParagraph: false,
  slashMenu: true,
  selectionToolbar: true,
  sourceLineNumbers: true,
  sourceWrap: true,
  plainFont: 'ia-mono',
  plainLineNumbers: false,
  newNoteKind: 'markdown',
  breaks: false,
  linkify: true,
  typographer: false,
  emoji: true,
  math: true,
  diagrams: true,
  rawHtml: true,
  codeLineNumbers: false,
  codeWrap: false,
  codeLigatures: true,
  autoSave: 'off',
  autoSaveDelay: 2,
  autoReload: true,
  restoreSession: true,
  confirmClose: true,
  imageFolder: 'assets',
  trimTrailingWhitespace: false,
  finalNewline: true,
  exportTheme: 'paper',
  exportIncludeTitle: false,
  printMargins: 'normal',
  customCss: '',
};

export const THEMES: { id: ThemeId; name: string; dark: boolean; swatch: [string, string, string] }[] = [
  { id: 'carbon', name: 'Carbon', dark: true, swatch: ['#090909', '#141414', '#f4f4f4'] },
  { id: 'graphite', name: 'Graphite', dark: true, swatch: ['#17181a', '#1f2023', '#f1f2f4'] },
  { id: 'midnight', name: 'Midnight', dark: true, swatch: ['#070a12', '#0e1320', '#eef2ff'] },
  { id: 'ember', name: 'Ember', dark: true, swatch: ['#0f0d0b', '#191613', '#f1e8dc'] },
  { id: 'paper', name: 'Paper', dark: false, swatch: ['#ececec', '#ffffff', '#141414'] },
  { id: 'linen', name: 'Linen', dark: false, swatch: ['#e9e4dc', '#fbf9f5', '#1f1b16'] },
  { id: 'sepia', name: 'Sepia', dark: false, swatch: ['#e6dcc8', '#f6eedd', '#2e2416'] },
  { id: 'mist', name: 'Mist', dark: false, swatch: ['#dfe4ea', '#f5f7fa', '#131a24'] },
];

export const ACCENTS = [
  { name: 'Blue', value: '#6aa3ff' },
  { name: 'Violet', value: '#a78bfa' },
  { name: 'Pink', value: '#f472b6' },
  { name: 'Red', value: '#f87171' },
  { name: 'Orange', value: '#fb923c' },
  { name: 'Amber', value: '#fbbf24' },
  { name: 'Green', value: '#4ade80' },
  { name: 'Teal', value: '#2dd4bf' },
  { name: 'Mono', value: '#d4d4d4' },
];

export const DOC_FONTS: Record<string, { name: string; stack: string; kind: 'sans' | 'serif' }> = {
  geist: { name: 'Geist', stack: "'Geist Variable', 'Segoe UI', system-ui, sans-serif", kind: 'sans' },
  quattro: { name: 'iA Writer Quattro', stack: "'iA Writer Quattro', 'Segoe UI', system-ui, sans-serif", kind: 'sans' },
  inter: { name: 'Inter', stack: "'Inter Variable', 'Segoe UI', system-ui, sans-serif", kind: 'sans' },
  atkinson: { name: 'Atkinson Hyperlegible', stack: "'Atkinson Hyperlegible', 'Segoe UI', sans-serif", kind: 'sans' },
  system: { name: 'Segoe UI', stack: "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif", kind: 'sans' },
  newsreader: { name: 'Newsreader', stack: "'Newsreader Variable', Georgia, serif", kind: 'serif' },
  literata: { name: 'Literata', stack: "'Literata Variable', Georgia, serif", kind: 'serif' },
  'source-serif': { name: 'Source Serif', stack: "'Source Serif 4 Variable', Georgia, serif", kind: 'serif' },
  lora: { name: 'Lora', stack: "'Lora Variable', Georgia, serif", kind: 'serif' },
  georgia: { name: 'Georgia', stack: 'Georgia, Cambria, serif', kind: 'serif' },
};

export const CODE_FONTS: Record<string, { name: string; stack: string }> = {
  'geist-mono': { name: 'Geist Mono', stack: "'Geist Mono Variable', Consolas, monospace" },
  jetbrains: { name: 'JetBrains Mono', stack: "'JetBrains Mono Variable', Consolas, monospace" },
  cascadia: { name: 'Cascadia Code', stack: "'Cascadia Code', 'Cascadia Mono', Consolas, monospace" },
  consolas: { name: 'Consolas', stack: 'Consolas, monospace' },
};

/** Plain text (.txt and notes). Code files always use the code font so columns line up. */
export const PLAIN_FONTS: Record<string, { name: string; stack: string }> = {
  'ia-mono': { name: 'iA Writer Mono', stack: "'iA Writer Mono', 'Cascadia Mono', Consolas, monospace" },
  'ia-duo': { name: 'iA Writer Duo', stack: "'iA Writer Duo', 'Cascadia Mono', Consolas, monospace" },
  'ia-quattro': { name: 'iA Writer Quattro', stack: "'iA Writer Quattro', 'Segoe UI', sans-serif" },
  code: { name: 'Same as code font', stack: 'var(--font-mono)' },
  doc: { name: 'Same as body font', stack: 'var(--font-doc)' },
  consolas: { name: 'Consolas (Notepad)', stack: 'Consolas, monospace' },
};

interface SettingsStore {
  settings: Settings;
  loaded: boolean;
  systemDark: boolean;
  load: () => Promise<void>;
  /** Reads the settings again (another window changed them). */
  reload: () => Promise<void>;
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  patch: (partial: Partial<Settings>) => void;
  reset: (keys?: (keyof Settings)[]) => void;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function persist(settings: Settings) {
  clearTimeout(saveTimer);
  // Other windows read the new settings once they are on disk.
  saveTimer = setTimeout(() => void storeSet('settings', settings).then(() => emitToAll('settings-changed', windowLabel)), 250);
}

const media = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: dark)') : null;

export const useSettings = create<SettingsStore>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  systemDark: media?.matches ?? true,
  async load() {
    await get().reload();
    media?.addEventListener('change', (e) => set({ systemDark: e.matches }));
  },
  async reload() {
    const saved = await storeGet<Partial<Settings>>('settings');
    const merged = { ...DEFAULT_SETTINGS };
    if (saved && typeof saved === 'object') {
      for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
        const v = saved[key];
        if (v !== undefined && typeof v === typeof DEFAULT_SETTINGS[key]) {
          (merged as Record<string, unknown>)[key] = v;
        }
      }
    }
    set({ settings: merged, loaded: true });
  },
  set(key, value) {
    const settings = { ...get().settings, [key]: value };
    set({ settings });
    persist(settings);
  },
  patch(partial) {
    const settings = { ...get().settings, ...partial };
    set({ settings });
    persist(settings);
  },
  reset(keys) {
    const current = get().settings;
    const settings = keys
      ? { ...current, ...Object.fromEntries(keys.map((k) => [k, DEFAULT_SETTINGS[k]])) }
      : { ...DEFAULT_SETTINGS };
    set({ settings });
    persist(settings);
  },
}));

export function activeTheme(s: Settings, systemDark: boolean): ThemeId {
  const dark = s.themeMode === 'dark' || (s.themeMode === 'system' && systemDark);
  return dark ? s.darkTheme : s.lightTheme;
}

export function isDarkTheme(id: ThemeId): boolean {
  return THEMES.find((t) => t.id === id)?.dark ?? true;
}

/** Pick black or white ink for text placed on the accent colour. */
function inkFor(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#0a0a0a' : '#ffffff';
}

/** Push settings into CSS variables / attributes on <html>. */
export function applySettings(s: Settings, systemDark: boolean) {
  const root = document.documentElement;
  const theme = activeTheme(s, systemDark);
  root.dataset.theme = theme;
  root.dataset.motion = s.motion;
  root.dataset.headings = s.headingStyle;
  root.dataset.codeWrap = String(s.codeWrap);
  root.dataset.caret = s.smoothCaret ? 'smooth' : 'native';
  root.dataset.focusPara = String(s.focusParagraph);
  const st = root.style;
  // Light themes need a deeper accent to stay readable on white.
  st.setProperty('--accent', isDarkTheme(theme) ? s.accent : `color-mix(in srgb, ${s.accent} 72%, #000)`);
  st.setProperty('--accent-ink', isDarkTheme(theme) ? inkFor(s.accent) : '#ffffff');
  const doc = DOC_FONTS[s.docFont] ?? DOC_FONTS.geist;
  st.setProperty('--font-doc', doc.stack);
  st.setProperty('--font-heading', s.headingFont === 'same' ? doc.stack : (DOC_FONTS[s.headingFont] ?? doc).stack);
  st.setProperty('--font-mono', (CODE_FONTS[s.codeFont] ?? CODE_FONTS['geist-mono']).stack);
  st.setProperty('--font-plain', (PLAIN_FONTS[s.plainFont] ?? PLAIN_FONTS['ia-mono']).stack);
  st.setProperty('--doc-size', `${s.fontSize}px`);
  st.setProperty('--doc-leading', String(s.lineHeight));
  st.setProperty('--doc-width', `${s.contentWidth}px`);
  st.setProperty('--doc-para-gap', `${s.paragraphSpacing}em`);
  st.setProperty('--doc-align', s.justify ? 'justify' : 'start');
  st.setProperty('--doc-hyphens', s.hyphens ? 'auto' : 'manual');
  st.setProperty('--code-ligatures', s.codeLigatures ? 'normal' : 'none');

  let style = document.getElementById('custom-css') as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = 'custom-css';
    document.head.appendChild(style);
  }
  if (style.textContent !== s.customCss) style.textContent = s.customCss;
}
