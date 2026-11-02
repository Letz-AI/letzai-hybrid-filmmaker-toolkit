// Boot, shell, routing, live events, shortcuts.
import { html, icon, mount, on, $, $$, plural } from './lib.js';
import { get, post, patch } from './api.js';
import { S, subscribe, subscribeJobs, emit, emitJobs, loadInfo, loadLibrary, upsertJob, unnamed, allClips, runningJobs, failedSends, proxyLeft } from './store.js';
import { toast, toastError, openMenu, closeTopLayer, hasLayer, openPopup } from './ui.js';
import { openPalette } from './palette.js';
import { openQueue } from './queue.js';
import { openRenameAll } from './renameall.js';

import welcome from './views/welcome.js';
import board from './views/board.js';
import review from './views/review.js';
import compare from './views/compare.js';
import ingest from './views/ingest.js';
import canvasView from './views/canvas.js';
import settings from './views/settings.js';

const VIEWS = { board, review, compare, ingest, canvas: canvasView, settings };
const NAV = [
  { id: 'board', label: 'Dashboard', icon: 'board', hint: 'What is shot, what is missing' },
  { id: 'review', label: 'Review', icon: 'review', hint: 'Watch takes, rate, circle, cut' },
  { id: 'compare', label: 'Compare', icon: 'compare', hint: 'Original next to the AI version' },
  { id: 'ingest', label: 'Ingest', icon: 'slate', hint: 'Name raw clips from the slate' },
  { id: 'canvas', label: 'Canvas', icon: 'canvas', hint: 'Send takes to LetzAI Canvas' },
  { id: 'settings', label: 'Settings', icon: 'settings', hint: 'Project, folders, setup' },
];

const $app = $('#app');
const $top = $('#topbar');
const $rail = $('#rail');
const $main = $('#main');

let current = { view: null, key: '' };

// ---- theme ----------------------------------------------------------------------
export function setTheme(t) {
  try { localStorage.setItem('theme', t); } catch { /* private mode */ }
  document.documentElement.setAttribute('data-theme', t === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : t);
  renderTop();
}
const theme = () => document.documentElement.getAttribute('data-theme');

// ---- routing ---------------------------------------------------------------------
export function go(view, ...args) {
  location.hash = `#/${view}${args.length ? `/${args.map((a) => encodeURIComponent(a)).join('/')}` : ''}`;
}
window.kitGo = go;

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const view = VIEWS[parts[0]] ? parts[0] : 'board';
  return { view, args: parts.slice(1) };
}

function route() {
  S.route = parseHash();
  show();
}

function show() {
  const hasProject = !!(S.info && S.info.project);
  $app.classList.toggle('no-project', !hasProject);
  const next = hasProject ? VIEWS[S.route.view] : welcome;
  const viewSig = hasProject ? S.route.view : 'welcome';
  const argsSig = S.route.args.join('/');
  $main.classList.toggle('flush', !!next.flush);
  if (current.mod === next && current.view === viewSig) {
    // Same view. A view that handles its own argument changes (Review keeps its player) is told, others just refresh.
    if (current.args !== argsSig && next.onArgs) { current.args = argsSig; next.onArgs(S.route.args); return; }
    if (current.args === argsSig) { if (next.update) next.update(); return; }
  }
  if (current.mod && current.mod.unmount) current.mod.unmount();
  // A new container per visit: handlers a view attaches to it go away with it. (They used to be attached to one shared
  // element and multiplied every time a view was opened again.)
  const host = document.createElement('div');
  host.className = `view-host${next.flush ? ' flush' : ''}`;
  $main.replaceChildren(host);
  current = { mod: next, view: viewSig, args: argsSig };
  next.mount(host, S.route.args);
  $main.focus({ preventScroll: true });
}

// ---- chrome ------------------------------------------------------------------------
function renderTop() {
  const p = S.info && S.info.project;
  const jobs = runningJobs();
  const failed = S.jobs.filter((j) => j.state === 'error' && Date.now() - (j.finishedAt || 0) < 3600e3).length;
  mount($top, html`
    <div class="brand"><img class="brand-l brand-l--light" src="/img/letzai-l.png" alt="LetzAI"><img class="brand-l brand-l--dark" src="/img/letzai-l-inverted.png" alt="LetzAI"><span>LetzAI</span><span class="brand-sub">Hybrid Filmmaker Kit</span></div>
    ${p ? html`<button class="app-btn" id="projectMenu" title="Project">${icon('folder')}<span>${p.name}</span>${icon('chevronDown', 12)}</button>` : ''}
    <div class="top-spacer"></div>
    ${p ? html`<button class="app-btn app-btn--outline" id="paletteBtn" title="Jump to any shot or action">${icon('search')}<span class="muted">Jump to…</span><span class="kbd">Ctrl K</span></button>` : ''}
    ${p && proxyLeft() ? html`<button class="app-btn app-btn--sm" id="proxyChip" title="Getting clips ready so they open instantly. Click for details, to pause or to resume.">${S.proxy.prepare ? html`<span class="spinner"></span>` : icon('pause', 14)} <span>${S.proxy.prepare ? `Preparing playback · ${S.proxy.left} left · about ${S.proxy.etaMinutes < 90 ? `${S.proxy.etaMinutes} min` : `${Math.round(S.proxy.etaMinutes / 60)} h`}` : `Playback preparation paused · ${S.proxy.left} left`}</span></button>` : ''}
    ${p && failedSends().length ? html`<a class="app-btn app-btn--sm app-chip--error" href="#/canvas" title="These takes did not reach the canvas. Open Canvas to see why and retry.">${icon('alert', 14)}<span>${failedSends().length} upload${failedSends().length === 1 ? '' : 's'} failed</span></a>` : ''}
    ${p ? html`<button class="app-btn ${jobs.length ? '' : 'faint'}" id="queueBtn" title="Background jobs">${jobs.length ? html`<span class="spinner"></span>` : icon('layers')}<span>${jobs.length ? plural(jobs.length, 'job') : failed ? html`${failed} failed` : 'Queue'}</span></button>` : ''}
    <button class="app-icon-btn" id="themeBtn" title="Switch to ${theme() === 'dark' ? 'light' : 'dark'} theme" aria-label="Switch theme">${icon(theme() === 'dark' ? 'sun' : 'moon')}</button>
    <button class="app-icon-btn" id="helpBtn" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">${icon('keyboard')}</button>`);
}

function renderRail() {
  const hasProject = !!(S.info && S.info.project);
  if (!hasProject) { mount($rail, ''); return; }
  const raw = allClips().filter((c) => c.kind === 'raw' && !c.skip).length; // whole film, whatever the folder filter says
  const t = S.snap && S.snap.coverage.totals;
  const counts = { ingest: raw || '', board: t && t.missing ? t.missing : '' };
  mount($rail, html`
    <div class="rail-label">Film</div>
    ${NAV.slice(0, 5).map((n) => html`<a class="rail-item" href="#/${n.id}" ${S.route.view === n.id ? 'aria-current="page"' : ''} title="${n.hint}">${icon(n.icon)}<span>${n.label}</span>${counts[n.id] ? html`<span class="count" title="${n.id === 'ingest' ? 'unnamed clips' : 'shots missing'}">${counts[n.id]}</span>` : ''}</a>`)}
    <div class="rail-label">Project</div>
    ${NAV.slice(5).map((n) => html`<a class="rail-item" href="#/${n.id}" ${S.route.view === n.id ? 'aria-current="page"' : ''}>${icon(n.icon)}<span>${n.label}</span></a>`)}
    <div class="rail-foot">
      ${S.info.ffmpeg.ok ? '' : html`<a href="#/settings" class="app-chip app-chip--warning">${icon('warn', 12)} ffmpeg missing</a>`}
      ${S.info.key.set ? '' : html`<a href="#/canvas" class="faint">${icon('key', 12)} No LetzAI key yet</a>`}
      <span title="${S.info.project.root}">${S.snap ? plural(S.snap.clips.length, 'clip') : ''}</span>
    </div>`);
}

function renderChrome() { renderTop(); renderRail(); }

on($top, 'click', '#themeBtn', () => setTheme(theme() === 'dark' ? 'light' : 'dark'));
on($top, 'click', '#helpBtn', () => openShortcuts());
on($top, 'click', '#paletteBtn', () => openPalette());
on($top, 'click', '#queueBtn', (e, el) => openQueue(el));
on($top, 'click', '#proxyChip', (e, el) => {
  const st = S.proxy || {};
  openMenu(el, [
    { head: `${st.left || 0} clips to prepare (${st.minutes || 0} min of footage)` },
    st.prepare
      ? { label: 'Pause, prepare only when I open a clip', icon: 'pause', onClick: () => setPrepare(false) }
      : { label: 'Resume preparing in the background', icon: 'play', onClick: () => setPrepare(true) },
    { sep: true },
    { label: 'Playback settings', icon: 'settings', onClick: () => go('settings') },
  ], { align: 'end' });
});
on($top, 'click', '#projectMenu', (e, el) => openMenu(el, [
  { label: 'Rescan folders', icon: 'regenerate', onClick: () => rescan() },
  { label: 'Rename all files…', icon: 'pencil', onClick: () => openRenameAll() },
  { label: 'Show in folder', icon: 'folder', onClick: () => post('/api/reveal', {}).catch(toastError) },
  { sep: true },
  { label: 'Switch project…', icon: 'arrowLeft', onClick: async () => { await post('/api/project/close'); } },
]));

async function setPrepare(on_) {
  try {
    await patch('/api/project', { playback: { prepare: on_ } });
    await loadInfo();
    S.proxy = await get('/api/proxy-status');
    emitJobs();
    toast(on_ ? 'Preparing playback copies in the background again.' : 'Paused. A clip is prepared when you open it.', { type: 'success' });
  } catch (e) { toastError(e); }
}

export async function rescan() {
  try { await post('/api/rescan'); toast('Folders rescanned.', { type: 'success' }); } catch (e) { toastError(e); }
}

function openShortcuts() {
  const rows = [
    ['Global', [['Ctrl K', 'Jump to a shot or action'], ['g then d / r / m / i / c / s', 'Go to Dashboard / Review / Compare / Ingest / Canvas / Settings'], ['?', 'This list']]],
    ['Review', [['Space or K', 'Play / pause'], ['J / L', 'Slower / faster (press again to speed up)'], ['← / →', 'Step one frame (Shift: one second)'], ['I / O', 'Set cut in / out point'], ['Enter', 'Add cut from in to out'], ['M', 'Drop a marker'], ['1 2 3', 'Rate: void / ok / good'], ['P', 'Print (circle) this take'], ['[ / ]', 'Previous / next take'], ['Shift [ / ]', 'Previous / next shot'], ['C', 'Compare with the next take'], ['T', 'Focus: hide the side panels'], ['S', 'Send this take to the canvas']]],
    ['Ingest', [['Enter', 'Apply the name and go to the next clip'], ['Tab', 'Move between scene, shot, take'], ['Esc', 'Skip this clip'], ['Ctrl Z', 'Undo the last rename']]],
  ];
  openPopup({
    title: 'Keyboard shortcuts', width: 640,
    body: html`${rows.map(([h, items]) => html`<div class="section-label" style="margin-top:0">${h}</div><div style="display:grid;gap:6px;margin-bottom:20px">${items.map(([k, d]) => html`<div class="row"><span class="kbd" style="min-width:0">${k}</span><span class="muted">${d}</span></div>`)}</div>`)}`,
  });
}

// ---- keyboard ------------------------------------------------------------------------
let chord = null;
document.addEventListener('keydown', (e) => {
  const t = e.target;
  const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable || t.tagName === 'SELECT');
  if (e.key === 'Escape') { if (closeTopLayer()) e.preventDefault(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (S.info && S.info.project) openPalette(); return; }
  if (typing || e.ctrlKey || e.metaKey || e.altKey || hasLayer()) return;
  if (e.key === '?') { e.preventDefault(); openShortcuts(); return; }
  if (!(S.info && S.info.project)) return;
  if (chord) {
    const map = { d: 'board', b: 'board', r: 'review', m: 'compare', i: 'ingest', c: 'canvas', s: 'settings' };
    const dest = map[e.key.toLowerCase()];
    chord = null;
    if (dest) { e.preventDefault(); go(dest); }
    return;
  }
  if (e.key === 'g') { chord = true; setTimeout(() => { chord = null; }, 900); }
});

// ---- live events -------------------------------------------------------------------------
let libTimer;
let proxyTimer;
function scheduleProxyStatus() {
  clearTimeout(proxyTimer);
  proxyTimer = setTimeout(async () => { try { S.proxy = await get('/api/proxy-status'); emitJobs(); } catch { /* no project */ } }, 700);
}
function connectEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('hello', (e) => {
    const d = JSON.parse(e.data);
    // the kit was restarted (an update): load the new interface instead of running the old one against it
    if (window.__kitStart && d.startedAt && window.__kitStart !== d.startedAt) { location.reload(); return; }
    window.__kitStart = d.startedAt;
    S.jobs = d.jobs; emitJobs();
  });
  es.addEventListener('job', (e) => {
    const j = JSON.parse(e.data);
    const before = S.jobs.find((x) => x.id === j.id);
    upsertJob(j);
    if (j.background || j.lane === 'proxy') scheduleProxyStatus();
    if (!before || before.state === j.state) return;
    if (j.state === 'error') toast(`${j.title}: ${j.error}`, { type: 'error', timeout: 12000, link: j.title.startsWith('Canvas') || j.title.startsWith('Cut') ? { text: 'See in Canvas', onClick: () => go('canvas') } : null });
    if (j.state === 'done' && j.title.startsWith('Canvas ·')) {
      const c = S.info.project.canvas;
      toast(`Sent ${j.title.replace('Canvas · ', '')} to the canvas.`, { type: 'success', link: c.canvasId ? { text: 'Open canvas', onClick: () => window.open(`https://www.letz.ai/canvas/${c.canvasId}${c.pageId ? `?page=${c.pageId}` : ''}`, '_blank') } : null });
    }
  });
  es.addEventListener('jobs', (e) => { S.jobs = JSON.parse(e.data); emitJobs(); });
  es.addEventListener('library', () => { clearTimeout(libTimer); libTimer = setTimeout(loadLibrary, 120); });
  es.addEventListener('project', async () => { await loadInfo(); await loadLibrary(); show(); });
  es.addEventListener('proxy', (e) => { document.dispatchEvent(new CustomEvent('kit:proxy', { detail: JSON.parse(e.data) })); });
  es.addEventListener('problem', (e) => toast(JSON.parse(e.data).message, { type: 'error' }));
  es.onerror = () => { /* the browser retries by itself */ };
}

// ---- boot --------------------------------------------------------------------------------------
subscribe(() => { renderChrome(); show(); });
subscribeJobs(() => renderTop());
window.addEventListener('hashchange', () => { route(); renderRail(); });

(async function boot() {
  try {
    S.hevc = !!document.createElement('video').canPlayType('video/mp4; codecs="hvc1.1.6.L120.90"');
    await loadInfo();
    await loadLibrary();
    // tell the kit what this browser can play, so it prepares only what is needed
    if (S.info && S.info.project) { post('/api/client-caps', { hevc: S.hevc }).then(scheduleProxyStatus).catch(() => {}); }
    connectEvents();
    route();
    renderChrome();
  } catch (e) {
    mount($main, html`<div class="app-empty"><div class="app-empty-title">Can't reach the kit</div><div class="app-empty-body">${e.message}</div></div>`);
  }
})();
