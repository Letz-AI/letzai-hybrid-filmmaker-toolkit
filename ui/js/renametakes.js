// Rename takes that already have a name: one take, a whole shot, a whole scene, or any selection.
// Change the scene and/or shot, and renumber the takes if you like. You see every new name first; one undo.
import { html, icon, mount, on, plural, debounce, fmtDur, fmtClock } from './lib.js';
import { post } from './api.js';
import { S, clip, allClips, loadLibrary } from './store.js';
import { openPopup, toast, toastError, field } from './ui.js';

const same = (a) => (a.length && a.every((x) => String(x) === String(a[0])) ? String(a[0]) : '');

/** Takes of a shot / a scene, for the quick entry points. */
export const takesOfShot = (scene, shot) => allClips().filter((c) => c.kind === 'shot' && String(c.scene) === String(scene) && String(c.shot).toUpperCase() === String(shot).toUpperCase());
export const takesOfScene = (scene) => allClips().filter((c) => c.kind === 'shot' && String(c.scene) === String(scene));

/**
 * @param {string[]} keys the takes to rename (they are shown in recording order)
 * @param {{title?: string, afterRename?: (changes) => void}} [opts]
 */
export function openRenameTakes(keys, opts = {}) {
  const chosen = keys.map((k) => clip(k)).filter((c) => c && c.kind === 'shot');
  if (!chosen.length) { toast('Pick at least one named take.'); return; }
  chosen.sort((a, b) => (a.recordedAt || '').localeCompare(b.recordedAt || '') || String(a.scene).localeCompare(String(b.scene), 'en', { numeric: true }) || String(a.shot).localeCompare(String(b.shot), 'en', { numeric: true }) || a.take - b.take);
  const scene0 = same(chosen.map((c) => c.scene));
  const shot0 = same(chosen.map((c) => String(c.shot).toUpperCase()));
  const selected = new Set(chosen.map((c) => c.key));
  const title = opts.title || (chosen.length === 1 ? `Rename ${chosen[0].scene}.${chosen[0].shot} take ${chosen[0].take}` : `Rename ${plural(chosen.length, 'take')}`);

  const p = openPopup({
    title, subtitle: 'Change the scene or shot, and renumber the takes if you want. Leave a field empty to keep it.', width: 780,
    body: html`<div style="display:grid;gap:14px">
      <div class="row" style="gap:12px;align-items:flex-start">
        ${field('Scene', html`<input class="app-input" id="rScene" value="${scene0}" placeholder="${scene0 ? '' : 'keep'}" style="width:100px" maxlength="6" spellcheck="false">`, scene0 ? '' : 'Takes are from several scenes. Empty keeps each one.')}
        ${field('Shot', html`<input class="app-input" id="rShot" value="${shot0}" placeholder="${shot0 ? '' : 'keep'}" style="width:100px" maxlength="6" spellcheck="false">`, shot0 ? '' : 'Takes are from several shots. Empty keeps each one.')}
        <div class="grow"></div>
        <div class="app-field"><div class="label">Take numbers</div><div class="app-segmented" role="radiogroup" aria-label="Take numbers"><button role="radio" aria-checked="true" data-tm="keep">Keep</button><button role="radio" aria-checked="false" data-tm="renumber">Renumber from</button></div></div>
        <div class="app-field"><div class="label">&nbsp;</div><input class="app-input" id="rStart" type="number" min="1" value="1" style="width:80px" disabled aria-label="First take number"></div>
      </div>
      <div class="faint" id="rHint" style="font-size:12px"></div>
      <div class="rename-list" id="rList" style="max-height:340px"></div>
      <div id="rWarn"></div></div>`,
    foot: html`<button class="app-btn" data-no>Cancel</button><button class="app-btn app-btn--primary" id="rGo">Rename</button>`,
  });
  const el = p.el;
  const q = (s) => el.querySelector(s);
  let mode = 'keep';
  let startTouched = false;

  const target = (c) => ({ scene: q('#rScene').value.trim() || String(c.scene), shot: (q('#rShot').value.trim() || String(c.shot)).toUpperCase() });

  // when renumbering, the first number defaults to one past the highest take that is staying in the target shot
  const defaultStart = () => {
    const t = target(chosen[0]);
    const staying = allClips().filter((c) => c.kind === 'shot' && !selected.has(c.key) && String(c.scene) === t.scene && String(c.shot).toUpperCase() === t.shot);
    return (staying.length ? Math.max(...staying.map((c) => c.take)) : 0) + 1;
  };

  const items = () => {
    const counters = new Map();
    const start = parseInt(q('#rStart').value, 10) || 1;
    return chosen.map((c) => {
      const t = target(c);
      let take = c.take;
      if (mode === 'renumber') { const g = `${t.scene}|${t.shot}`; const n = counters.get(g) || 0; counters.set(g, n + 1); take = start + n; }
      return { key: c.key, scene: t.scene, shot: t.shot, take };
    });
  };

  const hint = () => {
    const sc = q('#rScene').value.trim(); const sh = q('#rShot').value.trim();
    const bits = [];
    if (sc && sc !== scene0) bits.push(`scene ${sc}`);
    if (sh && sh.toUpperCase() !== shot0) bits.push(`shot ${sh.toUpperCase()}`);
    if (mode === 'renumber') bits.push(`takes numbered from ${q('#rStart').value || 1} in recording order`);
    q('#rHint').textContent = bits.length ? `Changing ${bits.join(', ')}.` : 'Nothing to change yet. Type a new scene or shot, or renumber the takes.';
  };

  let names = new Map(); let why = new Map();
  const rows = () => mount(q('#rList'), html`${chosen.map((c) => html`<div class="rename-row" role="row">
      <span style="min-width:0"><span class="mono-name faint">${c.name}</span></span><span class="faint">${icon('arrowRight', 14)}</span>
      <span class="mono-name">${why.has(c.key) ? html`<span style="color:var(--color-warning)">${why.get(c.key)}</span>` : names.has(c.key) ? html`<b>${names.get(c.key)}</b>` : html`<span class="faint">unchanged</span>`}</span></div>`)}`);

  let seq = 0;
  const draw = async () => {
    hint(); rows();
    const mine = ++seq;
    const go = q('#rGo');
    names = new Map(); why = new Map();
    try {
      const r = await post('/api/rename-many', { items: items(), apply: false });
      if (mine !== seq) return;
      for (const c of r.changes) names.set(c.key, c.to);
      for (const c of r.conflicts) why.set(c.key, c.reason);
      rows();
      go.disabled = !r.changes.length;
      go.textContent = r.changes.length ? `Rename ${plural(r.changes.length, 'take')}` : 'Nothing to rename';
      mount(q('#rWarn'), html`${r.conflicts.length ? html`<div class="app-alert app-alert--warning">${icon('warn')}<div class="grow"><b>${plural(r.conflicts.length, 'take')} will be left alone</b>A name that already exists is never overwritten. Pick another shot or take number.</div></div>` : ''}
        ${r.changes.some((c) => allClips().find((x) => x.key === c.key)?.cutOnCanvas) ? html`<div class="app-alert app-alert--warning" style="margin-top:10px">${icon('warn')}<div class="grow"><b>Some of these are on the canvas</b>Their clips there keep the old names, so sending them again would add a second copy.</div></div>` : ''}`);
    } catch (e) { mount(q('#rWarn'), html`<div class="app-alert app-alert--error">${icon('alert')}<div class="grow">${e.message}</div></div>`); go.disabled = true; }
  };
  const soon = debounce(draw, 180);

  el.addEventListener('input', (e) => {
    if (e.target.id === 'rStart') startTouched = true;
    if ((e.target.id === 'rScene' || e.target.id === 'rShot') && mode === 'renumber' && !startTouched) q('#rStart').value = defaultStart();
    soon();
  });
  on(el, 'click', '[data-tm]', (e, b) => {
    mode = b.dataset.tm;
    el.querySelectorAll('[data-tm]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    q('#rStart').disabled = mode !== 'renumber';
    if (mode === 'renumber' && !startTouched) q('#rStart').value = defaultStart();
    draw();
  });
  q('[data-no]').addEventListener('click', p.close);
  q('#rGo').addEventListener('click', async () => {
    const go = q('#rGo'); go.disabled = true;
    try {
      const r = await post('/api/rename-many', { items: items(), apply: true });
      p.close();
      await loadLibrary();
      toast(`Renamed ${plural(r.renamed, 'take')}${r.conflicts.length ? `, ${r.conflicts.length} left alone` : ''}.`, {
        type: 'success', timeout: 12000,
        link: { text: 'Undo', onClick: () => post('/api/rename/undo').then((u) => { toast(`Undid: ${u.undone}`, { type: 'success' }); return loadLibrary(); }).catch(toastError) },
      });
      if (opts.afterRename) opts.afterRename(r.changes);
    } catch (e) { go.disabled = false; toastError(e); }
  });
  hint(); draw();
  setTimeout(() => { const f = q(scene0 ? '#rShot' : '#rScene'); f.focus(); f.select(); }, 30);
}
