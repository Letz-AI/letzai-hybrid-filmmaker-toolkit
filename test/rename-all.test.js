'use strict';
// "Rename all": apply the naming scheme to every named take, safely.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-ra-'));
process.env.LETZAI_KIT_HOME = path.join(tmp, 'home');
const { Project } = require('../server/lib/project');
const { Jobs } = require('../server/lib/jobs');

const touch = (f, body = 'x') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
const names = (dir) => fs.readdirSync(dir).filter((n) => !n.startsWith('.')).sort();

async function setup(files) {
  const film = path.join(tmp, `film-${Math.random().toString(36).slice(2, 7)}`);
  // every file gets different bytes: the kit tells files apart by size and time, so identical dummies could be mistaken for each other
  files.forEach((f, i) => touch(path.join(film, f), f + '#'.repeat(i + 1)));
  const p = await Project.create(film, { name: 'T', prefix: 'Old', folders: ['.'] }, { jobs: new Jobs() });
  await p.scan();
  return { p, film };
}

test('preview lists takes with their cuts and proxy, and changes nothing', async () => {
  const { p, film } = await setup([
    'Old-scene6-shot1-take1.mp4', 'cuts/Old-scene6-shot1-take1-cut-1.mp4', 'cuts/Old-scene6-shot1-take1-cut-2.mp4', 'Proxy/Old-scene6-shot1-take1.mp4',
    'Old-scene6-shot1-take2-good-print.mp4', 'A001_C009.mp4',
  ]);
  await p.updateSettings({ prefix: 'New', naming: { pad: { scene: 2 } } });
  const pv = p.renameAllPreview();
  assert.equal(pv.total, 2);
  assert.deepEqual(pv.changes.map((c) => [c.from, c.to]), [
    ['Old-scene6-shot1-take1.mp4', 'New-scene06-shot1-take1.mp4'],
    ['Old-scene6-shot1-take2-good-print.mp4', 'New-scene06-shot1-take2.mp4'],
  ]);
  assert.equal(pv.changes[0].cuts, 2);
  assert.equal(pv.changes[0].proxy, true);
  assert.deepEqual(names(film), ['A001_C009.mp4', 'Old-scene6-shot1-take1.mp4', 'Old-scene6-shot1-take2-good-print.mp4', 'Proxy', 'cuts', 'letzai-kit.json'].sort());
});

test('rename all moves takes, cuts and proxies, keeps ratings that lived in file names, and is one undo', async () => {
  const { p, film } = await setup([
    'Old-scene6-shot1-take1.mp4', 'cuts/Old-scene6-shot1-take1-cut-1.mp4', 'Proxy/Old-scene6-shot1-take1.mp4',
    'Old-scene6-shot1-take2-good-print.mp4', 'cuts/Old-scene6-shot1-take2-good-print-cut-1.mp4',
  ]);
  await p.updateSettings({ prefix: 'New', naming: { pad: { scene: 2 } } });
  const r = await p.renameAll();
  assert.equal(r.renamed, 2);
  assert.equal(r.files, 5);
  assert.deepEqual(names(film).filter((n) => n.endsWith('.mp4')), ['New-scene06-shot1-take1.mp4', 'New-scene06-shot1-take2.mp4']);
  assert.deepEqual(names(path.join(film, 'cuts')), ['New-scene06-shot1-take1-cut-1.mp4', 'New-scene06-shot1-take2-cut-1.mp4']);
  assert.deepEqual(names(path.join(film, 'Proxy')), ['New-scene06-shot1-take1.mp4']);
  assert.equal(fs.readdirSync(film).filter((n) => n.startsWith('.kit-rename')).length, 0, 'no temporary names left behind');
  // the decision that used to be in the file name survives
  const two = p.library.find((e) => e.name === 'New-scene06-shot1-take2.mp4');
  assert.equal(two.rating, 'good');
  assert.equal(two.print, true);
  assert.equal(p.library.find((e) => e.name === 'New-scene06-shot1-take1.mp4').cutFiles.length, 1);
  // running it again finds nothing to do
  assert.equal(p.renameAllPreview().changes.length, 0);

  await p.undo();
  assert.deepEqual(names(film).filter((n) => n.endsWith('.mp4')), ['Old-scene6-shot1-take1.mp4', 'Old-scene6-shot1-take2-good-print.mp4']);
  assert.deepEqual(names(path.join(film, 'cuts')), ['Old-scene6-shot1-take1-cut-1.mp4', 'Old-scene6-shot1-take2-good-print-cut-1.mp4']);
  assert.deepEqual(names(path.join(film, 'Proxy')), ['Old-scene6-shot1-take1.mp4']);
  assert.equal(p.library.find((e) => e.name === 'Old-scene6-shot1-take2-good-print.mp4').rating, 'good');
});

test('turning on ratings in file names renames takes to carry them', async () => {
  const { p, film } = await setup(['Old-scene1-shot1-take1.mp4', 'Old-scene1-shot1-take2.mp4']);
  const two = p.library.find((e) => e.name === 'Old-scene1-shot1-take2.mp4');
  await p.setMeta(two.key, { rating: 'ok', print: true });
  await p.updateSettings({ naming: { ratingInFilename: true } });
  assert.deepEqual(p.renameAllPreview().changes.map((c) => c.to), ['Old-scene1-shot1-take2-ok-print.mp4']);
  await p.renameAll();
  assert.ok(fs.existsSync(path.join(film, 'Old-scene1-shot1-take2-ok-print.mp4')));
});

test('a name another file already has is a conflict, not an overwrite', async () => {
  const { p, film } = await setup(['Old-scene6-shot1-take1.mp4', 'New-scene06-shot1-take1.mp4']);
  await p.updateSettings({ prefix: 'New', naming: { pad: { scene: 2 } } });
  const pv = p.renameAllPreview();
  // New-scene06-... exists and is already right; Old-scene6-... wants that name
  assert.equal(pv.conflicts.length, 1);
  assert.equal(pv.conflicts[0].name, 'Old-scene6-shot1-take1.mp4');
  const r = await p.renameAll();
  assert.equal(r.renamed, 0);
  assert.equal(r.skipped, 1);
  assert.deepEqual(names(film).filter((n) => n.endsWith('.mp4')), ['New-scene06-shot1-take1.mp4', 'Old-scene6-shot1-take1.mp4']);
});

test('leading zeros are normalised both ways', async () => {
  const { p, film } = await setup(['Old-scene06-shot1-take01.mp4']);
  assert.deepEqual(p.renameAllPreview().changes.map((c) => c.to), ['Old-scene6-shot1-take1.mp4']);
  await p.renameAll();
  assert.deepEqual(names(film).filter((n) => n.endsWith('.mp4')), ['Old-scene6-shot1-take1.mp4']);
  await p.updateSettings({ naming: { pad: { scene: 2, take: 2 } } });
  await p.renameAll();
  assert.deepEqual(names(film).filter((n) => n.endsWith('.mp4')), ['Old-scene06-shot1-take01.mp4']);
});

test('names that swap or chain move safely (two-phase), and roll back on failure', async () => {
  const { p, film } = await setup([]);
  const a = path.join(film, 'a.mp4'); const b = path.join(film, 'b.mp4'); const c = path.join(film, 'c.mp4');
  touch(a, 'A'); touch(b, 'B'); touch(c, 'C');
  await p._moveAll([{ from: a, to: b }, { from: b, to: a }]); // a swap
  assert.equal(fs.readFileSync(a, 'utf8'), 'B');
  assert.equal(fs.readFileSync(b, 'utf8'), 'A');
  await p._moveAll([{ from: a, to: b }, { from: b, to: c }, { from: c, to: a }]); // a three-way chain
  assert.deepEqual([a, b, c].map((f) => fs.readFileSync(f, 'utf8')), ['C', 'B', 'A']);
  // a move that cannot happen undoes the ones before it
  await assert.rejects(() => p._moveAll([{ from: a, to: path.join(film, 'x.mp4') }, { from: path.join(film, 'missing.mp4'), to: path.join(film, 'y.mp4') }]), /rolled back/);
  assert.equal(fs.readFileSync(a, 'utf8'), 'C');
  assert.ok(!fs.existsSync(path.join(film, 'x.mp4')));
});

test('naming several clips at once: takes count up, one shot each, conflicts left alone, one undo', async () => {
  const { p, film } = await setup(['A001_C1.mp4', 'A001_C2.mp4', 'A001_C3.mp4', 'cuts/A001_C2-cut-1.mp4', 'Old-scene5-shot2-take2.mp4']);
  const keys = ['A001_C1.mp4', 'A001_C2.mp4', 'A001_C3.mp4'].map((n) => p.library.find((e) => e.name === n).key);

  // takes of one shot, counting up from 1
  const pv = await p.renameMany(keys.map((key, i) => ({ key, scene: '5', shot: '2', take: 1 + i })));
  assert.deepEqual(pv.changes.map((c) => c.to), ['Old-scene5-shot2-take1.mp4', 'Old-scene5-shot2-take3.mp4']);
  assert.deepEqual(pv.conflicts.map((c) => c.name), ['A001_C2.mp4'], 'take 2 of shot 2 already exists, so that clip is left alone');
  assert.ok(fs.existsSync(path.join(film, 'A001_C1.mp4')), 'a preview changes nothing');

  // starting after the existing take: all three go through, the cut moves with its clip
  const r = await p.renameMany(keys.map((key, i) => ({ key, scene: '5', shot: '2', take: 3 + i })), { apply: true });
  assert.equal(r.renamed, 3);
  assert.deepEqual(names(film).filter((n) => n.endsWith('.mp4')), ['Old-scene5-shot2-take2.mp4', 'Old-scene5-shot2-take3.mp4', 'Old-scene5-shot2-take4.mp4', 'Old-scene5-shot2-take5.mp4']);
  assert.deepEqual(names(path.join(film, 'cuts')), ['Old-scene5-shot2-take4-cut-1.mp4']);
  assert.equal(p.library.find((e) => e.name === 'Old-scene5-shot2-take4.mp4').orig, 'A001_C2.mp4', 'the camera name is remembered');
  await p.undo();
  assert.deepEqual(names(film).filter((n) => n.endsWith('.mp4')).sort(), ['A001_C1.mp4', 'A001_C2.mp4', 'A001_C3.mp4', 'Old-scene5-shot2-take2.mp4']);

  // one shot each: shots 7, 8, 9, take 1
  const each = await p.renameMany(keys.map((key, i) => ({ key, scene: '5', shot: String(7 + i), take: 1 })), { apply: true });
  assert.deepEqual(each.changes.map((c) => c.to), ['Old-scene5-shot7-take1.mp4', 'Old-scene5-shot8-take1.mp4', 'Old-scene5-shot9-take1.mp4']);

  // bad input is reported, never half-applied
  const bad = await p.renameMany([{ key: 'nope.mp4', scene: '1', shot: '1', take: 1 }, { key: each.changes[0].key, scene: '', shot: '1', take: 1 }]);
  assert.equal(bad.conflicts.length, 2);
  await assert.rejects(() => p.renameMany([]), /at least one/);
});

test('renaming takes that are already named: a whole shot moves, takes renumber, duplicate tags follow the name', async () => {
  const { p, film } = await setup(['Old-scene1-shot3-take1.mp4', 'Old-scene1-shot3-take2.mp4', 'Old-scene1-shot3-take2-dupC9.mp4', 'cuts/Old-scene1-shot3-take1-cut-1.mp4', 'Old-scene1-shot4-take1.mp4']);
  const of = (n) => p.library.find((e) => e.name === n).key;
  const shot3 = ['Old-scene1-shot3-take1.mp4', 'Old-scene1-shot3-take2.mp4', 'Old-scene1-shot3-take2-dupC9.mp4'].map(of);

  // shot 3 is really shot 4: its takes would land on shot 4's take 1
  let pv = await p.renameMany(shot3.map((key, i) => ({ key, scene: '1', shot: '4', take: [1, 2, 2][i] })));
  assert.ok(pv.conflicts.length >= 1, 'a name that already exists is not overwritten');

  // renumbered after the takes that are staying (take 1 of shot 4 stays)
  const r = await p.renameMany(shot3.map((key, i) => ({ key, scene: '1', shot: '4', take: 2 + i })), { apply: true });
  assert.equal(r.renamed, 3);
  assert.deepEqual(r.changes.map((c) => c.to), ['Old-scene1-shot4-take2.mp4', 'Old-scene1-shot4-take3.mp4', 'Old-scene1-shot4-take4.mp4'], 'a new name starts clean: no -dup tag');
  assert.ok(r.changes.every((c) => c.newKey && c.newKey !== c.key), 'the client is told where each take went');
  assert.deepEqual(names(path.join(film, 'cuts')), ['Old-scene1-shot4-take2-cut-1.mp4'], 'the cut followed its take');

  // changing nothing keeps a duplicate tag
  const dupKey = p.library.find((e) => e.name === 'Old-scene1-shot4-take4.mp4').key;
  const nothing = await p.renameMany([{ key: dupKey, scene: '1', shot: '4', take: 4 }]);
  assert.equal(nothing.changes.length, 0);
  await p.undo();
  assert.ok(fs.existsSync(path.join(film, 'Old-scene1-shot3-take2-dupC9.mp4')), 'undo restores the old names, tags included');
});

test('a file that is briefly locked is retried, and one that stays locked fails cleanly with everything put back', async () => {
  const { p, film } = await setup(['A001_C1.mp4', 'A001_C2.mp4']);
  const k1 = p.library.find((e) => e.name === 'A001_C1.mp4').key;
  const k2 = p.library.find((e) => e.name === 'A001_C2.mp4').key;
  const real = fs.renameSync;
  const busyError = () => Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
  try {
    // locked for the first two attempts, then free (Dropbox finishes syncing, a thumbnail finishes)
    let strikes = 2;
    fs.renameSync = (a, b) => { if (/A001_C1\.mp4$/.test(a) && strikes-- > 0) throw busyError(); return real(a, b); };
    const r = await p.renameMany([{ key: k1, scene: '1', shot: '1', take: 1 }, { key: k2, scene: '1', shot: '1', take: 2 }], { apply: true });
    assert.equal(r.renamed, 2, 'it waited and then succeeded');
    await p.undo();

    // locked for good: nothing is renamed, nothing is left half done, and the message says what to do
    fs.renameSync = (a, b) => { if (/A001_C2\.mp4$/.test(a)) throw busyError(); return real(a, b); };
    const pairs = ['A001_C1.mp4', 'A001_C2.mp4'].map((n, i) => ({ from: path.join(film, n), to: path.join(film, `Old-scene1-shot1-take${i + 1}.mp4`) }));
    await assert.rejects(
      () => p._moveAll(pairs, { delays: [1, 1] }),
      (e) => e.status === 423 && /in use by another program/.test(e.message) && /Nothing was changed/.test(e.message) && /A001_C2.mp4/.test(e.message));
  } finally { fs.renameSync = real; }
  assert.deepEqual(names(film).filter((n) => n.endsWith('.mp4')), ['A001_C1.mp4', 'A001_C2.mp4'], 'everything is back where it was');
  assert.equal(fs.readdirSync(film).filter((n) => n.startsWith('.kit-rename')).length, 0);
});

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
