import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, Check, CircleX, Info, X } from 'lucide-react';
import { useState } from 'react';
import { useToasts, type ToastItem } from '../lib/toast';
import { SPRING_BOUNCY } from './ui/controls';

const ICONS = {
  info: <Info size={16} />,
  success: <Check size={16} />,
  warn: <AlertTriangle size={16} />,
  error: <CircleX size={16} />,
};

/** A stack that sits collapsed (cards peeking behind the newest) and fans out on hover. */
export function Toasts() {
  const items = useToasts((s) => s.items);
  const [open, setOpen] = useState(false);
  const newestFirst = [...items].reverse();

  return (
    <div className="toasts" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} data-open={open || undefined}>
      <AnimatePresence>
        {newestFirst.map((t, depth) => (
          <Toast key={t.id} item={t} depth={depth} open={open} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function Toast({ item, depth, open }: { item: ToastItem; depth: number; open: boolean }) {
  const dismiss = useToasts((s) => s.dismiss);
  const collapsedY = -depth * 9;
  const expandedY = -depth * 66;
  return (
    <motion.div
      className="toast"
      data-kind={item.kind}
      role={item.kind === 'error' ? 'alert' : 'status'}
      style={{ zIndex: 10 - depth }}
      initial={{ opacity: 0, y: 28, scale: 0.92 }}
      animate={{
        opacity: open || depth < 3 ? 1 - (open ? 0 : depth * 0.22) : 0,
        y: open ? expandedY : collapsedY,
        scale: open ? 1 : 1 - depth * 0.045,
      }}
      exit={{ opacity: 0, y: 16, scale: 0.94, transition: { duration: 0.16 } }}
      transition={SPRING_BOUNCY}
      drag="x"
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={{ left: 0.05, right: 0.6 }}
      onDragEnd={(_, info) => {
        if (info.offset.x > 90 || info.velocity.x > 500) dismiss(item.id);
      }}
    >
      <span className="toast-icon">{ICONS[item.kind]}</span>
      <div className="toast-text">
        <span className="toast-title">{item.title}</span>
        {item.body && <span className="toast-body">{item.body}</span>}
      </div>
      {item.actionLabel && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            item.onAction?.();
            dismiss(item.id);
          }}
        >
          {item.actionLabel}
        </button>
      )}
      <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => dismiss(item.id)}>
        <X size={14} />
      </button>
    </motion.div>
  );
}
