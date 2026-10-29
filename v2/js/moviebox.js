/* MovieBox API helpers shared by the library and the room. */
(function () {
  'use strict';

  // When the site is served by the API itself (localhost:8000/app/ or a tunnel) the API is the
  // same origin; from the stand-alone dev server on :5500 it's the local API.
  const API = location.port === '5500' || location.protocol === 'file:' ? 'http://localhost:8000' : location.origin;

  // Where rooms connect: our own room server (room-server/ on Cloudflare), or '' to use Ably.
  // ?rooms=ably or ?rooms=<ws url> on a page overrides it, for testing.
  const ROOM_SERVER = 'wss://streamtogether-rooms.streamtogether-rooms.workers.dev';
  const roomsParam = new URLSearchParams(location.search).get('rooms');
  const ROOMS = roomsParam === 'ably' ? '' : roomsParam || ROOM_SERVER;

  async function get(path) {
    const r = await fetch(API + path);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(typeof body.detail === 'string' ? body.detail : 'HTTP ' + r.status);
    return body;
  }

  // Browsers can't send the Referer/Origin the video CDN insists on, so MP4s go through the API relay
  function proxied(stream) {
    const h = stream.headers ? '&h=' + encodeURIComponent(btoa(JSON.stringify(stream.headers))) : '';
    // The relay only serves links the API signed
    const t = stream.proxy_token ? `&exp=${stream.proxy_token.exp}&sig=${stream.proxy_token.sig}` : '';
    return API + '/proxy?url=' + encodeURIComponent(stream.url) + h + t;
  }

  const PREFERRED_HEIGHT = 720; // light enough to relay to a whole room, still sharp

  // Playable MP4s only, best first: full-length, H.264, closest to 720p.
  // (DASH/HLS variants need extra players and HEVC shows black on many devices.)
  function rankStreams(streams) {
    const full = s => (s.duration_sec && s.duration_sec < 300 ? 0 : 1);
    const avc = s => (/265|hevc/i.test(s.codec || '') ? 0 : 1);
    const height = s => s.quality_value || parseInt(s.quality, 10) || 0;
    return (streams || [])
      .filter(s => String(s.format).toUpperCase() === 'MP4')
      .sort((a, b) => full(b) - full(a) || avc(b) - avc(a) ||
        Math.abs(height(a) - PREFERRED_HEIGHT) - Math.abs(height(b) - PREFERRED_HEIGHT));
  }

  function srtToVtt(text) {
    if (/^\s*WEBVTT/.test(text)) return text;
    return 'WEBVTT\n\n' + text.replace(/\r+/g, '').replace(/^\s*\d+\s*$/gm, '')
      .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2').trim();
  }

  // A room link carries the title reference, never the signed video URL (those expire)
  function roomUrl(media, roomId) {
    const p = new URLSearchParams({ room: roomId || 'room_' + Math.random().toString(36).slice(2, 9) });
    if (media.mb) {
      p.set('mb', media.mb);
      if (media.se) p.set('se', media.se);
      if (media.ep) p.set('ep', media.ep);
    } else if (media.url) {
      p.set('stream', media.url);
    }
    if (media.title) p.set('title', media.title);
    return 'room.html?' + p.toString();
  }

  window.MB = { API, ROOMS, get, proxied, rankStreams, srtToVtt, roomUrl };
})();
