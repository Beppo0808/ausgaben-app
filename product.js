/*
 * Produkt-Scanner: Strichcode (EAN) fotografieren → Open Food Facts (freie Lebensmittel-Datenbank)
 * Übertragen wird nur der Strichcode – keine Namen, Preise oder Kontodaten.
 * Preis kommt aus euren eigenen Kassenbons (falls schon einmal gekauft).
 */
const Product = (() => {
  const ZXING_URL = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';
  const OFF = 'https://world.openfoodfacts.org/api/v2/product/';
  const FIELDS = 'product_name,product_name_de,generic_name_de,brands,quantity,nutriments,ingredients_text_de,ingredients_text,nutriscore_grade,image_front_small_url,allergens_tags,traces_tags';
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

  // ---------- Meine Hinweise (nur auf diesem Gerät – Gesundheitsdaten werden nie geteilt) ----------
  const HKEY = 'ausgaben-health-v1';
  const getH = () => { try { return { nut: [], diag: [], allergy: [], custom: [], ...JSON.parse(localStorage.getItem(HKEY) || '{}') }; } catch (e) { return { nut: [], diag: [], allergy: [], custom: [] }; } };
  const setH = (h) => { try { localStorage.setItem(HKEY, JSON.stringify(h)); } catch (e) { /* voll */ } };

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
  function assess(p) {
    const h = getH(), n = p.nutriments || {}, out = [], mark = {};
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
      box.innerHTML = `<p>Strichcode <b>${esc(ean)}</b> ist in der freien Datenbank (noch) nicht erfasst.</p><p class="hint">Du kannst das Produkt trotzdem von Hand auf die Einkaufsliste setzen.</p>`;
      $('#prodAdd').hidden = true; return;
    }
    const n = p.nutriments || {}, h = getH();
    const name = p.product_name_de || p.product_name || p.generic_name_de || 'Produkt';
    const brand = (p.brands || '').split(',')[0].trim();
    current = { ean, name: [brand, name].filter(Boolean).join(' ').slice(0, 70), qty: p.quantity || '' };
    const { notes, mark } = assess(p);
    const rows = NUTS.map(([k, label, unit, f]) => {
      const v = nv(n, k); if (v === null || !Number.isFinite(v)) return '';
      const val = f ? v * f : v;
      const imp = h.nut.includes(k);
      return `<tr class="${imp ? 'imp' : ''} ${mark[k] ? 'm-' + mark[k] : ''}"><td>${mark[k] ? `<span class="dot ${mark[k]}"></span>` : ''}${esc(label)}</td><td>${num(val)} ${unit}</td></tr>`;
    }).join('');
    const price = Shop.priceFor(current.name) || Shop.priceFor(name);
    const allergens = (p.allergens_tags || []).map((t) => (ALLERGENS.find((a) => a[0] === t) || [, t.replace(/^\w+:/, '')])[1]);
    box.innerHTML = `<div class="prod-head">${p.image_front_small_url && /^https:\/\/images\.openfoodfacts\.org\//.test(p.image_front_small_url) ? `<img src="${esc(p.image_front_small_url)}" alt="">` : ''}
      <div><div class="prod-brand">${esc(brand)}</div><div class="prod-name">${esc(name)}</div><div class="muted">${esc(p.quantity || '')}${p.nutriscore_grade && /^[a-e]$/.test(p.nutriscore_grade) ? ` · Nutri-Score ${esc(p.nutriscore_grade.toUpperCase())}` : ''}</div></div></div>
      ${notes.length ? `<ul class="prod-notes">${notes.map((x) => `<li class="${x.c}"><span class="dot ${x.c}"></span>${esc(x.t)}</li>`).join('')}</ul>`
        : (h.diag.length || h.allergy.length || h.custom.length ? '<p class="prod-ok">🟢 Zu deinen Hinweisen nichts Auffälliges gefunden.</p>' : '')}
      <table class="prod-nut"><caption>Alle Nährwerte pro 100 g / 100 ml</caption>${rows || '<tr><td colspan="2">Keine Nährwerte erfasst</td></tr>'}</table>
      ${allergens.length ? `<p class="hint"><b>Allergene laut Hersteller:</b> ${esc(allergens.join(', '))}</p>` : ''}
      <p class="prod-price">💶 ${price ? esc(price) : 'Preis: noch kein Bon mit diesem Produkt – nach dem Einkauf den Bon scannen'}</p>
      ${(p.ingredients_text_de || p.ingredients_text) ? `<details open><summary>Zutaten</summary><p class="hint">${esc(p.ingredients_text_de || p.ingredients_text)}</p></details>` : ''}
      <p class="hint">Angaben aus Open Food Facts – können unvollständig sein, die Verpackung gilt. Die Hinweise ersetzen keine ärztliche Beratung.</p>`;
    $('#prodAdd').hidden = false;
  }

  function openPrefs() {
    const h = getH();
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
    setH(h); $('#prefDialog').close();
    if (lastP && $('#prodDialog').open) render(lastEan, lastP);
    toast('Meine Hinweise gespeichert – nur auf diesem Gerät');
  }

  async function handleFile(file) {
    if (!file) return;
    bind();
    $('#prodResult').innerHTML = '<p>🔍 Lese Strichcode …</p>'; $('#prodAdd').hidden = true;
    $('#prodDialog').showModal();
    try {
      const ean = await readBarcode(file);
      if (!ean) { $('#prodResult').innerHTML = '<p>Kein Strichcode erkannt.</p><p class="hint">Bitte den Strichcode nah, gerade und scharf fotografieren – oder die Nummer unten eintippen.</p>'; return; }
      await show(ean);
    } catch (e) { $('#prodResult').innerHTML = `<p>⚠️ ${esc(e.message)}</p>`; }
  }
  async function show(ean) {
    $('#prodEan').value = ean;
    $('#prodResult').innerHTML = `<p>🔍 Suche Produkt ${esc(ean)} …</p>`;
    try { render(ean, await lookup(ean)); } catch (e) { $('#prodResult').innerHTML = `<p>⚠️ ${esc(e.message)}</p>`; }
  }

  function bind() {
    if (bound) return; bound = true;
    $('#prodClose').onclick = () => $('#prodDialog').close();
    $('#prodPrefs').onclick = openPrefs;
    $('#hpSave').onclick = savePrefs;
    $('#hpCancel').onclick = () => $('#prefDialog').close();
    $('#hpNone').onclick = () => { $$('#prefDialog input[data-g]').forEach((c) => { c.checked = false; }); $('#hpCustom').value = ''; };
    $('#prodAdd').onclick = () => { if (!current) return; Shop.addItems([(current.qty ? '' : '') + current.name]); $('#prodDialog').close(); toast('🛒 auf der Einkaufsliste'); };
    $('#prodEanBtn').onclick = () => { const v = $('#prodEan').value.replace(/\D/g, ''); if (v.length >= 8) show(v); else toast('Bitte die Ziffern unter dem Strichcode eintippen'); };
  }
  return { handleFile, bind, openPrefs };
})();
