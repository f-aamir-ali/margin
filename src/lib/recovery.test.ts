import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractDataImages, fromEditor, splitFrontMatter } from './editorText';
import * as platform from './platform';
import type { FileData } from './platform';
import { canAutosave, cleanDraft, flushAll, liveEditors, pathKey, trimClosed, useApp } from './store';
import { useSettings } from './settings';

const file = (path: string, content: string, extra: Partial<FileData> = {}): FileData => ({
  path, name: path.split(/[\\/]/).pop() as string, content, mtimeMs: 1, size: content.length,
  readonly: false, binary: false, encoding: 'UTF-8', bom: false, lossy: false, version: `${content.length}:1`, ...extra,
});

const reset = () =>
  useApp.setState({ docs: [], activeId: null, recents: [], closed: [], draftTrouble: null, ready: false });

describe('closing and reopening tabs never loses text', () => {
  beforeEach(() => {
    vi.spyOn(platform, 'downloadText').mockImplementation(() => undefined);
    vi.spyOn(platform, 'draftWrite').mockResolvedValue();
    vi.spyOn(platform, 'watchFile').mockResolvedValue();
    vi.spyOn(platform, 'unwatchFile').mockResolvedValue();
    reset();
  });
  afterEach(() => {
    liveEditors.clear();
    vi.restoreAllMocks();
  });

  it('keeps the draft when the closed-tab history cannot be written', async () => {
    const deleted = vi.spyOn(platform, 'draftDelete').mockResolvedValue();
    vi.spyOn(platform, 'storeSet').mockImplementation(async (key, _v, strict) => {
      if (key === 'closed' && strict) throw new Error('disk full');
    });
    const app = useApp.getState();
    app.newDoc('markdown');
    const id = useApp.getState().activeId as string;
    app.setContent(id, 'precious words');
    app.closeDoc(id);
    await flushAll();
    expect(useApp.getState().docs).toHaveLength(0);
    // The history write failed, so the draft must still be on disk: it comes back next start.
    expect(deleted).not.toHaveBeenCalledWith(id);
    expect(platform.draftWrite).toHaveBeenCalledWith(expect.objectContaining({ id, content: 'precious words' }));
  });

  it('deletes the draft only after the history is on disk', async () => {
    const order: string[] = [];
    vi.spyOn(platform, 'storeSet').mockImplementation(async (key) => {
      if (key === 'closed') order.push('closed');
    });
    vi.spyOn(platform, 'draftDelete').mockImplementation(async () => {
      order.push('delete');
    });
    const app = useApp.getState();
    app.newDoc('markdown');
    const id = useApp.getState().activeId as string;
    app.setContent(id, 'words');
    app.closeDoc(id);
    await flushAll();
    expect(order).toEqual(['closed', 'delete']);
    expect(useApp.getState().closed.slice(-1)[0]).toMatchObject({ content: 'words' });
  });

  it('reopening a closed tab whose file is open again makes a separate copy, not a second writable tab', async () => {
    vi.spyOn(platform, 'storeSet').mockResolvedValue();
    vi.spyOn(platform, 'draftDelete').mockResolvedValue();
    vi.spyOn(platform, 'readFile').mockResolvedValue(file('C:\\notes\\a.md', 'disk text'));
    const app = useApp.getState();
    await app.openPaths(['C:\\notes\\a.md']);
    const first = useApp.getState().activeId as string;
    app.setContent(first, 'my unsaved edit');
    app.closeDoc(first);
    await app.openPaths(['c:/NOTES/a.md']);
    await app.reopenClosed();
    const docs = useApp.getState().docs;
    expect(docs.filter((d) => d.path)).toHaveLength(1);
    const copy = docs.find((d) => !d.path);
    expect(copy?.content).toBe('my unsaved edit');
    expect(useApp.getState().closed).toHaveLength(0);
  });

  it('keeps the closed record when reopening fails', async () => {
    vi.spyOn(platform, 'storeSet').mockResolvedValue();
    useApp.setState({
      closed: [{ path: 'C:\\gone.md', name: 'gone.md', kind: 'markdown', mode: 'read', encoding: 'UTF-8', bom: false, closedAt: Date.now() }],
    });
    vi.spyOn(platform, 'readFile').mockRejectedValue(new Error('NOTFOUND: gone'));
    await useApp.getState().reopenClosed();
    expect(useApp.getState().closed).toHaveLength(1);
  });

  it('caps closed-tab history by size but always keeps the newest', () => {
    const big = 'x'.repeat(3 * 1024 * 1024);
    const entries = [1, 2, 3, 4].map((n) => ({ path: null, name: `n${n}`, kind: 'markdown' as const, mode: 'edit' as const, encoding: 'UTF-8', bom: false, content: big, closedAt: n }));
    const kept = trimClosed(entries);
    expect(kept.map((c) => c.name)).toEqual(['n4']);
    const huge = [{ ...entries[0], content: 'y'.repeat(20 * 1024 * 1024) }];
    expect(trimClosed(huge)).toHaveLength(1);
  });
});

describe('startup survives damaged or unreadable state', () => {
  beforeEach(() => {
    vi.spyOn(platform, 'storeSet').mockResolvedValue();
    vi.spyOn(platform, 'draftWrite').mockResolvedValue();
    vi.spyOn(platform, 'draftDelete').mockResolvedValue();
    vi.spyOn(platform, 'watchFile').mockResolvedValue();
    reset();
  });
  afterEach(() => vi.restoreAllMocks());

  it('restores healthy tabs when one draft record is malformed', async () => {
    vi.spyOn(platform, 'storeGet').mockImplementation(async (key: string) =>
      key === 'session'
        ? ({ version: 2, tabs: [{ id: 'good', path: null, name: 'x', mode: 'edit', kind: 'markdown', scroll: 0, encoding: 'UTF-8' }, { id: 'bad', path: 'C:\\b.md' }, null], activeId: 'good' } as never)
        : null,
    );
    vi.spyOn(platform, 'draftList').mockResolvedValue({
      drafts: [
        { id: 'good', path: null, name: 'x', content: 'kept', mode: 'edit', kind: 'markdown', encoding: 'UTF-8', bom: false, updatedAt: 1 },
        { id: 'bad', path: 'C:\\b.md' } as never,
      ],
      quarantined: [],
    });
    vi.spyOn(platform, 'readFile').mockResolvedValue(file('C:\\b.md', 'b on disk'));
    await expect(useApp.getState().init()).resolves.toBeUndefined();
    const docs = useApp.getState().docs;
    expect(docs.find((d) => d.id === 'good')?.content).toBe('kept');
    expect(docs.find((d) => d.id === 'bad')?.content).toBe('b on disk');
  });

  it('treats an unreadable file as unreadable, not deleted, and never autosaves it', async () => {
    vi.spyOn(platform, 'storeGet').mockImplementation(async (key: string) =>
      key === 'session'
        ? ({ version: 2, tabs: [{ id: 'f', path: 'C:\\locked.md', name: 'locked.md', mode: 'edit', kind: 'markdown', scroll: 0, encoding: 'UTF-8' }], activeId: 'f' } as never)
        : null,
    );
    vi.spyOn(platform, 'draftList').mockResolvedValue({
      drafts: [{ id: 'f', path: 'C:\\locked.md', name: 'locked.md', content: 'draft', savedHash: 'x', mode: 'edit', kind: 'markdown', encoding: 'UTF-8', bom: false, updatedAt: 1 }],
      quarantined: [],
    });
    vi.spyOn(platform, 'readFile').mockRejectedValue(new Error('Couldn\'t open C:\\locked.md: access was denied.'));
    await useApp.getState().init();
    const doc = useApp.getState().docs[0];
    expect(doc).toMatchObject({ content: 'draft', missing: false });
    expect(doc.diskError).toContain('access was denied');
    expect(canAutosave(doc)).toBe(false);
  });

  it('keeps only one writable tab per file when the session lists it twice', async () => {
    vi.spyOn(platform, 'storeGet').mockImplementation(async (key: string) =>
      key === 'session'
        ? ({ version: 2, tabs: [
            { id: 'a', path: 'C:\\n.md', name: 'n.md', mode: 'edit', kind: 'markdown', scroll: 0, encoding: 'UTF-8' },
            { id: 'b', path: 'c:/N.md', name: 'n.md', mode: 'edit', kind: 'markdown', scroll: 0, encoding: 'UTF-8' },
          ], activeId: 'a' } as never)
        : null,
    );
    vi.spyOn(platform, 'draftList').mockResolvedValue({
      drafts: [{ id: 'b', path: 'c:/N.md', name: 'n.md', content: 'other edit', savedHash: 'x', mode: 'edit', kind: 'markdown', encoding: 'UTF-8', bom: false, updatedAt: 1 }],
      quarantined: [],
    });
    vi.spyOn(platform, 'readFile').mockResolvedValue(file('C:\\n.md', 'disk'));
    await useApp.getState().init();
    const docs = useApp.getState().docs;
    expect(docs.filter((d) => d.path)).toHaveLength(1);
    expect(docs.find((d) => !d.path)?.content).toBe('other edit');
  });

  it('cleans draft records field by field', () => {
    expect(cleanDraft({ id: 'x' })).toBeNull();
    expect(cleanDraft(null)).toBeNull();
    expect(cleanDraft({ id: 'x', content: 'a', mode: 'weird', kind: 7, eol: 'nope' })).toMatchObject({ mode: 'edit', kind: 'markdown', eol: undefined });
  });
});

describe('saving checks the file on disk first', () => {
  beforeEach(() => {
    vi.spyOn(platform, 'storeSet').mockResolvedValue();
    vi.spyOn(platform, 'watchFile').mockResolvedValue();
    reset();
  });
  afterEach(() => vi.restoreAllMocks());

  it('passes the version it read, and a refused save marks a conflict without writing', async () => {
    vi.spyOn(platform, 'readFile').mockResolvedValue(file('C:\\c.md', 'v1', { version: '2:100' }));
    const write = vi.spyOn(platform, 'writeFile').mockRejectedValue(new Error('CONFLICT: c.md changed on disk'));
    const app = useApp.getState();
    await app.openPaths(['C:\\c.md']);
    const id = useApp.getState().activeId as string;
    app.setContent(id, 'mine');
    await expect(app.save(id)).resolves.toBe(false);
    expect(write).toHaveBeenCalledWith('C:\\c.md', expect.stringMatching(/^mine\s*$/), expect.anything(), { expected: '2:100', force: undefined });
    expect(useApp.getState().docs[0]).toMatchObject({ conflict: true, content: 'mine' });
    expect(canAutosave(useApp.getState().docs[0])).toBe(false);
  });

  it('Keep mine overwrites only when asked', async () => {
    vi.spyOn(platform, 'readFile').mockResolvedValue(file('C:\\c.md', 'v1'));
    const write = vi.spyOn(platform, 'writeFile').mockResolvedValue({ mtimeMs: 5, version: '4:5' });
    const app = useApp.getState();
    await app.openPaths(['C:\\c.md']);
    const id = useApp.getState().activeId as string;
    app.setContent(id, 'mine');
    await app.resolveConflict(id, 'overwrite');
    expect(write).toHaveBeenLastCalledWith('C:\\c.md', expect.stringMatching(/^mine\s*$/), expect.anything(), expect.objectContaining({ force: true }));
    expect(useApp.getState().docs[0]).toMatchObject({ saved: expect.stringMatching(/^mine/), version: '4:5', conflict: false });
  });

  it('Use the file\'s keeps your text in closed tabs', async () => {
    const read = vi.spyOn(platform, 'readFile').mockResolvedValueOnce(file('C:\\c.md', 'v1')).mockResolvedValue(file('C:\\c.md', 'theirs', { version: '6:9' }));
    const app = useApp.getState();
    await app.openPaths(['C:\\c.md']);
    const id = useApp.getState().activeId as string;
    app.setContent(id, 'mine');
    await app.resolveConflict(id, 'disk');
    expect(read).toHaveBeenCalledTimes(2);
    expect(useApp.getState().docs[0]).toMatchObject({ content: 'theirs', saved: 'theirs', version: '6:9' });
    expect(useApp.getState().closed.slice(-1)[0]).toMatchObject({ content: 'mine', path: null });
  });

  it('a missing file is recreated, but one that reappeared is not overwritten unseen', async () => {
    vi.spyOn(platform, 'readFile').mockResolvedValue(file('C:\\c.md', 'v1'));
    const write = vi.spyOn(platform, 'writeFile').mockResolvedValue({ mtimeMs: 5, version: '4:5' });
    const app = useApp.getState();
    await app.openPaths(['C:\\c.md']);
    const id = useApp.getState().activeId as string;
    useApp.setState((s) => ({ docs: s.docs.map((d) => ({ ...d, missing: true, version: null })) }));
    await app.save(id);
    expect(write).toHaveBeenCalledWith('C:\\c.md', expect.stringMatching(/^v1\s*$/), expect.anything(), expect.objectContaining({ expected: 'absent' }));
  });

  it('autosaves a background tab, not only the active one', async () => {
    vi.useFakeTimers();
    try {
      useSettings.setState((s) => ({ settings: { ...s.settings, autoSave: 'delay', autoSaveDelay: 1 } }));
      vi.spyOn(platform, 'readFile').mockImplementation(async (p) => file(p, `text of ${p}`));
      const write = vi.spyOn(platform, 'writeFile').mockResolvedValue({ mtimeMs: 5, version: '1:5' });
      vi.spyOn(platform, 'draftWrite').mockResolvedValue();
      vi.spyOn(platform, 'draftList').mockResolvedValue({ drafts: [], quarantined: [] });
      vi.spyOn(platform, 'storeGet').mockResolvedValue(null);
      await useApp.getState().init();
      const app = useApp.getState();
      await app.openPaths(['C:\\one.md', 'C:\\two.md']);
      const [one, two] = useApp.getState().docs.filter((d) => d.path);
      app.activate(one.id);
      app.setContent(one.id, 'edited one');
      app.activate(two.id);
      await vi.advanceTimersByTimeAsync(1500);
      expect(write).toHaveBeenCalledWith('C:\\one.md', expect.stringMatching(/^edited one\s*$/), expect.anything(), expect.anything());
    } finally {
      useSettings.setState((s) => ({ settings: { ...s.settings, autoSave: 'off' } }));
      vi.useRealTimers();
    }
  });
});

describe('markdown written back by the editor', () => {
  it('leaves escaped brackets inside code fences alone', () => {
    const md = '```md\n\\[toc]\n> \\[!NOTE]\n```\n\n\\[toc]\n\n> \\[!NOTE]\n> hi';
    expect(fromEditor(md)).toBe('```md\n\\[toc]\n> \\[!NOTE]\n```\n\n[toc]\n\n> [!NOTE]\n> hi');
  });

  it('agrees with Read on front matter', () => {
    expect(splitFrontMatter('---\ntitle: x\n...\nbody').raw).toBe('---\ntitle: x\n...\n');
    expect(splitFrontMatter('---\ntitle: x\n---\r\nbody')).toEqual({ raw: '---\ntitle: x\n---\r\n', body: 'body' });
    // A horizontal rule followed by prose is not front matter.
    expect(splitFrontMatter('---\nJust a paragraph\n---\nmore').raw).toBe('');
    expect(splitFrontMatter('no front matter').raw).toBe('');
  });

  it('turns inline pasted images into files once a note is saved', () => {
    const png = btoa('PNGDATA');
    const { text, images } = extractDataImages(`a ![shot](data:image/png;base64,${png} "t") b\n\`\`\`\n![x](data:image/png;base64,${png})\n\`\`\``, 'assets');
    expect(images).toHaveLength(1);
    expect(images[0].path).toMatch(/^assets\/image-[a-z0-9]+\.png$/);
    expect(new TextDecoder().decode(images[0].bytes)).toBe('PNGDATA');
    expect(text.startsWith(`a ![shot](${images[0].path} "t") b`)).toBe(true);
    expect(text).toContain('![x](data:image/png;base64,'); // code block untouched
  });
});

describe('path identity', () => {
  it('treats Windows spellings of one path as the same file', () => {
    expect(pathKey('C:\\Notes\\A.md')).toBe(pathKey('c:/notes/a.md'));
    expect(pathKey('C:\\Notes\\.\\A.md')).toBe(pathKey('C:\\Notes\\A.md'));
    expect(pathKey('\\\\?\\C:\\Notes\\A.md')).toBe(pathKey('C:\\Notes\\A.md'));
    expect(pathKey('\\\\server\\share\\a.md')).toBe('\\\\server\\share\\a.md');
    expect(pathKey('C:\\Notes\\A.md')).not.toBe(pathKey('C:\\Notes\\B.md'));
  });
});
