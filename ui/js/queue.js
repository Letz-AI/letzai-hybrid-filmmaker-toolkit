// Background jobs popover: review proxies, cuts, uploads, copies.
import { html, icon, mount, $ } from './lib.js';
import { post } from './api.js';
import { S, subscribeJobs } from './store.js';
import { pushLayer, toastError } from './ui.js';

let panel = null;
let unsub = null;
let unlayer = null;

function close() {
  if (!panel) return;
  panel.remove(); panel = null;
  if (unsub) unsub();
  if (unlayer) unlayer();
  document.removeEventListener('mousedown', outside, true);
}
function outside(e) { if (panel && !panel.contains(e.target) && !e.target.closest('#queueBtn')) close(); }

const stateLabel = { queued: 'Waiting', running: 'Working', done: 'Done', error: 'Failed', canceled: 'Canceled' };

function body() {
  const jobs = S.jobs.slice(0, 40);
  if (!jobs.length) return html`<div class="app-empty" style="padding:28px 16px"><div class="app-empty-title">Nothing running</div><div class="app-empty-body">Review proxies, cuts and canvas uploads show up here while they work.</div></div>`;
  return html`${jobs.map((j) => html`
    <div class="job ${j.state}">
      <div class="row"><span class="grow job-title">${j.title}</span>
        ${j.state === 'running' || j.state === 'queued' ? html`<button class="app-icon-btn app-icon-btn--sm" data-cancel="${j.id}" title="Cancel">${icon('close', 14)}</button>` : html`<span class="app-chip xs ${j.state === 'error' ? 'app-chip--error' : j.state === 'done' ? 'app-chip--success' : ''}">${stateLabel[j.state]}</span>`}
      </div>
      ${j.state === 'running' ? html`<div class="bar sm"><i style="width:${Math.round(j.progress * 100)}%"></i></div>` : ''}
      <div class="faint job-detail">${j.state === 'error' ? j.error : j.detail || (j.state === 'queued' ? 'Waiting for its turn' : '')}</div>
    </div>`)}`;
}

export function openQueue(anchor) {
  if (panel) { close(); return; }
  panel = document.createElement('div');
  panel.className = 'app-menu queue-panel';
  const r = anchor.getBoundingClientRect();
  panel.style.top = `${r.bottom + 6}px`;
  panel.style.right = `${innerWidth - r.right}px`;
  panel.style.left = 'auto';
  document.body.append(panel);
  const render = () => {
    if (!panel) return;
    mount(panel, html`<div class="head row"><span class="grow">Background jobs</span><button class="app-btn app-btn--sm" id="qclear">Clear finished</button></div><div class="queue-list">${body()}</div>`);
  };
  render();
  unsub = subscribeJobs(render);
  unlayer = pushLayer(close);
  setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
  panel.addEventListener('click', async (e) => {
    const c = e.target.closest('[data-cancel]');
    if (c) post('/api/jobs/cancel', { id: c.dataset.cancel }).catch(toastError);
    if (e.target.closest('#qclear')) post('/api/jobs/clear').catch(toastError);
  });
}
