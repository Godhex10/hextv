/* StreamTogether room server — one Durable Object per watch-party room.

   Clients connect with a WebSocket to /room/<roomId>?clientId=&name=&color=.
   The room relays chat, reactions and sync messages between its viewers, keeps
   the viewer list, and remembers what's playing plus the shared room clock, so
   a newcomer gets the room's state straight from the server.

   Uses the WebSocket Hibernation API: an idle room is evicted from memory
   without dropping its connections, and isn't billed while it sleeps. */
import { DurableObject } from 'cloudflare:workers';

const MAX_MESSAGE_BYTES = 8 * 1024;
const MAX_CHAT_CHARS = 500;
const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 40;                     // messages per viewer per window; the rest are dropped
const IDLE_CLEANUP_MS = 24 * 3600_000;   // forget an empty room's state after a day
const CHANNELS = new Set(['video_sync', 'chat_message', 'reaction']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/') return new Response('StreamTogether room server');
    const m = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{1,64})$/);
    if (!m) return new Response('Not found', { status: 404 });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(request);
  }
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = null;           // { media, clock } — what's playing and where
    this.rates = new Map();     // clientId -> { start, count }; fine to lose on eviction
    ctx.blockConcurrencyWhile(async () => { this.room = (await ctx.storage.get('room')) || null; });
    // Keepalive pings are answered without waking the room
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    const params = new URL(request.url).searchParams;
    const clientId = clean(params.get('clientId'), 64) || crypto.randomUUID();
    // A reconnecting viewer replaces their old socket instead of appearing twice
    for (const old of this.ctx.getWebSockets(clientId)) old.close(4000, 'replaced');

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [clientId]);
    const member = {
      clientId,
      data: { name: clean(params.get('name'), 40) || 'Guest', color: clean(params.get('color'), 20) || '#555' },
      timestamp: Date.now()
    };
    server.serializeAttachment(member);
    server.send(JSON.stringify({ t: 'welcome', clientId, serverTime: Date.now(), members: this.members(), room: this.room }));
    this.broadcast({ t: 'presence', action: 'enter', member, members: this.members() }, server);
    await this.ctx.storage.deleteAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_BYTES) return;
    const me = ws.deserializeAttachment();
    if (!me || !this.allow(me.clientId)) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const now = Date.now();

    if (msg.t === 'time') {
      ws.send(JSON.stringify({ t: 'time', id: msg.id, serverTime: now }));
    } else if (msg.t === 'presence') {
      const data = msg.data || {};
      me.data = { name: clean(data.name, 40) || me.data.name, color: clean(data.color, 20) || me.data.color };
      ws.serializeAttachment(me);
      this.broadcast({ t: 'presence', action: 'update', member: me, members: this.members() });
    } else if (msg.t === 'pub' && CHANNELS.has(msg.name) && msg.data && typeof msg.data === 'object') {
      if (msg.name === 'chat_message' && typeof msg.data.text === 'string') msg.data.text = msg.data.text.slice(0, MAX_CHAT_CHARS);
      if (msg.name === 'video_sync' && (await this.onSync(msg.data, me.clientId, ws, now))) return;
      this.broadcast({ t: 'msg', name: msg.name, data: msg.data, clientId: me.clientId, timestamp: now }, ws);
    }
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
    const others = this.ctx.getWebSockets().filter(s => s !== ws);
    if (me) this.broadcast({ t: 'presence', action: 'leave', member: me, members: this.members(ws) }, ws);
    if (!others.length) await this.ctx.storage.setAlarm(Date.now() + IDLE_CLEANUP_MS);
  }

  async alarm() {
    if (!this.ctx.getWebSockets().length) {
      this.room = null;
      await this.ctx.storage.deleteAll();
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
