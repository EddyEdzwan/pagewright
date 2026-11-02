// Browser/iPhone stand-in for the Electron preload bridge (window.host).
// In the desktop app preload.js defines window.host first and this file does nothing.
(function () {
  if (window.host) return;
  document.documentElement.classList.add('web');

  let commandFn = () => {};

  function pickFiles(accept, multiple) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.multiple = !!multiple;
      input.style.display = 'none';
      document.body.append(input);
      input.addEventListener('change', async () => {
        const files = await Promise.all([...input.files].map(async (f) => ({ name: f.name, path: null, file: f, data: new Uint8Array(await f.arrayBuffer()) })));
        input.remove();
        resolve(files);
      });
      input.addEventListener('cancel', () => { input.remove(); resolve([]); });
      input.click();
    });
  }

  const MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', txt: 'text/plain' };
  const mimeOf = (name) => MIME[(name.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';

  // ---- small self-contained dialog (reuses the app's modal styles)
  function dialog(message, detail, buttons, extraHtml = '') {
    return new Promise((resolve) => {
      const back = document.getElementById('modalBack'), box = document.getElementById('modal');
      const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      box.style.width = '';
      box.innerHTML = `<h2>${esc(message)}</h2>${detail ? `<p class="muted">${esc(detail)}</p>` : ''}${extraHtml}<div class="actions">${buttons.map((b, i) =>
        `<button data-i="${i}" class="${i === 0 ? 'primary' : ''}">${esc(b)}</button>`).join('')}</div>`;
      back.hidden = false;
      box.querySelectorAll('.actions button').forEach((btn) => {
        btn.onclick = () => { back.hidden = true; box.innerHTML = ''; resolve(+btn.dataset.i); };
      });
    });
  }

  // ---- output: batch writes (split/export produce several files), then share or download
  let queue = [], flushTimer = 0;
  async function deliver(files) {
    const canShare = navigator.canShare && navigator.canShare({ files });
    if (canShare) {
      try { await navigator.share({ files }); return; } catch (e) {
        if (e.name === 'AbortError') return; // user closed the share sheet
        // Safari requires a fresh tap before sharing; ask for one below.
      }
      const label = files.length === 1 ? files[0].name : `${files.length} files`;
      const r = await dialog('Your file is ready', `${label} — tap Save to send it to Files, Mail, AirDrop…`, ['Save / Share…', 'Cancel']);
      if (r === 0) { try { await navigator.share({ files }); } catch { /* cancelled */ } }
      return;
    }
    for (const f of files) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(f);
      a.download = f.name;
      document.body.append(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    }
  }
  function enqueue(file) {
    queue.push(file);
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => { const files = queue; queue = []; deliver(files); }, 350);
  }

  let dirty = false;
  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  window.host = {
    web: true,
    pathForFile: () => null,
    ready: async () => [],
    openPdfs: (multi) => pickFiles('application/pdf,.pdf', multi),
    openImage: async () => {
      const [f] = await pickFiles('image/png,image/jpeg,image/*', false);
      if (!f) return null;
      const ext = /png$/i.test(f.file.type) ? 'png' : /jpe?g$/i.test(f.file.type) ? 'jpg' : (f.name.split('.').pop() || 'png').toLowerCase();
      return { name: f.name, data: f.data, ext };
    },
    // No real file system: the "path" is just the file name; writing shares/downloads it.
    saveDialog: async (name) => name,
    pickFolder: async () => '',
    joinPath: async (...parts) => parts.filter(Boolean).join('/').split('/').pop(),
    writeFile: async (name, data) => {
      enqueue(new File([data], name, { type: mimeOf(name) }));
      return data.length ?? data.byteLength;
    },
    reveal: async () => {},
    unicodeFont: async () => null, // no redistributable system font; standard PDF fonts are used
    confirm: (message, detail, buttons) => dialog(message, detail, buttons || ['OK', 'Cancel']),
    setDirty: (d, title) => { dirty = d; if (title) document.title = title; },
    onCommand: (fn) => { commandFn = fn; },
    onOpenFiles: () => {},
  };

  // Desktop-browser shortcuts (the Electron app gets these from its menu bar).
  document.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const k = e.key.toLowerCase();
    const map = { o: 'open', s: e.shiftKey ? 'saveAs' : 'save', p: 'print', f: 'find', z: e.shiftKey ? 'redo' : 'undo', '=': 'zoomIn', '+': 'zoomIn', '-': 'zoomOut', '0': 'zoom100' };
    if (!map[k]) return;
    const typing = document.activeElement?.matches('input, textarea');
    if (typing && (k === 'z' || k === 'f')) return;
    e.preventDefault();
    commandFn(map[k]);
  });

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => navigator.serviceWorker.register('../sw.js', { scope: '../' }).catch((e) => console.warn('offline cache unavailable', e)));
  }
})();
