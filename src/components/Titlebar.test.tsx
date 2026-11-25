// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestClose } from '../lib/commands';
import { useApp, type Doc } from '../lib/store';
import { Titlebar } from './Titlebar';

vi.mock('../lib/commands', () => ({
  requestClose: vi.fn(),
  requestQuit: vi.fn(),
  runCommand: vi.fn(),
  setMode: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout or element scrolling. Scrolling is checked in a real browser, not here.
Element.prototype.scrollTo ??= function scrollTo() {};

/** A minimal open note. Only the fields the title bar reads matter here. */
function note(id: string, content: string): Doc {
  return {
    id,
    path: null,
    name: 'Untitled.md',
    content,
    saved: content,
    mtimeMs: 0,
    mode: 'edit',
    kind: 'markdown',
    encoding: 'UTF-8',
    bom: false,
    diskEncoding: 'UTF-8',
    diskBom: false,
    eol: '\n',
    rev: 0,
    scroll: 0,
    readonly: false,
    binary: false,
    conflict: false,
    missing: false,
    version: null,
    diskError: null,
  } as unknown as Doc;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.mocked(requestClose).mockClear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useApp.setState({ docs: [note('a', '# A'), note('b', '# B'), note('c', '# C')], activeId: 'b' });
  act(() => root.render(<Titlebar />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const tabs = () => [...host.querySelectorAll<HTMLElement>('[role="tab"]')];
const press = (el: HTMLElement, key: string) => act(() => void el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
const activeId = () => useApp.getState().activeId;

describe('Titlebar tab strip', () => {
  it('is a tablist of tabs, with only the active tab selected and in the Tab order', () => {
    expect(host.querySelector('[role="tablist"]')).not.toBeNull();
    expect(tabs().map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    expect(tabs().map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
  });

  it('keeps the new-note button outside the tablist, so it is never scrolled or covered by tabs', () => {
    const plus = host.querySelector('.tab-new');
    expect(plus).not.toBeNull();
    expect(host.querySelector('[role="tablist"]')?.contains(plus)).toBe(false);
  });

  it('moves focus with the arrow keys and Home/End, wrapping at the ends, and activates the tab it lands on', () => {
    act(() => tabs()[1].focus());
    press(tabs()[1], 'ArrowRight');
    expect(document.activeElement).toBe(tabs()[2]);
    expect(activeId()).toBe('c');

    press(tabs()[2], 'ArrowRight');
    expect(document.activeElement).toBe(tabs()[0]);
    expect(activeId()).toBe('a');

    press(tabs()[0], 'ArrowLeft');
    expect(document.activeElement).toBe(tabs()[2]);
    expect(activeId()).toBe('c');

    press(tabs()[2], 'Home');
    expect(document.activeElement).toBe(tabs()[0]);
    expect(activeId()).toBe('a');

    press(tabs()[0], 'End');
    expect(document.activeElement).toBe(tabs()[2]);
    expect(activeId()).toBe('c');
  });

  it('keeps the roving Tab stop on the active tab after keyboard moves', () => {
    act(() => tabs()[1].focus());
    press(tabs()[1], 'ArrowRight');
    expect(tabs().map((t) => t.tabIndex)).toEqual([-1, -1, 0]);
    expect(tabs().map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true']);
  });

  it('Enter and Space activate the focused tab', () => {
    act(() => tabs()[0].focus());
    press(tabs()[0], 'Enter');
    expect(activeId()).toBe('a');

    act(() => tabs()[2].focus());
    press(tabs()[2], ' ');
    expect(activeId()).toBe('c');
  });

  it('Delete closes the focused tab through requestClose', () => {
    act(() => tabs()[0].focus());
    press(tabs()[0], 'Delete');
    expect(requestClose).toHaveBeenCalledWith('a');
  });

  it('middle click closes a tab', () => {
    act(() => void tabs()[2].dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true })));
    expect(requestClose).toHaveBeenCalledWith('c');
  });

  it('the close button closes its own tab without activating it', () => {
    const close = tabs()[0].querySelector<HTMLButtonElement>('.tab-close');
    expect(close).not.toBeNull();
    act(() => close?.click());
    expect(requestClose).toHaveBeenCalledWith('a');
    expect(activeId()).toBe('b');
  });

  it('names an unsaved tab as unsaved', () => {
    const edited = { ...note('b', '# B'), content: '# B edited' } as Doc;
    act(() => useApp.setState({ docs: [note('a', '# A'), edited, note('c', '# C')] }));
    expect(tabs()[1].getAttribute('aria-label')).toBe('B edited, unsaved');
    expect(tabs()[0].getAttribute('aria-label')).toBe('A');
  });
});
