/* Strandline PT — office desktop app.
 *
 * Loads the same page the iOS build and the artifact use, then grants it the
 * things only a desktop can do: open a PDF off disk, render and read the
 * schedule, save files, and hold an API key in the OS keychain.
 *
 * Security posture is deliberate. The renderer is the app's own HTML, but it
 * runs with context isolation on and node integration off, and reaches the
 * outside world only through the narrow surface in preload.js. Nothing in the
 * page can read an arbitrary file or spawn anything.
 */

const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..', '..');            // repo root
const PAGE = path.join(ROOT, 'Strandline.html');
const SETTINGS = path.join(app.getPath('userData'), 'settings.json');

let win = null;

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch (e) { return {}; }
}
function writeSettings(s) {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2));
}

/* The API key is encrypted with the OS keychain where that is available, so it
   is not sitting in a readable file in the user profile. */
function saveApiKey(plain) {
  const s = readSettings();
  if (!plain) { delete s.apiKey; delete s.apiKeyPlain; writeSettings(s); return { stored: 'cleared' }; }
  if (safeStorage.isEncryptionAvailable()) {
    s.apiKey = safeStorage.encryptString(plain).toString('base64');
    delete s.apiKeyPlain;
    writeSettings(s);
    return { stored: 'keychain' };
  }
  // Better to be explicit than to pretend: the caller is told it is not encrypted.
  s.apiKeyPlain = plain;
  delete s.apiKey;
  writeSettings(s);
  return { stored: 'plaintext' };
}
function loadApiKey() {
  const s = readSettings();
  if (s.apiKey) {
    try { return safeStorage.decryptString(Buffer.from(s.apiKey, 'base64')); } catch (e) { return null; }
  }
  return s.apiKeyPlain || null;
}


/* The page is one file with inline script and style, so 'unsafe-inline' is
   unavoidable without splitting it. Everything else is closed: no remote
   script, no eval, and no network from the renderer at all - the desktop build
   talks to the sync server through IPC, where https is enforced in one place. */
const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'"
].join('; ');

function applyCsp() {
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    const headers = Object.assign({}, details.responseHeaders);
    headers['Content-Security-Policy'] = [CSP];
    cb({ responseHeaders: headers });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 940, minWidth: 900, minHeight: 600,
    backgroundColor: '#0B192C',
    title: 'Strandline PT',
    icon: path.join(ROOT, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false            // preload needs require; the renderer still cannot
    }
  });
  win.setMenuBarVisibility(false);
  if (!fs.existsSync(PAGE)) {
    win.loadURL('data:text/html,' + encodeURIComponent(
      '<body style="font:14px system-ui;padding:40px;background:#0B192C;color:#E9EEF4">' +
      '<h2>Strandline.html has not been built yet</h2>' +
      '<p>Run <code>build-standalone.ps1</code> in the project root, then reopen.</p></body>'));
  } else {
    win.loadFile(PAGE);
  }
  // External links open in the real browser, never inside the app shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

/* STRANDLINE_SMOKE=1 loads the window, checks that the page and the bridge
   came up, prints the result and exits. Lets the desktop build be verified
   without a human looking at a window. */
async function smokeTest() {
  const checks = await win.webContents.executeJavaScript(`(() => ({
    title: document.title,
    bridge: !!(window.strandline && window.strandline.platform === 'desktop'),
    isDesktopFn: typeof isDesktop === 'function' && isDesktop(),
    officeCardVisible: (() => { const e = document.getElementById('officeCard'); return !!e && e.style.display !== 'none'; })(),
    homeVisible: document.getElementById('s-home').classList.contains('on'),
    fontsLoaded: document.fonts ? document.fonts.size : 0,
    pdfBuilder: typeof buildPdf === 'function',
    extractor: typeof extractPdfText === 'function',
    syncClient: typeof syncPush === 'function',
    readerHook: typeof officeReadPlans === 'function',
    theme: getComputedStyle(document.body).backgroundColor,
    errors: (window.__errs || [])
  }))()`);
  const ok = checks.bridge && checks.pdfBuilder && checks.readerHook;
  // Electron on Windows does not reliably deliver main-process stdout to a
  // pipe, so the result goes to a file the caller can read.
  const out = process.env.STRANDLINE_SMOKE_OUT;
  if (out) { try { fs.writeFileSync(out, JSON.stringify({ ok, checks }, null, 2)); } catch (e) {} }
  console.log(JSON.stringify(checks, null, 2));
  app.exit(ok ? 0 : 1);
}

// Trace file for the smoke run, so a stall can be located rather than guessed at.
function smokeTrace(stage, extra) {
  const out = process.env.STRANDLINE_SMOKE_OUT;
  if (!out) return;
  try {
    fs.appendFileSync(out + '.log',
      new Date().toISOString() + '  ' + stage + (extra ? '  ' + JSON.stringify(extra) : '') + '\n');
  } catch (e) {}
}

app.whenReady().then(() => {
  smokeTrace('app ready');
  applyCsp();
  createWindow();
  smokeTrace('window created', { page: PAGE, exists: fs.existsSync(PAGE) });
  if (process.env.STRANDLINE_DIAG) {
    const { runDiag } = require("./diag.cjs");
    const outFile = process.env.STRANDLINE_DIAG_OUT || "diag.json";
    /* A dead or shouting renderer is otherwise invisible here: executeJavaScript
       just never resolves, and the run looks like it stopped for no reason. */
    const note = (what, d) => {
      try {
        fs.appendFileSync(outFile + '.log',
          new Date().toISOString() + '  ' + what + (d ? '  ' + JSON.stringify(d) : '') + '\n');
      } catch (e) {}
    };
    win.webContents.on('render-process-gone', (e, d) => note('render-process-gone', d));
    win.webContents.on('unresponsive', () => note('renderer unresponsive'));
    win.webContents.on('console-message', (e, level, msg) => {
      if (level >= 2) note('page error', { msg: String(msg).slice(0, 300) });
    });
    win.webContents.once("did-finish-load", () => setTimeout(async () => {
      await runDiag(win, process.env.STRANDLINE_DIAG, outFile);
      note('finished');
      app.exit(0);
    }, 1500));
    setTimeout(() => { note('hard timeout - killed mid-run'); app.exit(1); }, 600000);
  }
  if (process.env.STRANDLINE_SMOKE) {
    const wc = win.webContents;
    wc.on('console-message', (e, level, msg) => { if (level >= 2) smokeTrace('page console', { level, msg: String(msg).slice(0, 300) }); });
    wc.on('did-fail-load', (e, code, desc, url) => { smokeTrace('did-fail-load', { code, desc, url }); });
    wc.on('render-process-gone', (e, d) => { smokeTrace('render-process-gone', d); });
    wc.on('dom-ready', () => smokeTrace('dom-ready'));
    wc.once('did-finish-load', () => { smokeTrace('did-finish-load'); setTimeout(smokeTest, 1500); });
    setTimeout(() => {
      smokeTrace('TIMED OUT');
      const out = process.env.STRANDLINE_SMOKE_OUT;
      if (out) { try { fs.writeFileSync(out, JSON.stringify({ ok: false, error: 'timed out before the page finished loading' }, null, 2)); } catch (e) {} }
      app.exit(1);
    }, 30000);
  }
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

/* ---------------- IPC ---------------- */

ipcMain.handle('pick-pdf', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose the PT plan set',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    properties: ['openFile']
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('save-file', async (e, { suggestedName, data, filters }) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: suggestedName, filters: filters || [] });
  if (r.canceled || !r.filePath) return null;
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  fs.writeFileSync(r.filePath, buf);
  return r.filePath;
});

ipcMain.handle('reveal', async (e, p) => { if (p) shell.showItemInFolder(p); });

ipcMain.handle('settings-get', async () => {
  const s = readSettings();
  return {
    hasApiKey: !!loadApiKey(),
    keyStorage: s.apiKey ? 'keychain' : (s.apiKeyPlain ? 'plaintext' : 'none'),
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    locateModel: s.locateModel || '',
    readModel: s.readModel || ''
  };
});

ipcMain.handle('settings-set-key', async (e, key) => saveApiKey(key));

ipcMain.handle('settings-set-models', async (e, { locateModel, readModel }) => {
  const s = readSettings();
  s.locateModel = locateModel || '';
  s.readModel = readModel || '';
  writeSettings(s);
  return true;
});

/* Reads the schedule. Progress is streamed back so the window is not a frozen
   rectangle for the minute or two a big set takes. */
ipcMain.handle('read-plans', async (e, { pdfPath, pages, job, name }) => {
  const key = loadApiKey();
  if (!key) return { error: 'No API key saved. Add one in Office settings.' };
  if (!pdfPath || !fs.existsSync(pdfPath)) return { error: 'That file could not be found.' };

  const s = readSettings();
  const send = (msg) => { try { win && win.webContents.send('read-progress', msg); } catch (err) {} };

  try {
    const { runReader } = await import(pathToFileURL(path.join(__dirname, '..', 'reader-core.mjs')).href);
    const bundle = await runReader({
      pdfPath, pages, job, name,
      apiKey: key,
      locateModel: s.locateModel || undefined,
      readModel: s.readModel || undefined,
      onProgress: send
    });
    return { bundle };
  } catch (err) {
    return { error: err && err.message ? err.message : String(err) };
  }
});

/* The sync push is done from the main process so the token never has to sit in
   the page, and so a plain-http address can be refused in one place. */
ipcMain.handle('sync-request', async (e, { url, token, path: p, method, body }) => {
  const base = String(url || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(base)) {
    return { error: 'The server address must start with https. Over plain http the token and every job record travel in the clear.' };
  }
  try {
    const res = await fetch(base + p, {
      method: method || 'GET',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (err) {}
    return { status: res.status, ok: res.ok, body: json, raw: json ? undefined : text.slice(0, 400) };
  } catch (err) {
    return { error: err.message };
  }
});

/* ---------------- assisted entry: local, no API ---------------- */

/* Scans a plan set for ruled tables and returns thumbnails of the candidates.
   Rendering and detection are both local; nothing leaves the machine. */
ipcMain.handle('scan-plans', async (e, { pdfPath }) => {
  if (!pdfPath || !fs.existsSync(pdfPath)) return { error: 'That file could not be found.' };
  const send = (msg) => { try { win && win.webContents.send('scan-progress', msg); } catch (err) {} };
  try {
    const r = await import(pathToFileURL(path.join(__dirname, '..', 'render.mjs')).href);
    const d = await import(pathToFileURL(path.join(__dirname, '..', 'table-detect.mjs')).href);
    const sharp = require(path.join(__dirname, '..', 'node_modules', 'sharp'));
    const doc = await r.openPdf(pdfPath);
    send({ phase: 'start', pages: doc.numPages });
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      send({ phase: 'page', page: p, of: doc.numPages });
      /* Rendered at the scale detection was tuned and verified at. A lower
         scale scans faster but lost the Prado Lofts schedule entirely - thin
         rules do not survive the extra downscale - and a candidate the
         operator never sees is worse than a slower scan. */
      const { png } = await r.renderPage(doc, p, 2.0);
      const det = await d.detectTables(png);
      const meta = await sharp(png).metadata();
      const cands = [];
      for (const t of det.tables.slice(0, 4)) {
        const thumb = await sharp(png).extract({
          left: Math.max(0, Math.round(meta.width * t.box.x)),
          top: Math.max(0, Math.round(meta.height * t.box.y)),
          width: Math.max(8, Math.round(meta.width * t.box.w)),
          height: Math.max(8, Math.round(meta.height * t.box.h))
        }).resize(300, 300, { fit: 'inside' }).jpeg({ quality: 78 }).toBuffer();
        cands.push({ box: t.box, cols: t.cols, ink: t.ink,
                     thumb: 'data:image/jpeg;base64,' + thumb.toString('base64') });
      }
      pages.push({ page: p, candidates: cands });
    }
    send({ phase: 'done' });
    return { pages };
  } catch (err) {
    return { error: (err && err.message) || String(err) };
  }
});

/* A high-resolution crop of the chosen region, for reading off the screen. */
ipcMain.handle('crop-region', async (e, { pdfPath, page, box }) => {
  if (!pdfPath || !fs.existsSync(pdfPath)) return { error: 'That file could not be found.' };
  try {
    const r = await import(pathToFileURL(path.join(__dirname, '..', 'render.mjs')).href);
    const sharp = require(path.join(__dirname, '..', 'node_modules', 'sharp'));
    const doc = await r.openPdf(pdfPath);
    const { png } = await r.renderPage(doc, page, 4.0);
    const meta = await sharp(png).metadata();
    const pad = 0.006;
    const x = Math.max(0, box.x - pad), y = Math.max(0, box.y - pad);
    const w = Math.min(1 - x, box.w + pad * 2), h = Math.min(1 - y, box.h + pad * 2);
    const jpeg = await sharp(png).extract({
      left: Math.round(meta.width * x), top: Math.round(meta.height * y),
      width: Math.max(8, Math.round(meta.width * w)), height: Math.max(8, Math.round(meta.height * h))
    }).resize(1400, null, { fit: 'inside', kernel: 'lanczos3', withoutEnlargement: false })
      .jpeg({ quality: 92 }).toBuffer();
    return { image: 'data:image/jpeg;base64,' + jpeg.toString('base64') };
  } catch (err) {
    return { error: (err && err.message) || String(err) };
  }
});

/* Cuts the chosen table into one image per row, so the operator reads a
   magnified strip instead of a dense table. Local: render, segment, crop. */
ipcMain.handle('segment-table', async (e, { pdfPath, page, box }) => {
  if (!pdfPath || !fs.existsSync(pdfPath)) return { error: 'That file could not be found.' };
  try {
    const r = await import(pathToFileURL(path.join(__dirname, '..', 'render.mjs')).href);
    const seg = await import(pathToFileURL(path.join(__dirname, '..', 'cell-segment.mjs')).href);
    const sharp = require(path.join(__dirname, '..', 'node_modules', 'sharp'));

    const doc = await r.openPdf(pdfPath);
    const { png } = await r.renderPage(doc, page, 4.0);
    const meta = await sharp(png).metadata();
    const pad = 0.004;
    const bx = Math.max(0, box.x - pad), by = Math.max(0, box.y - pad);
    const bw = Math.min(1 - bx, box.w + pad * 2), bh = Math.min(1 - by, box.h + pad * 2);
    const crop = await sharp(png).extract({
      left: Math.round(meta.width * bx), top: Math.round(meta.height * by),
      width: Math.max(8, Math.round(meta.width * bw)), height: Math.max(8, Math.round(meta.height * bh))
    }).greyscale().png().toBuffer();

    const grey = await seg.loadGrey(crop);
    const { cols } = seg.findColumns(grey);
    if (cols.length < 2) return { error: 'No column rules found in that region.' };
    const classes = seg.classifyColumns(grey, cols);
    // Rows are projected from the columns that are not chained hexagons.
    const numeric = classes.filter(c => !c.chained).map(c => c.index);
    const rows = seg.findRows(grey, cols, numeric.length ? numeric : cols.map((_, i) => i));
    const dataRows = rows.filter(r => !r.isRule);
    if (!dataRows.length) return { error: 'No rows could be separated in that region.' };

    /* Heading rows are told apart by how many column separators cross them.
       A data row is crossed by all of them; the header by fewer, because the
       columns only start below the title; the title by fewer still, being a
       merged cell. Testing for zero crossings was too strict - the title here
       is still clipped by one rule that runs high - so the count is calibrated
       against the most common value instead, which is by definition a data
       row since they are the overwhelming majority.

       Flagged, not dropped. It is a suggestion the operator reverses simply
       by typing in the row, and guessing wrong about which bands hold data
       would be worse than the one click it saves. */
    const internal = cols.slice(1, -1).map(c => c.x0);
    const crossings = (band) => internal.filter(x => {
      let ink = 0;
      for (let y = band.y0; y < band.y1; y++) if (grey.data[y * grey.W + x] < 150) ink++;
      return ink > (band.y1 - band.y0) * 0.6;
    }).length;
    const counts = dataRows.map(crossings);
    const tally = new Map();
    counts.forEach(n => tally.set(n, (tally.get(n) || 0) + 1));
    let typical = 0, best = -1;
    for (const [n, c] of tally) if (c > best || (c === best && n > typical)) { best = c; typical = n; }

    const strips = [];
    for (const band of dataRows) {
      const vpad = Math.round((band.y1 - band.y0) * 0.35);
      const b = seg.clampExtract({
        left: 0, top: band.y0 - vpad,
        width: grey.W, height: (band.y1 - band.y0) + vpad * 2
      }, grey.W, grey.H);
      const jpeg = await sharp(crop).extract(b)
        .resize({ width: 1280, fit: 'inside', kernel: 'lanczos3', withoutEnlargement: false })
        .jpeg({ quality: 90 }).toBuffer();
      strips.push({
        image: 'data:image/jpeg;base64,' + jpeg.toString('base64'),
        likelyHeader: crossings(band) < typical,
        /* Where this band actually sits on the sheet, as page fractions. The
           text-layer pull uses it to put each value on the row it is printed
           on, instead of trusting that two independent counts agree. */
        y0: by + band.y0 / meta.height,
        y1: by + band.y1 / meta.height
      });
    }

    // A small overview of the whole table, for context above the strip.
    const overview = await sharp(crop)
      .resize({ width: 460, fit: 'inside', kernel: 'lanczos3' })
      .jpeg({ quality: 82 }).toBuffer();

    return {
      strips,
      overview: 'data:image/jpeg;base64,' + overview.toString('base64'),
      columns: cols.length,
      headerRows: rows.length - dataRows.length
    };
  } catch (err) {
    return { error: (err && err.message) || String(err) };
  }
});


/* Reads one chosen table and hands back its rows, for pre-filling the
   row-by-row grid. Only transcription: the expansion into tendons still
   happens in tested code, and the operator still confirms every row against
   the strip beside it.

   This uses the API rather than local OCR because local OCR was measured on
   this same table and is not fit for it - 5 of 18 elongations exact, 8
   confidently wrong, with 5 read as 3 so lengths come back plausible and
   incorrect. A wrong length passes the quantity cross-check silently. */
/* The columns the sheet exported as line-work. No key, no network, no OCR -
   the strokes are exact geometry, so identical characters are identical
   shapes. Nothing is named here except what the sheet proves about itself;
   the rest goes back to the operator to name once. */
/* The clusters from the table most recently read, so the operator's names can
   be attached to shapes when they save. Ids only mean something within one
   reading, which is why the shapes themselves are what gets stored. */
let lastVectorClusters = null;

function hammingB64(b64, bytes) {
  const a = Buffer.from(b64, 'base64');
  if (a.length !== bytes.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== bytes[i]) d++;
  return d;
}

ipcMain.handle('read-table-vector', async (e, { pdfPath, page, box, rowBands, names }) => {
  if (!pdfPath || !fs.existsSync(pdfPath)) return { error: 'That file could not be found.' };
  try {
    const r = await import(pathToFileURL(path.join(__dirname, '..', 'render.mjs')).href);
    const vt = await import(pathToFileURL(path.join(__dirname, '..', 'vector-text.mjs')).href);
    const tt = await import(pathToFileURL(path.join(__dirname, '..', 'table-text.mjs')).href);
    const ex = await import(pathToFileURL(path.join(__dirname, '..', 'expand.mjs')).href);
    const doc = await r.openPdf(pdfPath);

    /* Bands come from the strips the operator is stepping through; without
       them the stacked halves of a fraction each look like a row. */
    let bands = Array.isArray(rowBands) && rowBands.length ? rowBands : null;
    const txt = await tt.readTableText(doc, page, box);
    const textRows = txt.rows.filter(x => x.bundle).sort((a, b) => a.y - b.y);
    if (!bands && textRows.length > 1) {
      const ys = textRows.map(x => x.y);
      const pitch = (ys[ys.length - 1] - ys[0]) / (ys.length - 1);
      bands = ys.map(y => ({ y0: y - pitch * 0.62, y1: y + pitch * 0.42 }));
    }

    const V = await vt.readVectorTable(doc, page, box, { rowBands: bands, tol: 14 });
    if (!V.rows.length) return { rows: [], clusters: [], learned: {}, conflicts: [] };

    /* Line up the text rows with the bands so the counts land on the right
       rows even when the two disagree about how many there are. */
    const bundleFor = V.rows.map(row => {
      const hit = textRows.find(t => t.y >= row.y0 && t.y <= row.y1);
      return hit ? hit.bundle : null;
    });
    const learn = vt.learnFromCounts(V, bundleFor, b => {
      const p = b ? ex.parseBundle(b) : null;
      return p && p.count ? p.count : null;
    });

    /* Shapes named on an earlier sheet are recognised again here. A detailer's
       lettering does not change between sheets, so the second schedule from
       the same office asks for nothing. Matching is on the shape itself, since
       cluster numbering is particular to one table. */
    lastVectorClusters = V.clusters.map(c => ({ id: c.id, bitmap: c.bitmap, ar: c.ar }));
    const saved = readSettings().alphabet || [];
    const remembered = {};
    for (const c of V.clusters) {
      const hit = saved.find(s => Math.abs(s.ar - c.ar) <= 0.22 &&
        hammingB64(s.bitmap, c.bitmap) <= 6);
      if (hit) remembered[c.id] = hit.name;
    }

    const known = Object.assign({}, remembered, learn.names, names || {});
    return {
      rows: V.rows.map(row => ({
        y0: row.y0, y1: row.y1,
        cells: row.cells.filter(c => c.seq && c.seq.length).map(c => ({
          col: c.col,
          seq: c.seq.map(i => i.solidus ? { solidus: true, part: 'solidus' }
                                        : { cluster: i.cluster, part: i.part })
        }))
      })),
      clusters: V.clusters.map(c => Object.assign(
        { id: c.id, count: c.members.length }, vt.clusterOutline(c))),
      learned: learn.names,
      evidence: learn.evidence,
      conflicts: learn.conflicts,
      remembered,
      known,
      characters: V.glyphCount
    };
  } catch (err) {
    return { error: (err && err.message) || String(err) };
  }
});

/* Remember the shapes the operator named, so the next sheet from the same
   detailer needs none of it again. Only what they actually typed is kept -
   the labels the sheet proved for itself are re-derived every time and do not
   need storing. */
ipcMain.handle('save-alphabet', async (e, { names }) => {
  if (!lastVectorClusters || !names) return { saved: 0 };
  const s = readSettings();
  const alphabet = s.alphabet || [];
  let saved = 0;
  for (const [id, name] of Object.entries(names)) {
    if (!name) continue;
    const c = lastVectorClusters.find(c => String(c.id) === String(id));
    if (!c) continue;
    const b64 = Buffer.from(c.bitmap).toString('base64');
    const at = alphabet.findIndex(x => Math.abs(x.ar - c.ar) <= 0.22 && hammingB64(x.bitmap, c.bitmap) <= 6);
    if (at >= 0) alphabet[at] = { bitmap: b64, ar: c.ar, name };
    else alphabet.push({ bitmap: b64, ar: c.ar, name });
    saved++;
  }
  s.alphabet = alphabet;
  writeSettings(s);
  return { saved, total: alphabet.length };
});

ipcMain.handle('forget-alphabet', async () => {
  const s = readSettings();
  delete s.alphabet;
  writeSettings(s);
  return { cleared: true };
});

/* The free half of the pull: whatever the sheet carries as live text.
   No key, no network, no OCR. Columns that were exploded to line art come
   back empty rather than guessed. */
ipcMain.handle('read-table-text', async (e, { pdfPath, page, box }) => {
  if (!pdfPath || !fs.existsSync(pdfPath)) return { error: 'That file could not be found.' };
  try {
    const r = await import(pathToFileURL(path.join(__dirname, '..', 'render.mjs')).href);
    const tt = await import(pathToFileURL(path.join(__dirname, '..', 'table-text.mjs')).href);
    const doc = await r.openPdf(pdfPath);
    return await tt.readTableText(doc, page, box);
  } catch (err) {
    return { error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('read-table', async (e, { pdfPath, page, box }) => {
  const key = loadApiKey();
  if (!key) return { error: 'no-key' };
  if (!pdfPath || !fs.existsSync(pdfPath)) return { error: 'That file could not be found.' };
  try {
    const r = await import(pathToFileURL(path.join(__dirname, '..', 'render.mjs')).href);
    const core = await import(pathToFileURL(path.join(__dirname, '..', 'reader-core.mjs')).href);
    const s = readSettings();
    const doc = await r.openPdf(pdfPath);
    const { png } = await r.renderPage(doc, page, 4.0);
    const crop = await r.cropRegion(png, box);
    const res = await core.readTableImage(crop, {
      apiKey: key,
      model: s.readModel || undefined
    });
    return res;
  } catch (err) {
    return { error: (err && err.message) || String(err) };
  }
});
