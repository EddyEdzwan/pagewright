// Pagewright renderer: document model, viewer, editing tools, organizer.
import * as pdfjsLib from '../node_modules/pdfjs-dist/build/pdf.mjs';
import { applyIcons } from './icons.js';
import * as O from './objects.js';
import { buildPdf, DOC_OPTS, renderToCanvas, openBytes } from './pdfops.js';
import { toast, busy, modal, prompt, esc } from './ui.js';
import * as Tools from './tools.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../node_modules/pdfjs-dist/build/pdf.worker.mjs', location.href).href;
const CSS_UNITS = 96 / 72;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const { PDFDocument } = window.PDFLib;

// ---------------------------------------------------------------- state
export const S = {
  sources: [],          // {name, path, bytes, pdf, proxies[], encrypted}
  pages: [],            // {uid, src, idx, rot, objs[], ocr?}
  images: new Map(),    // imgId -> {bytes, mime, url, w, h}
  filePath: null, fileName: null, dirty: false, meta: null,
  zoom: 1, zoomMode: 'fit',
  tool: 'select', pending: null,
  sel: null,            // {uid, id}
  editing: null,        // object id hidden while its text editor is open
  undo: [], redo: [],
  flattenForms: false,
  current: 0,
  clip: null,
  find: { q: '', hits: [], cur: -1 },
};
const TOOL_COLORS = { highlight: '#ffeb3b', underline: '#1e88e5', strike: '#d32f2f', text: '#000000', ink: '#1e40af', rect: '#d32f2f', ellipse: '#d32f2f', line: '#d32f2f', arrow: '#d32f2f', note: '#fbc02d' };
const P = { color: '#d32f2f', fill: '#ffeb3b', fillOn: false, width: 2, opacity: 1, font: 'Helvetica', bold: false, italic: false, size: 14 };
const TOOL_NAMES = { select: 'Select', hand: 'Pan', highlight: 'Highlight', underline: 'Underline', strike: 'Strikethrough', note: 'Sticky note',
  text: 'Add text', edittext: 'Edit text', ink: 'Draw', rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', arrow: 'Arrow',
  whiteout: 'White-out', redact: 'Redact', place: 'Click to place' };

const viewer = $('#viewer'), pagesEl = $('#pages');
const views = new Map(); // uid -> view {p, el, vp, rendered, task}
let uidSeq = 0;
const newUid = () => `p${++uidSeq}`;

// ---------------------------------------------------------------- helpers
export const pageProxy = (p) => S.sources[p.src].proxies[p.idx];
export const totalRot = (p) => (pageProxy(p).rotate + p.rot) % 360;
const viewportFor = (p, scale) => pageProxy(p).getViewport({ scale, rotation: totalRot(p) });
const findObj = (uid, id) => S.pages.find((p) => p.uid === uid)?.objs.find((o) => o.id === id);
const isNarrow = () => window.matchMedia('(max-width: 760px)').matches;
const isTyping = () => { const a = document.activeElement; return a && (a.matches('input, textarea, select') || a.isContentEditable); };
const snapshot = () => structuredClone(S.pages);

export function pushUndo(snap) {
  S.undo.push(snap);
  if (S.undo.length > 200) S.undo.shift();
  S.redo = [];
  markDirty();
}
export function markDirty(d = true) {
  S.dirty = d;
  const name = S.fileName || 'Untitled.pdf';
  document.title = `${name}${d ? ' — Edited' : ''}`;
  host.setDirty(d, document.title);
}

function userPt(v, e) {
  const r = v.el.getBoundingClientRect();
  return v.vp.convertToPdfPoint(e.clientX - r.left, e.clientY - r.top);
}

// ---------------------------------------------------------------- loading
async function loadSource(file) {
  const task = pdfjsLib.getDocument({ ...DOC_OPTS, data: file.data.slice() });
  task.onPassword = async (update, reason) => {
    const pw = await prompt(reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD ? 'Wrong password — try again' : `“${file.name}” is password-protected`, '', true);
    if (pw == null) task.destroy(); else update(pw);
  };
  const pdf = await task.promise;
  const proxies = [];
  for (let i = 1; i <= pdf.numPages; i += 32) {
    const batch = await Promise.all(Array.from({ length: Math.min(32, pdf.numPages - i + 1) }, (_, k) => pdf.getPage(i + k)));
    proxies.push(...batch);
  }
  S.sources.push({ name: file.name, path: file.path, bytes: file.data, pdf, proxies });
  return S.sources.length - 1;
}

export async function openFiles(files) {
  if (!files?.length) return;
  if (S.dirty) {
    const r = await host.confirm('Discard unsaved changes?', 'The current document has edits that have not been saved.', ['Discard', 'Cancel']);
    if (r !== 0) return;
  }
  busy('Opening…');
  try {
    for (const s of S.sources) s.pdf.destroy();
    Object.assign(S, { sources: [], pages: [], undo: [], redo: [], sel: null, meta: null, current: 0, flattenForms: false });
    S.images.clear();
    S.find = { q: '', hits: [], cur: -1 };
    for (const f of files) {
      const si = await loadSource(f);
      S.sources[si].proxies.forEach((_, idx) => S.pages.push({ uid: newUid(), src: si, idx, rot: 0, objs: [] }));
    }
    S.filePath = files.length === 1 ? files[0].path : null;
    S.fileName = files.length === 1 ? files[0].name : 'Combined.pdf';
    document.body.classList.add('has-doc');
    S.zoomMode = 'fit';
    computeFitZoom();
    layout(false);
    buildThumbs();
    loadOutline();
    refreshComments();
    detectForms();
    markDirty(files.length > 1);
    viewer.scrollTop = 0;
  } catch (e) {
    console.error(e);
    toast(`Could not open: ${e.message}`);
  } finally { busy(); }
}

/** Append PDFs (or pages of them) into the open document at `at` (default end). */
export async function insertFiles(files, at = S.pages.length) {
  if (!S.sources.length) return openFiles(files);
  busy('Adding pages…');
  try {
    const snap = snapshot();
    const add = [];
    for (const f of files) {
      const si = await loadSource(f);
      S.sources[si].proxies.forEach((_, idx) => add.push({ uid: newUid(), src: si, idx, rot: 0, objs: [] }));
    }
    S.pages.splice(at, 0, ...add);
    pushUndo(snap);
    refresh(true);
    toast(`Added ${add.length} page${add.length === 1 ? '' : 's'}`);
  } catch (e) { toast(`Could not add: ${e.message}`); } finally { busy(); }
}

export async function addBlankPage(at, w = 612, h = 792) {
  const doc = await PDFDocument.create();
  doc.addPage([w, h]);
  const si = await loadSource({ name: 'Blank page', data: await doc.save() });
  const page = { uid: newUid(), src: si, idx: 0, rot: 0, objs: [] };
  S.pages.splice(at, 0, page);
  return page;
}

/** Swap a page's source for a freshly generated single-page PDF (used by Apply Redactions). */
export async function replacePageSource(p, bytes, { shift = [0, 0], rot = 0 } = {}) {
  const si = await loadSource({ name: 'Flattened page', data: bytes });
  p.src = si; p.idx = 0; p.rot = rot;
  for (const o of p.objs) O.translate(o, shift[0], shift[1]);
}

async function detectForms() {
  const fields = await S.sources[0]?.pdf.getFieldObjects().catch(() => null);
  const has = !!fields && Object.keys(fields).length > 0;
  $('#formBadge').hidden = !has;
  document.body.classList.toggle('hl-fields', has);
}

// ---------------------------------------------------------------- layout & rendering
const io = new IntersectionObserver((entries) => {
  for (const en of entries) {
    const v = views.get(en.target.dataset.uid);
    if (!v) continue;
    v.visible = en.isIntersecting;
    if (en.isIntersecting) renderView(v); else releaseView(v);
  }
}, { root: viewer, rootMargin: '1200px 0px' });

function computeFitZoom() {
  if (!S.pages.length) return;
  const p = S.pages[Math.min(S.current, S.pages.length - 1)];
  const vp = viewportFor(p, CSS_UNITS);
  const gutter = isNarrow() ? 16 : 48;
  const availW = viewer.clientWidth - gutter, availH = viewer.clientHeight - 40;
  if (S.zoomMode === 'fit') S.zoom = Math.min(4, availW / vp.width);
  else if (S.zoomMode === 'page') S.zoom = Math.min(availW / vp.width, availH / vp.height);
  syncZoomUI();
}

function syncZoomUI() {
  const sel = $('#zoomSel');
  if (S.zoomMode === 'fit' || S.zoomMode === 'page') sel.value = S.zoomMode;
  else {
    const match = [...sel.options].find((o) => Math.abs(+o.value - S.zoom) < 1e-3);
    if (match) sel.value = match.value;
    else { const c = sel.querySelector('[value=custom]'); c.textContent = `${Math.round(S.zoom * 100)}%`; sel.value = 'custom'; }
  }
}

export function setZoom(z, mode = 'custom') {
  S.zoomMode = mode;
  if (mode === 'custom') S.zoom = Math.max(0.1, Math.min(8, z));
  else computeFitZoom();
  syncZoomUI();
  layout(true);
}

function captureScroll() {
  const v = views.get(S.pages[S.current]?.uid);
  if (!v) return null;
  return { uid: v.p.uid, frac: (viewer.scrollTop - v.el.offsetTop) / v.el.offsetHeight };
}

export function layout(keepPos = true) {
  const anchor = keepPos ? captureScroll() : null;
  closeEditors();
  io.disconnect();
  for (const v of views.values()) v.task?.cancel();
  views.clear();
  pagesEl.innerHTML = '';
  const frag = document.createDocumentFragment();
  S.pages.forEach((p, i) => {
    const vp = viewportFor(p, S.zoom * CSS_UNITS);
    const el = document.createElement('div');
    el.className = 'pg';
    el.dataset.uid = p.uid;
    el.style.width = `${Math.floor(vp.width)}px`;
    el.style.height = `${Math.floor(vp.height)}px`;
    el.style.setProperty('--scale-factor', vp.scale);
    el.innerHTML = `<canvas class="render"></canvas><div class="textLayer"></div><div class="annotationLayer"></div><svg class="overlay"></svg><div class="hit"></div><div class="pglabel">${i + 1}</div>`;
    frag.append(el);
    const v = { p, el, vp, rendered: false };
    views.set(p.uid, v);
    drawOverlay(v);
  });
  pagesEl.append(frag);
  for (const v of views.values()) io.observe(v.el);
  if (anchor && views.has(anchor.uid)) {
    const el = views.get(anchor.uid).el;
    viewer.scrollTop = el.offsetTop + anchor.frac * el.offsetHeight;
  }
  updatePageIndicator();
}

/** Re-sync after a model change. structural=true when pages were added/removed/reordered/rotated. */
export function refresh(structural = null) {
  const sameShape = !structural && S.pages.length === views.size
    && S.pages.every((p) => { const v = views.get(p.uid); return v && v.p.rot === p.rot && v.p.src === p.src; });
  if (!sameShape) {
    layout(true);
    buildThumbs();
  } else {
    for (const p of S.pages) { const v = views.get(p.uid); v.p = p; drawOverlay(v); }
  }
  if (S.sel && !findObj(S.sel.uid, S.sel.id)) select(null);
  refreshComments();
  updateProps();
}

const linkService = {
  externalLinkTarget: 2, externalLinkRel: 'noopener noreferrer', isInPresentationMode: false,
  get pagesCount() { return S.pages.length; },
  page: 1, rotation: 0,
  addLinkAttributes(link, url) { link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; },
  getDestinationHash: () => '#', getAnchorUrl: () => '#',
  goToDestination: (dest) => goToDest(0, dest),
  executeNamedAction(action) {
    if (action === 'NextPage') goToPage(S.current + 1);
    if (action === 'PrevPage') goToPage(S.current - 1);
    if (action === 'FirstPage') goToPage(0);
    if (action === 'LastPage') goToPage(S.pages.length - 1);
  },
  executeSetOCGState() {}, setHash() {}, goToPage: (n) => goToPage(n - 1),
};

async function renderView(v) {
  if (v.rendered || v.rendering) return;
  v.rendering = true;
  const { p, vp, el } = v;
  const pp = pageProxy(p);
  const canvas = $('canvas.render', el);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(vp.width * dpr);
  canvas.height = Math.floor(vp.height * dpr);
  try {
    v.task = pp.render({
      canvasContext: canvas.getContext('2d'), viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
      annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS,
    });
    await v.task.promise;
    if (views.get(p.uid) !== v) return;
    const tl = $('.textLayer', el);
    tl.innerHTML = '';
    const textLayer = new pdfjsLib.TextLayer({ textContentSource: pp.streamTextContent({ includeMarkedContent: true, disableNormalization: true }), container: tl, viewport: vp });
    await textLayer.render();
    const eoc = document.createElement('div'); eoc.className = 'endOfContent'; tl.append(eoc);
    textRuns(p); textGlyphs(p); // warm caches so text tools respond within the tap
    const annots = await pp.getAnnotations({ intent: 'display' });
    if (annots.length && views.get(p.uid) === v) {
      const ad = $('.annotationLayer', el);
      ad.innerHTML = '';
      const avp = vp.clone({ dontFlip: true });
      const layer = new pdfjsLib.AnnotationLayer({ div: ad, page: pp, viewport: avp, accessibilityManager: null, annotationCanvasMap: null, annotationEditorUIManager: null, structTreeLayer: null });
      await layer.render({
        viewport: avp, div: ad, annotations: annots, page: pp, linkService, downloadManager: null,
        annotationStorage: S.sources[p.src].pdf.annotationStorage, renderForms: true, enableScripting: false, hasJSActions: false, fieldObjects: null,
        imageResourcesPath: new URL('../node_modules/pdfjs-dist/web/images/', location.href).href,
      });
    }
    v.rendered = true;
  } catch (e) {
    if (e?.name !== 'RenderingCancelledException') console.error('render failed', e);
  } finally { v.rendering = false; v.task = null; }
}

function releaseView(v) {
  if (!v.rendered && !v.rendering) return;
  if (v.el.contains(document.activeElement)) return; // don't drop a form field mid-typing
  v.task?.cancel();
  const c = $('canvas.render', v.el); c.width = 0; c.height = 0;
  $('.textLayer', v.el).innerHTML = '';
  $('.annotationLayer', v.el).innerHTML = '';
  v.rendered = false;
}

export function drawOverlay(v) {
  const { vp, p } = v;
  const svg = $('svg.overlay', v.el);
  svg.setAttribute('viewBox', `0 0 ${vp.width} ${vp.height}`);
  let inner = '';
  for (const o of p.objs) if (o.id !== S.editing) inner += O.objSvg(o, S.images, vp.scale);
  // search hits
  S.find.hits.forEach((h, i) => {
    if (h.uid !== p.uid) return;
    for (const r of h.rects) inner += `<rect class="find-hit${i === S.find.cur ? ' cur' : ''}" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"/>`;
  });
  // selection
  if (S.sel?.uid === p.uid) {
    const o = p.objs.find((q) => q.id === S.sel.id);
    if (o && o.id !== S.editing) {
      const poly = O.framePolygon(O.frameOf(o));
      inner += `<polygon class="sel-box" points="${poly.map((q) => q.join(',')).join(' ')}"/>`;
      if (O.RESIZABLE.has(o.type)) {
        const hs = 9 / vp.scale;
        poly.forEach(([x, y], i) => { inner += `<rect class="sel-handle" data-handle="${i}" x="${x - hs / 2}" y="${y - hs / 2}" width="${hs}" height="${hs}"/>`; });
      }
    }
  }
  svg.innerHTML = `<g transform="matrix(${vp.transform.join(' ')})">${inner}</g>`;
}

function redrawPage(uid) { const v = views.get(uid); if (v) drawOverlay(v); }

// ---------------------------------------------------------------- navigation
function updatePageIndicator() {
  $('#pageCount').textContent = `/ ${S.pages.length}`;
  $('#pageInput').value = S.pages.length ? S.current + 1 : 0;
  $$('#thumbs .thumb').forEach((t, i) => t.classList.toggle('current', i === S.current));
}

function onScroll() {
  const mid = viewer.scrollTop + viewer.clientHeight * 0.35;
  let cur = 0;
  for (let i = 0; i < S.pages.length; i++) {
    const v = views.get(S.pages[i].uid);
    if (v && v.el.offsetTop <= mid) cur = i; else break;
  }
  if (cur !== S.current) {
    S.current = cur;
    updatePageIndicator();
    $('#thumbs .thumb.current')?.scrollIntoView({ block: 'nearest' });
  }
}

export function goToPage(i, yFrac = 0) {
  i = Math.max(0, Math.min(S.pages.length - 1, i));
  const v = views.get(S.pages[i]?.uid);
  if (!v) return;
  viewer.scrollTop = v.el.offsetTop - 12 + yFrac * v.el.offsetHeight;
  S.current = i;
  updatePageIndicator();
}

async function goToDest(srcIdx, dest) {
  const pdf = S.sources[srcIdx].pdf;
  try {
    const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
    if (!Array.isArray(explicit)) return;
    const ref = explicit[0];
    const idx = typeof ref === 'object' ? await pdf.getPageIndex(ref) : ref;
    const i = S.pages.findIndex((p) => p.src === srcIdx && p.idx === idx);
    if (i < 0) return;
    let frac = 0;
    if (explicit[1]?.name === 'XYZ' && explicit[3] != null) {
      const v = views.get(S.pages[i].uid);
      const [, vy] = v.vp.convertToViewportPoint(explicit[2] || 0, explicit[3]);
      frac = Math.max(0, vy / v.el.offsetHeight - 0.02);
    }
    goToPage(i, frac);
  } catch (e) { console.warn('bad destination', e); }
}

async function loadOutline() {
  const box = $('#outline');
  const outline = await S.sources[0]?.pdf.getOutline().catch(() => null);
  if (!outline?.length) { box.className = 'empty-note'; box.textContent = 'No bookmarks'; return; }
  box.className = '';
  const build = (items) => `<ul>${items.map((it, i) => `<li><span data-path="${i}" title="${esc(it.title)}">${esc(it.title)}</span>${it.items?.length ? build(it.items) : ''}</li>`).join('')}</ul>`;
  box.innerHTML = build(outline);
  const flat = [];
  (function walk(items) { for (const it of items) { flat.push(it); if (it.items) walk(it.items); } })(outline);
  $$('span', box).forEach((s, i) => { s.onclick = () => { const it = flat[i]; if (it.dest) goToDest(0, it.dest); else if (it.url) window.open(it.url); }; });
}

export function refreshComments() {
  const box = $('#comments');
  const items = [];
  S.pages.forEach((p, i) => p.objs.forEach((o) => {
    if (o.type === 'note') items.push({ i, p, o, label: o.text || '(empty note)', kind: 'Note' });
    else if (['highlight', 'underline', 'strike'].includes(o.type)) items.push({ i, p, o, label: o.type[0].toUpperCase() + o.type.slice(1), kind: 'Markup' });
  }));
  if (!items.length) { box.className = 'empty-note'; box.textContent = 'No comments'; return; }
  box.className = '';
  box.innerHTML = items.map((c, k) => `<div class="comment-item" data-k="${k}" style="border-left-color:${esc(c.o.color)}"><div class="meta">Page ${c.i + 1} · ${c.kind}</div>${esc(c.label)}</div>`).join('');
  $$('.comment-item', box).forEach((el) => {
    el.onclick = () => {
      const c = items[+el.dataset.k];
      const v = views.get(c.p.uid);
      const f = O.frameOf(c.o);
      const [, vy] = v.vp.convertToViewportPoint(f.box[0], f.box[3]);
      goToPage(c.i, Math.max(0, vy / v.el.offsetHeight - 0.1));
      select({ uid: c.p.uid, id: c.o.id });
      if (c.o.type === 'note') openNote(v, c.o);
    };
  });
}

// ---------------------------------------------------------------- thumbnails
const thumbIO = new IntersectionObserver((entries) => {
  for (const en of entries) if (en.isIntersecting) { renderThumb(en.target); thumbIO.unobserve(en.target); }
}, { root: $('#tab-thumbs'), rootMargin: '400px 0px' });

async function renderThumb(el, width = 120) {
  const p = S.pages.find((q) => q.uid === el.dataset.uid);
  if (!p) return;
  const pp = pageProxy(p);
  const base = pp.getViewport({ scale: 1, rotation: totalRot(p) });
  const { canvas } = await renderToCanvas(pp, (width * (window.devicePixelRatio || 1)) / base.width, { rotation: totalRot(p) });
  canvas.style.width = `${width}px`;
  const frame = $('.tframe', el);
  frame.innerHTML = '';
  frame.append(canvas);
}

let dragUids = null;
function buildThumbs() {
  const box = $('#thumbs');
  thumbIO.disconnect();
  box.innerHTML = S.pages.map((p, i) => `<div class="thumb" draggable="true" data-uid="${p.uid}"><div class="tframe" style="aspect-ratio:${aspect(p)}"></div>${i + 1}</div>`).join('');
  $$('.thumb', box).forEach((el) => {
    thumbIO.observe(el);
    el.onclick = () => goToPage(S.pages.findIndex((p) => p.uid === el.dataset.uid));
    wireDrag(el, () => [el.dataset.uid], 'y');
  });
  updatePageIndicator();
}
const aspect = (p) => { const vp = viewportFor(p, 1); return `${vp.width} / ${vp.height}`; };

/** Shared drag-to-reorder for sidebar thumbnails and the organizer grid. */
function wireDrag(el, getUids, axis) {
  el.addEventListener('dragstart', (e) => { dragUids = getUids(); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'pages'); });
  el.addEventListener('dragend', () => { dragUids = null; $$('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after')); });
  el.addEventListener('dragover', (e) => {
    if (!dragUids) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const after = axis === 'y' ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2;
    $$('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
    el.classList.add(after ? 'drop-after' : 'drop-before');
  });
  el.addEventListener('drop', (e) => {
    if (!dragUids) return;
    e.preventDefault();
    const after = el.classList.contains('drop-after');
    movePages(dragUids, el.dataset.uid, after);
  });
}

export function movePages(uids, targetUid, after) {
  if (uids.includes(targetUid)) return;
  const snap = snapshot();
  const moving = S.pages.filter((p) => uids.includes(p.uid));
  S.pages = S.pages.filter((p) => !uids.includes(p.uid));
  let at = S.pages.findIndex((p) => p.uid === targetUid);
  if (after) at++;
  S.pages.splice(at, 0, ...moving);
  pushUndo(snap);
  refresh(true);
  if (!$('#organizer').hidden) buildOrganizer();
}

// ---------------------------------------------------------------- tools & properties
const PROPS_FOR = {
  rect: ['color', 'fill', 'width', 'opacity'], ellipse: ['color', 'fill', 'width', 'opacity'],
  line: ['color', 'width', 'opacity'], arrow: ['color', 'width', 'opacity'], ink: ['color', 'width', 'opacity'],
  highlight: ['color', 'opacity'], underline: ['color'], strike: ['color'],
  text: ['color', 'font', 'size'], edittext: [], note: ['color'],
  image: ['opacity'], stamp: ['color', 'opacity'], whiteout: [], redact: [],
};

export function setTool(t) {
  if (t !== 'place') S.pending = null;
  S.tool = t;
  document.body.dataset.tool = t;
  $$('#tools [data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  if (TOOL_COLORS[t]) P.color = TOOL_COLORS[t];
  if (!['select', 'hand'].includes(t)) select(null);
  window.getSelection()?.removeAllRanges();
  $$('.pg .hit').forEach((h) => { h.style.cursor = ''; });
  updateProps();
}

function selectedObj() { return S.sel ? findObj(S.sel.uid, S.sel.id) : null; }

export function updateProps() {
  const o = selectedObj();
  const kind = o ? o.type : S.tool;
  const show = new Set(PROPS_FOR[kind] || []);
  if (o) show.add('delete');
  $$('#propbar .prop').forEach((el) => el.classList.toggle('show', show.has(el.dataset.for)));
  $('#toolLabel').textContent = o ? `${TOOL_NAMES[o.type] || o.type[0].toUpperCase() + o.type.slice(1)} selected` : (S.tool === 'place' && S.pending ? `Click to place ${S.pending.label}` : TOOL_NAMES[S.tool]);
  const src = o || P;
  $('#pColor').value = src.color || P.color;
  $('#pFill').value = src.fill || P.fill;
  $('#pFillOn').checked = !!(o ? o.fillOn : P.fillOn);
  $('#pWidth').value = src.width ?? P.width; $('#pWidthOut').textContent = src.width ?? P.width;
  $('#pOpacity').value = src.opacity ?? (kind === 'highlight' ? 0.4 : 1);
  $('#pFont').value = src.font || P.font;
  $('#pSize').value = Math.round((src.size || P.size) * 10) / 10;
  $('#pBold').classList.toggle('on', !!(o ? o.bold : P.bold));
  $('#pItalic').classList.toggle('on', !!(o ? o.italic : P.italic));
}

let propSnap = null;
function applyProp(key, value) {
  P[key] = value;
  if (key === 'color' && TOOL_COLORS[S.tool]) TOOL_COLORS[S.tool] = value;
  const o = selectedObj();
  if (!o) return;
  if (!propSnap) { propSnap = snapshot(); pushUndo(propSnap); }
  o[key] = value;
  redrawPage(S.sel.uid);
  refreshComments();
}

export function select(sel) {
  const prev = S.sel?.uid;
  S.sel = sel;
  propSnap = null;
  if (prev) redrawPage(prev);
  if (sel && sel.uid !== prev) redrawPage(sel.uid);
  updateProps();
}

function deleteSelected() {
  const o = selectedObj();
  if (!o) return;
  const snap = snapshot();
  const p = S.pages.find((q) => q.uid === S.sel.uid);
  p.objs = p.objs.filter((q) => q.id !== o.id);
  pushUndo(snap);
  select(null);
  redrawPage(p.uid);
  refreshComments();
}

export function addObject(p, o, { selectIt = true } = {}) {
  const snap = snapshot();
  o.id = o.id || O.newId();
  p.objs.push(o);
  pushUndo(snap);
  redrawPage(p.uid);
  if (selectIt) select({ uid: p.uid, id: o.id });
  refreshComments();
  return o;
}

function undo() {
  if (isTyping()) return document.execCommand('undo');
  if (!S.undo.length) return;
  closeEditors(false);
  S.redo.push(snapshot());
  S.pages = S.undo.pop();
  markDirty();
  refresh();
}
function redo() {
  if (isTyping()) return document.execCommand('redo');
  if (!S.redo.length) return;
  S.undo.push(snapshot());
  S.pages = S.redo.pop();
  markDirty();
  refresh();
}

// ---------------------------------------------------------------- pointer interaction
function trackDrag(onMove, onUp) {
  const move = (e) => onMove(e);
  const up = (e) => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); onUp(e); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

pagesEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const pgEl = e.target.closest('.pg');
  if (!pgEl || e.target.closest('.text-editor, .note-pop')) return;
  // A tap outside an open text editor just finishes the edit (tools cancel the default, so blur wouldn't fire).
  if (activeEditor) { e.preventDefault(); closeEditors(); return; }
  const v = views.get(pgEl.dataset.uid);
  const t = S.tool;
  if (t === 'hand') return e.pointerType === 'touch' ? undefined : startPan(e); // touch already scrolls natively

  const handle = e.target.closest('.sel-handle');
  if (handle) return startResize(e, v, +handle.dataset.handle);

  if (t === 'select') {
    const objEl = e.target.closest('.obj');
    if (objEl) return startMove(e, v, objEl.dataset.id);
    if (S.sel) select(null);
    return; // fall through to native text selection / form fields
  }
  if (!e.target.classList.contains('hit')) return;
  e.preventDefault();
  if (['highlight', 'underline', 'strike'].includes(t)) return startMarkup(e, v, t);
  if (t === 'text') return createText(v, userPt(v, e));
  if (t === 'note') return createNote(v, userPt(v, e));
  // Open on release, synchronously, so iOS treats focusing the editor as part of the tap and shows the keyboard.
  if (t === 'edittext') return trackDrag(() => {}, (m) => { if (Math.hypot(m.clientX - e.clientX, m.clientY - e.clientY) < 10) editExistingText(v, userPt(v, m)); });
  if (t === 'place') return placePending(v, userPt(v, e));
  startDraw(e, v, t);
});

pagesEl.addEventListener('dblclick', (e) => {
  const objEl = e.target.closest('.obj');
  const pgEl = e.target.closest('.pg');
  if (!objEl || !pgEl || S.tool !== 'select') return;
  const v = views.get(pgEl.dataset.uid);
  const o = v.p.objs.find((q) => q.id === objEl.dataset.id);
  if (o?.type === 'text') openTextEditor(v, o, false);
});

function startPan(e) {
  const sx = e.clientX, sy = e.clientY, st = viewer.scrollTop, sl = viewer.scrollLeft;
  viewer.style.cursor = 'grabbing';
  e.preventDefault();
  trackDrag((m) => { viewer.scrollTop = st - (m.clientY - sy); viewer.scrollLeft = sl - (m.clientX - sx); }, () => { viewer.style.cursor = ''; });
}

function startMove(e, v, id) {
  e.preventDefault();
  const o = v.p.objs.find((q) => q.id === id);
  const wasSelected = S.sel?.uid === v.p.uid && S.sel?.id === id;
  select({ uid: v.p.uid, id });
  const start = userPt(v, e);
  let last = start, snap = null, moved = false;
  trackDrag((m) => {
    const pt = userPt(v, m);
    if (!moved && Math.hypot(m.clientX - e.clientX, m.clientY - e.clientY) < 3) return;
    if (!snap) snap = snapshot();
    moved = true;
    O.translate(o, pt[0] - last[0], pt[1] - last[1]);
    last = pt;
    drawOverlay(v);
  }, () => {
    if (moved) pushUndo(snap);
    else if (o.type === 'note') openNote(v, o);
    else if (o.type === 'text' && wasSelected) openTextEditor(v, o, false); // tap again to edit (no reliable dblclick on touch)
  });
}

function startResize(e, v, ci) {
  e.preventDefault(); e.stopPropagation();
  const o = selectedObj();
  if (!o) return;
  const start = { x: o.x, y: o.y, w: o.w, h: o.h };
  const snap = snapshot();
  let changed = false;
  trackDrag((m) => { const [x, y] = userPt(v, m); O.resizeCorner(o, ci, x, y, start); changed = true; drawOverlay(v); },
    () => { if (changed) pushUndo(snap); });
}

function startDraw(e, v, tool) {
  const p0 = userPt(v, e);
  const base = { id: O.newId(), color: P.color, width: P.width, opacity: P.opacity };
  let o;
  switch (tool) {
    case 'rect': case 'ellipse': o = { ...base, type: tool, x: p0[0], y: p0[1], w: 0, h: 0, fill: P.fill, fillOn: P.fillOn }; break;
    case 'whiteout': o = { id: base.id, type: 'whiteout', x: p0[0], y: p0[1], w: 0, h: 0, fill: '#ffffff' }; break;
    case 'redact': o = { id: base.id, type: 'redact', x: p0[0], y: p0[1], w: 0, h: 0 }; break;
    case 'line': case 'arrow': o = { ...base, type: tool, x1: p0[0], y1: p0[1], x2: p0[0], y2: p0[1] }; break;
    case 'ink': o = { ...base, type: 'ink', points: [p0] }; break;
    case 'highlight': case 'underline': case 'strike':
      o = { id: base.id, type: tool, color: P.color, opacity: tool === 'highlight' ? (P.opacity < 1 ? P.opacity : 0.4) : 1, rects: [{ x: p0[0], y: p0[1], w: 0, h: 0 }] }; break;
    default: return;
  }
  const snap = snapshot();
  v.p.objs.push(o);
  const rectFrom = (a, b) => ({ x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) });
  trackDrag((m) => {
    let pt = userPt(v, m);
    if (m.shiftKey && (tool === 'line' || tool === 'arrow')) { // snap to 45°
      const dx = pt[0] - p0[0], dy = pt[1] - p0[1], a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(dx, dy);
      pt = [p0[0] + len * Math.cos(a), p0[1] + len * Math.sin(a)];
    }
    if (tool === 'ink') { const lp = o.points[o.points.length - 1]; if (Math.hypot(pt[0] - lp[0], pt[1] - lp[1]) > 0.6) o.points.push(pt); }
    else if (tool === 'line' || tool === 'arrow') { o.x2 = pt[0]; o.y2 = pt[1]; }
    else if (o.rects) o.rects = [rectFrom(p0, pt)];
    else {
      const r = rectFrom(p0, pt);
      if (m.shiftKey) { const s = Math.max(r.w, r.h); r.w = r.h = s; if (pt[0] < p0[0]) r.x = p0[0] - s; if (pt[1] < p0[1]) r.y = p0[1] - s; }
      Object.assign(o, r);
    }
    drawOverlay(v);
  }, () => {
    const f = O.frameOf(o).box;
    const tiny = tool === 'ink' ? o.points.length < 2 : (f[2] - f[0] < 3 && f[3] - f[1] < 3);
    if (tiny) { v.p.objs = v.p.objs.filter((q) => q !== o); drawOverlay(v); return; }
    pushUndo(snap);
    refreshComments();
    if (tool === 'redact') toast('Marked for redaction — content under it is removed when you save (or Tools ▸ Apply redactions now).');
  });
}

// Text markup (highlight/underline/strike): press on text and drag, and the mark snaps to the characters in
// reading order, like selecting text. Click without dragging marks one word. Off text (or on a scanned page) it drags a box.
function startMarkup(e, v, tool) {
  const items = glyphCache.get(glyphKey(v.p));
  if (!items) textGlyphs(v.p);
  const a = items && glyphAt(items, userPt(v, e), 4);
  if (!a) return startDraw(e, v, tool);
  const o = { id: O.newId(), type: tool, color: P.color, opacity: tool === 'highlight' ? (P.opacity < 1 ? P.opacity : 0.4) : 1, rects: [] };
  const snap = snapshot();
  v.p.objs.push(o);
  let moved = false;
  trackDrag((m) => {
    if (!moved && Math.hypot(m.clientX - e.clientX, m.clientY - e.clientY) < 4) return;
    moved = true;
    o.rects = glyphRects(items, a, glyphAt(items, userPt(v, m), Infinity));
    drawOverlay(v);
  }, () => {
    if (!moved) o.rects = glyphRects(items, ...wordAround(items[a.i], a));
    if (!o.rects.length) { v.p.objs = v.p.objs.filter((q) => q !== o); drawOverlay(v); return; }
    drawOverlay(v);
    pushUndo(snap);
    refreshComments();
  });
}

// Show a text cursor over text and a crosshair elsewhere while a markup tool is active.
pagesEl.addEventListener('pointermove', (e) => {
  if (!['highlight', 'underline', 'strike'].includes(S.tool) || e.buttons || !e.target.classList.contains('hit')) return;
  const v = views.get(e.target.closest('.pg').dataset.uid);
  const items = v && glyphCache.get(glyphKey(v.p));
  e.target.style.cursor = items && glyphAt(items, userPt(v, e), 4) ? 'text' : 'crosshair';
});

// Per-character geometry of the page's text items, in content order. Character advances are measured with the
// browser's font and scaled to each item's real width, which is close enough to snap to.
const glyphCache = new Map();
const glyphKey = (p) => `${p.src}:${p.idx}`;
const measureCtx = document.createElement('canvas').getContext('2d');
async function textGlyphs(p) {
  const key = glyphKey(p);
  if (glyphCache.has(key)) return glyphCache.get(key);
  const tc = await pageProxy(p).getTextContent({ disableNormalization: true });
  const items = [];
  for (const it of tc.items) {
    if (!it.str?.trim() || !it.transform || !it.width) continue;
    const [a, b, , , e, f] = it.transform;
    const size = Math.hypot(a, b);
    if (!size) continue;
    const chars = [...it.str];
    measureCtx.font = `100px ${tc.styles[it.fontName]?.fontFamily || 'sans-serif'}`;
    const xs = [0];
    for (const ch of chars) xs.push(xs[xs.length - 1] + measureCtx.measureText(ch).width);
    const k = it.width / (xs[xs.length - 1] || 1);
    items.push({ x: e, y: f, size, rot: Math.round((Math.atan2(b, a) * 180) / Math.PI), w: it.width, chars, xs: xs.map((q) => q * k) });
  }
  glyphCache.set(key, items);
  return items;
}

/** Nearest caret position {i: item, c: boundary 0..n} to a user-space point, or null if farther than `slop`. */
function glyphAt(items, [ux, uy], slop) {
  let best = null, bestD = Infinity;
  items.forEach((g, i) => {
    const [lx, ly] = O.toLocal(g.x, g.y, g.rot, ux, uy);
    const lo = -g.size * 0.25, hi = g.size * 0.95;
    const dx = lx < 0 ? -lx : lx > g.w ? lx - g.w : 0;
    const dy = ly < lo ? lo - ly : ly > hi ? ly - hi : 0;
    const d = Math.hypot(dx, dy * 3); // prefer the line under the pointer over a neighbour to the side
    if (d < bestD) { bestD = d; best = { i, lx }; }
  });
  if (!best || bestD > slop) return null;
  const xs = items[best.i].xs;
  let c = 0;
  while (c < xs.length - 1 && Math.abs(xs[c + 1] - best.lx) <= Math.abs(xs[c] - best.lx)) c++;
  return { i: best.i, c };
}

function wordAround(g, { i, c }) {
  const isWord = (ch) => ch && /\S/.test(ch);
  let s = Math.min(c, g.chars.length - 1), t = s;
  if (!isWord(g.chars[s]) && isWord(g.chars[s - 1])) s = t = s - 1;
  while (s > 0 && isWord(g.chars[s - 1])) s--;
  while (t < g.chars.length && isWord(g.chars[t])) t++;
  return [{ i, c: s }, { i, c: t }];
}

function glyphRects(items, a, b) {
  if (a.i > b.i || (a.i === b.i && a.c > b.c)) [a, b] = [b, a];
  const out = [];
  for (let i = a.i; i <= b.i; i++) {
    const g = items[i];
    const c0 = i === a.i ? a.c : 0, c1 = i === b.i ? b.c : g.chars.length;
    if (c1 <= c0) continue;
    const pts = [[g.xs[c0], -g.size * 0.22], [g.xs[c1], -g.size * 0.22], [g.xs[c1], g.size * 0.9], [g.xs[c0], g.size * 0.9]]
      .map(([lx, ly]) => O.toUser(g.x, g.y, g.rot, lx, ly));
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    out.push({ x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) });
  }
  return mergeRects(out);
}

function mergeRects(rs) {
  rs.sort((a, b) => b.y - a.y || a.x - b.x);
  const out = [];
  for (const r of rs) {
    const last = out[out.length - 1];
    const sameLine = last && Math.abs(last.y - r.y) < Math.min(last.h, r.h) * 0.5 && Math.abs(last.h - r.h) < Math.max(last.h, r.h) * 0.6;
    if (sameLine && r.x <= last.x + last.w + r.h) {
      const x = Math.min(last.x, r.x), x2 = Math.max(last.x + last.w, r.x + r.w);
      const y = Math.min(last.y, r.y), y2 = Math.max(last.y + last.h, r.y + r.h);
      Object.assign(last, { x, y, w: x2 - x, h: y2 - y });
    } else out.push({ ...r });
  }
  return out;
}

// ---------------------------------------------------------------- text objects
function createText(v, [x, y]) {
  const o = { id: O.newId(), type: 'text', x, y: 0, text: '', size: P.size, font: P.font, bold: P.bold, italic: P.italic, color: P.color, opacity: 1, rot: totalRot(v.p) };
  // Click point = top-left of the first line as seen on screen → baseline below it.
  const [vx, vy] = v.vp.convertToViewportPoint(x, y);
  [o.x, o.y] = v.vp.convertToPdfPoint(vx, vy + o.size * v.vp.scale * 0.85);
  openTextEditor(v, o, true);
}

let activeEditor = null;
export function closeEditors(commit = true) {
  if (activeEditor) activeEditor(commit);
  $$('.note-pop').forEach((n) => n._close?.());
}

function openTextEditor(v, o, isNew, { pairedWhiteout, snap: preSnap, caret } = {}) {
  closeEditors();
  const s = v.vp.scale;
  const ta = document.createElement('textarea');
  ta.className = 'text-editor';
  ta.spellcheck = false;
  const [vx, vy] = v.vp.convertToViewportPoint(o.x, o.y);
  Object.assign(ta.style, {
    left: `${vx - 2}px`, top: `${vy - o.size * s * 0.95}px`, font: `${o.italic ? 'italic ' : ''}${o.bold ? '700 ' : ''}${o.size * s}px/1.2 ${O.FONT_CSS[o.font]}`, color: o.color,
  });
  ta.value = o.text;
  const fit = () => { ta.style.width = '10px'; ta.style.height = '10px'; ta.style.width = `${ta.scrollWidth + 6}px`; ta.style.height = `${ta.scrollHeight + 2}px`; };
  v.el.append(ta);
  S.editing = o.id;
  const original = o.text;
  const snap = preSnap || snapshot();
  if (!isNew) drawOverlay(v);
  fit();
  ta.addEventListener('input', fit);
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { done(!isNew); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) done(true);
  });
  ta.addEventListener('blur', () => done(true));
  // Live-apply font/colour changes from the property bar while editing.
  ta._apply = () => { Object.assign(ta.style, { font: `${o.italic ? 'italic ' : ''}${o.bold ? '700 ' : ''}${o.size * s}px/1.2 ${O.FONT_CSS[o.font]}`, color: o.color }); fit(); };
  ta._obj = o;
  // Focus now, inside the tap, so iOS raises the keyboard. Existing PDF text gets a caret where it was tapped.
  const place = () => { if (caret != null) ta.setSelectionRange(caret, caret); else if (!isNew) ta.select(); };
  ta.focus({ preventScroll: true }); place();
  setTimeout(() => { if (document.activeElement !== ta) ta.focus({ preventScroll: true }); place(); }, 0);
  let finished = false;
  function done(commit) {
    if (finished) return;
    finished = true;
    activeEditor = null;
    S.editing = null;
    const text = ta.value.replace(/\s+$/, '');
    ta.remove();
    if (!commit) {
      if (pairedWhiteout) v.p.objs = v.p.objs.filter((q) => q.id !== pairedWhiteout && q.id !== o.id);
      else if (isNew) v.p.objs = v.p.objs.filter((q) => q.id !== o.id);
      else o.text = original;
      drawOverlay(v);
      return;
    }
    if (pairedWhiteout && text === original) { // nothing changed: drop the temporary cover
      v.p.objs = v.p.objs.filter((q) => q.id !== pairedWhiteout && q.id !== o.id);
      drawOverlay(v);
      return;
    }
    o.text = text;
    if (!text && !pairedWhiteout) {
      v.p.objs = v.p.objs.filter((q) => q.id !== o.id);
      if (!isNew) pushUndo(snap);
    } else {
      if (isNew && !v.p.objs.includes(o)) v.p.objs.push(o);
      if (text !== original || isNew) pushUndo(snap);
      if (text) S.sel = { uid: v.p.uid, id: o.id };
    }
    drawOverlay(v);
    updateProps();
  }
  activeEditor = done;
}

// ---- edit existing PDF text: cover the original run and replace it with an editable copy
const runCache = new Map();
async function textRuns(p) {
  const key = `${p.src}:${p.idx}`;
  if (runCache.has(key)) return runCache.get(key);
  const pp = pageProxy(p);
  const tc = await pp.getTextContent({ disableNormalization: true });
  const runs = [];
  let cur = null;
  for (const it of tc.items) {
    if (!it.str || !it.transform) { if (it.hasEOL) cur = null; continue; }
    const [a, b, , , e, f] = it.transform;
    const size = Math.hypot(a, b);
    if (!size) continue;
    const rot = Math.round((Math.atan2(b, a) * 180) / Math.PI);
    const fam = (tc.styles[it.fontName]?.fontFamily || '').toLowerCase();
    let real = '';
    try { real = pp.commonObjs.get(it.fontName)?.name || ''; } catch { /* font not resolved */ }
    const font = /mono|courier/i.test(fam + real) ? 'Courier' : /serif|times|roman|georgia|garamond|minion|cambria/i.test(fam.replace('sans-serif', '') + real) ? 'Times' : 'Helvetica';
    const bold = /bold|black|heavy|semibold/i.test(real);
    const italic = /italic|oblique/i.test(real);
    if (cur && cur.rot === rot && Math.abs(cur.size - size) < size * 0.2) {
      const [lx, ly] = O.toLocal(cur.x, cur.y, rot, e, f);
      const gap = lx - cur.w;
      if (Math.abs(ly) < size * 0.3 && gap > -size * 0.5 && gap < size * 1.5) {
        if (gap > size * 0.15 && !cur.text.endsWith(' ') && !it.str.startsWith(' ')) cur.text += ' ';
        cur.text += it.str;
        cur.w = lx + it.width;
        if (it.hasEOL) cur = null;
        continue;
      }
    }
    cur = { x: e, y: f, w: it.width, size, rot, text: it.str, font, bold, italic };
    runs.push(cur);
    if (it.hasEOL) cur = null;
  }
  runs.forEach((r) => { r.text = r.text.replace(/\s+$/, ''); });
  runCache.set(key, runs);
  return runs;
}
export const getTextRuns = textRuns;

function sampleColors(v, run) {
  const canvas = $('canvas.render', v.el);
  if (!canvas.width) return { fg: '#000000', bg: '#ffffff' };
  const poly = [[0, -run.size * 0.25], [run.w, -run.size * 0.25], [run.w, run.size * 0.95], [0, run.size * 0.95]]
    .map(([lx, ly]) => v.vp.convertToViewportPoint(...O.toUser(run.x, run.y, run.rot, lx, ly)));
  const k = canvas.width / v.vp.width;
  const xs = poly.map((q) => q[0] * k), ys = poly.map((q) => q[1] * k);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 2), y0 = Math.max(0, Math.floor(Math.min(...ys)) - 2);
  const w = Math.min(canvas.width - x0, Math.ceil(Math.max(...xs)) - x0 + 4), h = Math.min(canvas.height - y0, Math.ceil(Math.max(...ys)) - y0 + 4);
  if (w <= 0 || h <= 0) return { fg: '#000000', bg: '#ffffff' };
  const d = canvas.getContext('2d').getImageData(x0, y0, w, h).data;
  const hex = (i) => '#' + [d[i], d[i + 1], d[i + 2]].map((c) => c.toString(16).padStart(2, '0')).join('');
  // background: most common colour on the border; foreground: pixel farthest from it
  const counts = new Map();
  for (let x = 0; x < w; x++) for (const y of [0, h - 1]) { const i = (y * w + x) * 4; const c = hex(i); counts.set(c, (counts.get(c) || 0) + 1); }
  const bg = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '#ffffff';
  const br = parseInt(bg.slice(1, 3), 16), bgG = parseInt(bg.slice(3, 5), 16), bb = parseInt(bg.slice(5, 7), 16);
  let best = 0, fg = '#000000';
  for (let i = 0; i < d.length; i += 4) {
    const dist = Math.abs(d[i] - br) + Math.abs(d[i + 1] - bgG) + Math.abs(d[i + 2] - bb);
    if (dist > best) { best = dist; fg = hex(i); }
  }
  return { fg, bg };
}

function editExistingText(v, pt) {
  const runs = runCache.get(`${v.p.src}:${v.p.idx}`);
  // Runs are prefetched when the page renders; if not ready yet, open after loading (desktop keyboards don't mind).
  if (!runs) return textRuns(v.p).then(() => editExistingText(v, pt));
  const [ux, uy] = pt;
  let clickX = 0;
  const run = runs.find((r) => {
    const [lx, ly] = O.toLocal(r.x, r.y, r.rot, ux, uy);
    clickX = lx;
    return lx >= -2 && lx <= r.w + 2 && ly >= -r.size * 0.3 && ly <= r.size;
  });
  if (!run) { toast('No text there — tap directly on a line of existing text.'); return; }
  const poly = [[-1, -run.size * 0.28], [run.w + 1, -run.size * 0.28], [run.w + 1, run.size * 0.98], [-1, run.size * 0.98]].map(([lx, ly]) => O.toUser(run.x, run.y, run.rot, lx, ly));
  const xs = poly.map((q) => q[0]), ys = poly.map((q) => q[1]);
  const { fg, bg } = sampleColors(v, run);
  const cover = { id: O.newId(), type: 'whiteout', x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), fill: bg };
  const txt = { id: O.newId(), type: 'text', x: run.x, y: run.y, text: run.text, size: Math.round(run.size * 10) / 10, font: run.font, bold: run.bold, italic: run.italic, color: fg, opacity: 1, rot: run.rot };
  const snap = snapshot();
  // Put the replacement at the bottom of the stack so existing highlights/markup stay visible on top.
  v.p.objs.unshift(cover, txt);
  drawOverlay(v);
  openTextEditor(v, txt, false, { pairedWhiteout: cover.id, snap, caret: caretIn(run, clickX) });
}

// Character index in a run nearest a local x, measuring with the run's font and scaling to its real width.
function caretIn(run, lx) {
  measureCtx.font = `${run.italic ? 'italic ' : ''}${run.bold ? '700 ' : ''}100px ${O.FONT_CSS[run.font]}`;
  const k = run.w / (measureCtx.measureText(run.text).width || 1);
  let best = 0;
  for (let i = 1; i <= run.text.length; i++) {
    if (Math.abs(measureCtx.measureText(run.text.slice(0, i)).width * k - lx) < Math.abs(measureCtx.measureText(run.text.slice(0, best)).width * k - lx)) best = i;
  }
  return best;
}

// ---------------------------------------------------------------- notes
function createNote(v, [x, y]) {
  const o = addObject(v.p, { type: 'note', x: x - 2, y: y + 18, text: '', color: P.color || '#fbc02d', author: 'Me', date: Date.now() });
  setTool('select');
  select({ uid: v.p.uid, id: o.id });
  openNote(v, o, true);
}

function openNote(v, o, isNew = false) {
  closeEditors();
  const [vx, vy] = v.vp.convertToViewportPoint(o.x + 22, o.y);
  const pop = document.createElement('div');
  pop.className = 'note-pop';
  pop.style.left = `${Math.min(vx, v.vp.width - 230)}px`;
  pop.style.top = `${vy}px`;
  pop.innerHTML = `<div class="row"><span>${esc(o.author || 'Note')} · ${new Date(o.date || Date.now()).toLocaleString()}</span><button title="Delete">🗑</button></div><textarea placeholder="Write a comment…"></textarea>`;
  const ta = $('textarea', pop);
  ta.value = o.text || '';
  v.el.append(pop);
  setTimeout(() => ta.focus(), 0);
  const snap = snapshot();
  const original = o.text;
  pop.addEventListener('pointerdown', (e) => e.stopPropagation());
  ta.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') close(); });
  $('button', pop).onclick = () => { pop._close = null; pop.remove(); select({ uid: v.p.uid, id: o.id }); deleteSelected(); };
  function close() {
    if (!pop.isConnected) return;
    pop.remove();
    o.text = ta.value;
    if (o.text !== original && !isNew) pushUndo(snap);
    refreshComments();
  }
  pop._close = close;
  setTimeout(() => document.addEventListener('pointerdown', function off(e) {
    if (pop.contains(e.target)) return;
    document.removeEventListener('pointerdown', off, true);
    close();
  }, true), 0);
}

// ---------------------------------------------------------------- placing images / signatures / stamps
export function beginPlace(pending) {
  S.pending = pending;
  setTool('place');
  S.pending = pending;
  updateProps();
  toast(`Click on a page to place the ${pending.label}`);
}

function placePending(v, [x, y]) {
  const pd = S.pending;
  if (!pd) return;
  const rot = totalRot(v.p);
  const swap = rot === 90 || rot === 270;
  let vw = pd.w, vh = pd.h;
  const o = pd.kind === 'image'
    ? { type: 'image', imgId: pd.imgId, opacity: 1, rot }
    : { type: 'stamp', label: pd.text, sub: pd.sub, color: pd.color, opacity: 1, rot };
  const w = swap ? vh : vw, h = swap ? vw : vh;
  Object.assign(o, { x: x - w / 2, y: y - h / 2, w, h });
  setTool('select');
  addObject(v.p, o);
}

export function registerImage(bytes, mime, w, h) {
  const id = O.newId('img');
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  S.images.set(id, { bytes, mime, url, w, h });
  return id;
}

async function insertImageFromBytes(bytes, ext) {
  let mime = ext === 'png' ? 'image/png' : 'image/jpeg';
  let bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
  // Normalise anything odd (CMYK JPEG, 16-bit PNG…) through a canvas → PNG.
  if (!['png', 'jpg', 'jpeg'].includes(ext)) {
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; c.getContext('2d').drawImage(bmp, 0, 0);
    bytes = new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer());
    mime = 'image/png';
  }
  const scale = Math.min(1, 300 / Math.max(bmp.width, bmp.height)) * 0.75;
  const imgId = registerImage(bytes, mime, bmp.width, bmp.height);
  beginPlace({ kind: 'image', imgId, w: Math.max(20, bmp.width * scale), h: Math.max(20, bmp.height * scale), label: 'image' });
}

// ---------------------------------------------------------------- search
async function runFind(q) {
  S.find = { q, hits: [], cur: -1 };
  if (q) {
    const cs = $('#findCase').checked;
    const needle = cs ? q : q.toLowerCase();
    for (const p of S.pages) {
      const runs = (await textRuns(p)).slice();
      for (const w of p.ocr || []) runs.push({ x: w.x, y: w.y + w.h * 0.2, w: w.w, size: w.h, rot: 0, text: w.text });
      for (const r of runs) {
        const hay = cs ? r.text : r.text.toLowerCase();
        let at = hay.indexOf(needle);
        while (at >= 0) {
          const L = r.text.length;
          const poly = [[(at / L) * r.w, -r.size * 0.25], [((at + q.length) / L) * r.w, r.size * 0.95]].map(([lx, ly]) => O.toUser(r.x, r.y, r.rot, lx, ly));
          const rect = { x: Math.min(poly[0][0], poly[1][0]), y: Math.min(poly[0][1], poly[1][1]), w: Math.abs(poly[0][0] - poly[1][0]), h: Math.abs(poly[0][1] - poly[1][1]) };
          S.find.hits.push({ uid: p.uid, rects: [rect] });
          at = hay.indexOf(needle, at + needle.length);
        }
      }
    }
  }
  for (const v of views.values()) drawOverlay(v);
  if (S.find.hits.length) {
    // jump to the first hit at/after the current page
    const order = S.pages.map((p) => p.uid);
    const startIdx = S.find.hits.findIndex((h) => order.indexOf(h.uid) >= S.current);
    showHit(startIdx < 0 ? 0 : startIdx);
  }
  $('#findCount').textContent = q ? (S.find.hits.length ? `${S.find.cur + 1} of ${S.find.hits.length}` : 'No matches') : '';
}

function showHit(i) {
  const n = S.find.hits.length;
  if (!n) return;
  S.find.cur = (i + n) % n;
  const h = S.find.hits[S.find.cur];
  const v = views.get(h.uid);
  for (const vv of views.values()) drawOverlay(vv);
  const r = h.rects[0];
  const [vx, vy] = v.vp.convertToViewportPoint(r.x, r.y + r.h);
  viewer.scrollTop = v.el.offsetTop + vy - viewer.clientHeight / 3;
  viewer.scrollLeft = Math.max(0, v.el.offsetLeft + vx - viewer.clientWidth / 2);
  $('#findCount').textContent = `${S.find.cur + 1} of ${n}`;
}

function openFind() {
  if (!S.pages.length) return;
  $('#findbar').hidden = false;
  $('#findInput').focus();
  $('#findInput').select();
}
function closeFind() {
  $('#findbar').hidden = true;
  S.find = { q: '', hits: [], cur: -1 };
  for (const v of views.values()) drawOverlay(v);
}

// ---------------------------------------------------------------- organizer
const orgSel = new Set();
let orgAnchor = null;
function buildOrganizer() {
  const grid = $('#orgGrid');
  for (const uid of [...orgSel]) if (!S.pages.some((p) => p.uid === uid)) orgSel.delete(uid);
  grid.innerHTML = S.pages.map((p, i) => `<div class="org-item${orgSel.has(p.uid) ? ' sel' : ''}" draggable="true" data-uid="${p.uid}"><div class="tframe"></div>${i + 1}<span class="src">${esc(S.sources[p.src].name)}</span></div>`).join('');
  const orgIO = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) { renderThumb(en.target, 140); orgIO.unobserve(en.target); }
  }, { root: grid, rootMargin: '300px' });
  $$('.org-item', grid).forEach((el, i) => {
    orgIO.observe(el);
    el.onclick = (e) => {
      const uid = el.dataset.uid;
      if (e.shiftKey && orgAnchor != null) {
        const a = S.pages.findIndex((p) => p.uid === orgAnchor);
        const [lo, hi] = [Math.min(a, i), Math.max(a, i)];
        for (let k = lo; k <= hi; k++) orgSel.add(S.pages[k].uid);
      } else if (e.metaKey || e.ctrlKey || isNarrow()) { orgSel.has(uid) ? orgSel.delete(uid) : orgSel.add(uid); orgAnchor = uid; } // tap toggles on phones
      else { orgSel.clear(); orgSel.add(uid); orgAnchor = uid; }
      $$('.org-item', grid).forEach((x) => x.classList.toggle('sel', orgSel.has(x.dataset.uid)));
      $('#orgSelCount').textContent = orgSel.size ? `${orgSel.size} selected` : '';
    };
    el.ondblclick = () => { closeOrganizer(); goToPage(i); };
    wireDrag(el, () => (orgSel.has(el.dataset.uid) ? S.pages.filter((p) => orgSel.has(p.uid)).map((p) => p.uid) : [el.dataset.uid]), 'x');
  });
  $('#orgSelCount').textContent = orgSel.size ? `${orgSel.size} selected` : '';
}
function openOrganizer() {
  if (!S.pages.length) return;
  closeEditors();
  $('#organizer').hidden = false;
  buildOrganizer();
}
function closeOrganizer() { $('#organizer').hidden = true; refresh(true); }

async function orgAction(act) {
  const selected = S.pages.filter((p) => orgSel.has(p.uid));
  const need = () => { if (!selected.length) { toast('Select one or more pages first (⌘-click / ⇧-click for several).'); return false; } return true; };
  const lastIdx = selected.length ? S.pages.indexOf(selected[selected.length - 1]) + 1 : S.pages.length;
  switch (act) {
    case 'close': return closeOrganizer();
    case 'left': case 'right': {
      if (!need()) return;
      const snap = snapshot();
      const moving = S.pages.filter((p) => orgSel.has(p.uid));
      const rest = S.pages.filter((p) => !orgSel.has(p.uid));
      const firstIdx = S.pages.indexOf(moving[0]);
      const before = S.pages.slice(0, firstIdx).filter((p) => !orgSel.has(p.uid)).length;
      const at = Math.max(0, Math.min(rest.length, before + (act === 'left' ? -1 : 1)));
      rest.splice(at, 0, ...moving);
      S.pages = rest;
      pushUndo(snap); return buildOrganizer();
    }
    case 'selectAll': S.pages.forEach((p) => orgSel.add(p.uid)); return buildOrganizer();
    case 'rotL': case 'rotR': {
      if (!need()) return;
      const snap = snapshot();
      selected.forEach((p) => { p.rot = (p.rot + (act === 'rotR' ? 90 : 270)) % 360; });
      pushUndo(snap); return buildOrganizer();
    }
    case 'delete': {
      if (!need()) return;
      if (selected.length === S.pages.length) return toast('A document needs at least one page.');
      const snap = snapshot();
      S.pages = S.pages.filter((p) => !orgSel.has(p.uid));
      orgSel.clear(); pushUndo(snap); return buildOrganizer();
    }
    case 'dup': {
      if (!need()) return;
      const snap = snapshot();
      for (const p of selected) {
        const copy = structuredClone(p);
        copy.uid = newUid();
        copy.objs.forEach((o) => { o.id = O.newId(); });
        S.pages.splice(S.pages.indexOf(p) + 1, 0, copy);
      }
      pushUndo(snap); return buildOrganizer();
    }
    case 'blank': {
      const ref = S.pages[Math.max(0, lastIdx - 1)];
      const vp = viewportFor(ref, 1);
      const snap = snapshot();
      await addBlankPage(lastIdx, vp.width, vp.height);
      pushUndo(snap); return buildOrganizer();
    }
    case 'insert': {
      const files = await host.openPdfs(true);
      if (files.length) { await insertFiles(files, lastIdx); buildOrganizer(); }
      return;
    }
    case 'extract': {
      if (!need()) return;
      const path = await host.saveDialog(`${(S.fileName || 'document').replace(/\.pdf$/i, '')}-extract.pdf`);
      if (!path) return;
      busy('Extracting…');
      try {
        const { bytes } = await buildPdf(S, { pages: selected });
        await host.writeFile(path, bytes);
        toast(`Saved ${selected.length} page${selected.length === 1 ? '' : 's'}`, { action: 'Show in Finder', onAction: () => host.reveal(path) });
      } catch (e) { toast(`Extract failed: ${e.message}`); } finally { busy(); }
    }
  }
}

// ---------------------------------------------------------------- save & print
export async function save(as = false) {
  if (!S.pages.length) return;
  closeEditors();
  let path = S.filePath;
  if (as || !path) path = await host.saveDialog(S.fileName || 'document.pdf');
  if (!path) return;
  busy('Saving…');
  try {
    const { bytes, notes } = await buildPdf(S, { flatten: S.flattenForms });
    await host.writeFile(path, bytes);
    S.filePath = path;
    S.fileName = path.split('/').pop();
    markDirty(false);
    toast(['Saved.', ...notes].join(' '), { ms: notes.length ? 8000 : 2500 });
  } catch (e) {
    console.error(e);
    toast(`Save failed: ${e.message}`, { ms: 8000 });
  } finally { busy(); }
}

async function print() {
  if (!S.pages.length) return;
  closeEditors();
  busy('Preparing to print…');
  const area = $('#printArea');
  try {
    const { bytes } = await buildPdf(S, { flatten: true });
    const doc = await openBytes(bytes);
    area.innerHTML = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const pg = await doc.getPage(i);
      const { canvas } = await renderToCanvas(pg, 150 / 72, { rotation: pg.rotate });
      const img = new Image();
      img.src = canvas.toDataURL('image/jpeg', 0.92);
      area.append(img);
    }
    await Promise.all([...area.images].map((im) => im.decode().catch(() => {})));
    doc.destroy();
    busy();
    window.print();
  } catch (e) { toast(`Print failed: ${e.message}`); } finally { busy(); area.innerHTML = ''; }
}

// ---------------------------------------------------------------- commands
const commands = {
  open: async () => openFiles(await host.openPdfs(true)),
  combine: async () => { const f = await host.openPdfs(true); if (f.length) await insertFiles(f); },
  save: () => save(false), saveAs: () => save(true), print,
  undo, redo,
  find: openFind,
  zoomIn: () => setZoom(S.zoom * 1.2), zoomOut: () => setZoom(S.zoom / 1.2), zoom100: () => setZoom(1), fitWidth: () => setZoom(0, 'fit'),
  toggleSidebar: () => {
    if (isNarrow()) { document.body.classList.toggle('drawer-open'); return; } // overlay drawer: page width unchanged
    $('#sidebar').classList.toggle('hidden');
    if (S.zoomMode !== 'custom') setZoom(0, S.zoomMode);
  },
  organize: () => ($('#organizer').hidden ? openOrganizer() : closeOrganizer()),
  image: async () => { if (!S.pages.length) return; const f = await host.openImage(); if (f) await insertImageFromBytes(f.data, f.ext); },
  signature: () => S.pages.length && Tools.signatureDialog(),
  stamp: () => S.pages.length && Tools.stampDialog(),
  split: () => S.pages.length && Tools.splitDialog(),
  compress: () => S.pages.length && Tools.compressDialog(),
  ocr: () => S.pages.length && Tools.ocrDialog(),
  exportImages: () => S.pages.length && Tools.exportImagesDialog(),
  exportText: () => S.pages.length && Tools.exportText(),
  properties: () => S.pages.length && Tools.propertiesDialog(),
  licenses: () => Tools.licensesDialog(),
  applyRedactions: () => S.pages.length && Tools.applyRedactionsNow(),
  toggleFlatten: () => { S.flattenForms = !S.flattenForms; $('#flattenItem').classList.toggle('checked', S.flattenForms); toast(S.flattenForms ? 'Form fields will be flattened (made permanent) when you save.' : 'Form fields stay fillable when you save.'); },
};
export const run = (cmd) => { $('#menuPop').hidden = true; return commands[cmd]?.(); };

// ---------------------------------------------------------------- wiring
function wire() {
  applyIcons();
  host.onCommand(run);
  host.onOpenFiles((files) => openFiles(files));
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cmd]');
    if (b) { run(b.dataset.cmd); return; }
    const t = e.target.closest('[data-tool]');
    if (t) setTool(t.dataset.tool);
    const org = e.target.closest('[data-org]');
    if (org) orgAction(org.dataset.org);
    if (!e.target.closest('#moreBtn, #menuPop')) $('#menuPop').hidden = true;
  });
  $('#moreBtn').onclick = () => {
    const m = $('#menuPop'), r = $('#moreBtn').getBoundingClientRect();
    m.hidden = !m.hidden;
    m.style.top = `${r.bottom + 4}px`; m.style.right = `${window.innerWidth - r.right}px`;
  };
  $$('.tabs button').forEach((b) => { b.onclick = () => {
    $$('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    $$('.tabpane').forEach((x) => x.classList.toggle('active', x.id === `tab-${b.dataset.tab}`));
  }; });

  // property bar
  const live = (id, key, conv = (x) => x) => $(id).addEventListener('input', (e) => {
    applyProp(key, conv(e.target.type === 'checkbox' ? e.target.checked : e.target.value));
    if (key === 'width') $('#pWidthOut').textContent = e.target.value;
    if (activeEditor) $('.text-editor')?._apply?.();
  });
  live('#pColor', 'color'); live('#pFill', 'fill'); live('#pFillOn', 'fillOn');
  live('#pWidth', 'width', Number); live('#pOpacity', 'opacity', Number);
  live('#pFont', 'font'); live('#pSize', 'size', (v) => Math.max(2, Number(v) || 12));
  for (const [id, key] of [['#pBold', 'bold'], ['#pItalic', 'italic']]) {
    const btn = $(id);
    btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep text editor focused
    btn.onclick = (e) => { e.preventDefault(); const on = !btn.classList.contains('on'); btn.classList.toggle('on', on); applyProp(key, on); const ed = $('.text-editor'); if (ed?._obj) { ed._obj[key] = on; ed._apply(); } };
  }
  // keep editor objects in sync with prop edits
  ['#pColor', '#pFont', '#pSize'].forEach((id) => $(id).addEventListener('input', () => {
    const ed = $('.text-editor');
    if (ed?._obj) { const k = { '#pColor': 'color', '#pFont': 'font', '#pSize': 'size' }[id]; ed._obj[k] = k === 'size' ? Number($(id).value) : $(id).value; ed._apply(); }
  }));
  $('#pDelete').onclick = deleteSelected;

  $('#zoomSel').onchange = (e) => { const v = e.target.value; if (v === 'fit' || v === 'page') setZoom(0, v); else if (v !== 'custom') setZoom(+v); };
  $('#pageInput').onchange = (e) => goToPage((parseInt(e.target.value, 10) || 1) - 1);
  $('#pageInput').onkeydown = (e) => { if (e.key === 'Enter') e.target.blur(); };

  let scrollRaf = 0;
  viewer.addEventListener('scroll', () => { if (!scrollRaf) scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; onScroll(); }); });
  let zoomTimer = 0, pendingZoom = null;
  viewer.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey) || !S.pages.length) return;
    e.preventDefault();
    pendingZoom = (pendingZoom ?? S.zoom) * Math.exp(-e.deltaY * 0.01);
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => { setZoom(pendingZoom); pendingZoom = null; }, 90);
  }, { passive: false });
  // iOS pinch-to-zoom (Safari gesture events): preview with a CSS transform, re-render on release.
  let pinchBase = 0;
  viewer.addEventListener('gesturestart', (e) => { if (!S.pages.length) return; e.preventDefault(); pinchBase = S.zoom; pagesEl.style.transformOrigin = `${viewer.scrollLeft + viewer.clientWidth / 2}px ${viewer.scrollTop + viewer.clientHeight / 2}px`; });
  viewer.addEventListener('gesturechange', (e) => { if (!pinchBase) return; e.preventDefault(); pagesEl.style.transform = `scale(${e.scale})`; });
  viewer.addEventListener('gestureend', (e) => {
    if (!pinchBase) return;
    e.preventDefault();
    pagesEl.style.transform = '';
    const z = pinchBase * e.scale;
    pinchBase = 0;
    if (Math.abs(z - S.zoom) > 0.02) setZoom(z);
  });
  // Close the sidebar drawer after jumping to a page, or when tapping the document, on phones.
  viewer.addEventListener('pointerdown', () => document.body.classList.remove('drawer-open'), true);
  $('#thumbs').addEventListener('click', () => { if (isNarrow()) document.body.classList.remove('drawer-open'); });
  let resizeTimer = 0;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (S.pages.length && S.zoomMode !== 'custom') setZoom(0, S.zoomMode); }, 150); });

  // find bar
  let findTimer = 0;
  $('#findInput').addEventListener('input', (e) => { clearTimeout(findTimer); findTimer = setTimeout(() => runFind(e.target.value), 200); });
  $('#findCase').onchange = () => runFind($('#findInput').value);
  $('#findInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (S.find.q !== e.target.value) runFind(e.target.value); else showHit(S.find.cur + (e.shiftKey ? -1 : 1)); }
    if (e.key === 'Escape') closeFind();
  });
  $$('[data-find]').forEach((b) => { b.onclick = () => ({ prev: () => showHit(S.find.cur - 1), next: () => showHit(S.find.cur + 1), close: closeFind })[b.dataset.find](); });

  // keyboard
  document.addEventListener('keydown', (e) => {
    if (!$('#modalBack').hidden || isTyping()) return;
    const mod = e.metaKey || e.ctrlKey;
    if ((e.key === 'Backspace' || e.key === 'Delete') && S.sel) { e.preventDefault(); return deleteSelected(); }
    if (e.key === 'Escape') { if (!$('#organizer').hidden) return closeOrganizer(); if (S.tool !== 'select') return setTool('select'); return select(null); }
    if (S.sel && e.key.startsWith('Arrow')) {
      e.preventDefault();
      const v = views.get(S.sel.uid), d = e.shiftKey ? 10 : 1;
      const [dx, dy] = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] }[e.key];
      const a = v.vp.convertToPdfPoint(0, 0), b = v.vp.convertToPdfPoint(dx * v.vp.scale, dy * v.vp.scale);
      const snap = snapshot();
      O.translate(selectedObj(), b[0] - a[0], b[1] - a[1]);
      pushUndo(snap); drawOverlay(v);
      return;
    }
    if (mod && e.key === 'd' && S.sel) {
      e.preventDefault();
      const o = structuredClone(selectedObj()); o.id = O.newId(); O.translate(o, 12, -12);
      return addObject(S.pages.find((p) => p.uid === S.sel.uid), o);
    }
    if (mod || e.altKey) return;
    const keyTools = { v: 'select', h: 'hand', t: 'text', p: 'ink', e: 'edittext', n: 'note', r: 'rect', l: 'line', a: 'arrow', o: 'ellipse', u: 'highlight' };
    if (keyTools[e.key] && S.pages.length) setTool(keyTools[e.key]);
    if (e.key === 'PageDown' || (e.key === ' ' && false)) goToPage(S.current + 1);
    if (e.key === 'PageUp') goToPage(S.current - 1);
  });

  // copy / paste objects and images
  document.addEventListener('copy', (e) => {
    if (isTyping() || !S.sel || !window.getSelection().isCollapsed) return;
    S.clip = structuredClone(selectedObj());
    e.clipboardData.setData('text/plain', S.clip.text || '');
    e.preventDefault();
  });
  document.addEventListener('paste', async (e) => {
    if (isTyping() || !S.pages.length) return;
    const file = [...(e.clipboardData?.files || [])].find((f) => /image\/(png|jpe?g)/.test(f.type));
    if (file) { e.preventDefault(); return insertImageFromBytes(new Uint8Array(await file.arrayBuffer()), file.type.includes('png') ? 'png' : 'jpg'); }
    if (S.clip) {
      e.preventDefault();
      const o = structuredClone(S.clip); o.id = O.newId(); O.translate(o, 12, -12); S.clip = structuredClone(o);
      addObject(S.pages[S.current], o);
    }
  });

  // drag & drop PDFs onto the window
  const drop = $('#empty .drop');
  document.addEventListener('dragover', (e) => { if (!dragUids) { e.preventDefault(); drop.classList.add('over'); } });
  document.addEventListener('dragleave', () => drop.classList.remove('over'));
  document.addEventListener('drop', async (e) => {
    if (dragUids) return;
    e.preventDefault();
    drop.classList.remove('over');
    const files = [...e.dataTransfer.files].filter((f) => /\.pdf$/i.test(f.name));
    const imgs = [...e.dataTransfer.files].filter((f) => /\.(png|jpe?g)$/i.test(f.name));
    if (!files.length && imgs.length && S.pages.length) return insertImageFromBytes(new Uint8Array(await imgs[0].arrayBuffer()), /png$/i.test(imgs[0].name) ? 'png' : 'jpg');
    if (!files.length) return;
    const loaded = await Promise.all(files.map(async (f) => ({ name: f.name, path: host.pathForFile(f), data: new Uint8Array(await f.arrayBuffer()) })));
    if (!S.pages.length) return openFiles(loaded);
    const r = await host.confirm(`Add ${files.length === 1 ? `“${files[0].name}”` : `${files.length} files`}`, 'Open in place of the current document, or append its pages to the end?', ['Append pages', 'Open instead', 'Cancel']);
    if (r === 0) insertFiles(loaded); else if (r === 1) openFiles(loaded);
  });

  setTool('select');
  markDirty(false);
}

wire();
// Expose for the smoke test and dev console.
window.app = { S, run, openFiles, insertFiles, setTool, setZoom, save, buildPdf, addObject, views, layout, refresh, getTextRuns, goToPage, beginPlace, registerImage, select, closeEditors };
host.ready().then((files) => { if (files.length) openFiles(files); });
