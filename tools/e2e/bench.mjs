// What a user waits for, measured on the real Windows app (the separately built test copy).
// Build: npm run tauri build -- --no-bundle --config tools/e2e/tauri.test.json
// Run:   node tools/e2e/bench.mjs            (prints a table; add --json for machine output)
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { createHarness } from './harness.mjs';

const RUNS = Number(process.env.BENCH_RUNS ?? 3);
const { dir, launch, fresh, kill, verify, dispose } = createHarness('margin-bench-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const p95 = (xs) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))];

const long = path.join(dir, 'long.md');
fs.copyFileSync(path.resolve('public/samples/long.md'), long);
const second = path.join(dir, 'second.md');
fs.writeFileSync(second, '# Second\n\n' + 'A paragraph of ordinary prose for switching tabs. '.repeat(400));
const log = path.join(dir, 'big.log');
const line = '2026-11-18 12:00:00.000 INFO  [worker-3] request handled in 12 ms path=/api/v1/items?id=12345\n';
fs.writeFileSync(log, line.repeat(Math.ceil((20 * 1024 * 1024) / line.length)));

async function attach() {
  for (let i = 0; i < 200; i++) {
    try {
      const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
      const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('tauri.localhost'));
      if (page) {
        await verify(page);
        return { b, page };
      }
      await b.close();
    } catch {
      /* not up yet */
    }
    await sleep(50);
  }
  throw new Error('could not attach');
}

/** Launch → the window is shown with text on screen, from the page's own clock. */
async function coldStart(args, selector) {
  fresh({});
  const started = Date.now();
  launch(args);
  const { b, page } = await attach();
  await page.waitForSelector(selector, { timeout: 30000 });
  const t = await page.evaluate(() => {
    const shown = performance.getEntriesByName('margin-visible')[0]?.startTime ?? NaN;
    return { origin: performance.timeOrigin, shown };
  });
  const visible = t.origin + t.shown - started;
  return { b, page, visible };
}

/** Settles the page heap first, so temporary copies made while loading don't count. */
async function settledMemoryMb(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.collectGarbage").catch(() => undefined);
  await sleep(1000);
  const heap = await cdp.send("Runtime.getHeapUsage").catch(() => null);
  lastHeapMb = heap ? Math.round(heap.usedSize / 1048576) : NaN;
  return memoryMb();
}
let lastHeapMb = NaN;

/** Process-tree private memory (MB) of the running test copy, WebView2 helpers included. */
function memoryMb() {
  const ps = `
$all = Get-CimInstance Win32_Process
$root = $all | Where-Object { $_.Name -eq 'margin.exe' } | Sort-Object CreationDate -Descending | Select-Object -First 1
if (-not $root) { 0; exit }
$ids = @($root.ProcessId); $changed = $true
while ($changed) { $changed = $false; foreach ($p in $all) { if ($ids -contains $p.ParentProcessId -and -not ($ids -contains $p.ProcessId)) { $ids += $p.ProcessId; $changed = $true } } }
($all | Where-Object { $ids -contains $_.ProcessId } | Measure-Object -Property PrivatePageCount -Sum).Sum`;
  const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
  return Math.round(Number(out) / 1048576);
}

/** Keystroke → next painted frame, measured inside the page. */
async function typingLatency(page, chars = 60) {
  await page.evaluate(() => {
    window.__lat = [];
    document.addEventListener('beforeinput', () => {
      const t = performance.now();
      requestAnimationFrame(() => setTimeout(() => window.__lat.push(performance.now() - t), 0));
    }, { capture: true });
  });
  for (let i = 0; i < chars; i++) {
    await page.keyboard.type(i % 12 === 11 ? ' ' : 'x');
    await sleep(25);
  }
  await sleep(300);
  return page.evaluate(() => window.__lat);
}

const rows = [];
const add = (name, values, unit = 'ms') => {
  const v = values.filter(Number.isFinite);
  rows.push({ name, median: Math.round(median(v)), p95: Math.round(p95(v)), unit, n: v.length });
};

try {
  const blank = [];
  const read = [];
  const logOpen = [];
  for (let r = 0; r < RUNS; r++) {
    let s = await coldStart([], '.ProseMirror, .cm-content');
    blank.push(s.visible);
    await s.b.close();
    kill();
    s = await coldStart([long], '.prose.reader h1, .ProseMirror h1');
    read.push(s.visible);
    await s.b.close();
    kill();
    s = await coldStart([log], '.cm-content');
    logOpen.push(s.visible);
    await s.b.close();
    kill();
  }
  add('Cold start, blank note (launch → window shown)', blank);
  add('Cold start, long.md', read);
  add('Cold start, 20 MB log', logOpen);

  // One session for the interactive measurements.
  const { b, page } = await coldStart([long, second], '.prose');
  await sleep(1500);
  const idleMb = await settledMemoryMb(page);

  // Tab switching (Ctrl+Tab) until the other document is on screen.
  const switches = [];
  for (let i = 0; i < 10; i++) {
    const t = Date.now();
    await page.keyboard.press('Control+Tab');
    await page.waitForFunction((n) => document.title.includes(n), i % 2 === 0 ? 'long' : 'second');
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(0))));
    switches.push(Date.now() - t);
  }
  add('Tab switch (Ctrl+Tab → painted)', switches);

  // First Edit, then typing latency in the rich editor.
  let t = Date.now();
  await page.keyboard.press('Control+e');
  await page.waitForSelector('.doc-stage[data-visible] .ProseMirror');
  add('First switch to Edit', [Date.now() - t]);
  await page.click('.doc-stage[data-visible] .ProseMirror p');
  add('Typing in Edit (keystroke → frame)', await typingLatency(page));

  // Save acknowledgement.
  t = Date.now();
  await page.keyboard.press('Control+s');
  await page.waitForSelector('.status-save[data-state="saved"]', { timeout: 10000 });
  add('Save (Ctrl+S → "Saved")', [Date.now() - t]);

  // Typing in the 20 MB log (Source), in a fresh session.
  await b.close();
  kill();
  await sleep(1500); // let the previous WebView2 processes exit before measuring the next session
  const big = await coldStart([log], '.cm-content');
  await big.page.click('.cm-content');
  await big.page.keyboard.press('Control+End');
  add('Typing in a 20 MB log (keystroke → frame)', await typingLatency(big.page, 40));
  await sleep(6000); // steady state: a few seconds after typing stops
  const bigMb = await settledMemoryMb(big.page);
  const bigHeap = lastHeapMb;
  await big.b.close();

  rows.push({ name: 'Memory, two notes open (process tree, private)', median: idleMb, p95: idleMb, unit: 'MB', n: 1 });
  rows.push({ name: 'Memory, 20 MB log open and edited', median: bigMb, p95: bigMb, unit: 'MB', n: 1 });
  rows.push({ name: '  of which JavaScript heap', median: bigHeap, p95: bigHeap, unit: 'MB', n: 1 });

  if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
  else {
    console.log('\nMargin benchmark (' + RUNS + ' cold runs each)\n');
    for (const r of rows) console.log(`${r.name.padEnd(52)} median ${String(r.median).padStart(6)} ${r.unit}   p95 ${String(r.p95).padStart(6)} ${r.unit}   (n=${r.n})`);
  }
} finally {
  dispose();
}
