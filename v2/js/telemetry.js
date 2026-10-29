/* HexTV — anonymous usage stats for the dashboard, plus the site-wide announcement banner.

   Each browser gets a random id (no names, no IPs, nothing typed is linked to it). Counters
   add up in memory and go to the room server in one small request every few minutes and when
   the page closes, so stats cost almost nothing on the free plans. */
(function () {
  'use strict';

  const SERVER = (window.MB && MB.ROOMS ? MB.ROOMS : 'wss://streamtogether-rooms.streamtogether-rooms.workers.dev')
    .replace(/^ws/, 'http').replace(/\/$/, '');
  const BEACON_MS = 5 * 60_000;

  function store(k, v) {
    try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; }
  }
  let vid = store('hx_vid');
  if (!vid) { vid = 'v' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36); store('hx_vid', vid); }

  const ua = navigator.userAgent;
  const platform = window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform() ? 'app' : 'web';
  const device = /iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua)) ? 'tablet'
    : /Mobi|iPhone|Android/i.test(ua) ? 'phone' : 'desktop';
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iPod/i.test(ua) ? 'iOS' : /Windows/i.test(ua) ? 'Windows'
    : /Mac OS/i.test(ua) ? 'macOS' : /CrOS/i.test(ua) ? 'ChromeOS' : /Linux/i.test(ua) ? 'Linux' : 'Other';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung'
    : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Other';

  let counters = { sessions: 1 };
  let searches = [];
  let errors = [];
  let title = null;   // { key, title, type } of what this page is watching

  function payload() {
    return JSON.stringify({ vid, platform, device, os, browser, appVersion: window.HEXTV_APP_VERSION || '',
      c: counters, searches, errors, title });
  }
  function send(useBeacon) {
    const hasData = Object.keys(counters).length || searches.length || errors.length;
    if (!hasData) return;
    const body = payload();
    counters = {}; searches = []; errors = [];
    // text/plain keeps it a "simple" request: no CORS preflight, and sendBeacon accepts it
    try {
      if (useBeacon && navigator.sendBeacon && navigator.sendBeacon(SERVER + '/t', new Blob([body], { type: 'text/plain' }))) return;
      fetch(SERVER + '/t', { method: 'POST', body, keepalive: true, headers: { 'Content-Type': 'text/plain' } }).catch(() => {});
    } catch (e) { /* stats are best-effort */ }
  }

  window.HexStats = {
    add(name, v = 1) { if (v) counters[name] = (counters[name] || 0) + v; },
    error(kind, detail) { this.add('err_' + kind); if (errors.length < 10) errors.push({ kind, detail: String(detail || '').slice(0, 160) }); },
    search(q, n) { this.add('searches'); if (!n) this.add('searches_empty'); if (searches.length < 20) searches.push({ q: String(q).slice(0, 60), n }); },
    setTitle(t) { title = t; },
    flush: () => send(false)
  };

  // First report soon, so short visits still count; then every few minutes
  setTimeout(() => send(false), 20_000);
  setInterval(() => send(false), BEACON_MS);
  window.addEventListener('pagehide', () => send(true));
  document.addEventListener('visibilitychange', () => { if (document.hidden) send(true); });

  /* ── Announcement banner (set from the dashboard) ── */
  function showBanner(cfg) {
    const text = (cfg && cfg.announcement || '').trim();
    if (!text) return;
    const dismissedKey = 'hx_ann_' + text.length + '_' + text.slice(0, 24);
    if (store(dismissedKey)) return;
    const css = document.createElement('style');
    css.textContent = `.hx-banner{position:fixed;left:50%;top:12px;transform:translate(-50%,-140%);z-index:9000;display:flex;gap:10px;align-items:center;
      max-width:min(640px,calc(100% - 24px));padding:9px 12px 9px 14px;border-radius:12px;font:500 12.5px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;
      background:rgba(18,18,23,.92);color:#f0efec;border:1px solid rgba(255,255,255,.12);box-shadow:0 10px 30px rgba(0,0,0,.4);backdrop-filter:blur(10px);
      transition:transform .5s cubic-bezier(.2,.8,.2,1)}.hx-banner.in{transform:translate(-50%,0)}
      .hx-banner i{color:#3987e5}.hx-banner.warning i{color:#fab219}.hx-banner button{margin-left:4px;background:none;border:0;color:#898781;cursor:pointer;font-size:14px;padding:2px 4px}`;
    document.head.appendChild(css);
    const el = document.createElement('div');
    el.className = 'hx-banner' + (cfg.announcementLevel === 'warning' ? ' warning' : '');
    el.setAttribute('role', 'status');
    el.innerHTML = `<i class="fa-solid ${cfg.announcementLevel === 'warning' ? 'fa-triangle-exclamation' : 'fa-bullhorn'}"></i><span></span>
      <button aria-label="Dismiss"><i class="fa-solid fa-xmark" style="color:inherit"></i></button>`;
    el.querySelector('span').textContent = text;
    el.querySelector('button').onclick = () => { store(dismissedKey, '1'); el.classList.remove('in'); setTimeout(() => el.remove(), 500); };
    document.body.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('in')));
  }
  window.HexStats.showBanner = showBanner;
  if (!document.body || document.body.dataset.banner !== 'off') {
    fetch(SERVER + '/config').then(r => r.json()).then(cfg => {
      window.HexStats.config = cfg;
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => showBanner(cfg));
      else showBanner(cfg);
    }).catch(() => {});
  }
})();
