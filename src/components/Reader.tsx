import { useEffect, useMemo, useReducer, useRef } from 'react';
import { enhance, type EnhanceOptions } from '../lib/enhance';
import { renderMarkdown, slugify, type RenderResult } from '../lib/markdown';
import { assetUrl, dirName, isMarkdownPath, isTauri, localReferencePath, openExternal, openLinkedFile, safeDecode } from '../lib/platform';
import { activeTheme, isDarkTheme, useSettings } from '../lib/settings';
import { pathKey, samePath, useApp, type Doc } from '../lib/store';
import { toast } from '../lib/toast';
import { useUi } from '../lib/ui';
import { flash, scrollToElement, useLongPage, useViewSync } from '../lib/viewSync';

const LINK_HINT = 'Ctrl+click to open in Margin';
/** A remote address at the start of a value, or after a space, comma, quote or bracket (src, srcset, url()). */
const REMOTE_REF = /(?:^|[\s,('"])(?:https?:)?\/\//i;
/** Remote src, srcset or poster values inside the sanitised HTML string. */
const REMOTE_IN_HTML = /\s(?:src|srcset|poster)="(?:[^"]*[\s,])?(?:https?:)?\/\//i;
const TASK_MARKER = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/;

/** Links opened in Margin whose #fragment waits for the new tab to render. Keyed by pathKey. */
const pendingFragments = new Map<string, string>();
/** Tabs (by doc id) that may load internet images for this session, after "Load for this note". */
const remoteAllowed = new Set<string>();

type Rendered = RenderResult & { ms: number; source: string };

interface Shown {
  /** The render the article DOM was built from. */
  render: Rendered | null;
  diagrams: boolean;
  blocking: boolean;
  dark: boolean;
  /** enhance() cleanup for the current DOM. */
  off?: () => void;
}

async function followLink(href: string, doc: Doc, docDir: string) {
  try {
    if (/^(?:https?:\/\/|mailto:|\/\/)/i.test(href)) {
      await openExternal(href.startsWith('//') ? 'https:' + href : href);
      return;
    }
    const path = localReferencePath(href, docDir);
    if (!path) {
      toast.info("Couldn't resolve the link", href);
    } else if (isTauri) {
      await openLinkedFile(path);
    } else if (isMarkdownPath(path)) {
      await useApp.getState().openPaths([path]);
    } else {
      await openExternal(new URL(href, new URL(doc.path ?? '/', window.location.href)).href);
    }
  } catch (error) {
    toast.error("Couldn't open the link", String(error));
  }
}

/** The local Markdown file a link points at, or null for web links, in-page anchors and other files. */
function markdownTarget(href: string, docDir: string): string | null {
  if (!href || href.startsWith('#') || /^(?:https?:\/\/|mailto:|\/\/)/i.test(href)) return null;
  const path = localReferencePath(href, docDir);
  return path && isMarkdownPath(path) ? path : null;
}

/** The decoded #fragment of a link destination, or '' when it has none. */
export function linkFragment(href: string): string {
  const hash = href.indexOf('#');
  return hash < 0 ? '' : safeDecode(href.slice(hash + 1));
}

/** The element with this id, or the one with the id's GitHub-style slug. */
function findTarget(root: HTMLElement, id: string): HTMLElement | null {
  if (!id) return null;
  return root.querySelector<HTMLElement>(`#${CSS.escape(id)}`) ?? root.querySelector<HTMLElement>(`#${CSS.escape(slugify(id))}`);
}

/** Adds the Ctrl+click hint to the tooltip of every link that opens a Markdown file. */
function markLocalLinks(root: HTMLElement, docDir: string) {
  for (const a of Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
    if (!markdownTarget(a.dataset.marginFile ?? a.getAttribute('href') ?? '', docDir)) continue;
    a.title = a.title ? `${a.title} (${LINK_HINT})` : LINK_HINT;
  }
}

/**
 * Scrolls to `dest`, then holds that place while the note settles, because images and diagrams change its
 * height after the first paint. Stops at the first wheel, click or key press, or after 2.5 s.
 */
function scrollAndHold(scroller: HTMLElement, content: HTMLElement, dest: HTMLElement) {
  const place = () => {
    scroller.scrollTop = Math.max(0, dest.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 28);
  };
  scrollToElement(scroller, dest);
  flash(dest);
  const ro = new ResizeObserver(place);
  ro.observe(content);
  const events = ['wheel', 'pointerdown', 'keydown'] as const;
  const stop = () => {
    ro.disconnect();
    window.clearTimeout(timer);
    for (const type of events) scroller.removeEventListener(type, stop);
  };
  const timer = window.setTimeout(stop, 2500);
  for (const type of events) scroller.addEventListener(type, stop, { passive: true });
}

/** Opens a Markdown file in Margin. A #fragment is kept so the note scrolls to that heading once it renders. */
async function openInMargin(path: string, fragment: string) {
  const key = pathKey(path);
  try {
    if (fragment) pendingFragments.set(key, fragment);
    await useApp.getState().openPaths([path]);
    const opened = useApp.getState().docs.find((d) => d.path && samePath(d.path, path));
    if (!opened) {
      pendingFragments.delete(key);
      return;
    }
    // A heading jump needs the reading view, which is the view that holds the fragment's target.
    if (fragment && opened.mode !== 'read') useApp.getState().setMode(opened.id, 'read');
  } catch (error) {
    pendingFragments.delete(key);
    toast.error("Couldn't open the link", String(error));
  }
}

/**
 * Flips the task marker on `line` (or up to two lines below it, for nested lists) in the source.
 * Returns the new source and the box's state after the flip, or null when there is no marker.
 */
export function toggleTaskSource(content: string, eol: string, line: number): { content: string; checked: boolean } | null {
  if (Number.isNaN(line)) return null;
  const lines = content.split(eol);
  for (let i = line; i < Math.min(lines.length, line + 3); i++) {
    const m = TASK_MARKER.exec(lines[i]);
    if (m) {
      const checked = m[2] === ' ';
      lines[i] = `${m[1]}[${checked ? 'x' : ' '}]${lines[i].slice(m[0].length)}`;
      return { content: lines.join(eol), checked };
    }
  }
  return null;
}

function isRemote(value: string | null): boolean {
  return !!value && REMOTE_REF.test(value);
}

/**
 * Replaces internet images under `root` with their alt text and drops remote sources, so the browser never
 * requests them. Build the nodes in a template first: a template's images do not load. Returns the count replaced.
 */
export function blockRemoteImages(root: ParentNode): number {
  let replaced = 0;
  for (const img of Array.from(root.querySelectorAll('img'))) {
    if (!isRemote(img.getAttribute('src')) && !isRemote(img.getAttribute('srcset'))) continue;
    const alt = img.getAttribute('alt')?.trim() ?? '';
    const placeholder = document.createElement('span');
    placeholder.className = 'remote-image';
    placeholder.setAttribute('role', 'img');
    placeholder.setAttribute('aria-label', alt ? `${alt} (not loaded)` : 'Image not loaded');
    placeholder.title = 'Internet images are off. Turn them on in Settings, or load them for this note.';
    placeholder.textContent = alt || 'Image';
    img.replaceWith(placeholder);
    replaced++;
  }
  for (const el of Array.from(root.querySelectorAll('*'))) {
    for (const name of ['src', 'srcset', 'poster']) {
      if (isRemote(el.getAttribute(name))) el.removeAttribute(name);
    }
    const style = el.getAttribute('style');
    if (style && /url\(/i.test(style) && REMOTE_REF.test(style)) el.removeAttribute('style');
  }
  return replaced;
}

export function Reader({ doc }: { doc: Doc }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  const shownRef = useRef<Shown>({ render: null, diagrams: true, blocking: false, dark: false });
  /** The source a checkbox click just wrote. The DOM already shows it, so the next render keeps the DOM. */
  const taskEcho = useRef<string | null>(null);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const s = useSettings((st) => st.settings);
  const systemDark = useSettings((st) => st.systemDark);
  const dark = isDarkTheme(activeTheme(s, systemDark));
  const docDir = doc.path ? dirName(doc.path) : '';
  const blocking = !s.remoteImages && !remoteAllowed.has(doc.id);

  const rendered = useMemo<Rendered>(() => {
    const started = performance.now();
    const out = renderMarkdown(doc.content, {
      breaks: s.breaks,
      linkify: s.linkify,
      typographer: s.typographer,
      emoji: s.emoji,
      math: s.math,
      html: s.rawHtml,
      lineNumbers: s.codeLineNumbers,
      localFiles: isTauri,
      resolveUrl: (url, kind) => {
        const local = kind === 'image' && isTauri ? localReferencePath(url, docDir) : null;
        return local ? assetUrl(local) : url;
      },
    });
    return { ...out, ms: performance.now() - started, source: doc.content };
  }, [doc.content, docDir, s.breaks, s.linkify, s.typographer, s.emoji, s.math, s.rawHtml, s.codeLineNumbers]);

  const remoteInHtml = useMemo(() => REMOTE_IN_HTML.test(rendered.html), [rendered.html]);

  // Builds the article only when its HTML, the diagram setting or the image policy changes. A checkbox toggle keeps
  // the DOM (taskEcho), and a theme change only draws the diagrams again, since the article HTML does not depend on it.
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const shown = shownRef.current;
    const echoed = taskEcho.current !== null && taskEcho.current === rendered.source;
    taskEcho.current = null;
    if (echoed) {
      shown.render = rendered;
      return;
    }
    const options: EnhanceOptions = {
      theme: dark ? 'dark' : 'light',
      onCopy: (ok) => (ok ? toast.success('Copied') : toast.error("Couldn't copy")),
    };
    if (shown.render !== rendered || shown.diagrams !== s.diagrams || shown.blocking !== blocking) {
      shown.off?.();
      if (blocking) {
        const template = document.createElement('template');
        template.innerHTML = rendered.html;
        blockRemoteImages(template.content);
        el.replaceChildren(template.content);
      } else {
        el.innerHTML = rendered.html;
      }
      if (!s.diagrams) {
        el.querySelectorAll<HTMLElement>('.mermaid-block').forEach((b) => {
          const pre = document.createElement('pre');
          pre.textContent = b.dataset.source ?? '';
          b.replaceWith(pre);
        });
      }
      if (docDir) markLocalLinks(el, docDir);
      shown.off = enhance(el, options);
    } else if (shown.dark !== dark) {
      shown.off?.();
      shown.off = enhance(el, options);
    }
    shown.render = rendered;
    shown.diagrams = s.diagrams;
    shown.blocking = blocking;
    shown.dark = dark;
  }, [rendered, dark, s.diagrams, blocking]);

  useEffect(
    () => () => {
      const shown = shownRef.current;
      shown.off?.();
      shown.off = undefined;
      // Unmounting cleans up the diagrams. A remount (StrictMode) must build the article again.
      shown.render = null;
    },
    [],
  );

  useLongPage(scrollerRef, rendered);
  useViewSync(doc, scrollerRef, contentRef, rendered);

  // A Ctrl+click that opened this note with a #fragment: scroll to that heading once it is on screen. The scroll waits a
  // tick: StrictMode runs this effect twice, and the scroll restore in useViewSync runs in between and would undo it.
  // The cleanup cancels a tick that a re-run replaces, and the fragment is only taken when the tick fires.
  useEffect(() => {
    if (!doc.path) return;
    const key = pathKey(doc.path);
    const el = contentRef.current;
    const scroller = scrollerRef.current;
    if (!pendingFragments.has(key) || !el || !scroller) return;
    const timer = window.setTimeout(() => {
      const fragment = pendingFragments.get(key);
      pendingFragments.delete(key);
      const dest = fragment === undefined ? null : findTarget(el, fragment);
      if (dest) scrollAndHold(scroller, el, dest);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [doc.id, rendered]);

  // One delegated listener for links, task boxes and images.
  useEffect(() => {
    const el = contentRef.current;
    const scroller = scrollerRef.current;
    if (!el || !scroller) return;

    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;

      const box = target.closest<HTMLInputElement>('input.task-checkbox');
      if (box) {
        // The browser has already flipped the box. Write the same change to the source, or put the box back.
        const current = useApp.getState().docs.find((d) => d.id === doc.id);
        const next = current && !current.readonly ? toggleTaskSource(current.content, current.eol, Number(box.dataset.line)) : null;
        if (!next) {
          e.preventDefault();
          if (current?.readonly) toast.warn('This file is read-only');
          return;
        }
        box.checked = next.checked;
        taskEcho.current = next.content;
        useApp.getState().setContent(doc.id, next.content);
        return;
      }

      const a = target.closest<HTMLAnchorElement>('a[href]');
      if (a) {
        e.preventDefault();
        const href = a.dataset.marginFile ?? a.getAttribute('href') ?? '';
        if (href.startsWith('#')) {
          const dest = findTarget(el, linkFragment(href));
          if (dest) {
            scrollToElement(scroller, dest);
            flash(dest);
          }
        } else if (href) {
          const markdown = e.ctrlKey ? markdownTarget(href, docDir) : null;
          if (markdown) void openInMargin(markdown, linkFragment(href));
          else void followLink(href, doc, docDir);
        }
        return;
      }

      const img = target.closest<HTMLImageElement>('img');
      if (img && s.zoomImages && !img.closest('a')) {
        useUi.getState().setLightbox({ src: img.currentSrc || img.src, alt: img.alt });
      }
    };

    // Ctrl+Enter on a focused link works like Ctrl+click.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || !e.ctrlKey || !(e.target instanceof Element)) return;
      const a = e.target.closest<HTMLAnchorElement>('a[href]');
      const href = a ? (a.dataset.marginFile ?? a.getAttribute('href') ?? '') : '';
      const markdown = href ? markdownTarget(href, docDir) : null;
      if (!markdown) return;
      e.preventDefault();
      void openInMargin(markdown, linkFragment(href));
    };

    el.addEventListener('click', onClick);
    el.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('click', onClick);
      el.removeEventListener('keydown', onKey);
    };
  }, [doc, docDir, s.zoomImages]);

  const showRemoteBar = blocking && remoteInHtml;

  return (
    <>
      <div className="doc-scroller" ref={scrollerRef} tabIndex={-1} data-mode="read">
        <article className="prose reader" ref={contentRef} />
        {doc.content.trim() === '' && (
          <div className="doc-empty">
            <p>This document is empty.</p>
            <p className="doc-empty-hint">
              Press <kbd>Ctrl</kbd> <kbd>E</kbd> to start writing.
            </p>
          </div>
        )}
      </div>
      {showRemoteBar && (
        <div className="remote-bar" role="status">
          <span>Images from the internet are blocked.</span>
          <button
            type="button"
            className="remote-bar-action"
            onClick={() => {
              remoteAllowed.add(doc.id);
              bump();
            }}
          >
            Load for this note
          </button>
        </div>
      )}
    </>
  );
}
