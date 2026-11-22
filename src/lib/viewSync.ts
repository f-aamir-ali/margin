import { useEffect, useLayoutEffect, type RefObject } from 'react';
import { create } from 'zustand';
import { useSettings } from './settings';
import { useApp, type Doc } from './store';
import { useUi } from './ui';

/** Live facts about the visible document view, read by the outline and status bar. */
interface ViewStore {
  progress: number;
  activeHeading: number;
  selectionWords: number;
  selectionChars: number;
  /** Caret line and column (1-based) in Source mode and plain text; null elsewhere. */
  cursor: { line: number; col: number } | null;
  set: (p: Partial<Omit<ViewStore, 'set'>>) => void;
}

export const useView = create<ViewStore>((set) => ({
  progress: 0,
  activeHeading: -1,
  selectionWords: 0,
  selectionChars: 0,
  cursor: null,
  set: (p) => set(p),
}));

const HEADINGS = 'h1, h2, h3, h4, h5, h6';

/**
 * Documents whose saved scroll position is still being restored. While a document lays out
 * (markdown rendering, images, math, the editor building) the page is briefly too short, and
 * the scroll events that causes must not overwrite the position the reader left it at.
 */
export const restoringScroll = new Set<string>();

export function scrollBehavior(): ScrollBehavior {
  const s = useSettings.getState().settings;
  return s.smoothScroll && s.motion === 'full' ? 'smooth' : 'auto';
}

/** Scroll so `el` sits a comfortable distance below the top of `scroller`. */
export function scrollToElement(scroller: HTMLElement, el: Element, offset = 28) {
  const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - offset;
  scroller.scrollTo({ top: Math.max(0, top), behavior: scrollBehavior() });
}

/**
 * Room under the last line (so the end of a long document can be read at eye level) only when
 * the page is long enough to scroll. A short note doesn't scroll at all.
 * Call before `useViewSync` so the restored scroll position is measured with the final padding.
 */
export function useLongPage(scrollerRef: RefObject<HTMLElement | null>, contentKey?: unknown) {
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const content = scroller?.firstElementChild as HTMLElement | null | undefined;
    if (!scroller || !content) return;
    const check = () => {
      const pad = parseFloat(getComputedStyle(scroller).paddingTop) || 0;
      const long = content.offsetHeight + pad * 2 > scroller.clientHeight + 1;
      if (long) scroller.dataset.long = '';
      else delete scroller.dataset.long;
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(content);
    ro.observe(scroller);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentKey]);
}

/**
 * Shared scroll plumbing for Reading and Editing views:
 * restores the saved position, reports progress + the heading being read,
 * and answers "jump to heading N" requests from the outline.
 */
export function useViewSync(
  doc: Doc,
  scrollerRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  /** Changes whenever the content DOM has been rebuilt. */
  contentKey: unknown,
  active = true,
) {
  // Restore position (as a fraction, so it survives switching modes and font sizes).
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!active || !scroller) return;
    // Read once: the live value is rewritten as the page scrolls during layout.
    const target = doc.scroll;
    const id = doc.id;
    const apply = () => {
      const max = scroller.scrollHeight - scroller.clientHeight;
      scroller.scrollTop = max > 0 ? target * max : 0;
    };
    const settle = () => {
      if (!restoringScroll.delete(id)) return;
      const max = scroller.scrollHeight - scroller.clientHeight;
      useApp.getState().setScroll(id, max > 0 ? Math.min(1, scroller.scrollTop / max) : 0);
    };
    if (target > 0) restoringScroll.add(id);
    apply();
    // Images, math and diagrams change the height after first paint: re-apply until the user scrolls.
    let userScrolled = false;
    const stop = () => {
      userScrolled = true;
      settle();
    };
    scroller.addEventListener('wheel', stop, { passive: true, once: true });
    scroller.addEventListener('pointerdown', stop, { passive: true, once: true });
    scroller.addEventListener('keydown', stop, { passive: true, once: true });
    const ro = new ResizeObserver(() => {
      if (!userScrolled) apply();
    });
    if (contentRef.current) ro.observe(contentRef.current);
    const t = setTimeout(() => {
      ro.disconnect();
      settle();
    }, 2500);
    return () => {
      clearTimeout(t);
      ro.disconnect();
      restoringScroll.delete(id);
      scroller.removeEventListener('wheel', stop);
      scroller.removeEventListener('pointerdown', stop);
      scroller.removeEventListener('keydown', stop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, doc.id, contentKey]);

  // Track progress and the active heading.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!active || !scroller) return;
    let raf = 0;
    let headings: HTMLElement[] = [];
    const collect = () => {
      headings = Array.from(contentRef.current?.querySelectorAll<HTMLElement>(HEADINGS) ?? []).filter(
        (h) => !h.closest('.toc, .milkdown-code-block, .cm-editor'),
      );
    };
    const measure = () => {
      raf = 0;
      const max = scroller.scrollHeight - scroller.clientHeight;
      const progress = max > 0 ? Math.min(1, scroller.scrollTop / max) : 0;
      if (!restoringScroll.has(doc.id)) useApp.getState().setScroll(doc.id, progress);
      const line = scroller.getBoundingClientRect().top + 90;
      let active = -1;
      for (let i = 0; i < headings.length; i++) {
        if (headings[i].getBoundingClientRect().top <= line) active = i;
        else break;
      }
      // At the very bottom the last heading may never reach the line: select it anyway.
      if (max > 0 && scroller.scrollTop >= max - 2 && headings.length) active = headings.length - 1;
      const v = useView.getState();
      if (Math.abs(v.progress - progress) > 0.002 || v.activeHeading !== active) v.set({ progress, activeHeading: active });
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    collect();
    measure();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    const mo = new MutationObserver(() => {
      collect();
      onScroll();
    });
    if (contentRef.current) mo.observe(contentRef.current, { childList: true, subtree: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      mo.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, doc.id, contentKey]);

  // Jump requests.
  const jump = useUi((s) => s.jump);
  useEffect(() => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (!active || !jump || !scroller || !content) return;
    if (jump.index !== undefined) {
      const hs = Array.from(content.querySelectorAll<HTMLElement>(HEADINGS)).filter(
        (h) => !h.closest('.toc, .milkdown-code-block, .cm-editor'),
      );
      const el = hs[jump.index];
      if (el) {
        scrollToElement(scroller, el);
        flash(el);
      }
    } else if (jump.line === 0) {
      scroller.scrollTo({ top: 0, behavior: scrollBehavior() });
    } else if (jump.line !== undefined) {
      const blocks = Array.from(content.querySelectorAll<HTMLElement>('[data-line]'));
      let best: HTMLElement | null = null;
      for (const b of blocks) {
        if (Number(b.dataset.line) <= jump.line) best = b;
        else break;
      }
      if (best) scrollToElement(scroller, best);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump?.nonce]);
}

/** A brief highlight so the eye lands on the heading that was jumped to. */
export function flash(el: HTMLElement) {
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1200);
}
