/* HexTV inside its apps: Windows (window.HexDesktop, from the Electron preload) and Android
   (window.HexAndroid, from the app's WebView). Gives both one interface, window.HexNative, and the
   app-only touches: no website home page or dashboard, and a labelled Create Room button.
   Loaded early in <head>; does nothing in a normal browser. */
(function () {
  'use strict';
  const android = window.HexAndroid;
  if (android && !window.HexNative) {
    let version = '';
    try { version = android.version(); } catch (e) { /* older app */ }
    window.HexNative = {
      platform: 'android', version,
      // Real fullscreen: the phone turns sideways (keyboard included) and the system bars hide
      fullscreen: on => { try { android.fullscreen(!!on); return true; } catch (e) { return false; } },
      // Returns true when the app will add the CDN's headers, so the page can skip the relay
      allowMedia: (url, headers) => { try { return android.allowMedia(String(url), JSON.stringify(headers || {})); } catch (e) { return false; } }
    };
  } else if (window.HexDesktop && !window.HexNative) {
    window.HexNative = window.HexDesktop;
  }
  const N = window.HexNative;
  if (!N) return;

  document.documentElement.classList.add('in-app', 'in-app-' + N.platform);
  // The apps open on the library: the website's home page and the dashboard aren't part of them
  if (/\/(index\.html)?$/.test(location.pathname) || /\/dashboard\.html$/.test(location.pathname)) {
    location.replace('library.html');
    return;
  }
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('a.btn-back[href="index.html"]').forEach(a => a.remove());
    document.querySelectorAll('a.brand[href="index.html"]').forEach(a => a.setAttribute('href', 'library.html'));
    document.querySelectorAll('a.create-room').forEach(a => {
      a.classList.add('hx-create');
      a.innerHTML = '<i class="fa-solid fa-plus"></i><span>Create Room</span>';
    });
  });
})();
