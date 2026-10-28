// api/realdebrid.js
// Vercel serverless proxy for Real-Debrid API.
// Handles full magnet resolution with automatic retry on infringing_file.

const RD_BASE = 'https://api.real-debrid.com/rest/1.0';

async function rdFetch(url, options = {}) {
  const res  = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, magnet, magnets, link, id, token } = req.body;

  if (!token) return res.status(400).json({ error: 'Missing RD token' });
  if (!action) return res.status(400).json({ error: 'Missing action' });

  const authHeaders = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/x-www-form-urlencoded'
  };

  try {

    /* ─── Single step actions (used for polling) ─── */

    if (action === 'addMagnet') {
      const { ok, status, data } = await rdFetch(`${RD_BASE}/torrents/addMagnet`, {
        method: 'POST', headers: authHeaders,
        body: `magnet=${encodeURIComponent(magnet)}`
      });
      if (!ok) return res.status(status).json(data);
      return res.status(200).json(data);
    }

    if (action === 'selectFiles') {
      if (!id) return res.status(400).json({ error: 'Missing id' });
      await rdFetch(`${RD_BASE}/torrents/selectFiles/${id}`, {
        method: 'POST', headers: authHeaders, body: 'files=all'
      });
      return res.status(200).json({ ok: true });
    }

    if (action === 'torrentInfo') {
      if (!id) return res.status(400).json({ error: 'Missing id' });
      const { ok, status, data } = await rdFetch(`${RD_BASE}/torrents/info/${id}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!ok) return res.status(status).json(data);
      return res.status(200).json(data);
    }

    /* ─── mediaInfos: real codec data for a resolved file ─── */
    // Returns the actual container and video/audio codecs rather than
    // guessing from the filename string.
    if (action === 'mediaInfos') {
      if (!id) return res.status(400).json({ error: 'Missing id' });
      const { ok, status, data } = await rdFetch(`${RD_BASE}/streaming/mediaInfos/${id}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!ok) return res.status(status).json(data);
      return res.status(200).json(data);
    }

    /* ─── transcode: RD-hosted HLS variants of a resolved file ─── */
    // Shape: { apple: {quality:url}, dash: {...}, liveMP4: {...}, h264WebM: {...} }
    // `apple` is the M3U8 HLS set — what HLS.js consumes.
    if (action === 'transcode') {
      if (!id) return res.status(400).json({ error: 'Missing id' });
      const { ok, status, data } = await rdFetch(`${RD_BASE}/streaming/transcode/${id}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!ok) return res.status(status).json(data);
      return res.status(200).json(data);
    }

    if (action === 'unrestrict') {
      if (!link) return res.status(400).json({ error: 'Missing link' });
      const { ok, status, data } = await rdFetch(`${RD_BASE}/unrestrict/link`, {
        method: 'POST', headers: authHeaders,
        body: `link=${encodeURIComponent(link)}`
      });
      if (!ok) return res.status(status).json(data);
      return res.status(200).json(data);
    }

    /* ─── resolveMagnet: full flow with auto-retry on infringing_file ─── */
    // Accepts a list of magnets and tries them one by one until one works.
    // This is the key fix — instead of failing on infringing_file, we skip
    // to the next magnet automatically.

    if (action === 'resolveMagnet') {
      const magnetList = magnets || (magnet ? [magnet] : []);
      if (!magnetList.length) return res.status(400).json({ error: 'No magnets provided' });

      // Errors specific to ONE torrent — skip it and try the next
      const SKIPPABLE_ERRORS = [
        'infringing_file',
        'virus',
        'dead',
        'magnet_error'
      ];

      // Errors about the ACCOUNT — every magnet will fail identically,
      // so stop immediately instead of burning the rate limit further
      const FATAL_ERRORS = [
        'too_many_requests',
        'permission_denied',
        'bad_token',
        'account_locked',
        'not_premium'
      ];

      const isFatal = (msg) =>
        FATAL_ERRORS.some(e => String(msg).toLowerCase().includes(e));

      // RD allows ~250 req/min. Each magnet costs 3+ calls, so cap the
      // attempts rather than walking a 69-item list.
      const MAX_ATTEMPTS = 8;

      let lastError = 'All magnets failed';

      const attemptLimit = Math.min(magnetList.length, MAX_ATTEMPTS);
      console.log(`[RD] ${magnetList.length} magnets supplied — trying up to ${attemptLimit}`);

      for (let i = 0; i < attemptLimit; i++) {
        const mag = magnetList[i];
        console.log(`[RD] Trying magnet ${i + 1}/${attemptLimit}…`);

        try {
          // Step 1 — Add magnet
          const addResult = await rdFetch(`${RD_BASE}/torrents/addMagnet`, {
            method: 'POST', headers: authHeaders,
            body: `magnet=${encodeURIComponent(mag)}`
          });

          if (!addResult.ok) {
            const errMsg = addResult.data?.error || `HTTP ${addResult.status}`;
            lastError = errMsg;

            // Account-level problem — no point trying the other magnets
            if (isFatal(errMsg) || addResult.status === 429) {
              console.error(`[RD] Fatal: ${errMsg} — aborting remaining magnets`);
              return res.status(429).json({
                error: errMsg,
                fatal: true,
                tried: i + 1
              });
            }

            console.warn(`[RD] addMagnet failed: ${errMsg}`);
            if (SKIPPABLE_ERRORS.some(e => errMsg.toLowerCase().includes(e))) continue;
            break;
          }

          const torrentId = addResult.data?.id;
          if (!torrentId) { lastError = 'No torrent ID returned'; continue; }

          // Step 2 — Select files
          await rdFetch(`${RD_BASE}/torrents/selectFiles/${torrentId}`, {
            method: 'POST', headers: authHeaders, body: 'files=all'
          });

          // Step 3 — Poll for links (max 20s)
          let links = [];
          let skippable = false;

          // Cached torrents have links IMMEDIATELY — so check first, sleep after.
          // Sleeping first wasted 1.5s on every single resolve.
          // Delays then ramp up for the uncached case.
          const POLL_DELAYS = [0, 400, 700, 1200, 1800, 2500, 3000, 3000];

          for (let poll = 0; poll < POLL_DELAYS.length; poll++) {
            if (POLL_DELAYS[poll] > 0) {
              await new Promise(r => setTimeout(r, POLL_DELAYS[poll]));
            }
            const infoResult = await rdFetch(`${RD_BASE}/torrents/info/${torrentId}`, {
              headers: { 'Authorization': `Bearer ${token}` }
            });

            const info = infoResult.data;
            console.log(`[RD] Torrent ${i+1} status: ${info.status} (check ${poll+1})`);

            if (info.links?.length > 0) { links = info.links; break; }

            // Check for terminal failure states
            if (SKIPPABLE_ERRORS.includes(info.status)) {
              lastError = `infringing_file: ${info.status}`;
              skippable = true;
              break;
            }

            // Also check error message
            if (info.error && SKIPPABLE_ERRORS.some(e => info.error.toLowerCase().includes(e))) {
              lastError = info.error;
              skippable = true;
              break;
            }
          }

          if (skippable) {
            console.warn(`[RD] Magnet ${i+1} flagged (${lastError}), trying next…`);
            continue;
          }

          if (links.length === 0) {
            lastError = 'Timed out waiting for links';
            console.warn(`[RD] Magnet ${i+1} timed out, trying next…`);
            continue;
          }

          // Step 4 — Unrestrict
          const unResult = await rdFetch(`${RD_BASE}/unrestrict/link`, {
            method: 'POST', headers: authHeaders,
            body: `link=${encodeURIComponent(links[0])}`
          });

          if (!unResult.ok) {
            const errMsg = unResult.data?.error || `HTTP ${unResult.status}`;

            if (isFatal(errMsg) || unResult.status === 429) {
              console.error(`[RD] Fatal on unrestrict: ${errMsg}`);
              return res.status(429).json({ error: errMsg, fatal: true, tried: i + 1 });
            }

            if (SKIPPABLE_ERRORS.some(e => errMsg.toLowerCase().includes(e))) {
              lastError = errMsg;
              console.warn(`[RD] Unrestrict flagged: ${errMsg}, trying next…`);
              continue;
            }
            lastError = errMsg;
            break;
          }

          const downloadUrl = unResult.data?.download;
          if (!downloadUrl) { lastError = 'No download URL returned'; continue; }

          // ✅ Success!
          console.log(`[RD] ✅ Resolved on magnet ${i+1}:`, downloadUrl);
          // Also return the RD file id — needed for mediaInfos + transcode
          return res.status(200).json({
            download:    downloadUrl,
            id:          unResult.data?.id || null,
            filename:    unResult.data?.filename || null,
            magnetIndex: i
          });

        } catch (err) {
          console.warn(`[RD] Exception on magnet ${i+1}:`, err.message);
          lastError = err.message;
          continue;
        } finally {
          // Brief pause so a run of failures doesn't spike the rate limit
          if (i < attemptLimit - 1) await new Promise(r => setTimeout(r, 300));
        }
      }

      // All magnets exhausted
      console.error(`[RD] All ${magnetList.length} magnets failed. Last error: ${lastError}`);
      return res.status(422).json({
        error: lastError,
        exhausted: true,
        tried: magnetList.length
      });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('[RD Proxy] Unhandled error:', err);
    return res.status(500).json({ error: err.message });
  }
}
