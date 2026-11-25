// Type declarations for installed packages that ship without usable TypeScript types.
// Only the parts this app uses are declared.

declare module "markdown-it-footnote" {
  import type MarkdownIt from "markdown-it";
  const footnote: (md: MarkdownIt) => void;
  export default footnote;
}

declare module "markdown-it-deflist" {
  import type MarkdownIt from "markdown-it";
  const deflist: (md: MarkdownIt) => void;
  export default deflist;
}

declare module "markdown-it-mark" {
  import type MarkdownIt from "markdown-it";
  const mark: (md: MarkdownIt) => void;
  export default mark;
}

declare module "markdown-it-sup" {
  import type MarkdownIt from "markdown-it";
  const sup: (md: MarkdownIt) => void;
  export default sup;
}

declare module "markdown-it-emoji" {
  import type MarkdownIt from "markdown-it";
  type EmojiPlugin = (md: MarkdownIt) => void;
  export const full: EmojiPlugin;
  export const light: EmojiPlugin;
  export const bare: EmojiPlugin;
}

// highlight.js ships each language as a plain .js file with no declarations.
declare module "highlight.js/lib/languages/*" {
  import type { LanguageFn } from "highlight.js";
  const language: LanguageFn;
  export default language;
}
