import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as platform from './platform';
import { detectEol, normaliseEol } from './platform';
import { activeDoc, hashText, isDirty, liveEditors, noteTitle, useApp } from './store';

describe('noteTitle (untitled notes are named after their first line)', () => {
  it('uses the first non-empty line without markdown marks', () => {
    expect(noteTitle('\n\n# Shopping list\n- milk')).toBe('Shopping list');
    expect(noteTitle('- [ ] call **Dad** back')).toBe('call Dad back');
    expect(noteTitle('1. first step')).toBe('first step');
  });
  it('shortens long lines and handles empty notes', () => {
    expect(noteTitle('a'.repeat(80))).toHaveLength(40);
    expect(noteTitle('a'.repeat(80))?.endsWith('…')).toBe(true);
    expect(noteTitle('   \n\t\n')).toBeNull();
    expect(noteTitle('')).toBeNull();
  });
  it('understands CRLF', () => {
    expect(noteTitle('\r\nTitle line\r\nbody')).toBe('Title line');
  });
});

describe('hashText', () => {
  it('is stable and tells versions apart', () => {
    expect(hashText('hello')).toBe(hashText('hello'));
    expect(hashText('hello')).not.toBe(hashText('hellp'));
    expect(hashText('a\r\nb')).not.toBe(hashText('a\nb'));
  });
});

describe('line endings', () => {
  it('detects the first line ending', () => {
    expect(detectEol('a\r\nb')).toBe('\r\n');
    expect(detectEol('a\nb')).toBe('\n');
    expect(detectEol('a\rb')).toBe('\r');
    expect(detectEol('single line')).toBe('\n');
  });
  it('leaves consistent text untouched', () => {
    const crlf = 'a\r\nb\r\nc';
    expect(normaliseEol(crlf)).toBe(crlf);
    expect(normaliseEol('a\nb\n')).toBe('a\nb\n');
  });
  it('normalises a mix to the majority', () => {
    expect(normaliseEol('a\r\nb\r\nc\nd')).toBe('a\r\nb\r\nc\r\nd');
    expect(normaliseEol('a\nb\nc\r\nd')).toBe('a\nb\nc\nd');
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('file operations while editing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(platform, 'storeSet').mockResolvedValue();
    vi.spyOn(platform, 'downloadText').mockImplementation(() => undefined);
    useApp.setState({ docs: [], activeId: null, recents: [] });
  });

  afterEach(() => {
    liveEditors.clear();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps keystrokes typed during Save As and writes them on the next save', async () => {
    const app = useApp.getState();
    app.newDoc('text');
    const id = useApp.getState().activeId!;
    app.setContent(id, 'before');
    const dialog = deferred<string>();
    const write = deferred<{ mtimeMs: number }>();
    vi.spyOn(platform, 'pickSavePath').mockReturnValue(dialog.promise);
    const onDisk = vi.spyOn(platform, 'writeFile').mockReturnValueOnce(write.promise).mockResolvedValue({ mtimeMs: 2 });
    const saveAs = app.saveAs(id);
    app.setContent(id, 'during dialog');
    dialog.resolve('copy.txt');
    await Promise.resolve();
    app.setContent(id, 'during write');
    write.resolve({ mtimeMs: 1 });
    await expect(saveAs).resolves.toBe(true);
    expect(onDisk).toHaveBeenNthCalledWith(1, 'copy.txt', 'during dialog', { encoding: 'UTF-8', bom: false });
    const current = activeDoc(useApp.getState())!;
    expect(current).toMatchObject({ content: 'during write', saved: 'during dialog', path: 'copy.txt' });
    expect(isDirty(current)).toBe(true);
    await expect(app.save(id)).resolves.toBe(true);
    expect(onDisk).toHaveBeenLastCalledWith('copy.txt', 'during write', expect.objectContaining({ encoding: 'UTF-8' }));
  });

  it('refuses to reopen in another encoding when the live editor has unsaved input', async () => {
    const app = useApp.getState();
    const read = vi.spyOn(platform, 'readFile').mockResolvedValue({
      path: 'note.md', name: 'note.md', content: 'disk', mtimeMs: 1, size: 4,
      readonly: false, binary: false, encoding: 'UTF-8', bom: false,
    });
    await app.openPaths(['note.md']);
    const id = useApp.getState().activeId!;
    liveEditors.add(() => app.setContent(id, 'just typed', true));
    await app.reopenWithEncoding(id, 'windows-1252');
    expect(read).toHaveBeenCalledTimes(1);
    expect(activeDoc(useApp.getState())?.content).toBe('just typed');
  });

  it('does not auto-save over a conflict', async () => {
    const app = useApp.getState();
    const disk = {
      path: 'note.md', name: 'note.md', content: 'disk', mtimeMs: 1, size: 4,
      readonly: false, binary: false, encoding: 'UTF-8', bom: false,
    };
    const read = vi.spyOn(platform, 'readFile').mockResolvedValueOnce(disk).mockResolvedValue({ ...disk, content: 'outside', mtimeMs: 2 });
    const write = vi.spyOn(platform, 'writeFile');
    await app.openPaths([disk.path]);
    const id = useApp.getState().activeId!;
    liveEditors.add(() => app.setContent(id, 'just typed', true));
    await app.handleExternalChange(disk.path, 'modified');
    expect(read).toHaveBeenCalledTimes(2);
    expect(activeDoc(useApp.getState())).toMatchObject({ content: 'just typed', conflict: true });
    await app.saveAll();
    expect(write).not.toHaveBeenCalled();
  });
});
