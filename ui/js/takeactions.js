// Takes and their snippets: what can be done with them, in one place for the Dashboard and Review.
// A selection is { keys: [take keys], snippets: [{ key, n }] }: whole takes (cut first where needed) and single snippets.
import { html, icon, plural, fmtSize } from './lib.js';
import { post } from './api.js';
import { S, clip } from './store.js';
import { toast, toastError, confirmDialog, openPopup } from './ui.js';

const t2 = (sec) => { const s = Math.max(0, Math.round(sec || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
// a length: tenths for short snippets ("1.1 s"), minutes and seconds otherwise ("0:28")
const len2 = (sec) => (sec > 0 && sec < 10 ? `${(Math.round(sec * 10) / 10).toFixed(1)} s` : t2(sec));
const takeName = (c) => (c.kind === 'shot' ? `${c.scene}.${c.shot} take ${c.take}` : (c.orig || c.name));
const describe = ({ keys = [], snippets = [] }) => [keys.length && (keys.length === 1 && clip(keys[0]) ? takeName(clip(keys[0])) : plural(keys.length, 'take')), snippets.length && plural(snippets.length, 'snippet')].filter(Boolean).join(' and ');
const needKey = () => {
  if (S.info.key.set) return false;
  toast('This needs your LetzAI API key.', { link: { text: 'Add it', onClick: () => window.kitGo('settings', 'letzai') } });
  return true;
};
export const snippetOf = (key, n) => { const c = clip(key); return c && c.cutFiles.find((x) => x.n === Number(n)); };

/** What a take is busy with right now, from the job queue: 'cut', 'asset' (uploading to LetzAI) or 'upload' (canvas). */
export function busyWith(key) {
  const j = S.jobs.find((x) => (x.state === 'queued' || x.state === 'running') && x.dedupeKey && x.dedupeKey.slice(x.dedupeKey.indexOf(':') + 1).split('#')[0] === key);
  return j ? j.dedupeKey.split(':')[0] : '';
}
export const BUSY_TEXT = { cut: 'Cutting…', asset: 'Uploading…', upload: 'Sending…' };

/** Cut takes into snippets (nothing is uploaded). */
export async function cutTakes(keys) {
  if (!keys.length) return;
  try { await post('/api/cuts', { keys }); toast(`Cutting ${describe({ keys })} into snippets.`, { type: 'success' }); } catch (e) { toastError(e); }
}

/** Upload to LetzAI (your uploads there, not the canvas). Whole takes are cut first; what is uploaded already is skipped. */
export async function uploadItems(sel) {
  if (!(sel.keys || []).length && !(sel.snippets || []).length) return;
  if (needKey()) return;
  try { await post('/api/letzai/upload', sel); toast(`Uploading ${describe(sel)} to LetzAI.`, { type: 'success' }); } catch (e) { toastError(e); }
}

/** Place on the LetzAI Canvas. Files already uploaded to LetzAI are reused. */
export async function sendItems(sel) {
  const keys = (sel.keys || []).filter((k) => clip(k) && clip(k).kind === 'shot');
  const snippets = (sel.snippets || []).filter((s) => clip(s.key) && clip(s.key).kind === 'shot');
  if (!keys.length && !snippets.length) { toast('Only named takes can go on the canvas.'); return; }
  if (needKey()) return;
  if (!S.info.project.canvas.canvasId) { toast('Choose a canvas first.', { link: { text: 'Canvas', onClick: () => window.kitGo('canvas') } }); return; }
  try { await post('/api/canvas/send', { keys, snippets }); toast(`Sending ${describe({ keys, snippets })} to the canvas.`, { type: 'success' }); } catch (e) { toastError(e); }
}

/** Delete snippet files (whole takes: all their snippets). The takes stay, and so does anything on LetzAI. */
export async function deleteItems(sel) {
  const keys = (sel.keys || []).filter((k) => clip(k) && clip(k).cutFiles.length);
  const snippets = (sel.snippets || []).filter((s) => !keys.includes(s.key) && snippetOf(s.key, s.n));
  const n = keys.reduce((a, k) => a + clip(k).cutFiles.length, 0) + snippets.length;
  if (!n) { toast('There are no snippets to delete.'); return false; }
  const ok = await confirmDialog({ title: `Delete ${plural(n, 'snippet')}?`, message: 'The snippet files are deleted from the cuts folder. The takes stay, and so does anything already uploaded to LetzAI or on the canvas. You can cut again any time.', confirmLabel: 'Delete', danger: true });
  if (!ok) return false;
  try { const r = await post('/api/cuts/delete', { keys, snippets }); toast(`Deleted ${plural(r.deleted, 'snippet')}.`, { type: 'success' }); return true; } catch (e) { toastError(e); return false; }
}

/** Copy the LetzAI links of what is uploaded. */
export async function copyLinks(sel) {
  const urls = [
    ...(sel.keys || []).flatMap((k) => (clip(k) ? clip(k).cutFiles.filter((c) => c.uploaded).map((c) => c.uploaded.url) : [])),
    ...(sel.snippets || []).map((s) => snippetOf(s.key, s.n)).filter((s) => s && s.uploaded).map((s) => s.uploaded.url),
  ];
  if (!urls.length) { toast('Nothing here is uploaded to LetzAI yet.'); return; }
  try { await navigator.clipboard.writeText([...new Set(urls)].join('\n')); toast(`Copied ${plural(urls.length, 'link')}.`, { type: 'success' }); } catch (e) { toastError(e); }
}

export const revealSnippet = (key, n) => post('/api/reveal', { key, cut: n }).catch(toastError);

/** A frame from the middle of the snippet, from the take itself (cached like every other thumbnail). */
export const snippetThumb = (key, s, w = 320) => `/thumb?key=${encodeURIComponent(key)}&t=${((s.start || 0) + (s.len || 0) / 2).toFixed(1)}&w=${w}`;

/**
 * A snippet as a card: frame, number and range, length, what happened to it. With `pick`, a checkbox to select it.
 * Clicking the card (not the checkbox) opens it.
 */
export function snippetCard(c, s, { pick = null } = {}) {
  const id = `${c.key}#${s.n}`;
  return html`<div class="snip-card ${pick && pick.has(id) ? 'is-picked' : ''}" data-snip="${c.key}" data-n="${s.n}" tabindex="0" aria-label="Snippet ${s.n} of ${takeName(c)}">
    <div class="snip-thumb">
      <img loading="lazy" alt="" src="${snippetThumb(c.key, s)}" onerror="this.style.visibility='hidden'">
      ${pick ? html`<label class="snip-check" title="Select"><input type="checkbox" class="app-check" data-pick="${id}" ${pick.has(id) ? 'checked' : ''} aria-label="Select snippet ${s.n}"></label>` : ''}
      <span class="snip-play">${icon('play', 18)}</span>
      <span class="snip-dur tnum">${len2(s.len)}</span>
      <span class="snip-badges">${s.uploaded ? html`<span class="snip-badge" title="Uploaded to LetzAI">${icon('upload', 12)}</span>` : ''}${s.onCanvas ? html`<span class="snip-badge" title="On the canvas">${icon('canvas', 12)}</span>` : ''}</span>
    </div>
    <div class="snip-meta"><b>${s.n}</b><span class="faint tnum">${t2(s.start)}–${t2(s.start + s.len)}</span><span class="grow"></span>${s.uploaded ? html`<span class="faint" style="font-size:11px">LetzAI</span>` : ''}${s.onCanvas ? html`<span class="faint" style="font-size:11px">Canvas</span>` : ''}</div>
  </div>`;
}

/** One snippet, playing, with everything that can be done with it. */
export function openSnippet(key, n) {
  const c = clip(key);
  const s = snippetOf(key, n);
  if (!c || !s) return;
  const status = [s.uploaded ? 'Uploaded to LetzAI' : 'Not uploaded', s.onCanvas ? 'on the canvas' : '', fmtSize(s.size)].filter(Boolean).join(' · ');
  const p = openPopup({
    title: `${takeName(c)} · snippet ${s.n}`, subtitle: `${len2(s.len)}, ${t2(s.start)}–${t2(s.start + s.len)} of the take · ${status}`, width: 900,
    body: html`<video class="snippet-video" src="/media?key=${encodeURIComponent(key)}&src=cut&n=${s.n}&v=${s.size}" controls autoplay playsinline></video>`,
    foot: html`<button class="app-icon-btn" data-sn="delete" title="Delete this snippet">${icon('trash')}</button><button class="app-btn" data-sn="reveal">${icon('folder', 14)}<span>Show in folder</span></button><span class="grow"></span>
      ${s.uploaded ? html`<button class="app-btn" data-sn="copy">${icon('copy', 14)}<span>Copy LetzAI link</span></button>` : html`<button class="app-btn" data-sn="upload">${icon('upload', 14)}<span>Upload to LetzAI</span></button>`}
      ${c.kind === 'shot' ? html`<button class="app-btn app-btn--primary" data-sn="send">${icon('canvas', 14)}<span>${s.onCanvas ? 'Send again' : 'Send to Canvas'}</span></button>` : ''}`,
  });
  const sel = { keys: [], snippets: [{ key, n: s.n }] };
  p.el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-sn]');
    if (!b) return;
    const a = b.dataset.sn;
    if (a === 'reveal') revealSnippet(key, s.n);
    else if (a === 'copy') copyLinks(sel);
    else if (a === 'upload') { p.close(); uploadItems(sel); }
    else if (a === 'send') { p.close(); sendItems(sel); }
    else if (a === 'delete') { if (await deleteItems(sel)) p.close(); }
  });
}

/** A short line about a take's snippets: "3 snippets", what is uploaded and on the canvas, or what is happening now. */
export function snippetSummary(c) {
  const b = busyWith(c.key);
  if (b) return html`<span class="row" style="gap:6px"><span class="spinner"></span><span class="muted">${BUSY_TEXT[b]}</span></span>`;
  if (c.canvasError) return html`<span class="app-chip xs app-chip--error" title="${c.canvasError.message}">${icon('alert', 12)} send failed</span>`;
  if (!c.cutFiles.length) return html`<span class="faint" title="Not cut into snippets yet">—</span>`;
  const n = c.cutFiles.length;
  const part = (k) => (k === n ? '' : ` ${k}/${n}`);
  return html`<span class="row wrap" style="gap:6px"><span class="tnum">${plural(n, 'snippet')}</span>
    ${c.cutStale ? html`<span class="app-chip xs app-chip--warning" title="Cut ranges or settings changed since cutting. Cut again to update.">outdated</span>` : ''}
    ${c.cutUploaded ? html`<span class="app-chip xs" title="Uploaded to LetzAI">${icon('upload', 12)}${part(c.cutUploaded) || ' LetzAI'}</span>` : ''}
    ${c.cutOnCanvas ? html`<span class="app-chip xs app-chip--ink" title="On the canvas">${icon('canvas', 12)}${part(c.cutOnCanvas) || ' Canvas'}</span>` : ''}</span>`;
}
