// Launches the app and checks the main flows: library first, no home page, a MovieBox room playing
// straight from the CDN, sync with a browser viewer, YouTube, and the guide's back button.
// Usage: node test/smoke.js [path-to-HexTV.exe]   (defaults to the development app)
const { _electron: electron, chromium } = require('C:/Users/ugopr/AppData/Roaming/npm/node_modules/rea-agents/node_modules/playwright-core');
const path = require('path');
const fs = require('fs');
const SITE = 'https://streamtogether-pi.vercel.app';
const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const wait = ms => new Promise(r => setTimeout(r, ms));
const exe = process.argv[2];

(async () => {
  const app = await electron.launch(exe ? { executablePath: exe, args: [] } : { executablePath: path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe'), args: [path.join(__dirname, '..')] });
  const win = await app.firstWindow();
  await win.waitForURL(/library\.html/, { timeout: 60000 });
  await wait(4000);
  console.log('starts at:', win.url());
  console.log('HexDesktop:', await win.evaluate(() => window.HexDesktop && { platform: HexDesktop.platform, version: HexDesktop.version }));
  console.log('Home link hidden:', await win.evaluate(() => { const a = document.querySelector('.top-links a[href="index.html"]'); return !a || getComputedStyle(a).display === 'none'; }));
  await win.screenshot({ path: path.join(OUT, '1-library.png') });

  // The website's home page and the dashboard redirect to the library
  for (const p of ['/', '/index.html', '/dashboard.html']) {
    await win.goto(SITE + p, { timeout: 90000, waitUntil: 'domcontentloaded' }).catch(() => {}); await wait(2500, { timeout: 90000, waitUntil: 'domcontentloaded' });
    console.log(`goto ${p} ->`, win.url().replace(SITE, ''));
  }

  // MovieBox room: plays directly from the CDN, not through /proxy
  const room = 'room_win' + Date.now().toString(36);
  await win.goto(`${SITE}/room.html?room=${room}&mb=6391474290696802080&title=Test`, { timeout: 90000, waitUntil: 'domcontentloaded' });
  await wait(9000);
  await win.evaluate(() => { const o = document.getElementById('syncOverlay'); if (o && o.style.display === 'flex') dismissSyncOverlay(); });
  await win.waitForFunction(() => { const v = document.querySelector('video'); return v && !v.paused && v.currentTime > 2; }, null, { timeout: 120000 }).catch(async e => {
    console.log('app state:', await win.evaluate(() => { const v = document.querySelector('video'); return { src: (v.currentSrc || '').slice(0, 70), ready: v.readyState, paused: v.paused, t: v.currentTime, err: v.error && v.error.code,
      overlay: document.getElementById('syncOverlay').style.display, status: document.getElementById('syncBtn').dataset.state, media: document.getElementById('mediaStatusText').textContent }; })); throw e; });
  const src = await win.evaluate(() => document.querySelector('video').currentSrc);
  console.log('video source:', src.includes('/proxy?') ? 'RELAY' : 'DIRECT from ' + new URL(src).host);
  console.log('Open-in-app button hidden in app:', await win.evaluate(() => document.getElementById('openAppBtn').hidden));

  // A browser viewer joins the same room and syncs with the app
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctx.route(/streamtogether-rooms.*\/t$/, r => r.fulfill({ status: 204, body: '' }));
  const phone = await ctx.newPage();
  await phone.goto(`${SITE}/room.html?room=${room}&mb=6391474290696802080&title=Test`, { timeout: 90000, waitUntil: 'domcontentloaded' });
  await wait(6000);
  // Phones in a browser are first offered the app; this viewer stays in the browser
  const inBrowser = phone.getByText('Watch in the browser');
  if (await inBrowser.isVisible().catch(() => false)) await inBrowser.click();
  await wait(3000);
  await phone.evaluate(() => dismissSyncOverlay());
  await phone.waitForFunction(() => { const v = document.querySelector('video'); return v && !v.paused && v.currentTime > 2; }, null, { timeout: 150000 }).catch(async e => { console.log('phone state:', await phone.evaluate(() => { const v = document.querySelector('video'); return { src: (v.currentSrc || '').slice(0, 60), ready: v.readyState, paused: v.paused, t: v.currentTime, err: v.error && v.error.code, status: document.getElementById('syncBtn').dataset.state, media: document.getElementById('mediaStatusText').textContent }; })); throw e; });
  await wait(15000);
  const [ta, tb] = await Promise.all([win, phone].map(p => p.evaluate(() => document.querySelector('video').currentTime)));
  console.log('app vs phone:', Math.abs(ta - tb).toFixed(3) + 's apart; app status', await win.evaluate(() => document.getElementById('syncBtn').dataset.state),
    '· phone status', await phone.evaluate(() => document.getElementById('syncBtn').dataset.state),
    '· phone video via', await phone.evaluate(() => { const s = document.querySelector('video').currentSrc; return s.includes('/proxy?') ? new URL(s).host + ' relay' : 'direct'; }));
  // Pause in the app → the phone pauses too
  await win.evaluate(() => userPause()); await wait(2500);
  console.log('phone paused after app paused:', await phone.evaluate(() => document.querySelector('video').paused));
  await win.evaluate(() => userPlay()); await wait(1500);
  await win.screenshot({ path: path.join(OUT, '2-room.png') });
  await browser.close();

  // YouTube room
  await win.goto(`${SITE}/room.html?room=${room}yt&yt=aqz-KE-bpKQ`, { timeout: 90000, waitUntil: 'domcontentloaded' });
  await wait(12000);
  await win.evaluate(() => { const o = document.getElementById('syncOverlay'); if (o && o.style.display === 'flex') dismissSyncOverlay(); });
  await wait(8000);
  console.log('YouTube playing:', await win.evaluate(() => { const v = document.querySelector('video'); return v && !v.paused; }));
  await win.screenshot({ path: path.join(OUT, '3-youtube.png') });

  // Guide: "Back to Library"
  await win.goto(SITE + '/how-to.html'); await wait(3000, { timeout: 90000, waitUntil: 'domcontentloaded' });
  console.log('guide back button:', await win.evaluate(() => { const a = document.querySelector('a.btn-back'); return a && a.getAttribute('href') + ' / ' + a.textContent.trim(); }));
  await win.screenshot({ path: path.join(OUT, '4-guide.png') });
  await app.close();
})().catch(e => { console.error(e); process.exit(1); });
