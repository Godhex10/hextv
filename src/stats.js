/* HexTV stats — one Durable Object ("global") that collects everything the dashboard shows.

   Inputs:
     - rooms report presence/media/playing changes            POST /report
     - pages send anonymous telemetry every few minutes        POST /telemetry
     - the cron trigger runs health checks and alert rules     POST /cron
   Outputs:
     - the dashboard summary                                   GET  /summary?days=1|7|30
     - public settings for pages (announcement, pause switch)  GET  /config

   Writes are budgeted for the free plan: counters accumulate in memory and are flushed once a
   minute (one row per metric per hour), so a busy hour costs dozens of row writes, not thousands.
   Viewers are anonymous random ids; no names, IPs or exact locations are stored. */
import { DurableObject } from 'cloudflare:workers';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const FLUSH_MS = 60_000;
const VERCEL_FREE_BYTES = 100 * 1024 ** 3;   // Vercel Hobby: ~100 GB transfer a month
const CF_FREE_REQUESTS = 100_000;            // Workers Free: 100k requests a day
const KEEP_DAYS = 45;

const hourOf = t => Math.floor(t / HOUR) * HOUR;
const dayOf = t => new Date(t).toISOString().slice(0, 10);
const clamp = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// Metric names a client may add to (anything else is ignored)
const CLIENT_COUNTERS = new Set(['sessions', 'watch_s', 'watch_relay_s', 'relay_bytes', 'startup_ms_sum', 'startup_n',
  'buffer_n', 'buffer_s', 'drift_sum', 'drift_n', 'behind_n', 'step_downs', 'slow_mode_n', 'chat_n', 'react_n',
  'err_lookup', 'err_relay', 'err_youtube', 'err_room', 'err_subs', 'searches', 'searches_empty', 'title_join']);
const ERROR_KINDS = new Set(['lookup', 'relay', 'youtube', 'room', 'subs']);

export class Stats extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.pending = new Map();     // `${hour}|${name}` -> delta
    this.peaks = new Map();       // `${hour}|${name}` -> max
    this.titleDeltas = new Map(); // `${day}|${key}` -> { title, type, joins, watch_s }
    this.lastFlush = Date.now();
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS counters (hour INTEGER, name TEXT, value REAL, PRIMARY KEY (hour, name));
      CREATE TABLE IF NOT EXISTS peaks (hour INTEGER, name TEXT, value REAL, PRIMARY KEY (hour, name));
      CREATE TABLE IF NOT EXISTS live (room TEXT PRIMARY KEY, viewers INTEGER, web INTEGER, app INTEGER, mtype TEXT,
        title TEXT, playing INTEGER, opened_at INTEGER, updated_at INTEGER);
      CREATE TABLE IF NOT EXISTS viewers (day TEXT, vid TEXT, platform TEXT, PRIMARY KEY (day, vid));
      CREATE TABLE IF NOT EXISTS first_seen (vid TEXT PRIMARY KEY, day TEXT);
      CREATE TABLE IF NOT EXISTS dims (day TEXT, dim TEXT, val TEXT, n INTEGER, PRIMARY KEY (day, dim, val));
      CREATE TABLE IF NOT EXISTS titles (day TEXT, tkey TEXT, title TEXT, type TEXT, joins INTEGER, watch_s REAL, PRIMARY KEY (day, tkey));
      CREATE TABLE IF NOT EXISTS searches (day TEXT, q TEXT, n INTEGER, empty INTEGER, PRIMARY KEY (day, q));
      CREATE TABLE IF NOT EXISTS health (at INTEGER PRIMARY KEY, ok INTEGER, ms INTEGER, detail TEXT);
      CREATE TABLE IF NOT EXISTS errlog (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, kind TEXT, detail TEXT, platform TEXT);
      CREATE TABLE IF NOT EXISTS alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, level TEXT, akey TEXT, title TEXT, detail TEXT, sent INTEGER);
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
    `);
  }

  /* ── buffered counters ── */
  add(name, value, at = Date.now()) {
    if (!value) return;
    const k = hourOf(at) + '|' + name;
    this.pending.set(k, (this.pending.get(k) || 0) + value);
    this.scheduleFlush();
  }
  peak(name, value, at = Date.now()) {
    const k = hourOf(at) + '|' + name;
    if (value > (this.peaks.get(k) ?? -1)) this.peaks.set(k, value);
    this.scheduleFlush();
  }
  scheduleFlush() {
    if (Date.now() - this.lastFlush > FLUSH_MS) this.flush();
    else this.ctx.storage.getAlarm().then(a => { if (!a) this.ctx.storage.setAlarm(Date.now() + FLUSH_MS); });
  }
  async alarm() { this.flush(); }

  flush() {
    this.lastFlush = Date.now();
    for (const [k, v] of this.pending) {
      const [hour, name] = k.split('|');
      this.sql.exec('INSERT INTO counters (hour, name, value) VALUES (?, ?, ?) ON CONFLICT (hour, name) DO UPDATE SET value = value + excluded.value',
        Number(hour), name, v);
    }
    for (const [k, v] of this.peaks) {
      const [hour, name] = k.split('|');
      this.sql.exec('INSERT INTO peaks (hour, name, value) VALUES (?, ?, ?) ON CONFLICT (hour, name) DO UPDATE SET value = MAX(value, excluded.value)',
        Number(hour), name, v);
    }
    for (const [k, t] of this.titleDeltas) {
      const [day, tkey] = k.split('|');
      this.sql.exec(`INSERT INTO titles (day, tkey, title, type, joins, watch_s) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (day, tkey) DO UPDATE SET joins = joins + excluded.joins, watch_s = watch_s + excluded.watch_s,
        title = CASE WHEN excluded.title != '' THEN excluded.title ELSE title END`, day, tkey, t.title, t.type, t.joins, t.watch_s);
    }
    this.pending.clear();
    this.peaks.clear();
    this.titleDeltas.clear();
  }

  kvGet(k) { const r = this.sql.exec('SELECT v FROM kv WHERE k = ?', k).toArray()[0]; return r ? r.v : null; }
  kvSet(k, v) { this.sql.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', k, String(v)); }

  settings() {
    return {
      announcement: this.kvGet('announcement') || '',
      announcementLevel: this.kvGet('announcementLevel') || 'info',
      newRoomsPaused: this.kvGet('newRoomsPaused') === '1'
    };
  }

  /* ── request router (internal: only the worker and rooms call this object) ── */
  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
    const route = url.pathname;
    let out;
    if (route === '/report') out = this.onRoomReport(body);
    else if (route === '/telemetry') out = this.onTelemetry(body);
    else if (route === '/config') { this.add('config_hits', 1); out = this.settings(); }
    else if (route === '/summary') out = this.summary(Math.min(30, Math.max(1, Number(url.searchParams.get('days')) || 1)));
    else if (route === '/settings') out = this.saveSettings(body);
    else if (route === '/signing-key') out = { key: this.signingKey() };
    else if (route === '/cron') out = await this.onCron();
    else if (route === '/test-alert') out = await this.notify('info', 'test', 'Test alert from HexTV', 'If you can read this, alerts are working.', true);
    else return new Response('Not found', { status: 404 });
    return Response.json(out ?? { ok: true });
  }

  signingKey() {
    let key = this.kvGet('signing_key');
    if (!key) {
      key = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
      this.kvSet('signing_key', key);
    }
    return key;
  }

  /* ── rooms ── */
  onRoomReport(r) {
    const now = Date.now();
    this.add('reports', 1);
    if (r.created) this.add('rooms_created', 1);
    if (r.event === 'enter') { this.add('joins', 1); if (r.inviteJoin) this.add('invite_joins', 1); }
    if (r.wsMsgs) this.add('ws_msgs', num(r.wsMsgs));
    const room = clamp(r.room, 64);
    if (!room) return;
    if (r.event === 'close' || !r.viewers) {
      const row = this.sql.exec('SELECT opened_at FROM live WHERE room = ?', room).toArray()[0];
      const opened = num(r.openedAt) || (row && row.opened_at);
      if (opened) { this.add('room_seconds', Math.max(0, (now - opened) / 1000)); this.add('rooms_closed', 1); }
      this.sql.exec('DELETE FROM live WHERE room = ?', room);
    } else {
      const m = r.media || {};
      this.sql.exec(`INSERT INTO live (room, viewers, web, app, mtype, title, playing, opened_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (room) DO UPDATE SET viewers = excluded.viewers, web = excluded.web, app = excluded.app, mtype = excluded.mtype,
        title = excluded.title, playing = excluded.playing, updated_at = excluded.updated_at`,
        room, num(r.viewers), num(r.web), num(r.app), clamp(m.type, 12), clamp(m.title, 120), r.playing ? 1 : 0, num(r.openedAt) || now, now);
    }
    // Rooms that never reported closing (a crash) shouldn't stay "live" forever
    this.sql.exec('DELETE FROM live WHERE updated_at < ?', now - 8 * HOUR);
    const live = this.sql.exec('SELECT COUNT(*) AS rooms, COALESCE(SUM(viewers), 0) AS viewers FROM live').one();
    this.peak('peak_viewers', live.viewers);
    this.peak('peak_rooms', live.rooms);
  }

  /* ── page telemetry ── */
  onTelemetry(t) {
    const now = Date.now();
    const day = dayOf(now);
    const vid = clamp(t.vid, 40);
    const platform = ['app', 'windows'].includes(t.platform) ? t.platform : 'web';
    this.add('beacons', 1);
    const c = t.c && typeof t.c === 'object' ? t.c : {};
    for (const [name, v] of Object.entries(c)) if (CLIENT_COUNTERS.has(name)) this.add(name, Math.min(num(v), 1e12));
    if (platform !== 'web') this.add('watch_s_app', num(c.watch_s));

    if (vid) {
      const inserted = this.sql.exec('INSERT OR IGNORE INTO viewers (day, vid, platform) VALUES (?, ?, ?)', day, vid, platform).rowsWritten;
      if (inserted) {
        this.sql.exec('INSERT OR IGNORE INTO first_seen (vid, day) VALUES (?, ?)', vid, day);
        // Audience breakdowns count each viewer once a day
        const dims = { country: clamp(t.country, 2) || 'XX', device: clamp(t.device, 12), os: clamp(t.os, 16),
          browser: clamp(t.browser, 20), platform, app_version: platform !== 'web' ? (platform === 'windows' ? 'win ' : 'android ') + clamp(t.appVersion, 16) : '' };
        for (const [dim, val] of Object.entries(dims)) {
          if (!val) continue;
          this.sql.exec('INSERT INTO dims (day, dim, val, n) VALUES (?, ?, ?, 1) ON CONFLICT (day, dim, val) DO UPDATE SET n = n + 1', day, dim, val);
        }
      }
    }
    if (t.title && typeof t.title === 'object' && t.title.key) {
      const key = clamp(t.title.key, 120);
      const k = day + '|' + key;
      const cur = this.titleDeltas.get(k) || { title: clamp(t.title.title, 120), type: clamp(t.title.type, 12), joins: 0, watch_s: 0 };
      cur.joins += c.title_join ? 1 : 0;
      cur.watch_s += Math.min(num(c.watch_s), 3600);
      if (t.title.title) cur.title = clamp(t.title.title, 120);
      this.titleDeltas.set(k, cur);
    }
    for (const s of Array.isArray(t.searches) ? t.searches.slice(0, 20) : []) {
      const q = clamp(String(s.q || '').toLowerCase().trim(), 60);
      if (!q) continue;
      this.sql.exec('INSERT INTO searches (day, q, n, empty) VALUES (?, ?, 1, ?) ON CONFLICT (day, q) DO UPDATE SET n = n + 1, empty = empty + excluded.empty',
        day, q, s.n ? 0 : 1);
    }
    for (const e of Array.isArray(t.errors) ? t.errors.slice(0, 10) : []) {
      if (!ERROR_KINDS.has(e.kind)) continue;
      this.sql.exec('INSERT INTO errlog (at, kind, detail, platform) VALUES (?, ?, ?, ?)', now, e.kind, clamp(e.detail, 160), platform);
    }
  }

  /* ── settings & alerts ── */
  saveSettings(s) {
    if (typeof s.announcement === 'string') this.kvSet('announcement', s.announcement.slice(0, 280));
    if (typeof s.announcementLevel === 'string') this.kvSet('announcementLevel', ['info', 'warning'].includes(s.announcementLevel) ? s.announcementLevel : 'info');
    if (typeof s.newRoomsPaused === 'boolean') this.kvSet('newRoomsPaused', s.newRoomsPaused ? '1' : '0');
    return this.settings();
  }

  telegramReady() { return !!(this.env.TELEGRAM_BOT_TOKEN && this.env.TELEGRAM_CHAT_ID); }

  // Record an alert (deduplicated per key for 3 hours) and send it to Telegram when configured
  async notify(level, akey, title, detail, force) {
    const now = Date.now();
    if (!force) {
      const recent = this.sql.exec('SELECT at FROM alerts WHERE akey = ? ORDER BY at DESC LIMIT 1', akey).toArray()[0];
      if (recent && now - recent.at < 3 * HOUR) return { skipped: true };
    }
    let sent = 0;
    if (this.telegramReady()) {
      const text = `[${level.toUpperCase()}] HexTV — ${title}\n${detail}`;
      try {
        const r = await fetch(`https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: this.env.TELEGRAM_CHAT_ID, text })
        });
        sent = r.ok ? 1 : 0;
      } catch (e) { /* recorded as unsent */ }
    }
    this.sql.exec('INSERT INTO alerts (at, level, akey, title, detail, sent) VALUES (?, ?, ?, ?, ?, ?)', now, level, akey, title, detail, sent);
    return { sent: !!sent, telegram: this.telegramReady() };
  }

  async onCron() {
    this.flush();
    const now = Date.now();
    // 1. MovieBox health: the library rows and one stream lookup, through our own API
    const base = (this.env.API_BASE || '').replace(/\/$/, '');
    let ok = 0, ms = 0, detail = '';
    if (base) {
      const t0 = Date.now();
      try {
        const [home, stream] = await Promise.all([
          fetch(base + '/catalog/home', { headers: { 'User-Agent': 'HexTV-health' } }),
          fetch(base + '/api/stream/6391474290696802080', { headers: { 'User-Agent': 'HexTV-health' } })
        ]);
        const s = stream.ok ? await stream.json() : {};
        ok = home.ok && stream.ok && (s.streams || []).length > 0 ? 1 : 0;
        detail = ok ? '' : `library ${home.status}, lookup ${stream.status}${stream.ok ? ' (no streams)' : ''}`;
      } catch (e) { detail = 'unreachable: ' + (e.message || 'error'); }
      ms = Date.now() - t0;
      this.sql.exec('INSERT OR REPLACE INTO health (at, ok, ms, detail) VALUES (?, ?, ?, ?)', now, ok, ms, detail);
      this.add(ok ? 'health_ok' : 'health_fail', 1);
    }

    // 2. Alert rules
    const last2 = this.sql.exec('SELECT ok FROM health ORDER BY at DESC LIMIT 2').toArray();
    if (last2.length === 2 && last2.every(h => !h.ok)) {
      await this.notify('critical', 'moviebox_down', 'MovieBox is not answering', `The last two health checks failed (${detail || 'unknown error'}). Search and playback are probably down.`);
    } else if (ok && ms > 8000) {
      await this.notify('warning', 'moviebox_slow', 'MovieBox is slow', `A health check took ${(ms / 1000).toFixed(1)}s.`);
    }
    const lim = this.limits();
    for (const [key, used, label] of [['cf', lim.cloudflare.pct, 'Cloudflare room-server requests today'], ['vercel', lim.vercel.pct, 'Vercel video traffic this month']]) {
      if (used >= 0.9) await this.notify('critical', key + '_90', `${label} at ${Math.round(used * 100)}%`, 'The free limit is nearly used up; the service may stop until it resets.');
      else if (used >= 0.7) await this.notify('warning', key + '_70', `${label} at ${Math.round(used * 100)}%`, 'Keep an eye on it.');
    }
    const errNow = this.sql.exec("SELECT COUNT(*) AS n FROM errlog WHERE at > ?", now - HOUR).one().n;
    const errDay = this.sql.exec("SELECT COUNT(*) AS n FROM errlog WHERE at > ? AND at <= ?", now - 25 * HOUR, now - HOUR).one().n;
    if (errNow >= Math.max(15, (errDay / 24) * 3)) {
      await this.notify('warning', 'error_spike', 'Error spike', `${errNow} playback errors in the last hour (usually ${Math.round(errDay / 24)}).`);
    }

    // 3. Housekeeping
    const cutoff = now - KEEP_DAYS * DAY;
    const cutDay = dayOf(cutoff);
    this.sql.exec('DELETE FROM counters WHERE hour < ?', cutoff);
    this.sql.exec('DELETE FROM peaks WHERE hour < ?', cutoff);
    for (const t of ['viewers', 'dims', 'titles', 'searches']) this.sql.exec(`DELETE FROM ${t} WHERE day < ?`, cutDay);
    this.sql.exec('DELETE FROM health WHERE at < ?', now - 8 * DAY);
    this.sql.exec('DELETE FROM errlog WHERE id NOT IN (SELECT id FROM errlog ORDER BY id DESC LIMIT 400)');
    this.sql.exec('DELETE FROM alerts WHERE id NOT IN (SELECT id FROM alerts ORDER BY id DESC LIMIT 200)');
    return { ok, ms };
  }

  /* ── dashboard ── */
  sumSince(since, names) {
    const out = Object.fromEntries(names.map(n => [n, 0]));
    const rows = this.sql.exec(`SELECT name, SUM(value) AS v FROM counters WHERE hour >= ? AND name IN (${names.map(() => '?').join(',')}) GROUP BY name`, since, ...names).toArray();
    for (const r of rows) out[r.name] = r.v;
    return out;
  }

  limits() {
    const now = Date.now();
    const d = new Date(now);
    const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const m = this.sumSince(monthStart, ['relay_bytes']);
    const t = this.sumSince(dayStart, ['joins', 'beacons', 'config_hits', 'reports', 'ws_msgs', 'admin_calls', 'health_ok', 'health_fail']);
    // Workers bill incoming WebSocket messages at 20:1; everything else is one request each
    const cfToday = t.joins + t.beacons + t.config_hits + t.reports + t.admin_calls + t.health_ok + t.health_fail + t.ws_msgs / 20;
    const vercelBytes = m.relay_bytes;
    return {
      vercel: { used: vercelBytes, limit: VERCEL_FREE_BYTES, pct: vercelBytes / VERCEL_FREE_BYTES, resets: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) },
      cloudflare: { used: Math.round(cfToday), limit: CF_FREE_REQUESTS, pct: cfToday / CF_FREE_REQUESTS, resets: dayStart + DAY },
      storage: { used: this.ctx.storage.sql.databaseSize, limit: 1024 ** 3, pct: this.ctx.storage.sql.databaseSize / 1024 ** 3 }
    };
  }

  summary(days) {
    this.flush();
    this.add('admin_calls', 1);
    const now = Date.now();
    const since = days === 1 ? hourOf(now - 23 * HOUR) : Date.parse(dayOf(now - (days - 1) * DAY));
    const sinceDay = dayOf(since);
    const bucketMs = days === 1 ? HOUR : DAY;
    const nBuckets = days === 1 ? 24 : days;

    // Time series
    const series = Array.from({ length: nBuckets }, (_, i) => ({ t: since + i * bucketMs }));
    const idx = t => Math.min(nBuckets - 1, Math.floor((t - since) / bucketMs));
    for (const r of this.sql.exec('SELECT hour, name, value FROM counters WHERE hour >= ?', since).toArray()) {
      const b = series[idx(r.hour)];
      if (b) b[r.name] = (b[r.name] || 0) + r.value;
    }
    for (const r of this.sql.exec('SELECT hour, name, value FROM peaks WHERE hour >= ?', since).toArray()) {
      const b = series[idx(r.hour)];
      if (b) b[r.name] = Math.max(b[r.name] || 0, r.value);
    }
    if (days > 1) {
      for (const r of this.sql.exec('SELECT day, COUNT(*) AS n FROM viewers WHERE day >= ? GROUP BY day', sinceDay).toArray()) {
        const b = series[idx(Date.parse(r.day))];
        if (b) b.unique = r.n;
      }
    }
    const tot = this.sumSince(since, ['rooms_created', 'joins', 'invite_joins', 'watch_s', 'watch_s_app', 'chat_n', 'react_n', 'room_seconds', 'rooms_closed',
      'room_size_sum', 'startup_ms_sum', 'startup_n', 'buffer_n', 'buffer_s', 'drift_sum', 'drift_n', 'behind_n', 'step_downs', 'slow_mode_n',
      'err_lookup', 'err_relay', 'err_youtube', 'err_room', 'err_subs', 'sessions', 'searches', 'searches_empty', 'health_ok', 'health_fail']);
    const unique = this.sql.exec('SELECT COUNT(DISTINCT vid) AS n FROM viewers WHERE day >= ?', sinceDay).one().n;
    const returning = this.sql.exec(`SELECT COUNT(DISTINCT v.vid) AS n FROM viewers v JOIN first_seen f ON f.vid = v.vid
      WHERE v.day >= ? AND f.day < v.day`, sinceDay).one().n;

    const live = this.sql.exec('SELECT * FROM live WHERE updated_at > ? ORDER BY viewers DESC, updated_at DESC LIMIT 100', now - 8 * HOUR).toArray();
    const todayStart = hourOf(now - (now % DAY));
    const peakToday = this.sql.exec("SELECT COALESCE(MAX(value), 0) AS v FROM peaks WHERE name = 'peak_viewers' AND hour >= ?", todayStart).one().v;

    const rows = (q, ...b) => this.sql.exec(q, ...b).toArray();
    const dim = d => rows('SELECT val, SUM(n) AS n FROM dims WHERE day >= ? AND dim = ? GROUP BY val ORDER BY n DESC LIMIT 12', sinceDay, d);

    const watchH = tot.watch_s / 3600;
    return {
      now, days, since,
      live: {
        rooms: live, roomsCount: live.length,
        viewers: live.reduce((s, r) => s + r.viewers, 0),
        web: live.reduce((s, r) => s + r.web, 0), app: live.reduce((s, r) => s + r.app, 0),
        peakToday
      },
      usage: {
        series,
        totals: {
          roomsCreated: tot.rooms_created, uniqueViewers: unique, returning, joins: tot.joins, inviteJoins: tot.invite_joins,
          watchHours: watchH, appWatchHours: tot.watch_s_app / 3600, chat: tot.chat_n, reactions: tot.react_n, sessions: tot.sessions,
          avgRoomMinutes: tot.rooms_closed ? tot.room_seconds / tot.rooms_closed / 60 : 0,
          avgRoomSize: tot.rooms_created ? tot.joins / tot.rooms_created : 0
        }
      },
      content: {
        titles: rows(`SELECT tkey, MAX(title) AS title, MAX(type) AS type, SUM(joins) AS joins, SUM(watch_s) AS watch_s FROM titles
          WHERE day >= ? GROUP BY tkey ORDER BY watch_s DESC, joins DESC LIMIT 12`, sinceDay),
        types: rows('SELECT type, SUM(joins) AS joins, SUM(watch_s) AS watch_s FROM titles WHERE day >= ? GROUP BY type', sinceDay),
        searches: rows('SELECT q, SUM(n) AS n FROM searches WHERE day >= ? GROUP BY q ORDER BY n DESC LIMIT 12', sinceDay),
        emptySearches: rows('SELECT q, SUM(empty) AS n FROM searches WHERE day >= ? GROUP BY q HAVING SUM(empty) > 0 ORDER BY n DESC LIMIT 10', sinceDay),
        searchTotal: tot.searches, searchEmpty: tot.searches_empty
      },
      quality: {
        startupAvgS: tot.startup_n ? tot.startup_ms_sum / tot.startup_n / 1000 : null,
        bufferPerHour: watchH > 0 ? tot.buffer_n / watchH : null,
        bufferAvgS: tot.buffer_n ? tot.buffer_s / tot.buffer_n : null,
        driftAvgS: tot.drift_n ? tot.drift_sum / tot.drift_n : null,
        behindPerHour: watchH > 0 ? tot.behind_n / watchH : null,
        stepDowns: tot.step_downs, slowMode: tot.slow_mode_n,
        errors: { lookup: tot.err_lookup, relay: tot.err_relay, youtube: tot.err_youtube, room: tot.err_room, subs: tot.err_subs },
        errlog: rows('SELECT at, kind, detail, platform FROM errlog ORDER BY id DESC LIMIT 25'),
        health: {
          checks: rows('SELECT at, ok, ms, detail FROM health WHERE at > ? ORDER BY at ASC', now - 2 * DAY).slice(-192),
          uptime: (tot.health_ok + tot.health_fail) ? tot.health_ok / (tot.health_ok + tot.health_fail) : null
        }
      },
      limits: this.limits(),
      audience: {
        country: dim('country'), device: dim('device'), os: dim('os'), browser: dim('browser'),
        platform: dim('platform'), appVersion: dim('app_version')
      },
      alerts: { list: rows('SELECT at, level, title, detail, sent FROM alerts ORDER BY id DESC LIMIT 30'), telegram: this.telegramReady() },
      settings: this.settings()
    };
  }
}
