// Real WebView2 tests. Build with tools/e2e/tauri.test.json to isolate the installed app.
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createHarness } from './harness.mjs';

const { dir, launch, kill, fresh, verify, dispose, running, count } = createHarness('margin-real-');

const file = path.join(dir, 'notes.md');
const second = path.join(dir, 'second.md');
const ansi = path.join(dir, 'ansi.txt');
const ORIGINAL =
  '---\r\ntitle: Test\r\n---\r\n\r\nSetext Title\r\n============\r\n\r\nA paragraph with a [ref link][r] and *  odd   spacing*.\r\n\r\n* star bullet\r\n* another\r\n\r\n- [ ] task one\r\n- [x] task two\r\n\r\n$$E = mc^2$$\r\n\r\n[r]: https://example.com\r\n';
// "café # not a heading" etc. in Windows-1252 with CRLF.
const ANSI = Buffer.from('caf\xe9 costs 5 \x80\r\n# not a heading\r\n* stars *\r\n', 'latin1');
fs.writeFileSync(file, ORIGINAL);
fs.writeFileSync(second, '# Second file\n\nHello.\n');
fs.writeFileSync(ansi, ANSI);

const results = [];
const ok = (name, pass, extra = '') => {
  results.push((pass ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  [' + extra + ']' : ''));
  console.log(results[results.length - 1]);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const connect = async () => {
  for (let i = 0; i < 80; i++) {
    try {
      const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
      const page = b
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().includes('tauri.localhost') || p.url().startsWith('tauri:'));
      if (page) {
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
        await page.waitForSelector('.app', { timeout: 15000 });
        await sleep(500);
        await verify(page);
        return { b, page };
      }
      await b.close();
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('could not attach to the app');
};
const tabNames = (page) => page.locator('.tab-name').allTextContents();
const activeName = (page) => page.textContent('.tab[data-active="true"] .tab-name');
/** Polls the tab strip (tabs animate in and out) until `test(names)` holds or 1.5 s pass. */
const tabsSettle = async (page, test) => {
  let names = [];
  for (let i = 0; i < 15; i++) {
    names = await tabNames(page);
    if (test(names)) return { pass: true, names };
    await sleep(100);
  }
  return { pass: false, names };
};

try {
  fresh();

  const t0 = Date.now();
  const mainProcess = launch([file]);
  let { b, page } = await connect();
  await page.waitForSelector('.prose.reader', { timeout: 15000 });
  ok('cold start to rendered document', true, Date.now() - t0 + ' ms including attach');
  ok('opens the file given on the command line', (await activeName(page)) === 'notes.md');
  ok('front matter hidden, setext heading rendered', (await page.textContent('.prose.reader h1')).trim() === 'Setext Title');
  ok('math rendered', (await page.locator('.prose.reader .katex').count()) > 0);
  ok('window title says Margin', (await page.title()).endsWith('- Margin'), await page.title());

  const closeHitArea = () => page.locator('.wc-close').evaluate((el) =>
    el.contains(document.elementFromPoint(window.innerWidth - 1, 0)) &&
    el.contains(document.elementFromPoint(window.innerWidth - 1, 12))
  );
  ok('Close reaches the first row and last column of the restored window', await closeHitArea());
  const nativeCaption = JSON.parse(execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.resolve('tools/e2e/caption-hit.ps1'), '-AppProcessId', String(mainProcess.pid),
  ], { encoding: 'utf8', windowsHide: true }));
  ok('native resize strip passes the Close corner through and still resizes elsewhere',
    nativeCaption.close === -1 && nativeCaption.resize === 12, JSON.stringify(nativeCaption));
  await page.getByRole('button', { name: 'Maximise', exact: true }).click();
  await page.getByRole('button', { name: 'Restore', exact: true }).waitFor();
  ok('Close reaches the first row and last column when maximized', await closeHitArea());
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await page.getByRole('button', { name: 'Maximise', exact: true }).waitFor();
  const mainMenu = page.getByRole('button', { name: 'Menu', exact: true });
  await mainMenu.click();
  await page.getByRole('menuitem', { name: 'Open file…' }).hover({ timeout: 3000 });
  ok('the main menu opens over the document and accepts pointer input', true);
  await mainMenu.click();
  ok('clicking the menu trigger again dismisses it', (await mainMenu.getAttribute('aria-expanded')) === 'false');

  const sourceRadio = page.getByRole('radio', { name: 'Source', exact: true });
  const readRadio = page.getByRole('radio', { name: 'Read', exact: true });
  const visibleEditor = () => page.locator('.doc-stage[data-visible] .prose.editor[data-ready]');
  const openEditFromSource = async () => {
    await page.locator('.doc-stage[data-visible] .source .cm-content').waitFor();
    const editRadio = page.getByRole('radio', { name: 'Edit', exact: true });
    await editRadio.evaluate((button) => {
      button.addEventListener('click', () => {
        const start = performance.now();
        let blankFrames = 0;
        window.marginSwitch = new Promise((resolve) => {
          const frame = () => {
            const editor = document.querySelector('.doc-stage[data-visible] .prose.editor[data-ready]');
            const elapsed = performance.now() - start;
            if (editor || elapsed > 5000) {
              resolve({ blankFrames, elapsed: Math.round(elapsed), focused: !!editor?.contains(document.activeElement) });
              return;
            }
            if (!document.querySelector('.doc-stage[data-visible] .source .cm-content')) blankFrames++;
            requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
        });
      }, { capture: true, once: true });
    });
    await editRadio.click();
    const result = await page.evaluate(() => window.marginSwitch);
    await visibleEditor().waitFor();
    return result;
  };
  await sourceRadio.click();
  const cold = await openEditFromSource();
  ok('first Source to Edit switch keeps the document visible and focuses the editor', cold.blankFrames === 0 && cold.focused, JSON.stringify(cold));
  await visibleEditor().evaluate((node) => { window.marginOriginalEditor = node.querySelector('.ProseMirror'); });
  await sourceRadio.click();
  const warm = await openEditFromSource();
  ok('switching back from unchanged Source reuses the existing rich editor',
    warm.blankFrames === 0 && warm.focused &&
      await visibleEditor().evaluate((node) => node.querySelector('.ProseMirror') === window.marginOriginalEditor), JSON.stringify(warm));
  await readRadio.click();
  await page.locator('.prose.reader').waitFor();

  // 1. visiting Edit and Source must not touch the file
  await page.keyboard.press('Control+e');
  await page.waitForSelector('.prose.editor[data-ready]');
  await sleep(900);
  await page.keyboard.press('Control+/');
  await sleep(600);
  await page.keyboard.press('Control+e');
  await page.waitForSelector('.prose.reader');
  await sleep(400);
  ok('file untouched after visiting Edit and Source', fs.readFileSync(file, 'utf8') === ORIGINAL);
  await page.keyboard.press('Control+s');
  await sleep(300);
  ok('Ctrl+S with no edits writes nothing', fs.readFileSync(file, 'utf8') === ORIGINAL);

  // 2. task checkbox in reading mode: one character changes
  await page.click('.prose.reader input.task-checkbox >> nth=0');
  await sleep(300);
  await page.keyboard.press('Control+s');
  await sleep(500);
  ok('task tick changed only that character', fs.readFileSync(file, 'utf8') === ORIGINAL.replace('- [ ] task one', '- [x] task one'));

  // 3. real edit in the WYSIWYG editor, caret position, then save
  await page.keyboard.press('Control+e');
  await page.waitForSelector('.prose.editor[data-ready]');
  await sleep(700);
  await page.click('.ProseMirror p >> nth=0');
  // A new paragraph: typing straight after italic text continues the italics (as in Word),
  // and this paragraph deliberately ends in odd emphasis. See tools/e2e/probe-marks.mjs.
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Typed with **bold** and ~strike~.', { delay: 15 });
  await sleep(900);
  const caret = await page.evaluate(() => {
    const c = document.querySelector('.smooth-caret');
    const sel = document.getSelection();
    if (!c || !sel?.rangeCount) return null;
    const r = sel.getRangeAt(0).getClientRects();
    const target = r[r.length - 1];
    const cr = c.getBoundingClientRect();
    return { caret: cr.left + cr.width / 2, text: target?.left ?? NaN, visible: c.dataset.visible };
  });
  const caretOff = caret ? Math.abs(caret.caret - caret.text) : NaN;
  ok('gliding caret sits on the insertion point (within 1.5 px)', caret?.visible === 'true' && caretOff <= 1.5, caret ? caretOff.toFixed(2) + ' px off' : 'no caret');
  const snapped = await page.evaluate(() => ({
    strong: !!document.querySelector('.ProseMirror strong'),
    del: !!document.querySelector('.ProseMirror del'),
    html: document.querySelector('.ProseMirror p')?.innerHTML.slice(-160) ?? '',
  }));
  await page.screenshot({ path: path.join(dir, 'shot-edit.png') });
  ok('**bold** and ~strike~ snap', snapped.strong && snapped.del, snapped.strong && snapped.del ? '' : snapped.html);
  await page.keyboard.press('Control+s');
  await sleep(700);
  const edited = fs.readFileSync(file, 'utf8');
  ok('saved file contains the edit', edited.includes('**bold**') && edited.includes('~~strike~~'));
  ok('front matter and CRLF kept', edited.startsWith('---\r\ntitle: Test\r\n---\r\n') && !/[^\r]\n/.test(edited));
  ok('display math survived', /\$\$\r\nE = mc\^2\r\n\$\$/.test(edited));

  // 4. external change while clean -> auto reload
  await page.keyboard.press('Control+e');
  await sleep(500);
  fs.writeFileSync(file, edited + '\r\nAppended by another program.\r\n');
  let reloaded = false;
  for (let i = 0; i < 30 && !reloaded; i++) {
    await sleep(200);
    reloaded = (await page.textContent('.prose.reader')).includes('Appended by another program');
  }
  ok('reloads when the file changes on disk', reloaded);

  // 5. second launch hands its file to the running window; a .txt opens as plain text
  launch([second]);
  launch([ansi]);
  let got = false;
  for (let i = 0; i < 40 && !got; i++) {
    await sleep(200);
    const names = await tabNames(page);
    got = names.includes('second.md') && names.includes('ansi.txt');
  }
  ok('second and third launches open as tabs in the same window', got);
  const procs = count();
  ok('only one app process', procs === 1, procs + ' processes');

  await page.click('.tab:has-text("ansi.txt")');
  await page.waitForSelector('.doc-scroller[data-plain] .cm-content');
  await sleep(300);
  const plainText = await page.textContent('.doc-scroller[data-plain] .cm-content');
  ok('.txt opens as plain text, literally', plainText.includes('# not a heading') && plainText.includes('* stars *'));
  await page.screenshot({ path: path.join(dir, 'shot-plain.png') });
  ok('Windows-1252 decoded', plainText.includes('café costs 5 €'));
  ok('status bar shows ANSI and CRLF', (await page.textContent('.statusbar')).includes('ANSI (Windows-1252)') && (await page.textContent('.statusbar')).includes('Windows (CRLF)'));
  await page.click('.doc-scroller[data-plain] .cm-content');
  await page.keyboard.press('Control+End');
  await page.keyboard.type('!');
  await page.keyboard.press('Control+s');
  await sleep(600);
  const ansiAfter = fs.readFileSync(ansi);
  ok('plain text saved back byte-identical in Windows-1252 + CRLF', ansiAfter.equals(Buffer.concat([ANSI, Buffer.from('!')])), ansiAfter.toString('latin1').replace(/\r/g, '\\r').replace(/\n/g, '\\n'));

  // 6. HOT EXIT: an untitled note and an edited file survive a hard kill
  await page.keyboard.press('Control+n');
  await page.waitForSelector('.prose.editor[data-ready]');
  await sleep(500);
  const focusAfterNew = await page.evaluate(() => document.activeElement?.className ?? '');
  await page.keyboard.type('Hot exit note 123', { delay: 10 });
  ok('Ctrl+N focuses the new note', focusAfterNew.includes('ProseMirror'), focusAfterNew.slice(0, 60));
  // Switch away at once: the last keystrokes must not be lost to the editor's reporting pause.
  await page.click('.tab:has-text("second.md")');
  const kept = await tabsSettle(page, (n) => n.includes('Hot exit note 123'));
  ok('switching tabs right after typing keeps every keystroke', kept.pass, kept.names.join(', '));
  await page.keyboard.press('Control+/');
  await page.waitForSelector('.doc-scroller .cm-content');
  await page.click('.doc-scroller .cm-content');
  await page.keyboard.press('Control+End');
  await page.keyboard.type('Unsaved line.', { delay: 10 });
  const secondOnDisk = fs.readFileSync(second, 'utf8');
  await sleep(1600);
  await b.close();
  kill();
  await sleep(800);
  launch([]);
  ({ b, page } = await connect());
  let names = await tabNames(page);
  ok('after a hard kill, every tab is back', ['notes.md', 'second.md', 'ansi.txt', 'Hot exit note 123'].every((n) => names.includes(n)), names.join(', '));
  await page.click('.tab:has-text("Hot exit note 123")');
  await sleep(500);
  ok('the untitled note kept its text', (await page.textContent('.doc-view')).includes('Hot exit note 123'));
  ok('the edited file is restored as unsaved', (await page.getAttribute('.tab:has-text("second.md")', 'data-dirty')) === 'true');
  ok('the file on disk was not touched', fs.readFileSync(second, 'utf8') === secondOnDisk);

  // 7. closing the window normally never asks, and everything comes back
  await page.mouse.click(await page.evaluate(() => window.innerWidth - 1), 0);
  let exited = false;
  for (let i = 0; i < 30 && !exited; i++) {
    await sleep(200);
    exited = !running();
  }
  ok('closing the window with unsaved notes exits without a dialog', exited);
  await b.close().catch(() => undefined);
  launch([]);
  ({ b, page } = await connect());
  names = await tabNames(page);
  ok('after a normal close, every tab is back', names.includes('Hot exit note 123') && names.includes('second.md'), names.join(', '));

  // 8. closing one unsaved tab asks; "Don't save" can be undone with Ctrl+Shift+T
  await page.click('.tab:has-text("Hot exit note 123")');
  await sleep(300);
  await page.keyboard.press('Control+w');
  await sleep(400);
  ok('closing an unsaved tab asks first', (await page.locator('[role="alertdialog"]').count()) === 1);
  await page.click('[role="alertdialog"] button:has-text("Don\'t save")');
  const gone = await tabsSettle(page, (n) => !n.includes('Hot exit note 123'));
  ok('"Don\'t save" closes the tab', gone.pass, gone.names.join(', '));
  await page.keyboard.press('Control+Shift+T');
  const back = await tabsSettle(page, (n) => n.includes('Hot exit note 123'));
  await sleep(400);
  ok('Ctrl+Shift+T brings it back with its text', back.pass && (await page.textContent('.doc-view')).includes('Hot exit note 123'));

  // 9. a file changed while Margin was closed, with a draft pending: conflict offered, draft shown
  await page.click('.tab:has-text("second.md")');
  await sleep(1600);
  await b.close();
  kill();
  fs.writeFileSync(second, '# Second file\n\nChanged while closed.\n');
  launch([]);
  ({ b, page } = await connect());
  await sleep(800);
  ok('conflict is offered, not silently resolved', (await page.textContent('.toasts, body')).includes('changed while Margin was closed'));
  await page.click('.tab:has-text("second.md")');
  await sleep(400);
  ok('the unsaved version is what shows', (await page.textContent('.doc-view')).includes('Unsaved line.'));

  // 10. Win+R `note` while open: a fresh blank note
  const before = (await tabNames(page)).length;
  launch([]);
  await sleep(1500);
  ok('a second empty launch gives a blank note', (await tabNames(page)).length === before + 1);

  // 11. Ctrl+1..9 switch tabs
  await page.keyboard.press('Control+1');
  await sleep(200);
  ok('Ctrl+1 goes to the first tab', (await activeName(page)) === (await tabNames(page))[0]);

  // File format menus and disk bytes.
  const format = path.join(dir, 'format.txt');
  fs.writeFileSync(format, 'first\r\nmatch\r\nlast\r\n');
  launch([format]);
  await page.locator('.tab[data-active] .tab-name').filter({ hasText: 'format.txt' }).waitFor();
  await page.locator('.cm-content').waitFor();
  await page.keyboard.press('Control+h');
  await page.getByPlaceholder('Find', { exact: true }).fill('match');
  await page.getByPlaceholder('Replace with').fill('updated');
  await page.getByRole('button', { name: 'Replace', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+s');
  await sleep(500);
  ok('Replace edits the right text in a CRLF file', fs.readFileSync(format, 'utf8') === 'first\r\nupdated\r\nlast\r\n');

  let endings = page.locator('button[data-tip="Line endings"]');
  let encoding = page.locator('button[data-tip^="Encoding"]');
  await endings.click();
  await page.getByRole('menuitem', { name: 'Classic Mac (CR)', exact: true }).click();
  ok('line-ending menu opens above the status bar and updates the label', (await endings.textContent()).trim() === 'Classic Mac (CR)');
  await encoding.click();
  await page.getByRole('menuitem', { name: 'Save as UTF-16 LE', exact: true }).click();
  await page.keyboard.press('Control+s');
  await sleep(500);
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('first\rupdated\rlast\r', 'utf16le')]);
  ok('encoding and line-ending choices are written to disk exactly', fs.readFileSync(format).equals(utf16));
  await encoding.click();
  await page.getByRole('menuitem', { name: 'Save as UTF-8 with BOM', exact: true }).click();
  await page.locator('.wc-close').click();
  await sleep(850);
  await b.close().catch(() => undefined);
  launch([]);
  ({ b, page } = await connect());
  endings = page.locator('button[data-tip="Line endings"]');
  encoding = page.locator('button[data-tip^="Encoding"]');
  ok('pending encoding conversion survives normal exit without changing the original bytes', (await encoding.textContent()).trim() === 'UTF-8 with BOM' && fs.readFileSync(format).equals(utf16));
  await page.keyboard.press('Control+s');
  await sleep(500);
  const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('first\rupdated\rlast\r')]);
  ok('saving the restored conversion writes UTF-8 BOM and retains CR', fs.readFileSync(format).equals(utf8));
  await encoding.click();
  await page.getByRole('menuitem', { name: 'Reopen as ANSI (Windows-1252)', exact: true }).click();
  await sleep(300);
  ok('reopening in a different encoding rereads the file without rewriting it', (await encoding.textContent()).trim() === 'ANSI (Windows-1252)' && fs.readFileSync(format).equals(utf8));

  await page.keyboard.press('Control+Alt+n');
  await page.locator('.tab[data-active] .tab-name').filter({ hasText: 'Untitled' }).waitFor();
  await endings.click();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  ok('a blank note remembers a line-ending choice made by keyboard', (await endings.textContent()).trim() === 'Windows (CRLF)');
  await page.locator('.cm-content').fill('one');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await sleep(850);
  const { configDir } = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('app_info'));
  const drafts = fs.readdirSync(path.join(configDir, 'drafts')).filter((name) => name.endsWith('.json'));
  ok('the first line break in a blank note uses the chosen format', drafts.some((name) =>
    JSON.parse(fs.readFileSync(path.join(configDir, 'drafts', name), 'utf8')).content === 'one\r\ntwo'
  ));

  await page.keyboard.press('F11');
  await page.locator('.titlebar').waitFor({ state: 'hidden' });
  ok('focus mode hides the title and status bars', await page.locator('.statusbar').count() === 0);
  await page.keyboard.press('Escape');
  await page.locator('.wc-close').waitFor();
  ok('Escape restores the chrome after focus mode', await page.locator('.statusbar').isVisible());

  // Drive the WebView2 drop event from a disposable fixture and verify the application's handler.
  const imageNote = path.join(dir, 'images.md');
  fs.writeFileSync(imageNote, '# Image check\n');
  await page.evaluate(async (file) => {
    await window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {
      event: 'tauri://drag-drop',
      payload: { paths: [file], position: { x: 300, y: 200 } },
    });
  }, imageNote);
  await page.locator('.tab[data-active] .tab-name').filter({ hasText: 'images.md' }).waitFor();
  ok('a WebView drop event opens the actual file in a tab', true);

  const pasteImage = async () => {
    await page.locator('.ProseMirror').evaluate((editor) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 2;
      const uri = canvas.toDataURL('image/png');
      const bytes = Uint8Array.from(atob(uri.split(',')[1]), (char) => char.charCodeAt(0));
      const clipboardData = new DataTransfer();
      clipboardData.items.add(new File([bytes], 'paste.png', { type: 'image/png' }));
      editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
    });
  };
  await page.getByRole('radio', { name: 'Edit', exact: true }).click();
  await page.locator('.prose.editor[data-ready]').waitFor();
  await page.locator('.ProseMirror h1').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await pasteImage();
  await page.locator('.ProseMirror img').waitFor();
  await page.keyboard.press('Control+s');
  await sleep(700);
  const attachments = fs.readdirSync(path.join(dir, 'assets'));
  ok('pasting into a saved note writes an image beside the file', attachments.length === 1 && fs.readFileSync(imageNote, 'utf8').includes(attachments[0]));
  await page.evaluate(() => {
    window.print = () => {
      const root = document.getElementById('print-root');
      root.dataset.testPrint = root.querySelector('img')?.naturalWidth === 2 ? 'image-ready' : 'image-missing';
      window.dispatchEvent(new Event('afterprint'));
    };
  });
  await page.keyboard.press('Control+p');
  await page.locator('#print-root[data-test-print]').waitFor({ state: 'attached' });
  ok('print preparation renders the local image before opening the dialog', await page.locator('#print-root').getAttribute('data-test-print') === 'image-ready');

  await page.keyboard.press('Control+n');
  await page.locator('.tab[data-active] .tab-name').filter({ hasText: 'Untitled' }).waitFor();
  await page.locator('.prose.editor[data-ready]').waitFor();
  await page.locator('.ProseMirror').click();
  await pasteImage();
  await page.locator('.ProseMirror img').waitFor();
  await page.keyboard.press('Control+e');
  await page.locator('.reader img').waitFor();
  ok('pasting into an untitled note creates an image that survives switching to Read', await page.locator('.reader img').evaluate((img) => img.src.startsWith('data:image/png')));

  const switchNote = path.join(dir, 'switch.md');
  fs.copyFileSync(path.resolve('public/samples/long.md'), switchNote);
  launch([switchNote]);
  await page.locator('.tab[data-active="true"] .tab-name').filter({ hasText: 'switch.md' }).waitFor();
  await page.getByRole('radio', { name: 'Source', exact: true }).click();
  await page.locator('.doc-stage[data-visible] .source .cm-content').waitFor();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\n\nLatest source text goes straight into Edit.');
  const changed = await openEditFromSource();
  ok('edited Source stays visible until Edit is ready and the latest text survives on a long note',
    changed.blankFrames === 0 && changed.focused &&
      (await visibleEditor().textContent()).includes('Latest source text goes straight into Edit.'), JSON.stringify(changed));

  const worksheet = path.join(dir, 'worksheet.md');
  const photo = path.join(dir, 'assets', 'Photo #10.png');
  fs.copyFileSync(path.join(dir, 'assets', attachments[0]), photo);
  fs.writeFileSync(worksheet, [
    '# Equilibrium practice',
    '',
    '| Order | Whole question | Focus | Source |',
    '| --- | --- | --- | --- |',
    '| 1 | Translational Q3 · Two force diagrams | Decide whether each set of forces balances | [Photo 10](assets/Photo%20%2310.png) |',
    '',
    '[Absolute photo](' + pathToFileURL(photo).href + ')',
    '',
    '[Second note](second.md)',
    '',
    '[Plain text](ansi.txt)',
  ].join('\n'));
  launch([worksheet]);
  await page.locator('.tab[data-active="true"] .tab-name').filter({ hasText: 'worksheet.md' }).waitFor();
  await page.getByRole('radio', { name: 'Read', exact: true }).click();
  const table = page.locator('.reader table');
  await table.waitFor();
  const widthAtDefaultZoom = (await table.boundingBox()).width;
  const zoomOut = page.getByRole('button', { name: 'Zoom out', exact: true });
  for (let i = 0; i < 4; i++) await zoomOut.click();
  const layout = await table.evaluate((node) => {
    const pane = node.closest('.doc-scroller');
    const range = document.createRange();
    range.selectNodeContents(node.querySelector('tbody td:last-child a'));
    return {
      pane: pane.clientWidth,
      table: node.getBoundingClientRect().width,
      linkLines: range.getClientRects().length,
    };
  });
  ok('a worksheet table fills the reading pane at 60% zoom and its photo label fits on one line',
    (await page.locator('.zoom-value').textContent()).trim() === '60%' &&
      layout.table === widthAtDefaultZoom && layout.table / layout.pane > 0.85 && layout.linkLines === 1,
    JSON.stringify(layout));

  // Check the shell handoff independently of which apps this PC has set as defaults.
  await page.evaluate(() => {
    const fetch = window.fetch.bind(window);
    const opener = window.__TAURI_INTERNALS__.convertFileSrc('open_linked_file', 'ipc');
    window.marginLinkedPaths = [];
    window.fetch = async (url, options) => {
      if (url !== opener) return fetch(url, options);
      window.marginLinkedPaths.push(JSON.parse(options.body).path);
      return new Response('null', { headers: { 'Tauri-Response': 'ok', 'Content-Type': 'application/json' } });
    };
  });
  for (const [index, label] of ['Photo 10', 'Absolute photo', 'Second note', 'Plain text'].entries()) {
    await page.getByRole('link', { name: label, exact: true }).click();
    await page.waitForFunction((count) => window.marginLinkedPaths.length === count, index + 1);
  }
  const forwarded = await page.evaluate(() => window.marginLinkedPaths);
  ok('both photo links are resolved and sent to the Windows opener',
    forwarded.slice(0, 2).every((file) => path.normalize(file) === photo) && await page.locator('.lightbox').count() === 0);
  ok('Markdown and text file links also go through the default app handler',
    path.normalize(forwarded[2]) === second && path.normalize(forwarded[3]) === ansi &&
    (await activeName(page)) === 'worksheet.md');

  ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await b.close();
} catch (error) {
  ok('suite completed', false, error.message);
  throw error;
} finally {
  dispose();
  const passed = results.filter((r) => r.startsWith('PASS')).length;
  console.log('\n' + passed + '/' + results.length + ' passed; fixtures: ' + dir);
  if (passed !== results.length) process.exitCode = 1;
}
