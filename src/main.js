/* HexTV for Windows.

   The app shows the live HexTV site in its own window, starting at the movie library — the
   website's home page and the admin dashboard are skipped. Because the site is loaded live,
   every website update reaches the app without reinstalling.

   What the app adds over a browser:
     - hextv://room?… links open that room here (and only one HexTV window ever runs)
     - MovieBox videos play straight from their CDN: the app sends the Referer/Origin the CDN
       wants, which a browser page can't, so viewers don't use the Vercel relay's bandwidth
     - remembers the window's size and position; dark title bar; no menu bar */
const { app, BrowserWindow, session, shell, ipcMain, nativeTheme, Menu, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const SITE = 'https://streamtogether-pi.vercel.app';
const START = SITE + '/library.html';
const PROTOCOL = 'hextv';
const BG = '#050507';

app.setAppUserModelId('com.godhex.watchparty');
if (!app.requestSingleInstanceLock()) { app.quit(); return; }

// hextv:// links start this app (in development, through electron.exe + this folder)
if (process.defaultApp) app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
else app.setAsDefaultProtocolClient(PROTOCOL);

// hextv://room?room=…&mb=… → the room page; anything else → the library
function siteUrlFor(link) {
  try {
    const u = new URL(link);
    const page = (u.hostname || u.pathname.replace(/^\/+/, '')).replace(/\/+$/, '').toLowerCase();
    if (page === 'room' && u.searchParams.get('room')) return SITE + '/room.html' + u.search;
  } catch { /* malformed link */ }
  return START;
}
const linkFromArgs = argv => argv.find(a => typeof a === 'string' && a.toLowerCase().startsWith(PROTOCOL + '://'));

/* ── window size and position, remembered between runs ── */
const stateFile = () => path.join(app.getPath('userData'), 'window.json');
function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    // Ignore a position that's no longer on any screen (e.g. a monitor was unplugged)
    const onScreen = screen.getAllDisplays().some(d => {
      const a = d.workArea;
      return s.x < a.x + a.width - 100 && s.x + s.width > a.x + 100 && s.y >= a.y - 20 && s.y < a.y + a.height - 100;
    });
    return onScreen ? s : { width: s.width, height: s.height, maximized: s.maximized };
  } catch { return { width: 1280, height: 800 }; }
}
function saveWindowState(win) {
  try {
    const b = win.getNormalBounds();
    fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch { /* not important */ }
}

/* ── direct video playback ──
   The page asks (through the preload) to play a CDN URL with given headers; requests to that host
   then carry them. Only HexTV's own pages can ask, and only Referer/Origin/User-Agent are allowed. */
const mediaHeaders = new Map();   // host -> { Referer, Origin, User-Agent }
const ALLOWED_HEADERS = { referer: 'Referer', origin: 'Origin', 'user-agent': 'User-Agent' };
function allowMedia(frame, url, headers) {
  if (!frame || !frame.url.startsWith(SITE + '/')) return false;
  const u = new URL(url);
  if (u.protocol !== 'https:' || !headers || typeof headers !== 'object') return false;
  const h = {};
  for (const [k, v] of Object.entries(headers)) {
    const name = ALLOWED_HEADERS[String(k).toLowerCase()];
    if (name && typeof v === 'string' && v.length < 300) h[name] = v;
  }
  if (!Object.keys(h).length) return false;
  mediaHeaders.set(u.host, h);
  return true;
}
// Setting returnValue answers the page at once, so it's set exactly once
ipcMain.on('hx:allow-media', (e, url, headers) => {
  let ok = false;
  try { ok = allowMedia(e.senderFrame, url, headers); } catch { /* the page uses the relay */ }
  e.returnValue = ok;
});
ipcMain.on('hx:version', e => { e.returnValue = app.getVersion(); });

function setUpSession() {
  const ses = session.defaultSession;
  // The app has no home page or dashboard: those addresses open the library instead
  ses.webRequest.onBeforeRequest({ urls: [SITE + '/', SITE + '/?*', SITE + '/index.html*', SITE + '/dashboard.html*', SITE + '/app', SITE + '/app/*'] }, (d, cb) => {
    if (d.resourceType === 'mainFrame') cb({ redirectURL: START });
    else cb({});
  });
  ses.webRequest.onBeforeSendHeaders({ urls: ['https://*/*'] }, (d, cb) => {
    let host = '';
    try { host = new URL(d.url).host; } catch { /* keep going */ }
    const extra = mediaHeaders.get(host);
    if (!extra) return cb({ requestHeaders: d.requestHeaders });
    const headers = { ...d.requestHeaders };
    for (const k of Object.keys(headers)) if (ALLOWED_HEADERS[k.toLowerCase()]) delete headers[k];
    cb({ requestHeaders: { ...headers, ...extra } });
  });
  // Fullscreen and copying the invite link are all the site needs
  const allowed = new Set(['fullscreen', 'clipboard-sanitized-write', 'clipboard-read']);
  ses.setPermissionRequestHandler((wc, perm, cb, details) => cb(allowed.has(perm) && (details.requestingUrl || '').startsWith(SITE)));
  ses.setPermissionCheckHandler((wc, perm, origin) => allowed.has(perm) && (origin || '').startsWith(SITE));
}

/* ── the window ── */
let win = null;
let pendingUrl = null;

function createWindow(firstUrl) {
  const s = loadWindowState();
  win = new BrowserWindow({
    x: s.x, y: s.y, width: s.width || 1280, height: s.height || 800, minWidth: 380, minHeight: 560,
    backgroundColor: BG, title: 'HexTV', show: false, autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      autoplayPolicy: 'no-user-gesture-required', spellcheck: false
    }
  });
  if (s.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  for (const ev of ['resize', 'move', 'close']) win.on(ev, () => saveWindowState(win));

  const wc = win.webContents;
  // Stay on HexTV; other links open in the normal browser
  const isSite = url => url.startsWith(SITE + '/') || url === SITE;
  const isLocal = url => url.startsWith('file:');
  wc.setWindowOpenHandler(({ url }) => {
    if (isSite(url)) wc.loadURL(url);
    else if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (isSite(url) || isLocal(url)) return;
    e.preventDefault();
    if (url.toLowerCase().startsWith(PROTOCOL + '://')) wc.loadURL(siteUrlFor(url));
    else if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
  // Small app-only touches on the site's pages
  wc.on('dom-ready', () => {
    if (!isSite(wc.getURL())) return;
    wc.insertCSS(`.top-links a[href="index.html"] { display: none !important; }
      a.create-room.hx-create { width: auto !important; padding: 0 14px 0 12px; gap: 7px; display: inline-flex !important; align-items: center;
        border-radius: 999px; color: #fff !important; font-weight: 600; font-size: 13px; text-decoration: none;
        background: linear-gradient(135deg, #ff2d3a 0%, #e50914 45%, #b20710 100%); border-color: transparent !important;
        box-shadow: 0 6px 18px -8px rgba(229,9,20,.8); }`);
  });
  // No connection: a friendly screen with a retry button instead of a browser error
  wc.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || !isSite(url)) return;   // -3: navigation replaced by another
    win.loadFile(path.join(__dirname, 'offline.html'), { query: { u: url } });
  });
  // Keyboard and mouse: F11 fullscreen, Ctrl+R reload, Alt+← / mouse back button to go back
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const k = input.key;
    if (k === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    else if ((input.control && k.toLowerCase() === 'r') || k === 'F5') { wc.reload(); e.preventDefault(); }
    else if (input.alt && k === 'ArrowLeft' && wc.navigationHistory.canGoBack()) { wc.navigationHistory.goBack(); e.preventDefault(); }
    else if (!app.isPackaged && input.control && input.shift && k.toLowerCase() === 'i') { wc.toggleDevTools(); e.preventDefault(); }
  });
  win.on('app-command', (e, cmd) => {
    if (cmd === 'browser-backward' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    if (cmd === 'browser-forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  });

  // A splash with the logo while the site loads, then the page itself
  win.loadFile(path.join(__dirname, 'splash.html')).then(() => wc.loadURL(firstUrl));
  win.on('closed', () => { win = null; });
}

function openLink(link) {
  const url = siteUrlFor(link);
  if (!win) { pendingUrl = url; return; }
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
  win.webContents.loadURL(url);
}

// A second launch (e.g. clicking a hextv:// link) hands its link to the running window
app.on('second-instance', (e, argv) => {
  const link = linkFromArgs(argv);
  if (link) openLink(link);
  else if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  Menu.setApplicationMenu(null);
  setUpSession();
  const link = linkFromArgs(process.argv);
  createWindow(pendingUrl || (link ? siteUrlFor(link) : START));
});
app.on('window-all-closed', () => app.quit());
