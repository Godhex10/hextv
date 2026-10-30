// The packaged app: starts at the library, and a hextv:// link opens that room in the running window
const { _electron: electron } = require('C:/Users/ugopr/AppData/Roaming/npm/node_modules/rea-agents/node_modules/playwright-core');
const { execSync } = require('child_process');
(async () => {
  const app = await electron.launch({ executablePath: process.argv[2], args: [] });
  const win = await app.firstWindow();
  await win.waitForURL(/library/, { timeout: 60000 });
  console.log('packaged app starts at:', win.url());
  execSync('cmd /c start "" "hextv://room?room=room_proto' + Date.now().toString(36) + '&yt=aqz-KE-bpKQ"');
  await win.waitForURL(/room\.html/, { timeout: 30000 });
  console.log('hextv:// link opened in the app:', win.url().replace('https://streamtogether-pi.vercel.app', ''));
  console.log('windows open:', await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length));
  await app.close();
})().catch(e => { console.error(e); process.exit(1); });
