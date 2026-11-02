// Settings: project, footage, playback, AI slate reading, appearance; naming details, setup check and data under Advanced.
import { html, icon, mount, on, $, plural, debounce, fmtSize } from '../lib.js';
import { get, post, put, patch } from '../api.js';
import { providerPicker, currentProvider, money } from '../slate.js';
import { openSetup } from '../setup.js';
import { S, loadInfo, clips, allClips, folders } from '../store.js';
import { toast, toastError, confirmDialog, field } from '../ui.js';
import { openRenameAll } from '../renameall.js';
import { setTheme } from '../app.js';

let root;
let doctor = null;
let found = [];
let proxy = null;
let vis = null;     // AI slate reading settings from the server (provider, model, consent, which keys are saved)
let visBusy = '';
let visMsg = null;  // { ok, text }
let visError = ''; // why those settings could not be loaded
let advOpen = false; // "Advanced" unfolded (kept across redraws)

const proj = () => S.info.project;
const theme = () => { try { return localStorage.getItem('theme') || 'dark'; } catch { return 'dark'; } };

const saved = debounce(() => toast('Saved.', { timeout: 1200 }), 500);
async function save(body) {
  try { await patch('/api/project', body); await loadInfo(); saved(); } catch (e) { toastError(e); }
}

function draw() {
  if (!root || !S.info) return;
  const p = proj();
  const sy = root.scrollTop;
  const needProxy = clips().filter((c) => c.probe && !(c.probe.codec === 'h264' && c.size < 4e9) && !c.hasCamProxy).length;
  mount(root, html`<div class="page default">
    <div class="page-head"><div><h1 class="page-title">Settings</h1><div class="page-sub">${p.name}</div></div></div>

    <div class="section-label" style="margin-top:0">Project</div>
    <div class="surface pad form-grid">
      ${field('Film name', html`<input class="app-input" id="sName" value="${p.name}" spellcheck="false">`)}
      ${field('File name prefix', html`<input class="app-input" id="sPrefix" value="${p.prefix}" spellcheck="false">`, html`New names: <b style="display:inline">${p.prefix}-scene6-shot2A-take3</b>`)}
    </div>

    <div class="section-label">Footage</div>
    <div class="surface pad">
      <div class="folder-list">${p.folders.map((f, i) => html`<div class="row folder-row"><span class="grow tnum" title="${f}">${f}</span><button class="app-icon-btn app-icon-btn--sm" data-rmf="${i}" title="Remove this folder from the project">${icon('close', 14)}</button></div>`)}${p.folders.length ? '' : html`<div class="faint" style="padding:8px">No folders yet.</div>`}</div>
      ${found.length ? html`<div class="app-alert app-alert--warning" style="margin-top:12px">${icon('folder')}<div class="grow"><b>New footage found</b>${found.map((f) => html`<div class="row" style="gap:8px;margin-top:6px"><span class="grow"><b style="display:inline">${f.name}</b> <span class="faint">· ${plural(f.clips, 'clip')}</span></span><button class="app-btn app-btn--sm" data-add-found="${f.path}">${icon('plus', 14)}<span>Add</span></button></div>`)}</div></div>` : ''}
      <div class="row" style="margin-top:10px"><button class="app-btn app-btn--sm" id="addFolder">${icon('plus', 14)}<span>Add a folder</span></button><button class="app-btn app-btn--sm" id="rescan">${icon('regenerate', 14)}<span>Rescan</span></button></div>
    </div>

    <div class="section-label">Playback</div>
    <div class="surface pad form-grid">
      <label class="app-switch" title="Camera files (4K HEVC) don’t play in most browsers, so the kit makes small playable copies."><input type="checkbox" id="sPrepare" ${p.playback && p.playback.prepare === false ? '' : 'checked'}><span>Prepare playable copies in the background${proxy ? html`<br><span class="faint">${proxy.left ? `${plural(proxy.left, 'clip')} left, about ${proxy.etaMinutes} min` : 'All ready'}</span>` : ''}</span></label>
    </div>

    <div class="section-label">AI slate reading</div>
    <div class="surface pad form-grid">
      ${visError ? html`<div class="app-alert app-alert--error">${icon('alert')}<div class="grow"><b>Couldn’t load the AI settings</b>${visError}</div></div>` : vis ? html`
        <div class="muted">An AI reads the slate on each clip and suggests its name. Uses your own API key.</div>
        ${field('AI', providerPicker(vis))}
        <div class="app-field"><label for="sVisKey">${vis.company} API key</label>
          ${vis.key.set ? html`<div class="row" style="gap:8px"><span class="app-chip app-chip--success">${icon('checkCircle', 14)}Saved${vis.key.source === 'environment' ? ` (${currentProvider(vis).env})` : ''}</span><span class="grow"></span>${vis.key.source === 'file' ? html`<button class="app-btn app-btn--sm" id="visRemove">${icon('trash', 14)}<span>Remove key</span></button>` : ''}<button class="app-btn app-btn--sm" id="visTest">${visBusy === 'test' ? 'Testing…' : 'Test it'}</button></div>`
            : html`<div class="row" style="gap:8px"><input class="app-input" id="sVisKey" type="password" placeholder="${currentProvider(vis).keyHint}" autocomplete="off" spellcheck="false"><button class="app-btn app-btn--primary" id="visSave" style="flex:none">${visBusy === 'save' ? 'Testing…' : 'Save and test'}</button></div>
              <div class="app-hint">Get one in the <a href="${currentProvider(vis).keyUrl}" target="_blank" rel="noopener">${currentProvider(vis).keyPage}</a>.</div>`}
          ${visMsg ? html`<div class="app-alert app-alert--${visMsg.ok ? 'success' : 'error'}" style="margin-top:8px">${icon(visMsg.ok ? 'checkCircle' : 'alert')}<div class="grow">${visMsg.text}</div></div>` : ''}
        </div>
        ${field('Model', html`<select class="app-input" id="sVisModel">${vis.models.map((m) => html`<option value="${m.id}" title="${m.note}" ${m.id === vis.model ? 'selected' : ''}>${m.label}</option>`)}</select>`)}
        <label class="app-switch" title="A few frames from the start of each clip you ask the AI to read. File names are not sent. You see the size of each run first."><input type="checkbox" id="sVisConsent" ${vis.consent ? 'checked' : ''}><span>Allow sending frames to ${vis.company}</span></label>
        <div class="app-field"><div class="label">Spending</div>
          <div class="muted">This month: about ${money(vis.budget.spent)}${vis.budget.monthly != null ? ` of your ${money(vis.budget.monthly)} budget` : ''}. <span class="faint">Estimated from what the AI reports; your ${vis.company} account shows the exact amount.</span></div></div>
        <div class="row wrap" style="gap:16px;align-items:flex-start">
          ${field('Monthly budget (US$)', html`<input class="app-input" id="sBudget" type="number" min="0" step="1" inputmode="decimal" placeholder="No limit" value="${vis.budget.monthly ?? ''}" style="width:160px">`, 'Reading stops when it is used up.')}
          ${field('Ask before a run over (US$)', html`<input class="app-input" id="sConfirm" type="number" min="0" step="1" inputmode="decimal" placeholder="Never ask" value="${vis.budget.confirmAbove ?? ''}" style="width:160px">`, 'Large runs need a second yes.')}
        </div>
        <div class="app-hint">The kit’s budget is an estimate. For a hard limit, also set one in your <a href="${currentProvider(vis).limitsUrl}" target="_blank" rel="noopener">${vis.company} account</a>.</div>` : html`<span class="row"><span class="spinner"></span> Loading…</span>`}
    </div>

    <div class="section-label">Appearance</div>
    <div class="surface pad"><div class="app-segmented" role="radiogroup">${[['dark', 'Dark', 'moon'], ['light', 'Light', 'sun'], ['system', 'Match system', 'settings']].map(([id, l, ic]) => html`<button role="radio" aria-checked="${theme() === id}" data-theme-pick="${id}">${icon(ic, 14)}${l}</button>`)}</div></div>

    <details class="fold" id="advFold" ${advOpen ? 'open' : ''}><summary class="section-label">Advanced</summary>
    <div class="surface pad form-grid">
      <div class="app-field"><div class="label">Number padding</div><div class="row">${['scene', 'shot', 'take'].map((k) => html`<select class="app-input" data-pad="${k}" style="width:auto"><option value="0" ${p.naming.pad[k] === 0 ? 'selected' : ''}>${k} 6</option><option value="2" ${p.naming.pad[k] === 2 ? 'selected' : ''}>${k} 06</option><option value="3" ${p.naming.pad[k] === 3 ? 'selected' : ''}>${k} 006</option></select>`)}</div></div>
      <label class="app-switch" title="Adds -good / -ok / -void and -print. Off: ratings stay in the project file, so names never change."><input type="checkbox" id="sRich" ${p.naming.ratingInFilename ? 'checked' : ''}><span>Put the rating in the file name</span></label>
      <div class="row" style="gap:12px"><div class="grow"><b>Rename all files</b><div class="faint">Apply prefix, padding and rating changes to files already named. Can be undone.</div></div><button class="app-btn" id="renameAll">${icon('pencil')}<span>Rename all…</span></button></div>
      <div class="app-field"><label for="sIgnore">Skip folders named</label><input class="app-input" id="sIgnore" value="${p.ignoreDirs.join(', ')}" spellcheck="false"><div class="app-hint">Comma separated</div></div>
      ${folders().length > 1 ? html`<div><div class="insp-label">Folders the project sees</div><div class="folder-tree">${folders().filter((f) => f.path !== '.').map((f) => html`<div class="row" style="padding-left:${(f.depth - 1) * 18}px">${icon('folder', 14)}<span class="grow">${f.name}</span><span class="faint tnum">${plural(f.clips, 'clip')}${f.raw ? ` · ${f.raw} unnamed` : ''}</span></div>`)}</div></div>` : ''}
    </div>

    <div class="section-label">Setup check</div>
    <div class="surface pad setup-list">
      ${check(S.info.ffmpeg.ok, 'ffmpeg', S.info.ffmpeg.ok ? html`${S.info.ffmpeg.version}<br><span class="faint tnum">${S.info.ffmpeg.path}</span>` : 'Not found. Install it and restart the kit.')}
      ${check(!!doctor, 'Video encoder', doctor ? (doctor.encoder === 'libx264' ? 'Processor (x264). Cutting 4K is slow.' : `Graphics card (${doctor.encoder})`) : html`<span class="row"><span class="spinner"></span> Testing…</span>`)}
      ${check(S.hevc, 'HEVC playback', S.hevc ? 'Camera files play directly.' : html`Not in this browser, so playable copies are made. <span class="faint">On Windows the “HEVC Video Extensions” from the Microsoft Store fix this.</span>`)}
      ${check(S.info.vision && S.info.vision.keySet, `${(S.info.vision && S.info.vision.company) || 'AI'} API key`, S.info.vision && S.info.vision.keySet ? 'Saved' : 'Optional')}
      ${check(S.info.key.set, 'LetzAI API key', S.info.key.set ? 'Saved' : html`Optional. Add it in <a href="#/canvas">Canvas</a>.`)}
      <div class="row wrap" style="margin-top:6px"><button class="app-btn app-btn--sm" id="setupAgain">${icon('key', 14)}<span>Setup assistant…</span></button><button class="app-btn app-btn--sm" id="prepProxies">${icon('layers', 14)}<span>Prepare playable copies for ${needProxy ? plural(needProxy, 'clip') : 'all clips'} now</span></button></div>
    </div>

    <div class="section-label">Data</div>
    <div class="surface pad data-list">
      <div class="row"><div class="grow"><b>Project file</b><div class="faint tnum">${p.root}\\letzai-kit.json</div></div><button class="app-btn app-btn--sm" id="revealProj">${icon('folder', 14)}<span>Show</span></button></div>
      <div class="row"><div class="grow"><b>Local cache</b><div class="faint tnum">${doctor ? doctor.dirs.cache : '…'} · safe to delete</div></div></div>
      <div class="row"><div class="grow"><b>Start from scratch</b><div class="faint">Removes your LetzAI and AI keys, settings, the list of recent films and the spending count from this computer, as on a first start. Film folders and footage are not touched.</div></div><button class="app-btn app-btn--sm app-btn--danger" id="resetAll">${icon('trash', 14)}<span>Reset…</span></button></div>
      <div class="row"><div class="grow"><b>Import from continuity-log.csv</b><div class="faint">Ratings, prints and notes from the old namer</div></div><button class="app-btn app-btn--sm" id="importLog">Import</button></div>
    </div>
    </details>

    <div class="section-label">About</div>
    <div class="surface pad about">
      <div><b>${S.info.app.name}</b> <span class="faint">version ${S.info.app.version} · MIT license</span></div>
      <div class="row wrap" style="margin-top:12px"><a class="app-btn app-btn--sm" href="https://letz.ai/docs/api" target="_blank" rel="noopener">${icon('external', 14)}<span>LetzAI API docs</span></a><a class="app-btn app-btn--sm" href="https://www.letz.ai/brandguidelines" target="_blank" rel="noopener">${icon('external', 14)}<span>Brand guidelines</span></a></div>
    </div>
  </div>`);
  root.scrollTop = sy;
}

function check(ok, title, body) {
  return html`<div class="row" style="align-items:flex-start;gap:12px"><span style="margin-top:2px;color:${ok ? 'var(--color-success)' : 'var(--text-tertiary)'}">${icon(ok ? 'checkCircle' : 'alert')}</span><div class="grow"><b>${title}</b><div class="muted">${body}</div></div></div>`;
}

export default {
  flush: false,
  mount(el) {
    root = el;
    el.addEventListener('toggle', (e) => { if (e.target.id === 'advFold') advOpen = e.target.open; }, true);
    draw();
    get('/api/doctor').then((d) => { doctor = d; draw(); }).catch(() => {});
    get('/api/proxy-status').then((r) => { proxy = r; draw(); }).catch(() => {});
    get('/api/vision').then((r) => { vis = r; visError = ''; draw(); }).catch((e) => { visError = e.message; draw(); });
    const look = () => get('/api/folders/discover').then((r) => { found = r.folders; draw(); }).catch(() => {});
    look();
    on(el, 'click', '[data-add-found]', async (e, b) => { b.disabled = true; await save({ folders: [...proj().folders, b.dataset.addFound] }); look(); });
    const pads = () => Object.fromEntries([...el.querySelectorAll('[data-pad]')].map((s) => [s.dataset.pad, +s.value]));
    el.addEventListener('change', (e) => {
      const t = e.target;
      if (t.id === 'sName') save({ name: t.value });
      else if (t.id === 'sPrefix') save({ prefix: t.value });
      else if (t.dataset.pad) save({ naming: { pad: pads() } });
      else if (t.id === 'sRich') save({ naming: { ratingInFilename: t.checked } });
      else if (t.id === 'sPrepare') save({ playback: { prepare: t.checked } });
      else if (t.id === 'sIgnore') save({ ignoreDirs: t.value.split(',') });
      else if (t.id === 'sVisModel') put('/api/vision', { model: t.value }).then((r) => { vis = r; toast('Saved.', { timeout: 1200 }); }).catch(toastError);
      else if (t.id === 'sVisConsent') put('/api/vision', { consent: t.checked }).then((r) => { vis = r; toast('Saved.', { timeout: 1200 }); }).catch(toastError);
      else if (t.id === 'sBudget' || t.id === 'sConfirm') put('/api/vision', { budget: { [t.id === 'sBudget' ? 'monthly' : 'confirmAbove']: t.value.trim() === '' ? null : t.value } }).then((r) => { vis = r; toast('Saved.', { timeout: 1200 }); draw(); }).catch(toastError);
    });
    on(el, 'click', '[data-theme-pick]', (e, b) => { setTheme(b.dataset.themePick); draw(); });
    on(el, 'click', '#addFolder', async () => { try { const r = await post('/api/pick-folder', { title: 'Add a footage folder', start: proj().root }); if (r.path) { await save({ folders: [...proj().folders, r.path] }); } } catch (e) { toastError(e); } });
    on(el, 'click', '[data-rmf]', async (e, b) => { const f = proj().folders.filter((_, i) => i !== +b.dataset.rmf); await save({ folders: f }); });
    on(el, 'click', '#rescan', async () => { try { await post('/api/rescan'); toast('Folders rescanned.', { type: 'success' }); look(); } catch (e) { toastError(e); } });
    on(el, 'click', '#prepProxies', async () => { try { const r = await post('/api/proxies', {}); toast(r.queued ? `Preparing ${plural(r.queued, 'review copy', 'review copies')}. Follow it in the queue.` : 'Nothing needs a review copy.', { type: 'success' }); } catch (e) { toastError(e); } });
    on(el, 'click', '#importLog', async () => { try { const r = await post('/api/import-log', {}); toast(`Imported ${plural(r.applied, 'take')} from ${plural(r.rows, 'log row')}.`, { type: 'success' }); } catch (e) { toastError(e); } });
    const visTest = async (body, busy) => {
      visBusy = busy; visMsg = null; draw();
      try { const r = await post('/api/vision/test', { ...body, provider: vis.provider, model: vis.model }); vis = r; visMsg = { ok: true, text: 'The key works.' }; await loadInfo(); } catch (e) { visMsg = { ok: false, text: e.message }; }
      visBusy = ''; draw();
    };
    on(el, 'click', '#visSave', () => { const k = el.querySelector('#sVisKey').value.trim(); if (k) visTest({ key: k, save: true }, 'save'); });
    on(el, 'click', '#visTest', () => visTest({}, 'test'));
    on(el, 'click', '[data-prov]', async (e, b) => { if (b.dataset.prov === vis.provider) return; try { vis = await put('/api/vision', { provider: b.dataset.prov }); visMsg = null; await loadInfo(); draw(); } catch (err) { toastError(err); } });
    on(el, 'click', '#visRemove', async () => { try { vis = await put('/api/vision', { key: '' }); visMsg = null; await loadInfo(); draw(); toast('Key removed from this computer.', { type: 'success' }); } catch (e) { toastError(e); } });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'sVisKey') el.querySelector('#visSave').click(); });
    on(el, 'click', '#renameAll', () => openRenameAll());
    on(el, 'click', '#resetAll', async () => {
      const ok = await confirmDialog({
        title: 'Start from scratch?',
        message: 'Your LetzAI key and your Claude, ChatGPT and Gemini keys are deleted from this computer, so you will need to paste them again. Settings, the list of recent films and this month’s spending count are reset too, and the setup assistant opens. Your film folders, footage, ratings and notes stay as they are.',
        confirmLabel: 'Reset everything', danger: true,
      });
      if (!ok) return;
      try {
        const r = await post('/api/reset');
        if (r.envKeys.length) await confirmDialog({ title: 'Some keys are still active', message: `These keys come from environment variables, which the kit cannot remove: ${r.envKeys.join(', ')}. Remove them from your system settings to test without them.`, confirmLabel: 'OK' });
        location.hash = '#/';
        location.reload();
      } catch (e) { toastError(e); }
    });
    on(el, 'click', '#setupAgain', () => openSetup({ onDone: () => get('/api/vision').then((r) => { vis = r; draw(); }).catch(() => {}) }));
    on(el, 'click', '#revealProj', () => post('/api/reveal', {}).catch(toastError));
  },
  update() { if (root && !(document.activeElement && /INPUT|SELECT/.test(document.activeElement.tagName))) draw(); },
  unmount() { root = null; },
};
