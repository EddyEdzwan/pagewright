// Small UI primitives: toast, busy overlay, modal dialogs.
const $ = (s) => document.querySelector(s);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer;
export function toast(msg, { action, onAction, ms = 3500 } = {}) {
  const t = $('#toast');
  t.innerHTML = esc(msg) + (action ? `<a>${esc(action)}</a>` : '');
  if (action) t.querySelector('a').onclick = () => { t.hidden = true; onAction(); };
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

export function busy(text) {
  $('#busyText').textContent = text || 'Working…';
  $('#busy').hidden = !text;
}

/**
 * Show a modal. `html` is the body; buttons: [{label, value, primary}].
 * onMount(root, close) can wire extra behaviour; `collect(root)` builds the resolved value
 * for non-cancel buttons. Resolves with {button, data} or null on cancel/Escape.
 */
export function modal({ title, html, buttons = [{ label: 'Cancel', value: null }, { label: 'OK', value: 'ok', primary: true }], onMount, collect, width }) {
  return new Promise((resolve) => {
    const back = $('#modalBack'), box = $('#modal');
    box.style.width = width ? `${width}px` : '';
    box.innerHTML = `<h2>${esc(title)}</h2><div class="body">${html}</div><div class="actions">${buttons.map((b, i) =>
      `<button data-i="${i}" class="${b.primary ? 'primary' : ''}">${esc(b.label)}</button>`).join('')}</div>`;
    back.hidden = false;
    const close = (v) => { back.hidden = true; box.innerHTML = ''; document.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
      if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) {
        const p = buttons.findIndex((b) => b.primary);
        if (p >= 0) { e.preventDefault(); box.querySelector(`[data-i="${p}"]`).click(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    box.querySelectorAll('.actions button').forEach((btn) => {
      btn.onclick = async () => {
        const b = buttons[+btn.dataset.i];
        if (b.value == null) return close(null);
        const data = collect ? await collect(box, b.value) : null;
        if (data === false) return; // validation failed; keep open
        close({ button: b.value, data });
      };
    });
    onMount?.(box, close);
    const first = box.querySelector('input:not([type=checkbox]):not([type=radio]):not([type=color]), textarea');
    (first || box.querySelector('.actions .primary'))?.focus();
  });
}

export async function prompt(title, value = '', password = false) {
  const r = await modal({
    title, html: `<input type="${password ? 'password' : 'text'}" id="promptIn" style="width:100%" value="${esc(value)}"/>`,
    collect: (root) => root.querySelector('#promptIn').value,
  });
  return r ? r.data : null;
}

/** Parse "1-3, 5, 8-" into zero-based page index groups; `max` = page count. */
export function parseRanges(str, max) {
  const groups = [];
  for (const part of str.split(/[,;]+/).map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d*)\s*(?:-\s*(\d*))?$/);
    if (!m) throw new Error(`Can't read "${part}"`);
    const a = m[1] ? +m[1] : 1;
    const b = part.includes('-') ? (m[2] ? +m[2] : max) : a;
    if (a < 1 || b > max || a > b) throw new Error(`"${part}" is outside 1–${max}`);
    groups.push(Array.from({ length: b - a + 1 }, (_, i) => a - 1 + i));
  }
  if (!groups.length) throw new Error('Enter at least one page range');
  return groups;
}
