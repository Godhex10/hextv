/* YouTube in the room: the official IFrame player behind the same interface as
   the room's <video> element, so the sync engine drives either one unchanged.

   RoomYouTube.create(videoEl, container) returns a controller whose `facade`
   stands in for the <video>: while YouTube is active, reads and writes of
   currentTime, paused, play(), readyState, buffered, playbackRate, volume… go
   to the YouTube player, and its state changes are re-fired as ordinary media
   events (play, pause, waiting, canplay, timeupdate…) on videoEl, where the
   room's listeners already are. */
(function () {
  'use strict';

  const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

  // youtube.com/watch?v=, youtu.be/, /shorts/, /embed/, /live/ — returns the 11-char id or null
  function parse(input) {
    let u;
    try { u = new URL(String(input).trim()); } catch (e) { return null; }
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    let id = null;
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (u.pathname === '/watch') id = u.searchParams.get('v');
      else {
        const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([^/?#]+)/);
        if (m) id = m[2];
      }
    }
    return id && VIDEO_ID.test(id) ? id : null;
  }

  let apiReady = null;
  function loadApi() {
    if (apiReady) return apiReady;
    apiReady = new Promise((resolve, reject) => {
      if (window.YT && window.YT.Player) return resolve();
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { if (prev) prev(); resolve(); };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => { apiReady = null; reject(new Error('Could not load YouTube. Check your connection.')); };
      document.head.appendChild(s);
    });
    return apiReady;
  }

  const ERRORS = {
    2: 'That YouTube link looks invalid.',
    5: 'YouTube could not play this video here.',
    100: 'This YouTube video is private or has been removed.',
    // YouTube reports missing videos with these codes too, so the message covers both
    101: "This video can't play here — its owner may not allow other sites, or it was removed.",
    150: "This video can't play here — its owner may not allow other sites, or it was removed.",
    153: "This video can't play here — its owner may not allow other sites, or it was removed."
  };

  // YT.PlayerState: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
  const PLAYING = 1, PAUSED = 2, BUFFERING = 3, ENDED = 0;

  function create(el, container) {
    let player = null;
    let state = -1;
    let ready = false;
    let intent = 'pause';         // what the room last asked for; buffering mid-play isn't "paused"
    let seekingUntil = 0;
    let rate = 1;
    let vol = 1, muted = false;
    let lastError = null;
    let timer = null;
    let playWaiters = [];
    let anchor = { v: 0, at: 0 };   // last position YouTube reported, and when
    const fire = name => el.dispatchEvent(new Event(name));

    // Rejections use the same names as <video>.play(): NotAllowedError when YouTube didn't start
    // (autoplay rules), AbortError when the player was replaced or paused first
    function settlePlay(ok, name) {
      const waiters = playWaiters;
      playWaiters = [];
      waiters.forEach(w => (ok ? w.resolve()
        : w.reject(Object.assign(new Error(name === 'AbortError' ? 'Playback was interrupted' : 'Playback was blocked'), { name: name || 'NotAllowedError' }))));
    }

    function onState(s) {
      const prev = state;
      state = s;
      if (s === PLAYING && intent === 'pause') {
        // Seeking a video that hasn't started makes YouTube start it. The room asked for it
        // to wait (paused, or held until the room arrives), so put it back — silently.
        seekingUntil = 0;
        player.mute();
        player.pauseVideo();
        return;
      }
      if (s === PLAYING) {
        seekingUntil = 0;
        if (prev !== PLAYING) { fire('play'); fire('playing'); }
        fire('seeked');
        fire('canplay');
        settlePlay(true);
        clearInterval(timer);
        timer = setInterval(() => fire('timeupdate'), 250);
      } else {
        clearInterval(timer);
        if (s === PAUSED) { seekingUntil = 0; fire('pause'); fire('seeked'); fire('canplay'); }
        else if (s === BUFFERING) fire('waiting');
        else if (s === ENDED) { intent = 'pause'; fire('pause'); fire('ended'); }
        else if (s === 5) fire('canplay');
        fire('timeupdate');
      }
    }

    function destroy() {
      clearInterval(timer);
      settlePlay(false, 'AbortError');
      if (player) { try { player.destroy(); } catch (e) { /* already gone */ } }
      player = null;
      ready = false;
      state = -1;
      container.innerHTML = '';
      container.hidden = true;
    }

    const controller = {
      active: false,
      get lastError() { return lastError; },

      // Load a video; resolves with its title once the player is ready
      activate(id) {
        controller.active = true;
        lastError = null;
        intent = 'pause';
        // Silence the <video> element while YouTube plays
        try { el.pause(); el.removeAttribute('src'); el.load(); } catch (e) { /* nothing loaded */ }
        return loadApi().then(() => new Promise((resolve, reject) => {
          destroy();
          const host = document.createElement('div');
          container.appendChild(host);
          container.hidden = false;
          player = new YT.Player(host, {
            videoId: id,
            width: '100%',
            height: '100%',
            // No YouTube controls: play/pause/seek must go through the room so everyone follows
            playerVars: { controls: 0, disablekb: 1, rel: 0, playsinline: 1, modestbranding: 1, iv_load_policy: 3, fs: 0, origin: location.origin },
            events: {
              onReady: () => {
                ready = true;
                player.setVolume(Math.round(vol * 100));
                if (muted) player.mute();
                fire('loadedmetadata');
                fire('canplay');
                const data = player.getVideoData ? player.getVideoData() : {};
                resolve((data && data.title) || '');
              },
              onStateChange: e => onState(e.data),
              onError: e => {
                lastError = ERRORS[e.data] || 'YouTube could not play this video.';
                settlePlay(false);
                if (!ready) reject(new Error(lastError));
                else fire('error');
              }
            }
          });
        }));
      },

      deactivate() {
        if (!controller.active) return;
        controller.active = false;
        destroy();
      },

      get(prop) {
        switch (prop) {
          case 'currentTime': {
            if (!player || !ready) return 0;
            // YouTube hands back a cached position that some devices (notably iPhones) refresh
            // only every so often. Left as-is, time looks like it stutters behind and leaps ahead,
            // and the room keeps "correcting" smooth playback. Between refreshes, advance it by
            // the clock so the room always sees smooth time.
            const v = player.getCurrentTime() || 0;
            const now = performance.now();
            if (v !== anchor.v || state !== PLAYING) anchor = { v, at: now };
            return state === PLAYING ? v + Math.min(1.5, (now - anchor.at) / 1000) * rate : v;
          }
          case 'paused': return !(intent === 'play' && (state === PLAYING || state === BUFFERING || state === -1 || state === 5));
          case 'readyState': return !ready ? 0 : state === BUFFERING ? 2 : 4;
          case 'seeking': return performance.now() < seekingUntil;
          case 'duration': return player && ready ? player.getDuration() || NaN : NaN;
          case 'buffered': {
            const end = player && ready ? (player.getVideoLoadedFraction() || 0) * (player.getDuration() || 0) : 0;
            return { length: 1, start: () => 0, end: () => end };
          }
          case 'playbackRate': return rate;
          case 'volume': return vol;
          case 'muted': return muted;
          case 'error': return lastError ? { code: 4, message: lastError } : null;
          case 'textTracks': return [];
          case 'currentSrc': return '';
          case 'getAttribute': return () => null;  // there's no <video> src while YouTube plays
          case 'play': return () => {
            intent = 'play';
            if (!player || !ready) return Promise.reject(new Error('YouTube is not ready'));
            if (state === PLAYING) return Promise.resolve();
            const p = new Promise((resolve, reject) => playWaiters.push({ resolve, reject }));
            if (!muted) player.unMute();   // undo the silent re-pause, unless the viewer muted
            player.playVideo();
            // Autoplay rules can stop YouTube silently: no start within 5s counts as blocked —
            // unless it's still loading (slow connection), which just means waiting longer
            const askedAt = performance.now();
            const checkStarted = () => {
              if (state === PLAYING || !playWaiters.length) return;
              if (state === BUFFERING && performance.now() - askedAt < 30000) return setTimeout(checkStarted, 2000);
              intent = 'pause';
              settlePlay(false, 'NotAllowedError');
              fire('pause');
            };
            setTimeout(checkStarted, 5000);
            return p;
          };
          case 'pause': return () => {
            intent = 'pause';
            settlePlay(false, 'AbortError');   // like <video>: a pause interrupts a pending play
            if (player && ready) player.pauseVideo();
          };
          default: return undefined;
        }
      },

      set(prop, value) {
        if (!player || !ready) return;
        if (prop === 'currentTime') {
          const target = Math.max(0, value);
          seekingUntil = performance.now() + 1500;
          fire('seeking');
          player.seekTo(target, true);
          // A seek while paused often changes no player state, so nothing would say it finished
          // (and the room would think seeks are slow). Watch for the position to land.
          const started = performance.now();
          const check = () => {
            if (!player || !ready) return;
            const landed = Math.abs((player.getCurrentTime() || 0) - target) < 1 && state !== BUFFERING;
            if (landed || performance.now() - started > 3000) {
              seekingUntil = 0;
              fire('seeked');
              fire('canplay');
            } else setTimeout(check, 100);
          };
          setTimeout(check, 100);
        } else if (prop === 'playbackRate') {
          // YouTube only plays at its own fixed speeds; anything else stays at 1x
          const allowed = player.getAvailablePlaybackRates ? player.getAvailablePlaybackRates() : [1];
          const next = allowed.includes(value) ? value : 1;
          if (next !== rate) { rate = next; player.setPlaybackRate(next); }
        } else if (prop === 'volume') {
          vol = Math.min(1, Math.max(0, Number(value)));
          player.setVolume(Math.round(vol * 100));
          fire('volumechange');
        } else if (prop === 'muted') {
          muted = !!value;
          muted ? player.mute() : player.unMute();
          fire('volumechange');
        }
      }
    };

    const OVERRIDDEN = new Set(['currentTime', 'paused', 'play', 'pause', 'readyState', 'seeking', 'duration', 'buffered',
      'playbackRate', 'volume', 'muted', 'error', 'getAttribute', 'textTracks', 'currentSrc']);

    controller.facade = new Proxy(el, {
      get(target, prop) {
        if (controller.active && OVERRIDDEN.has(prop)) return controller.get(prop);
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
      set(target, prop, value) {
        if (controller.active && OVERRIDDEN.has(prop)) { controller.set(prop, value); return true; }
        return Reflect.set(target, prop, value, target);
      }
    });

    return controller;
  }

  window.RoomYouTube = { parse, create };
})();
