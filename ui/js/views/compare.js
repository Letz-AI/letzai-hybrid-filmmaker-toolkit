// Compare: the real take next to the AI version of it, with a slider (or side by side, fade, difference).
// The AI clip is the timeline. The original follows it, starting at the point of the take the AI clip was made from.
import { html, icon, mount, on, $, fmtDur, fmtTc, clamp, plural, debounce } from '../lib.js';
import { get, post } from '../api.js';
import { S, clip, allClips } from '../store.js';
import { toast, toastError, openMenu } from '../ui.js';
import { openAddAi } from '../aiadd.js';

const ls = {
  get(k, d) { try { const v = localStorage.getItem(`compare.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`compare.${k}`, JSON.stringify(v)); } catch { /* ignore */ } },
};

const MODES = [['wipe', 'Slider', 'Slider: drag the divider, original on one side, AI on the other (1)'], ['side', 'Side', 'Side by side: both next to each other (2)'], ['fade', 'Fade', 'Cross-fade between them (3)'], ['diff', 'Diff', 'Difference: shows what changed, brightened (4)']];

let root; let vO; let vA;
let key = null; let aiId = null;
let mode = 'wipe'; let pos = 50; let swap = false; let loop = true; let fit = 'contain';
let rate = 1; let raf = 0;
let pend = { orig: null, ai: null };
let docKey = null; let docProxy = null;
let tok = 0;

const cur = () => (key ? clip(key) : null);
const rec = () => { const c = cur(); return c ? (c.ai || []).find((a) => a.id === aiId) || null : null; };
const enc = encodeURIComponent;
const origFps = () => (cur() && cur().probe && cur().probe.fps) || 30;
const aiFps = () => (rec() && rec().fps) || origFps();
const aiDur = () => (vA && isFinite(vA.duration) && vA.duration > 0 ? vA.duration : (rec() && rec().duration) || 0);
const withAi = () => allClips().filter((c) => c.kind === 'shot' && c.ai && c.ai.length);

/** Where each snippet of a take starts, for the "made from snippet N" picker. */
function snippetStarts(c) {
  const max = Number(S.info.project.snippets.maxSeconds) || 30;
  if (c.cutRanges && c.cutRanges.length) return c.cutRanges.map((r) => r.in);
  const n = Math.max(1, Math.ceil((c.duration || 0) / max - 1e-9));
  return Array.from({ length: n }, (_, i) => i * max);
}

const SKELETON = html`
  <div class="review cmp">
    <aside class="rv-nav" id="cmpNav" aria-label="Takes with AI results"></aside>
    <section class="rv-center">
      <div class="rv-head" id="cmpHead"></div>
      <div class="cmp-stage" id="cmpStage" data-mode="wipe">
        <div class="cmp-layer" id="layOrig"><video id="vO" muted playsinline preload="auto"></video><span class="cmp-tag" id="tagO">Original</span></div>
        <div class="cmp-layer" id="layAi"><video id="vA" playsinline preload="auto"></video><span class="cmp-tag" id="tagA">AI</span></div>
        <div class="cmp-handle" id="cmpHandle" role="slider" tabindex="0" aria-label="Comparison divider" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"><span class="cmp-grip">${icon('chevronLeft', 12)}${icon('chevronRight', 12)}</span></div>
        <div class="stage-overlay hide" id="cmpOvl"></div>
      </div>
      <div class="transport">
        <div class="scrub" id="cmpScrub" role="slider" aria-label="Seek" tabindex="0"><div class="scrub-track"><div class="scrub-fill" id="cmpFill"></div><div class="scrub-head" id="cmpPh"></div></div><div class="scrub-tip hide" id="cmpTip"></div></div>
        <div class="tbar">
          <button class="app-icon-btn" id="cBack" title="Previous frame (←)">${icon('stepBack')}</button>
          <button class="app-icon-btn tplay" id="cPlay" title="Play / pause (Space)">${icon('play')}</button>
          <button class="app-icon-btn" id="cFwd" title="Next frame (→)">${icon('stepForward')}</button>
          <div class="tc tnum" id="cTc">00:00:00 <span class="faint">/ 00:00:00</span></div>
          <span class="grow"></span>
          <input type="range" id="cFade" min="0" max="100" value="50" class="hide" aria-label="Original to AI" style="width:160px">
          <div class="app-segmented sm" id="cModes" role="radiogroup" aria-label="Comparison mode">${MODES.map(([id, label, tip]) => html`<button role="radio" aria-checked="false" data-cm="${id}" title="${tip}">${label}</button>`)}</div>
          <button class="app-icon-btn" id="cSwap" title="Swap sides (S)">${icon('regenerate')}</button>
          <button class="app-btn app-btn--sm" id="cSpeed" title="Speed">1×</button>
          <button class="app-icon-btn" id="cLoop" title="Loop" aria-pressed="true">${icon('loop')}</button>
          <button class="app-icon-btn" id="cFit" title="Fit the whole frame / fill the stage">${icon('layers')}</button>
          <button class="app-icon-btn" id="cFull" title="Full screen (F)">${icon('expand')}</button>
        </div>
      </div>
      <div class="strip" id="cmpStrip"></div>
    </section>
    <aside class="rv-insp" id="cmpInsp" aria-label="AI result details"></aside>
  </div>`;

// ---- side panels -------------------------------------------------------------------------------
function renderNav() {
  const list = withAi();
  const groups = new Map();
  for (const c of list) { const g = `${c.scene}.${c.shot}`; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(c); }
  mount($('#cmpNav', root), html`
    <div class="nav-head"><div class="row"><span class="grow rail-label" style="padding:0">Compared takes</span><span class="faint tnum">${list.length}</span></div>
      <button class="app-btn app-btn--primary" id="cAdd" style="width:100%;margin-top:8px">${icon('plus')}<span>Add AI results…</span></button></div>
    <div class="nav-tree">
      ${[...groups.entries()].map(([g, takes]) => html`<div class="nav-scene"><div class="nav-scene-h" style="cursor:default"><span>Shot ${g}</span></div>
        ${takes.map((c) => html`<button class="nav-shot ${c.key === key ? 'active' : ''}" data-ct="${c.key}"><span class="tnum nav-id">T${c.take}</span><span class="grow nav-desc">${c.ai.length === 1 ? c.ai[0].label : `${c.ai.length} AI results`}</span>${c.ai.some((a) => a.missing) ? html`<span class="app-chip xs app-chip--warning">missing</span>` : html`<span class="faint tnum">${c.ai.length}</span>`}</button>`)}</div>`)}
      ${list.length ? '' : html`<div class="faint" style="padding:14px">No takes yet. Add the videos you generated and say which take each one came from.</div>`}
    </div>`);
}

function renderHead() {
  const c = cur();
  const a = rec();
  mount($('#cmpHead', root), c ? html`
    <div class="grow"><div class="rv-title"><span class="tnum">${c.scene}.${c.shot}</span> <span class="muted">take ${c.take}</span> <span class="faint" style="font-weight:400">vs</span> <span>${a ? a.label : 'AI'}</span></div>
      <div class="faint" style="font-size:12px">${a ? `AI clip ${fmtDur(aiDur())}${a.width ? ` · ${a.width}×${a.height}` : ''} · made from ${fmtTc(a.originalStart || 0, origFps())} of the take` : ''}</div></div>
    <button class="app-btn app-btn--sm" id="cReview" title="Open this take in Review">${icon('review', 14)}<span>Open in Review</span></button>` : '');
}

function renderStrip() {
  const c = cur();
  mount($('#cmpStrip', root), c ? html`${c.ai.map((a, i) => html`<button class="take ${a.id === aiId ? 'active' : ''}" data-ca="${a.id}" title="${a.name}">
      <span class="take-img cmp-chip-img">${icon(a.kind === 'url' ? 'cloud' : 'video', 24)}</span>
      <span class="take-b">${String.fromCharCode(65 + i)}</span>
      ${a.missing ? html`<span class="take-top"><span class="app-chip on-media xs app-chip--warning">missing</span></span>` : ''}
      <span class="take-bot"><b class="ellipsis">${a.label}</b><span class="tnum">${fmtDur(a.duration)}</span></span></button>`)}` : '');
}

function renderInsp() {
  const c = cur();
  const a = rec();
  const el = $('#cmpInsp', root);
  if (!c || !a) { mount(el, html`<div class="app-empty"><div class="app-empty-title">Pick an AI result</div></div>`); return; }
  const starts = snippetStarts(c);
  const match = starts.findIndex((s) => Math.abs(s - (a.originalStart || 0)) < 0.05);
  const ae = document.activeElement;
  const keepLabel = ae && ae.id === 'iLabel' ? ae.value : null;
  const keepNote = ae && ae.id === 'iNote' ? ae.value : null;
  mount(el, html`
    <div class="insp-sec">
      <div class="insp-label">AI result</div>
      <input class="app-input" id="iLabel" value="${a.label}" maxlength="80" aria-label="Label">
      <div class="faint" style="font-size:12px;margin-top:6px;word-break:break-all">${a.kind === 'file' ? a.path : html`From your canvas <a href="${a.url}" target="_blank" rel="noopener">${icon('external', 12)}</a>`}</div>
      ${a.missing ? html`<div class="app-alert app-alert--warning" style="margin-top:10px">${icon('warn')}<div class="grow"><b>The file is missing</b>It was moved or deleted. Put it back, or remove this result and add it again.</div></div>` : ''}
    </div>
    <div class="insp-sec">
      <div class="insp-label">Where it lines up</div>
      <div class="faint" style="font-size:12px;margin-bottom:8px">The AI clip usually comes from a piece of the take. Say where that piece starts, so both play in step.</div>
      <div class="row" style="gap:8px"><input class="app-input tnum" id="iStart" type="number" min="0" step="0.04" value="${(a.originalStart || 0).toFixed(2)}" style="width:96px" aria-label="Starts at, in seconds"><span class="muted">seconds into the take</span></div>
      <div class="row" style="gap:6px;margin-top:8px"><span class="faint" style="font-size:12px">Nudge</span>
        <button class="app-btn app-btn--sm" id="nudgeBack" title="Original one frame earlier">${icon('chevronLeft', 14)} frame</button>
        <button class="app-btn app-btn--sm" id="nudgeFwd" title="Original one frame later">frame ${icon('chevronRight', 14)}</button></div>
      ${starts.length > 1 || (c.cutRanges && c.cutRanges.length) ? html`<div class="app-field" style="margin-top:12px"><label for="iSnip">Made from snippet</label>
        <select class="app-input" id="iSnip"><option value="">Custom</option>${starts.map((s, i) => html`<option value="${i}" ${i === match ? 'selected' : ''}>Snippet ${i + 1} · starts ${fmtTc(s, origFps())}</option>`)}</select></div>` : ''}
    </div>
    <div class="insp-sec">
      <div class="insp-label">Note</div>
      <textarea class="app-input" id="iNote" rows="3" placeholder="What changed, what worked, what to try next…" spellcheck="true">${a.note || ''}</textarea>
    </div>
    <div class="insp-sec"><div class="row wrap" style="gap:8px">
      ${a.kind === 'file' ? html`<button class="app-btn app-btn--sm" id="iReveal">${icon('folder', 14)}<span>Show file</span></button>` : ''}
      <button class="app-btn app-btn--sm" id="iAddMore">${icon('plus', 14)}<span>Add another</span></button>
      <button class="app-btn app-btn--sm app-btn--danger" id="iRemove">${icon('trash', 14)}<span>Remove</span></button></div>
      <div class="faint" style="font-size:12px;margin-top:10px">Removing only forgets the mapping. The video file stays where it is.</div></div>
    <div class="insp-sec"><div class="insp-label">Keys</div><div class="faint" style="font-size:12px;line-height:1.9">
      <span class="kbd">Space</span> play <span class="kbd">←</span><span class="kbd">→</span> frame <span class="kbd">1</span>–<span class="kbd">4</span> mode <span class="kbd">S</span> swap sides <span class="kbd">[</span><span class="kbd">]</span> other AI result <span class="kbd">{</span><span class="kbd">}</span> other take</div></div>`);
  if (keepLabel != null) { const i = $('#iLabel', el); i.focus(); i.value = keepLabel; }
  if (keepNote != null) { const i = $('#iNote', el); i.focus(); i.value = keepNote; }
}

// ---- layout of the two pictures ---------------------------------------------------------------------
function applyLayout() {
  const stage = $('#cmpStage', root);
  stage.dataset.mode = mode;
  stage.dataset.fit = fit;
  const lo = $('#layOrig', root); const la = $('#layAi', root);
  const leftEl = swap ? la : lo; const rightEl = swap ? lo : la;
  for (const el of [lo, la]) { el.style.clipPath = ''; el.style.opacity = ''; el.style.order = ''; el.style.zIndex = ''; el.classList.remove('diff'); }
  if (mode === 'wipe') { rightEl.style.zIndex = 1; leftEl.style.zIndex = 2; leftEl.style.clipPath = `inset(0 ${100 - pos}% 0 0)`; }
  else if (mode === 'side') { leftEl.style.order = 1; rightEl.style.order = 2; }
  else if (mode === 'fade') { leftEl.style.zIndex = 1; rightEl.style.zIndex = 2; rightEl.style.opacity = String(pos / 100); }
  else { leftEl.style.zIndex = 1; rightEl.style.zIndex = 2; rightEl.classList.add('diff'); }
  const h = $('#cmpHandle', root);
  h.classList.toggle('hide', mode !== 'wipe');
  h.style.left = `${pos}%`;
  h.setAttribute('aria-valuenow', String(Math.round(pos)));
  // the tag of whatever is on the right-hand side sits at the right edge, so the divider never clips it away
  $('#tagO', root).classList.toggle('right', mode !== 'side' && swap);
  $('#tagA', root).classList.toggle('right', mode !== 'side' && !swap);
  // names on the tags
  $('#tagO', root).textContent = 'Original';
  $('#tagA', root).textContent = (rec() && rec().label) || 'AI';
  $('#tagO', root).classList.toggle('hide', mode === 'diff');
  $('#tagA', root).classList.toggle('hide', mode === 'diff');
  const fade = $('#cFade', root);
  fade.classList.toggle('hide', mode !== 'fade');
  fade.value = String(pos);
  root.querySelectorAll('[data-cm]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.cm === mode)));
  $('#cLoop', root).setAttribute('aria-pressed', String(loop));
}

function setPos(p) { pos = clamp(p, 0, 100); applyLayout(); }

// ---- loading the two videos ---------------------------------------------------------------------------
function overlay(content) {
  const o = $('#cmpOvl', root);
  if (!content) { o.classList.add('hide'); o.innerHTML = ''; return; }
  o.classList.remove('hide');
  mount(o, content);
}
function refreshOverlay() {
  const waiting = [pend.orig && 'the original', pend.ai && 'the AI result'].filter(Boolean);
  if (waiting.length) overlay(html`<div class="ovl-card"><span class="spinner"></span><div><b>Preparing a playback copy of ${waiting.join(' and ')}</b><div class="muted">A smaller copy is being made so your browser can play it. This only happens once.</div></div></div>`);
  else overlay(null);
}

async function loadOriginal(my) {
  try {
    const r = await get(`/api/playback?key=${enc(key)}&hevc=${S.hevc ? 1 : 0}`);
    if (my !== tok) return;
    if (r.pending) { pend.orig = { jobId: r.jobId }; vO.removeAttribute('src'); vO.load(); refreshOverlay(); return; }
    pend.orig = null; vO.src = r.url; vO.load(); refreshOverlay();
  } catch (e) { overlay(html`<div class="ovl-card err">${icon('alert')}<div><b>Can’t load the original</b><div class="muted">${e.message}</div></div></div>`); }
}
async function loadAi(my) {
  try {
    const r = await get(`/api/ai/playback?key=${enc(key)}&id=${enc(aiId)}&hevc=${S.hevc ? 1 : 0}`);
    if (my !== tok) return;
    if (r.pending) { pend.ai = { jobId: r.jobId }; vA.removeAttribute('src'); vA.load(); refreshOverlay(); return; }
    pend.ai = null; vA.src = r.url; vA.load(); refreshOverlay();
  } catch (e) { overlay(html`<div class="ovl-card err">${icon('alert')}<div><b>Can’t load the AI result</b><div class="muted">${e.message}</div></div></div>`); }
}
function loadBoth() {
  const my = ++tok;
  vA.pause(); vO.pause(); playIcon();
  pend = { orig: null, ai: null };
  overlay(null);
  if (!key || !aiId) return;
  loadOriginal(my); loadAi(my);
}

// ---- keeping the original in step with the AI clip -----------------------------------------------------
function playIcon() { mount($('#cPlay', root), icon(vA && !vA.paused ? 'pause' : 'play')); }

function tick() {
  raf = requestAnimationFrame(tick);
  if (!vA || !vO) return;
  const a = rec();
  if (a && vO.readyState > 0) {
    const target = (a.originalStart || 0) + (vA.currentTime || 0);
    const drift = Math.abs(vO.currentTime - target);
    if (drift > (vA.paused ? 0.02 : 0.2)) { try { vO.currentTime = target; } catch { /* not ready */ } }
    if (vA.paused !== vO.paused) { if (vA.paused) vO.pause(); else vO.play().catch(() => {}); }
    vO.playbackRate = vA.playbackRate;
  }
  const d = aiDur();
  const t = vA.currentTime || 0;
  $('#cTc', root).innerHTML = `${fmtTc(t, aiFps())} <span class="faint">/ ${fmtTc(d, aiFps())}</span>`;
  const pct = d ? clamp(t / d, 0, 1) * 100 : 0;
  $('#cmpFill', root).style.width = `${pct}%`;
  $('#cmpPh', root).style.left = `${pct}%`;
}

function seek(t) {
  if (!vA) return;
  vA.currentTime = clamp(t, 0, aiDur() || t);
  const a = rec();
  if (a && vO.readyState > 0) { try { vO.currentTime = (a.originalStart || 0) + vA.currentTime; } catch { /* not ready */ } }
}
function step(dir, big) {
  vA.pause(); playIcon();
  seek(big ? vA.currentTime + dir : (Math.round(vA.currentTime * aiFps()) + dir) / aiFps() + 0.0004);
}
function togglePlay() {
  if (!vA || !vA.src) return;
  if (vA.paused) { if (aiDur() && vA.currentTime >= aiDur() - 0.05) seek(0); vA.play().catch(() => {}); } else vA.pause();
}
function setRate(r) { rate = r; vA.playbackRate = r; vO.playbackRate = r; $('#cSpeed', root).textContent = `${r}×`; }

// ---- data changes ----------------------------------------------------------------------------------------
const savePatch = debounce(async (patchBody) => {
  try { await post('/api/ai/update', { key, id: aiId, patch: patchBody }); } catch (e) { toastError(e); }
}, 400);

function setStart(v) {
  const a = rec(); if (!a) return;
  a.originalStart = Math.max(0, Number(v) || 0);
  savePatch({ originalStart: a.originalStart });
  const i = $('#iStart', root); if (i && document.activeElement !== i) i.value = a.originalStart.toFixed(2);
  renderHead();
}

// ---- opening a take / a result ----------------------------------------------------------------------------
function chooseInitial(args) {
  const list = withAi();
  const k = args[0] && clip(args[0]) && clip(args[0]).ai && clip(args[0]).ai.length ? args[0] : (ls.get('last', null) && clip(ls.get('last')) && clip(ls.get('last')).ai && clip(ls.get('last')).ai.length ? ls.get('last') : (list[0] && list[0].key));
  if (!k) return { k: null, id: null };
  const c = clip(k);
  const id = args[1] && c.ai.some((a) => a.id === args[1]) ? args[1] : c.ai[0].id;
  return { k, id };
}

function open(k, id) {
  key = k; aiId = id;
  if (k) ls.set('last', k);
  renderNav(); renderHead(); renderStrip(); renderInsp(); applyLayout();
  loadBoth();
}

// ---- empty state -----------------------------------------------------------------------------------------------
function emptyState() {
  mount(root, html`<div class="app-empty" style="height:100%;gap:12px">
    <div class="cmp-empty-ic">${icon('compare', 24)}</div>
    <div class="app-empty-title">Compare the real take with the AI version</div>
    <div class="app-empty-body">Add the videos you generated and say which take each one came from. Then drag a slider between the original and the result, or put them side by side, fade between them, or see the difference.</div>
    <button class="app-btn app-btn--primary" id="cAddFirst">${icon('plus')}<span>Add AI results…</span></button>
    <div class="faint" style="font-size:12px;max-width:52ch">Files on your computer or videos already on your LetzAI canvas both work. Name your clips first (Ingest) so there is a take to map them to.</div></div>`);
  on(root, 'click', '#cAddFirst', () => openAddAi({}));
}

export default {
  flush: true,
  mount(el, args) {
    root = el;
    const { k, id } = chooseInitial(args);
    if (!k) { emptyState(); return; }
    if (args[0] !== k || args[1] !== id) location.replace(`#/compare/${enc(k)}/${enc(id)}`);
    mount(el, SKELETON);
    vO = $('#vO', el); vA = $('#vA', el);
    mode = ls.get('mode', 'wipe'); swap = ls.get('swap', false); loop = ls.get('loop', true); fit = ls.get('fit', 'contain'); pos = ls.get('pos', 50); rate = 1;
    bind();
    docKey = onKey; document.addEventListener('keydown', docKey, true);
    docProxy = (e) => { if (e.detail.key === key) loadOriginal(tok); if (e.detail.key === `ai:${aiId}`) loadAi(tok); };
    document.addEventListener('kit:proxy', docProxy);
    raf = requestAnimationFrame(tick);
    open(k, id);
  },
  onArgs(args) {
    if (!root || !root.querySelector('.cmp')) { this.mount(root, args); return; }
    const { k, id } = chooseInitial(args);
    if (k) open(k, id);
  },
  update() {
    if (!root) return;
    if (!root.querySelector('.cmp')) { if (withAi().length) this.mount(root, []); return; }
    const c = cur();
    if (!c || !c.ai.length) { const { k, id } = chooseInitial([]); if (k) window.kitGo('compare', k, id); else { this.unmount(); emptyState(); } return; }
    if (!c.ai.some((a) => a.id === aiId)) { window.kitGo('compare', key, c.ai[0].id); return; }
    renderNav(); renderHead(); renderStrip(); renderInsp(); applyLayout();
  },
  unmount() {
    cancelAnimationFrame(raf);
    if (vA) { vA.pause(); vA.removeAttribute('src'); vA.load(); }
    if (vO) { vO.pause(); vO.removeAttribute('src'); vO.load(); }
    if (docKey) document.removeEventListener('keydown', docKey, true);
    if (docProxy) document.removeEventListener('kit:proxy', docProxy);
    root = vO = vA = null; key = aiId = null; pend = { orig: null, ai: null };
  },
};

// ---- wiring ------------------------------------------------------------------------------------------------------
function bind() {
  vA.addEventListener('play', playIcon); vA.addEventListener('pause', playIcon);
  vA.addEventListener('loadedmetadata', () => {
    const a = rec();
    if (a && !a.duration && isFinite(vA.duration)) { a.duration = vA.duration; savePatch({ duration: vA.duration }); }
    renderHead(); renderStrip();
    seek(0);
  });
  vO.addEventListener('loadedmetadata', () => { const a = rec(); if (a) { try { vO.currentTime = a.originalStart || 0; } catch { /* ignore */ } } });
  vA.addEventListener('ended', () => { if (loop) { seek(0); vA.play().catch(() => {}); } else playIcon(); });
  const failure = (what) => () => { if (!(what === 'original' ? vO : vA).getAttribute('src')) return; overlay(html`<div class="ovl-card err">${icon('alert')}<div><b>This browser can’t play the ${what}</b><div class="muted">${what === 'AI result' ? 'If it came from your canvas, the link may have expired. Add it again from the canvas.' : 'Try a Chromium based browser, or wait for the playback copy to finish.'}</div></div></div>`); };
  vA.addEventListener('error', failure('AI result')); vO.addEventListener('error', failure('original'));
  vA.addEventListener('canplay', () => { if (!pend.ai && !pend.orig) overlay(null); });
  vO.muted = true;
  vA.volume = ls.get('volume', 1); vA.muted = ls.get('muted', false);

  // the divider: drag anywhere on the picture (slider mode), or use the keys when it has focus
  const stage = $('#cmpStage', root);
  let drag = false;
  const at = (e) => { const r = stage.getBoundingClientRect(); return ((e.clientX - r.left) / r.width) * 100; };
  stage.addEventListener('pointerdown', (e) => { if (mode !== 'wipe' || e.button !== 0) return; drag = true; try { stage.setPointerCapture(e.pointerId); } catch { /* synthetic or unsupported pointer */ } setPos(at(e)); $('#cmpHandle', root).focus({ preventScroll: true }); });
  stage.addEventListener('pointermove', (e) => { if (drag) setPos(at(e)); });
  stage.addEventListener('pointerup', () => { drag = false; ls.set('pos', pos); });
  $('#cmpHandle', root).addEventListener('keydown', (e) => {
    const d = e.shiftKey ? 10 : 2;
    if (e.key === 'ArrowLeft' && mode === 'wipe') { e.preventDefault(); e.stopPropagation(); setPos(pos - d); ls.set('pos', pos); }
    if (e.key === 'ArrowRight' && mode === 'wipe') { e.preventDefault(); e.stopPropagation(); setPos(pos + d); ls.set('pos', pos); }
    if (e.key === 'Home') { setPos(0); } if (e.key === 'End') { setPos(100); }
  });
  $('#cFade', root).addEventListener('input', (e) => setPos(Number(e.target.value)));

  // timeline over the AI clip
  const scrub = $('#cmpScrub', root); const tip = $('#cmpTip', root);
  const tAt = (e) => { const r = $('.scrub-track', scrub).getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1) * aiDur(); };
  let sd = false;
  scrub.addEventListener('pointerdown', (e) => { sd = true; try { scrub.setPointerCapture(e.pointerId); } catch { /* synthetic or unsupported pointer */ } seek(tAt(e)); });
  scrub.addEventListener('pointermove', (e) => { const t = tAt(e); tip.classList.remove('hide'); tip.textContent = fmtTc(t, aiFps()); const r = scrub.getBoundingClientRect(); tip.style.left = `${clamp(e.clientX - r.left, 24, r.width - 24)}px`; if (sd) seek(t); });
  scrub.addEventListener('pointerup', () => { sd = false; }); scrub.addEventListener('pointerleave', () => tip.classList.add('hide'));

  on(root, 'click', '#cPlay', togglePlay);
  on(root, 'click', '#cBack', () => step(-1)); on(root, 'click', '#cFwd', () => step(1));
  on(root, 'click', '[data-cm]', (e, b) => { mode = b.dataset.cm; ls.set('mode', mode); applyLayout(); });
  on(root, 'click', '#cSwap', () => { swap = !swap; ls.set('swap', swap); applyLayout(); });
  on(root, 'click', '#cLoop', () => { loop = !loop; ls.set('loop', loop); applyLayout(); });
  on(root, 'click', '#cFit', () => { fit = fit === 'contain' ? 'cover' : 'contain'; ls.set('fit', fit); applyLayout(); });
  on(root, 'click', '#cFull', () => $('#cmpStage', root).requestFullscreen?.());
  on(root, 'click', '#cSpeed', (e, b) => openMenu(b, [0.25, 0.5, 1, 1.5, 2].map((r) => ({ label: `${r}×`, checked: r === rate, onClick: () => setRate(r) }))));
  on(root, 'click', '#cAdd', () => openAddAi({ key }));
  on(root, 'click', '#iAddMore', () => openAddAi({ key }));
  on(root, 'click', '#cReview', () => window.kitGo('review', key));
  on(root, 'click', '[data-ct]', (e, b) => window.kitGo('compare', b.dataset.ct));
  on(root, 'click', '[data-ca]', (e, b) => window.kitGo('compare', key, b.dataset.ca));
  on(root, 'click', '#nudgeBack', () => setStart((rec().originalStart || 0) - 1 / origFps()));
  on(root, 'click', '#nudgeFwd', () => setStart((rec().originalStart || 0) + 1 / origFps()));
  on(root, 'click', '#iReveal', () => post('/api/reveal', { path: rec().path }).catch(toastError));
  on(root, 'click', '#iRemove', async () => {
    const id = aiId;
    try { await post('/api/ai/remove', { key, id }); toast('Removed. The video file was not touched.', { type: 'success' }); } catch (e) { toastError(e); }
  });
  root.addEventListener('input', (e) => {
    const a = rec(); if (!a) return;
    if (e.target.id === 'iLabel') { a.label = e.target.value; savePatch({ label: e.target.value }); $('#tagA', root).textContent = e.target.value || 'AI'; }
    if (e.target.id === 'iNote') { a.note = e.target.value; savePatch({ note: e.target.value }); }
    if (e.target.id === 'iStart') setStart(e.target.value);
  });
  root.addEventListener('change', (e) => {
    if (e.target.id === 'iSnip' && e.target.value !== '') setStart(snippetStarts(cur())[Number(e.target.value)]);
  });
  setRate(1);
}

function onKey(e) {
  if (!root || !root.isConnected || !root.querySelector('.cmp')) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) { if (e.key !== 'Escape') return; }
  if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('.scrim')) return;
  const handled = () => { e.preventDefault(); e.stopPropagation(); };
  const c = cur();
  switch (e.key) {
    case ' ': case 'k': case 'K': handled(); togglePlay(); break;
    case 'ArrowLeft': handled(); step(-1, e.shiftKey); break;
    case 'ArrowRight': handled(); step(1, e.shiftKey); break;
    case '1': case '2': case '3': case '4': handled(); mode = MODES[Number(e.key) - 1][0]; ls.set('mode', mode); applyLayout(); break;
    case 's': case 'S': handled(); swap = !swap; ls.set('swap', swap); applyLayout(); break;
    case 'f': case 'F': handled(); $('#cmpStage', root).requestFullscreen?.(); break;
    case '[': case ']': {
      handled();
      if (!c) break;
      const i = c.ai.findIndex((a) => a.id === aiId) + (e.key === ']' ? 1 : -1);
      if (c.ai[i]) window.kitGo('compare', key, c.ai[i].id);
      break;
    }
    case '{': case '}': {
      handled();
      const list = withAi(); const i = list.findIndex((x) => x.key === key) + (e.key === '}' ? 1 : -1);
      if (list[i]) window.kitGo('compare', list[i].key);
      break;
    }
    default: break;
  }
}
