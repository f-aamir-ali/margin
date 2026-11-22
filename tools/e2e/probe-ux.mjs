// UX checks for the Nov 22 feedback round: one check (or more) per complaint.
// Build the isolated test copy first (tools/e2e/tauri.test.json), then: node tools/e2e/probe-ux.mjs
// Screenshots: <temp>/margin-ux-*/ux-*.png
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

import { createHarness } from './harness.mjs';

const { dir, launch, fresh, verify, dispose } = createHarness('margin-ux-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, pass, extra = '') => {
  results.push((pass ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  [' + extra + ']' : ''));
  console.log(results[results.length - 1]);
};
const errors = [];
const connect = async () => {
  for (let i = 0; i < 80; i++) {
    try {
      const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
      const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('tauri.localhost'));
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
  throw new Error('could not attach');
};
const shot = (page, name) => page.screenshot({ path: path.join(dir, `ux-${name}.png`) });
const para = (i) => `Paragraph ${i}. ` + 'The quick brown fox jumps over the lazy dog while the long document keeps going. '.repeat(6);
const longMd = (title) => `# ${title}\n\n` + Array.from({ length: 70 }, (_, i) => (i % 10 === 0 ? `## Section ${i / 10 + 1}\n\n` : '') + para(i)).join('\n\n') + '\n\n- last item one\n- last item two\n';

const longA = path.join(dir, 'long-a.md');
const longB = path.join(dir, 'long-b.md');
const shortMd = path.join(dir, 'short.md');
const plainTxt = path.join(dir, 'separators.txt');
const names = ['a.md', 'a-much-longer-file-name-here.md', 'mid-name.md', 'x.md', 'another-fairly-long-one.md', 'b.md'];
fs.writeFileSync(longA, longMd('Long A'));
fs.writeFileSync(longB, longMd('Long B'));
fs.writeFileSync(shortMd, '# Short\n\nOnly a few lines here.\n');
fs.writeFileSync(plainTxt, 'First thought, written as plain text.\n---\nSecond thought here.\n---\nThird thought and the end.\n');
for (const n of names) fs.writeFileSync(path.join(dir, n), `# ${n}\n\nText.\n`);

const scroller = (page) => page.locator('.doc-view .doc-stage[data-visible] .doc-scroller').first();
const frac = (page) =>
  scroller(page).evaluate((s) => {
    const max = s.scrollHeight - s.clientHeight;
    return max > 0 ? s.scrollTop / max : 0;
  });
const setFrac = (page, f) =>
  scroller(page).evaluate((s, f) => {
    s.scrollTop = f * (s.scrollHeight - s.clientHeight);
    s.dispatchEvent(new WheelEvent('wheel'));
  }, f);
const activate = async (page, name) => {
  await page.click(`.tab:has-text("${name}")`);
  await sleep(900);
};

try {
  fresh();
  launch([longA, longB, shortMd]);
  let { b, page } = await connect();
  await page.waitForSelector('.tab:has-text("short.md")');
  await sleep(800);

  // --- 11. short pages don't scroll (Read, Edit, Source)
  await activate(page, 'short.md');
  for (const [mode, key] of [['read', null], ['edit', 'Control+e'], ['source', 'Control+/']]) {
    if (key) {
      await page.keyboard.press(key);
      await sleep(1200);
    }
    const s = await scroller(page).evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight, long: el.hasAttribute('data-long') }));
    ok(`short page does not scroll in ${mode}`, s.sh <= s.ch + 1, `${s.sh} vs ${s.ch}`);
  }
  await page.keyboard.press('Control+e'); // back to read
  await sleep(700);

  // --- 4. each tab keeps its scroll position (Read)
  await activate(page, 'long-a.md');
  await setFrac(page, 0.62);
  await sleep(500);
  await activate(page, 'long-b.md');
  await setFrac(page, 0.31);
  await sleep(500);
  await activate(page, 'long-a.md');
  const backA = await frac(page);
  await activate(page, 'long-b.md');
  const backB = await frac(page);
  ok('Read: switching tabs keeps each position', Math.abs(backA - 0.62) < 0.03 && Math.abs(backB - 0.31) < 0.03, `${backA.toFixed(3)} / ${backB.toFixed(3)}`);

  // same in Source
  await activate(page, 'long-a.md');
  await page.keyboard.press('Control+/');
  await sleep(1000);
  await setFrac(page, 0.5);
  await sleep(400);
  await activate(page, 'long-b.md');
  await activate(page, 'long-a.md');
  await sleep(400);
  const srcBack = await frac(page);
  ok('Source: switching tabs keeps the position', Math.abs(srcBack - 0.5) < 0.04, srcBack.toFixed(3));

  // and Edit
  await page.click('.titlebar .segmented-item[aria-label="Edit"]');
  await sleep(1800);
  await setFrac(page, 0.7);
  await sleep(500);
  await activate(page, 'long-b.md');
  await activate(page, 'long-a.md');
  await sleep(1200);
  const editBack = await frac(page);
  ok('Edit: switching tabs keeps the position', Math.abs(editBack - 0.7) < 0.05, editBack.toFixed(3));

  // --- 9. back to top
  const topBtn = await page.locator('.scroll-top').count();
  ok('back-to-top button shows deep in a long document', topBtn === 1);
  if (topBtn) {
    await page.click('.scroll-top');
    let top = 9999;
    for (let i = 0; i < 30 && top >= 5; i++) {
      await sleep(100);
      top = await scroller(page).evaluate((s) => s.scrollTop);
    }
    ok('back-to-top goes to the top', top < 5, Math.round(top) + 'px');
  }
  await sleep(400);
  ok('back-to-top hides at the top', (await page.locator('.scroll-top').count()) === 0);

  // --- 12. Down at the last line does not reach a phantom line (doc ends in a list)
  await page.click('.titlebar .segmented-item[aria-label="Edit"]');
  await sleep(1500);
  await page.click('.doc-stage[data-visible] .ProseMirror p >> nth=3');
  await page.keyboard.press('Control+End');
  await sleep(300);
  const lastBlock = await page.evaluate(() => {
    const pms = [...document.querySelectorAll('.ProseMirror')];
    const pm = document.querySelector('.doc-stage[data-visible] .ProseMirror') ?? pms[pms.length - 1];
    const last = pm?.lastElementChild;
    return { tag: last?.tagName, text: (last?.textContent ?? '').slice(0, 30), editors: pms.length, stages: document.querySelectorAll('.doc-stage[data-visible]').length, cls: last?.className };
  });
  ok('Edit: no empty phantom line after a final list', lastBlock.tag === 'UL' || lastBlock.tag === 'OL', JSON.stringify(lastBlock));
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  const inLast = await page.evaluate(() => {
    const sel = document.getSelection();
    const pm = document.querySelector('.doc-stage[data-visible] .ProseMirror');
    return !!sel?.anchorNode && !!pm?.lastElementChild?.contains(sel.anchorNode);
  });
  ok('Edit: Down at the last line stays on the last line', inLast);

  // --- 1. click the empty page below the text -> caret at the very end (Edit)
  await activate(page, 'short.md');
  await page.keyboard.press('Control+e');
  await sleep(1500);
  const box = await scroller(page).boundingBox();
  await page.mouse.click(box.x + box.width * 0.85, box.y + box.height - 40);
  await sleep(250);
  const atEnd = await page.evaluate(() => {
    const sel = document.getSelection();
    const pm = document.querySelector('.doc-stage[data-visible] .ProseMirror');
    if (!sel?.anchorNode || !pm) return false;
    const r = document.createRange();
    r.selectNodeContents(pm);
    r.setStart(sel.anchorNode, sel.anchorOffset);
    return r.toString().length === 0;
  });
  ok('Edit: clicking below the text puts the caret at the end', atEnd);
  await page.keyboard.type('!');
  await sleep(300);
  ok('Edit: typing there appends to the last line', (await page.textContent('.doc-stage[data-visible] .ProseMirror')).includes('here.!'));
  await page.keyboard.press('Control+z');

  // same in Source
  await page.keyboard.press('Control+/');
  await sleep(1000);
  await page.mouse.click(box.x + box.width * 0.85, box.y + box.height - 40);
  await sleep(250);
  const srcCaret = await page.evaluate(() => document.querySelector('.statusbar')?.textContent ?? '');
  // The file ends with a line break, so the very end is the start of line 4.
  ok('Source: clicking below the text puts the caret at the end', /Ln 4, Col 1(?!\d)/.test(srcCaret), srcCaret.match(/Ln [\d,]+, Col [\d,]+/)?.[0]);
  await page.keyboard.press('Control+/');
  await sleep(500);

  // --- 5. Ctrl+F: focus goes to the find box, typing finds, clicking the page closes it
  await activate(page, 'long-a.md');
  await page.click('.titlebar .segmented-item[aria-label="Edit"]');
  await sleep(1500);
  await page.click('.doc-stage[data-visible] .ProseMirror p >> nth=2');
  await page.keyboard.press('Control+f');
  await sleep(500);
  const focus = await page.evaluate(() => !!document.activeElement?.closest('.findbar'));
  ok('Ctrl+F puts the caret in the find box', focus);
  await page.keyboard.type('lazy dog');
  await sleep(500);
  const count = (await page.textContent('.find-count')) ?? '';
  ok('typing finds as you type', /\d+ \/ \d+/.test(count), count);
  await page.keyboard.press('Control+f');
  await sleep(300);
  ok('Ctrl+F again keeps the find box focused', await page.evaluate(() => !!document.activeElement?.closest('.findbar')));
  await page.click('.doc-stage[data-visible] .ProseMirror p >> nth=4');
  await sleep(500);
  ok('clicking back on the page closes find', (await page.locator('.findbar').count()) === 0);

  // --- 3. Format as markdown keeps --- lines as separators
  await page.keyboard.press('Control+o').catch(() => undefined);
  await sleep(300);
  await page.keyboard.press('Escape');
  launch([plainTxt]);
  await page.waitForSelector('.tab:has-text("separators.txt")[data-active="true"]', { timeout: 8000 });
  await sleep(900);
  await page.click('.format-md');
  await page.waitForSelector('.doc-stage[data-visible] .prose.reader');
  await sleep(700);
  const fm = await page.evaluate(() => {
    const r = document.querySelector('.doc-stage[data-visible] .prose.reader');
    return { h: r?.querySelectorAll('h1, h2').length ?? -1, hr: r?.querySelectorAll('hr').length ?? -1 };
  });
  ok('Format as markdown: --- lines stay separators, no giant headings', fm.h === 0 && fm.hr === 2, JSON.stringify(fm));
  await shot(page, 'format-md');

  // --- word count: a selection never exceeds the total
  await page.keyboard.press('Control+/');
  await sleep(900);
  await page.click('.doc-stage[data-visible] .cm-content');
  await page.keyboard.press('Control+a');
  await sleep(400);
  const words = (await page.textContent('.statusbar')).match(/([\d,]+) of ([\d,]+) words/);
  ok('selected words never exceed the total', !!words && Number(words[1].replace(/,/g, '')) <= Number(words[2].replace(/,/g, '')), words?.[0]);
  const cursorH = await page.locator('.status-cursor').evaluate((el) => el.getBoundingClientRect().height);
  ok('Ln/Col with a selection stays on one line', cursorH <= 24, cursorH + 'px');

  // --- 10. icon-only view switch
  await page.keyboard.press('Control+/');
  await sleep(400);
  const segText = (await page.locator('.titlebar .segmented').textContent())?.trim() ?? '';
  ok('Read / Edit / Source are icons only', segText === '', JSON.stringify(segText));

  // --- 2. closing tabs: the next close button lands under the cursor
  launch(names.map((n) => path.join(dir, n)));
  await page.waitForSelector('.tab:has-text("b.md")');
  await sleep(1200);
  await shot(page, 'tabs');
  const widths = await page.locator('.tab').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
  ok('tabs share one width', Math.max(...widths) - Math.min(...widths) <= 2, widths.join(','));
  const target = page.locator('.tab:has-text("a-much-longer-file-name-here.md") .tab-close');
  await page.hover('.tab:has-text("a-much-longer-file-name-here.md")');
  const cb = await target.boundingBox();
  const cx = cb.x + cb.width / 2;
  const cy = cb.y + cb.height / 2;
  const before = (await page.locator('.tab-name').allTextContents()).length;
  for (let i = 0; i < 3; i++) {
    await page.mouse.move(cx, cy);
    await sleep(150);
    await page.mouse.down();
    await page.mouse.up();
    await sleep(450);
  }
  const after = (await page.locator('.tab-name').allTextContents()).length;
  ok('three clicks in one spot close three tabs', before - after === 3, `${before} -> ${after}`);
  await page.mouse.move(cx, cy + 300);
  await sleep(500);

  // --- 7. many tabs: the strip never runs under the right-hand controls, and there is room to drag
  for (let i = 0; i < 14; i++) await page.keyboard.press('Control+n');
  await sleep(1200);
  await shot(page, 'many-tabs');
  const geo = await page.evaluate(() => {
    const r = (s) => document.querySelector(s)?.getBoundingClientRect();
    return { tabs: r('.titlebar .tabs'), drag: r('.titlebar .tabs-drag'), right: r('.titlebar-right') };
  });
  ok('many tabs: strip ends before the right-hand controls', geo.tabs.right <= geo.right.left + 0.5, `${geo.tabs.right} <= ${geo.right.left}`);
  ok('many tabs: a drag strip of at least 48 px stays', geo.drag.width >= 48, Math.round(geo.drag.width) + 'px');

  // --- 13. narrow window (vertical monitor): status bar stays on one line
  // A vertical monitor: emulate a 640 px wide window.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 640, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(900);
  await activate(page, 'separators.txt');
  await page.keyboard.press('Control+/');
  await sleep(800);
  await page.click('.doc-stage[data-visible] .cm-content');
  await page.keyboard.press('Control+a');
  await sleep(400);
  const sb = await page.locator('.statusbar').evaluate((el) => {
    const kids = [...el.querySelectorAll('button, .status-item')].filter((k) => k.offsetParent && k.getBoundingClientRect().width > 0);
    const mids = kids.map((k) => { const r = k.getBoundingClientRect(); return r.top + r.height / 2; });
    return { width: window.innerWidth, spread: Math.round(Math.max(...mids) - Math.min(...mids)), height: Math.round(el.getBoundingClientRect().height), overflow: el.scrollWidth > el.clientWidth + 1, text: el.textContent };
  });
  await shot(page, 'narrow');
  ok('narrow window: status bar is one tidy row', sb.width <= 660 && sb.spread <= 4 && !sb.overflow, JSON.stringify(sb));
  await cdp.send('Emulation.clearDeviceMetricsOverride');

  ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await b.close();
} finally {
  dispose();
  console.log('\n' + results.filter((r) => r.startsWith('PASS')).length + '/' + results.length + ' passed; screenshots in ' + dir);
}
