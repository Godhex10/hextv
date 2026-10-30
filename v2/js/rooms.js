/* Client for our own room server (room-server/ on Cloudflare).

   It mirrors the small part of the Ably API the room page uses —
   connection.on, auth.clientId, time(), channels.get(), channel.publish/
   subscribe and channel.presence.update/get/subscribe — so the page can run
   on either service by changing MB.ROOMS. */
(function () {
  'use strict';

  const PING_MS = 25000;
  const QUEUED = new Set(['chat_message', 'reaction']); // sync is never replayed late: the room state wins

  function RoomSocket(opts) {
    this.opts = opts;
    this.auth = { clientId: opts.clientId };
    this._handlers = {};
    this._subs = {};
    this._presenceSubs = [];
    this._ctlSubs = [];
    this._members = [];
    this._ctl = null;      // host controls: { host, lock, guestsLoad } (our server only)
    this._queue = [];
    this._timeReqs = new Map();
    this._seq = 0;
    this._attempt = 0;
    this._everConnected = false;
    this._open = false;

    const self = this;
    this.connection = { on(evt, cb) { (self._handlers[evt] = self._handlers[evt] || []).push(cb); } };
    const channel = {
      subscribe(name, cb) { (self._subs[name] = self._subs[name] || []).push(cb); },
      publish(name, data) {
        if (!self._send({ t: 'pub', name, data }) && QUEUED.has(name)) self._queue.push({ t: 'pub', name, data });
        return Promise.resolve();
      },
      presence: {
        subscribe(cb) { self._presenceSubs.push(cb); },
        update(data) {
          self.opts.name = data.name;
          self.opts.color = data.color;
          self._send({ t: 'presence', data });
          return Promise.resolve();
        },
        get() { return Promise.resolve(self._members.slice()); }
      },
      // Host controls; set() is only accepted from the host
      control: {
        get: () => self._ctl,
        subscribe(cb) { self._ctlSubs.push(cb); },
        set(data) { return self._send({ t: 'ctl', data }); }
      }
    };
    this.channels = { get: () => channel };
    this._connect();
  }

  RoomSocket.prototype.time = function () {
    const id = ++this._seq;
    return new Promise((resolve, reject) => {
      if (!this._send({ t: 'time', id })) return reject(new Error('not connected'));
      this._timeReqs.set(id, resolve);
      setTimeout(() => { if (this._timeReqs.delete(id)) reject(new Error('timeout')); }, 5000);
    });
  };

  RoomSocket.prototype._emit = function (evt, arg) {
    (this._handlers[evt] || []).forEach(cb => { try { cb(arg); } catch (e) { console.error(e); } });
  };

  RoomSocket.prototype._send = function (obj) {
    if (!this._open) return false;
    try { this._ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
  };

  RoomSocket.prototype._connect = function () {
    const o = this.opts;
    const url = new URL(o.url.replace(/\/$/, '') + '/room/' + encodeURIComponent(o.room));
    url.searchParams.set('clientId', o.clientId);
    url.searchParams.set('name', o.name || '');
    url.searchParams.set('color', o.color || '');
    // Anonymous stats id and web/app, so the dashboard can count viewers (see telemetry.js)
    try { url.searchParams.set('vid', localStorage.getItem('hx_vid') || ''); } catch (e) { /* private mode */ }
    url.searchParams.set('platform', window.HexDesktop ? 'windows'
      : window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform() ? 'app' : 'web');
    const ws = new WebSocket(url.toString());
    this._ws = ws;

    ws.onmessage = e => {
      if (e.data === 'pong') return;
      let msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      this._onMessage(msg);
    };
    ws.onclose = () => {
      const wasOpen = this._open;
      this._open = false;
      clearInterval(this._ping);
      if (wasOpen) this._emit('disconnected');
      if (this._closed) return;   // the server ended this room for us: don't knock again
      this._attempt++;
      if (!this._everConnected && this._attempt === 3) this._emit('failed');
      // Back off 0.5s, 1s, 2s ... up to 10s, forever: the room comes back when the network does
      setTimeout(() => this._connect(), Math.min(10000, 500 * 2 ** Math.min(this._attempt, 5)));
    };
  };

  RoomSocket.prototype._setCtl = function (ctl, by) {
    if (!ctl) return;
    const before = this._ctl;
    this._ctl = ctl;
    this._ctlSubs.forEach(cb => { try { cb(ctl, before, by); } catch (e) { console.error(e); } });
  };

  RoomSocket.prototype._onMessage = function (msg) {
    if (msg.t === 'welcome') {
      this._open = true;
      this._attempt = 0;
      this._everConnected = true;
      this._members = msg.members || [];
      clearInterval(this._ping);
      this._ping = setInterval(() => { try { this._ws.send('ping'); } catch (e) { /* reconnecting */ } }, PING_MS);
      const queued = this._queue.splice(0);
      queued.forEach(m => this._send(m));
      // A new socket never replays what was missed, so the page re-syncs from the room
      this._emit('connected', { resumed: false });
      this._setCtl(msg.ctl);
    } else if (msg.t === 'msg') {
      (this._subs[msg.name] || []).forEach(cb => cb({ name: msg.name, data: msg.data, clientId: msg.clientId, timestamp: msg.timestamp }));
    } else if (msg.t === 'presence') {
      this._members = msg.members || this._members;
      const m = msg.member || {};
      this._presenceSubs.forEach(cb => cb({ action: msg.action, clientId: m.clientId, data: m.data, timestamp: m.timestamp }));
      this._setCtl(msg.ctl);
    } else if (msg.t === 'ctl') {
      this._setCtl(msg.ctl, msg.by);
    } else if (msg.t === 'closed') {
      // Room closed by the admin, viewer removed, or new rooms paused
      this._closed = true;
      this._emit('closed', msg);
    } else if (msg.t === 'time') {
      const resolve = this._timeReqs.get(msg.id);
      if (resolve) { this._timeReqs.delete(msg.id); resolve(msg.serverTime); }
    }
  };

  window.RoomSocket = RoomSocket;
})();
