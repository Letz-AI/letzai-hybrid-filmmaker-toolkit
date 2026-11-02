'use strict';
// Upload and canvas behaviour against a fake LetzAI that misbehaves on demand.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createFakeLetzAI } = require('./helpers/fake-letzai');
const { until } = require('./helpers/wait');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-cv-'));
process.env.LETZAI_KIT_HOME = path.join(tmp, 'home');
process.env.LETZAI_API_KEY = 'test-key';
process.env.LETZAI_KIT_STALL_MS = '600';

const fake = createFakeLetzAI();
const canvas = require('../server/lib/canvas');
const ff = require('../server/lib/ffmpeg');
const { App } = require('../server/app');

const loc = ff.locate(true);
const skip = !loc.ok && 'ffmpeg not installed';
const fastClient = () => new canvas.CanvasClient(() => 'test-key', { delays: [5, 5, 5] });

function clip(file, seconds = 2, size = '320x180') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const r = spawnSync(loc.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=25:duration=${seconds}`, '-f', 'lavfi', '-i', 'sine=duration=' + seconds, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
  assert.equal(r.status, 0);
  return file;
}

test.before(async () => { await fake.start(); });
test.after(async () => { await fake.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });
test.beforeEach(() => fake.reset());

const send = (client, file, extra = {}) => canvas.sendFile(client, { canvasId: 'c1', pageId: 'p2', file, width: 320, height: 180, ...extra });

test('a clean upload creates the clip and its caption, and is verified', { skip }, async () => {
  const f = clip(path.join(tmp, 'a', 'Film-scene6-shot1-take1-cut-1.mp4'));
  const r = await send(fastClient(), f);
  assert.equal(r.skipped, false);
  assert.equal(fake.count('p2', 'media'), 1);
  assert.equal(fake.count('p2', 'text'), 1);
  assert.ok(fake.state.log.some((l) => l.startsWith('HEAD /files/')), 'the uploaded file was checked on LetzAI');
});

test('sending the same file again is skipped, a changed file replaces the old one', { skip }, async () => {
  const f = clip(path.join(tmp, 'b', 'Film-scene6-shot1-take1-cut-1.mp4'), 2);
  const c = fastClient();
  const first = await send(c, f);
  assert.equal((await send(c, f, { sent: { size: first.size } })).skipped, true);
  assert.equal(fake.count('p2', 'media'), 1);
  clip(f, 3); // re-cut: different bytes under the same name
  const again = await send(c, f, { sent: { size: first.size } });
  assert.equal(again.replaced, true);
  assert.equal(fake.count('p2', 'media'), 1, 'old node was removed, not duplicated');
  assert.equal(fake.count('p2', 'text'), 1);
});

test('429 from LetzAI is retried and succeeds', { skip }, async () => {
  fake.state.fail.slot429 = 2;
  const f = clip(path.join(tmp, 'c', 'Film-scene6-shot1-take2-cut-1.mp4'));
  await send(fastClient(), f);
  assert.equal(fake.count('p2', 'media'), 1);
  assert.equal(fake.state.log.filter((l) => l === 'POST /user-assets').length, 3);
});

test('a refused upload explains why and creates nothing', { skip }, async () => {
  fake.state.fail.putStatus = { status: 403, body: '<Error><Message>Request has expired</Message></Error>' };
  const f = clip(path.join(tmp, 'd', 'Film-scene6-shot1-take3-cut-1.mp4'));
  await assert.rejects(() => send(fastClient(), f), (e) => { const t = canvas.explain(e); return /403/.test(t) && /Request has expired/.test(t); });
  assert.equal(fake.count('p2', 'media'), 0);
});

test('a truncated upload is detected, retried, and reported when it keeps failing', { skip }, async () => {
  const f = clip(path.join(tmp, 'e', 'Film-scene6-shot1-take4-cut-1.mp4'));
  fake.state.fail.putTruncate = true;
  fake.state.fail.putTruncateTimes = 1; // first attempt truncated, second fine
  await send(fastClient(), f);
  assert.equal(fake.count('p2', 'media'), 1, 'recovered on retry');
  fake.reset();
  fake.state.fail.putTruncate = true; // always truncated
  await assert.rejects(() => send(fastClient(), f), (e) => /incomplete/i.test(canvas.explain(e)));
  assert.equal(fake.count('p2', 'media'), 0, 'nothing is placed on the canvas for a broken file');
});

test('an upload that stalls is given up on', { skip }, async () => {
  fake.state.fail.stall = true;
  const f = clip(path.join(tmp, 'f', 'Film-scene6-shot1-take5-cut-1.mp4'));
  const c = new canvas.CanvasClient(() => 'test-key', { delays: [] });
  await assert.rejects(() => send(c, f), (e) => /stalled/i.test(canvas.explain(e)));
});

test('missing upload link and missing nodes are reported, not ignored', { skip }, async () => {
  const f = clip(path.join(tmp, 'g', 'Film-scene6-shot2-take1-cut-1.mp4'));
  fake.state.fail.slotMissingUrl = true;
  await assert.rejects(() => send(fastClient(), f), (e) => /did not hand out an upload link/.test(canvas.explain(e)));
  fake.reset();
  fake.state.fail.batchNoMedia = true;
  await assert.rejects(() => send(fastClient(), f), (e) => /did not put .* on the canvas/.test(canvas.explain(e)));
});

test('a 500 that still created the nodes counts as success (no duplicate)', { skip }, async () => {
  const f = clip(path.join(tmp, 'h', 'Film-scene6-shot2-take2-cut-1.mp4'));
  fake.state.fail.batch500Created = true;
  const r = await send(fastClient(), f);
  assert.ok(r.nodeId);
  assert.equal(fake.count('p2', 'media'), 1);
});

test('no connection and bad key read as sentences', async () => {
  const dead = new canvas.CanvasClient(() => 'test-key', { delays: [] });
  const old = process.env.LETZAI_API_BASE;
  process.env.LETZAI_API_BASE = 'http://127.0.0.1:1';
  await assert.rejects(() => dead.getPage('c1', 'p1'), (e) => /No connection to LetzAI/.test(canvas.explain(e)));
  process.env.LETZAI_API_BASE = old;
  const bad = new canvas.CanvasClient(() => 'wrong', { delays: [] });
  await assert.rejects(() => bad.getPage('c1', 'p1'), (e) => /rejected the API key/.test(canvas.explain(e)));
});

test('scene pages are matched by name', () => {
  const pages = [{ id: 'a', name: 'Drafts' }, { id: 'b', name: 'Scene 6' }, { id: 'c', name: 'scene 14 - Hall' }, { id: 'd', name: 'Scene 6B' }];
  assert.equal(canvas.findScenePage(pages, '6').id, 'b');
  assert.equal(canvas.findScenePage(pages, '14').id, 'c');
  assert.equal(canvas.findScenePage(pages, '6B').id, 'd');
  assert.equal(canvas.findScenePage(pages, '15'), undefined);
});

test('page-per-scene sort starts below existing content and keeps its place', () => {
  const L = { clipW: 100, clipH: 50, gap: 10, capH: 20, cols: 2 };
  const other = { id: 'o', kind: 'media', clientNodeId: null, position: { x: 40, y: 0 }, size: { w: 100, h: 200 } };
  const mk = (id, name, y = 0) => ({ id, clientNodeId: `ltn:${name}`, kind: 'media', position: { x: 0, y }, size: { w: 1, h: 1 } });
  const page = { nodes: [other, mk('a', 'P-scene6-shot2-take1.mp4'), mk('b', 'P-scene6-shot1-take1.mp4')] };
  const pos = Object.fromEntries(canvas.planSortPage(page, L).map((u) => [u.id, u.patch.position]));
  assert.deepEqual(pos.b, { x: 40, y: 5200 + 20 }); // first clip: below the other content (200 + 5000), left aligned with it
  assert.deepEqual(pos.a, { x: 150, y: 5220 });
  // once placed, further sorting keeps the block where it is
  const placed = { nodes: [other, { ...mk('a', 'P-scene6-shot2-take1.mp4'), position: { x: 150, y: 5220 } }, { ...mk('b', 'P-scene6-shot1-take1.mp4'), position: { x: 40, y: 5220 } }] };
  assert.equal(canvas.planSortPage(placed, L).length, 0);
});

// ---- the whole job: cut -> upload, with a failure in the middle of a take --------------------------------------

const waitJobs = (app) => until(() => !app.jobs.list.some((j) => j.state === 'queued' || j.state === 'running'), 'the jobs to finish');

async function makeApp(mode) {
  const film = path.join(tmp, `film-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(film, { recursive: true });
  clip(path.join(film, 'Film-scene6-shot1-take1.mp4'), 7, '640x360');
  clip(path.join(film, 'Film-scene9-shot1-take1.mp4'), 2, '640x360');
  const app = new App({ client: fastClient() });
  await app.createProject({ root: film, name: 'T', prefix: 'Film', folders: [film] });
  const p = app.project;
  p.state.snippets.maxSeconds = 2; p.state.snippets.height = 0;
  await p.updateSettings({ canvas: { canvasId: 'c1', canvasName: 'Fake', pageId: 'p2', pageName: 'Final Assets', mode } });
  await until(() => !p.library.some((e) => !e.probe), 'every clip to be probed');
  return { app, p, film };
}

test('one bad snippet does not sink the take: the rest go up, the failure stays visible and a retry fixes it', { skip }, async () => {
  const { app, p } = await makeApp('labels');
  const take = p.library.find((e) => e.scene === '6');
  // the second of four snippets is refused every time
  fake.state.fail.putStatus = { status: 500, body: 'boom', name: 'Film-scene6-shot1-take1-cut-2.mp4' };
  app.sendToCanvas([take.key]);
  await waitJobs(app);
  const up = app.jobs.list.find((j) => j.title.startsWith('Canvas ·'));
  assert.equal(up.state, 'error');
  assert.match(up.error, /1 of 4 snippets did not reach the canvas \(3 did\)/);
  assert.equal(fake.count('p2', 'media'), 3);
  const shown = p.toClient(p.byKey.get(take.key));
  assert.equal(shown.canvasError.files.length, 1);
  assert.match(shown.canvasError.files[0].file, /cut-2/);
  assert.equal(shown.onCanvas, false);
  assert.equal(shown.cutOnCanvas, 3);
  // fixed on LetzAI's side: retry sends only what is missing
  fake.state.fail.putStatus = null;
  app.sendToCanvas([take.key]);
  await waitJobs(app);
  assert.equal(fake.count('p2', 'media'), 4);
  const done = p.toClient(p.byKey.get(take.key));
  assert.equal(done.canvasError, null);
  assert.equal(done.onCanvas, true);
  const uploads = fake.state.log.filter((l) => l === 'POST /user-assets').length;
  assert.equal(uploads, 3 + 1 + 1, 'three first time, the failed one retried 1x by the client, then only the missing snippet');
});

test('a wrong API key stops after one try and says so', { skip }, async () => {
  const { app, p } = await makeApp('labels');
  fake.state.fail.page401 = true;
  const take = p.library.find((e) => e.scene === '6');
  app.sendToCanvas([take.key]);
  await waitJobs(app);
  const up = app.jobs.list.find((j) => j.title.startsWith('Canvas ·'));
  assert.equal(up.state, 'error');
  assert.match(up.error, /rejected the API key/);
  assert.equal(fake.state.log.filter((l) => l === 'POST /user-assets').length, 0);
  assert.match(p.canvasErrors.get(take.key).message, /rejected the API key/);
});

test('page per scene: clips go to the page named after the scene; a scene without a page says what to do', { skip }, async () => {
  const { app, p } = await makeApp('pages');
  const six = p.library.find((e) => e.scene === '6');
  const nine = p.library.find((e) => e.scene === '9');
  app.sendToCanvas([six.key, nine.key]);
  await waitJobs(app);
  assert.equal(fake.count('p1', 'media'), 4, 'Scene 6 page got the Scene 6 clips');
  assert.equal(fake.count('p2', 'media'), 0, 'the labels page was not used');
  const jobs = app.jobs.list.filter((j) => j.title.startsWith('Canvas ·'));
  const nineJob = jobs.find((j) => j.title.includes('scene9'));
  assert.equal(nineJob.state, 'error');
  assert.match(nineJob.error, /no page named “Scene 9”/);
  assert.match(nineJob.error, /add one called Scene 9/);
  const st = await app.refreshCanvas();
  assert.equal(st.scenePages['6'].found, true);
  assert.equal(st.scenePages['9'].found, false);
});
