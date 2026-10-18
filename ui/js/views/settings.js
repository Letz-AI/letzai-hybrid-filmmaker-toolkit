// Settings: project naming, footage folders, appearance, setup check, data.
import { html, icon, mount, on, $, plural, debounce, fmtSize } from '../lib.js';
import { get, post, patch } from '../api.js';
import { S, loadInfo, clips, allClips, folders } from '../store.js';
import { toast, toastError, confirmDialog, field } from '../ui.js';
import { openRenameAll } from '../renameall.js';
import { setTheme } from '../app.js';

let root;
let doctor = null;
let found = [];
let proxy = null;

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
    <div class="page-head"><div><h1 class="page-title">Settings</h1><div class="page-sub">${p.name} · saved in <span class="tnum">${p.root}</span></div></div></div>

    <div class="section-label" style="margin-top:0">Naming</div>
    <div class="surface pad form-grid">
      ${field('Film name', html`<input class="app-input" id="sName" value="${p.name}" spellcheck="false">`)}
      ${field('File name prefix', html`<input class="app-input" id="sPrefix" value="${p.prefix}" spellcheck="false">`, html`New names look like <b style="display:inline">${p.prefix}-scene6-shot2A-take3</b>. Files you have already named keep their names.`)}
      <div class="app-field"><div class="label">Number padding</div><div class="row">${['scene', 'shot', 'take'].map((k) => html`<select class="app-input" data-pad="${k}" style="width:auto"><option value="0" ${p.naming.pad[k] === 0 ? 'selected' : ''}>${k} 6</option><option value="2" ${p.naming.pad[k] === 2 ? 'selected' : ''}>${k} 06</option><option value="3" ${p.naming.pad[k] === 3 ? 'selected' : ''}>${k} 006</option></select>`)}</div><div class="app-hint">Applies to new names only.</div></div>
      <label class="app-switch"><input type="checkbox" id="sRich" ${p.naming.ratingInFilename ? 'checked' : ''}><span>Put the rating in the file name<br><span class="faint">Adds -good / -ok / -void and -print, like older naming scripts. Off by default: ratings are kept in the project file instead, so names never change when you change your mind.</span></span></label>
      <div class="row" style="gap:12px;align-items:flex-start"><div class="grow"><b>Rename all files</b><div class="faint">Changes to the prefix, number padding or rating tags only affect new names. Apply them to every take you already named (with its cuts and camera proxy), in one step you can undo.</div></div><button class="app-btn" id="renameAll">${icon('pencil')}<span>Rename all…</span></button></div>
    </div>

    <div class="section-label">Footage</div>
    <div class="surface pad">
      <div class="folder-list">${p.folders.map((f, i) => html`<div class="row folder-row"><span class="grow tnum" title="${f}">${f}</span><button class="app-icon-btn app-icon-btn--sm" data-rmf="${i}" title="Remove this folder from the project">${icon('close', 14)}</button></div>`)}${p.folders.length ? '' : html`<div class="faint" style="padding:8px">No folders yet.</div>`}</div>
      ${found.length ? html`<div class="app-alert app-alert--warning" style="margin-top:12px">${icon('folder')}<div class="grow"><b>Footage not in the project yet</b>${found.map((f) => html`<div class="row" style="gap:8px;margin-top:6px"><span class="grow"><b style="display:inline">${f.name}</b> <span class="faint">· ${plural(f.clips, 'clip')}</span></span><button class="app-btn app-btn--sm" data-add-found="${f.path}">${icon('plus', 14)}<span>Add</span></button></div>`)}</div></div>` : ''}
      ${folders().length > 1 ? html`<div class="insp-label" style="margin-top:16px">What the project sees</div><div class="folder-tree">${folders().filter((f) => f.path !== '.').map((f) => html`<div class="row" style="padding-left:${(f.depth - 1) * 18}px">${icon('folder', 14)}<span class="grow">${f.name}</span><span class="faint tnum">${plural(f.clips, 'clip')}${f.raw ? ` · ${f.raw} unnamed` : ''}</span></div>`)}</div>` : ''}
      <div class="row" style="margin-top:10px"><button class="app-btn app-btn--sm" id="addFolder">${icon('plus', 14)}<span>Add a folder</span></button><button class="app-btn app-btn--sm" id="rescan">${icon('regenerate', 14)}<span>Rescan</span></button></div>
      <div class="app-field" style="margin-top:16px"><label for="sIgnore">Skip folders named</label><input class="app-input" id="sIgnore" value="${p.ignoreDirs.join(', ')}" spellcheck="false"><div class="app-hint">Comma separated. Subfolders up to three levels deep are scanned. Your own <b style="display:inline">Proxy</b> folders are used for playback, not listed as clips.</div></div>
    </div>

    <div class="section-label">Playback</div>
    <div class="surface pad form-grid">
      <label class="app-switch"><input type="checkbox" id="sPrepare" ${p.playback && p.playback.prepare === false ? '' : 'checked'}><span>Prepare playback copies in the background<br><span class="faint">Camera files are 4K HEVC, which most browsers can’t play directly. The kit makes a small copy of each one, unnamed clips first, so they open instantly. Uses the graphics card when it can. ${proxy ? (proxy.left ? `${proxy.left} clips (${proxy.minutes} min of footage) still to prepare, about ${proxy.etaMinutes} min${proxy.measured ? '' : ' (a guess until the first one is done)'}.` : 'Everything is ready.') : ''}</span></span></label>
    </div>

    <div class="section-label">Appearance</div>
    <div class="surface pad"><div class="app-segmented" role="radiogroup">${[['dark', 'Dark', 'moon'], ['light', 'Light', 'sun'], ['system', 'Match system', 'settings']].map(([id, l, ic]) => html`<button role="radio" aria-checked="${theme() === id}" data-theme-pick="${id}">${icon(ic, 14)}${l}</button>`)}</div></div>

    <div class="section-label">Setup check</div>
    <div class="surface pad setup-list">
      ${check(S.info.ffmpeg.ok, 'ffmpeg', S.info.ffmpeg.ok ? html`Version ${S.info.ffmpeg.version}<br><span class="faint tnum">${S.info.ffmpeg.path}</span>` : 'Not found. Install it (see the welcome page) and restart the kit.')}
      ${check(!!doctor, 'Video encoder', doctor ? (doctor.encoder === 'libx264' ? 'Processor (x264). Cutting 4K will be slow; a graphics card encoder is used automatically when one works.' : `Graphics card: ${doctor.encoder}. Fast cuts and proxies.`) : html`<span class="row"><span class="spinner"></span> Testing…</span>`)}
      ${check(S.hevc, 'HEVC playback in this window', S.hevc ? 'Camera files play directly.' : 'This browser cannot decode HEVC, so the kit makes small H.264 copies. On Windows, the “HEVC Video Extensions” add-on from the Microsoft Store lets Edge play camera files directly.')}
      ${check(S.info.key.set, 'LetzAI API key', S.info.key.set ? 'Saved on this computer.' : html`Optional. Add it in <a href="#/canvas">Canvas</a>.`)}
      <div class="row" style="margin-top:6px"><button class="app-btn app-btn--sm" id="prepProxies" title="Make review copies now instead of when you open each clip">${icon('layers', 14)}<span>Prepare review copies for ${needProxy ? plural(needProxy, 'clip') : 'all clips'}</span></button></div>
    </div>

    <div class="section-label">Data</div>
    <div class="surface pad data-list">
      <div class="row"><div class="grow"><b>Import ratings from the old namer</b><div class="faint">Reads continuity-log.csv in the film folder: ratings, print flags and notes.</div></div><button class="app-btn app-btn--sm" id="importLog">Import</button></div>
      <div class="row"><div class="grow"><b>Project file</b><div class="faint tnum">${p.root}\\letzai-kit.json · ratings, notes, cuts, shot list. Safe to sync or commit.</div></div><button class="app-btn app-btn--sm" id="revealProj">${icon('folder', 14)}<span>Show</span></button></div>
      <div class="row"><div class="grow"><b>Local cache</b><div class="faint tnum">${doctor ? doctor.dirs.cache : '…'} · review copies and thumbnails. Safe to delete.</div></div></div>
      <div class="row"><div class="grow"><b>Rename history</b><div class="faint">${plural(p.history, 'rename')} can be undone from Ingest.</div></div></div>
    </div>

    <div class="section-label">About</div>
    <div class="surface pad about">
      <div><b>${S.info.app.name}</b> <span class="faint">version ${S.info.app.version}</span></div>
      <div class="muted" style="margin-top:6px">Open source under the MIT license. It runs on your computer; nothing leaves it except what you send to your LetzAI canvas.</div>
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
    draw();
    get('/api/doctor').then((d) => { doctor = d; draw(); }).catch(() => {});
    get('/api/proxy-status').then((r) => { proxy = r; draw(); }).catch(() => {});
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
    });
    on(el, 'click', '[data-theme-pick]', (e, b) => { setTheme(b.dataset.themePick); draw(); });
    on(el, 'click', '#addFolder', async () => { try { const r = await post('/api/pick-folder', { title: 'Add a footage folder', start: proj().root }); if (r.path) { await save({ folders: [...proj().folders, r.path] }); } } catch (e) { toastError(e); } });
    on(el, 'click', '[data-rmf]', async (e, b) => { const f = proj().folders.filter((_, i) => i !== +b.dataset.rmf); await save({ folders: f }); });
    on(el, 'click', '#rescan', async () => { try { await post('/api/rescan'); toast('Folders rescanned.', { type: 'success' }); look(); } catch (e) { toastError(e); } });
    on(el, 'click', '#prepProxies', async () => { try { const r = await post('/api/proxies', {}); toast(r.queued ? `Preparing ${plural(r.queued, 'review copy', 'review copies')}. Follow it in the queue.` : 'Nothing needs a review copy.', { type: 'success' }); } catch (e) { toastError(e); } });
    on(el, 'click', '#importLog', async () => { try { const r = await post('/api/import-log', {}); toast(`Imported ${plural(r.applied, 'take')} from ${plural(r.rows, 'log row')}.`, { type: 'success' }); } catch (e) { toastError(e); } });
    on(el, 'click', '#renameAll', () => openRenameAll());
    on(el, 'click', '#revealProj', () => post('/api/reveal', {}).catch(toastError));
  },
  update() { if (root && !(document.activeElement && /INPUT|SELECT/.test(document.activeElement.tagName))) draw(); },
  unmount() { root = null; },
};
