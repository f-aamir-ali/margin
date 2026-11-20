/* Extra inline syntax for the WYSIWYG editor: ==highlight== and ^superscript^.
   Without these the editor would show the raw markers and could escape them on save. */

import { imageBlockSchema } from '@milkdown/kit/component/image-block';
import { remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { markRule } from '@milkdown/kit/prose';
import { $inputRule, $markSchema, $remark } from '@milkdown/kit/utils';

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

const PATTERN = /==(?=\S)([^=\n]+?)(?<=\S)==|\^(?=\S)([^\^\s]+?)\^/g;
const SKIP = new Set(['inlineCode', 'code', 'math', 'inlineMath', 'html', 'yaml', 'link', 'definition']);

/** Split text nodes on the two patterns, producing `mark` / `superscript` nodes. */
function transform(node: MdNode): void {
  if (!node.children || SKIP.has(node.type)) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type !== 'text' || !child.value || (!child.value.includes('==') && !child.value.includes('^'))) {
      transform(child);
      next.push(child);
      continue;
    }
    const text = child.value;
    let last = 0;
    PATTERN.lastIndex = 0;
    for (let m = PATTERN.exec(text); m; m = PATTERN.exec(text)) {
      if (m.index > last) next.push({ type: 'text', value: text.slice(last, m.index) });
      next.push(
        m[1] !== undefined
          ? { type: 'mark', children: [{ type: 'text', value: m[1] }] }
          : { type: 'superscript', children: [{ type: 'text', value: m[2] }] },
      );
      last = m.index + m[0].length;
    }
    if (last === 0) next.push(child);
    else if (last < text.length) next.push({ type: 'text', value: text.slice(last) });
  }
  node.children = next;
}

const remarkMarks = $remark('mdvMarks', () => () => (tree: unknown) => transform(tree as MdNode));

const highlightSchema = $markSchema('highlight', () => ({
  parseDOM: [{ tag: 'mark' }],
  toDOM: () => ['mark', 0],
  parseMarkdown: {
    match: (node) => node.type === 'mark',
    runner: (state, node, markType) => {
      state.openMark(markType);
      state.next(node.children);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'highlight',
    runner: (state, mark) => {
      state.withMark(mark, 'mark');
    },
  },
}));

const superscriptSchema = $markSchema('superscript', () => ({
  parseDOM: [{ tag: 'sup' }],
  toDOM: () => ['sup', 0],
  parseMarkdown: {
    match: (node) => node.type === 'superscript',
    runner: (state, node, markType) => {
      state.openMark(markType);
      state.next(node.children);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'superscript',
    runner: (state, mark) => {
      state.withMark(mark, 'superscript');
    },
  },
}));

const highlightRule = $inputRule((ctx) => markRule(/(?<![=\w])==(?=\S)([^=]+?)(?<=\S)==$/, highlightSchema.type(ctx)));
const superscriptRule = $inputRule((ctx) => markRule(/\^(?=\S)([^\^\s]+?)\^$/, superscriptSchema.type(ctx)));

type Phrasing = (node: unknown, info: Record<string, unknown>) => string;

/** Teach the serialiser how to write the two node types back out. */
export function configureMarkSerialisers(ctx: Ctx): void {
  const wrap =
    (open: string) =>
    (node: unknown, _parent: unknown, state: { containerPhrasing: Phrasing }, info: Record<string, unknown>) =>
      open + state.containerPhrasing(node, { ...info, before: open, after: open }) + open;
  ctx.update(remarkStringifyOptionsCtx, (prev) => ({
    ...prev,
    handlers: {
      ...prev.handlers,
      mark: wrap('=='),
      superscript: wrap('^'),
    } as typeof prev.handlers,
  }));
}

/**
 * The stock image block stores its display ratio in the image's alt text, which throws the real
 * alt text away on save. This version keeps alt (shown as the caption) and title intact.
 */
const imageBlockKeepingAlt = imageBlockSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    attrs: { ...base.attrs, title: { default: '', validate: 'string' } },
    parseMarkdown: {
      match: ({ type }) => type === 'image-block',
      runner: (state, node, type) => {
        state.addNode(type, {
          src: (node.url as string) ?? '',
          caption: (node.alt as string | null) ?? '',
          title: (node.title as string | null) ?? '',
          ratio: 1,
        });
      },
    },
    toMarkdown: {
      match: (node) => node.type.name === 'image-block',
      runner: (state, node) => {
        state.openNode('paragraph');
        state.addNode('image', undefined, undefined, {
          url: node.attrs.src,
          alt: node.attrs.caption,
          title: node.attrs.title || null,
        });
        state.closeNode();
      },
    },
  };
});

export const extraMarks = [remarkMarks, highlightSchema, superscriptSchema, highlightRule, superscriptRule, imageBlockKeepingAlt].flat();
