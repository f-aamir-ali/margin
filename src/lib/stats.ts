export interface DocStats {
  words: number;
  chars: number;
  lines: number;
  minutes: number;
}

/** Longer texts (in characters) are counted off the UI thread, and their editors report edits in batches. */
export const LARGE_DOC_CHARS = 200_000;

const WORD = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

/** Count the words a reader actually reads: code fences, front matter and syntax are left out. */
export function computeStats(src: string, plain = false): DocStats {
  const lines = src.length ? src.split(/\r\n|\r|\n/).length : 0;
  const prose = plain ? src : src.replace(/\r\n|\r/g, '\n')
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/^(```|~~~)[\s\S]*?^\1/gm, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ');
  const words = countWords(prose);
  return { words, chars: src.length, lines, minutes: words / 230 };
}

export function formatMinutes(min: number): string {
  if (min < 1) return 'under a minute';
  if (min < 60) return `${Math.round(min)} min read`;
  const h = Math.floor(min / 60);
  return `${h} h ${Math.round(min - h * 60)} min read`;
}

export function countWords(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0;
  return (text.replace(CJK, ' ').match(WORD)?.length ?? 0) + cjk;
}
