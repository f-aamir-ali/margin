/* Plain-text paste for the Markdown editor: what pasted text turns into. Pure functions, so the rules are tested
   without an editor. The editor turns the lines into paragraphs with unmarked text (see Editor.tsx). */

/**
 * The non-blank lines of pasted text, one paragraph each. A blank line is not a paragraph of its own: the
 * paragraph break already leaves a gap between two lines, and Markdown has no empty paragraphs (the save drops
 * them, see fromEditor), so keeping one would make the editor disagree with the file.
 */
export function plainTextLines(text: string): string[] {
  return text
    .replace(/ /g, ' ')
    .split(/\r\n|\r|\n/)
    .filter((line) => line.trim() !== '');
}

/** The readable text of an HTML clipboard payload, with line breaks where the layout has them. */
export function htmlToPlainText(html: string): string {
  if (!html.trim()) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, template').forEach((el) => el.remove());
  doc.querySelectorAll('br').forEach((el) => el.replaceWith('\n'));
  doc
    .querySelectorAll('p, div, li, tr, blockquote, pre, h1, h2, h3, h4, h5, h6, table, ul, ol, hr')
    .forEach((el) => {
      el.prepend('\n');
      el.append('\n');
    });
  return doc.body.textContent ?? '';
}

/** The text to paste: the plain-text flavour when the source has one, otherwise the text of its HTML. */
export function clipboardPlainText(plain: string, html: string): string {
  return plain || htmlToPlainText(html);
}
