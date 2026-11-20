import DOMPurify from "dompurify";
import katex from "katex";
import katexPlugin from "@vscode/markdown-it-katex";
import githubAlerts from "markdown-it-github-alerts";
import deflist from "markdown-it-deflist";
import footnote from "markdown-it-footnote";
import { full as emojiPlugin } from "markdown-it-emoji";
import mark from "markdown-it-mark";
import sup from "markdown-it-sup";
import MarkdownIt, { type MarkdownIt as Md, type StateCore, type StateInline, type Token } from "markdown-it";
import { highlight } from "./hljs";
import { isExplicitFileReference } from "./platform";

export interface Heading {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
  id: string;
  line: number; // 0-based source line
}

export interface RenderOptions {
  breaks?: boolean; // newline => <br>            default false
  linkify?: boolean; // bare URLs                  default true
  typographer?: boolean; // smart quotes           default false
  emoji?: boolean; // :smile:                      default true
  math?: boolean; // $..$ and $$..$$               default true
  html?: boolean; // allow raw HTML (always sanitised) default true
  lineNumbers?: boolean; // code line numbers      default false
  localFiles?: boolean; // desktop reader can handle explicit local paths
  /** Rewrites image and link URLs. Called for every URL except in-page `#fragments`. */
  resolveUrl?: (url: string, kind: "image" | "link") => string;
}

export interface RenderResult {
  html: string;
  headings: Heading[];
  frontMatter: string | null;
}

/** Per-call state that the parser and renderer rules read through markdown-it's `env`. */
interface MarkdownEnv {
  [key: string | symbol]: unknown;
  headings: Heading[];
  mermaidSources: string[];
  resolveUrl?: RenderOptions["resolveUrl"];
  lineNumbers: boolean;
}

/** CommonJS plugins arrive as either the function or a { default } wrapper depending on the bundler. */
type Plugin = Parameters<Md["use"]>[0];
function plug(mod: unknown): Plugin {
  const m = mod as { default?: unknown };
  return (typeof mod === "function" ? mod : typeof m.default === "function" ? m.default : (m.default as { default?: unknown })?.default) as Plugin;
}

/**
 * GitHub treats a single pair of tildes as strikethrough too (a single ~pair~), and so does the editor.
 * markdown-it only knows the double form, so this adds the single one.
 */
function singleTildeStrike(md: Md): void {
  const TILDE = 0x7e;
  const isSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || Number.isNaN(c);
  md.inline.ruler.before("strikethrough", "single_tilde", (state, silent) => {
    const { src, pos: start, posMax: max } = state;
    if (src.charCodeAt(start) !== TILDE) return false;
    if (src.charCodeAt(start + 1) === TILDE || (start > 0 && src.charCodeAt(start - 1) === TILDE)) return false;
    if (start + 2 >= max || isSpace(src.charCodeAt(start + 1))) return false;

    let pos = start + 1;
    let close = -1;
    while (pos < max) {
      const c = src.charCodeAt(pos);
      if (c === 0x0a) break;
      if (c === 0x5c) {
        pos += 2;
      } else if (c === 0x60) {
        // Skip a whole code span so a tilde inside it can never close the strike.
        let run = pos;
        while (src.charCodeAt(run) === 0x60) run++;
        const ticks = src.slice(pos, run);
        const end = src.indexOf(ticks, run);
        pos = end < 0 || end >= max ? run : end + ticks.length;
      } else if (c === TILDE) {
        let run = pos;
        while (src.charCodeAt(run) === TILDE) run++;
        if (run - pos === 1 && !isSpace(src.charCodeAt(pos - 1))) {
          close = pos;
          break;
        }
        pos = run;
      } else {
        pos++;
      }
    }
    if (close < 0) return false;

    if (!silent) {
      state.push("s_open", "s", 1).markup = "~";
      state.pos = start + 1;
      state.posMax = close;
      state.md.inline.tokenize(state);
      state.push("s_close", "s", -1).markup = "~";
    }
    state.pos = close + 1;
    state.posMax = max;
    return true;
  });
}

const EXTERNAL_URL = /^https?:\/\//i;

/** The options that change how the parser is built. One cached instance exists per distinct set. */
interface ParserConfig {
  breaks: boolean;
  linkify: boolean;
  typographer: boolean;
  emoji: boolean;
  math: boolean;
  html: boolean;
  localFiles: boolean;
}

const DEFAULTS = {
  breaks: false,
  linkify: true,
  typographer: false,
  emoji: true,
  math: true,
  html: true,
  lineNumbers: false,
} as const;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** GitHub-style slug: lowercase, punctuation removed, spaces become hyphens. */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/**
 * Headings with the same ids that `renderMarkdown` assigns, without rendering any HTML.
 * Pass the same options you pass to `renderMarkdown`: typographer and emoji change the slugs.
 */
export function extractHeadings(src: string, opts: RenderOptions = {}): Heading[] {
  const config = resolveConfig(opts);
  const { body } = splitFrontMatter(normalizeSource(src));
  const env = createEnv();
  getParser(config).parse(body, env);
  return env.headings;
}

/** Renders Markdown to sanitised HTML and returns its headings and front matter. */
export function renderMarkdown(src: string, opts: RenderOptions = {}): RenderResult {
  const config = resolveConfig(opts);
  const { body, frontMatter } = splitFrontMatter(normalizeSource(src));
  const md = getParser(config);
  const env = createEnv(opts);
  const tokens = md.parse(body, env);
  const html = md.renderer.render(tokens, md.options, env);
  return {
    html: restoreMermaidSources(getSanitizer().sanitize(html, SANITIZE_CONFIG), env.mermaidSources),
    headings: env.headings,
    frontMatter,
  };
}

// ---------------------------------------------------------------------------
// Source preparation
// ---------------------------------------------------------------------------

function normalizeSource(src: string): string {
  return src.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

function createEnv(opts: RenderOptions = {}): MarkdownEnv {
  return {
    headings: [],
    mermaidSources: [],
    resolveUrl: opts.resolveUrl,
    lineNumbers: opts.lineNumbers ?? DEFAULTS.lineNumbers,
  };
}

/**
 * DOMPurify strips any attribute whose value contains `-->`, and mermaid sources often do.
 * Each diagram is therefore emitted as a numbered placeholder, sanitised, and given its
 * escaped source back here. The source never passes through the sanitiser.
 */
const MERMAID_PLACEHOLDER = /<div class="mermaid-block" data-mermaid-id="(\d+)"/g;

function restoreMermaidSources(html: string, sources: string[]): string {
  return html.replace(MERMAID_PLACEHOLDER, (match, id: string) => {
    const source = sources[Number(id)];
    return source === undefined ? match : `<div class="mermaid-block" data-source="${escapeHtml(source)}"`;
  });
}

/**
 * Pulls a YAML front matter block off the top of the document. The block's lines are
 * blanked rather than removed, so every later line keeps its original number.
 * A block only counts when it is closed by `---` or `...` and its first non-blank
 * line looks like a `key:` pair, so a leading horizontal rule is left alone.
 */
function splitFrontMatter(src: string): { body: string; frontMatter: string | null } {
  const lines = src.split("\n");
  if (lines.length < 2 || lines[0].trimEnd() !== "---") {
    return { body: src, frontMatter: null };
  }
  const close = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line));
  if (close < 0) return { body: src, frontMatter: null };

  const inner = lines.slice(1, close);
  const firstContent = inner.find((line) => line.trim() !== "");
  if (firstContent !== undefined && !/^[\w"'-][\w "'.-]*:(\s|$)/.test(firstContent)) {
    return { body: src, frontMatter: null };
  }

  const body = lines.map((line, index) => (index <= close ? "" : line)).join("\n");
  return { body, frontMatter: inner.join("\n") };
}

function resolveConfig(opts: RenderOptions): ParserConfig {
  return {
    breaks: opts.breaks ?? DEFAULTS.breaks,
    linkify: opts.linkify ?? DEFAULTS.linkify,
    typographer: opts.typographer ?? DEFAULTS.typographer,
    emoji: opts.emoji ?? DEFAULTS.emoji,
    math: opts.math ?? DEFAULTS.math,
    html: opts.html ?? DEFAULTS.html,
    localFiles: opts.localFiles ?? false,
  };
}

// ---------------------------------------------------------------------------
// Parser cache
// ---------------------------------------------------------------------------

const parsers = new Map<string, Md>();

function getParser(config: ParserConfig): Md {
  const key = [config.breaks, config.linkify, config.typographer, config.emoji, config.math, config.html, config.localFiles]
    .map((flag) => (flag ? "1" : "0"))
    .join("");
  let md = parsers.get(key);
  if (!md) {
    md = createParser(config);
    parsers.set(key, md);
  }
  return md;
}

function createParser(config: ParserConfig): Md {
  const md = new MarkdownIt({
    html: config.html,
    breaks: config.breaks,
    linkify: config.linkify,
    typographer: config.typographer,
  });
  if (config.localFiles) {
    const validateLink = md.validateLink;
    md.validateLink = (url) => isExplicitFileReference(url) || validateLink(url);
  }

  md.use(plug(footnote));
  md.use(plug(deflist));
  md.use(plug(mark));
  md.use(singleTildeStrike);
  md.use(plug(sup));
  md.use(plug(githubAlerts));
  if (config.emoji) md.use(plug(emojiPlugin));
  if (config.math) md.use(plug(katexPlugin));

  md.inline.ruler.before("image", "sized_image", sizedImageRule);
  md.core.ruler.after("block", "task_markers", markTaskItems);
  md.core.ruler.after("inline", "task_checkboxes", insertCheckboxes);
  md.core.ruler.push("heading_ids", assignHeadingIds);
  md.core.ruler.push("toc", expandTocParagraphs);
  md.core.ruler.push("block_lines", assignBlockLines);

  installRenderers(md, config);
  return md;
}

// ---------------------------------------------------------------------------
// Parser rules
// ---------------------------------------------------------------------------

/** `![alt](url =WxH)`: markdown-it cannot parse the size suffix, so this rule takes the whole image. */
const SIZED_IMAGE_TAIL = /^\(\s*([^\s()]+)\s+=(\d*)(?:x(\d*))?\s*\)/;

function sizedImageRule(state: StateInline, silent: boolean): boolean {
  const { src, pos, posMax } = state;
  if (src.charCodeAt(pos) !== 0x21 /* ! */ || src.charCodeAt(pos + 1) !== 0x5b /* [ */) return false;

  const labelEnd = state.md.helpers.parseLinkLabel(state, pos + 1, false);
  if (labelEnd < 0) return false;

  const match = SIZED_IMAGE_TAIL.exec(src.slice(labelEnd + 1, posMax));
  if (!match) return false;
  const [whole, rawHref, width, height] = match;
  if (!width && !height) return false;

  const href = state.md.normalizeLink(rawHref);
  if (!state.md.validateLink(href)) return false;

  if (!silent) {
    const label = src.slice(pos + 2, labelEnd);
    const token = state.push("image", "img", 0);
    token.attrs = [
      ["src", href],
      ["alt", ""],
    ];
    token.content = label;
    token.children = [];
    state.md.inline.parse(label, state.md, state.env, token.children);
    if (width) token.attrSet("width", width);
    if (height) token.attrSet("height", height);
  }

  state.pos = labelEnd + 1 + whole.length;
  return true;
}

/** Task items: `- [ ] open` and `- [x] done`. The marker is stripped before inline parsing. */
const TASK_MARKER = /^\[([ xX])\](?=\s|$)/;

interface TaskMeta {
  task?: { checked: boolean; line: number };
}

function markTaskItems(state: StateCore): void {
  const { tokens } = state;
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i];
    if (inline.type !== "inline" || tokens[i - 1].type !== "paragraph_open" || tokens[i - 2].type !== "list_item_open") {
      continue;
    }
    const match = TASK_MARKER.exec(inline.content);
    if (!match) continue;

    inline.content = inline.content.slice(match[0].length).trimStart();
    inline.meta = { task: { checked: match[1] !== " ", line: inline.map?.[0] ?? 0 } };

    const item = tokens[i - 2];
    item.attrJoin("class", "task-list-item");
    const list = findParentList(tokens, i - 2);
    if (list && !(attr(list, "class") ?? "").includes("contains-task-list")) {
      list.attrJoin("class", "contains-task-list");
    }
  }
}

function findParentList(tokens: Token[], index: number): Token | undefined {
  const parentLevel = tokens[index].level - 1;
  for (let j = index - 1; j >= 0; j--) {
    if (tokens[j].level === parentLevel) {
      return tokens[j].type.endsWith("_list_open") ? tokens[j] : undefined;
    }
  }
  return undefined;
}

function insertCheckboxes(state: StateCore): void {
  for (const token of state.tokens) {
    const task = token.type === "inline" ? (token.meta as TaskMeta | null)?.task : undefined;
    if (!task) continue;
    const box = new state.Token("html_inline", "", 0);
    box.content = `<input type="checkbox" class="task-checkbox" data-line="${task.line}"${task.checked ? " checked" : ""}> `;
    token.children = [box, ...(token.children ?? [])];
  }
}

function assignHeadingIds(state: StateCore): void {
  const env = state.env as MarkdownEnv;
  const { tokens } = state;
  const used = new Set<string>();
  const headings: Heading[] = [];

  for (let i = 0; i < tokens.length - 1; i++) {
    const open = tokens[i];
    if (open.type !== "heading_open") continue;
    const inline = tokens[i + 1];
    const text = inline.type === "inline" ? plainText(inline.children ?? []) : "";
    const id = uniqueSlug(text, used);
    open.attrSet("id", id);
    headings.push({
      level: Number(open.tag.slice(1)) as Heading["level"],
      text,
      id,
      line: open.map?.[0] ?? 0,
    });
  }
  env.headings = headings;
}

function plainText(tokens: Token[]): string {
  let out = "";
  for (const token of tokens) {
    if (token.type === "text" || token.type === "code_inline" || token.type === "emoji") {
      out += token.content;
    } else if (token.type === "softbreak" || token.type === "hardbreak") {
      out += " ";
    } else if (token.type === "image" && token.children) {
      out += plainText(token.children);
    }
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Unique GitHub-style id: the second "Intro" becomes "intro-1", the third "intro-2". */
function uniqueSlug(text: string, used: Set<string>): string {
  const base = slugify(text) || "section";
  let candidate = base;
  for (let n = 1; used.has(candidate); n++) {
    candidate = `${base}-${n}`;
  }
  used.add(candidate);
  return candidate;
}

const TOC_MARKER = /^\[\[?toc\]\]?$/i;

/** Replaces a paragraph that holds only `[toc]` or `[[toc]]` with a nested heading list. */
function expandTocParagraphs(state: StateCore): void {
  const env = state.env as MarkdownEnv;
  const { tokens } = state;
  const out: Token[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const isToc =
      token.type === "paragraph_open" &&
      token.level === 0 &&
      tokens[i + 1]?.type === "inline" &&
      tokens[i + 2]?.type === "paragraph_close" &&
      TOC_MARKER.test(tokens[i + 1].content.trim());

    if (isToc) {
      const nav = new state.Token("html_block", "", 0);
      nav.content = renderToc(env.headings);
      nav.map = token.map;
      nav.block = true;
      out.push(nav);
      i += 2;
      continue;
    }
    out.push(token);
  }
  state.tokens = out;
}

function renderToc(headings: Heading[]): string {
  interface Node {
    heading: Heading;
    children: Node[];
  }
  const roots: Node[] = [];
  const stack: Node[] = [];

  for (const heading of headings) {
    const node: Node = { heading, children: [] };
    while (stack.length > 0 && stack[stack.length - 1].heading.level >= heading.level) {
      stack.pop();
    }
    (stack.length > 0 ? stack[stack.length - 1].children : roots).push(node);
    stack.push(node);
  }

  const renderList = (nodes: Node[]): string =>
    `<ul>${nodes
      .map(
        ({ heading, children }) =>
          `<li><a href="#${escapeHtml(heading.id)}">${escapeHtml(heading.text)}</a>${
            children.length > 0 ? renderList(children) : ""
          }</li>`,
      )
      .join("")}</ul>`;

  return `<nav class="toc">${roots.length > 0 ? renderList(roots) : ""}</nav>\n`;
}

/** Puts `data-line` on every top-level block so the app can sync scroll and jump to lines. */
function assignBlockLines(state: StateCore): void {
  for (const token of state.tokens) {
    if (token.level === 0 && token.map && token.nesting !== -1) {
      token.attrSet("data-line", String(token.map[0]));
    }
  }

  // The footnote section has no source map of its own, so it takes the line of its first definition.
  const footnotes = state.tokens.find((token) => token.type === "footnote_block_open");
  const firstDefinition = state.src.split("\n").findIndex((line) => FOOTNOTE_DEFINITION.test(line));
  if (footnotes && firstDefinition >= 0) {
    footnotes.attrSet("data-line", String(firstDefinition));
  }
}

const FOOTNOTE_DEFINITION = /^\[\^[^\]\s]+\]:/;

// ---------------------------------------------------------------------------
// Renderer rules
// ---------------------------------------------------------------------------

function installRenderers(md: Md, config: ParserConfig): void {
  const rules = md.renderer.rules;

  rules.fence = (tokens, idx, _options, env) => {
    const token = tokens[idx];
    const lang = fenceLanguage(token.info);
    const source = stripTrailingNewline(token.content);
    const line = lineAttr(token);

    if (lang === "mermaid") {
      const sources = (env as MarkdownEnv).mermaidSources;
      return `<div class="mermaid-block" data-mermaid-id="${sources.push(source) - 1}"${line}></div>\n`;
    }
    if (lang === "math" && config.math) {
      return `<div class="katex-block"${line}>${renderMath(source, true)}</div>\n`;
    }
    return renderCodeBlock(source, lang, line, (env as MarkdownEnv).lineNumbers);
  };

  rules.code_block = (tokens, idx, _options, env) =>
    renderCodeBlock(
      stripTrailingNewline(tokens[idx].content),
      "",
      lineAttr(tokens[idx]),
      (env as MarkdownEnv).lineNumbers,
    );

  rules.html_block = (tokens, idx) => withLine(tokens[idx].content, attr(tokens[idx], "data-line"));

  rules.table_open = (tokens, idx) => `<div class="table-wrap"${lineAttr(tokens[idx])}><table>\n`;
  rules.table_close = () => "</table></div>\n";

  rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const src = resolveUrl(attr(token, "src") ?? "", "image", env as MarkdownEnv);
    const alt = self.renderInlineAsText(token.children ?? [], options, env);
    const title = attr(token, "title");
    const width = attr(token, "width");
    const height = attr(token, "height");
    return (
      `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"` +
      (title ? ` title="${escapeHtml(title)}"` : "") +
      (width ? ` width="${escapeHtml(width)}"` : "") +
      (height ? ` height="${escapeHtml(height)}"` : "") +
      ` loading="lazy" decoding="async">`
    );
  };

  rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const href = attr(token, "href");
    if (href !== null && !href.startsWith("#")) {
      if (config.localFiles && isExplicitFileReference(href)) {
        // Hand filesystem destinations to the native click handler without a navigable file URI.
        token.attrSet("href", "#");
        token.attrSet("data-margin-file", href);
      } else {
        token.attrSet("href", resolveUrl(href, "link", env as MarkdownEnv));
      }
      if (EXTERNAL_URL.test(href)) {
        token.attrSet("target", "_blank");
        token.attrSet("rel", "noopener noreferrer");
        token.attrJoin("class", "external");
      }
    }
    return self.renderToken(tokens, idx, options);
  };

  if (config.math) {
    rules.math_inline = (tokens, idx) => {
      let latex = tokens[idx].content;
      // $`x`$ keeps its backticks in the source; they are not part of the formula.
      if (latex.length > 2 && latex.startsWith("`") && latex.endsWith("`")) {
        latex = latex.slice(1, -1);
      }
      return renderMath(latex, DISPLAY_ENVIRONMENT.test(latex));
    };

    // Block `$$…$$` and inline `$$…$$` both arrive as math_block tokens; only the first has a source line.
    rules.math_block = (tokens, idx) => {
      const token = tokens[idx];
      const html = renderMath(token.content.trim(), true);
      if (token.level === 0 && token.map) {
        return `<div class="katex-block"${lineAttr(token)}>${html}</div>\n`;
      }
      return `<span class="katex-block">${html}</span>`;
    };
  }

  // The alert and footnote renderers come from plugins that write their own markup, so the line is added here.
  const alertOpen = rules.alert_open;
  if (alertOpen) {
    rules.alert_open = (tokens, idx, options, env, self) =>
      withLine(alertOpen(tokens, idx, options, env, self), attr(tokens[idx], "data-line"));
  }
  const footnoteSection = rules.footnote_block_open;
  if (footnoteSection) {
    rules.footnote_block_open = (tokens, idx, options, env, self) =>
      footnoteSection(tokens, idx, options, env, self).replace(
        '<section class="footnotes">',
        `<section class="footnotes"${lineAttr(tokens[idx])}>`,
      );
  }
}

const DISPLAY_ENVIRONMENT = /\\begin\{(align|equation|gather|cd|alignat)\}/i;

function renderMath(latex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(latex, { displayMode, throwOnError: true, trust: false, strict: "ignore" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `<span class="math-error" style="color:#c62828" title="${escapeHtml(latex)}">${escapeHtml(message)}</span>`;
  }
}

function renderCodeBlock(source: string, lang: string, line: string, lineNumbers: boolean): string {
  const label = lang || "text";
  const highlighted = lang ? highlight(source, lang) : null;
  let body = highlighted ?? escapeHtml(source);
  if (lineNumbers) body = numberLines(body);
  const codeClass = lang ? `hljs language-${escapeHtml(lang)}` : "hljs";
  return (
    `<div class="code-block" data-lang="${escapeHtml(label)}"${line}>` +
    `<div class="code-head"><span class="code-lang">${escapeHtml(label)}</span>` +
    `<button class="code-copy" type="button" aria-label="Copy code">Copy</button></div>` +
    `<pre><code class="${codeClass}">${body}</code></pre></div>\n`
  );
}

const SPAN_TAG = /<(\/?)span\b[^>]*>/g;

/**
 * Wraps each line of highlighted HTML in `<span class="code-line">`. A span that runs across
 * lines (a multi-line comment, say) is closed at the end of one line and reopened at the start of the next.
 */
function numberLines(html: string): string {
  const lines = html.split("\n");
  const open: string[] = [];
  return lines
    .map((line, index) => {
      const reopened = open.join("");
      for (const match of line.matchAll(SPAN_TAG)) {
        if (match[1]) open.pop();
        else open.push(match[0]);
      }
      const closing = "</span>".repeat(open.length);
      const newline = index < lines.length - 1 ? "\n" : "";
      return `<span class="code-line">${reopened}${line}${closing}</span>${newline}`;
    })
    .join("");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveUrl(url: string, kind: "image" | "link", env: MarkdownEnv): string {
  return env.resolveUrl ? env.resolveUrl(url, kind) : url;
}

function fenceLanguage(info: string): string {
  return info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

function stripTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

/** Attribute value as a string, or null when the token does not carry it. */
function attr(token: Token, name: string): string | null {
  const value = token.attrGet(name);
  return value === null ? null : String(value);
}

function lineAttr(token: Token): string {
  const line = attr(token, "data-line");
  return line === null ? "" : ` data-line="${line}"`;
}

/** Adds `data-line` to the first element of a raw HTML block. Blocks that start with text or a comment are left alone. */
const OPENING_TAG = /^(\s*<[a-zA-Z][\w-]*)/;

function withLine(html: string, line: string | null): string {
  return line === null ? html : html.replace(OPENING_TAG, `$1 data-line="${line}"`);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * DOMPurify's default URI rule lets through http(s), mailto and the like. It also strips
 * `asset:` and `blob:`, the schemes Tauri uses for local files, so both are allowed here.
 * `javascript:`, `file:` and everything else stay blocked.
 */
const ALLOWED_URI = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|asset|blob):|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i;

const SANITIZE_CONFIG = {
  USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
  ADD_TAGS: ["details", "summary"],
  ADD_ATTR: ["target", "rel", "loading", "decoding", "checked", "start", "width", "height"],
  ALLOWED_URI_REGEXP: ALLOWED_URI,
  FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form", "frame", "frameset", "base", "meta", "link"],
  FORBID_ATTR: ["srcdoc", "formaction"],
};

let sanitizer: ReturnType<typeof DOMPurify> | null = null;

/**
 * A private DOMPurify instance, created on first use, so the heading-id hook below does not
 * change how other code in the app uses DOMPurify.
 */
function getSanitizer(): ReturnType<typeof DOMPurify> {
  if (!sanitizer) {
    sanitizer = DOMPurify(window);
    // DOMPurify drops an id that matches a document property (a heading called "Title" would lose
    // its id). Heading ids are generated here, so they are kept. The value checks still apply.
    sanitizer.addHook("uponSanitizeAttribute", (node, data) => {
      if (data.attrName === "id" && /^H[1-6]$/.test(node.nodeName)) {
        data.forceKeepAttr = true;
      }
    });
  }
  return sanitizer;
}
