'use strict';
// Small shared helpers. No dependencies.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Windows reports a file that something else is reading (or Dropbox is syncing) as busy for a moment. */
/** Windows and macOS file systems ignore case by default; Linux does not. Two names that differ only by case are one file on the former. */
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';
const pathKey = (p) => { const r = path.resolve(p); return CASE_INSENSITIVE_FS ? r.toLowerCase() : r; };

const BUSY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const RENAME_DELAYS = [100, 200, 400, 800, 1500, 2500, 4000];

/** fs.rename that waits and tries again while the file is briefly locked (about 9 seconds in all). */
async function renameRetry(from, to, { delays = RENAME_DELAYS } = {}) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; } catch (e) {
      if (!BUSY_CODES.has(e.code) || i >= delays.length) throw e;
      await sleep(delays[i]);
    }
  }
}

/** A sentence a director can act on for a failed rename. */
function explainRename(err, file) {
  if (err && BUSY_CODES.has(err.code)) {
    return `${file ? path.basename(file) : 'A file'} is in use by another program (most likely Dropbox syncing it, or a preview being made), so it could not be renamed. Nothing was changed. Wait a moment and try again. [${err.code}]`;
  }
  return `Rename failed and was rolled back: ${err.message}`;
}

/** Natural ("2" < "10") case-insensitive compare. */
function natCompare(a, b) {
  return String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });
}

/** "2A" -> [2, "A"]; anything without a leading number sorts last. */
function shotParts(shot) {
  const m = /^(\d+)(.*)$/.exec(String(shot));
  return m ? [parseInt(m[1], 10), m[2].toUpperCase()] : [Number.MAX_SAFE_INTEGER, String(shot).toUpperCase()];
}

function compareShots(a, b) {
  const [an, as] = shotParts(a);
  const [bn, bs] = shotParts(b);
  if (an !== bn) return an < bn ? -1 : 1;
  return as < bs ? -1 : as > bs ? 1 : 0;
}

const toPosix = (p) => String(p).split(path.sep).join('/');

function hash(s, len = 16) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, len);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Write a file atomically (tmp + rename). Dropbox / antivirus can hold a file for a moment on Windows,
 * so a busy rename is retried a few times before giving up.
 */
async function atomicWrite(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, data);
  let lastErr;
  for (let i = 0; i < 10; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      lastErr = err;
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) break;
      await sleep(120 * (i + 1));
    }
  }
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  throw lastErr;
}

/** Filename-safe, no spaces (matches the original namer tool). */
function cleanToken(s) {
  return String(s ?? '').replace(/[<>:"/\\|?*\x00-\x1f\s]/g, '');
}

function formatTime(sec, frames) {
  if (sec == null || !isFinite(sec)) return '--:--';
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(frames ? 2 : 1).padStart(frames ? 5 : 4, '0')}`;
}

function httpError(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  if (extra) Object.assign(e, extra);
  return e;
}

/** Run async fn over items with limited concurrency, keeping order of results. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Run at most `n` async tasks at once; extra tasks wait in line. */
function limiter(n) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= n || !waiting.length) return;
    active++;
    const { fn, resolve, reject } = waiting.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { waiting.push({ fn, resolve, reject }); next(); });
}

module.exports = {
  pathKey, CASE_INSENSITIVE_FS, renameRetry, explainRename, BUSY_CODES,
  limiter, sleep, natCompare, shotParts, compareShots, toPosix, hash, readJson, atomicWrite,
  cleanToken, formatTime, httpError, mapLimit,
};
