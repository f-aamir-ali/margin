import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const identifier = 'com.faamirali.margin.e2e';

/** Keep process kills and config resets confined to a separately built copy of Margin. */
export function createHarness(prefix) {
  const exe = path.resolve(process.env.MARGIN_E2E_EXE ?? 'src-tauri/target/release/margin.exe');
  if (!fs.readFileSync(exe).includes(Buffer.from(identifier))) {
    throw new Error('Build the test copy first: npm run tauri build -- --no-bundle --config tools/e2e/tauri.test.json');
  }
  const config = path.join(process.env.APPDATA, identifier);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const lock = `${config}.lock`;
  const fd = fs.openSync(lock, 'wx');
  const children = new Set();
  const launch = (args) => {
    const child = spawn(exe, args, {
      env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9333' },
      stdio: 'ignore',
    });
    children.add(child);
    child.once('exit', () => children.delete(child));
    return child;
  };
  const kill = () => {
    for (const child of children) {
      if (child.pid && child.exitCode === null) {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      }
    }
  };
  const fresh = (settings = {}) => {
    kill();
    fs.rmSync(config, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(config, { recursive: true });
    fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify(settings));
    fs.writeFileSync(path.join(config, 'seen-tour.json'), 'true');
  };
  const verify = async (page) => {
    const info = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('app_info'));
    if (path.resolve(info.configDir).toLowerCase() !== path.resolve(config).toLowerCase()) {
      throw new Error('Refusing to drive a Margin instance with a different profile');
    }
  };
  const dispose = () => {
    kill();
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  };
  return { dir, config, launch, kill, fresh, verify, dispose, running: () => children.size > 0, count: () => children.size };
}
