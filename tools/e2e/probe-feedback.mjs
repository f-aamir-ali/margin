// The 2026-11-25 feedback round, checked in the real WebView2 app (test copy).
// Build: npm run tauri build -- --no-bundle --config tools/e2e/tauri.test.json
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

import { createHarness } from './harness.mjs';

const { dir, launch, fresh, verify, dispose } = createHarness('margin-feedback-');
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

const long = path.join(dir, 'long.md');
fs.writeFileSync(long, Array.from({ length: 160 }, (_, i) => `## Section ${i + 1}\n\nParagraph ${i + 1} with enough words to wrap across the line at least once in the reading column, so the page is long.\n`).join('\n'));
const other = path.join(dir, 'other.md');
fs.writeFileSync(other, '# Other\n\n' + 'Another paragraph. '.repeat(600));

const tabRects = (page) => page.$$eval('.tabs .tab', (tabs) => tabs.map((t) => { const r = t.getBoundingClientRect(); return `${Math.round(r.left)}:${Math.round(r.width)}`; }).join(','));
const stripWidth = (page) => page.$eval('.tabs', (t) => Math.round(t.getBoundingClientRect().width));

try {
  fresh({ spellcheck: true });
  launch([long, other]);
  const { b, page } = await connect();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForSelector('.tabs .tab');

  // 1. The top bar holds still while typing in an untitled note (its title follows the first line).
  await page.keyboard.press('Control+n');
  await page.waitForSelector('.doc-stage[data-visible] .ProseMirror');
  await sleep(400);
  const before = await tabRects(page);
  const beforeStrip = await stripWidth(page);
  let moved = 0;
  for (const ch of 'A title that keeps getting longer as I type') {
    await page.keyboard.type(ch);
    await sleep(15);
    if ((await tabRects(page)) !== before) moved++;
  }
  ok('typing in an untitled note never moves or resizes the tabs', moved === 0 && (await stripWidth(page)) === beforeStrip, `${moved} changes`);

  // 2. A dragged tab can't go under the + button.
  const firstTab = page.locator('.tabs .tab').first();
  const box = await firstTab.boundingBox();
  const plus = await page.locator('.tab-new').boundingBox();
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
  let worst = -Infinity;
  for (let x = box.x + 20; x < plus.x + 600; x += 40) {
    await page.mouse.move(x, box.y + box.height / 2, { steps: 2 });
    await sleep(30);
    const dragged = await page.$$eval('.tabs .tab', (tabs) => Math.max(...tabs.map((t) => t.getBoundingClientRect().right)));
    worst = Math.max(worst, dragged);
  }
  await page.mouse.up();
  await sleep(400);
  ok('a dragged tab never reaches the + button', worst <= plus.x + 1, `rightmost ${Math.round(worst)}, + at ${Math.round(plus.x)}`);

  // 3. Many tabs: the strip scrolls and the active tab stays in view.
  for (let i = 0; i < 22; i++) await page.keyboard.press('Control+t');
  await sleep(500);
  const strip = page.locator('.tabs');
  const overflowing = await strip.evaluate((s) => s.scrollWidth > s.clientWidth);
  const activeInView = async () => page.evaluate(() => {
    const s = document.querySelector('.tabs').getBoundingClientRect();
    const a = document.querySelector('.tabs .tab[data-active="true"]').getBoundingClientRect();
    return a.left >= s.left - 1 && a.right <= s.right + 1 ? true : JSON.stringify({ s: [Math.round(s.left), Math.round(s.right)], a: [Math.round(a.left), Math.round(a.right)] });
  });
  await page.keyboard.press('Control+1');
  await sleep(1500);
  const firstVisible = await activeInView();
  await page.keyboard.press('Control+9');
  await sleep(1500);
  const lastVisible = await activeInView();
  const before3 = await strip.evaluate((s) => s.scrollLeft);
  await strip.hover();
  await page.mouse.wheel(0, -400);
  await sleep(300);
  const wheeled = (await strip.evaluate((s) => s.scrollLeft)) !== before3;
  const chevron = await page.locator('.tabs-wrap[data-overflow-left] .tabs-nav-left').count();
  ok('too many tabs: wheel scrolls the strip, chevrons show, the active tab is kept in view', overflowing && firstVisible === true && lastVisible === true && wheeled && chevron === 1,
    JSON.stringify({ overflowing, firstVisible, lastVisible, wheeled, chevron }));
  // Close the extra untitled tabs again.
  await page.keyboard.press('Control+9');
  for (let i = 0; i < 22; i++) {
    await page.keyboard.press('Control+w');
    await sleep(120);
    if (await page.locator('[role="alertdialog"]').count()) await page.getByRole('button', { name: "Don't save" }).click();
  }
  await sleep(400);

  // 4. Ctrl+Tab keeps each long document's scroll position.
  await sleep(600);
  await page.locator('.tabs .tab').filter({ hasText: 'long.md' }).click();
  await page.waitForFunction(() => document.title.includes('long.md'));
  await page.getByRole('radio', { name: 'Read', exact: true }).click();
  await page.waitForSelector('.doc-stage[data-visible] .reader h2');
  await page.locator('.doc-stage[data-visible] .doc-scroller').evaluate((s) => { s.scrollTop = s.scrollHeight * 0.6; });
  await sleep(400);
  const kept = await page.locator('.doc-stage[data-visible] .doc-scroller').evaluate((s) => s.scrollTop);
  await page.keyboard.down('Control');
  await page.keyboard.press('Tab');
  await sleep(150);
  await page.keyboard.press('Shift+Tab'); // back again while Ctrl is still held
  await sleep(1200);
  await page.keyboard.up('Control');
  // Wait until the first tab is the active one again.
  await page.waitForFunction(() => document.title.includes('long.md'));
  await sleep(800);
  const back = await page.locator('.doc-stage[data-visible] .doc-scroller').evaluate((s) => s.scrollTop);
  ok('Ctrl+Tab away and back keeps the scroll position', Math.abs(back - kept) < 40, `${Math.round(kept)} -> ${Math.round(back)}`);

  // 5 + 6. Typing in Edit doesn't scroll when the caret is visible, and Enter doesn't shift earlier text.
  await page.getByRole('radio', { name: 'Edit', exact: true }).click();
  await page.waitForSelector('.doc-stage[data-visible] .ProseMirror');
  await sleep(800);
  const scroller = page.locator('.doc-stage[data-visible] .doc-scroller');
  const para = page.locator('.doc-stage[data-visible] .ProseMirror p').nth(40);
  await para.scrollIntoViewIfNeeded();
  await scroller.evaluate((s, el) => { s.scrollTop += el.getBoundingClientRect().top - s.getBoundingClientRect().top - s.clientHeight * 0.4; }, await para.elementHandle());
  await sleep(300);
  await para.click({ position: { x: 30, y: 8 } });
  await page.keyboard.press('End');
  const top0 = await scroller.evaluate((s) => s.scrollTop);
  const above0 = await page.locator('.doc-stage[data-visible] .ProseMirror p').nth(39).evaluate((el) => el.getBoundingClientRect().top);
  let scrolls = 0;
  let shifts = 0;
  for (let i = 0; i < 30; i++) {
    await page.keyboard.type(i % 10 === 9 ? ' ' : 'w');
    await sleep(20);
    if (Math.abs((await scroller.evaluate((s) => s.scrollTop)) - top0) > 0.5) scrolls++;
  }
  const top1 = await scroller.evaluate((s) => s.scrollTop);
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Enter');
    await page.keyboard.type('new line');
    await sleep(120);
    const above = await page.locator('.doc-stage[data-visible] .ProseMirror p').nth(39).evaluate((el) => el.getBoundingClientRect().top);
    const scrolled = (await scroller.evaluate((s) => s.scrollTop)) - top1;
    if (Math.abs(above + scrolled - above0) > 0.5) shifts++;
  }
  ok('typing mid-screen in Edit never scrolls the page', scrolls === 0, `${scrolls} scroll jumps in 30 keys`);
  ok('pressing Enter leaves the text above exactly where it was', shifts === 0, `${shifts} shifts`);

  // 7. The caret stops blinking when the window isn't focused.
  const caretState = () => page.evaluate(() => {
    const c = document.querySelector('.smooth-caret');
    return c ? { visible: c.getAttribute('data-visible'), blink: c.getAttribute('data-blink'), opacity: getComputedStyle(c).opacity } : null;
  });
  const focused = await caretState();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hasFocus', { value: () => false, configurable: true });
    window.dispatchEvent(new Event('blur'));
  });
  await sleep(300);
  const blurred = await caretState();
  await page.evaluate(() => {
    delete document.hasFocus;
    window.dispatchEvent(new Event('focus'));
  });
  ok('the caret hides when the window loses focus', !!focused && focused.visible === 'true' && (!blurred || blurred.visible !== 'true' || blurred.opacity === '0'), JSON.stringify({ focused, blurred }));

  // 8. Pasting web content inserts plain text only.
  await page.locator('.doc-stage[data-visible] .ProseMirror p').nth(10).click();
  await page.keyboard.press('End');
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/html', '<h1 style="font-size:40px">Big</h1><p><b>bold</b> <a href="https://x.test">link</a> <span style="color:red;font-family:Comic Sans MS">red</span></p>');
    data.setData('text/plain', 'Big\nbold link red *not markdown*');
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await sleep(400);
  const pasted = await page.evaluate(() => {
    const pm = document.querySelector('.doc-stage[data-visible] .ProseMirror');
    return {
      text: pm.innerText.includes('bold link red *not markdown*'),
      marks: pm.querySelectorAll('strong, b, a[href="https://x.test"], h1 + p span[style]').length,
      styled: [...pm.querySelectorAll('[style]')].filter((n) => /color|font/.test(n.getAttribute('style'))).length,
      h1s: [...pm.querySelectorAll('h1')].filter((h) => h.textContent === 'Big').length,
    };
  });
  ok('pasting formatted web content inserts plain text only', pasted.text && pasted.marks === 0 && pasted.styled === 0 && pasted.h1s === 0, JSON.stringify(pasted));

  ok('no page errors', errors.length === 0, errors.join(' | '));
  await b.close();

  // 9. Right-click spelling, in a fresh session (as after opening Margin and typing).
  {
    fresh({ spellcheck: true, defaultMode: 'edit' });
    const note = path.join(dir, 'spell.md');
    fs.writeFileSync(note, '# Spelling\n\nThe quick brown fox jumps over the lazy dog.\n');
    launch([note]);
    const { b, page } = await connect();
    await page.waitForSelector('.doc-stage[data-visible] .ProseMirror p');
    await sleep(1000);
    await page.evaluate(() => { window.__routes = []; const I = window.__TAURI_INTERNALS__; const id = I.transformCallback((e) => window.__routes.push(e.payload.native)); return I.invoke('plugin:event|listen', { event: 'context-menu-route', target: { kind: 'Any' }, handler: id }); });
    const p = page.locator('.doc-stage[data-visible] .ProseMirror p').first();
    await p.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' recieve teh wrold ');
    await sleep(3500);
    const at = (needle, offset) => p.evaluate((el, [n, o]) => {
      const text = [...el.childNodes].find((x) => x.nodeType === 3 && x.textContent.includes(n));
      const i = text.textContent.indexOf(n) + o;
      const r = document.createRange();
      r.setStart(text, i);
      r.setEnd(text, i + 1);
      const box = r.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }, [needle, offset]);
    const bad = await at('recieve', 2);
    await page.mouse.click(bad.x, bad.y, { button: 'right' });
    await sleep(800);
    const ownOnBad = await page.locator('[role="menu"]').count();
    // The native menu is its own window: the next click dismisses it, then Margin's menu opens
    // (its fallback covers the click that only closed the native one).
    await page.keyboard.press('Escape');
    await sleep(600);
    const good = await at('quick', 2);
    await page.mouse.click(good.x, good.y, { button: 'right' });
    await sleep(800);
    const ownOnGood = await page.locator('[role="menu"]').count();
    await page.keyboard.press('Escape');
    const routes = await page.evaluate(() => window.__routes);
    ok("right-click on a misspelled word opens the native spelling menu; on other words Margin's own menu", routes[0] === true && ownOnBad === 0 && ownOnGood === 1, JSON.stringify({ routes, ownOnBad, ownOnGood }));
    await b.close();
  }
} finally {
  dispose();
}
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
