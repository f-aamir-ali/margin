// Code stays code: inside a code block (Read and Edit) and in Source mode, Markdown such as "### and" or
// "**bold**" is coloured only. Every line keeps one font size, weight, slant and line height, also while typing.
// Build: npm run tauri build -- --no-bundle --config tools/e2e/tauri.test.json
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

import { createHarness } from './harness.mjs';

const { dir, launch, fresh, verify, dispose } = createHarness('margin-code-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, pass, extra = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
};

async function connect() {
  for (let i = 0; i < 120; i++) {
    try {
      const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
      const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('tauri.localhost'));
      if (page) {
        await page.waitForSelector('.app', { timeout: 15000 });
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
}

const FENCE = '```';
const file = path.join(dir, 'code.md');
fs.writeFileSync(
  file,
  [
    '# Code blocks',
    '',
    `${FENCE}md`,
    'plain line',
    '### and',
    '# big heading',
    '## second',
    '**bold** and *italic* and _under_',
    '> a quote',
    '- [link](https://example.com)',
    FENCE,
    '',
    `${FENCE}js`,
    'const x = 1; // comment',
    FENCE,
    '',
  ].join('\n'),
);

/** Every line under `lines` and every text run inside it: one size, weight and slant, one line height. */
const uniform = (page, lines) =>
  page.$$eval(lines, (els) => {
    const fonts = new Set();
    const heights = new Set();
    for (const line of els) {
      heights.add(Math.round(line.getBoundingClientRect().height * 10) / 10);
      for (const el of [line, ...line.querySelectorAll('*')]) {
        if (!el.textContent.trim()) continue;
        const cs = getComputedStyle(el);
        fonts.add(`${cs.fontSize} ${cs.fontWeight} ${cs.fontStyle} ${cs.fontFamily.split(',')[0]}`);
      }
    }
    return { lines: els.length, fonts: [...fonts], heights: [...heights] };
  });
const same = (u) => u.lines > 0 && u.fonts.length === 1 && u.heights.length === 1;
const show = (u) => JSON.stringify(u);

try {
  fresh({ spellcheck: false });
  launch([file]);
  const { b, page } = await connect();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.locator('.tab[data-active="true"]').waitFor();

  // Read mode
  await page.getByRole('radio', { name: 'Read', exact: true }).click();
  await page.locator('.doc-stage[data-visible] .reader pre code').first().waitFor();
  await sleep(300);
  const read = await page.$$eval('.doc-stage[data-visible] .reader pre code', (blocks) =>
    blocks.map((code) => {
      const fonts = new Set();
      for (const el of [code, ...code.querySelectorAll('*')]) {
        if (!el.textContent.trim()) continue;
        const cs = getComputedStyle(el);
        fonts.add(`${cs.fontSize} ${cs.fontWeight} ${cs.fontStyle}`);
      }
      return [...fonts];
    }),
  );
  ok('Read: markdown inside a code block keeps one size, weight and slant', read.length === 2 && read.every((f) => f.length === 1), JSON.stringify(read));

  // Edit mode
  await page.getByRole('radio', { name: 'Edit', exact: true }).click();
  await page.locator('.doc-stage[data-visible] .milkdown-code-block .cm-line').first().waitFor();
  await sleep(500);
  const firstBlockLines = async () =>
    page.locator('.doc-stage[data-visible] .milkdown-code-block').first().evaluate((block) => {
      const fonts = new Set();
      const heights = new Set();
      const lines = block.querySelectorAll('.cm-line');
      for (const line of lines) {
        heights.add(Math.round(line.getBoundingClientRect().height * 10) / 10);
        for (const el of [line, ...line.querySelectorAll('*')]) {
          if (!el.textContent.trim()) continue;
          const cs = getComputedStyle(el);
          fonts.add(`${cs.fontSize} ${cs.fontWeight} ${cs.fontStyle} ${cs.fontFamily.split(',')[0]}`);
        }
      }
      return { lines: lines.length, fonts: [...fonts], heights: [...heights] };
    });
  const editBefore = await firstBlockLines();
  ok('Edit: a ```md block shows headings, bold and quotes at one size and line height', same(editBefore) && editBefore.lines === 7, show(editBefore));

  // Type new heading lines into the block, as he did.
  const last = page.locator('.doc-stage[data-visible] .milkdown-code-block').first().locator('.cm-line').last();
  await last.click();
  await page.keyboard.press('End');
  const heights = [];
  const lineHeight = () => last.evaluate((el) => el.closest('.cm-content').lastElementChild.getBoundingClientRect().height);
  await page.keyboard.press('Enter');
  for (const ch of '### and then more') {
    await page.keyboard.type(ch);
    await sleep(20);
    heights.push(Math.round((await lineHeight()) * 10) / 10);
  }
  await page.keyboard.press('Enter');
  await page.keyboard.type('# a big one **and bold**', { delay: 10 });
  await sleep(400);
  const editAfter = await firstBlockLines();
  ok('Edit: typing "### and" in the block never changes the line height', new Set(heights).size === 1, heights.join(','));
  ok('Edit: after typing, every line in the block is still the same', same(editAfter) && editAfter.lines === 9 && editAfter.fonts[0] === editBefore.fonts[0] && editAfter.heights[0] === editBefore.heights[0], show(editAfter));

  // Source mode
  await page.getByRole('radio', { name: 'Source', exact: true }).click();
  await page.locator('.doc-stage[data-visible] .source .cm-content').waitFor();
  await sleep(400);
  const sourceLines = '.doc-stage[data-visible] .source .cm-line';
  const srcBefore = await uniform(page, sourceLines);
  ok('Source: "# Code blocks", headings and bold lines all share one size and line height', same(srcBefore), show(srcBefore));
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.type('## typed **heading** _here_', { delay: 10 });
  await sleep(300);
  const srcAfter = await uniform(page, sourceLines);
  ok('Source: typing a heading at the top keeps every line the same', same(srcAfter) && srcAfter.fonts[0] === srcBefore.fonts[0], show(srcAfter));

  ok('no page errors', errors.length === 0, errors.join(' | '));
  await page.keyboard.press('Control+z');
  await b.close();
} finally {
  dispose();
}
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
