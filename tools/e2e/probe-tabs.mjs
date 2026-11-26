// The tab strip in the real WebView2 app (test copy): reordering frame by frame, tearing a tab
// off into its own window, dropping it back, one window per file, and restarting into one window.
// Build: npm run tauri build -- --no-bundle --config tools/e2e/tauri.test.json
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

import { createHarness } from './harness.mjs';

const { dir, launch, fresh, verify, dispose } = createHarness('margin-tabs-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, pass, extra = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
};

const files = Object.fromEntries(['a', 'b', 'c'].map((n) => {
  const file = path.join(dir, `${n}.md`);
  fs.writeFileSync(file, `# Note ${n.toUpperCase()}\n\n` + `Text of note ${n}. `.repeat(80));
  return [n, file];
}));

let browser;
async function pages() {
  for (let i = 0; i < 120; i++) {
    try {
      browser ??= await chromium.connectOverCDP('http://127.0.0.1:9333');
      const list = browser.contexts().flatMap((c) => c.pages()).filter((p) => p.url().includes('tauri.localhost'));
      if (list.length) return list;
    } catch {
      browser = undefined;
    }
    await sleep(250);
  }
  throw new Error('could not attach');
}
const labelOf = (page) => page.evaluate(() => window.__TAURI_INTERNALS__.metadata.currentWindow.label);
async function windowPage(label, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    for (const p of await pages()) {
      try {
        if ((await labelOf(p)) === label) {
          await p.waitForSelector('.app');
          return p;
        }
      } catch {
        /* closing */
      }
    }
    await sleep(200);
  }
  return null;
}
async function liveLabels() {
  const out = [];
  for (const p of await pages()) {
    try {
      out.push(await labelOf(p));
    } catch {
      /* closing */
    }
  }
  return out.sort();
}
const tabNames = (page) => page.$$eval('.tabs [role="tab"] .tab-name', (n) => n.map((x) => x.textContent));
const frame = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(0)))));
const lefts = (page) => page.$$eval('.tabs [role="tab"]', (tabs) => tabs.map((t) => Math.round(t.getBoundingClientRect().left * 10) / 10));

/** Drags tab `from` horizontally to `toX`, sampling every tab's position each frame. */
async function dragAcross(page, from, toX) {
  const tabs = page.locator('.tabs [role="tab"]');
  const box = await tabs.nth(from).boundingBox();
  const plus = await page.locator('.tab-new').boundingBox();
  const startX = box.x + 30;
  const y = box.y + box.height / 2;
  await page.evaluate(() => {
    window.__ev = [];
    const strip = document.querySelector('.tabs');
    if (!strip.__traced) {
      strip.__traced = true;
      for (const t of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture', 'gotpointercapture']) strip.addEventListener(t, (e) => window.__ev.push(t + '@' + Math.round(e.clientX)), true);
    }
  });
  await page.mouse.move(startX, y);
  await page.mouse.down();
  const during = [];
  const step = toX > startX ? 7 : -7;
  for (let x = startX; step > 0 ? x <= toX : x >= toX; x += step) {
    await page.mouse.move(x, y);
    await frame(page);
    const rects = await page.$$eval('.tabs [role="tab"]', (ts) => ts.map((t) => { const r = t.getBoundingClientRect(); return { l: r.left, r: r.right, dragged: t.hasAttribute('data-dragged') }; }));
    during.push(rects);
  }
  await page.mouse.up();
  const after = [];
  for (let i = 0; i < 16; i++) {
    await frame(page);
    after.push(await lefts(page));
  }
  const trace = await page.evaluate(() => ({ ev: window.__ev, transforms: [...document.querySelectorAll('.tabs [role="tab"]')].map((t) => t.style.transform + '|' + t.style.transition), dragging: document.querySelector('.tabs').hasAttribute('data-dragging') }));
  return { during, after, plus, trace };
}

try {
  fresh({ defaultMode: 'read' });
  launch([files.a, files.b]);
  let main = await windowPage('main', 30000);
  await main.waitForSelector('.tabs [role="tab"]');
  await sleep(800);
  const errors = [];
  main.on('pageerror', (e) => errors.push(e.message));

  // 1. Two tabs: drag the left one to the far right.
  const before = await tabNames(main);
  const slots = await lefts(main);
  let run = await dragAcross(main, 0, (await main.locator('.tab-new').boundingBox()).x + 260);
  let order = await tabNames(main);
  // Only frames after the drag has started (before that no tab is marked as dragged).
  const otherMoves = run.during.filter((rects) => rects.some((r) => r.dragged)).map((rects) => rects.find((r) => !r.dragged)?.l).filter((v) => v !== undefined);
  const draggedRight = Math.max(...run.during.map((rects) => Math.max(...rects.filter((r) => r.dragged).map((r) => r.r), -Infinity)));
  // The other tab only ever moves left, once, toward the slot the dragged tab left.
  let monotonic = otherMoves.every((v, i) => i === 0 || v <= otherMoves[i - 1] + 0.5);
  ok('two tabs: the left one dragged right swaps places', order[0] === before[1] && order[1] === before[0], order.join(' | '));
  ok('two tabs: the other tab slides once, never back and forth', monotonic, otherMoves.map((v) => Math.round(v)).filter((v, i, a) => i === 0 || v !== a[i - 1]).join('→'));
  ok('the dragged tab never goes past the last slot or under +', draggedRight <= run.plus.x + 1, `${Math.round(draggedRight)} vs + at ${Math.round(run.plus.x)}`);
  // After the drop: the untouched tab stays still and the dropped tab only settles toward its slot.
  const finalLefts = run.after[run.after.length - 1];
  const otherAfter = run.after.map((l) => l[0]);
  const droppedAfter = run.after.map((l) => l[1]);
  const settled = droppedAfter.every((v, i) => i === 0 || Math.abs(v - finalLefts[1]) <= Math.abs(droppedAfter[i - 1] - finalLefts[1]) + 0.5);
  ok('after the drop nothing jumps: the other tab stays put, the dropped tab glides into its slot',
    otherAfter.every((v) => Math.abs(v - finalLefts[0]) < 0.6) && settled && Math.abs(finalLefts[0] - slots[0]) < 1 && Math.abs(finalLefts[1] - slots[1]) < 1,
    `other ${[...new Set(otherAfter.map(Math.round))].join(',')} dropped ${droppedAfter.map(Math.round).join(',')}`);

  // 2. And back: the right one dragged far left.
  run = await dragAcross(main, 1, 0);
  order = await tabNames(main);
  ok('dragging it back restores the order', order[0] === before[0] && order[1] === before[1], order.join(' | ') + ' ' + JSON.stringify(run.trace) + ' frames ' + run.during.length + ' last ' + JSON.stringify(run.during[run.during.length - 1]));
  const finalBack = run.after[run.after.length - 1];
  ok('and every tab ends exactly in a slot', Math.abs(finalBack[0] - slots[0]) < 1 && Math.abs(finalBack[1] - slots[1]) < 1, finalBack.join(','));

  // 3. Rapid back-and-forth with three tabs never leaves a tab off its slot.
  await main.keyboard.press('Control+t');
  await sleep(400);
  const slots3 = await lefts(main);
  for (const [from, x] of [[0, 900], [2, 0], [1, 900], [0, 500], [2, 60]]) await dragAcross(main, from, Math.min(x, (await main.locator('.tab-new').boundingBox()).x + 100));
  await sleep(300);
  const end3 = await lefts(main);
  ok('five quick drags with three tabs leave every tab in a slot', end3.every((l, i) => Math.abs(l - slots3[i]) < 1), `${end3.join(',')} vs ${slots3.join(',')}`);

  // 4. A click (no movement) selects without reordering; Escape cancels a drag.
  const order4 = await tabNames(main);
  const second = await main.locator('.tabs [role="tab"]').nth(1).boundingBox();
  await main.mouse.click(second.x + 40, second.y + 15);
  await sleep(200);
  const activeName = await main.$eval('.tabs [role="tab"][aria-selected="true"] .tab-name', (n) => n.textContent);
  ok('a click selects the tab and changes nothing else', activeName === order4[1] && (await tabNames(main)).join() === order4.join());
  const first = await main.locator('.tabs [role="tab"]').nth(0).boundingBox();
  await main.mouse.move(first.x + 30, first.y + 15);
  await main.mouse.down();
  for (let x = first.x + 30; x < first.x + 300; x += 10) await main.mouse.move(x, first.y + 15);
  await main.keyboard.press('Escape');
  await main.mouse.up();
  await sleep(400);
  ok('Escape during a drag puts every tab back', (await tabNames(main)).join() === order4.join() && (await lefts(main)).every((l, i) => Math.abs(l - slots3[i]) < 1));

  // 5. Typing a new note's title never moves the strip.
  const rectsBefore = (await lefts(main)).join();
  await main.locator('.tabs [role="tab"]').filter({ hasText: 'Untitled' }).click();
  await main.waitForSelector('.doc-stage[data-visible] .ProseMirror');
  await main.locator('.doc-stage[data-visible] .ProseMirror').click();
  let moved = 0;
  for (const ch of 'A long title typed into the new note') {
    await main.keyboard.type(ch);
    if ((await lefts(main)).join() !== rectsBefore) moved++;
  }
  ok('typing a new note title never moves a tab', moved === 0, `${moved} changes`);

  // 6. Tear a tab off: drag it well below the bar and let go over the page.
  const countBefore = (await tabNames(main)).length;
  const tearName = 'b.md';
  const t = await main.locator('.tabs [role="tab"]').filter({ hasText: tearName }).boundingBox();
  await main.mouse.move(t.x + 40, t.y + 15);
  await main.mouse.down();
  for (let dy = 0; dy <= 260; dy += 20) {
    await main.mouse.move(t.x + 60 + dy / 4, t.y + 15 + dy);
    await sleep(30);
  }
  await sleep(700);
  await main.mouse.up();
  await sleep(1500);
  const labels = await liveLabels();
  const torn = labels.find((l) => l !== 'main');
  const tornPage = torn ? await windowPage(torn) : null;
  const tornTabs = tornPage ? await tabNames(tornPage) : [];
  ok('dragging a tab below the bar opens it in its own window', !!tornPage && tornTabs.length === 1 && tornTabs[0] === tearName && (await tabNames(main)).length === countBefore - 1,
    JSON.stringify({ labels, tornTabs, main: await tabNames(main) }));
  const letter = 'b';
  const tornText = tornPage ? await tornPage.$eval('.doc-stage[data-visible]', (n, l) => n.textContent.includes(`Text of note ${l}`), letter) : false;
  ok('the torn-off window shows the note', tornText);

  // 7. One window per file: opening that file again shows the window that has it.
  if (tornPage) {
    launch([files[letter]]);
    await sleep(1500);
    ok('opening a file another window has open never makes a second tab for it',
      !(await tabNames(main)).includes(tearName) && (await tabNames(tornPage)).includes(tearName),
      JSON.stringify({ main: await tabNames(main), torn: await tabNames(tornPage) }));
  }

  // 7b. A setting changed in one window reaches the other.
  if (tornPage) {
    const themeOf = (page) => page.evaluate(() => document.documentElement.dataset.theme);
    const was = await themeOf(tornPage);
    await main.locator('.statusbar button[aria-label="Switch theme"]').click();
    await sleep(1200);
    const now = await themeOf(tornPage);
    ok('changing the theme in one window changes it in the other', now !== was && now === (await themeOf(main)), `${was} -> ${now}`);
    await main.locator('.statusbar button[aria-label="Switch theme"]').click();
    await sleep(800);
  }

  /** Drags a main-window tab below the bar (it tears off), then to screen point `to`, and lets go. */
  async function tearAndDrop(name, to) {
    const box = await main.locator('.tabs [role="tab"]').filter({ hasText: name }).boundingBox();
    await main.mouse.move(box.x + 40, box.y + 15);
    await main.mouse.down();
    for (let dy = 0; dy <= 200; dy += 20) {
      await main.mouse.move(box.x + 40, box.y + 15 + dy);
      await sleep(30);
    }
    await sleep(900);
    const at = await main.evaluate(() => ({ x: window.screenX, y: window.screenY }));
    for (let i = 1; i <= 6; i++) {
      const cx = box.x + 40 + ((to.x - at.x) - (box.x + 40)) * (i / 6);
      const cy = box.y + 215 + ((to.y - at.y) - (box.y + 215)) * (i / 6);
      await main.mouse.move(cx, cy);
      await sleep(40);
    }
    await main.mouse.up();
    await sleep(2500);
  }
  const stripPoint = (page) => page.evaluate(() => {
    const strip = document.querySelector('.tabs').getBoundingClientRect();
    return { x: window.screenX + strip.right - 30, y: window.screenY + strip.top + strip.height / 2 };
  });

  // 8. Tear a tab off and drop it straight back on its own bar: it comes home, the extra window closes.
  const before8 = await tabNames(main);
  await tearAndDrop('a.md', await stripPoint(main));
  ok('a torn-off tab dropped back on its own bar returns, and the extra window closes',
    (await tabNames(main)).length === before8.length && (await tabNames(main)).includes('a.md') && (await liveLabels()).join() === ['main', torn].sort().join(),
    JSON.stringify({ tabs: await tabNames(main), windows: await liveLabels() }));

  // 9. Tear a tab off and drop it on the other window's bar: it joins that window.
  if (tornPage) {
    await tearAndDrop('a.md', await stripPoint(tornPage));
    ok("a tab dropped on another window's bar joins that window",
      (await tabNames(tornPage)).includes('a.md') && (await tabNames(tornPage)).includes('b.md') && !(await tabNames(main)).includes('a.md') && (await liveLabels()).length === 2,
      JSON.stringify({ main: await tabNames(main), other: await tabNames(tornPage), windows: await liveLabels() }));
  }

  // 10. Both windows closed, then Margin started again: every tab is back in one window.
  const all = [...(await tabNames(main)), ...(tornPage ? await tabNames(tornPage) : [])];
  if (tornPage) {
    await tornPage.locator('.wc-close').click();
    await sleep(1200);
  }
  await main.locator('.wc-close').click();
  await sleep(1500);
  await browser?.close().catch(() => undefined);
  browser = undefined;
  launch([]);
  main = await windowPage('main', 30000);
  await main.waitForSelector('.tabs [role="tab"]');
  await sleep(1200);
  const restored = await tabNames(main);
  ok('after closing both windows, the next start brings every tab back in one window',
    (await liveLabels()).length === 1 && all.every((n) => restored.includes(n)) && restored.length === all.length,
    JSON.stringify({ before: all, restored }));

  ok('no page errors', errors.length === 0, errors.join(' | '));
} finally {
  await browser?.close().catch(() => undefined);
  dispose();
}
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
