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
// Plans and prices the dashboard compares against (checked 2026-10-31):
// Vercel Pro, Cape Town region — vercel.com/docs/plans/pro-plan, /docs/pricing/regional-pricing/cpt1.
// $20 credit each calendar month spent on usage; Pro also includes 1 TB of transfer and 1M CDN requests.
const VERCEL_PRO = { credit: 20, fotPerGB: 0.43, fdtPerGB: 0.28, fdtIncludedGB: 1000, reqPerMillion: 2.80, reqIncluded: 1_000_000, cpuPerHour: 0.20, memPerGBh: 0.0166 };
// Cloudflare Workers Free — developers.cloudflare.com/workers/platform/limits and /durable-objects/platform/pricing.
// Daily limits reset at 00:00 UTC; incoming WebSocket messages count as 1 request per 20.
const CF_FREE = { workerRequests: 100_000, doRequests: 100_000, doGBs: 13_000, rowsRead: 5_000_000, rowsWritten: 100_000, storageBytes: 5 * 1024 ** 3 };
const GB = 1e9;   // Vercel bills decimal gigabytes
const KEEP_DAYS = 45;

const hourOf = t => Math.floor(t / HOUR) * HOUR;
const dayOf = t => new Date(t).toISOString().slice(0, 10);
const clamp = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// Metric names a client may add to (anything else is ignored)
const CLIENT_COUNTERS = new Set(['sessions', 'watch_s', 'watch_relay_s', 'relay_bytes', 'startup_ms_sum', 'startup_n',
  'buffer_n', 'buffer_s', 'drift_sum', 'drift_n', 'behind_n', 'step_downs', 'slow_mode_n', 'chat_n', 'react_n',
  'err_lookup', 'err_relay', 'err_youtube', 'err_room', 'err_subs', 'err_struggle', 'err_audio', 'searches', 'searches_empty', 'title_join']);
const ERROR_KINDS = new Set(['lookup', 'relay', 'youtube', 'room', 'subs', 'struggle', 'audio']);   // struggle: a viewer couldn't keep up (slow connection or busy device)

export class Stats extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.pending = new Map();     // `${hour}|${name}` -> delta
    this.peaks = new Map();       // `${hour}|${name}` -> max
    this.titleDeltas = new Map(); // `${day}|${key}` -> { title, type, joins, watch_s }
    this.lastFlush = Date.now();
    this.providers = {};          // latest usage read from Vercel and Cloudflare (see refreshProviders)
    ctx.blockConcurrencyWhile(async () => { this.migrate(); this.providers = (await ctx.storage.get('providers')) || {}; });
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
    else if (route === '/refresh-usage') { await this.refreshProviders(); out = this.limits(); }
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
    await this.refreshProviders();
    const lim = this.limits();
    const v = lim.vercel;
    if (v.onDemand > 0) await this.notify('critical', 'vercel_ondemand', `Vercel is now charging beyond your $20 credit: $${v.onDemand.toFixed(2)}`, 'Usage past the monthly credit is billed to your card. Check Vercel → Usage, and the spending cap.');
    else if (v.creditPct >= 1) await this.notify('critical', 'vercel_credit_100', 'Vercel credit used up', `About $${v.creditUsed.toFixed(2)} of the $20 monthly credit is used. Further usage is billed.`);
    else if (v.creditPct >= 0.75) await this.notify('warning', 'vercel_credit_75', `Vercel credit at ${Math.round(v.creditPct * 100)}%`, `About $${v.creditUsed.toFixed(2)} of $20 used this month${v.daysLeft != null ? `; at today's pace it lasts about ${Math.max(0, v.daysLeft).toFixed(1)} more days` : ''}.`);
    if (v.budget && !v.budget.pause) await this.notify('warning', 'vercel_budget_nopause', 'Vercel spending cap does not pause', `Your Spend Management budget is $${v.budget.amount} with pause off, so charges can keep going past it. Turn on "pause" in Vercel → Settings → Billing.`);
    for (const c of lim.cloudflare.items) {
      if (c.pct >= 0.9) await this.notify('critical', 'cf_' + c.k + '_90', `Cloudflare ${c.name} at ${Math.round(c.pct * 100)}%`, 'Nearly at the free daily limit; rooms may stop working until 00:00 UTC.');
      else if (c.pct >= 0.7) await this.notify('warning', 'cf_' + c.k + '_70', `Cloudflare ${c.name} at ${Math.round(c.pct * 100)}%`, 'Getting close to the free daily limit.');
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

  /* ── provider usage: real numbers from Vercel and Cloudflare ──
     Needs read-only tokens stored as secrets (VERCEL_TOKEN, CF_API_TOKEN). Without them the
     dashboard shows HexTV's own estimates, clearly marked as such. */
  async refreshProviders() {
    const out = { ...this.providers };
    if (this.env.VERCEL_TOKEN && this.env.VERCEL_TEAM_ID) {
      try { out.vercel = { ...(await this.vercelUsage()), at: Date.now() }; out.vercelError = ''; }
      catch (e) { out.vercelError = String((e && e.message) || e).slice(0, 200); }
    }
    if (this.env.CF_API_TOKEN && this.env.CF_ACCOUNT_ID) {
      try { out.cloudflare = { ...(await this.cloudflareUsage()), at: Date.now() }; out.cloudflareError = ''; }
      catch (e) { out.cloudflareError = String((e && e.message) || e).slice(0, 200); }
    }
    this.providers = out;
    await this.ctx.storage.put('providers', out);
    return out;
  }

  async vercelUsage() {
    const team = this.env.VERCEL_TEAM_ID;
    const headers = { Authorization: 'Bearer ' + this.env.VERCEL_TOKEN, 'Content-Type': 'application/json' };
    const call = async (path, init = {}) => {
      const r = await fetch('https://api.vercel.com' + path + (path.includes('?') ? '&' : '?') + 'teamId=' + team, { ...init, headers });
      if (!r.ok) throw new Error(`Vercel answered ${r.status} for ${path.split('?')[0]}: ${(await r.text()).slice(0, 400)}`);
      return r.json();
    };
    const now = new Date();
    // The billing period (the $20 credit runs per period) and the plan invoice, from Vercel's invoices
    let periodStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1), periodEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1), periodFrom = 'calendar month';
    let invoice = null;
    try {
      const raw = await call('/v1/invoices?limit=10');
      const inv = raw.data || raw.invoices || [];   // the raw API lists them under "data" 
      for (const i of inv) {
        const pro = (i.lineItems || []).find(l => /^pro$/i.test(l.description || '') || l.billableItem === 'pro');
        if (!pro || !pro.periodStart || !pro.periodEnd) continue;
        const ps = Date.parse(pro.periodStart), pe = Date.parse(pro.periodEnd);
        if (ps <= now.getTime() && now.getTime() < pe) {
          periodStart = ps; periodEnd = pe; periodFrom = 'Vercel invoice';
          invoice = { number: i.invoiceNumber, status: i.status || (Number(i.amountRemaining) > 0 ? 'open' : 'paid'), total: Number(i.total ?? i.amountDue ?? 0),
            due: Number(i.amountRemaining ?? i.amountDue ?? 0), paid: Number(i.amountPaid ?? 0) };
          break;
        }
      }
    } catch (e) { periodFrom = 'calendar month (invoices unavailable: ' + String((e && e.message) || e).slice(0, 120) + ')'; }
    const monthStart = new Date(periodStart);
    const dayAgo = new Date(now.getTime() - DAY);
    // The same query the Vercel CLI's `vercel metrics` sends (team-wide)
    // Vercel wants the range on whole buckets: start rounded down, end rounded up (as the CLI does)
    const metric = async (name, aggregation, start, bucket) => {
      const ms = bucket * 1000;
      const from = new Date(Math.floor(start.getTime() / ms) * ms), to = new Date(Math.ceil(now.getTime() / ms) * ms);
      const body = { scope: { ownerId: team }, timeRange: { start: from.toISOString(), end: to.toISOString() }, bucketSeconds: bucket,
        metrics: { value: { metric: name, aggregation } }, outputs: ['value'] };
      const r = await call('/metrics/v1', { method: 'POST', body: JSON.stringify(body) });
      return Number((r.summary && r.summary[0] && r.summary[0].values && r.summary[0].values.value) || 0);
    };
    const [fot, fot24h, fdt, requests, cpuMs, durationMs, memAvgMb] = await Promise.all([
      metric('vercel.function_invocation.fot_total_bytes', 'sum', monthStart, DAY / 1000),
      metric('vercel.function_invocation.fot_total_bytes', 'sum', dayAgo, HOUR / 1000),
      metric('vercel.request.fdt_total_bytes', 'sum', monthStart, DAY / 1000),
      metric('vercel.request.count', 'count', monthStart, DAY / 1000),
      metric('vercel.function_invocation.function_cpu_time_ms', 'sum', monthStart, DAY / 1000),
      metric('vercel.function_invocation.function_duration_ms', 'sum', monthStart, DAY / 1000),
      metric('vercel.function_invocation.provisioned_memory_mb', 'avg', monthStart, DAY / 1000)
    ]);
    // On-demand spend (what's charged beyond the credit) and the Spend Management budget, as Vercel reports them
    let onDemand = null, budget = null;
    try { const sp = await call(`/teams/${team}/spend`); onDemand = Number(sp.currentSpend ?? (sp.spend && sp.spend.currentSpend) ?? sp.amount ?? 0); } catch { /* shown as unknown */ }
    try {
      const b = await call('/v1/budgets?scope=team');
      const list = Array.isArray(b) ? b : b.budgets || b.data || [];
      const t = list.find(x => x.scope === 'team') || list[0];
      if (t) budget = { amount: Number(t.amount), pause: !!t.pause, status: t.status };
    } catch { /* shown as unknown */ }
    return { fot, fot24h, fdt, requests, cpuMs, durationMs, memAvgMb, onDemand, budget, invoice, periodStart, periodEnd, periodFrom };
  }

  async cloudflareUsage() {
    const date = dayOf(Date.now());
    const gql = async (fields) => {
      const r = await fetch('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST', headers: { Authorization: 'Bearer ' + this.env.CF_API_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: `query ($a: String!, $d: Date!) { viewer { accounts(filter: { accountTag: $a }) { ${fields} } } }`, variables: { a: this.env.CF_ACCOUNT_ID, d: date } })
      });
      const j = await r.json();
      if (j.errors && j.errors.length) throw new Error(j.errors[0].message);
      return j.data.viewer.accounts[0] || {};
    };
    const sum = (rows, f) => (rows || []).reduce((t, x) => t + Number((x.sum && x.sum[f]) || 0), 0);
    const out = { date, notes: [] };
    // Each dataset on its own, so one Cloudflare change can't blank the whole card
    try { const a = await gql('workersInvocationsAdaptive(limit: 1000, filter: { date: $d }) { sum { requests } }'); out.workerRequests = sum(a.workersInvocationsAdaptive, 'requests'); } catch (e) { out.notes.push('worker requests: ' + e.message); }
    try { const a = await gql('durableObjectsInvocationsAdaptiveGroups(limit: 1000, filter: { date: $d }) { sum { requests } }'); out.doRequests = sum(a.durableObjectsInvocationsAdaptiveGroups, 'requests'); } catch (e) { out.notes.push('room requests: ' + e.message); }
    try { const a = await gql('durableObjectsPeriodicGroups(limit: 1000, filter: { date: $d }) { sum { activeTime inboundWebsocketMsgCount } }'); const g = a.durableObjectsPeriodicGroups;
      out.doGBs = sum(g, 'activeTime') / 1e6 * 0.125; out.wsIn = sum(g, 'inboundWebsocketMsgCount'); } catch (e) { out.notes.push('room time: ' + e.message); }
    try { const a = await gql('durableObjectsPeriodicGroups(limit: 1000, filter: { date: $d }) { sum { rowsRead rowsWritten } }'); const g = a.durableObjectsPeriodicGroups;
      out.rowsRead = sum(g, 'rowsRead'); out.rowsWritten = sum(g, 'rowsWritten'); } catch (e) { out.notes.push('rows: ' + e.message); }
    // Storage: SQLite-backed objects (what HexTV uses) report in their own dataset
    out.storedBytes = 0;
    for (const ds of ['durableObjectsSqlStorageGroups', 'durableObjectsStorageGroups']) {
      try { const a = await gql(`${ds}(limit: 1, filter: { date: $d }) { max { storedBytes } }`); const g = a[ds];
        out.storedBytes = Math.max(out.storedBytes, Number((g && g[0] && g[0].max && g[0].max.storedBytes) || 0)); } catch (e) { out.notes.push(ds + ': ' + e.message); }
    }
    if (!out.storedBytes) { out.storedBytes = null; out.notes.push('storage not reported by Cloudflare yet'); }
    return out;
  }

  limits() {
    const now = Date.now();
    const d = new Date(now);
    const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const monthEnd = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const P = this.providers || {};
    const own = this.sumSince(monthStart, ['relay_bytes']), own24 = this.sumSince(now - DAY, ['relay_bytes']);
    const t = this.sumSince(dayStart, ['joins', 'beacons', 'config_hits', 'reports', 'ws_msgs', 'admin_calls', 'health_ok', 'health_fail']);

    /* Vercel: real usage when connected (and from this month), otherwise HexTV's estimate of the relay */
    const pv = P.vercel && P.vercel.periodEnd > now ? P.vercel : null;   // still inside its billing period
    const fot = pv ? pv.fot : own.relay_bytes, fot24h = pv ? pv.fot24h : own24.relay_bytes;
    const cpuH = pv ? pv.cpuMs / 3.6e6 : 0, memGBh = pv ? (pv.memAvgMb / 1024) * (pv.durationMs / 3.6e6) : 0;
    const fdt = pv ? pv.fdt : null, requests = pv ? pv.requests : null;
    const cost = {
      fot: fot / GB * VERCEL_PRO.fotPerGB, cpu: cpuH * VERCEL_PRO.cpuPerHour, memory: memGBh * VERCEL_PRO.memPerGBh,
      fdt: fdt == null ? 0 : Math.max(0, fdt / GB - VERCEL_PRO.fdtIncludedGB) * VERCEL_PRO.fdtPerGB,
      requests: requests == null ? 0 : Math.max(0, requests - VERCEL_PRO.reqIncluded) / 1e6 * VERCEL_PRO.reqPerMillion
    };
    const creditUsed = Object.values(cost).reduce((a, b) => a + b, 0);
    const perDay = fot24h / GB * VERCEL_PRO.fotPerGB;
    const vercel = {
      connected: !!pv, error: P.vercelError || '', at: pv ? pv.at : null, source: pv ? 'Vercel' : 'HexTV estimate',
      fot, fot24h, fdt, requests, cpuH, memGBh, cost, creditUsed, credit: VERCEL_PRO.credit, creditPct: creditUsed / VERCEL_PRO.credit,
      creditGB: VERCEL_PRO.credit / VERCEL_PRO.fotPerGB * GB, perDay, daysLeft: perDay > 0 ? (VERCEL_PRO.credit - creditUsed) / perDay : null,
      onDemand: pv && pv.onDemand != null ? pv.onDemand : 0, onDemandKnown: !!(pv && pv.onDemand != null), budget: pv ? pv.budget : null,
      prices: VERCEL_PRO, resets: pv ? pv.periodEnd : monthEnd, periodStart: pv ? pv.periodStart : monthStart, periodFrom: pv ? pv.periodFrom : 'calendar month (estimate)',
      invoice: pv ? pv.invoice : null
    };

    /* Cloudflare: today's real numbers when connected, otherwise HexTV's own count */
    const pc = P.cloudflare && P.cloudflare.date === dayOf(now) ? P.cloudflare : null;
    const ownReq = t.joins + t.beacons + t.config_hits + t.reports + t.admin_calls + t.health_ok + t.health_fail;
    const val = (k, fallback) => (pc && pc[k] != null ? pc[k] : fallback);
    const items = [
      { k: 'workers', name: 'requests', used: val('workerRequests', ownReq), limit: CF_FREE.workerRequests, unit: 'n' },
      { k: 'rooms', name: 'room requests', used: pc && pc.doRequests != null ? pc.doRequests + (pc.wsIn || 0) / 20 : t.ws_msgs / 20 + t.joins, limit: CF_FREE.doRequests, unit: 'n' },
      { k: 'time', name: 'room running time', used: val('doGBs', null), limit: CF_FREE.doGBs, unit: 'GB-s' },
      { k: 'writes', name: 'storage writes', used: val('rowsWritten', null), limit: CF_FREE.rowsWritten, unit: 'n' },
      { k: 'storage', name: 'storage', used: val('storedBytes', this.ctx.storage.sql.databaseSize), limit: CF_FREE.storageBytes, unit: 'bytes', total: true }
    ].map(c => ({ ...c, pct: c.used == null ? 0 : c.used / c.limit }));
    return {
      vercel,
      cloudflare: { connected: !!pc, error: P.cloudflareError || '', notes: pc ? pc.notes : [], at: pc ? pc.at : null, source: pc ? 'Cloudflare' : 'HexTV count', items, resets: dayStart + DAY }
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
      'err_lookup', 'err_relay', 'err_youtube', 'err_room', 'err_subs', 'err_struggle', 'err_audio', 'sessions', 'searches', 'searches_empty', 'health_ok', 'health_fail']);
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
        errors: { lookup: tot.err_lookup, relay: tot.err_relay, youtube: tot.err_youtube, room: tot.err_room, subs: tot.err_subs, struggle: tot.err_struggle, audio: tot.err_audio },
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
