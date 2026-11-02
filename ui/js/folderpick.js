// The folder control shared by Dashboard, Review, Ingest and Canvas: one place to say "only show Shoot day 2".
import { html, icon, plural, fmtDur } from './lib.js';
import { S, folders, folderLabel, setFolderFilter } from './store.js';
import { openMenu } from './ui.js';

/** True when there is more than one place footage lives in, so a folder control is worth showing. */
export const worthShowing = () => folders().filter((f) => f.direct > 0).length > 1 || !!S.filters.folder;

/** The button. Wire it with on(root, 'click', '[data-folder-btn]', (e, el) => openFolderMenu(el)). */
export function folderButton({ outline = true } = {}) {
  if (!worthShowing()) return '';
  const f = S.filters.folder;
  return html`<button class="app-btn ${outline ? 'app-btn--outline' : ''} ${f ? 'is-filtering' : ''}" data-folder-btn title="Show only one folder (shoot day, camera card…)">${icon('folder')}<span>${f ? folderLabel(f) : 'All folders'}</span>${icon('chevronDown', 12)}</button>`;
}

/** A removable chip that says a filter is on. */
export function folderChip() {
  const f = S.filters.folder;
  if (!f) return '';
  return html`<span class="app-chip app-chip--ink" title="Only this folder is shown">${icon('folder', 12)} ${folderLabel(f)}<button class="chip-x" data-folder-clear aria-label="Show all folders" title="Show all folders">${icon('close', 12)}</button></span>`;
}

/** The folders as an indented list with clip counts. Choosing one includes everything inside it. */
export function openFolderMenu(anchor, { onPick } = {}) {
  const f = S.filters.folder;
  const all = folders();
  const total = all.find((x) => x.path === '.') ? all.find((x) => x.path === '.').clips : all.filter((x) => x.depth === 1).reduce((a, x) => a + x.clips, 0);
  const pick = (path) => { setFolderFilter(path); if (onPick) onPick(path); };
  const items = [
    { head: 'Show' },
    { label: 'All folders', icon: 'layers', checked: !f, trail: String(total), onClick: () => pick('') },
    { sep: true },
    ...all.filter((x) => x.path !== '.').map((x) => ({
      label: `${' '.repeat(Math.max(0, x.depth - 1))}${x.name}`,
      icon: 'folder', checked: f === x.path, trail: `${x.clips}${x.raw ? ` · ${x.raw} unnamed` : ''}`, onClick: () => pick(x.path),
    })),
  ];
  openMenu(anchor, items);
}

/** Wire the shared clicks for a view root. */
export function wireFolderControls(root, on) {
  on(root, 'click', '[data-folder-btn]', (e, el) => openFolderMenu(el));
  on(root, 'click', '[data-folder-clear]', (e) => { e.stopPropagation(); setFolderFilter(''); });
}
