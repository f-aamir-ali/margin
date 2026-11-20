import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

export const SPRING = { type: 'spring', stiffness: 420, damping: 36, mass: 1 } as const;
export const SPRING_SOFT = { type: 'spring', stiffness: 380, damping: 34, mass: 1 } as const;
export const SPRING_BOUNCY = { type: 'spring', stiffness: 500, damping: 26, mass: 0.8 } as const;

/* ---------- IconButton ---------- */

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  ref?: React.Ref<HTMLButtonElement>;
  keys?: string;
  active?: boolean;
  tipSide?: 'top' | 'bottom' | 'left' | 'right';
}

export function IconButton({ label, keys, active, tipSide = 'bottom', className = '', children, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      data-tip={label}
      data-tip-keys={keys}
      data-tip-side={tipSide}
      data-active={active || undefined}
      className={`icon-btn ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/* ---------- Button ---------- */

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'solid' | 'soft' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  ref?: React.Ref<HTMLButtonElement>;
}

export function Button({ variant = 'soft', size = 'md', className = '', ...rest }: ButtonProps) {
  return <button type="button" className={`btn btn-${variant} btn-${size} ${className}`} {...rest} />;
}

/* ---------- Segmented control with a sliding thumb ---------- */

interface SegmentedProps<T extends string> {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; title?: string; keys?: string }[];
  size?: 'sm' | 'md';
  ariaLabel?: string;
}

export function Segmented<T extends string>({ value, onChange, options, size = 'md', ariaLabel }: SegmentedProps<T>) {
  const id = useId();
  return (
    <div className={`segmented segmented-${size}`} role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            data-on={on || undefined}
            data-tip={o.title}
            data-tip-keys={o.keys}
            className="segmented-item"
            onClick={() => onChange(o.value)}
          >
            {on && <motion.span layoutId={`seg-${id}`} className="segmented-thumb" transition={SPRING} />}
            <span className="segmented-label">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ---------- Switch ---------- */

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-on={checked || undefined}
      className="switch"
      onClick={() => onChange(!checked)}
    >
      <motion.span className="switch-knob" layout transition={SPRING_BOUNCY} />
    </button>
  );
}

/* ---------- Slider ---------- */

interface SliderProps {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  label?: string;
}

export function Slider({ value, min, max, step, onChange, format, label }: SliderProps) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="slider">
      <div className="slider-track">
        <div className="slider-fill" style={{ width: `${pct}%` }} />
        <input
          type="range"
          aria-label={label}
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <div className="slider-thumb" style={{ left: `${pct}%` }} />
      </div>
      <span className="slider-value">{format ? format(value) : value}</span>
    </div>
  );
}

/* ---------- Select (custom popover) ---------- */

interface SelectProps<T extends string> {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; style?: React.CSSProperties; hint?: string }[];
  label?: string;
  width?: number;
}

export function Select<T extends string>({ value, onChange, options, label, width = 190 }: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    setCursor(Math.max(0, options.findIndex((o) => o.value === value)));
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown, true);
    return () => window.removeEventListener('mousedown', onDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => (c + 1) % options.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => (c - 1 + options.length) % options.length);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onChange(options[cursor].value);
      setOpen(false);
    }
  };

  return (
    <div className="select" ref={ref} style={{ width }}>
      <button
        type="button"
        className="select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        data-open={open || undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKey}
      >
        <span className="select-value" style={current?.style}>
          {current?.label}
        </span>
        <motion.span className="select-chevron" animate={{ rotate: open ? 180 : 0 }} transition={SPRING}>
          <ChevronDown size={14} />
        </motion.span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="popover select-menu"
            role="listbox"
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98, transition: { duration: 0.1 } }}
            transition={SPRING}
          >
            {options.map((o, i) => (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={o.value === value}
                data-cursor={i === cursor || undefined}
                className="menu-item"
                onMouseEnter={() => setCursor(i)}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                <span style={o.style}>{o.label}</span>
                {o.hint && <span className="menu-hint">{o.hint}</span>}
                {o.value === value && <Check size={14} className="menu-check" />}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ---------- Popover menu anchored to a trigger ---------- */

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  keys?: string;
  danger?: boolean;
  checked?: boolean;
  separatorBefore?: boolean;
  disabled?: boolean;
  run: () => void;
}

export function Menu({
  items,
  onClose,
  align = 'right',
  style,
  anchor,
  side = 'bottom',
}: {
  items: MenuItem[];
  onClose: () => void;
  align?: 'left' | 'right';
  style?: React.CSSProperties;
  anchor?: RefObject<HTMLButtonElement | null>;
  side?: 'top' | 'bottom';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const present = useIsPresent();
  const [position, setPosition] = useState<React.CSSProperties>();
  const [cursor, setCursor] = useState(-1);

  useLayoutEffect(() => {
    if (!anchor || !present) return;
    const place = () => {
      const bounds = anchor.current?.getBoundingClientRect();
      if (!bounds) return;
      const edge = side === 'top' ? window.innerHeight - bounds.top + 6 : bounds.bottom + 6;
      setPosition({
        position: 'fixed',
        top: side === 'top' ? 'auto' : edge,
        bottom: side === 'top' ? edge : 'auto',
        right: Math.max(8, window.innerWidth - bounds.right),
        maxHeight: Math.max(0, window.innerHeight - edge - 8),
        transformOrigin: side === 'top' ? 'bottom right' : 'top right',
      });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor, present, side]);

  useLayoutEffect(() => {
    if (cursor >= 0) ref.current?.querySelector('[data-cursor]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  useEffect(() => {
    if (!present) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !anchor?.current?.contains(target)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const usable = items.flatMap((item, i) => item.disabled ? [] : [i]);
        if (!usable.length) return;
        setCursor((c) => {
          const cur = usable.indexOf(c);
          const dir = e.key === 'ArrowDown' ? 1 : -1;
          if (cur < 0) return dir === 1 ? usable[0] : usable[usable.length - 1];
          return usable[(cur + dir + usable.length) % usable.length];
        });
      } else if (e.key === 'Enter' && items[cursor] && !items[cursor].disabled) {
        e.preventDefault();
        items[cursor].run();
        onClose();
      }
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [anchor, cursor, items, onClose, present]);

  const menu = (
    <motion.div
      ref={ref}
      className="popover menu"
      role="menu"
      data-align={align}
      style={{ ...position, ...style, pointerEvents: present ? undefined : 'none' }}
      inert={!present}
      initial={{ opacity: 0, y: side === 'top' ? 6 : -6, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.98, transition: { duration: 0.1 } }}
      transition={SPRING}
    >
      {items.map((item, i) => (
        <div key={item.id}>
          {item.separatorBefore && <div className="menu-sep" />}
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled}
            data-cursor={i === cursor || undefined}
            data-danger={item.danger || undefined}
            className="menu-item"
            onMouseEnter={() => !item.disabled && setCursor(i)}
            onClick={() => {
              item.run();
              onClose();
            }}
          >
            {item.icon && <span className="menu-icon">{item.icon}</span>}
            <span>{item.label}</span>
            {item.checked && <Check size={14} className="menu-check" />}
            {item.keys && <Keys combo={item.keys} />}
          </button>
        </div>
      ))}
    </motion.div>
  );
  return anchor ? createPortal(menu, document.body) : menu;
}

/* ---------- Keyboard combo display ---------- */

export function Keys({ combo }: { combo: string }) {
  return (
    <span className="keys">
      {combo.split('+').map((k, i) => (
        <kbd key={i}>{k === 'Ctrl' ? 'Ctrl' : k === 'Shift' ? '⇧' : k}</kbd>
      ))}
    </span>
  );
}

/* ---------- Tooltip layer: one floating tip for every [data-tip] element ---------- */

export function TooltipLayer() {
  const [tip, setTip] = useState<{ text: string; keys?: string; x: number; y: number; side: string } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: Element | null = null;
    let warm = false;
    let cool: ReturnType<typeof setTimeout> | undefined;

    const show = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      const side = el.dataset.tipSide ?? 'bottom';
      const pos =
        side === 'top'
          ? { x: r.left + r.width / 2, y: r.top - 8 }
          : side === 'right'
            ? { x: r.right + 8, y: r.top + r.height / 2 }
            : side === 'left'
              ? { x: r.left - 8, y: r.top + r.height / 2 }
              : { x: r.left + r.width / 2, y: r.bottom + 8 };
      setTip({ text: el.dataset.tip as string, keys: el.dataset.tipKeys, side, ...pos });
      warm = true;
    };
    const hide = () => {
      clearTimeout(timer);
      current = null;
      setTip(null);
      clearTimeout(cool);
      cool = setTimeout(() => (warm = false), 400);
    };
    const over = (e: MouseEvent) => {
      const el = (e.target as Element).closest?.('[data-tip]') as HTMLElement | null;
      if (el === current) return;
      clearTimeout(timer);
      current = el;
      if (!el || !el.dataset.tip) return setTip(null);
      // After the first tooltip, neighbours show instantly (like a native toolbar).
      if (warm) show(el);
      else timer = setTimeout(() => show(el), 480);
    };
    document.addEventListener('mouseover', over);
    document.addEventListener('mousedown', hide, true);
    document.addEventListener('keydown', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      document.removeEventListener('mouseover', over);
      document.removeEventListener('mousedown', hide, true);
      document.removeEventListener('keydown', hide, true);
      window.removeEventListener('blur', hide);
      clearTimeout(timer);
      clearTimeout(cool);
    };
  }, []);

  // Keep the tip inside the window.
  useLayoutEffect(() => {
    if (!tip || !ref.current) return setShift(0);
    const r = ref.current.getBoundingClientRect();
    const overflowRight = r.right - shift - (window.innerWidth - 8);
    const overflowLeft = 8 - (r.left - shift);
    setShift(overflowRight > 0 ? -overflowRight : overflowLeft > 0 ? overflowLeft : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tip]);

  return (
    <AnimatePresence>
      {tip && (
        <motion.div
          ref={ref}
          key={tip.text}
          className="tooltip"
          data-side={tip.side}
          style={{ left: tip.x + shift, top: tip.y }}
          initial={{ opacity: 0, scale: 0.94 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.08 } }}
          transition={{ duration: 0.12 }}
        >
          {tip.text}
          {tip.keys && <Keys combo={tip.keys} />}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
