'use strict';
// The running application: the open project, the job queue, and the LetzAI canvas workflow.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const cfg = require('./lib/config');
const ff = require('./lib/ffmpeg');
const { Jobs } = require('./lib/jobs');
const { Project, FILE_NAME } = require('./lib/project');
const canvas = require('./lib/canvas');
const vision = require('./lib/vision');
const { httpError, natCompare, mapLimit } = require('./lib/util');

const pkg = require('../package.json');

// Failures that will fail the same way for every remaining snippet: stop instead of repeating them.
const fatalFor = (e) => e && (e.status === 401 || e.status === 402 || e.status === 403 || e.status === 404 || e.code === 'no-scene-page' || /No LetzAI API key/.test(e.message));

class App extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.jobs = new Jobs();
    this.project = null;
    this.client = opts.client || new canvas.CanvasClient(() => cfg.getKey());
    this._canvasChain = Promise.resolve();
    this._pagesCache = null;
    this.jobs.on('job', (j) => this.emit('job', j));
    this.jobs.on('reset', (l) => this.emit('jobs', l));
  }

  requireProject() {
    if (!this.project) throw httpError(409, 'No project is open.');
    return this.project;
  }

  info() {
    const loc = ff.locate();
    return {
      app: { name: 'LetzAI Hybrid Filmmaker Kit', version: pkg.version },
      ffmpeg: loc.ok ? { ok: true, version: loc.version, path: loc.ffmpeg } : { ok: false, missing: loc.missing || 'ffmpeg' },
      system: ff.describeSystem(),
      key: { set: !!cfg.getKey(), source: cfg.keySource() },
      vision: (() => { const v = vision.settings(); const p = vision.PROVIDERS[v.provider]; return { ...v, label: p.label, company: p.company, keySet: !!cfg.getVisionKey(v.provider) }; })(),
      recent: cfg.loadConfig().recent.filter((r) => fs.existsSync(r.root)),
      project: this.project ? this.project.summary() : null,
    };
  }

  async openProject(root) {
    const abs = path.resolve(String(root || ''));
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw httpError(404, `Folder not found: ${abs}`);
    if (!Project.exists(abs)) throw httpError(404, `No ${FILE_NAME} in that folder. Create a project there first.`, { code: 'no-project' });
    await this._attach(new Project(abs, { jobs: this.jobs }).load());
    return this.project;
  }

  async createProject({ root, name, prefix, folders }) {
    const abs = path.resolve(String(root || ''));
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw httpError(404, `Folder not found: ${abs}`);
    if (Project.exists(abs)) throw httpError(409, 'That folder already has a project. Open it instead.');
    const p = await Project.create(abs, { name, prefix, folders: folders && folders.length ? folders : [abs] }, { jobs: this.jobs });
    await this._attach(p);
    return p;
  }

  async _attach(p) {
    if (this.project) { await this.project.saveNow().catch(() => {}); this.project.removeAllListeners(); }
    this.project = p;
    this._pagesCache = null;
    p.on('library', () => this.emit('library'));
    p.on('proxy', (e) => this.emit('proxy', e));
    p.on('error', (e) => this.emit('problem', e.message));
    await p.scan();
    await cfg.rememberProject(p.root, p.state.name);
    this.emit('project');
    // learn what is on the canvas, quietly, if we can
    this.refreshCanvas().catch(() => {});
  }

  async closeProject() {
    if (this.project) { await this.project.saveNow().catch(() => {}); this.project.removeAllListeners(); }
    this.project = null;
    this.emit('project');
  }

  // ---- canvas ---------------------------------------------------------------
  /** Serialise canvas page mutations so parallel uploads can't trample each other's sort. */
  _locked(fn) {
    const run = this._canvasChain.then(fn, fn);
    this._canvasChain = run.catch(() => {});
    return run;
  }

  canvasTarget() {
    const p = this.requireProject();
    const { canvasId, pageId, mode } = p.state.canvas;
    if (!cfg.getKey()) throw httpError(401, 'No LetzAI API key');
    if (!canvasId) throw httpError(400, 'Choose a canvas first (Canvas > Connection).');
    if (mode !== 'pages' && !pageId) throw httpError(400, 'Choose a canvas page first (Canvas > Connection).');
    return { canvasId, pageId, mode: mode === 'pages' ? 'pages' : 'labels', layout: p.state.canvas.layout };
  }

  /** The canvas's pages (cached for a few seconds: one send touches this many times). */
  async canvasPages(fresh) {
    const { canvasId } = this.canvasTarget();
    if (!fresh && this._pagesCache && this._pagesCache.id === canvasId && Date.now() - this._pagesCache.at < 8000) return this._pagesCache.pages;
    const c = await this.client.getCanvas(canvasId);
    const pages = (c.pages || []).map((pg) => ({ id: pg.id, name: pg.name, nodeCount: pg.nodeCount }));
    this._pagesCache = { id: canvasId, at: Date.now(), pages };
    return pages;
  }

  /** Which page does this scene go to? In "pages" mode a page called "Scene N" must exist (the API can't create pages). */
  async pageForScene(scene) {
    const t = this.canvasTarget();
    if (t.mode === 'labels') return { id: t.pageId, name: this.project.state.canvas.pageName };
    let pages = await this.canvasPages();
    let pg = canvas.findScenePage(pages, scene);
    if (!pg) { pages = await this.canvasPages(true); pg = canvas.findScenePage(pages, scene); }
    if (!pg) {
      throw Object.assign(httpError(404, `No page named "Scene ${scene}" on the canvas`), {
        code: 'no-scene-page',
        friendly: `This canvas has no page named “Scene ${scene}”. LetzAI's API can't create pages: add one called Scene ${scene} in the canvas, then retry.`,
      });
    }
    return pg;
  }

  /** The pages that hold this project's scenes (one in labels mode, one per scene in pages mode). */
  async targetPages() {
    const p = this.requireProject();
    const t = this.canvasTarget();
    const scenes = [...new Set(p.library.filter((e) => e.kind === 'shot').map((e) => e.scene))].sort(natCompare);
    if (t.mode === 'labels') return { mode: 'labels', pages: [{ id: t.pageId, scenes }], scenes, missing: [] };
    const all = await this.canvasPages(true);
    const byPage = new Map();
    const missing = [];
    for (const s of scenes) {
      const pg = canvas.findScenePage(all, s);
      if (!pg) { missing.push(s); continue; }
      if (!byPage.has(pg.id)) byPage.set(pg.id, { id: pg.id, name: pg.name, scenes: [] });
      byPage.get(pg.id).scenes.push(s);
    }
    return { mode: 'pages', pages: [...byPage.values()], scenes, missing, allPages: all };
  }

  /** Reads the page(s), remembers which clips are already there, and reports what is set up for each scene. */
  async refreshCanvas() {
    const p = this.requireProject();
    const t = this.canvasTarget();
    const tp = await this.targetPages();
    const names = new Set();
    let nodeCount = 0;
    const labels = {};
    const scenePages = {};
    await mapLimit(tp.pages, 3, async (pg) => {
      const page = await this.client.getPage(t.canvasId, pg.id);
      for (const n of canvas.onCanvasMap(page).keys()) names.add(n);
      nodeCount += (page.nodes || []).length;
      for (const s of pg.scenes) {
        if (t.mode === 'labels') labels[s] = !!canvas.findSceneLabel(page.nodes || [], s);
        else scenePages[s] = { found: true, pageId: pg.id, name: pg.name };
      }
    });
    for (const s of tp.missing) scenePages[s] = { found: false };
    p.canvasNames = names;
    p.canvasSyncedAt = new Date().toISOString();
    await p.scan();
    const sceneNamedPages = (tp.allPages || []).filter((pg) => /^\s*scene\s*\S+/i.test(pg.name || '')).map((pg) => pg.name);
    return { mode: t.mode, nodeCount, onCanvas: names.size, labels, scenePages, syncedAt: p.canvasSyncedAt, scenePageNames: sceneNamedPages };
  }

  async canvasStatus() {
    const p = this.requireProject();
    const c = p.state.canvas;
    if (!cfg.getKey()) return { state: 'no-key' };
    if (!c.canvasId || (c.mode !== 'pages' && !c.pageId)) return { state: 'no-canvas' };
    try {
      const s = await this.refreshCanvas();
      // suggest the per-scene layout when the canvas obviously uses it
      let suggestPages = false;
      if (c.mode !== 'pages') {
        const pages = await this.canvasPages().catch(() => []);
        suggestPages = pages.filter((pg) => /^\s*scene\s*\d+/i.test(pg.name || '')).length >= 2;
      }
      return { state: 'ok', ...s, suggestPages };
    } catch (e) {
      return { state: 'error', error: canvas.explain(e), status: e.status || 0 };
    }
  }

  /** Videos on the canvas that are not the kit's own clips: where generated results live. */
  async canvasMedia() {
    const t = this.canvasTarget();
    const tp = await this.targetPages();
    const out = [];
    for (const pg of tp.pages) {
      const page = await this.client.getPage(t.canvasId, pg.id);
      for (const n of page.nodes || []) {
        if (n.kind !== 'media' || String(n.clientNodeId || '').startsWith('ltn') || !n.data || !n.data.url) continue;
        const isVideo = n.data.type === 'video' || /\.(mp4|mov|webm|m4v)(\?|$)/i.test(n.data.url);
        if (!isVideo) continue;
        out.push({ nodeId: n.id, url: n.data.url, width: n.data.naturalW || 0, height: n.data.naturalH || 0, page: pg.name || this.requireProject().state.canvas.pageName || '', createdAt: n.createdAt || '' });
      }
    }
    out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return out.slice(0, 300);
  }

  async sortCanvas() {
    const t = this.canvasTarget();
    return this._locked(async () => {
      const tp = await this.targetPages();
      let moved = 0;
      const out = {};
      for (const pg of tp.pages) {
        const page = await this.client.getPage(t.canvasId, pg.id);
        const updates = t.mode === 'pages' ? canvas.planSortPage(page, t.layout) : canvas.planSort(page, t.layout, out);
        moved += await canvas.applyUpdates(this.client, t.canvasId, pg.id, updates);
      }
      return { moved, parked: out.parked || [], missing: tp.missing };
    });
  }

  async createLabels(scenes) {
    const t = this.canvasTarget();
    if (t.mode !== 'labels') throw httpError(400, 'Scene labels are only used when sending to one page.');
    let created = 0;
    for (const scene of scenes) {
      const r = await this._locked(() => canvas.createSceneLabel(this.client, { canvasId: t.canvasId, pageId: t.pageId, scene, layout: t.layout }));
      if (r.created) created++;
    }
    await this.refreshCanvas();
    return { created };
  }

  _setCanvasError(key, err) {
    const p = this.project;
    if (!p) return;
    if (err) p.canvasErrors.set(key, err); else p.canvasErrors.delete(key);
    this.emit('library');
  }

  /**
   * Cut (if needed) and upload takes to the canvas. One job chain per take:
   * cut lane -> upload lane, so cutting the next take overlaps uploading the previous one.
   * Whatever goes wrong is kept on the take (clip.canvasError) until a retry succeeds.
   */
  sendToCanvas(keys) {
    const p = this.requireProject();
    this.canvasTarget(); // fail fast with a helpful message
    const queued = [];
    for (const key of keys) {
      const e = p.entry(key);
      if (e.kind !== 'shot') continue; // unnamed footage has no scene yet, so it has no place on the canvas
      p.canvasErrors.delete(key);
      queued.push(this.jobs.add({
        lane: 'cut', title: `Cut · ${e.name}`, dedupeKey: `cut:${e.key}`,
        run: async (ctx) => {
          try { await p.makeCuts(e.key, ctx); } catch (err) {
            if (!err.cancelled) this._setCanvasError(e.key, { message: `Cutting failed: ${err.message}`, files: [], at: new Date().toISOString(), phase: 'cut' });
            throw err;
          }
          const fresh = p.entry(e.key);
          this.jobs.add({
            lane: 'upload', title: `Canvas · ${fresh.name}`, dedupeKey: `upload:${fresh.key}`,
            run: (uctx) => this._uploadCuts(fresh.key, uctx),
          });
        },
      }));
    }
    return queued;
  }

  async _uploadCuts(key, ctx) {
    const p = this.requireProject();
    const e = p.entry(key);
    const t = this.canvasTarget();
    const dir = path.join(path.dirname(e.abs), 'cuts');
    const files = e.cutFiles.map((c) => path.join(dir, c.name));
    const fail = (message, list) => { const err = { message, files: list, at: new Date().toISOString(), phase: 'upload' }; this._setCanvasError(key, err); return new Error(message); };
    if (!files.length) throw fail(`No cuts exist for ${e.name}. Cut it again.`, []);

    let pg;
    try { pg = await this.pageForScene(e.scene); } catch (err) { throw fail(canvas.explain(err), []); }
    let page;
    try { page = await this.client.getPage(t.canvasId, pg.id); } catch (err) { throw fail(canvas.explain(err), []); }

    const failures = [];
    let uploaded = 0; let skipped = 0; let replaced = 0;
    for (let i = 0; i < files.length; i++) {
      const name = path.basename(files[i]);
      try {
        const info = await p.probeFile(files[i]);
        if (info.error) throw Object.assign(new Error(info.error), { friendly: `The snippet ${name} can't be read (${info.error}). Cut it again.` });
        const r = await canvas.sendFile(this.client, {
          canvasId: t.canvasId, pageId: pg.id, file: files[i], width: info.width, height: info.height, layout: t.layout, signal: ctx.signal, page,
          sent: p.state.sent[name],
          onProgress: (f) => ctx.progress((i + f) / files.length, `Uploading ${i + 1} of ${files.length}`),
        });
        if (r.skipped) skipped++; else uploaded++;
        if (r.replaced) replaced++;
        p.state.sent[name] = { size: r.size, at: new Date().toISOString(), page: pg.id };
        p.scheduleSave();
      } catch (err) {
        if (err.cancelled || ctx.signal.aborted) throw err;
        failures.push({ file: name, message: canvas.explain(err) });
        if (fatalFor(err)) break; // same cause for every remaining snippet
      }
    }

    // Always tidy and re-read what is really on the canvas, even after a partial failure.
    try {
      await this._locked(async () => {
        const fresh = await this.client.getPage(t.canvasId, pg.id);
        await canvas.applyUpdates(this.client, t.canvasId, pg.id, t.mode === 'pages' ? canvas.planSortPage(fresh, t.layout) : canvas.planSort(fresh, t.layout));
        for (const n of canvas.onCanvasMap(fresh).keys()) p.canvasNames.add(n);
      });
    } catch (err) {
      if (!failures.length) failures.push({ file: '(sorting)', message: `Uploaded, but putting the clips in order failed. Press Sort canvas to retry. ${canvas.explain(err)}` });
    }
    p.canvasSyncedAt = new Date().toISOString();
    await p.scan();

    if (failures.length) {
      const done = uploaded + skipped;
      throw fail(`${failures.length} of ${files.length} snippets did not reach the canvas${done ? ` (${done} did)` : ''}. ${failures[0].message}`, failures);
    }
    this._setCanvasError(key, null);
    ctx.progress(1, `${uploaded} sent${skipped ? `, ${skipped} already there` : ''}${replaced ? `, ${replaced} replaced` : ''}`);
  }
}

module.exports = { App };
