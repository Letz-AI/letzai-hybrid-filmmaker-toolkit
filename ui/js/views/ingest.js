// Ingest: read the slate, type scene / shot / take, press Enter, next clip. Built for speed.
import { html, icon, mount, on, $, $$, fmtDur, fmtClock, fmtDay, plural, clamp, debounce } from '../lib.js';
import { post, patch } from '../api.js';
import { S, clips, allClips, clip, loadLibrary, hasManyFolders, folderLabel } from '../store.js';
import { folderButton, wireFolderControls } from '../folderpick.js';
import { toast, toastError, openPopup, field } from '../ui.js';
import { openSlateReader } from '../slate.js';

const setSkip = (k, v) => patch('/api/clip', { key: k, patch: { skip: v } });

let root;
let key = null;
let t = 1;               // time of the frame being shown
let touchedTake = false;
let conflict = null;     // { message, take }
let busy = false;
const recent = [];       // names applied in this session, newest first

const frameUrl = (c, time, w = 1280) => `/thumb?key=${encodeURIComponent(c.key)}&t=${time.toFixed(1)}&w=${w}`;
const queue = () => clips().filter((c) => c.kind === 'raw' && !c.skip);
const skipped = () => clips().filter((c) => c.kind === 'raw' && c.skip);

/**
 * The one place to name many clips. Either type the scene and shot from the slate (takes count up in recording order),
 * or let Claude read the slates; Claude can also re-check clips that already have a name.
 */
function openBulkName() {
  const unnamed = queue();
  const named = clips().filter((c) => c.kind === 'shot' && !c.skip);
  if (!unnamed.length && !named.length) { toast('No clips here.'); return; }
  let src = unnamed.length ? 'type' : 'claude';  // 'type' | 'claude'
  let withNamed = !unnamed.length;               // Claude only: also re-check named takes
  let mode = 'takes';                            // numbering when typing: 'takes' | 'shots'
  const on_ = new Set(withNamed ? named.map((c) => c.key) : unnamed.map((c) => c.key));
  const pool = () => (src === 'claude' && withNamed ? [...unnamed, ...named] : unnamed);
  const pred = unnamed.length ? prediction(unnamed[0]) : { scene: '', shot: '', take: 1 };
  const p = openPopup({
    title: 'Name several clips', width: 780,
    body: html`<div style="display:grid;gap:14px">
      <div class="app-segmented" role="radiogroup" aria-label="How to name"><button role="radio" data-src="type" ${unnamed.length ? '' : 'disabled'}>Type the slate</button><button role="radio" data-src="claude">${icon('bolt', 14)}Claude reads the slates</button></div>
      <div class="row" id="bType" style="gap:12px;align-items:flex-start">${field('Scene', html`<input class="app-input" id="bScene" value="${pred.scene}" style="width:90px" maxlength="6" spellcheck="false">`)}${field('Shot', html`<input class="app-input" id="bShot" value="${pred.shot}" style="width:90px" maxlength="6" spellcheck="false">`)}${field('First take', html`<input class="app-input" id="bTake" type="number" min="1" value="${pred.take}" style="width:100px">`)}
        <div class="grow"></div>
        <div class="app-field"><div class="label">Numbering</div><div class="app-segmented" role="radiogroup" aria-label="How to number"><button role="radio" aria-checked="true" data-bm="takes">Takes of one shot</button><button role="radio" aria-checked="false" data-bm="shots">One shot each</button></div></div></div>
      <div id="bClaude">${named.length ? html`<label class="app-switch"><input type="checkbox" id="bNamed" ${withNamed ? 'checked' : ''}><span>Also check clips that already have a name</span></label>` : ''}</div>
      <div class="faint" id="bHint" style="font-size:12px"></div>
      <div class="row" style="gap:8px"><label class="row" style="gap:8px;cursor:pointer"><input type="checkbox" class="app-check" id="bAll"><span id="bAllLbl"></span></label></div>
      <div id="bList" class="rename-list" style="max-height:340px"></div>
      <div id="bWarn"></div></div>`,
    foot: html`<button class="app-btn" data-no>Cancel</button><button class="app-btn app-btn--primary" id="bGo">Rename</button>`,
  });
  const val = (id) => p.el.querySelector(id).value.trim();
  const orderedOn = () => pool().filter((c) => on_.has(c.key));
  const items = () => {
    const shot = val('#bShot'); const t0 = parseInt(val('#bTake'), 10) || 1; const n0 = parseInt(shot, 10);
    return orderedOn().map((c, i) => (mode === 'takes'
      ? { key: c.key, scene: val('#bScene'), shot, take: t0 + i }
      : { key: c.key, scene: val('#bScene'), shot: Number.isFinite(n0) ? String(n0 + i) : shot, take: t0 }));
  };
  const hint = () => {
    const all = pool(); const n = orderedOn().length;
    const shot = val('#bShot'); const t0 = parseInt(val('#bTake'), 10) || 1;
    p.el.querySelector('#bType').style.display = src === 'type' ? '' : 'none';
    p.el.querySelector('#bClaude').style.display = src === 'claude' ? '' : 'none';
    p.el.querySelectorAll('[data-src]').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.src === src)));
    p.el.querySelector('#bHint').textContent = !n ? 'Tick at least one clip.' : src === 'claude'
      ? 'Nothing is renamed until you check what Claude read.'
      : mode === 'takes' ? `Scene ${val('#bScene') || '?'}, shot ${shot || '?'}: takes ${t0} to ${t0 + n - 1}.`
        : (/^\d+$/.test(shot) ? `Scene ${val('#bScene') || '?'}: shots ${shot} to ${+shot + n - 1}, take ${t0} each.` : 'Shot numbers can only count up from a plain number.');
    p.el.querySelector('[data-bm=shots]').disabled = !/^\d+$/.test(shot);
    const allBox = p.el.querySelector('#bAll');
    allBox.checked = n === all.length; allBox.indeterminate = n > 0 && n < all.length;
    p.el.querySelector('#bAllLbl').textContent = `${n} of ${all.length} ticked`;
  };
  let names = new Map(); let why = new Map();
  const target = (c) => {
    if (!on_.has(c.key)) return html`<span class="faint">skipped</span>`;
    if (src === 'claude') return html`<span class="faint">Claude reads it</span>`;
    return why.has(c.key) ? html`<span style="color:var(--color-warning)">${why.get(c.key)}</span>` : names.has(c.key) ? html`<b>${names.get(c.key)}</b>` : html`<span class="faint">…</span>`;
  };
  const rows = () => mount(p.el.querySelector('#bList'), html`${pool().map((c) => html`<label class="rename-row bulk-row" role="row">
      <span class="row" style="gap:10px;min-width:0"><input type="checkbox" class="app-check" data-bk="${c.key}" ${on_.has(c.key) ? 'checked' : ''}>
        <span class="mini-poster"><img loading="lazy" alt="" src="${frameUrl(c, clamp(c.duration ? Math.min(1, c.duration / 2) : 1, 0, 2), 160)}" onerror="this.style.visibility='hidden'"></span>
        <span style="min-width:0"><span class="mono-name">${c.kind === 'shot' ? `${c.scene}.${c.shot} take ${c.take}` : (c.orig || c.name)}</span><div class="faint" style="font-size:11px">${fmtClock(c.recordedAt) || ''} ${fmtDur(c.duration)}</div></span></span>
      <span class="faint">${icon('arrowRight', 14)}</span>
      <span class="mono-name">${target(c)}</span></label>`)}`);
  let seq = 0;
  const draw = async () => {
    hint(); rows();
    const mine = ++seq;
    const go = p.el.querySelector('#bGo');
    const warn = p.el.querySelector('#bWarn');
    names = new Map(); why = new Map();
    if (src === 'claude') {
      const n = orderedOn().length;
      go.disabled = !n; go.textContent = n ? `Read ${plural(n, 'slate')}…` : 'Tick clips to read'; warn.innerHTML = '';
      return;
    }
    const it = items();
    if (!it.length || !it[0].scene || !it[0].shot) { go.disabled = true; go.textContent = 'Rename'; warn.innerHTML = ''; return; }
    try {
      const r = await post('/api/rename-many', { items: it, apply: false });
      if (mine !== seq) return;
      for (const c of r.changes) names.set(c.key, c.to);
      for (const c of r.conflicts) why.set(c.key, c.reason);
      rows();
      go.disabled = !r.changes.length;
      go.textContent = r.changes.length ? `Rename ${plural(r.changes.length, 'clip')}` : 'Nothing to rename';
      mount(warn, r.conflicts.length ? html`<div class="app-alert app-alert--warning">${icon('warn')}<div class="grow"><b>${plural(r.conflicts.length, 'clip')} left alone</b>That name exists already. Try a later first take.</div></div>` : '');
    } catch (e) { mount(warn, html`<div class="app-alert app-alert--error">${icon('alert')}<div class="grow">${e.message}</div></div>`); go.disabled = true; }
  };
  const soon = debounce(draw, 180);
  p.el.addEventListener('input', (e) => { if (e.target.id !== 'bAll' && e.target.id !== 'bNamed' && !e.target.dataset.bk) soon(); });
  p.el.addEventListener('change', (e) => {
    if (e.target.dataset.bk) { if (e.target.checked) on_.add(e.target.dataset.bk); else on_.delete(e.target.dataset.bk); draw(); }
    if (e.target.id === 'bAll') { if (e.target.checked) pool().forEach((c) => on_.add(c.key)); else on_.clear(); draw(); }
    if (e.target.id === 'bNamed') { withNamed = e.target.checked; named.forEach((c) => (withNamed ? on_.add(c.key) : on_.delete(c.key))); draw(); }
  });
  on(p.el, 'click', '[data-src]', (e, bt) => { if (bt.disabled) return; src = bt.dataset.src; draw(); });
  on(p.el, 'click', '[data-bm]', (e, bt) => { if (bt.disabled) return; mode = bt.dataset.bm; p.el.querySelectorAll('[data-bm]').forEach((x) => x.setAttribute('aria-checked', String(x === bt))); draw(); });
  p.el.querySelector('[data-no]').addEventListener('click', p.close);
  p.el.querySelector('#bGo').addEventListener('click', async () => {
    const go = p.el.querySelector('#bGo');
    if (src === 'claude') {
      const keys = orderedOn().map((c) => c.key);
      p.close();
      // read named takes again (that is the point of checking them); unnamed clips read before keep their reading
      openSlateReader({ keys, force: keys.some((k) => clip(k) && clip(k).kind === 'shot'), title: `Read ${plural(keys.length, 'slate')} with Claude` });
      return;
    }
    go.disabled = true;
    try {
      const r = await post('/api/rename-many', { items: items(), apply: true });
      p.close();
      for (const c of r.changes) recent.unshift({ key: c.key, label: c.to.replace(/^.*?-scene/, 'scene').replace(/\.[^.]+$/, '') });
      await loadLibrary();
      toast(`Named ${plural(r.renamed, 'clip')}${r.conflicts.length ? `, ${r.conflicts.length} left alone` : ''}.`, { type: 'success', timeout: 12000, link: { text: 'Undo', onClick: () => undoRename() } });
      const q = queue(); window.kitGo('ingest', ...(q[0] ? [q[0].key] : []));
    } catch (e) { go.disabled = false; toastError(e); }
  });
  draw();
  setTimeout(() => { const f = p.el.querySelector(src === 'claude' ? '#bGo' : pred.scene ? '#bTake' : '#bScene'); f.focus(); if (f.select) f.select(); }, 30);
}

export { openBulkName };

export async function undoRename() {
  try { const r = await post('/api/rename/undo'); toast(`Undid ${r.undone}.`, { type: 'success' }); } catch (e) { toastError(e); }
}

/** Highest take for scene/shot plus one, from what is on disk right now. */
function nextTake(scene, shot) {
  const takes = allClips().filter((c) => c.kind === 'shot' && String(c.scene) === String(scene) && String(c.shot).toUpperCase() === String(shot).toUpperCase()).map((c) => c.take);
  return (takes.length ? Math.max(...takes) : 0) + 1;
}

/** Neighbours in shooting order: the named clip just before this one, and just after. */
function neighbours(c) {
  const all = allClips();
  const i = all.findIndex((x) => x.key === c.key);
  let before = null; let after = null;
  for (let j = i - 1; j >= 0; j--) if (all[j].kind === 'shot') { before = all[j]; break; }
  for (let j = i + 1; j < all.length; j++) if (all[j].kind === 'shot') { after = all[j]; break; }
  return { before, after };
}

function prediction(c) {
  const { before } = neighbours(c);
  const last = recent[0] && clip(recent[0].key) ? clip(recent[0].key) : null;
  const ref = last && (!before || (last.recordedAt || '') >= (before.recordedAt || '')) ? last : before;
  if (!ref) return { scene: '', shot: '', take: 1 };
  return { scene: ref.scene, shot: ref.shot, take: nextTake(ref.scene, ref.shot), ref };
}

function preview() {
  const v = vals();
  const p = S.info.project;
  const pad = p.naming.pad;
  const padv = (x, w) => (/^\d+$/.test(x) && w > 0 ? x.padStart(w, '0') : x);
  if (!v.scene || !v.shot || !v.take) return '';
  const c = clip(key);
  return `${p.prefix}-scene${padv(v.scene, pad.scene)}-shot${padv(v.shot.toUpperCase(), pad.shot)}-take${padv(v.take, pad.take)}${c ? c.ext : ''}`;
}

const vals = () => ({ scene: ($('#iScene', root) || {}).value?.trim() || '', shot: ($('#iShot', root) || {}).value?.trim() || '', take: ($('#iTake', root) || {}).value?.trim() || '' });

function takenBy(v) {
  if (!v.scene || !v.shot || !/^\d+$/.test(v.take)) return null;
  return clips().find((c) => c.kind === 'shot' && String(c.scene) === v.scene && String(c.shot).toUpperCase() === v.shot.toUpperCase() && c.take === +v.take && c.extra.length === 0) || null;
}

function renderQueue() {
  const q = queue();
  const sk = skipped();
  mount($('#igQueue', root), html`
    <div class="nav-head"><div class="row"><span class="grow rail-label" style="padding:0">Unnamed clips</span><span class="faint tnum">${q.length}</span></div>${hasManyFolders() || S.filters.folder ? html`<div style="margin-top:8px">${folderButton()}</div>` : ''}
      ${q.length > 1 || clips().some((c) => c.kind === 'shot') ? html`<button class="app-btn app-btn--primary" id="bulkName" style="width:100%;margin-top:10px" title="Type the slate once for many clips, or let Claude read them">${icon('slate')}<span>Name several…</span></button>` : ''}</div>
    <div class="nav-tree ig-list">
      ${q.map((c) => html`<div class="ig-row"><button class="ig-item ${c.key === key ? 'active' : ''}" data-q="${c.key}">
        <span class="mini-poster"><img loading="lazy" alt="" src="${frameUrl(c, clamp(c.duration ? Math.min(1, c.duration / 2) : 1, 0, 2), 200)}" onerror="this.style.visibility='hidden'"></span>
        <span class="grow"><b class="tnum">${fmtClock(c.recordedAt) || '—'}</b><div class="faint mono-name" style="font-size:11px">${c.orig || c.name}</div>${hasManyFolders() ? html`<div class="faint" style="font-size:11px">${icon('folder', 12)} ${folderLabel(c.dir)}</div>` : ''}</span>
        <span class="faint tnum">${fmtDur(c.duration)}</span></button></div>`)}
      ${q.length ? '' : html`<div class="faint" style="padding:16px">Every clip has a name.</div>`}
      ${recent.length ? html`<div class="rail-label">Just named</div>${recent.slice(0, 8).map((r) => html`<div class="ig-done"><span class="tnum">${r.label}</span></div>`)}
        <div style="padding:4px 12px"><button class="app-btn app-btn--sm" id="igUndo">${icon('undo', 14)}<span>Undo last</span><span class="kbd">Ctrl Z</span></button></div>` : ''}
      ${sk.length ? html`<div class="rail-label">Skipped</div>${sk.map((c) => html`<div class="ig-done row"><span class="grow mono-name faint" style="font-size:11px">${c.orig || c.name}</span><button class="app-btn app-btn--sm" data-unskip="${c.key}">Restore</button></div>`)}` : ''}
    </div>`);
  const a = $('.ig-item.active', root);
  if (a) a.scrollIntoView({ block: 'nearest' });
}

function renderMain() {
  const c = key && clip(key);
  const el = $('#igMain', root);
  el.dataset.key = String(c ? c.key : '');
  if (!c) {
    mount(el, html`<div class="app-empty" style="height:100%">${icon('checkCircle', 24)}<div class="app-empty-title">${queue().length ? 'Pick a clip on the left' : 'Everything is named'}</div><a class="app-btn app-btn--outline" href="#/board">Open the Dashboard</a></div>`);
    return;
  }
  const d = c.duration || 0;
  const chips = [0.5, 1.5, 3, 5, 8].filter((x) => !d || x < d - 0.3);
  if (d > 6) chips.push(Math.max(0, d - 3));
  const pred = prediction(c);
  const { before, after } = neighbours(c);
  const n = queue().length;
  mount(el, html`
    <div class="ig-grid">
      <div class="ig-frame">
        <div class="frame-box" id="frameBox" title="Click to enlarge" role="button" tabindex="0"><img id="slateImg" alt="Frame from the clip at ${t.toFixed(1)} seconds" src="${frameUrl(c, t)}"><div class="frame-loading hide" id="frameLoad"><span class="spinner"></span></div><span class="frame-zoom">${icon('expand', 14)}</span></div>
        <div class="row wrap" style="margin-top:12px;gap:6px">
          <span class="faint">Look at</span>
          ${chips.map((x) => html`<button class="app-btn app-btn--sm ${Math.abs(x - t) < 0.05 ? 'sel' : ''}" aria-pressed="${Math.abs(x - t) < 0.05}" data-t="${x}">${d && x > d - 3.1 && x > 6 ? 'End' : `${x}s`}</button>`)}
          <input type="range" id="slateT" min="0" max="${Math.max(1, Math.floor(d))}" step="0.1" value="${t}" style="flex:1;min-width:140px" aria-label="Scan through the clip">
          <button class="app-btn app-btn--sm" id="openReview" title="Watch it in Review">${icon('review', 14)}<span>Watch</span></button>
        </div>
      </div>
      <div class="ig-form">
        <div class="ig-meta">
          <div class="mono-name"><b>${c.orig || c.name}</b></div>
          <div class="faint">${c.recordedAt ? `${fmtDay(c.recordedAt)} ${fmtClock(c.recordedAt)} · ` : ''}${fmtDur(c.duration)}${c.probe ? ` · ${c.probe.width}×${c.probe.height}` : ''}</div>
        </div>
        <div id="igClaude"></div>
        <div class="ig-fields">
          ${['Scene', 'Shot', 'Take'].map((l, i) => html`<div class="app-field"><label for="i${l}">${l}</label><input class="app-input lg" id="i${l}" data-f="${l.toLowerCase()}" inputmode="${l === 'Shot' ? 'text' : 'numeric'}" autocomplete="off" spellcheck="false" maxlength="6" value="${[pred.scene, pred.shot, pred.take][i]}"></div>`)}
        </div>
        <div class="ig-name tnum" id="igName" data-empty="File name">${preview()}</div>
        <div id="igWarn"></div>
        <div class="row" style="gap:8px;margin-top:4px">
          <button class="app-btn app-btn--primary grow" id="igApply" style="height:42px;font-size:14px">${icon('check')}<span>Apply name</span><span class="kbd">Enter</span></button>
          <button class="app-btn" id="igSkip" title="Leave this one for later (Esc)">Skip<span class="kbd">Esc</span></button>
        </div>
        <div class="ig-chips">
          <div class="faint" style="font-size:12px;margin-bottom:6px">Quick fill</div>
          <div class="row wrap" style="gap:6px">
            ${pred.ref ? html`<button class="app-btn app-btn--sm app-btn--outline" data-fill="${pred.scene}|${pred.shot}|${pred.take}">Same shot · take ${pred.take}</button>` : ''}
            ${pred.ref ? html`<button class="app-btn app-btn--sm app-btn--outline" data-fill="${pred.scene}|${nextShotId(pred.shot)}|1">Next shot · ${pred.scene}.${nextShotId(pred.shot)}</button>` : ''}
            ${pred.ref ? html`<button class="app-btn app-btn--sm app-btn--outline" data-fill="${nextSceneId(pred.scene)}|1|1">Next scene · ${nextSceneId(pred.scene)}</button>` : ''}
          </div>
        </div>
        <div class="ig-ctx faint">
          ${before ? html`<div>Shot before: <b class="tnum">${before.scene}.${before.shot} take ${before.take}</b> ${fmtClock(before.recordedAt)}</div>` : ''}
          ${after ? html`<div>Shot after: <b class="tnum">${after.scene}.${after.shot} take ${after.take}</b> ${fmtClock(after.recordedAt)}</div>` : ''}
        </div>
        <button class="app-btn app-btn--sm" id="igHide" style="justify-self:start" title="Hide this clip from the queue (tests, b-roll, not a take)">${icon('eye', 14)}<span>Not a take, hide it</span></button>
      </div>
    </div>
    <div class="faint" style="padding:0 0 8px;font-size:12px">${n} left</div>`);
  renderClaudeBox();
  checkConflict();
  const f = $('#iScene', root); const sh = $('#iShot', root); const tk = $('#iTake', root);
  // Focus the field most likely to need typing: scene/shot when there is no prediction, else the shot.
  (pred.ref ? sh : f).focus(); (pred.ref ? sh : f).select();
  touchedTake = false;
  void tk;
}

/** What Claude read from this clip's slate, with a button to use it. */
function renderClaudeBox() {
  const box = $('#igClaude', root);
  const c = key && clip(key);
  if (!box || !c) return;
  const s = c.slate;
  const flags = s && s.flags && s.flags.length ? html`<div style="font-size:12px;color:var(--color-warning);margin-top:2px">${s.flags.map((f) => ({ low: 'Not sure', partial: 'Only part of the slate was readable', taken: 'That take already exists', twice: 'Another clip was read the same', 'not-in-plan': 'Scene is not in the shot list', order: 'Out of recording order' }[f] || f)).join(' · ')}</div>` : '';
  mount(box, !s ? html`<button class="app-btn app-btn--sm" id="igClaude1" title="Let Claude read this slate">${icon('bolt', 14)}<span>Read slate with Claude</span></button>`
    : s.status === 'unreadable' ? html`<div class="claude-box"><div class="grow"><b>Claude found no readable slate</b>${s.evidence ? html`<div class="faint" style="font-size:12px">${s.evidence}</div>` : ''}</div><button class="app-btn app-btn--sm" id="igClaude1">Read again</button></div>`
      : html`<div class="claude-box"><div class="grow"><div><span class="faint">Claude reads</span> <b class="tnum">${s.scene} · ${s.shot} · take ${s.take}</b> <span class="app-chip xs ${s.confidence >= 0.85 && !(s.flags || []).length ? 'app-chip--success' : 'app-chip--warning'}">${Math.round(s.confidence * 100)}%</span></div><div class="faint" style="font-size:12px">${s.evidence ? `Slate says “${s.evidence}”` : ''}${s.frameT != null ? ` · frame at ${s.frameT.toFixed(1)} s` : ''}</div>${flags}</div><button class="app-btn app-btn--sm app-btn--outline" data-fill="${s.scene}|${s.shot}|${s.take}" id="igUseClaude">Use this</button><button class="app-icon-btn app-icon-btn--sm" id="igClaude1" title="Read again">${icon('regenerate', 14)}</button></div>`);
}

const nextShotId = (s) => (/^\d+$/.test(s) ? String(+s + 1) : String((parseInt(s, 10) || 0) + 1));
const nextSceneId = (s) => (/^\d+$/.test(s) ? String(+s + 1) : '1');

function checkConflict() {
  const v = vals();
  const w = $('#igWarn', root);
  const nm = $('#igName', root);
  if (nm) nm.textContent = preview();
  if (!w) return;
  const hit = takenBy(v);
  conflict = null;
  if (hit) {
    conflict = { take: nextTake(v.scene, v.shot) };
    mount(w, html`<div class="app-alert app-alert--warning">${icon('warn')}<div class="grow"><b>${v.scene}.${v.shot} take ${v.take} already exists</b>
      <div class="row" style="margin-top:8px"><button class="app-btn app-btn--sm app-btn--outline" id="useNext">Use take ${conflict.take}</button><button class="app-btn app-btn--sm app-btn--outline" id="keepDup">Keep both as duplicates</button></div></div></div>`);
  } else mount(w, '');
}

async function apply(onConflict) {
  if (busy) return;
  const c = key && clip(key);
  if (!c) return;
  const v = vals();
  if (!v.scene || !v.shot || !/^\d+$/.test(v.take)) { toast('Scene, shot and a numeric take are needed.', { type: 'error' }); return; }
  busy = true;
  const q = queue();
  const i = q.findIndex((x) => x.key === key);
  const nxt = q[i + 1] || q[i - 1] || null;
  try {
    const r = await post('/api/clip/rename', { key: c.key, scene: v.scene, shot: v.shot.toUpperCase(), take: +v.take, onConflict });
    recent.unshift({ key: r.key, label: `${v.scene}.${v.shot.toUpperCase()} · take ${r.take || v.take}` });
    toast(`Named ${r.name || preview()}`, { type: 'success', timeout: 2200 });
    key = nxt ? nxt.key : null; t = 1;
    await loadLibrary();
    window.kitGo('ingest', ...(key ? [key] : []));
  } catch (e) {
    if (e.status === 409 && e.code === 'exists') { checkConflict(); } else toastError(e);
  } finally { busy = false; }
}

function select(k) { key = k; t = 1; conflict = null; renderQueue(); renderMain(); }

function frameTo(time) {
  const c = key && clip(key);
  if (!c) return;
  t = clamp(time, 0, c.duration || 600);
  const img = $('#slateImg', root);
  const load = $('#frameLoad', root);
  if (!img) return;
  load.classList.remove('hide');
  const next = new Image();
  next.onload = () => { img.src = next.src; load.classList.add('hide'); };
  next.onerror = () => { load.classList.add('hide'); };
  next.src = frameUrl(c, t);
  $$('[data-t]', root).forEach((b) => b.setAttribute('aria-pressed', String(Math.abs(+b.dataset.t - t) < 0.05)));
}
const frameToSoon = debounce(frameTo, 140);

export default {
  flush: true,
  mount(el, args) {
    root = el;
    mount(el, html`<div class="ingest"><aside class="rv-nav" id="igQueue"></aside><section class="ig-main" id="igMain"></section></div>`);
    const q = queue();
    key = args[0] && clip(args[0]) && clip(args[0]).kind === 'raw' ? args[0] : (q[0] && q[0].key) || null;
    t = 1;
    renderQueue(); renderMain();

    wireFolderControls(el, on);
    on(el, 'click', '[data-q]', (e, b) => window.kitGo('ingest', b.dataset.q));
    on(el, 'click', '#bulkName', () => openBulkName());
    on(el, 'click', '#igClaude1', () => openSlateReader({ keys: [key], force: !!(clip(key) && clip(key).slate) }));
    on(el, 'click', '[data-t]', (e, b) => frameTo(parseFloat(b.dataset.t)));
    on(el, 'input', '#slateT', (e, r) => { t = parseFloat(r.value); frameToSoon(t); });
    el.addEventListener('input', (e) => {
      if (e.target.id === 'slateT') { frameToSoon(parseFloat(e.target.value)); return; }
      if (e.target.dataset.f === 'take') touchedTake = true;
      if ((e.target.dataset.f === 'scene' || e.target.dataset.f === 'shot') && !touchedTake) {
        const v = vals();
        if (v.scene && v.shot) $('#iTake', el).value = nextTake(v.scene, v.shot);
      }
      if (e.target.dataset.f) checkConflict();
    });
    el.addEventListener('focusin', (e) => { if (e.target.dataset && e.target.dataset.f) e.target.select(); });
    on(el, 'click', '#frameBox', () => {
      const c = clip(key);
      if (!c) return;
      const p = openPopup({ title: `${c.orig || c.name} at ${t.toFixed(1)} s`, width: 1280, className: 'zoom-popup', body: html`<img class="zoom-img" alt="" src="${frameUrl(c, t, 1920)}">` });
      p.el.addEventListener('keydown', (e) => { if (e.key === 'Enter') p.close(); });
    });
    on(el, 'click', '#igApply', () => apply('fail'));
    on(el, 'click', '#useNext', () => apply('next'));
    on(el, 'click', '#keepDup', () => apply('dup'));
    on(el, 'click', '#igSkip', () => skip());
    on(el, 'click', '#igUndo', undoRename);
    on(el, 'click', '#openReview', () => window.kitGo('review', key));
    on(el, 'click', '[data-fill]', (e, b) => { const [s, sh, tk] = b.dataset.fill.split('|'); $('#iScene', el).value = s; $('#iShot', el).value = sh; $('#iTake', el).value = tk; touchedTake = true; checkConflict(); $('#iTake', el).focus(); });
    on(el, 'click', '#igHide', async () => {
      const q2 = queue(); const i = q2.findIndex((x) => x.key === key); const nxt = q2[i + 1] || q2[i - 1];
      try { await setSkip(key, true); await loadLibrary(); toast('Hidden. Restore it under Skipped.'); window.kitGo('ingest', ...(nxt ? [nxt.key] : [])); } catch (err) { toastError(err); }
    });
    on(el, 'click', '[data-unskip]', async (e, b) => { try { await setSkip(b.dataset.unskip, false); await loadLibrary(); } catch (err) { toastError(err); } });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.dataset && e.target.dataset.f) { e.preventDefault(); apply(conflict ? 'fail' : 'fail'); }
      if (e.key === 'Escape' && !document.querySelector('.scrim')) { e.preventDefault(); skip(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !(e.target.dataset && e.target.dataset.f && e.target.value !== e.target.defaultValue)) { e.preventDefault(); undoRename(); }
    });
  },
  onArgs(args) {
    if (!root) return;
    const k = args[0] && clip(args[0]) && clip(args[0]).kind === 'raw' ? args[0] : (queue()[0] && queue()[0].key) || null;
    select(k);
  },
  update() {
    if (!root || !root.querySelector('.ingest')) return;
    const q = queue();
    if (key && !(clip(key) && clip(key).kind === 'raw' && !clip(key).skip)) key = (q[0] && q[0].key) || null;
    if (!key && q.length) key = q[0].key;
    renderQueue();
    // keep what the user is typing; only rebuild the main pane if the clip itself changed
    if ($('#igMain', root).dataset.key !== String(key || '')) renderMain(); else renderClaudeBox();
  },
  unmount() { root = null; key = null; },
};

function skip() {
  const q = queue();
  const i = q.findIndex((x) => x.key === key);
  const nxt = q[i + 1] || q[0];
  if (nxt && nxt.key !== key) window.kitGo('ingest', nxt.key);
}
