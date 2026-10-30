// Screenshots the splash, the offline screen and the library header: node test/logo.js [path-to-HexTV.exe]
const { _electron: electron } = require('C:/Users/ugopr/AppData/Roaming/npm/node_modules/rea-agents/node_modules/playwright-core');
const path = require('path');
const { pathToFileURL } = require('url');
const OUT = path.join(__dirname, 'shots');
const page = name => pathToFileURL(path.join(__dirname, '..', 'src', name)).href;
(async () => {
  const app = await electron.launch({ executablePath: process.argv[2] || path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe'), args: process.argv[2] ? [] : [path.join(__dirname, '..')] });
  const win = await app.firstWindow();
  await win.waitForURL(/library/, { timeout: 60000 });
  await win.goto(page('splash.html')); await new Promise(r => setTimeout(r, 600));
  await win.screenshot({ path: path.join(OUT, 'splash.png') });
  await win.goto(page('offline.html')); await new Promise(r => setTimeout(r, 400));
  await win.screenshot({ path: path.join(OUT, 'offline.png') });
  await win.goto('https://streamtogether-pi.vercel.app/library.html', { waitUntil: 'load', timeout: 60000 }); await new Promise(r => setTimeout(r, 3500));
  await win.screenshot({ path: path.join(OUT, 'lib-top.png'), clip: { x: 0, y: 0, width: 700, height: 70 } });
  await app.close();
})().catch(e => { console.error(e); process.exit(1); });
