/* Runs before the site's own scripts. It tells the site it's inside the Windows app
   (window.HexDesktop) and lets it ask for direct video playback — nothing else is exposed. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('HexDesktop', {
  platform: 'windows',
  version: ipcRenderer.sendSync('hx:version'),
  // Returns true when the app will add the CDN's headers, so the page can skip the relay
  allowMedia: (url, headers) => ipcRenderer.sendSync('hx:allow-media', String(url), headers)
});

// App-only touches: there's no home page, so the library's "+" becomes a labelled Create Room
// button (for YouTube and link parties), and the guide's "Back to Lobby" is dropped (it has a Library button)
window.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('a.btn-back[href="index.html"]').forEach(a => a.remove());
  document.querySelectorAll('a.create-room').forEach(a => {
    a.classList.add('hx-create');
    a.innerHTML = '<i class="fa-solid fa-plus"></i><span>Create Room</span>';
  });
});
