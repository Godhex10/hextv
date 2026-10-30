const { _electron: electron } = require('C:/Users/ugopr/AppData/Roaming/npm/node_modules/rea-agents/node_modules/playwright-core');
const path = require('path');
(async () => {
  const app = await electron.launch({ executablePath: path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe'), args: [path.join(__dirname, '..')], env: { ...process.env, HX_DEBUG: '1' } });
  app.process().stdout.on('data', d => process.stdout.write('[main] ' + d));
  app.process().stderr.on('data', d => process.stdout.write('[main-err] ' + d));
  const win = await app.firstWindow();
  await win.waitForURL(/library/, { timeout: 60000 });
  console.log(await win.evaluate(() => HexDesktop.allowMedia('https://bcdnxw.hakunaymatata.com/x.mp4', { Referer: 'https://movie-box.co/' })));
  await app.close();
})().catch(e => { console.error(e); process.exit(1); });
