import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const browser = process.env.CHROME_PATH ?? [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
if (!browser) throw new Error('Set CHROME_PATH to a Chrome or Chromium executable to run the browser tests.');

const tempRoot = resolve(tmpdir());
const dir = mkdtempSync(join(tempRoot, 'ai-helper-browser-'));
try {
  await build({
    entryPoints: ['tests/sidebar-browser-harness.ts'], bundle: true,
    outfile: join(dir, 'harness.js'), format: 'iife', target: 'chrome120',
  });
  writeFileSync(join(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><body><pre id="result">RUNNING</pre><script src="harness.js"></script></body>');
  const output = execFileSync(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${join(dir, 'profile')}`, '--allow-file-access-from-files',
    '--virtual-time-budget=5000', '--dump-dom', pathToFileURL(join(dir, 'index.html')).href,
  ], { encoding: 'utf8', timeout: 30_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const result = output.match(/<pre id="result">([\s\S]*?)<\/pre>/)?.[1];
  if (!result?.startsWith('PASS:')) {
    throw new Error(result ?? 'No browser result');
  }
  console.log(result);
} finally {
  // Delete only the test directory just created under the verified temp root.
  if (resolve(dir).startsWith(`${tempRoot}\\`) || resolve(dir).startsWith(`${tempRoot}/`)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Browser may still be releasing its profile. */ }
  }
}
