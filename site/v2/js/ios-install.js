/* iPhone/iPad in the browser: a small banner showing how to put HexTV on the Home Screen
   (iPhones have no install button, so it shows the steps). Not shown in the apps, once
   opened from the Home Screen, or for two weeks after it's closed. */
(function () {
  'use strict';
  const apple = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  const installed = navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  if (!apple || installed || window.HexNative || window.HexDesktop) return;
  const KEY = 'hx_ios_tip_closed';
  try { if (Date.now() - Number(localStorage.getItem(KEY) || 0) < 14 * 864e5) return; } catch (e) { /* storage blocked */ }

  const device = /iPad|Macintosh/.test(navigator.userAgent) ? 'iPad' : 'iPhone';
  const css = document.createElement('style');
  css.textContent = `
    #hxInstall { position: fixed; left: 12px; right: 12px; bottom: calc(12px + env(safe-area-inset-bottom)); z-index: 9000; max-width: 460px; margin: 0 auto;
      display: flex; align-items: center; gap: 12px; padding: 12px 40px 12px 12px; border-radius: 16px; color: #f6f6f8;
      background: rgba(22, 22, 28, .94); border: 1px solid rgba(255, 255, 255, .12); box-shadow: 0 12px 40px rgba(0, 0, 0, .55);
      -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); font: 400 13.5px/1.4 'DM Sans', system-ui, sans-serif;
      transform: translateY(140%); transition: transform .4s cubic-bezier(.2, .8, .3, 1); }
    #hxInstall.in { transform: none; }
    #hxInstall img { width: 44px; height: 44px; border-radius: 11px; flex-shrink: 0; }
    #hxInstall b { display: block; font-size: 14.5px; font-weight: 700; margin-bottom: 2px; }
    #hxInstall .hxi-step { color: #b9b9c4; }
    #hxInstall .hxi-step i { color: #3d9bff; margin: 0 2px; }
    #hxInstall .hxi-step strong { color: #f6f6f8; font-weight: 600; }
    #hxInstall .hxi-close { position: absolute; top: 6px; right: 6px; width: 30px; height: 30px; border: 0; border-radius: 50%;
      background: none; color: #8d8d99; font-size: 15px; }`;
  const el = document.createElement('div');
  el.id = 'hxInstall';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Install HexTV');
  el.innerHTML = `<img src="img/hextv-icon-180.png" alt="">
    <div><b>Install HexTV on your ${device}</b>
      <div class="hxi-step">Tap <i class="fa-solid fa-arrow-up-from-bracket"></i> Share, then <strong>Add to Home Screen</strong>.</div></div>
    <button type="button" class="hxi-close" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>`;
  el.querySelector('.hxi-close').addEventListener('click', () => {
    try { localStorage.setItem(KEY, String(Date.now())); } catch (e) { /* storage blocked */ }
    el.classList.remove('in');
    setTimeout(() => { el.remove(); css.remove(); }, 450);
  });

  // A few seconds in, once the page has settled
  window.addEventListener('load', () => setTimeout(() => {
    document.head.appendChild(css);
    document.body.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('in')));
  }, 3000));
})();
