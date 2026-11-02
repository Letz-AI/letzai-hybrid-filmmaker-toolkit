'use strict';
// HTTP-level test: security guard, project lifecycle, media range requests, reports, undo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-srv-'));
process.env.LETZAI_KIT_HOME = path.join(tmp, 'home');
const ff = require('../server/lib/ffmpeg');
const { createServer } = require('../server/index.js');
const { until } = require('./helpers/wait');

const loc = ff.locate(true);
const skip = !loc.ok && 'ffmpeg not installed';
const TOKEN = 'test-token-abc';

let server; let port; let cookie = '';

function req(method, url, { body, headers = {}, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, path: url, method, headers: { Host: host || `127.0.0.1:${port}`, ...(cookie ? { Cookie: cookie } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, buf, json, text: buf.toString('utf8') });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

test.before(async () => {
  ({ server } = createServer({ token: TOKEN, port: 0 }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  // the guard compares Host with the configured port, so rebuild the server with the real one
  server.close();
  ({ server } = createServer({ token: TOKEN, port }));
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
});
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('requests without the launch token are refused', async () => {
  assert.equal((await req('GET', '/api/info')).status, 401);
  assert.equal((await req('GET', '/')).status, 401);
  assert.equal((await req('GET', '/?k=wrong')).status, 401);
});

test('a foreign Host header is refused (DNS rebinding)', async () => {
  const r = await req('GET', `/?k=${TOKEN}`, { host: 'evil.example.com' });
  assert.equal(r.status, 403);
});

test('the launch link sets a strict cookie and serves the app', async () => {
  const r = await req('GET', `/?k=${TOKEN}`);
  assert.equal(r.status, 302);
  const set = r.headers['set-cookie'][0];
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  cookie = set.split(';')[0];
  const home = await req('GET', '/');
  assert.equal(home.status, 200);
  assert.match(home.text, /LetzAI Hybrid Filmmaker Kit/);
  assert.equal((await req('GET', '/js/app.js')).status, 200);
  assert.equal((await req('GET', '/..%2F..%2Fpackage.json')).status, 403);
  assert.equal((await req('GET', '/api/nope')).status, 404);
});

test('info reports setup state', async () => {
  const r = await req('GET', '/api/info');
  assert.equal(r.status, 200);
  assert.equal(typeof r.json.ffmpeg.ok, 'boolean');
  assert.equal(r.json.project, null);
  assert.equal(r.json.key.set, false);
});

test('project lifecycle, media range requests, reports, rename and undo', { skip }, async () => {
  const film = path.join(tmp, 'film');
  fs.mkdirSync(film, { recursive: true });
  for (const n of ['A001_C001.mp4', 'Film-scene1-shot1-take1.mp4']) {
    const r = spawnSync(loc.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=2', '-f', 'lavfi', '-i', 'sine=duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(film, n)]);
    assert.equal(r.status, 0);
  }
  assert.equal((await req('POST', '/api/project/open', { body: { root: film } })).json.code, 'no-project');
  const created = await req('POST', '/api/project/create', { body: { root: film, name: 'T', prefix: 'Film' } });
  assert.equal(created.status, 200, created.text);
  assert.equal(created.json.clips.length, 2);
  assert.equal((await req('POST', '/api/project/create', { body: { root: film } })).status, 409);

  // wait for probing
  let lib;
  await until(async () => { lib = (await req('GET', '/api/library')).json; return lib.clips.every((c) => c.probe); }, 'every clip to be probed');
  const raw = lib.clips.find((c) => c.kind === 'raw');
  const named = lib.clips.find((c) => c.kind === 'shot');
  assert.ok(raw && named);

  // playback resolves to the original (H.264 mp4) and Range requests work
  const pb = (await req('GET', `/api/playback?key=${encodeURIComponent(named.key)}`)).json;
  assert.equal(pb.kind, 'original');
  const full = await req('GET', pb.url);
  assert.equal(full.status, 200);
  assert.equal(full.headers['accept-ranges'], 'bytes');
  const part = await req('GET', pb.url, { headers: { Range: 'bytes=0-99' } });
  assert.equal(part.status, 206);
  assert.equal(part.buf.length, 100);
  assert.match(part.headers['content-range'], /^bytes 0-99\//);
  assert.equal((await req('GET', pb.url, { headers: { Range: `bytes=${full.buf.length + 10}-` } })).status, 416);

  // thumbnails
  const th = await req('GET', `/thumb?key=${encodeURIComponent(named.key)}&t=0.5&w=320`);
  assert.equal(th.status, 200);
  assert.equal(th.headers['content-type'], 'image/jpeg');

  // rename conflicts and undo
  const clash = await req('POST', '/api/clip/rename', { body: { key: raw.key, scene: '1', shot: '1', take: 1 } });
  assert.equal(clash.status, 409);
  assert.equal(clash.json.suggestion.take, 2);
  const ok = await req('POST', '/api/clip/rename', { body: { key: raw.key, scene: '1', shot: '1', take: 2 } });
  assert.equal(ok.status, 200, ok.text);
  assert.ok(fs.existsSync(path.join(film, 'Film-scene1-shot1-take2.mp4')));
  assert.equal((await req('POST', '/api/rename/undo')).status, 200);
  assert.ok(fs.existsSync(path.join(film, 'A001_C001.mp4')));

  // rating, shot list, coverage
  const named2 = (await req('GET', '/api/library')).json.clips.find((c) => c.kind === 'shot');
  await req('PATCH', '/api/clip', { body: { key: named2.key, patch: { rating: 'good', print: true } } });
  const sl = await req('PUT', '/api/shotlist', { body: { text: 'Scene 1\n1.1 Wide\n1.2 Close\n' } });
  assert.deepEqual([sl.json.scenes, sl.json.shots], [1, 2]);
  const cov = (await req('GET', '/api/library')).json.coverage;
  assert.deepEqual(cov.scenes[0].shots.map((s) => s.status), ['selected', 'missing']);
  assert.equal(cov.totals.missing, 1);
  const missing = await req('GET', '/api/report/missing.csv');
  assert.match(missing.text, /1,2,Close/);
  assert.equal((await req('POST', '/api/shotlist/edit', { body: { op: 'add', scene: '1', shot: '3', desc: 'Insert', optional: true } })).status, 200);

  // a whole new scene: planned shots show up as missing until someone shoots them
  assert.equal((await req('POST', '/api/shotlist/edit', { body: { op: 'scene', scene: '12', count: 3, title: 'Rooftop' } })).status, 200);
  const withScene = (await req('GET', '/api/library')).json.coverage.scenes.find((s) => s.id === '12');
  assert.deepEqual(withScene.shots.map((s) => [s.id, s.status]), [['1', 'missing'], ['2', 'missing'], ['3', 'missing']]);
  assert.equal(withScene.title, 'Rooftop');
  assert.equal((await req('POST', '/api/shotlist/edit', { body: { op: 'scene', scene: '12', count: 2 } })).status, 409);
  assert.equal((await req('POST', '/api/shotlist/edit', { body: { op: 'scene', scene: 'not a scene', count: 2 } })).status, 400);
  assert.equal((await req('POST', '/api/shotlist/edit', { body: { op: 'scene', scene: '13', count: 0 } })).status, 400);

  // bad input is rejected, not crashed on
  assert.equal((await req('PATCH', '/api/clip', { body: { key: 'does-not-exist', patch: {} } })).status, 404);
  assert.equal((await req('POST', '/api/clip/rename', { body: { key: raw.key, scene: '', shot: '1', take: 1 } })).status, 400);
  assert.equal((await req('POST', '/api/canvas/send', { body: { keys: [named2.key] } })).status, 401, 'no key: asks for one instead of failing mysteriously');

  // the project file is plain JSON in the film folder
  const file = JSON.parse(fs.readFileSync(path.join(film, 'letzai-kit.json'), 'utf8'));
  assert.equal(file.name, 'T');
});
