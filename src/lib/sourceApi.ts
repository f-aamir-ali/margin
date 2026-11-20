import type { EditorView } from '@codemirror/view';

/** The live Source-mode editor, shared with the find bar without importing the whole editor. */
export const sourceApi: { view: EditorView | null } = { view: null };
