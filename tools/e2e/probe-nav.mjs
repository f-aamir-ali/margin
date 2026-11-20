// Ctrl+End / Ctrl+Home in Editing mode across math, code, tables and lists (the tour has them all).
// Use the isolated release build from tools/e2e/tauri.test.json.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

import { createHarness } from './harness.mjs';

const { dir, launch, fresh, verify, dispose } = createHarness('margin-probe-nav-');
const file = path.join(dir, 'tour-copy.md');
fs.copyFileSync(path.resolve('public/samples/welcome.md'), file);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  fresh();
  launch([file]);
  let page;
  let b;
  for (let i = 0; i < 80 && !page; i++) {
    try {
      b = await chromium.connectOverCDP('http://127.0.0.1:9333');
      page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('tauri.localhost'));
    } catch {
      await sleep(250);
    }
  }
  await verify(page);
  await page.waitForSelector('.prose.reader');
  await page.keyboard.press('Control+e');
  await page.waitForSelector('.prose.editor[data-ready]');
  await sleep(1500);
  await page.click('.ProseMirror p >> nth=0');
  const where = () =>
    page.evaluate(() => {
      const sel = document.getSelection();
      const pm = document.querySelector('.ProseMirror');
      if (!sel?.anchorNode || !pm) return null;
      const blocks = [...pm.children];
      const i = blocks.findIndex((el) => el.contains(sel.anchorNode));
      return { block: i, of: blocks.length, text: (blocks[i]?.textContent ?? '').slice(0, 40) };
    });
  await page.keyboard.press('Control+End');
  await sleep(400);
  const end = await where();
  console.log((end && end.block === end.of - 1 ? 'PASS' : 'FAIL') + '  Ctrl+End reaches the last block', JSON.stringify(end));
  await page.keyboard.press('Control+Home');
  await sleep(400);
  const home = await where();
  console.log((home && home.block === 0 ? 'PASS' : 'FAIL') + '  Ctrl+Home reaches the first block', JSON.stringify(home));
  if (!end || end.block !== end.of - 1 || !home || home.block !== 0) process.exitCode = 1;
  await b.close();
} finally {
  dispose();
}
