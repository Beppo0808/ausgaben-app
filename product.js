/*
 * Produkt-Scanner: Strichcode (EAN) fotografieren → Open Food Facts (freie Lebensmittel-Datenbank)
 * Übertragen wird nur der Strichcode – keine Namen, Preise oder Kontodaten.
 * Preis kommt aus euren eigenen Kassenbons (falls schon einmal gekauft).
 */
const Product = (() => {
  const ZXING_URL = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';
  const OFF = 'https://world.openfoodfacts.org/api/v2/product/';
  const FIELDS = 'product_name,product_name_de,generic_name_de,brands,quantity,nutriments,ingredients_text_de,ingredients_text,nutriscore_grade,image_front_small_url,allergens_tags,traces_tags,product_quantity,product_quantity_unit,serving_size,serving_quantity';
  let current = null, bound = false;

  function loadZxing() {
    if (window.ZXing) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = ZXING_URL; s.onload = res;
      s.onerror = () => rej(new Error('Strichcode-Leser konnte nicht geladen werden – Internet prüfen')); document.head.appendChild(s);
    });
  }

  /** Strichcode aus einem Foto lesen (mehrere Größen/Drehungen probieren) */
  async function readBarcode(file) {
    await loadZxing();
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Bild konnte nicht geöffnet werden')); i.src = url; });
      const hints = new Map();
      hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.EAN_13, ZXing.BarcodeFormat.EAN_8, ZXing.BarcodeFormat.UPC_A, ZXing.BarcodeFormat.UPC_E]);
      hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
      const reader = new ZXing.MultiFormatReader(); reader.setHints(hints);
      for (const maxW of [1600, 1000, 2400]) {
        for (const rot of [0, 90]) {
          const sc = Math.min(1, maxW / Math.max(img.naturalWidth, img.naturalHeight));
          const w = Math.round(img.naturalWidth * sc), h = Math.round(img.naturalHeight * sc);
          const c = document.createElement('canvas'); c.width = rot ? h : w; c.height = rot ? w : h;
          const x = c.getContext('2d', { willReadFrequently: true });
          if (rot) { x.translate(c.width / 2, c.height / 2); x.rotate(Math.PI / 2); x.drawImage(img, -w / 2, -h / 2, w, h); } else x.drawImage(img, 0, 0, w, h);
          try {
            const src = new ZXing.HTMLCanvasElementLuminanceSource(c);
            const r = reader.decode(new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(src)));
            if (r && r.getText()) return r.getText();
          } catch (e) { /* nächster Versuch */ }
        }
      }
      return '';
    } finally { URL.revokeObjectURL(url); }
  }

  async function lookup(ean) {
    const cacheKey = 'off-' + ean;
    try { const c = JSON.parse(localStorage.getItem(cacheKey) || 'null'); if (c && Date.now() - c.at < 30 * 864e5) return c.p; } catch (e) { /* egal */ }
    const r = await fetch(`${OFF}${encodeURIComponent(ean)}.json?fields=${FIELDS}`);
    if (!r.ok && r.status !== 404) throw new Error('Datenbank gerade nicht erreichbar');
    const j = await r.json().catch(() => ({}));
    const p = j && j.status === 1 && j.product ? j.product : null;
    try { localStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), p })); } catch (e) { /* voll */ }
    return p;
  }

  // ---------- Hinweise je Person (verschlüsselt im Haushalt geteilt, damit beide sie sehen) ----------
  const EMPTY = () => ({ nut: [], diag: [], allergy: [], custom: [] });
  const meName = () => state.settings.me || (state.settings.persons || [])[0] || 'Ich';
  const getH = (who = meName()) => ({ ...EMPTY(), ...((state.settings.health || {})[who] || {}) });
  const setH = (who, h) => { state.settings.health = { ...(state.settings.health || {}), [who]: { ...h, t: Date.now() } }; save(); };
  const hasH = (h) => h.diag.length || h.allergy.length || h.custom.length;

  // Nährwerte (Reihenfolge wie auf der Verpackung)
  const NUTS = [
    ['energy-kcal', 'Energie', 'kcal'], ['fat', 'Fett', 'g'], ['saturated-fat', 'davon gesättigte Fettsäuren', 'g'],
    ['carbohydrates', 'Kohlenhydrate', 'g'], ['sugars', 'davon Zucker', 'g'], ['polyols', 'davon mehrwertige Alkohole', 'g'], ['starch', 'davon Stärke', 'g'],
    ['fiber', 'Ballaststoffe', 'g'], ['proteins', 'Eiweiß', 'g'], ['salt', 'Salz', 'g'],
    ['cholesterol', 'Cholesterin', 'mg', 1000], ['potassium', 'Kalium', 'mg', 1000], ['calcium', 'Calcium', 'mg', 1000], ['iron', 'Eisen', 'mg', 1000],
    ['magnesium', 'Magnesium', 'mg', 1000], ['vitamin-c', 'Vitamin C', 'mg', 1000], ['vitamin-d', 'Vitamin D', 'µg', 1e6], ['caffeine', 'Koffein', 'mg', 1000], ['alcohol', 'Alkohol', '% vol'],
  ];
  // Diagnosen / Ernährungsweisen → Regeln je 100 g (orientiert an der üblichen Nährwert-Ampel)
  const DIAGS = [
    ['insulin', 'Insulinresistenz / Diabetes', [['sugars', 5, 10, 'Zucker'], ['carbohydrates', 20, 45, 'Kohlenhydrate'], ['fiber', 3, 6, 'Ballaststoffe', true]]],
    ['divert', 'Divertikulose', [['fiber', 3, 6, 'Ballaststoffe', true], ['saturated-fat', 1.5, 5, 'gesättigte Fette']]],
    ['bp', 'Bluthochdruck', [['salt', 0.3, 1.5, 'Salz']]],
    ['chol', 'Erhöhte Blutfette / Cholesterin', [['saturated-fat', 1.5, 5, 'gesättigte Fette'], ['fat', 3, 17.5, 'Fett']]],
    ['weight', 'Abnehmen / Kalorien', [['energy-kcal', 150, 400, 'Kalorien'], ['sugars', 5, 22.5, 'Zucker'], ['fat', 3, 17.5, 'Fett']]],
    ['kidney', 'Nierenschonend', [['salt', 0.3, 1.5, 'Salz'], ['proteins', 10, 20, 'Eiweiß']]],
    ['protein', 'Eiweißreich essen', [['proteins', 5, 10, 'Eiweiß', true]]],
    ['lactose', 'Laktoseintoleranz', [], ['en:milk'], /laktose|lactose|milch(?!säure)/i, /laktosefrei|lactose[- ]free/i],
    ['gluten', 'Zöliakie / Glutenunverträglichkeit', [], ['en:gluten'], /weizen|gerste|roggen|dinkel|hafer|gluten/i, /glutenfrei|gluten[- ]free/i],
  ];
  // Allergene (EU-14) + häufige weitere
  const ALLERGENS = [
    ['en:gluten', 'Gluten'], ['en:crustaceans', 'Krebstiere'], ['en:eggs', 'Eier'], ['en:fish', 'Fisch'], ['en:peanuts', 'Erdnüsse'], ['en:soybeans', 'Soja'],
    ['en:milk', 'Milch'], ['en:nuts', 'Schalenfrüchte (Nüsse)'], ['en:celery', 'Sellerie'], ['en:mustard', 'Senf'], ['en:sesame-seeds', 'Sesam'],
    ['en:sulphur-dioxide-and-sulphites', 'Sulfite'], ['en:lupin', 'Lupinen'], ['en:molluscs', 'Weichtiere'],
    ['x:propolis', 'Propolis / Bienenprodukte', /propolis|bienenharz|kittharz|gelée royale|gelee royale|bienenwachs|\bhonig/i],
  ];
  const nv = (n, k) => { const v = n[k + '_100g']; return v === undefined || v === '' ? null : +v; };

  /** Hinweise für dieses Produkt (rot/gelb/grün) aus den gewählten Diagnosen und Allergien */
  function assess(p, h) {
    const n = p.nutriments || {}, out = [], mark = {};
    const ingr = `${p.ingredients_text_de || ''} ${p.ingredients_text || ''} ${p.product_name_de || p.product_name || ''}`;
    const tags = p.allergens_tags || [], traces = p.traces_tags || [];
    const lvl = { red: 3, yellow: 2, green: 1 };
    const setMark = (k, c) => { if (!mark[k] || lvl[c] > lvl[mark[k]]) mark[k] = c; };
    for (const id of h.diag) {
      const d = DIAGS.find((x) => x[0] === id); if (!d) continue;
      for (const [k, lo, hi, label, good] of d[2]) {
        const v = nv(n, k); if (v === null || !Number.isFinite(v)) continue;
        const c = good ? (v >= hi ? 'green' : v >= lo ? 'yellow' : 'red') : (v > hi ? 'red' : v > lo ? 'yellow' : 'green');
        setMark(k, c);
        if (c !== 'green' || good) out.push({ c, t: `${d[1]}: ${good ? (c === 'green' ? 'viel' : c === 'yellow' ? 'etwas' : 'wenig') : (c === 'red' ? 'viel' : c === 'yellow' ? 'mittel' : 'wenig')} ${label}` });
      }
      if (d[3]) {
        const freeOk = d[5] && d[5].test(ingr);
        const hit = d[3].some((t) => tags.includes(t)) || (d[4] && d[4].test(ingr));
        if (hit && !freeOk) out.push({ c: id === 'gluten' ? 'red' : 'yellow', t: `${d[1]}: enthält ${id === 'gluten' ? 'Gluten' : 'Milch/Laktose'}` });
        else if (freeOk) out.push({ c: 'green', t: `${d[1]}: als „frei“ gekennzeichnet` });
      }
    }
    for (const id of h.allergy) {
      const a = ALLERGENS.find((x) => x[0] === id); if (!a) continue;
      if (tags.includes(id) || (a[2] && a[2].test(ingr))) out.push({ c: 'red', t: `⚠️ Allergie: enthält ${a[1]}` });
      else if (traces.includes(id)) out.push({ c: 'yellow', t: `Allergie: kann Spuren von ${a[1]} enthalten` });
    }
    for (const w of h.custom) {
      if (w && new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(ingr)) out.push({ c: 'red', t: `⚠️ enthält „${w}“` });
    }
    const order = { red: 0, yellow: 1, green: 2 };
    return { notes: out.sort((x, y) => order[x.c] - order[y.c]), mark };
  }

  const num = (v) => (Number.isFinite(+v) ? (+v).toLocaleString('de-DE', { maximumFractionDigits: 1 }) : '–');
  let lastP = null, lastEan = '';
  function render(ean, p) {
    lastP = p; lastEan = ean;
    const box = $('#prodResult');
    if (!p) {
      current = null;
      const own = Catalog.byEan(ean);
      box.innerHTML = `${own && own.img ? `<div class="prod-head"><img src="${esc(own.img)}" alt=""></div>` : ''}<p>Strichcode <b>${esc(ean)}</b> ist in der freien Datenbank (noch) nicht erfasst.</p>
        <label class="field">Produktname<input type="text" id="prodOwnName" value="${esc(own && own.name !== ean ? own.name : '')}" placeholder="z. B. Doppelherz Kollagen Pulver 200 g" autocomplete="off"></label>
        <p class="hint">Mach unten ein 🖼️ Produktfoto – dann erkennst du es unter ⭐ Produkte wieder.</p>`;
      current = { ean, name: own ? own.name : '', pname: own ? own.name : '', brand: own ? own.brand || '' : '', qty: '', img: '', unknown: true };
      $('#prodAdd').hidden = false; return;
    }
    const n = p.nutriments || {}, h = getH();
    const name = p.product_name_de || p.product_name || p.generic_name_de || 'Produkt';
    const brand = (p.brands || '').split(',')[0].trim();
    current = { ean, name: [brand, name].filter(Boolean).join(' ').slice(0, 70), pname: name.slice(0, 80), brand, qty: p.quantity || '', img: /^https:\/\/images\.openfoodfacts\.org\//.test(p.image_front_small_url || '') ? p.image_front_small_url : '' };
    // Hinweise für alle Personen mit Einstellungen; bei mehreren mit Namen davor
    const people = (state.settings.persons || [meName()]).filter((x) => hasH(getH(x)));
    const notes = [], mark = {}, lv = { red: 3, yellow: 2, green: 1 };
    for (const who of people) {
      const r = assess(p, getH(who));
      r.notes.forEach((x) => notes.push(people.length > 1 || who !== meName() ? { ...x, t: `${who}: ${x.t}` } : x));
      for (const [k, c] of Object.entries(r.mark)) if (!mark[k] || lv[c] > lv[mark[k]]) mark[k] = c;
    }
    const ord = { red: 0, yellow: 1, green: 2 }; notes.sort((x, y) => ord[x.c] - ord[y.c]);
    // Spalten: pro 100 g/ml · pro Portion · ganze Packung
    const per = /ml|\bl\b|liter/i.test(p.product_quantity_unit || p.quantity || '') ? 'ml' : 'g';
    const qm = String(p.quantity || '').replace(',', '.').match(/(\d+(?:\.\d+)?)\s*(kg|g|ml|cl|l)\b/i);
    const qParsed = qm ? +qm[1] * ({ kg: 1000, l: 1000, cl: 10 }[qm[2].toLowerCase()] || 1) : 0;
    const packQ = +p.product_quantity > 0 && +p.product_quantity <= 20000 ? +p.product_quantity : qParsed > 0 && qParsed <= 20000 ? qParsed : 0;
    const servQ = +p.serving_quantity > 0 && +p.serving_quantity < 5000 ? +p.serving_quantity : 0;
    const cols = [['100', (v) => v]];
    if (servQ && Math.abs(servQ - 100) > 0.5 && !(packQ && Math.abs(servQ - packQ) <= 0.5)) cols.push([`Portion<br>${num(servQ)} ${per}`, (v) => v * servQ / 100]);
    const ownQ = Catalog.packFor(ean);
    const pq = packQ || ownQ;
    if (pq && Math.abs(pq - 100) > 0.5) cols.push([`Packung<br>${num(pq)} ${per}`, (v) => v * pq / 100]);
    const rows = NUTS.map(([k, label, unit, f]) => {
      const v = nv(n, k); if (v === null || !Number.isFinite(v)) return '';
      const imp = h.nut.includes(k);
      return `<tr class="${imp ? 'imp' : ''} ${mark[k] ? 'm-' + mark[k] : ''}"><td>${mark[k] ? `<span class="dot ${mark[k]}"></span>` : ''}${esc(label)}</td>${cols.map(([, fn]) => `<td>${num(fn(f ? v * f : v))} ${unit}</td>`).join('')}</tr>`;
    }).join('');
    const thead = `<tr><th></th>${cols.map(([l]) => `<th>${l === '100' ? `pro<br>100 ${per}` : l}</th>`).join('')}</tr>`;
    const ownImg = Catalog.imgFor(ean);
    const allergens = (p.allergens_tags || []).map((t) => (ALLERGENS.find((a) => a[0] === t) || [, t.replace(/^\w+:/, '')])[1]);
    box.innerHTML = `<div class="prod-head"><label class="prod-photo-btn" title="Eigenes Foto">📷<input type="file" class="prod-own-photo" accept="image/*" capture="environment"></label>${ownImg ? `<img src="${esc(ownImg)}" alt="">` : p.image_front_small_url && /^https:\/\/images\.openfoodfacts\.org\//.test(p.image_front_small_url) ? `<img src="${esc(p.image_front_small_url)}" alt="">` : ''}
      <div><div class="prod-brand">${esc(brand)}</div><div class="prod-name">${esc(name)}</div><div class="muted">${esc(p.quantity || '')}${p.nutriscore_grade && /^[a-e]$/.test(p.nutriscore_grade) ? ` · Nutri-Score ${esc(p.nutriscore_grade.toUpperCase())}` : ''}</div></div></div>
      ${notes.length ? `<ul class="prod-notes">${notes.map((x) => `<li class="${x.c}"><span class="dot ${x.c}"></span>${esc(x.t)}</li>`).join('')}</ul>`
        : (people.length ? '<p class="prod-ok">🟢 Zu deinen Hinweisen nichts Auffälliges gefunden.</p>' : '')}
      ${!packQ ? `<label class="field prod-pack">Packungsinhalt (${per}) – für die Spalte „Packung“<input type="text" inputmode="decimal" class="prod-pack-in" value="${ownQ ? num(ownQ) : ''}" placeholder="z. B. 250"></label>` : ''}
      <table class="prod-nut${cols.length > 2 ? ' multi' : ''}"><caption>Nährwerte</caption>${rows ? thead + rows : '<tr><td>Keine Nährwerte erfasst</td></tr>'}</table>
      ${allergens.length ? `<p class="hint"><b>Allergene laut Hersteller:</b> ${esc(allergens.join(', '))}</p>` : ''}
      ${(p.ingredients_text_de || p.ingredients_text) ? `<details open><summary>Zutaten</summary><p class="hint">${esc(p.ingredients_text_de || p.ingredients_text)}</p></details>` : ''}
      <p class="hint">Angaben aus Open Food Facts – können unvollständig sein, die Verpackung gilt. Die Hinweise ersetzen keine ärztliche Beratung.</p>`;
    $('#prodAdd').hidden = false;
  }

  let prefWho = '';
  function openPrefs(who) {
    prefWho = typeof who === 'string' ? who : (prefWho || meName());
    const h = getH(prefWho);
    $('#hpWho').innerHTML = (state.settings.persons || [meName()]).map((x) => `<button type="button" aria-pressed="${x === prefWho}" data-who="${esc(x)}">${esc(x)}</button>`).join('');
    const chk = (name, id, label, on) => `<label class="pref"><input type="checkbox" data-g="${name}" value="${esc(id)}" ${on ? 'checked' : ''}><span>${esc(label)}</span></label>`;
    $('#hpNut').innerHTML = NUTS.slice(0, 10).map(([k, l]) => chk('nut', k, l, h.nut.includes(k))).join('');
    $('#hpDiag').innerHTML = DIAGS.map(([k, l]) => chk('diag', k, l, h.diag.includes(k))).join('');
    $('#hpAllergy').innerHTML = ALLERGENS.map(([k, l]) => chk('allergy', k, l, h.allergy.includes(k))).join('');
    $('#hpCustom').value = h.custom.join(', ');
    $('#prefDialog').showModal();
  }
  function savePrefs() {
    const h = { nut: [], diag: [], allergy: [], custom: [] };
    $$('#prefDialog input[data-g]:checked').forEach((c) => h[c.dataset.g].push(c.value));
    h.custom = $('#hpCustom').value.split(',').map((x) => x.trim()).filter((x) => x.length > 1).slice(0, 20);
    setH(prefWho, h); $('#prefDialog').close();
    if (lastP && $('#prodDialog').open) render(lastEan, lastP);
    toast(`Hinweise für ${prefWho} gespeichert`);
  }

  // ---------- Live-Kamera: Strichcode wird automatisch erkannt ----------
  let live = null;
  const eanOk = (c) => { if (!/^\d{8}$|^\d{12,13}$/.test(c)) return false; const d = c.padStart(13, '0').split('').map(Number); const sum = d.slice(0, 12).reduce((a, x, i) => a + x * (i % 2 ? 3 : 1), 0); return (10 - (sum % 10)) % 10 === d[12]; };
  function stopLive() {
    if (live) { clearInterval(live.timer); live.stream && live.stream.getTracks().forEach((t) => t.stop()); }
    live = null;
    const v = $('#prodVideo'); if (v) { try { v.pause(); } catch (e) { /* egal */ } v.srcObject = null; }
    $('#prodCam').hidden = true;
  }
  /** Eigene Kamera-Schleife: alle 0,2 s den mittleren Bildausschnitt nach einem Strichcode absuchen */
  async function startLive() {
    bind(); stopLive();
    current = null; lastP = null; shot = '';
    $('#prodResult').innerHTML = ''; $('#prodPrices').innerHTML = ''; $('#prodTagForm').hidden = true; $('#prodAdd').hidden = true; $('#prodEan').value = '';
    $('#prodCam').hidden = false; $('#prodCamHint').textContent = '📷 Kamera startet …';
    if (!$('#prodDialog').open) $('#prodDialog').showModal();
    const zx = loadZxing(); // parallel laden
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { const e = new Error('Kamera-Zugriff wird hier nicht unterstützt'); e.name = 'NoMedia'; throw e; }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
      const v = $('#prodVideo');
      v.setAttribute('playsinline', ''); v.setAttribute('muted', ''); v.muted = true; v.autoplay = true;
      v.srcObject = stream;
      live = { stream, timer: 0 };
      await v.play().catch(() => {});
      await zx;
      if (!live) return; // inzwischen geschlossen
      const hints = new Map();
      hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.EAN_13, ZXing.BarcodeFormat.EAN_8, ZXing.BarcodeFormat.UPC_A, ZXing.BarcodeFormat.UPC_E]);
      const reader = new ZXing.MultiFormatReader(); reader.setHints(hints);
      const c = document.createElement('canvas'), x = c.getContext('2d', { willReadFrequently: true });
      let seen = '', count = 0, busy = false;
      $('#prodCamHint').textContent = 'Strichcode ins Bild halten – wird automatisch erkannt';
      live.timer = setInterval(() => {
        if (!live || busy || !v.videoWidth) return;
        busy = true;
        try {
          const vw = v.videoWidth, vh = v.videoHeight;
          const cw = vw * 0.9, ch = vh * 0.5, sx = (vw - cw) / 2, sy = (vh - ch) / 2; // Bereich im Rahmen
          const sc = Math.min(1, 1000 / cw);
          c.width = Math.round(cw * sc); c.height = Math.round(ch * sc);
          x.drawImage(v, sx, sy, cw, ch, 0, 0, c.width, c.height);
          let t = '';
          try { t = reader.decode(new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(new ZXing.HTMLCanvasElementLuminanceSource(c)))).getText(); } catch (e) { /* noch nichts */ }
          if (t && eanOk(t)) {
            count = t === seen ? count + 1 : 1; seen = t;
            if (count >= 2) { // zweimal gleich gelesen = sicher
              if (navigator.vibrate) navigator.vibrate(60);
              try { shot = Catalog.thumb(v, vw, vh); } catch (e) { shot = ''; }
              stopLive(); show(t);
            }
          }
        } finally { busy = false; }
      }, 200);
    } catch (e) {
      stopLive();
      const why = e && e.name === 'NotAllowedError' ? 'Kamerazugriff wurde nicht erlaubt. Einstellungen → Safari → Kamera → „Erlauben“ (oder beim nächsten Mal „Erlauben“ tippen).'
        : e && e.name === 'NotReadableError' ? 'Die Kamera wird gerade von einer anderen App benutzt.'
        : `Kamera nicht verfügbar (${esc((e && (e.name + ': ' + e.message)) || 'unbekannt')}).`;
      $('#prodResult').innerHTML = `<p>⚠️ ${why}</p><p class="hint">Solange: 📷 Strichcode-Foto machen oder die Nummer unten eintippen.</p>`;
    }
  }

  // ---------- Preise: eigene (Preisschild/Bon) + freie Preisdatenbank Open Prices ----------
  const PRICES = 'https://prices.openfoodfacts.org/api/v1/prices';
  async function openPrices(ean) {
    const key = 'op-' + ean;
    try { const c = JSON.parse(localStorage.getItem(key) || 'null'); if (c && Date.now() - c.at < 864e5) return c.items; } catch (e) { /* egal */ }
    try {
      const r = await fetch(`${PRICES}?product_code=${encodeURIComponent(ean)}&currency=EUR&order_by=-date&size=50`);
      if (!r.ok) return [];
      const j = await r.json();
      const items = (j.items || []).filter((x) => x.location && x.location.osm_address_country_code === 'DE' && x.price > 0)
        .map((x) => ({ store: String(x.location.osm_brand || x.location.osm_name || '').slice(0, 40), city: String(x.location.osm_address_city || '').slice(0, 40), p: +x.price, d: String(x.date || '').slice(0, 10), deal: !!x.price_is_discounted }));
      try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), items })); } catch (e) { /* voll */ }
      return items;
    } catch (e) { return []; }
  }
  const myPrices = (ean) => ({ ...(((state.settings.prices || {})[ean]) || {}), ...Catalog.pricesFor(ean) });
  let shot = '';
  const meta = (ean) => ({ ean, name: current ? current.pname : ean, brand: current ? current.brand : '', qty: current ? current.qty : '', img: (current && current.img) || shot });
  function savePrice(ean, store, p, d) {
    const all = { ...(state.settings.prices || {}) };
    all[ean] = { ...(all[ean] || {}), [store]: { p, d: d || new Date().toISOString().slice(0, 10), t: Date.now() } };
    state.settings.prices = all; save();
  }
  const eur = (v) => (+v).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
  const dshort = (d) => (d ? d.split('-').reverse().join('.') : '');
  async function renderPrices(ean, name) {
    const box = $('#prodPrices'); if (!box) return;
    const mine = Object.entries(myPrices(ean)).map(([store, v]) => ({ store, p: v.p, d: v.d, own: true }));
    const bon = Shop.priceFor(name);
    const known = Shop.stores().map((x) => x.toLowerCase());
    const draw = (others) => {
      const ownStores = new Set(mine.map((x) => x.store.toLowerCase()));
      const best = new Map();
      for (const o of others) { const k = o.store.toLowerCase(); if (!o.store || ownStores.has(k)) continue; if (!best.has(k)) best.set(k, o); }
      const ext = [...best.values()].sort((a, b) => (known.some((k) => b.store.toLowerCase().includes(k)) - known.some((k) => a.store.toLowerCase().includes(k))) || a.p - b.p).slice(0, 6);
      const rows = [...mine.sort((a, b) => a.p - b.p).map((x) => `<li><b>${esc(x.store)}</b><span>${eur(x.p)}</span><small>dein Preis · ${esc(dshort(x.d))}</small></li>`),
        ...ext.map((x) => `<li><b>${esc(x.store)}</b><span>${eur(x.p)}${x.deal ? ' %' : ''}</span><small>${esc(x.city)} · ${esc(dshort(x.d))}</small></li>`)];
      box.innerHTML = `<h3 class="small-h">💶 Wo gibt es das – und zu welchem Preis?</h3>
        ${rows.length ? `<ul class="prod-prices">${rows.join('')}</ul>` : '<p class="hint">Noch kein Preis bekannt.</p>'}
        ${bon ? `<p class="hint">Aus deinen Bons: ${esc(bon)}</p>` : ''}
        <label class="btn btn-sm btn-file">🏷️ Preisschild fotografieren<input type="file" id="prodTag" accept="image/*" capture="environment"></label>
        <button type="button" class="btn btn-sm" id="prodPriceManual">✏️ Preis eintragen</button>
        <div class="row-btns">${(() => { const q = encodeURIComponent(((current && current.name) || name || ean) + (current && current.qty ? ' ' + current.qty : ''));
          return `<a class="btn btn-sm" target="_blank" rel="noopener noreferrer" href="https://www.google.de/search?tbm=shop&q=${q}">🌐 Preis online suchen</a><a class="btn btn-sm" target="_blank" rel="noopener noreferrer" href="https://www.idealo.de/preisvergleich/MainSearchProductCategory.html?q=${q}">idealo</a>`; })()}</div>
        <p class="hint">Fremde Preise: freie Preisdatenbank „Open Prices“ (von Nutzern gemeldet, nur Deutschland). Live-Preise der Märkte gibt es leider nicht öffentlich.</p>`;
    };
    draw([]);
    draw(await openPrices(ean));
  }

  /** Preisschild am Regal lesen: Preis (größte Zahl), Laden, Strichcode-Nummer */
  async function readTag(file) {
    const ean = $('#prodEan').value.replace(/\D/g, '');
    $('#prodTagForm').hidden = false; $('#ptHint').textContent = '🔍 Lese Preisschild …';
    const st = Shop.stores();
    $('#ptStore').innerHTML = st.map((x) => `<option>${esc(x)}</option>`).join('');
    $('#ptPrice').value = '';
    try {
      const canvas = await Receipt._toCanvas(file);
      const w = await Receipt._getWorker(() => {});
      const { data } = await w.recognize(canvas);
      const words = (data.words || []).map((x) => ({ t: x.text, h: x.bbox.y1 - x.bbox.y0, cx: (x.bbox.x0 + x.bbox.x1) / 2 }));
      const text = data.text || '';
      const eanW = words.find((x) => ean && x.t.replace(/\D/g, '') === ean);
      const cands = words.map((x) => ({ ...x, v: (x.t.match(/^(\d{1,3})[,.](\d{2})$/) || [])[0] })).filter((x) => x.v && !/kg|ltr|l=|=/i.test(x.t));
      if (eanW) cands.forEach((x) => { x.h -= Math.abs(x.cx - eanW.cx) / 20; }); // bei 2 Schildern: das mit „unserem“ Strichcode
      cands.sort((a, b) => b.h - a.h);
      if (cands[0]) $('#ptPrice').value = cands[0].v.replace('.', ',');
      const low = text.toLowerCase();
      const hit = st.find((x) => low.includes(x.toLowerCase().split(' ')[0]));
      if (hit) $('#ptStore').value = hit;
      $('#ptHint').textContent = cands[0] ? 'Bitte kurz prüfen und speichern.' : 'Preis nicht erkannt – bitte eintippen.';
    } catch (e) { $('#ptHint').textContent = 'Konnte das Schild nicht lesen – bitte eintippen.'; }
  }

  async function handleFile(file) {
    if (!file) return;
    bind();
    $('#prodResult').innerHTML = '<p>🔍 Lese Strichcode …</p>'; $('#prodAdd').hidden = true; $('#prodPrices').innerHTML = ''; $('#prodTagForm').hidden = true;
    $('#prodDialog').showModal();
    try {
      shot = await Catalog.thumbFromFile(file);
      const ean = await readBarcode(file);
      if (!ean) { $('#prodResult').innerHTML = '<p>Kein Strichcode erkannt.</p><p class="hint">Bitte den Strichcode nah, gerade und scharf fotografieren – oder die Nummer unten eintippen.</p>'; return; }
      await show(ean);
    } catch (e) { $('#prodResult').innerHTML = `<p>⚠️ ${esc(e.message)}</p>`; }
  }
  async function show(ean) {
    stopLive();
    $('#prodEan').value = ean;
    $('#prodResult').innerHTML = `<p>🔍 Suche Produkt ${esc(ean)} …</p>`;
    try { render(ean, await lookup(ean)); } catch (e) { $('#prodResult').innerHTML = `<p>⚠️ ${esc(e.message)}</p>`; }
    renderPrices(ean, current ? current.name : '');
  }

  function bind() {
    if (bound) return; bound = true;
    $('#prodClose').onclick = () => $('#prodDialog').close();
    $('#prodDialog').addEventListener('close', stopLive);
    $('#prodRescan').onclick = startLive;
    const ownPhoto = async (e) => {
      const f = e.target.files[0]; e.target.value = ''; const ean = $('#prodEan').value.replace(/\D/g, '');
      if (!f || ean.length < 8) { toast('Erst Strichcode scannen oder eintippen'); return; }
      const t = await Catalog.thumbFromFile(f); if (!t) return;
      if (current && current.unknown) { const v = ($('#prodOwnName') || {}).value || ''; if (v.trim()) current.name = current.pname = v.trim().slice(0, 80); }
      Catalog.setImg(meta(ean), t); toast('📷 Foto gespeichert');
      const head = $('#prodResult .prod-head img'); if (head) head.src = t; else if ($('#prodResult .prod-head')) $('#prodResult .prod-head').insertAdjacentHTML('beforeend', `<img src="${t}" alt="">`); else $('#prodResult').insertAdjacentHTML('afterbegin', `<div class="prod-head"><img src="${t}" alt=""></div>`);
    };
    $('#prodOwnPhoto').addEventListener('change', ownPhoto);
    $('#prodResult').addEventListener('change', (e) => {
      if (e.target.matches('.prod-own-photo')) ownPhoto(e);
      if (e.target.matches('.prod-pack-in')) { const q = parseFloat(e.target.value.replace(',', '.')); const ean = $('#prodEan').value.replace(/\D/g, ''); if (q > 0 && q < 20000 && ean) { Catalog.setPack(meta(ean), q); if (lastP) render(lastEan, lastP); } }
    });
    $('#prodPhoto2').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) { stopLive(); handleFile(f); } });
    $('#prodPrices').addEventListener('change', (e) => { if (e.target.id === 'prodTag') { const f = e.target.files[0]; e.target.value = ''; if (f) readTag(f); } });
    $('#prodPrices').addEventListener('click', (e) => { if (e.target.id === 'prodPriceManual') { $('#ptStore').innerHTML = Shop.stores().map((x) => `<option>${esc(x)}</option>`).join(''); $('#ptPrice').value = ''; $('#ptHint').textContent = ''; $('#prodTagForm').hidden = false; $('#ptPrice').focus(); } });
    $('#ptCancel').onclick = () => { $('#prodTagForm').hidden = true; };
    $('#ptSave').onclick = () => {
      const ean = $('#prodEan').value.replace(/\D/g, ''), p = parseFloat($('#ptPrice').value.replace(',', '.'));
      if (ean.length < 8 || !(p > 0 && p < 10000)) { toast('Bitte Strichcode und Preis prüfen'); return; }
      Catalog.setPrice(meta(ean), $('#ptStore').value, Math.round(p * 100) / 100);
      $('#prodTagForm').hidden = true; toast('💶 Preis gespeichert'); renderPrices(ean, current ? current.name : '');
    };
    $('#prodPrefs').onclick = openPrefs;
    $('#hpSave').onclick = savePrefs;
    $('#hpWho').onclick = (e) => { const b = e.target.closest('[data-who]'); if (b) openPrefs(b.dataset.who); };
    // alte, nur lokal gespeicherte Hinweise einmalig übernehmen
    try { const old = localStorage.getItem('ausgaben-health-v1'); if (old && !(state.settings.health || {})[meName()]) { setH(meName(), { ...EMPTY(), ...JSON.parse(old) }); } localStorage.removeItem('ausgaben-health-v1'); } catch (e) { /* egal */ }
    $('#hpCancel').onclick = () => $('#prefDialog').close();
    $('#hpNone').onclick = () => { $$('#prefDialog input[data-g]').forEach((c) => { c.checked = false; }); $('#hpCustom').value = ''; };
    $('#prodAdd').onclick = () => { if (!current) return; if (current.unknown) { const v = ($('#prodOwnName') || {}).value || ''; if (!v.trim()) { toast('Bitte einen Produktnamen eintragen'); return; } current.name = current.pname = v.trim().slice(0, 80); } const pid = Catalog.upsertScan(meta(current.ean)); Shop.addItems([current.pname || current.name], '', { pid }); $('#prodDialog').close(); toast('🛒 auf der Einkaufsliste'); };
    $('#prodEanBtn').onclick = () => { const v = $('#prodEan').value.replace(/\D/g, ''); if (v.length >= 8) show(v); else toast('Bitte die Ziffern unter dem Strichcode eintippen'); };
  }
  const showEan = (ean) => { bind(); shot = ''; $('#prodCam').hidden = true; if (!$('#prodDialog').open) $('#prodDialog').showModal(); show(ean); };
  return { handleFile, bind, openPrefs, startLive, showEan };
})();
