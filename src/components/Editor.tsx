import { syntaxHighlighting } from '@codemirror/language';
import { Crepe } from '@milkdown/crepe';
import { editorViewCtx, remarkStringifyOptionsCtx, serializerCtx } from '@milkdown/kit/core';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey, Selection, TextSelection } from '@milkdown/kit/prose/state';
import { trailingConfig } from '@milkdown/kit/plugin/trailing';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { attachSmoothCaret } from '../lib/caret';
import { cmHighlight, cmTheme } from '../lib/cmTheme';
import { configureMarkSerialisers, extraMarks } from '../lib/editorMarks';
import { fromEditor, toEditor } from '../lib/editorText';
import { enhance } from '../lib/enhance';
import {
  assetUrl,
  asDataUrl,
  dirName,
  isTauri,
  joinPath,
  localReferencePath,
  writeBinary,
} from '../lib/platform';
import { activeTheme, isDarkTheme, useSettings } from '../lib/settings';
import { liveEditors, useApp, type Doc } from '../lib/store';
import { toast } from '../lib/toast';
import { useLongPage, useViewSync } from '../lib/viewSync';

const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
const SNAP_BLOCKS = 'h1, h2, h3, h4, h5, h6, blockquote, ul, ol, hr, .milkdown-code-block, .milkdown-table-block';

/** Dims every block except the one holding the caret (the "focus paragraph" setting). */
const activeBlockKey = new PluginKey('mdv-active-block');
const activeBlock = $prose(
  () =>
    new Plugin({
      key: activeBlockKey,
      props: {
        decorations(state) {
          const { $from } = state.selection;
          if ($from.depth < 1) return null;
          const start = $from.before(1);
          const node = state.doc.nodeAt(start);
          if (!node) return null;
          return DecorationSet.create(state.doc, [Decoration.node(start, start + node.nodeSize, { class: 'is-active-block' })]);
        },
      },
    }),
);

/** Styles a quote that starts with [!NOTE], [!TIP]… as the callout it becomes in Reading mode. */
const ALERT_MARK = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i;
const alertBlocks = $prose(
  () =>
    new Plugin({
      key: new PluginKey('mdv-alerts'),
      props: {
        decorations(state) {
          const found: Decoration[] = [];
          state.doc.descendants((node, pos) => {
            if (node.type.name !== 'blockquote') return node.isBlock && !node.isTextblock;
            const m = ALERT_MARK.exec(node.firstChild?.textContent ?? '');
            if (m) found.push(Decoration.node(pos, pos + node.nodeSize, { class: `markdown-alert markdown-alert-${m[1].toLowerCase()}` }));
            return true;
          });
          return found.length ? DecorationSet.create(state.doc, found) : null;
        },
      },
    }),
);

export function Editor({ doc, active, onPreparing, onReady, onError }: {
  doc: Doc;
  active: boolean;
  onPreparing: () => void;
  onReady: () => void;
  onError: () => void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(0);
  const crepeRef = useRef<Crepe | null>(null);
  const s = useSettings((st) => st.settings);
  const systemDark = useSettings((st) => st.systemDark);
  const dark = isDarkTheme(activeTheme(s, systemDark));
  const docRef = useRef(doc);
  docRef.current = doc;
  const callbacks = useRef({ onPreparing, onReady, onError });
  callbacks.current = { onPreparing, onReady, onError };

  // Build the editor. It is rebuilt only when the text changes from outside (reload, source edits)
  // or when a setting that shapes the editor itself changes.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    callbacks.current.onPreparing();
    // An obsolete async create/destroy must only touch its own mount point.
    const editorRoot = document.createElement('div');
    host.append(editorRoot);
    const original = docRef.current.content;
    const originalLf = original.replace(/\r\n|\r/g, '\n');
    const eol = docRef.current.eol;
    const frontMatter = FRONT_MATTER.exec(originalLf)?.[0] ?? '';
    const body = toEditor(originalLf.slice(frontMatter.length));
    let disposed = false;
    let baseline: ProseNode | null = null;
    let baselineMarkdown: string | undefined;

    const saveImage = async (file: File): Promise<string> => {
      const d = docRef.current;
      try {
        if (!isTauri || !d.path) return await asDataUrl(file);
        const folder = useSettings.getState().settings.imageFolder.trim();
        const ext = (/\.([a-z0-9]+)$/i.exec(file.name)?.[1] ?? 'png').toLowerCase();
        const stem = file.name.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '-').slice(0, 50) || 'image';
        const name = `${stem}-${crypto.randomUUID().slice(0, 12)}.${ext}`;
        const dir = folder ? joinPath(dirName(d.path), folder) : dirName(d.path);
        await writeBinary(joinPath(dir, name), new Uint8Array(await file.arrayBuffer()));
        return folder ? `${folder}/${name}` : name;
      } catch (err) {
        toast.error("Couldn't save the image", String(err instanceof Error ? err.message : err));
        throw err;
      }
    };

    const crepe = new Crepe({
      root: editorRoot,
      defaultValue: body,
      features: {
        [Crepe.Feature.TopBar]: false,
        [Crepe.Feature.AI]: false,
        [Crepe.Feature.BlockEdit]: s.slashMenu,
        [Crepe.Feature.Toolbar]: s.selectionToolbar,
        [Crepe.Feature.Latex]: s.math,
      },
      featureConfigs: {
        [Crepe.Feature.Placeholder]: { text: 'Start writing, or type / for blocks', mode: 'doc' },
        // Our own gliding caret replaces the library's drawn one.
        [Crepe.Feature.Cursor]: { virtual: false, color: 'var(--accent)', width: 2 },
        [Crepe.Feature.ImageBlock]: {
          onUpload: saveImage,
          inlineOnUpload: saveImage,
          blockOnUpload: saveImage,
          proxyDomURL: (url: string) => {
            const path = docRef.current.path;
            const local = isTauri ? localReferencePath(url, path ? dirName(path) : '') : null;
            return local ? assetUrl(local) : url;
          },
        },
        [Crepe.Feature.CodeMirror]: {
          onCopy: () => toast.success('Copied'),
          theme: [cmTheme, syntaxHighlighting(cmHighlight)],
          // Math and diagrams show their result; the source opens when you click Edit on the block.
          previewOnlyByDefault: true,
          previewLabel: '',
          renderPreview: (language, content, applyPreview) => {
            if ((language ?? '').toLowerCase() !== 'mermaid' || !content.trim() || !useSettings.getState().settings.diagrams) return null;
            // Mermaid measures text, so it has to draw inside the document: render off-screen, then hand the result over.
            const holder = document.createElement('div');
            holder.className = 'prose';
            holder.style.cssText = 'position:fixed;left:-99999px;top:0;width:720px;visibility:hidden';
            const block = document.createElement('div');
            block.className = 'mermaid-block';
            block.dataset.source = content;
            holder.appendChild(block);
            document.body.appendChild(holder);
            const cleanup = enhance(holder, { theme: dark ? 'dark' : 'light' });
            const started = Date.now();
            const poll = () => {
              const finished = block.classList.contains('is-rendered') || block.querySelector('.mermaid-error');
              if (!finished && Date.now() - started < 8000) return void setTimeout(poll, 50);
              cleanup();
              holder.remove();
              if (!disposed) applyPreview(block);
            };
            poll();
            return undefined;
          },
        },
      },
    });

    crepe.editor.config((ctx) => {
      ctx.update(remarkStringifyOptionsCtx, (prev) => ({
        ...prev,
        bullet: '-' as const,
        bulletOther: '*' as const,
        emphasis: '*' as const,
        strong: '*' as const,
        rule: '-' as const,
        fences: true,
        listItemIndent: 'one' as const,
        incrementListMarker: true,
      }));
      configureMarkSerialisers(ctx);
      // An empty line is added after the last block only when you couldn't otherwise type after it
      // (code, tables, math, images). After a list or quote it was a phantom line the Down key reached.
      ctx.update(trailingConfig.key, (prev) => ({
        ...prev,
        shouldAppend: (last: ProseNode | null) => !!last && /code|table|math|image|hr|html|diagram/i.test(last.type.name),
      }));
    });
    crepe.editor.use(activeBlock).use(alertBlocks).use(extraMarks);

    // Delay serialisation until there is an actual edit, including the untouched baseline.
    let unsent = false;
    let reportTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      clearTimeout(reportTimer);
      if (disposed || !unsent || baseline === null) return;
      unsent = false;
      const app = useApp.getState();
      if (!app.docs.some((d) => d.id === doc.id && d.rev === doc.rev)) return;
      const untouched = baseline;
      const next = crepe.editor.action((ctx) => {
        const current = ctx.get(editorViewCtx).state.doc;
        if (current.eq(untouched)) return original;
        const serialize = ctx.get(serializerCtx);
        baselineMarkdown ??= serialize(untouched);
        const markdown = serialize(current);
        // The original bytes survive undo and changes that only affect editor presentation.
        return markdown === baselineMarkdown ? original : (frontMatter + fromEditor(markdown)).replace(/\n/g, eol);
      });
      app.setContent(doc.id, next, true);
    };
    const trackEdits = $prose(
      () =>
        new Plugin({
          key: new PluginKey('mdv-unsent'),
          view: () => ({
            update(view, prev) {
              if (baseline === null || view.state.doc.eq(prev.doc)) return;
              unsent = true;
              clearTimeout(reportTimer);
              reportTimer = setTimeout(flush, 200);
            },
          }),
        }),
    );
    crepe.editor.use(trackEdits);
    liveEditors.add(flush);

    let snapObserver: MutationObserver | undefined;
    void crepe.create().then(() => {
      if (disposed) return;
      baseline = crepe.editor.action((ctx) => ctx.get(editorViewCtx).state.doc);
      crepeRef.current = crepe;
      crepe.setReadonly(docRef.current.readonly);
      const pm = editorRoot.querySelector<HTMLElement>('.ProseMirror');
      if (pm) {
        pm.spellcheck = s.spellcheck;
        // The snap: when a line turns into a heading, quote, list… the new block settles in.
        // Web Animations leave the DOM untouched, so ProseMirror never notices.
        snapObserver = new MutationObserver((muts) => {
          if (useSettings.getState().settings.motion !== 'full') return;
          for (const m of muts) {
            // Only a 1-for-1 swap is a block changing type; pastes and reloads add many nodes at once.
            if (m.addedNodes.length !== 1 || m.removedNodes.length !== 1) continue;
            const el = m.addedNodes[0];
            if (el instanceof HTMLElement && el.matches(SNAP_BLOCKS)) {
              el.animate(
                [
                  { opacity: 0.3, transform: 'translateY(4px) scale(0.985)' },
                  { opacity: 1, transform: 'none' },
                ],
                { duration: 280, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
              );
            }
          }
        });
        snapObserver.observe(pm, { childList: true });
      }
      if (import.meta.env.DEV) {
        (window as unknown as Record<string, unknown>).__mdvEditor = () => frontMatter + fromEditor(crepe.getMarkdown());
      }
      setReady((n) => n + 1);
      callbacks.current.onReady();
    }).catch((error) => {
      if (disposed) return;
      toast.error("Couldn't open Edit", String(error instanceof Error ? error.message : error));
      callbacks.current.onError();
    });

    return () => {
      // Switching tabs or modes right after typing: hand the last keystrokes over first.
      flush();
      liveEditors.delete(flush);
      disposed = true;
      if (crepeRef.current === crepe) crepeRef.current = null;
      snapObserver?.disconnect();
      void crepe.destroy();
      editorRoot.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, doc.rev, s.slashMenu, s.selectionToolbar, s.math, s.spellcheck, s.diagrams, dark]);

  useLongPage(scrollerRef, ready);
  useViewSync(doc, scrollerRef, hostRef, ready, active);

  // Like Notepad: clicking the empty page below the text puts the caret at the very end;
  // clicking in the side margin puts it on the nearest line.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!active || !ready || !scroller) return;
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || e.shiftKey || e.detail > 1) return;
      const host = hostRef.current;
      const pm = host?.querySelector<HTMLElement>('.ProseMirror');
      const crepe = crepeRef.current;
      if (!host || !pm || !crepe) return;
      const target = e.target as Element;
      const last = pm.lastElementChild as HTMLElement | null;
      const below = !last || e.clientY > last.getBoundingClientRect().bottom;
      const inMargin = target === scroller || target === host || target === pm;
      if (!(below && (inMargin || pm.contains(target))) && !inMargin) return;
      e.preventDefault();
      e.stopPropagation();
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        let selection: Selection = Selection.atEnd(view.state.doc);
        if (!below) {
          const box = pm.getBoundingClientRect();
          const hit = view.posAtCoords({ left: Math.min(Math.max(e.clientX, box.left + 2), box.right - 2), top: e.clientY });
          if (hit) selection = TextSelection.near(view.state.doc.resolve(hit.pos));
        }
        view.focus();
        view.dispatch(view.state.tr.setSelection(selection).scrollIntoView());
      });
    };
    scroller.addEventListener('mousedown', onDown, true);
    return () => scroller.removeEventListener('mousedown', onDown, true);
  }, [active, ready]);

  useEffect(() => {
    if (!active || !ready || !s.smoothCaret || !scrollerRef.current) return;
    const pm = hostRef.current?.querySelector<HTMLElement>('.ProseMirror');
    if (pm) return attachSmoothCaret(scrollerRef.current, pm);
  }, [active, ready, s.smoothCaret]);

  // Entering Editing mode means you want to type: place the caret, without scrolling the page.
  useLayoutEffect(() => {
    if (!active || !ready || doc.readonly) return;
    const focused = document.activeElement;
    if (focused?.closest('.findbar, [role="dialog"], [role="alertdialog"]')) return;
    const scroller = scrollerRef.current;
    const top = scroller?.scrollTop ?? 0;
    crepeRef.current?.editor.action((ctx) => ctx.get(editorViewCtx).focus());
    if (scroller) scroller.scrollTop = top;
  }, [active, ready, doc.readonly]);

  // Typewriter scrolling: keep the line being typed at a fixed height.
  useEffect(() => {
    if (!active || !s.typewriter) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    let raf = 0;
    const recentre = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const sel = document.getSelection();
        if (!sel?.rangeCount || !sel.isCollapsed || !hostRef.current?.contains(sel.anchorNode)) return;
        const range = sel.getRangeAt(0);
        const rect = range.getClientRects()[0] ?? (sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement)?.getBoundingClientRect();
        if (!rect) return;
        const box = scroller.getBoundingClientRect();
        const delta = rect.top - (box.top + box.height * 0.42);
        if (Math.abs(delta) > 6) scroller.scrollBy({ top: delta, behavior: 'smooth' });
      });
    };
    const host = hostRef.current;
    host?.addEventListener('keyup', recentre);
    host?.addEventListener('input', recentre);
    return () => {
      cancelAnimationFrame(raf);
      host?.removeEventListener('keyup', recentre);
      host?.removeEventListener('input', recentre);
    };
  }, [active, s.typewriter, ready]);

  return (
    <div
      className="doc-scroller"
      ref={scrollerRef}
      data-mode="edit"
      data-typewriter={s.typewriter || undefined}
    >
      <div className="prose editor" ref={hostRef} data-ready={ready > 0 || undefined} />
    </div>
  );
}
