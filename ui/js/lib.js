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
const P = {
  board: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  review: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M10.5 9.5v5l4-2.5z"/>',
  slate: '<path d="M4 10h16v8.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z"/><path d="m4 10-.7-3.6a1 1 0 0 1 .8-1.2L18.5 3l.9 4.4L4 10zM8.2 9.2 7.3 4.4M13 8.3l-.9-4.7"/>',
  canvas: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M8 9.5h3v3H8zM13.5 12h3v3h-3z"/>',
  settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  checkCircle: '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.3 2.4 2.4 4.6-4.9"/>',
  chevronDown: '<path d="m6 9.5 6 6 6-6"/>',
  chevronRight: '<path d="m9.5 6 6 6-6 6"/>',
  chevronLeft: '<path d="m14.5 6-6 6 6 6"/>',
  chevronUp: '<path d="m6 14.5 6-6 6 6"/>',
  arrowLeft: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  play: '<path d="M8 5.5v13l11-6.5z"/>',
  pause: '<path d="M8.5 5.5v13M15.5 5.5v13"/>',
  stepBack: '<path d="M6.5 5.5v13M18 6v12l-8.5-6z"/>',
  stepForward: '<path d="M17.5 5.5v13M6 6v12l8.5-6z"/>',
  scissors: '<circle cx="6.5" cy="6.5" r="2.5"/><circle cx="6.5" cy="17.5" r="2.5"/><path d="M20 4.5 8.5 15.5M20 19.5 8.5 8.5"/>',
  upload: '<path d="M12 16V4.5M7.5 9 12 4.5 16.5 9M4.5 15v3.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V15"/>',
  download: '<path d="M12 4.5V16M7.5 11.5 12 16l4.5-4.5M4.5 15v3.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V15"/>',
  folder: '<path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h4l2 2.5h8A1.5 1.5 0 0 1 20.5 9.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/>',
  more: '<circle cx="5.5" cy="12" r="1.1" fill="currentColor"/><circle cx="12" cy="12" r="1.1" fill="currentColor"/><circle cx="18.5" cy="12" r="1.1" fill="currentColor"/>',
  alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5M12 16v.01"/>',
  warn: '<path d="M12 4.5 21 19.5H3z"/><path d="M12 10v4M12 16.8v.01"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.01"/>',
  thumbsUp: '<path d="M7.5 11v8.5h-3V11zM7.5 11l3.2-6a2 2 0 0 1 3 1.8L13 10h5a2 2 0 0 1 2 2.3l-1 6a2 2 0 0 1-2 1.7H7.5"/>',
  ban: '<circle cx="12" cy="12" r="8.5"/><path d="m6 6 12 12"/>',
  flag: '<path d="M6 20.5v-17M6 4.5h11l-2 4 2 4H6"/>',
  flagFill: '<path d="M6 20.5v-17" /><path d="M6 4.5h11l-2 4 2 4H6z" fill="currentColor"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
  trash: '<path d="M5 7h14M10 7V4.5h4V7M7 7l.8 12h8.4L17 7M10.5 11v5M13.5 11v5"/>',
  pencil: '<path d="m5 19 1-4L16.5 4.5a2 2 0 0 1 3 3L9 18z"/>',
  compare: '<rect x="3.5" y="5" width="7.5" height="14" rx="1.5"/><rect x="13" y="5" width="7.5" height="14" rx="1.5"/>',
  expand: '<path d="M5 9V5h4M19 9V5h-4M5 15v4h4M19 15v4h-4"/>',
  filter: '<path d="M4.5 6h15M7.5 12h9M10.5 18h3"/>',
  layers: '<path d="m12 4 8.5 4.5L12 13 3.5 8.5z"/><path d="m3.5 12.5 8.5 4.5 8.5-4.5M3.5 16.5 12 21l8.5-4.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  key: '<circle cx="8" cy="15" r="3.5"/><path d="M10.5 12.5 19 4M16 7l2.5 2.5M13.5 9.5l2 2"/>',
  regenerate: '<path d="M19.5 8A8 8 0 0 0 5 8M4.5 4v4h4M4.5 16A8 8 0 0 0 19 16M19.5 20v-4h-4"/>',
  undo: '<path d="M8.5 6 4.5 10l4 4M5 10h9a5 5 0 0 1 0 10h-3"/>',
  list: '<path d="M8.5 6.5h11M8.5 12h11M8.5 17.5h11M4.5 6.5v.01M4.5 12v.01M4.5 17.5v.01"/>',
  video: '<rect x="3.5" y="6.5" width="12" height="11" rx="2"/><path d="m15.5 11 5-3v8l-5-3"/>',
  sun: '<circle cx="12" cy="12" r="3.5"/><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M18 6l-1.4 1.4M7.4 16.6 6 18"/>',
  moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.5"/>',
  volume: '<path d="M4.5 10v4h3l4 3.5v-11L7.5 10zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  mute: '<path d="M4.5 10v4h3l4 3.5v-11L7.5 10zM16 9.5l4 5M20 9.5l-4 5"/>',
  loop: '<path d="M4.5 11V10a3 3 0 0 1 3-3h10M14.5 4l3 3-3 3M19.5 13v1a3 3 0 0 1-3 3h-10M9.5 20l-3-3 3-3"/>',
  keyboard: '<rect x="3" y="6.5" width="18" height="11" rx="2"/><path d="M7 10.5v.01M10 10.5v.01M13 10.5v.01M16 10.5v.01M8 14h8"/>',
  external: '<path d="M13 5.5h5.5V11M18.5 5.5 10 14M16 14v3.5a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 5 17.5v-8A1.5 1.5 0 0 1 6.5 8H10"/>',
  bolt: '<path d="M13 3.5 5.5 13.5H12l-1 7 7.5-10H12z"/>',
  dot: '<circle cx="12" cy="12" r="3.5"/>',
  dashed: '<rect x="4.5" y="5.5" width="15" height="13" rx="2" stroke-dasharray="3 3"/>',
  menu: '<path d="M4.5 7h15M4.5 12h15M4.5 17h15"/>',
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
