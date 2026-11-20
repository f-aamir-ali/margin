import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { LanguageDescription, bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { Compartment, EditorState, Text, Transaction } from '@codemirror/state';
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
import { sourceApi } from '../lib/sourceApi';
import { useApp, type Doc } from '../lib/store';
import { useUi } from '../lib/ui';
import { useView } from '../lib/viewSync';

/** Files that read best edge to edge: logs, data and anything with a recognised code language. */
const WIDE_EXTENSIONS = ['log', 'csv', 'tsv', 'json', 'jsonc', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env'];

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** Source mode for markdown, and the whole view for plain text (with colouring for code files). */
export function Source({ doc }: { doc: Doc }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const s = useSettings((st) => st.settings);
  const plain = doc.kind === 'text';
  const gutters = useRef(new Compartment());
  const wrap = useRef(new Compartment());
  const lang = useRef(new Compartment());
  const lineSep = useRef(new Compartment());
  const readOnly = useRef(new Compartment());
  const applying = useRef(false);
  const codeLang = plain ? LanguageDescription.matchFilename(languages, doc.name) : null;
  const wide = plain && (!!codeLang || WIDE_EXTENSIONS.includes(extOf(doc.name)));
  const showNumbers = plain ? s.plainLineNumbers : s.sourceLineNumbers;

  useEffect(() => {
    const host = hostRef.current;
    const scroller = scrollerRef.current;
    if (!host || !scroller) return;
    const st = useSettings.getState().settings;
    const numbers = plain ? st.plainLineNumbers : st.sourceLineNumbers;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: doc.content,
        extensions: [
          gutters.current.of(numbers ? [lineNumbers(), highlightActiveLineGutter()] : []),
          wrap.current.of(st.sourceWrap ? EditorView.lineWrapping : []),
          lineSep.current.of(EditorState.lineSeparator.of(doc.eol)),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          highlightActiveLine(),
          lang.current.of(plain ? [] : markdown({ base: markdownLanguage, codeLanguages: languages })),
          syntaxHighlighting(highlight),
          theme,
          readOnly.current.of(EditorState.readOnly.of(doc.readonly)),
          EditorView.contentAttributes.of({ spellcheck: String(st.spellcheck && (!plain || !codeLang)), 'aria-label': doc.name }),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !applying.current) {
              useApp.getState().setContent(doc.id, u.state.sliceDoc());
            }
            if (u.selectionSet || u.docChanged || u.focusChanged) {
              const sel = u.state.selection.main;
              const text = sel.empty ? '' : u.state.sliceDoc(sel.from, sel.to);
              const line = u.state.doc.lineAt(sel.head);
              useView.getState().set({
                selectionWords: text ? text.trim().split(/\s+/).filter(Boolean).length : 0,
                selectionChars: text.length,
                cursor: { line: line.number, col: sel.head - line.from + 1 },
              });
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    sourceApi.view = view;

    // Code files: load the language lazily, then colour the text.
    let alive = true;
    if (codeLang) {
      void codeLang.load().then((support) => {
        if (alive) view.dispatch({ effects: lang.current.reconfigure(support) });
      }).catch((error) => console.warn('Could not load syntax highlighting', error));
    }

    const max = scroller.scrollHeight - scroller.clientHeight;
    scroller.scrollTop = max > 0 ? doc.scroll * max : 0;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const m = scroller.scrollHeight - scroller.clientHeight;
        const progress = m > 0 ? Math.min(1, scroller.scrollTop / m) : 0;
        useApp.getState().setScroll(doc.id, progress);
        useView.getState().set({ progress, activeHeading: -1 });
      });
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    view.focus();
    useView.getState().set({ cursor: { line: 1, col: 1 }, selectionChars: 0 });

    return () => {
      alive = false;
      scroller.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
      view.destroy();
      viewRef.current = null;
      if (sourceApi.view === view) sourceApi.view = null;
      useView.getState().set({ cursor: null, selectionChars: 0 });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, doc.kind]);

  // Text replaced from outside (reload from disk, find-and-replace, line-ending change).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.sliceDoc();
    if (current === doc.content && view.state.lineBreak === doc.eol) return;
    const next = Text.of(doc.content.split(/\r\n|\r|\n/));
    applying.current = true;
    try {
      view.dispatch({
        effects: lineSep.current.reconfigure(EditorState.lineSeparator.of(doc.eol)),
        changes: next.eq(view.state.doc) ? undefined : { from: 0, to: view.state.doc.length, insert: next },
        annotations: Transaction.addToHistory.of(false),
      });
    } finally {
      applying.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.content, doc.eol]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: readOnly.current.reconfigure(EditorState.readOnly.of(doc.readonly)) });
  }, [doc.readonly]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: [
        gutters.current.reconfigure(showNumbers ? [lineNumbers(), highlightActiveLineGutter()] : []),
        wrap.current.reconfigure(s.sourceWrap ? EditorView.lineWrapping : []),
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
