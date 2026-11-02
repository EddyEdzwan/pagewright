// Pagewright — Electron main process.
// Serves the renderer over a privileged app:// scheme (so ES modules and
// module workers load cleanly), and owns every filesystem/dialog operation.
const { app, BrowserWindow, protocol, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const SMOKE = process.argv.includes('--smoke');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.gz': 'application/gzip',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream', '.ttf': 'font/ttf', '.map': 'application/json',
};

function serveApp(request) {
  const url = new URL(request.url);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/src/index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) return new Response('forbidden', { status: 403 });
  try {
    const data = fs.readFileSync(file);
    return new Response(data, { headers: { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' } });
  } catch {
    return new Response('not found', { status: 404 });
  }
}

let win = null;
let pendingOpen = []; // files requested before the renderer was ready
let rendererReady = false;
let docDirty = false;

function readPdfFile(p) {
  return { path: p, name: path.basename(p), data: new Uint8Array(fs.readFileSync(p)) };
}

function openPaths(paths) {
  const pdfs = paths.filter((p) => /\.pdf$/i.test(p) && fs.existsSync(p));
  if (!pdfs.length) return;
  if (!win || !rendererReady) { pendingOpen.push(...pdfs); return; }
  win.webContents.send('open-files', pdfs.map(readPdfFile));
}

function send(cmd, arg) { if (win) win.webContents.send('cmd', cmd, arg); }

function buildMenu() {
  const item = (label, cmd, accelerator) => ({ label, accelerator, click: () => send(cmd) });
  const template = [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        item('Open…', 'open', 'CmdOrCtrl+O'),
        item('Combine Files…', 'combine', 'CmdOrCtrl+Shift+O'),
        { type: 'separator' },
        item('Save', 'save', 'CmdOrCtrl+S'),
        item('Save As…', 'saveAs', 'CmdOrCtrl+Shift+S'),
        { type: 'separator' },
        item('Export Pages as Images…', 'exportImages'),
        item('Export Text…', 'exportText'),
        item('Split Document…', 'split'),
        item('Compress…', 'compress'),
        { type: 'separator' },
        item('Print…', 'print', 'CmdOrCtrl+P'),
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        item('Undo', 'undo', 'CmdOrCtrl+Z'),
        item('Redo', 'redo', 'CmdOrCtrl+Shift+Z'),
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        item('Find…', 'find', 'CmdOrCtrl+F'),
      ],
    },
    {
      label: 'View',
      submenu: [
        item('Zoom In', 'zoomIn', 'CmdOrCtrl+='),
        item('Zoom Out', 'zoomOut', 'CmdOrCtrl+-'),
        item('Actual Size', 'zoom100', 'CmdOrCtrl+0'),
        item('Fit Width', 'fitWidth', 'CmdOrCtrl+1'),
        { type: 'separator' },
        item('Toggle Sidebar', 'toggleSidebar', 'CmdOrCtrl+Shift+B'),
        item('Organize Pages', 'organize', 'CmdOrCtrl+Shift+G'),
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Tools',
      submenu: [
        item('Recognize Text (OCR)…', 'ocr'),
        item('Flatten Form Fields on Save', 'toggleFlatten'),
        item('Apply Redactions Now', 'applyRedactions'),
      ],
    },
    { role: 'windowMenu' },
    { role: 'help', submenu: [item('Open-source Licenses', 'licenses')] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 920, minWidth: 900, minHeight: 600,
    title: 'Pagewright',
    titleBarStyle: 'hiddenInset',
    show: !SMOKE,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('close', (e) => {
    if (!docDirty || SMOKE) return;
    const r = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['Discard Changes', 'Cancel'], defaultId: 1, cancelId: 1,
      message: 'You have unsaved changes.', detail: 'Close the window and lose them?',
    });
    if (r === 1) e.preventDefault();
  });
  win.on('closed', () => { win = null; rendererReady = false; });
  win.loadURL('app://local/src/index.html');
  // Packaged builds don't ship test/, so the smoke script can be pointed at from outside.
  if (SMOKE) require(process.env.PAGEWRIGHT_SMOKE || './test/smoke').run(win, app);
}

// ---------- IPC ----------
ipcMain.handle('renderer-ready', () => {
  rendererReady = true;
  const files = pendingOpen.splice(0);
  return files.map(readPdfFile);
});
ipcMain.on('set-dirty', (_e, dirty, title) => {
  docDirty = dirty;
  if (win) { win.setDocumentEdited(dirty); if (title) win.setTitle(title); }
});
ipcMain.handle('open-pdfs', async (_e, multi) => {
  const r = await dialog.showOpenDialog(win, {
    properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (r.canceled) return [];
  r.filePaths.forEach((p) => app.addRecentDocument(p));
  return r.filePaths.map(readPdfFile);
});
ipcMain.handle('open-images', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
  });
  if (r.canceled) return null;
  const p = r.filePaths[0];
  return { name: path.basename(p), data: new Uint8Array(fs.readFileSync(p)), ext: path.extname(p).slice(1).toLowerCase() };
});
ipcMain.handle('save-dialog', async (_e, defaultName, ext = 'pdf') => {
  const r = await dialog.showSaveDialog(win, {
    defaultPath: defaultName, filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  return r.canceled ? null : r.filePath;
});
ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('write-file', (_e, p, data) => { fs.writeFileSync(p, Buffer.from(data)); return fs.statSync(p).size; });
// A system font with wide Unicode coverage, for text the 14 standard PDF fonts can't encode.
const UNICODE_FONTS = ['/System/Library/Fonts/Supplemental/Arial Unicode.ttf', '/Library/Fonts/Arial Unicode.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf'];
ipcMain.handle('unicode-font', () => {
  const p = UNICODE_FONTS.find((f) => fs.existsSync(f));
  return p ? new Uint8Array(fs.readFileSync(p)) : null;
});
ipcMain.handle('join-path', (_e, ...parts) => path.join(...parts));
ipcMain.handle('reveal', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('confirm', (_e, message, detail, buttons) =>
  dialog.showMessageBox(win, { type: 'question', message, detail, buttons: buttons || ['OK', 'Cancel'], defaultId: 0, cancelId: (buttons || [0, 1]).length - 1 })
    .then((r) => r.response));

// ---------- lifecycle ----------
app.on('open-file', (e, p) => { e.preventDefault(); openPaths([p]); });
app.whenReady().then(() => {
  protocol.handle('app', serveApp);
  buildMenu();
  openPaths(process.argv.slice(SMOKE ? 99 : 1).filter((a) => !a.startsWith('-')));
  createWindow();
  app.on('activate', () => { if (!win) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin' || SMOKE) app.quit(); });
