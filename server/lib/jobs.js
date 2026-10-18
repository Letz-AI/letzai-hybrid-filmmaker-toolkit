'use strict';
// A tiny job queue with lanes (so heavy ffmpeg work never runs too many at once), priorities, and live progress events.
const { EventEmitter } = require('events');
const crypto = require('crypto');

const LANE_LIMITS = { proxy: 2, cut: 1, upload: 2, misc: 2, vision: 1 };
// Quiet background work gets fewer slots than the lane: the rest are kept free for something you are waiting for.
const BACKGROUND_LIMITS = { proxy: 1 };

class Jobs extends EventEmitter {
  constructor() {
    super();
    this.list = [];
    this.running = { proxy: 0, cut: 0, upload: 0, misc: 0, vision: 0 };
    this.runningBg = { proxy: 0, cut: 0, upload: 0, misc: 0, vision: 0 };
    this.paused = new Set(); // lanes whose queued background jobs should wait
  }

  /**
   * @param {{lane:string, title:string, detail?:string, dedupeKey?:string, priority?:number, background?:boolean, run:(ctx)=>Promise<any>}} spec
   * priority: higher runs first within a lane (something the user is waiting for beats background work).
   * background: shown as a quiet summary, not as one more job; dropped from the list when done.
   * ctx = { progress(fraction, detail?), signal }
   */
  add(spec) {
    if (spec.dedupeKey) {
      const dup = this.list.find((j) => j.dedupeKey === spec.dedupeKey && (j.state === 'queued' || j.state === 'running'));
      if (dup) {
        // someone is now waiting for a job that was only queued in the background: move it to the front
        if (dup.state === 'queued' && (spec.priority || 0) > dup.priority) {
          dup.priority = spec.priority;
          if (!spec.background) dup.background = false;
          this._emit(dup);
          this._pump();
        }
        return dup;
      }
    }
    const job = {
      id: crypto.randomBytes(5).toString('hex'),
      lane: spec.lane || 'misc',
      title: spec.title,
      detail: spec.detail || '',
      dedupeKey: spec.dedupeKey || null,
      priority: spec.priority || 0,
      background: !!spec.background,
      state: 'queued',
      progress: 0,
      error: null,
      createdAt: Date.now(),
      finishedAt: null,
    };
    Object.defineProperty(job, '_run', { value: spec.run, enumerable: false });
    Object.defineProperty(job, '_abort', { value: new AbortController(), enumerable: false });
    this.list.unshift(job);
    if (this.list.length > 600) this.list.length = 600;
    this._emit(job);
    this._pump();
    return job;
  }

  cancel(id) {
    const job = this.list.find((j) => j.id === id);
    if (!job) return false;
    if (job.state === 'queued') { job.state = 'canceled'; job.finishedAt = Date.now(); this._emit(job); return true; }
    if (job.state === 'running') { job._abort.abort(); return true; }
    return false;
  }

  /** Stop all queued background jobs of a lane that have not started (running ones finish). */
  cancelBackground(lane) {
    let n = 0;
    for (const j of this.list) if (j.background && j.lane === lane && j.state === 'queued') { j.state = 'canceled'; j.finishedAt = Date.now(); this._emit(j); n++; }
    this.list = this.list.filter((j) => !(j.background && j.state === 'canceled'));
    this.emit('reset', this.snapshot());
    return n;
  }

  clearFinished() {
    this.list = this.list.filter((j) => j.state === 'queued' || j.state === 'running');
    this.emit('reset', this.snapshot());
  }

  snapshot() {
    return this.list.map((j) => ({ ...j }));
  }

  _emit(job) {
    this.emit('job', { ...job });
  }

  _pump() {
    // highest priority first, then oldest first
    const queued = this.list.filter((j) => j.state === 'queued').sort((a, b) => (b.priority - a.priority) || (a.createdAt - b.createdAt));
    for (const job of queued) {
      const limit = LANE_LIMITS[job.lane] || 1;
      if (this.running[job.lane] >= limit) continue;
      if (job.background && this.runningBg[job.lane] >= (BACKGROUND_LIMITS[job.lane] || limit)) continue;
      this.running[job.lane]++;
      if (job.background) this.runningBg[job.lane]++;
      job.state = 'running';
      this._emit(job);
      let last = 0;
      const ctx = {
        signal: job._abort.signal,
        progress: (f, detail) => {
          job.progress = Math.max(0, Math.min(1, f));
          if (detail != null) job.detail = detail;
          const now = Date.now();
          if (now - last > 150 || job.progress >= 1) { last = now; this._emit(job); }
        },
      };
      Promise.resolve()
        .then(() => job._run(ctx))
        .then(() => { job.state = 'done'; job.progress = 1; })
        .catch((e) => {
          if (e && e.cancelled || job._abort.signal.aborted) job.state = 'canceled';
          else { job.state = 'error'; job.error = (e && e.message) || String(e); }
        })
        .finally(() => {
          job.finishedAt = Date.now();
          this.running[job.lane]--;
          if (job.background) this.runningBg[job.lane]--;
          this._emit(job);
          // quiet background work that succeeded leaves no trace in the list
          if (job.background && job.state === 'done') this.list = this.list.filter((j) => j !== job);
          this._pump();
        });
    }
  }
}

module.exports = { Jobs };
