// Command palette (Ctrl/Cmd+K): jump to any shot or take, or run an action.
import { html, icon, mount, $, $$ } from './lib.js';
import { S, clips, unnamed, folders, setFolderFilter } from './store.js';
import { openPopup } from './ui.js';

function actionList() {
  const go = (v) => () => window.kitGo(v);
  return [
    { label: 'Go to Board', icon: 'board', hay: 'board coverage missing overview', run: go('board') },
    { label: 'Go to Review', icon: 'review', hay: 'review watch player', run: go('review') },
    { label: 'Go to Ingest (name raw clips)', icon: 'slate', hay: 'ingest slate name rename raw unnamed', run: go('ingest') },
    { label: 'Go to Canvas', icon: 'canvas', hay: 'canvas letzai send upload', run: go('canvas') },
    { label: 'Go to Settings', icon: 'settings', hay: 'settings setup folders ffmpeg', run: go('settings') },
    { label: 'Rename takes (change scene, shot or take numbers)', icon: 'pencil', hay: 'rename takes shot scene renumber change fix mislabeled wrong named', run: () => { window.kitGo('board'); S.filters.boardMode = 'clips'; setTimeout(() => document.querySelector('[data-mode=clips]')?.click(), 300); } },
    { label: 'Compare original with AI result', icon: 'compare', hay: 'compare original ai result generated slider before after wipe', run: go('compare') },
    { label: 'Add AI results (map generated videos to takes)', icon: 'plus', hay: 'add ai results generated videos map takes compare', run: () => import('./aiadd.js').then((m) => m.openAddAi({})) },
    { label: 'Read slates of unnamed clips with Claude', icon: 'bolt', hay: 'claude ai read slate klappe name unnamed suggest anthropic', run: () => import('./slate.js').then((m) => m.openSlateReader({ keys: unnamed().map((c) => c.key), title: 'Read slates with Claude' })) },
    { label: 'Check names: read slates of named takes again with Claude', icon: 'bolt', hay: 'claude ai check verify re-read reread slate klappe named takes names wrong', run: () => import('./slate.js').then((m) => m.openSlateReader({ keys: clips().filter((c) => c.kind === 'shot').map((c) => c.key), force: true, title: 'Check names with Claude' })) },
    { label: 'Name several clips at once', icon: 'slate', hay: 'name rename multiple several batch many clips ingest slate', run: () => { window.kitGo('ingest'); setTimeout(() => import('./views/ingest.js').then((m) => m.openBulkName()), 400); } },
    { label: 'Add a scene', icon: 'plus', hay: 'add new scene plan', run: () => import('./views/shotlist.js').then((m) => m.addSceneDialog()) },
    { label: 'Edit shot list', icon: 'list', hay: 'shot list plan edit scenes', run: () => import('./views/shotlist.js').then((m) => m.openShotList()) },
    { label: 'Rename all files to the current naming scheme', icon: 'pencil', hay: 'rename all files batch naming scheme prefix padding', run: () => import('./renameall.js').then((m) => m.openRenameAll()) },
    { label: 'Undo last rename', icon: 'undo', hay: 'undo rename', run: () => import('./views/ingest.js').then((m) => m.undoRename()) },
    { label: 'Rescan folders', icon: 'regenerate', hay: 'rescan refresh reload folders', run: () => import('./app.js').then((m) => m.rescan()) },
    { label: 'Download continuity log (CSV)', icon: 'download', hay: 'export report continuity csv', run: () => { location.href = '/api/report/continuity.csv'; } },
    { label: 'Download missing shots (CSV)', icon: 'download', hay: 'export report missing csv', run: () => { location.href = '/api/report/missing.csv'; } },
  ];
}

function score(item, tokens) {
  const hay = item.hay;
  let s = 0;
  for (const t of tokens) {
    if (!hay.includes(t)) return -1;
    s += /^\d+$/.test(t) ? (new RegExp(`(^|[^0-9a-z])${t}([^0-9]|$)`).test(hay) ? 3 : 1) : 2;
  }
  // "6 2" or "6.2" means scene 6, shot 2 (a third number is the take): exact shot matches come first.
  if (item.type === 'shot' && tokens.length >= 2 && tokens.length <= 3) {
    const [a, b, c] = tokens.length === 2 && tokens[0].includes('.') ? [...tokens[0].split('.'), tokens[1]] : tokens;
    if (item.scene === a && item.shot === b) s += 20 + (c && String(item.take) === c ? 10 : 0);
  }
  return s + (item.type === 'shot' ? 1 : 0);
}

export function openPalette() {
  const shots = clips().filter((c) => c.kind === 'shot').map((c) => ({
    type: 'shot', key: c.key, scene: String(c.scene).toLowerCase(), shot: String(c.shot).toLowerCase(), take: c.take, label: `${c.scene}.${c.shot} · take ${c.take}`, sub: `Scene ${c.scene}${c.note ? ` · ${c.note}` : ''}`, icon: 'review',
    hay: `${c.scene}.${c.shot} scene ${c.scene} shot ${c.shot} take ${c.take} ${c.name} ${c.orig} ${c.note} ${c.rating} ${c.print ? 'print' : ''}`.toLowerCase(),
  }));
  const raws = unnamed().map((c) => ({ type: 'raw', key: c.key, label: c.orig || c.name, sub: 'Unnamed clip', icon: 'slate', hay: `${c.name} ${c.orig} unnamed raw`.toLowerCase() }));
  const folderActs = folders().filter((f) => f.path !== '.').map((f) => ({ type: 'action', label: `Only show ${f.name}`, icon: 'folder', hay: `folder ${f.path} only show ${f.name} shoot day`.toLowerCase(), run: () => { setFolderFilter(f.path); window.kitGo('board'); } }));
  if (S.filters.folder) folderActs.unshift({ type: 'action', label: 'Show all folders', icon: 'layers', hay: 'folder all show clear filter', run: () => setFolderFilter('') });
  const actions = [...actionList(), ...folderActs].map((a) => ({ ...a, type: 'action', hay: `${a.label} ${a.hay}`.toLowerCase() }));
  const all = [...actions, ...shots, ...raws];

  const p = openPopup({
    title: 'Jump to', width: 620, className: 'palette',
    body: html`<input class="app-input" id="palq" placeholder="Shot like 6.2 or 7 2 3, a file name, or an action…" autocomplete="off" spellcheck="false"><div id="palr" class="pal-results" role="listbox"></div>`,
  });
  const input = $('#palq', p.el);
  const out = $('#palr', p.el);
  let results = [];
  let sel = 0;

  const draw = () => {
    const q = input.value.trim().toLowerCase();
    const tokens = q.split(/[\s·]+/).filter(Boolean);
    results = (tokens.length ? all.map((it) => ({ it, s: score(it, tokens) })).filter((r) => r.s >= 0).sort((a, b) => b.s - a.s).map((r) => r.it) : actions).slice(0, 14);
    sel = Math.min(sel, Math.max(0, results.length - 1));
    mount(out, results.length ? html`${results.map((r, i) => html`<button role="option" class="pal-item ${i === sel ? 'sel' : ''}" data-i="${i}">${icon(r.icon)}<span class="grow"><span class="pal-label">${r.label}</span>${r.sub ? html` <span class="faint">${r.sub}</span>` : ''}</span>${r.type === 'action' ? html`<span class="faint">Action</span>` : ''}</button>`)}`
      : html`<div class="app-empty" style="padding:24px"><div class="app-empty-body">Nothing matches “${q}”.</div></div>`);
  };
  const choose = (i) => {
    const r = results[i];
    if (!r) return;
    p.close();
    if (r.type === 'action') r.run();
    else if (r.type === 'shot') window.kitGo('review', r.key);
    else window.kitGo('ingest', r.key);
  };
  input.addEventListener('input', () => { sel = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(results.length - 1, sel + 1); draw(); $('.sel', out)?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); $('.sel', out)?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(sel); }
  });
  out.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) choose(+b.dataset.i); });
  out.addEventListener('mousemove', (e) => { const b = e.target.closest('[data-i]'); if (b && +b.dataset.i !== sel) { sel = +b.dataset.i; $$('.pal-item', out).forEach((el, i) => el.classList.toggle('sel', i === sel)); } });
  draw();
}
