/* Watch history for "Continue Watching": what this device watched from the library and where it stopped.
   Kept in localStorage only (no accounts yet), one entry per title — a series keeps its latest episode.
   The room page saves progress; the library shows the row. */
(function () {
  const KEY = 'hx_history';
  const MAX = 20;
  const DONE = 0.95;      // watched this much (or under 2 minutes left): the movie/episode counts as finished

  function read() {
    try { const l = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(l) ? l : []; } catch { return []; }
  }
  function write(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))); } catch { /* storage full or blocked */ }
  }
  const finished = (t, d) => d > 0 && (t / d >= DONE || d - t < 120);

  window.HexHistory = {
    // Newest first
    list: read,
    get: mb => read().find(e => e.mb === String(mb)) || null,
    // Called every few seconds while a library title plays: { mb, se, ep, title, cover, type }, position, length
    save(media, t, d) {
      if (!media || !media.mb || !(d > 0) || t < 20) return;
      const list = read();
      const old = list.find(e => e.mb === String(media.mb)) || {};
      const entry = {
        mb: String(media.mb), se: media.se || 0, ep: media.ep || 0,
        title: media.title || old.title || '', cover: media.cover || old.cover || '',
        type: media.type || old.type || (media.se ? 'series' : 'movie'),
        t: Math.floor(t), d: Math.floor(d), done: finished(t, d), at: Date.now()
      };
      // A finished movie leaves the row; a finished episode stays so "Play next" can offer the next one
      const rest = list.filter(e => e.mb !== entry.mb);
      write(entry.done && entry.type !== 'series' ? rest : [entry, ...rest]);
    },
    remove(mb) { write(read().filter(e => e.mb !== String(mb))); },
    clear() { try { localStorage.removeItem(KEY); } catch { /* blocked */ } }
  };
})();
