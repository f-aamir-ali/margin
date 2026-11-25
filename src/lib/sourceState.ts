import { Compartment, EditorState, Facet } from '@codemirror/state';
import { EditorView, type ViewUpdate } from '@codemirror/view';

/**
 * Source-editor pieces shared by every Source editor, so a kept state can be reconfigured after
 * remount. Each mount re-applies the current settings to these, so no value is tied to one mount.
 */
export const compartments = {
  gutters: new Compartment(),
  wrap: new Compartment(),
  lang: new Compartment(),
  lineSep: new Compartment(),
  readOnly: new Compartment(),
  attrs: new Compartment(),
};

/** Which document a state belongs to. It lives in the state, so a kept state still knows its tab. */
export const docKey = Facet.define<string, string>({ combine: (values) => values[0] ?? '' });

/** What the mounted editor of one document handles. */
export interface SourceHandler {
  onUpdate(u: ViewUpdate): void;
}

const handlers = new Map<string, SourceHandler>();

export function setSourceHandler(id: string, handler: SourceHandler): void {
  handlers.set(id, handler);
}

export function clearSourceHandler(id: string, handler: SourceHandler): void {
  if (handlers.get(id) === handler) handlers.delete(id);
}

/** One listener for every state: it passes each update to the mounted editor of that document. */
export const routeUpdates = EditorView.updateListener.of((u) => {
  handlers.get(u.state.facet(docKey))?.onUpdate(u);
});

/* ---------- kept editor states (undo history and caret survive a tab switch) ---------- */

export interface KeptEditor {
  state: EditorState;
  /** The text the state holds, as the store knows it. */
  text: string;
  eol: string;
  kind: string;
  name: string;
}

const MAX_KEPT = 6;
/** Total text kept, in characters. A 20 MB log takes several times that in editor memory. */
const MAX_KEPT_CHARS = 48_000_000;
/** Insertion order is recency: the first entry is the least recently used. */
const kept = new Map<string, KeptEditor>();

/** Takes the kept state for a document if it still holds exactly `want`. The entry is removed either way. */
export function takeEditorState(id: string, want: Pick<KeptEditor, 'text' | 'eol' | 'kind' | 'name'>): EditorState | null {
  const hit = kept.get(id);
  if (!hit) return null;
  kept.delete(id);
  const same =
    hit.eol === want.eol &&
    hit.kind === want.kind &&
    hit.name === want.name &&
    hit.text.length === want.text.length &&
    hit.text === want.text;
  return same ? hit.state : null;
}

export function putEditorState(id: string, entry: KeptEditor): void {
  kept.delete(id);
  if (entry.text.length > MAX_KEPT_CHARS) return;
  kept.set(id, entry);
  let chars = 0;
  for (const e of kept.values()) chars += e.text.length;
  for (const [key, e] of kept) {
    if (kept.size <= MAX_KEPT && chars <= MAX_KEPT_CHARS) break;
    kept.delete(key);
    chars -= e.text.length;
  }
}

/* ---------- coalesced reporting for large documents ---------- */

export interface Reporter {
  /** A change happened: report after a quiet moment, and never later than the max wait. */
  touch(): void;
  /** Report now, if anything is waiting. */
  flush(): void;
  /** Drop what is waiting without reporting it (the caller has already reported the full text). */
  cancel(): void;
}

/**
 * Reports `quietMs` after the last change, but no later than `maxWaitMs` after the first change that
 * is still unreported. Typing in a huge document then costs one copy of the text per pause, not per key.
 */
export function createReporter({
  report,
  quietMs = 120,
  maxWaitMs = 400,
  now = () => performance.now(),
}: {
  report: () => void;
  quietMs?: number;
  maxWaitMs?: number;
  now?: () => number;
}): Reporter {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstAt: number | null = null;

  const fire = () => {
    clearTimeout(timer);
    timer = undefined;
    if (firstAt === null) return;
    firstAt = null;
    report();
  };

  return {
    touch() {
      const t = now();
      if (firstAt === null) firstAt = t;
      clearTimeout(timer);
      timer = setTimeout(fire, Math.max(0, Math.min(quietMs, firstAt + maxWaitMs - t)));
    },
    flush: fire,
    cancel() {
      clearTimeout(timer);
      timer = undefined;
      firstAt = null;
    },
  };
}
