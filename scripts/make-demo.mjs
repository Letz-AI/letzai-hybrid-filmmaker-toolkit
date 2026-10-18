#!/usr/bin/env node
// Generates a small synthetic film so you can try the kit without any footage of your own:
// slates, several takes per shot, a shot list with gaps, ratings, and a few unnamed clips to name from the slate.
//
//   npm run demo                 build the demo (once) and open it
//   node scripts/make-demo.mjs --dir /some/folder --no-launch
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const dir = path.resolve(opt('dir') || path.join(os.tmpdir(), 'letzai-kit-demo'));

const ff = require('../server/lib/ffmpeg.js').locate();
if (!ff.ok) { console.error('ffmpeg is needed to build the demo. See the README for how to install it.'); process.exit(1); }

const fontCandidates = ['C:/Windows/Fonts/arialbd.ttf', 'C:/Windows/Fonts/arial.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/System/Library/Fonts/Helvetica.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf'];
const font = fontCandidates.find((f) => fs.existsSync(f));
const esc = (s) => s.replace(/\\/g, '/').replace(/:/g, '\\:');
const text = (t, x, y, size, color = 'white') => (font ? `drawtext=fontfile='${esc(font)}':text='${t.replace(/[':]/g, '')}':x=${x}:y=${y}:fontsize=${size}:fontcolor=${color}` : 'null');

// two shoot days, so folders have something to show: scenes 1 and 2 on day 1, scene 3 (and the unnamed clips) on day 2
const footage = path.join(dir, 'footage');
const dayOf = (scene) => (Number(scene) >= 3 ? 'Shoot day 2' : 'Shoot day 1');
for (const d of ['Shoot day 1', 'Shoot day 2']) fs.mkdirSync(path.join(footage, d), { recursive: true });

// scene palettes: the "picture" is a slow gradient, so thumbnails look like frames rather than test charts
const SCENES = {
  1: { title: 'Kitchen', c0: '0x1b232a', c1: '0xd9a15f' },
  2: { title: 'Street', c0: '0x1c1f22', c1: '0x8fa0ad' },
  3: { title: 'Rooftop', c0: '0x2a1a38', c1: '0xf0704a' },
};

// [scene, shot, takes, description, size]
const PLAN = [
  [1, '1', 3, 'Wide, Mira enters', 'WS'],
  [1, '2', 2, 'Medium on Mira at the table', 'MS'],
  [1, '3', 4, 'Close on the cup', 'CU'],
  [1, '4', 0, 'Over the shoulder, the letter', 'OTS'],
  [2, '1', 2, 'Establishing, the empty street', 'EWS'],
  [2, '2', 1, 'Tracking, Mira walks', 'MS'],
  [2, '3', 0, 'Insert, the phone buzzes', 'CU'],
  [3, '1', 2, 'Skyline, golden hour', 'WS'],
  [3, '2', 3, 'Two shot, the argument', 'MS'],
];

function render(file, { scene, shot, take, seconds = 5, hue }) {
  const slate = 1.2;
  const label = scene ? `SCENE ${scene}   SHOT ${shot}   TAKE ${take}` : '';
  const pal = SCENES[scene] || SCENES[1];
  const filters = [
    `[0:v]${text('LE DEMO', 380, 150, 54, 'black')},${text(label, 150, 330, 60, 'black')},${text('DEMO FILM   CAMERA A', 330, 470, 34, 'black')}[s]`,
    `[1:v]format=yuv420p,${text(scene ? `scene ${scene}.${shot}  take ${take}` : 'unslated clip', 40, 40, 30, 'white@0.8')}[b]`,
    '[s][b]concat=n=2:v=1:a=0[v]',
  ].join(';');
  const args = ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=0xeeeeee:s=1280x720:r=25:d=${slate}`,
    '-f', 'lavfi', '-i', `gradients=s=1280x720:r=25:d=${seconds}:c0=${pal.c0}:c1=${pal.c1}:speed=0.015:seed=${(scene || 0) * 13 + Number(shot || 0) * 5 + take}`,
    '-f', 'lavfi', '-i', `sine=f=${220 + (hue % 200)}:d=${seconds + slate}`,
    '-filter_complex', filters, '-map', '[v]', '-map', '2:a',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-shortest', file];
  const r = spawnSync(ff.ffmpeg, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed for ${file}: ${r.stderr}`);
}

const made = [];
let n = 0;
for (const [scene, shot, takes] of PLAN) {
  for (let t = 1; t <= takes; t++) {
    const name = `DemoFilm-scene${scene}-shot${shot}-take${t}.mp4`;
    const file = path.join(footage, dayOf(scene), name);
    if (!fs.existsSync(file)) {
      process.stdout.write(`\r  rendering ${++n}…`);
      render(file, { scene, shot, take: t, seconds: 3 + ((scene * 7 + t * 3) % 5), hue: scene * 70 + t * 25 });
    }
    made.push({ scene, shot, take: t, name });
  }
}
// unnamed clips, slated, waiting for Ingest
const raws = [['A001_C101.mp4', 1, '4', 1], ['A001_C102.mp4', 2, '3', 1], ['A001_C103.mp4', 3, '1', 3]];
for (const [name, scene, shot, take] of raws) {
  const file = path.join(footage, 'Shoot day 2', name);
  if (!fs.existsSync(file)) { process.stdout.write(`\r  rendering ${++n}…`); render(file, { scene, shot, take, seconds: 4, hue: 40 + take * 60 }); }
}
console.log('\r  demo footage ready.        ');

const rel = (name) => { const m = /scene(\d+)-/.exec(name); return `footage/${dayOf(m ? m[1] : 3)}/${name}`; };
const clips = {};
const meta = (name, m) => { clips[rel(name)] = m; };
meta('DemoFilm-scene1-shot1-take2.mp4', { rating: 'good', print: true, note: 'Best entrance, the pause before the door.' });
meta('DemoFilm-scene1-shot1-take1.mp4', { rating: 'void', note: 'Boom in frame.' });
meta('DemoFilm-scene1-shot2-take1.mp4', { rating: 'ok' });
meta('DemoFilm-scene1-shot2-take2.mp4', { rating: 'good', print: true });
meta('DemoFilm-scene1-shot3-take3.mp4', { rating: 'ok', note: 'Focus pulls late.' });
meta('DemoFilm-scene2-shot1-take1.mp4', { rating: 'good', print: true });
meta('DemoFilm-scene3-shot2-take2.mp4', { rating: 'good' });

// "AI versions" of two takes, so Compare has something to show: the same picture, restyled. They are cut from the
// original after the slate, so they start 1.2 s into the take.
const aiDir = path.join(dir, 'ai-results');
fs.mkdirSync(aiDir, { recursive: true });
function restyle(srcName, outName, vf, label) {
  const src = path.join(footage, dayOf(Number(/scene(\d+)-/.exec(srcName)[1])), srcName);
  const out = path.join(aiDir, outName);
  if (!fs.existsSync(out)) {
    const r = spawnSync(ff.ffmpeg, ['-v', 'error', '-y', '-ss', '1.2', '-i', src, '-t', '3', '-vf', `${vf},${text(label, 40, 640, 34, 'white')}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-an', out], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`ffmpeg failed for ${outName}: ${r.stderr}`);
  }
  return out;
}
const aiResults = {
  'DemoFilm-scene1-shot1-take2.mp4': [
    { file: restyle('DemoFilm-scene1-shot1-take2.mp4', 'scene1-shot1-take2_ai-v1.mp4', 'eq=contrast=1.25:saturation=1.9,hue=h=-18,noise=alls=10:allf=t', 'AI v1  warm grade'), label: 'Warm film look', note: 'Skin tones hold up. The window blows out a little.' },
    { file: restyle('DemoFilm-scene1-shot1-take2.mp4', 'scene1-shot1-take2_ai-v2.mp4', 'hue=s=0.15,eq=contrast=1.35:brightness=-0.04,noise=alls=6:allf=t', 'AI v2  desaturated'), label: 'Cold and desaturated', note: '' },
  ],
  'DemoFilm-scene1-shot3-take3.mp4': [
    { file: restyle('DemoFilm-scene1-shot3-take3.mp4', 'scene1-shot3-take3_ai-v1.mp4', 'curves=preset=vintage,eq=saturation=1.4', 'AI v1  vintage'), label: 'Vintage', note: '' },
  ],
};
for (const [take, list] of Object.entries(aiResults)) {
  const c = (clips[rel(take)] = clips[rel(take)] || {});
  c.ai = list.map((a, i) => ({ id: `demoai${Object.keys(clips).length}${i}`, kind: 'file', path: a.file, label: a.label, duration: 3, width: 1280, height: 720, fps: 25, originalStart: 1.2, note: a.note, addedAt: new Date().toISOString() }));
}

const project = {
  version: 1,
  name: 'Demo film',
  prefix: 'DemoFilm',
  naming: { pad: { scene: 0, shot: 0, take: 0 }, ratingInFilename: false },
  folders: ['footage'],
  ignoreDirs: ['cuts', 'proxy', 'proxies', 'node_modules'],
  proxyDirs: ['Proxy', 'Proxies'],
  shotList: Object.entries(SCENES).map(([id, sc]) => ({
    scene: id, title: sc.title,
    shots: PLAN.filter((p) => String(p[0]) === id).map(([, shot, , desc, size]) => ({ id: shot, desc, size, optional: false })),
  })),
  clips,
  canvas: { canvasId: '', canvasName: '', pageId: '', pageName: '', layout: { clipW: 17174, clipH: 9660, gap: 2000, capH: 1700, cols: 3, originDX: -1373, originDY: 29664, captionSize: 1100 } },
  snippets: { maxSeconds: 30, height: 1080, lossless: false, encoder: 'auto' },
  history: [],
};
const pf = path.join(dir, 'letzai-kit.json');
if (!fs.existsSync(pf)) fs.writeFileSync(pf, `${JSON.stringify(project, null, 2)}\n`);

console.log(`  Demo film: ${dir}`);
if (!argv.includes('--no-launch')) {
  spawn(process.execPath, [path.join(root, 'server', 'index.js'), '--project', dir, ...argv.filter((a) => a === '--browser' || a === '--no-open')], { stdio: 'inherit' });
}
