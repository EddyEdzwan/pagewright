// Page objects (markup the user adds) live in PDF user space: origin bottom-left,
// y up, units = points. The viewer draws them inside an SVG group transformed by the
// pdf.js viewport matrix, and the save pipeline draws the same numbers with pdf-lib,
// so what you see is what gets written.

export const FONT_CSS = {
  Helvetica: 'Helvetica, Arial, sans-serif',
  Times: '"Times New Roman", Times, serif',
  Courier: '"Courier New", Courier, monospace',
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const n = (v) => Math.round(v * 1000) / 1000;

let uidCounter = 0;
export const newId = (p = 'o') => `${p}${Date.now().toString(36)}${(uidCounter++).toString(36)}`;

/** Point (lx,ly) in a frame anchored at (x0,y0) and rotated `rot` degrees CCW → user space. */
export function toUser(x0, y0, rot, lx, ly) {
  const a = (rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [x0 + lx * c - ly * s, y0 + lx * s + ly * c];
}
export function toLocal(x0, y0, rot, ux, uy) {
  const a = (-rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const dx = ux - x0, dy = uy - y0;
  return [dx * c - dy * s, dx * s + dy * c];
}

/** For a box-shaped object (user bbox x,y,w,h) whose content is rotated `rot` (multiple of 90),
 *  return the rotation origin and content width/height as pdf-lib's drawImage expects. */
export function boxFrame(o) {
  const r = ((o.rot || 0) % 360 + 360) % 360;
  const swap = r === 90 || r === 270;
  const vw = swap ? o.h : o.w, vh = swap ? o.w : o.h;
  const corner = { 0: [o.x, o.y], 90: [o.x + o.w, o.y], 180: [o.x + o.w, o.y + o.h], 270: [o.x, o.y + o.h] }[r] || [o.x, o.y];
  return { x0: corner[0], y0: corner[1], rot: r, vw, vh };
}

// Text measurement for hit boxes (canvas metrics are close enough to the PDF standard fonts).
const measureCtx = document.createElement('canvas').getContext('2d');
export function textWidth(line, o) {
  measureCtx.font = `${o.italic ? 'italic ' : ''}${o.bold ? 'bold ' : ''}${o.size}px ${FONT_CSS[o.font] || FONT_CSS.Helvetica}`;
  return measureCtx.measureText(line).width;
}
export function textLocalBox(o) {
  const lines = String(o.text).split('\n');
  const w = Math.max(4, ...lines.map((l) => textWidth(l, o)));
  return [0, -(lines.length - 1) * o.size * 1.2 - 0.25 * o.size, w, 0.9 * o.size];
}

/** Bounding frame of an object: {x0,y0,rot, box:[lx1,ly1,lx2,ly2]} in a local frame. */
export function frameOf(o) {
  switch (o.type) {
    case 'text': return { x0: o.x, y0: o.y, rot: o.rot || 0, box: textLocalBox(o) };
    case 'line': case 'arrow': {
      const pad = Math.max(2, o.width);
      return { x0: 0, y0: 0, rot: 0, box: [Math.min(o.x1, o.x2) - pad, Math.min(o.y1, o.y2) - pad, Math.max(o.x1, o.x2) + pad, Math.max(o.y1, o.y2) + pad] };
    }
    case 'ink': {
      const xs = o.points.map((p) => p[0]), ys = o.points.map((p) => p[1]), pad = o.width;
      return { x0: 0, y0: 0, rot: 0, box: [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad] };
    }
    case 'highlight': case 'underline': case 'strike': {
      const r = o.rects;
      return { x0: 0, y0: 0, rot: 0, box: [Math.min(...r.map((q) => q.x)), Math.min(...r.map((q) => q.y)), Math.max(...r.map((q) => q.x + q.w)), Math.max(...r.map((q) => q.y + q.h))] };
    }
    case 'note': return { x0: 0, y0: 0, rot: 0, box: [o.x, o.y - 20, o.x + 20, o.y] };
    default: return { x0: 0, y0: 0, rot: 0, box: [o.x, o.y, o.x + o.w, o.y + o.h] };
  }
}

export function framePolygon(f) {
  const [a, b, c, d] = f.box;
  return [[a, b], [c, b], [c, d], [a, d]].map(([lx, ly]) => toUser(f.x0, f.y0, f.rot, lx, ly));
}

export function hitTest(o, ux, uy, tol) {
  const f = frameOf(o);
  const [lx, ly] = toLocal(f.x0, f.y0, f.rot, ux, uy);
  const [a, b, c, d] = f.box;
  return lx >= a - tol && lx <= c + tol && ly >= b - tol && ly <= d + tol;
}

export const RESIZABLE = new Set(['rect', 'ellipse', 'whiteout', 'redact', 'image', 'stamp']);

export function translate(o, dx, dy) {
  switch (o.type) {
    case 'line': case 'arrow': o.x1 += dx; o.y1 += dy; o.x2 += dx; o.y2 += dy; break;
    case 'ink': o.points = o.points.map(([x, y]) => [x + dx, y + dy]); break;
    case 'highlight': case 'underline': case 'strike': o.rects = o.rects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy })); break;
    default: o.x += dx; o.y += dy;
  }
}

/** Resize a box object so corner `ci` (0..3 of framePolygon order) lands on (ux,uy). */
export function resizeCorner(o, ci, ux, uy, start) {
  const xs = [start.x, start.x + start.w], ys = [start.y, start.y + start.h];
  const fixedX = ci === 0 || ci === 3 ? xs[1] : xs[0];
  const fixedY = ci === 0 || ci === 1 ? ys[1] : ys[0];
  let w = Math.abs(ux - fixedX), h = Math.abs(uy - fixedY);
  if (o.type === 'image' && start.w && start.h) { // keep aspect ratio
    const k = Math.max(w / start.w, h / start.h); w = start.w * k; h = start.h * k;
  }
  o.w = Math.max(4, w); o.h = Math.max(4, h);
  o.x = ux < fixedX ? fixedX - o.w : fixedX;
  o.y = uy < fixedY ? fixedY - o.h : fixedY;
}

/** Largest label size that fits a stamp box; `unitWidth(text)` = width at font size 1. */
export function stampFontSize(label, vw, vh, unitWidth) {
  return Math.min(vh * 0.55, (vw * 0.84) / Math.max(0.1, unitWidth(label) * 1.06));
}

export function arrowHead(o) {
  const ang = Math.atan2(o.y2 - o.y1, o.x2 - o.x1), len = Math.max(8, o.width * 4), spread = Math.PI / 7;
  return [ang + Math.PI - spread, ang + Math.PI + spread].map((a) => [o.x2 + len * Math.cos(a), o.y2 + len * Math.sin(a)]);
}

/** SVG markup for one object, in user-space coordinates. `scale` = CSS px per point (for hit widths). */
export function objSvg(o, images, scale) {
  const id = `data-id="${o.id}"`;
  const op = o.opacity ?? 1;
  const fat = n(Math.max(10 / scale, (o.width || 1) + 4 / scale));
  const hitStroke = (d) => `<path d="${d}" fill="none" stroke="transparent" stroke-width="${fat}" stroke-linecap="round"/>`;
  switch (o.type) {
    case 'rect':
    case 'whiteout':
    case 'redact': {
      const cls = o.type === 'redact' ? 'class="redact-mark"' : '';
      const fill = o.type === 'whiteout' ? (o.fill || '#ffffff') : o.type === 'redact' ? '' : (o.fillOn ? o.fill : 'none');
      const stroke = o.type === 'rect' ? `stroke="${o.color}" stroke-width="${o.width}"` : '';
      const fillAttr = fill ? `fill="${fill}"` : '';
      return `<g class="obj" ${id} opacity="${op}"><rect ${cls} x="${n(o.x)}" y="${n(o.y)}" width="${n(o.w)}" height="${n(o.h)}" ${fillAttr} ${stroke}/>${o.type === 'rect' && !o.fillOn ? hitStroke(`M${o.x} ${o.y}h${o.w}v${o.h}h${-o.w}z`) : ''}</g>`;
    }
    case 'ellipse':
      return `<g class="obj" ${id} opacity="${op}"><ellipse cx="${n(o.x + o.w / 2)}" cy="${n(o.y + o.h / 2)}" rx="${n(o.w / 2)}" ry="${n(o.h / 2)}" fill="${o.fillOn ? o.fill : 'none'}" stroke="${o.color}" stroke-width="${o.width}"/>${!o.fillOn ? `<ellipse cx="${n(o.x + o.w / 2)}" cy="${n(o.y + o.h / 2)}" rx="${n(o.w / 2)}" ry="${n(o.h / 2)}" fill="none" stroke="transparent" stroke-width="${fat}"/>` : ''}</g>`;
    case 'line':
    case 'arrow': {
      let d = `M${n(o.x1)} ${n(o.y1)}L${n(o.x2)} ${n(o.y2)}`;
      if (o.type === 'arrow') { const [a, b] = arrowHead(o); d += `M${n(a[0])} ${n(a[1])}L${n(o.x2)} ${n(o.y2)}L${n(b[0])} ${n(b[1])}`; }
      return `<g class="obj" ${id} opacity="${op}"><path d="${d}" fill="none" stroke="${o.color}" stroke-width="${o.width}" stroke-linecap="round" stroke-linejoin="round"/>${hitStroke(d)}</g>`;
    }
    case 'ink': {
      const d = 'M' + o.points.map((p) => `${n(p[0])} ${n(p[1])}`).join('L');
      return `<g class="obj" ${id} opacity="${op}"><path d="${d}" fill="none" stroke="${o.color}" stroke-width="${o.width}" stroke-linecap="round" stroke-linejoin="round"/>${hitStroke(d)}</g>`;
    }
    case 'highlight':
      return `<g class="obj" ${id} style="mix-blend-mode:multiply">${o.rects.map((r) => `<rect x="${n(r.x)}" y="${n(r.y)}" width="${n(r.w)}" height="${n(r.h)}" fill="${o.color}" opacity="${o.opacity ?? 0.4}"/>`).join('')}</g>`;
    case 'underline':
    case 'strike':
      return `<g class="obj" ${id}>${o.rects.map((r) => {
        const y = o.type === 'underline' ? r.y + r.h * 0.12 : r.y + r.h * 0.45;
        const t = Math.max(0.8, r.h * 0.07);
        return `<rect x="${n(r.x)}" y="${n(r.y)}" width="${n(r.w)}" height="${n(r.h)}" fill="transparent"/><path d="M${n(r.x)} ${n(y)}h${n(r.w)}" stroke="${o.color}" stroke-width="${n(t)}"/>`;
      }).join('')}</g>`;
    case 'text': {
      const lines = String(o.text).split('\n');
      const box = textLocalBox(o);
      return `<g class="obj" ${id} opacity="${op}" transform="translate(${n(o.x)} ${n(o.y)}) rotate(${o.rot || 0}) scale(1 -1)">`
        + `<rect x="0" y="${n(-box[3])}" width="${n(box[2])}" height="${n(box[3] - box[1])}" fill="transparent"/>`
        + `<text xml:space="preserve" font-family='${FONT_CSS[o.font] || FONT_CSS.Helvetica}' font-size="${o.size}" fill="${o.color}" font-weight="${o.bold ? 700 : 400}" font-style="${o.italic ? 'italic' : 'normal'}">`
        + lines.map((l, i) => `<tspan x="0" y="${n(i * o.size * 1.2)}">${esc(l) || ' '}</tspan>`).join('')
        + `</text></g>`;
    }
    case 'image': {
      const img = images.get(o.imgId);
      const f = boxFrame(o);
      return `<g class="obj" ${id} opacity="${op}" transform="translate(${n(f.x0)} ${n(f.y0)}) rotate(${f.rot}) translate(0 ${n(f.vh)}) scale(1 -1)">`
        + `<image href="${img ? img.url : ''}" width="${n(f.vw)}" height="${n(f.vh)}" preserveAspectRatio="none"/></g>`;
    }
    case 'stamp': {
      const f = boxFrame(o);
      const fs = stampFontSize(o.label, f.vw, f.vh, (t) => textWidth(t, { size: 1, bold: true, font: 'Helvetica' }));
      const sub = o.sub ? `<text x="${n(f.vw / 2)}" y="${n(f.vh * 0.86)}" text-anchor="middle" font-family="Helvetica, Arial" font-weight="700" font-size="${n(f.vh * 0.16)}" fill="${o.color}">${esc(o.sub)}</text>` : '';
      const ty = o.sub ? f.vh * 0.58 : f.vh / 2 + fs * 0.36;
      return `<g class="obj" ${id} opacity="${op}" transform="translate(${n(f.x0)} ${n(f.y0)}) rotate(${f.rot}) translate(0 ${n(f.vh)}) scale(1 -1)">`
        + `<rect x="1.5" y="1.5" width="${n(f.vw - 3)}" height="${n(f.vh - 3)}" rx="${n(f.vh * 0.12)}" fill="${o.color}" fill-opacity="0.06" stroke="${o.color}" stroke-width="3"/>`
        + `<text x="${n(f.vw / 2)}" y="${n(ty)}" text-anchor="middle" font-family="Helvetica, Arial" font-weight="800" letter-spacing="1" font-size="${n(fs)}" fill="${o.color}">${esc(o.label)}</text>${sub}</g>`;
    }
    case 'note':
      return `<g class="obj note" ${id} transform="translate(${n(o.x)} ${n(o.y)}) scale(1 -1)">`
        + `<path d="M1 1h18v13h-9l-5 4v-4H1z" fill="${o.color || '#fbc02d'}" stroke="#7a5d00" stroke-width="0.8"/>`
        + `<path d="M5 5h10M5 9h7" stroke="#7a5d00" stroke-width="1"/></g>`;
    default: return '';
  }
}
