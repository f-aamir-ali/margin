# Architecture

*How Margin fits together (named MD Viewer until 2026-11-17). Update when structure changes; keep it short.*

## Shape
- **Rust (Tauri 2), `src-tauri/`**: file IO, file watching, single instance, settings storage, window. No markdown logic.
- **Web UI (React 19 + TS, `src/`)** in WebView2: everything the user sees.
- `src/lib/platform.ts` is the only bridge. In a plain browser (`npm run dev`) it falls back to `fetch` + `localStorage`, so the whole UI can be developed and screenshot-tested without Rust.

## Two kinds of document (`Doc.kind`)
- `markdown` (`.md` and friends): the three modes below.
- `text` (everything else: `.txt`, `.log`, code, config): one view, `Source.tsx` in plain styling (`data-plain`), never reformatted. Code files get CodeMirror language colouring (`LanguageDescription.matchFilename`) and run full width (`data-wide`). "Format as markdown" flips a tab to `markdown`; the choice is remembered per file (`file-kinds` store key). Files over 5 MB always open as `text`.
- `viewMode(doc)` in `store.ts` gives what is actually shown (`text` → `source`). Use it, not `doc.mode`, when deciding what is on screen.

## The three modes (markdown only, `Doc.mode`)
| Mode | Component | Engine | Writes the file? |
|---|---|---|---|
| Read | `Reader.tsx` | `lib/markdown.ts` (markdown-it + plugins → sanitised HTML) then `lib/enhance.ts` (Mermaid, copy buttons) | Never, except ticking a task checkbox (edits that one line) |
| Edit | `Editor.tsx` | Milkdown **Crepe** (ProseMirror). Input rules give the snap-as-you-type behaviour | Only after a real edit |
| Source | `Source.tsx` | CodeMirror 6 | Only after a real edit |

`Editor` and `Source` are lazy chunks; Reading mode is the default so cold start stays light.
While Edit prepares, the previous view stays visible. The active tab keeps one rich editor for its current document revision. Changing the document in Source invalidates that instance, and switching tabs releases it.

In Read, headings open in place and web links go to the default browser. Relative file references resolve against the current note. Local images, notes and other supported file types go through the native `open_linked_file` command to the Windows default app.

## Never rewriting an untouched file (the core rule)
- `Doc.content` is the current text, `Doc.saved` is what is on disk. Dirty = they differ.
- The WYSIWYG editor always re-serialises markdown (bullets, table padding, setext → ATX…). `Editor.tsx` captures the untouched ProseMirror document as a **baseline** and delays serialising it until the first real edit. Output that matches the baseline restores the original bytes, including after undo.
- Adapters in `lib/editorText.ts`:
  - `toEditor`: rewrites `$$x$$` / `$$\begin…` so `$$` sits on its own line (the editor otherwise reads an unterminated block that swallows the rest of the document).
  - `fromEditor`: un-escapes `> [!NOTE]` alerts and `[toc]` and drops the editor's `<br />` empty-paragraph placeholders, line by line and never inside a fenced code block. `splitFrontMatter` uses the same rule as Read. `extractDataImages` turns images pasted into an untitled note into files on its first Save As.
- Front matter is cut off before the editor sees it and glued back on output. Both editors honour the document's selected line ending, even before it has a newline.
- Encodings: Rust decodes any file (`encoding_rs` + `chardetng`: BOM, then UTF-8, then the likeliest legacy code page) and returns `encoding` + `bom`; saving encodes back the same way and refuses (`UNMAPPABLE:`) rather than writing escapes. Mixed line endings are normalised to the majority on read (`normaliseEol` in `platform.ts`); `Source.tsx` declares CRLF/CR to CodeMirror so it never converts them. Files with NUL bytes are refused (`BINARY:`) unless opened anyway, then read-only.
- `lib/editorMarks.ts`: adds `==highlight==` and `^sup^` marks, and replaces Crepe's image-block schema, which otherwise overwrites image alt text with a display ratio.
- Check after any editor change: `scratchpad roundtrip.mjs` idea = open sample in Edit mode, read `window.__mdvEditor()` (dev only), render original vs round-tripped with `renderMarkdown`, compare block text. Both samples currently differ in 0 blocks.

## Known editor limits (accepted)
- On save after an edit, reference-style links become inline links, setext headings become `#` headings, tables get padded. Rendering is unchanged.
- `~x~` is strikethrough in both modes. Use `<sub>` for subscript.
- Image resize in the editor is visual only (markdown has no size syntax).

## Hot exit: nothing typed is ever lost (the second core rule)
- Every tab has a stable `Doc.id`. Untitled tabs, and file tabs with unsaved edits, each keep `<config>/drafts/<id>.json` (Rust `draft_write` / `draft_delete` / `draft_list`, atomic writes). A store subscription (`syncDrafts`) writes ~0.7 s after typing stops, at most 2 s apart while typing continues, and immediately on window blur, hide and close (`flushAll`).
- The WYSIWYG editor reports text after a ~200 ms pause. `Editor.tsx` tracks outstanding changes and registers a flusher in `store.liveEditors`. Save, close, quit and mode switches flush before proceeding. The editor also flushes on unmount and checks its revision before updating the store. **Anything new that reads `doc.content` for saving or closing must call `flushEditors()` first.**
- `session.json` (version 2) lists tab ids in order, active id, mode, kind, encoding. On launch each tab is rebuilt from its file plus its draft. A file draft stores `savedHash` (hash of the disk text it was based on): if the file changed while Margin was closed, the draft is shown and a conflict toast offers the disk version. Drafts the session doesn't list are restored at the end; unreadable ones are renamed `.bad`.
- Closing the window flushes drafts and the session before destroying it. If a write fails, Margin reports the failure and keeps the window open. Closing a tab prompts if dirty; closed tabs (with unsaved text) go to the `closed` store key (20 kept, 30 days) for Ctrl+Shift+T.
- Untitled tabs are named after their first line (`noteTitle` / `displayName`).
- Second launch: see `open-files` below; with no files (Win+R `note` while running) it gives a blank note (`newDocIfNeeded`).

## Saving safely (the third core rule)
- Every file tab remembers the disk `version` its `saved` text came from. `save` sends it; if another program changed the file, Rust refuses with `CONFLICT:` and the tab is marked `conflict`. A tab whose file was missing or unreadable sends `absent`, so a file that has reappeared is never overwritten unseen.
- Conflicts resolve through `resolveConflict(id, how)` (status bar menu): `compare` opens the disk version as a read-only `transient` tab, `overwrite` saves with `force`, `disk` takes the file's text after putting yours in closed tabs, `copy` is Save As. Reload over unsaved edits goes through `disk` too.
- Restore distinguishes `NOTFOUND` (tab `missing`) from any other read error (tab `diskError`, Retry via `retryDisk`). `canAutosave` refuses conflict, missing, unreadable, lossy, binary and transient tabs. Autosave runs per document in the store, so background tabs are saved.
- Closing a tab writes the closed-tab history (strict, serialised) before deleting its draft; if that write fails the draft stays and comes back next start. History is capped at 20 entries / 8 MB. Only one writable tab per file (`pathKey`); duplicates become "(recovered)" untitled copies.
- Startup validates every draft and session record (`cleanDraft`, `cleanTab`), reads tabs 6 at a time, and `main.tsx` always shows a window even if restore throws.

## Windows and the tab strip (like Chrome)
- **Tab strip** (`Titlebar.tsx`, plain pointer events, no layout-animation library): tabs are `width: var(--tab-max)` (224 px) and shrink together to `--tab-min` (96 px), then the strip scrolls (wheel, edge chevrons). A tab's width never depends on its title. The strip captures the pointer; a press becomes a drag after 5 px. The dragged tab follows the pointer, clamped between the first and last slot; its slot is the nearest one (swaps at half overlap); the others slide with CSS transitions. On drop the order changes in the store and a layout effect (before paint) settles the dropped tab from where it was let go. Escape cancels. Closing with the mouse freezes widths and keeps a spacer until the pointer leaves, so the next close button stays under the cursor.
- **Tear-off:** dragging 40 px above or below the bar detaches the tab: `detachDoc` writes its full state to its draft and removes it, `open_tab_window` (Rust, async) opens window `w<n>` at the pointer with `?adopt=<id>`, and the source keeps moving that window with the pointer (`move_window`). On release, `tab_drop_target` finds a Margin window whose tab bar is under the pointer: the new window is asked (`transfer-out`, repeated until `transfer-ack`) to hand the tab to it (`adopt-tab` → `adoptDoc` at the drop index) and close. A window whose only tab is dragged moves itself instead and, if dropped on another bar, merges and closes. The tab context menu has **Move to new window**.
- **One process, many windows:** `claim_restore` is true only for the first window, which restores every window's saved tabs (`session` + `session-w*`, `closed` + `closed-w*`, merged and the extras deleted). Each window saves its own `session-<label>` / `closed-<label>`, so closing all windows and starting again brings every tab back in one window. Torn-off windows start with only their adopted tabs and never touch other drafts. `claim_path` keeps each file in one window (opening it elsewhere focuses its window via `activate-path`). Later launches go to the most recently focused window. Settings changes are broadcast (`settings-changed`). Only `main` remembers its size and place. Capabilities cover `main` and `w*`.

## State (zustand)
- `lib/store.ts` `useApp`: documents/tabs, recents, closed tabs, sidebar, zoom, drafts and session persistence (`session`, `recents`, `closed`, `file-kinds`, `zoom` keys + `drafts/`).
- `lib/settings.ts` `useSettings`: one flat `Settings` object, `DEFAULT_SETTINGS`, `applySettings()` pushes it to CSS variables / `data-*` attributes on `<html>`. Adding a setting = add to the interface + defaults + one row in `components/Settings.tsx`.
- `lib/ui.ts` `useUi`: overlays (palette, settings, find, lightbox, confirm-close) and jump requests.
- `lib/viewSync.ts`: scroll restore (as a fraction, shared across modes), reading progress, active heading by index, outline jumps.
- `lib/commands.ts`: every command with its shortcut. The palette, menus, shortcut list in Settings and the global key handler all read this one list.

## Rust commands (all in `src-tauri/src`)
`read_file` (optional `encoding`, `force`; returns `version` = size:mtime-ns, `lossy`, and typed errors `NOTFOUND:` / `TOOBIG:` / `BINARY:`), `write_file` (optional `encoding`, `bom`, `expected` version and `force`; refuses with `CONFLICT:` when the file moved on, `UNMAPPABLE:` when the encoding can't hold a character; temp file + `ReplaceFileW` on Windows so attributes, ACLs and streams survive; writes through symlinks to the target), `write_binary`, `list_dir`, `list_files` (recursive name search for the palette), `file_meta`, `reveal_in_explorer`, `open_linked_file`, `watch_file` / `unwatch_file`, `store_get` / `store_set`, `draft_write` / `draft_delete` / `draft_list` (records without string `content` or a matching `id` are quarantined as `.bad`), `launch_files`, `take_open_requests`, `app_info`, `set_window_theme`, `show_snap_layout`, `open_external`.
Spelling: WebView2 names its suggestion items `spellcheck` (lowercase) with blank labels, so a page menu can't show them; `spell_menu.rs` lets the native menu open for a misspelled word. The editor must use `white-space: break-spaces`: with `pre-wrap` plus a custom caret colour WebView2 draws no spelling underlines.

Events to the UI: `open-files` (a ping: later launches queue their file lists in Rust and the UI drains them with `take_open_requests`, so none are lost during startup; an empty list = new note), `file-changed` (`{ path, kind }`; Margin's own write is ignored only while the file is still the version it wrote) and `context-menu-route` (`{ native }`: `spell_menu.rs` lets the native WebView2 menu show for a misspelled word, because WebView2 doesn't give suggestion text to page menus; every other right-click gets `ContextMenu.tsx`).
Config dir: `%APPDATA%\com.faamirali.margin`. On first launch `drafts::migrate_from_old_identifier` copies `com.faamirali.mdviewer` across (old folder left alone).

## Windows integration (installer)

- The title bar spans the full client width. `window_corner.rs` lets Close receive pointer input through Tauri’s native resize strip and leaves the rest of the strip available for resizing.
- `tauri.conf.json` `fileAssociations`: Margin.Markdown (md…), Margin.Text (txt, text, log), Margin.Config (ini, json, yaml, toml…). Windows only honours these where he hasn't already picked an app (UserChoice); otherwise he picks Margin in Settings > Default apps.
- `src-tauri/windows/hooks.nsh` (NSIS hooks, all HKCU, removed on uninstall): App Paths `note.exe` (Win+R `note`), `Applications\margin.exe`, Open-with for every PerceivedType=text file plus a list of code types (never their default), "Edit with Margin" on every file's classic right-click menu, and RegisteredApplications so Margin shows in Default apps.

## Styling
- `styles/tokens.css`: eight themes (dark: carbon, graphite, midnight, ember; light: paper, linen, sepia, mist) + motion tokens. Only place with raw colours.
- Fonts: Geist (UI, default body), Geist Mono (code), iA Writer Mono (default plain text, loaded at boot); iA Writer Duo/Quattro, Source Serif and the rest load after first paint (`fonts-extra.ts`).
- `styles/prose.css`: document typography for Read and Edit. Zoom changes text size independently of the column width. Notes with tables use the available document pane. `styles/crepe.css` matches the editor metrics to the reader.
- Interaction rules come from `research/ui-reference.md`: press = `scale 0.96` over 160 ms `cubic-bezier(.22,1,.36,1)`, critically damped springs (`SPRING` in `components/ui/controls.tsx`), double-ring focus, 1px top highlight on raised surfaces.

## Testing
- `npx vitest run`: renderer, editor text adapters, store helpers (titles, hashing, line endings).
- `cargo test` in `src-tauri`: encodings (ANSI round trip, UTF-16, BOM, refusals), binary detection, drafts (round trip, quarantine), config migration, atomic write, dir listing, store keys, CLI args.
- `node tools/e2e/real.mjs` (repo root, after building with `tools/e2e/tauri.test.json`): drives a release build over WebView2's debug port. Covers window controls, both format menus, disk bytes and encoding after restart, hot exit, find and replace, file watching, Markdown editing, and attachment handling. The harness verifies the separate profile before driving the app and only kills the processes it starts.
- `node tools/e2e/probe-tabs.mjs`: the tab strip and windows in the real app (18 checks): reordering sampled frame by frame (no jitter, no jump on drop, never under +), Escape, click, typing, tear-off, drop back, drop on another window, one window per file, settings across windows, restart into one window. A single-tab window moving with the pointer can't be driven by synthetic events (they are placed relative to the window's old position); it was checked with the real mouse.
- `node tools/e2e/probe-feedback.mjs`: the 2026-11-25 feedback round in the real app: tabs hold still while typing, drag stops before +, tab overflow, Ctrl+Tab scroll memory, no scroll jumps or text shifts in Edit, caret hidden when unfocused, plain paste, native spelling menu on a misspelled word (10 checks).
- `node tools/e2e/probe-code.mjs`: code stays code. Markdown inside a code block (Read and Edit) and the whole Source view keep one font size, weight, slant and line height, also while typing "### and" or "**bold**" (7 checks). Rule: `cmTheme.ts` and the `.hljs-*` styles only set colours.
- `node tools/e2e/bench.mjs`: cold start (blank, long.md, 20 MB log), Ctrl+Tab switch, first Edit, keystroke-to-frame latency, save acknowledgement and process-tree memory, median and p95.
- `node tools/e2e/probe-notepad.mjs`: code colouring, Ctrl+G, F5, Alt+Z, binary prompt, 20 MB log (opens in ~0.5 s), theme screenshots to `%TEMP%\margin-probe` (10 checks). `probe-hotexit.mjs` and `probe-marks.mjs` are small focused probes used to diagnose failures.
