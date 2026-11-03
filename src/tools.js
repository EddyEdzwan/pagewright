// Dialog-driven tools: signatures, stamps, split, compress, OCR, export, properties, redaction.
import { S, beginPlace, registerImage, refresh, pushUndo, replacePageSource, pageProxy, totalRot, markDirty } from './app.js';
import { buildPdf, renderToCanvas, canvasBytes, openBytes } from './pdfops.js';
import { modal, toast, busy, esc, parseRanges } from './ui.js';

const { PDFDocument } = window.PDFLib;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const baseName = () => (S.fileName || 'document.pdf').replace(/\.pdf$/i, '');
const fmtSize = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(2)} MB` : `${Math.round(b / 1e3)} KB`);

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

// ---------------------------------------------------------------- signature
const SIG_FONTS = ['Snell Roundhand', 'Apple Chancery', 'Bradley Hand', 'Noteworthy', 'Savoye LET', 'Zapfino'];

/** Crop a canvas to its non-transparent content; returns a new canvas. */
function trimCanvas(c) {
  const ctx = c.getContext('2d');
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  const pad = 6, out = document.createElement('canvas');
  out.width = x1 - x0 + 1 + pad * 2; out.height = y1 - y0 + 1 + pad * 2;
  out.getContext('2d').drawImage(c, x0 - pad, y0 - pad, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

async function placeSignatureFromDataUrl(url) {
  const blob = await (await fetch(url)).blob();
  const bmp = await createImageBitmap(blob);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const imgId = registerImage(bytes, 'image/png', bmp.width, bmp.height);
  const w = 160, h = (160 * bmp.height) / bmp.width;
  beginPlace({ kind: 'image', imgId, w, h: Math.min(h, 90), label: 'signature' });
}

export async function signatureDialog() {
  const saved = store.get('pagewright.signatures', null) ?? store.get('pdfstudio.signatures', []); // keep signatures saved before the rename
  let mode = 'draw', uploaded = null;
  const r = await modal({
    title: 'Add signature', width: 580,
    html: `
      ${saved.length ? `<div class="muted">Saved signatures — click one to place it</div><div class="sig-saved">${saved.map((u, i) => `<div class="s" data-i="${i}"><img src="${u}"/><button data-del="${i}" title="Forget">✕</button></div>`).join('')}</div><hr/>` : ''}
      <div class="row"><div class="segmented"><button data-mode="draw" class="active">Draw</button><button data-mode="type">Type</button><button data-mode="upload">Image</button></div>
        <span class="spacer"></span><label>Ink <input type="color" id="sigColor" value="#0b2a7a"/></label></div>
      <div data-pane="draw"><canvas class="sig-pad" id="sigPad"></canvas><div class="row"><button id="sigClear">Clear</button><span class="muted">Draw with mouse or trackpad</span></div></div>
      <div data-pane="type" hidden><input type="text" id="sigText" placeholder="Your name" style="width:100%"/>
        <div class="row"><select id="sigFont">${SIG_FONTS.map((f) => `<option>${f}</option>`).join('')}</select></div>
        <div id="sigPreview" style="font-size:44px;min-height:70px;background:#fff;color:#0b2a7a;border:1px solid var(--border);border-radius:8px;padding:4px 12px"></div></div>
      <div data-pane="upload" hidden><button id="sigPick">Choose image…</button> <span id="sigPicked" class="muted">PNG with transparent background works best</span></div>
      <label class="row"><input type="checkbox" id="sigSave" checked/> Remember this signature</label>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Place signature', value: 'ok', primary: true }],
    onMount(root, close) {
      const pad = $('#sigPad', root), dpr = 2;
      pad.width = (pad.clientWidth || 520) * dpr; pad.height = (pad.clientHeight || 180) * dpr; // match CSS size (narrower on phones)
      const ctx = pad.getContext('2d');
      ctx.scale(dpr, dpr); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      let drawing = false, last = null;
      pad.onpointerdown = (e) => { drawing = true; pad.setPointerCapture(e.pointerId); last = [e.offsetX, e.offsetY]; };
      pad.onpointermove = (e) => {
        if (!drawing) return;
        const p = [e.offsetX, e.offsetY];
        ctx.strokeStyle = $('#sigColor', root).value;
        ctx.lineWidth = Math.max(1.4, 3.2 - Math.hypot(p[0] - last[0], p[1] - last[1]) * 0.06); // faster = thinner
        ctx.beginPath(); ctx.moveTo(...last); ctx.quadraticCurveTo(last[0], last[1], (last[0] + p[0]) / 2, (last[1] + p[1]) / 2); ctx.lineTo(...p); ctx.stroke();
        last = p;
      };
      pad.onpointerup = () => { drawing = false; };
      $('#sigClear', root).onclick = () => ctx.clearRect(0, 0, pad.width, pad.height);
      const prev = () => { const p = $('#sigPreview', root); p.textContent = $('#sigText', root).value || 'Your name'; p.style.fontFamily = `"${$('#sigFont', root).value}", cursive`; p.style.color = $('#sigColor', root).value; };
      $('#sigText', root).oninput = prev; $('#sigFont', root).onchange = prev; $('#sigColor', root).oninput = prev; prev();
      $$('[data-mode]', root).forEach((b) => { b.onclick = () => {
        mode = b.dataset.mode;
        $$('[data-mode]', root).forEach((x) => x.classList.toggle('active', x === b));
        $$('[data-pane]', root).forEach((x) => { x.hidden = x.dataset.pane !== mode; });
      }; });
      $('#sigPick', root).onclick = async () => {
        const f = await host.openImage();
        if (!f) return;
        uploaded = f;
        $('#sigPicked', root).textContent = f.name;
      };
      $$('.sig-saved .s', root).forEach((el) => { el.onclick = (e) => {
        if (e.target.dataset.del != null) {
          saved.splice(+e.target.dataset.del, 1); store.set('pagewright.signatures', saved); el.remove(); e.stopPropagation(); return;
        }
        close(null); placeSignatureFromDataUrl(saved[+el.dataset.i]);
      }; });
    },
    async collect(root) {
      let c;
      if (mode === 'draw') c = trimCanvas($('#sigPad', root));
      else if (mode === 'type') {
        const text = $('#sigText', root).value.trim();
        if (!text) { toast('Type your name first'); return false; }
        const tmp = document.createElement('canvas'); tmp.width = 1400; tmp.height = 300;
        const t = tmp.getContext('2d');
        t.font = `120px "${$('#sigFont', root).value}", cursive`; t.fillStyle = $('#sigColor', root).value; t.textBaseline = 'middle';
        t.fillText(text, 20, 150);
        c = trimCanvas(tmp);
      } else {
        if (!uploaded) { toast('Choose an image first'); return false; }
        const bmp = await createImageBitmap(new Blob([uploaded.data]));
        c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; c.getContext('2d').drawImage(bmp, 0, 0);
      }
      if (!c) { toast('Draw your signature first'); return false; }
      return { url: c.toDataURL('image/png'), remember: $('#sigSave', root).checked };
    },
  });
  if (!r) return;
  if (r.data.remember) { saved.unshift(r.data.url); store.set('pagewright.signatures', saved.slice(0, 6)); }
  await placeSignatureFromDataUrl(r.data.url);
}

// ---------------------------------------------------------------- stamps
const STAMPS = [['APPROVED', '#2e7d32'], ['REJECTED', '#c62828'], ['DRAFT', '#1565c0'], ['CONFIDENTIAL', '#c62828'], ['FINAL', '#2e7d32'], ['FOR REVIEW', '#ef6c00'], ['PAID', '#2e7d32'], ['VOID', '#c62828'], ['COPY', '#6a1b9a']];

export async function stampDialog() {
  let chosen = null;
  const r = await modal({
    title: 'Stamp',
    html: `<div class="stamp-grid">${STAMPS.map(([t, c], i) => `<button data-i="${i}" style="color:${c}">${t}</button>`).join('')}</div>
      <div class="row"><input type="text" id="stCustom" placeholder="…or custom text" style="flex:1"/><input type="color" id="stColor" value="#c62828"/></div>
      <label class="row"><input type="checkbox" id="stDate" checked/> Add today's date</label>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Place stamp', value: 'ok', primary: true }],
    onMount(root) {
      $$('.stamp-grid button', root).forEach((b) => { b.onclick = () => {
        chosen = STAMPS[+b.dataset.i];
        $$('.stamp-grid button', root).forEach((x) => { x.style.background = x === b ? 'var(--accent-soft)' : ''; });
        $('#stCustom', root).value = ''; $('#stColor', root).value = chosen[1];
      }; });
    },
    collect(root) {
      const custom = $('#stCustom', root).value.trim().toUpperCase();
      const text = custom || chosen?.[0];
      if (!text) { toast('Pick a stamp or type custom text'); return false; }
      return { text, color: $('#stColor', root).value, date: $('#stDate', root).checked };
    },
  });
  if (!r) return;
  const sub = r.data.date ? new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
  const w = Math.max(120, r.data.text.length * 15 + 30);
  beginPlace({ kind: 'stamp', text: r.data.text, sub, color: r.data.color, w, h: sub ? 58 : 44, label: 'stamp' });
}

// ---------------------------------------------------------------- split
export async function splitDialog() {
  const n = S.pages.length;
  const r = await modal({
    title: 'Split document',
    html: `<label class="row"><input type="radio" name="sm" value="every" checked/> Every <input type="number" id="spN" value="1" min="1" max="${n}" style="width:60px"/> page(s)</label>
      <label class="row"><input type="radio" name="sm" value="ranges"/> Custom ranges <input type="text" id="spR" placeholder="e.g. 1-3, 4-6, 7-" style="flex:1"/></label>
      <p class="muted">Each part is saved as a separate PDF in the folder you choose. The open document is unchanged. (${n} pages)</p>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Choose folder & split', value: 'ok', primary: true }],
    collect(root) {
      try {
        const mode = $('input[name=sm]:checked', root).value;
        if (mode === 'every') {
          const k = Math.max(1, parseInt($('#spN', root).value, 10) || 1);
          const groups = [];
          for (let i = 0; i < n; i += k) groups.push(Array.from({ length: Math.min(k, n - i) }, (_, j) => i + j));
          return groups;
        }
        return parseRanges($('#spR', root).value, n);
      } catch (e) { toast(e.message); return false; }
    },
  });
  if (!r) return;
  const folder = await host.pickFolder();
  if (!folder) return;
  try {
    const groups = r.data;
    let first = null;
    for (let g = 0; g < groups.length; g++) {
      busy(`Writing part ${g + 1} of ${groups.length}…`);
      const { bytes } = await buildPdf(S, { pages: groups[g].map((i) => S.pages[i]) });
      const a = groups[g][0] + 1, b = groups[g][groups[g].length - 1] + 1;
      const path = await host.joinPath(folder, `${baseName()}_p${a === b ? a : `${a}-${b}`}.pdf`);
      await host.writeFile(path, bytes);
      first = first || path;
    }
    toast(`Split into ${groups.length} file${groups.length === 1 ? '' : 's'}`, { action: 'Show in Finder', onAction: () => host.reveal(first) });
  } catch (e) { toast(`Split failed: ${e.message}`); } finally { busy(); }
}

// ---------------------------------------------------------------- compress
export async function compressDialog() {
  const before = S.sources.reduce((a, s) => a + s.bytes.length, 0);
  const r = await modal({
    title: 'Compress PDF',
    html: `<p class="muted">Current source size: <b>${fmtSize(before)}</b></p>
      <label class="row"><input type="radio" name="cm" value="lossless" checked/> <b>Optimize</b> — repack the file losslessly (text stays sharp & searchable)</label>
      <label class="row"><input type="radio" name="cm" value="raster"/> <b>Strong</b> — re-render pages as JPEG images</label>
      <div class="row" style="padding-left:24px">Resolution <select id="cmDpi"><option value="72">72 dpi (screen)</option><option value="110" selected>110 dpi (ebook)</option><option value="150">150 dpi (print-ish)</option></select>
        Quality <input type="range" id="cmQ" min="0.3" max="0.9" step="0.05" value="0.6"/></div>
      <p class="muted" style="padding-left:24px">Strong mode removes selectable text; you can run OCR afterwards to restore searchability.</p>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Compress & save as…', value: 'ok', primary: true }],
    collect: (root) => ({ mode: $('input[name=cm]:checked', root).value, dpi: +$('#cmDpi', root).value, q: +$('#cmQ', root).value }),
  });
  if (!r) return;
  const path = await host.saveDialog(`${baseName()}-compressed.pdf`);
  if (!path) return;
  busy('Compressing…');
  try {
    const { bytes } = await buildPdf(S, r.data.mode === 'raster' ? { raster: { dpi: r.data.dpi, quality: r.data.q } } : {});
    const size = await host.writeFile(path, bytes);
    const pct = Math.round((1 - size / before) * 100);
    toast(`${fmtSize(before)} → ${fmtSize(size)} (${pct >= 0 ? `${pct}% smaller` : `${-pct}% larger — this file was already compact`})`, { action: 'Show in Finder', onAction: () => host.reveal(path), ms: 8000 });
  } catch (e) { toast(`Compress failed: ${e.message}`); } finally { busy(); }
}

// ---------------------------------------------------------------- OCR
let ocrWorker = null;
async function getWorker() {
  if (ocrWorker) return ocrWorker;
  const u = (p) => new URL(p, location.href).href;
  ocrWorker = await window.Tesseract.createWorker('eng', 1, {
    workerPath: u('../node_modules/tesseract.js/dist/worker.min.js'),
    corePath: u('../node_modules/tesseract.js-core'),
    langPath: u('../node_modules/@tesseract.js-data/eng/4.0.0_best_int'),
    workerBlobURL: false, gzip: true, cacheMethod: 'none',
  });
  return ocrWorker;
}

export async function ocrDialog() {
  const r = await modal({
    title: 'Recognize text (OCR)',
    html: `<p class="muted">Turns scanned pages into searchable, selectable text. Runs fully offline (English).</p>
      <label class="row"><input type="radio" name="os" value="current" checked/> Current page (${S.current + 1})</label>
      <label class="row"><input type="radio" name="os" value="all"/> All ${S.pages.length} pages</label>
      <label class="row"><input type="checkbox" id="osSkip" checked/> Skip pages that already contain text</label>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Recognize', value: 'ok', primary: true }],
    collect: (root) => ({ all: $('input[name=os]:checked', root).value === 'all', skip: $('#osSkip', root).checked }),
  });
  if (!r) return;
  const targets = r.data.all ? S.pages.slice() : [S.pages[S.current]];
  const snap = structuredClone(S.pages);
  let done = 0, skipped = 0, words = 0;
  try {
    busy('Loading OCR engine…');
    const worker = await getWorker();
    for (let i = 0; i < targets.length; i++) {
      const p = targets[i];
      const pp = pageProxy(p);
      if (r.data.skip) {
        const tc = await pp.getTextContent();
        if (tc.items.some((it) => it.str?.trim())) { skipped++; continue; }
      }
      busy(`Recognizing page ${S.pages.indexOf(p) + 1} (${i + 1}/${targets.length})…`);
      const rot = totalRot(p);
      const { canvas, vp } = await renderToCanvas(pp, 300 / 72, { rotation: rot });
      const { data } = await worker.recognize(canvas);
      const list = data.words || (data.blocks || []).flatMap((b) => b.paragraphs.flatMap((pa) => pa.lines.flatMap((l) => l.words)));
      p.ocr = [];
      for (const w of list) {
        if (!w.text?.trim() || w.confidence < 30) continue;
        const a = vp.convertToPdfPoint(w.bbox.x0, w.bbox.y0), b = vp.convertToPdfPoint(w.bbox.x1, w.bbox.y1);
        p.ocr.push({ text: w.text, x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]), rot });
      }
      words += p.ocr.length;
      done++;
    }
    if (done) pushUndo(snap);
    toast(done ? `Recognized ${words} words on ${done} page${done === 1 ? '' : 's'}. Find (⌘F) works now; save to make it searchable everywhere.`
      : `Nothing to do — ${skipped} page${skipped === 1 ? '' : 's'} already had text.`, { ms: 7000 });
  } catch (e) {
    console.error(e);
    toast(`OCR failed: ${e.message}`, { ms: 8000 });
  } finally { busy(); }
}

// ---------------------------------------------------------------- export
export async function exportImagesDialog() {
  const r = await modal({
    title: 'Export pages as images',
    html: `<div class="row">Format <select id="exF"><option value="png">PNG</option><option value="jpeg">JPEG</option></select>
      Resolution <select id="exD"><option>72</option><option selected>150</option><option>300</option></select> dpi</div>
      <label class="row"><input type="radio" name="er" value="all" checked/> All pages</label>
      <label class="row"><input type="radio" name="er" value="range"/> Pages <input type="text" id="exR" placeholder="e.g. 1-3, 5" /></label>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Choose folder & export', value: 'ok', primary: true }],
    collect(root) {
      try {
        const idx = $('input[name=er]:checked', root).value === 'all' ? S.pages.map((_, i) => i) : parseRanges($('#exR', root).value, S.pages.length).flat();
        return { fmt: $('#exF', root).value, dpi: +$('#exD', root).value, idx };
      } catch (e) { toast(e.message); return false; }
    },
  });
  if (!r) return;
  const folder = await host.pickFolder();
  if (!folder) return;
  busy('Rendering…');
  try {
    const { bytes } = await buildPdf(S, { pages: r.data.idx.map((i) => S.pages[i]), flatten: true });
    const doc = await openBytes(bytes);
    let first = null;
    for (let k = 1; k <= doc.numPages; k++) {
      busy(`Exporting image ${k} of ${doc.numPages}…`);
      const pg = await doc.getPage(k);
      const { canvas } = await renderToCanvas(pg, r.data.dpi / 72, { rotation: pg.rotate });
      const out = await canvasBytes(canvas, `image/${r.data.fmt}`, 0.92);
      const path = await host.joinPath(folder, `${baseName()}_page${r.data.idx[k - 1] + 1}.${r.data.fmt === 'jpeg' ? 'jpg' : 'png'}`);
      await host.writeFile(path, out);
      first = first || path;
    }
    doc.destroy();
    toast(`Exported ${r.data.idx.length} image${r.data.idx.length === 1 ? '' : 's'}`, { action: 'Show in Finder', onAction: () => host.reveal(first) });
  } catch (e) { toast(`Export failed: ${e.message}`); } finally { busy(); }
}

export async function exportText() {
  const path = await host.saveDialog(`${baseName()}.txt`, 'txt');
  if (!path) return;
  busy('Extracting text…');
  try {
    const { bytes } = await buildPdf(S, {});
    const doc = await openBytes(bytes);
    const parts = [];
    for (let k = 1; k <= doc.numPages; k++) {
      const tc = await (await doc.getPage(k)).getTextContent();
      parts.push(`--- Page ${k} ---\n` + tc.items.map((it) => (it.str || '') + (it.hasEOL ? '\n' : '')).join('').trim());
    }
    doc.destroy();
    await host.writeFile(path, new TextEncoder().encode(parts.join('\n\n') + '\n'));
    toast('Text exported', { action: 'Show in Finder', onAction: () => host.reveal(path) });
  } catch (e) { toast(`Export failed: ${e.message}`); } finally { busy(); }
}

// ---------------------------------------------------------------- properties
export async function propertiesDialog() {
  const src = S.sources[0];
  const { info } = await src.pdf.getMetadata().catch(() => ({ info: {} }));
  const m = S.meta || { title: info.Title || '', author: info.Author || '', subject: info.Subject || '', keywords: info.Keywords || '' };
  const ro = [['File', S.fileName], ['Location', S.filePath || '—'], ['Pages', S.pages.length], ['PDF version', info.PDFFormatVersion || '—'],
    ['Created by', info.Creator || '—'], ['Producer', info.Producer || '—'], ['Encrypted', src.encrypted == null ? 'checked on save' : src.encrypted ? 'yes' : 'no']];
  const r = await modal({
    title: 'Document properties', width: 560,
    html: `<table class="props-table">${['title', 'author', 'subject', 'keywords'].map((k) => `<tr><td>${k[0].toUpperCase() + k.slice(1)}</td><td><input type="text" data-k="${k}" value="${esc(m[k])}"/></td></tr>`).join('')}
      ${ro.map(([k, v]) => `<tr><td>${k}</td><td style="user-select:text">${esc(v)}</td></tr>`).join('')}</table>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Apply', value: 'ok', primary: true }],
    collect: (root) => Object.fromEntries($$('input[data-k]', root).map((i) => [i.dataset.k, i.value])),
  });
  if (!r) return;
  S.meta = r.data;
  markDirty();
}

// ---------------------------------------------------------------- redaction
export async function applyRedactionsNow() {
  const targets = S.pages.filter((p) => p.objs.some((o) => o.type === 'redact'));
  if (!targets.length) return toast('No redaction marks yet — use the Redact tool to mark areas first.');
  const ok = await host.confirm('Apply redactions?', `${targets.length} page(s) will be flattened to images with the marked areas permanently blacked out. Text on those pages will no longer be selectable (OCR can restore it). You can still Undo before saving.`, ['Apply', 'Cancel']);
  if (ok !== 0) return;
  const snap = structuredClone(S.pages);
  try {
    for (let i = 0; i < targets.length; i++) {
      busy(`Redacting page ${i + 1} of ${targets.length}…`);
      const p = targets[i];
      const pp = pageProxy(p);
      const { canvas } = await renderToCanvas(pp, 200 / 72, { rotation: 0 });
      const [vx0, vy0, vx1, vy1] = pp.view;
      const k = canvas.width / (vx1 - vx0), ctx = canvas.getContext('2d');
      ctx.fillStyle = '#000';
      for (const o of p.objs.filter((q) => q.type === 'redact')) ctx.fillRect((o.x - vx0) * k, (vy1 - (o.y + o.h)) * k, o.w * k, o.h * k);
      const doc = await PDFDocument.create();
      const img = await doc.embedJpg(await canvasBytes(canvas, 'image/jpeg', 0.9));
      doc.addPage([vx1 - vx0, vy1 - vy0]).drawImage(img, { x: 0, y: 0, width: vx1 - vx0, height: vy1 - vy0 });
      const rot = totalRot(p);
      p.objs = p.objs.filter((q) => q.type !== 'redact');
      p.ocr = null;
      await replacePageSource(p, await doc.save(), { shift: [-vx0, -vy0], rot });
    }
    pushUndo(snap);
    refresh(true);
    toast(`Redactions applied to ${targets.length} page(s). Save to write them to disk.`);
  } catch (e) { toast(`Redaction failed: ${e.message}`); } finally { busy(); }
}

// ---------------------------------------------------------------- licenses
export async function licensesDialog() {
  const text = await fetch('third-party-licenses.txt').then((r) => r.text()).catch(() => 'License file not found.');
  await modal({
    title: 'Open-source licenses', width: 640,
    html: `<p class="muted">Pagewright is MIT-licensed and built on these open-source components.</p><pre style="white-space:pre-wrap;font-size:11px;max-height:55vh;overflow:auto;user-select:text;background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:10px">${esc(text)}</pre>`,
    buttons: [{ label: 'Close', value: null, primary: true }],
  });
}
