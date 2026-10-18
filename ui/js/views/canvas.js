// Canvas: connect LetzAI, then cut and send takes to a canvas, sorted by scene, shot and take.
// Two layouts: one page with "Scene N" labels, or one page per scene (pages named "Scene 6", "Scene 14"…).
// Anything that fails stays on screen with the reason and a retry until it is fixed.
import { html, icon, mount, on, $, $$, fmtDur, plural, debounce } from '../lib.js';
import { get, post, put, patch } from '../api.js';
import { S, clips, allClips, scenes, loadInfo, failedSends, hasManyFolders, folderLabel } from '../store.js';
import { toast, toastError, openPopup, confirmDialog, field } from '../ui.js';
import { folderButton, folderChip, wireFolderControls } from '../folderpick.js';

let root;
let status = null;        // last /api/canvas/status
let loading = false;
let filter = 'printed';   // printed | all | todo | failed
const selected = new Set();
let keyEditing = false;

const proj = () => S.info.project;
const perScene = () => proj().canvas.mode === 'pages';
const connected = () => S.info.key.set && proj().canvas.canvasId && (perScene() || proj().canvas.pageId);
const canvasUrl = () => `https://www.letz.ai/canvas/${proj().canvas.canvasId}${!perScene() && proj().canvas.pageId ? `?page=${proj().canvas.pageId}` : ''}`;

async function refresh() {
  if (!root) return;
  loading = true; draw();
  try { status = await get('/api/canvas/status'); } catch (e) { status = { state: 'error', error: e.message }; }
  loading = false; draw();
}

async function setMode(mode) {
  try { await patch('/api/project', { canvas: { mode } }); await loadInfo(); status = null; refresh(); } catch (e) { toastError(e); }
}

function statusBlock() {
  const c = proj().canvas;
  if (!S.info.key.set) return html`<div class="app-alert">${icon('key')}<div class="grow"><b>Add your LetzAI API key</b>The kit uploads with your own key. It is stored on this computer only, never in the film folder.</div></div>`;
  if (!c.canvasId) return html`<div class="app-alert">${icon('canvas')}<div class="grow"><b>Choose a canvas</b>Pick the canvas your takes should land on.</div></div>`;
  if (loading && !status) return html`<div class="row faint"><span class="spinner"></span> Checking the canvas…</div>`;
  if (!status) return '';
  if (status.state === 'error') return html`<div class="app-alert app-alert--error">${icon('alert')}<div class="grow"><b>Can’t reach the canvas</b>${status.error}</div><button class="app-btn app-btn--sm" id="retry">Try again</button></div>`;
  if (status.state === 'ok') return html`<div class="row wrap" style="gap:10px"><span class="app-chip app-chip--success">${icon('check', 12)} Connected</span><span class="muted tnum">${status.nodeCount.toLocaleString()} nodes ${perScene() ? 'on the scene pages' : 'on the page'} · ${plural(status.onCanvas, 'clip')} from this kit</span><span class="grow"></span><a class="app-btn app-btn--sm" href="${canvasUrl()}" target="_blank" rel="noopener">${icon('external', 14)}<span>Open canvas</span></a><button class="app-btn app-btn--sm" id="retry" title="Check again">${icon('regenerate', 14)}</button></div>`;
  return '';
}

function connectionCard() {
  const c = proj().canvas;
  const key = S.info.key;
  return html`
    <div class="surface pad conn">
      <div class="conn-row">
        <div class="step-n">1</div>
        <div class="grow"><div class="surface-title">API key</div>
          ${key.set && !keyEditing ? html`<div class="muted">Saved on this computer${key.source === 'environment' ? ' (from the LETZAI_API_KEY environment variable)' : ''}.</div>` : html`<div class="row" style="margin-top:8px;max-width:520px"><input class="app-input" id="keyInput" type="password" placeholder="Paste your key" autocomplete="off" spellcheck="false"><button class="app-btn app-btn--primary" id="saveKey">Save</button>${keyEditing ? html`<button class="app-btn" id="cancelKey">Cancel</button>` : ''}</div><div class="app-hint" style="margin-top:6px">Get one at <a href="https://letz.ai/subscription" target="_blank" rel="noopener">letz.ai/subscription</a>.</div>`}
        </div>
        ${key.set && !keyEditing ? html`<button class="app-btn app-btn--sm" id="editKey">Replace</button>${key.source === 'file' ? html`<button class="app-btn app-btn--sm app-btn--danger" id="removeKey">Remove</button>` : ''}` : ''}
      </div>
      <div class="conn-row">
        <div class="step-n">2</div>
        <div class="grow"><div class="surface-title">Canvas</div>
          <div class="muted">${c.canvasId ? html`<b style="color:var(--color)">${c.canvasName || c.canvasId}</b>${!perScene() && c.pageName ? html` · ${c.pageName}` : ''}` : 'Not chosen yet.'}</div></div>
        <button class="app-btn app-btn--sm ${c.canvasId ? '' : 'app-btn--outline'}" id="pickCanvas" ${key.set ? '' : 'disabled'}>${c.canvasId ? 'Change' : 'Choose canvas…'}</button>
      </div>
      <div class="conn-row">
        <div class="step-n">3</div>
        <div class="grow"><div class="surface-title">Where clips go</div>
          <div class="muted">${perScene() ? 'Each scene goes to the page named after it (Scene 6, Scene 14…), in a grid below what is already there.' : 'All scenes go to one page, each under a text node called “Scene N”.'}</div></div>
        <div class="app-segmented" role="radiogroup" aria-label="Where clips go"><button role="radio" aria-checked="${!perScene()}" data-mode-pick="labels">One page</button><button role="radio" aria-checked="${perScene()}" data-mode-pick="pages">Page per scene</button></div>
      </div>
      <div class="conn-status">${statusBlock()}${suggestion()}</div>
    </div>`;
}

function suggestion() {
  if (!status || status.state !== 'ok' || perScene() || !status.suggestPages) return '';
  return html`<div class="app-alert" style="margin-top:12px">${icon('info')}<div class="grow"><b>This canvas has a page for each scene</b>Pages like “Scene 6” exist. Send each scene to its own page instead of one page?</div><button class="app-btn app-btn--sm" data-mode-pick="pages">Use a page per scene</button></div>`;
}

function destinations() {
  if (!connected() || !status || status.state !== 'ok') return '';
  const sc = scenes().filter((s) => s.shots.some((sh) => sh.takes.length));
  if (!sc.length) return '';
  if (perScene()) {
    const missing = sc.filter((s) => !(status.scenePages[s.id] && status.scenePages[s.id].found));
    return html`
      <div class="section-label">Scene pages</div>
      <div class="surface pad">
        <div class="row wrap" style="gap:8px">${sc.map((s) => { const p = status.scenePages[s.id]; return html`<span class="app-chip ${p && p.found ? 'app-chip--success' : 'app-chip--warning'}" title="${p && p.found ? p.name : 'No page named Scene ' + s.id}">${icon(p && p.found ? 'check' : 'dashed', 12)} Scene ${s.id}${p && p.found ? html` <span class="faint">→ ${p.name}</span>` : ''}</span>`; })}</div>
        ${missing.length ? html`<div class="app-alert app-alert--warning" style="margin-top:14px">${icon('warn')}<div class="grow"><b>${plural(missing.length, 'scene')} without a page</b>LetzAI’s API can’t create pages. Add ${missing.length === 1 ? 'a page' : 'pages'} named ${missing.map((s) => `“Scene ${s.id}”`).join(', ')} on the canvas, then check again. Takes of those scenes won’t send until then.</div><div class="row wrap" style="gap:6px"><button class="app-btn app-btn--sm" id="copyPageNames" data-names="${missing.map((s) => `Scene ${s.id}`).join('\n')}">${icon('copy', 14)}<span>Copy names</span></button><a class="app-btn app-btn--sm" href="${canvasUrl()}" target="_blank" rel="noopener">${icon('external', 14)}<span>Open canvas</span></a><button class="app-btn app-btn--sm" id="retry">Check again</button></div></div>` : ''}
      </div>`;
  }
  const missing = sc.filter((s) => status.labels[s.id] === false);
  return html`
    <div class="section-label">Scene labels on the page</div>
    <div class="surface pad">
      <div class="faint" style="margin-bottom:12px">Clips are placed in a grid under a text node called “Scene N”. A scene without one is parked below everything else on the page, far from where you’d look.</div>
      <div class="row wrap" style="gap:8px">${sc.map((s) => html`<span class="app-chip ${status.labels[s.id] ? 'app-chip--success' : 'app-chip--warning'}">${icon(status.labels[s.id] ? 'check' : 'dashed', 12)} Scene ${s.id}</span>`)}</div>
      ${missing.length ? html`<div class="row" style="margin-top:14px"><button class="app-btn app-btn--sm app-btn--outline" id="makeLabels">${icon('plus', 14)}<span>Create ${plural(missing.length, 'missing label')}</span></button></div>` : ''}
    </div>`;
}

function problems() {
  const bad = failedSends();
  if (!bad.length) return '';
  return html`
    <div class="section-label" style="color:var(--color-error)">Didn’t reach the canvas</div>
    <div class="surface problems">
      ${bad.map((c) => html`<div class="problem">
        <div class="row"><b class="tnum">${c.scene}.${c.shot}</b><span class="muted">take ${c.take}</span><span class="grow"></span>
          <button class="app-btn app-btn--sm" data-retry="${c.key}">${icon('regenerate', 14)}<span>Retry</span></button></div>
        <div class="problem-msg">${c.canvasError.message}</div>
        ${(c.canvasError.files || []).length ? html`<div class="faint problem-files">${c.canvasError.files.slice(0, 5).map((f) => html`<div><span class="mono-name">${f.file}</span> ${f.message ? html`<span>${f.message}</span>` : ''}</div>`)}${c.canvasError.files.length > 5 ? html`<div>and ${c.canvasError.files.length - 5} more</div>` : ''}</div>` : ''}
      </div>`)}
      <div class="row" style="padding:12px 16px"><button class="app-btn app-btn--primary" id="retryAll">${icon('regenerate')}<span>Retry all ${bad.length}</span></button></div>
    </div>`;
}

function takeRows() {
  const all = clips().filter((c) => c.kind === 'shot');
  const anyPrinted = all.some((c) => c.print);
  const f = filter === 'printed' && !anyPrinted ? 'all' : filter;
  return { f, anyPrinted, rows: all.filter((c) => (f === 'all' ? true : f === 'failed' ? !!c.canvasError : f === 'printed' ? c.print : !c.onCanvas && (c.print || !anyPrinted))) };
}

function sendTable() {
  const { f, anyPrinted, rows } = takeRows();
  const bySceneMap = new Map();
  for (const c of rows) { if (!bySceneMap.has(c.scene)) bySceneMap.set(c.scene, []); bySceneMap.get(c.scene).push(c); }
  const keys = rows.map((c) => c.key);
  const chosen = keys.filter((k) => selected.has(k));
  const toSend = chosen.length;
  const head = chosen.length === 0 ? false : chosen.length === keys.length ? true : 'mixed';
  const nFailed = failedSends().length;
  return html`
    <div class="section-label">Send takes</div>
    <div class="surface">
      <div class="send-bar">
        <div class="app-tabs" role="tablist">${[['printed', 'Printed'], ['all', 'All takes'], ['todo', 'Not on canvas'], ...(nFailed ? [['failed', `Failed (${nFailed})`]] : [])].map(([id, l]) => html`<button class="app-tab" role="tab" data-sf="${id}" aria-selected="${f === id}">${l}</button>`)}</div>
        ${!anyPrinted && filter === 'printed' ? html`<span class="faint">Nothing is printed yet, so all takes are shown.</span>` : ''}
        ${folderButton()}
        <span class="grow"></span>
        <button class="app-btn" id="sortCanvas" title="Re-order the kit’s clips on the canvas" ${connected() ? '' : 'disabled'}>${icon('layers')}<span>Sort canvas</span></button>
        <button class="app-btn app-btn--primary" id="sendSel" ${connected() && toSend ? '' : 'disabled'}>${icon('upload')}<span>${toSend ? `Cut and send ${plural(toSend, 'take')}` : 'Select takes to send'}</span></button>
      </div>
      ${rows.length ? html`<table class="table send-table"><thead><tr><th style="width:36px"><input type="checkbox" class="app-check" id="selAll" ${head === true ? 'checked' : ''} aria-label="Select all"></th><th>Take</th>${hasManyFolders() ? html`<th>Folder</th>` : ''}<th>Decision</th><th>Length</th><th>Cut files</th><th>On canvas</th></tr></thead>
        <tbody>${[...bySceneMap.entries()].map(([scene, list]) => html`<tr class="day-row"><td></td><td colspan="${hasManyFolders() ? 6 : 5}">Scene ${scene} <span class="faint">· ${plural(list.length, 'take')}</span></td></tr>
          ${list.map((c) => html`<tr data-row="${c.key}"><td><input type="checkbox" class="app-check" data-sel="${c.key}" ${selected.has(c.key) ? 'checked' : ''}></td>
            <td><b class="tnum">${c.scene}.${c.shot}</b> <span class="muted">take ${c.take}</span></td>
            ${hasManyFolders() ? html`<td class="faint">${folderLabel(c.dir)}</td>` : ''}
            <td>${c.rating ? html`<span class="app-chip xs">${c.rating}</span> ` : ''}${c.print ? html`<span class="app-chip xs app-chip--ink">${icon('flagFill', 12)} print</span>` : ''}${!c.rating && !c.print ? html`<span class="faint">—</span>` : ''}</td>
            <td class="tnum muted">${fmtDur(c.duration)}</td>
            <td class="tnum muted">${c.cutFiles.length || '—'}</td>
            <td>${c.canvasError ? html`<span class="app-chip xs app-chip--error" title="${c.canvasError.message}">${icon('alert', 12)} failed</span>` : c.onCanvas ? html`<span class="app-chip xs app-chip--success">${icon('check', 12)} On canvas</span>` : c.cutFiles.length ? html`<span class="tnum faint">${c.cutOnCanvas} / ${c.cutFiles.length}</span>` : html`<span class="faint">—</span>`}</td></tr>`)}`)}</tbody></table>`
      : html`<div class="app-empty"><div class="app-empty-title">No takes here</div><div class="app-empty-body">${f === 'printed' ? 'Circle takes in Review with P and they show up here.' : f === 'failed' ? 'Nothing failed.' : 'Everything is already on the canvas.'}</div></div>`}
    </div>`;
}

function snippetCard() {
  const s = proj().snippets;
  return html`
    <div class="section-label">Cutting</div>
    <div class="surface pad snippet-grid">
      ${field('Longest snippet', html`<div class="row"><input class="app-input" id="snMax" type="number" min="2" max="600" value="${s.maxSeconds}" style="width:90px"><span class="muted">seconds</span></div>`, 'Longer takes are split into pieces of this length.')}
      ${field('Picture size', html`<select class="app-input" id="snH" style="width:200px">${[[0, 'Original size'], [2160, 'Up to 4K'], [1440, 'Up to 1440p'], [1080, 'Up to 1080p (recommended)'], [720, 'Up to 720p']].map(([v, l]) => html`<option value="${v}" ${+s.height === v ? 'selected' : ''}>${l}</option>`)}</select>`, 'Smaller files upload faster. Clips are never scaled up.')}
      ${field('Encoder', html`<select class="app-input" id="snEnc" style="width:200px"><option value="auto" ${s.encoder !== 'cpu' ? 'selected' : ''}>Automatic (graphics card if available)</option><option value="cpu" ${s.encoder === 'cpu' ? 'selected' : ''}>Processor only</option></select>`)}
      <div class="app-field"><label>&nbsp;</label><label class="app-switch"><input type="checkbox" id="snLossless" ${s.lossless ? 'checked' : ''}><span>Fast cuts without re-encoding<br><span class="faint">Cuts land on keyframes. Ignored when scaling the picture.</span></span></label></div>
    </div>`;
}

function draw() {
  if (!root || !S.info) return;
  const sy = root.scrollTop;
  const ae = document.activeElement;
  const keep = ae && ae.id === 'keyInput' ? ae.value : null;
  mount(root, html`<div class="page nav">
    <div class="page-head"><div><h1 class="page-title">Canvas</h1><div class="page-sub">Cut your takes into snippets and send them to LetzAI Canvas, sorted by scene, shot and take.</div></div></div>
    ${connectionCard()}${problems()}${destinations()}${sendTable()}${snippetCard()}
  </div>`);
  root.scrollTop = sy;
  if (keep != null) { const k = $('#keyInput', root); if (k) { k.value = keep; k.focus(); } }
  const sa = $('#selAll', root);
  if (sa) { const { rows } = takeRows(); const n = rows.filter((c) => selected.has(c.key)).length; sa.indeterminate = n > 0 && n < rows.length; }
}

async function pickCanvasDialog() {
  const p = openPopup({
    title: 'Choose a canvas', width: 620,
    body: html`<input class="app-input" id="cvQ" placeholder="Search your canvases…" autocomplete="off"><div id="cvList" class="pick-list" style="margin-top:12px"><div class="row faint" style="padding:16px"><span class="spinner"></span> Loading…</div></div>`,
  });
  const list = $('#cvList', p.el);
  const load = async (q) => {
    try {
      const r = await get(`/api/canvas/list${q ? `?search=${encodeURIComponent(q)}` : ''}`);
      mount(list, r.canvases.length ? html`${r.canvases.map((c) => html`<button class="pick-item" data-cv="${c.id}" data-name="${c.name}">${c.thumbnail ? html`<img alt="" src="${c.thumbnail}" loading="lazy">` : html`<span class="pick-ph">${icon('canvas')}</span>`}<span class="grow"><b>${c.name || 'Untitled canvas'}</b><div class="faint" style="font-size:12px">${c.updatedAt ? `Updated ${new Date(c.updatedAt).toLocaleDateString()}` : ''}</div></span>${icon('chevronRight', 14)}</button>`)}` : html`<div class="app-empty" style="padding:24px"><div class="app-empty-body">No canvases found.</div></div>`);
    } catch (e) { mount(list, html`<div class="app-alert app-alert--error">${icon('alert')}<div class="grow">${e.message}</div></div>`); }
  };
  load('');
  $('#cvQ', p.el).addEventListener('input', debounce((e) => load(e.target.value.trim()), 250));
  on(p.el, 'click', '[data-cv]', async (e, b) => {
    mount(list, html`<div class="row faint" style="padding:16px"><span class="spinner"></span> Loading pages…</div>`);
    try {
      const r = await get(`/api/canvas/pages?canvasId=${encodeURIComponent(b.dataset.cv)}`);
      const scenePages = r.pages.filter((pg) => /^\s*scene\s*\d+/i.test(pg.name || ''));
      const choose = async (pg, mode) => {
        await patch('/api/project', { canvas: { canvasId: b.dataset.cv, canvasName: b.dataset.name, pageId: pg ? pg.id : '', pageName: pg ? pg.name : '', ...(mode ? { mode } : {}) } });
        await loadInfo(); p.close(); status = null;
        toast(mode === 'pages' ? `Using ${b.dataset.name}, one page per scene.` : `Using ${b.dataset.name} · ${pg.name}.`, { type: 'success' });
        refresh();
      };
      if (r.pages.length === 1) { await choose(r.pages[0]); return; }
      mount(list, html`<div class="faint" style="margin-bottom:8px">Pick where clips go in <b style="color:var(--color)">${b.dataset.name}</b></div>
        ${scenePages.length >= 2 ? html`<button class="pick-item" data-per-scene><span class="pick-ph">${icon('layers')}</span><span class="grow"><b>One page per scene</b><div class="faint" style="font-size:12px">Uses the pages named ${scenePages.slice(0, 4).map((pg) => pg.name).join(', ')}${scenePages.length > 4 ? '…' : ''}</div></span>${icon('chevronRight', 14)}</button><div class="rail-label">Or one page</div>` : ''}
        ${r.pages.map((pg) => html`<button class="pick-item" data-pg="${pg.id}" data-pname="${pg.name}"><span class="pick-ph">${icon('layers')}</span><span class="grow"><b>${pg.name || 'Page'}</b><div class="faint" style="font-size:12px">${(pg.nodeCount ?? 0).toLocaleString()} nodes${pg.id === r.defaultPageId ? ' · default' : ''}</div></span>${icon('chevronRight', 14)}</button>`)}`);
      on(list, 'click', '[data-pg]', (e2, pb) => choose({ id: pb.dataset.pg, name: pb.dataset.pname }, 'labels').catch(toastError));
      on(list, 'click', '[data-per-scene]', () => choose(null, 'pages').catch(toastError));
    } catch (err) { mount(list, html`<div class="app-alert app-alert--error">${icon('alert')}<div class="grow">${err.message}</div></div>`); }
  });
}

const saveSnippets = debounce(async (body) => { try { await patch('/api/project', { snippets: body }); await loadInfo(); } catch (e) { toastError(e); } }, 400);

async function sendKeys(keys, label) {
  try { await post('/api/canvas/send', { keys }); toast(`${label} Follow it in the queue.`, { type: 'success' }); } catch (e) { toastError(e); }
}

export default {
  flush: false,
  mount(el) {
    root = el;
    draw();
    refresh();
    wireFolderControls(el, on);
    on(el, 'click', '#saveKey', async () => { const v = $('#keyInput', el).value.trim(); if (!v) return; try { await put('/api/key', { key: v }); keyEditing = false; await loadInfo(); toast('Key saved on this computer.', { type: 'success' }); status = null; refresh(); } catch (e) { toastError(e); } });
    on(el, 'click', '#editKey', () => { keyEditing = true; draw(); $('#keyInput', el).focus(); });
    on(el, 'click', '#cancelKey', () => { keyEditing = false; draw(); });
    on(el, 'click', '#removeKey', async () => { if (await confirmDialog({ title: 'Remove the API key?', message: 'The key is deleted from this computer. You can add it again any time.', confirmLabel: 'Remove', danger: true })) { await put('/api/key', { key: '' }); await loadInfo(); status = null; draw(); } });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'keyInput') $('#saveKey', el).click(); });
    on(el, 'click', '#pickCanvas', pickCanvasDialog);
    on(el, 'click', '[data-mode-pick]', (e, b) => { const m = b.dataset.modePick; if ((m === 'pages') !== perScene()) setMode(m); });
    on(el, 'click', '#retry', refresh);
    on(el, 'click', '#copyPageNames', async (e, b) => { try { await navigator.clipboard.writeText(b.dataset.names); toast('Page names copied, one per line.', { type: 'success' }); } catch { toast('Could not copy. Type the names as shown.', { type: 'error' }); } });
    on(el, 'click', '#makeLabels', async (e, b) => { b.disabled = true; try { const miss = Object.entries(status.labels).filter(([, v]) => !v).map(([k]) => k); const r = await post('/api/canvas/labels', { scenes: miss }); toast(`Created ${plural(r.created, 'label')} on the canvas.`, { type: 'success' }); refresh(); } catch (err) { toastError(err); b.disabled = false; } });
    on(el, 'click', '[data-sf]', (e, b) => { filter = b.dataset.sf; selected.clear(); draw(); });
    on(el, 'change', '[data-sel]', (e, i) => { if (i.checked) selected.add(i.dataset.sel); else selected.delete(i.dataset.sel); draw(); });
    on(el, 'change', '#selAll', (e, i) => { const { rows } = takeRows(); if (i.checked) rows.forEach((c) => selected.add(c.key)); else rows.forEach((c) => selected.delete(c.key)); draw(); });
    on(el, 'click', '[data-row]', (e, tr) => { if (e.target.closest('input')) return; const k = tr.dataset.row; if (selected.has(k)) selected.delete(k); else selected.add(k); draw(); });
    on(el, 'click', '#sortCanvas', async (e, b) => {
      b.disabled = true;
      try {
        const r = await post('/api/canvas/sort');
        const note = r.parked && r.parked.length ? ` Scene ${r.parked.join(', ')} ${r.parked.length === 1 ? 'has' : 'have'} no label on the page, so ${r.parked.length === 1 ? 'its' : 'their'} clips sit below everything else.` : '';
        toast((r.moved ? `Moved ${plural(r.moved, 'node')} into order.` : 'Everything is already in order.') + note, { type: note ? 'info' : 'success', timeout: note ? 9000 : 4200 });
      } catch (err) { toastError(err); }
      b.disabled = false;
    });
    on(el, 'click', '#sendSel', async () => { const keys = [...selected]; if (!keys.length) return; await sendKeys(keys, `Cutting and uploading ${plural(keys.length, 'take')}.`); selected.clear(); draw(); });
    on(el, 'click', '[data-retry]', (e, b) => sendKeys([b.dataset.retry], 'Retrying.'));
    on(el, 'click', '#retryAll', () => sendKeys(failedSends().map((c) => c.key), `Retrying ${plural(failedSends().length, 'take')}.`));
    const snip = () => ({ maxSeconds: +$('#snMax', el).value, height: +$('#snH', el).value, encoder: $('#snEnc', el).value, lossless: $('#snLossless', el).checked });
    el.addEventListener('change', (e) => { if (['snMax', 'snH', 'snEnc', 'snLossless'].includes(e.target.id)) saveSnippets(snip()); });
  },
  update() { if (root && S.info && !(document.activeElement && document.activeElement.id === 'keyInput')) draw(); },
  unmount() { root = null; },
};
