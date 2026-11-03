// Turning the in-memory document (sources + page list + markup) into PDF bytes.
import * as pdfjsLib from '../node_modules/pdfjs-dist/build/pdf.mjs';
import { boxFrame, toUser, arrowHead, stampFontSize } from './objects.js';

const { PDFDocument, StandardFonts, rgb, degrees, PDFName, PDFHexString, LineCapStyle, BlendMode } = window.PDFLib;

const abs = (p) => new URL(p, location.href).href;
export const DOC_OPTS = {
  cMapUrl: abs('../node_modules/pdfjs-dist/cmaps/'),
  cMapPacked: true,
  standardFontDataUrl: abs('../node_modules/pdfjs-dist/standard_fonts/'),
  isEvalSupported: false,
};

export function hexToRgb(hex) {
  const h = (hex || '#000000').replace('#', '');
  const v = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return rgb(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255);
}

const FONT_MAP = {
  Helvetica: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'],
  Times: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'],
  Courier: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique'],
};

/** Render one source page to a canvas. rotation=null → the page's own /Rotate. */
export async function renderToCanvas(pdfPage, scale, { rotation = 0, forms = true } = {}) {
  const vp = pdfPage.getViewport({ scale, rotation });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(vp.width));
  canvas.height = Math.max(1, Math.round(vp.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await pdfPage.render({
    canvasContext: ctx, viewport: vp,
    annotationMode: forms ? pdfjsLib.AnnotationMode.ENABLE_STORAGE : pdfjsLib.AnnotationMode.ENABLE,
  }).promise;
  return { canvas, vp };
}

export const canvasBytes = (canvas, type = 'image/jpeg', q = 0.85) =>
  new Promise((res) => canvas.toBlob((b) => b.arrayBuffer().then((a) => res(new Uint8Array(a))), type, q));

async function isEncrypted(bytes) {
  try { return (await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })).isEncrypted; }
  catch { return true; }
}

/**
 * Build output bytes.
 * opts.pages       subset/ordering of S.pages to write (default all)
 * opts.flatten     flatten AcroForm fields
 * opts.raster      {dpi, quality} → every page becomes a JPEG (used by Compress)
 * Returns {bytes, notes[]} — notes describe lossy fallbacks taken.
 */
export async function buildPdf(S, opts = {}) {
  const pages = opts.pages || S.pages;
  const notes = [];
  const used = [...new Set(pages.map((p) => p.src))];

  // Source bytes, including any form values typed into pdf.js widgets.
  const srcBytes = new Map(), encrypted = new Map();
  for (const si of used) {
    const s = S.sources[si];
    let b = s.bytes;
    if (s.pdf.annotationStorage.size > 0) {
      try { b = await s.pdf.saveDocument(); } catch (e) { notes.push(`Form values in ${s.name} could not be saved: ${e.message}`); }
    }
    srcBytes.set(si, b);
    encrypted.set(si, s.encrypted ?? (s.encrypted = await isEncrypted(s.bytes)));
  }

  const rasterize = (p) => opts.raster || encrypted.get(p.src) || p.objs.some((o) => o.type === 'redact');

  // Edit the first source in place when possible so bookmarks, metadata and forms survive.
  const baseSrc = pages.find((p) => !rasterize(p))?.src;
  const canInPlace = baseSrc === 0 && !opts.raster;
  const out = canInPlace ? await PDFDocument.load(srcBytes.get(0), { ignoreEncryption: true, updateMetadata: false }) : await PDFDocument.create();
  const basePages = canInPlace ? out.getPages() : [];
  for (let i = out.getPageCount() - 1; i >= 0; i--) out.removePage(i);

  const libDocs = new Map();
  const libDoc = async (si) => {
    if (!libDocs.has(si)) libDocs.set(si, await PDFDocument.load(srcBytes.get(si), { ignoreEncryption: true, updateMetadata: false }));
    return libDocs.get(si);
  };
  const fonts = new Map();
  const font = async (name) => {
    if (!fonts.has(name)) {
      if (name === 'unicode') {
        out.registerFontkit(window.fontkit);
        unicodeFontBytes = unicodeFontBytes || await host.unicodeFont();
        fonts.set(name, unicodeFontBytes ? await out.embedFont(unicodeFontBytes, { subset: true }) : await out.embedFont(StandardFonts.Helvetica));
      } else fonts.set(name, await out.embedFont(StandardFonts[name]));
    }
    return fonts.get(name);
  };
  const imgCache = new Map();
  const embedImage = async (imgId) => {
    if (!imgCache.has(imgId)) {
      const im = S.images.get(imgId);
      imgCache.set(imgId, im.mime === 'image/jpeg' ? await out.embedJpg(im.bytes) : await out.embedPng(im.bytes));
    }
    return imgCache.get(imgId);
  };

  const usedBase = new Set();
  let rasterCount = 0;
  for (const p of pages) {
    const pdfPage = await S.sources[p.src].pdf.getPage(p.idx + 1);
    const totalRot = (pdfPage.rotate + p.rot) % 360;
    let page, offset = [0, 0];

    if (rasterize(p)) {
      // Rasterize in unrotated user space, then re-apply rotation. Text under redactions is gone for good.
      const dpi = opts.raster?.dpi || 200;
      const { canvas } = await renderToCanvas(pdfPage, dpi / 72, { rotation: 0 });
      const [vx0, vy0, vx1, vy1] = pdfPage.view;
      const ctx = canvas.getContext('2d'), k = canvas.width / (vx1 - vx0);
      ctx.fillStyle = '#000';
      for (const o of p.objs.filter((q) => q.type === 'redact')) {
        ctx.fillRect((o.x - vx0) * k, (vy1 - (o.y + o.h)) * k, o.w * k, o.h * k);
      }
      const jpg = await out.embedJpg(await canvasBytes(canvas, 'image/jpeg', opts.raster?.quality ?? 0.9));
      page = out.addPage([vx1 - vx0, vy1 - vy0]);
      page.drawImage(jpg, { x: 0, y: 0, width: vx1 - vx0, height: vy1 - vy0 });
      offset = [-vx0, -vy0];
      rasterCount++;
    } else if (canInPlace && p.src === 0 && !usedBase.has(p.idx)) {
      page = basePages[p.idx];
      out.addPage(page);
      usedBase.add(p.idx);
    } else {
      const [cp] = await out.copyPages(await libDoc(p.src), [p.idx]);
      page = out.addPage(cp);
    }
    page.setRotation(degrees(totalRot));
    await drawObjects(page, p, offset, { font, embedImage, out, S });
  }
  if (encrypted.size && [...encrypted.values()].some(Boolean)) notes.push('Encrypted pages were saved as images (run OCR to make them searchable again).');
  if (rasterCount && pages.some((p) => p.objs.some((o) => o.type === 'redact'))) notes.push('Redacted pages were flattened to images so the hidden content is really removed.');

  if (opts.flatten && canInPlace) {
    try { const form = out.getForm(); form.updateFieldAppearances(); form.flatten(); }
    catch (e) { notes.push(`Could not flatten some form fields: ${e.message}`); }
  }
  if (S.meta) {
    const m = S.meta;
    if (m.title != null) out.setTitle(m.title);
    if (m.author != null) out.setAuthor(m.author);
    if (m.subject != null) out.setSubject(m.subject);
    if (m.keywords != null) out.setKeywords(m.keywords.split(',').map((s) => s.trim()).filter(Boolean));
  }
  out.setProducer('Pagewright');
  out.setModificationDate(new Date());
  const bytes = await out.save({ useObjectStreams: true });
  return { bytes, notes };
}

let unicodeFontBytes = null;
const needsUnicode = async (f, s) => [...s].some((ch) => ch !== '\n' && !(f.__charset || (f.__charset = new Set(f.getCharacterSet()))).has(ch.codePointAt(0)));

function safeText(f, s) {
  const set = f.__charset || (f.__charset = new Set(f.getCharacterSet()));
  return [...s].map((ch) => (ch === '\n' || set.has(ch.codePointAt(0)) ? ch : '?')).join('');
}

async function drawObjects(page, p, [ox, oy], { font, embedImage, out, S }) {
  const sh = (x, y) => [x + ox, y + oy];
  for (const o of p.objs) {
    const opacity = o.opacity ?? 1;
    switch (o.type) {
      case 'rect': {
        const [x, y] = sh(o.x, o.y);
        page.drawRectangle({ x, y, width: o.w, height: o.h, borderColor: hexToRgb(o.color), borderWidth: o.width,
          color: o.fillOn ? hexToRgb(o.fill) : undefined, opacity, borderOpacity: opacity });
        break;
      }
      case 'whiteout': case 'redact': {
        const [x, y] = sh(o.x, o.y);
        page.drawRectangle({ x, y, width: o.w, height: o.h, color: o.type === 'redact' ? rgb(0, 0, 0) : hexToRgb(o.fill || '#ffffff') });
        break;
      }
      case 'ellipse': {
        const [x, y] = sh(o.x + o.w / 2, o.y + o.h / 2);
        page.drawEllipse({ x, y, xScale: o.w / 2, yScale: o.h / 2, borderColor: hexToRgb(o.color), borderWidth: o.width,
          color: o.fillOn ? hexToRgb(o.fill) : undefined, opacity, borderOpacity: opacity });
        break;
      }
      case 'line': case 'arrow': {
        const style = { thickness: o.width, color: hexToRgb(o.color), opacity, lineCap: LineCapStyle.Round };
        const [x1, y1] = sh(o.x1, o.y1), [x2, y2] = sh(o.x2, o.y2);
        page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, ...style });
        if (o.type === 'arrow') for (const [hx, hy] of arrowHead(o)) {
          const [ax, ay] = sh(hx, hy);
          page.drawLine({ start: { x: ax, y: ay }, end: { x: x2, y: y2 }, ...style });
        }
        break;
      }
      case 'ink': {
        // drawSvgPath flips y, so feed it negated y with origin 0.
        const d = 'M' + o.points.map(([x, y]) => { const [a, b] = sh(x, y); return `${a} ${-b}`; }).join(' L');
        page.drawSvgPath(d, { x: 0, y: 0, borderColor: hexToRgb(o.color), borderWidth: o.width, borderOpacity: opacity, borderLineCap: LineCapStyle.Round });
        break;
      }
      case 'highlight':
        for (const r of o.rects) {
          const [x, y] = sh(r.x, r.y);
          page.drawRectangle({ x, y, width: r.w, height: r.h, color: hexToRgb(o.color), opacity: o.opacity ?? 0.4, blendMode: BlendMode.Multiply });
        }
        break;
      case 'underline': case 'strike':
        for (const r of o.rects) {
          const yy = o.type === 'underline' ? r.y + r.h * 0.12 : r.y + r.h * 0.45;
          const [x, y] = sh(r.x, yy);
          page.drawLine({ start: { x, y }, end: { x: x + r.w, y }, thickness: Math.max(0.8, r.h * 0.07), color: hexToRgb(o.color) });
        }
        break;
      case 'text': {
        const variant = (o.bold ? 1 : 0) + (o.italic ? 2 : 0);
        let f = await font((FONT_MAP[o.font] || FONT_MAP.Helvetica)[variant]);
        if (await needsUnicode(f, o.text)) f = await font('unicode');
        const [x, y] = sh(o.x, o.y);
        page.drawText(safeText(f, o.text), { x, y, size: o.size, font: f, color: hexToRgb(o.color), opacity,
          rotate: degrees(o.rot || 0), lineHeight: o.size * 1.2 });
        break;
      }
      case 'image': {
        const img = await embedImage(o.imgId);
        const fr = boxFrame(o);
        const [x, y] = sh(fr.x0, fr.y0);
        page.drawImage(img, { x, y, width: fr.vw, height: fr.vh, rotate: degrees(fr.rot), opacity });
        break;
      }
      case 'stamp': {
        const fr = boxFrame(o);
        let f = await font('HelveticaBold');
        if (await needsUnicode(f, o.label + (o.sub || ''))) f = await font('unicode');
        const col = hexToRgb(o.color);
        const at = (lx, ly) => { const [ux, uy] = toUser(fr.x0, fr.y0, fr.rot, lx, ly); return sh(ux, uy); };
        const [rx, ry] = at(1.5, 1.5);
        page.drawRectangle({ x: rx, y: ry, width: fr.vw - 3, height: fr.vh - 3, rotate: degrees(fr.rot), borderColor: col, borderWidth: 3, color: col, opacity: 0.06 * opacity, borderOpacity: opacity });
        const label = safeText(f, o.label);
        const fs = stampFontSize(label, fr.vw, fr.vh, (t) => f.widthOfTextAtSize(t, 1));
        const lw = f.widthOfTextAtSize(label, fs);
        const ly = o.sub ? fr.vh - fr.vh * 0.58 : fr.vh / 2 - fs * 0.36;
        const [tx, ty] = at((fr.vw - lw) / 2, ly);
        page.drawText(label, { x: tx, y: ty, size: fs, font: f, color: col, opacity, rotate: degrees(fr.rot) });
        if (o.sub) {
          const ss = fr.vh * 0.16, sub = safeText(f, o.sub), sw = f.widthOfTextAtSize(sub, ss);
          const [sx, sy] = at((fr.vw - sw) / 2, fr.vh - fr.vh * 0.86);
          page.drawText(sub, { x: sx, y: sy, size: ss, font: f, color: col, opacity, rotate: degrees(fr.rot) });
        }
        break;
      }
      case 'note': {
        const [x, y] = sh(o.x, o.y);
        const c = hexToRgb(o.color || '#fbc02d');
        const annot = out.context.obj({
          Type: 'Annot', Subtype: 'Text', Rect: [x, y - 20, x + 20, y], Name: 'Comment', F: 4, Open: false,
          Contents: PDFHexString.fromText(o.text || ''), T: PDFHexString.fromText(o.author || 'Pagewright'),
          C: [c.red, c.green, c.blue], M: PDFHexString.fromText(new Date(o.date || Date.now()).toISOString()),
        });
        page.node.addAnnot(out.context.register(annot));
        break;
      }
    }
  }
  // Invisible OCR text so scanned pages become searchable/selectable.
  if (p.ocr?.length) {
    const f = await font('Helvetica');
    for (const w of p.ocr) {
      const t = safeText(f, w.text);
      const unit = f.widthOfTextAtSize(t, 1);
      if (!unit) continue;
      const fr = boxFrame({ x: w.x, y: w.y, w: w.w, h: w.h, rot: w.rot || 0 });
      const size = Math.max(1, Math.min(fr.vw / unit, fr.vh * 1.2));
      const [lx, ly] = toUser(fr.x0, fr.y0, fr.rot, 0, fr.vh * 0.2);
      const [x, y] = sh(lx, ly);
      page.drawText(t, { x, y, size, font: f, opacity: 0, rotate: degrees(fr.rot) });
    }
  }
}

/** Load bytes into pdf.js (for print/export of the built result). */
export async function openBytes(bytes) {
  return pdfjsLib.getDocument({ ...DOC_OPTS, data: bytes.slice() }).promise;
}
