'use strict';
// LetzAI Canvas client. Talks to the public API (https://api.letz.ai) with the user's own API key.
//
// Node ids are compatible with an earlier namer script this kit grew out of, so both can work on one canvas:
//   media node   clientNodeId "ltn:<file name>"        caption node  "ltn-cap:<file name>"
//
// Two ways to lay clips out:
//   labels  one page; each scene sits under a text node "Scene <N>", three clips per row (shot, take, cut order)
//   pages   one page per scene, named "Scene <N>"; clips sit in a grid below whatever is already on that page
//
// Everything that can fail is checked: the upload slot, the bytes that arrived, the nodes that were created.
// Transient problems (network, 429, 5xx, stalled transfers) are retried; everything else is reported with a
// sentence a director can act on.
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { URL } = require('url');
const { parseName, captionFor } = require('./names');
const { compareShots, httpError, sleep } = require('./util');

const apiBase = () => process.env.LETZAI_API_BASE || 'https://api.letz.ai';

const MIME = {
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', avi: 'video/x-msvideo', m4v: 'video/mp4',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
};

// The page uses a huge coordinate scale: a 1920x1080 clip is ~17174 wide there.
const DEFAULT_LAYOUT = { clipW: 17174, clipH: 9660, gap: 2000, capH: 1700, cols: 3, originDX: -1373, originDY: 29664, captionSize: 1100 };

const putStallMs = () => Number(process.env.LETZAI_KIT_STALL_MS) || 60000;

/** Turn a failure into a sentence you can act on (the technical detail stays in brackets). */
function explain(err) {
  const raw = String((err && err.message) || err);
  const detail = raw.replace(/\s+/g, ' ').trim().slice(0, 260);
  const s = err && err.status;
  let why;
  if (err && err.friendly) return err.friendly;
  if (/No LetzAI API key/.test(raw)) why = 'No LetzAI API key yet. Add one in Canvas.';
  else if (s === 401) why = 'LetzAI rejected the API key (401). It may be wrong or expired.';
  else if (s === 402) why = 'LetzAI says you are out of credits (402).';
  else if (s === 403) why = "You don't have permission to edit this canvas (403), or the upload link was refused.";
  else if (s === 404) why = 'The canvas or page was not found (404). Check the canvas selection.';
  else if (s === 413) why = 'The file is too large to upload (413).';
  else if (s === 429) why = 'LetzAI is rate-limiting requests (429). Wait a minute and retry.';
  else if (s >= 500) why = 'LetzAI had a server problem. Retry in a few minutes.';
  else if (err && err.code === 'stalled') why = 'The upload stalled and was given up on. Check the connection and retry.';
  else if (err && err.code === 'incomplete') why = 'The file arrived on LetzAI incomplete. Retry.';
  else if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EPIPE|fetch failed|network|socket hang up/i.test(raw)) why = 'No connection to LetzAI. Check the internet and retry.';
  else if (/ENOENT/.test(raw)) why = 'The snippet file is missing on disk. Cut it again.';
  else why = 'The canvas request failed.';
  return `${why} [${detail}]`;
}

const retryable = (e) => e && !e.cancelled && (e.status === 0 || e.status === 429 || e.status === 502 || e.status === 503 || e.status === 504 || e.code === 'stalled' || e.code === 'incomplete'
  || /ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|socket hang up|fetch failed/i.test(String(e.message)));

class CanvasClient {
  /**
   * @param {() => string|null} keyProvider
   * @param {{delays?: number[]}} [opts] retry back-off in ms (tests pass short ones)
   */
  constructor(keyProvider, opts = {}) {
    this.keyProvider = keyProvider;
    this.delays = opts.delays || [800, 2500, 6000];
  }

  /** Retry `fn` while the failure looks transient. */
  async retrying(fn, { delays = this.delays, signal, only429 = false } = {}) {
    let last;
    for (let i = 0; i <= delays.length; i++) {
      try { return await fn(i); } catch (e) {
        last = e;
        if (only429 ? e.status !== 429 : !retryable(e)) throw e;
        if (i === delays.length || (signal && signal.aborted)) throw e;
        const wait = e.retryAfter ? Math.min(30000, e.retryAfter * 1000) : delays[i];
        await sleep(wait);
      }
    }
    throw last;
  }

  /**
   * @param {{idempotent?: boolean}} [opts] POSTs that create things are only retried on 429 unless idempotent
   */
  async request(method, apiPath, body, opts = {}) {
    const attempt = async () => {
      const key = this.keyProvider();
      if (!key) throw httpError(401, 'No LetzAI API key');
      let res;
      try {
        res = await fetch(apiBase() + apiPath, {
          method,
          headers: { Authorization: `Bearer ${key}`, ...(body != null ? { 'Content-Type': 'application/json' } : {}) },
          body: body != null ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        throw httpError(0, `fetch failed: ${(e.cause && e.cause.code) || e.message}`);
      }
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      if (!res.ok) {
        const err = httpError(res.status, `LetzAI ${method} ${apiPath} failed (${res.status}): ${typeof data === 'string' ? data : JSON.stringify(data)}`);
        err.retryAfter = Number(res.headers.get('retry-after')) || 0;
        throw err;
      }
      return data;
    };
    const safe = method === 'GET' || method === 'PUT' || method === 'DELETE' || method === 'PATCH' || opts.idempotent;
    // A POST that creates things is only repeated on 429, when nothing can have been created yet.
    return this.retrying(attempt, { only429: !safe });
  }

  async listCanvases(search) {
    const q = new URLSearchParams({ limit: '50', sortBy: 'updatedAt', sortOrder: 'desc' });
    if (search) q.set('search', search);
    const res = await this.request('GET', `/canvas?${q}`);
    return Array.isArray(res) ? res : res.items || res.data || res.canvases || [];
  }

  getCanvas(id) { return this.request('GET', `/canvas/${id}`); }
  getPage(canvasId, pageId) { return this.request('GET', `/canvas/${canvasId}/pages/${pageId}`); }

  /**
   * Upload a file and prove it arrived: ask for a signed slot, PUT the bytes (stall-guarded, retried),
   * then HEAD the public URL and compare the size. Throws unless the whole file is there.
   */
  async uploadAsset(file, onProgress, signal) {
    const stat = fs.statSync(file);
    if (!stat.size) throw Object.assign(new Error(`${path.basename(file)} is empty`), { friendly: `The snippet ${path.basename(file)} is empty (0 bytes). Cut it again. [${file}]` });
    const ext = path.extname(file).slice(1).toLowerCase();
    const mime = MIME[ext];
    if (!mime) throw httpError(400, `Unsupported file type .${ext}`);
    const one = async () => {
      const slot = await this.request('POST', '/user-assets', { extension: ext === 'm4v' ? 'mp4' : ext, originalFilename: path.basename(file), mimeType: mime, fileSize: stat.size }, { idempotent: true });
      if (!slot || !slot.uploadUrl || !slot.imageUrl) throw Object.assign(new Error('LetzAI returned no upload link'), { friendly: `LetzAI did not hand out an upload link for ${path.basename(file)}. [${JSON.stringify(slot).slice(0, 160)}]` });
      await putFile(slot.uploadUrl, file, mime, stat.size, onProgress, signal);
      await this.verifyAvailable(slot.imageUrl, stat.size);
      return { ...slot, mime, size: stat.size, isVideo: mime.startsWith('video/') };
    };
    return this.retrying(one, { signal });
  }

  /** The uploaded file must be served with exactly the bytes we sent (LetzAI stores uploads unchanged). */
  async verifyAvailable(url, size) {
    let last = 'no answer';
    for (let i = 0; i < 5; i++) {
      try {
        const r = await fetch(url, { method: 'HEAD' });
        const len = Number(r.headers.get('content-length'));
        if (r.ok && len === size) return;
        if (r.ok && len && len !== size) throw Object.assign(new Error(`arrived with ${len} of ${size} bytes`), { code: 'incomplete' });
        last = r.ok ? 'size not reported' : `HTTP ${r.status}`;
      } catch (e) { if (e.code === 'incomplete') throw e; last = e.message; }
      await sleep(i === 0 ? 400 : 1200);
    }
    throw Object.assign(new Error(`Upload finished but ${url} is not available (${last})`), { friendly: `The upload finished but LetzAI is not serving the file (${last}). Retry. [${url}]` });
  }
}

function putFile(url, file, mime, size, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    const req = lib.request({ method: 'PUT', hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname + u.search, headers: { 'Content-Type': mime, 'Content-Length': size } }, (res) => {
      const chunks = [];
      res.on('data', (c) => { if (chunks.length < 20) chunks.push(c); });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) return done(resolve);
        const body = Buffer.concat(chunks).toString('utf8');
        const msg = (/<Message>([^<]+)<\/Message>/.exec(body) || [])[1] || body.slice(0, 160);
        return done(reject, httpError(res.statusCode, `Upload was refused (${res.statusCode})${msg ? `: ${msg}` : ''}`));
      });
    });
    req.setTimeout(putStallMs(), () => req.destroy(Object.assign(new Error('Upload stalled'), { code: 'stalled' })));
    req.on('error', (e) => done(reject, e.cancelled ? e : (e.code === 'stalled' ? e : httpError(0, `fetch failed: ${e.code || e.message}`))));
    if (signal) {
      if (signal.aborted) return done(reject, Object.assign(new Error('cancelled'), { cancelled: true }));
      signal.addEventListener('abort', () => req.destroy(Object.assign(new Error('cancelled'), { cancelled: true })), { once: true });
    }
    let sent = 0;
    const rs = fs.createReadStream(file);
    rs.on('data', (c) => { sent += c.length; if (onProgress) onProgress(sent / size); });
    rs.on('error', (e) => { req.destroy(); done(reject, e); });
    rs.pipe(req);
  });
}

// ---- pages ------------------------------------------------------------------

/** The page for a scene in "page per scene" mode: named "Scene 6" (also "Scene 6 - Kitchen"). */
function findScenePage(pages, scene) {
  const n = String(scene).replace(/^0+(?=\d)/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*scene\\s*0*${n}\\s*(?:[-\\u2013:].*)?$`, 'i');
  return (pages || []).find((p) => re.test(String(p.name || '')));
}

// ---- layout ---------------------------------------------------------------

const sceneLabelRe = (scene) => new RegExp(`^\\s*Scene\\s+${String(scene).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');

function findSceneLabel(nodes, scene) {
  const re = sceneLabelRe(scene);
  return nodes.find((n) => n.kind === 'text' && n.data && typeof n.data.text === 'string' && re.test(n.data.text));
}

function infoFor(nodeName) {
  const info = parseName(nodeName);
  return info ? { name: nodeName, ...info } : null;
}

const isOurs = (n) => typeof n.clientNodeId === 'string' && n.clientNodeId.startsWith('ltn');

function ourItems(nodes) {
  const caps = new Map();
  for (const n of nodes) if (typeof n.clientNodeId === 'string' && n.clientNodeId.startsWith('ltn-cap:')) caps.set(n.clientNodeId.slice(8), n);
  const items = [];
  for (const n of nodes) {
    if (typeof n.clientNodeId !== 'string' || !n.clientNodeId.startsWith('ltn:')) continue;
    const info = infoFor(n.clientNodeId.slice(4));
    if (info) items.push({ node: n, cap: caps.get(info.name), ...info });
  }
  return items;
}

function gridMoves(group, ox, oy, L) {
  const updates = [];
  group.sort((a, b) => compareShots(a.shot, b.shot) || a.take - b.take || a.cut - b.cut || a.name.localeCompare(b.name));
  group.forEach((it, i) => {
    const col = i % L.cols;
    const row = Math.floor(i / L.cols);
    const x = ox + col * (L.clipW + L.gap);
    const y = oy + row * (L.capH + L.clipH + L.gap);
    if (it.cap && (Math.abs(it.cap.position.x - x) > 0.5 || Math.abs(it.cap.position.y - y) > 0.5)) updates.push({ id: it.cap.id, patch: { position: { x, y } } });
    const cy = y + L.capH;
    if (Math.abs(it.node.position.x - x) > 0.5 || Math.abs(it.node.position.y - cy) > 0.5) updates.push({ id: it.node.id, patch: { position: { x, y: cy } } });
  });
  return updates;
}

/**
 * Labels mode: node moves that put every kit-managed clip in order, one block per scene under its "Scene N" label.
 * A scene without a label is parked below everything and reported in `parked` (the UI says so).
 */
function planSort(page, layout, out) {
  const L = { ...DEFAULT_LAYOUT, ...layout };
  const nodes = page.nodes || [];
  const byScene = new Map();
  for (const it of ourItems(nodes)) { if (!byScene.has(it.scene)) byScene.set(it.scene, []); byScene.get(it.scene).push(it); }
  const updates = [];
  const minX = nodes.length ? Math.min(...nodes.map((n) => n.position.x)) : 0;
  const maxB = nodes.length ? Math.max(...nodes.map((n) => n.position.y + ((n.size && n.size.h) || 0))) : 0;
  let parked = 0;
  for (const [scene, group] of byScene) {
    const label = findSceneLabel(nodes, scene);
    let ox; let oy;
    if (label) { ox = label.position.x + L.originDX; oy = label.position.y + L.originDY; }
    else { ox = minX; oy = maxB + 5000 + parked * (L.capH + L.clipH + L.gap) * 4; parked++; if (out) (out.parked ||= []).push(scene); }
    updates.push(...gridMoves(group, ox, oy, L));
  }
  return updates;
}

/**
 * Page-per-scene mode: everything of ours on this page is one block. It starts where our first clip already is,
 * or, the first time, below whatever is on the page already (we never move other people's nodes).
 */
function planSortPage(page, layout) {
  const L = { ...DEFAULT_LAYOUT, ...layout };
  const nodes = page.nodes || [];
  const items = ourItems(nodes);
  if (!items.length) return [];
  const others = nodes.filter((n) => !isOurs(n));
  // Where each of our blocks starts: its caption's top, or the clip's top minus the caption height.
  const tops = items.map((it) => ({ x: it.cap ? it.cap.position.x : it.node.position.x, y: it.cap ? it.cap.position.y : it.node.position.y - L.capH }));
  const mine = { x: Math.min(...tops.map((t) => t.x)), y: Math.min(...tops.map((t) => t.y)) };
  let ox = mine.x; let oy = mine.y;
  if (others.length) {
    // Keep the block where it is once it sits below the other content; otherwise (first time) start below it.
    const othersBottom = Math.max(...others.map((n) => n.position.y + ((n.size && n.size.h) || 0)));
    if (mine.y < othersBottom) { ox = Math.min(...others.map((n) => n.position.x)); oy = othersBottom + 5000; }
  }
  return gridMoves(items, ox, oy, L);
}

async function applyUpdates(client, canvasId, pageId, updates) {
  for (let i = 0; i < updates.length; i += 80) {
    await client.request('PATCH', `/canvas/${canvasId}/pages/${pageId}/nodes`, { updates: updates.slice(i, i + 80) });
  }
  return updates.length;
}

/**
 * Upload a local video/image and drop it on the canvas with a caption.
 *
 *  - a clip already on the page is skipped, unless the file changed since it was sent (`sent.size` differs):
 *    then the old nodes are removed and the new file is uploaded in their place
 *  - the upload is verified (size on LetzAI) and so are the created nodes; any shortfall throws
 */
async function sendFile(client, { canvasId, pageId, file, width, height, layout, onProgress, signal, page, sent }) {
  const L = { ...DEFAULT_LAYOUT, ...layout };
  const name = path.basename(file);
  const clientNodeId = `ltn:${name}`;
  const capId = `ltn-cap:${name}`;
  const stat = fs.statSync(file);
  const current = page || await client.getPage(canvasId, pageId);
  const existing = (current.nodes || []).find((n) => n.clientNodeId === clientNodeId);
  let replaced = false;
  if (existing) {
    if (!(sent && sent.size && sent.size !== stat.size)) return { nodeId: existing.id, skipped: true, size: stat.size };
    const cap = (current.nodes || []).find((n) => n.clientNodeId === capId);
    await client.request('DELETE', `/canvas/${canvasId}/pages/${pageId}/nodes`, { ids: [existing.id, ...(cap ? [cap.id] : [])] });
    replaced = true;
  }
  const asset = await client.uploadAsset(file, onProgress, signal);
  const W = width || 1920;
  const H = height || 1080;
  const scale = Math.min(L.clipW / W, L.clipH / H);
  const nodes = [
    {
      clientNodeId: capId, kind: 'text', position: { x: 0, y: 0 }, size: { w: L.clipW, h: L.capH - 300 },
      data: { text: captionFor(name), fontSize: L.captionSize, bold: false, italic: false, underline: false, variant: 'body', textColor: null, runs: null, autoResize: 'both' },
    },
    {
      clientNodeId, kind: 'media', position: { x: 0, y: L.capH }, size: { w: Math.round(W * scale), h: Math.round(H * scale) },
      data: { url: asset.imageUrl, thumbUrl: asset.imageUrl, type: asset.isVideo ? 'video' : 'image', source: 'asset', mediaId: asset.id, assetId: asset.id, naturalW: W, naturalH: H, likes: 0, pending: null },
    },
  ];
  let res;
  try {
    res = await client.request('POST', `/canvas/${canvasId}/pages/${pageId}/nodes/batch`, { nodes });
  } catch (e) {
    // An ambiguous failure may still have created the nodes. Look before reporting.
    if (e.status === 0 || e.status >= 500) {
      const after = await client.getPage(canvasId, pageId).catch(() => null);
      const made = after && (after.nodes || []).find((n) => n.clientNodeId === clientNodeId);
      if (made) return { nodeId: made.id, skipped: false, replaced, size: stat.size };
    }
    throw e;
  }
  const made = (res && res.nodes || []).find((n) => n.clientNodeId === clientNodeId);
  const madeCap = (res && res.nodes || []).find((n) => n.clientNodeId === capId);
  if (!made || !made.id) {
    throw Object.assign(new Error(`LetzAI did not create the clip node for ${name}: ${JSON.stringify(res).slice(0, 200)}`), { friendly: `The file was uploaded, but LetzAI did not put ${name} on the canvas. Retry. [${JSON.stringify(res).slice(0, 160)}]` });
  }
  if (!madeCap) {
    // the clip is there but its caption is not: add the caption on its own rather than leaving a bare clip
    await client.request('POST', `/canvas/${canvasId}/pages/${pageId}/nodes/batch`, { nodes: [nodes[0]] }).catch(() => {});
  }
  return { nodeId: made.id, skipped: false, replaced, size: stat.size };
}

/** Create a "Scene N" label (labels mode) so clips of that scene have a home. */
async function createSceneLabel(client, { canvasId, pageId, scene, layout }) {
  const L = { ...DEFAULT_LAYOUT, ...layout };
  const page = await client.getPage(canvasId, pageId);
  const nodes = page.nodes || [];
  if (findSceneLabel(nodes, scene)) return { created: false };
  const labels = nodes.filter((n) => n.kind === 'text' && /^\s*Scene\s+\S+\s*$/i.test((n.data && n.data.text) || ''));
  // Stack new labels below the lowest existing scene block, aligned with the other labels.
  const x = labels.length ? Math.min(...labels.map((n) => n.position.x)) : 0;
  const y = labels.length ? Math.max(...labels.map((n) => n.position.y)) + 3 * (L.capH + L.clipH + L.gap) + 4000 : 0;
  await client.request('POST', `/canvas/${canvasId}/pages/${pageId}/nodes/batch`, {
    nodes: [{
      clientNodeId: `ltn-scene:${scene}`, kind: 'text', position: { x, y }, size: { w: 9000, h: 3000 },
      data: { text: `Scene ${scene}`, fontSize: 2400, bold: true, italic: false, underline: false, variant: 'body', textColor: null, runs: null, autoResize: 'both' },
    }],
  });
  return { created: true };
}

/** Which of our clips are on this page? -> Map(file name -> node id) */
function onCanvasMap(page) {
  const map = new Map();
  for (const n of page.nodes || []) if (typeof n.clientNodeId === 'string' && n.clientNodeId.startsWith('ltn:')) map.set(n.clientNodeId.slice(4), n.id);
  return map;
}

module.exports = {
  CanvasClient, DEFAULT_LAYOUT, explain, retryable, planSort, planSortPage, applyUpdates, sendFile, createSceneLabel,
  onCanvasMap, findSceneLabel, findScenePage, ourItems, MIME,
};
