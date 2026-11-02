'use strict';
// Slate reading for a project: pick frames, ask the AI (see vision.js), remember the answer with the clip, and judge it against
// what is already known (the clip's name, the other takes, the shot list).
const fs = require('fs');
const vision = require('./vision');
const { httpError } = require('./util');

// Slates are usually shown right at the start. If the first look finds none, a second pass looks further in.
const PASSES = [[0.4, 1, 1.7, 2.5, 3.5, 4.8], [6, 7.5, 9, 10.5, 12, 14]];
const FRAME_WIDTH = 1024;
const TOKENS_PER_FRAME = 800; // a 1024x576 image is about 790 input tokens
const PROMPT_TOKENS = 450;

/** Times to grab for a pass, inside the clip. */
function frameTimes(duration, pass = 0) {
  const d = duration || 0;
  const base = PASSES[pass] || [];
  const t = d ? base.filter((x) => x < d - 0.3) : base;
  if (!t.length && pass === 0) return [Math.min(0.5, Math.max(0, d / 2))];
  return t;
}

const same = (e, r) => String(e.scene) === String(r.scene) && String(e.shot).toUpperCase() === String(r.shot) && e.take === r.take;
const nameOf = (r) => `${r.scene}.${r.shot} take ${r.take}`;

/** What the reading means for this clip: status, and flags that deserve a second look. */
function view(project, e) {
  const r = e.slate;
  if (!r) return null;
  const complete = !!(r.scene && r.shot && r.take);
  const out = { ...r, status: !complete ? 'unreadable' : e.kind !== 'shot' ? 'new' : same(e, r) ? 'match' : 'differs', flags: [] };
  if (!complete) { if (r.slateVisible) out.flags.push('partial'); return out; }
  if (r.confidence < 0.7) out.flags.push('low');
  if (out.status === 'match') return out;
  const others = project.library.filter((x) => x.key !== e.key);
  // taken by a take that stays as it is; a take that was read differently is probably about to move away, so it is not in the way
  if (others.some((x) => x.kind === 'shot' && x.extra.length === 0 && same(x, r) && !(x.slate && x.slate.scene && x.slate.shot && x.slate.take && !same(x, x.slate)))) out.flags.push('taken');
  // two unnamed clips read as the same take
  if (others.some((x) => x.slate && x.kind !== 'shot' && x.slate.scene === r.scene && x.slate.shot === r.shot && x.slate.take === r.take)) out.flags.push('twice');
  const plan = project.state.shotList || [];
  if (plan.length && !plan.some((s) => String(s.scene) === String(r.scene))) out.flags.push('not-in-plan');
  // takes of a shot are recorded in order: an earlier recording cannot carry a higher take number
  if (e.recordedAt) {
    const clash = others.find((x) => x.kind === 'shot' && x.recordedAt && String(x.scene) === String(r.scene) && String(x.shot).toUpperCase() === r.shot
      && ((x.recordedAt < e.recordedAt && x.take >= r.take) || (x.recordedAt > e.recordedAt && x.take <= r.take)));
    if (clash) out.flags.push('order');
  }
  return out;
}

/** Which of these clips would be read (already read ones are skipped unless forced), and a rough size of the request. */
function estimate(project, keys, { force = false } = {}) {
  let clips = 0; let skipped = 0;
  for (const k of keys) {
    const e = project.byKey.get(k);
    if (!e) continue;
    if (e.slate && !force) { skipped++; continue; }
    clips++;
  }
  const frames = clips * PASSES[0].length;
  return { clips, skipped, frames, inputTokens: clips * (PASSES[0].length * TOKENS_PER_FRAME + PROMPT_TOKENS), ...vision.settings() };
}

async function grab(project, e, times) {
  const frames = [];
  for (const t of times) {
    const file = await project.thumb(e.key, t, FRAME_WIDTH);
    frames.push({ t, base64: fs.readFileSync(file).toString('base64') });
  }
  return frames;
}

/** Read one clip and remember the answer. Looks further into the clip when the first pass finds no slate. */
async function readOne(project, key, { provider, model, signal, force = false } = {}) {
  const e = project.byKey.get(key);
  if (!e) throw httpError(404, 'That clip is not in the project.');
  if (e.slate && !force) return e.slate;
  const dur = e.duration || (e.probe && e.probe.duration) || 0;
  let result = null; let pass = 0;
  const tokens = { in: 0, out: 0 };
  for (; pass < PASSES.length; pass++) {
    const times = frameTimes(dur, pass);
    if (!times.length) break;
    const frames = await grab(project, e, times);
    const r = await vision.readSlate(frames, { provider, model, signal });
    tokens.in += r.tokens.in; tokens.out += r.tokens.out;
    result = { ...r, frameT: times[r.frame - 1] };
    if (r.slateVisible) break;
  }
  const m = project.state.clips[key] || (project.state.clips[key] = {});
  m.sig = e.sig;
  const { frame, tokens: _t, ...rest } = result || { slateVisible: false, scene: null, shot: null, take: null, confidence: 0, evidence: '', other: '', frameT: 0 };
  m.slate = { ...rest, sig: e.sig, provider: provider || vision.settings().provider, model: model || vision.settings().model, pass: Math.min(pass + 1, PASSES.length), tokens, readAt: new Date().toISOString() };
  e.slate = m.slate;
  project.scheduleSave();
  return m.slate;
}

/**
 * Read many clips in a background job: three at a time, results saved as they arrive.
 * A failure that would repeat for every clip (bad key, no credit) stops the whole run.
 */
async function readMany(project, keys, { provider, model, signal, force = false, progress = () => {}, concurrency = 3 } = {}) {
  const todo = keys.filter((k) => { const e = project.byKey.get(k); return e && (force || !e.slate); });
  const failed = [];
  const total = todo.length;
  let done = 0; let used = 0; let stop = null; let next = 0; let lastEmit = 0;
  const emitSoon = () => { const now = Date.now(); if (now - lastEmit > 800) { lastEmit = now; project.emit('library'); } };
  const worker = async () => {
    while (next < todo.length && !stop) {
      if (signal && signal.aborted) throw Object.assign(new Error('Canceled'), { cancelled: true });
      const k = todo[next++];
      try {
        const r = await readOne(project, k, { provider, model, signal, force });
        used += r.tokens.in + r.tokens.out;
      } catch (e) {
        if (e.cancelled) throw e;
        failed.push({ key: k, name: (project.byKey.get(k) || {}).name || k, reason: e.message });
        if (vision.isFatal(e)) stop = e;
      }
      done++;
      progress(total ? done / total : 1, `${done} of ${total} read${failed.length ? `, ${failed.length} failed` : ''}`);
      emitSoon();
    }
  };
  try { await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker)); } finally { project.emit('library'); }
  if (stop) throw stop;
  if (failed.length) throw httpError(502, `${failed.length} of ${total} clips could not be read: ${failed[0].reason}`, { failed });
  return { read: total, tokens: used };
}

function clear(project, keys) {
  let n = 0;
  for (const k of keys) {
    const m = project.state.clips[k];
    if (m && m.slate) { delete m.slate; const e = project.byKey.get(k); if (e) e.slate = null; n++; }
  }
  if (n) { project.scheduleSave(); project.emit('library'); }
  return n;
}

module.exports = { frameTimes, view, estimate, readOne, readMany, clear, nameOf, PASSES };
