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
  if (N.platform === 'android') splash();
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('a.btn-back[href="index.html"]').forEach(a => a.remove());
    document.querySelectorAll('a.brand[href="index.html"]').forEach(a => a.setAttribute('href', 'library.html'));
    document.querySelectorAll('a.create-room').forEach(a => {
      a.classList.add('hx-create');
      a.innerHTML = '<i class="fa-solid fa-plus"></i><span>Create Room</span>';
    });
  });

  /* The Android app's opening splash: the glowing H, the HEXTV wordmark and a loading bar, shown
     on the first page after the app starts until that page has loaded. Android's own launch screen
     (just the H) stays up until this is on screen, so there's no black gap between them. */
  function splash() {
    let seen = false;
    try { seen = sessionStorage.getItem('hx_splashed') === '1'; sessionStorage.setItem('hx_splashed', '1'); } catch (e) { /* storage blocked */ }
    const nativeSplash = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.SplashScreen;
    const hideNative = () => { try { nativeSplash && nativeSplash.hide({ fadeOutDuration: 150 }); } catch (e) { /* already hidden */ } };
    if (seen) return hideNative();

    const css = document.createElement('style');
    css.textContent = `
      #hxSplash { position: fixed; inset: 0; z-index: 2147483647; background: radial-gradient(60% 40% at 50% 46%, rgba(229,9,20,.20), transparent 70%), #050507;
        display: flex; flex-direction: column; align-items: center; justify-content: center; transition: opacity .35s ease; }
      #hxSplash.out { opacity: 0; pointer-events: none; }
      #hxSplash .h { width: 96px; height: 96px; background: url(img/hextv-h.svg) center / contain no-repeat;
        filter: drop-shadow(0 0 28px rgba(229,9,20,.55)); animation: hxPulse 1.8s ease-in-out infinite; }
      #hxSplash .foot { position: absolute; left: 0; right: 0; bottom: max(64px, env(safe-area-inset-bottom)); display: flex; flex-direction: column; align-items: center; }
      #hxSplash .word { font: 400 30px/1 'Bebas Neue', Impact, 'Arial Narrow', sans-serif; letter-spacing: .06em; color: #f6f6f8; }
      #hxSplash .word b { font-weight: 400; color: #e50914; }
      #hxSplash .bar { width: 78px; height: 3px; border-radius: 2px; background: rgba(255,255,255,.12); margin-top: 14px; overflow: hidden; }
      #hxSplash .bar i { display: block; height: 100%; width: 100%; background: #e50914; border-radius: 2px; transform-origin: left;
        transform: scaleX(.04); transition: transform 2.6s cubic-bezier(.2,.7,.3,1); }
      #hxSplash.go .bar i { transform: scaleX(.85); }
      #hxSplash.done .bar i { transform: scaleX(1); transition-duration: .25s; }
      @keyframes hxPulse { 50% { transform: scale(1.05); filter: drop-shadow(0 0 40px rgba(229,9,20,.75)); } }`;
    const el = document.createElement('div');
    el.id = 'hxSplash';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '<div class="h"></div><div class="foot"><div class="word">HEX<b>TV</b></div><div class="bar"><i></i></div></div>';
    document.documentElement.appendChild(css);
    document.documentElement.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => { el.classList.add('go'); hideNative(); }));

    // Gone once the page has loaded (at least ~1s so it doesn't flash, at most 6s on a slow network)
    const shown = Date.now();
    let gone = false;
    const finish = () => {
      if (gone) return; gone = true;
      setTimeout(() => {
        el.classList.add('done');
        setTimeout(() => { el.classList.add('out'); setTimeout(() => { el.remove(); css.remove(); }, 400); }, 260);
      }, Math.max(0, 1000 - (Date.now() - shown)));
    };
    if (document.readyState === 'complete') finish();
    else window.addEventListener('load', finish);
    setTimeout(finish, 6000);
  }
})();
