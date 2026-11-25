import { motion } from 'motion/react';
import { CaseSensitive, ChevronDown, ChevronUp, Regex, WholeWord, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { StateEffect, StateField, Text as EditorText, type Range as CMRange } from '@codemirror/state';
import { viewMode, type Doc } from '../lib/store';
import { toast } from '../lib/toast';
import { useUi } from '../lib/ui';
import { scrollBehavior } from '../lib/viewSync';
import { sourceApi } from '../lib/sourceApi';
import {
  compileFind,
  findMatchesAsync,
  replaceAt,
  replaceChanges,
  type FindOptions,
  type FindResult,
  type MatchRange,
} from '../lib/find';
import { IconButton, SPRING } from './ui/controls';

/**
 * CodeMirror's text with every line break as one character, so match offsets are CodeMirror
 * positions. `sliceDoc()` would use the file's own line separator, and CRLF would shift every
 * match by one character per line.
 */
function cmText(view: { state: { doc: { length: number; sliceString(from: number, to?: number, sep?: string): string } } }): string {
  return view.state.doc.sliceString(0, view.state.doc.length, '\n');
}

/** Past these the count reads "N+" and the list stops there. */
const CAP_SOURCE = 20000;
const CAP_RENDERED = 3000;

const fmt = (n: number) => n.toLocaleString('en-US');
const toLines = (s: string) => EditorText.of(s.split(/\r\n|\r|\n/));

// ---------- Source mode: matches are marks in the CodeMirror state ----------

interface Marks {
  ranges: MatchRange[];
  current: number;
}

const setMarks = StateEffect.define<Marks | null>();
const setCurrent = StateEffect.define<number>();
const noMarks: Marks = { ranges: [], current: -1 };

const marksField = StateField.define<Marks>({
  create: () => noMarks,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setMarks)) return e.value ?? noMarks;
      if (e.is(setCurrent)) return { ranges: value.ranges, current: e.value };
    }
    if (!tr.docChanged || !value.ranges.length) return value;
    // Map every match through the edit, same order and count, until the debounced search catches up.
    const len = tr.startState.doc.length;
    return {
      ranges: value.ranges.map((r) => ({
        from: tr.changes.mapPos(Math.min(r.from, len), 1),
        to: tr.changes.mapPos(Math.min(r.to, len), -1),
      })),
      current: value.current,
    };
  },
});

const hitMark = Decoration.mark({ class: 'cm-find-hit' });
const currentMark = Decoration.mark({ class: 'cm-find-hit cm-find-current' });

/** Index of the first match that ends after `pos`. Matches are sorted and never overlap. */
function firstEndingAfter(ranges: MatchRange[], pos: number): number {
  let lo = 0;
  let hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid].to <= pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Marks for the visible lines only. Scrolling re-slices the list; it never searches again. */
function visibleMarks(view: EditorView): DecorationSet {
  const { ranges, current } = view.state.field(marksField);
  if (!ranges.length) return Decoration.none;
  const len = view.state.doc.length;
  const out: CMRange<Decoration>[] = [];
  let next = 0;
  for (const { from, to } of view.visibleRanges) {
    let i = Math.max(next, firstEndingAfter(ranges, from));
    for (; i < ranges.length && ranges[i].from <= to; i++) {
      const m = ranges[i];
      // Mark decorations must be non-empty and inside the document.
      if (m.to > m.from && m.to <= len) out.push((i === current ? currentMark : hitMark).range(m.from, m.to));
    }
    next = i;
  }
  return Decoration.set(out, true);
}

const marksPainter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = visibleMarks(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.transactions.some((t) => t.effects.some((e) => e.is(setMarks) || e.is(setCurrent)))) {
        this.decorations = visibleMarks(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

const marksTheme = EditorView.theme({
  '.cm-find-hit': { backgroundColor: 'color-mix(in srgb, var(--warn) 34%, transparent)' },
  '.cm-find-current': { backgroundColor: 'var(--warn)', color: '#1a1200' },
});

/** Called after each Source-mode document change. The open find bar re-searches, debounced. */
const sourceEdits = new Set<() => void>();

const marksExtension = [
  marksField,
  marksPainter,
  marksTheme,
  EditorView.updateListener.of((u) => {
    if (u.docChanged) sourceEdits.forEach((f) => f());
  }),
];

/** Adds the marks to a Source editor. Checks the state itself, so a re-created state gets them again. */
function ensureMarks(view: EditorView) {
  if (!view.state.field(marksField, false)) view.dispatch({ effects: StateEffect.appendConfig.of(marksExtension) });
}

function paintSource(view: EditorView, marks: Marks | null) {
  if (!view.dom.isConnected) return;
  ensureMarks(view);
  view.dispatch({ effects: setMarks.of(marks) });
}

function clearSource(view: EditorView | null) {
  if (view?.dom.isConnected && view.state.field(marksField, false)?.ranges.length) {
    view.dispatch({ effects: setMarks.of(null) });
  }
}

// ---------- Read and Edit modes: the rendered text ----------

const SKIP = '.katex, .code-copy, .code-lang, .cm-gutters, style, script, .mermaid-block, .milkdown-slash-menu';

interface DomIndex {
  el: HTMLElement;
  /** textContent when indexed. Lets a scroll-driven re-render be told apart from a text change. */
  sig: string;
  text: string;
  nodes: Text[];
  starts: number[];
}

/** The rendered text under `root`, and where each text node begins in it. */
function indexDom(root: HTMLElement): DomIndex {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = '';
  let prevBlock: Element | null = null;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    // Keep words in different blocks from matching across the gap.
    const block = n.parentElement?.closest('p, li, h1, h2, h3, h4, h5, h6, td, th, pre, blockquote, .cm-line, dt, dd') ?? null;
    if (block !== prevBlock && text) text += '\n';
    prevBlock = block;
    starts.push(text.length);
    nodes.push(n);
    text += n.data;
  }
  return { el: root, sig: root.textContent ?? '', text, nodes, starts };
}

/** DOM ranges for text offsets from the index. */
function domRanges(idx: DomIndex, matches: MatchRange[]): Range[] {
  const { nodes, starts } = idx;
  const out: Range[] = [];
  let ni = 0;
  for (const { from, to } of matches) {
    while (ni + 1 < nodes.length && starts[ni + 1] <= from) ni++;
    let ei = ni;
    while (ei + 1 < nodes.length && starts[ei + 1] < to) ei++;
    const range = document.createRange();
    try {
      range.setStart(nodes[ni], Math.min(nodes[ni].length, from - starts[ni]));
      range.setEnd(nodes[ei], Math.min(nodes[ei].length, to - starts[ei]));
      out.push(range);
    } catch {
      /* node vanished mid-walk */
    }
  }
  return out;
}

const supportsHighlight = typeof CSS !== 'undefined' && 'highlights' in CSS;

function paint(all: Range[], current: Range | null) {
  if (!supportsHighlight) return;
  CSS.highlights.set('find', new Highlight(...all));
  if (current) CSS.highlights.set('find-current', new Highlight(current));
  else CSS.highlights.delete('find-current');
}

function clearPaint() {
  if (!supportsHighlight) return;
  CSS.highlights.delete('find');
  CSS.highlights.delete('find-current');
}

// ---------- The bar ----------

export function FindBar({ doc }: { doc: Doc }) {
  const mode = viewMode(doc);
  const isSource = mode === 'source';
  const replaceMode = useUi((s) => s.findReplace) && isSource;
  const [query, setQuery] = useState(() => document.getSelection()?.toString().split('\n')[0].slice(0, 80) ?? '');
  const [replacement, setReplacement] = useState('');
  const [opts, setOpts] = useState<FindOptions>({ caseSensitive: false, wholeWord: false, regex: false });
  const [count, setCount] = useState(0);
  const [capped, setCapped] = useState(false);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const sourceMatches = useRef<MatchRange[]>([]);
  const renderedRanges = useRef<Range[]>([]);
  const dom = useRef<DomIndex | null>(null);
  const indexRef = useRef(0);
  const generation = useRef(0);
  // Requests that stay pending until a search finishes and applies them.
  const resetPending = useRef(true);
  const revealPending = useRef(false);
  const afterPending = useRef<number | null>(null);
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const retries = useRef(0);
  const compiled = useMemo(() => compileFind(query, opts), [query, opts]);
  const invalid = compiled.error !== null;

  const root = useCallback(
    () =>
      document.querySelector<HTMLElement>(
        mode === 'read' ? '.doc-stage[data-visible] .prose.reader' : mode === 'edit' ? '.doc-stage[data-visible] .ProseMirror' : '.doc-stage[data-visible] .cm-content',
      ),
    [mode],
  );

  const close = () => useUi.getState().close('find');

  const reveal = useCallback(
    (i: number) => {
      const scroller = document.querySelector<HTMLElement>('.doc-view .doc-scroller');
      if (isSource) {
        const m = sourceMatches.current[i];
        const view = sourceApi.view;
        if (!m || !view) return;
        // The text may have shrunk since this match was found (the search is debounced).
        const len = view.state.doc.length;
        const from = Math.min(m.from, len);
        const to = Math.min(m.to, len);
        ensureMarks(view);
        view.dispatch({
          selection: { anchor: from, head: to },
          effects: [EditorView.scrollIntoView(from, { y: 'nearest' }), setCurrent.of(i)],
        });
        const coords = view.coordsAtPos(from);
        if (coords && scroller) {
          const box = scroller.getBoundingClientRect();
          if (coords.top < box.top + 70 || coords.bottom > box.bottom - 70) {
            scroller.scrollTo({ top: scroller.scrollTop + coords.top - box.top - box.height * 0.38, behavior: scrollBehavior() });
          }
        }
        return;
      }
      const r = renderedRanges.current[i];
      if (!r || !scroller) return;
      paint(renderedRanges.current, r);
      const rect = r.getBoundingClientRect();
      const box = scroller.getBoundingClientRect();
      if (rect.top < box.top + 70 || rect.bottom > box.bottom - 70) {
        scroller.scrollTo({ top: scroller.scrollTop + rect.top - box.top - box.height * 0.38, behavior: scrollBehavior() });
      }
    },
    [isSource],
  );

  /**
   * Search the document and show the result. A run that is overtaken (the query, the options or the
   * text changed while it worked) is dropped without touching the bar.
   */
  const run = useCallback(
    async (flags: { reset?: boolean; reveal?: boolean; after?: number } = {}) => {
      if (flags.reset) resetPending.current = true;
      if (flags.reveal) revealPending.current = true;
      if (flags.after !== undefined) afterPending.current = flags.after;
      const mine = ++generation.current;
      const isCurrent = () => generation.current === mine;

      const view = isSource ? sourceApi.view : null;
      if (isSource && !view && retries.current++ < 20) {
        // The editor mounts a moment after the bar. Try again instead of reporting no results.
        clearTimeout(retry.current);
        retry.current = setTimeout(() => void run(), 100);
        return;
      }
      // Installed on every search, not only when something is painted: the edit listener that
      // keeps the count fresh lives in these marks.
      if (view) ensureMarks(view);
      const el = isSource ? null : root();
      if (el && (!dom.current || dom.current.el !== el)) dom.current = indexDom(el);
      const idx = el ? dom.current : null;
      const text = isSource ? (view ? cmText(view) : '') : (idx?.text ?? '');

      const snapshot = view?.state.doc;
      let res: FindResult | null = { ranges: [], capped: false, error: null };
      if (query && (isSource ? view : idx)) {
        res = await findMatchesAsync(text, query, opts, isSource ? CAP_SOURCE : CAP_RENDERED, isCurrent);
      }
      if (!res || !isCurrent()) return;
      // The text changed while this ran, so its positions are stale. The edit listener or the DOM
      // observer queues a fresh search; this one must not apply anything.
      if (isSource ? view?.state.doc !== snapshot : dom.current !== idx) return;

      if (isSource) {
        sourceMatches.current = res.ranges;
        renderedRanges.current = [];
      } else {
        sourceMatches.current = [];
        renderedRanges.current = idx ? domRanges(idx, res.ranges) : [];
      }
      const total = isSource ? sourceMatches.current.length : renderedRanges.current.length;
      const reset = resetPending.current;
      const wantReveal = revealPending.current;
      const after = afterPending.current;
      resetPending.current = false;
      revealPending.current = false;
      afterPending.current = null;

      let next = reset || !total ? 0 : Math.min(indexRef.current, total - 1);
      if (isSource && after !== null && total) {
        const found = sourceMatches.current.findIndex((m) => m.from >= after);
        next = found < 0 ? 0 : found;
      }
      indexRef.current = next;
      setIndex(next);
      setCount(total);
      setCapped(res.capped);

      if (isSource) {
        if (view && total) paintSource(view, { ranges: sourceMatches.current, current: next });
        else if (view) clearSource(view);
      } else if (total) {
        paint(renderedRanges.current, renderedRanges.current[next]);
      } else {
        clearPaint();
      }
      if (total && (reset || wantReveal || after !== null)) reveal(next);
    },
    [query, opts, isSource, root, reveal],
  );

  // A new query or new options start again from the first match.
  useEffect(() => {
    const t = setTimeout(() => void run({ reset: true, reveal: true }), 60);
    return () => clearTimeout(t);
  }, [run]);

  // Document edits re-search, debounced. Source mode listens to CodeMirror. The rendered modes
  // look at the DOM, but only a change in the text counts: scroll-driven markup churn is ignored.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    if (isSource) {
      const onEdit = () => {
        clearTimeout(t);
        t = setTimeout(() => void run(), 150);
      };
      sourceEdits.add(onEdit);
      return () => {
        sourceEdits.delete(onEdit);
        clearTimeout(t);
      };
    }
    const el = inputRef.current?.closest('.doc-view');
    if (!el) return;
    const mo = new MutationObserver((changes) => {
      if (!changes.some(({ target, addedNodes }) =>
        (target instanceof Element ? target : target.parentElement)?.closest('.doc-stage') ||
        Array.from(addedNodes).some((node) => node instanceof Element && node.matches('.doc-stage'))
      )) return;
      clearTimeout(t);
      t = setTimeout(() => {
        const r = root();
        const cached = dom.current;
        if (r && cached?.el === r && cached.sig === (r.textContent ?? '')) return;
        dom.current = null;
        void run();
      }, 120);
    });
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      clearTimeout(t);
      mo.disconnect();
    };
  }, [isSource, run, root]);

  // Ctrl+F always puts the caret in the find field, ready to type, even if the editor had it.
  const focusNonce = useUi((s) => s.findFocus);
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const grab = () => {
      input.focus({ preventScroll: true });
      input.select();
    };
    grab();
    // The editors re-focus themselves on the next frame when they mount or switch mode.
    const raf = requestAnimationFrame(() => requestAnimationFrame(grab));
    const late = setTimeout(() => {
      if (document.activeElement !== input) grab();
    }, 120);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(late);
    };
  }, [focusNonce]);

  // Clicking back into the page means you're done finding: the bar goes away.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target || target.closest('.findbar')) return;
      if (target.closest('.doc-view')) close();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, []);

  // Leaving the bar: any search still running is stale, and the highlights go.
  useEffect(
    () => () => {
      generation.current++;
      clearTimeout(retry.current);
      clearPaint();
      clearSource(sourceApi.view);
    },
    [],
  );

  const step = (dir: 1 | -1) => {
    if (!count) return;
    const next = (indexRef.current + dir + count) % count;
    indexRef.current = next;
    setIndex(next);
    reveal(next);
  };

  const replaceOne = () => {
    const view = sourceApi.view;
    const m = sourceMatches.current[indexRef.current];
    if (!m || !view || doc.readonly) return;
    const edit = replaceAt(cmText(view), m.from, query, replacement, opts);
    if (!edit || edit.to !== m.to) {
      // The text changed since the last search. Search again rather than guess.
      void run();
      return;
    }
    view.dispatch({ changes: { from: edit.from, to: edit.to, insert: toLines(edit.insert) } });
    // Move on past the inserted text, so Replace never lands on what it just wrote.
    void run({ reveal: true, after: edit.from + edit.insert.replace(/\r\n?/g, '\n').length });
  };

  const replaceAllMatches = () => {
    const view = sourceApi.view;
    if (!query || !view || doc.readonly || compiled.error) return;
    const { changes, count: n } = replaceChanges(cmText(view), query, replacement, opts);
    if (!n) return;
    view.dispatch({ changes: changes.map((c) => ({ from: c.from, to: c.to, insert: toLines(c.insert) })) });
    toast.success(`Replaced ${fmt(n)} ${n === 1 ? 'match' : 'matches'}`);
    void run({ reset: true, reveal: true });
  };

  const toggle = (key: keyof FindOptions) => setOpts((o) => ({ ...o, [key]: !o[key] }));

  const label =
    query === '' ? '' : invalid ? 'Invalid' : count === 0 ? 'No results' : `${index + 1} / ${fmt(count)}${capped ? '+' : ''}`;
  const labelTitle = invalid
    ? (compiled.error ?? undefined)
    : capped
      ? `Showing the first ${fmt(count)} matches. Narrow the search to see the rest.`
      : undefined;

  return (
    <motion.div
      className="findbar popover"
      role="search"
      initial={{ opacity: 0, y: -12, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -8, scale: 0.98, transition: { duration: 0.12 } }}
      transition={SPRING}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          close();
        }
      }}
    >
      <div className="find-row">
        <div className="find-field" data-invalid={invalid || undefined}>
          <input
            ref={inputRef}
            autoFocus
            spellCheck={false}
            placeholder="Find"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                step(e.shiftKey ? -1 : 1);
              }
            }}
          />
          <span className="find-count" data-none={query !== '' && count === 0 || undefined} title={labelTitle}>
            {label}
          </span>
        </div>
        <IconButton label="Match case" tipSide="bottom" active={opts.caseSensitive} onClick={() => toggle('caseSensitive')}>
          <CaseSensitive size={16} />
        </IconButton>
        <IconButton label="Whole word" active={opts.wholeWord} onClick={() => toggle('wholeWord')}>
          <WholeWord size={16} />
        </IconButton>
        <IconButton label="Regular expression" active={opts.regex} onClick={() => toggle('regex')}>
          <Regex size={15} />
        </IconButton>
        <span className="find-sep" />
        <IconButton label="Previous" keys="Shift+Enter" disabled={!count} onClick={() => step(-1)}>
          <ChevronUp size={16} />
        </IconButton>
        <IconButton label="Next" keys="Enter" disabled={!count} onClick={() => step(1)}>
          <ChevronDown size={16} />
        </IconButton>
        <IconButton label="Close" keys="Esc" onClick={close}>
          <X size={15} />
        </IconButton>
      </div>
      {replaceMode && (
        <div className="find-row">
          <div className="find-field">
            <input
              spellCheck={false}
              placeholder="Replace with"
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  replaceOne();
                }
              }}
            />
          </div>
          <button type="button" className="btn btn-soft btn-sm" disabled={!count || doc.readonly} onClick={replaceOne}>
            Replace
          </button>
          <button type="button" className="btn btn-soft btn-sm" disabled={!count || doc.readonly} onClick={replaceAllMatches}>
            All
          </button>
        </div>
      )}
    </motion.div>
  );
}
