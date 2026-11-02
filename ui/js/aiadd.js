// "Add AI results": choose generated videos (files, or videos already on your canvas), say which take each one
// came from, and the Compare view can put them side by side with the original.
import { html, icon, mount, on, plural, fmtDur, $, esc } from './lib.js';
import { get, post } from './api.js';
import { S, allClips } from './store.js';
import { openPopup, toast, toastError } from './ui.js';

const enc = encodeURIComponent;

/** @param {{key?: string}} [opts] key: a take to map everything to by default */
export function openAddAi({ key } = {}) {
  const takes = allClips().filter((c) => c.kind === 'shot').sort((a, b) => String(a.scene).localeCompare(String(b.scene), 'en', { numeric: true }) || String(a.shot).localeCompare(String(b.shot), 'en', { numeric: true }) || a.take - b.take);
  if (!takes.length) { toast('Name some clips first (Ingest). AI results are mapped to named takes.'); return; }
  const rows = []; // { rid, kind, path|url, nodeId, name, label, key, cut, why, width, height }
  let rid = 0;
  const connected = S.info.key.set && S.info.project.canvas.canvasId;

  const p = openPopup({
    title: 'Add AI results', subtitle: 'The videos you generated, and the take each one came from.', width: 860,
    body: html`<div style="display:grid;gap:16px">
      <div class="row wrap" style="gap:8px">
        <button class="app-btn app-btn--outline" id="aaFiles">${icon('folder')}<span>Choose files…</span></button>
        <button class="app-btn app-btn--outline" id="aaCanvas" ${connected ? '' : 'disabled'} title="${connected ? 'Pick videos that are already on your LetzAI canvas' : 'Connect your canvas first (Canvas tab)'}">${icon('canvas')}<span>From the canvas…</span></button>
        <span class="faint" style="font-size:12px">or paste a link</span>
        <input class="app-input" id="aaUrl" placeholder="https://…" style="width:260px" spellcheck="false"><button class="app-btn" id="aaUrlAdd">Add</button>
      </div>
      <div id="aaPicker"></div>
      <div id="aaRows"></div>
      <div id="aaWarn"></div></div>`,
    foot: html`<button class="app-btn" data-no>Cancel</button><button class="app-btn app-btn--primary" id="aaGo" disabled>Add</button>`,
  });
  const q = (s) => p.el.querySelector(s);

  const takeOptions = (selected) => {
    let lastGroup = ''; let out = '';
    for (const c of takes) {
      const g = `Scene ${c.scene} · shot ${c.shot}`;
      if (g !== lastGroup) { if (lastGroup) out += '</optgroup>'; out += `<optgroup label="${esc(g)}">`; lastGroup = g; }
      out += `<option value="${esc(c.key)}" ${c.key === selected ? 'selected' : ''}>${esc(`${c.scene}.${c.shot} take ${c.take}`)}</option>`;
    }
    return out + (lastGroup ? '</optgroup>' : '');
  };
  const startOf = (r) => {
    const c = allClips().find((x) => x.key === r.key);
    if (!c || !r.cut) return null;
    const max = Number(S.info.project.snippets.maxSeconds) || 30;
    const starts = c.cutRanges && c.cutRanges.length ? c.cutRanges.map((x) => x.in) : Array.from({ length: Math.max(1, Math.ceil((c.duration || 0) / max - 1e-9)) }, (_, i) => i * max);
    return starts[r.cut - 1] != null ? starts[r.cut - 1] : null;
  };

  const draw = () => {
    const mapped = rows.filter((r) => r.key).length;
    const go = q('#aaGo');
    go.disabled = !mapped;
    go.textContent = mapped ? `Add ${plural(mapped, 'result')}` : 'Add';
    mount(q('#aaWarn'), rows.length && mapped < rows.length ? html`<div class="app-alert app-alert--warning">${icon('warn')}<div class="grow"><b>${plural(rows.length - mapped, 'video')} without a take</b>Choose the take each one came from, or they will be skipped.</div></div>` : '');
    mount(q('#aaRows'), rows.length ? html`
      <div class="rename-list" style="max-height:340px">${rows.map((r) => html`<div class="ai-row" data-rid="${r.rid}">
        <div style="min-width:0"><div class="mono-name"><b>${r.name}</b></div><div class="faint" style="font-size:11px">${r.kind === 'url' ? 'From your canvas' : 'File on this computer'}${r.why ? ` · ${r.why}` : ''}</div></div>
        <span class="faint">${icon('arrowRight', 14)}</span>
        <select class="app-input" data-take aria-label="Take"></select>
        <div class="row" style="gap:6px"><span class="faint" style="font-size:12px">snippet</span><input class="app-input tnum" data-cut type="number" min="1" placeholder="–" value="${r.cut || ''}" style="width:64px" aria-label="Snippet number"></div>
        <div class="faint tnum" style="font-size:11px;min-width:84px">${startOf(r) != null ? `starts ${fmtDur(startOf(r))}` : ''}</div>
        <button class="app-icon-btn app-icon-btn--sm" data-drop title="Remove from this list">${icon('close', 14)}</button></div>`)}</div>
` : html`<div class="faint" style="padding:6px 2px">Nothing chosen yet.</div>`);
    // the option lists are filled after mounting (they are long, and need to keep the current choice)
    p.el.querySelectorAll('.ai-row').forEach((rowEl) => {
      const r = rows.find((x) => String(x.rid) === rowEl.dataset.rid);
      rowEl.querySelector('[data-take]').innerHTML = `<option value="">Which take?</option>${takeOptions(r.key)}`;
    });
  };

  const suggest = async (added) => {
    try {
      const res = await post('/api/ai/suggest', { names: added.map((r) => r.name) });
      added.forEach((r, i) => {
        const s = res.suggestions[i];
        if (s && s.key) { r.key = s.key; r.cut = s.cut || null; r.why = s.why; }
        else if (key) { r.key = key; r.why = 'the take you are looking at'; }
      });
    } catch { if (key) added.forEach((r) => { r.key = r.key || key; }); }
    draw();
  };
  const addRows = (list) => { rows.push(...list); draw(); suggest(list); };

  q('#aaFiles').addEventListener('click', async () => {
    try {
      const r = await post('/api/pick-files', { title: 'Choose the AI videos' });
      if (!r.paths.length) return;
      addRows(r.paths.map((path) => ({ rid: ++rid, kind: 'file', path, name: path.split(/[\\/]/).pop(), label: path.split(/[\\/]/).pop().replace(/\.[^.]+$/, ''), key: null, cut: null })));
    } catch (e) { toastError(e); }
  });
  const addUrl = () => {
    const v = q('#aaUrl').value.trim();
    if (!/^https:\/\//i.test(v)) { toast('A link has to start with https://'); return; }
    q('#aaUrl').value = '';
    addRows([{ rid: ++rid, kind: 'url', url: v, name: decodeURIComponent(v.split('?')[0].split('/').pop() || 'AI result'), label: 'AI result', key: null, cut: null }]);
  };
  q('#aaUrlAdd').addEventListener('click', addUrl);
  q('#aaUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') addUrl(); });

  q('#aaCanvas').addEventListener('click', async () => {
    const box = q('#aaPicker');
    mount(box, html`<div class="row faint" style="padding:12px"><span class="spinner"></span> Looking for videos on your canvas…</div>`);
    try {
      const { media } = await get('/api/canvas/media');
      if (!media.length) { mount(box, html`<div class="app-alert">${icon('info')}<div class="grow"><b>No generated videos on this canvas yet</b></div></div>`); return; }
      mount(box, html`<div class="surface" style="padding:12px">
        <div class="row" style="margin-bottom:8px"><b class="grow">${plural(media.length, 'video')} on the canvas</b><button class="app-btn app-btn--sm" id="aaCvClose">Close</button><button class="app-btn app-btn--sm app-btn--primary" id="aaCvUse">Use ticked</button></div>
        <div class="canvas-grid">${media.map((m, i) => html`<label class="canvas-item"><input type="checkbox" class="app-check" data-cm="${i}">
          <video muted preload="metadata" src="${m.url}#t=0.2" class="canvas-prev"></video>
          <span class="faint" style="font-size:11px">${m.page ? `${m.page} · ` : ''}${m.width ? `${m.width}×${m.height} · ` : ''}${m.createdAt ? new Date(m.createdAt).toLocaleDateString() : ''}</span></label>`)}</div></div>`);
      q('#aaCvClose').addEventListener('click', () => mount(box, ''));
      q('#aaCvUse').addEventListener('click', () => {
        const picked = [...p.el.querySelectorAll('[data-cm]:checked')].map((b) => media[Number(b.dataset.cm)]);
        if (!picked.length) { toast('Tick at least one video.'); return; }
        mount(box, '');
        addRows(picked.map((m, i) => ({ rid: ++rid, kind: 'url', url: m.url, nodeId: m.nodeId, width: m.width, height: m.height, name: `Canvas video${m.page ? ` (${m.page})` : ''} ${i + 1}`, label: `AI result ${rows.length + i + 1}`, key: null, cut: null })));
      });
    } catch (e) { mount(box, html`<div class="app-alert app-alert--error">${icon('alert')}<div class="grow">${e.message}</div></div>`); }
  });

  p.el.addEventListener('change', (e) => {
    const rowEl = e.target.closest('.ai-row'); if (!rowEl) return;
    const r = rows.find((x) => String(x.rid) === rowEl.dataset.rid);
    if (e.target.matches('[data-take]')) { r.key = e.target.value || null; r.why = r.key ? 'chosen by you' : ''; draw(); }
    if (e.target.matches('[data-cut]')) { r.cut = parseInt(e.target.value, 10) || null; draw(); }
  });
  p.el.addEventListener('click', (e) => { const d = e.target.closest('[data-drop]'); if (!d) return; const rowEl = d.closest('.ai-row'); const i = rows.findIndex((x) => String(x.rid) === rowEl.dataset.rid); rows.splice(i, 1); draw(); });
  q('[data-no]').addEventListener('click', p.close);
  q('#aaGo').addEventListener('click', async () => {
    const go = q('#aaGo'); go.disabled = true;
    const byTake = new Map();
    for (const r of rows.filter((x) => x.key)) {
      if (!byTake.has(r.key)) byTake.set(r.key, []);
      byTake.get(r.key).push({ ...(r.kind === 'file' ? { path: r.path } : { url: r.url, nodeId: r.nodeId, width: r.width, height: r.height }), label: r.label, cut: r.cut || undefined });
    }
    try {
      let firstKey = null; let firstId = null; let n = 0;
      for (const [k, items] of byTake) {
        const res = await post('/api/ai/add', { key: k, items });
        n += res.added.length;
        if (!firstKey) { firstKey = k; firstId = res.added[0]; }
      }
      p.close();
      toast(`Mapped ${plural(n, 'AI result')}.`, { type: 'success', timeout: 9000, link: { text: 'Compare', onClick: () => window.kitGo('compare', firstKey, firstId) } });
      window.kitGo('compare', firstKey, firstId);
    } catch (e) { go.disabled = false; toastError(e); }
  });

  draw();
  if (key) q('#aaFiles').focus();
}
