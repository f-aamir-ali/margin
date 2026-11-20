// Real WebView2 tests. Build with tools/e2e/tauri.test.json to isolate the installed app.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

import { createHarness } from './harness.mjs';

const { dir, config, launch, fresh, verify, dispose } = createHarness('margin-probe-notepad-');

const py = path.join(dir, 'script.py');
fs.writeFileSync(py, 'import os\n\n\ndef greet(name: str) -> str:\n    """Say hello."""\n    return f"Hello {name}"  # comment\n\n\nprint(greet(os.getlogin()))\n');
const txt = path.join(dir, 'lines.txt');
fs.writeFileSync(txt, Array.from({ length: 200 }, (_, i) => `line ${i + 1} ` + 'word '.repeat(i % 7 === 0 ? 40 : 3)).join('\r\n'));
const bin = path.join(dir, 'blob.dat');
fs.writeFileSync(bin, Buffer.from([0x4d, 0x5a, 0x00, 0x00, 0x90, 0x00, 0xff, 0xfe, 0x00, 0x01]));
const log = path.join(dir, 'big.log');
const logLine = '2026-11-18 12:00:00.000 INFO  [worker-3] request handled in 12 ms path=/api/v1/items?id=12345\n';
const logLines = Math.ceil((20 * 1024 * 1024) / logLine.length);
fs.writeFileSync(log, logLine.repeat(logLines));

const results = [];
const ok = (name, pass, extra = '') => {
  results.push((pass ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  [' + extra + ']' : ''));
  console.log(results[results.length - 1]);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = async () => {
  for (let i = 0; i < 80; i++) {
    try {
      const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
      const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('tauri.localhost'));
      if (page) {
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
  throw new Error('could not attach');
};

try {
  fresh({});
  launch([py]);
  let { b, page } = await connect();
  await page.waitForSelector('.doc-scroller[data-plain] .cm-content');
  await sleep(1200); // the language loads lazily
  const colours = await page.evaluate(() => {
    const spans = [...document.querySelectorAll('.cm-content span')];
    return new Set(spans.map((s) => getComputedStyle(s).color)).size;
  });
  ok('a .py file opens as plain text with syntax colours', colours >= 3, colours + ' colours');
  ok('code files run full width', (await page.getAttribute('.doc-scroller', 'data-wide')) === 'true');
  await page.screenshot({ path: path.join(dir, 'code.png') });

  // Ctrl+G go to line
  launch([txt]);
  await page.waitForSelector('.tab:has-text("lines.txt")[data-active="true"]', { timeout: 8000 });
  await sleep(800);
  await page.click('.doc-scroller[data-plain] .cm-content');
  await page.keyboard.press('Control+g');
  await sleep(300);
  await page.keyboard.type('150');
  await page.keyboard.press('Enter');
  await sleep(500);
  ok('Ctrl+G 150 jumps to line 150', (await page.textContent('.statusbar')).includes('Ln 150'), (await page.textContent('.statusbar')).slice(0, 80));

  // F5 inserts the time and date
  const before = (await page.textContent('.cm-activeLine')) ?? '';
  await page.keyboard.press('Home');
  await page.keyboard.press('F5');
  await sleep(200);
  const after = (await page.textContent('.cm-activeLine')) ?? '';
  ok('F5 inserts the time and date', after.length > before.length && /\d/.test(after.slice(0, after.length - before.length)), after.slice(0, 40));
  await page.keyboard.press('Control+z');

  // Alt+Z toggles word wrap
  const wrapped = async () => (await page.locator('.cm-lineWrapping').count()) > 0;
  const w0 = await wrapped();
  await page.keyboard.press('Alt+z');
  await sleep(300);
  const w1 = await wrapped();
  await page.keyboard.press('Alt+z');
  await sleep(300);
  ok('Alt+Z toggles word wrap', w0 !== w1 && (await wrapped()) === w0, `${w0} -> ${w1}`);

  // A binary file asks first, then opens read-only
  launch([bin]);
  await sleep(1500);
  const body = await page.textContent('body');
  ok('a binary file asks before opening', body.includes('looks like a binary file'));
  await page.click('button:has-text("Open anyway")').catch(() => undefined);
  await sleep(800);
  ok('"Open anyway" opens it', (await page.locator('.tab-name').allTextContents()).includes('blob.dat'));

  // A 20 MB log opens quickly as plain text
  const t0 = Date.now();
  launch([log]);
  await page.waitForSelector('.tab:has-text("big.log")[data-active="true"] ', { timeout: 30000 });
  await page.waitForSelector('.doc-scroller[data-plain] .cm-content');
  const openMs = Date.now() - t0;
  ok('a 20 MB log opens in under 4 s', openMs < 4000, openMs + ' ms');
  await page.keyboard.press('Control+End');
  await sleep(500);
  const lastLine = `Ln ${new Intl.NumberFormat('en-CA').format(logLines + 1)}, Col 1`;
  const lineLabel = await page.locator('button[data-tip="Go to line"]').textContent();
  ok('Ctrl+End reaches the exact last line of the big log', lineLabel.trim() === lastLine, lineLabel);
  await b.close();

  // Theme screenshots
  for (const [mode, key, id] of [
    ['dark', 'darkTheme', 'ember'],
    ['light', 'lightTheme', 'linen'],
    ['dark', 'darkTheme', 'carbon'],
    ['light', 'lightTheme', 'paper'],
  ]) {
    fresh({ themeMode: mode, [key]: id });
    launch([py, path.resolve('public/samples/welcome.md')]);
    ({ b, page } = await connect());
    await page.waitForSelector('.prose.reader');
    await sleep(900);
    await page.screenshot({ path: path.join(dir, `theme-${id}.png`) });
    await page.click('.tab:has-text("script.py")');
    await sleep(900);
    await page.screenshot({ path: path.join(dir, `theme-${id}-code.png`) });
    await b.close();
  }
  ok('theme screenshots taken', true, dir);

  fresh({ autoSave: 'delay', autoSaveDelay: 1 });
  const auto = path.join(dir, 'autosave.txt');
  fs.writeFileSync(auto, 'Unchanged text');
  launch([auto]);
  ({ b, page } = await connect());
  await page.locator('button[data-tip^="Encoding"]').click();
  await page.getByRole('menuitem', { name: 'Save as UTF-8 with BOM', exact: true }).click();
  await sleep(1500);
  ok('delayed auto-save writes an encoding change without a text edit',
    fs.readFileSync(auto).equals(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Unchanged text')])));

  await page.keyboard.press('Control+Alt+n');
  await page.locator('.tab[data-active] .tab-name').filter({ hasText: 'Untitled' }).waitFor();
  await page.locator('.cm-content').fill('kept during a write failure');
  await sleep(1100);
  const draftDir = path.join(config, 'drafts');
  const draft = fs.readdirSync(draftDir).map((name) => path.join(draftDir, name)).find((file) =>
    file.endsWith('.json') && JSON.parse(fs.readFileSync(file, 'utf8')).content === 'kept during a write failure');
  if (!draft) throw new Error('Could not find the test draft');
  const backup = draft + '.fixture-backup';
  fs.renameSync(draft, backup);
  fs.mkdirSync(draft);
  try {
    await page.keyboard.press('End');
    await page.keyboard.type('!');
    await page.locator('.wc-close').click();
    await page.getByText("Margin couldn't save this session", { exact: true }).waitFor();
    ok('a failed draft write keeps Margin open with the unsaved edit', (await page.locator('.cm-content').textContent()).endsWith('!'));
  } finally {
    fs.rmdirSync(draft);
    fs.renameSync(backup, draft);
  }
  await page.locator('.wc-close').click();
  await page.waitForEvent('close', { timeout: 7000 }).catch(() => undefined);
  ok('retrying Close writes the draft once storage is available', JSON.parse(fs.readFileSync(draft, 'utf8')).content.endsWith('!'));
  await b.close().catch(() => undefined);
} catch (error) {
  ok('suite completed', false, error.message);
  throw error;
} finally {
  dispose();
  const passed = results.filter((r) => r.startsWith('PASS')).length;
  console.log('\n' + passed + '/' + results.length + ' passed; fixtures: ' + dir);
  if (passed !== results.length) process.exitCode = 1;
}
