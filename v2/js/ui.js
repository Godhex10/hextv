/* ══════════════════════════════════════════════════════════════
   StreamTogether — shared UI motion layer
   Purely presentational: it never touches the page's own logic
   (Ably sync, chat, stream resolving). Safe to remove.
══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer  = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  /* ── Ambient layers ─────────────────────────────── */
  function injectAmbient() {
    if (document.body.dataset.ambient === 'off') return;
    const el = document.createElement('div');
    el.className = 'ambient';
    el.setAttribute('aria-hidden', 'true');
    document.body.prepend(el);
  }

  /* ── Page transitions between the separate pages ── */
  const curtain = document.createElement('div');
  curtain.className = 'curtain';
  curtain.setAttribute('aria-hidden', 'true');

  function isInternalPageLink(a, e) {
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
    if (a.target && a.target !== '_self') return false;
    if (a.hasAttribute('download') || a.dataset.noTransition !== undefined) return false;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return false;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin) return false;
    if (url.pathname === location.pathname && url.search === location.search && url.hash) return false;
    return /\.html?$|\/$/.test(url.pathname);
  }

  function setupTransitions() {
    document.body.appendChild(curtain);
    if (sessionStorage.getItem('st_curtain') === '1' && !reduceMotion) {
      sessionStorage.removeItem('st_curtain');
      curtain.classList.add('reveal-out');
      curtain.addEventListener('animationend', () => curtain.classList.remove('reveal-out'), { once: true });
    }
    document.addEventListener('click', e => {
      const a = e.target.closest('a');
      if (!isInternalPageLink(a, e) || reduceMotion) return;
      e.preventDefault();
      sessionStorage.setItem('st_curtain', '1');
      curtain.classList.add('cover');
      setTimeout(() => { location.href = a.href; }, 480);
    });
    // Back/forward cache restores the covered page — uncover it
    window.addEventListener('pageshow', e => { if (e.persisted) curtain.classList.remove('cover'); });
  }

  /* ── Preloader (landing page) ───────────────────── */
  function runPreloader() {
    const pl = document.getElementById('preloader');
    if (!pl) { document.body.classList.remove('is-loading'); return Promise.resolve(); }

    // First visit gets a short moment for the logo; later visits only cover the page load
    const seen = sessionStorage.getItem('st_seen_intro') === '1';
    const bar = document.getElementById('plBar');
    if (seen || reduceMotion) pl.classList.add('quick');

    return new Promise(resolve => {
      const start = performance.now();
      const minTime = seen || reduceMotion ? 500 : 1400;
      let fontsReady = false, pageReady = document.readyState === 'complete';
      (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => { fontsReady = true; });
      window.addEventListener('load', () => { pageReady = true; }, { once: true });

      const step = () => {
        const t = performance.now() - start;
        const real = (fontsReady ? 0.5 : 0.2) + (pageReady ? 0.5 : 0.2);
        const pct = Math.min(1, Math.min(t / minTime, real));
        bar.style.transform = `scaleX(${pct.toFixed(3)})`;
        if (pct >= 1 || t > 5000) {
          bar.style.transform = 'scaleX(1)';
          setTimeout(() => {
            pl.classList.add('done');
            document.body.classList.remove('is-loading');
            sessionStorage.setItem('st_seen_intro', '1');
            resolve();
            setTimeout(() => pl.remove(), 700);
          }, 200);
        } else {
          requestAnimationFrame(step);
        }
      };
      requestAnimationFrame(step);
    });
  }

  /* ── Scroll reveal ──────────────────────────────── */
  function setupReveal(root = document) {
    const els = root.querySelectorAll('.reveal:not(.in)');
    if (!('IntersectionObserver' in window) || reduceMotion) { els.forEach(el => el.classList.add('in')); return; }
    const io = new IntersectionObserver(entries => {
      entries.forEach(en => {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    els.forEach(el => io.observe(el));
  }

  /* ── Animated counters ──────────────────────────── */
  function setupCounters() {
    const els = document.querySelectorAll('[data-count]');
    if (!els.length) return;
    const run = el => {
      const target = Number(el.dataset.count), div = Number(el.dataset.div || 1);
      const dec = Number(el.dataset.dec || 0), suffix = el.dataset.suffix || '';
      const dur = 1800, t0 = performance.now();
      const frame = now => {
        const p = Math.min(1, (now - t0) / dur), eased = 1 - Math.pow(1 - p, 4);
        el.textContent = (target * eased / div).toFixed(dec) + suffix;
        if (p < 1) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    };
    const io = new IntersectionObserver(entries => entries.forEach(en => {
      if (en.isIntersecting) { run(en.target); io.unobserve(en.target); }
    }), { threshold: 0.6 });
    els.forEach(el => io.observe(el));
  }

  /* ── Magnetic buttons + tilt cards (desktop) ────── */
  function setupMagnetic() {
    if (!finePointer || reduceMotion) return;
    document.querySelectorAll('.magnetic').forEach(el => {
      el.addEventListener('pointermove', e => {
        const r = el.getBoundingClientRect();
        const x = e.clientX - r.left - r.width / 2, y = e.clientY - r.top - r.height / 2;
        el.style.transform = `translate(${x * 0.18}px, ${y * 0.28}px)`;
      });
      el.addEventListener('pointerleave', () => { el.style.transform = ''; });
    });
  }

  function setupTilt() {
    if (!finePointer || reduceMotion) return;
    // At most one tilt update per frame, however fast the pointer moves
    let pending = null, queued = false;
    document.addEventListener('pointermove', e => {
      pending = e;
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        const ev = pending, el = ev.target.closest && ev.target.closest('.tilt');
        if (!el) return;
        const r = el.getBoundingClientRect();
        const px = (ev.clientX - r.left) / r.width - 0.5, py = (ev.clientY - r.top) / r.height - 0.5;
        el.style.setProperty('--rx', (-py * 6).toFixed(2) + 'deg');
        el.style.setProperty('--ry', (px * 8).toFixed(2) + 'deg');
        el.style.setProperty('--mx', ((px + 0.5) * 100).toFixed(1) + '%');
        el.style.setProperty('--my', ((py + 0.5) * 100).toFixed(1) + '%');
      });
    }, { passive: true });
    document.addEventListener('pointerout', e => {
      const el = e.target.closest && e.target.closest('.tilt');
      if (el && !el.contains(e.relatedTarget)) { el.style.setProperty('--rx', '0deg'); el.style.setProperty('--ry', '0deg'); }
    });
  }

  /* ── Sticky nav state ───────────────────────────── */
  function setupNav() {
    const nav = document.querySelector('[data-nav]');
    if (!nav) return;
    const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  /* ── Reaction icons ─────────────────────────────── */
  // Reactions still travel between viewers as emoji characters (so older
  // clients keep working); they're only drawn as Font Awesome icons.
  const REACTIONS = {
    '🔥': 'fire fire', '😂': 'face-laugh-squint laugh', '😱': 'face-surprise surprise',
    '❤️': 'heart heart', '👏': 'hands-clapping clap', '🤯': 'explosion wow'
  };
  function reactionIcon(emoji) {
    const [icon, key] = (REACTIONS[emoji] || 'heart heart').split(' ');
    return `<i class="fa-solid fa-${icon} rx rx-${key}"></i>`;
  }

  window.STUI = { setupReveal, reduceMotion, finePointer, reactionIcon };

  document.addEventListener('DOMContentLoaded', () => {
    injectAmbient();
    setupTransitions();
    setupNav();
    setupMagnetic();
    setupTilt();
    runPreloader().then(() => {
      setupReveal();
      setupCounters();
      document.dispatchEvent(new CustomEvent('st:ready'));
    });
  });
})();
