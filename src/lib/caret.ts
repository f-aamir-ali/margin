/* A caret that glides between positions instead of teleporting.
   The native caret is hidden while this one is confident about where it should be;
   whenever it is not (odd selections, widgets), the native caret comes straight back. */

function caretRect(sel: Selection): DOMRect | null {
  const range = sel.getRangeAt(0);
  const rects = range.getClientRects();
  if (rects.length) {
    // At a soft wrap the browser reports both line ends; the last one is where typing lands.
    return rects[rects.length - 1];
  }
  const node = sel.anchorNode;
  if (!node) return null;
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node as Text;
    const probe = document.createRange();
    if (sel.anchorOffset < text.length) {
      probe.setStart(text, sel.anchorOffset);
      probe.setEnd(text, sel.anchorOffset + 1);
      const r = probe.getClientRects()[0];
      return r ? new DOMRect(r.left, r.top, 0, r.height) : null;
    }
    if (text.length > 0) {
      probe.setStart(text, text.length - 1);
      probe.setEnd(text, text.length);
      const r = probe.getClientRects()[0];
      return r ? new DOMRect(r.right, r.top, 0, r.height) : null;
    }
    return text.parentElement ? emptyBlockRect(text.parentElement) : null;
  }
  const el = node as Element;
  const child = el.childNodes[sel.anchorOffset] ?? el.childNodes[sel.anchorOffset - 1];
  if (child instanceof HTMLBRElement) {
    const r = child.getBoundingClientRect();
    if (r.height > 0) return new DOMRect(r.left, r.top, 0, r.height);
  }
  return emptyBlockRect(el);
}

function emptyBlockRect(el: Element): DOMRect | null {
  const r = el.getBoundingClientRect();
  if (r.height === 0) return null;
  const cs = getComputedStyle(el);
  const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padT = parseFloat(cs.paddingTop) || 0;
  const rtl = cs.direction === 'rtl';
  return new DOMRect(rtl ? r.right - padL : r.left + padL, r.top + padT, 0, Math.min(lh, r.height));
}

export function attachSmoothCaret(scroller: HTMLElement, pm: HTMLElement): () => void {
  const caret = document.createElement('div');
  caret.className = 'smooth-caret';
  caret.setAttribute('aria-hidden', 'true');
  scroller.appendChild(caret);
  // A zero-size marker at left:0/top:0 of the same containing block as the caret. Its rect is the
  // caret's true origin, whatever gutters, borders, padding or zoom sit between it and the scroller's
  // border box (`scrollbar-gutter: both-edges` once put the caret one gutter-width too far right).
  const origin = document.createElement('div');
  origin.className = 'smooth-caret-origin';
  origin.setAttribute('aria-hidden', 'true');
  scroller.appendChild(origin);
  let raf = 0;
  let first = true;
  let blinkTimer: ReturnType<typeof setTimeout> | undefined;

  const hide = () => {
    pm.classList.remove('has-smooth-caret');
    caret.dataset.visible = 'false';
    first = true;
  };

  const update = () => {
    raf = 0;
    const sel = document.getSelection();
    const anchor = sel?.anchorNode ?? null;
    const anchorEl = anchor instanceof Element ? anchor : anchor?.parentElement ?? null;
    if (
      !sel ||
      !sel.rangeCount ||
      !sel.isCollapsed ||
      !anchorEl ||
      !pm.contains(anchorEl) ||
      !pm.contains(document.activeElement) && document.activeElement !== pm ||
      anchorEl.closest('.cm-editor, input, textarea, [contenteditable="false"]')
    ) {
      return hide();
    }
    const rect = caretRect(sel);
    if (!rect || rect.height === 0) return hide();

    const box = scroller.getBoundingClientRect();
    const o = origin.getBoundingClientRect();
    // Works under any page zoom: compare visual size with layout size.
    const scale = scroller.offsetWidth ? box.width / scroller.offsetWidth : 1;
    // The marker scrolls with the content, so no scroll offsets are needed.
    const x = (rect.left - o.left) / scale;
    const y = (rect.top - o.top) / scale;
    const h = rect.height / scale;

    if (first) {
      // Appear in place; only subsequent moves glide.
      caret.style.transition = 'none';
      first = false;
      requestAnimationFrame(() => (caret.style.transition = ''));
    }
    caret.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`;
    caret.style.height = `${h.toFixed(2)}px`;
    caret.dataset.visible = 'true';
    pm.classList.add('has-smooth-caret');

    // Hold the caret solid while it moves; resume blinking once it rests.
    caret.dataset.blink = 'false';
    clearTimeout(blinkTimer);
    blinkTimer = setTimeout(() => (caret.dataset.blink = 'true'), 520);
  };

  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(update);
  };

  document.addEventListener('selectionchange', schedule);
  pm.addEventListener('input', schedule);
  pm.addEventListener('focusin', schedule);
  pm.addEventListener('focusout', schedule);
  window.addEventListener('resize', schedule);
  const ro = new ResizeObserver(schedule);
  ro.observe(pm);

  return () => {
    document.removeEventListener('selectionchange', schedule);
    pm.removeEventListener('input', schedule);
    pm.removeEventListener('focusin', schedule);
    pm.removeEventListener('focusout', schedule);
    window.removeEventListener('resize', schedule);
    ro.disconnect();
    if (raf) cancelAnimationFrame(raf);
    clearTimeout(blinkTimer);
    pm.classList.remove('has-smooth-caret');
    caret.remove();
    origin.remove();
  };
}
