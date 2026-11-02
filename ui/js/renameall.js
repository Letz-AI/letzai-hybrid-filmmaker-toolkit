// "Rename all": apply the naming scheme (prefix, padding, rating tags) to every named take at once.
// Always previewed first, and always one undo.
import { html, icon, mount, plural, $ } from './lib.js';
import { get, post } from './api.js';
import { loadLibrary } from './store.js';
import { openPopup, toast, toastError } from './ui.js';

export async function openRenameAll() {
  const p = openPopup({
    title: 'Rename all files', subtitle: 'Apply the current naming scheme to every take you have already named.', width: 760,
    body: html`<div class="row faint" style="padding:24px"><span class="spinner"></span> Working out what would change…</div>`,
  });
  let pv;
  try { pv = await get('/api/rename-all/preview'); } catch (e) { p.close(); toastError(e); return; }

  const sch = pv.scheme;
  const padLabel = (n) => (n ? `${n} digits` : 'none');
  const example = `${sch.prefix}-scene${'6'.padStart(sch.pad.scene || 0, '0')}-shot2A-take${'3'.padStart(sch.pad.take || 0, '0')}${sch.ratingInFilename ? '-good-print' : ''}`;
  const nothing = !pv.changes.length;
  const shown = pv.changes.slice(0, 200);

  mount(p.body, html`
    <div style="display:grid;gap:16px">
      <div class="surface pad" style="background:var(--control-hover-bg)">
        <div class="insp-label">Current scheme</div>
        <div class="mono-name tnum" style="font-size:15px;font-weight:600">${example}</div>
        <div class="faint" style="margin-top:6px;font-size:12px">Prefix <b style="display:inline">${sch.prefix}</b> · scene ${padLabel(sch.pad.scene)} · shot ${padLabel(sch.pad.shot)} · take ${padLabel(sch.pad.take)} · rating in name ${sch.ratingInFilename ? 'on' : 'off'}. Change it in <a href="#/settings/film" data-settings>Settings</a>.</div>
      </div>

      ${nothing ? html`<div class="app-alert app-alert--success">${icon('checkCircle')}<div class="grow"><b>Everything already follows the scheme</b>${plural(pv.total, 'take')} checked, nothing to rename.</div></div>` : html`
        <div class="row wrap" style="gap:8px"><span class="app-chip app-chip--ink">${plural(pv.changes.length, 'take')} to rename</span>
          ${pv.unchanged ? html`<span class="app-chip">${pv.unchanged} already fine</span>` : ''}
          ${pv.conflicts.length ? html`<span class="app-chip app-chip--warning">${pv.conflicts.length} skipped</span>` : ''}
          <span class="faint">Cut snippets and camera proxies are renamed along with their take.</span></div>

        ${pv.onCanvas ? html`<div class="app-alert app-alert--warning">${icon('warn')}<div class="grow"><b>${plural(pv.onCanvas, 'take')} already on the canvas</b>Canvas copies keep their old names, so sending again adds a second copy.</div></div>` : ''}

        <div class="rename-list" role="table" aria-label="Files that will be renamed">
          ${shown.map((c) => html`<div class="rename-row" role="row"><span class="mono-name faint">${c.from}</span><span class="faint">${icon('arrowRight', 14)}</span><span class="mono-name"><b>${c.to}</b>${c.cuts || c.proxy ? html` <span class="faint">+ ${[c.cuts ? plural(c.cuts, 'cut') : '', c.proxy ? 'proxy' : ''].filter(Boolean).join(', ')}</span>` : ''}</span></div>`)}
          ${pv.changes.length > shown.length ? html`<div class="faint" style="padding:8px 12px">and ${pv.changes.length - shown.length} more</div>` : ''}
        </div>

        ${pv.conflicts.length ? html`<div class="app-alert app-alert--warning">${icon('warn')}<div class="grow"><b>${plural(pv.conflicts.length, 'take')} left alone</b>Their new name is already taken by another file.${pv.conflicts.slice(0, 4).map((c) => html`<div class="faint mono-name" style="font-size:12px;margin-top:4px">${c.name} → ${c.to}</div>`)}</div></div>` : ''}
        <div class="faint" style="font-size:12px">Ratings and print flags that only live in a file name (like <span class="mono-name">-good-print</span>) are saved in the project file first, so nothing is lost. You can undo the whole rename afterwards.</div>`}
    </div>`);

  const foot = p.foot || (() => { const f = document.createElement('div'); f.className = 'popup-foot'; p.el.append(f); return f; })();
  mount(foot, html`<button class="app-btn" data-no>${nothing ? 'Close' : 'Cancel'}</button>${nothing ? '' : html`<button class="app-btn app-btn--primary" id="raGo">${icon('check')}<span>Rename ${plural(pv.changes.length, 'take')}</span></button>`}`);
  $('[data-no]', foot).addEventListener('click', p.close);
  p.el.querySelector('[data-settings]')?.addEventListener('click', p.close);
  const go = $('#raGo', foot);
  if (go) {
    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        const r = await post('/api/rename-all');
        p.close();
        await loadLibrary();
        toast(`Renamed ${plural(r.renamed, 'take')} (${plural(r.files, 'file')})${r.skipped ? `, ${r.skipped} left alone` : ''}.`, {
          type: 'success', timeout: 12000,
          link: { text: 'Undo', onClick: () => post('/api/rename/undo').then((u) => toast(`Undid: ${u.undone}`, { type: 'success' })).catch(toastError) },
        });
      } catch (e) { go.disabled = false; toastError(e); }
    });
    go.focus();
  }
}
