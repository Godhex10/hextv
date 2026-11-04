const { _electron: electron } = require('C:/Users/ugopr/AppData/Roaming/npm/node_modules/rea-agents/node_modules/playwright-core');
const path = require('path');
(async () => {
  const app = await electron.launch({ executablePath: process.argv[2] || path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe'), args: process.argv[2] ? [] : [path.join(__dirname, '..')] });
  const win = await app.firstWindow();
  await win.waitForURL(/library/, { timeout: 60000 }); await new Promise(r => setTimeout(r, 3500));
  await win.screenshot({ path: path.join(__dirname, 'shots', 'lib-top.png'), clip: { x: 0, y: 0, width: 1280, height: 70 } });
  await win.click('a.create-room'); await win.waitForURL(/room\.html/, { timeout: 30000 }); await new Promise(r => setTimeout(r, 4000));
  await win.screenshot({ path: path.join(__dirname, 'shots', 'create.png') });
  await win.goto('https://streamtogether-pi.vercel.app/how-to.html', { waitUntil: 'domcontentloaded' }); await new Promise(r => setTimeout(r, 2500));
  await win.screenshot({ path: path.join(__dirname, 'shots', 'guide-top.png'), clip: { x: 0, y: 0, width: 1280, height: 70 } });
  console.log('title:', await win.title(), '· window size:', await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds()));
  await app.close();
})().catch(e => { console.error(e); process.exit(1); });
