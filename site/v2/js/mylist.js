/* My List: titles saved for later with the ♥ on a poster or in the details. Kept in localStorage
   on this device (no accounts yet), newest first. The library shows it as a row. */
(function () {
  const KEY = 'hx_mylist';
  const MAX = 100;

  function read() {
    try { const l = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(l) ? l : []; } catch { return []; }
  }
  function write(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))); } catch { /* storage full or blocked */ }
  }

  window.HexMyList = {
    list: read,
    has: id => read().some(e => e.subject_id === String(id)),
    // Saves a library item ({ subject_id, title, cover, type, year, rating }) or removes it; returns whether it's saved now
    toggle(item) {
      const id = String(item.subject_id);
      const list = read();
      if (list.some(e => e.subject_id === id)) { write(list.filter(e => e.subject_id !== id)); return false; }
      const { title, cover, type, year, rating } = item;
      write([{ subject_id: id, title, cover, type, year, rating, at: Date.now() }, ...list]);
      return true;
    }
  };
})();
