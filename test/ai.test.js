'use strict';
// AI results for the Compare view: file-name matching, mapping to takes, persistence across renames, media streaming.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-ai-'));
process.env.LETZAI_KIT_HOME = path.join(tmp, 'home');
const ff = require('../server/lib/ffmpeg');
const { aiHints, suggestTake } = require('../server/lib/ai');
const { createServer } = require('../server/index.js');
const { until } = require('./helpers/wait');

const loc = ff.locate(true);
const skip = !loc.ok && 'ffmpeg not installed';
const TOKEN = 'ai-test-token';

const take = (scene, shot, n, extra = {}) => ({ key: `k${scene}${shot}${n}`, stem: `Film-scene${scene}-shot${shot}-take${n}`, scene: String(scene), shot, take: n, ...extra });

test('aiHints reads scene, shot, take and snippet from loose file names', () => {
  assert.deepEqual(aiHints('render_scene6_shot2A_take3_cut-2_v1.mp4'), { scene: '6', shot: '2A', take: 3, cut: 2 });
  assert.deepEqual(aiHints('Scene 6 Shot 2 Take 3.mov'), { scene: '6', shot: '2', take: 3, cut: null });
  assert.deepEqual(aiHints('random-name.mp4'), { scene: null, shot: null, take: null, cut: null });
});

test('suggestTake prefers the full take name, then the numbers, then the camera name; never take1 for take10', () => {
  const takes = [take(1, '1', 1), take(1, '1', 10), take(2, '3', 2, { orig: 'A001_C047.mov' })];
  assert.equal(suggestTake('Film-scene1-shot1-take10_ai_v2.mp4', takes).key, 'k1110');
  assert.equal(suggestTake('Film-scene1-shot1-take1-cut-3_runway.mp4', takes).cut, 3);
  assert.equal(suggestTake('Film-scene1-shot1-take1-cut-3_runway.mp4', takes).key, 'k111');
  assert.equal(suggestTake('x_scene2_shot3_take2_final.mp4', takes).key, 'k232');
  assert.equal(suggestTake('result of A001_C047 restyled.mp4', takes).key, 'k232');
  assert.equal(suggestTake('holiday.mp4', takes), null);
});

let server; let port; let cookie = '';
function req(method, url, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, path: url, method, headers: { Host: `127.0.0.1:${port}`, ...(cookie ? { Cookie: cookie } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, buf, json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

test.after(() => { try { server && server.close(); } catch { /* not started */ } fs.rmSync(tmp, { recursive: true, force: true }); });

test('map AI results to takes: add, update, survive a rename, stream with Range, go missing, remove', { skip }, async () => {
  const film = path.join(tmp, 'film');
  const ai = path.join(tmp, 'ai-out');
  fs.mkdirSync(film, { recursive: true });
  fs.mkdirSync(ai, { recursive: true });
  const make = (file, secs) => assert.equal(spawnSync(loc.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=320x180:rate=25:duration=${secs}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]).status, 0);
  make(path.join(film, 'Film-scene1-shot1-take1.mp4'), 4);
  make(path.join(film, 'A001_C009.mp4'), 4);
  make(path.join(ai, 'Film-scene1-shot1-take1_cut-2_v1.mp4'), 2);
  make(path.join(ai, 'Film-scene1-shot1-take1_v2.mp4'), 2);
  fs.writeFileSync(path.join(ai, 'notes.txt'), 'not a video');

  // the server guards its port, so start it twice: once to learn the port, once with it
  ({ server } = createServer({ token: TOKEN, port: 0 }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  server.close();
  ({ server } = createServer({ token: TOKEN, port }));
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  cookie = (await req('GET', `/?k=${TOKEN}`)).headers['set-cookie'][0].split(';')[0];

  assert.equal((await req('POST', '/api/project/create', { body: { root: film, name: 'T', prefix: 'Film' } })).status, 200);
  let lib;
  await until(async () => { lib = (await req('GET', '/api/library')).json; return lib.clips.every((c) => c.probe); }, 'every clip to be probed');
  const named = lib.clips.find((c) => c.kind === 'shot');
  const raw = lib.clips.find((c) => c.kind === 'raw');

  // only named takes can have AI results; bad input is refused with a reason
  assert.equal((await req('POST', '/api/ai/add', { body: { key: raw.key, items: [{ path: path.join(ai, 'Film-scene1-shot1-take1_v2.mp4') }] } })).status, 400);
  assert.equal((await req('POST', '/api/ai/add', { body: { key: named.key, items: [] } })).status, 400);
  assert.equal((await req('POST', '/api/ai/add', { body: { key: named.key, items: [{ path: path.join(ai, 'missing.mp4') }] } })).status, 404);
  assert.equal((await req('POST', '/api/ai/add', { body: { key: named.key, items: [{ path: path.join(ai, 'notes.txt') }] } })).status, 400);
  assert.equal((await req('POST', '/api/ai/add', { body: { key: named.key, items: [{ url: 'http://insecure.example/x.mp4' }] } })).status, 400);

  // suggestions come from the file names
  const sug = (await req('POST', '/api/ai/suggest', { body: { names: ['Film-scene1-shot1-take1_cut-2_v1.mp4', 'holiday.mp4'] } })).json.suggestions;
  assert.equal(sug[0].key, named.key);
  assert.equal(sug[0].cut, 2);
  assert.equal(sug[1].key, null);

  // add: one with an explicit start, one without
  const added = await req('POST', '/api/ai/add', { body: { key: named.key, items: [
    { path: path.join(ai, 'Film-scene1-shot1-take1_cut-2_v1.mp4'), label: 'Version one', originalStart: 1.25 },
    { path: path.join(ai, 'Film-scene1-shot1-take1_v2.mp4') },
  ] } });
  assert.equal(added.status, 200, JSON.stringify(added.json));
  assert.equal(added.json.added.length, 2);
  lib = (await req('GET', '/api/library')).json;
  let entry = lib.clips.find((c) => c.key === named.key);
  assert.equal(entry.ai.length, 2);
  assert.equal(entry.ai[0].label, 'Version one');
  assert.equal(entry.ai[0].originalStart, 1.25);
  assert.equal(entry.ai[1].originalStart, 0);
  assert.ok(entry.ai[0].duration > 1.5 && entry.ai[0].duration < 2.5);
  assert.equal(entry.ai[0].missing, false);

  // update: label, note, start; negative starts are clamped
  const id = entry.ai[0].id;
  await req('POST', '/api/ai/update', { body: { key: named.key, id, patch: { label: 'Warm', note: 'good skin', originalStart: -3 } } });
  entry = (await req('GET', '/api/library')).json.clips.find((c) => c.key === named.key);
  assert.deepEqual([entry.ai[0].label, entry.ai[0].note, entry.ai[0].originalStart], ['Warm', 'good skin', 0]);
  assert.equal((await req('POST', '/api/ai/update', { body: { key: named.key, id: 'nope', patch: {} } })).status, 404);

  // playback: browser-safe H.264 plays as is; Range works; the token guard applies
  const pb = (await req('GET', `/api/ai/playback?key=${encodeURIComponent(named.key)}&id=${id}`)).json;
  assert.equal(pb.kind, 'original');
  const part = await req('GET', pb.url, { headers: { Range: 'bytes=0-49' } });
  assert.equal(part.status, 206);
  assert.equal(part.buf.length, 50);
  const saved = cookie; cookie = '';
  assert.equal((await req('GET', pb.url)).status, 401);
  cookie = saved;
  assert.equal((await req('GET', `/ai-media?key=${encodeURIComponent(named.key)}&id=nope&src=orig`)).status, 404);

  // the mapping follows the take when it is renamed
  const renamed = await req('POST', '/api/clip/rename', { body: { key: named.key, scene: '2', shot: '5', take: 1 } });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.json));
  lib = (await req('GET', '/api/library')).json;
  entry = lib.clips.find((c) => c.name === 'Film-scene2-shot5-take1.mp4');
  assert.ok(entry, 'renamed take found');
  assert.equal(entry.ai.length, 2);
  assert.equal(entry.ai[0].label, 'Warm');

  // a deleted AI file shows up as missing, with a helpful playback error, and removing only forgets the mapping
  fs.unlinkSync(path.join(ai, 'Film-scene1-shot1-take1_v2.mp4'));
  const id2 = entry.ai[1].id;
  await req('POST', '/api/rescan');
  const gone = await req('GET', `/api/ai/playback?key=${encodeURIComponent(entry.key)}&id=${id2}`);
  assert.equal(gone.status, 404);
  assert.match(gone.json.error, /missing/i);
  assert.equal((await req('POST', '/api/ai/remove', { body: { key: entry.key, id: id2 } })).status, 200);
  assert.equal((await req('POST', '/api/ai/remove', { body: { key: entry.key, id: id2 } })).status, 404);
  assert.equal((await req('POST', '/api/ai/remove', { body: { key: entry.key, id } })).status, 200);
  entry = (await req('GET', '/api/library')).json.clips.find((c) => c.key === entry.key);
  assert.ok(!entry.ai || entry.ai.length === 0);
  assert.ok(fs.existsSync(path.join(ai, 'Film-scene1-shot1-take1_cut-2_v1.mp4')), 'removing a mapping never deletes the file');
});
