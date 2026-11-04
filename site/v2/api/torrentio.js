// api/torrentio.js
// Vercel serverless proxy for Stremio-protocol addons (Torrentio, Nuvio).
//
// TIMING CONSTRAINT: Vercel's free tier kills functions at 10s. Everything
// here must finish well inside that, so mirrors are raced in PARALLEL with a
// short per-request timeout rather than tried one after another.
//
// Usage:
//   GET /api/torrentio?source=torrentio&type=movie&id=tt0468569
//   GET /api/torrentio?source=nuvio&type=series&id=tt0944947:1:1

const SOURCES = {
  torrentio: [
    'https://torrentio.strem.fun'
  ],
  nuvio: [
    // Config prefix must precede /stream/ — set via the addon's /configure page
    'https://nuviostreamsaddon-production.up.railway.app/providers=vidzee,vidsrc,vixsrc,mp4hydra,topmovies'
  ]
};

// 7s leaves ~3s of headroom under Vercel's 10s function limit
const TIMEOUT_MS = 7000;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Torrentio embeds quality/size as text in name+title (no structured fields),
// e.g. name: "Torrentio\n4k HDR", title: "...2160p...\n👤 313 💾 8.91 GB ⚙️ 1337x"
const RESOLUTION_RE = /(\d{3,4})p/i;
const SIZE_RE = /💾\s*([\d.]+)\s*(GB|MB)/i;

function parseStreamMeta(stream) {
  const text = `${stream.name || ''}\n${stream.title || ''}`;
  const resMatch = text.match(RESOLUTION_RE);
  const resolution = resMatch ? parseInt(resMatch[1], 10) : (/4k/i.test(text) ? 2160 : null);

  const sizeMatch = text.match(SIZE_RE);
  const sizeMB = sizeMatch
    ? parseFloat(sizeMatch[1]) * (sizeMatch[2].toUpperCase() === 'GB' ? 1024 : 1)
    : null;

  return { resolution, sizeMB };
}

// Caps results at maxRes (e.g. 480) and sorts smallest-file-first — phone-friendly
// picks first. Streams with unparseable resolution are dropped when filtering,
// since we can't confirm they're actually within the cap.
function applyQualityFilter(streams, maxRes) {
  const annotated = streams.map(s => ({ ...s, ...parseStreamMeta(s) }));
  if (!maxRes) return annotated;

  const capped = annotated.filter(s => s.resolution && s.resolution <= maxRes);
  const pool = capped.length > 0 ? capped : annotated; // fall back rather than return nothing

  return pool.slice().sort((a, b) => (a.sizeMB ?? Infinity) - (b.sizeMB ?? Infinity));
}

// Retry a 429 with backoff, respecting Retry-After when the server sends it.
// Budget is deliberately small — Vercel kills the function at 10s.
async function tryMirror(base, type, id, attempt = 0) {
  const result = await tryMirrorOnce(base, type, id);

  if (result.rateLimited && attempt < 1) {
    const waitMs = Math.min(result.retryAfterMs || 1500, 2500);
    console.warn(`[${base}] rate limited — retrying in ${waitMs}ms`);
    await sleep(waitMs);
    return tryMirror(base, type, id, attempt + 1);
  }

  return result;
}

async function tryMirrorOnce(base, type, id) {
  const url = `${base}/stream/${type}/${encodeURIComponent(id)}.json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      }
    });
    clearTimeout(timer);
    const ms = Date.now() - startedAt;

    if (res.status === 429) {
      // Retry-After may be seconds or an HTTP date; only the numeric form is useful here
      const ra = res.headers.get('retry-after');
      const retryAfterMs = ra && !isNaN(Number(ra)) ? Number(ra) * 1000 : null;
      return {
        ok: false, rateLimited: true, retryAfterMs,
        mirror: base, ms, url,
        error: 'rate limited (HTTP 429)'
      };
    }

    if (!res.ok) {
      // Include a snippet of the body — a 404 page often says what's wrong
      let hint = '';
      try {
        const text = await res.text();
        if (text) hint = ` — ${text.slice(0, 120).replace(/\s+/g, ' ')}`;
      } catch (_) {}
      return { ok: false, mirror: base, ms, url, error: `HTTP ${res.status}${hint}` };
    }

    const data = await res.json();
    return { ok: true, mirror: base, ms, url, streams: data.streams || [] };

  } catch (e) {
    clearTimeout(timer);
    const ms = Date.now() - startedAt;
    const reason = e.name === 'AbortError'
      ? `no response in ${TIMEOUT_MS / 1000}s`
      : e.message;
    return { ok: false, mirror: base, ms, url, error: reason };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { type = 'movie', id, source = 'torrentio', maxRes } = req.query;
  const maxResNum = maxRes ? parseInt(maxRes, 10) : null;

  if (!id) return res.status(400).json({ error: 'Missing "id" parameter' });
  if (type !== 'movie' && type !== 'series') {
    return res.status(400).json({ error: 'type must be "movie" or "series"' });
  }

  const mirrors = SOURCES[source];
  if (!mirrors) {
    return res.status(400).json({
      error: `Unknown source "${source}"`,
      available: Object.keys(SOURCES)
    });
  }

  // Race all mirrors at once — total time is the slowest single request,
  // not the sum. Keeps us inside Vercel's function limit.
  const results = await Promise.all(mirrors.map(m => tryMirror(m, type, id)));

  const attempts = results.map(r => ({
    mirror: r.mirror,
    ms:     r.ms,
    url:    r.url,
    error:  r.error || null,
    count:  r.ok ? r.streams.length : 0
  }));

  // Prefer a mirror that actually returned streams, then any that responded OK
  const withStreams = results.find(r => r.ok && r.streams.length > 0);
  const anyOk       = results.find(r => r.ok);
  const winner      = withStreams || anyOk;

  if (winner) {
    const streams = applyQualityFilter(winner.streams, maxResNum);
    console.log(`[${source}] ${streams.length}/${winner.streams.length} streams from ${winner.mirror} in ${winner.ms}ms${maxResNum ? ` (maxRes=${maxResNum})` : ''}`);
    return res.status(200).json({
      streams,
      _source:   source,
      _mirror:   winner.mirror,
      _ms:       winner.ms,
      _attempts: attempts
    });
  }

  console.warn(`[${source}] all mirrors failed`, attempts);
  const anyRateLimited = results.some(r => r.rateLimited);

  return res.status(anyRateLimited ? 429 : 502).json({
    error:       anyRateLimited
                   ? `${source} is rate limiting — wait a moment and try again`
                   : `All ${source} mirrors failed`,
    rateLimited: anyRateLimited,
    streams:   [],
    _source:   source,
    _attempts: attempts
  });
}
