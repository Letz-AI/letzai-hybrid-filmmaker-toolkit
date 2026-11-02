// First-run setup assistant: the LetzAI key (Canvas features) and an AI key for slate reading (Claude, ChatGPT or
// Gemini). Both are optional; features without their key stay unavailable until one is added. Also opened from Settings.
import { html, icon, mount } from './lib.js';
import { get, put, post } from './api.js';
import { S, loadInfo } from './store.js';
import { openPopup, toastError, field } from './ui.js';
import { providerPicker, currentProvider } from './slate.js';

const LETZAI_KEYS = 'https://letz.ai/subscription';

export async function openSetup({ onDone } = {}) {
  let v;
  try { v = await get('/api/vision'); } catch (e) { toastError(e); return; }
  let closed = false;
  const p = openPopup({
    title: 'Set up the kit', width: 640, body: html`<div></div>`, foot: html`<span></span>`,
    onClose: async () => {
      if (closed) return;
      closed = true;
      try { await put('/api/setup', { done: true }); await loadInfo(); } catch { /* shown as not done next time */ }
      if (onDone) onDone();
    },
  });
  const alertBox = (type, msg) => html`<div class="app-alert app-alert--${type}">${icon(type === 'error' ? 'alert' : 'warn')}<div class="grow">${msg}</div></div>`;
  const stepLabel = (n) => html`<div class="faint" style="font-size:12px">Step ${n} of 2</div>`;
  const saved = (text) => html`<span class="app-chip app-chip--success">${icon('checkCircle', 14)}${text}</span>`;
  const footer = (buttons) => { mount(p.foot, buttons); };

  function intro() {
    mount(p.body, html`<div style="display:grid;gap:14px">
      <p style="margin:0">Reviewing, naming and comparing takes works right away. Two optional keys add more:</p>
      <div class="setup-list" style="display:grid;gap:10px">
        <div class="row" style="gap:12px;align-items:flex-start">${icon('canvas')}<div><b>LetzAI API key</b><div class="muted">Send your takes to a LetzAI Canvas, and pick AI results from it in Compare.</div></div></div>
        <div class="row" style="gap:12px;align-items:flex-start">${icon('bolt')}<div><b>Claude, ChatGPT or Gemini API key</b><div class="muted">Let an AI read the slates and suggest the clip names.</div></div></div>
      </div>
      <p class="faint" style="margin:0">You can skip both and add them later in Settings. Keys are stored only on this computer.</p></div>`);
    footer(html`<button class="app-btn" data-skip>Skip for now</button><span class="grow"></span><button class="app-btn app-btn--primary" data-next>Set up keys</button>`);
    p.foot.querySelector('[data-skip]').addEventListener('click', p.close);
    p.foot.querySelector('[data-next]').addEventListener('click', () => letzai());
  }

  function letzai(msg) {
    const has = S.info.key.set;
    mount(p.body, html`<div style="display:grid;gap:14px">
      ${stepLabel(1)}
      <div><b>LetzAI</b><div class="muted">Needed to send takes to your LetzAI Canvas.</div></div>
      ${has ? html`<div>${saved('LetzAI key saved')}</div>`
        : field('LetzAI API key', html`<input class="app-input" id="suKey" type="password" placeholder="Paste your key" autocomplete="off" spellcheck="false">`, html`Get your key at <a href="${LETZAI_KEYS}" target="_blank" rel="noopener">letz.ai/subscription</a>.`)}
      <div id="suErr">${msg || ''}</div></div>`);
    footer(html`<button class="app-btn" data-back>Back</button><span class="grow"></span>${has ? '' : html`<button class="app-btn" data-skip>Skip</button>`}<button class="app-btn app-btn--primary" data-next>${has ? 'Next' : 'Save and continue'}</button>`);
    p.foot.querySelector('[data-back]').addEventListener('click', () => intro());
    const skip = p.foot.querySelector('[data-skip]');
    if (skip) skip.addEventListener('click', () => ai());
    const go = p.foot.querySelector('[data-next]');
    const input = p.body.querySelector('#suKey');
    const save = async () => {
      if (has) { ai(); return; }
      const k = input.value.trim();
      if (!k) { input.focus(); return; }
      go.disabled = true; go.textContent = 'Checking…';
      try {
        await put('/api/key', { key: k });
        // check it the cheap way: list the canvases this key can see
        try { await get('/api/canvas/list'); } catch (e) {
          if (e.status === 401 || e.status === 403) { await put('/api/key', { key: '' }); throw new Error('LetzAI did not accept this key. Check that it was copied completely.'); }
          await loadInfo();
          letzai(alertBox('warning', html`The key is saved, but LetzAI could not be reached to check it (${e.message}). You can test it later in Canvas.`));
          return;
        }
        await loadInfo();
        ai();
      } catch (e) { go.disabled = false; go.textContent = 'Save and continue'; mount(p.body.querySelector('#suErr'), alertBox('error', e.message)); }
    };
    go.addEventListener('click', save);
    if (input) { input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); }); input.focus(); }
  }

  function ai(msg) {
    const pv = currentProvider(v);
    const has = v.key.set;
    mount(p.body, html`<div style="display:grid;gap:14px">
      ${stepLabel(2)}
      <div><b>AI slate reading</b><div class="muted">An AI reads the slate on each clip and suggests its name. You pay the AI company for what you use, usually about a cent per clip.</div></div>
      ${field('AI', providerPicker(v))}
      ${has ? html`<div>${saved(`${pv.company} key saved`)}</div>`
        : field(`${pv.company} API key`, html`<input class="app-input" id="suAiKey" type="password" placeholder="${pv.keyHint}" autocomplete="off" spellcheck="false">`, html`Get one in the <a href="${pv.keyUrl}" target="_blank" rel="noopener">${pv.keyPage}</a>. Most accounts need some prepaid credit.`)}
      ${field('Monthly budget (US$, optional)', html`<input class="app-input" id="suBudget" type="number" min="0" step="1" inputmode="decimal" placeholder="No limit" value="${v.budget.monthly ?? ''}" style="width:160px">`, 'Slate reading stops when this month’s estimated cost reaches it.')}
      <div id="suErr">${msg || ''}</div></div>`);
    footer(html`<button class="app-btn" data-back>Back</button><span class="grow"></span>${has ? '' : html`<button class="app-btn" data-skip>Skip</button>`}<button class="app-btn app-btn--primary" data-next>${has ? 'Next' : 'Save and test'}</button>`);
    p.foot.querySelector('[data-back]').addEventListener('click', () => letzai());
    const saveBudget = async () => {
      const b = p.body.querySelector('#suBudget').value.trim();
      if (b !== String(v.budget.monthly ?? '')) v = await put('/api/vision', { budget: { monthly: b === '' ? null : b } });
    };
    const skip = p.foot.querySelector('[data-skip]');
    if (skip) skip.addEventListener('click', () => done());
    const go = p.foot.querySelector('[data-next]');
    const input = p.body.querySelector('#suAiKey');
    const save = async () => {
      try {
        if (!has) {
          const k = input.value.trim();
          if (!k) { input.focus(); return; }
          go.disabled = true; go.textContent = 'Testing…';
          v = await post('/api/vision/test', { provider: v.provider, key: k, save: true, model: v.model });
        }
        await saveBudget();
        await loadInfo();
        done();
      } catch (e) { go.disabled = false; go.textContent = has ? 'Next' : 'Save and test'; mount(p.body.querySelector('#suErr'), alertBox('error', e.message)); }
    };
    go.addEventListener('click', save);
    if (input) { input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); }); input.focus(); }
  }

  function done() {
    const lz = S.info.key.set;
    const aiOn = S.info.vision && S.info.vision.keySet;
    const line = (ok, title, on, off) => html`<div class="row" style="gap:12px;align-items:flex-start"><span style="color:${ok ? 'var(--color-success)' : 'var(--text-tertiary)'}">${icon(ok ? 'checkCircle' : 'info')}</span><div><b>${title}</b><div class="muted">${ok ? on : off}</div></div></div>`;
    mount(p.body, html`<div style="display:grid;gap:14px">
      <b>You’re ready</b>
      ${line(lz, 'LetzAI Canvas', 'Sending takes to your canvas is available.', 'Unavailable until you add a LetzAI key, in Canvas or Settings → Setup assistant.')}
      ${line(aiOn, 'AI slate reading', `${S.info.vision.label} will read your slates.`, 'Unavailable until you add an AI key in Settings → AI slate reading.')}
      ${S.info.project ? '' : html`<p class="faint" style="margin:0">Next, choose the folder with your footage.</p>`}</div>`);
    footer(html`<span class="grow"></span><button class="app-btn app-btn--primary" data-done>${S.info.project ? 'Done' : 'Choose film folder'}</button>`);
    p.foot.querySelector('[data-done]').addEventListener('click', () => { p.close(); if (!S.info.project) document.querySelector('#choose')?.click(); });
  }

  // switching the AI on step 2
  p.el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-prov]');
    if (!b || b.dataset.prov === v.provider) return;
    try { v = await put('/api/vision', { provider: b.dataset.prov }); await loadInfo(); ai(); } catch (err) { toastError(err); }
  });

  intro();
}
