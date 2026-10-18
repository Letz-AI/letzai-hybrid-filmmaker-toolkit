'use strict';
// A tiny stand-in for api.letz.ai that can misbehave on demand. Used to prove the upload error paths.
const http = require('http');

function createFakeLetzAI() {
  const state = {
    pages: { p1: [], p2: [] },
    canvasPages: [{ id: 'p1', name: 'Scene 6' }, { id: 'p2', name: 'Final Assets' }],
    files: new Map(),     // id -> { bytes, declared }
    log: [],              // "METHOD path"
    n: 0,
    // behaviours, consumed in order where it says "times"
    fail: {
      slot429: 0,          // answer /user-assets with 429 this many times first
      slotMissingUrl: false,
      putStatus: null,     // { status, body, name? } refuse uploads (optionally only for one file name)
      putStatusTimes: Infinity,
      putTruncate: false,  // store only half the bytes
      putTruncateTimes: Infinity,
      batchNoMedia: false, // batch answers without the media node
      batchNoCaption: false,
      batch500Created: false, // answer 500 but create the nodes anyway
      page401: false,
      stall: false,
    },
  };
  let base = '';

  const readBody = (req) => new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))); });
  const send = (res, status, obj, headers = {}) => { const b = obj == null ? '' : typeof obj === 'string' ? obj : JSON.stringify(obj); res.writeHead(status, { 'Content-Type': typeof obj === 'string' ? 'text/plain' : 'application/json', ...headers }); res.end(b); };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    state.log.push(`${req.method} ${p}`);
    let m;
    try {
      if (req.method === 'PUT' && (m = /^\/upload\/(.+)$/.exec(p))) {
        const f = state.fail;
        if (f.stall) { req.resume(); return; } // never answer
        const body = await readBody(req);
        const meta = state.files.get(m[1]);
        if (f.putStatus && f.putStatusTimes > 0 && (!f.putStatus.name || f.putStatus.name === meta.name)) {
          f.putStatusTimes--;
          return send(res, f.putStatus.status, f.putStatus.body || '');
        }
        let bytes = body;
        if (f.putTruncate && f.putTruncateTimes > 0) { f.putTruncateTimes--; bytes = body.subarray(0, Math.floor(body.length / 2)); }
        meta.bytes = bytes;
        return send(res, 200, '');
      }
      if ((req.method === 'HEAD' || req.method === 'GET') && (m = /^\/files\/(.+)$/.exec(p))) {
        const meta = state.files.get(m[1]);
        if (!meta || !meta.bytes) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Length': meta.bytes.length, 'Content-Type': 'video/mp4' });
        return res.end(req.method === 'HEAD' ? undefined : meta.bytes);
      }
      if (req.headers.authorization !== 'Bearer test-key') return send(res, 401, { message: 'Unauthorized' });
      const body = ['POST', 'PATCH', 'DELETE'].includes(req.method) ? JSON.parse((await readBody(req)).toString('utf8') || '{}') : null;

      if (req.method === 'POST' && p === '/user-assets') {
        if (state.fail.slot429 > 0) { state.fail.slot429--; return send(res, 429, { message: 'slow down' }, { 'Retry-After': '0' }); }
        const id = `a${++state.n}`;
        state.files.set(id, { bytes: null, name: body.originalFilename, declared: body.fileSize });
        if (state.fail.slotMissingUrl) return send(res, 201, { id });
        return send(res, 201, { id, uploadUrl: `${base}/upload/${id}`, imageUrl: `${base}/files/${id}` });
      }
      if (req.method === 'GET' && (m = /^\/canvas\/([^/]+)$/.exec(p))) return send(res, 200, { id: m[1], name: 'Fake', pages: state.canvasPages, defaultPageId: 'p1' });
      if ((m = /^\/canvas\/([^/]+)\/pages\/([^/]+)(\/nodes(?:\/batch)?)?$/.exec(p))) {
        const nodes = state.pages[m[2]];
        if (!nodes) return send(res, 404, { message: 'page not found' });
        if (req.method === 'GET' && !m[3]) { if (state.fail.page401) return send(res, 401, { message: 'nope' }); return send(res, 200, { id: m[2], nodes }); }
        if (req.method === 'POST' && m[3] === '/nodes/batch') {
          const made = body.nodes.map((n) => ({ ...n, id: `n${++state.n}`, position: { ...n.position } }));
          const f = state.fail;
          const keep = made.filter((n) => !(f.batchNoMedia && n.kind === 'media') && !(f.batchNoCaption && n.kind === 'text'));
          nodes.push(...(f.batch500Created ? made : keep));
          if (f.batch500Created) { f.batch500Created = false; return send(res, 500, { message: 'boom' }); }
          return send(res, 201, { nodes: keep });
        }
        if (req.method === 'PATCH' && m[3] === '/nodes') {
          for (const u of body.updates) { const n = nodes.find((x) => x.id === u.id); if (n && u.patch.position) n.position = u.patch.position; }
          return send(res, 200, { ok: true });
        }
        if (req.method === 'DELETE' && m[3] === '/nodes') {
          state.pages[m[2]] = nodes.filter((n) => !body.ids.includes(n.id));
          return send(res, 200, { ok: true });
        }
      }
      return send(res, 404, { message: `no route ${req.method} ${p}` });
    } catch (e) { return send(res, 500, { message: e.message }); }
  });

  return {
    state,
    async start() { await new Promise((r) => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`; process.env.LETZAI_API_BASE = base; return base; },
    stop() { return new Promise((r) => { server.closeAllConnections?.(); server.close(r); }); },
    count: (pageId, kind) => state.pages[pageId].filter((n) => n.kind === kind).length,
    reset() { state.pages = { p1: [], p2: [] }; state.files.clear(); state.log = []; Object.assign(state.fail, { slot429: 0, slotMissingUrl: false, putStatus: null, putStatusTimes: Infinity, putTruncate: false, putTruncateTimes: Infinity, batchNoMedia: false, batchNoCaption: false, batch500Created: false, page401: false, stall: false }); },
  };
}

module.exports = { createFakeLetzAI };
