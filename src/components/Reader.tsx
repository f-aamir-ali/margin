import { useEffect, useMemo, useRef } from 'react';
import { enhance } from '../lib/enhance';
import { renderMarkdown, slugify } from '../lib/markdown';
import { assetUrl, baseName, dirName, isMarkdownPath, isTauri, isTextPath, localReferencePath, openExternal, openLinkedFile, safeDecode } from '../lib/platform';
import { activeTheme, isDarkTheme, useSettings } from '../lib/settings';
import { useApp, type Doc } from '../lib/store';
import { toast } from '../lib/toast';
import { useUi } from '../lib/ui';
import { flash, scrollToElement, useViewSync } from '../lib/viewSync';

const PREVIEW_IMAGE = /\.(?:apng|avif|bmp|gif|ico|jpe?g|jfif|png|svg|webp)$/i;

async function followLink(href: string, label: string, doc: Doc, docDir: string) {
  try {
    if (/^(?:https?:\/\/|mailto:|\/\/)/i.test(href)) {
      await openExternal(href.startsWith('//') ? 'https:' + href : href);
      return;
    }
    const path = localReferencePath(href, docDir);
    if (!path) {
      toast.info("Couldn't resolve the link", href);
    } else if (isMarkdownPath(path) || (isTauri && isTextPath(path))) {
      await useApp.getState().openPaths([path]);
    } else if (!isTauri) {
      await openExternal(new URL(href, new URL(doc.path ?? '/', window.location.href)).href);
    } else if (PREVIEW_IMAGE.test(path)) {
      useUi.getState().setLightbox({ src: assetUrl(path), alt: label.trim() || baseName(path) });
    } else {
      await openLinkedFile(path);
    }
  } catch (error) {
    toast.error("Couldn't open the link", String(error));
  }
}

export function Reader({ doc }: { doc: Doc }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  const s = useSettings((st) => st.settings);
  const systemDark = useSettings((st) => st.systemDark);
  const dark = isDarkTheme(activeTheme(s, systemDark));
  const docDir = doc.path ? dirName(doc.path) : '';

  const rendered = useMemo(() => {
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
    return { ...out, ms: performance.now() - started };
  }, [doc.content, docDir, s.breaks, s.linkify, s.typographer, s.emoji, s.math, s.rawHtml, s.codeLineNumbers]);

  // Put the HTML in the DOM ourselves so React never diffs a huge string.
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    el.innerHTML = rendered.html;
    if (!s.diagrams) {
      el.querySelectorAll<HTMLElement>('.mermaid-block').forEach((b) => {
        const pre = document.createElement('pre');
        pre.textContent = b.dataset.source ?? '';
        b.replaceWith(pre);
      });
    }
    return enhance(el, {
      theme: dark ? 'dark' : 'light',
      onCopy: (ok) => (ok ? toast.success('Copied') : toast.error("Couldn't copy")),
    });
  }, [rendered, dark, s.diagrams]);

  useViewSync(doc, scrollerRef, contentRef, rendered);

  // One delegated listener for links, task boxes and images.
  useEffect(() => {
    const el = contentRef.current;
    const scroller = scrollerRef.current;
    if (!el || !scroller) return;

    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;

      const box = target.closest<HTMLInputElement>('input.task-checkbox');
      if (box) {
        e.preventDefault();
        toggleTask(doc, Number(box.dataset.line));
        return;
      }

      const a = target.closest<HTMLAnchorElement>('a[href]');
      if (a) {
        e.preventDefault();
        const href = a.dataset.marginFile ?? a.getAttribute('href') ?? '';
        if (href.startsWith('#')) {
          const id = safeDecode(href.slice(1));
          const dest = el.querySelector<HTMLElement>(`#${CSS.escape(id)}`) ?? el.querySelector<HTMLElement>(`#${CSS.escape(slugify(id))}`);
          if (dest) {
            scrollToElement(scroller, dest);
            flash(dest);
          }
        } else if (href) {
          void followLink(href, a.textContent || a.querySelector('img')?.alt || '', doc, docDir);
        }
        return;
      }

      const img = target.closest<HTMLImageElement>('img');
      if (img && s.zoomImages && !img.closest('a')) {
        useUi.getState().setLightbox({ src: img.currentSrc || img.src, alt: img.alt });
      }
    };

    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, [doc, docDir, s.zoomImages]);

  return (
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
  );
}

/** Flip `[ ]` / `[x]` on one source line. This is a real edit, limited to that single character. */
function toggleTask(doc: Doc, line: number) {
  if (Number.isNaN(line)) return;
  if (doc.readonly) {
    toast.warn('This file is read-only');
    return;
  }
  const lines = doc.content.split(doc.eol);
  // The checkbox's block may start a line or two above the marker in nested lists: search a small window.
  for (let i = line; i < Math.min(lines.length, line + 3); i++) {
    const m = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/.exec(lines[i]);
    if (m) {
      lines[i] = `${m[1]}[${m[2] === ' ' ? 'x' : ' '}]${lines[i].slice(m[0].length)}`;
      useApp.getState().setContent(doc.id, lines.join(doc.eol));
      return;
    }
  }
}
