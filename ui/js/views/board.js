// The Board: the plan laid over what was shot. Which shots are covered, which are missing, which need a decision.
import { html, icon, mount, on, $, $$, fmtDur, fmtClock, fmtDay, plural, clamp, debounce } from '../lib.js';
import { get, post, patch } from '../api.js';
import { S, scenes, totals, clips, allClips, takesOf, clip, folders, folderLabel, hasManyFolders, setFolderFilter, loadInfo, failedSends } from '../store.js';
import { toast, toastError, openMenu } from '../ui.js';
import { folderButton, folderChip, wireFolderControls } from '../folderpick.js';
import { openRenameTakes, takesOfScene } from '../renametakes.js';
import { openSlateReader } from '../slate.js';
import { openShotList, addShotDialog, addSceneDialog, planOp } from './shotlist.js';

let root;
const ticked = new Set(); // takes ticked in All clips
const collapsed = new Set(JSON.parse(localStorage.getItem('board.collapsed') || '[]'));
const saveCollapsed = () => { try { localStorage.setItem('board.collapsed', JSON.stringify([...collapsed])); } catch { /* ignore */ } };

const posterUrl = (c, w = 480) => {
  const t = c.duration > 0 ? clamp(c.duration * 0.35, 1, 8) : 2;
  return `/thumb?key=${encodeURIComponent(c.key)}&t=${t.toFixed(1)}&w=${w}`;
};

const STATUS = {
  selected: { label: 'Selected', cls: 'app-chip--ink', icon: 'check' },
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

function statCard({ value, label, sub, bar, tone, act }) {
  return html`<div class="stat surface ${act ? 'clickable' : ''}" ${act ? html`data-stat="${act}"` : ''}>
    <div class="stat-v tnum ${tone || ''}">${value}</div><div class="stat-l">${label}</div>
    ${bar != null ? html`<div class="bar sm" style="margin-top:10px"><i style="width:${Math.round(clamp(bar, 0, 1) * 100)}%"></i></div>` : ''}
    ${sub ? html`<div class="faint stat-s">${sub}</div>` : ''}</div>`;
}

function stats() {
  const t = totals();
  const planned = S.snap.coverage.scenes.some((s) => s.planned);
  const all = clips().filter((c) => c.kind === 'shot');
  const printed = all.filter((c) => c.print);
  const printedOnCanvas = printed.filter((c) => c.onCanvas).length;
  const footage = clips().reduce((a, c) => a + (c.duration || 0), 0);
  const denom = Math.max(1, t.shots - scenes().reduce((a, s) => a + s.shots.filter((x) => x.status === 'optional').length, 0));
  return html`
    ${statCard({ value: html`${t.covered}<span class="faint"> / ${t.shots}</span>`, label: planned ? 'shots covered' : 'shots on disk', bar: t.covered / denom })}
    ${statCard({ value: t.selected, label: 'shots with a printed take', bar: t.covered ? t.selected / t.covered : 0, sub: `${plural(printed.length, 'take')} printed` })}
    ${statCard({ value: t.toReview, label: 'shots still to review', sub: t.toReview ? 'no rating on any take yet' : 'nothing waiting', act: t.toReview ? 'toReview' : '' })}
    ${S.filters.folder ? statCard({ value: html`<span class="faint">—</span>`, label: 'shots missing', sub: 'tracked for the whole film, not one folder' }) : statCard({ value: t.missing, label: 'shots missing', tone: t.missing ? 'warn' : '', sub: t.missing ? 'planned, no takes (or numbering gaps)' : planned ? 'every planned shot has a take' : 'write a shot list to track this', act: t.missing ? 'missing' : '' })}
    ${statCard({ value: fmtDur(footage), label: 'footage', sub: `${fmtDur(t.printedRuntime)} printed` })}
    ${statCard({ value: html`${printedOnCanvas}<span class="faint"> / ${printed.length}</span>`, label: 'printed takes on canvas', bar: printed.length ? printedOnCanvas / printed.length : 0, sub: S.info.project.canvas.canvasId ? S.info.project.canvas.canvasName || 'connected' : 'not connected', act: 'canvas' })}`;
}

function shotCard(sc, sh) {
  const st = STATUS[sh.status];
  const takes = takesOf(sh);
  const best = sh.best ? clip(sh.best) : null;
  const missing = sh.status === 'missing' || sh.status === 'gap' || sh.status === 'optional';
  return html`
    <article class="shot-card ${missing ? 'is-missing' : ''} st-${sh.status}" tabindex="0" data-act="open-shot" data-scene="${sc.id}" data-shot="${sh.id}" aria-label="Shot ${sc.id}.${sh.id}, ${st.label}">
      <div class="poster">
        ${best ? html`<img loading="lazy" alt="" src="${posterUrl(best)}" onerror="this.style.visibility='hidden'">` : html`<div class="poster-empty">${icon('dashed', 24)}<span>${sh.status === 'gap' ? 'Numbering gap' : 'Not shot yet'}</span></div>`}
        <span class="app-chip on-media shot-id">${sc.id}.${sh.id}</span>
        <span class="app-chip ${st.cls}">${icon(st.icon, 12)}${st.label}</span>
        ${best && best.onCanvas ? html`<span class="app-chip on-media cloud" title="On the canvas">${icon('canvas', 12)}</span>` : ''}
      </div>
      <div class="shot-body">
        <div class="shot-desc ${sh.desc ? '' : 'faint'}">${sh.desc || (sh.extra ? 'Not in the shot list' : sh.status === 'gap' ? 'No takes between the neighbouring shots' : '—')}${sh.size ? html` <span class="app-chip xs app-chip--quiet">${sh.size}</span>` : ''}</div>
        <div class="shot-meta">
          ${takes.length ? html`<span class="tnum">${plural(takes.length, 'take')} · ${fmtDur(sh.duration)}</span>${pips(takes)}` : html`<span class="faint">No takes</span>`}
        </div>
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
  const done = sc.stats.selected;
  const total = sc.shots.filter((s) => s.status !== 'optional').length;
  return html`
    <section class="scene" data-scene-sec="${sc.id}">
      <header class="scene-head">
        <button class="app-icon-btn app-icon-btn--sm" data-act="toggle-scene" data-scene="${sc.id}" aria-expanded="${open}" title="${open ? 'Collapse' : 'Expand'}">${icon(open ? 'chevronDown' : 'chevronRight', 14)}</button>
        <h2 class="scene-title">Scene ${sc.id}</h2>
        ${sc.title ? html`<span class="muted">${sc.title}</span>` : ''}
        ${sc.done ? html`<span class="app-chip app-chip--ink xs">${icon('check', 12)} Complete</span>` : ''}
        ${sc.stats.missing ? html`<span class="app-chip app-chip--warning xs">${sc.stats.missing} missing</span>` : ''}
        <span class="grow"></span>
        <span class="faint tnum">${done} of ${total} selected</span>
        <div class="bar sm" style="width:96px"><i style="width:${total ? Math.round((done / total) * 100) : 0}%"></i></div>
        <button class="app-btn app-btn--sm" data-act="rename-scene" data-scene="${sc.id}" title="Change the scene or shot numbers of these takes">${icon('pencil', 14)}<span>Rename</span></button>
        <button class="app-btn app-btn--sm" data-act="add-shot" data-scene="${sc.id}">${icon('plus', 14)}<span>Add shot</span></button>
      </header>
      ${open ? html`<div class="shot-grid">${shots.map((sh) => shotCard(sc, sh))}</div>` : ''}
    </section>`;
}

function clipsTable() {
  const q = S.filters.q.toLowerCase();
  const rows = clips().filter((c) => !q || `${c.name} ${c.orig} ${c.note} ${c.scene}.${c.shot}`.toLowerCase().includes(q));
  if (!rows.length) return html`<div class="app-empty"><div class="app-empty-title">No clips match</div></div>`;
  for (const k of [...ticked]) if (!clip(k)) ticked.delete(k);
  const bar = ticked.size ? html`<div class="tick-bar"><b>${plural(ticked.size, 'take')} selected</b><span class="grow"></span><button class="app-btn app-btn--sm" id="tickClear">Clear</button><button class="app-btn app-btn--sm" id="checkTicked" title="Read the slates again and compare them with the names">${icon('bolt', 14)}<span>Check with Claude…</span></button><button class="app-btn app-btn--sm app-btn--primary" id="renameTicked">${icon('pencil', 14)}<span>Rename selected…</span></button></div>` : html`<div class="faint" style="font-size:12px;margin:0 0 8px">Tick takes to rename several at once.</div>`;
  const byFolder = hasManyFolders();
  let lastGroup = '';
  return html`${bar}<table class="table clip-table">
    <thead><tr><th style="width:36px"><input type="checkbox" class="app-check" id="tickAll" aria-label="Select all takes" ${rows.filter((c) => c.kind === 'shot').length && rows.filter((c) => c.kind === 'shot').every((c) => ticked.has(c.key)) ? 'checked' : ''}></th><th style="width:92px"></th><th>Name</th><th>Original</th>${byFolder ? html`<th>Folder</th>` : ''}<th>Recorded</th><th>Length</th><th>Rating</th><th>Print</th><th>Canvas</th></tr></thead>
    <tbody>${rows.map((c) => {
      // with several folders (shoot days) the table is grouped by folder, otherwise by recording day
      const group = byFolder ? (c.dir === '.' ? folderLabel('.') : c.dir) : fmtDay(c.recordedAt);
      const head = group && group !== lastGroup ? html`<tr class="day-row"><td colspan="${byFolder ? 10 : 9}">${byFolder ? html`${icon('folder', 12)} ` : ''}${group}</td></tr>` : '';
      lastGroup = group || lastGroup;
      return html`${head}<tr data-act="${c.kind === 'shot' ? 'open-clip' : 'open-raw'}" data-key="${c.key}" tabindex="0">
        <td>${c.kind === 'shot' ? html`<input type="checkbox" class="app-check" data-tick="${c.key}" ${ticked.has(c.key) ? 'checked' : ''} aria-label="Select ${c.name}">` : ''}</td>
        <td><div class="mini-poster"><img loading="lazy" alt="" src="${posterUrl(c, 200)}" onerror="this.style.visibility='hidden'"></div></td>
        <td>${c.kind === 'shot' ? html`<b class="tnum">${c.scene}.${c.shot}</b> <span class="muted">take ${c.take}</span>` : html`<span class="app-chip xs app-chip--quiet">Unnamed</span>`}<div class="faint mono-name" style="font-size:12px">${c.name}</div></td>
        <td class="faint mono-name">${c.kind === 'shot' ? c.orig : ''}</td>
        ${byFolder ? html`<td class="faint">${folderLabel(c.dir)}</td>` : ''}
        <td class="tnum muted">${fmtClock(c.recordedAt)}</td>
        <td class="tnum muted">${fmtDur(c.duration)}</td>
        <td>${c.rating ? html`<span class="app-chip xs">${c.rating}</span>` : html`<span class="faint">—</span>`}</td>
        <td>${c.print ? icon('flagFill') : ''}</td>
        <td>${c.canvasError ? html`<span class="app-chip xs app-chip--error" title="${c.canvasError.message}">${icon('alert', 12)} failed</span>` : c.onCanvas ? icon('checkCircle') : c.cutFiles.length ? html`<span class="faint tnum">${c.cutOnCanvas}/${c.cutFiles.length}</span>` : ''}</td>
      </tr>`;
    })}</tbody></table>`;
}

/** Folder cards: one per shoot day / card / subfolder, with what is in it. Click to look inside. */
function foldersView() {
  // folders that only hold other folders are just containers; the cards are the places clips actually sit
  const list = folders().filter((f) => f.path !== '.' && f.direct > 0);
  if (!list.length) return html`<div class="app-empty"><div class="app-empty-title">No subfolders</div><div class="app-empty-body">All footage sits directly in the project folder.</div></div>`;
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
  return html`<div class="app-alert app-alert--warning" style="margin-bottom:16px">${icon('folder')}<div class="grow"><b>New footage the project doesn’t look at yet</b>${discovered.map((f) => html`<div class="row" style="gap:8px;margin-top:6px"><span class="grow"><b style="display:inline">${f.name}</b> <span class="faint">· ${plural(f.clips, 'clip')}</span></span><button class="app-btn app-btn--sm" data-add-folder="${f.path}">${icon('plus', 14)}<span>Add to project</span></button></div>`)}</div></div>`;
}

function sendProblems() {
  const bad = failedSends();
  if (!bad.length) return '';
  return html`<div class="app-alert app-alert--error" style="margin-bottom:16px">${icon('alert')}<div class="grow"><b>${plural(bad.length, 'take')} didn’t reach the canvas</b>${bad[0].canvasError.message}</div><a class="app-btn app-btn--sm" href="#/canvas">See and retry</a></div>`;
}

function emptyScenes() {
  const raw = clips().filter((c) => c.kind === 'raw' && !c.skip).length;
  if (S.filters.folder && raw && S.filters.board === 'all' && !S.filters.q) {
    return html`<div class="app-empty"><div class="app-empty-title">${plural(raw, 'clip')} here still ${raw === 1 ? 'needs' : 'need'} a name</div><div class="app-empty-body">Footage joins the Board once it has a scene, shot and take. Read the slates in Ingest, it takes a few seconds per clip.</div><a class="app-btn app-btn--primary" href="#/ingest">${icon('slate')}<span>Name them in Ingest</span></a></div>`;
  }
  return html`<div class="app-empty"><div class="app-empty-title">Nothing here</div><div class="app-empty-body">No shots match this filter.</div></div>`;
}

function render() {
  const p = S.info.project;
  const t = totals();
  const hasPlan = scenes().some((s) => s.planned);
  const toReviewKey = (() => { for (const sc of scenes()) for (const sh of sc.shots) if (sh.status === 'shot') return sh.takes[0]; return null; })();
  const filters = [['all', 'All'], ['missing', 'Missing', t.missing], ['toReview', 'To review', t.toReview], ['reviewed', 'Reviewed'], ['selected', 'Selected', t.selected]];
  const mode = S.filters.boardMode;
  const noClips = !clips().length;

  return html`
    <div class="page">
      <div class="page-head">
        <div><h1 class="page-title">${p.name}</h1>
          <div class="page-sub tnum">${S.filters.folder ? html`${folderChip()} · ` : ''}${plural(t.scenes, 'scene')} · ${plural(t.shots, 'shot')} · ${plural(t.takes, 'take')} · ${fmtDur(t.runtime)} of footage${clips().some((c) => c.kind === 'raw' && !c.skip) ? html` · <a href="#/ingest">${clips().filter((c) => c.kind === 'raw' && !c.skip).length} unnamed</a>` : ''}</div></div>
        <div class="page-actions">
          ${clips().some((c) => c.kind === 'raw' && !c.skip) ? html`<button class="app-btn" id="nameMany" title="Name the unnamed clips from their slates">${icon('slate')}<span>Name clips…</span></button>` : ''}
          <button class="app-btn" id="addScene">${icon('plus')}<span>Add scene</span></button>
          <button class="app-btn" id="editPlan">${icon('list')}<span>Shot list</span></button>
          <button class="app-btn" id="exportMenu">${icon('download')}<span>Export</span>${icon('chevronDown', 12)}</button>
          <button class="app-btn app-btn--primary" id="startReview" ${noClips ? 'disabled' : ''}>${icon('review')}<span>${toReviewKey ? `Review ${plural(t.toReview, 'shot')}` : 'Open review'}</span></button>
        </div>
      </div>

      ${noClips ? html`<div class="app-empty surface"><div class="app-empty-title">No footage found yet</div><div class="app-empty-body">Looking in: ${p.folders.join(', ') || 'no folders'}. Add your footage folder in Settings, or drop clips there and rescan.</div><a class="app-btn app-btn--outline" href="#/settings">Open settings</a></div>` : html`
        <div id="discoverBanner">${discoverBanner()}</div>
        ${sendProblems()}
        ${hasPlan ? '' : html`<div class="app-alert" style="margin-bottom:16px">${icon('info')}<div class="grow"><b>No shot list yet</b>Without a plan the Board can only spot holes in your numbering. Write the shot list and it will show every shot you still owe, scene by scene.</div>
          <button class="app-btn app-btn--sm" id="seedPlan">Use what’s shot so far</button><button class="app-btn app-btn--sm app-btn--outline" id="editPlan2">Write shot list</button></div>`}
        <div class="stats">${stats()}</div>
        <div class="toolbar">
          <div class="app-tabs" role="tablist">${filters.map(([id, label, n]) => html`<button class="app-tab" role="tab" data-filter="${id}" aria-selected="${S.filters.board === id}">${label}${n ? html`<span class="n">${n}</span>` : ''}</button>`)}</div>
          <span class="grow"></span>
          <div class="legend faint"><i class="pip print"></i>printed <i class="pip good"></i>good <i class="pip ok"></i>ok <i class="pip none"></i>unrated <i class="pip void"></i>void</div>
          ${folderButton()}
          <div class="app-segmented" role="group"><button data-mode="scenes" aria-pressed="${mode === 'scenes'}">${icon('board', 14)}By scene</button>${folders().length > 1 ? html`<button data-mode="folders" aria-pressed="${mode === 'folders'}">${icon('folder', 14)}By folder</button>` : ''}<button data-mode="clips" aria-pressed="${mode === 'clips'}">${icon('list', 14)}All clips</button></div>
          <div style="position:relative;width:220px"><input class="app-input" id="boardQ" placeholder="Filter…" value="${S.filters.q}" style="padding-left:32px" spellcheck="false"><span style="position:absolute;left:10px;top:9px;color:var(--text-tertiary)">${icon('search', 14)}</span></div>
        </div>
        ${mode === 'scenes' ? html`<div class="scenes">${scenes().map(sceneSection)}${scenes().every((s) => !sceneSection(s).toString()) ? emptyScenes() : ''}</div>` : mode === 'folders' ? foldersView() : clipsTable()}`}
    </div>`;
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
    on(el, 'click', '[data-stat]', (e, b) => {
      const a = b.dataset.stat;
      if (a === 'canvas') window.kitGo('canvas'); else { S.filters.board = a; S.filters.boardMode = 'scenes'; this.update(); }
    });
    on(el, 'click', '#editPlan,#editPlan2', () => openShotList());
    on(el, 'click', '#addScene', () => addSceneDialog());
    on(el, 'click', '#nameMany', () => { window.kitGo('ingest'); setTimeout(() => import('./ingest.js').then((m) => m.openBulkName()), 400); });
    on(el, 'click', '#seedPlan', async () => { try { await post('/api/shotlist/seed'); toast('Shot list created from your footage. Add the shots you still owe.', { type: 'success' }); openShotList(); } catch (e) { toastError(e); } });
    on(el, 'click', '#startReview', () => {
      for (const sc of scenes()) for (const sh of sc.shots) if (sh.status === 'shot') return window.kitGo('review', sh.best || sh.takes[0]);
      const first = clips().find((c) => c.kind === 'shot');
      if (first) window.kitGo('review', first.key); else window.kitGo('ingest');
      return undefined;
    });
    on(el, 'click', '#exportMenu', (e, b) => openMenu(b, [
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
    on(el, 'click', '[data-act="add-shot"]', (e, b) => addShotDialog(b.dataset.scene));
    on(el, 'click', '[data-act="rename-scene"]', (e, b) => { const t = takesOfScene(b.dataset.scene); if (!t.length) { toast('No takes in this scene yet.'); return; } openRenameTakes(t.map((x) => x.key), { title: `Rename scene ${b.dataset.scene}` }); });
    on(el, 'click', '[data-tick]', (e, box) => { e.stopPropagation(); if (box.checked) ticked.add(box.dataset.tick); else ticked.delete(box.dataset.tick); this.update(); });
    on(el, 'click', '#tickAll', (e, box) => { e.stopPropagation(); const rows = clips().filter((c) => c.kind === 'shot'); if (box.checked) rows.forEach((c) => ticked.add(c.key)); else ticked.clear(); this.update(); });
    on(el, 'click', '#tickClear', () => { ticked.clear(); this.update(); });
    on(el, 'click', '#checkTicked', () => openSlateReader({ keys: [...ticked], force: true, title: `Check ${plural(ticked.size, 'take')} with Claude` }));
    on(el, 'click', '#renameTicked', () => openRenameTakes([...ticked], { afterRename: () => ticked.clear() }));
    on(el, 'click', '[data-act="open-shot"]', (e, c) => openShot(c.dataset.scene, c.dataset.shot));
    on(el, 'click', '[data-act="open-clip"]', (e, c) => { if (e.target.closest('input')) return; window.kitGo('review', c.dataset.key); });
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
    const sy = root.scrollTop;
    const hadFocus = document.activeElement && document.activeElement.id === 'boardQ';
    mount(root, render());
    root.scrollTop = sy;
    if (hadFocus) { const q = $('#boardQ', root); q.focus(); const l = q.value.length; q.setSelectionRange(l, l); }
  },
  unmount() { root = null; },
};
