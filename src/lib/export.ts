import { enhance } from './enhance';
import { renderMarkdown } from './markdown';
import { asDataUrl, assetUrl, baseName, dirName, downloadText, isTauri, localImagePath, pickSavePath, writeFile } from './platform';
import { activeTheme, isDarkTheme, useSettings } from './settings';
import type { Doc } from './store';
import { toast } from './toast';

const KATEX_CDN = 'https://cdn.jsdelivr.net/npm/katex@0.19.1/dist/katex.min.css';

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

/** Render a document into a detached element, with diagrams drawn. */
async function renderDetached(doc: Doc, dark: boolean, embedImages = false): Promise<HTMLElement> {
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
    await Promise.all(Array.from(host.querySelectorAll<HTMLImageElement>('img[src]')).map(async (img) => {
      const local = localImagePath(img.getAttribute('src') ?? '', folder);
      if (!local) return;
      const src = assetUrl(local);
      if (!embedImages) {
        img.src = src;
        return;
      }
      try {
        const response = await fetch(src);
        if (response.ok) img.src = await asDataUrl(await response.blob());
      } catch {
        // Keep the original reference when a local image can't be read.
      }
    }));
  }
  // Mermaid measures text, so the element must be in the document while it renders.
  host.style.cssText = 'position:fixed;left:-99999px;top:0;width:760px;visibility:hidden';
  document.body.appendChild(host);
  const cleanup = enhance(host, { theme: dark ? 'dark' : 'light' });
  const deadline = Date.now() + 8000;
  while (host.querySelector('.mermaid-block:not(.is-rendered)') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 60));
  }
  cleanup();
  host.remove();
  host.style.cssText = '';
  host.querySelectorAll('.code-copy, .heading-anchor').forEach((el) => el.remove());
  return host;
}

/** All app CSS as text, minus bundled font files (which would not travel with the export). */
function collectCss(): string {
  const out: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSFontFaceRule) continue;
      out.push(rule.cssText);
    }
  }
  return out.join('\n');
}

export async function buildStandaloneHtml(doc: Doc): Promise<string> {
  const { settings, systemDark } = useSettings.getState();
  const theme = settings.exportTheme === 'paper' ? 'paper' : activeTheme(settings, systemDark);
  const article = await renderDetached(doc, isDarkTheme(theme), true);
  const title = doc.name.replace(/\.[^.]+$/, '');
  const rootStyle = document.documentElement.getAttribute('style') ?? '';
  return `<!doctype html>
<html lang="en" data-theme="${theme}" data-headings="${settings.headingStyle}" data-code-wrap="${settings.codeWrap}" style="${rootStyle.replace(/"/g, '&quot;')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${KATEX_CDN}">
<style>
${collectCss()}
html, body { height: auto; overflow: auto; user-select: text; cursor: auto; }
body { background: var(--doc-bg); padding: 56px 24px 96px; }
.prose { max-width: var(--doc-width); margin: 0 auto; }
</style>
</head>
<body>
${settings.exportIncludeTitle ? `<p class="export-title">${escapeHtml(title)}</p>` : ''}
${article.outerHTML}
</body>
</html>
`;
}

export async function exportHtml(doc: Doc): Promise<void> {
  const name = doc.name.replace(/\.[^.]+$/, '') + '.html';
  const path = await pickSavePath(name, 'html', doc.path ? dirName(doc.path) : undefined);
  if (!path) return;
  try {
    const html = await buildStandaloneHtml(doc);
    if (isTauri) await writeFile(path, html);
    else downloadText(name, html, 'text/html');
    toast.success('Exported HTML', baseName(path));
  } catch (err) {
    toast.error('Export failed', String(err instanceof Error ? err.message : err));
  }
}

/** Print (and "Save as PDF" from the print dialog) using a clean, paper-styled copy of the document. */
export async function printDoc(doc: Doc): Promise<void> {
  const { settings } = useSettings.getState();
  const article = await renderDetached(doc, false, true);
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
