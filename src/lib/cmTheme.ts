/* One CodeMirror look for Source mode and for code blocks inside the editor, driven by the theme variables. */
import { HighlightStyle } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

export const cmHighlight = HighlightStyle.define([
  { tag: t.heading1, color: 'var(--doc-heading)', fontWeight: '700', fontSize: '1.25em' },
  { tag: t.heading2, color: 'var(--doc-heading)', fontWeight: '700', fontSize: '1.12em' },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], color: 'var(--doc-heading)', fontWeight: '650' },
  { tag: t.strong, fontWeight: '700', color: 'var(--doc-heading)' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--text-3)' },
  { tag: [t.link, t.url], color: 'var(--accent)' },
  { tag: t.monospace, color: 'var(--syn-string)' },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: 'var(--text-3)' },
  { tag: t.quote, color: 'var(--doc-muted)', fontStyle: 'italic' },
  { tag: t.list, color: 'var(--accent)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--syn-comment)' },
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.modifier], color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--syn-number)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--syn-func)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--syn-type)' },
  { tag: [t.tagName, t.angleBracket], color: 'var(--syn-tag)' },
  { tag: [t.attributeName, t.propertyName], color: 'var(--syn-attr)' },
]);

export const cmTheme = EditorView.theme({
  '&': { color: 'var(--doc-text)', backgroundColor: 'transparent', fontSize: 'calc(var(--doc-size) * 0.88)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.65', overflow: 'visible' },
  '.cm-content': { padding: '0', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0 2px' },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'var(--text-4)', paddingRight: '14px' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 2px 0 0', minWidth: '28px' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--text) 4%, transparent)', borderRadius: '6px' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-2)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused': { outline: 'none' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'var(--selection)',
  },
  '.cm-matchingBracket': { backgroundColor: 'var(--accent-soft)', outline: 'none' },
});
