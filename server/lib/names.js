'use strict';
// File naming: <prefix>-scene<S>-shot<H>-take<T>[-extra][-rating][-print].<ext>
// Compatible with the earlier namer script this kit grew out of (same rating and print tags).
const { cleanToken } = require('./util');

const RATINGS = ['void', 'ok', 'good'];
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.avi', '.webm', '.mts', '.m2ts', '.mxf', '.mpg', '.mpeg']);

const pad = (value, width) => {
  const s = String(value);
  if (!/^\d+$/.test(s)) return s;
  const n = String(parseInt(s, 10));
  return width > 0 ? n.padStart(width, '0') : n;
};

/**
 * Build a stem (no extension) for a take.
 * @param {{prefix:string, pad?:{scene?:number,shot?:number,take?:number}}} naming
 * @param {{scene:string,shot:string,take:number|string,extra?:string[],rating?:string,print?:boolean}} t
 */
function formatStem(naming, t) {
  const p = naming.pad || {};
  let stem = `${cleanToken(naming.prefix || 'Film')}-scene${pad(cleanToken(t.scene), p.scene || 0)}` +
    `-shot${pad(cleanToken(t.shot), p.shot || 0)}-take${pad(String(t.take), p.take || 0)}`;
  for (const e of t.extra || []) stem += `-${cleanToken(e)}`;
  if (t.rating && RATINGS.includes(t.rating)) stem += `-${t.rating}`;
  if (t.print) stem += '-print';
  return stem;
}

const NAME_RE = /^(?<prefix>.+?)-scene(?<scene>[^-]+)-shot(?<shot>[^-]+)-take(?<take>\d+)(?<rest>(?:-[^-]+)*)$/i;

/**
 * Parse a file name (with or without extension). Returns null when it is not a named take.
 * Cuts ("...-cut-3") are reported via `cut`.
 */
function parseName(fileName) {
  const stem = String(fileName).replace(/\.[A-Za-z0-9]{2,4}$/, '');
  const m = NAME_RE.exec(stem);
  if (!m) return null;
  const { prefix, scene, shot, take, rest } = m.groups;
  const parts = rest ? rest.slice(1).split('-') : [];
  let rating = '';
  let print = false;
  let cut = 0;
  const extra = [];
  for (let i = 0; i < parts.length; i++) {
    const w = parts[i];
    if (w.toLowerCase() === 'cut' && /^\d+$/.test(parts[i + 1] || '')) { cut = parseInt(parts[i + 1], 10); i++; continue; }
    if (RATINGS.includes(w.toLowerCase())) { rating = w.toLowerCase(); continue; }
    if (w.toLowerCase() === 'print') { print = true; continue; }
    extra.push(w);
  }
  return { prefix, scene, shot, take: parseInt(take, 10), rating, print, extra, cut };
}

/** True for files we treat as video footage. */
const isVideoFile = (name) => VIDEO_EXT.has(String(name).slice(String(name).lastIndexOf('.')).toLowerCase());

/** Caption shown above a clip on the canvas: "shot2A-take3-good-cut-2". */
function captionFor(fileName) {
  const stem = String(fileName).replace(/\.[A-Za-z0-9]{2,4}$/, '');
  return stem.replace(/^.*?-scene[^-]+-/, '');
}

module.exports = { RATINGS, VIDEO_EXT, formatStem, parseName, isVideoFile, captionFor, pad };
