// Settings, in two groups: "This film" (name and naming, footage folders, playback; needs an open film) and "Kit"
// (works without a film). Each feature owns its key: the LetzAI key is on the LetzAI page, the AI key on the AI slate
// reading page. Each item is its own page: #/settings/<section>.
import { html, icon, mount, on, plural, debounce, feedbackHref, FEEDBACK_EMAIL } from '../lib.js';
import { get, post, put, patch } from '../api.js';
import { providerPicker, currentProvider, money } from '../slate.js';
import { openSetup } from '../setup.js';
import { S, loadInfo, clips, folders } from '../store.js';
import { toast, toastError, confirmDialog, field } from '../ui.js';
import { openRenameAll } from '../renameall.js';
import { setTheme, shortcutList } from '../app.js';

const SECTIONS = [
  { id: 'film', group: 'film', label: 'Film', icon: 'review', title: 'Film', sub: 'Name, file names and the project file.' },
  { id: 'footage', group: 'film', label: 'Footage', icon: 'folder', title: 'Footage', sub: 'The folders the kit looks at for this film.' },
  { id: 'playback', group: 'film', label: 'Playback', icon: 'play', title: 'Playback', sub: 'Playable copies of camera files your browser cannot show.' },
  { id: 'letzai', group: 'kit', label: 'LetzAI', icon: 'canvas', title: 'LetzAI', sub: 'Your LetzAI API key, for sending takes to a LetzAI Canvas. Stored only on this computer.' },
  { id: 'ai', group: 'kit', label: 'AI slate reading', icon: 'bolt', title: 'AI slate reading', sub: 'An AI reads the slate on each clip and suggests its name, with your own API key.' },
  { id: 'appearance', group: 'kit', label: 'Appearance', icon: 'sun', title: 'Appearance', sub: '' },
  { id: 'keyboard', group: 'kit', label: 'Keyboard shortcuts', icon: 'keyboard', title: 'Keyboard shortcuts', sub: 'Press ? anywhere to see this list. On a Mac, use Cmd instead of Ctrl.' },
  { id: 'about', group: 'kit', label: 'About and system', icon: 'info', title: 'About and system', sub: '' },
  { id: 'reset', group: 'kit', label: 'Setup and reset', icon: 'regenerate', title: 'Setup and reset', sub: '' },
];
const ALIASES = { account: 'letzai', system: 'about' };   // older links
const LETZAI_KEYS = 'https://letz.ai/subscription';

let root;
let section = '';
let doctor = null;
let found = [];
let proxy = null;
let vis = null;     // AI slate reading settings from the server (provider, model, consent, budget, which keys are saved)
let visBusy = '';
let visMsg = null;  // { ok, text }
let visError = ''; // why those settings could not be loaded
let lzBusy = false;
let lzMsg = null;   // { ok, text } after saving the LetzAI key
let lzEditing = false;

const proj = () => S.info.project;
const theme = () => { try { return localStorage.getItem('theme') || 'dark'; } catch { return 'dark'; } };
// a film section asked for without an open film shows the account page
const current = () => {
  const id = ALIASES[section] || section;
  const s = SECTIONS.find((x) => x.id === id) || SECTIONS.find((x) => x.id === (proj() ? 'film' : 'letzai'));
  return s.group === 'film' && !proj() ? SECTIONS.find((x) => x.id === 'letzai') : s;
};

const saved = debounce(() => toast('Saved.', { timeout: 1200 }), 500);
async function save(body) {
  try { await patch('/api/project', body); await loadInfo(); saved(); } catch (e) { toastError(e); }
}

const card = (label, body, cls = 'form-grid') => html`${label ? html`<div class="section-label">${label}</div>` : ''}<div class="surface pad ${cls}">${body}</div>`;
const alertMsg = (m) => (m ? html`<div class="app-alert app-alert--${m.ok ? 'success' : 'error'}" style="margin-top:8px">${icon(m.ok ? 'checkCircle' : 'alert')}<div class="grow">${m.text}</div></div>` : '');
const savedChip = (env) => html`<span class="app-chip app-chip--success">${icon('checkCircle', 14)}Saved${env ? ` (${env})` : ''}</span>`;
function check(ok, title, body) {
  return html`<div class="row" style="align-items:flex-start;gap:12px"><span style="margin-top:2px;color:${ok ? 'var(--color-success)' : 'var(--text-tertiary)'}">${icon(ok ? 'checkCircle' : 'alert')}</span><div class="grow"><b>${title}</b><div class="muted">${body}</div></div></div>`;
}

// ---- This film ------------------------------------------------------------------------------------------------
function filmPage(p) {
  return html`
    ${card('', html`
      ${field('Film name', html`<input class="app-input" id="sName" value="${p.name}" spellcheck="false">`)}
      ${field('File name prefix', html`<input class="app-input" id="sPrefix" value="${p.prefix}" spellcheck="false">`, html`New names: <b style="display:inline">${p.prefix}-scene6-shot2A-take3</b>`)}`)}
    ${card('File names', html`
      <div class="app-field"><div class="label">Numbers</div><div class="row">${['scene', 'shot', 'take'].map((k) => html`<select class="app-input" data-pad="${k}" style="width:auto"><option value="0" ${p.naming.pad[k] === 0 ? 'selected' : ''}>${k} 6</option><option value="2" ${p.naming.pad[k] === 2 ? 'selected' : ''}>${k} 06</option><option value="3" ${p.naming.pad[k] === 3 ? 'selected' : ''}>${k} 006</option></select>`)}</div></div>
      <label class="app-switch" title="Adds -good / -ok / -void and -print. Off: ratings stay in the project file, so names never change."><input type="checkbox" id="sRich" ${p.naming.ratingInFilename ? 'checked' : ''}><span>Put the rating in the file name</span></label>
      <div class="row" style="gap:12px"><div class="grow"><b>Rename all files</b><div class="faint">Apply the prefix, numbers and rating setting to every take you have named. Can be undone.</div></div><button class="app-btn" id="renameAll">${icon('pencil')}<span>Rename all…</span></button></div>`)}
    ${card('Project file', html`
      <div class="row"><div class="grow"><b>letzai-kit.json</b><div class="faint tnum">${p.root}</div><div class="faint">Ratings, notes, cuts, shot list and readings for this film. Safe to sync or back up.</div></div><button class="app-btn app-btn--sm" id="revealProj">${icon('folder', 14)}<span>Show</span></button></div>
      <div class="row"><div class="grow"><b>Import from continuity-log.csv</b><div class="faint">Ratings, prints and notes from an older naming script</div></div><button class="app-btn app-btn--sm" id="importLog">Import</button></div>`, 'data-list')}`;
}

function footagePage(p) {
  return html`
    ${card('', html`
      <div class="folder-list">${p.folders.map((f, i) => html`<div class="row folder-row"><span class="grow tnum" title="${f}">${f}</span><button class="app-icon-btn app-icon-btn--sm" data-rmf="${i}" title="Remove this folder from the project">${icon('close', 14)}</button></div>`)}${p.folders.length ? '' : html`<div class="faint" style="padding:8px">No folders yet.</div>`}</div>
      ${found.length ? html`<div class="app-alert app-alert--warning">${icon('folder')}<div class="grow"><b>New footage found</b>${found.map((f) => html`<div class="row" style="gap:8px;margin-top:6px"><span class="grow"><b style="display:inline">${f.name}</b> <span class="faint">· ${plural(f.clips, 'clip')}</span></span><button class="app-btn app-btn--sm" data-add-found="${f.path}">${icon('plus', 14)}<span>Add</span></button></div>`)}</div></div>` : ''}
      <div class="row"><button class="app-btn app-btn--sm" id="addFolder">${icon('plus', 14)}<span>Add a folder</span></button><button class="app-btn app-btn--sm" id="rescan">${icon('regenerate', 14)}<span>Rescan</span></button></div>
      <div class="app-hint">Subfolders are included.</div>`)}
    ${card('Skip', html`<div class="app-field"><label for="sIgnore">Skip folders named</label><input class="app-input" id="sIgnore" value="${p.ignoreDirs.join(', ')}" spellcheck="false"><div class="app-hint">Comma separated, for example: cuts, Proxy, Renders</div></div>`)}
    ${folders().length > 1 ? card('Folders the project sees', html`<div class="folder-tree">${folders().filter((f) => f.path !== '.').map((f) => html`<div class="row" style="padding-left:${(f.depth - 1) * 18}px">${icon('folder', 14)}<span class="grow">${f.name}</span><span class="faint tnum">${plural(f.clips, 'clip')}${f.raw ? ` · ${f.raw} unnamed` : ''}</span></div>`)}</div>`, '') : ''}`;
}

function playbackPage(p) {
  const needProxy = clips().filter((c) => c.probe && !(c.probe.codec === 'h264' && c.size < 4e9) && !c.hasCamProxy).length;
  return html`
    ${card('', html`
      <label class="app-switch" title="Camera files (4K HEVC) don’t play in most browsers, so the kit makes small playable copies."><input type="checkbox" id="sPrepare" ${p.playback && p.playback.prepare === false ? '' : 'checked'}><span>Prepare playable copies in the background${proxy ? html`<br><span class="faint">${proxy.left ? `${plural(proxy.left, 'clip')} left, about ${proxy.etaMinutes} min` : 'All ready'}</span>` : ''}</span></label>
      <div class="row"><button class="app-btn app-btn--sm" id="prepProxies">${icon('layers', 14)}<span>Prepare ${needProxy ? plural(needProxy, 'clip') : 'all clips'} now</span></button></div>`)}
    ${card('This browser', check(S.hevc, 'HEVC playback', S.hevc ? 'Camera files play directly, no copies needed.' : html`Not in this browser, so playable copies are made. <span class="faint">On Windows the “HEVC Video Extensions” from the Microsoft Store fix this.</span>`), 'setup-list')}`;
}

// ---- Kit --------------------------------------------------------------------------------------------------------
function letzaiPage() {
  const k = S.info.key;
  return html`
    ${card('', html`
      <div class="app-field"><label for="sLzKey">LetzAI API key</label>
        ${k.set && !lzEditing ? html`<div class="row" style="gap:8px">${savedChip(k.source === 'environment' ? 'LETZAI_API_KEY' : '')}<span class="grow"></span>${k.source === 'file' ? html`<button class="app-btn app-btn--sm" id="lzReplace">Replace</button><button class="app-btn app-btn--sm" id="lzRemove">${icon('trash', 14)}<span>Remove key</span></button>` : ''}</div>`
          : html`<div class="row" style="gap:8px"><input class="app-input" id="sLzKey" type="password" placeholder="Paste your key" autocomplete="off" spellcheck="false"><button class="app-btn app-btn--primary" id="lzSave" style="flex:none">${lzBusy ? 'Checking…' : 'Save'}</button>${lzEditing ? html`<button class="app-btn" id="lzCancel" style="flex:none">Cancel</button>` : ''}</div>
            <div class="app-hint">Get your key at <a href="${LETZAI_KEYS}" target="_blank" rel="noopener">letz.ai/subscription</a>. Needed to send takes to a LetzAI Canvas.</div>`}
        ${alertMsg(lzMsg)}</div>`)}`;
}

function resetPage() {
  return html`
    ${card('', html`<div class="row" style="gap:12px"><div class="grow"><b>Setup assistant</b><div class="faint">The short walk-through from the first start: the LetzAI key and an AI key, step by step.</div></div><button class="app-btn app-btn--sm" id="setupAgain">${icon('key', 14)}<span>Open</span></button></div>`)}
    <div class="section-label">Start from scratch</div>
    <div class="surface pad danger-card"><div class="row" style="gap:12px;align-items:flex-start"><div class="grow"><b>Reset the kit on this computer</b><div class="faint">Removes your LetzAI and AI keys, your settings, the list of recent films and the spending count, as on a first start. Film folders, footage, ratings and notes are not touched.</div></div><button class="app-btn app-btn--sm app-btn--danger" id="resetAll">${icon('trash', 14)}<span>Reset…</span></button></div></div>`;
}

function aiPage() {
  if (visError) return card('', html`<div class="app-alert app-alert--error">${icon('alert')}<div class="grow"><b>Couldn’t load the AI settings</b>${visError}</div></div>`);
  if (!vis) return card('', html`<span class="row"><span class="spinner"></span> Loading…</span>`);
  const pv = currentProvider(vis);
  return html`
    ${card('', html`
      ${field('AI', providerPicker(vis))}
      <div class="app-field"><label for="sVisKey">${vis.company} API key</label>
        ${vis.key.set ? html`<div class="row" style="gap:8px">${savedChip(vis.key.source === 'environment' ? pv.env : '')}<span class="grow"></span>${vis.key.source === 'file' ? html`<button class="app-btn app-btn--sm" id="visRemove">${icon('trash', 14)}<span>Remove key</span></button>` : ''}<button class="app-btn app-btn--sm" id="visTest">${visBusy === 'test' ? 'Testing…' : 'Test it'}</button></div>`
          : html`<div class="row" style="gap:8px"><input class="app-input" id="sVisKey" type="password" placeholder="${pv.keyHint}" autocomplete="off" spellcheck="false"><button class="app-btn app-btn--primary" id="visSave" style="flex:none">${visBusy === 'save' ? 'Testing…' : 'Save and test'}</button></div>
            <div class="app-hint">Get one in the <a href="${pv.keyUrl}" target="_blank" rel="noopener">${pv.keyPage}</a>. Most accounts need some prepaid credit.</div>`}
        ${alertMsg(visMsg)}</div>
      ${field('Model', html`<select class="app-input" id="sVisModel">${vis.models.map((m) => html`<option value="${m.id}" ${m.id === vis.model ? 'selected' : ''}>${m.label}</option>`)}</select>`, (vis.models.find((m) => m.id === vis.model) || {}).note || '')}
      <label class="app-switch" title="A few frames from the start of each clip you ask the AI to read. File names are not sent. You see the price of each run first."><input type="checkbox" id="sVisConsent" ${vis.consent ? 'checked' : ''}><span>Allow sending frames to ${vis.company}</span></label>`)}
    ${card('Spending and budget', html`
      <div class="muted">This month: about <b style="display:inline">${money(vis.budget.spent)}</b>${vis.budget.monthly != null ? ` of your ${money(vis.budget.monthly)} budget` : ''}. <span class="faint">Estimated from what the AI reports.</span></div>
      <div class="row wrap" style="gap:16px;align-items:flex-start">
        ${field('Monthly budget (US$)', html`<input class="app-input" id="sBudget" type="number" min="0" step="1" inputmode="decimal" placeholder="No limit" value="${vis.budget.monthly ?? ''}" style="width:160px">`, 'Reading stops when it is used up.')}
        ${field('Ask before a run over (US$)', html`<input class="app-input" id="sConfirm" type="number" min="0" step="1" inputmode="decimal" placeholder="Never ask" value="${vis.budget.confirmAbove ?? ''}" style="width:160px">`, 'Large runs need a second yes.')}
      </div>
      <div class="app-hint">These are estimates. For a hard limit, also set one in your <a href="${pv.limitsUrl}" target="_blank" rel="noopener">${vis.company} account</a>.</div>`)}`;
}

function appearancePage() {
  return card('', html`<div class="app-field"><div class="label">Theme</div><div class="app-segmented" role="radiogroup" style="width:max-content">${[['dark', 'Dark', 'moon'], ['light', 'Light', 'sun'], ['system', 'Match system', 'settings']].map(([id, l, ic]) => html`<button role="radio" aria-checked="${theme() === id}" data-theme-pick="${id}">${icon(ic, 14)}${l}</button>`)}</div></div>`);
}

function aboutPage() {
  return html`
    ${card('', html`<div><b>${S.info.app.name}</b> <span class="beta-badge">Beta</span> <span class="faint">version ${S.info.app.version} · MIT license</span></div>
      <div class="muted">A work in progress. Feedback? Send it to <a href="${feedbackHref(S.info.app.version)}">${FEEDBACK_EMAIL}</a>.</div>
      <div class="row wrap"><a class="app-btn app-btn--sm" href="https://letz.ai/docs/api" target="_blank" rel="noopener">${icon('external', 14)}<span>LetzAI API docs</span></a><a class="app-btn app-btn--sm" href="https://www.letz.ai/brandguidelines" target="_blank" rel="noopener">${icon('external', 14)}<span>Brand guidelines</span></a><a class="app-btn app-btn--sm" href="https://github.com/Letz-AI/letzai-hybrid-filmmaker-toolkit" target="_blank" rel="noopener">${icon('external', 14)}<span>Source code</span></a></div>`)}
    ${card('This computer', html`
      ${check(S.info.ffmpeg.ok, 'ffmpeg', S.info.ffmpeg.ok ? html`${S.info.ffmpeg.version}<br><span class="faint tnum">${S.info.ffmpeg.path}</span>` : 'Not found. Install it and restart the kit.')}
      ${check(!!(doctor && doctor.encoder), 'Video encoder', doctor ? (!doctor.encoder ? 'None found.' : doctor.encoder === 'libx264' ? 'Processor (x264). Cutting 4K is slow.' : `Graphics card (${doctor.encoder})`) : html`<span class="row"><span class="spinner"></span> Testing…</span>`)}
      ${check(S.hevc, 'HEVC playback', S.hevc ? 'Camera files play directly.' : 'Not in this browser, so playable copies are made.')}`, 'setup-list')}
    ${card('Folders', html`
      <div class="row"><div class="grow"><b>Settings and keys</b><div class="faint tnum">${doctor ? doctor.dirs.config : '…'}</div></div></div>
      <div class="row"><div class="grow"><b>Cache</b><div class="faint tnum">${doctor ? doctor.dirs.cache : '…'}</div><div class="faint">Playable copies and thumbnails. Safe to delete; they are made again when needed.</div></div></div>`, 'data-list')}`;
}

const PAGES = { film: filmPage, footage: footagePage, playback: playbackPage, letzai: letzaiPage, ai: aiPage, appearance: appearancePage, keyboard: () => shortcutList(), about: aboutPage, reset: resetPage };

function draw() {
  if (!root || !S.info) return;
  const p = proj();
  const cur = current();
  const sy = root.scrollTop;
  const item = (s) => (s.group === 'film' && !p
    ? html`<span class="rail-item" aria-disabled="true">${icon(s.icon)}<span>${s.label}</span></span>`
    : html`<a class="rail-item" href="#/settings/${s.id}" aria-current="${s.id === cur.id ? 'page' : 'false'}">${icon(s.icon)}<span>${s.label}</span></a>`);
  mount(root, html`<div class="page default">
    <div class="page-head"><div class="grow"><h1 class="page-title">Settings</h1></div>${p ? '' : html`<a class="app-btn app-btn--sm" href="#/board">${icon('arrowLeft', 14)}<span>Back</span></a>`}</div>
    <div class="settings-layout">
      <nav class="settings-nav" aria-label="Settings">
        <div class="rail-label">This film</div>
        ${p ? html`<div class="settings-nav-note" title="${p.root}">${p.name}</div>` : html`<div class="settings-nav-note">Open a film to change these.</div>`}
        ${SECTIONS.filter((s) => s.group === 'film').map(item)}
        <div class="rail-label">Kit</div>
        ${SECTIONS.filter((s) => s.group === 'kit').map(item)}
      </nav>
      <section class="settings-body">
        <h2 class="settings-title">${cur.title}</h2>${cur.sub ? html`<p class="muted settings-sub">${cur.sub}</p>` : ''}
        ${PAGES[cur.id](p)}
      </section>
    </div>
  </div>`);
  root.scrollTop = sy;
}

function load() {
  get('/api/doctor').then((d) => { doctor = d; draw(); }).catch(() => {});
  get('/api/vision').then((r) => { vis = r; visError = ''; draw(); }).catch((e) => { visError = e.message; draw(); });
  if (proj()) {
    get('/api/proxy-status').then((r) => { proxy = r; draw(); }).catch(() => {});
    get('/api/folders/discover').then((r) => { found = r.folders; draw(); }).catch(() => {});
  }
}

export default {
  flush: false,
  mount(el, args = []) {
    root = el;
    section = args[0] || '';
    draw();
    load();
    const look = () => get('/api/folders/discover').then((r) => { found = r.folders; draw(); }).catch(() => {});
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
      else if (t.id === 'sVisModel') put('/api/vision', { model: t.value }).then((r) => { vis = r; toast('Saved.', { timeout: 1200 }); draw(); }).catch(toastError);
      else if (t.id === 'sVisConsent') put('/api/vision', { consent: t.checked }).then((r) => { vis = r; toast('Saved.', { timeout: 1200 }); }).catch(toastError);
      else if (t.id === 'sBudget' || t.id === 'sConfirm') put('/api/vision', { budget: { [t.id === 'sBudget' ? 'monthly' : 'confirmAbove']: t.value.trim() === '' ? null : t.value } }).then((r) => { vis = r; toast('Saved.', { timeout: 1200 }); draw(); }).catch(toastError);
    });
    on(el, 'click', '[data-theme-pick]', (e, b) => { setTheme(b.dataset.themePick); draw(); });
    on(el, 'click', '#addFolder', async () => { try { const r = await post('/api/pick-folder', { title: 'Add a footage folder', start: proj().root }); if (r.path) { await save({ folders: [...proj().folders, r.path] }); } } catch (e) { toastError(e); } });
    on(el, 'click', '[data-rmf]', async (e, b) => { const f = proj().folders.filter((_, i) => i !== +b.dataset.rmf); await save({ folders: f }); });
    on(el, 'click', '#rescan', async () => { try { await post('/api/rescan'); toast('Folders rescanned.', { type: 'success' }); look(); } catch (e) { toastError(e); } });
    on(el, 'click', '#prepProxies', async () => { try { const r = await post('/api/proxies', {}); toast(r.queued ? `Preparing ${plural(r.queued, 'review copy', 'review copies')}. Follow it in the queue.` : 'Nothing needs a review copy.', { type: 'success' }); } catch (e) { toastError(e); } });
    on(el, 'click', '#importLog', async () => { try { const r = await post('/api/import-log', {}); toast(`Imported ${plural(r.applied, 'take')} from ${plural(r.rows, 'log row')}.`, { type: 'success' }); } catch (e) { toastError(e); } });
    on(el, 'click', '#renameAll', () => openRenameAll());
    on(el, 'click', '#revealProj', () => post('/api/reveal', {}).catch(toastError));

    // LetzAI key: saved, then checked by listing the canvases it can see (a refused key is removed again)
    const lzSave = async () => {
      const k = el.querySelector('#sLzKey').value.trim();
      if (!k) return;
      lzBusy = true; lzMsg = null; draw();
      try {
        await put('/api/key', { key: k });
        try { await get('/api/canvas/list'); lzMsg = { ok: true, text: 'The key works.' }; } catch (e) {
          if (e.status === 401 || e.status === 403) { await put('/api/key', { key: '' }); lzMsg = { ok: false, text: 'LetzAI did not accept this key. Check that it was copied completely.' }; } else lzMsg = { ok: true, text: `Saved. LetzAI could not be reached to check it (${e.message}).` };
        }
        await loadInfo();
      } catch (e) { lzMsg = { ok: false, text: e.message }; }
      lzBusy = false; lzEditing = false; draw();
    };
    on(el, 'click', '#lzSave', lzSave);
    on(el, 'click', '#lzReplace', () => { lzEditing = true; lzMsg = null; draw(); });
    on(el, 'click', '#lzCancel', () => { lzEditing = false; draw(); });
    on(el, 'click', '#lzRemove', async () => {
      if (!(await confirmDialog({ title: 'Remove the LetzAI key?', message: 'The key is deleted from this computer. Sending to a canvas is unavailable until you add it again.', confirmLabel: 'Remove', danger: true }))) return;
      try { await put('/api/key', { key: '' }); lzMsg = null; await loadInfo(); draw(); } catch (e) { toastError(e); }
    });

    // AI key, provider, model
    const visTest = async (body, busy) => {
      visBusy = busy; visMsg = null; draw();
      try { const r = await post('/api/vision/test', { ...body, provider: vis.provider, model: vis.model }); vis = r; visMsg = { ok: true, text: 'The key works.' }; await loadInfo(); } catch (e) { visMsg = { ok: false, text: e.message }; }
      visBusy = ''; draw();
    };
    on(el, 'click', '#visSave', () => { const k = el.querySelector('#sVisKey').value.trim(); if (k) visTest({ key: k, save: true }, 'save'); });
    on(el, 'click', '#visTest', () => visTest({}, 'test'));
    on(el, 'click', '[data-prov]', async (e, b) => { if (b.dataset.prov === vis.provider) return; try { vis = await put('/api/vision', { provider: b.dataset.prov }); visMsg = null; await loadInfo(); draw(); } catch (err) { toastError(err); } });
    on(el, 'click', '#visRemove', async () => { try { vis = await put('/api/vision', { key: '' }); visMsg = null; await loadInfo(); draw(); toast('Key removed from this computer.', { type: 'success' }); } catch (e) { toastError(e); } });
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (e.target.id === 'sVisKey') el.querySelector('#visSave').click();
      if (e.target.id === 'sLzKey') lzSave();
    });

    on(el, 'click', '#setupAgain', () => openSetup({ onDone: () => get('/api/vision').then((r) => { vis = r; draw(); }).catch(() => {}) }));
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
  },
  onArgs(args) { section = args[0] || ''; lzMsg = null; visMsg = null; if (root) { root.scrollTop = 0; draw(); } },
  update() { if (root && !(document.activeElement && /INPUT|SELECT/.test(document.activeElement.tagName))) draw(); },
  unmount() { root = null; },
};
