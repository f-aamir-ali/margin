// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { clipboardPlainText, htmlToPlainText, plainTextLines } from './paste';

describe('plainTextLines', () => {
  it('makes one paragraph per line and drops blank lines', () => {
    expect(plainTextLines('one\n\ntwo\n   \nthree')).toEqual(['one', 'two', 'three']);
  });

  it('accepts Windows and old Mac line endings', () => {
    expect(plainTextLines('a\r\nb\rc\n')).toEqual(['a', 'b', 'c']);
  });

  it('keeps Markdown syntax literal', () => {
    expect(plainTextLines('*x* and # not a heading\n- not a list')).toEqual(['*x* and # not a heading', '- not a list']);
  });

  it('turns non-breaking spaces into ordinary spaces', () => {
    expect(plainTextLines('a b')).toEqual(['a b']);
  });

  it('returns nothing for whitespace only', () => {
    expect(plainTextLines(' \n\t\n')).toEqual([]);
  });
});

describe('htmlToPlainText', () => {
  it('keeps the readable text and drops every tag, mark and link', () => {
    const html = '<h1>Title</h1><p><em>hello</em> <a href="https://example.com"><strong>link</strong></a></p><p>second</p>';
    expect(plainTextLines(htmlToPlainText(html))).toEqual(['Title', 'hello link', 'second']);
  });

  it('reads line breaks and list items as lines', () => {
    expect(plainTextLines(htmlToPlainText('<p>a<br>b</p><ul><li>one</li><li>two</li></ul>'))).toEqual(['a', 'b', 'one', 'two']);
  });

  it('leaves out scripts and styles', () => {
    expect(plainTextLines(htmlToPlainText('<style>p{color:red}</style><script>x()</script><p>kept</p>'))).toEqual(['kept']);
  });

  it('is empty for empty HTML', () => {
    expect(htmlToPlainText('  ')).toBe('');
  });
});

describe('clipboardPlainText', () => {
  it('prefers the plain-text flavour', () => {
    expect(clipboardPlainText('plain', '<p>html</p>')).toBe('plain');
  });

  it('falls back to the text of the HTML', () => {
    expect(plainTextLines(clipboardPlainText('', '<p>only html</p>'))).toEqual(['only html']);
  });
});
