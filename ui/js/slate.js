// Reading slates with Claude: set up the key, confirm what is sent, watch it run, check the readings, apply the names.
// The same dialog serves unnamed clips (suggest names) and named takes (check that the names are right).
import { html, icon, mount, plural, fmtClock } from './lib.js';
import { get, post, put } from './api.js';
import { S, clip, loadLibrary, loadInfo, subscribeJobs } from './store.js';
import { openPopup, toast, toastError, field } from './ui.js';

export const CONSOLE_KEYS = 'https://console.anthropic.com/settings/keys';

const FLAG_TEXT = {
  low: 'Claude is not sure',
  partial: 'Only part of the slate could be read',
  taken: 'That take already exists',
  twice: 'Another clip was read as the same take',
  'not-in-plan': 'This scene is not in the shot list',
  order: 'Does not fit the recording order of the other takes',
};
const pct = (c) => `${Math.round((c || 0) * 100)}%`;
const slateOf = (k) => { const c = clip(k); return c && c.slate ? c.slate : null; };
const confident = (s) => s && s.status !== 'unreadable' && s.status !== 'match' && s.confidence >= 0.85 && !s.flags.length;
const readingText = (s) => `${s.scene} · ${s.shot} · take ${s.take}`;
export const hasReadings = (keys) => keys.some((k) => slateOf(k));

/** Readings that finish after the dialog was closed: say so, and offer to look at them. */
function watchLater(jobId, keys) {
  const un = subscribeJobs(() => {
    const j = S.jobs.find((x) => x.id === jobId);
    if (!j || j.state === 'queued' || j.state === 'running') return;
    un();
    loadLibrary().then(() => {
      if (j.state === 'canceled') return;
      toast(j.state === 'error' ? `Slate reading stopped: ${j.error}` : 'Slate reading finished.', { type: j.state === 'error' ? 'error' : 'success', timeout: 15000, link: hasReadings(keys) ? { text: 'Review', onClick: () => openReadings(keys) } : undefined });
    });
  });
}

/**
 * @param {{keys: string[], title?: string, force?: boolean, view?: string}} opts clips to read; force = read again even if already read; view 'results' only shows what was read before
 */
export async function openSlateReader({ keys, title = 'Read slates with Claude', force = false, view = '' } = {}) {
  if (!keys || !keys.length) { toast('Pick at least one clip.'); return; }
  let v;
  try { v = await get('/api/vision'); } catch (e) { toastError(e); return; }
  let again = !!force;
  let watching = null;
  const p = openPopup({ title, width: 780, body: html`<div></div>`, foot: html`<span></span>`, onClose: () => { if (watching) { watchLater(watching, keys); watching = null; } } });

  const alertBox = (msg) => html`<div class="app-alert app-alert--error">${icon('alert')}<div class="grow">${msg}</div></div>`;

  // 1. no key yet
  function stepSetup(msg) {
    mount(p.body, html`<div style="display:grid;gap:14px">
      <p class="muted" style="margin:0">Claude can read the slate (the <i>Klappe</i>) on each clip and suggest its scene, shot and take. It uses <b>your own</b> Anthropic API key, and the kit sends a few frames from each clip straight to Anthropic. Nothing is renamed until you say so.</p>
      ${field('Anthropic API key', html`<input class="app-input" id="slKey" type="password" placeholder="sk-ant-…" autocomplete="off" spellcheck="false">`, html`Create one in the <a href="${CONSOLE_KEYS}" target="_blank" rel="noopener">Anthropic Console</a>; the account needs some credit. The key is saved only on this computer, in a file only you can read.`)}
      <div id="slErr">${msg ? alertBox(msg) : ''}</div></div>`);
    mount(p.foot, html`<button class="app-btn" data-no>Cancel</button><button class="app-btn app-btn--primary" id="slSave">Save and test key</button>`);
    p.foot.querySelector('[data-no]').addEventListener('click', p.close);
    const input = p.body.querySelector('#slKey');
    const go = p.foot.querySelector('#slSave');
    const save = async () => {
      if (!input.value.trim()) { input.focus(); return; }
      go.disabled = true; go.textContent = 'Testing…';
      try { v = await post('/api/vision/test', { key: input.value.trim(), save: true, model: v.model }); await loadInfo(); stepConfirm(); } catch (e) { go.disabled = false; go.textContent = 'Save and test key'; mount(p.body.querySelector('#slErr'), alertBox(e.message)); }
    };
    go.addEventListener('click', save);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    input.focus();
  }

  // 2. what will be sent
  async function stepConfirm() {
    let est;
    try { est = await post('/api/slate/estimate', { keys, force: again }); } catch (e) { toastError(e); return; }
    const modelNote = (id) => (v.models.find((m) => m.id === id) || {}).note || '';
    mount(p.body, html`<div style="display:grid;gap:14px">
      <div><b>${est.clips ? `${plural(est.clips, 'clip')} will be read` : 'Nothing new to read'}</b>
        <div class="muted">${est.clips ? `About ${plural(est.frames, 'frame')} and ${Math.round(est.inputTokens / 1000)}k input tokens in all. Your Anthropic usage page shows the exact cost.` : 'Every clip here was read already.'}</div></div>
      ${est.skipped || again ? html`<label class="app-switch"><input type="checkbox" id="slAgain" ${again ? 'checked' : ''}><span>Read clips again that were read before${est.skipped ? html`<br><span class="faint">${plural(est.skipped, 'clip')} already ${est.skipped === 1 ? 'has' : 'have'} a reading and would be skipped.</span>` : ''}</span></label>` : ''}
      ${field('Model', html`<select class="app-input" id="slModel">${v.models.map((m) => html`<option value="${m.id}" ${m.id === v.model ? 'selected' : ''}>${m.label}</option>`)}</select>`, html`<span id="slModelNote">${modelNote(v.model)}</span>`)}
      <label class="app-switch"><input type="checkbox" id="slConsent" ${v.consent ? 'checked' : ''}><span>Send frames from my clips to Anthropic<br><span class="faint">Up to six pictures from the start of each clip (more only if no slate is found there), sent to api.anthropic.com with your key. File names are not sent. Anthropic’s own terms apply to what you send.</span></span></label>
      <div id="slErr"></div></div>`);
    mount(p.foot, html`${hasReadings(keys) ? html`<button class="app-btn" id="slSee">Review earlier readings</button>` : ''}<span class="grow"></span><button class="app-btn" data-no>Cancel</button><button class="app-btn app-btn--primary" id="slGo">${est.clips ? `Read ${plural(est.clips, 'clip')}` : 'Nothing to read'}</button>`);
    const go = p.foot.querySelector('#slGo');
    const consent = p.body.querySelector('#slConsent');
    const sync = () => { go.disabled = !est.clips || !consent.checked; };
    sync();
    consent.addEventListener('change', sync);
    p.body.querySelector('#slModel').addEventListener('change', (e) => { v.model = e.target.value; p.body.querySelector('#slModelNote').textContent = modelNote(v.model); });
    const ag = p.body.querySelector('#slAgain');
    if (ag) ag.addEventListener('change', () => { again = ag.checked; stepConfirm(); });
    p.foot.querySelector('[data-no]').addEventListener('click', p.close);
    const see = p.foot.querySelector('#slSee');
    if (see) see.addEventListener('click', () => stepResults());
    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        await put('/api/vision', { consent: true, model: v.model });
        const r = await post('/api/slate/read', { keys, force: again });
        stepRunning(r.job);
      } catch (e) {
        go.disabled = false;
        if (e.code === 'no-vision-key') { stepSetup(e.message); return; }
        mount(p.body.querySelector('#slErr'), alertBox(e.message));
      }
    });
  }

  // 3. working
  function stepRunning(jobId) {
    watching = jobId;
    mount(p.body, html`<div style="display:grid;gap:12px;padding:8px 0"><div class="row"><span class="spinner"></span><b id="slTitle">Reading slates…</b></div><div class="bar"><i id="slBar" style="width:0%"></i></div><div class="muted" id="slDetail"></div>
      <div class="faint" style="font-size:12px">You can close this and keep working. The readings are saved as they arrive, and you will get a message when it is done.</div></div>`);
    mount(p.foot, html`<button class="app-btn" id="slStop">Stop</button><span class="grow"></span><button class="app-btn app-btn--primary" id="slBg">Keep working</button>`);
    p.foot.querySelector('#slStop').addEventListener('click', () => post('/api/jobs/cancel', { id: jobId }).catch(toastError));
    p.foot.querySelector('#slBg').addEventListener('click', p.close);
    const un = subscribeJobs(() => {
      const j = S.jobs.find((x) => x.id === jobId);
      if (!j || !p.body.isConnected) { un(); return; }
      const bar = p.body.querySelector('#slBar');
      if (bar) { bar.style.width = `${Math.round(j.progress * 100)}%`; p.body.querySelector('#slDetail').textContent = j.detail || ''; }
      if (j.state === 'queued' || j.state === 'running') return;
      un(); watching = null;
      loadLibrary().then(() => { if (j.state !== 'canceled' || hasReadings(keys)) stepResults(j.state === 'error' ? j.error : ''); else p.close(); });
    });
  }

  // 4. check the readings, apply names
  function stepResults(problem) {
    const rows = keys.map((k) => ({ k, c: clip(k), s: slateOf(k) })).filter((r) => r.c);
    const todo = rows.filter((r) => r.s && r.s.status !== 'unreadable' && r.s.status !== 'match');
    const matching = rows.filter((r) => r.s && r.s.status === 'match');
    const unreadable = rows.filter((r) => r.s && r.s.status === 'unreadable');
    const unread = rows.filter((r) => !r.s);
    const state = new Map(todo.map((r) => [r.k, { on: confident(r.s) && r.s.status === 'new', scene: r.s.scene, shot: r.s.shot, take: String(r.s.take) }]));
    let showMatching = false;
    const frame = (r, w) => `/thumb?key=${encodeURIComponent(r.k)}&t=${(r.s.frameT || 0.5).toFixed(1)}&w=${w}`;

    const draw = () => {
      mount(p.body, html`<div style="display:grid;gap:12px">
        ${problem ? alertBox(problem) : ''}
        <div class="row wrap" style="gap:8px"><b>${todo.length ? plural(todo.length, 'suggestion') : 'No changes to suggest'}</b><span class="faint">${[matching.length && `${matching.length} already correct`, unreadable.length && `${unreadable.length} without a readable slate`, unread.length && `${unread.length} not read`].filter(Boolean).join(' · ')}</span></div>
        ${todo.length ? html`<div class="rename-list slate-list" style="max-height:400px">${todo.map((r) => { const st = state.get(r.k); return html`<div class="slate-row" data-row="${r.k}">
          <input type="checkbox" class="app-check" data-on="${r.k}" ${st.on ? 'checked' : ''} aria-label="Use this reading">
          <button class="mini-poster slate-poster" data-zoom="${r.k}" title="Look at the frame Claude read"><img loading="lazy" alt="" src="${frame(r, 240)}"></button>
          <span style="min-width:0"><span class="mono-name">${r.c.kind === 'shot' ? `${r.c.scene}.${r.c.shot} take ${r.c.take}` : (r.c.orig || r.c.name)}</span><div class="faint" style="font-size:11px">${[r.c.kind === 'shot' ? 'now named' : fmtClock(r.c.recordedAt), `slate says “${r.s.evidence || '…'}”`].filter(Boolean).join(' · ')}</div></span>
          <span class="faint">${icon('arrowRight', 14)}</span>
          <span class="row" style="gap:4px"><input class="app-input slt-in" data-f="scene" data-k="${r.k}" value="${st.scene}" aria-label="Scene" maxlength="6"><input class="app-input slt-in" data-f="shot" data-k="${r.k}" value="${st.shot}" aria-label="Shot" maxlength="6"><input class="app-input slt-in" data-f="take" data-k="${r.k}" value="${st.take}" aria-label="Take" maxlength="4" inputmode="numeric"></span>
          <span style="min-width:0"><span class="app-chip xs ${r.s.confidence >= 0.85 && !r.s.flags.length ? 'app-chip--success' : 'app-chip--warning'}">${pct(r.s.confidence)}</span>${r.s.flags.map((f) => html`<div style="font-size:11px;color:var(--color-warning)">${FLAG_TEXT[f] || f}</div>`)}</span></div>`; })}</div>` : ''}
        ${matching.length ? html`<div><button class="app-btn app-btn--sm" id="slMatch">${icon(showMatching ? 'chevronUp' : 'chevronDown', 14)}<span>${showMatching ? 'Hide' : 'Show'} the ${plural(matching.length, 'take')} that match</span></button>
          ${showMatching ? html`<div class="rename-list" style="margin-top:8px;max-height:220px">${matching.map((r) => html`<div class="slate-row slate-ok"><span class="app-chip app-chip--success xs">${icon('check', 12)}</span><span class="mono-name">${r.c.name}</span><span class="faint">${r.s.evidence}</span><span class="faint">${pct(r.s.confidence)}</span></div>`)}</div>` : ''}</div>` : ''}
        ${unreadable.length ? html`<div class="app-alert app-alert--warning">${icon('warn')}<div class="grow"><b>${plural(unreadable.length, 'clip')} without a readable slate</b>These need a human look: ${unreadable.slice(0, 6).map((r) => html`<a href="#" data-unread="${r.k}">${r.c.orig || r.c.name}</a>`).reduce((a, x) => (a.length ? [...a, ', ', x] : [x]), [])}${unreadable.length > 6 ? ` and ${unreadable.length - 6} more` : ''}. Claude never guesses a number it cannot read.</div></div>` : ''}
        ${!rows.length ? html`<div class="faint">Nothing to show.</div>` : ''}
      </div>`);
      const n = [...state.values()].filter((s) => s.on).length;
      mount(p.foot, html`${todo.length ? html`<button class="app-btn app-btn--sm" id="slTick">Tick the confident ones</button><button class="app-btn app-btn--sm" id="slTickAll" title="Tick every row, including ones Claude is unsure about or that are flagged">Tick all ${todo.length}</button>` : ''}<span class="grow"></span><button class="app-btn" data-no>Close</button>${todo.length ? html`<button class="app-btn app-btn--primary" id="slApply" ${n ? '' : 'disabled'}>${n ? `Rename ${plural(n, 'clip')}` : 'Tick what to rename'}</button>` : ''}`);
      p.foot.querySelector('[data-no]').addEventListener('click', p.close);
      const apply = p.foot.querySelector('#slApply');
      if (apply) apply.addEventListener('click', doApply);
      const tickAll = p.foot.querySelector('#slTickAll');
      if (tickAll) tickAll.addEventListener('click', () => { for (const r of todo) state.get(r.k).on = true; draw(); });
      const tick = p.foot.querySelector('#slTick');
      if (tick) tick.addEventListener('click', () => { for (const r of todo) state.get(r.k).on = confident(r.s); draw(); });
    };

    const doApply = async () => {
      const items = todo.filter((r) => state.get(r.k).on).map((r) => ({ key: r.k, scene: state.get(r.k).scene, shot: state.get(r.k).shot.toUpperCase(), take: state.get(r.k).take }));
      if (!items.length) return;
      const go = p.foot.querySelector('#slApply'); go.disabled = true;
      try {
        const r = await post('/api/rename-many', { items, apply: true });
        await loadLibrary();
        p.close();
        toast(`Renamed ${plural(r.renamed || 0, 'clip')}${r.conflicts && r.conflicts.length ? `, ${r.conflicts.length} left alone (${r.conflicts[0].reason})` : ''}.`, { type: r.renamed ? 'success' : 'info', timeout: 12000, link: r.renamed ? { text: 'Undo', onClick: () => post('/api/rename/undo').then((u) => toast(`Undid ${u.undone}.`, { type: 'success' })).catch(toastError) } : undefined });
      } catch (e) { go.disabled = false; toastError(e); }
    };

    draw();
    p.el.onclick = (e) => {
      const z = e.target.closest('[data-zoom]');
      if (z) { const r = rows.find((x) => x.k === z.dataset.zoom); const zp = openPopup({ title: `${r.c.orig || r.c.name} at ${(r.s.frameT || 0).toFixed(1)} s`, subtitle: r.s.evidence ? `Slate: ${r.s.evidence}` : '', width: 1200, className: 'zoom-popup', body: html`<img class="zoom-img" alt="" src="${frame(r, 1920)}">` }); zp.el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') zp.close(); }); return; }
      if (e.target.closest('#slMatch')) { showMatching = !showMatching; draw(); return; }
      const g = e.target.closest('[data-unread]');
      if (g) { e.preventDefault(); p.close(); window.kitGo('ingest', g.dataset.unread); }
    };
    p.el.onchange = (e) => {
      const t = e.target;
      if (t.dataset.on) { state.get(t.dataset.on).on = t.checked; const n = [...state.values()].filter((s) => s.on).length; const a = p.foot.querySelector('#slApply'); if (a) { a.disabled = !n; a.textContent = n ? `Rename ${plural(n, 'clip')}` : 'Tick what to rename'; } }
    };
    p.el.oninput = (e) => {
      const t = e.target;
      if (t.dataset.f && t.dataset.k) { state.get(t.dataset.k)[t.dataset.f] = t.value.trim(); const row = t.closest('[data-row]'); const cb = row && row.querySelector('[data-on]'); if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); } }
    };
  }

  if (view === 'results') stepResults();
  else if (!v.key.set) stepSetup();
  else stepConfirm();
}

/** Show readings that exist already, without calling Claude. */
export async function openReadings(keys) {
  if (!hasReadings(keys)) { toast('Nothing has been read yet.'); return; }
  return openSlateReader({ keys, title: 'Slate readings', view: 'results' });
}
