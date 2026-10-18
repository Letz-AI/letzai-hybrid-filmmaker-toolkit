#!/usr/bin/env node
'use strict';
// HTTP server: serves the UI, a small JSON API, media with Range support, and live events (SSE).
// Bound to 127.0.0.1 only. Every request needs a per-launch token cookie (see `guard`), so other websites
// you happen to have open can't talk to the kit, even though it is "just localhost".
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { URL } = require('url');
const { App } = require('./app');
const cfg = require('./lib/config');
const canvas = require('./lib/canvas');
const vision = require('./lib/vision');
const slate = require('./lib/slate');
const { httpError } = require('./lib/util');

/** What the UI needs to know about reading slates with Claude. The key itself never leaves the server. */
const visionInfo = () => ({ key: { set: !!cfg.getAnthropicKey(), source: cfg.anthropicKeySource() }, ...cfg.visionSettings(), models: vision.MODELS });

const UI_DIR = path.join(__dirname, '..', 'ui');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.mov': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.csv': 'text/csv; charset=utf-8',
};

function createServer({ token, port, app: injected }) {
  const app = injected || new App();
  const sse = new Set();
  const startedAt = Date.now();
  const send = (event, data) => { const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; for (const r of sse) r.write(msg); };
  let libTimer = null;
  app.on('job', (j) => send('job', j));
  app.on('jobs', (l) => send('jobs', l));
  app.on('library', () => { clearTimeout(libTimer); libTimer = setTimeout(() => send('library', {}), 150); });
  app.on('project', () => send('project', {}));
  app.on('proxy', (e) => send('proxy', e));
  app.on('problem', (m) => send('problem', { message: m }));

  const json = (res, status, body) => {
    const s = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(s);
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > 2e6) { reject(httpError(413, 'Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(httpError(400, 'Invalid JSON')); } });
    req.on('error', reject);
  });

  function guard(req, url) {
    const host = (req.headers.host || '').toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw httpError(403, 'Bad host');
    const cookie = Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2));
    if (cookie.kit === token) return true;
    if (url.pathname === '/' && url.searchParams.get('k') === token) return 'login';
    return false;
  }

  function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(UI_DIR, rel));
    if (!file.startsWith(UI_DIR)) throw httpError(403, 'Forbidden');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw httpError(404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }

  function serveFile(req, res, file, type) {
    const st = fs.statSync(file);
    const ct = type || MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && (range[1] || range[2])) {
      let start = range[1] ? parseInt(range[1], 10) : st.size - parseInt(range[2], 10);
      let end = range[1] && range[2] ? parseInt(range[2], 10) : st.size - 1;
      start = Math.max(0, start); end = Math.min(st.size - 1, end);
      if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { 'Content-Type': ct, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' });
      const rs = fs.createReadStream(file, { start, end });
      rs.on('error', () => res.destroy());
      res.on('close', () => rs.destroy());
      return rs.pipe(res);
    }
    res.writeHead(200, { 'Content-Type': ct, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' });
    const rs = fs.createReadStream(file);
    rs.on('error', () => res.destroy());
    res.on('close', () => rs.destroy());
    return rs.pipe(res);
  }

  // ---- routes ---------------------------------------------------------------
  const routes = {
    'GET /api/info': async () => app.info(),
    'GET /api/doctor': async () => {
      const ff = require('./lib/ffmpeg');
      const loc = ff.locate();
      const enc = loc.ok ? await ff.pickEncoder('auto') : null;
      return { ffmpeg: loc.ok ? { path: loc.ffmpeg, version: loc.version } : null, encoder: enc ? enc.name : null, system: ff.describeSystem(), dirs: { config: cfg.configDir(), cache: cfg.cacheDir() } };
    },

    'POST /api/project/open': async ({ body }) => { await app.openProject(body.root); return app.project.snapshot(); },
    'POST /api/project/create': async ({ body }) => { await app.createProject(body); return app.project.snapshot(); },
    'POST /api/project/close': async () => { await app.closeProject(); return { ok: true }; },
    'POST /api/project/forget': async ({ body }) => { await cfg.forgetProject(body.root); return { ok: true }; },
    'PATCH /api/project': async ({ body }) => { await app.requireProject().updateSettings(body); return app.project.snapshot(); },

    'GET /api/library': async () => app.requireProject().snapshot(),
    'POST /api/rescan': async () => { await app.requireProject().scan(); return app.project.snapshot(); },
    'GET /api/folders/discover': async () => ({ folders: app.requireProject().discoverFolders() }),

    'PATCH /api/clip': async ({ body }) => ({ clip: await app.requireProject().setMeta(body.key, body.patch || {}) }),
    'POST /api/clip/rename': async ({ body }) => app.requireProject().renameClip(body.key, body),
    'POST /api/rename/undo': async () => app.requireProject().undo(),
    'POST /api/rename-many': async ({ body }) => app.requireProject().renameMany(body.items, { apply: !!body.apply }),
    'GET /api/rename-all/preview': async () => app.requireProject().renameAllPreview(),
    'POST /api/rename-all': async () => app.requireProject().renameAll(),
    'GET /api/next-take': async ({ url }) => ({ take: app.requireProject().nextTake(url.searchParams.get('scene'), url.searchParams.get('shot')) }),

    'PUT /api/shotlist': async ({ body }) => app.requireProject().setShotListText(body.text),
    'POST /api/shotlist/seed': async () => ({ text: app.requireProject().seedShotListFromFootage() }),
    'POST /api/shotlist/edit': async ({ body }) => { app.requireProject().editPlan(body); return { ok: true }; },
    'POST /api/shotlist/preview': async ({ body }) => require('./lib/shotlist').parseShotListText(body.text),
    'POST /api/import-log': async ({ body }) => {
      const p = app.requireProject();
      const file = body.path || path.join(p.root, 'continuity-log.csv');
      if (!fs.existsSync(file)) throw httpError(404, `No continuity log at ${file}`);
      return p.importContinuityLog(file);
    },

    'GET /api/playback': async ({ url }) => app.requireProject().playback(url.searchParams.get('key'), { hevc: url.searchParams.get('hevc') === '1' }),
    'GET /api/proxy-status': async () => app.requireProject().proxyStatus(),
    'POST /api/client-caps': async ({ body }) => { app.requireProject().setClientCaps({ hevc: !!body.hevc }); return { ok: true }; },
    'POST /api/proxies': async ({ body }) => {
      const p = app.requireProject();
      const keys = body.keys && body.keys.length ? body.keys : p.library.filter((e) => !e.probe || !require('./lib/ffmpeg').browserSafe(e.probe, e.abs)).map((e) => e.key);
      return { queued: keys.map((k) => p.ensureProxy(p.entry(k), { background: true, priority: 0 }).id).length };
    },

    'POST /api/cuts': async ({ body }) => {
      const p = app.requireProject();
      return { jobs: body.keys.map((key) => app.jobs.add({ lane: 'cut', title: `Cut · ${p.entry(key).name}`, dedupeKey: `cut:${key}`, run: (ctx) => p.makeCuts(key, ctx) }).id) };
    },

    'GET /api/canvas/status': async () => app.canvasStatus(),
    'GET /api/canvas/list': async ({ url }) => ({ canvases: (await app.client.listCanvases(url.searchParams.get('search') || '').catch((e) => { throw httpError(e.status || 500, canvas.explain(e)); })).map((c) => ({ id: c.id, name: c.name, updatedAt: c.updatedAt, thumbnail: c.thumbnail })) }),
    'GET /api/canvas/pages': async ({ url }) => {
      const c = await app.client.getCanvas(url.searchParams.get('canvasId')).catch((e) => { throw httpError(e.status || 500, canvas.explain(e)); });
      return { name: c.name, defaultPageId: c.defaultPageId, pages: (c.pages || []).map((p) => ({ id: p.id, name: p.name, nodeCount: p.nodeCount })) };
    },
    'POST /api/canvas/send': async ({ body }) => ({ jobs: app.sendToCanvas(body.keys).map((j) => j.id) }),
    'POST /api/canvas/sort': async () => app.sortCanvas().catch((e) => { throw httpError(e.status || 500, canvas.explain(e)); }),
    'POST /api/canvas/pages': async () => ({ pages: await app.canvasPages(true).catch((e) => { throw httpError(e.status || 500, canvas.explain(e)); }) }),
    'POST /api/canvas/labels': async ({ body }) => app.createLabels(body.scenes || []).catch((e) => { throw httpError(e.status || 500, canvas.explain(e)); }),
    // Claude reads slates (Anthropic API, the user's own key)
    'GET /api/vision': async () => visionInfo(),
    'PUT /api/vision': async ({ body }) => {
      if (typeof body.key === 'string') await cfg.setAnthropicKey(body.key);
      const patch = {};
      if (body.model != null) { if (!vision.MODELS.some((m) => m.id === body.model)) throw httpError(400, 'Unknown model.'); patch.model = body.model; }
      if (body.consent != null) patch.consent = !!body.consent;
      if (Object.keys(patch).length) await cfg.setVisionSettings(patch);
      return visionInfo();
    },
    'POST /api/vision/test': async ({ body }) => {
      const key = typeof body.key === 'string' && body.key.trim() ? body.key.trim() : undefined;
      const r = await vision.verifyKey({ key, model: body.model });
      if (key && body.save) await cfg.setAnthropicKey(key);
      return { ...r, ...visionInfo() };
    },
    'POST /api/slate/estimate': async ({ body }) => slate.estimate(app.requireProject(), body.keys || [], { force: !!body.force }),
    'POST /api/slate/read': async ({ body }) => {
      const p = app.requireProject();
      if (!cfg.getAnthropicKey()) throw httpError(400, 'Add your Anthropic API key first.', { code: 'no-vision-key' });
      if (!cfg.visionSettings().consent) throw httpError(400, 'Confirm first that frames from your clips may be sent to Anthropic.', { code: 'no-consent' });
      const keys = (body.keys || []).filter((k) => p.byKey.has(k));
      if (!keys.length) throw httpError(400, 'Choose at least one clip.');
      const model = cfg.visionSettings().model;
      const job = app.jobs.add({ lane: 'vision', title: `Reading slates · ${keys.length === 1 ? p.byKey.get(keys[0]).name : `${keys.length} clips`}`, detail: `Claude · ${model}`, run: (ctx) => slate.readMany(p, keys, { model, force: !!body.force, signal: ctx.signal, progress: ctx.progress }) });
      return { job: job.id };
    },
    'POST /api/slate/clear': async ({ body }) => ({ cleared: slate.clear(app.requireProject(), body.keys || []) }),

    'PUT /api/key': async ({ body }) => { await cfg.setKey(body.key); return app.info().key; },

    'POST /api/jobs/cancel': async ({ body }) => ({ ok: app.jobs.cancel(body.id) }),
    'POST /api/jobs/clear': async () => { app.jobs.clearFinished(); return { ok: true }; },
    'GET /api/jobs': async () => ({ jobs: app.jobs.snapshot() }),

    'POST /api/selects': async ({ body }) => {
      const p = app.requireProject();
      const dest = path.resolve(String(body.dest || ''));
      if (!body.dest) throw httpError(400, 'Choose a destination folder.');
      return { job: app.jobs.add({ lane: 'misc', title: 'Copy selects', detail: dest, run: (ctx) => p.copySelects(dest, ctx) }).id };
    },

    'POST /api/ai/add': async ({ body }) => ({ added: await app.requireProject().addAi(body.key, body.items) }),
    'POST /api/ai/update': async ({ body }) => ({ ai: app.requireProject().updateAi(body.key, body.id, body.patch || {}) }),
    'POST /api/ai/remove': async ({ body }) => { app.requireProject().removeAi(body.key, body.id); return { ok: true }; },
    'POST /api/ai/suggest': async ({ body }) => ({ suggestions: app.requireProject().suggestAi(body.names) }),
    'GET /api/ai/playback': async ({ url }) => app.requireProject().aiPlayback(url.searchParams.get('key'), url.searchParams.get('id'), { hevc: url.searchParams.get('hevc') === '1' }),
    'GET /api/canvas/media': async () => ({ media: await app.canvasMedia().catch((e) => { throw httpError(e.status || 500, canvas.explain(e)); }) }),
    'POST /api/pick-files': async ({ body }) => ({ paths: await pickFiles(body.title || 'Choose videos', body.start) }),
    'POST /api/pick-folder': async ({ body }) => ({ path: await pickFolder(body.title || 'Choose a folder', body.start) }),
    'GET /api/browse': async ({ url }) => browse(url.searchParams.get('dir')),
    'POST /api/reveal': async ({ body }) => {
      const p = app.requireProject();
      const target = body.key ? p.absOf(body.key) : path.resolve(body.path || p.root);
      reveal(target);
      return { ok: true };
    },
  };

  async function handle(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    try {
      const g = guard(req, url);
      if (!g) {
        res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Open the kit with the link printed in your terminal (it includes a one-time key).');
      }
      if (g === 'login') {
        res.writeHead(302, { 'Set-Cookie': `kit=${token}; HttpOnly; SameSite=Strict; Path=/`, Location: '/' });
        return res.end();
      }
      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(`event: hello\ndata: ${JSON.stringify({ jobs: app.jobs.snapshot(), startedAt })}\n\n`);
        sse.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 20000);
        req.on('close', () => { clearInterval(ping); sse.delete(res); });
        return undefined;
      }
      if (url.pathname === '/media') {
        const p = app.requireProject();
        const e = p.entry(url.searchParams.get('key'));
        const file = p.mediaPath(e, url.searchParams.get('src'));
        if (!fs.existsSync(file)) throw httpError(404, 'Media not found');
        return serveFile(req, res, file, 'video/mp4');
      }
      if (url.pathname === '/ai-media') {
        const p = app.requireProject();
        const file = p.aiMediaPath(url.searchParams.get('key'), url.searchParams.get('id'), url.searchParams.get('src'));
        if (!fs.existsSync(file)) throw httpError(404, 'Media not found');
        return serveFile(req, res, file, 'video/mp4');
      }
      if (url.pathname === '/thumb') {
        const f = await app.requireProject().thumb(url.searchParams.get('key'), url.searchParams.get('t'), url.searchParams.get('w'));
        return serveFile(req, res, f, 'image/jpeg');
      }
      if (url.pathname === '/strip') {
        const q = url.searchParams;
        const f = await app.requireProject().strip(q.get('key'), q.get('from'), q.get('to'), q.get('n'), q.get('w'));
        return serveFile(req, res, f, 'image/jpeg');
      }
      const rep = /^\/api\/report\/(\w+)\.csv$/.exec(url.pathname);
      if (rep && req.method === 'GET') {
        const csv = app.requireProject().report(rep[1]);
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${app.project.state.prefix}-${rep[1]}.csv"` });
        return res.end(csv);
      }
      const route = routes[`${req.method} ${url.pathname}`];
      if (route) {
        const body = req.method === 'GET' ? {} : await readBody(req);
        return json(res, 200, await route({ req, url, body }));
      }
      if (url.pathname.startsWith('/api/')) throw httpError(404, 'Unknown endpoint');
      return serveStatic(req, res, url);
    } catch (e) {
      const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
      if (status === 500) console.error(e);
      if (res.headersSent) return res.destroy();
      return json(res, status, { error: e.message, code: e.code, ...(e.suggestion ? { suggestion: e.suggestion } : {}) });
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  return { server, app };
}

// ---- OS helpers -------------------------------------------------------------
function hasCommand(name) {
  const r = require('child_process').spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore' });
  return r.status === 0;
}

function pickFolder(title, start) {
  return new Promise((resolve, reject) => {
    let cmd; let args;
    if (process.platform === 'win32') {
      const ps = `Add-Type -AssemblyName System.Windows.Forms; $o = New-Object System.Windows.Forms.Form; $o.TopMost = $true; $o.ShowInTaskbar = $false; $o.Opacity = 0; $o.StartPosition = 'CenterScreen'; $o.Show(); $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = $env:KIT_TITLE; $f.ShowNewFolderButton = $true; if ($env:KIT_START -and (Test-Path -LiteralPath $env:KIT_START)) { $f.SelectedPath = $env:KIT_START }; if ($f.ShowDialog($o) -eq 'OK') { [Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Output $f.SelectedPath }; $o.Close()`;
      cmd = 'powershell.exe'; args = ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-Command', ps];
    } else if (process.platform === 'darwin') {
      cmd = 'osascript'; args = ['-e', `POSIX path of (choose folder with prompt "${title.replace(/"/g, '')}")`];
    } else {
      cmd = hasCommand('zenity') ? 'zenity' : 'kdialog';
      args = cmd === 'zenity' ? ['--file-selection', '--directory', `--title=${title}`] : ['--getexistingdirectory', start || os.homedir(), '--title', title];
    }
    const p = spawn(cmd, args, { env: { ...process.env, KIT_TITLE: title, KIT_START: start || '' }, windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => reject(httpError(501, 'No native folder dialog is available here. Type the path instead.')));
    p.on('close', () => resolve(out.trim().replace(/\/$/, '') || null));
  });
}

/** A native "choose files" dialog. Returns the chosen paths (empty when cancelled). */
function pickFiles(title, start) {
  return new Promise((resolve, reject) => {
    let cmd; let args;
    if (process.platform === 'win32') {
      const ps = "Add-Type -AssemblyName System.Windows.Forms; $o = New-Object System.Windows.Forms.Form; $o.TopMost = $true; $o.ShowInTaskbar = $false; $o.Opacity = 0; $o.StartPosition = 'CenterScreen'; $o.Show(); $f = New-Object System.Windows.Forms.OpenFileDialog; $f.Title = $env:KIT_TITLE; $f.Multiselect = $true; $f.Filter = 'Video files|*.mp4;*.mov;*.m4v;*.mkv;*.webm;*.avi|All files|*.*'; if ($env:KIT_START -and (Test-Path -LiteralPath $env:KIT_START)) { $f.InitialDirectory = $env:KIT_START }; if ($f.ShowDialog($o) -eq 'OK') { [Console]::OutputEncoding = [Text.Encoding]::UTF8; $f.FileNames | ForEach-Object { Write-Output $_ } }; $o.Close()";
      cmd = 'powershell.exe'; args = ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-Command', ps];
    } else if (process.platform === 'darwin') {
      cmd = 'osascript';
      args = ['-e', `set fs to choose file with prompt "${title.replace(/"/g, '')}" with multiple selections allowed`, '-e', 'set out to ""', '-e', 'repeat with f in fs', '-e', 'set out to out & POSIX path of f & linefeed', '-e', 'end repeat', '-e', 'return out'];
    } else if (hasCommand('zenity')) {
      cmd = 'zenity'; args = ['--file-selection', '--multiple', '--separator=\n', `--title=${title}`];
    } else {
      cmd = 'kdialog'; args = ['--getopenfilename', start || os.homedir(), 'Video (*.mp4 *.mov *.m4v *.mkv *.webm *.avi)', '--multiple', '--separate-output', '--title', title];
    }
    const p = spawn(cmd, args, { env: { ...process.env, KIT_TITLE: title, KIT_START: start || '' }, windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => reject(httpError(501, 'No native file dialog is available here. Paste the file path instead.')));
    p.on('close', () => resolve(out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)));
  });
}

function browse(dir) {
  const here = path.resolve(dir || os.homedir());
  const entries = [];
  try {
    for (const e of fs.readdirSync(here, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.')) entries.push({ name: e.name, path: path.join(here, e.name) });
    }
  } catch (err) { throw httpError(404, `Can't read ${here}`); }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  const roots = process.platform === 'win32' ? 'CDEFGHIJ'.split('').map((l) => `${l}:\\`).filter((d) => fs.existsSync(d)) : ['/'];
  return { dir: here, parent: path.dirname(here) !== here ? path.dirname(here) : null, entries, roots, home: os.homedir() };
}

function reveal(target) {
  if (process.platform === 'win32') {
    if (fs.existsSync(target) && fs.statSync(target).isFile()) spawn('explorer.exe', [`/select,${target}`], { windowsHide: false, detached: true }).unref();
    else spawn('explorer.exe', [target], { detached: true }).unref();
  } else if (process.platform === 'darwin') spawn('open', ['-R', target], { detached: true }).unref();
  else spawn('xdg-open', [fs.existsSync(target) && fs.statSync(target).isFile() ? path.dirname(target) : target], { detached: true }).unref();
}

// ---- launching --------------------------------------------------------------
function findAppBrowser() {
  const c = [];
  if (process.platform === 'win32') {
    for (const base of [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA]) {
      if (!base) continue;
      c.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(base, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'));
    }
  } else if (process.platform === 'darwin') {
    c.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser');
  } else {
    c.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge');
  }
  return c.find((x) => fs.existsSync(x));
}

function openUi(url, { appMode }) {
  const browser = appMode ? findAppBrowser() : null;
  if (browser) {
    const profile = path.join(cfg.cacheDir(), 'app-window');
    spawn(browser, [`--app=${url}`, `--user-data-dir=${profile}`, '--window-size=1500,940', '--no-first-run', '--no-default-browser-check'], { detached: true, stdio: 'ignore' }).unref();
    return 'app window';
  }
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  return 'browser';
}

/** `npm run check`: is this computer ready? Prints what is found and what to install if something is missing. */
async function runCheck() {
  const ff = require('./lib/ffmpeg');
  const ok = (b) => (b ? 'ok     ' : 'MISSING');
  const hint = { win32: { ffmpeg: 'winget install Gyan.FFmpeg', node: 'winget install OpenJS.NodeJS.LTS' }, darwin: { ffmpeg: 'brew install ffmpeg', node: 'brew install node' }, linux: { ffmpeg: 'sudo apt install ffmpeg   (or your distribution\'s package manager)', node: 'https://nodejs.org (or your distribution\'s package manager)' } }[process.platform] || { ffmpeg: 'https://ffmpeg.org/download.html', node: 'https://nodejs.org' };
  const nodeOk = parseInt(process.versions.node, 10) >= 20;
  const loc = ff.locate(true);
  const enc = loc.ok ? await ff.pickEncoder('auto').catch(() => null) : null;
  const dialog = process.platform === 'win32' ? true : process.platform === 'darwin' ? hasCommand('osascript') : (hasCommand('zenity') || hasCommand('kdialog'));
  const browser = findAppBrowser();
  const lines = [
    '',
    '  LetzAI Hybrid Filmmaker Kit: setup check',
    '',
    `  ${ok(nodeOk)}  Node.js ${process.versions.node}${nodeOk ? '' : `  (20 or newer is needed: ${hint.node})`}`,
    `  ${ok(loc.ok)}  ffmpeg ${loc.ok ? `${loc.version}  ${loc.ffmpeg}` : `not found. Install it: ${hint.ffmpeg}`}`,
    `  ${ok(loc.ok)}  ffprobe ${loc.ok ? '' : `not found (it comes with ffmpeg)${loc.missing === 'ffprobe' ? ': ffmpeg was found but ffprobe was not' : ''}`}`,
    `  ${ok(!!enc)}  video encoder: ${enc ? `${enc.name}${enc.name === 'libx264' ? '  (processor only: fine, just slower for 4K)' : '  (hardware)'}` : 'unknown until ffmpeg is installed'}`,
    `  ${ok(!!browser)}  app window: ${browser ? browser : 'no Chrome, Edge or Brave found, the kit will open in your default browser instead (that works fine)'}`,
    `  ${ok(dialog)}  folder dialog: ${dialog ? 'available' : 'not available here. You can still paste a folder path instead'}`,
    `          system: ${process.platform} ${process.arch}, ${require('os').cpus().length} cores`,
    `          settings and API key: ${require('./lib/config').configDir()}`,
    `          cache (review copies): ${require('./lib/config').cacheDir()}`,
    '',
    nodeOk && loc.ok ? '  Ready. Start the kit with:  npm start' : '  Not ready yet: fix the lines marked MISSING above, then run this check again.',
    '',
  ];
  console.log(lines.join('\n'));
  return nodeOk && loc.ok ? 0 : 1;
}

async function main() {
  if (parseInt(process.versions.node, 10) < 20) {
    console.error(`\n  Node.js 20 or newer is needed (you have ${process.versions.node}). Get it at https://nodejs.org\n`);
    process.exit(1);
  }
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes(`--${n}`);
  const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  if (flag('check')) process.exit(await runCheck());
  const token = process.env.LETZAI_KIT_TOKEN || crypto.randomBytes(24).toString('hex');
  let port = parseInt(opt('port') || process.env.PORT || '4747', 10);

  for (let tries = 0; tries < 30; tries++, port++) {
    const { server, app } = createServer({ token, port });
    const ok = await new Promise((resolve) => {
      server.once('error', (e) => resolve(e.code === 'EADDRINUSE' ? false : Promise.reject(e)));
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (!ok) continue;
    const url = `http://127.0.0.1:${port}/?k=${token}`;
    console.log('\n  LetzAI Hybrid Filmmaker Kit');
    console.log(`  Running at ${url}\n`);
    if (!flag('no-open')) console.log(`  Opened in ${openUi(url, { appMode: !flag('browser') })}. Close this window to stop the kit.\n`);
    const initial = opt('project');
    if (initial) app.openProject(initial).then(() => console.log(`  Opened project ${app.project.state.name}`)).catch((e) => console.error(`  Could not open project: ${e.message}`));
    const stop = async () => { try { if (app.project) await app.project.saveNow(); } catch { /* ignore */ } process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }
  console.error('Could not find a free port.');
  process.exit(1);
}

if (require.main === module) main();

module.exports = { createServer, main };
