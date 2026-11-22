// Design screenshots in a chosen theme: Read, Edit, Source, plain text, hover and pressed controls.
// node tools/e2e/probe-shots.mjs [darkTheme=ember] [lightTheme=sepia] [mode=dark]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

import { createHarness } from './harness.mjs';

const [darkTheme = 'ember', lightTheme = 'sepia', themeMode = 'dark'] = process.argv.slice(2);
const { dir, launch, fresh, verify, dispose } = createHarness('margin-shots-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md = path.join(dir, 'English Desk notes.md');
fs.writeFileSync(
  md,
  '# English desk skill changes\n\nA few things I want to change before the next lesson.\n\n## What works\n\n- The walk-through finds the right lesson **every time**.\n- Screenshots are taken only when needed.\n\n## What to fix\n\n1. It skips the vocabulary check.\n2. It reads the *whole* page instead of the question.\n\n> [!NOTE]\n> Keep answers in my own words.\n\n```js\nconst lesson = await open("Unit 4");\n```\n\n| Step | Time |\n|---|---|\n| Read | 5 min |\n| Answer | 10 min |\n',
);
const txt = path.join(dir, 'todo.txt');
fs.writeFileSync(txt, 'Groceries\n- milk\n- eggs\n\nCall the dentist on Monday.\n');
try {
  fresh({ themeMode, darkTheme, lightTheme });
  launch([txt, md]);
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
  await sleep(1000);
  const shot = (n) => page.screenshot({ path: path.join(dir, `${n}.png`) });
  await shot('read');
  await page.hover('.titlebar .segmented-item[aria-label="Edit"]');
  await sleep(700);
  await shot('hover-edit');
  await page.click('.titlebar .segmented-item[aria-label="Edit"]');
  await sleep(1500);
  await shot('edit');
  await page.click('.titlebar .segmented-item[aria-label="Source"]');
  await sleep(900);
  await shot('source');
  await page.click('.tab:has-text("todo.txt")');
  await sleep(900);
  await page.hover('.format-md');
  await sleep(700);
  await shot('plain-hover-format');
  await b.close();
} finally {
  dispose();
  console.log(dir);
}
