import { motion } from 'motion/react';
import { CaseSensitive, ChevronDown, ChevronUp, Regex, WholeWord, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { viewMode, type Doc } from '../lib/store';
import { toast } from '../lib/toast';
import { useUi } from '../lib/ui';
import { scrollBehavior } from '../lib/viewSync';
import { sourceApi } from '../lib/sourceApi';
import { EditorView } from '@codemirror/view';
import { Text as EditorText } from '@codemirror/state';
import { IconButton, SPRING } from './ui/controls';

interface Opts {
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
}

function buildRegex(query: string, o: Opts): RegExp | null {
  if (!query) return null;
  try {
    let src = o.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (o.wholeWord) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
    return new RegExp(src, `g${o.matchCase ? '' : 'i'}u`);
  } catch {
    return null;
  }
}

const SKIP = '.katex, .code-copy, .code-lang, .cm-gutters, style, script, .mermaid-block, .milkdown-slash-menu';

/** Find every match in the rendered text under `root`, as DOM ranges. */
function domRanges(root: HTMLElement, re: RegExp, limit = 3000): Range[] {
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
  const out: Range[] = [];
  let ni = 0;
  re.lastIndex = 0;
  for (let m = re.exec(text); m && out.length < limit; m = re.exec(text)) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    const from = m.index;
    const to = from + m[0].length;
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

export function FindBar({ doc }: { doc: Doc }) {
  const mode = viewMode(doc);
  const replaceMode = useUi((s) => s.findReplace) && mode === 'source';
  const [query, setQuery] = useState(() => document.getSelection()?.toString().split('\n')[0].slice(0, 80) ?? '');
  const [replacement, setReplacement] = useState('');
  const [opts, setOpts] = useState<Opts>({ matchCase: false, wholeWord: false, regex: false });
  const [count, setCount] = useState(0);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const ranges = useRef<Range[]>([]);
  const textMatches = useRef<{ from: number; to: number }[]>([]);
  const invalid = query !== '' && buildRegex(query, opts) === null;
  const isSource = mode === 'source';

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
      if (isSource) {
        const m = textMatches.current[i];
        const view = sourceApi.view;
        if (m && view) {
          view.dispatch({ selection: { anchor: m.from, head: m.to }, effects: EditorView.scrollIntoView(m.from, { y: 'nearest' }) });
          const coords = view.coordsAtPos(m.from);
          const scroller = document.querySelector<HTMLElement>('.doc-view .doc-scroller');
          if (coords && scroller) {
            const box = scroller.getBoundingClientRect();
            if (coords.top < box.top + 70 || coords.bottom > box.bottom - 70) {
              scroller.scrollTo({ top: scroller.scrollTop + coords.top - box.top - box.height * 0.38, behavior: scrollBehavior() });
            }
          }
        }
        return;
      }
      const r = ranges.current[i];
      const scroller = document.querySelector<HTMLElement>('.doc-view .doc-scroller');
      if (!r || !scroller) return;
      paint(ranges.current, r);
      const rect = r.getBoundingClientRect();
      const box = scroller.getBoundingClientRect();
      if (rect.top < box.top + 70 || rect.bottom > box.bottom - 70) {
        scroller.scrollTo({ top: scroller.scrollTop + rect.top - box.top - box.height * 0.38, behavior: scrollBehavior() });
      }
    },
    [isSource],
  );

  // Recompute matches whenever the query, options or document change.
  const search = useCallback(
    (keepIndex: boolean) => {
      const re = buildRegex(query, opts);
      const el = root();
      if (!re || !el) {
        ranges.current = [];
        textMatches.current = [];
        clearPaint();
        setCount(0);
        setIndex(0);
        return;
      }
      ranges.current = domRanges(el, re);
      if (isSource) {
        // CodeMirror uses one position per line break, including in CRLF files.
        const text = sourceApi.view?.state.doc.toString() ?? '';
        const found: { from: number; to: number }[] = [];
        re.lastIndex = 0;
        for (let m = re.exec(text); m && found.length < 20000; m = re.exec(text)) {
          if (m[0].length === 0) re.lastIndex++;
          else found.push({ from: m.index, to: m.index + m[0].length });
        }
        textMatches.current = found;
        paint(ranges.current, null);
        setCount(found.length);
      } else {
        setCount(ranges.current.length);
      }
      const total = isSource ? textMatches.current.length : ranges.current.length;
      setIndex((prev) => {
        const next = keepIndex ? Math.min(prev, Math.max(0, total - 1)) : 0;
        if (!isSource) paint(ranges.current, ranges.current[next] ?? null);
        return next;
      });
      return total;
    },
    [query, opts, root, isSource, doc.id],
  );

  // Keep highlights in step with edits and (in source mode) with lines scrolling into view.
  useEffect(() => {
    const el = inputRef.current?.closest('.doc-view');
    if (!el) return;
    let jumped = false;
    const refresh = () => {
      if (search(jumped) && !jumped) {
        jumped = true;
        reveal(0);
      }
    };
    let t = setTimeout(refresh, 60);
    const mo = new MutationObserver((changes) => {
      if (!changes.some(({ target, addedNodes }) =>
        (target instanceof Element ? target : target.parentElement)?.closest('.doc-stage') ||
        Array.from(addedNodes).some((node) => node instanceof Element && node.matches('.doc-stage'))
      )) return;
      clearTimeout(t);
      t = setTimeout(refresh, 120);
    });
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      clearTimeout(t);
      mo.disconnect();
    };
  }, [search, reveal]);

  useEffect(() => {
    inputRef.current?.select();
    return clearPaint;
  }, []);

  const step = (dir: 1 | -1) => {
    if (!count) return;
    const next = (index + dir + count) % count;
    setIndex(next);
    reveal(next);
  };

  const replaceOne = () => {
    const m = textMatches.current[index];
    const view = sourceApi.view;
    if (!m || !view || doc.readonly) return;
    const re = buildRegex(query, opts);
    if (!re) return;
    const text = view.state.doc.toString();
    const exact = new RegExp(re.source, re.flags.replace('g', 'y'));
    exact.lastIndex = m.from;
    if (exact.exec(text)?.[0].length !== m.to - m.from) return;
    let insert = replacement;
    if (opts.regex) {
      exact.lastIndex = m.from;
      const next = text.replace(exact, replacement);
      insert = next.slice(m.from, next.length - (text.length - m.to));
    }
    view.dispatch({ changes: { from: m.from, to: m.to, insert: EditorText.of(insert.split(/\r\n|\r|\n/)) } });
    setTimeout(() => {
      search(true);
      reveal(Math.min(index, Math.max(0, textMatches.current.length - 1)));
    }, 0);
  };

  const replaceAll = () => {
    const re = buildRegex(query, opts);
    const view = sourceApi.view;
    if (!re || !view || doc.readonly || !count) return;
    const text = view.state.doc.toString();
    let n = 0;
    for (const match of text.matchAll(re)) if (match[0].length) n++;
    if (!n) return;
    const next = opts.regex ? text.replace(re, replacement) : text.replace(re, () => replacement);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: EditorText.of(next.split(/\r\n|\r|\n/)) } });
    toast.success(`Replaced ${n} ${n === 1 ? 'match' : 'matches'}`);
  };

  const toggle = (key: keyof Opts) => setOpts((o) => ({ ...o, [key]: !o[key] }));

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
          <span className="find-count" data-none={query !== '' && count === 0 || undefined}>
            {query === '' ? '' : invalid ? 'Invalid' : count === 0 ? 'No results' : `${index + 1} / ${count}`}
          </span>
        </div>
        <IconButton label="Match case" tipSide="bottom" active={opts.matchCase} onClick={() => toggle('matchCase')}>
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
          <button type="button" className="btn btn-soft btn-sm" disabled={!count || doc.readonly} onClick={replaceAll}>
            All
          </button>
        </div>
      )}
    </motion.div>
  );
}
