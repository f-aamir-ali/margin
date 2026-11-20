// Types **bold** and ~strike~ at the end of different kinds of paragraph and prints what the
// Use the isolated release build from tools/e2e/tauri.test.json.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

import { createHarness } from './harness.mjs';

const { dir, launch, fresh, verify, dispose } = createHarness('margin-probe-marks-');
const file = path.join(dir, 'marks.md');
fs.writeFileSync(file, 'Plain ending.\n\nEnds in *italic*\n\nEnds in *  odd   spacing*.\n\nEnds in **bold**\n');
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
  await sleep(800);
  const count = await page.locator('.ProseMirror p').count();
  for (let i = 0; i < count; i++) {
    await page.click(`.ProseMirror p >> nth=${i}`);
    await page.keyboard.press('End');
    await page.keyboard.type(' x **bold** and ~strike~.', { delay: 15 });
    await sleep(300);
    console.log(i, await page.locator(`.ProseMirror p >> nth=${i}`).innerHTML());
  }
  // and a fresh paragraph
  await page.keyboard.press('Enter');
  await page.keyboard.type('Fresh **bold** and ~strike~.', { delay: 15 });
  await sleep(300);
  console.log('fresh', await page.locator('.ProseMirror p').last().innerHTML());
  await b.close();
} finally {
  dispose();
}
