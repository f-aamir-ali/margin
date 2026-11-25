import { EditorState } from '@codemirror/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReporter, putEditorState, takeEditorState, type KeptEditor } from './sourceState';

describe('createReporter (large documents report in batches)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reports once, a quiet 120 ms after the last change', () => {
    const report = vi.fn();
    const r = createReporter({ report, now: () => Date.now() });
    r.touch();
    vi.advanceTimersByTime(60);
    r.touch();
    vi.advanceTimersByTime(100);
    expect(report).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('never waits more than 400 ms after the first unreported change', () => {
    const report = vi.fn();
    const r = createReporter({ report, now: () => Date.now() });
    // Keys every 50 ms, so the quiet timer alone would never fire.
    for (let i = 0; i < 7; i++) {
      r.touch();
      vi.advanceTimersByTime(50);
    }
    expect(report).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('flush reports now, and cancel drops what is waiting', () => {
    const report = vi.fn();
    const r = createReporter({ report, now: () => Date.now() });
    r.flush();
    expect(report).not.toHaveBeenCalled();
    r.touch();
    r.flush();
    expect(report).toHaveBeenCalledTimes(1);
    r.touch();
    r.cancel();
    vi.advanceTimersByTime(1000);
    expect(report).toHaveBeenCalledTimes(1);
  });
});

describe('kept editor states (undo survives a tab switch)', () => {
  const kept = (text: string, extra: Partial<KeptEditor> = {}): KeptEditor => ({
    state: EditorState.create({ doc: text }),
    text,
    eol: '\n',
    kind: 'text',
    name: 'app.log',
    ...extra,
  });
  const want = (text: string, extra: Partial<Pick<KeptEditor, 'eol' | 'kind' | 'name'>> = {}) => ({
    text,
    eol: '\n',
    kind: 'text',
    name: 'app.log',
    ...extra,
  });

  it('gives back the same state for unchanged text, and only once', () => {
    const entry = kept('hello\nworld');
    putEditorState('a', entry);
    expect(takeEditorState('a', want(['hello', 'world'].join('\n')))).toBe(entry.state);
    expect(takeEditorState('a', want('hello\nworld'))).toBeNull();
  });

  it('refuses a state when the text, line ending, kind or name no longer match', () => {
    putEditorState('a', kept('one'));
    expect(takeEditorState('a', want('two'))).toBeNull();
    putEditorState('a', kept('one'));
    expect(takeEditorState('a', want('one', { eol: '\r\n' }))).toBeNull();
    putEditorState('a', kept('one'));
    expect(takeEditorState('a', want('one', { kind: 'markdown' }))).toBeNull();
    putEditorState('a', kept('one'));
    expect(takeEditorState('a', want('one', { name: 'other.txt' }))).toBeNull();
  });

  it('keeps six documents and drops the least recently used', () => {
    for (let i = 0; i < 7; i++) putEditorState(`d${i}`, kept(`doc ${i}`));
    expect(takeEditorState('d0', want('doc 0'))).toBeNull();
    expect(takeEditorState('d6', want('doc 6'))).not.toBeNull();
  });

  it('keeps no more than the total text budget, dropping the oldest first', () => {
    const big = (n: number) => kept('x'.repeat(n));
    putEditorState('a', big(25_000_000));
    putEditorState('b', big(25_000_000));
    putEditorState('c', big(25_000_000));
    expect(takeEditorState('a', want('x'.repeat(25_000_000)))).toBeNull();
    expect(takeEditorState('c', want('x'.repeat(25_000_000)))).not.toBeNull();
  });

  it('does not keep a single document larger than the budget', () => {
    putEditorState('huge', kept('x'.repeat(49_000_000)));
    expect(takeEditorState('huge', want('x'.repeat(49_000_000)))).toBeNull();
  });
});
