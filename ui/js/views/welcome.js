// No project open: pick a film folder, reopen a recent one, check the setup.
import { html, icon, mount, on, $, esc, feedbackHref, FEEDBACK_EMAIL } from '../lib.js';
import { get, post } from '../api.js';
import { S } from '../store.js';
import { toast, toastError, openPopup, field } from '../ui.js';
import { openSetup } from '../setup.js';

let root;
let off = [];

function hero() {
  const ffOk = S.info.ffmpeg.ok;
  const recent = S.info.recent || [];
  return html`
    <div class="welcome">
      <div class="welcome-hero">
        <h1 class="hero-title">Know what you’ve shot, and what’s still missing.</h1>
        <p class="hero-sub">Review takes, name them from the slate, circle the best, and send them to your LetzAI Canvas. Everything runs on your computer.</p>
        <div class="row" style="margin-top:28px;gap:12px">
          <button class="app-btn app-btn--primary" id="choose" style="height:42px;padding:0 20px;font-size:14px">${icon('folder')}<span>Choose film folder</span></button>
          <span class="faint">or paste a path</span>
          <input class="app-input" id="pathInput" placeholder="C:\\Films\\My film" style="width:300px" spellcheck="false">
          <button class="app-btn" id="openPath">Open</button>
        </div>
        <div class="beta-note"><span class="beta-badge">Beta</span><span class="muted">A work in progress. Feedback? Send it to <a href="${feedbackHref(S.info.app.version)}">${FEEDBACK_EMAIL}</a>.</span><a class="app-btn app-btn--sm" href="${feedbackHref(S.info.app.version)}">${icon('chat', 14)}<span>Send feedback</span></a></div>
      </div>

      ${recent.length ? html`
        <div class="section-label">Recent films</div>
        <div class="recent-list surface">
          ${recent.map((r) => html`
            <div class="recent-row" data-open="${r.root}">
              <div class="recent-ic">${icon('review')}</div>
              <div class="grow"><div class="recent-name">${r.name}</div><div class="faint tnum" title="${r.root}">${r.root}</div></div>
              <button class="app-icon-btn app-icon-btn--sm" data-forget="${r.root}" title="Remove from this list">${icon('close', 14)}</button>
            </div>`)}
        </div>` : ''}

      <div class="section-label">Setup</div>
      <div class="surface pad setup-grid">
        <div class="row">${icon(ffOk ? 'checkCircle' : 'alert')}<div class="grow"><b>ffmpeg</b><div class="muted">${ffOk ? html`Found, version ${S.info.ffmpeg.version}.` : html`Needed for thumbnails, review proxies and cuts.`}</div></div></div>
        ${ffOk ? '' : html`<div class="app-alert app-alert--warning" style="grid-column:1/-1"><div class="grow"><b>Install ffmpeg to continue</b>
            Windows: <code>winget install Gyan.FFmpeg</code> &nbsp;·&nbsp; macOS: <code>brew install ffmpeg</code> &nbsp;·&nbsp; Linux: <code>sudo apt install ffmpeg</code><br>Then restart the kit. You can also point <code>LETZAI_KIT_FFMPEG</code> at your ffmpeg folder.</div></div>`}
        <div class="row">${icon(S.info.key.set ? 'checkCircle' : 'info')}<div class="grow"><b>LetzAI API key</b><div class="muted">${S.info.key.set ? 'Saved' : 'Optional. Needed to send takes to a LetzAI Canvas.'}</div></div></div>
        <div class="row">${icon(S.info.vision && S.info.vision.keySet ? 'checkCircle' : 'info')}<div class="grow"><b>AI key for slate reading</b><div class="muted">${S.info.vision && S.info.vision.keySet ? `${S.info.vision.label}, saved` : 'Optional. Claude, ChatGPT or Gemini reads the slates for you.'}</div></div></div>
        <div class="row" style="grid-column:1/-1"><button class="app-btn app-btn--sm" id="setupKeys">${icon('key', 14)}<span>${S.info.key.set && S.info.vision && S.info.vision.keySet ? 'Change keys…' : 'Add keys…'}</span></button></div>
      </div>
    </div>`;
}

async function chooseFolder() {
  try {
    const r = await post('/api/pick-folder', { title: 'Choose your film folder' });
    if (r.path) await openOrCreate(r.path);
  } catch (e) { toastError(e); }
}

export async function openOrCreate(dir) {
  try {
    await post('/api/project/open', { root: dir });
  } catch (e) {
    if (e.code === 'no-project') createDialog(dir); else toastError(e);
  }
}

function suggestPrefix(name) {
  const w = name.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).map((s) => s[0].toUpperCase() + s.slice(1));
  return w.join('') || 'Film';
}

export function createDialog(dir) {
  const base = dir.split(/[\\/]/).filter(Boolean).pop() || 'My film';
  const folders = [dir];
  const p = openPopup({
    title: 'New film project', subtitle: dir, width: 600,
    body: html`
      <div style="display:grid;gap:16px">
        <div class="app-alert"><div class="grow">This folder has no kit project yet. The kit adds one small file, <b style="display:inline">letzai-kit.json</b>, to it. Your footage is never moved or changed unless you rename or cut it here.</div></div>
        ${field('Film name', html`<input class="app-input" id="cName" value="${base}" spellcheck="false">`)}
        ${field('File name prefix', html`<input class="app-input" id="cPrefix" value="${suggestPrefix(base)}" spellcheck="false">`, html`Takes are named <b style="display:inline" id="cEx"></b>`)}
        <div class="app-field"><div class="label">Where is the footage?</div><div id="cFolders" class="folder-list"></div>
          <div class="row"><button class="app-btn app-btn--sm" id="cAdd">${icon('plus', 14)}<span>Add another folder</span></button></div>
          <div class="app-hint">Subfolders are included.</div></div>
      </div>`,
    foot: html`<button class="app-btn" data-close2>Cancel</button><button class="app-btn app-btn--primary" id="cCreate">Create project</button>`,
  });
  const name = $('#cName', p.el); const prefix = $('#cPrefix', p.el); const ex = $('#cEx', p.el); const list = $('#cFolders', p.el);
  const drawEx = () => { ex.textContent = `${prefix.value || 'Film'}-scene6-shot2A-take3`; };
  const drawFolders = () => mount(list, html`${folders.map((f, i) => html`<div class="row folder-row"><span class="grow tnum" title="${f}">${f}</span>${folders.length > 1 ? html`<button class="app-icon-btn app-icon-btn--sm" data-rm="${i}">${icon('close', 14)}</button>` : ''}</div>`)}`);
  name.addEventListener('input', () => { if (!prefix.dataset.touched) { prefix.value = suggestPrefix(name.value); drawEx(); } });
  prefix.addEventListener('input', () => { prefix.dataset.touched = '1'; drawEx(); });
  drawEx(); drawFolders();
  on(p.el, 'click', '[data-rm]', (e, el) => { folders.splice(+el.dataset.rm, 1); drawFolders(); });
  $('#cAdd', p.el).addEventListener('click', async () => { try { const r = await post('/api/pick-folder', { title: 'Add a footage folder', start: dir }); if (r.path && !folders.includes(r.path)) { folders.push(r.path); drawFolders(); } } catch (e) { toastError(e); } });
  $('[data-close2]', p.el).addEventListener('click', p.close);
  $('#cCreate', p.el).addEventListener('click', async () => {
    try {
      await post('/api/project/create', { root: dir, name: name.value.trim() || base, prefix: prefix.value.trim() || 'Film', folders });
      p.close();
      toast('Project created. Scanning your footage…', { type: 'success' });
    } catch (e) { toastError(e); }
  });
}

export default {
  flush: false,
  mount(el) {
    root = el;
    mount(el, html`<div class="page default">${hero()}</div>`);
    const c = $('.page', el);
    on(c, 'click', '#choose', chooseFolder);
    on(c, 'click', '#setupKeys', () => openSetup({ onDone: () => this.update() }));
    on(c, 'click', '#openPath', () => { const v = $('#pathInput', c).value.trim(); if (v) openOrCreate(v); });
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'pathInput') { const v = e.target.value.trim(); if (v) openOrCreate(v); } });
    on(c, 'click', '[data-open]', (e, el2) => { if (e.target.closest('[data-forget]')) return; openOrCreate(el2.dataset.open); });
    on(c, 'click', '[data-forget]', async (e, el2) => { e.stopPropagation(); await post('/api/project/forget', { root: el2.dataset.forget }); S.info = await get('/api/info'); this.update(); });
  },
  update() { if (root && S.info) { const c = $('.page', root); if (c) mount(c, hero()); } },
  unmount() { root = null; off = []; },
};
