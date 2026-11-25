import { diagramsSettled, enhance } from './enhance';
import { renderMarkdown } from './markdown';
import { asDataUrl, assetUrl, baseName, dirName, downloadText, isTauri, localReferencePath, pickSavePath, writeFile } from './platform';
import { activeTheme, isDarkTheme, useSettings } from './settings';
import type { Doc } from './store';
import { toast } from './toast';

const KATEX_CDN = 'https://cdn.jsdelivr.net/npm/katex@0.19.1/dist/katex.min.css';

/** Embedded image limits, in MiB. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 100 * 1024 * 1024;

const IMAGE_TYPES = new Map<string, string>([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['svg', 'image/svg+xml'],
  ['avif', 'image/avif'],
  ['bmp', 'image/bmp'],
  ['ico', 'image/x-icon'],
  ['apng', 'image/apng'],
]);

export type SkipReason = 'not-image' | 'too-large' | 'over-total-limit' | 'unreadable';

/** A local image the export left as a link. The exported file keeps `src` exactly as the document wrote it. */
export interface SkippedAsset {
  src: string;
  reason: SkipReason;
}

export interface ExportOptions {
  /** Gets the images left as links. Without it, a warning toast lists them. */
  onSkipped?: (skipped: SkippedAsset[]) => void;
}

/**
 * The MIME type to embed a local file under, or null when it is not an image. The response's
 * content-type counts when it is an image type; otherwise a known image extension does.
 */
export function imageMimeType(path: string, contentType: string | null | undefined): string | null {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (type.startsWith('image/')) return type;
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';
  return IMAGE_TYPES.get(ext) ?? null;
}

/** Why an image of `size` bytes must stay a link, given the bytes already embedded. */
export function sizeSkipReason(size: number, totalSoFar: number): 'too-large' | 'over-total-limit' | null {
  if (size > MAX_IMAGE_BYTES) return 'too-large';
  if (totalSoFar + size > MAX_TOTAL_IMAGE_BYTES) return 'over-total-limit';
  return null;
}

/** True when the rendered article has KaTeX output, so the KaTeX fonts and styles are needed. */
export function needsKatexCss(article: ParentNode): boolean {
  return article.querySelector('.katex') !== null;
}

function renderOptions() {
  const s = useSettings.getState().settings;
  return {
    breaks: s.breaks,
    linkify: s.linkify,
    typographer: s.typographer,
    emoji: s.emoji,
    math: s.math,
    html: s.rawHtml,
    lineNumbers: s.codeLineNumbers,
  };
}

/** Render a document into a detached element, with diagrams drawn. Local images that cannot be embedded are pushed onto `skipped`. */
async function renderDetached(doc: Doc, dark: boolean, embedImages = false, skipped: SkippedAsset[] = []): Promise<HTMLElement> {
  const host = document.createElement('article');
  host.className = 'prose';
  if (doc.kind === 'text') {
    const pre = document.createElement('pre');
    pre.className = 'plain-export';
    pre.textContent = doc.content;
    host.append(pre);
    return host;
  }
  const { html } = renderMarkdown(doc.content, renderOptions());
  host.innerHTML = html;
  if (isTauri) {
    const folder = doc.path ? dirName(doc.path) : '';
    const budget = { total: 0 };
    await Promise.all(Array.from(host.querySelectorAll<HTMLImageElement>('img[src]')).map(async (img) => {
      const local = localReferencePath(img.getAttribute('src') ?? '', folder);
      if (!local) return;
      const src = assetUrl(local);
      if (!embedImages) {
        img.src = src;
        return;
      }
      await embedImage(img, local, src, budget, skipped);
    }));
  }
  // Mermaid measures text, so the element must be in the document while it renders.
  host.style.cssText = 'position:fixed;left:-99999px;top:0;width:760px;visibility:hidden';
  document.body.appendChild(host);
  const cleanup = enhance(host, { theme: dark ? 'dark' : 'light' });
  await diagramsSettled(host);
  cleanup();
  host.remove();
  host.style.cssText = '';
  host.querySelectorAll('.code-copy, .heading-anchor').forEach((el) => el.remove());
  return host;
}

/** Replaces a local image's src with a data URL. Anything that fails a check keeps its original reference and is recorded. */
async function embedImage(img: HTMLImageElement, local: string, src: string, budget: { total: number }, skipped: SkippedAsset[]): Promise<void> {
  const original = img.getAttribute('src') ?? src;
  const skip = (reason: SkipReason) => {
    skipped.push({ src: original, reason });
  };
  try {
    const response = await fetch(src);
    if (!response.ok) return skip('unreadable');
    const mime = imageMimeType(local, response.headers.get('content-type'));
    if (!mime) return skip('not-image');
    // Refuse from the declared length first, so a huge file is never read.
    const declared = Number(response.headers.get('content-length') ?? 0);
    const early = declared > 0 ? sizeSkipReason(declared, budget.total) : null;
    if (early) return skip(early);

    const blob = await response.blob();
    const tooBig = sizeSkipReason(blob.size, budget.total);
    if (tooBig) return skip(tooBig);
    // Count the bytes before the next await, so concurrent images cannot overrun the total.
    budget.total += blob.size;
    try {
      img.src = await asDataUrl(new Blob([blob], { type: mime }));
    } catch {
      budget.total -= blob.size;
      skip('unreadable');
    }
  } catch {
    skip('unreadable');
  }
}

const SKIP_TEXT: Record<SkipReason, string> = {
  'not-image': 'not an image',
  'too-large': 'larger than 25 MB',
  'over-total-limit': 'over the 100 MB total',
  unreadable: 'could not be read',
};

function reportSkipped(skipped: SkippedAsset[], options: ExportOptions): void {
  if (skipped.length === 0) return;
  if (options.onSkipped) {
    options.onSkipped(skipped);
    return;
  }
  const count = skipped.length;
  const listed = skipped.slice(0, 3).map((s) => `${s.src} (${SKIP_TEXT[s.reason]})`);
  if (count > 3) listed.push(`and ${count - 3} more`);
  toast.warn(`${count} ${count === 1 ? 'image' : 'images'} left as links`, listed.join(', '));
}

/* ---------- stylesheet for standalone HTML ---------- */

/** Layout for the exported page. It is written after the app's rules, so it wins where they overlap. */
const EXPORT_CSS = `html, body { height: auto; overflow: auto; user-select: text; cursor: auto; }
body { background: var(--doc-bg); padding: 56px 24px 96px; }
.prose { max-width: var(--doc-width); margin: 0 auto; }`;

/** Selectors that style the article's own content. Toolbars, sidebars and dialogs are not exported. */
const CONTENT_SELECTOR = /\.prose|\.reader|markdown|hljs|katex|code|table|mermaid|footnote|task|alert|export-title|\b(?:h[1-6]|p|a|ul|ol|li|blockquote|pre|img|hr|del|ins|mark|sub|sup|kbd|dl|dt|dd|details|summary|figure|figcaption|strong|em|th|td)\b/i;

/** Editor-only selectors (the Milkdown editor and its source view). They never appear in an export. */
const EDITOR_ONLY = /\.milkdown|\.ProseMirror|\.cm-|\.editor\b|\.source\b|smooth-caret|crepe-/;

const RULE_STYLE = 1;
const RULE_MEDIA = 4;
const RULE_PAGE = 6;
const RULE_KEYFRAMES = 7;
const RULE_SUPPORTS = 12;

interface Decl {
  name: string;
  value: string;
  priority: string;
}

type Piece =
  | { kind: 'tokens'; selector: string; decls: Decl[] }
  | { kind: 'text'; css: string }
  | { kind: 'group'; prelude: string; children: Piece[] }
  | { kind: 'keyframes'; name: string; css: string };

const VAR_REF = /var\(\s*(--[\w-]+)/g;

/** Splits a selector list on commas that are not inside () or [] or quotes, so `:where(h1, h2)` stays whole. */
function splitSelectors(selectorText: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < selectorText.length; i++) {
    const c = selectorText[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '(' || c === '[') {
      depth++;
    } else if (c === ')' || c === ']') {
      depth--;
    } else if (c === ',' && depth === 0) {
      parts.push(selectorText.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(selectorText.slice(start).trim());
  return parts.filter(Boolean);
}

/** `:root`, `:root[data-theme='x']` and similar. Theme tokens live on these. */
function isTokenPart(part: string): boolean {
  return /^:root(?:\[[^\]]*\]|:[\w-]+(?:\([^)]*\))?)*$/.test(part);
}

/** Document-wide selectors. Base box model, colour and font, text selection and scrollbars. */
function isGlobalPart(part: string): boolean {
  return /^(?:\*|html\b|body\b|#root\b|::selection|::-webkit-scrollbar)/.test(part);
}

function keepSelector(part: string, math: boolean): boolean {
  if (EDITOR_ONLY.test(part)) return false;
  if (isGlobalPart(part)) return true;
  return CONTENT_SELECTOR.test(part) && (math || !/katex/i.test(part));
}

function declarations(style: CSSStyleDeclaration): Decl[] {
  const out: Decl[] = [];
  for (let i = 0; i < style.length; i++) {
    const name = style.item(i);
    out.push({ name, value: style.getPropertyValue(name), priority: style.getPropertyPriority(name) });
  }
  return out;
}

function formatDecls(decls: Decl[]): string {
  return decls.map((d) => `  ${d.name}: ${d.value}${d.priority ? ` !${d.priority}` : ''};`).join('\n');
}

function classify(rules: CSSRule[], math: boolean): Piece[] {
  const out: Piece[] = [];
  for (const rule of rules) {
    if (rule.type === RULE_STYLE) {
      const styleRule = rule as CSSStyleRule;
      const parts = splitSelectors(styleRule.selectorText);
      if (parts.length > 0 && parts.every(isTokenPart)) {
        out.push({ kind: 'tokens', selector: parts.join(', '), decls: declarations(styleRule.style) });
        continue;
      }
      if (parts.length === 0) continue;
      const kept = parts.filter((part) => keepSelector(part, math));
      if (kept.length === parts.length) {
        out.push({ kind: 'text', css: rule.cssText });
      } else if (kept.length > 0) {
        out.push({ kind: 'text', css: `${kept.join(', ')} {\n${formatDecls(declarations(styleRule.style))}\n}` });
      }
    } else if (rule.type === RULE_MEDIA || rule.type === RULE_SUPPORTS) {
      const children = classify(Array.from((rule as CSSGroupingRule).cssRules), math);
      if (children.length === 0) continue;
      const prelude = rule.type === RULE_MEDIA
        ? `@media ${(rule as CSSMediaRule).media.mediaText}`
        : `@supports ${(rule as CSSSupportsRule).conditionText}`;
      out.push({ kind: 'group', prelude, children });
    } else if (rule.type === RULE_PAGE) {
      out.push({ kind: 'text', css: rule.cssText });
    } else if (rule.type === RULE_KEYFRAMES) {
      out.push({ kind: 'keyframes', name: (rule as CSSKeyframesRule).name, css: rule.cssText });
    }
    // @font-face is left out on purpose: the font files do not travel with the export.
  }
  return out;
}

/** Every piece, including those nested inside @media and @supports. */
function flatten(pieces: Piece[]): Piece[] {
  return pieces.flatMap((piece) => (piece.kind === 'group' ? [piece, ...flatten(piece.children)] : [piece]));
}

function serialize(pieces: Piece[], needed: Set<string>): string {
  const out: string[] = [];
  for (const piece of pieces) {
    if (piece.kind === 'text') {
      out.push(piece.css);
    } else if (piece.kind === 'tokens') {
      const decls = piece.decls.filter((d) => !d.name.startsWith('--') || needed.has(d.name));
      if (decls.length === 0) continue;
      out.push(`${piece.selector} {\n${formatDecls(decls)}\n}`);
    } else if (piece.kind === 'group') {
      const inner = serialize(piece.children, needed);
      if (inner) out.push(`${piece.prelude} {\n${inner}\n}`);
    }
  }
  return out.join('\n');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Keeps only the rules the exported article can use, as CSS text. Content rules are kept whole.
 * Theme token rules (`:root`) are kept with just the custom properties the kept rules reach, so
 * light and dark themes still resolve. `extraCss` is CSS the export adds itself (its own layout and
 * the root element's inline style), so the variables it uses are kept too. KaTeX rules are kept
 * only when the document has math. Font files are never included.
 */
export function filterAppCss(rules: ArrayLike<CSSRule>, options: { math: boolean; extraCss?: string[] }): string {
  const pieces = classify(Array.from(rules), options.math);
  const all = flatten(pieces);
  const needed = new Set<string>();
  const keptTexts = [...(options.extraCss ?? []), ...all.flatMap((p) => (p.kind === 'text' ? [p.css] : []))];
  for (const css of keptTexts) {
    for (const match of css.matchAll(VAR_REF)) needed.add(match[1]);
  }
  const tokenDecls = all.flatMap((p) => (p.kind === 'tokens' ? p.decls.filter((d) => d.name.startsWith('--')) : []));
  let grew = true;
  while (grew) {
    grew = false;
    for (const decl of tokenDecls) {
      if (!needed.has(decl.name)) continue;
      for (const match of decl.value.matchAll(VAR_REF)) {
        if (!needed.has(match[1])) {
          needed.add(match[1]);
          grew = true;
        }
      }
    }
  }

  const body = serialize(pieces, needed);
  // Keyframes are kept only when a kept rule animates with them.
  const keyframes = all.flatMap((p) => (p.kind === 'keyframes' ? [p] : []));
  const used = keyframes.filter((k) => new RegExp(`(?<![\\w-])${escapeRegExp(k.name)}(?![\\w-])`).test(body));
  return [body, ...used.map((k) => k.css)].filter(Boolean).join('\n');
}

/** The app's own stylesheets, filtered for the export. Sheets the browser will not read are skipped. */
function appStylesheet(math: boolean, extraCss: string[]): string {
  const rules: CSSRule[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      rules.push(...Array.from(sheet.cssRules));
    } catch {
      // A sheet from another origin cannot be read.
    }
  }
  return filterAppCss(rules, { math, extraCss });
}

export async function buildStandaloneHtml(doc: Doc, options: ExportOptions = {}): Promise<string> {
  const { settings, systemDark } = useSettings.getState();
  const theme = settings.exportTheme === 'paper' ? 'paper' : activeTheme(settings, systemDark);
  const skipped: SkippedAsset[] = [];
  const article = await renderDetached(doc, isDarkTheme(theme), true, skipped);
  reportSkipped(skipped, options);
  const title = doc.name.replace(/\.[^.]+$/, '');
  const rootStyle = document.documentElement.getAttribute('style') ?? '';
  const math = needsKatexCss(article);
  return `<!doctype html>
<html lang="en" data-theme="${theme}" data-headings="${settings.headingStyle}" data-code-wrap="${settings.codeWrap}" style="${rootStyle.replace(/"/g, '&quot;')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${math ? `<link rel="stylesheet" href="${KATEX_CDN}">` : ''}
<style>
${appStylesheet(math, [rootStyle, EXPORT_CSS])}
${EXPORT_CSS}
</style>
</head>
<body>
${settings.exportIncludeTitle ? `<p class="export-title">${escapeHtml(title)}</p>` : ''}
${article.outerHTML}
</body>
</html>
`;
}

export async function exportHtml(doc: Doc, options: ExportOptions = {}): Promise<void> {
  const name = doc.name.replace(/\.[^.]+$/, '') + '.html';
  const path = await pickSavePath(name, 'html', doc.path ? dirName(doc.path) : undefined);
  if (!path) return;
  try {
    const html = await buildStandaloneHtml(doc, options);
    if (isTauri) await writeFile(path, html);
    else downloadText(name, html, 'text/html');
    toast.success('Exported HTML', baseName(path));
  } catch (err) {
    toast.error('Export failed', String(err instanceof Error ? err.message : err));
  }
}

/** Print (and "Save as PDF" from the print dialog) using a clean, paper-styled copy of the document. */
export async function printDoc(doc: Doc, options: ExportOptions = {}): Promise<void> {
  const { settings } = useSettings.getState();
  const skipped: SkippedAsset[] = [];
  const article = await renderDetached(doc, false, true, skipped);
  reportSkipped(skipped, options);
  let root = document.getElementById('print-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'print-root';
    document.body.appendChild(root);
  }
  root.dataset.margins = settings.printMargins;
  root.replaceChildren(article);
  const prevTitle = document.title;
  document.title = doc.name.replace(/\.[^.]+$/, '');
  const done = () => {
    document.title = prevTitle;
    root?.replaceChildren();
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  // Give images a beat to decode so they are not blank on paper.
  await Promise.all(
    Array.from(article.querySelectorAll('img')).map((img) => {
      img.loading = 'eager';
      return img.decode().catch(() => undefined);
    }),
  );
  window.print();
}

export async function copyAsHtml(doc: Doc): Promise<void> {
  const article = await renderDetached(doc, false);
  const html = article.innerHTML;
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([article.innerText], { type: 'text/plain' }),
      }),
    ]);
    toast.success('Copied as rich text', 'Paste into Word, Docs or an email.');
  } catch {
    await navigator.clipboard.writeText(html);
    toast.success('Copied HTML');
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}
