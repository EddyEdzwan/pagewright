// End-to-end smoke test: `npm run smoke` (set SMOKE_OUT=/some/dir for artifacts).
// Builds fixture PDFs, drives the real renderer through its UI/API, saves, then
// re-reads the saved files with pdf.js and checks the edits actually landed.
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');

const OUT = process.env.SMOKE_OUT || path.join(require('os').tmpdir(), 'pagewright-smoke');

async function makeFixture() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const p1 = doc.addPage([612, 792]);
  p1.drawText('Quarterly Report', { x: 72, y: 700, size: 28, font: bold, color: rgb(0.1, 0.1, 0.3) });
  p1.drawText('The quick brown fox jumps over the lazy dog.', { x: 72, y: 640, size: 14, font });
  p1.drawText('Revenue grew strongly across every region this quarter.', { x: 72, y: 615, size: 14, font });
  p1.drawText('Name:', { x: 72, y: 540, size: 12, font });
  const form = doc.getForm();
  const tf = form.createTextField('applicant.name');
  tf.addToPage(p1, { x: 120, y: 532, width: 220, height: 22 });
  const p2 = doc.addPage([612, 792]);
  p2.drawText('Secret account number 4421-9987', { x: 72, y: 700, size: 16, font });
  p2.drawText('Public paragraph stays here.', { x: 72, y: 660, size: 16, font });
  const p3 = doc.addPage([612, 792]);
  p3.drawText('Third page (will be rotated)', { x: 72, y: 700, size: 18, font });
  p3.setRotation(degrees(0));
  doc.setTitle('Smoke fixture');
  return doc.save();
}

function waitFor(ms) { return new Promise((r) => setTimeout(r, ms)); }

exports.run = (win, app) => {
  const results = [];
  const log = (ok, msg) => { results.push({ ok, msg }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) console.log('[renderer]', message); });

  win.webContents.once('did-finish-load', async () => {
    try {
      fs.mkdirSync(OUT, { recursive: true });
      const fixture = path.join(OUT, 'fixture.pdf');
      fs.writeFileSync(fixture, await makeFixture());
      const js = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
      const shot = async (name) => fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG());

      // ---- open
      const b64 = fs.readFileSync(fixture).toString('base64');
      await js(`const d = Uint8Array.from(atob('${b64}'), c => c.charCodeAt(0));
        await app.openFiles([{ name: 'fixture.pdf', path: ${JSON.stringify(fixture)}, data: d }]);`);
      await waitFor(1500);
      log(await js(`return app.S.pages.length === 3`), 'opens 3-page fixture');
      log(await js(`return document.querySelectorAll('.pg canvas.render').length === 3 && document.querySelector('.pg canvas.render').width > 0`), 'renders pages to canvas');
      log(await js(`return document.querySelectorAll('.pg .textLayer span').length > 3`), 'builds selectable text layer');
      log(await js(`return !!document.querySelector('.annotationLayer input')`), 'renders fillable form field');
      await shot('01-open');

      // ---- fill form
      await js(`const i = document.querySelector('.annotationLayer input'); i.focus(); i.value = 'Ada Lovelace';
        i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); i.blur();`);

      // ---- highlight real text by dragging across it (snaps to characters)
      await js(`app.setTool('highlight');
        const pg = document.querySelector('.pg'); const v = app.views.get(pg.dataset.uid); const b = pg.getBoundingClientRect();
        const at = (x, y) => { const [vx, vy] = v.vp.convertToViewportPoint(x, y); return { bubbles: true, button: 0, clientX: b.left + vx, clientY: b.top + vy }; };
        await new Promise(r => setTimeout(r, 200));
        pg.querySelector('.hit').dispatchEvent(new PointerEvent('pointerdown', at(75, 645)));
        window.dispatchEvent(new PointerEvent('pointermove', at(200, 646)));
        window.dispatchEvent(new PointerEvent('pointerup', at(200, 646)));
        await new Promise(r => setTimeout(r, 50));`);
      log(await js(`const h = app.S.pages[0].objs.find(o => o.type === 'highlight'); return !!h && h.rects.length === 1 && h.rects[0].x > 70 && h.rects[0].w > 60 && h.rects[0].w < 150 && h.rects[0].h < 30`), `highlight snaps to dragged text (${await js('return JSON.stringify(app.S.pages[0].objs.find(o => o.type === "highlight")?.rects)')})`);

      // ---- edit existing text by clicking on it
      await js(`app.setTool('edittext');
        const pg = document.querySelector('.pg'); const v = app.views.get(pg.dataset.uid);
        const [vx, vy] = v.vp.convertToViewportPoint(100, 645); const b = pg.getBoundingClientRect();
        const ev = { bubbles: true, button: 0, clientX: b.left + vx, clientY: b.top + vy };
        pg.querySelector('.hit').dispatchEvent(new PointerEvent('pointerdown', ev));
        window.dispatchEvent(new PointerEvent('pointerup', ev));
        await new Promise(r => setTimeout(r, 300));
        const ta = document.querySelector('.text-editor');
        if (!ta) throw new Error('no editor opened');
        window.__orig = ta.value; window.__caret = ta.selectionStart;
        ta.value = ta.value.replace('brown', 'RED');
        ta.dispatchEvent(new Event('input'));`);
      log(await js(`return window.__caret > 0 && window.__caret < 15 && document.activeElement?.classList.contains('text-editor')`), `edit-text focuses with caret at the tapped character (${await js('return window.__caret')})`);
      log(await js(`return window.__orig === 'The quick brown fox jumps over the lazy dog.'`), `edit-text picked up the original line ("${await js('return window.__orig')}")`);
      await shot('02-editing-text');
      await js(`app.closeEditors(); await new Promise(r => setTimeout(r, 50));`);
      log(await js(`const o = app.S.pages[0].objs; return o.some(x => x.type === 'whiteout') && o.some(x => x.type === 'text' && x.text.includes('RED'))`), 'edit-text replaced line with cover + new text');

      // ---- shapes, ink, text, note, stamp, signature image
      await js(`const p = app.S.pages[0];
        app.addObject(p, { type: 'rect', x: 66, y: 600, w: 420, h: 60, color: '#d32f2f', width: 2, opacity: 1, fillOn: false, fill: '#ffeb3b' }, { selectIt: false });
        app.addObject(p, { type: 'arrow', x1: 400, y1: 450, x2: 480, y2: 520, color: '#1565c0', width: 3, opacity: 1 }, { selectIt: false });
        app.addObject(p, { type: 'ellipse', x: 380, y: 300, w: 120, h: 70, color: '#2e7d32', width: 2, opacity: 1, fillOn: true, fill: '#c8e6c9' }, { selectIt: false });
        app.addObject(p, { type: 'ink', points: [[80,400],[100,420],[120,395],[140,425],[160,400]], color: '#1e40af', width: 2.5, opacity: 1 }, { selectIt: false });
        app.addObject(p, { type: 'text', x: 72, y: 470, text: 'Added note line 1\\nand line 2 ✓', size: 16, font: 'Times', bold: true, italic: false, color: '#6a1b9a', opacity: 1, rot: 0 }, { selectIt: false });
        app.addObject(p, { type: 'note', x: 520, y: 700, text: 'Please double-check these numbers', color: '#fbc02d', author: 'Smoke', date: Date.now() }, { selectIt: false });
        app.addObject(p, { type: 'stamp', x: 380, y: 160, w: 170, h: 58, label: 'APPROVED', sub: 'Oct 19, 2026', color: '#2e7d32', opacity: 1, rot: 0 }, { selectIt: false });
        const c = document.createElement('canvas'); c.width = 300; c.height = 90; const g = c.getContext('2d');
        g.font = '60px "Snell Roundhand", cursive'; g.fillStyle = '#0b2a7a'; g.fillText('A. Lovelace', 10, 65);
        const bytes = new Uint8Array(await (await new Promise(r => c.toBlob(r, 'image/png'))).arrayBuffer());
        const id = app.registerImage(bytes, 'image/png', 300, 90);
        app.addObject(p, { type: 'image', imgId: id, x: 72, y: 120, w: 200, h: 60, opacity: 1, rot: 0 });`);
      log(await js(`return document.querySelectorAll('.pg svg.overlay .obj').length >= 10`), 'overlay draws all markup objects');
      log(await js(`return !!document.querySelector('.sel-handle')`), 'selected image shows resize handles');
      await shot('03-markup');

      // ---- undo / redo
      const before = await js(`return app.S.pages[0].objs.length`);
      await js(`app.run('undo')`);
      const mid = await js(`return app.S.pages[0].objs.length`);
      await js(`app.run('redo')`);
      const after = await js(`return app.S.pages[0].objs.length`);
      log(mid === before - 1 && after === before, `undo/redo (${before} → ${mid} → ${after})`);

      // ---- redaction mark on page 2
      await js(`app.addObject(app.S.pages[1], { type: 'redact', x: 68, y: 693, w: 300, h: 24 }, { selectIt: false });`);

      // ---- organizer: rotate page 3 right, then drag-free reorder via API (move page 3 to second position)
      await js(`app.run('organize'); await new Promise(r => setTimeout(r, 100));
        const items = document.querySelectorAll('.org-item'); items[2].click();
        document.querySelector('[data-org=rotR]').click(); await new Promise(r => setTimeout(r, 50));`);
      await shot('04-organizer');
      await js(`document.querySelector('[data-org=close]').click(); await new Promise(r => setTimeout(r, 300));`);
      log(await js(`return app.S.pages[2].rot === 90`), 'organizer rotates page');

      // ---- find
      await js(`app.run('find'); const i = document.querySelector('#findInput'); i.value = 'region'; i.dispatchEvent(new Event('input')); await new Promise(r => setTimeout(r, 600));`);
      log(await js(`return app.S.find.hits.length === 1 && !!document.querySelector('.find-hit.cur')`), 'find highlights match');
      await js(`document.querySelector('[data-find=close]').click()`);

      // ---- save in place
      await js(`await app.save(false)`);
      await waitFor(300);
      const saved = fs.readFileSync(fixture);
      const check = await js(`const d = Uint8Array.from(atob('${saved.toString('base64')}'), c => c.charCodeAt(0));
        const pdfjs = await import('../node_modules/pdfjs-dist/build/pdf.mjs');
        const doc = await pdfjs.getDocument({ data: d }).promise;
        const text = async (n) => (await (await doc.getPage(n)).getTextContent()).items.map(i => i.str).join(' ');
        const p1 = await doc.getPage(1);
        const annots = await p1.getAnnotations();
        const fields = await doc.getFieldObjects();
        const p3 = await doc.getPage(3);
        return { pages: doc.numPages, t1: await text(1), t2: await text(2), annots: annots.map(a => a.subtype), field: fields?.['applicant.name']?.[0]?.value, rot3: p3.rotate, title: (await doc.getMetadata()).info.Title, dirty: app.S.dirty };`);
      log(check.pages === 3, `saved file has 3 pages`);
      log(check.t1.includes('quick RED fox'), 'saved: edited text present');
      log(check.t1.includes('Added note line 1'), 'saved: added text present');
      log(check.t1.includes('✓'), 'saved: non-Latin character kept via Unicode font fallback');
      log(check.annots.includes('Text'), `saved: sticky note is a real PDF comment (${check.annots.join(',')})`);
      const formVal = (await PDFDocument.load(saved)).getForm().getTextField('applicant.name').getText();
      log(formVal === 'Ada Lovelace', `saved: form value readable by other PDF tools (${formVal})`);
      log(!check.t2.includes('4421'), `saved: redacted text removed from page 2 (text="${check.t2.slice(0, 60)}")`);
      log(check.rot3 === 90, 'saved: page 3 rotation');
      log(check.title === 'Smoke fixture', 'saved: metadata preserved (in-place edit)');
      log(check.dirty === false, 'saved: document marked clean');

      // render the saved file for a visual check
      await js(`const d = Uint8Array.from(atob('${saved.toString('base64')}'), c => c.charCodeAt(0));
        await app.openFiles([{ name: 'saved.pdf', path: null, data: d }]); await new Promise(r => setTimeout(r, 1200));`);
      await shot('05-saved-reopened');

      // ---- merge + extract + split via buildPdf
      const merged = await js(`const d = Uint8Array.from(atob('${b64}'), c => c.charCodeAt(0));
        await app.insertFiles([{ name: 'again.pdf', path: null, data: d }]);
        const { bytes } = await app.buildPdf(app.S, { pages: [app.S.pages[0], app.S.pages[4]] });
        const doc = await (await import('../node_modules/pdfjs-dist/build/pdf.mjs')).getDocument({ data: bytes }).promise;
        return { total: app.S.pages.length, extracted: doc.numPages };`);
      log(merged.total === 6 && merged.extracted === 2, `merge appends pages (${merged.total}) and extract builds subset (${merged.extracted})`);

      // ---- OCR on a scanned (image-only) page
      const ocr = await js(`
        const c = document.createElement('canvas'); c.width = 1700; c.height = 2200; const g = c.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#111'; g.font = '64px Helvetica';
        g.fillText('Invoice number 88231 due November', 150, 300); g.fillText('Scanned documents become searchable', 150, 420);
        const jpg = new Uint8Array(await (await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9))).arrayBuffer());
        const doc = await PDFLib.PDFDocument.create(); const img = await doc.embedJpg(jpg);
        doc.addPage([612, 792]).drawImage(img, { x: 0, y: 0, width: 612, height: 792 });
        app.S.dirty = false;
        await app.openFiles([{ name: 'scan.pdf', path: null, data: await doc.save() }]);
        app.run('ocr'); await new Promise(r => setTimeout(r, 100));
        document.querySelector('#modal .actions .primary').click();
        for (let i = 0; i < 120 && !app.S.pages[0].ocr; i++) await new Promise(r => setTimeout(r, 500));
        await new Promise(r => setTimeout(r, 300));
        const words = (app.S.pages[0].ocr || []).map(w => w.text).join(' ');
        const { bytes } = await app.buildPdf(app.S, {});
        const out = await (await import('../node_modules/pdfjs-dist/build/pdf.mjs')).getDocument({ data: bytes }).promise;
        const t = (await (await out.getPage(1)).getTextContent()).items.map(i => i.str).join(' ');
        return { words, t };`);
      log(/Invoice/i.test(ocr.words) && /searchable/i.test(ocr.words), `OCR recognized: "${ocr.words.slice(0, 70)}"`);
      log(/88231/.test(ocr.t), 'OCR text embedded in saved PDF');

      // ---- compress (raster) path
      const comp = await js(`const { bytes } = await app.buildPdf(app.S, { raster: { dpi: 72, quality: 0.5 } }); return bytes.length;`);
      log(comp > 1000, `raster compress produced ${comp} bytes`);
    } catch (e) {
      log(false, `exception: ${e.stack || e}`);
    }
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed. Artifacts in ${OUT}`);
    app.exit(failed ? 1 : 0);
  });
};
