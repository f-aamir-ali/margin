import { describe, expect, it } from 'vitest';
import { fromEditor, toEditor } from './editorText';

describe('toEditor: display math spellings', () => {
  it('leaves a well-formed block alone', () => {
    const md = 'a\n\n$$\nx = 1\n$$\n\nb';
    expect(toEditor(md)).toBe(md);
  });

  it('splits a one-line block', () => {
    expect(toEditor('$$x = 1$$')).toBe('$$\nx = 1\n$$');
  });

  it('splits delimiters that share a line with content', () => {
    const md = '$$\\begin{aligned}\na &= b \\\\\n\\end{aligned}$$\n\n## Next';
    expect(toEditor(md)).toBe('$$\n\\begin{aligned}\na &= b \\\\\n\\end{aligned}\n$$\n\n## Next');
  });

  it('never touches code fences', () => {
    const md = '```sh\n$$not math$$\necho $$\n```\n\n~~~\n$$x$$\n~~~';
    expect(toEditor(md)).toBe(md);
  });

  it('leaves inline math and prices alone', () => {
    const md = 'Costs $5 and $10, and $a+b$ inline, then $$ in text.';
    expect(toEditor(md)).toBe(md);
  });

  it('keeps indentation (math inside a list item)', () => {
    expect(toEditor('- item\n\n  $$y$$')).toBe('- item\n\n  $$\n  y\n  $$');
  });
});

describe('fromEditor', () => {
  it('unescapes GitHub alerts', () => {
    expect(fromEditor('> \\[!NOTE]\n> Body')).toBe('> [!NOTE]\n> Body');
    expect(fromEditor('> \\[!warning\\]\n> Body')).toBe('> [!warning]\n> Body');
    expect(fromEditor('> > \\[!TIP]\n> > nested')).toBe('> > [!TIP]\n> > nested');
  });

  it('unescapes a table-of-contents marker', () => {
    expect(fromEditor('intro\n\n\\[toc]\n\ntext')).toBe('intro\n\n[toc]\n\ntext');
    expect(fromEditor('\\[\\[toc\\]\\]')).toBe('[[toc]]');
  });

  it('leaves other escaped brackets alone', () => {
    expect(fromEditor('a \\[not a link] b')).toBe('a \\[not a link] b');
  });

  it('drops empty-paragraph placeholders', () => {
    expect(fromEditor('a\n\n<br />\n\nb\n')).toBe('a\n\nb\n');
    expect(fromEditor('a\n\n<br />\n\n<br />\n\nb\n')).toBe('a\n\nb\n');
    expect(fromEditor('<br />\n\na\n')).toBe('a\n');
    expect(fromEditor('a\n\n<br />\n')).toBe('a\n');
  });

  it('keeps <br /> inside text and code', () => {
    expect(fromEditor('line one<br />\nline two')).toBe('line one<br />\nline two');
    const code = '```html\n\n<br />\n\n```';
    expect(fromEditor(code)).toBe(code);
  });
});
