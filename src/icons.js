// Minimal stroke icon set (24×24 grid).
const P = {
  open: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  save: 'M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM7 3v5h8V3M7 21v-7h10v7',
  print: 'M6 9V3h12v6M6 18H4a1 1 0 0 1-1-1v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6a1 1 0 0 1-1 1h-2M6 14h12v7H6z',
  undo: 'M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  redo: 'm15 14 5-5-5-5M20 9H9a5 5 0 0 0 0 10h3',
  select: 'M5 3l6 16 2.5-6.5L20 10z',
  hand: 'M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 10.5v-6a1.5 1.5 0 0 1 3 0V11M14 6.5a1.5 1.5 0 0 1 3 0V12M17 9.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-2a6 6 0 0 1-5-2.7L4.3 14a1.6 1.6 0 0 1 2.6-1.8L8 14',
  highlight: 'm9 11-5 5v4h4l5-5M9 11l6-6 4 4-6 6M9 11l4 4M14 21h7',
  underline: 'M7 4v6a5 5 0 0 0 10 0V4M5 20h14',
  strike: 'M16 6c-.8-1.3-2.3-2-4-2-2.5 0-4 1.3-4 3 0 1.4 1 2.3 3 3M4 12h16M15 14c.6.6 1 1.3 1 2.2 0 2-1.8 3.8-4.5 3.8-2 0-3.6-.9-4.5-2.3',
  note: 'M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-6l-5 4v-4H6a2 2 0 0 1-2-2zM8 8h8M8 12h5',
  text: 'M5 6V4h14v2M12 4v16M9 20h6',
  edittext: 'M4 7V5h10v2M9 5v12M7 17h4M14 19l6-6-2-2-6 6v2z',
  pen: 'M3 21c3-1 4-4 6-6l8.5-8.5a2.1 2.1 0 0 0-3-3L6 12c-2 2-5 3-6 6',
  rect: 'M4 6h16v12H4z',
  ellipse: 'M12 5c4.4 0 8 3.1 8 7s-3.6 7-8 7-8-3.1-8-7 3.6-7 8-7z',
  line: 'M5 19 19 5',
  arrow: 'M5 19 19 5M10 5h9v9',
  whiteout: 'M4 8h16v8H4zM8 12h8',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15 9.5a1.5 1.5 0 1 0 0-.01',
  sign: 'M3 17c2-4 4-9 6-9 3 0-2 10 1 10 1.5 0 2.5-3 4-3 1 0 1 2 2 2s2-1 2-1M3 21h18',
  stamp: 'M9 4h6l-1 7h4a2 2 0 0 1 2 2v3H4v-3a2 2 0 0 1 2-2h4zM5 20h14',
  redact: 'M4 6h16v4H4zM4 14h10v4H4z',
  minus: 'M6 12h12', plus: 'M12 6v12M6 12h12',
  search: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM16 16l4.5 4.5',
  grid: 'M4 4h6v7H4zM14 4h6v7h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  doc: 'M6 3h8l5 5v13H6zM14 3v5h5M9 13h6M9 17h6',
  rotl: 'M4 10a8 8 0 1 1 2 6M4 4v6h6', rotr: 'M20 10a8 8 0 1 0-2 6M20 4v6h-6',
  sidebar: 'M4 5h16v14H4zM9 5v14', left: 'm15 6-6 6 6 6', right: 'm9 6 6 6-6 6',
  up: 'm6 15 6-6 6 6', down: 'm6 9 6 6 6-6', x: 'M6 6l12 12M18 6 6 18',
};

export function icon(name) {
  return `<svg class="ic" viewBox="0 0 24 24"><path d="${P[name] || ''}"/></svg>`;
}

export function applyIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    if (!el.querySelector('svg.ic')) el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));
  });
}
