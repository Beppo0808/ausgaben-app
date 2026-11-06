/* Eigener Bon-Scanner in der App – Kamera öffnet sofort, löst automatisch aus, bereitet das Bild wie ein Scan auf.
 *
 * - Kamera über getUserMedia (nur auf diesem Gerät, nichts wird dafür hochgeladen).
 * - Auto-Auslöser: wenn das Bild im Rahmen ruhig und scharf ist.
 * - „Scan-Look“: Bon wird ausgeschnitten (heller Bon vor dunklerem Untergrund), Kontrast verstärkt, Hintergrund weiß.
 * - Lange Bons: mehrere Teile nacheinander, werden untereinander zusammengesetzt.
 * - Ohne Kamera-Freigabe: Rückfall auf Foto/Datei-Auswahl.
 */
'use strict';

const Scanner = (() => {
  let stream = null, timer = null, parts = [], prev = null, stableSince = 0, sharpMax = 0, paused = 0, onDone = null;
  const $s = (q) => document.querySelector(q);

  const supported = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

  async function open(cb) {
    onDone = cb; parts = []; prev = null; stableSince = 0; sharpMax = 0; paused = 0;
    $s('#scanner').hidden = false; document.body.classList.add('viewer-open');
    setHint('Kamera wird gestartet …'); updateParts();
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } } });
    } catch (e) {
      close();
      toast('Kamera nicht freigegeben – bitte Foto oder Datei wählen');
      if (onDone) onDone(null, 'fallback');
      return;
    }
    const v = $s('#scanVideo');
    v.srcObject = stream; v.setAttribute('playsinline', ''); v.muted = true;
    try { await v.play(); } catch (e) { /* iOS startet trotzdem */ }
    setHint('Bon in den Rahmen halten – löst automatisch aus');
    timer = setInterval(tick, 250);
  }

  function stop() {
    clearInterval(timer); timer = null;
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    const v = $s('#scanVideo'); if (v) v.srcObject = null;
  }
  function close() { stop(); $s('#scanner').hidden = true; document.body.classList.remove('viewer-open'); }
  function setHint(t) { $s('#scanHint').textContent = t; }
  function updateParts() {
    const n = parts.length;
    $s('#scanParts').textContent = n ? `${n} ${n === 1 ? 'Teil' : 'Teile'} aufgenommen` : '';
    $s('#scanDone').hidden = !n;
    $s('#scanThumbs').innerHTML = parts.map((c) => `<img src="${c.toDataURL('image/jpeg', 0.5)}" alt="">`).join('');
  }

  /** Bereich des Rahmens im Videobild (Video wird mit object-fit: cover gezeigt) */
  function guideRect() {
    const v = $s('#scanVideo'), g = $s('#scanGuide');
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return null;
    const vr = v.getBoundingClientRect(), gr = g.getBoundingClientRect();
    const scale = Math.max(vr.width / vw, vr.height / vh);
    const ox = (vr.width - vw * scale) / 2, oy = (vr.height - vh * scale) / 2;
    const x = Math.max(0, (gr.left - vr.left - ox) / scale), y = Math.max(0, (gr.top - vr.top - oy) / scale);
    return { x, y, w: Math.min(vw - x, gr.width / scale), h: Math.min(vh - y, gr.height / scale) };
  }

  /** Ganzes Kamerabild (der Bon wird danach automatisch ausgeschnitten) */
  function grabFull() {
    const v = $s('#scanVideo');
    if (!v.videoWidth) return null;
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d', { willReadFrequently: true }).drawImage(v, 0, 0);
    return c;
  }

  function grab(maxW) {
    const v = $s('#scanVideo'), r = guideRect();
    if (!r || r.w < 10 || r.h < 10) return null;
    const s = Math.min(1, maxW / r.w);
    const c = document.createElement('canvas'); c.width = Math.round(r.w * s); c.height = Math.round(r.h * s);
    c.getContext('2d', { willReadFrequently: true }).drawImage(v, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
    return c;
  }

  /** Ruhe + Schärfe prüfen → automatisch auslösen */
  function tick() {
    if (Date.now() < paused) return;
    const c = grab(160); if (!c) return;
    const { data, width: w, height: h } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    const g = new Float32Array(w * h);
    let mean = 0;
    for (let i = 0; i < w * h; i++) { g[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]; mean += g[i]; }
    mean /= w * h;
    let motion = 255;
    if (prev && prev.length === g.length) { let d = 0; for (let i = 0; i < g.length; i++) d += Math.abs(g[i] - prev[i]); motion = d / g.length; }
    prev = g;
    let lap = 0, lap2 = 0, n = 0; // Schärfe: Varianz des Laplace-Filters
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x; const L = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
      lap += L; lap2 += L * L; n++;
    }
    const sharp = lap2 / n - (lap / n) ** 2;
    sharpMax = Math.max(sharpMax * 0.995, sharp);
    const ok = motion < 3.5 && sharp > 25 && sharp >= sharpMax * 0.6 && mean > 50 && mean < 235;
    if (!ok) { stableSince = 0; $s('#scanGuide').classList.remove('steady'); setHint(mean <= 50 ? 'Zu dunkel – mehr Licht' : motion >= 3.5 ? 'Bon in den Rahmen halten – ruhig halten' : 'Etwas näher / scharfstellen …'); return; }
    if (!stableSince) stableSince = Date.now();
    $s('#scanGuide').classList.add('steady');
    setHint('Gut – halten …');
    if (Date.now() - stableSince > 900) capture();
  }

  function capture() {
    const c = grabFull(); if (!c) return;
    parts.push(enhance(trim(c)));
    stableSince = 0; paused = Date.now() + 1800; // kurze Pause, damit nicht derselbe Teil doppelt aufgenommen wird
    const f = $s('#scanFlash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
    if (navigator.vibrate) navigator.vibrate(30);
    updateParts();
    setHint('✓ Aufgenommen – „Fertig“ tippen. Langer Bon? Weiter nach unten schieben.');
  }

  /** Hellen Bon vor dunklerem Untergrund ausschneiden (Otsu-Schwelle auf verkleinertem Bild) */
  function trim(c) {
    const s = Math.min(1, 300 / c.width);
    const t = document.createElement('canvas'); t.width = Math.round(c.width * s); t.height = Math.round(c.height * s);
    const tx = t.getContext('2d', { willReadFrequently: true }); tx.drawImage(c, 0, 0, t.width, t.height);
    const { data } = tx.getImageData(0, 0, t.width, t.height);
    const hist = new Array(256).fill(0); const gs = new Uint8Array(t.width * t.height);
    for (let i = 0; i < gs.length; i++) { const v = Math.round(0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]); gs[i] = v; hist[v]++; }
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, thr = 128;
    for (let i = 0; i < 256; i++) { wB += hist[i]; if (!wB) continue; const wF = gs.length - wB; if (!wF) break; sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) ** 2; if (between > best) { best = between; thr = i; } }
    // Zeilen/Spalten mit überwiegend hellen Pixeln = Bon
    const W = t.width, H = t.height, col = new Array(W).fill(0), row = new Array(H).fill(0);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (gs[y * W + x] > thr) { col[x]++; row[y]++; }
    const cx = col.map((v) => v / H > 0.3), ry = row.map((v) => v / W > 0.15);
    let x0 = cx.indexOf(true), x1 = cx.lastIndexOf(true), y0 = ry.indexOf(true), y1 = ry.lastIndexOf(true);
    if (x0 < 0 || y0 < 0 || (x1 - x0) * (y1 - y0) < 0.08 * W * H) return c; // nichts Sinnvolles gefunden → ganzes Bild nehmen
    const m = 4; x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(W - 1, x1 + m); y1 = Math.min(H - 1, y1 + m);
    const o = document.createElement('canvas'); o.width = Math.round((x1 - x0 + 1) / s); o.height = Math.round((y1 - y0 + 1) / s);
    o.getContext('2d').drawImage(c, x0 / s, y0 / s, o.width, o.height, 0, 0, o.width, o.height);
    return o;
  }

  /** „Scan-Look“: Graustufen, Kontrast strecken, Papier weiß */
  function enhance(c) {
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const d = ctx.getImageData(0, 0, c.width, c.height); const px = d.data;
    const hist = new Array(256).fill(0);
    for (let i = 0; i < px.length; i += 4) { const v = Math.round(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]); px[i] = v; hist[v]++; }
    const total = px.length / 4; let acc = 0, lo = 0, hi = 255;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc < total * 0.02) lo = i; if (acc < total * 0.6) hi = i; }
    hi = Math.max(hi, lo + 40);
    for (let i = 0; i < px.length; i += 4) {
      let v = (px[i] - lo) / (hi - lo); v = Math.max(0, Math.min(1, v)); v = v ** 1.15; // Papier → weiß, Schrift dunkel (nicht zu fett)
      const g = Math.round(v * 255); px[i] = px[i + 1] = px[i + 2] = g;
    }
    ctx.putImageData(d, 0, 0);
    return c;
  }

  function stitch() {
    const W = Math.min(1400, Math.max(...parts.map((p) => p.width)));
    const scaled = parts.map((p) => ({ p, h: Math.round(p.height * (W / p.width)) }));
    const out = document.createElement('canvas'); out.width = W; out.height = scaled.reduce((a, s) => a + s.h, 0);
    const ctx = out.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, out.width, out.height);
    let y = 0; for (const s of scaled) { ctx.drawImage(s.p, 0, y, W, s.h); y += s.h; }
    return out;
  }

  function bind() {
    $s('#scanShutter').onclick = capture;
    $s('#scanDone').onclick = () => { const c = parts.length ? stitch() : null; close(); if (onDone) onDone(c); };
    $s('#scanCancel').onclick = () => { close(); };
    $s('#scanFile').onclick = () => { close(); if (onDone) onDone(null, 'fallback'); };
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && stream) close(); });
  }

  return { open, supported, bind, _enhance: enhance, _trim: trim };
})();
