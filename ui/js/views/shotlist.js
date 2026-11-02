// The shot list: the plan that lets the Dashboard say what is still missing. Edited as plain text, previewed live.
import { html, icon, mount, on, $, debounce, plural } from '../lib.js';
import { post, put } from '../api.js';
import { S, findShotAll as findShot } from '../store.js';
import { toast, toastError, openPopup, field } from '../ui.js';

export const planOp = (op) => post('/api/shotlist/edit', op);

export function openShotList() {
  const original = S.snap.shotListText || '';
  const sample = `Scene 1 - Kitchen
1.1  Wide, Mira enters  [WS]
1.2  Medium on Mira at the table  [MS]
1.3  Close on the cup  [CU]
?1.4 Optional insert, hands

Scene 2 - Street
2.1-3`;
  const p = openPopup({
    title: 'Shot list', subtitle: 'One shot per line.', width: 980, className: 'shotlist-popup',
    actions: html`<button class="app-btn" id="slSeed" title="Fill the list with every shot you have footage for">${icon('regenerate')}<span>Use what’s shot so far</span></button><button class="app-btn app-btn--primary" id="slSave">Save</button>`,
    body: html`<div class="sl-grid">
      <div class="app-field"><label for="slText">Plan</label>
        <textarea class="app-input" id="slText" spellcheck="false" placeholder="${sample}"></textarea>
        <div class="app-hint">Header lines: <b style="display:inline">Scene 6 - Kitchen</b>. Shot lines: <b style="display:inline">6.2A  Close on the cup  [CU]</b>. Ranges: <b style="display:inline">6.1-5</b>. Start a line with <b style="display:inline">?</b> for an optional shot.</div></div>
      <div class="app-field"><div class="label">Preview</div><div id="slPrev" class="sl-prev"></div></div>
    </div>`,
  });
  const ta = $('#slText', p.el);
  const prev = $('#slPrev', p.el);
  ta.value = original;
  let dirty = false;

  const draw = (res) => {
    if (!res.scenes.length) { mount(prev, html`<div class="faint" style="padding:12px">Nothing yet. Add a scene header and a few shots.</div>`); return; }
    mount(prev, html`
      ${res.errors.length ? html`<div class="app-alert app-alert--warning" style="margin-bottom:12px"><div class="grow">${res.errors.map((er) => html`<div>Line ${er.line}: ${er.message}</div>`)}</div></div>` : ''}
      ${res.scenes.map((sc) => html`<div class="sl-scene"><div class="sl-scene-h"><b>Scene ${sc.scene}</b>${sc.title ? html`<span class="muted"> ${sc.title}</span>` : ''}</div>
        ${sc.shots.map((sh) => {
          const f = findShot(sc.scene, sh.id);
          const n = f ? f.shot.takes.length : 0;
          return html`<div class="sl-shot"><span class="tnum sl-id">${sc.scene}.${sh.id}</span><span class="grow ${sh.desc ? '' : 'faint'}">${sh.desc || 'No description'}${sh.size ? html` <span class="app-chip xs app-chip--quiet">${sh.size}</span>` : ''}</span>
            ${sh.optional ? html`<span class="app-chip xs app-chip--quiet">optional</span>` : ''}
            ${n ? html`<span class="app-chip xs">${plural(n, 'take')}</span>` : sh.optional ? '' : html`<span class="app-chip xs app-chip--warning">missing</span>`}</div>`;
        })}</div>`)}`);
  };
  const refresh = debounce(async () => {
    try { draw(await post('/api/shotlist/preview', { text: ta.value })); } catch (e) { toastError(e); }
  }, 200);
  ta.addEventListener('input', () => { dirty = true; refresh(); });
  ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') $('#slSave', p.el).click(); });
  refresh();

  $('#slSeed', p.el).addEventListener('click', async () => {
    if (ta.value.trim() && !confirm('Replace the text with every shot you have footage for?')) return;
    try { const r = await post('/api/shotlist/seed'); ta.value = r.text; dirty = false; refresh(); toast('Filled from your footage. Add the shots you still owe.', { type: 'success' }); } catch (e) { toastError(e); }
  });
  $('#slSave', p.el).addEventListener('click', async () => {
    try {
      const r = await put('/api/shotlist', { text: ta.value });
      dirty = false;
      p.close();
      toast(`Shot list saved: ${plural(r.shots, 'shot')} in ${plural(r.scenes, 'scene')}.${r.errors.length ? ` ${plural(r.errors.length, 'line')} skipped.` : ''}`, { type: r.errors.length ? 'info' : 'success' });
    } catch (e) { toastError(e); }
  });
  setTimeout(() => ta.focus(), 30);
}

/** Next free scene number: one above the highest numeric scene in the plan or the footage. */
function nextSceneId() {
  const ids = S.snap.coverage.scenes.map((s) => parseInt(s.id, 10)).filter(Number.isFinite);
  return String((ids.length ? Math.max(...ids) : 0) + 1);
}

export function addSceneDialog() {
  const p = openPopup({
    title: 'Add a scene', width: 480,
    body: html`<div style="display:grid;gap:14px">
      <div class="row" style="gap:12px;align-items:flex-start">${field('Scene', html`<input class="app-input" id="scId" value="${nextSceneId()}" style="width:90px" maxlength="6" spellcheck="false">`)}${field('Planned shots', html`<input class="app-input" id="scN" type="number" min="0" max="60" value="3" style="width:110px">`)}</div>
      ${field('Title', html`<input class="app-input" id="scT" placeholder="Optional, like Kitchen" spellcheck="false">`)}
</div>`,
    foot: html`<button class="app-btn" data-no>Cancel</button><button class="app-btn app-btn--primary" id="scGo">Add scene</button>`,
  });
  const go = async () => {
    try {
      await planOp({ op: 'scene', scene: p.el.querySelector('#scId').value, count: p.el.querySelector('#scN').value, title: p.el.querySelector('#scT').value });
      p.close();
      toast(`Scene ${p.el.querySelector('#scId').value} added.`, { type: 'success' });
    } catch (e) { toastError(e); }
  };
  p.el.querySelector('[data-no]').addEventListener('click', p.close);
  p.el.querySelector('#scGo').addEventListener('click', go);
  p.el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') go(); });
  setTimeout(() => { const i = p.el.querySelector('#scN'); i.focus(); i.select(); }, 30);
}

export function addShotDialog(scene, shot) {
  const sc = S.snap.coverage.scenes.find((s) => String(s.id) === String(scene));
  const nums = (sc ? sc.shots : []).map((s) => parseInt(s.id, 10)).filter(Number.isFinite);
  const next = shot || String((nums.length ? Math.max(...nums) : 0) + 1);
  const p = openPopup({
    title: `Add a shot to scene ${scene}`, width: 460,
    body: html`<div style="display:grid;gap:14px">
      <div class="row" style="gap:12px">${field('Shot', html`<input class="app-input" id="asShot" value="${next}" style="width:90px" spellcheck="false">`)}${field('Size', html`<input class="app-input" id="asSize" placeholder="WS, MS, CU…" style="width:130px" maxlength="12" spellcheck="false">`)}</div>
      ${field('Description', html`<input class="app-input" id="asDesc" placeholder="What the shot is" spellcheck="false">`)}
      <label class="app-switch"><input type="checkbox" id="asOpt"><span>Optional (don’t count it as missing)</span></label></div>`,
    foot: html`<button class="app-btn" data-no>Cancel</button><button class="app-btn app-btn--primary" id="asGo">Add shot</button>`,
  });
  const go = async () => {
    try {
      await planOp({ op: 'add', scene, shot: $('#asShot', p.el).value, desc: $('#asDesc', p.el).value, size: $('#asSize', p.el).value, optional: $('#asOpt', p.el).checked });
      p.close();
    } catch (e) { toastError(e); }
  };
  $('[data-no]', p.el).addEventListener('click', p.close);
  $('#asGo', p.el).addEventListener('click', go);
  p.el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') go(); });
  setTimeout(() => $('#asDesc', p.el).focus(), 30);
}
