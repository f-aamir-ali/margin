/* Pure find and replace helpers for the find bar. No DOM, no CodeMirror.
   Positions are UTF-16 offsets into the text given (CodeMirror uses the same units). */

export interface FindOptions {
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
}

export interface MatchRange {
  from: number;
  to: number;
}

export interface FindResult {
  ranges: MatchRange[];
  /** True only when more matches exist beyond `cap`. */
  capped: boolean;
  /** The regex error message when the query is not a valid regular expression. */
  error: string | null;
}

export interface Change {
  from: number;
  to: number;
  insert: string;
}

const WORD = '[\\p{L}\\p{N}_]';

/** Build the RegExp for a query. `re` is null for an empty query or an invalid regex (see `error`). */
export function compileFind(query: string, o: FindOptions): { re: RegExp | null; error: string | null } {
  if (!query) return { re: null, error: null };
  let src = o.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (o.wholeWord) src = `(?<!${WORD})(?:${src})(?!${WORD})`;
  try {
    return { re: new RegExp(src, `g${o.caseSensitive ? '' : 'i'}u`), error: null };
  } catch (e) {
    return { re: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The index after the code point that starts at `i`, so a scan never splits a surrogate pair. */
function nextIndex(text: string, i: number): number {
  const c = text.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff) {
    const d = text.charCodeAt(i + 1);
    if (d >= 0xdc00 && d <= 0xdfff) return i + 2;
  }
  return i + 1;
}

/**
 * Every non-empty match, in order. Zero-length matches (`^`, `\b`, `x*`) are skipped:
 * the scan moves on by one code point. Find, Replace All and Replace One all use this rule,
 * so the count shown always equals the number of replacements made.
 */
function* scan(text: string, re: RegExp): Generator<RegExpExecArray> {
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0].length === 0) {
      re.lastIndex = nextIndex(text, m.index);
      continue;
    }
    yield m;
  }
}

/** Replacement text for one match, with the JavaScript `$` rules (`$1`, `$<name>`, `$&`, `` $` ``, `$'`, `$$`). */
export function expandReplacement(m: RegExpExecArray, input: string, rep: string): string {
  if (!rep.includes('$')) return rep;
  const matched = m[0];
  const captures = m.length - 1;
  const tail = m.index + matched.length;
  let out = '';
  for (let i = 0; i < rep.length; i++) {
    const c = rep[i];
    const n = rep[i + 1];
    if (c !== '$' || n === undefined) {
      out += c;
      continue;
    }
    if (n === '$') {
      out += '$';
      i++;
    } else if (n === '&') {
      out += matched;
      i++;
    } else if (n === '`') {
      out += input.slice(0, m.index);
      i++;
    } else if (n === "'") {
      out += input.slice(tail);
      i++;
    } else if (n >= '0' && n <= '9') {
      const pair = rep.slice(i + 1, i + 3);
      if (/^\d\d$/.test(pair) && Number(pair) >= 1 && Number(pair) <= captures) {
        out += m[Number(pair)] ?? '';
        i += 2;
      } else if (Number(n) >= 1 && Number(n) <= captures) {
        out += m[Number(n)] ?? '';
        i++;
      } else {
        out += c;
      }
    } else if (n === '<' && m.groups) {
      const close = rep.indexOf('>', i + 2);
      if (close < 0) {
        out += c;
      } else {
        out += m.groups[rep.slice(i + 2, close)] ?? '';
        i = close;
      }
    } else {
      out += c;
    }
  }
  return out;
}

/** Every match, up to `cap` (Infinity for none). `capped` means a match beyond the cap exists. */
export function findMatches(text: string, query: string, o: FindOptions, cap = Infinity): FindResult {
  const { re, error } = compileFind(query, o);
  if (!re) return { ranges: [], capped: false, error };
  const ranges: MatchRange[] = [];
  for (const m of scan(text, re)) {
    if (ranges.length >= cap) return { ranges, capped: true, error: null };
    ranges.push({ from: m.index, to: m.index + m[0].length });
  }
  return { ranges, capped: false, error: null };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * `findMatches` that yields to the event loop after each `budgetMs` of work, so a big document
 * keeps the UI responsive. Resolves to null as soon as `isCurrent()` is false (the query or the
 * document moved on). A single regex exec cannot be interrupted, so one catastrophic pattern can
 * still block for that exec.
 */
export async function findMatchesAsync(
  text: string,
  query: string,
  o: FindOptions,
  cap: number,
  isCurrent: () => boolean,
  budgetMs = 50,
): Promise<FindResult | null> {
  const { re, error } = compileFind(query, o);
  if (!re) return { ranges: [], capped: false, error };
  const ranges: MatchRange[] = [];
  let sliceStart = performance.now();
  for (const m of scan(text, re)) {
    if (ranges.length >= cap) return { ranges, capped: true, error: null };
    ranges.push({ from: m.index, to: m.index + m[0].length });
    if (performance.now() - sliceStart >= budgetMs) {
      await tick();
      if (!isCurrent()) return null;
      sliceStart = performance.now();
    }
  }
  return { ranges, capped: false, error: null };
}

/** The edits Replace All makes: exactly the matches `findMatches` reports, uncapped, in order. */
export function replaceChanges(text: string, query: string, replacement: string, o: FindOptions): { changes: Change[]; count: number } {
  const { re } = compileFind(query, o);
  if (!re) return { changes: [], count: 0 };
  const changes: Change[] = [];
  for (const m of scan(text, re)) {
    changes.push({
      from: m.index,
      to: m.index + m[0].length,
      insert: o.regex ? expandReplacement(m, text, replacement) : replacement,
    });
  }
  return { changes, count: changes.length };
}

/** Replace All as a whole-text operation. `count` equals the number of replacements made. */
export function replaceAll(text: string, query: string, replacement: string, o: FindOptions): { text: string; count: number } {
  const { changes, count } = replaceChanges(text, query, replacement, o);
  let out = '';
  let pos = 0;
  for (const c of changes) {
    out += text.slice(pos, c.from) + c.insert;
    pos = c.to;
  }
  return { text: out + text.slice(pos), count };
}

/** The single edit for the match that starts exactly at `from`, or null if there is none. Used by Replace One. */
export function replaceAt(text: string, from: number, query: string, replacement: string, o: FindOptions): Change | null {
  const { re } = compileFind(query, o);
  if (!re) return null;
  const sticky = new RegExp(re.source, re.flags.replace('g', 'y'));
  sticky.lastIndex = from;
  const m = sticky.exec(text);
  if (!m || m[0].length === 0) return null;
  return { from, to: from + m[0].length, insert: o.regex ? expandReplacement(m, text, replacement) : replacement };
}
