'use strict';
// A project = one film. Its state lives in <film folder>/letzai-kit.json (small, human readable, safe to sync).
// Heavy generated files (review proxies, thumbnails, probe cache) live in the user's cache dir, never in the film folder.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const ff = require('./ffmpeg');
const cfg = require('./config');
const { formatStem, parseName, isVideoFile, RATINGS } = require('./names');
const { buildCoverage } = require('./coverage');
const { parseShotListText, shotListToText } = require('./shotlist');
const { parseCsv, toCsv } = require('./csv');
const { view: slateView } = require('./slate');
const { hash, readJson, atomicWrite, toPosix, compareShots, natCompare, httpError, mapLimit, formatTime, limiter, renameRetry, explainRename, pathKey } = require('./util');

// Thumbnails are requested in bursts (a whole Board at once). Never run more than a few ffmpeg processes for them,
// and never render the same frame twice at the same time.
const thumbLimit = limiter(3);
const inflight = new Map();
function renderOnce(out, fn) {
  if (!inflight.has(out)) inflight.set(out, thumbLimit(fn).finally(() => inflight.delete(out)));
  return inflight.get(out);
}
const { DEFAULT_LAYOUT } = require('./canvas');
const { suggestTake } = require('./ai');

const FILE_NAME = 'letzai-kit.json';
const SCHEMA = 1;

const DEFAULTS = () => ({
  version: SCHEMA,
  name: 'Untitled film',
  prefix: 'Film',
  naming: { pad: { scene: 0, shot: 0, take: 0 }, ratingInFilename: false },
  folders: [],
  ignoreDirs: ['cuts', 'proxy', 'proxies', 'node_modules'],
  proxyDirs: ['Proxy', 'Proxies'],
  shotList: [],
  clips: {},
  canvas: { canvasId: '', canvasName: '', pageId: '', pageName: '', mode: 'labels', layout: { ...DEFAULT_LAYOUT } },
  sent: {},
  playback: { prepare: true },
  snippets: { maxSeconds: 30, height: 1080, lossless: false, encoder: 'auto' },
  history: [],
});

const inFolder = (dir, folder) => folder === '.' || dir === folder || dir.startsWith(`${folder}/`);

const sigOf = (st) => `${st.size}-${Math.round(st.mtimeMs)}`;

class Project extends EventEmitter {
  constructor(root, { jobs }) {
    super();
    this.root = path.resolve(root);
    this.jobs = jobs;
    this.file = path.join(this.root, FILE_NAME);
    this.id = hash(this.root.toLowerCase());
    this.state = DEFAULTS();
    this.library = [];
    this.byKey = new Map();
    this.canvasNames = new Set(); // file names known to be on the canvas (last sync)
    this.canvasErrors = new Map(); // clip key -> { message, files[], at } for the last failed send
    this.canvasSyncedAt = null;
    this.scanning = false;
    this.cache = path.join(cfg.cacheDir(), this.id);
    this.probeCache = readJson(path.join(this.cache, 'probe.json'), {});
    this._saveTimer = null;
    this._probeTimer = null;
  }

  static exists(root) { return fs.existsSync(path.join(root, FILE_NAME)); }

  static async create(root, init, ctx) {
    const p = new Project(root, ctx);
    Object.assign(p.state, { name: init.name || path.basename(root), prefix: (init.prefix || path.basename(root)).replace(/[^A-Za-z0-9_.]/g, '') || 'Film' });
    p.state.folders = (init.folders && init.folders.length ? init.folders : []).map((f) => p.relOrAbs(f));
    await p.saveNow();
    return p;
  }

  load() {
    const raw = readJson(this.file, null);
    if (!raw) throw httpError(404, `No ${FILE_NAME} in ${this.root}`);
    const d = DEFAULTS();
    this.state = {
      ...d, ...raw,
      naming: { ...d.naming, ...raw.naming, pad: { ...d.naming.pad, ...(raw.naming && raw.naming.pad) } },
      canvas: { ...d.canvas, ...raw.canvas, layout: { ...d.canvas.layout, ...(raw.canvas && raw.canvas.layout) } },
      snippets: { ...d.snippets, ...raw.snippets },
      sent: { ...(raw.sent || {}) },
      playback: { ...d.playback, ...(raw.playback || {}) },
    };
    return this;
  }

  // ---- persistence -------------------------------------------------------
  scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveNow().catch((e) => this.emit('error', e)), 350);
  }

  async saveNow() {
    clearTimeout(this._saveTimer);
    // Drop empty metadata so the file stays small.
    for (const [k, m] of Object.entries(this.state.clips)) {
      const keep = m.rating || m.print || m.note || m.skip || (m.tags && m.tags.length) || (m.marks && m.marks.length) || (m.cuts && m.cuts.length) || (m.ai && m.ai.length) || m.slate || m.orig;
      if (!keep) delete this.state.clips[k];
    }
    this.state.history = this.state.history.slice(0, 100);
    await atomicWrite(this.file, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  // ---- paths ---------------------------------------------------------------
  relOrAbs(p) {
    const abs = path.resolve(this.root, p);
    const rel = path.relative(this.root, abs);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? toPosix(rel) : abs;
  }

  absOf(key) { return path.isAbsolute(key) ? key : path.join(this.root, key); }
  keyOf(abs) { return this.relOrAbs(abs); }
  folderPaths() { return this.state.folders.map((f) => path.resolve(this.root, f)); }

  // ---- scanning -------------------------------------------------------------
  async scan() {
    if (this.scanning) return this.library;
    this.scanning = true;
    try {
      const ignore = new Set(this.state.ignoreDirs.map((s) => s.toLowerCase()));
      const files = [];
      const walk = (dir, depth) => {
        let ents;
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          if (e.name.startsWith('.')) continue; // includes macOS "._" resource forks
          const full = path.join(dir, e.name);
          if (e.isDirectory()) { if (depth < 3 && !ignore.has(e.name.toLowerCase())) walk(full, depth + 1); }
          else if (e.isFile() && isVideoFile(e.name) && !/\.part\.[a-z0-9]+$/i.test(e.name)) files.push(full);
        }
      };
      for (const f of this.folderPaths()) walk(f, 0);

      const dirCache = new Map();
      const listDir = (d) => {
        if (!dirCache.has(d)) { try { dirCache.set(d, fs.readdirSync(d)); } catch { dirCache.set(d, []); } }
        return dirCache.get(d);
      };

      const entries = [];
      const seen = new Set();
      for (const abs of files.sort((a, b) => natCompare(a, b))) {
        const key = this.keyOf(abs);
        if (seen.has(key)) continue;
        seen.add(key);
        let st;
        try { st = fs.statSync(abs); } catch { continue; }
        const name = path.basename(abs);
        const ext = path.extname(name);
        const stem = path.basename(name, ext);
        const parsed = parseName(name);
        const sig = sigOf(st);
        entries.push({
          key, abs, name, stem, ext, dir: toPosix(path.relative(this.root, path.dirname(abs))) || '.',
          size: st.size, mtimeMs: st.mtimeMs, sig,
          kind: parsed && !parsed.cut ? 'shot' : 'raw',
          parsed: parsed && !parsed.cut ? parsed : null,
        });
      }

      // Metadata follows a file even if it was renamed outside the kit (matched by size+mtime fingerprint).
      const orphans = Object.entries(this.state.clips).filter(([k, m]) => !seen.has(k) && m.sig);
      if (orphans.length) {
        for (const e of entries) {
          if (this.state.clips[e.key]) continue;
          const hit = orphans.find(([k, m]) => m.sig === e.sig && !seen.has(k));
          if (hit) {
            this.state.clips[e.key] = this.state.clips[hit[0]];
            delete this.state.clips[hit[0]];
            this.scheduleSave();
          }
        }
      }

      const proxyNames = this.state.proxyDirs;
      for (const e of entries) {
        const m = this.state.clips[e.key] || {};
        const probe = this.probeCache[e.sig];
        const p = e.parsed;
        e.scene = p ? p.scene : '';
        e.shot = p ? p.shot : '';
        e.take = p ? p.take : 0;
        e.extra = p ? p.extra : [];
        // Metadata wins; tags in the file name (from the old namer tool) fill in what the sidecar lacks.
        e.rating = RATINGS.includes(m.rating) ? m.rating : (p && p.rating) || '';
        e.print = m.print != null ? !!m.print : !!(p && p.print);
        e.note = m.note || '';
        e.skip = !!m.skip;
        e.tags = m.tags || [];
        e.marks = m.marks || [];
        e.cutRanges = m.cuts || [];
        // generated versions of this take (files on disk or links to the canvas)
        e.ai = (m.ai || []).map((a) => ({ ...a, name: a.kind === 'file' ? path.basename(a.path) : a.label, missing: a.kind === 'file' && !fs.existsSync(a.path) }));
        // what Claude read from the slate (kept only while the file is the one that was read)
        e.slate = m.slate && m.slate.sig === e.sig ? m.slate : null;
        e.orig =m.orig || (e.kind === 'raw' ? e.name : '');
        e.probe = probe && !probe.error ? probe : null;
        e.duration = e.probe ? e.probe.duration : 0;
        e.recordedAt = e.probe ? e.probe.recordedAt : '';
        // cut snippets sitting in <dir>/cuts/
        const dirAbs = path.dirname(e.abs);
        const prefix = `${e.stem}-cut-`.toLowerCase();
        e.cutFiles = listDir(path.join(dirAbs, 'cuts'))
          .filter((n) => n.toLowerCase().startsWith(prefix) && isVideoFile(n) && !/\.part\./i.test(n))
          .map((n) => ({ name: n, n: parseInt((/-cut-(\d+)/i.exec(n) || [])[1] || '0', 10) }))
          .sort((a, b) => a.n - b.n);
        e.cutOnCanvas = e.cutFiles.filter((c) => this.canvasNames.has(c.name)).length;
        e.onCanvas = e.cutFiles.length > 0 && e.cutOnCanvas === e.cutFiles.length;
        // the camera's own proxy, if any
        e.camProxy = null;
        const candidates = [m.proxy ? this.absOf(m.proxy) : null];
        for (const pd of proxyNames) {
          for (const base of [e.stem, m.orig && path.basename(m.orig, path.extname(m.orig))].filter(Boolean)) {
            for (const n of listDir(path.join(dirAbs, pd))) {
              if (!n.startsWith('.') && isVideoFile(n) && path.basename(n, path.extname(n)).toLowerCase() === base.toLowerCase()) candidates.push(path.join(dirAbs, pd, n));
            }
          }
        }
        e.camProxy = candidates.find((c) => c && fs.existsSync(c)) || null;
      }

      entries.sort((a, b) => (a.recordedAt || '').localeCompare(b.recordedAt || '') || natCompare(a.name, b.name));
      this.library = entries;
      this.byKey = new Map(entries.map((e) => [e.key, e]));
      this.emit('library');
      this._probeMissing();
      return this.library;
    } finally {
      this.scanning = false;
    }
  }

  /** Probe files we haven't seen before, a few at a time, in the background. */
  async _probeMissing() {
    if (this._probing) return;
    this._probing = true;
    try {
      const todo = this.library.filter((e) => !this.probeCache[e.sig]);
      let done = 0;
      await mapLimit(todo, 4, async (e) => {
        try { this.probeCache[e.sig] = await ff.probe(e.abs); } catch (err) { this.probeCache[e.sig] = { error: err.message }; }
        done++;
        if (done % 6 === 0) this._applyProbes();
      });
      if (todo.length) { this._applyProbes(); this._saveProbeCache(); }
    } finally {
      this._probing = false;
    }
    this.autoProxy();
  }

  _applyProbes() {
    for (const e of this.library) {
      const p = this.probeCache[e.sig];
      if (p && !p.error) { e.probe = p; e.duration = p.duration; e.recordedAt = p.recordedAt; }
    }
    this.library.sort((a, b) => (a.recordedAt || '').localeCompare(b.recordedAt || '') || natCompare(a.name, b.name));
    this.emit('library');
  }

  _saveProbeCache() {
    clearTimeout(this._probeTimer);
    this._probeTimer = setTimeout(() => {
      atomicWrite(path.join(this.cache, 'probe.json'), JSON.stringify(this.probeCache)).catch(() => {});
    }, 300);
  }

  async probeFile(abs) {
    const st = fs.statSync(abs);
    const sig = sigOf(st);
    if (!this.probeCache[sig] || this.probeCache[sig].error) {
      try { this.probeCache[sig] = await ff.probe(abs); } catch (e) { return { error: e.message }; }
      this._saveProbeCache();
    }
    return this.probeCache[sig];
  }

  // ---- client view -----------------------------------------------------------
  entry(key) {
    const e = this.byKey.get(key);
    if (!e) throw httpError(404, `Clip not found: ${key}`);
    return e;
  }

  toClient(e) {
    const { abs, parsed, camProxy, mtimeMs, ...rest } = e;
    return { ...rest, hasCamProxy: !!camProxy, canvasError: this.canvasErrors.get(e.key) || null, slate: slateView(this, e) };
  }

  snapshot() {
    const clips = this.library.map((e) => this.toClient(e));
    const coverage = buildCoverage(clips, this.state.shotList);
    const folders = this.folderTree();
    // Per folder: what was shot there. Planned-but-missing shots make no sense for a single shoot day, so no plan and no gaps.
    const coverageByFolder = {};
    for (const f of folders) {
      const subset = clips.filter((c) => inFolder(c.dir, f.path));
      if (subset.length) coverageByFolder[f.path] = buildCoverage(subset, [], { inferGaps: false });
    }
    return {
      project: this.summary(),
      clips,
      coverage,
      folders,
      coverageByFolder,
      shotListText: shotListToText(this.state.shotList),
      canvasSyncedAt: this.canvasSyncedAt,
    };
  }

  summary() {
    const s = this.state;
    return { id: this.id, root: this.root, playback: s.playback, name: s.name, prefix: s.prefix, naming: s.naming, folders: s.folders, ignoreDirs: s.ignoreDirs, proxyDirs: s.proxyDirs, canvas: s.canvas, snippets: s.snippets, history: s.history.length };
  }

  // ---- metadata ------------------------------------------------------------------
  async setMeta(key, patch) {
    const e = this.entry(key);
    const m = this.state.clips[key] || (this.state.clips[key] = {});
    m.sig = e.sig;
    if ('rating' in patch) m.rating = RATINGS.includes(patch.rating) ? patch.rating : '';
    if ('print' in patch) m.print = !!patch.print;
    if ('note' in patch) m.note = String(patch.note || '').slice(0, 2000);
    if ('skip' in patch) m.skip = !!patch.skip;
    if ('tags' in patch) m.tags = [...new Set((patch.tags || []).map((t) => String(t).trim().slice(0, 40)).filter(Boolean))];
    if ('marks' in patch) m.marks = (patch.marks || []).map((x) => ({ id: String(x.id || hash(Math.random())), t: Number(x.t) || 0, label: String(x.label || '').slice(0, 80) })).sort((a, b) => a.t - b.t);
    if ('cuts' in patch) {
      m.cuts = (patch.cuts || []).map((x) => ({ id: String(x.id || hash(Math.random())), in: Math.max(0, Number(x.in) || 0), out: Number(x.out) || 0, label: String(x.label || '').slice(0, 80) })).filter((x) => x.out > x.in).sort((a, b) => a.in - b.in);
    }
    this.scheduleSave();
    let finalKey = key;
    if (this.state.naming.ratingInFilename && ('rating' in patch || 'print' in patch) && e.kind === 'shot') {
      // the rating is part of the file name in this project, so the file follows
      const r = await this.renameClip(key, { scene: e.scene, shot: e.shot, take: e.take, quiet: true });
      finalKey = r.key || key;
    } else {
      // reflect immediately without a rescan
      Object.assign(e, { rating: m.rating || '', print: !!m.print, note: m.note || '', skip: !!m.skip, tags: m.tags || [], marks: m.marks || [], cutRanges: m.cuts || [] });
      this.emit('library');
    }
    return this.toClient(this.byKey.get(finalKey) || e);
  }

  // ---- renaming --------------------------------------------------------------------
  /** Highest take used for scene/shot, plus one. */
  nextTake(scene, shot) {
    const taken = this.library.filter((e) => e.kind === 'shot' && String(e.scene) === String(scene) && String(e.shot).toUpperCase() === String(shot).toUpperCase()).map((e) => e.take);
    return (taken.length ? Math.max(...taken) : 0) + 1;
  }

  planRename(e, { scene, shot, take, extra }) {
    const m = this.state.clips[e.key] || {};
    const rich = this.state.naming.ratingInFilename;
    const stem = formatStem({ prefix: this.state.prefix, pad: this.state.naming.pad }, {
      scene, shot: String(shot).toUpperCase(), take,
      extra: extra != null ? extra : e.extra,
      rating: rich ? (m.rating || e.rating) : '', print: rich ? (m.print != null ? m.print : e.print) : false,
    });
    return { stem, name: stem + e.ext, target: path.join(path.dirname(e.abs), stem + e.ext) };
  }

  /**
   * Rename a clip (and its cut snippets and camera proxy) to the film's naming scheme.
   * onConflict: 'fail' (default) | 'next' (use the next free take) | 'dup' (keep the number, add -dup<clip id>)
   */
  async renameClip(key, { scene, shot, take, onConflict = 'fail', quiet } = {}) {
    const e = this.entry(key);
    scene = String(scene ?? '').trim();
    shot = String(shot ?? '').trim();
    take = parseInt(take, 10);
    if (!scene || !shot || !Number.isFinite(take) || take < 1) throw httpError(400, 'Scene, shot and take are needed (take is a number).');
    let extra;
    let plan = this.planRename(e, { scene, shot, take, extra });
    const same = (a, b) => pathKey(a) === pathKey(b);
    const taken = () => fs.existsSync(plan.target) && !same(plan.target, e.abs);
    if (taken()) {
      if (onConflict === 'next') { take = this.nextTake(scene, shot); plan = this.planRename(e, { scene, shot, take, extra }); }
      else if (onConflict === 'dup') {
        const id = (e.probe && e.probe.camera.clipId ? e.probe.camera.clipId.split('_').pop() : e.stem.replace(/[^A-Za-z0-9]/g, '').slice(-6)) || 'x';
        extra = [...(e.extra || []).filter((x) => !/^dup/i.test(x)), `dup${id}`];
        plan = this.planRename(e, { scene, shot, take, extra });
      }
      if (taken()) throw httpError(409, `${plan.name} already exists.`, { code: 'exists', suggestion: { take: this.nextTake(scene, shot) } });
    }
    if (same(plan.target, e.abs) && plan.name === e.name) return { key, unchanged: true };

    const moves = [{ from: e.abs, to: plan.target }];
    const dirAbs = path.dirname(e.abs);
    const cutsDir = path.join(dirAbs, 'cuts');
    const oldPrefix = `${e.stem}-cut-`.toLowerCase();
    for (const c of e.cutFiles) {
      if (c.name.toLowerCase().startsWith(oldPrefix)) moves.push({ from: path.join(cutsDir, c.name), to: path.join(cutsDir, plan.stem + c.name.slice(e.stem.length)) });
    }
    let keepProxy = null;
    if (e.camProxy) {
      const to = path.join(path.dirname(e.camProxy), plan.stem + path.extname(e.camProxy));
      if (!fs.existsSync(to) || same(to, e.camProxy)) moves.push({ from: e.camProxy, to }); else keepProxy = e.camProxy;
    }
    for (const mv of moves.slice(1)) if (fs.existsSync(mv.to) && !same(mv.to, mv.from)) throw httpError(409, `${path.basename(mv.to)} already exists.`, { code: 'exists' });

    const done = [];
    let current = null;
    try {
      for (const mv of moves) { if (mv.from !== mv.to) { current = mv.from; await renameRetry(mv.from, mv.to); done.push(mv); } }
    } catch (err) {
      for (const mv of done.reverse()) { try { await renameRetry(mv.to, mv.from); } catch { /* best effort */ } }
      throw httpError(err.code && ['EBUSY', 'EPERM', 'EACCES'].includes(err.code) ? 423 : 500, explainRename(err, current), { code: err.code === 'EBUSY' ? 'busy' : undefined });
    }

    const newKey = this.keyOf(plan.target);
    const oldMeta = this.state.clips[key];
    const meta = oldMeta || (this.state.clips[key] = {});
    meta.sig = e.sig;
    if (!meta.orig && e.kind === 'raw') meta.orig = e.name;
    if (keepProxy) meta.proxy = this.keyOf(keepProxy);
    if (newKey !== key) { this.state.clips[newKey] = meta; delete this.state.clips[key]; }
    this.keyAfterRename = newKey;
    const entry = {
      id: hash(Math.random()), at: new Date().toISOString(), label: `${e.name} -> ${plan.name}`,
      moves: moves.map((m) => ({ from: this.keyOf(m.from), to: this.keyOf(m.to) })),
      meta: newKey !== key ? { from: key, to: newKey } : null,
    };
    if (!quiet) this.state.history.unshift(entry);
    this.scheduleSave();
    await this.scan();
    return { key: newKey, name: plan.name, take, history: entry.id };
  }

  /**
   * Move the project's notes about clips (ratings, cuts, AI mappings, slate readings...) to new keys. All of them are
   * taken out first and put back second, so swaps and chains ("take 2 becomes 3, take 3 becomes 2") cannot overwrite
   * each other. Returns the moves that were applied, for the undo record.
   */
  _moveMetas(list) {
    const moving = list.filter((m) => m.from !== m.to && this.state.clips[m.from]);
    const taken = moving.map((m) => ({ ...m, data: this.state.clips[m.from] }));
    for (const m of taken) delete this.state.clips[m.from];
    for (const m of taken) this.state.clips[m.to] = m.data;
    return taken.map(({ from, to }) => ({ from, to }));
  }

  async undo() {
    const h = this.state.history[0];
    if (!h) throw httpError(404, 'Nothing to undo.');
    // Two phases (everything to a temporary name, then to its old name) so any set of renames can be reversed,
    // even ones that swapped or chained names.
    const pairs = h.moves.map((mv) => ({ from: this.absOf(mv.to), to: this.absOf(mv.from) })).filter((p) => fs.existsSync(p.from));
    await this._moveAll(pairs, { skipIfTargetBusy: true });
    this.state.history.shift(); // only now: if the files were busy, undo can be tried again
    this._moveMetas((h.metas || (h.meta ? [h.meta] : [])).map((m) => ({ from: m.to, to: m.from })));
    this.scheduleSave();
    await this.scan();
    return { undone: h.label };
  }

  /**
   * Move many files at once, safely: every source goes to a temporary name first, then to its final name, so a name
   * that is both a target and a source (chains, swaps, case-only changes) cannot collide. If anything fails,
   * everything done so far is rolled back and the error is thrown.
   */
  async _moveAll(pairs, { skipIfTargetBusy = false, delays } = {}) {
    const id = Math.random().toString(36).slice(2, 7);
    const sources = new Set(pairs.map((p) => pathKey(p.from)));
    const work = skipIfTargetBusy ? pairs.filter((p) => !fs.existsSync(p.to) || sources.has(pathKey(p.to))) : pairs;
    const done = [];
    let current = null;
    const step = async (a, b) => { current = a; await renameRetry(a, b, delays ? { delays } : undefined); done.push([a, b]); };
    try {
      let i = 0;
      for (const p of work) { p.tmp = path.join(path.dirname(p.from), `.kit-rename-${id}-${i++}${path.extname(p.from)}`); await step(p.from, p.tmp); }
      for (const p of work) await step(p.tmp, p.to);
    } catch (err) {
      for (const [a, b] of done.reverse()) { try { await renameRetry(b, a, delays ? { delays } : undefined); } catch { /* best effort */ } }
      const original = work.find((p) => p.tmp === current || p.from === current);
      throw httpError(['EBUSY', 'EPERM', 'EACCES'].includes(err.code) ? 423 : 500, explainRename(err, original ? original.from : current), { code: err.code === 'EBUSY' ? 'busy' : undefined });
    }
  }

  /**
   * Work out what "rename all" would do: every named take (with its cuts and camera proxy) to the current naming
   * scheme (prefix, number padding, rating in the file name). Nothing is touched.
   */
  planRenameAll() {
    const norm = pathKey;
    // every take whose name would change, with all the files that move along with it
    const candidates = [];
    for (const e of this.library) {
      if (e.kind !== 'shot') continue;
      const plan = this.planRename(e, { scene: e.scene, shot: e.shot, take: e.take, extra: e.extra });
      if (plan.name === e.name) continue;
      candidates.push({ e, plan, moves: this._movesFor(e, plan) });
    }

    const { items, conflicts } = this._settle(candidates);
    return { total: this.library.filter((e) => e.kind === 'shot').length, items, conflicts };
  }

  /**
   * Given takes and where each wants to go, decide which can really move. A target is free if nothing is there, or if
   * the file there is itself moving away. Which takes move depends on which conflicts exist, so settle it by
   * dropping conflicted takes until nothing changes.
   */
  _settle(candidates) {
    const norm = pathKey;
    let moving = candidates.slice();
    const conflicts = [];
    for (let guard = 0; guard < 20; guard++) {
      const leaving = new Set(moving.flatMap((c) => c.moves.map((m) => norm(m.from))));
      const wanted = new Map();
      for (const c of moving) for (const m of c.moves) { const t = norm(m.to); wanted.set(t, (wanted.get(t) || 0) + 1); }
      const dropped = [];
      for (const c of moving) {
        const bad = c.moves.find((m) => {
          const t = norm(m.to);
          if (wanted.get(t) > 1) return true;                    // two files want the same name
          return fs.existsSync(m.to) && t !== norm(m.from) && !leaving.has(t); // taken by a file that stays
        });
        if (bad) dropped.push({ c, bad });
      }
      if (!dropped.length) break;
      for (const d of dropped) conflicts.push({ key: d.c.e.key, name: d.c.e.name, to: path.basename(d.bad.to), reason: `${path.basename(d.bad.to)} already exists` });
      const gone = new Set(dropped.map((d) => d.c));
      moving = moving.filter((c) => !gone.has(c));
    }
    const items = moving.map(({ e, plan, moves }) => ({ key: e.key, from: e.name, to: plan.name, stem: plan.stem, moves, cuts: moves.length - 1 - (e.camProxy ? 1 : 0), proxy: !!e.camProxy, onCanvas: e.cutOnCanvas || 0 }));
    return { items, conflicts };
  }

  /** The files that travel with a take when it is renamed: its cut snippets and the camera's proxy. */
  _movesFor(e, plan) {
    const dirAbs = path.dirname(e.abs);
    const moves = [{ from: e.abs, to: plan.target }];
    const oldPrefix = `${e.stem}-cut-`.toLowerCase();
    const cutsDir = path.join(dirAbs, 'cuts');
    for (const c of e.cutFiles) if (c.name.toLowerCase().startsWith(oldPrefix)) moves.push({ from: path.join(cutsDir, c.name), to: path.join(cutsDir, plan.stem + c.name.slice(e.stem.length)) });
    if (e.camProxy) moves.push({ from: e.camProxy, to: path.join(path.dirname(e.camProxy), plan.stem + path.extname(e.camProxy)) });
    return moves;
  }

  /**
   * Name several clips at once. items: [{ key, scene, shot, take }] (the client works out the numbering).
   * Returns what would happen; with apply it does it as one undoable step.
   */
  async renameMany(items, { apply = false } = {}) {
    if (!Array.isArray(items) || !items.length) throw httpError(400, 'Choose at least one clip.');
    if (items.length > 500) throw httpError(400, 'That is too many clips at once (500 at most).');
    const candidates = [];
    const problems = [];
    const seen = new Set();
    for (const it of items) {
      const e = this.byKey.get(it.key);
      if (!e) { problems.push({ key: it.key, name: String(it.key), reason: 'File not found' }); continue; }
      if (seen.has(it.key)) continue;
      seen.add(it.key);
      const scene = String(it.scene ?? '').trim();
      const shot = String(it.shot ?? '').trim();
      const take = parseInt(it.take, 10);
      if (!scene || !shot || !Number.isFinite(take) || take < 1) { problems.push({ key: it.key, name: e.name, reason: 'Needs a scene, a shot and a take number' }); continue; }
      // a duplicate tag (-dupC149) only makes sense for the name it was given; a new name starts clean
      const unchanged = String(e.scene) === scene && String(e.shot).toUpperCase() === shot.toUpperCase() && e.take === take;
      const plan = this.planRename(e, { scene, shot, take, extra: unchanged ? e.extra : [] });
      if (plan.name === e.name) continue;
      candidates.push({ e, plan, moves: this._movesFor(e, plan) });
    }
    const { items: ok, conflicts } = this._settle(candidates);
    const preview = {
      changes: ok.map(({ key, from, to, cuts, proxy, moves }) => ({ key, from, to, cuts, proxy, newKey: this.keyOf(moves[0].to) })),
      conflicts: [...conflicts, ...problems],
      unchanged: items.length - ok.length - conflicts.length - problems.length,
    };
    if (!apply) return preview;
    if (!ok.length) return { ...preview, renamed: 0 };
    for (const it of ok) {
      const e = this.byKey.get(it.key);
      const m = this.state.clips[it.key] || (this.state.clips[it.key] = {});
      m.sig = e.sig;
      if (!m.orig && e.kind === 'raw') m.orig = e.name;
    }
    const pairs = ok.flatMap((it) => it.moves.map((m) => ({ from: m.from, to: m.to })));
    await this._moveAll(pairs);
    const metas = this._moveMetas(ok.map((it) => ({ from: it.key, to: this.keyOf(it.moves[0].to) })));
    const entry = {
      id: hash(Math.random()), at: new Date().toISOString(), label: `Named ${ok.length} clip${ok.length === 1 ? '' : 's'}`,
      moves: pairs.map((m) => ({ from: this.keyOf(m.from), to: this.keyOf(m.to) })), metas,
    };
    this.state.history.unshift(entry);
    this.scheduleSave();
    await this.scan();
    return { ...preview, renamed: ok.length, files: pairs.length, history: entry.id };
  }

  renameAllPreview() {
    const p = this.planRenameAll();
    return {
      total: p.total,
      unchanged: p.total - p.items.length - p.conflicts.length,
      changes: p.items.map(({ key, from, to, cuts, proxy, onCanvas }) => ({ key, from, to, cuts, proxy, onCanvas })),
      conflicts: p.conflicts,
      onCanvas: p.items.reduce((a, i) => a + (i.onCanvas ? 1 : 0), 0),
      scheme: { prefix: this.state.prefix, pad: this.state.naming.pad, ratingInFilename: this.state.naming.ratingInFilename },
    };
  }

  /** Rename every take to the current scheme in one step that can be undone. Ratings found only in file names are kept in the project file first. */
  async renameAll() {
    const plan = this.planRenameAll();
    if (!plan.items.length) return { renamed: 0, skipped: plan.conflicts.length };
    // Dropping "-good-print" from a file name must not lose the decision: write it to the project file first.
    for (const it of plan.items) {
      const e = this.byKey.get(it.key);
      const m = this.state.clips[it.key] || (this.state.clips[it.key] = {});
      m.sig = e.sig;
      if (m.rating == null && e.rating) m.rating = e.rating;
      if (m.print == null && e.print) m.print = true;
      if (!m.orig && e.orig) m.orig = e.orig;
    }
    const pairs = plan.items.flatMap((it) => it.moves.map((m) => ({ from: m.from, to: m.to })));
    await this._moveAll(pairs);
    const metas = this._moveMetas(plan.items.map((it) => ({ from: it.key, to: this.keyOf(it.moves[0].to) })));
    const entry = {
      id: hash(Math.random()), at: new Date().toISOString(), label: `Renamed ${plan.items.length} take${plan.items.length === 1 ? '' : 's'} to the current naming scheme`,
      moves: pairs.map((m) => ({ from: this.keyOf(m.from), to: this.keyOf(m.to) })), metas,
    };
    this.state.history.unshift(entry);
    this.scheduleSave();
    await this.scan();
    return { renamed: plan.items.length, skipped: plan.conflicts.length, files: pairs.length, history: entry.id };
  }

  // ---- cuts ----------------------------------------------------------------------
  /** The snippets this take will be cut into: custom ranges if any, else auto-split into <= maxSeconds pieces. */
  planCuts(e) {
    const { maxSeconds } = this.state.snippets;
    const max = Math.max(2, Number(maxSeconds) || 30);
    const dur = e.duration;
    if (!dur) return [];
    const ranges = e.cutRanges && e.cutRanges.length ? e.cutRanges.map((r) => ({ start: r.in, end: Math.min(dur, r.out), label: r.label })) : [{ start: 0, end: dur }];
    const out = [];
    for (const r of ranges) {
      const len = r.end - r.start;
      if (len <= 0.05) continue;
      const pieces = len <= max + 0.05 ? 1 : Math.ceil(len / max - 1e-9);
      for (let i = 0; i < pieces; i++) {
        const start = r.start + i * max;
        const l = pieces === 1 ? len : Math.min(max - 0.05, r.end - start);
        out.push({ start, len: l, whole: pieces === 1 && ranges.length === 1 && r.start === 0 && Math.abs(r.end - dur) < 0.05, label: r.label || '' });
      }
    }
    return out.map((c, i) => ({ ...c, n: i + 1, name: `${e.stem}-cut-${i + 1}${e.ext}` }));
  }

  cutSignature(e) {
    const s = this.state.snippets;
    return hash(JSON.stringify([this.planCuts(e).map((c) => [c.start.toFixed(2), c.len.toFixed(2)]), s.maxSeconds, s.height, s.lossless, e.size]));
  }

  /** Cut the take into snippets in <dir>/cuts. Up-to-date snippets are kept; stale ones are replaced. */
  async makeCuts(key, ctx) {
    const e = this.entry(key);
    const plan = this.planCuts(e);
    if (!plan.length) throw httpError(400, `Can't read the duration of ${e.name}.`);
    const sig = this.cutSignature(e);
    const meta = this.state.clips[key] || (this.state.clips[key] = { sig: e.sig });
    const stale = meta.cutSig !== sig;
    const outDir = path.join(path.dirname(e.abs), 'cuts');
    fs.mkdirSync(outDir, { recursive: true });
    if (stale) for (const c of e.cutFiles) { try { fs.unlinkSync(path.join(outDir, c.name)); } catch { /* gone */ } }
    const { height, lossless, encoder } = this.state.snippets;
    const paths = [];
    for (let i = 0; i < plan.length; i++) {
      const c = plan[i];
      const dst = path.join(outDir, c.name);
      paths.push(dst);
      ctx.progress(i / plan.length, `Cut ${i + 1} of ${plan.length}`);
      if (!stale && fs.existsSync(dst)) continue;
      if (c.whole && !(height > 0 && e.probe && e.probe.height > height)) { fs.copyFileSync(e.abs, dst); continue; }
      await ff.cut(e.abs, dst, {
        start: c.start, len: c.whole ? null : c.len, lossless, height: height > 0 && e.probe && e.probe.height > height ? height : 0,
        preference: encoder, signal: ctx.signal, onProgress: (f) => ctx.progress((i + f) / plan.length, `Cut ${i + 1} of ${plan.length}`),
      });
    }
    meta.cutSig = sig;
    this.scheduleSave();
    await this.scan();
    return paths;
  }

  // ---- playback ---------------------------------------------------------------------
  proxyPath(e) { return path.join(this.cache, 'proxy', `${e.sig}.mp4`); }

  /**
   * Decide what the browser should play. Order of preference: the file itself (if browser safe),
   * the camera's proxy (if the browser can decode its codec), else a generated 720p H.264 proxy.
   */
  async playback(key, { hevc }) {
    const e = this.entry(key);
    const orig = e.probe;
    const urlFor = (src) => `/media?key=${encodeURIComponent(key)}&src=${src}&v=${e.sig}`;
    if (orig && ff.browserSafe(orig, e.abs) && orig.height <= 1440) return { kind: 'original', url: urlFor('orig') };
    if (hevc !== undefined) this.clientHevc = !!hevc;
    if (e.camProxy) {
      const pp = await this.probeFile(e.camProxy);
      if (!pp.error && (ff.browserSafe(pp, e.camProxy) || (pp.codec === 'hevc' && hevc))) return { kind: 'camera-proxy', url: urlFor('cam') };
    }
    // A browser that can decode HEVC (Windows with the HEVC extension, macOS) plays the camera original straight away.
    if (hevc && orig && orig.codec === 'hevc' && orig.height <= 2160 && /yuv420p/.test(orig.pixFmt || 'yuv420p')) return { kind: 'original', url: urlFor('orig') };
    const gen = this.proxyPath(e);
    if (fs.existsSync(gen)) return { kind: 'generated-proxy', url: urlFor('gen') };
    const job = this.ensureProxy(e); // someone is waiting for this one: front of the queue
    return { kind: 'pending', jobId: job.id, pending: true };
  }

  /** Does this clip need a generated review copy before a browser can play it? */
  needsProxy(e) {
    const orig = e.probe;
    if (!orig) return false; // not probed yet
    if (fs.existsSync(this.proxyPath(e))) return false;
    if (ff.browserSafe(orig, e.abs) && orig.height <= 1440) return false;
    if (this.clientHevc && orig.codec === 'hevc' && orig.height <= 2160) return false;
    if (e.camProxy) {
      const pp = this.probeCache[sigOf(fs.statSync(e.camProxy))];
      if (pp && !pp.error && (ff.browserSafe(pp, e.camProxy) || (pp.codec === 'hevc' && this.clientHevc))) return false;
    }
    return true;
  }

  proxyStatus() {
    const clips = this.library.filter((e) => e.probe);
    const needing = clips.filter((e) => this.needsProxy(e));
    const ready = clips.filter((e) => fs.existsSync(this.proxyPath(e))).length;
    const active = this.jobs.list.filter((j) => j.lane === 'proxy' && (j.state === 'queued' || j.state === 'running')).length;
    const leftSeconds = needing.reduce((a, e) => a + (e.duration || 0), 0);
    // how many seconds of footage get prepared per second of waiting, as measured here (5x until the first clip is done)
    const st = this.proxyStats || [];
    const rate = st.length ? Math.max(0.5, st.reduce((a, x) => a + x.seconds, 0) / (st.reduce((a, x) => a + x.ms, 0) / 1000)) : 5;
    return { clips: clips.length, ready, left: needing.length, active, minutes: Math.round(leftSeconds / 60), etaMinutes: Math.max(1, Math.ceil(leftSeconds / rate / 60)), speed: Math.round(rate * 10) / 10, measured: st.length > 0, prepare: !!this.state.playback.prepare };
  }

  /**
   * Quietly prepare review copies for everything that needs one, so clips open instantly. Unnamed clips first (the
   * ones you read slates from), then in shooting order. Opening a clip jumps it to the front.
   */
  autoProxy() {
    if (!this.state.playback.prepare || this._probing || !ff.locate().ok) return 0;
    const need = this.library.filter((e) => this.needsProxy(e));
    need.sort((a, b) => (a.kind === 'raw' ? 0 : 1) - (b.kind === 'raw' ? 0 : 1));
    for (const e of need) this.ensureProxy(e, { background: true, priority: 0 });
    return need.length;
  }

  setClientCaps({ hevc }) {
    const was = this.clientHevc;
    this.clientHevc = !!hevc;
    if (was !== this.clientHevc) this.autoProxy();
  }

  ensureProxy(e, { background = false, priority = 10 } = {}) {
    const dst = this.proxyPath(e);
    return this.jobs.add({
      lane: 'proxy', title: `Review copy · ${e.name}`, dedupeKey: `proxy:${e.sig}`, background, priority,
      run: async (ctx) => {
        if (fs.existsSync(dst)) return;
        const t0 = Date.now();
        const dur = e.duration || (e.probe && e.probe.duration);
        await ff.makeProxy(e.abs, dst, { duration: dur, signal: ctx.signal, onProgress: (f) => ctx.progress(f), preference: this.state.snippets.encoder });
        if (dur) { (this.proxyStats ||= []).push({ seconds: dur, ms: Date.now() - t0 }); if (this.proxyStats.length > 12) this.proxyStats.shift(); }
        this.emit('proxy', { key: e.key });
      },
    });
  }

  mediaPath(e, src) {
    if (src === 'cam' && e.camProxy) return e.camProxy;
    if (src === 'gen') return this.proxyPath(e);
    return e.abs;
  }

  /** Cached JPEG frame (poster / hover frames). Uses the lightest source available for speed. */
  async thumb(key, t, width) {
    const e = this.entry(key);
    const w = Math.max(120, Math.min(1280, parseInt(width, 10) || 480));
    const tt = Math.max(0, Math.round((Number(t) || 0) * 10) / 10);
    const out = path.join(this.cache, 'thumb', `${e.sig}-${tt}-${w}.jpg`);
    if (fs.existsSync(out)) return out;
    const gen = this.proxyPath(e);
    const src = fs.existsSync(gen) ? gen : e.camProxy || e.abs;
    const dur = e.duration || 0;
    await renderOnce(out, () => ff.poster(src, dur ? Math.min(tt, Math.max(0, dur - 0.2)) : tt, out, w));
    return out;
  }

  async strip(key, from, to, count, width) {
    const e = this.entry(key);
    const n = Math.max(2, Math.min(12, parseInt(count, 10) || 4));
    const w = Math.max(120, Math.min(640, parseInt(width, 10) || 320));
    const f = Math.max(0, Number(from) || 0);
    const t = Math.max(f + 0.2, Number(to) || f + 4);
    const out = path.join(this.cache, 'strip', `${e.sig}-${f.toFixed(1)}-${t.toFixed(1)}-${n}-${w}.jpg`);
    if (fs.existsSync(out)) return out;
    const gen = this.proxyPath(e);
    await renderOnce(out, () => ff.strip(fs.existsSync(gen) ? gen : e.camProxy || e.abs, f, t, n, out, w));
    return out;
  }

  /**
   * Folders that hold clips, as a tree with counts for each folder including everything below it.
   * Paths are relative to the project folder ('.' is the project folder itself).
   */
  folderTree() {
    const map = new Map();
    const touch = (p, e) => {
      if (!map.has(p)) map.set(p, { path: p, name: p === '.' ? this.state.name : p.split('/').pop(), depth: p === '.' ? 0 : p.split('/').length, clips: 0, named: 0, raw: 0, duration: 0, size: 0, direct: 0, scenes: new Set() });
      const f = map.get(p);
      f.clips++; f.size += e.size; f.duration += e.duration || 0;
      if (e.kind === 'shot') { f.named++; f.scenes.add(String(e.scene)); } else if (!e.skip) f.raw++;
    };
    for (const e of this.library) {
      const parts = e.dir === '.' ? [] : e.dir.split('/');
      if (!parts.length) touch('.', e); else for (let i = 1; i <= parts.length; i++) touch(parts.slice(0, i).join('/'), e);
      const own = map.get(e.dir);
      if (own) own.direct++;
    }
    // A folder that only contains one subfolder adds nothing to look at, but keep it: paths must stay navigable.
    return [...map.values()].sort((a, b) => natCompare(a.path, b.path)).map((f) => ({ ...f, scenes: [...f.scenes].sort(natCompare) }));
  }

  /** Folders with footage that the project does not scan yet (a new shoot day, a card dump). */
  discoverFolders() {
    const have = this.folderPaths().map((p) => pathKey(p));
    const covered = (abs) => { const a = pathKey(abs); return have.some((h) => a === h || a.startsWith(h + path.sep)); };
    const ignore = new Set(this.state.ignoreDirs.map((s) => s.toLowerCase()));
    const found = [];
    const countVideos = (dir, depth) => {
      let n = 0;
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
      for (const e of ents) {
        if (e.name.startsWith('.')) continue;
        if (e.isDirectory()) { if (depth < 3 && !ignore.has(e.name.toLowerCase())) n += countVideos(path.join(dir, e.name), depth + 1); }
        else if (e.isFile() && isVideoFile(e.name)) n++;
      }
      return n;
    };
    const walk = (dir, depth) => {
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (!e.isDirectory() || e.name.startsWith('.') || ignore.has(e.name.toLowerCase())) continue;
        const full = path.join(dir, e.name);
        if (covered(full)) continue;
        const n = countVideos(full, 0);
        if (n) found.push({ path: this.relOrAbs(full), name: e.name, clips: n });
        else if (depth < 1) walk(full, depth + 1);
      }
    };
    walk(this.root, 0);
    // also siblings of existing footage folders (Day 1 and Day 2 side by side)
    return found.sort((a, b) => natCompare(a.name, b.name));
  }

  // ---- AI results: the generated versions of a take, for the Compare view ---------------------

  /**
   * Map generated videos to the take they came from.
   * items: [{ path | url, label?, originalStart?, cut?, nodeId? }]. A result is usually made from a piece of the take,
   * so originalStart says where in the original it begins; `cut` (the snippet number) works that out.
   */
  async addAi(key, items) {
    const e = this.entry(key);
    if (e.kind !== 'shot') throw httpError(400, 'Name this clip first, then map AI results to it.');
    if (!Array.isArray(items) || !items.length) throw httpError(400, 'Choose at least one video.');
    const m = this.state.clips[key] || (this.state.clips[key] = { sig: e.sig });
    m.sig = e.sig;
    m.ai = m.ai || [];
    const plan = this.planCuts(e);
    const added = [];
    for (const it of items) {
      let rec;
      if (it.path) {
        const abs = path.resolve(String(it.path));
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw httpError(404, `That file is not there: ${abs}`);
        if (!isVideoFile(abs)) throw httpError(400, `${path.basename(abs)} is not a video file.`);
        const info = await this.probeFile(abs);
        rec = { kind: 'file', path: abs, label: String(it.label || path.basename(abs).replace(/\.[^.]+$/, '')).slice(0, 80), duration: info.error ? 0 : info.duration, width: info.error ? 0 : info.width, height: info.error ? 0 : info.height, fps: info.error ? 0 : info.fps };
      } else if (it.url) {
        if (!/^https:\/\//i.test(String(it.url))) throw httpError(400, 'Links must start with https://');
        rec = { kind: 'url', url: String(it.url), nodeId: String(it.nodeId || ''), label: String(it.label || 'AI result').slice(0, 80), duration: Number(it.duration) || 0, width: Number(it.width) || 0, height: Number(it.height) || 0 };
      } else throw httpError(400, 'Each result needs a file or a link.');
      const cut = parseInt(it.cut, 10);
      const start = it.originalStart != null ? Number(it.originalStart) : (cut >= 1 && plan[cut - 1] ? plan[cut - 1].start : 0);
      rec.id = hash(Math.random() + rec.label);
      rec.originalStart = Math.max(0, Number.isFinite(start) ? start : 0);
      rec.note = '';
      rec.addedAt = new Date().toISOString();
      m.ai.push(rec);
      added.push(rec.id);
    }
    this.scheduleSave();
    await this.scan();
    return added;
  }

  updateAi(key, id, patch) {
    this.entry(key);
    const m = this.state.clips[key];
    const a = m && (m.ai || []).find((x) => x.id === id);
    if (!a) throw httpError(404, 'That AI result is not mapped to this take.');
    if ('label' in patch) a.label = String(patch.label || '').slice(0, 80) || a.label;
    if ('note' in patch) a.note = String(patch.note || '').slice(0, 1000);
    if ('originalStart' in patch) a.originalStart = Math.max(0, Number(patch.originalStart) || 0);
    if ('duration' in patch && Number(patch.duration) > 0) a.duration = Number(patch.duration);
    this.scheduleSave();
    const e = this.byKey.get(key);
    if (e) e.ai = (m.ai || []).map((x) => ({ ...x, name: x.kind === 'file' ? path.basename(x.path) : x.label, missing: x.kind === 'file' && !fs.existsSync(x.path) }));
    this.emit('library');
    return a;
  }

  removeAi(key, id) {
    this.entry(key);
    const m = this.state.clips[key];
    if (!m || !(m.ai || []).some((x) => x.id === id)) throw httpError(404, 'That AI result is not mapped to this take.');
    m.ai = m.ai.filter((x) => x.id !== id);
    if (!m.ai.length) delete m.ai;
    this.scheduleSave();
    const e = this.byKey.get(key);
    if (e) e.ai = (m.ai || []).map((x) => ({ ...x, name: x.kind === 'file' ? path.basename(x.path) : x.label, missing: x.kind === 'file' && !fs.existsSync(x.path) }));
    this.emit('library');
  }

  /** For a list of file names: the take each probably belongs to (null when unknown), and which snippet it is. */
  suggestAi(names) {
    const takes = this.library.filter((e) => e.kind === 'shot');
    return (names || []).map((name) => {
      const hit = suggestTake(String(name), takes);
      if (!hit) return { name, key: null };
      const e = this.byKey.get(hit.key);
      const plan = this.planCuts(e);
      return { name, key: hit.key, why: hit.why, cut: hit.cut, originalStart: hit.cut && plan[hit.cut - 1] ? plan[hit.cut - 1].start : 0 };
    });
  }

  /** What the browser should play for an AI result: the file, a small copy of it, or its link. */
  async aiPlayback(key, id, { hevc } = {}) {
    this.entry(key);
    const m = this.state.clips[key];
    const a = m && (m.ai || []).find((x) => x.id === id);
    if (!a) throw httpError(404, 'That AI result is not mapped to this take.');
    if (a.kind === 'url') return { kind: 'remote', url: a.url };
    if (!fs.existsSync(a.path)) throw httpError(404, `The file is missing: ${a.path}. Move it back, or remove this result and add it again.`, { code: 'missing' });
    const st = fs.statSync(a.path);
    const sig = `${st.size}-${Math.round(st.mtimeMs)}`;
    const info = await this.probeFile(a.path);
    const urlFor = (src) => `/ai-media?key=${encodeURIComponent(key)}&id=${id}&src=${src}&v=${sig}`;
    if (info.error || (ff.browserSafe(info, a.path) && info.height <= 2160) || (hevc && info.codec === 'hevc')) return { kind: 'original', url: urlFor('orig') };
    const pseudo = { abs: a.path, sig, name: path.basename(a.path), duration: info.duration, probe: info, key: `ai:${id}` };
    if (fs.existsSync(this.proxyPath(pseudo))) return { kind: 'generated-proxy', url: urlFor('gen') };
    const job = this.ensureProxy(pseudo);
    return { kind: 'pending', jobId: job.id, pending: true };
  }

  aiMediaPath(key, id, src) {
    const m = this.state.clips[key];
    const a = m && (m.ai || []).find((x) => x.id === id);
    if (!a || a.kind !== 'file') throw httpError(404, 'Media not found');
    if (src === 'gen') {
      const st = fs.statSync(a.path);
      return this.proxyPath({ sig: `${st.size}-${Math.round(st.mtimeMs)}` });
    }
    return a.path;
  }

  // ---- shot list ----------------------------------------------------------------------
  setShotListText(text) {
    const { scenes, errors } = parseShotListText(text);
    if (errors.length && !scenes.length && String(text).trim()) throw httpError(400, errors[0].message, { errors });
    this.state.shotList = scenes;
    this.scheduleSave();
    this.emit('library');
    return { errors, scenes: scenes.length, shots: scenes.reduce((a, s) => a + s.shots.length, 0) };
  }

  /** Small structured edits to the plan: add a shot, toggle optional, remove a shot. */
  editPlan(op) {
    const list = this.state.shotList;
    const scene = String(op.scene ?? '').trim();
    const id = String(op.shot ?? '').trim().toUpperCase();
    if (op.op === 'scene') {
      // a new scene with N planned shots (1..N) and an optional title
      if (!/^[A-Za-z0-9]{1,6}$/.test(scene)) throw httpError(400, 'Give the scene a short number or name, like 12 or 12B.');
      if (list.some((s) => String(s.scene).toLowerCase() === scene.toLowerCase())) throw httpError(409, `Scene ${scene} is already in the shot list.`);
      const n = Math.max(0, Math.min(60, parseInt(op.count, 10) || 0));
      const title = String(op.title || '').trim().slice(0, 80);
      if (!n && !title) throw httpError(400, 'Plan at least one shot, or give the scene a title.');
      list.push({ scene, title, shots: Array.from({ length: n }, (_, i) => ({ id: String(i + 1), desc: '', size: '', optional: false })) });
      list.sort((a, b) => natCompare(a.scene, b.scene));
      this.state.shotList = list;
      this.scheduleSave();
      this.emit('library');
      return;
    }
    if (!scene || !id) throw httpError(400, 'Scene and shot are needed.');
    let sc = list.find((s) => String(s.scene) === scene);
    if (op.op === 'add') {
      if (!sc) { sc = { scene, title: '', shots: [] }; list.push(sc); list.sort((a, b) => natCompare(a.scene, b.scene)); }
      if (sc.shots.some((s) => s.id === id)) throw httpError(409, `Shot ${scene}.${id} is already in the shot list.`);
      sc.shots.push({ id, desc: String(op.desc || '').slice(0, 200), size: String(op.size || '').slice(0, 12), optional: !!op.optional });
      sc.shots.sort((a, b) => compareShots(a.id, b.id));
    } else if (op.op === 'optional') {
      const sh = sc && sc.shots.find((s) => s.id === id);
      if (!sh) throw httpError(404, 'That shot is not in the shot list.');
      sh.optional = op.value != null ? !!op.value : !sh.optional;
    } else if (op.op === 'remove') {
      if (sc) sc.shots = sc.shots.filter((s) => s.id !== id);
    } else throw httpError(400, 'Unknown plan operation.');
    this.state.shotList = list.filter((s) => s.shots.length || s.title);
    this.scheduleSave();
    this.emit('library');
  }

  /** Seed the plan from what has been shot so far (plus gaps to fill in later). */
  seedShotListFromFootage() {
    const map = new Map();
    for (const e of this.library) {
      if (e.kind !== 'shot') continue;
      if (!map.has(e.scene)) map.set(e.scene, new Map());
      if (!map.get(e.scene).has(String(e.shot).toUpperCase())) map.get(e.scene).set(String(e.shot).toUpperCase(), { id: String(e.shot).toUpperCase(), desc: '', size: '', optional: false });
    }
    const scenes = [...map.entries()].sort((a, b) => natCompare(a[0], b[0])).map(([scene, shots]) => ({ scene, title: '', shots: [...shots.values()].sort((a, b) => compareShots(a.id, b.id)) }));
    this.state.shotList = scenes;
    this.scheduleSave();
    this.emit('library');
    return shotListToText(scenes);
  }

  // ---- settings ------------------------------------------------------------------------
  async updateSettings(patch) {
    const s = this.state;
    if (typeof patch.name === 'string' && patch.name.trim()) s.name = patch.name.trim().slice(0, 80);
    if (typeof patch.prefix === 'string' && patch.prefix.trim()) s.prefix = patch.prefix.replace(/[^A-Za-z0-9_.]/g, '').slice(0, 40) || s.prefix;
    if (patch.naming) {
      if (patch.naming.pad) for (const k of ['scene', 'shot', 'take']) if (patch.naming.pad[k] != null) s.naming.pad[k] = Math.max(0, Math.min(4, parseInt(patch.naming.pad[k], 10) || 0));
      if (patch.naming.ratingInFilename != null) s.naming.ratingInFilename = !!patch.naming.ratingInFilename;
    }
    if (Array.isArray(patch.folders)) s.folders = patch.folders.map((f) => this.relOrAbs(f));
    if (Array.isArray(patch.ignoreDirs)) s.ignoreDirs = patch.ignoreDirs.map((x) => String(x).trim()).filter(Boolean);
    if (patch.playback && patch.playback.prepare != null) {
      s.playback.prepare = !!patch.playback.prepare;
      if (!s.playback.prepare) this.jobs.cancelBackground('proxy'); else setTimeout(() => this.autoProxy(), 0);
    }
    if (patch.snippets) {
      const sn = patch.snippets;
      if (sn.maxSeconds != null) s.snippets.maxSeconds = Math.max(2, Math.min(600, Number(sn.maxSeconds) || 30));
      if (sn.height != null) s.snippets.height = [0, 720, 1080, 1440, 2160].includes(Number(sn.height)) ? Number(sn.height) : 1080;
      if (sn.lossless != null) s.snippets.lossless = !!sn.lossless;
      if (sn.encoder != null) s.snippets.encoder = sn.encoder === 'cpu' ? 'cpu' : 'auto';
    }
    if (patch.canvas) {
      const c = patch.canvas;
      for (const k of ['canvasId', 'canvasName', 'pageId', 'pageName']) if (typeof c[k] === 'string') s.canvas[k] = c[k].trim();
      if (c.mode === 'labels' || c.mode === 'pages') s.canvas.mode = c.mode;
      if (c.layout) for (const [k, v] of Object.entries(c.layout)) if (k in DEFAULT_LAYOUT && Number.isFinite(Number(v))) s.canvas.layout[k] = Number(v);
    }
    await this.saveNow();
    await this.scan();
    return this.summary();
  }

  // ---- import / reports --------------------------------------------------------------------
  /** Pull ratings, print flags and notes from the old namer tool's continuity-log.csv. */
  async importContinuityLog(csvPath) {
    const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
    const latest = new Map();
    for (const r of rows) {
      const stem = path.basename(String(r.File || '')).replace(/\.[A-Za-z0-9]+$/, '').replace(/-print$/, '').replace(/-(void|ok|good)$/, '').toLowerCase();
      if (stem) latest.set(stem, r);
    }
    let applied = 0;
    for (const e of this.library) {
      const stem = e.stem.replace(/-print$/, '').replace(/-(void|ok|good)$/, '').toLowerCase();
      const r = latest.get(stem);
      if (!r) continue;
      const m = this.state.clips[e.key] || (this.state.clips[e.key] = {});
      m.sig = e.sig;
      if (r.Rating && RATINGS.includes(r.Rating)) m.rating = r.Rating;
      if (/^(yes|true|1)$/i.test(r.Print || '')) m.print = true;
      if (r.Note && !m.note) m.note = r.Note;
      applied++;
    }
    this.scheduleSave();
    await this.scan();
    return { rows: rows.length, applied };
  }

  report(type) {
    const clips = this.library.filter((e) => e.kind === 'shot');
    if (type === 'continuity') {
      return toCsv(['Date', 'Scene', 'Shot', 'Take', 'Rating', 'Print', 'Duration', 'Note', 'File', 'Original', 'Camera'], clips
        .slice().sort((a, b) => natCompare(a.scene, b.scene) || compareShots(a.shot, b.shot) || a.take - b.take)
        .map((e) => ({
          Date: e.recordedAt, Scene: e.scene, Shot: e.shot, Take: e.take, Rating: e.rating, Print: e.print ? 'yes' : '',
          Duration: e.duration ? e.duration.toFixed(1) : '', Note: e.note, File: e.name, Original: e.orig,
          Camera: e.probe ? [e.probe.camera.model, e.probe.camera.lens].filter(Boolean).join(' / ') : '',
        })));
    }
    const { scenes } = buildCoverage(this.library.map((e) => this.toClient(e)), this.state.shotList);
    if (type === 'missing') {
      const rows = [];
      for (const s of scenes) for (const sh of s.shots) if (sh.status === 'missing' || sh.status === 'gap') rows.push({ Scene: s.id, Shot: sh.id, Description: sh.desc, Size: sh.size, Why: sh.status === 'gap' ? 'numbering gap' : 'planned, no takes' });
      return toCsv(['Scene', 'Shot', 'Description', 'Size', 'Why'], rows);
    }
    if (type === 'prints') {
      return toCsv(['Scene', 'Shot', 'Take', 'Rating', 'Duration', 'Note', 'File'], clips.filter((e) => e.print)
        .sort((a, b) => natCompare(a.scene, b.scene) || compareShots(a.shot, b.shot) || a.take - b.take)
        .map((e) => ({ Scene: e.scene, Shot: e.shot, Take: e.take, Rating: e.rating, Duration: e.duration ? formatTime(e.duration) : '', Note: e.note, File: e.name })));
    }
    throw httpError(404, `Unknown report ${type}`);
  }

  /** Copy every printed take into <dest>/<Scene n>/ (a hand-off folder for the edit). */
  copySelects(dest, ctx) {
    const prints = this.library.filter((e) => e.kind === 'shot' && e.print);
    if (!prints.length) throw httpError(400, 'No takes are marked print yet.');
    let done = 0;
    const total = prints.reduce((a, e) => a + e.size, 0) || 1;
    let copied = 0;
    return (async () => {
      for (const e of prints) {
        const dir = path.join(dest, `Scene ${e.scene}`);
        fs.mkdirSync(dir, { recursive: true });
        const to = path.join(dir, e.name);
        if (!fs.existsSync(to)) {
          await new Promise((resolve, reject) => {
            const rs = fs.createReadStream(e.abs);
            const ws = fs.createWriteStream(`${to}.part`);
            rs.on('data', (c) => { copied += c.length; ctx.progress(copied / total, `${++done > prints.length ? prints.length : done} / ${prints.length}`); });
            rs.on('error', reject);
            ws.on('error', reject);
            ws.on('close', () => { try { fs.renameSync(`${to}.part`, to); resolve(); } catch (err) { reject(err); } });
            rs.pipe(ws);
          });
        }
      }
      return prints.length;
    })();
  }
}

module.exports = { Project, FILE_NAME };
