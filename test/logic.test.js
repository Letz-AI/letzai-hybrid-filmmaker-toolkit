'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatStem, parseName, captionFor } = require('../server/lib/names');
const { parseShotListText, shotListToText } = require('../server/lib/shotlist');
const { buildCoverage } = require('../server/lib/coverage');
const { compareShots, natCompare } = require('../server/lib/util');
const { parseCsv, toCsv } = require('../server/lib/csv');
const { planSort } = require('../server/lib/canvas');

const naming = { prefix: 'Film', pad: { scene: 0, shot: 0, take: 0 } };

test('formatStem and parseName round-trip, including rating and print tags', () => {
  assert.equal(formatStem(naming, { scene: '6', shot: '2A', take: 3 }), 'Film-scene6-shot2A-take3');
  assert.equal(formatStem(naming, { scene: '6', shot: '2A', take: 3, rating: 'good', print: true }), 'Film-scene6-shot2A-take3-good-print');
  const p = parseName('MyFilm-scene14-shot2B-take1-ok-print.mov');
  assert.deepEqual({ scene: p.scene, shot: p.shot, take: p.take, rating: p.rating, print: p.print }, { scene: '14', shot: '2B', take: 1, rating: 'ok', print: true });
  assert.equal(parseName('A001_10171033_C047.mov'), null);
  assert.equal(parseName('Film-scene1-shot1-take4-cut-2.mp4').cut, 2);
  assert.deepEqual(parseName('Film-scene9-shot1-take2-dupC149.mov').extra, ['dupC149']);
});

test('padding is optional', () => {
  assert.equal(formatStem({ prefix: 'F', pad: { scene: 2, shot: 2, take: 3 } }, { scene: '6', shot: '2A', take: 3 }), 'F-scene06-shot2A-take003');
});

test('captions drop the project prefix and scene', () => {
  assert.equal(captionFor('MyFilm-scene6-shot2A-take3-good-cut-2.mp4'), 'shot2A-take3-good-cut-2');
});

test('shot ordering is numeric then alphabetic', () => {
  assert.deepEqual(['10', '2B', '2', '2A', '1'].sort(compareShots), ['1', '2', '2A', '2B', '10']);
  assert.deepEqual(['14', '6', '7'].sort(natCompare), ['6', '7', '14']);
});

test('shot list text parses scenes, ranges, optional shots, sizes and errors', () => {
  const { scenes, errors } = parseShotListText(`
# Scene 6 - Kitchen
6.1  Wide, Mira enters  [WS]
2A   Close on the cup
?6.4 Optional insert
Scene 7
7.1-3
nonsense line here
`);
  assert.equal(scenes.length, 2);
  const s6 = scenes.find((s) => s.scene === '6');
  assert.equal(s6.title, 'Kitchen');
  assert.deepEqual(s6.shots.map((s) => s.id), ['1', '2A', '4']);
  assert.equal(s6.shots[0].size, 'WS');
  assert.equal(s6.shots[2].optional, true);
  assert.deepEqual(scenes.find((s) => s.scene === '7').shots.map((s) => s.id), ['1', '2', '3']);
  assert.equal(errors.length, 1);
  assert.match(shotListToText(scenes), /Scene 6 - Kitchen/);
});

const clip = (scene, shot, take, extra = {}) => ({ kind: 'shot', key: `${scene}.${shot}.${take}`, name: `${scene}-${shot}-${take}`, scene, shot, take, rating: '', print: false, duration: 5, ...extra });

test('coverage: missing, shot, reviewed, selected, and numbering gaps', () => {
  const plan = [{ scene: '6', title: '', shots: [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4', optional: true }, { id: '5' }] }];
  const clips = [
    clip('6', '1', 1), clip('6', '1', 2, { rating: 'good', print: true }),
    clip('6', '2', 1, { rating: 'ok' }),
    clip('6', '3', 1),
    clip('6', '9', 1), // not planned
    clip('8', '1', 1), clip('8', '4', 1), // no plan for scene 8: 2 and 3 are gaps
  ];
  const { scenes, totals } = buildCoverage(clips, plan);
  const s6 = scenes.find((s) => s.id === '6');
  const st = Object.fromEntries(s6.shots.map((s) => [s.id, s.status]));
  assert.deepEqual(st, { 1: 'selected', 2: 'reviewed', 3: 'shot', 4: 'optional', 5: 'missing', 9: 'shot' });
  assert.equal(s6.shots.find((s) => s.id === '9').extra, true);
  assert.equal(s6.shots.find((s) => s.id === '1').best, '6.1.2');
  const s8 = scenes.find((s) => s.id === '8');
  assert.deepEqual(s8.shots.map((s) => `${s.id}:${s.status}`), ['1:shot', '2:gap', '3:gap', '4:shot']);
  assert.equal(totals.missing, 3);
  assert.equal(totals.scenes, 2);
});

test('coverage flags take gaps and duplicate take numbers', () => {
  const { scenes } = buildCoverage([clip('1', '1', 1), clip('1', '1', 4), clip('1', '1', 4, { name: 'dup' })], []);
  const sh = scenes[0].shots[0];
  assert.deepEqual(sh.takeGaps, [2, 3]);
  assert.deepEqual(sh.dupTakes, [4]);
});

test('csv round trip handles quotes, commas and newlines', () => {
  const rows = [{ A: 'x,y', B: 'say "hi"', C: 'line1\nline2' }];
  assert.deepEqual(parseCsv(toCsv(['A', 'B', 'C'], rows)), rows);
});

test('canvas sort puts clips under their Scene label by shot, take, cut', () => {
  const L = { clipW: 100, clipH: 50, gap: 10, capH: 20, cols: 2, originDX: 0, originDY: 1000 };
  const mk = (id, name, y = 0) => ({ id, clientNodeId: `ltn:${name}`, kind: 'media', position: { x: 0, y }, size: { w: 1, h: 1 } });
  const page = {
    nodes: [
      { id: 'L', kind: 'text', data: { text: 'Scene 6' }, position: { x: 500, y: 0 }, size: { w: 1, h: 1 } },
      mk('a', 'P-scene6-shot2-take1.mp4'), mk('b', 'P-scene6-shot1-take2-cut-1.mp4'), mk('c', 'P-scene6-shot1-take1.mp4'),
    ],
  };
  const ups = planSort(page, L);
  const pos = Object.fromEntries(ups.map((u) => [u.id, u.patch.position]));
  assert.deepEqual(pos.c, { x: 500, y: 1020 }); // shot1-take1 first
  assert.deepEqual(pos.b, { x: 610, y: 1020 }); // then shot1-take2
  assert.deepEqual(pos.a, { x: 500, y: 1100 }); // next row
});
