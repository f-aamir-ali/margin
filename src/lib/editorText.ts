/* Text adapters between a file on disk and the WYSIWYG editor.
   The editor's parser is stricter than the Reading-mode renderer in a few places;
   these keep documents from being misread on the way in or damaged on the way out. */

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * The editor only recognises display math when `$$` sits on its own line.
 * Rewrite the other common spellings so a formula is never mistaken for an
 * unterminated block that swallows the rest of the document:
 *   `$$x = 1$$`                    (one line)
 *   `$$\begin{aligned}` … `\end{aligned}$$`   (delimiters sharing a line with content)
 */
export function toEditor(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let fence: string | null = null;
  let inMath = false;

  for (const line of lines) {
    const f = FENCE.exec(line);
    if (!inMath && f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = null;
      out.push(line);
      continue;
    }
    if (fence) {
      out.push(line);
      continue;
    }

    const trimmed = line.trim();
    const indent = line.slice(0, line.length - line.trimStart().length);

    if (!inMath) {
      if (trimmed === '$$') {
        inMath = true;
        out.push(line);
      } else if (trimmed.startsWith('$$') && trimmed.endsWith('$$') && trimmed.length > 4 && !trimmed.slice(2, -2).includes('$$')) {
        out.push(`${indent}$$`, indent + trimmed.slice(2, -2).trim(), `${indent}$$`);
      } else if (trimmed.startsWith('$$') && !trimmed.slice(2).includes('$$')) {
        inMath = true;
        out.push(`${indent}$$`, indent + trimmed.slice(2).trim());
      } else {
        out.push(line);
      }
    } else if (trimmed === '$$') {
      inMath = false;
      out.push(line);
    } else if (trimmed.endsWith('$$')) {
      inMath = false;
      out.push(indent + trimmed.slice(0, -2).trimEnd(), `${indent}$$`);
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}

/**
 * The editor writes an empty paragraph (an extra Enter) as a lone `<br />` block.
 * Markdown has no empty paragraphs, so those would just litter the file: leave them out.
 */
function dropEmptyParagraphs(md: string): string {
  if (!md.includes('<br />')) return md;
  const lines = md.split('\n');
  const out: string[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = FENCE.exec(line);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = null;
    }
    const alone = !fence && line === '<br />' && (out.length === 0 || out[out.length - 1] === '') && (lines[i + 1] === undefined || lines[i + 1] === '');
    if (alone) {
      if (lines[i + 1] === '') i++; // also swallow the blank line that followed it
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

const ALERT =/^((?:[ \t]*>[ \t]?)+)\\\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\\?\]/gim;
const TOC = /^\\\[(\\\[)?toc\\?\](\\\])?[ \t]*$/gim;

/**
 * The editor's serialiser escapes square brackets it does not understand.
 * Undo that for the two bracket constructs that must stay literal to keep working.
 */
export function fromEditor(md: string): string {
  return dropEmptyParagraphs(md)
    .replace(ALERT, (_m, prefix: string, kind: string) => `${prefix}[!${kind}]`)
    .replace(TOC, (_m, open?: string) => (open ? '[[toc]]' : '[toc]'));
}
