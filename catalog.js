/*
 * Unsere Produkte: alles, was ihr schon gekauft oder gescannt habt – mit Foto, Laden und Preis.
 * Antippen setzt es auf die Einkaufsliste (mit dem passenden Laden).
 * Ein gescannter Bon hakt passende Einträge auf der Liste automatisch ab – auch bei anderer Marke oder anderem Laden.
 */
const Catalog = (() => {
  let bound = false, q = '', editing = null, picking = null, grp = '', sub = '', net = null, netQ = '';
  const norm = (s) => String(s || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const list = () => (Array.isArray(state.products) ? state.products : (state.products = []));
  const today = () => new Date().toISOString().slice(0, 10);
  const imgOk = (s) => typeof s === 'string' && (/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s) || /^https:\/\/images\.openfoodfacts\.org\/[\w\-./]+$/.test(s));
  const emojiOf = (name) => Array.from(GROUP_LABEL[itemGroup(name)] || '📦')[0];
  const dshort = (d) => (d ? d.split('-').reverse().join('.') : '');

  /** Kleines Vorschaubild (für die Kachel) aus Bild oder Kamera */
  function thumb(src, w0, h0) {
    const s = Math.min(1, 160 / Math.max(w0, h0)), c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w0 * s)); c.height = Math.max(1, Math.round(h0 * s));
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.66);
  }
  function thumbFromFile(file) {
    return new Promise((res) => {
      const u = URL.createObjectURL(file), i = new Image();
      i.onload = () => { try { res(thumb(i, i.naturalWidth, i.naturalHeight)); } catch (e) { res(''); } URL.revokeObjectURL(u); };
      i.onerror = () => { URL.revokeObjectURL(u); res(''); };
      i.src = u;
    });
  }

  /** Foto zuschneiden: Bild im Quadrat verschieben (Finger) und vergrößern (Regler) → kleines Vorschaubild */
  function cropFromFile(file) {
    return new Promise((res) => {
      const u = URL.createObjectURL(file), img = new Image();
      img.onerror = () => { URL.revokeObjectURL(u); res(''); };
      img.onload = () => {
        const cv = $('#cropCv'), cx = cv.getContext('2d'), S = cv.width;
        const W = img.naturalWidth, H = img.naturalHeight, base = Math.max(S / W, S / H);
        let z = 1, ox = 0, oy = 0, drag = null, done = false;
        const clamp = () => { const k = base * z; ox = Math.min(0, Math.max(S - W * k, ox)); oy = Math.min(0, Math.max(S - H * k, oy)); };
        const draw = () => { clamp(); const k = base * z; cx.fillStyle = '#fff'; cx.fillRect(0, 0, S, S); cx.drawImage(img, ox, oy, W * k, H * k); };
        ox = (S - W * base) / 2; oy = (S - H * base) / 2; $('#cropZoom').value = '1'; draw();
        const scale = () => cv.width / cv.getBoundingClientRect().width;
        cv.onpointerdown = (e) => { drag = { x: e.clientX, y: e.clientY, ox, oy }; cv.setPointerCapture(e.pointerId); };
        cv.onpointermove = (e) => { if (!drag) return; const f = scale(); ox = drag.ox + (e.clientX - drag.x) * f; oy = drag.oy + (e.clientY - drag.y) * f; draw(); };
        cv.onpointerup = cv.onpointercancel = () => { drag = null; };
        $('#cropZoom').oninput = (e) => { const nz = +e.target.value, c = S / 2; ox = c - (c - ox) * nz / z; oy = c - (c - oy) * nz / z; z = nz; draw(); };
        const finish = (ok) => {
          if (done) return; done = true; URL.revokeObjectURL(u);
          let out = '';
          if (ok) { const t = document.createElement('canvas'); t.width = t.height = 160; t.getContext('2d').drawImage(cv, 0, 0, 160, 160); out = t.toDataURL('image/jpeg', 0.7); }
          $('#cropDialog').close(); res(out);
        };
        $('#cropOk').onclick = () => finish(true);
        $('#cropCancel').onclick = () => finish(false);
        $('#cropDialog').onclose = () => finish(false);
        $('#cropDialog').showModal();
      };
      img.src = u;
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
      out.push({ id: p.id, name: p.name, brand: p.brand || '', qty: p.qty || '', img: imgOk(p.img) ? p.img : '', ean: p.ean || '', cats: p.cats || [], stores, saved: true, at: p.at || '' });
    }
    const rest = [...bons.values()].sort((a, b) => b.n - a.n || b.last.localeCompare(a.last))
      .map((b) => ({ key: b.key, name: b.name, stores: b.stores, saved: false, at: b.last }));
    return out.concat(rest);
  }
  const best = (stores) => Object.entries(stores || {}).map(([st, v]) => ({ st, ...v })).sort((a, b) => a.p - b.p);

  // ---------- Ansicht ----------
  // Untergruppen je Gruppe (unabhängig vom Laden)
  const SUBS = {
    milch: [['Milch', /milch(?!schok|reis)/i], ['Joghurt & Skyr', /jog|skyr/i], ['Quark', /quark/i], ['Sahne & Crème fraîche', /sahne|schmand|cr(è|e)me/i], ['Ayran, Kefir & Buttermilch', /ayran|kefir|buttermilch|lassi/i], ['Pudding & Desserts', /pudding|dessert|grie(ß|ss)/i]],
    kaese: [['Hartkäse', /gouda|emmentaler|parmesan|bergk|cheddar|edamer|tilsiter|maasdamer/i], ['Weichkäse', /brie|camembert/i], ['Frischkäse, Feta & Mozzarella', /frischk|mozzarella|feta|hirten|burrata/i]],
    wurst: [['Salami', /salami/i], ['Schinken', /schinken/i], ['Würstchen', /w(ü|ue)rstchen|wiener|bockw/i]],
    fleisch: [['Geflügel', /h(ä|ae)hnchen|haehn|huhn|pute|gefl(ü|ue)gel|chicken|leber|herz/i], ['Rind', /rind|beef|steak/i], ['Schwein', /schwein|kotelett|schnitzel/i], ['Hackfleisch', /hack/i]],
    obst: [['Obst', /apfel|(ä|ae)pfel|banane|birne|traube|orange|mandarine|clementine|zitrone|beere|kiwi|mango|melone|ananas|pfirsich/i]],
    getraenke: [['Wasser', /wasser|sprudel/i], ['Saft & Limo', /saft|limo|cola|fanta|schorle|sprite|eistee/i], ['Kaffee & Tee', /kaffee|\btee\b|espresso/i], ['Bier & Wein', /bier|wein|sekt/i]],
    suess: [['Schokolade', /schoko/i], ['Chips & Knabbern', /chips|cracker|n(ü|ue)sse|erdnuss|flips|salzst/i], ['Kekse & Gebäck', /keks|waffel|geb(ä|ae)ck/i], ['Gummi & Bonbons', /gummi|bonbon|lakritz/i]],
    vorrat: [['Nudeln & Reis', /nudel|spaghetti|penne|fusilli|\breis\b/i], ['Öl, Essig & Gewürze', /(ö|oe)l\b|essig|gew(ü|ue)rz|pfeffer|\bsalz\b|paprika/i], ['Mehl & Zucker', /mehl|zucker/i], ['Konserven', /dose|konserve|tomaten|bohnen|mais/i]],
    brot: [['Brot', /brot(?!chen)/i], ['Brötchen', /br(ö|oe)tchen|semmel/i], ['Kuchen & Gebäck', /kuchen|croissant|berliner/i]],
  };
  const REST = { obst: 'Gemüse & Kräuter' };
  const grpOf = (x) => { const g = itemGroup(x.name); return g !== 'sonst' || !(x.cats && x.cats.length) ? g : itemGroup(x.cats.join(' ')); };
  const subOf = (x, g) => { const t = `${x.name} ${(x.cats || []).join(' ')}`; const s = (SUBS[g] || []).find(([, re]) => re.test(t)); return s ? s[0] : (REST[g] || 'Weitere'); };

  function render() {
    bind();
    const all = entries();
    all.forEach((x) => { x.g = grpOf(x); x.sg = subOf(x, x.g); });
    const nq = norm(q);
    // Gruppen-Knöpfe (nur vorhandene) und Untergruppen der gewählten Gruppe
    const cnt = (arr, f) => arr.reduce((m, x) => m.set(f(x), (m.get(f(x)) || 0) + 1), new Map());
    const gc = cnt(all, (x) => x.g);
    if (grp && !gc.has(grp)) { grp = ''; sub = ''; }
    $('#catGroups').innerHTML = `<button type="button" class="chip" data-g="" aria-pressed="${!grp}">Alle ${all.length}</button>`
      + GROUP_ORDER.concat('sonst').filter((g) => gc.has(g)).map((g) => `<button type="button" class="chip" data-g="${g}" aria-pressed="${grp === g}">${esc(GROUP_LABEL[g])} <small>${gc.get(g)}</small></button>`).join('');
    const inG = grp ? all.filter((x) => x.g === grp) : all;
    const sc = cnt(inG, (x) => x.sg);
    if (sub && !sc.has(sub)) sub = '';
    $('#catSubs').hidden = !grp || sc.size < 2;
    $('#catSubs').innerHTML = `<button type="button" class="chip sm" data-s="" aria-pressed="${!sub}">Alle</button>` + [...sc.keys()].map((s) => `<button type="button" class="chip sm" data-s="${esc(s)}" aria-pressed="${sub === s}">${esc(s)} <small>${sc.get(s)}</small></button>`).join('');
    const shown = inG.filter((x) => (!sub || x.sg === sub) && (!nq || norm(`${x.brand || ''} ${x.name}`).includes(nq))).slice(0, 240);
    $('#catCount').textContent = `${all.length} Produkte`;
    // Internet-Suche anbieten
    $('#catNetBtn').hidden = nq.length < 3;
    $('#catNetBtn').textContent = `🌐 „${q.trim()}“ im Internet suchen`;
    if (netQ !== nq) { net = null; netQ = ''; $('#catNet').innerHTML = ''; }
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

  /** Produkte in der freien Datenbank suchen (nur der Suchbegriff wird übertragen) */
  async function searchNet() {
    const term = q.trim(); if (term.length < 3) return;
    netQ = norm(term); $('#catNet').innerHTML = '<p class="hint">🌐 Suche im Internet …</p>';
    try {
      const url = 'https://world.openfoodfacts.org/cgi/search.pl?search_simple=1&action=process&json=1&page_size=24'
        + '&fields=code,product_name,product_name_de,brands,quantity,image_front_small_url&search_terms=' + encodeURIComponent(term);
      let j = null;
      for (let t = 0; t < 3 && !j; t++) { // die freie Datenbank ist manchmal kurz überlastet → bis zu 3 Versuche
        try { const r = await fetch(url); if (r.ok) j = await r.json(); } catch (e) { /* nächster Versuch */ }
        if (!j) await new Promise((ok) => setTimeout(ok, 1500));
      }
      if (!j) throw new Error('keine Antwort');
      net = (j.products || []).filter((p) => /^\d{8,14}$/.test(p.code || '') && (p.product_name_de || p.product_name));
      if (netQ !== norm(q.trim())) return;
      $('#catNet').innerHTML = net.length ? `<h3 class="small-h">🌐 Aus dem Internet – antippen zum Ansehen und Speichern</h3><div class="cat-grid">${net.map((p, i) => {
        const im = /^https:\/\/images\.openfoodfacts\.org\/[\w\-./]+$/.test(p.image_front_small_url || '') ? p.image_front_small_url : '';
        return `<div class="cat-tile"><button type="button" class="cat-pic" data-net="${i}">${im ? `<img src="${esc(im)}" alt="" loading="lazy">` : '<span>📦</span>'}</button>
          <div class="cat-name"><small>${esc(String(p.brands || '').split(',')[0])}</small>${esc(p.product_name_de || p.product_name)}${p.quantity ? ` <small>${esc(p.quantity)}</small>` : ''}</div></div>`; }).join('')}</div>`
        : '<p class="hint">Im Internet nichts gefunden.</p>';
    } catch (e) { console.warn('Netzsuche', e); $('#catNet').innerHTML = '<p class="hint">⚠️ Die freie Datenbank antwortet gerade nicht – bitte gleich noch einmal tippen.</p>'; }
  }

  function onGrid(e) {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const x = current[+b.closest('[data-i]').dataset.i]; if (!x) return;
    if (b.dataset.act === 'add') addToList(x); else openEdit(x);
  }

  let pickQty = 1, pickStore = '';
  function addToList(x) {
    const b = best(x.stores);
    picking = x; pickQty = 1; pickStore = b[0] ? niceStore(b[0].st) : '';
    $('#catPickTitle').textContent = x.name;
    $('#catPickImg').innerHTML = x.img ? `<img src="${esc(x.img)}" alt="">` : `<span>${emojiOf(x.name)}</span>`;
    $('#catPickQty').textContent = '1';
    $('#catPickList').innerHTML = b.map((v) => `<button type="button" class="btn cat-pick" data-st="${esc(niceStore(v.st))}">${esc(niceStore(v.st))} <b>${fmt(v.p)}</b><small>${esc(dshort(v.d))}</small></button>`).join('')
      + '<button type="button" class="btn btn-ghost cat-pick" data-st="">Egal wo</button>';
    markPick();
    $('#catPickDialog').showModal();
  }
  const markPick = () => $$('#catPickList [data-st]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.st === pickStore)));
  function confirmPick() {
    const x = picking; if (!x) return;
    Shop.addItems([`${pickQty > 1 ? pickQty + ' ' : ''}${x.name}`], '', { store: pickStore, pid: x.id || '', bk: x.key || '' });
    $('#catPickDialog').close(); picking = null;
    toast(`🛒 ${pickQty > 1 ? pickQty + ' × ' : ''}${x.name}${pickStore ? ' · ' + pickStore : ''}`);
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
  /** Neues Produkt ohne Strichcode (z. B. Obst, Fleisch von der Theke) */
  function openNew() { openEdit({ saved: false, key: '', name: '', brand: '', qty: '', img: '', stores: {} }); $('#ceName').focus(); }
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
  function upsertScan({ ean, name, brand, qty, img, cats }) {
    if (!ean && !name) return '';
    let p = (ean && list().find((y) => y.ean === ean)) || list().find((y) => !y.ean && norm(y.name) === norm(name));
    const isNew = !p;
    if (!p) { p = { id: uid(), ean: ean || '', name: (name || ean).slice(0, 80), brand: (brand || '').slice(0, 40), qty: (qty || '').slice(0, 20), aliases: [], stores: {}, at: new Date().toISOString() }; list().push(p); }
    if (!p.img && imgOk(img)) p.img = img;
    if (ean && !p.ean) p.ean = ean;
    if (Array.isArray(cats) && cats.length && !(p.cats && p.cats.length)) p.cats = cats.map((c) => String(c).slice(0, 50)).slice(-4);
    if (isNew) pricesFromBons(p, bonExps()); // schon gekauft? → Preis und Laden aus früheren Bons
    save();
    return p.id;
  }
  /** Günstigster bekannter Preis als Text */
  function bestPrice(id) { const x = entries().find((y) => y.id === id); const b = x ? best(x.stores) : []; return b.length ? `${fmt(b[0].p)} bei ${b[0].st}` : ''; }
  function pickById(id) { const x = entries().find((y) => y.id === id); if (x) addToList(x); }
  function setPrice(meta, store, price) {
    const id = upsertScan(meta); const p = list().find((y) => y.id === id); if (!p) return;
    p.stores = { ...(p.stores || {}), [store]: { p: price, d: today() } };
    save();
  }
  const packFor = (ean) => { const p = list().find((y) => ean && y.ean === ean); return p && +p.pack > 0 ? +p.pack : 0; };
  function setPack(meta, q) { const id = upsertScan(meta); const p = list().find((y) => y.id === id); if (p) { p.pack = q; save(); } }
  const findFor = (x) => (x.pid && list().find((y) => y.id === x.pid)) || list().find((y) => norm(y.name) === norm(x.name)) || null;
  /** Bild zu einem Eintrag der Einkaufsliste (über verknüpftes oder gleichnamiges Produkt) */
  const imgForItem = (x) => { const p = findFor(x); return p && imgOk(p.img) ? p.img : ''; };
  /** Foto aus der Einkaufsliste speichern → Produkt anlegen/ergänzen, Eintrag verknüpfen */
  function photoForItem(x, img) {
    if (!imgOk(img)) return '';
    let p = findFor(x);
    if (!p) { p = { id: uid(), name: x.name.slice(0, 80), aliases: x.bk ? [x.bk] : [], stores: {}, at: new Date().toISOString() }; list().push(p); }
    p.img = img; x.pid = p.id; save();
    return p.id;
  }
  const byEan = (ean) => list().find((y) => ean && y.ean === ean) || null;
  const imgFor = (ean) => { const p = byEan(ean); return p && imgOk(p.img) && p.img.startsWith('data:') ? p.img : ''; };
  function setImg(meta, img) {
    const id = upsertScan(meta); const p = list().find((y) => y.id === id); if (!p || !imgOk(img)) return id;
    p.img = img; if (meta.name && (!p.name || p.name === p.ean)) p.name = meta.name.slice(0, 80);
    save(); return id;
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
  /** Passt ein Bon-Artikel zu diesem Produkt? (Strichcode, gemerkter Bon-Name, oder Marke + Produktwort) */
  function itemFits(p, it) {
    if (it.ean && p.ean && it.ean === p.ean) return true;
    const k = norm(it.name); if ((p.aliases || []).includes(k)) return true;
    const bw = k.split(' '), hit = (w) => bw.some((x) => wordHit(w, x));
    const ws = sigWords(p.name, p.brand); if (!ws.length) return false;
    const brand = norm(p.brand).split(' ').filter((w) => w.length >= 3);
    const nHits = ws.filter(hit).length;
    if (brand.length) return brand.some(hit) && nHits >= 1;            // „HAYRAN AYRAN“ ↔ Hayran · Ayran
    return ws.length >= 2 ? nHits >= Math.min(ws.length, 2) : false;   // ohne Marke: mind. 2 Wörter
  }
  /** Preise und Laden aus Bons beim Produkt eintragen (neuester Bon je Laden) */
  function pricesFromBons(p, exps) {
    let changed = false;
    for (const e of exps) {
      const st = niceStore(storeOf(e.merchant || '') || e.merchant || ''); if (!st) continue;
      for (const it of e.items || []) {
        if (!(it.price > 0) || !itemFits(p, it)) continue;
        const each = it.qty && it.unit ? it.unit : it.price, cur = (p.stores || {})[st];
        if (!cur || (e.date || '') >= (cur.d || '')) { p.stores = { ...(p.stores || {}), [st]: { p: each, d: e.date || today() } }; changed = true; }
        const k = norm(it.name); if (!(p.aliases || []).includes(k)) { p.aliases = [...(p.aliases || []), k].slice(-12); changed = true; }
      }
    }
    return changed;
  }
  const bonExps = () => state.expenses.filter((e) => e.items && e.items.length && (!e.private || isMine(e)));

  function fromBon(exp) {
    if (exp && Array.isArray(exp.items) && list().some((p) => pricesFromBons(p, [exp]))) save(); // Preis + Laden automatisch zum Produkt
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
    $('#catGroups').addEventListener('click', (e) => { const b = e.target.closest('[data-g]'); if (b) { grp = b.dataset.g; sub = ''; render(); } });
    $('#catSubs').addEventListener('click', (e) => { const b = e.target.closest('[data-s]'); if (b) { sub = b.dataset.s; render(); } });
    $('#catNetBtn').onclick = searchNet;
    $('#catNet').addEventListener('click', (e) => { const b = e.target.closest('[data-net]'); if (b && net && net[+b.dataset.net]) Product.showEan(net[+b.dataset.net].code); });
    $('#catSearch').addEventListener('input', (e) => { q = e.target.value; render(); });
    $('#catPickList').addEventListener('click', (e) => { const b = e.target.closest('[data-st]'); if (!b) return; pickStore = b.dataset.st; markPick(); });
    $('#catPickMinus').onclick = () => { pickQty = Math.max(1, pickQty - 1); $('#catPickQty').textContent = pickQty; };
    $('#catPickPlus').onclick = () => { pickQty = Math.min(99, pickQty + 1); $('#catPickQty').textContent = pickQty; };
    $('#catPickOk').onclick = confirmPick;
    $('#catPickCancel').onclick = () => $('#catPickDialog').close();
    $('#cePhoto').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; const t = await cropFromFile(f); if (t) { $('#cePic').dataset.img = t; $('#cePic').innerHTML = `<img src="${t}" alt="">`; } });
    $('#ceSave').onclick = saveEdit;
    $('#ceCancel').onclick = () => $('#catEditDialog').close();
    $('#ceAdd').onclick = () => { if (editing) { $('#catEditDialog').close(); addToList(editing); } };
    $('#ceNut').onclick = () => { if (editing && editing.ean) { $('#catEditDialog').close(); Product.showEan(editing.ean); } };
    $('#ceDel').onclick = () => {
      if (!editing || !editing.saved || !confirm('Dieses Produkt aus „Unsere Produkte“ entfernen?')) return;
      state.products = list().filter((y) => y.id !== editing.id); save(); $('#catEditDialog').close(); render();
    };
  }

  return { cropFromFile, bestPrice, pickById, openNew, imgForItem, photoForItem, render, fromBon, upsertScan, setPrice, pricesFor, packFor, setPack, byEan, imgFor, setImg, thumb, thumbFromFile };
})();
