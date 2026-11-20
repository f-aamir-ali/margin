// Focused check of the scariest path: a brand-new untitled note survives a hard kill.
// Use the isolated release build from tools/e2e/tauri.test.json.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

import { createHarness } from './harness.mjs';

const { config, launch, fresh, verify, dispose, kill } = createHarness('margin-probe-hotexit-');
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
  fresh();
  launch([]);
  let { b, page } = await connect();
  console.log('tabs at start', await page.locator('.tab-name').allTextContents());
  await page.keyboard.press('Control+n');
  await page.waitForSelector('.prose.editor[data-ready]');
  await sleep(500);
  console.log('focus after Ctrl+N:', await page.evaluate(() => document.activeElement?.className));
  await page.keyboard.type('Hot exit note 123', { delay: 10 });
  await sleep(300);
  console.log('tabs after typing', await page.locator('.tab-name').allTextContents());
  await sleep(2200);
  const drafts = path.join(config, 'drafts');
  for (const f of fs.existsSync(drafts) ? fs.readdirSync(drafts) : []) {
    console.log('draft', f, fs.readFileSync(path.join(drafts, f), 'utf8').slice(0, 200));
  }
  await b.close();
  kill();
  await sleep(800);
  launch([]);
  ({ b, page } = await connect());
  console.log('tabs after hard kill', await page.locator('.tab-name').allTextContents());
  // Closing that tab: the dialog's "Don't save" must close it.
  page.on('console', (m) => console.log('console:', m.type(), m.text()));
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.click('.tab:has-text("Hot exit note 123")');
  await sleep(300);
  await page.keyboard.press('Control+w');
  await sleep(400);
  console.log('dialog buttons', await page.locator('[role="alertdialog"] button').allTextContents());
  await page.click('[role="alertdialog"] button:has-text("Don\'t save")');
  for (const t of [50, 250, 700]) {
    await sleep(t);
    console.log('after', t, 'ms:', await page.locator('.tab-name').allTextContents(), 'dialogs', await page.locator('[role="alertdialog"]').count());
  }
  await b.close();
} finally {
  dispose();
}
