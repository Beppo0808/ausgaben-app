/*
 * Unsere Produkte: alles, was ihr schon gekauft oder gescannt habt – mit Foto, Laden und Preis.
 * Antippen setzt es auf die Einkaufsliste (mit dem passenden Laden).
 * Ein gescannter Bon hakt passende Einträge auf der Liste automatisch ab – auch bei anderer Marke oder anderem Laden.
 */
const Catalog = (() => {
  let bound = false, q = '', editing = null, picking = null;
  const norm = (s) => String(s || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const list = () => (Array.isArray(state.products) ? state.products : (state.products = []));
  const today = () => new Date().toISOString().slice(0, 10);
  const imgOk = (s) => typeof s === 'string' && (/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s) || /^https:\/\/images\.openfoodfacts\.org\/[\w\-./]+$/.test(s));
  const emojiOf = (name) => Array.from(GROUP_LABEL[itemGroup(name)] || '📦')[0];
  const dshort = (d) => (d ? d.split('-').reverse().join('.') : '');

  /** Kleines Vorschaubild (für die Kachel) aus Bild oder Kamera */
  function thumb(src, w0, h0) {
    const s = 220 / Math.max(w0, h0), c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w0 * s)); c.height = Math.max(1, Math.round(h0 * s));
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.72);
  }
  function thumbFromFile(file) {
    return new Promise((res) => {
      const u = URL.createObjectURL(file), i = new Image();
      i.onload = () => { try { res(thumb(i, i.naturalWidth, i.naturalHeight)); } catch (e) { res(''); } URL.revokeObjectURL(u); };
      i.onerror = () => { URL.revokeObjectURL(u); res(''); };
      i.src = u;
    });
  }

  /** Ladenname wie in der Ladenleiste schreiben („EDEKA“ → „Edeka“) */
  const niceStore = (st) => { const n = norm(st); if (!n) return ''; return Shop.stores().find((s) => { const k = norm(s); return k === n || k.split(' ')[0] === n.split(' ')[0]; }) || st; };

  // ---------- Einträge aus Bons (ohne Speichern – werden jedes Mal aus den Bons berechnet) ----------
  function fromBons() {
    const m = new Map();
    state.expenses.filter((e) => !e.private || isMine(e)).forEach((e) => (e.items || []).forEach((it) => {
      if (!it.name || !(it.price > 0) || it.price > 500) return;
      const k = norm(it.name); if (k.length < 3 || /^(pfand|leergut|rabatt|summe)/.test(k)) return;
      const st = niceStore(storeOf(e.merchant) || e.merchant || '');
      const each = it.qty && it.unit ? it.unit : it.price;
      const x = m.get(k) || { key: k, name: it.name, stores: {}, n: 0, last: '' };
      x.n++; if ((e.date || '') >= x.last) { x.last = e.date || ''; x.name = it.name; }
      if (st && (!x.stores[st] || (e.date || '') >= x.stores[st].d)) x.stores[st] = { p: each, d: e.date || '' };
      m.set(k, x);
    }));
    return m;
  }

  /** Alle Kacheln: gespeicherte Produkte (mit Bon-Preisen ergänzt) + übrige Bon-Artikel */
  function entries() {
    const bons = fromBons(), out = [];
    for (const p of list()) {
      const stores = { ...(p.stores || {}) };
      for (const a of p.aliases || []) {
        const b = bons.get(a); if (!b) continue;
        for (const [st, v] of Object.entries(b.stores)) if (!stores[st] || v.d >= (stores[st].d || '')) stores[st] = v;
        bons.delete(a);
      }
      out.push({ id: p.id, name: p.name, brand: p.brand || '', qty: p.qty || '', img: imgOk(p.img) ? p.img : '', ean: p.ean || '', stores, saved: true, at: p.at || '' });
    }
    const rest = [...bons.values()].sort((a, b) => b.n - a.n || b.last.localeCompare(a.last))
      .map((b) => ({ key: b.key, name: b.name, stores: b.stores, saved: false, at: b.last }));
    return out.concat(rest);
  }
  const best = (stores) => Object.entries(stores || {}).map(([st, v]) => ({ st, ...v })).sort((a, b) => a.p - b.p);

  // ---------- Ansicht ----------
  function render() {
    bind();
    const all = entries();
    const nq = norm(q);
    const shown = (nq ? all.filter((x) => norm(`${x.brand || ''} ${x.name}`).includes(nq)) : all).slice(0, 240);
    $('#catCount').textContent = `${all.length} Produkte`;
    $('#catGrid').innerHTML = shown.length ? shown.map((x, i) => {
      const b = best(x.stores);
      return `<div class="cat-tile" data-i="${i}">
        <button type="button" class="cat-pic" data-act="add" aria-label="${esc(x.name)} auf die Einkaufsliste">${x.img ? `<img src="${esc(x.img)}" alt="" loading="lazy">` : `<span>${emojiOf(x.name)}</span>`}</button>
        <button type="button" class="cat-info" data-act="edit" aria-label="Details">ⓘ</button>
        <div class="cat-name">${x.brand ? `<small>${esc(x.brand)}</small>` : ''}${esc(x.name)}${x.qty ? ` <small>${esc(x.qty)}</small>` : ''}</div>
        <div class="cat-price">${b.length ? `${fmt(b[0].p)} · ${esc(b[0].st)}${b.length > 1 ? ` <small>+${b.length - 1}</small>` : ''}` : '<small>noch kein Preis</small>'}</div>
      </div>`;
    }).join('') : '<div class="empty-state">Noch keine Produkte.<br>Sie entstehen automatisch aus euren Bons und aus gescannten Produkten.</div>';
    current = shown;
  }
  let current = [];

  function onGrid(e) {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const x = current[+b.closest('[data-i]').dataset.i]; if (!x) return;
    if (b.dataset.act === 'add') addToList(x); else openEdit(x);
  }

  function addToList(x, store) {
    const b = best(x.stores);
    if (store === undefined && b.length > 1) { picking = x; openPick(x, b); return; }
    const st = store !== undefined ? store : (b[0] ? b[0].st : '');
    const shopName = niceStore(st);
    Shop.addItems([x.name], '', { store: shopName, pid: x.id || '', bk: x.key || '' });
    toast(`🛒 ${x.name}${shopName ? ' · ' + shopName : ''}`);
  }
  function openPick(x, b) {
    $('#catPickTitle').textContent = x.name;
    $('#catPickList').innerHTML = b.map((v) => `<button type="button" class="btn cat-pick" data-st="${esc(v.st)}">${esc(v.st)} <b>${fmt(v.p)}</b><small>${esc(dshort(v.d))}</small></button>`).join('')
      + '<button type="button" class="btn btn-ghost cat-pick" data-st="">Egal wo</button>';
    $('#catPickDialog').showModal();
  }

  // ---------- Details / Foto / Name ----------
  function openEdit(x) {
    editing = x;
    $('#ceName').value = x.name; $('#ceBrand').value = x.brand || ''; $('#ceQty').value = x.qty || '';
    $('#cePic').innerHTML = x.img ? `<img src="${esc(x.img)}" alt="">` : `<span>${emojiOf(x.name)}</span>`;
    $('#cePic').dataset.img = x.img || '';
    $('#cePrices').innerHTML = best(x.stores).map((v) => `<li><b>${esc(v.st)}</b><span>${fmt(v.p)}</span><small>${esc(dshort(v.d))}</small></li>`).join('') || '<li><small>noch kein Preis</small></li>';
    $('#ceNut').hidden = !x.ean; $('#ceDel').hidden = !x.saved;
    $('#catEditDialog').showModal();
  }
  function saveEdit() {
    const x = editing; if (!x) return;
    const name = $('#ceName').value.trim().slice(0, 80); if (!name) { toast('Bitte einen Namen eintragen'); return; }
    const img = $('#cePic').dataset.img || '';
    let p = x.saved ? list().find((y) => y.id === x.id) : null;
    if (!p) { p = { id: uid(), aliases: x.key ? [x.key] : [], stores: {}, at: new Date().toISOString() }; list().push(p); }
    Object.assign(p, { name, brand: $('#ceBrand').value.trim().slice(0, 40), qty: $('#ceQty').value.trim().slice(0, 20), img: imgOk(img) ? img : '' });
    save(); $('#catEditDialog').close(); render(); toast('Gespeichert ✓');
  }

  // ---------- Verbindungen zu Scanner und Bon ----------
  /** Gescanntes Produkt merken (oder vorhandenes ergänzen) – gibt die Produkt-Id zurück */
  function upsertScan({ ean, name, brand, qty, img }) {
    if (!ean && !name) return '';
    let p = (ean && list().find((y) => y.ean === ean)) || list().find((y) => !y.ean && norm(y.name) === norm(name));
    if (!p) { p = { id: uid(), ean: ean || '', name: (name || ean).slice(0, 80), brand: (brand || '').slice(0, 40), qty: (qty || '').slice(0, 20), aliases: [], stores: {}, at: new Date().toISOString() }; list().push(p); }
    if (!p.img && imgOk(img)) p.img = img;
    if (ean && !p.ean) p.ean = ean;
    save();
    return p.id;
  }
  function setPrice(meta, store, price) {
    const id = upsertScan(meta); const p = list().find((y) => y.id === id); if (!p) return;
    p.stores = { ...(p.stores || {}), [store]: { p: price, d: today() } };
    save();
  }
  const packFor = (ean) => { const p = list().find((y) => ean && y.ean === ean); return p && +p.pack > 0 ? +p.pack : 0; };
  function setPack(meta, q) { const id = upsertScan(meta); const p = list().find((y) => y.id === id); if (p) { p.pack = q; save(); } }
  const byEan = (ean) => list().find((y) => ean && y.ean === ean) || null;
  const imgFor = (ean) => { const p = byEan(ean); return p && imgOk(p.img) && p.img.startsWith('data:') ? p.img : ''; };
  function setImg(meta, img) {
    const id = upsertScan(meta); const p = list().find((y) => y.id === id); if (!p || !imgOk(img)) return;
    p.img = img; if (meta.name && (!p.name || p.name === p.ean)) p.name = meta.name.slice(0, 80);
    save();
  }
  const pricesFor = (ean) => { const p = list().find((y) => ean && y.ean === ean); return p ? entries().find((x) => x.id === p.id).stores : {}; };

  // Wortvergleich, der Kassenbon-Kürzel versteht: „BUTT.“ = Butter, „H-Vollmilch“ = Milch, aber nicht „Milchschokolade“ = Milch
  const wordHit = (w, bw) => bw === w || (bw.length >= 4 && w.startsWith(bw)) || (bw.startsWith(w) && bw.length <= w.length + 2) || (w.length >= 4 && bw.endsWith(w))
    || (bw.length >= 4 && w.lastIndexOf(bw) > 0 && w.length - w.lastIndexOf(bw) <= bw.length + 3); // „Weidebutter“ ↔ „BUTT.“
  const sigWords = (name, brand) => {
    const skip = new Set(norm(brand).split(' '));
    return norm(name).split(' ').filter((w) => w.length >= 3 && !/^\d/.test(w) && !skip.has(w) && !/^(ltr|liter|gramm|stk|stueck|pack|bio|ja|gut|guenstig|und|mit)$/.test(w));
  };

  /** Nach dem Bon-Scan: passende offene Einträge abhaken, Produkt-Preise ergänzen. Liefert die Zahl der abgehakten Einträge. */
  function fromBon(exp) {
    if (!exp || !Array.isArray(exp.items) || !exp.items.length || !Array.isArray(state.shopping)) return 0;
    const st = niceStore(storeOf(exp.merchant) || exp.merchant || '');
    const bonItems = exp.items.filter((it) => it.name).map((it) => ({ it, k: norm(it.name), ws: norm(it.name).split(' '), used: false }));
    let n = 0;
    for (const x of state.shopping.filter((s) => !s.done)) {
      const prod = x.pid ? list().find((y) => y.id === x.pid) : null;
      // Allgemeiner Eintrag („Butter“): Hauptwort genügt – jede Marke, jeder Laden. Bestimmtes Produkt mit mehreren Wörtern: mind. 2 Wörter müssen passen
      const ws = sigWords(x.name, prod && prod.brand), hw = ws[ws.length - 1] || '';
      const need = prod && ws.length >= 2 ? 2 : 1;
      const fits = (b) => { const hits = ws.filter((w) => b.ws.some((bw) => wordHit(w, bw))).length; return hw && b.ws.some((bw) => wordHit(hw, bw)) ? hits >= need : need === 2 && hits >= 2; };
      const hit = bonItems.find((b) => !b.used && ((prod && (prod.aliases || []).includes(b.k)) || (x.bk && x.bk === b.k))) || bonItems.find((b) => !b.used && fits(b));
      if (!hit) continue;
      hit.used = true; n++;
      x.done = true; x.doneBy = state.settings.me; x.doneAt = new Date().toISOString(); x.note = `laut Bon${st ? ' · ' + st : ''}`;
      if (prod) { // Bon-Name merken: nächstes Mal sicher erkannt, Preis landet beim Produkt
        if (!(prod.aliases || []).includes(hit.k)) prod.aliases = [...(prod.aliases || []), hit.k].slice(-12);
      }
    }
    if (n) save();
    return n;
  }

  function bind() {
    if (bound) return; bound = true;
    $('#catGrid').addEventListener('click', onGrid);
    $('#catSearch').addEventListener('input', (e) => { q = e.target.value; render(); });
    $('#catPickList').addEventListener('click', (e) => { const b = e.target.closest('[data-st]'); if (!b || !picking) return; $('#catPickDialog').close(); addToList(picking, b.dataset.st); picking = null; });
    $('#catPickCancel').onclick = () => $('#catPickDialog').close();
    $('#cePhoto').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; const t = await thumbFromFile(f); if (t) { $('#cePic').dataset.img = t; $('#cePic').innerHTML = `<img src="${t}" alt="">`; } });
    $('#ceSave').onclick = saveEdit;
    $('#ceCancel').onclick = () => $('#catEditDialog').close();
    $('#ceAdd').onclick = () => { if (editing) { $('#catEditDialog').close(); addToList(editing); } };
    $('#ceNut').onclick = () => { if (editing && editing.ean) { $('#catEditDialog').close(); Product.showEan(editing.ean); } };
    $('#ceDel').onclick = () => {
      if (!editing || !editing.saved || !confirm('Dieses Produkt aus „Unsere Produkte“ entfernen?')) return;
      state.products = list().filter((y) => y.id !== editing.id); save(); $('#catEditDialog').close(); render();
    };
  }

  return { render, fromBon, upsertScan, setPrice, pricesFor, packFor, setPack, byEan, imgFor, setImg, thumb, thumbFromFile };
})();
