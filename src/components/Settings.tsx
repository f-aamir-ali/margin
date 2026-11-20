import { AnimatePresence, motion } from 'motion/react';
import {
  BookOpen,
  Check,
  Code2,
  Download,
  FileCog,
  Info,
  Keyboard,
  Palette as PaletteIcon,
  PencilLine,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Type,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { COMMANDS } from '../lib/commands';
import { appInfo, type AppInfo } from '../lib/platform';
import {
  ACCENTS,
  CODE_FONTS,
  DEFAULT_SETTINGS,
  DOC_FONTS,
  PLAIN_FONTS,
  THEMES,
  useSettings,
  type Settings as S,
  type ThemeId,
} from '../lib/settings';
import { useUi, type SettingsSection } from '../lib/ui';
import { Button, IconButton, Keys, Segmented, Select, Slider, SPRING, Switch } from './ui/controls';

type Row =
  | { kind: 'switch'; key: keyof S; label: string; hint?: string }
  | { kind: 'slider'; key: keyof S; label: string; hint?: string; min: number; max: number; step: number; format?: (v: number) => string }
  | { kind: 'select'; key: keyof S; label: string; hint?: string; options: { value: string; label: string; style?: React.CSSProperties }[] }
  | { kind: 'segmented'; key: keyof S; label: string; hint?: string; options: { value: string; label: string }[] }
  | { kind: 'text'; key: keyof S; label: string; hint?: string; placeholder?: string }
  | { kind: 'custom'; id: string; label: string; hint?: string; keys: (keyof S)[]; render: () => React.ReactNode; stacked?: boolean };

interface Group {
  title?: string;
  rows: Row[];
}

const docFontOptions = Object.entries(DOC_FONTS).map(([value, f]) => ({ value, label: f.name, style: { fontFamily: f.stack } }));
const codeFontOptions = Object.entries(CODE_FONTS).map(([value, f]) => ({ value, label: f.name, style: { fontFamily: f.stack } }));
const plainFontOptions = Object.entries(PLAIN_FONTS).map(([value, f]) => ({ value, label: f.name, style: { fontFamily: f.stack } }));

const SECTIONS: { id: SettingsSection; label: string; icon: React.ReactNode; groups: Group[] }[] = [
  {
    id: 'appearance',
    label: 'Appearance',
    icon: <PaletteIcon size={15} />,
    groups: [
      {
        rows: [
          {
            kind: 'segmented',
            key: 'themeMode',
            label: 'Mode',
            hint: 'Follow Windows, or stay dark or light.',
            options: [
              { value: 'dark', label: 'Dark' },
              { value: 'light', label: 'Light' },
              { value: 'system', label: 'Auto' },
            ],
          },
          { kind: 'custom', id: 'themes', label: 'Theme', keys: ['darkTheme', 'lightTheme'], stacked: true, render: () => <ThemePicker /> },
          { kind: 'custom', id: 'accent', label: 'Accent colour', hint: 'Links, selection and highlights.', keys: ['accent'], render: () => <AccentPicker /> },
        ],
      },
      {
        title: 'Window',
        rows: [
          {
            kind: 'segmented',
            key: 'sidebarSide',
            label: 'Sidebar side',
            options: [
              { value: 'left', label: 'Left' },
              { value: 'right', label: 'Right' },
            ],
          },
          { kind: 'switch', key: 'showStatusBar', label: 'Status bar', hint: 'Word count, save state and zoom along the bottom.' },
          { kind: 'switch', key: 'showProgress', label: 'Reading progress line', hint: 'A thin line under the title bar that fills as you scroll.' },
          {
            kind: 'segmented',
            key: 'motion',
            label: 'Animation',
            hint: 'Reduced keeps everything instant.',
            options: [
              { value: 'full', label: 'Full' },
              { value: 'reduced', label: 'Reduced' },
            ],
          },
          { kind: 'switch', key: 'sounds', label: 'Interface sounds', hint: 'A soft tick when you press buttons and flip switches.' },
        ],
      },
    ],
  },
  {
    id: 'typography',
    label: 'Typography',
    icon: <Type size={15} />,
    groups: [
      {
        title: 'Fonts',
        rows: [
          { kind: 'select', key: 'docFont', label: 'Body font', options: docFontOptions },
          { kind: 'select', key: 'headingFont', label: 'Heading font', options: [{ value: 'same', label: 'Same as body' }, ...docFontOptions] },
          { kind: 'select', key: 'codeFont', label: 'Code font', options: codeFontOptions },
          { kind: 'select', key: 'plainFont', label: 'Plain text font', hint: 'For .txt files and plain notes. Code files use the code font.', options: plainFontOptions },
        ],
      },
      {
        title: 'Page',
        rows: [
          { kind: 'slider', key: 'fontSize', label: 'Text size', min: 13, max: 24, step: 1, format: (v) => `${v} px` },
          { kind: 'slider', key: 'lineHeight', label: 'Line height', min: 1.3, max: 2.1, step: 0.05, format: (v) => v.toFixed(2) },
          { kind: 'slider', key: 'contentWidth', label: 'Line width', hint: 'How wide the text column may grow.', min: 520, max: 1400, step: 20, format: (v) => `${v} px` },
          { kind: 'slider', key: 'paragraphSpacing', label: 'Paragraph spacing', min: 0.4, max: 1.8, step: 0.1, format: (v) => `${v.toFixed(1)} em` },
          { kind: 'switch', key: 'justify', label: 'Justify text', hint: 'Align both edges of each paragraph.' },
          { kind: 'switch', key: 'hyphens', label: 'Hyphenate', hint: 'Break long words at line ends.' },
          {
            kind: 'segmented',
            key: 'headingStyle',
            label: 'Headings',
            options: [
              { value: 'clean', label: 'Clean' },
              { value: 'underlined', label: 'Ruled' },
              { value: 'numbered', label: 'Numbered' },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'reading',
    label: 'Reading',
    icon: <BookOpen size={15} />,
    groups: [
      {
        rows: [
          {
            kind: 'select',
            key: 'defaultMode',
            label: 'Open files in',
            hint: 'Reading mode never shows a caret and never changes the file.',
            options: [
              { value: 'read', label: 'Reading mode' },
              { value: 'edit', label: 'Editing mode' },
              { value: 'source', label: 'Source mode' },
              { value: 'last', label: 'Whatever I used last' },
            ],
          },
          { kind: 'switch', key: 'smoothScroll', label: 'Smooth scrolling', hint: 'Glide to headings and search results.' },
          { kind: 'switch', key: 'zoomImages', label: 'Click images to enlarge' },
        ],
      },
      {
        title: 'Code blocks',
        rows: [
          { kind: 'switch', key: 'codeLineNumbers', label: 'Line numbers' },
          { kind: 'switch', key: 'codeWrap', label: 'Wrap long lines', hint: 'Off scrolls sideways instead.' },
          { kind: 'switch', key: 'codeLigatures', label: 'Font ligatures', hint: 'Join => and != into single glyphs where the font supports it.' },
        ],
      },
    ],
  },
  {
    id: 'editor',
    label: 'Editor',
    icon: <PencilLine size={15} />,
    groups: [
      {
        title: 'Editing mode',
        rows: [
          { kind: 'switch', key: 'smoothCaret', label: 'Gliding caret', hint: 'The cursor slides between positions instead of jumping.' },
          { kind: 'switch', key: 'slashMenu', label: 'Slash menu and block handles', hint: 'Type / on an empty line to insert a table, image, code or math block.' },
          { kind: 'switch', key: 'selectionToolbar', label: 'Selection toolbar', hint: 'Bold, italic, link and more appear above selected text.' },
          { kind: 'switch', key: 'typewriter', label: 'Typewriter scrolling', hint: 'Keep the line you are typing at a steady height.' },
          { kind: 'switch', key: 'focusParagraph', label: 'Dim other paragraphs', hint: 'Only the block you are writing stays at full strength.' },
          { kind: 'switch', key: 'spellcheck', label: 'Spell check' },
        ],
      },
      {
        title: 'Source mode',
        rows: [
          { kind: 'switch', key: 'sourceLineNumbers', label: 'Line numbers' },
          { kind: 'switch', key: 'sourceWrap', label: 'Wrap long lines', hint: 'Also plain text. Alt+Z switches it anywhere.' },
        ],
      },
      {
        title: 'Plain text and notes',
        rows: [
          {
            kind: 'segmented',
            key: 'newNoteKind',
            label: 'New notes are',
            hint: 'What Ctrl+N makes. Ctrl+Alt+N always makes plain text.',
            options: [
              { value: 'markdown', label: 'Markdown' },
              { value: 'text', label: 'Plain text' },
            ],
          },
          { kind: 'switch', key: 'plainLineNumbers', label: 'Line numbers in plain text' },
        ],
      },
    ],
  },
  {
    id: 'markdown',
    label: 'Markdown',
    icon: <Code2 size={15} />,
    groups: [
      {
        title: 'Reading mode rendering',
        rows: [
          { kind: 'switch', key: 'math', label: 'Math', hint: 'Render $inline$ and $$block$$ LaTeX with KaTeX.' },
          { kind: 'switch', key: 'diagrams', label: 'Diagrams', hint: 'Draw ```mermaid blocks as flowcharts, sequences and more.' },
          { kind: 'switch', key: 'emoji', label: 'Emoji shortcodes', hint: 'Turn :rocket: into 🚀.' },
          { kind: 'switch', key: 'linkify', label: 'Link bare URLs', hint: 'https://example.com becomes clickable without brackets.' },
          { kind: 'switch', key: 'breaks', label: 'Single line breaks', hint: 'Treat every newline as a line break, not only blank lines.' },
          { kind: 'switch', key: 'typographer', label: 'Smart punctuation', hint: 'Curly quotes, en and em dashes, ellipses.' },
          { kind: 'switch', key: 'rawHtml', label: 'Inline HTML', hint: 'Render safe HTML tags. Scripts are always removed.' },
        ],
      },
    ],
  },
  {
    id: 'files',
    label: 'Files',
    icon: <FileCog size={15} />,
    groups: [
      {
        title: 'Saving',
        rows: [
          {
            kind: 'select',
            key: 'autoSave',
            label: 'Auto-save',
            hint: 'Files you only read are never rewritten.',
            options: [
              { value: 'off', label: 'Off' },
              { value: 'delay', label: 'After I stop typing' },
              { value: 'blur', label: 'When the window loses focus' },
            ],
          },
          { kind: 'slider', key: 'autoSaveDelay', label: 'Auto-save delay', min: 1, max: 10, step: 1, format: (v) => `${v} s` },
          { kind: 'switch', key: 'finalNewline', label: 'End files with a newline' },
          { kind: 'switch', key: 'trimTrailingWhitespace', label: 'Trim trailing spaces on save', hint: 'Two-space line breaks are kept.' },
          { kind: 'switch', key: 'confirmClose', label: 'Ask before closing an unsaved tab', hint: 'Closing the window never asks: every tab comes back next time, saved or not.' },
        ],
      },
      {
        title: 'Opening',
        rows: [
          { kind: 'switch', key: 'restoreSession', label: 'Reopen last session', hint: 'Bring back the tabs you had open.' },
          { kind: 'switch', key: 'autoReload', label: 'Reload when a file changes on disk', hint: 'Only when you have no unsaved edits.' },
          { kind: 'text', key: 'imageFolder', label: 'Pasted images folder', hint: 'Relative to the document. Leave empty to save beside it.', placeholder: 'assets' },
        ],
      },
    ],
  },
  {
    id: 'export',
    label: 'Export',
    icon: <Download size={15} />,
    groups: [
      {
        rows: [
          {
            kind: 'segmented',
            key: 'exportTheme',
            label: 'HTML export theme',
            options: [
              { value: 'paper', label: 'Paper' },
              { value: 'current', label: 'Current' },
            ],
          },
          { kind: 'switch', key: 'exportIncludeTitle', label: 'Add the file name as a title' },
          {
            kind: 'segmented',
            key: 'printMargins',
            label: 'Print margins',
            hint: 'Used for printing and Save as PDF.',
            options: [
              { value: 'narrow', label: 'Narrow' },
              { value: 'normal', label: 'Normal' },
              { value: 'wide', label: 'Wide' },
            ],
          },
        ],
      },
    ],
  },
  { id: 'shortcuts', label: 'Shortcuts', icon: <Keyboard size={15} />, groups: [] },
  {
    id: 'advanced',
    label: 'Advanced',
    icon: <SlidersHorizontal size={15} />,
    groups: [
      {
        rows: [
          {
            kind: 'custom',
            id: 'customCss',
            label: 'Custom CSS',
            hint: 'Applied on top of the theme. Target .prose for the document.',
            keys: ['customCss'],
            stacked: true,
            render: () => <CustomCss />,
          },
        ],
      },
    ],
  },
  { id: 'about', label: 'About', icon: <Info size={15} />, groups: [] },
];

export function SettingsPanel() {
  const section = useUi((s) => s.settings) ?? 'appearance';
  const close = () => useUi.getState().close('settings');
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  const searchResults = useMemo(() => {
    if (!q) return null;
    const out: { section: string; row: Row }[] = [];
    for (const sec of SECTIONS) {
      for (const g of sec.groups) {
        for (const row of g.rows) {
          if (`${row.label} ${row.hint ?? ''} ${g.title ?? ''} ${sec.label}`.toLowerCase().includes(q)) out.push({ section: sec.label, row });
        }
      }
    }
    return out;
  }, [q]);

  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];

  return (
    <motion.div
      className="overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.14 } }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <motion.div
        className="settings popover"
        role="dialog"
        aria-label="Settings"
        initial={{ opacity: 0, y: 18, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 10, scale: 0.98, transition: { duration: 0.14 } }}
        transition={SPRING}
      >
        <nav className="settings-nav">
          <div className="settings-search">
            <Search size={14} />
            <input placeholder="Search settings" spellCheck={false} value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          {SECTIONS.map((s) => {
            const on = !q && s.id === current.id;
            return (
              <button
                key={s.id}
                type="button"
                className="settings-nav-item"
                data-on={on || undefined}
                onClick={() => {
                  setQuery('');
                  useUi.getState().openSettings(s.id);
                }}
              >
                {on && <motion.span layoutId="settings-nav" className="settings-nav-bg" transition={SPRING} />}
                <span className="settings-nav-icon">{s.icon}</span>
                <span>{s.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="settings-main">
          <header className="settings-head">
            <h2>{searchResults ? `Results for “${query.trim()}”` : current.label}</h2>
            <IconButton label="Close" keys="Esc" onClick={close}>
              <X size={16} />
            </IconButton>
          </header>
          <div className="settings-scroll">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={searchResults ? 'search' : current.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: { duration: 0.07 } }}
                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              >
                {searchResults ? (
                  searchResults.length ? (
                    <div className="settings-group">
                      {searchResults.map(({ row, section: sec }) => (
                        <SettingRow key={`${sec}-${rowId(row)}`} row={row} tag={sec} />
                      ))}
                    </div>
                  ) : (
                    <p className="settings-none">No settings match.</p>
                  )
                ) : current.id === 'shortcuts' ? (
                  <Shortcuts />
                ) : current.id === 'about' ? (
                  <About />
                ) : (
                  <>
                    {current.groups.map((g, i) => (
                      <section key={i}>
                        {g.title && <h3 className="settings-group-title">{g.title}</h3>}
                        <div className="settings-group">
                          {g.rows.map((row) => (
                            <SettingRow key={rowId(row)} row={row} />
                          ))}
                        </div>
                      </section>
                    ))}
                    <SectionReset groups={current.groups} />
                  </>
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

const rowId = (row: Row) => (row.kind === 'custom' ? row.id : row.key);
const rowKeys = (row: Row): (keyof S)[] => (row.kind === 'custom' ? row.keys : [row.key]);

function SettingRow({ row, tag }: { row: Row; tag?: string }) {
  const settings = useSettings((s) => s.settings);
  const set = useSettings((s) => s.set);
  const stacked = row.kind === 'custom' && row.stacked;
  const disabled = row.kind !== 'custom' && row.key === 'autoSaveDelay' && settings.autoSave !== 'delay';

  let control: React.ReactNode;
  if (row.kind === 'switch') {
    control = <Switch label={row.label} checked={settings[row.key] as boolean} onChange={(v) => set(row.key, v as never)} />;
  } else if (row.kind === 'slider') {
    control = (
      <Slider label={row.label} value={settings[row.key] as number} min={row.min} max={row.max} step={row.step} format={row.format} onChange={(v) => set(row.key, v as never)} />
    );
  } else if (row.kind === 'select') {
    control = <Select label={row.label} value={settings[row.key] as string} options={row.options} onChange={(v) => set(row.key, v as never)} />;
  } else if (row.kind === 'segmented') {
    control = <Segmented ariaLabel={row.label} size="sm" value={settings[row.key] as string} options={row.options} onChange={(v) => set(row.key, v as never)} />;
  } else if (row.kind === 'text') {
    control = (
      <input
        className="text-input"
        aria-label={row.label}
        spellCheck={false}
        placeholder={row.placeholder}
        value={settings[row.key] as string}
        onChange={(e) => set(row.key, e.target.value.replace(/[<>:"|?*]/g, '') as never)}
      />
    );
  } else {
    control = row.render();
  }

  return (
    <div className="setting" data-stacked={stacked || undefined} data-disabled={disabled || undefined}>
      <div className="setting-text">
        <span className="setting-label">
          {row.label}
          {tag && <span className="setting-tag">{tag}</span>}
        </span>
        {row.hint && <span className="setting-hint">{row.hint}</span>}
      </div>
      <div className="setting-control">{control}</div>
    </div>
  );
}

function SectionReset({ groups }: { groups: Group[] }) {
  const settings = useSettings((s) => s.settings);
  const reset = useSettings((s) => s.reset);
  const keys = groups.flatMap((g) => g.rows.flatMap(rowKeys));
  const changed = keys.some((k) => settings[k] !== DEFAULT_SETTINGS[k]);
  return (
    <div className="settings-reset">
      <Button variant="ghost" size="sm" disabled={!changed} onClick={() => reset(keys)}>
        <RotateCcw size={13} /> Reset this page
      </Button>
    </div>
  );
}

function ThemePicker() {
  const settings = useSettings((s) => s.settings);
  const systemDark = useSettings((s) => s.systemDark);
  const patch = useSettings((s) => s.patch);
  const dark = settings.themeMode === 'dark' || (settings.themeMode === 'system' && systemDark);
  const active: ThemeId = dark ? settings.darkTheme : settings.lightTheme;
  return (
    <div className="theme-grid">
      {THEMES.map((t) => {
        const on = t.id === active;
        return (
          <button
            key={t.id}
            type="button"
            className="theme-card"
            data-on={on || undefined}
            aria-pressed={on}
            onClick={() => patch(t.dark ? { darkTheme: t.id, themeMode: settings.themeMode === 'system' && systemDark ? 'system' : 'dark' } : { lightTheme: t.id, themeMode: settings.themeMode === 'system' && !systemDark ? 'system' : 'light' })}
          >
            <span className="theme-preview" style={{ background: t.swatch[0] }}>
              <span className="theme-preview-page" style={{ background: t.swatch[1] }}>
                <i style={{ background: t.swatch[2], width: '46%', opacity: 0.9 }} />
                <i style={{ background: t.swatch[2], width: '82%', opacity: 0.35 }} />
                <i style={{ background: t.swatch[2], width: '64%', opacity: 0.35 }} />
              </span>
            </span>
            <span className="theme-name">
              {t.name}
              {on && (
                <motion.span className="theme-check" initial={{ scale: 0 }} animate={{ scale: 1 }} transition={SPRING}>
                  <Check size={11} strokeWidth={3} />
                </motion.span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function AccentPicker() {
  const accent = useSettings((s) => s.settings.accent);
  const set = useSettings((s) => s.set);
  return (
    <div className="accents">
      {ACCENTS.map((a) => (
        <button
          key={a.value}
          type="button"
          className="accent-dot"
          aria-label={a.name}
          data-tip={a.name}
          data-tip-side="top"
          data-on={a.value === accent || undefined}
          style={{ '--dot': a.value } as React.CSSProperties}
          onClick={() => set('accent', a.value)}
        />
      ))}
    </div>
  );
}

function CustomCss() {
  const css = useSettings((s) => s.settings.customCss);
  const set = useSettings((s) => s.set);
  return (
    <textarea
      className="css-input"
      spellCheck={false}
      placeholder={'.prose h1 {\n  letter-spacing: -0.03em;\n}'}
      value={css}
      onChange={(e) => set('customCss', e.target.value)}
    />
  );
}

function Shortcuts() {
  const groups = useMemo(() => {
    const map = new Map<string, typeof COMMANDS>();
    for (const c of COMMANDS) {
      if (!c.keys) continue;
      map.set(c.group, [...(map.get(c.group) ?? []), c]);
    }
    return Array.from(map.entries());
  }, []);
  const typing: [string, string][] = [
    ['# then space', 'Heading (## for level 2, up to ######)'],
    ['> then space', 'Quote'],
    ['- or * then space', 'Bullet list'],
    ['1. then space', 'Numbered list'],
    ['[ ] then space', 'Task (inside a list)'],
    ['``` then space', 'Code block'],
    ['--- then Enter', 'Divider'],
    ['**text**', 'Bold'],
    ['*text*', 'Italic'],
    ['~~text~~', 'Strikethrough'],
    ['`text`', 'Inline code'],
    ['$text$', 'Inline math'],
    ['/', 'Insert menu (on an empty line)'],
  ];
  return (
    <>
      {groups.map(([group, cmds]) => (
        <section key={group}>
          <h3 className="settings-group-title">{group}</h3>
          <div className="settings-group">
            {cmds.map((c) => (
              <div key={c.id} className="setting shortcut">
                <span className="setting-label">{c.title}</span>
                <Keys combo={c.keys as string} />
              </div>
            ))}
          </div>
        </section>
      ))}
      <section>
        <h3 className="settings-group-title">While typing in Editing mode</h3>
        <div className="settings-group">
          {typing.map(([k, v]) => (
            <div key={k} className="setting shortcut">
              <span className="setting-label">{v}</span>
              <code className="shortcut-code">{k}</code>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

function About() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const reset = useSettings((s) => s.reset);
  useEffect(() => void appInfo().then(setInfo), []);
  return (
    <div className="about">
      <p className="about-name">Margin</p>
      <p className="about-version">Version {info?.version ?? '…'}</p>
      <p className="about-text">
        A local reader and live editor for Markdown files. Margin has no account or telemetry. Documents can load remote
        images when they link to them.
      </p>
      <div className="settings-group">
        <div className="setting">
          <div className="setting-text">
            <span className="setting-label">Settings location</span>
            <span className="setting-hint about-path">{info?.configDir ?? ''}</span>
          </div>
        </div>
        <div className="setting">
          <div className="setting-text">
            <span className="setting-label">Reset everything</span>
            <span className="setting-hint">Put every setting back to how it shipped.</span>
          </div>
          <div className="setting-control">
            <Button variant="danger" size="sm" onClick={() => reset()}>
              Reset all
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
