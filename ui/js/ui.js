// Shared UI pieces: toasts, menus, popups, and the Escape stack ("Escape closes the top layer only").
import { html, icon, mount, esc, $ } from './lib.js';

// ---- layers --------------------------------------------------------------------
const layers = [];
export function pushLayer(close) { layers.push(close); return () => { const i = layers.indexOf(close); if (i >= 0) layers.splice(i, 1); }; }
export function closeTopLayer() { const fn = layers.pop(); if (fn) { fn(); return true; } return false; }
export const hasLayer = () => layers.length > 0;

// ---- toasts --------------------------------------------------------------------
let toastHost;
export function toast(message, { type = 'info', link, timeout = 4200 } = {}) {
  if (!toastHost) { toastHost = document.createElement('div'); toastHost.className = 'toasts'; document.body.append(toastHost); }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  const ic = type === 'error' ? 'alert' : type === 'success' ? 'checkCircle' : 'info';
  mount(el, html`${icon(ic)}<span>${message}${link ? html` <button class="link" data-link>${link.text}</button>` : ''}</span>`);
  if (link) $('[data-link]', el).addEventListener('click', () => { link.onClick(); el.remove(); });
  toastHost.append(el);
  const t = setTimeout(() => el.remove(), type === 'error' ? Math.max(timeout, 7000) : timeout);
  el.addEventListener('mouseenter', () => clearTimeout(t));
  return el;
}

export const toastError = (e) => toast(e && e.message ? e.message : String(e), { type: 'error' });

// ---- menus -------------------------------------------------------------------------
let openMenuEl = null;
export function closeMenu() { if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; document.removeEventListener('mousedown', outside, true); } }
function outside(e) { if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu(); }

/**
 * items: [{ label, icon?, onClick, checked?, danger?, trail?, disabled? } | { sep: true } | { head: 'Label' }]
 * anchor: an element, or {x, y}
 */
export function openMenu(anchor, items, { align = 'start' } = {}) {
  closeMenu();
  const el = document.createElement('div');
  el.className = 'app-menu';
  el.setAttribute('role', 'menu');
  mount(el, html`${items.map((it, i) => (it.sep ? html`<div class="sep"></div>` : it.head ? html`<div class="head">${it.head}</div>`
    : html`<button role="menuitem" data-i="${i}" ${it.checked != null ? html`aria-checked="${it.checked}"` : ''} ${it.disabled ? 'disabled' : ''}>${it.icon ? icon(it.icon) : ''}<span>${it.label}</span>${it.checked ? html`<span class="trail">${icon('check')}</span>` : it.trail ? html`<span class="trail">${it.trail}</span>` : ''}</button>`))}`);
  document.body.append(el);
  const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0 };
  const mw = el.offsetWidth;
  const mh = el.offsetHeight;
  let x = align === 'end' ? r.right - mw : r.left;
  let y = r.bottom + 4;
  if (y + mh > innerHeight - 8) y = Math.max(8, r.top - mh - 4);
  x = Math.max(8, Math.min(x, innerWidth - mw - 8));
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  openMenuEl = el;
  setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
  const unlayer = pushLayer(closeMenu);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    const it = items[+b.dataset.i];
    closeMenu(); unlayer();
    if (it && it.onClick) it.onClick();
  });
  const first = el.querySelector('button:not([disabled])');
  if (first) first.focus({ preventScroll: true });
  el.addEventListener('keydown', (e) => {
    const bs = [...el.querySelectorAll('button:not([disabled])')];
    const i = bs.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); bs[(i + 1) % bs.length].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); bs[(i - 1 + bs.length) % bs.length].focus(); }
  });
  return el;
}

// ---- popups ------------------------------------------------------------------------
/**
 * Popup with the standard header: title on the left, actions on the right, close X always last ("Close (Esc)").
 * Returns { el, body, close }.
 */
export function openPopup({ title, subtitle, body, foot, width = 640, actions, onClose, className = '' }) {
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.innerHTML = '';
  const pop = document.createElement('div');
  pop.className = `popup ${className}`;
  pop.style.setProperty('--popup-w', `${width}px`);
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-modal', 'true');
  pop.setAttribute('aria-label', title);
  mount(pop, html`
    <div class="popup-head">
      <div class="grow"><div class="popup-title">${title}</div>${subtitle ? html`<div class="faint" style="font-size:12px">${subtitle}</div>` : ''}</div>
      ${actions || ''}
      <button class="app-icon-btn" data-close title="Close (Esc)" aria-label="Close (Esc)">${icon('close')}</button>
    </div>
    <div class="popup-body"></div>
    ${foot ? html`<div class="popup-foot"></div>` : ''}`);
  const bodyEl = $('.popup-body', pop);
  if (body) mount(bodyEl, body);
  if (foot) mount($('.popup-foot', pop), foot);
  scrim.append(pop);
  document.body.append(scrim);
  const prevFocus = document.activeElement;
  let unlayer;
  const close = () => { scrim.remove(); unlayer(); if (prevFocus && prevFocus.focus) prevFocus.focus({ preventScroll: true }); if (onClose) onClose(); };
  unlayer = pushLayer(close);
  scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(); });
  $('[data-close]', pop).addEventListener('click', close);
  const f = pop.querySelector('input, textarea, select, [data-autofocus]');
  if (f) f.focus();
  return { el: pop, body: bodyEl, foot: $('.popup-foot', pop), close };
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const p = openPopup({
      title, width: 440, body: html`<p class="muted">${message}</p>`,
      foot: html`<button class="app-btn" data-no>Cancel</button><button class="app-btn app-btn--primary" data-yes>${confirmLabel}</button>`,
      onClose: () => { if (!done) resolve(false); },
    });
    $('[data-no]', p.el).addEventListener('click', () => { done = true; p.close(); resolve(false); });
    $('[data-yes]', p.el).addEventListener('click', () => { done = true; p.close(); resolve(true); });
  });
}

export function field(label, control, hint) {
  return html`<div class="app-field"><label>${label}</label>${control}${hint ? html`<div class="app-hint">${hint}</div>` : ''}</div>`;
}

export { esc };
