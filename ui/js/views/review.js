// Review: watch takes frame by frame, rate and circle them, mark cuts, compare, send to canvas.
// The player lives outside the re-rendered parts, so rating a take never interrupts playback.
import { html, icon, mount, on, $, $$, fmtDur, fmtTc, fmtSize, fmtClock, fmtDay, plural, clamp, debounce, copyText, esc } from '../lib.js';
import { get, post, patch } from '../api.js';
import { S, clip, clips, scenes, findShot, takesOf, subscribeJobs, inFolder, setFolderFilter, hasManyFolders, folderLabel } from '../store.js';
import { toast, toastError, openMenu } from '../ui.js';
import { folderButton, wireFolderControls } from '../folderpick.js';
import { openRenameTakes, takesOfShot, takesOfScene } from '../renametakes.js';
import { openSlateReader, aiName, aiReady } from '../slate.js';
import { openAddAi } from '../aiadd.js';

const ls = {
  get(k, d) { try { const v = localStorage.getItem(`review.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`review.${k}`, JSON.stringify(v)); } catch { /* ignore */ } },
};

let root; let A; let B;
let key = null;
let compareKey = null;
let token = 0;
let pbInfo = null;
let pending = null;      // { jobId }
let rate = 1;
let reverseTimer = null;
let inP = null; let outP = null;
let loop = false;
let fit = 'contain';
let raf = 0;
let unsubJobs = null;
let docKey = null;
let docProxy = null;
let showAll = false;
let fileOpen = false;     // "File details" unfolded (kept across redraws)
const navOpen = new Set();

const cur = () => (key ? clip(key) : null);
const fps = (c) => (c && c.probe && c.probe.fps) || 30;
const dur = () => (A && isFinite(A.duration) && A.duration > 0 ? A.duration : (cur() && cur().duration) || 0);
const posterUrl = (c, w = 320) => `/thumb?key=${encodeURIComponent(c.key)}&t=${(c.duration > 0 ? clamp(c.duration * 0.35, 1, 8) : 2).toFixed(1)}&w=${w}`;
const RATING = { void: { icon: 'ban', label: 'Void' }, ok: { icon: 'check', label: 'OK' }, good: { icon: 'thumbsUp', label: 'Good' } };

// ---- skeleton ---------------------------------------------------------------------
const SKELETON = html`
  <div class="review">
    <aside class="rv-nav" id="rvNav" aria-label="Shots"></aside>
    <section class="rv-center">
      <div class="rv-head" id="rvHead"></div>
      <div class="stage" id="stage">
        <div class="stage-pane" id="paneA"><video id="vA" playsinline preload="auto"></video><div class="stage-label" id="lblA"></div><div class="stage-info" id="infoA"></div></div>
        <div class="stage-pane hide" id="paneB"><video id="vB" playsinline muted preload="auto"></video><div class="stage-label" id="lblB"></div></div>
        <div class="stage-overlay hide" id="ovl"></div>
      </div>
      <div class="transport">
        <div class="scrub" id="scrub" role="slider" aria-label="Seek" tabindex="0">
          <div class="scrub-track"><div class="scrub-fill" id="fill"></div><div class="scrub-layer" id="layer"></div><div class="scrub-head" id="ph"></div></div>
          <div class="scrub-tip hide" id="tip"></div>
        </div>
        <div class="tbar">
          <button class="app-icon-btn" id="bBack" title="Previous frame (←)">${icon('stepBack')}</button>
          <button class="app-icon-btn tplay" id="bPlay" title="Play / pause (Space)">${icon('play')}</button>
          <button class="app-icon-btn" id="bFwd" title="Next frame (→)">${icon('stepForward')}</button>
          <div class="tc tnum" id="tc">00:00:00 <span class="faint">/ 00:00:00</span></div>
          <span class="grow"></span>
          <button class="app-btn app-btn--sm" id="bSpeed" title="Speed (J / K / L)">1×</button>
          <button class="app-icon-btn" id="bLoop" title="Loop between in and out" aria-pressed="false">${icon('loop')}</button>
          <button class="app-icon-btn" id="bCompare" title="Compare with another take (C)" aria-pressed="false">${icon('compare')}</button>
          <button class="app-icon-btn" id="bFocus" title="Focus: hide the side panels (T)" aria-pressed="false">${icon('menu')}</button>
          <button class="app-icon-btn" id="bFit" title="Fit / fill the frame">${icon('expand')}</button>
          <button class="app-icon-btn" id="bMute" title="Mute">${icon('volume')}</button>
          <button class="app-icon-btn" id="bFull" title="Full screen (F)">${icon('expand')}</button>
        </div>
      </div>
      <div class="strip" id="strip"></div>
    </section>
    <aside class="rv-insp" id="rvInsp" aria-label="Take details"></aside>
  </div>`;

// ---- navigator ------------------------------------------------------------------------
function statusGlyph(sh) {
  if (sh.status === 'selected') return html`<span class="glyph on" title="Selected">${icon('check', 12)}</span>`;
  if (sh.status === 'reviewed') return html`<span class="glyph" title="Reviewed">${icon('eye', 12)}</span>`;
  if (sh.status === 'shot') return html`<span class="glyph dot" title="To review"></span>`;
  return html`<span class="glyph miss" title="No takes">${icon('dashed', 12)}</span>`;
}

function renderNav() {
  const c = cur();
  const q = (showAll ? '' : '').toString();
  const list = scenes();
  const unrated = ls.get('unrated', false);
  const nav = $('#rvNav', root);
  const curScene = c && c.kind === 'shot' ? String(c.scene) : null;
  if (curScene && !navOpen.has(curScene) && !nav.dataset.touched) navOpen.add(curScene);
  mount(nav, html`
    <div class="nav-head">
      <div class="row"><span class="grow rail-label" style="padding:0">Shots</span>
        <label class="app-switch" title="Only show shots that still need a rating"><input type="checkbox" id="navUnrated" ${unrated ? 'checked' : ''}><span class="faint">To review</span></label></div>
      ${S.filters.folder || hasManyFolders() ? html`<div style="margin-top:8px">${folderButton({ outline: true })}</div>` : ''}
    </div>
    <div class="nav-tree">
      ${list.map((sc) => {
        const shots = sc.shots.filter((sh) => (unrated ? sh.status === 'shot' : true));
        if (!shots.length) return '';
        const open = navOpen.has(String(sc.id)) || unrated;
        return html`<div class="nav-scene">
          <button class="nav-scene-h" data-nav-scene="${sc.id}">${icon(open ? 'chevronDown' : 'chevronRight', 12)}<span>Scene ${sc.id}</span><span class="faint tnum">${sc.stats.selected}/${sc.shots.filter((s) => s.status !== 'optional').length}</span></button>
          ${open ? shots.map((sh) => html`<button class="nav-shot ${c && c.kind === 'shot' && String(c.scene) === String(sc.id) && String(c.shot).toUpperCase() === String(sh.id) ? 'active' : ''} ${sh.takes.length ? '' : 'none'}" ${sh.takes.length ? html`data-nav-shot="${sh.best || sh.takes[0]}"` : 'disabled'}>
              ${statusGlyph(sh)}<span class="tnum nav-id">${sc.id}.${sh.id}</span><span class="grow nav-desc">${sh.desc || ''}</span><span class="faint tnum">${sh.takes.length || ''}</span></button>`) : ''}
        </div>`;
      })}
    </div>
    <div class="nav-foot faint">${unnamedCount() ? html`<a href="#/ingest">${plural(unnamedCount(), 'clip')} still unnamed</a>` : 'All clips are named'}</div>`);
  const active = $('.nav-shot.active', nav);
  if (active) active.scrollIntoView({ block: 'nearest' });
}
const unnamedCount = () => clips().filter((c) => c.kind === 'raw' && !c.skip).length;

// ---- header + strip ---------------------------------------------------------------------
function renderHead() {
  const c = cur();
  const el = $('#rvHead', root);
  if (!c) { mount(el, ''); return; }
  const f = c.kind === 'shot' ? findShot(c.scene, c.shot) : null;
  const flat = flatShots();
  const idx = f ? flat.findIndex((x) => x.sh === f.shot) : -1;
  mount(el, html`
    <div class="grow">
      <div class="rv-title">${c.kind === 'shot' ? html`<span class="tnum">${c.scene}.${c.shot}</span> <span class="muted">take ${c.take}</span>` : html`<span>${c.orig || c.name}</span> <span class="app-chip xs app-chip--quiet">Unnamed</span>`}</div>
      <div class="faint" style="font-size:12px">${f && f.shot.desc ? `${f.shot.desc} · ` : ''}${c.recordedAt ? `${fmtDay(c.recordedAt)} ${fmtClock(c.recordedAt)}` : c.name}</div>
    </div>
    ${c.kind === 'shot' ? html`<button class="app-btn app-btn--sm" id="renameMenu" title="Change this take's scene, shot or take number">${icon('pencil', 14)}<span>Rename</span>${icon('chevronDown', 12)}</button>` : ''}
    ${f ? html`<div class="row"><button class="app-icon-btn app-icon-btn--sm" id="prevShot" title="Previous shot (Shift [)" ${idx <= 0 ? 'disabled' : ''}>${icon('chevronLeft', 14)}</button>
      <span class="faint tnum" style="font-size:12px">shot ${idx + 1} / ${flat.length}</span>
      <button class="app-icon-btn app-icon-btn--sm" id="nextShot" title="Next shot (Shift ])" ${idx >= flat.length - 1 ? 'disabled' : ''}>${icon('chevronRight', 14)}</button></div>` : ''}`);
}

function flatShots() {
  const out = [];
  for (const sc of scenes()) for (const sh of sc.shots) if (sh.takes.length) out.push({ sc, sh });
  return out;
}

function shotTakes() {
  const c = cur();
  if (!c) return [];
  if (c.kind !== 'shot') return [c];
  const f = findShot(c.scene, c.shot);
  return f ? takesOf(f.shot) : [c];
}

function glyphFor(t) {
  return t.print ? html`<span class="tk-flag" title="Printed">${icon('flagFill', 14)}</span>` : '';
}

function renderStrip() {
  const c = cur();
  const el = $('#strip', root);
  if (!c) { mount(el, ''); return; }
  const takes = shotTakes();
  mount(el, html`${takes.map((t) => html`
    <button class="take ${t.key === key ? 'active' : ''} ${t.key === compareKey ? 'cmp' : ''}" data-take="${t.key}" title="${t.name}">
      <span class="take-img"><img loading="lazy" alt="" src="${posterUrl(t)}" onerror="this.style.visibility='hidden'"></span>
      <span class="take-top">${t.rating ? html`<span class="app-chip on-media xs">${icon(RATING[t.rating].icon, 12)}</span>` : ''}${t.ai && t.ai.length ? html`<span class="app-chip on-media xs" title="${t.ai.length} AI result${t.ai.length === 1 ? '' : 's'} mapped">AI</span>` : ''}${glyphFor(t)}</span>
      ${t.key === compareKey ? html`<span class="take-b">B</span>` : t.key === key && compareKey ? html`<span class="take-b">A</span>` : ''}
      <span class="take-bot"><b class="tnum">${t.kind === 'shot' ? `T${t.take}` : 'Clip'}</b><span class="tnum">${fmtDur(t.duration)}</span></span>
      ${hasManyFolders() ? html`<span class="take-folder" title="${t.dir}">${folderLabel(t.dir)}</span>` : ''}
    </button>`)}`);
  const a = $('.take.active', el);
  if (a) a.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

// ---- inspector ------------------------------------------------------------------------------
function cutPlan(c) {
  const max = Math.max(2, Number(S.info.project.snippets.maxSeconds) || 30);
  const d = c.duration || dur();
  if (!d) return [];
  const ranges = c.cutRanges && c.cutRanges.length ? c.cutRanges.map((r) => ({ a: r.in, b: Math.min(d, r.out) })) : [{ a: 0, b: d }];
  const out = [];
  for (const r of ranges) {
    const len = r.b - r.a;
    if (len <= 0.05) continue;
    const n = len <= max + 0.05 ? 1 : Math.ceil(len / max - 1e-9);
    for (let i = 0; i < n; i++) out.push(n === 1 ? len : Math.min(max - 0.05, r.b - (r.a + i * max)));
  }
  return out;
}

function camRow(label, v) { return v ? html`<div class="kv"><span class="faint">${label}</span><span class="tnum">${v}</span></div>` : ''; }

function renderInspector() {
  const c = cur();
  const el = $('#rvInsp', root);
  if (!c) { mount(el, html`<div class="app-empty"><div class="app-empty-title">No clip selected</div></div>`); return; }
  const p = c.probe;
  const cam = p && p.camera;
  const plan = cutPlan(c);
  const connected = S.info.project.canvas.canvasId && S.info.key.set;
  const ac = document.activeElement;
  const noteFocus = ac && ac.id === 'noteBox';
  const prevNote = noteFocus ? ac.value : null;
  const selStart = noteFocus ? ac.selectionStart : 0;

  mount(el, html`
    <div class="insp-sec">
      <div class="row"><div class="grow mono-name insp-name" title="${c.name}">${c.name}</div>
        <button class="app-icon-btn app-icon-btn--sm" id="copyName" title="Copy file name">${icon('copy', 14)}</button>
        <button class="app-icon-btn app-icon-btn--sm" id="reveal" title="Show in folder">${icon('folder', 14)}</button></div>
      ${c.orig && c.orig !== c.name ? html`<div class="faint" style="font-size:12px;margin-top:2px">Camera original ${c.orig}</div>` : ''}
    </div>

    ${c.kind === 'raw' ? html`
      <div class="insp-sec"><div class="app-alert">${icon('slate')}<div class="grow"><b>No name yet</b></div></div>
        <button class="app-btn app-btn--primary" id="nameIt" style="width:100%;margin-top:12px">${icon('slate')}<span>Name from the slate</span></button></div>` : html`
      <div class="insp-sec">
        <div class="insp-label">Decision</div>
        <div class="app-segmented rating" role="radiogroup" aria-label="Rating" style="width:100%">
          ${Object.entries(RATING).map(([id, r], i) => html`<button role="radio" aria-checked="${c.rating === id}" data-rate="${id}" title="${r.label} (${i + 1})" style="flex:1;justify-content:center">${icon(r.icon, 14)}<span>${r.label}</span></button>`)}
        </div>
        <button class="app-btn print-btn ${c.print ? 'on' : ''}" id="printBtn" aria-pressed="${!!c.print}" title="Print (circle) this take · P">${icon(c.print ? 'flagFill' : 'flag')}<span>${c.print ? 'Printed' : 'Print this take'}</span><span class="kbd">P</span></button>
      </div>`}

    <div class="insp-sec">
      <div class="insp-label">Note</div>
      <textarea class="app-input" id="noteBox" rows="3" placeholder="Add a note…" spellcheck="true">${c.note}</textarea>
    </div>

    <div class="insp-sec">
      <div class="row"><div class="insp-label grow" style="margin:0">Cuts</div>
        <button class="app-btn app-btn--sm" id="setIn" title="Set in point (I)">In <span class="kbd">I</span></button>
        <button class="app-btn app-btn--sm" id="setOut" title="Set out point (O)">Out <span class="kbd">O</span></button>
        <button class="app-btn app-btn--sm" id="addCut" title="Add a cut from in to out (Enter)" ${inP != null && outP != null && outP > inP ? '' : 'disabled'}>${icon('scissors', 14)}Add</button></div>
      <div class="inout tnum">${inP != null ? fmtTc(inP, fps(c)) : '--:--:--'} <span class="faint">→</span> ${outP != null ? fmtTc(outP, fps(c)) : '--:--:--'}${inP != null && outP != null && outP > inP ? html` <span class="faint">· ${(outP - inP).toFixed(1)} s</span>` : ''}</div>
      ${c.cutRanges.length ? html`<div class="cuts">${c.cutRanges.map((r, i) => html`<div class="cut-row"><span class="faint tnum">${i + 1}</span>
          <button class="link-btn tnum" data-seek="${r.in}" data-out="${r.out}" title="Play this cut">${fmtTc(r.in, fps(c))} → ${fmtTc(r.out, fps(c))}</button>
          <input class="app-input cut-label" data-cut-label="${r.id}" value="${r.label}" placeholder="Label" maxlength="80">
          <button class="app-icon-btn app-icon-btn--sm" data-del-cut="${r.id}" title="Remove cut">${icon('close', 14)}</button></div>`)}</div>` : ''}
      ${plan.length ? html`<div class="faint" style="font-size:12px;margin-top:8px" title="Snippets are at most ${S.info.project.snippets.maxSeconds} s">${plural(plan.length, 'snippet')} · ${plan.map((l) => Math.round(l)).join(', ')} s</div>` : ''}
      ${c.marks.length ? html`<div class="insp-label" style="margin-top:14px">Markers</div><div class="marks">${c.marks.map((m) => html`<div class="cut-row"><button class="link-btn tnum" data-seek="${m.t}">${fmtTc(m.t, fps(c))}</button><span class="grow faint">${m.label || ''}</span><button class="app-icon-btn app-icon-btn--sm" data-del-mark="${m.id}">${icon('close', 14)}</button></div>`)}</div>` : ''}
    </div>

    ${c.kind === 'shot' ? html`<div class="insp-sec">
      <div class="insp-label">AI versions</div>
      ${c.ai && c.ai.length ? html`<div class="ai-list">${c.ai.map((a) => html`<button class="ai-item" data-compare-ai="${a.id}" title="Compare with the original">${icon('compare', 14)}<span class="grow ellipsis">${a.label}</span><span class="faint tnum">${fmtDur(a.duration)}</span></button>`)}</div>` : ''}
      <button class="app-btn app-btn--sm" id="aiAdd" style="margin-top:${c.ai && c.ai.length ? 8 : 0}px" title="Add a generated video to compare it with this take">${icon('plus', 14)}<span>Add AI result…</span></button>
    </div>` : ''}

    ${c.kind === 'shot' ? html`<div class="insp-sec">
      <div class="insp-label">Canvas</div>
      ${c.canvasError ? html`<div class="app-alert app-alert--error" style="margin-bottom:10px">${icon('alert')}<div class="grow"><b>Didn’t reach the canvas</b><span style="word-break:break-word">${c.canvasError.message}</span>${(c.canvasError.files || []).slice(0, 4).map((f) => html`<div class="faint" style="font-size:12px;margin-top:4px">${f.file}</div>`)}</div></div>` : ''}
      ${c.cutFiles.length ? html`<div class="row wrap" style="margin-bottom:10px"><span class="app-chip xs ${c.onCanvas ? 'app-chip--ink' : ''}">${icon(c.onCanvas ? 'check' : 'cloud', 12)} ${c.onCanvas ? 'On canvas' : `${c.cutOnCanvas} of ${c.cutFiles.length} on canvas`}</span></div>` : ''}
      <div class="row">${S.info.key.set ? html`<button class="app-btn app-btn--primary grow" id="sendCanvas">${icon('canvas')}<span>${!connected ? 'Connect canvas' : c.canvasError ? 'Retry send' : 'Send to canvas'}</span><span class="kbd">S</span></button>`
        : html`<button class="app-btn grow" disabled title="Needs a LetzAI API key">${icon('canvas')}<span>Send to canvas</span></button>`}
        <button class="app-btn" id="cutOnly" title="Cut the snippets without uploading">${icon('scissors')}<span>Cut only</span></button></div>
      ${S.info.key.set ? '' : html`<div class="faint" style="font-size:12px;margin-top:6px">Sending needs your LetzAI API key. <a href="#/canvas">Add it in Canvas</a>.</div>`}
    </div>` : ''}

    <details class="insp-sec insp-fold" id="fileFold" ${fileOpen ? 'open' : ''}>
      <summary class="insp-label">File details</summary>
      ${p ? html`<div class="kvs">
        ${hasManyFolders() ? html`<div class="kv"><span class="faint">Folder</span><span title="${c.dir}">${c.dir === '.' ? folderLabel('.') : c.dir}</span></div>` : ''}
        ${camRow('Recorded', c.recordedAt ? `${fmtDay(c.recordedAt)} ${fmtClock(c.recordedAt)}` : '')}
        ${camRow('Length', fmtDur(p.duration))}
        ${camRow('Picture', `${p.width}×${p.height} · ${p.fps} fps · ${p.codec}`)}
        ${camRow('Size', fmtSize(c.size))}
        ${cam ? html`${camRow('Camera', cam.model)}${camRow('Lens', cam.lens)}${camRow('Exposure', [cam.iso && `ISO ${cam.iso}`, cam.shutter && `${cam.shutter}`, cam.aperture].filter(Boolean).join(' · '))}${camRow('White balance', cam.kelvin && `${cam.kelvin} K`)}${camRow('LUT', cam.lut)}${camRow('Camera clip', cam.clipId)}` : ''}
      </div>` : ''}
    </details>`);

  if (prevNote != null) { const nb = $('#noteBox', el); nb.focus(); nb.setSelectionRange(selStart, selStart); }
}

// ---- player ----------------------------------------------------------------------------------------
function setPlayIcon() {
  const b = $('#bPlay', root);
  if (!b) return;
  mount(b, icon(A && !A.paused ? 'pause' : 'play'));
}

function paintTime() {
  const c = cur();
  if (!c || !A) return;
  const d = dur();
  const t = A.currentTime || 0;
  $('#tc', root).innerHTML = `${fmtTc(t, fps(c))} <span class="faint">/ ${fmtTc(d, fps(c))}</span>`;
  const pct = d ? clamp(t / d, 0, 1) * 100 : 0;
  $('#fill', root).style.width = `${pct}%`;
  $('#ph', root).style.left = `${pct}%`;
}

function paintLayer() {
  const c = cur();
  const d = dur();
  const layer = $('#layer', root);
  if (!c || !d) { layer.innerHTML = ''; return; }
  const pc = (t) => `${clamp(t / d, 0, 1) * 100}%`;
  let h = '';
  for (const r of c.cutRanges) h += `<i class="sl-cut" style="left:${pc(r.in)};width:${(clamp((r.out - r.in) / d, 0, 1) * 100).toFixed(3)}%" title="${esc(r.label || 'cut')}"></i>`;
  if (inP != null && outP != null && outP > inP) h += `<i class="sl-sel" style="left:${pc(inP)};width:${(clamp((outP - inP) / d, 0, 1) * 100).toFixed(3)}%"></i>`;
  if (inP != null) h += `<i class="sl-in" style="left:${pc(inP)}"></i>`;
  if (outP != null) h += `<i class="sl-out" style="left:${pc(outP)}"></i>`;
  for (const m of c.marks) h += `<i class="sl-mark" style="left:${pc(m.t)}" title="${esc(m.label || 'marker')}"></i>`;
  layer.innerHTML = h;
}

function tick() {
  raf = requestAnimationFrame(tick);
  if (!A) return;
  paintTime();
  if (loop && outP != null && inP != null && outP > inP && !A.paused && A.currentTime >= outP) A.currentTime = inP;
  if (compareKey && B && !B.classList.contains('hide')) {
    const bt = A.currentTime;
    if (B.duration && bt > B.duration) { if (!B.paused) B.pause(); } else {
      if (Math.abs(B.currentTime - bt) > 0.12) B.currentTime = bt;
      if (!A.paused && B.paused) B.play().catch(() => {});
      if (A.paused && !B.paused) B.pause();
      B.playbackRate = A.playbackRate;
    }
  }
}

function setOverlay(content) {
  const o = $('#ovl', root);
  if (!content) { o.classList.add('hide'); o.innerHTML = ''; return; }
  o.classList.remove('hide');
  mount(o, content);
}

function pendingOverlay() {
  const job = pending && S.jobs.find((j) => j.id === pending.jobId);
  const pct = job && job.state === 'running' ? Math.round(job.progress * 100) : 0;
  return html`<div class="ovl-card"><span class="spinner"></span><div><b>Preparing a playable copy</b><div class="muted">${job && job.state === 'running' ? `${pct}%` : 'Starting…'}</div></div></div>`;
}

async function loadPlayback(k, { hevc = S.hevc } = {}) {
  return get(`/api/playback?key=${encodeURIComponent(k)}&hevc=${hevc ? 1 : 0}`);
}

async function startPlayback(opts = {}) {
  const my = ++token;
  const c = cur();
  if (!c || !A) return;
  A.pause(); setPlayIcon();
  setOverlay(null);
  try {
    const res = await loadPlayback(key, opts);
    if (my !== token) return;
    pbInfo = res;
    if (res.pending) { pending = { jobId: res.jobId }; setOverlay(pendingOverlay()); A.removeAttribute('src'); A.load(); return; }
    pending = null;
    A.src = res.url;
    A.playbackRate = rate;
    A.load();
    paintInfo();
    if (compareKey) loadB();
  } catch (e) { setOverlay(html`<div class="ovl-card err">${icon('alert')}<div><b>Can’t load this clip</b><div class="muted">${e.message}</div></div></div>`); }
}

function paintInfo() {
  const c = cur();
  const kinds = { original: 'Original', 'camera-proxy': 'Camera proxy', 'generated-proxy': 'Review proxy 720p' };
  $('#infoA', root).textContent = c && c.probe ? `${kinds[pbInfo && pbInfo.kind] || ''}${pbInfo && pbInfo.kind ? ' · ' : ''}${c.probe.width}×${c.probe.height} ${c.probe.fps} fps` : '';
  const lbl = $('#lblA', root);
  lbl.textContent = c ? (c.kind === 'shot' ? `${c.scene}.${c.shot} · take ${c.take}` : c.orig || c.name) : '';
  lbl.classList.toggle('hide', !compareKey);
}

async function loadB() {
  const b = compareKey && clip(compareKey);
  if (!b || !B) return;
  $('#lblB', root).textContent = b.kind === 'shot' ? `${b.scene}.${b.shot} · take ${b.take}` : b.name;
  try {
    const res = await loadPlayback(compareKey);
    if (res.pending) { toast('Preparing a review copy of the second take…'); B.removeAttribute('src'); return; }
    B.src = res.url; B.muted = true; B.load();
  } catch (e) { toastError(e); }
}

function setCompare(on_, k) {
  compareKey = on_ ? k : null;
  $('#paneB', root).classList.toggle('hide', !on_);
  $('#stage', root).classList.toggle('compare', !!on_);
  $('#bCompare', root).setAttribute('aria-pressed', String(!!on_));
  paintInfo();
  if (on_) loadB(); else if (B) { B.pause(); B.removeAttribute('src'); B.load(); }
  renderStrip();
}

function toggleCompare() {
  if (compareKey) { setCompare(false); return; }
  const takes = shotTakes();
  if (takes.length < 2) { toast('Compare needs a shot with at least two takes.'); return; }
  const i = takes.findIndex((t) => t.key === key);
  setCompare(true, takes[(i + 1) % takes.length].key);
}

function seekTo(t) {
  if (!A) return;
  A.currentTime = clamp(t, 0, dur() || t);
  paintTime();
}

function stepFrame(dir, big) {
  if (!A) return;
  A.pause(); stopReverse(); setPlayIcon();
  const f = fps(cur());
  if (big) { seekTo(A.currentTime + dir); return; }
  seekTo((Math.round(A.currentTime * f) + dir) / f + 0.0004);
}

function togglePlay() {
  if (!A || !A.src) return;
  stopReverse();
  if (A.paused) { A.play().catch(() => {}); } else A.pause();
}

function stopReverse() { if (reverseTimer) { clearInterval(reverseTimer); reverseTimer = null; } }

function setRate(r) {
  rate = clamp(r, 0.25, 8);
  ls.set('rate', rate);
  if (A) A.playbackRate = rate;
  $('#bSpeed', root).textContent = `${rate}×`;
}

function faster() { stopReverse(); if (A.paused) { setRate(1); A.play().catch(() => {}); } else setRate(rate < 1 ? 1 : Math.min(8, rate * 2)); }
function slower() {
  if (!A) return;
  if (!A.paused && rate > 1) { setRate(rate / 2); return; }
  A.pause();
  if (reverseTimer) { stopReverse(); return; }
  reverseTimer = setInterval(() => { if (A.currentTime <= 0.05) { stopReverse(); return; } A.currentTime = Math.max(0, A.currentTime - 0.04 * Math.max(1, rate)); }, 40);
}

// ---- data actions ------------------------------------------------------------------------------------------
async function saveMeta(patchBody, { local } = {}) {
  const c = cur();
  if (!c) return;
  Object.assign(c, local || patchBody);
  try { await patch('/api/clip', { key: c.key, patch: patchBody }); } catch (e) { toastError(e); }
}

const notes = debounce((value) => saveMeta({ note: value }), 450);

function rate_(r) {
  const c = cur();
  if (!c || c.kind !== 'shot') return;
  const next = c.rating === r ? '' : r;
  saveMeta({ rating: next });
  renderInspector(); renderStrip();
  if (next && ls.get('advance', false)) advanceUnrated();
}

function print_() {
  const c = cur();
  if (!c || c.kind !== 'shot') return;
  saveMeta({ print: !c.print });
  renderInspector(); renderStrip();
}

function advanceUnrated() {
  const takes = shotTakes();
  const nxt = takes.find((t) => t.key !== key && !t.rating);
  if (nxt) { window.kitGo('review', nxt.key); return; }
  const flat = flatShots();
  const f = findShot(cur().scene, cur().shot);
  const i = flat.findIndex((x) => x.sh === f.shot);
  for (let j = i + 1; j < flat.length; j++) if (flat[j].sh.status === 'shot') { window.kitGo('review', flat[j].sh.takes[0]); return; }
  toast('That was the last take waiting for a decision.', { type: 'success' });
}

function stepTake(d) {
  const takes = shotTakes();
  const i = takes.findIndex((t) => t.key === key);
  const n = takes[i + d];
  if (n) window.kitGo('review', n.key);
}

function stepShot(d) {
  const c = cur();
  if (!c || c.kind !== 'shot') return;
  const flat = flatShots();
  const f = findShot(c.scene, c.shot);
  const i = flat.findIndex((x) => x.sh === f.shot);
  const n = flat[i + d];
  if (n) window.kitGo('review', n.sh.best || n.sh.takes[0]);
}

function addCut() {
  const c = cur();
  if (!c || inP == null || outP == null || outP <= inP) { toast('Set an in point (I) and an out point (O) first.'); return; }
  const cuts = [...c.cutRanges, { id: `c${Date.now().toString(36)}`, in: inP, out: outP, label: '' }].sort((a, b) => a.in - b.in);
  saveMeta({ cuts }, { local: { cutRanges: cuts } });
  inP = outP = null;
  renderInspector(); paintLayer();
}

function dropMarker() {
  const c = cur();
  if (!c || !A) return;
  const marks = [...c.marks, { id: `m${Date.now().toString(36)}`, t: A.currentTime, label: '' }].sort((a, b) => a.t - b.t);
  saveMeta({ marks }, { local: { marks } });
  renderInspector(); paintLayer();
}

async function sendToCanvas() {
  const c = cur();
  if (!c || c.kind !== 'shot') return;
  if (!S.info.key.set) { toast('Sending to a canvas needs your LetzAI API key.', { link: { text: 'Add it', onClick: () => window.kitGo('canvas') } }); return; }
  if (!S.info.project.canvas.canvasId) { window.kitGo('canvas'); return; }
  try { await post('/api/canvas/send', { keys: [c.key] }); toast(`Cutting and uploading ${c.scene}.${c.shot} take ${c.take}…`, { type: 'success' }); } catch (e) { toastError(e); }
}

async function cutOnly() {
  const c = cur();
  if (!c) return;
  try { await post('/api/cuts', { keys: [c.key] }); toast('Cutting snippets. Follow it in the queue.', { type: 'success' }); } catch (e) { toastError(e); }
}

// ---- wiring ----------------------------------------------------------------------------------------------------------
function bindPlayer() {
  A = $('#vA', root); B = $('#vB', root);
  A.addEventListener('play', setPlayIcon); A.addEventListener('pause', setPlayIcon); A.addEventListener('ended', setPlayIcon);
  A.addEventListener('loadedmetadata', () => { paintLayer(); paintTime(); });
  A.addEventListener('error', async () => {
    if (!A.getAttribute('src')) return;
    if (pbInfo && (pbInfo.kind === 'original' || pbInfo.kind === 'camera-proxy') && !A.dataset.retried) {
      A.dataset.retried = '1';
      await startPlayback({ hevc: false });
      return;
    }
    setOverlay(html`<div class="ovl-card err">${icon('alert')}<div><b>This browser can’t play the clip</b><div class="muted">Try a Chromium based browser (Chrome, Edge) or install the HEVC video extension.</div></div></div>`);
  });
  A.addEventListener('canplay', () => { delete A.dataset.retried; setOverlay(null); }, { once: false });
  A.addEventListener('click', togglePlay);
  A.addEventListener('dblclick', () => $('#stage', root).requestFullscreen?.());
  A.volume = ls.get('volume', 1);
  A.muted = ls.get('muted', false);
  mount($('#bMute', root), icon(A.muted ? 'mute' : 'volume'));
  rate = ls.get('rate', 1); $('#bSpeed', root).textContent = `${rate}×`;
  fit = ls.get('fit', 'contain');
  $('#stage', root).dataset.fit = fit;
  loop = ls.get('loop', false);
  $('#bLoop', root).setAttribute('aria-pressed', String(loop));

  const scrub = $('#scrub', root);
  const tip = $('#tip', root);
  const at = (e) => { const r = $('.scrub-track', scrub).getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1) * dur(); };
  let drag = false;
  scrub.addEventListener('pointerdown', (e) => { drag = true; scrub.setPointerCapture(e.pointerId); seekTo(at(e)); });
  scrub.addEventListener('pointermove', (e) => {
    const t = at(e);
    tip.classList.remove('hide'); tip.textContent = fmtTc(t, fps(cur()));
    const r = scrub.getBoundingClientRect();
    tip.style.left = `${clamp(e.clientX - r.left, 24, r.width - 24)}px`;
    if (drag) seekTo(t);
  });
  scrub.addEventListener('pointerup', () => { drag = false; });
  scrub.addEventListener('pointerleave', () => { tip.classList.add('hide'); });
  scrub.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') stepFrame(-1, e.shiftKey); if (e.key === 'ArrowRight') stepFrame(1, e.shiftKey); });

  wireFolderControls(root, on);
  on(root, 'click', '#aiAdd', () => openAddAi({ key }));
  on(root, 'click', '[data-compare-ai]', (e, b) => window.kitGo('compare', key, b.dataset.compareAi));
  on(root, 'click', '#bPlay', togglePlay);
  on(root, 'click', '#bBack', () => stepFrame(-1));
  on(root, 'click', '#bFwd', () => stepFrame(1));
  on(root, 'click', '#bLoop', (e, b) => { loop = !loop; ls.set('loop', loop); b.setAttribute('aria-pressed', String(loop)); if (loop && (inP == null || outP == null)) toast('Set in (I) and out (O) points, then the loop plays between them.'); });
  on(root, 'click', '#bCompare', toggleCompare);
  const setFocus = (on_) => { ls.set('focus', on_); $('.review', root).classList.toggle('focus', on_); $('#bFocus', root).setAttribute('aria-pressed', String(on_)); };
  setFocus(ls.get('focus', false));
  on(root, 'click', '#bFocus', () => setFocus(!ls.get('focus', false)));
  on(root, 'click', '#bFit', () => { fit = fit === 'contain' ? 'cover' : 'contain'; ls.set('fit', fit); $('#stage', root).dataset.fit = fit; });
  on(root, 'click', '#bFull', () => $('#stage', root).requestFullscreen?.());
  on(root, 'click', '#bMute', (e, b) => { A.muted = !A.muted; ls.set('muted', A.muted); mount(b, icon(A.muted ? 'mute' : 'volume')); });
  on(root, 'click', '#bSpeed', (e, b) => openMenu(b, [0.25, 0.5, 1, 1.5, 2, 4].map((r) => ({ label: `${r}×`, checked: r === rate, onClick: () => setRate(r) }))));

  // navigator
  on(root, 'click', '[data-nav-shot]', (e, b) => window.kitGo('review', b.dataset.navShot));
  on(root, 'click', '[data-nav-scene]', (e, b) => { const id = b.dataset.navScene; if (navOpen.has(id)) navOpen.delete(id); else navOpen.add(id); $('#rvNav', root).dataset.touched = '1'; renderNav(); });
  on(root, 'change', '#navUnrated', (e, i) => { ls.set('unrated', i.checked); renderNav(); });
  on(root, 'click', '#prevShot', () => stepShot(-1));
  on(root, 'click', '#renameMenu', (e, b) => {
    const c = cur();
    if (!c || c.kind !== 'shot') return;
    const after = (changes) => { const mine = changes.find((x) => x.key === c.key); if (mine) window.kitGo('review', mine.newKey); };
    const shotTakes = takesOfShot(c.scene, c.shot);
    const sceneTakes = takesOfScene(c.scene);
    openMenu(b, [
      { label: 'This take…', icon: 'pencil', onClick: () => openRenameTakes([c.key], { afterRename: after }) },
      { label: `Whole shot ${c.scene}.${c.shot} (${plural(shotTakes.length, 'take')})…`, icon: 'layers', onClick: () => openRenameTakes(shotTakes.map((x) => x.key), { title: `Rename shot ${c.scene}.${c.shot}`, afterRename: after }) },
      { label: `Whole scene ${c.scene} (${plural(sceneTakes.length, 'take')})…`, icon: 'board', onClick: () => openRenameTakes(sceneTakes.map((x) => x.key), { title: `Rename scene ${c.scene}`, afterRename: after }) },
      { label: aiReady() ? `Check this name with ${aiName()}…` : 'Check this name with AI (add a key in Settings)', icon: 'bolt', disabled: !aiReady(), onClick: () => openSlateReader({ keys: [c.key], force: true, title: `Check ${c.scene}.${c.shot} take ${c.take}` }) },
    ], { align: 'end' });
  });
  on(root, 'click', '#nextShot', () => stepShot(1));

  // takes strip
  on(root, 'click', '[data-take]', (e, b) => {
    const k = b.dataset.take;
    if (compareKey && !e.shiftKey && k !== key) { compareKey = k; setCompare(true, k); return; }
    if (k !== key) window.kitGo('review', k);
  });

  // inspector
  on(root, 'click', '[data-rate]', (e, b) => rate_(b.dataset.rate));
  on(root, 'click', '#printBtn', print_);
  on(root, 'click', '#setIn', () => { inP = A.currentTime; if (outP != null && outP <= inP) outP = null; renderInspector(); paintLayer(); });
  on(root, 'click', '#setOut', () => { outP = A.currentTime; if (inP != null && inP >= outP) inP = null; renderInspector(); paintLayer(); });
  on(root, 'click', '#addCut', addCut);
  on(root, 'click', '[data-seek]', (e, b) => {
    seekTo(parseFloat(b.dataset.seek));
    if (b.dataset.out) { inP = parseFloat(b.dataset.seek); outP = parseFloat(b.dataset.out); loop = true; ls.set('loop', true); $('#bLoop', root).setAttribute('aria-pressed', 'true'); renderInspector(); paintLayer(); A.play().catch(() => {}); }
  });
  on(root, 'click', '[data-del-cut]', (e, b) => { const cuts = cur().cutRanges.filter((r) => r.id !== b.dataset.delCut); saveMeta({ cuts }, { local: { cutRanges: cuts } }); renderInspector(); paintLayer(); });
  on(root, 'click', '[data-del-mark]', (e, b) => { const marks = cur().marks.filter((m) => m.id !== b.dataset.delMark); saveMeta({ marks }, { local: { marks } }); renderInspector(); paintLayer(); });
  on(root, 'click', '#sendCanvas', sendToCanvas);
  on(root, 'click', '#cutOnly', cutOnly);
  on(root, 'click', '#nameIt', () => window.kitGo('ingest', key));
  on(root, 'click', '#reveal', () => post('/api/reveal', { key }).catch(toastError));
  on(root, 'click', '#copyName', async () => { if (await copyText(cur().name)) toast('File name copied.'); });
  root.addEventListener('input', (e) => {
    if (e.target.id === 'noteBox') { cur().note = e.target.value; notes(e.target.value); }
    if (e.target.dataset.cutLabel) { const c = cur(); const cuts = c.cutRanges.map((r) => (r.id === e.target.dataset.cutLabel ? { ...r, label: e.target.value } : r)); c.cutRanges = cuts; labelSave(cuts); }
  });
}
const labelSave = debounce((cuts) => saveMeta({ cuts }, { local: { cutRanges: cuts } }), 500);

function onKey(e) {
  if (!root || !root.isConnected) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) { if (!(e.key === 'Escape')) return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (document.querySelector('.scrim')) return;
  const k = e.key;
  const handled = () => { e.preventDefault(); e.stopPropagation(); };
  switch (k) {
    case ' ': case 'k': case 'K': handled(); togglePlay(); break;
    case 'l': case 'L': handled(); faster(); break;
    case 'j': case 'J': handled(); slower(); break;
    case 'ArrowLeft': handled(); stepFrame(-1, e.shiftKey); break;
    case 'ArrowRight': handled(); stepFrame(1, e.shiftKey); break;
    case 'i': case 'I': handled(); $('#setIn', root).click(); break;
    case 'o': case 'O': handled(); $('#setOut', root).click(); break;
    case 'Enter': handled(); addCut(); break;
    case 'm': case 'M': handled(); dropMarker(); break;
    case '1': handled(); rate_('void'); break;
    case '2': handled(); rate_('ok'); break;
    case '3': handled(); rate_('good'); break;
    case 'p': case 'P': handled(); print_(); break;
    case '[': handled(); stepTake(-1); break;
    case ']': handled(); stepTake(1); break;
    case '{': handled(); stepShot(-1); break;
    case '}': handled(); stepShot(1); break;
    case 'PageUp': handled(); stepTake(-1); break;
    case 'PageDown': handled(); stepTake(1); break;
    case 'c': case 'C': handled(); toggleCompare(); break;
    case 'f': case 'F': handled(); $('#stage', root).requestFullscreen?.(); break;
    case 't': case 'T': handled(); $('#bFocus', root).click(); break;
    case 's': case 'S': handled(); sendToCanvas(); break;
    default: break;
  }
}

function pickInitialKey() {
  const last = ls.get('last', null);
  if (last && clip(last)) return last;
  for (const sc of scenes()) for (const sh of sc.shots) if (sh.status === 'shot') return sh.takes[0];
  const first = clips().find((c) => c.kind === 'shot') || clips()[0];
  return first ? first.key : null;
}

function load(k) {
  if (k === key && A && A.src) { renderAll(); return; }
  stopReverse();
  const target = clip(k);
  if (S.filters.folder && target && !inFolder(target.dir)) setFolderFilter('');
  key = k;
  ls.set('last', k);
  inP = outP = null;
  if (compareKey === k) compareKey = null;
  const takes = shotTakes();
  if (compareKey && !takes.some((t) => t.key === compareKey)) setCompare(false);
  renderAll();
  paintLayer();
  startPlayback();
}

function renderAll() { renderNav(); renderHead(); renderStrip(); renderInspector(); paintInfo(); }

export default {
  flush: true,
  mount(el, args) {
    root = el;
    el.addEventListener('toggle', (e) => { if (e.target.id === 'fileFold') fileOpen = e.target.open; }, true);
    const k = args[0] && clip(args[0]) ? args[0] : pickInitialKey();
    if (!k) { mount(el, html`<div class="app-empty" style="height:100%"><div class="app-empty-title">Nothing to review yet</div><div class="app-empty-body">Name your raw clips in Ingest, or add your footage folder in Settings.</div><a class="app-btn app-btn--outline" href="#/ingest">Open Ingest</a></div>`); return; }
    if (args[0] !== k) { location.replace(`#/review/${encodeURIComponent(k)}`); }
    mount(el, SKELETON);
    bindPlayer();
    docKey = onKey; document.addEventListener('keydown', docKey, true);
    docProxy = (e) => { if (e.detail.key === key) startPlayback(); if (compareKey && e.detail.key === compareKey) loadB(); };
    document.addEventListener('kit:proxy', docProxy);
    unsubJobs = subscribeJobs(() => { if (pending) { const job = S.jobs.find((j) => j.id === pending.jobId); if (job && job.state === 'error') setOverlay(html`<div class="ovl-card err">${icon('alert')}<div><b>Couldn’t prepare a review copy</b><div class="muted">${job.error}</div></div></div>`); else setOverlay(pendingOverlay()); } });
    raf = requestAnimationFrame(tick);
    key = null;
    load(k);
  },
  onArgs(args) { if (!root || !root.querySelector('.review')) { this.mount(root, args); return; } const k = args[0] && clip(args[0]) ? args[0] : key; if (k) load(k); },
  update() {
    if (!root || !root.querySelector('.review')) return;
    if (key && !clip(key)) { const k = pickInitialKey(); if (k) { window.kitGo('review', k); } return; }
    renderAll(); paintLayer();
  },
  unmount() {
    cancelAnimationFrame(raf); stopReverse();
    if (A) { A.pause(); A.removeAttribute('src'); A.load(); }
    if (B) { B.pause(); B.removeAttribute('src'); B.load(); }
    if (docKey) document.removeEventListener('keydown', docKey, true);
    if (docProxy) document.removeEventListener('kit:proxy', docProxy);
    if (unsubJobs) unsubJobs();
    root = A = B = null; key = null; compareKey = null; pending = null; pbInfo = null;
  },
};
