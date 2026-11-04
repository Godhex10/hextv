/* HexTV room server — one Durable Object per watch-party room, plus the Stats object.

   Clients connect with a WebSocket to /room/<roomId>?clientId=&name=&color=&vid=&platform=.
   The room relays chat, reactions and sync messages between its viewers, keeps
   the viewer list, and remembers what's playing plus the shared room clock, so
   a newcomer gets the room's state straight from the server.

   Also served here:
     POST /t              anonymous page telemetry (see stats.js)
     GET  /config         public settings: announcement banner, "new rooms paused"
     /admin/*             the dashboard's API, behind a password login
     cron (every 15 min)  health checks and alert rules

   Uses the WebSocket Hibernation API: an idle room is evicted from memory
   without dropping its connections, and isn't billed while it sleeps. */
import { DurableObject } from 'cloudflare:workers';
export { Stats } from './stats.js';

const MAX_MESSAGE_BYTES = 8 * 1024;
const MAX_CHAT_CHARS = 500;
const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 40;                     // messages per viewer per window; the rest are dropped
const IDLE_CLEANUP_MS = 24 * 3600_000;   // forget an empty room's state after a day
const CHANNELS = new Set(['video_sync', 'chat_message', 'reaction']);
const TOKEN_TTL_MS = 7 * 24 * 3600_000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400'
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
const stats = env => env.STATS.get(env.STATS.idFromName('global'));
const statsCall = (env, path, body) => stats(env).fetch('https://stats' + path,
  body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) });

// Per-isolate caches: they save Durable Object requests on hot paths
let configCache = { at: 0, data: null };
let signingKeyCache = null;
const loginAttempts = new Map();   // ip -> { start, n }

// Rooms and stats only serve HexTV's own pages, so a copied site can't run on this server.
// Browsers always send Origin on WebSockets and POSTs; requests without one aren't from a web page.
const SITE_HOSTS = ['streamtogether-pi.vercel.app', 'localhost', '127.0.0.1'];
function siteAllowed(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin || origin === 'null') return !origin;
  let host;
  try { host = new URL(origin).hostname.toLowerCase(); } catch { return false; }
  const extra = (env.ALLOWED_SITE_HOSTS || '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
  return SITE_HOSTS.includes(host) || extra.includes(host);
}

async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function hmacHex(keyHex, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(keyHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function signingKey(env) {
  if (!signingKeyCache) signingKeyCache = (await (await statsCall(env, '/signing-key')).json()).key;
  return signingKeyCache;
}
async function issueToken(env) {
  const exp = String(Date.now() + TOKEN_TTL_MS);
  return exp + '.' + (await hmacHex(await signingKey(env), 'admin:' + exp));
}
async function validToken(env, header) {
  const token = (header || '').replace(/^Bearer\s+/i, '');
  const [exp, sig] = token.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await hmacHex(await signingKey(env), 'admin:' + exp));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (path === '/') return new Response('HexTV room server');

    const m = path.match(/^\/room\/([A-Za-z0-9_-]{1,64})$/);
    if ((m || path === '/t') && !siteAllowed(request, env)) return new Response('Not allowed from this site', { status: 403, headers: CORS });
    if (m) {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
      const headers = new Headers(request.headers);
      headers.set('x-room', m[1]);
      return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(new Request(request, { headers }));
    }

    if (path === '/t' && request.method === 'POST') {
      const text = await request.text();
      if (text.length > 16 * 1024) return new Response(null, { status: 413, headers: CORS });
      let body;
      try { body = JSON.parse(text); } catch { return new Response(null, { status: 400, headers: CORS }); }
      body.country = (request.cf && request.cf.country) || '';
      await statsCall(env, '/telemetry', body);
      return new Response(null, { status: 204, headers: CORS });
    }

    if (path === '/config') {
      if (!configCache.data || Date.now() - configCache.at > 60_000) {
        configCache = { at: Date.now(), data: await (await statsCall(env, '/config')).json() };
      }
      return json(configCache.data);
    }

    if (path === '/admin/login' && request.method === 'POST') {
      const ip = request.headers.get('CF-Connecting-IP') || 'x';
      const a = loginAttempts.get(ip);
      const now = Date.now();
      if (a && now - a.start < 60_000 && a.n >= 6) return json({ error: 'Too many attempts — wait a minute' }, 429);
      loginAttempts.set(ip, a && now - a.start < 60_000 ? { start: a.start, n: a.n + 1 } : { start: now, n: 1 });
      const { password } = await request.json().catch(() => ({}));
      if (!env.DASHBOARD_PASSWORD_SHA256) return json({ error: 'Dashboard password is not configured' }, 503);
      if (!safeEqual(await sha256Hex(String(password || '')), env.DASHBOARD_PASSWORD_SHA256)) return json({ error: 'Wrong password' }, 401);
      return json({ token: await issueToken(env) });
    }

    if (path.startsWith('/admin/')) {
      if (!(await validToken(env, request.headers.get('Authorization')))) return json({ error: 'Not signed in' }, 401);
      const body = request.method === 'POST' ? await request.json().catch(() => ({})) : undefined;
      if (path === '/admin/summary') {
        const r = await stats(env).fetch('https://stats/summary?days=' + encodeURIComponent(url.searchParams.get('days') || '1'));
        return json(await r.json());
      }
      if (path === '/admin/settings' && body) {
        configCache.at = 0;
        return json(await (await statsCall(env, '/settings', body)).json());
      }
      if (path === '/admin/test-alert') return json(await (await statsCall(env, '/test-alert', {})).json());
      if (path === '/admin/refresh-usage') return json(await (await statsCall(env, '/refresh-usage', {})).json());
      const room = clean((body && body.room) || url.searchParams.get('room'), 64);
      if (room && path.startsWith('/admin/room/')) {
        const action = path.slice('/admin/room/'.length);
        if (!['viewers', 'close', 'kick'].includes(action)) return json({ error: 'Unknown action' }, 404);
        const r = await env.ROOMS.get(env.ROOMS.idFromName(room)).fetch('https://room/internal/' + action, {
          method: 'POST', headers: { 'x-room': room }, body: JSON.stringify(body || {})
        });
        return json(await r.json());
      }
      return json({ error: 'Not found' }, 404);
    }
    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(statsCall(env, '/cron', {}));
  }
};

const mediaType = m => (!m ? '' : m.mb ? (m.se ? 'series' : 'movie') : m.yt ? 'youtube' : 'link');
// Fields starting with "_" are private to the server (platform, anonymous viewer id)
const publicMember = m => (m ? { clientId: m.clientId, data: m.data, timestamp: m.timestamp } : m);
// A host is a device (its anonymous id), so a host who refreshes or reconnects stays host
const deviceOf = m => m._v || 'c:' + m.clientId;
// Who may send what while host controls are on: playback (play/pause/seek/up-next) and loading a video
const PLAYBACK = new Set(['play', 'pause', 'seek', 'upnext', 'upnext_cancel']);

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = null;           // { media, clock } — what's playing and where
    this.rates = new Map();     // clientId -> { start, count }; fine to lose on eviction
    this.wsMsgs = 0;            // incoming messages since the last stats report
    this.settings = { at: 0, v: null };
    // Host controls: owner = the host's device; lock = only the host controls playback;
    // guestsLoad = guests may change the video. Off by default (everyone controls).
    this.ctl = { owner: '', lock: false, guestsLoad: true };
    ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get('room')) || null;
      this.ctl = { ...this.ctl, ...((await ctx.storage.get('ctl')) || {}) };
      this.openedAt = (await ctx.storage.get('openedAt')) || null;
      this.name = (await ctx.storage.get('name')) || '';
    });
    // Keepalive pings are answered without waking the room
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async getSettings() {
    if (!this.settings.v || Date.now() - this.settings.at > 60_000) {
      try { this.settings = { at: Date.now(), v: await (await statsCall(this.env, '/config')).json() }; }
      catch { this.settings = { at: Date.now(), v: this.settings.v || {} }; }
    }
    return this.settings.v;
  }

  async report(event, extra = {}) {
    if (!this.name) return;
    const ms = this.members();
    const app = ms.filter(m => m._p && m._p !== 'web').length;   // Android and Windows apps
    const media = this.room && this.room.media;
    const body = {
      room: this.name, event, viewers: ms.length, web: ms.length - app, app,
      media: media ? { type: mediaType(media), title: media.title || '' } : null,
      playing: !!(this.room && this.room.clock && this.room.clock.playing),
      openedAt: this.openedAt, wsMsgs: this.wsMsgs, ...extra
    };
    this.wsMsgs = 0;
    try { await statsCall(this.env, '/report', body); } catch { /* stats are best-effort */ }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const roomName = clean(request.headers.get('x-room'), 64);
    if (roomName && roomName !== this.name) { this.name = roomName; await this.ctx.storage.put('name', roomName); }
    if (url.pathname.startsWith('/internal/')) return this.internal(url.pathname.slice('/internal/'.length), await request.json().catch(() => ({})));

    const params = url.searchParams;
    const clientId = clean(params.get('clientId'), 64) || crypto.randomUUID();
    const vid = clean(params.get('vid'), 40);
    const platform = ['app', 'windows'].includes(params.get('platform')) ? params.get('platform') : 'web';

    const [client, server] = Object.values(new WebSocketPair());
    const others = this.ctx.getWebSockets().filter(s => s.readyState === WebSocket.READY_STATE_OPEN);
    const blocked = (await this.ctx.storage.get('blocked')) || [];
    const settings = await this.getSettings();
    // Removed viewers, and new rooms while the emergency switch is on, get a reason instead of a room
    const refuse = vid && blocked.includes(vid) ? { reason: 'kicked', message: 'You were removed from this room.' }
      : settings.newRoomsPaused && !others.length ? { reason: 'paused', message: 'HexTV is paused for maintenance. Please try again soon.' } : null;
    if (refuse) {
      server.accept();
      server.send(JSON.stringify({ t: 'closed', ...refuse }));
      server.close(4001, refuse.reason);
      return new Response(null, { status: 101, webSocket: client });
    }

    // A reconnecting viewer replaces their old socket instead of appearing twice
    for (const old of this.ctx.getWebSockets(clientId)) old.close(4000, 'replaced');
    // One device, one seat: the same device opening this room in another tab or window takes
    // over from the older one, which is told why (the page offers to switch back)
    if (vid) {
      for (const old of this.ctx.getWebSockets()) {
        const m = old.deserializeAttachment();
        if (!m || m._v !== vid || m.clientId === clientId) continue;
        try { old.send(JSON.stringify({ t: 'closed', reason: 'elsewhere', message: 'This room is now open in another tab on this device. HexTV plays one room at a time on each device.' })); } catch { /* closing */ }
        old.close(4001, 'elsewhere');
      }
    }
    const created = !others.length && !this.openedAt;
    if (!this.openedAt) { this.openedAt = Date.now(); await this.ctx.storage.put('openedAt', this.openedAt); }

    this.ctx.acceptWebSocket(server, [clientId]);
    const member = {
      clientId,
      data: { name: clean(params.get('name'), 40) || 'Guest', color: clean(params.get('color'), 20) || '#555' },
      timestamp: Date.now(), _p: platform, _v: vid
    };
    server.serializeAttachment(member);
    // A fresh (or emptied and reopened) room belongs to whoever opens it, with host controls off
    if (!this.ctl.owner || created) { this.ctl = { owner: deviceOf(member), lock: false, guestsLoad: true }; await this.ctx.storage.put('ctl', this.ctl); }
    server.send(JSON.stringify({ t: 'welcome', clientId, serverTime: Date.now(), members: this.members().map(publicMember), room: this.room,
      ctl: this.ctlState(), announcement: settings.announcement || '', announcementLevel: settings.announcementLevel || 'info' }));
    this.broadcast({ t: 'presence', action: 'enter', member: publicMember(member), members: this.members().map(publicMember), ctl: this.ctlState() }, server);
    await this.ctx.storage.deleteAlarm();
    await this.report('enter', { created, inviteJoin: others.length > 0 });
    return new Response(null, { status: 101, webSocket: client });
  }

  // Admin actions, reached only through the worker's signed-in /admin routes
  async internal(action, body) {
    if (action === 'viewers') {
      return Response.json({ viewers: this.members().map(m => ({ clientId: m.clientId, name: m.data.name, platform: m._p, since: m.timestamp })) });
    }
    if (action === 'close') {
      this.broadcast({ t: 'closed', reason: 'admin', message: 'This room was closed by HexTV.' });
      for (const ws of this.ctx.getWebSockets()) ws.close(4001, 'closed');
      this.room = null;
      await this.ctx.storage.delete('room');
      await this.report('close', { viewers: 0 });
      return Response.json({ ok: true });
    }
    if (action === 'kick') {
      const target = this.ctx.getWebSockets(clean(body.clientId, 64))[0];
      if (!target) return Response.json({ ok: false, error: 'Viewer not found' });
      const m = target.deserializeAttachment() || {};
      if (m._v) {
        const blocked = (await this.ctx.storage.get('blocked')) || [];
        if (!blocked.includes(m._v)) blocked.push(m._v);
        await this.ctx.storage.put('blocked', blocked.slice(-200));
      }
      target.send(JSON.stringify({ t: 'closed', reason: 'kicked', message: 'You were removed from this room.' }));
      target.close(4001, 'kicked');
      return Response.json({ ok: true });
    }
    return Response.json({ error: 'unknown' }, { status: 404 });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_BYTES) return;
    const me = ws.deserializeAttachment();
    if (!me || !this.allow(me.clientId)) return;
    this.wsMsgs++;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const now = Date.now();

    if (msg.t === 'time') {
      ws.send(JSON.stringify({ t: 'time', id: msg.id, serverTime: now }));
    } else if (msg.t === 'presence') {
      const data = msg.data || {};
      me.data = { name: clean(data.name, 40) || me.data.name, color: clean(data.color, 20) || me.data.color };
      ws.serializeAttachment(me);
      this.broadcast({ t: 'presence', action: 'update', member: publicMember(me), members: this.members().map(publicMember) });
    } else if (msg.t === 'ctl' && msg.data && typeof msg.data === 'object') {
      await this.onControl(msg.data, me);
    } else if (msg.t === 'pub' && CHANNELS.has(msg.name) && msg.data && typeof msg.data === 'object') {
      if (msg.name === 'chat_message' && typeof msg.data.text === 'string') msg.data.text = msg.data.text.slice(0, MAX_CHAT_CHARS);
      if (msg.name === 'video_sync' && !this.mayControl(msg.data.type, me.clientId)) return;   // the page already told them why
      if (msg.name === 'video_sync' && (await this.onSync(msg.data, me.clientId, ws, now))) return;
      this.broadcast({ t: 'msg', name: msg.name, data: msg.data, clientId: me.clientId, timestamp: now }, ws);
    }
  }

  // The host: the owner's device when it's here, otherwise whoever has been here longest
  hostId(except) {
    const ms = this.members(except);
    if (!ms.length) return null;
    const owner = ms.find(m => deviceOf(m) === this.ctl.owner);
    return (owner || ms.reduce((a, b) => (b.timestamp < a.timestamp ? b : a))).clientId;
  }

  ctlState(except) {
    return { host: this.hostId(except), lock: !!this.ctl.lock, guestsLoad: this.ctl.guestsLoad !== false };
  }

  mayControl(type, clientId) {
    if (!this.ctl.lock && this.ctl.guestsLoad !== false) return true;
    if (clientId === this.hostId()) return true;
    if (type === 'load') return this.ctl.guestsLoad !== false;
    return PLAYBACK.has(type) ? !this.ctl.lock : true;
  }

  // Only the host changes the controls or hands hosting to someone else
  async onControl(data, me) {
    if (me.clientId !== this.hostId()) return;
    if (typeof data.lock === 'boolean') this.ctl.lock = data.lock;
    if (typeof data.guestsLoad === 'boolean') this.ctl.guestsLoad = data.guestsLoad;
    if (typeof data.makeHost === 'string') {
      const target = this.members().find(m => m.clientId === data.makeHost);
      if (target) this.ctl.owner = deviceOf(target);
    }
    await this.ctx.storage.put('ctl', this.ctl);
    this.broadcast({ t: 'ctl', ctl: this.ctlState(), by: me.clientId });
  }

  // Track the room clock from sync messages. Returns true when the server answered itself.
  async onSync(data, from, ws, now) {
    if (data.type === 'state_request') {
      if (!this.room || !this.room.media || !this.room.clock) return false; // let viewers answer
      ws.send(JSON.stringify({ t: 'msg', name: 'video_sync', clientId: 'server', timestamp: now,
        data: { type: 'state', to: from, media: this.room.media, clock: this.room.clock } }));
      return true;
    }
    const room = this.room || { media: null, clock: null };
    const clock = room.clock;
    const before = { title: room.media && room.media.title, playing: !!(clock && clock.playing) };
    // Play/pause/seek carry the media too, so the room knows what's on even when it was
    // started from a link rather than loaded in the room
    if (data.type !== 'load' && data.type !== 'state' && data.media && typeof data.media === 'object') room.media = data.media;
    if (data.type === 'load') {
      room.media = data.media || (data.src ? { url: data.src, title: data.title || '' } : room.media);
      room.clock = { playing: false, time: 0, at: now };
    } else if (data.type === 'play') {
      room.clock = { playing: true, time: num(data.time), at: num(data.at) || now };
    } else if (data.type === 'pause') {
      room.clock = { playing: false, time: num(data.time), at: now };
    } else if (data.type === 'seek') {
      const playing = typeof data.playing === 'boolean' ? data.playing : !!(clock && clock.playing);
      room.clock = { playing, time: num(data.time), at: num(data.at) || now };
    } else if (data.type === 'state' && !room.media && data.media) {
      // A viewer described the room before the server knew it (e.g. after a cleanup)
      room.media = data.media;
      room.clock = data.clock || room.clock;
    } else {
      return false;
    }
    this.room = room;
    await this.ctx.storage.put('room', room);
    // The dashboard's live view only needs to hear about what changed
    const after = { title: room.media && room.media.title, playing: !!(room.clock && room.clock.playing) };
    if (after.title !== before.title || after.playing !== before.playing) await this.report('state');
    return false;
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch { /* already closed */ }
    await this.leave(ws);
  }

  async webSocketError(ws) {
    await this.leave(ws);
  }

  async leave(ws) {
    const me = ws.deserializeAttachment();
    const others = this.ctx.getWebSockets().filter(s => s !== ws && s.readyState === WebSocket.READY_STATE_OPEN);
    if (me) this.broadcast({ t: 'presence', action: 'leave', member: publicMember(me), members: this.members(ws).map(publicMember), ctl: this.ctlState(ws) }, ws);
    if (!others.length) {
      await this.report('close', { viewers: 0 });
      this.openedAt = null;
      await this.ctx.storage.delete('openedAt');
      await this.ctx.storage.setAlarm(Date.now() + IDLE_CLEANUP_MS);
    } else {
      await this.report('leave');
    }
  }

  async alarm() {
    if (!this.ctx.getWebSockets().length) {
      this.room = null;
      this.ctl = { owner: '', lock: false, guestsLoad: true };
      const name = this.name;
      await this.ctx.storage.deleteAll();
      if (name) await this.ctx.storage.put('name', name);
    }
  }

  members(except) {
    return this.ctx.getWebSockets()
      .filter(ws => ws !== except && ws.readyState === WebSocket.READY_STATE_OPEN)
      .map(ws => ws.deserializeAttachment())
      .filter(Boolean);
  }

  broadcast(obj, except) {
    const text = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try { ws.send(text); } catch { /* closing */ }
    }
  }

  allow(clientId) {
    const now = Date.now();
    const r = this.rates.get(clientId);
    if (!r || now - r.start > RATE_WINDOW_MS) {
      this.rates.set(clientId, { start: now, count: 1 });
      return true;
    }
    return ++r.count <= RATE_MAX;
  }
}

const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
