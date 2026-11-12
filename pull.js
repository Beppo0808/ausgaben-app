/* Nach unten ziehen zum Aktualisieren (wie in vielen iPhone-Apps) */
(() => {
  const THRESHOLD = 80;
  let startY = null, pulling = false, dist = 0, busy = false;
  const el = document.createElement('div');
  el.id = 'pullRefresh';
  el.innerHTML = '<span class="pr-icon">↓</span><span class="pr-text">Zum Aktualisieren ziehen</span>';
  document.body.appendChild(el);

  const blocked = () => busy || document.querySelector('dialog[open]') || document.body.classList.contains('locked')
    || document.body.classList.contains('viewer-open') || !document.getElementById('lockScreen')?.hidden
    || !document.getElementById('scanner')?.hidden;

  function set(d) {
    dist = d;
    el.style.transform = `translate(-50%, ${Math.min(d, THRESHOLD * 1.4) - 60}px)`;
    el.style.opacity = String(Math.min(1, d / THRESHOLD));
    el.classList.toggle('ready', d >= THRESHOLD);
    el.querySelector('.pr-text').textContent = d >= THRESHOLD ? 'Loslassen zum Aktualisieren' : 'Zum Aktualisieren ziehen';
  }
  function reset() { el.classList.remove('busy'); el.style.transition = 'transform .25s, opacity .25s'; set(0); setTimeout(() => { el.style.transition = ''; }, 260); }

  async function doRefresh() {
    busy = true;
    el.classList.add('busy'); el.querySelector('.pr-text').textContent = 'Aktualisiere …';
    try {
      const jobs = [];
      if (typeof Sync !== 'undefined' && Sync.enabled()) jobs.push(Sync.syncNow());
      // Konto nur, wenn der letzte Abruf über eine Stunde her ist (Banken erlauben ohne TAN nur wenige Abrufe am Tag)
      if (typeof Konto !== 'undefined' && document.body.dataset.mode === 'personal') {
        const d = Konto._data();
        const last = Math.max(0, ...((d.bank && d.bank.connections) || []).flatMap((c) => c.accounts.map((a) => (a.fetched ? new Date(a.fetched).getTime() : 0))));
        if (last && Date.now() - last > 3600e3) jobs.push(Konto.refresh(false, true));
      }
      if (navigator.serviceWorker) jobs.push(navigator.serviceWorker.getRegistration().then((r) => r && r.update()).catch(() => {}));
      await Promise.race([Promise.allSettled(jobs), new Promise((r) => setTimeout(r, 12000))]);
      if (typeof render === 'function') render();
      if (typeof toast === 'function') toast('✓ Aktualisiert');
    } finally { busy = false; reset(); }
  }

  window.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || window.scrollY > 0 || blocked()) { startY = null; return; }
    startY = e.touches[0].clientY; pulling = false;
  }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (startY === null) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0 || window.scrollY > 0) { if (pulling) set(0); pulling = false; return; }
    pulling = true;
    set(dy * 0.5); // gebremst wie bei iOS
  }, { passive: true });
  window.addEventListener('touchend', () => {
    if (startY === null) return;
    startY = null;
    if (pulling && dist >= THRESHOLD) doRefresh(); else reset();
    pulling = false;
  });
})();
