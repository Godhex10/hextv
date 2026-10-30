const { _electron: electron } = require('C:/Users/ugopr/AppData/Roaming/npm/node_modules/rea-agents/node_modules/playwright-core');
const path = require('path');
(async () => {
  const app = await electron.launch({ executablePath: path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe'), args: [path.join(__dirname, '..')] });
  const win = await app.firstWindow();
  win.on('console', m => console.log('[page]', m.type(), m.text().slice(0, 200)));
  await win.waitForURL(/library/, { timeout: 60000 });
  await win.goto('https://streamtogether-pi.vercel.app/room.html?room=room_dbg' + Date.now() + '&mb=6391474290696802080&title=T', { timeout: 90000, waitUntil: 'domcontentloaded' });
  await win.waitForFunction(() => typeof mediaStreams !== 'undefined' && mediaStreams.length, null, { timeout: 60000 });
  console.log(await win.evaluate(() => ({ headers: mediaStreams[0].headers, url: mediaStreams[0].url.slice(0, 90), src: document.querySelector('video').getAttribute('src').slice(0, 90),
    allow: HexDesktop.allowMedia(mediaStreams[0].url, mediaStreams[0].headers) })));
  await new Promise(r => setTimeout(r, 15000));
  console.log('now src:', await win.evaluate(() => document.querySelector('video').currentSrc.slice(0, 90)), await win.evaluate(() => { const v = document.querySelector('video'); return { err: v.error && v.error.code, ready: v.readyState }; }));
  await app.close();
})().catch(e => { console.error(e); process.exit(1); });
