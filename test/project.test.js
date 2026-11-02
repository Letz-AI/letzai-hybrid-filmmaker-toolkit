'use strict';
// Integration test: real ffmpeg, real files in a temp folder. Skipped when ffmpeg isn't installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-test-'));
process.env.LETZAI_KIT_HOME = path.join(tmp, 'home');
const ff = require('../server/lib/ffmpeg');
const { Project } = require('../server/lib/project');
const { Jobs } = require('../server/lib/jobs');
const { until } = require('./helpers/wait');

const loc = ff.locate(true);
const skip = !loc.ok && 'ffmpeg not installed';

function makeClip(file, seconds, label) {
  const r = spawnSync(loc.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=320x180:rate=25:duration=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-metadata', `title=${label}`, file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

async function waitProbes(p) {
  await until(() => !p.library.some((e) => !e.probe), 'every clip to be probed');
}

test('scan, rename with undo, metadata follows renames, cuts', { skip }, async () => {
  const film = path.join(tmp, 'film');
  const day = path.join(film, 'day1');
  fs.mkdirSync(path.join(day, 'Proxy'), { recursive: true });
  makeClip(path.join(day, 'A001_C001.mov'), 2, 'raw1');
  makeClip(path.join(day, 'A001_C002.mov'), 5, 'raw2');
  makeClip(path.join(day, 'Film-scene1-shot1-take1.mov'), 2, 'named');
  makeClip(path.join(day, 'Proxy', 'A001_C001.mov'), 2, 'proxy');
  fs.writeFileSync(path.join(day, '._A001_C001.mov'), 'junk'); // macOS resource fork must be ignored

  const jobs = new Jobs();
  const p = await Project.create(film, { name: 'Test', prefix: 'Film', folders: ['day1'] }, { jobs });
  await p.scan();
  await waitProbes(p);
  assert.equal(p.library.length, 3);
  const named = p.library.find((e) => e.kind === 'shot');
  assert.equal(named.scene, '1');
  assert.ok(named.duration > 1.5 && named.duration < 2.5, `duration ${named.duration}`);
  assert.equal(named.probe.width, 320);

  // rating + notes on a raw clip, then name it: metadata must follow
  const raw = p.library.find((e) => e.name === 'A001_C001.mov');
  assert.ok(raw.camProxy, 'camera proxy found');
  await p.setMeta(raw.key, { rating: 'good', print: true, note: 'nice' });
  const r = await p.renameClip(raw.key, { scene: '1', shot: '1', take: 2 });
  assert.equal(r.name, 'Film-scene1-shot1-take2.mov');
  assert.ok(fs.existsSync(path.join(day, 'Film-scene1-shot1-take2.mov')));
  assert.ok(fs.existsSync(path.join(day, 'Proxy', 'Film-scene1-shot1-take2.mov')), 'proxy renamed too');
  const after = p.byKey.get(r.key);
  assert.equal(after.rating, 'good');
  assert.equal(after.print, true);
  assert.equal(after.note, 'nice');
  assert.equal(after.orig, 'A001_C001.mov');

  // collisions are refused, with a suggestion
  const raw2 = p.library.find((e) => e.name === 'A001_C002.mov');
  await assert.rejects(() => p.renameClip(raw2.key, { scene: '1', shot: '1', take: 2 }), (e) => e.status === 409 && e.suggestion.take === 3);
  const dup = await p.renameClip(raw2.key, { scene: '1', shot: '1', take: 2, onConflict: 'next' });
  assert.equal(dup.name, 'Film-scene1-shot1-take3.mov');

  // undo restores names and metadata
  await p.undo();
  assert.ok(fs.existsSync(path.join(day, 'A001_C002.mov')));
  await p.undo();
  assert.ok(fs.existsSync(path.join(day, 'A001_C001.mov')));
  assert.ok(fs.existsSync(path.join(day, 'Proxy', 'A001_C001.mov')));
  assert.equal(p.library.find((e) => e.name === 'A001_C001.mov').rating, 'good');

  // renaming outside the kit does not lose metadata (fingerprint match)
  fs.renameSync(path.join(day, 'A001_C001.mov'), path.join(day, 'Film-scene2-shot1-take1.mov'));
  await p.scan();
  const moved = p.library.find((e) => e.name === 'Film-scene2-shot1-take1.mov');
  assert.equal(moved.note, 'nice');

  // cuts: 5 s clip with a 2 s limit -> 3 snippets; ranges override auto split
  p.state.snippets.maxSeconds = 2;
  p.state.snippets.height = 0;
  const long = p.library.find((e) => e.name === 'A001_C002.mov');
  const progress = [];
  const files = await p.makeCuts(long.key, { progress: (f) => progress.push(f), signal: new AbortController().signal });
  assert.equal(files.length, 3);
  for (const f of files) assert.ok(fs.existsSync(f));
  assert.equal(p.library.find((e) => e.name === 'A001_C002.mov').cutFiles.length, 3);
  await p.setMeta(long.key, { cuts: [{ in: 1, out: 2, label: 'a' }] });
  const files2 = await p.makeCuts(long.key, { progress() {}, signal: new AbortController().signal });
  assert.equal(files2.length, 1);
  assert.equal(p.library.find((e) => e.name === 'A001_C002.mov').cutFiles.length, 1, 'stale snippets are removed');

  // reports
  assert.match(p.report('continuity'), /Scene,Shot,Take/);
  await p.saveNow();
  assert.ok(JSON.parse(fs.readFileSync(path.join(film, 'letzai-kit.json'), 'utf8')).clips);
});

test('proxies are generated for clips a browser cannot play', { skip }, async () => {
  const dir = path.join(tmp, 'hevc');
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, 'A001_X.mov');
  const r = spawnSync(loc.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=2', '-c:v', 'mpeg4', src], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const jobs = new Jobs();
  const p = await Project.create(dir, { name: 'X', prefix: 'X', folders: ['.'] }, { jobs });
  await p.scan();
  await waitProbes(p);
  const e = p.library[0];
  const pb = await p.playback(e.key, { hevc: false });
  assert.equal(pb.pending, true);
  await until(() => !jobs.list.some((j) => j.state === 'queued' || j.state === 'running'), 'the review copy');
  assert.ok(!jobs.list.some((j) => j.state === 'error'), 'no job failed');
  const pb2 = await p.playback(e.key, { hevc: false });
  assert.equal(pb2.kind, 'generated-proxy');
});

test('review copies are prepared in the background, unnamed clips first, only for clips a browser cannot play', { skip }, async () => {
  const dir = path.join(tmp, 'bg');
  fs.mkdirSync(dir, { recursive: true });
  const mk = (n, codec) => { const r = spawnSync(loc.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=1', '-c:v', codec, ...(codec === 'libx264' ? ['-pix_fmt', 'yuv420p'] : []), path.join(dir, n)]); assert.equal(r.status, 0, r.stderr.toString()); };
  mk('Film-scene1-shot1-take1.mp4', 'mpeg4'); // named, not H.264: needs a copy
  mk('A001_C1.mp4', 'mpeg4');                  // unnamed, not H.264: needs a copy, goes first
  mk('Film-scene1-shot1-take2.mp4', 'libx264'); // plays as it is: needs nothing
  const jobs = new Jobs();
  const p = await Project.create(dir, { name: 'B', prefix: 'Film', folders: ['.'] }, { jobs });
  await p.scan();
  await waitProbes(p);
  // the copies start on their own; wait until they are done, not a fixed time (they may not have started yet)
  await until(() => { const s = p.proxyStatus(); return s.ready === 2 && !s.active; }, 'both background review copies');
  const st = p.proxyStatus();
  assert.equal(st.ready, 2, 'both non-H.264 clips got a copy by themselves');
  assert.equal(st.left, 0);
  assert.ok(!fs.existsSync(p.proxyPath(p.library.find((e) => e.name === 'Film-scene1-shot1-take2.mp4'))), 'an H.264 clip needs no copy');
  // a browser that can decode HEVC needs fewer copies; turning the setting off stops new ones
  await p.updateSettings({ playback: { prepare: false } });
  assert.equal(p.state.playback.prepare, false);
  assert.equal(p.autoProxy(), 0);
});

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

test('cutting never leaves a runt snippet at the end: a leftover under a second shares time with the piece before', () => {
  const plan = (duration, maxSeconds, cutRanges = []) => Project.prototype.planCuts.call({ state: { snippets: { maxSeconds } } }, { duration, cutRanges, stem: 'T', ext: '.mp4' });
  const lens = (pl) => pl.map((c) => Math.round(c.len * 100) / 100);
  assert.deepEqual(lens(plan(7, 2)), [1.95, 1.95, 1.95, 1]);        // a full second left: kept as it is
  assert.deepEqual(lens(plan(4.04, 2)), [1.95, 1.02, 1.02]);       // 0.04 s left: the last two share it
  const long = plan(60.1, 30);
  assert.equal(long.length, 3);
  assert.ok(long.every((c) => c.len <= 30 && c.len > 1));
  assert.ok(Math.abs(long[2].start + long[2].len - 60.1) < 1e-9, 'nothing at the end is lost');
  assert.deepEqual(lens(plan(20, 30)), [20]);                       // shorter than the limit: one piece, untouched
});
