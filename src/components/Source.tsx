import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { LanguageDescription, bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { EditorState, Text, Transaction } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { useEffect, useRef } from 'react';
import { cmHighlight as highlight, cmTheme as theme } from '../lib/cmTheme';
import { useSettings } from '../lib/settings';
import { LARGE_DOC_CHARS, countWords } from '../lib/stats';
import { sourceApi } from '../lib/sourceApi';
import { liveEditors, useApp, type Doc } from '../lib/store';
import {
  clearSourceHandler,
  compartments,
  createReporter,
  docKey,
  putEditorState,
  routeUpdates,
  setSourceHandler,
  takeEditorState,
  type Reporter,
  type SourceHandler,
} from '../lib/sourceState';
import { useUi, focusIsElsewhere } from '../lib/ui';
import { restoringScroll, useLongPage, useView } from '../lib/viewSync';

/** Files that read best edge to edge: logs, data and anything with a recognised code language. */
const WIDE_EXTENSIONS = ['log', 'csv', 'tsv', 'json', 'jsonc', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env'];

/** Where the caret was in each tab, so switching tabs and back puts it where it was (this session). */
const caretByDoc = new Map<string, { anchor: number; head: number }>();

/** What one mounted editor needs while it lives. */
interface Mount {
  view: EditorView | null;
  /** The text last reported to the store (or taken from it). Equal to doc.content when nothing new happened. */
  sent: string;
  /** True while this component itself writes outside text into the editor. */
  applying: boolean;
  reporter: Reporter;
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** Source mode for markdown, and the whole view for plain text (with colouring for code files). */
export function Source({ doc }: { doc: Doc }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const mountRef = useRef<Mount | null>(null);
  const s = useSettings((st) => st.settings);
  const plain = doc.kind === 'text';
  const codeLang = plain ? LanguageDescription.matchFilename(languages, doc.name) : null;
  const wide = plain && (!!codeLang || WIDE_EXTENSIONS.includes(extOf(doc.name)));
  const showNumbers = plain ? s.plainLineNumbers : s.sourceLineNumbers;
  useLongPage(scrollerRef, doc.id);

  useEffect(() => {
    const host = hostRef.current;
    const scroller = scrollerRef.current;
    if (!host || !scroller) return;
    const st = useSettings.getState().settings;
    const numbers = plain ? st.plainLineNumbers : st.sourceLineNumbers;
    const attrs = EditorView.contentAttributes.of({
      spellcheck: String(st.spellcheck && (!plain || !codeLang)),
      'aria-label': doc.name,
    });
    const saved = caretByDoc.get(doc.id);
    const clamp = (n: number) => Math.max(0, Math.min(n, doc.content.length));

    // Reuse the editor state this tab had (undo history and caret included) if its text is unchanged.
    const kept = takeEditorState(doc.id, { text: doc.content, eol: doc.eol, kind: doc.kind, name: doc.name });
    const mount: Mount = {
      view: null,
      sent: doc.content,
      applying: false,
      reporter: createReporter({ report: () => { if (mount.view) send(mount.view.state); } }),
    };
    const send = (state: EditorState) => {
      const text = state.sliceDoc();
      mount.sent = text;
      useApp.getState().setContent(doc.id, text);
    };
    const handler: SourceHandler = {
      onUpdate(u) {
        if (u.docChanged && !mount.applying) {
          if (u.state.doc.length >= LARGE_DOC_CHARS) {
            mount.reporter.touch();
          } else {
            mount.reporter.cancel();
            send(u.state);
          }
        }
        if (u.selectionSet || u.docChanged || u.focusChanged) {
          const sel = u.state.selection.main;
          const text = sel.empty ? '' : u.state.sliceDoc(sel.from, sel.to);
          const line = u.state.doc.lineAt(sel.head);
          useView.getState().set({
            selectionWords: text ? countWords(text) : 0,
            selectionChars: text.length,
            cursor: { line: line.number, col: sel.head - line.from + 1 },
          });
        }
      },
    };

    const state =
      kept ??
      EditorState.create({
        doc: doc.content,
        selection: saved ? { anchor: clamp(saved.anchor), head: clamp(saved.head) } : undefined,
        extensions: [
          compartments.gutters.of(numbers ? [lineNumbers(), highlightActiveLineGutter()] : []),
          compartments.wrap.of(st.sourceWrap ? EditorView.lineWrapping : []),
          compartments.lineSep.of(EditorState.lineSeparator.of(doc.eol)),
          compartments.attrs.of(attrs),
          docKey.of(doc.id),
          routeUpdates,
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          highlightActiveLine(),
          compartments.lang.of(plain ? [] : markdown({ base: markdownLanguage, codeLanguages: languages })),
          syntaxHighlighting(highlight),
          theme,
          compartments.readOnly.of(EditorState.readOnly.of(doc.readonly)),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        ],
      });
    const view = new EditorView({ parent: host, state });
    mount.view = view;
    viewRef.current = view;
    mountRef.current = mount;
    sourceApi.view = view;
    // A kept state carries the settings of its last mount, so apply the current ones.
    view.dispatch({ effects: compartments.attrs.reconfigure(attrs) });
    setSourceHandler(doc.id, handler);
    const flush = () => mount.reporter.flush();
    liveEditors.add(flush);

    // Code files: load the language lazily, then colour the text.
    let alive = true;
    if (codeLang) {
      void codeLang.load().then((support) => {
        if (alive) view.dispatch({ effects: compartments.lang.reconfigure(support) });
      }).catch((error) => console.warn('Could not load syntax highlighting', error));
    }

    // Restore the scroll position. CodeMirror measures lines over the first frames, so apply it
    // again then, and don't record positions until it has settled.
    const target = doc.scroll;
    const apply = () => {
      const max = scroller.scrollHeight - scroller.clientHeight;
      scroller.scrollTop = max > 0 ? target * max : 0;
    };
    if (target > 0) restoringScroll.add(doc.id);
    apply();
    let settleRaf = requestAnimationFrame(() => {
      apply();
      settleRaf = requestAnimationFrame(() => {
        apply();
        restoringScroll.delete(doc.id);
      });
    });
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const m = scroller.scrollHeight - scroller.clientHeight;
        const progress = m > 0 ? Math.min(1, scroller.scrollTop / m) : 0;
        if (!restoringScroll.has(doc.id)) useApp.getState().setScroll(doc.id, progress);
        useView.getState().set({ progress, activeHeading: -1 });
      });
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    // Like Notepad: a click on the empty page below the text puts the caret at the very end;
    // a click in the side margin lands on the nearest line.
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || e.shiftKey || e.detail > 1) return;
      const target = e.target as Element;
      if (target.closest('.cm-gutters')) return;
      const end = view.state.doc.length;
      const endBox = view.coordsAtPos(end);
      const below = !!endBox && e.clientY > endBox.bottom;
      const inMargin = target === scroller || target === host;
      if (!below && !inMargin) return;
      let pos = end;
      if (!below) {
        const box = view.contentDOM.getBoundingClientRect();
        const hit = view.posAtCoords({ x: Math.min(Math.max(e.clientX, box.left + 2), box.right - 2), y: e.clientY });
        if (hit === null) return;
        pos = hit;
      }
      e.preventDefault();
      e.stopPropagation();
      view.focus();
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    };
    scroller.addEventListener('mousedown', onDown, true);
    if (!focusIsElsewhere()) view.focus();
    const head = view.state.selection.main.head;
    const caretLine = view.state.doc.lineAt(head);
    useView.getState().set({ cursor: { line: caretLine.number, col: head - caretLine.from + 1 }, selectionChars: 0 });

    return () => {
      alive = false;
      cancelAnimationFrame(settleRaf);
      restoringScroll.delete(doc.id);
      // Hand over the last keystrokes first: the store must hold them before this editor goes.
      flush();
      liveEditors.delete(flush);
      clearSourceHandler(doc.id, handler);
      const sel = view.state.selection.main;
      caretByDoc.set(doc.id, { anchor: sel.anchor, head: sel.head });
      putEditorState(doc.id, { state: view.state, text: mount.sent, eol: doc.eol, kind: doc.kind, name: doc.name });
      scroller.removeEventListener('scroll', onScroll);
      scroller.removeEventListener('mousedown', onDown, true);
      if (raf) cancelAnimationFrame(raf);
      view.destroy();
      mount.view = null;
      viewRef.current = null;
      mountRef.current = null;
      if (sourceApi.view === view) sourceApi.view = null;
      useView.getState().set({ cursor: null, selectionChars: 0 });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, doc.kind]);

  // Text replaced from outside (reload from disk, find-and-replace, line-ending change).
  useEffect(() => {
    const mount = mountRef.current;
    const view = mount?.view;
    if (!mount || !view) return;
    // The usual case: this is the text the editor just reported. Anything typed since is still pending.
    if (doc.content === mount.sent && view.state.lineBreak === doc.eol) return;
    const current = view.state.sliceDoc();
    if (current === doc.content && view.state.lineBreak === doc.eol) {
      mount.sent = doc.content;
      return;
    }
    mount.reporter.cancel();
    const next = Text.of(doc.content.split(/\r\n|\r|\n/));
    mount.applying = true;
    try {
      view.dispatch({
        effects: compartments.lineSep.reconfigure(EditorState.lineSeparator.of(doc.eol)),
        changes: next.eq(view.state.doc) ? undefined : { from: 0, to: view.state.doc.length, insert: next },
        annotations: Transaction.addToHistory.of(false),
      });
    } finally {
      mount.applying = false;
    }
    mount.sent = doc.content;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.content, doc.eol]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.readOnly.reconfigure(EditorState.readOnly.of(doc.readonly)) });
  }, [doc.readonly]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: [
        compartments.gutters.reconfigure(showNumbers ? [lineNumbers(), highlightActiveLineGutter()] : []),
        compartments.wrap.reconfigure(s.sourceWrap ? EditorView.lineWrapping : []),
      ],
    });
  }, [showNumbers, s.sourceWrap]);

  // Outline clicks and Go to line: jump to the line.
  const jump = useUi((st) => st.jump);
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !jump || jump.line === undefined) return;
    const line = view.state.doc.line(Math.min(view.state.doc.lines, jump.line + 1));
    view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
    view.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump?.nonce]);

  return (
    <div
      className="doc-scroller"
      ref={scrollerRef}
      data-mode="source"
      data-plain={plain || undefined}
      data-wide={wide || undefined}
      data-plain-font={plain ? s.plainFont : undefined}
      onMouseDown={(e) => {
        if (e.target === scrollerRef.current) {
          e.preventDefault();
          viewRef.current?.focus();
        }
      }}
    >
      <div className="source" ref={hostRef} />
    </div>
  );
}
