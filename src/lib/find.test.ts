import { describe, expect, it } from 'vitest';
import { compileFind, findMatches, findMatchesAsync, replaceAll, replaceAt, replaceChanges, type FindOptions } from './find';

const plain: FindOptions = { regex: false, caseSensitive: false, wholeWord: false };
const rx: FindOptions = { ...plain, regex: true };
const exact: FindOptions = { ...plain, caseSensitive: true };
const whole: FindOptions = { ...plain, wholeWord: true };

const texts = (text: string, query: string, o: FindOptions) =>
  findMatches(text, query, o).ranges.map((r) => text.slice(r.from, r.to));

describe('findMatches: basics', () => {
  it('reports UTF-16 positions of each match', () => {
    expect(findMatches('one two one', 'one', plain)).toEqual({
      ranges: [
        { from: 0, to: 3 },
        { from: 8, to: 11 },
      ],
      capped: false,
      error: null,
    });
  });

  it('ignores case by default and respects caseSensitive', () => {
    expect(texts('Cat cat CAT', 'cat', plain)).toHaveLength(3);
    expect(findMatches('Cat cat CAT', 'cat', exact).ranges).toEqual([{ from: 4, to: 7 }]);
  });

  it('escapes the query when regex is off', () => {
    expect(texts('a.b axb (x)', 'a.b', plain)).toEqual(['a.b']);
    expect(texts('a.b axb (x)', '(x)', plain)).toEqual(['(x)']);
  });

  it('returns nothing for an empty query', () => {
    expect(findMatches('anything', '', plain)).toEqual({ ranges: [], capped: false, error: null });
  });

  it('matches whole words only', () => {
    expect(findMatches('cat cats concat cat.', 'cat', whole).ranges).toEqual([
      { from: 0, to: 3 },
      { from: 16, to: 19 },
    ]);
  });

  it('whole word also applies to regex queries', () => {
    expect(texts('cat cats', 'cat\\w*', { ...whole, regex: true })).toEqual(['cat', 'cats']);
    expect(texts('cats cat', 'cat', { ...whole, regex: true })).toEqual(['cat']);
  });
});

describe('findMatches: unicode', () => {
  it('matches accented letters case-insensitively', () => {
    expect(texts('Café café CAFÉ', 'café', plain)).toEqual(['Café', 'café', 'CAFÉ']);
  });

  it('reports surrogate-pair characters at UTF-16 offsets', () => {
    expect(findMatches('😀a😀', '😀', plain).ranges).toEqual([
      { from: 0, to: 2 },
      { from: 3, to: 5 },
    ]);
  });

  it('treats an astral character as one unit for regex dot', () => {
    expect(findMatches('😀', '^.$', rx).ranges).toEqual([{ from: 0, to: 2 }]);
  });
});

describe('findMatches: invalid regex and caps', () => {
  it('reports an invalid regex as an error instead of throwing', () => {
    const r = findMatches('abc', '(', rx);
    expect(r.ranges).toEqual([]);
    expect(r.error).toEqual(expect.any(String));
    expect(compileFind('(', rx).re).toBeNull();
  });

  it('caps the result and says so only when more matches exist', () => {
    expect(findMatches('aaaaa', 'a', plain, 3)).toEqual({
      ranges: [
        { from: 0, to: 1 },
        { from: 1, to: 2 },
        { from: 2, to: 3 },
      ],
      capped: true,
      error: null,
    });
    expect(findMatches('aaa', 'a', plain, 3).capped).toBe(false);
  });
});

describe('zero-length matches', () => {
  it('skips zero-length matches in Find', () => {
    expect(findMatches('abx', 'x*', rx).ranges).toEqual([{ from: 2, to: 3 }]);
    expect(findMatches('a\nb', '^', rx).ranges).toEqual([]);
    expect(findMatches('ab cd', '\\b', rx).ranges).toEqual([]);
  });

  it('terminates on an empty pattern over astral text', () => {
    expect(findMatches('😀😀', '(?:)', rx)).toEqual({ ranges: [], capped: false, error: null });
  });

  it('Replace All makes exactly as many replacements as Find counts', () => {
    const text = 'xax\nb xx\n\nend';
    for (const pattern of ['x*', '^', '$', '\\b', 'a|', '\\b\\w*', '(?=x)', 'x?']) {
      const found = findMatches(text, pattern, rx).ranges.length;
      const replaced = replaceAll(text, pattern, '-', rx);
      expect(replaced.count, pattern).toBe(found);
    }
  });

  it('Replace All does not insert text at zero-length positions', () => {
    expect(replaceAll('abx', 'x*', '-', rx)).toEqual({ text: 'ab-', count: 1 });
  });
});

describe('replaceAll', () => {
  it('uses the replacement literally when regex is off', () => {
    expect(replaceAll('a.b a.b', 'a.b', '$1 & $$', plain)).toEqual({ text: '$1 & $$ $1 & $$', count: 2 });
  });

  it('expands $1 group references in regex mode', () => {
    expect(replaceAll('John Smith', '(\\w+) (\\w+)', '$2, $1', rx)).toEqual({ text: 'Smith, John', count: 1 });
  });

  it('expands $& and $$', () => {
    expect(replaceAll('a1 a2', 'a(\\d)', '[$&|$$|$1]', rx).text).toBe('[a1|$|1] [a2|$|2]');
  });

  it('expands $<name> for named groups', () => {
    expect(replaceAll('2026-11', '(?<y>\\d{4})-(?<m>\\d{2})', '$<m>/$<y>', rx).text).toBe('11/2026');
  });

  it('keeps references to missing groups as written', () => {
    expect(replaceAll('a', '(a)', '$2', rx).text).toBe('$2');
    expect(replaceAll('a', '(a)', '$10', rx).text).toBe('a0');
    expect(replaceAll('a', '(a)', '$0', rx).text).toBe('$0');
  });

  it('expands $` and $\' around the match', () => {
    expect(replaceAll('abc', 'b', "[$`|$']", rx).text).toBe("a[a|c]c");
  });

  it('is case-insensitive by default', () => {
    expect(replaceAll('Cat cat', 'cat', 'dog', plain)).toEqual({ text: 'dog dog', count: 2 });
  });

  it('respects whole word', () => {
    expect(replaceAll('cat catalog cat', 'cat', 'dog', whole)).toEqual({ text: 'dog catalog dog', count: 2 });
  });

  it('handles unicode text', () => {
    expect(replaceAll('naïve café', 'café', 'coffee', plain).text).toBe('naïve coffee');
    expect(replaceAll('😀x😀', '😀', '!', plain).text).toBe('!x!');
  });

  it('returns the text unchanged for an invalid regex', () => {
    expect(replaceAll('abc', '(', 'x', rx)).toEqual({ text: 'abc', count: 0 });
  });
});

describe('replaceChanges and replaceAt', () => {
  it('lists edits in order that never overlap', () => {
    const { changes, count } = replaceChanges('a-a-a', 'a', 'bb', plain);
    expect(count).toBe(3);
    expect(changes.map((c) => [c.from, c.to])).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
    ]);
  });

  it('replaces only the match that starts at the given position', () => {
    expect(replaceAt('abc abc', 4, 'abc', 'X', plain)).toEqual({ from: 4, to: 7, insert: 'X' });
    expect(replaceAt('abc abc', 3, 'abc', 'X', plain)).toBeNull();
  });

  it('expands groups for a single replacement', () => {
    expect(replaceAt('x=1', 1, '=(\\d)', '[$1]', rx)).toEqual({ from: 1, to: 3, insert: '[1]' });
  });

  it('returns null for a zero-length match position', () => {
    expect(replaceAt('abc', 0, '^', 'X', rx)).toBeNull();
  });
});

describe('findMatchesAsync', () => {
  // A zero budget yields after every match, so keep the fixture small (each yield is a timer hop).
  const text = 'ab cd '.repeat(20);

  it('gives the same result as the synchronous search when it yields often', async () => {
    const sync = findMatches(text, 'ab', plain);
    const async = await findMatchesAsync(text, 'ab', plain, Infinity, () => true, 0);
    expect(async).toEqual(sync);
    expect(async?.ranges).toHaveLength(20);
  });

  it('drops the search as soon as it is stale', async () => {
    expect(await findMatchesAsync(text, 'ab', plain, Infinity, () => false, 0)).toBeNull();
  });

  it('applies the cap across chunks', async () => {
    const r = await findMatchesAsync(text, 'ab', plain, 5, () => true, 0);
    expect(r?.ranges).toHaveLength(5);
    expect(r?.capped).toBe(true);
  });

  it('reports an invalid regex without running', async () => {
    const r = await findMatchesAsync(text, '(', rx, Infinity, () => true);
    expect(r?.ranges).toEqual([]);
    expect(r?.error).toEqual(expect.any(String));
  });
});
