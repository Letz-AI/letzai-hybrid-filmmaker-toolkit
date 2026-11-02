// The Dashboard (route #/board): the plan laid over what was shot. Which shots are covered, which are missing, which need a decision.
import { html, icon, mount, on, $, $$, fmtDur, fmtClock, fmtDay, plural, clamp, debounce } from '../lib.js';
import { get, post, patch } from '../api.js';
import { S, scenes, totals, clips, allClips, takesOf, clip, folders, folderLabel, hasManyFolders, setFolderFilter, loadInfo, failedSends, subscribeJobs } from '../store.js';
import { toast, toastError, openMenu } from '../ui.js';
import { folderButton, folderChip, wireFolderControls } from '../folderpick.js';
import { openRenameTakes, takesOfScene } from '../renametakes.js';
import { openShotList, addShotDialog, addSceneDialog, planOp } from './shotlist.js';
import { cutTakes, uploadItems, sendItems, deleteItems, copyLinks, openSnippet, snippetCard, snippetOf, snippetSummary, busyWith } from '../takeactions.js';

let root;
const ticked = new Set(); // takes ticked in All clips
const expanded = new Set(); // takes whose snippets are shown in All clips
const picked = new Set();   // single snippets ticked, as "takeKey#n"
const pickedList = () => [...picked].map((id) => { const i = id.lastIndexOf('#'); return { key: id.slice(0, i), n: Number(id.slice(i + 1)) }; });
const selection = () => ({ keys: [...ticked], snippets: pickedList() });
const takeLabel = (c) => (c.kind === 'shot' ? html`<b class="tnum">${c.scene}.${c.shot}</b> <span class="muted">take ${c.take}</span>` : html`<b>${c.orig || c.name}</b>`);
const collapsed = new Set(JSON.parse(localStorage.getItem('board.collapsed') || '[]'));
const saveCollapsed = () => { try { localStorage.setItem('board.collapsed', JSON.stringify([...collapsed])); } catch { /* ignore */ } };

const posterUrl = (c, w = 480) => {
  const t = c.duration > 0 ? clamp(c.duration * 0.35, 1, 8) : 2;
  return `/thumb?key=${encodeURIComponent(c.key)}&t=${t.toFixed(1)}&w=${w}`;
};

const STATUS = {
  selected: { label: 'Printed', cls: 'app-chip--ink', icon: 'check' },
  reviewed: { label: 'Reviewed', cls: 'on-media', icon: 'eye' },
  shot: { label: 'To review', cls: 'on-media', icon: 'dot' },
  missing: { label: 'Missing', cls: 'app-chip--warning', icon: 'dashed' },
  gap: { label: 'Gap', cls: 'app-chip--dashed', icon: 'dashed' },
  optional: { label: 'Optional', cls: 'app-chip--quiet', icon: 'dashed' },
};

function pips(takes) {
  return html`<span class="pips" aria-label="Takes">${takes.map((t) => html`<i class="pip ${t.print ? 'print' : t.rating || 'none'}" title="Take ${t.take}${t.rating ? ` · ${t.rating}` : ''}${t.print ? ' · printed' : ''}"></i>`)}</span>`;
}

function matches(sh, sc, q) {
  if (!q) return true;
  const hay = `${sc.id}.${sh.id} scene ${sc.id} shot ${sh.id} ${sh.desc} ${sh.size} ${takesOf(sh).map((t) => t.note).join(' ')}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).every((tok) => hay.includes(tok));
}

function passes(sh) {
  const f = S.filters.board;
  if (f === 'all') return true;
  if (f === 'missing') return sh.status === 'missing' || sh.status === 'gap';
  if (f === 'toReview') return sh.status === 'shot';
  if (f === 'reviewed') return sh.status === 'reviewed';
  if (f === 'selected') return sh.status === 'selected';
  return true;
}

function shotCard(sc, sh) {
  const st = STATUS[sh.status];
  const takes = takesOf(sh);
  const best = sh.best ? clip(sh.best) : null;
  const missing = sh.status === 'missing' || sh.status === 'gap' || sh.status === 'optional';
  return html`
    <article class="shot-card ${missing ? 'is-missing' : ''} st-${sh.status}" tabindex="0" data-act="open-shot" data-scene="${sc.id}" data-shot="${sh.id}" aria-label="Shot ${sc.id}.${sh.id}, ${st.label}">
      <div class="poster">
        ${best ? html`<img loading="lazy" alt="" src="${posterUrl(best)}" onerror="this.style.visibility='hidden'">` : html`<div class="poster-empty">${icon('dashed', 24)}</div>`}
        <span class="app-chip on-media shot-id">${sc.id}.${sh.id}</span>
        <span class="app-chip ${st.cls}">${icon(st.icon, 12)}${st.label}</span>
        ${best && best.onCanvas ? html`<span class="app-chip on-media cloud" title="On the canvas">${icon('canvas', 12)}</span>` : ''}
      </div>
      <div class="shot-body">
        ${sh.desc || sh.size ? html`<div class="shot-desc">${sh.desc}${sh.size ? html` <span class="app-chip xs app-chip--quiet">${sh.size}</span>` : ''}</div>` : ''}
        ${sh.extra ? html`<div class="faint" style="font-size:12px">Not in the shot list</div>` : ''}
        ${takes.length ? html`<div class="shot-meta"><span class="tnum">${plural(takes.length, 'take')} · ${fmtDur(sh.duration)}</span>${pips(takes)}</div>` : ''}
        ${sh.takeGaps.length ? html`<div class="shot-warn">${icon('warn', 12)} take ${sh.takeGaps.join(', ')} not found</div>` : ''}
        ${sh.dupTakes.length ? html`<div class="shot-warn">${icon('warn', 12)} take ${sh.dupTakes.join(', ')} appears twice</div>` : ''}
      </div>
    </article>`;
}

function sceneSection(sc) {
  const q = S.filters.q;
  const shots = sc.shots.filter((sh) => passes(sh) && matches(sh, sc, q));
  if (!shots.length && (S.filters.board !== 'all' || q)) return '';
  const open = !collapsed.has(sc.id);
  return html`
    <section class="scene" data-scene-sec="${sc.id}">
      <header class="scene-head">
        <button class="app-icon-btn app-icon-btn--sm" data-act="toggle-scene" data-scene="${sc.id}" aria-expanded="${open}" title="${open ? 'Collapse' : 'Expand'}">${icon(open ? 'chevronDown' : 'chevronRight', 14)}</button>
        <h2 class="scene-title">Scene ${sc.id}</h2>
        ${sc.title ? html`<span class="muted">${sc.title}</span>` : ''}
        ${sc.done ? html`<span class="app-chip app-chip--ink xs">${icon('check', 12)} Complete</span>` : ''}
        ${sc.stats.missing ? html`<span class="app-chip app-chip--warning xs">${sc.stats.missing} missing</span>` : ''}
        <span class="grow"></span>
        <button class="app-icon-btn app-icon-btn--sm" data-act="scene-menu" data-scene="${sc.id}" title="Scene actions">${icon('more', 16)}</button>
      </header>
      ${open ? html`<div class="shot-grid">${shots.map((sh) => shotCard(sc, sh))}</div>` : ''}
    </section>`;
}

function clipsTable() {
  const q = S.filters.q.toLowerCase();
  const rows = clips().filter((c) => !q || `${c.name} ${c.orig} ${c.note} ${c.scene}.${c.shot}`.toLowerCase().includes(q));
  if (!rows.length) return html`<div class="app-empty"><div class="app-empty-title">No clips match</div></div>`;
  for (const k of [...ticked]) if (!clip(k)) ticked.delete(k);
  const byFolder = hasManyFolders();
  const cols = byFolder ? 10 : 9;
  let lastGroup = '';
  return html`<table class="table clip-table">
    <thead><tr><th style="width:36px"><input type="checkbox" class="app-check" id="tickAll" aria-label="Select all takes" ${rows.filter((c) => c.kind === 'shot').length && rows.filter((c) => c.kind === 'shot').every((c) => ticked.has(c.key)) ? 'checked' : ''}></th><th style="width:92px"></th><th>Name</th><th>Original</th>${byFolder ? html`<th>Folder</th>` : ''}<th>Recorded</th><th>Length</th><th>Rating</th><th>Snippets</th></tr></thead>
    <tbody>${rows.map((c) => {
      // with several folders (shoot days) the table is grouped by folder, otherwise by recording day
      const group = byFolder ? (c.dir === '.' ? folderLabel('.') : c.dir) : fmtDay(c.recordedAt);
      const head = group && group !== lastGroup ? html`<tr class="day-row"><td colspan="${cols}">${byFolder ? html`${icon('folder', 12)} ` : ''}${group}</td></tr>` : '';
      lastGroup = group || lastGroup;
      const open = expanded.has(c.key) && c.cutFiles.length;
      return html`${head}<tr data-act="${c.kind === 'shot' ? 'open-clip' : 'open-raw'}" data-key="${c.key}" tabindex="0" class="${ticked.has(c.key) ? 'is-ticked' : ''}">
        <td>${c.kind === 'shot' ? html`<input type="checkbox" class="app-check" data-tick="${c.key}" ${ticked.has(c.key) ? 'checked' : ''} aria-label="Select ${c.name}">` : ''}</td>
        <td><div class="mini-poster"><img loading="lazy" alt="" src="${posterUrl(c, 200)}" onerror="this.style.visibility='hidden'"></div></td>
        <td>${c.kind === 'shot' ? html`<b class="tnum">${c.scene}.${c.shot}</b> <span class="muted">take ${c.take}</span>` : html`<span class="app-chip xs app-chip--quiet">Unnamed</span>`}<div class="faint mono-name" style="font-size:12px">${c.name}</div></td>
        <td class="faint mono-name">${c.kind === 'shot' ? c.orig : ''}</td>
        ${byFolder ? html`<td class="faint">${folderLabel(c.dir)}</td>` : ''}
        <td class="tnum muted">${fmtClock(c.recordedAt)}</td>
        <td class="tnum muted">${fmtDur(c.duration)}</td>
        <td>${c.rating ? html`<span class="app-chip xs">${c.rating}</span>` : ''}${c.print ? html` <span title="Printed">${icon('flagFill', 14)}</span>` : ''}${!c.rating && !c.print ? html`<span class="faint">—</span>` : ''}</td>
        <td><span class="row" style="gap:6px">${c.cutFiles.length ? html`<button class="app-icon-btn app-icon-btn--sm" data-expand="${c.key}" aria-expanded="${open ? 'true' : 'false'}" title="${open ? 'Hide' : 'Show'} the snippets">${icon(open ? 'chevronDown' : 'chevronRight', 14)}</button>` : ''}${c.kind === 'shot' ? snippetSummary(c) : ''}</span></td>
      </tr>${open ? html`<tr class="snip-row"><td></td><td colspan="${cols - 1}"><div class="snip-grid">${c.cutFiles.map((s) => snippetCard(c, s, { pick: picked }))}</div></td></tr>` : ''}`;
    })}</tbody></table>`;
}

/** Every snippet as a card, grouped by take, to look at, select and send on. */
const SNIP_FILTERS = [['all', 'All'], ['notUploaded', 'Not uploaded'], ['uploaded', 'Uploaded'], ['onCanvas', 'On canvas']];
const snipPasses = (s, f) => f === 'all' || (f === 'notUploaded' ? !s.uploaded : f === 'uploaded' ? !!s.uploaded : s.onCanvas);
function snippetsView() {
  const f = S.filters.snips || 'all';
  const q = S.filters.q.toLowerCase();
  if (!clips().some((c) => c.cutFiles.length)) {
    return html`<div class="app-empty"><div class="app-empty-title">No snippets yet</div><div class="app-empty-body">Snippets are the short pieces of a take (at most ${S.info.project.snippets.maxSeconds} s) that go to LetzAI. Tick takes in All clips and press Cut, or cut a take in Review.</div><button class="app-btn app-btn--outline" data-mode="clips">${icon('list', 14)}<span>All clips</span></button></div>`;
  }
  const groups = clips()
    .filter((c) => c.cutFiles.length && (!q || `${c.name} ${c.orig} ${c.note} ${c.scene}.${c.shot}`.toLowerCase().includes(q)))
    .map((c) => ({ c, list: c.cutFiles.filter((s) => snipPasses(s, f)) }))
    .filter((g) => g.list.length);
  if (!groups.length) return html`<div class="app-empty"><div class="app-empty-title">No snippets match</div></div>`;
  return html`<div class="snip-groups">${groups.map(({ c, list }) => {
    const ids = list.map((s) => `${c.key}#${s.n}`);
    return html`<section class="snip-group">
      <header class="snip-group-head">
        <input type="checkbox" class="app-check" data-pick-many="${ids.join(' ')}" ${ids.every((id) => picked.has(id)) ? 'checked' : ''} aria-label="Select these snippets">
        <button class="link-btn" data-open-take="${c.key}" title="Open the take in Review">${takeLabel(c)}</button>
        ${snippetSummary(c)}
      </header>
      <div class="snip-grid">${list.map((s) => snippetCard(c, s, { pick: picked }))}</div>
    </section>`;
  })}</div>`;
}

/** The bar at the bottom while takes or snippets are ticked: everything that can be done with them. */
function actionBar() {
  const mode = S.filters.boardMode;
  for (const x of pickedList()) if (!snippetOf(x.key, x.n)) picked.delete(`${x.key}#${x.n}`); // deleted or cut again
  if ((mode !== 'clips' && mode !== 'snippets') || (!ticked.size && !picked.size)) return '';
  const takes = ticked.size;
  const noKey = !S.info.key.set;
  const what = [takes && plural(takes, 'take'), picked.size && plural(picked.size, 'snippet')].filter(Boolean).join(' · ');
  return html`<div class="action-bar" role="toolbar" aria-label="Selected">
    <b>${what}</b>
    <span class="grow"></span>
    ${takes ? html`<button class="app-btn app-btn--sm" data-bulk="cut" title="Cut the ticked takes into snippets of at most ${S.info.project.snippets.maxSeconds} s, without uploading">${icon('scissors', 14)}<span>Cut</span></button>` : ''}
    <button class="app-btn app-btn--sm" data-bulk="upload" aria-disabled="${noKey ? 'true' : 'false'}" title="${noKey ? 'Needs your LetzAI API key' : 'Upload to your LetzAI uploads (not the canvas). Takes are cut first.'}">${icon('upload', 14)}<span>Upload to LetzAI</span></button>
    <button class="app-btn app-btn--sm app-btn--primary" data-bulk="send" aria-disabled="${noKey ? 'true' : 'false'}" title="${noKey ? 'Needs your LetzAI API key' : 'Place on your LetzAI Canvas. Takes are cut first.'}">${icon('canvas', 14)}<span>Send to Canvas</span></button>
    ${takes ? html`<button class="app-btn app-btn--sm" data-bulk="rename">${icon('pencil', 14)}<span>Rename…</span></button>` : ''}
    <button class="app-icon-btn app-icon-btn--sm" data-bulk="more" title="More">${icon('more', 16)}</button>
    <button class="app-icon-btn app-icon-btn--sm" id="tickClear" title="Clear the selection">${icon('close', 16)}</button>
  </div>`;
}

/** Folder cards: one per shoot day / card / subfolder, with what is in it. Click to look inside. */
function foldersView() {
  // folders that only hold other folders are just containers; the cards are the places clips actually sit
  const list = folders().filter((f) => f.path !== '.' && f.direct > 0);
  if (!list.length) return html`<div class="app-empty"><div class="app-empty-title">No subfolders</div></div>`;
  const first = (path) => allClips().find((c) => (c.dir === path || c.dir.startsWith(path + '/')) && c.kind === 'shot') || allClips().find((c) => c.dir === path || c.dir.startsWith(path + '/'));
  return html`<div class="folder-grid">${list.map((f) => {
    const lead = first(f.path);
    const parent = f.depth > 1 ? f.path.split('/').slice(0, -1).join(' / ') : '';
    return html`<article class="folder-card" tabindex="0" data-act="open-folder" data-path="${f.path}">
      <div class="poster">${lead ? html`<img loading="lazy" alt="" src="${posterUrl(lead)}" onerror="this.style.visibility='hidden'">` : ''}<span class="app-chip on-media shot-id">${icon('folder', 12)} ${f.depth > 1 ? 'Subfolder' : 'Folder'}</span></div>
      <div class="shot-body">
        <div class="folder-name">${f.name}</div>
        ${parent ? html`<div class="faint" style="font-size:12px">in ${parent}</div>` : ''}
        <div class="shot-meta tnum"><span>${plural(f.clips, 'clip')} · ${fmtDur(f.duration)}</span></div>
        <div class="row wrap" style="gap:6px">${f.scenes.length ? html`<span class="app-chip xs">Scenes ${f.scenes.join(', ')}</span>` : ''}${f.raw ? html`<span class="app-chip xs app-chip--warning">${f.raw} unnamed</span>` : ''}</div>
      </div>
    </article>`;
  })}</div>`;
}

let discovered = [];
async function discover() {
  try { discovered = (await get('/api/folders/discover')).folders; } catch { discovered = []; }
  if (root) { const b = $('#discoverBanner', root); if (b) mount(b, discoverBanner()); }
}
function discoverBanner() {
  if (!discovered.length) return '';
  return html`<div class="app-alert app-alert--warning" style="margin-bottom:16px">${icon('folder')}<div class="grow"><b>New footage found</b>${discovered.map((f) => html`<div class="row" style="gap:8px;margin-top:6px"><span class="grow"><b style="display:inline">${f.name}</b> <span class="faint">· ${plural(f.clips, 'clip')}</span></span><button class="app-btn app-btn--sm" data-add-folder="${f.path}">${icon('plus', 14)}<span>Add</span></button></div>`)}</div></div>`;
}

function sendProblems() {
  const bad = failedSends();
  if (!bad.length) return '';
  return html`<div class="app-alert app-alert--error" style="margin-bottom:16px">${icon('alert')}<div class="grow"><b>${plural(bad.length, 'take')} didn’t reach the canvas</b>${bad[0].canvasError.message}</div><a class="app-btn app-btn--sm" href="#/canvas">See and retry</a></div>`;
}

function emptyScenes() {
  const raw = clips().filter((c) => c.kind === 'raw' && !c.skip).length;
  if (S.filters.folder && raw && S.filters.board === 'all' && !S.filters.q) {
    return html`<div class="app-empty"><div class="app-empty-title">${plural(raw, 'clip')} here still ${raw === 1 ? 'needs' : 'need'} a name</div><div class="app-empty-body">Clips show up here once they have a scene, shot and take.</div><a class="app-btn app-btn--primary" href="#/ingest">${icon('slate')}<span>Name them in Ingest</span></a></div>`;
  }
  return html`<div class="app-empty"><div class="app-empty-title">Nothing here</div><div class="app-empty-body">No shots match this filter.</div></div>`;
}

function render() {
  const p = S.info.project;
  const t = totals();
  const toReviewKey = (() => { for (const sc of scenes()) for (const sh of sc.shots) if (sh.status === 'shot') return sh.takes[0]; return null; })();
  const filters = [['all', 'All'], ['missing', 'Missing', t.missing], ['toReview', 'To review', t.toReview], ['reviewed', 'Reviewed'], ['selected', 'Printed', t.selected]];
  const mode = S.filters.boardMode;
  const noClips = !clips().length;

  return html`
    <div class="page">
      <div class="page-head">
        <div><h1 class="page-title">${p.name}</h1>
          <div class="page-sub tnum">${S.filters.folder ? html`${folderChip()} · ` : ''}${plural(t.scenes, 'scene')} · ${plural(t.shots, 'shot')} · ${plural(t.takes, 'take')} · ${fmtDur(t.runtime)} of footage${clips().some((c) => c.kind === 'raw' && !c.skip) ? html` · <a href="#/ingest">${clips().filter((c) => c.kind === 'raw' && !c.skip).length} unnamed</a>` : ''}</div></div>
        <div class="page-actions">
          <button class="app-icon-btn" id="pageMenu" title="Shot list, scenes, exports">${icon('more', 18)}</button>
          <button class="app-btn app-btn--primary" id="startReview" ${noClips ? 'disabled' : ''}>${icon('review')}<span>${toReviewKey ? `Review ${plural(t.toReview, 'shot')}` : 'Open review'}</span></button>
        </div>
      </div>

      ${noClips ? html`<div class="app-empty surface"><div class="app-empty-title">No footage found yet</div><div class="app-empty-body">Looking in: ${p.folders.join(', ') || 'no folders'}</div><a class="app-btn app-btn--outline" href="#/settings/footage">Footage settings</a></div>` : html`
        <div id="discoverBanner">${discoverBanner()}</div>
        ${sendProblems()}
        <div class="toolbar">
          ${mode === 'snippets'
            ? html`<div class="app-tabs" role="tablist">${SNIP_FILTERS.map(([id, label]) => { const n = clips().reduce((a, c) => a + c.cutFiles.filter((s) => snipPasses(s, id)).length, 0); return html`<button class="app-tab" role="tab" data-snipfilter="${id}" aria-selected="${(S.filters.snips || 'all') === id}">${label}${n ? html`<span class="n">${n}</span>` : ''}</button>`; })}</div>`
            : html`<div class="app-tabs" role="tablist">${filters.map(([id, label, n]) => html`<button class="app-tab" role="tab" data-filter="${id}" aria-selected="${S.filters.board === id}">${label}${n ? html`<span class="n">${n}</span>` : ''}</button>`)}</div>`}
          <span class="grow"></span>
          ${folderButton()}
          <div class="app-segmented" role="group"><button data-mode="scenes" aria-pressed="${mode === 'scenes'}">${icon('board', 14)}By scene</button>${folders().length > 1 ? html`<button data-mode="folders" aria-pressed="${mode === 'folders'}">${icon('folder', 14)}By folder</button>` : ''}<button data-mode="clips" aria-pressed="${mode === 'clips'}">${icon('list', 14)}All clips</button><button data-mode="snippets" aria-pressed="${mode === 'snippets'}">${icon('scissors', 14)}Snippets</button></div>
          <div style="position:relative;width:220px"><input class="app-input" id="boardQ" placeholder="Filter…" value="${S.filters.q}" style="padding-left:32px" spellcheck="false"><span style="position:absolute;left:10px;top:9px;color:var(--text-tertiary)">${icon('search', 14)}</span></div>
        </div>
        ${mode === 'scenes' ? html`<div class="scenes">${scenes().map(sceneSection)}${scenes().every((s) => !sceneSection(s).toString()) ? emptyScenes() : ''}</div>` : mode === 'folders' ? foldersView() : mode === 'snippets' ? snippetsView() : clipsTable()}`}
    </div>
    ${actionBar()}`;
}

function openShot(sceneId, shotId) {
  const sc = scenes().find((s) => String(s.id) === String(sceneId));
  const sh = sc && sc.shots.find((x) => String(x.id) === String(shotId));
  if (!sh) return;
  if (sh.takes.length) { window.kitGo('review', sh.best || sh.takes[0]); return; }
  openMenu(root.querySelector(`[data-scene="${sc.id}"][data-shot="${sh.id}"]`), [
    { head: `Shot ${sc.id}.${sh.id}` },
    ...(sh.planned ? [
      { label: sh.optional ? 'Make required' : 'Mark as optional', icon: 'dashed', onClick: () => planOp({ op: 'optional', scene: sc.id, shot: sh.id }).catch(toastError) },
      { label: 'Remove from shot list', icon: 'trash', onClick: () => planOp({ op: 'remove', scene: sc.id, shot: sh.id }).catch(toastError) },
    ] : [{ label: 'Add to shot list', icon: 'plus', onClick: () => addShotDialog(sc.id, sh.id) }]),
    { sep: true },
    { label: 'Name a raw clip as this shot…', icon: 'slate', onClick: () => window.kitGo('ingest') },
  ]);
}

export default {
  flush: false,
  mount(el) {
    root = el;
    this.update();
    discover();
    on(el, 'click', '[data-filter]', (e, b) => { S.filters.board = b.dataset.filter; this.update(); });
    on(el, 'click', '[data-mode]', (e, b) => { S.filters.boardMode = b.dataset.mode; this.update(); });
    on(el, 'click', '#startReview', () => {
      for (const sc of scenes()) for (const sh of sc.shots) if (sh.status === 'shot') return window.kitGo('review', sh.best || sh.takes[0]);
      const first = clips().find((c) => c.kind === 'shot');
      if (first) window.kitGo('review', first.key); else window.kitGo('ingest');
      return undefined;
    });
    on(el, 'click', '#pageMenu', (e, b) => openMenu(b, [
      { label: 'Shot list…', icon: 'list', onClick: () => openShotList() },
      { label: 'Add scene…', icon: 'plus', onClick: () => addSceneDialog() },
      { sep: true },
      { head: 'Reports (CSV)' },
      { label: 'Continuity log', icon: 'download', onClick: () => { location.href = '/api/report/continuity.csv'; } },
      { label: 'Missing shots', icon: 'download', onClick: () => { location.href = '/api/report/missing.csv'; } },
      { label: 'Printed takes', icon: 'download', onClick: () => { location.href = '/api/report/prints.csv'; } },
      { sep: true },
      { head: 'Files' },
      { label: 'Rename all files…', icon: 'pencil', onClick: () => import('../renameall.js').then((m) => m.openRenameAll()) },
      { sep: true },
      { head: 'Hand-off' },
      { label: 'Copy printed takes to a folder…', icon: 'folder', onClick: async () => { try { const r = await post('/api/pick-folder', { title: 'Copy printed takes to…' }); if (r.path) { await post('/api/selects', { dest: r.path }); toast('Copying printed takes. Follow it in the queue.', { type: 'success' }); } } catch (err) { toastError(err); } } },
    ], { align: 'end' }));
    wireFolderControls(el, on);
    on(el, 'click', '[data-act="open-folder"]', (e, c) => { setFolderFilter(c.dataset.path); S.filters.boardMode = 'scenes'; });
    on(el, 'click', '[data-add-folder]', async (e, b) => { b.disabled = true; try { await patch('/api/project', { folders: [...S.info.project.folders, b.dataset.addFolder] }); await loadInfo(); toast('Folder added. Scanning…', { type: 'success' }); discover(); } catch (err) { toastError(err); b.disabled = false; } });
    on(el, 'click', '[data-act="toggle-scene"]', (e, b) => { const id = b.dataset.scene; if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id); saveCollapsed(); this.update(); e.stopPropagation(); });
    on(el, 'click', '[data-act="scene-menu"]', (e, b) => {
      const id = b.dataset.scene;
      openMenu(b, [
        { label: 'Add shot…', icon: 'plus', onClick: () => addShotDialog(id) },
        { label: 'Rename takes…', icon: 'pencil', onClick: () => { const t = takesOfScene(id); if (!t.length) { toast('No takes in this scene yet.'); return; } openRenameTakes(t.map((x) => x.key), { title: `Rename scene ${id}` }); } },
      ], { align: 'end' });
    });
    on(el, 'click', '[data-tick]', (e, box) => { e.stopPropagation(); if (box.checked) ticked.add(box.dataset.tick); else ticked.delete(box.dataset.tick); this.update(); });
    on(el, 'click', '#tickAll', (e, box) => { e.stopPropagation(); const rows = clips().filter((c) => c.kind === 'shot'); if (box.checked) rows.forEach((c) => ticked.add(c.key)); else ticked.clear(); this.update(); });
    on(el, 'click', '#tickClear', () => { ticked.clear(); picked.clear(); this.update(); });
    on(el, 'click', '[data-expand]', (e, b) => { e.stopPropagation(); const k = b.dataset.expand; if (expanded.has(k)) expanded.delete(k); else expanded.add(k); this.update(); });
    on(el, 'click', '[data-snipfilter]', (e, b) => { S.filters.snips = b.dataset.snipfilter; this.update(); });
    on(el, 'click', '[data-open-take]', (e, b) => window.kitGo('review', b.dataset.openTake));
    // snippet cards: the checkbox selects, anywhere else opens it
    on(el, 'click', '[data-pick]', (e, box) => { e.stopPropagation(); if (box.checked) picked.add(box.dataset.pick); else picked.delete(box.dataset.pick); this.update(); });
    on(el, 'click', '[data-pick-many]', (e, box) => { const ids = box.dataset.pickMany.split(' '); ids.forEach((id) => (box.checked ? picked.add(id) : picked.delete(id))); this.update(); });
    on(el, 'click', '[data-snip]', (e, card) => { if (e.target.closest('.snip-check')) return; openSnippet(card.dataset.snip, card.dataset.n); });
    el.addEventListener('keydown', (e) => {
      const card = e.target.closest && e.target.closest('.snip-card');
      if (!card || e.target !== card) return;
      if (e.key === 'Enter') { e.preventDefault(); openSnippet(card.dataset.snip, card.dataset.n); }
      if (e.key === ' ') { e.preventDefault(); const id = `${card.dataset.snip}#${card.dataset.n}`; if (picked.has(id)) picked.delete(id); else picked.add(id); this.update(); const again = root.querySelector(`.snip-card[data-snip="${CSS.escape(card.dataset.snip)}"][data-n="${card.dataset.n}"]`); if (again) again.focus(); }
    });
    on(el, 'click', '[data-bulk]', async (e, b) => {
      const sel = selection();
      const act = b.dataset.bulk;
      // in All clips, open the takes being worked on, so their snippets appear where the person is looking
      const reveal = () => { sel.keys.forEach((k) => expanded.add(k)); this.update(); };
      if (act === 'cut') { reveal(); cutTakes(sel.keys); }
      else if (act === 'upload') { reveal(); uploadItems(sel); }
      else if (act === 'send') { reveal(); sendItems(sel); }
      else if (act === 'rename') openRenameTakes(sel.keys, { afterRename: () => ticked.clear() });
      else if (act === 'more') {
        openMenu(b, [
          { label: 'Copy LetzAI links', icon: 'copy', onClick: () => copyLinks(sel) },
          ...(sel.keys.length ? [{ label: 'Copy take names', icon: 'copy', onClick: () => navigator.clipboard.writeText(sel.keys.map((k) => clip(k).name).join('\n')).then(() => toast('Names copied.', { type: 'success' })).catch(toastError) }] : []),
          { sep: true },
          { label: sel.keys.length ? 'Delete their snippets…' : 'Delete snippets…', icon: 'trash', onClick: async () => { if (await deleteItems(sel)) { picked.clear(); this.update(); } } },
        ], { align: 'end' });
      }
    });
    on(el, 'click', '[data-act="open-shot"]', (e, c) => openShot(c.dataset.scene, c.dataset.shot));
    on(el, 'click', '[data-act="open-clip"]', (e, c) => { if (e.target.closest('input, button, a')) return; window.kitGo('review', c.dataset.key); });
    on(el, 'click', '[data-act="open-raw"]', (e, c) => window.kitGo('ingest', c.dataset.key));
    el.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-act]')) { e.preventDefault(); e.target.click(); } });
    el.addEventListener('input', debounce((e) => {
      if (e.target.id !== 'boardQ') return;
      S.filters.q = e.target.value;
      const pos = e.target.selectionStart;
      this.update();
      const q = $('#boardQ', el); q.focus(); q.setSelectionRange(pos, pos);
    }, 160));
  },
  update() {
    if (!root || !S.snap) return;
    if (!this.unJobs) {
      let sig = '';
      this.unJobs = subscribeJobs(() => {
        if (!root || (S.filters.boardMode !== 'clips' && S.filters.boardMode !== 'snippets')) return;
        const next = clips().map((c) => busyWith(c.key)).join(',');
        if (next !== sig) { sig = next; this.update(); }
      });
    }
    const sy = root.scrollTop;
    const hadFocus = document.activeElement && document.activeElement.id === 'boardQ';
    mount(root, render());
    root.scrollTop = sy;
    if (hadFocus) { const q = $('#boardQ', root); q.focus(); const l = q.value.length; q.setSelectionRange(l, l); }
  },
  unmount() { root = null; if (this.unJobs) { this.unJobs(); this.unJobs = null; } },
};
