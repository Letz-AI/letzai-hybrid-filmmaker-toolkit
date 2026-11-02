// Tiny UI toolkit: safe HTML templates, icons, formatting. No framework, no build step.

export class Safe { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Safe(String(s));

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

const toS = (v) => {
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(toS).join('');
  if (v == null || v === false) return '';
  return esc(v);
};

/** Tagged template: every interpolated value is HTML-escaped unless it is itself html`` output. */
export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => { out += s; if (i < vals.length) out += toS(vals[i]); });
  return new Safe(out);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function mount(el, content) { el.innerHTML = content instanceof Safe ? content.s : String(content); return el; }

/** Event delegation: on(root, 'click', '[data-act]', (event, matchedElement) => ...) */
export function on(root, type, selector, handler) {
  root.addEventListener(type, (e) => {
    const el = e.target.closest(selector);
    if (el && root.contains(el)) handler(e, el);
  });
}

// ---- icons (24 grid, 1.5 stroke, currentColor) --------------------------------
// Shared with the LetzAI web app: every icon that exists there (canvas, settings, folder, …) is the same drawing,
// taken from letzai-frontend components/icons. review, slate, list, keyboard, dot, dashed and cloud are the kit's own.
const P = {
  board: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.8"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.8"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.8"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.8"/>',
  review: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M10.5 9.5v5l4-2.5z"/>',
  slate: '<path d="M4 10h16v8.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z"/><path d="m4 10-.7-3.6a1 1 0 0 1 .8-1.2L18.5 3l.9 4.4L4 10zM8.2 9.2 7.3 4.4M13 8.3l-.9-4.7"/>',
  canvas: '<rect x="3.5" y="3.5" width="7" height="9" rx="2"/><rect x="13.5" y="3.5" width="7" height="5" rx="2"/><rect x="13.5" y="11.5" width="7" height="9" rx="2"/><rect x="3.5" y="15.5" width="7" height="5" rx="2"/>',
  settings: '<circle cx="12" cy="12" r="2.8"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2.1-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2.1 1.2l-2.3-.9-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-.9a7 7 0 0 0 2.1 1.2L10 21h4l.5-2.6a7 7 0 0 0 2.1-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  plus: '<g fill="currentColor" stroke="none"><path d="M10.25 5h3.5v5.25H19v3.5h-5.25V19h-3.5v-5.25H5v-3.5h5.25V5Z"/></g>',
  close: '<path d="M7 7l10 10M17 7 7 17"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  checkCircle: '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/>',
  chevronDown: '<path d="m7 10 5 5 5-5"/>',
  chevronRight: '<path d="m10 7 5 5-5 5"/>',
  chevronLeft: '<path d="m14 7-5 5 5 5"/>',
  chevronUp: '<path d="m7 14 5-5 5 5"/>',
  arrowLeft: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  pause: '<path d="M8.5 5.5v13M15.5 5.5v13"/>',
  stepBack: '<path d="M6.5 5.5v13M18 6v12l-8.5-6z"/>',
  stepForward: '<path d="M17.5 5.5v13M6 6v12l8.5-6z"/>',
  scissors: '<circle cx="6.5" cy="7" r="2.5"/><circle cx="6.5" cy="17" r="2.5"/><path d="M8.6 8.4 19.5 17.5M8.6 15.6 19.5 6.5"/>',
  upload: '<path d="M12 15.5V4.5M7.5 9 12 4.5 16.5 9"/><path d="M4.5 14.5v2.5a3 3 0 0 0 3 3h9a3 3 0 0 0 3-3v-2.5"/>',
  download: '<path d="M12 4.5v11M7.5 11l4.5 4.5 4.5-4.5"/><path d="M4.5 14.5v2.5a3 3 0 0 0 3 3h9a3 3 0 0 0 3-3v-2.5"/>',
  folder: '<path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h4.5l2 2.5H19A1.5 1.5 0 0 1 20.5 9.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/>',
  more: '<g fill="currentColor" stroke="none"><circle cx="5.5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18.5" cy="12" r="1.6"/></g>',
  alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5M12 16h.01"/>',
  warn: '<path d="M10.3 4.3 3.4 16.5A2 2 0 0 0 5.1 19.5h13.8a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z"/><path d="M12 9.5v4M12 16.5h.01"/>',
  info: '<circle cx="12" cy="12" r="8.25"/><path d="M12 11v5M12 8h.01"/>',
  thumbsUp: '<path d="M7.5 10.5h-3v9h3z"/><path d="m7.5 10.5 3.6-6a1.9 1.9 0 0 1 3.4 1.5l-.8 3.5h4.8a2 2 0 0 1 2 2.4l-1.3 6a2 2 0 0 1-2 1.6H7.5"/>',
  ban: '<circle cx="12" cy="12" r="8.5"/><path d="m6 6 12 12"/>',
  flag: '<path d="M5.5 20.5v-16M5.5 5h11l-2 4 2 4h-11"/>',
  flagFill: '<path d="M5.5 20.5v-16"/><path d="M5.5 5h11l-2 4 2 4h-11z" fill="currentColor"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
  trash: '<path d="M4.5 7h15M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7"/><path d="m6.5 7 .8 11.2a2 2 0 0 0 2 1.8h5.4a2 2 0 0 0 2-1.8L17.5 7M10.5 11v5M13.5 11v5"/>',
  pencil: '<path d="M15.6 4.9a2.1 2.1 0 0 1 3 3L8.4 18.1 4.5 19.5l1.4-3.9z"/>',
  compare: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M12 2.5v19"/>',
  expand: '<rect x="7.5" y="7.5" width="9" height="9" rx="1.5"/><path d="M3.5 7V3.5H7M17 3.5h3.5V7M20.5 17v3.5H17M7 20.5H3.5V17"/>',
  filter: '<path d="M4 7.5h8.5M16.5 7.5H20M4 16.5h3.5M11.5 16.5H20"/><circle cx="14.5" cy="7.5" r="2"/><circle cx="9.5" cy="16.5" r="2"/>',
  layers: '<path d="m12 4 8.5 4.5L12 13 3.5 8.5z"/><path d="m3.5 12.5 8.5 4.5 8.5-4.5M3.5 16.5 12 21l8.5-4.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  key: '<circle cx="8" cy="14" r="4"/><path d="m11 11 8-8M16 6l2.5 2.5M14 8l2 2"/>',
  regenerate: '<path d="M19.5 12a7.5 7.5 0 0 1-12.9 5.2M4.5 12a7.5 7.5 0 0 1 12.9-5.2"/><path d="M17.5 3.5v3.7h-3.7M6.5 20.5v-3.7h3.7"/>',
  undo: '<path d="M9 7.5 4.5 12 9 16.5"/><path d="M4.5 12H15a4.5 4.5 0 0 1 0 9h-2"/>',
  list: '<path d="M8.5 6.5h11M8.5 12h11M8.5 17.5h11M4.5 6.5v.01M4.5 12v.01M4.5 17.5v.01"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="3"/><path d="m16 10.5 5-3v9l-5-3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
  moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>',
  eye: '<path d="M2.8 12C4.6 8.4 8 6 12 6s7.4 2.4 9.2 6c-1.8 3.6-5.2 6-9.2 6s-7.4-2.4-9.2-6z"/><circle cx="12" cy="12" r="2.8"/>',
  volume: '<path d="M4 9.5v5h3.5L12 18V6L7.5 9.5z"/><path d="M16 9a4 4 0 0 1 0 6"/>',
  mute: '<path d="M4 9.5v5h3.5L12 18V6L7.5 9.5z"/><path d="m16 10 4 4M20 10l-4 4"/>',
  loop: '<path d="m17 3.5 3 3-3 3M4 11.5V10a3.5 3.5 0 0 1 3.5-3.5H20"/><path d="m7 20.5-3-3 3-3M20 12.5V14a3.5 3.5 0 0 1-3.5 3.5H4"/>',
  keyboard: '<rect x="3" y="6.5" width="18" height="11" rx="2"/><path d="M7 10.5v.01M10 10.5v.01M13 10.5v.01M16 10.5v.01M8 14h8"/>',
  external: '<path d="M14 4.5h5.5V10M19.5 4.5 11 13"/><path d="M18 14v3.5a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2H10"/>',
  bolt: '<path d="M13 3.5 5.5 13.5H12l-1 7 7.5-10H12z"/>',
  dot: '<circle cx="12" cy="12" r="3.5"/>',
  dashed: '<rect x="4.5" y="5.5" width="15" height="13" rx="2" stroke-dasharray="3 3"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  cloud: '<path d="M7 18.5a4 4 0 0 1-.6-7.95 5.5 5.5 0 0 1 10.6 1.2A3.4 3.4 0 0 1 16.5 18.5z"/>',
};

export function icon(name, size) {
  const cls = size ? `i s${size}` : 'i';
  return new Safe(`<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name] || P.dot}</svg>`);
}

// ---- formatting -----------------------------------------------------------------
export function fmtDur(sec) {
  if (sec == null || !isFinite(sec) || sec <= 0) return '—';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/** mm:ss:ff timecode. */
export function fmtTc(sec, fps = 30) {
  const f = Math.max(1, Math.round(fps || 30));
  const total = Math.max(0, sec || 0);
  const whole = Math.floor(total);
  const frames = Math.min(f - 1, Math.floor((total - whole) * f + 1e-6));
  const m = Math.floor(whole / 60);
  return `${String(m).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}:${String(frames).padStart(2, '0')}`;
}

export function fmtSize(b) {
  if (!b) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}

export function fmtClock(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
export function fmtDay(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}

export const shotLabel = (scene, shot) => `${scene}.${shot}`;
export const clipLabel = (c) => (c.kind === 'shot' ? `${c.scene}.${c.shot} · take ${c.take}` : c.name);
export const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}
