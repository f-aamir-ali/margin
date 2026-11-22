import { AnimatePresence, motion } from 'motion/react';
import { ArrowUp } from 'lucide-react';
import { useEffect, useState } from 'react';
import { scrollBehavior } from '../lib/viewSync';
import { SPRING } from './ui/controls';

/** How far down (in screen heights) before the button appears. */
const SHOW_AFTER_SCREENS = 1.5;

function visibleScroller(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.doc-view .doc-stage[data-visible] .doc-scroller') ?? document.querySelector<HTMLElement>('.doc-view .doc-scroller');
}

/** A "back to top" button for long documents, shown once you've scrolled well down. */
export function ScrollTop({ docId }: { docId: string }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const host = document.querySelector<HTMLElement>('.doc-view');
    if (!host) return;
    let raf = 0;
    const check = () => {
      raf = 0;
      const s = visibleScroller();
      setShow(!!s && s.scrollTop > s.clientHeight * SHOW_AFTER_SCREENS);
    };
    // Scroll events don't bubble, but they can be caught on the way down.
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(check);
    };
    host.addEventListener('scroll', onScroll, { capture: true, passive: true });
    check();
    return () => {
      host.removeEventListener('scroll', onScroll, { capture: true });
      if (raf) cancelAnimationFrame(raf);
    };
  }, [docId]);

  return (
    <AnimatePresence>
      {show && (
        <motion.button
          type="button"
          className="scroll-top"
          aria-label="Back to top"
          data-tip="Back to top"
          data-tip-keys="Ctrl+Home"
          data-tip-side="top"
          initial={{ opacity: 0, y: 10, scale: 0.9 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.92, transition: { duration: 0.14 } }}
          transition={SPRING}
          onClick={() => {
            const s = visibleScroller();
            if (!s) return;
            // Counts as the reader scrolling: stop any pending restore of the old position.
            s.dispatchEvent(new WheelEvent('wheel'));
            s.scrollTo({ top: 0, behavior: scrollBehavior() });
          }}
        >
          <ArrowUp size={16} strokeWidth={2.2} />
        </motion.button>
      )}
    </AnimatePresence>
  );
}
