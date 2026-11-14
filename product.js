/*
 * Produkt-Scanner: Strichcode (EAN) fotografieren → Open Food Facts (freie Lebensmittel-Datenbank)
 * Übertragen wird nur der Strichcode – keine Namen, Preise oder Kontodaten.
 * Preis kommt aus euren eigenen Kassenbons (falls schon einmal gekauft).
 */
const Product = (() => {
  const ZXING_URL = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';
  const OFF = 'https://world.openfoodfacts.org/api/v2/product/';
  const FIELDS = 'product_name,product_name_de,generic_name_de,brands,quantity,nutriments,ingredients_text_de,ingredients_text,nutriscore_grade,image_front_small_url,allergens_tags';
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

  const num = (v) => (Number.isFinite(+v) ? (+v).toLocaleString('de-DE', { maximumFractionDigits: 1 }) : '–');
  function render(ean, p) {
    const box = $('#prodResult');
    if (!p) {
      current = null;
      box.innerHTML = `<p>Strichcode <b>${esc(ean)}</b> ist in der freien Datenbank (noch) nicht erfasst.</p><p class="hint">Du kannst das Produkt trotzdem von Hand auf die Einkaufsliste setzen.</p>`;
      $('#prodAdd').hidden = true; return;
    }
    const n = p.nutriments || {};
    const name = p.product_name_de || p.product_name || p.generic_name_de || 'Produkt';
    const brand = (p.brands || '').split(',')[0].trim();
    current = { ean, name: [brand, name].filter(Boolean).join(' ').slice(0, 70), qty: p.quantity || '' };
    const sugar = +n.sugars_100g, prot = +n.proteins_100g;
    const flag = Number.isFinite(sugar) ? (sugar > 15 ? '🔴 viel Zucker' : sugar > 5 ? '🟡 mittel Zucker' : '🟢 wenig Zucker') : '';
    const price = Shop.priceFor(current.name) || Shop.priceFor(name);
    box.innerHTML = `<div class="prod-head">${p.image_front_small_url && /^https:\/\/images\.openfoodfacts\.org\//.test(p.image_front_small_url) ? `<img src="${esc(p.image_front_small_url)}" alt="">` : ''}
      <div><div class="prod-brand">${esc(brand)}</div><div class="prod-name">${esc(name)}</div><div class="muted">${esc(p.quantity || '')}${p.nutriscore_grade && /^[a-e]$/.test(p.nutriscore_grade) ? ` · Nutri-Score ${esc(p.nutriscore_grade.toUpperCase())}` : ''}</div></div></div>
      ${flag ? `<p class="prod-flag">${flag}${Number.isFinite(prot) && prot >= 10 ? ' · 💪 eiweißreich' : ''}</p>` : ''}
      <table class="prod-nut"><caption>pro 100 g / 100 ml</caption>
        <tr><td>Energie</td><td>${num(n['energy-kcal_100g'])} kcal</td></tr>
        <tr><td>Fett</td><td>${num(n.fat_100g)} g</td></tr>
        <tr><td>Kohlenhydrate</td><td>${num(n.carbohydrates_100g)} g</td></tr>
        <tr class="hl"><td>davon Zucker</td><td>${num(n.sugars_100g)} g</td></tr>
        <tr class="hl"><td>Eiweiß</td><td>${num(n.proteins_100g)} g</td></tr>
        <tr><td>Ballaststoffe</td><td>${num(n.fiber_100g)} g</td></tr>
        <tr><td>Salz</td><td>${num(n.salt_100g)} g</td></tr></table>
      <p class="prod-price">💶 ${price ? esc(price) : 'Preis: noch kein Bon mit diesem Produkt – nach dem Einkauf den Bon scannen'}</p>
      ${(p.ingredients_text_de || p.ingredients_text) ? `<details><summary>Zutaten</summary><p class="hint">${esc(p.ingredients_text_de || p.ingredients_text)}</p></details>` : ''}
      <p class="hint">Angaben aus Open Food Facts (freie Datenbank) – können unvollständig sein, die Verpackung gilt.</p>`;
    $('#prodAdd').hidden = false;
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
    $('#prodAdd').onclick = () => { if (!current) return; Shop.addItems([(current.qty ? '' : '') + current.name]); $('#prodDialog').close(); toast('🛒 auf der Einkaufsliste'); };
    $('#prodEanBtn').onclick = () => { const v = $('#prodEan').value.replace(/\D/g, ''); if (v.length >= 8) show(v); else toast('Bitte die Ziffern unter dem Strichcode eintippen'); };
  }
  return { handleFile, bind };
})();
