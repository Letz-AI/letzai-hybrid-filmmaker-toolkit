#!/usr/bin/env node
// Dev tool: take full-size screenshots of the running kit with headless Chrome/Edge (no dependencies).
//
//   node scripts/screenshot.mjs --base http://127.0.0.1:4747 --token <token> --spec steps.json [--width 1440] [--height 900] [--theme dark|light]
//
// steps.json: [{ "route": "#/board", "wait": 1500, "eval": "document.querySelector('#x').click()", "out": "board.png" }, ...]
// Used for the README screenshots and for checking layouts without a visible browser.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (typeof WebSocket === 'undefined') { console.error('This helper needs Node 22 or newer (it uses the built-in WebSocket).'); process.exit(1); }
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), []));
const base = args.base || 'http://127.0.0.1:4747';
const W = +args.width || 1440;
const H = +args.height || 900;
const steps = JSON.parse(fs.readFileSync(args.spec, 'utf8').replace(/^﻿/, ''));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  const c = [];
  if (process.platform === 'win32') {
    for (const b of [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA]) {
      if (b) c.push(path.join(b, 'Microsoft/Edge/Application/msedge.exe'), path.join(b, 'Google/Chrome/Application/chrome.exe'));
    }
  } else if (process.platform === 'darwin') c.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  else c.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  return c.find((x) => fs.existsSync(x));
}

const browser = args.browser || findBrowser();
if (!browser) { console.error('No Chrome or Edge found.'); process.exit(1); }
const port = 9333 + Math.floor(Math.random() * 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-shot-'));
const proc = spawn(browser, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--headless=new', '--hide-scrollbars', '--no-first-run', '--disable-gpu', '--mute-audio', '--autoplay-policy=no-user-gesture-required', `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });

async function cdpTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Browser did not start');
}

const ws = new WebSocket(await cdpTarget());
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
const events = [];
ws.addEventListener('message', (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { const { resolve, reject } = pending.get(d.id); pending.delete(d.id); d.error ? reject(new Error(d.error.message)) : resolve(d.result); } else events.push(d);
});
const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
if (args.theme) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: args.theme }] });
await send('Page.navigate', { url: `${base}/?k=${args.token}` });
await sleep(1500);
if (args.theme) await send('Runtime.evaluate', { expression: `localStorage.setItem('theme','${args.theme}'); document.documentElement.setAttribute('data-theme','${args.theme}')` });

for (const s of steps) {
  if (s.route) await send('Runtime.evaluate', { expression: `location.hash = ${JSON.stringify(s.route)}` });
  await sleep(s.wait ?? 1500);
  if (s.eval) {
    const r = await send('Runtime.evaluate', { expression: `(async () => { ${s.eval} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) console.error('eval error:', r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    else if (r.result && r.result.value !== undefined) console.log(`${s.out || s.route || 'eval'}: ${typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value)}`);
    await sleep(s.after ?? 600);
  }
  if (s.out) {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(path.resolve(s.out)), { recursive: true });
    fs.writeFileSync(s.out, Buffer.from(shot.data, 'base64'));
    console.log(`saved ${s.out}`);
  }
}
const errs = events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'));
for (const e of errs) console.error('page error:', JSON.stringify(e.params.exceptionDetails ? e.params.exceptionDetails.exception?.description : e.params.args.map((a) => a.value || a.description)));
ws.close();
proc.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(0);
