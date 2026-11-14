/*
 * Einkaufsliste, Rezepte und Kalender-Übernahme
 * - Einkaufsliste und eigene Rezepte werden wie alles Gemeinsame Ende-zu-Ende-verschlüsselt abgeglichen.
 * - Preis-Hinweise kommen ausschließlich aus euren eigenen Kassenbons (nichts geht an fremde Dienste).
 * - Kalender: erzeugt eine .ics-Datei, die das iPhone in den Kalender übernimmt (kein Dauerzugriff nötig).
 */
const Shop = (() => {
  let bound = false, tab = 'list', tagFilter = new Set(), curRecipe = null, editRecipeId = null;

  const PANTRY = /\b(salz|pfeffer|wasser|zimt|gewürz|oregano|paprikapulver|kreuzkümmel|curry(pulver)?|muskat|backpulver|chiligewürz|kurkuma)\b|(oliven|raps|sesam)?öl\b/i;
  const UNIT = '(?:x|×|stk\\.?|stück|g|gr|kg|ml|l|liter|pck\\.?|packung(?:en)?|pack|dose[n]?|becher|flasche[n]?|bund|el|tl|prise|glas|gläser|kopf|zehe[n]?|scheibe[n]?|handvoll|beutel|netz)';
  const QTY_RE = new RegExp(`^\\s*((?:\\d+[.,]?\\d*|½|¼|¾|ein|eine|zwei|drei|vier|fünf)\\s*${UNIT}?\\.?)\\s+(.+)$`, 'i');

  const norm = (s) => String(s || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

  /** „2 Butter“ → { qty: '2', name: 'Butter' } */
  function splitQty(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    const m = t.match(QTY_RE);
    if (m && m[2].length > 1) return { qty: m[1].trim(), name: m[2].replace(/\s*\(.*?\)\s*$/, '').trim() };
    return { qty: '', name: t };
  }

  /** Eingabe (auch diktiert) in einzelne Artikel zerlegen: „Milch, 2 Butter und Eier“ */
  function splitInput(text) {
    return String(text || '').split(/\n|,|;|\s+und\s+|\s+sowie\s+|\s+plus\s+/i)
      .map((x) => x.trim().replace(/^(?:[-•*·]|\d+[.)])\s*/, '').trim()).filter((x) => x.length > 1); // Aufzählungszeichen weg, Mengen bleiben
  }

  // ---------- Preis-Hinweis aus den eigenen Bons ----------
  let priceIdx = null, priceIdxAt = 0;
  function priceIndex() {
    if (priceIdx && Date.now() - priceIdxAt < 5000) return priceIdx;
    const rows = [];
    state.expenses.filter((e) => !e.private || isMine(e)).forEach((e) => (e.items || []).forEach((it) => {
      if (!it.name || !(it.price > 0)) return;
      rows.push({ n: norm(it.name), name: it.name, each: it.qty && it.unit ? it.unit : it.price, store: storeOf(e.merchant), date: e.date });
    }));
    priceIdx = rows; priceIdxAt = Date.now();
    return rows;
  }
  function priceInfo(name, store) {
    const words = norm(name).split(' ').filter((w) => w.length > 2);
    if (!words.length) return null;
    const hits = priceIndex().filter((r) => words.every((w) => r.n.includes(w)));
    if (!hits.length) return null;
    const here = store ? hits.filter((h) => norm(h.store).replace(/ /g, '') === norm(store).replace(/ /g, '') || norm(store).startsWith(norm(h.store))) : [];
    const last = (here.length ? here : hits).reduce((a, b) => (b.date > a.date ? b : a));
    const cheap = hits.reduce((a, b) => (b.each < a.each ? b : a));
    return { last, cheap, n: hits.length };
  }
  const priceText = (p) => !p ? '' : (p.cheap.each < p.last.each - 0.004
    ? `zuletzt ${fmt(p.last.each)} (${p.last.store}) · günstigst ${fmt(p.cheap.each)} bei ${p.cheap.store}`
    : `zuletzt ${fmt(p.last.each)} bei ${p.last.store}`);

  // ---------- Einkaufsliste ----------
  // ---------- Läden (Abzeichen in typischen Ladenfarben – keine echten Logos/Marken) ----------
  const STORE_BADGES = {
    'ALDI SÜD': ['#00205b', '#ffffff', '#f39200'], 'ALDI Nord': ['#00a5e3', '#ffffff', '#003a7d'], 'LIDL': ['#0050aa', '#fff000', '#e60a14'],
    'REWE': ['#cc071e', '#ffffff'], 'EDEKA': ['#ffd400', '#1a3d8f'], 'Marktkauf': ['#4a3a2c', '#ffffff'], 'Netto': ['#ffe600', '#e2001a'],
    'Penny': ['#cd1414', '#ffffff'], 'Kaufland': ['#e10915', '#ffffff'], 'Mix Markt': ['#e30613', '#ffffff'], 'dm': ['#ffffff', '#1e3d8f', '#f7c600'],
    'Rossmann': ['#c70f2e', '#ffffff'], 'Trinkgut': ['#0a7a3a', '#ffffff'], 'Fressnapf': ['#2a8c3c', '#ffffff'],
  };
  const DEFAULT_STORES = ['ALDI SÜD', 'ALDI Nord', 'LIDL', 'REWE', 'EDEKA', 'Marktkauf', 'Netto', 'Penny', 'Kaufland', 'dm', 'Rossmann'];
  const storeList = () => (Array.isArray(state.settings.shopStores) && state.settings.shopStores.length ? state.settings.shopStores : DEFAULT_STORES);
  const logoOf = (name) => { const l = state.settings.storeLogos && state.settings.storeLogos[name]; return l && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(l) ? l : ''; };
  function storeBadge(name, big) {
    if (!name) return '';
    const logo = logoOf(name);
    if (logo) return `<span class="store-badge store-logo ${big ? 'big' : ''}"><img src="${logo}" alt="${esc(name)}"></span>`;
    const c = STORE_BADGES[name] || ['#8a6f55', '#4a3a2c'];
    // gedämpft: helle, warme Fläche, Ladenfarbe nur als Rand und Schrift (blendet nicht)
    const lum = (hx) => { const n = parseInt(hx.slice(1), 16); return (0.3 * (n >> 16) + 0.59 * ((n >> 8) & 255) + 0.11 * (n & 255)); };
    const ink = [c[0], c[1]].sort((a, b) => lum(a) - lum(b))[0];
    return `<span class="store-badge ${big ? 'big' : ''}" style="background:#f4ece0;color:${ink};border:2px solid ${c[0] === '#ffffff' ? ink : c[0]};border-left-width:8px">${esc(name)}</span>`;
  }
  let shopStore = '';
  try { shopStore = localStorage.getItem('shop-store') || ''; } catch (e) { /* egal */ }
  function setShopStore(v) { shopStore = v; try { localStorage.setItem('shop-store', v); } catch (e) { /* egal */ } render(); }
  function renderStoreRow() {
    const open = state.shopping.filter((x) => !x.done);
    const cnt = (st) => open.filter((x) => x.store === st).length;
    $('#shopStores').innerHTML = `<button type="button" class="store-pick ${!shopStore ? 'on' : ''}" data-st=""><span class="store-badge" style="background:#f6efe4;color:#4a3a2c">🛒 Alle</span>${open.length ? `<b>${open.length}</b>` : ''}</button>`
      + storeList().map((st) => `<button type="button" class="store-pick ${shopStore === st ? 'on' : ''}" data-st="${esc(st)}">${storeBadge(st)}${cnt(st) ? `<b>${cnt(st)}</b>` : ''}</button>`).join('')
      + '<button type="button" class="store-pick" data-st="__edit"><span class="store-badge" style="background:#efe5d6;color:#4a3a2c">✏️ Läden &amp; Logos</span></button>';
    $('#shopStoreHint').innerHTML = shopStore ? `${storeBadge(shopStore, true)} <span>Neue Einträge kommen auf diese Liste. Einträge ohne Laden („egal wo“) stehen auch hier.</span>` : '';
  }
  // Läden verwalten: eigenes Logo-Bild je Laden (z. B. Screenshot von der Website), hinzufügen, entfernen
  function openStoreDialog() {
    $('#storeDlgList').innerHTML = storeList().map((st, i) => `<li data-i="${i}">${storeBadge(st)}
      <label class="btn btn-sm btn-file">🖼️ Logo<input type="file" accept="image/*" data-logo="${esc(st)}"></label>
      ${logoOf(st) ? `<button type="button" class="btn btn-sm btn-ghost" data-nologo="${esc(st)}">Logo weg</button>` : ''}
      <button type="button" class="sh-del" data-rm="${esc(st)}" aria-label="Laden entfernen">✕</button></li>`).join('');
    if (!$('#storeDlg').open) $('#storeDlg').showModal();
  }
  function setLogo(name, file) {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const H = 64, W = Math.min(240, Math.round(img.naturalWidth * H / img.naturalHeight)) || H;
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      c.getContext('2d').drawImage(img, 0, 0, W, H); URL.revokeObjectURL(url);
      state.settings.storeLogos = { ...(state.settings.storeLogos || {}), [name]: c.toDataURL('image/png') };
      save(); render(); openStoreDialog(); toast('Logo gespeichert ✓');
    };
    img.onerror = () => { URL.revokeObjectURL(url); toast('Bild konnte nicht geöffnet werden'); };
    img.src = url;
  }

  function onStorePick(e) {
    const b = e.target.closest('[data-st]'); if (!b) return;
    if (b.dataset.st === '__edit') { openStoreDialog(); return; }
    if (b.dataset.st === '__add') {
      const n = (prompt('Name des Ladens (z. B. „Hit“, „Wochenmarkt“):') || '').trim().slice(0, 30);
      if (!n) return;
      const list = [...storeList()]; if (!list.some((x) => x.toLowerCase() === n.toLowerCase())) list.push(n);
      state.settings.shopStores = list; save(); setShopStore(n); return;
    }
    setShopStore(shopStore === b.dataset.st ? '' : b.dataset.st);
  }

  // ---------- Senden & Drucken (aktueller Laden oder alles, nach Laden und Gruppe sortiert) ----------
  function exportGroups() {
    const open = state.shopping.filter((x) => !x.done && (!shopStore || !x.store || x.store === shopStore));
    const byStore = new Map();
    const stores = shopStore ? [shopStore] : [...new Set(open.map((x) => x.store || ''))].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b, 'de'));
    stores.forEach((st) => byStore.set(st, open.filter((x) => (shopStore ? true : (x.store || '') === st))));
    return [...byStore.entries()].filter(([, l]) => l.length).map(([st, l]) => {
      const groups = new Map();
      l.forEach((x) => { const g = itemGroup(x.name); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(x); });
      return { store: st || 'Egal wo', groups: GROUP_ORDER.filter((g) => groups.has(g)).map((g) => ({ label: GROUP_LABEL[g], items: groups.get(g) })) };
    });
  }
  const line = (x) => `${x.qty ? x.qty + ' ' : ''}${x.name}${shopStore && !x.store ? ' (egal wo)' : ''}`;
  async function shareList() {
    const parts = exportGroups();
    if (!parts.length) { toast('Die Liste ist leer'); return; }
    const title = shopStore ? `🛒 Einkaufsliste ${shopStore}` : '🛒 Einkaufsliste';
    const text = title + '\n' + parts.map((p) => (shopStore ? '' : `\n■ ${p.store}\n`) + p.groups.map((g) => `${g.label.replace(/^\S+\s/, '')}:\n` + g.items.map((x) => `☐ ${line(x)}`).join('\n')).join('\n')).join('\n');
    try { if (navigator.share) { await navigator.share({ title, text }); return; } } catch (e) { if (e.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(text); toast('Liste kopiert ✓ – zum Einfügen z. B. in Nachrichten'); } catch (e) { prompt('Liste kopieren:', text); }
  }
  function printList() {
    const parts = exportGroups();
    if (!parts.length) { toast('Die Liste ist leer'); return; }
    const d = new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
    const area = $('#shopPrintArea');
    area.innerHTML = `<h1>🛒 Einkaufsliste${shopStore ? ' ' + esc(shopStore) : ''}</h1><p class="pr-date">${esc(d)}</p>`
      + parts.map((p) => `<section>${shopStore ? '' : `<h2>${storeBadge(p.store === 'Egal wo' ? '' : p.store) || ''} ${p.store === 'Egal wo' ? 'Egal wo' : ''}</h2>`}`
        + p.groups.map((g) => `<h3>${esc(g.label)}</h3><ul>${g.items.map((x) => `<li><span class="pr-box"></span>${esc(line(x))}</li>`).join('')}</ul>`).join('') + '</section>').join('');
    area.hidden = false;
    document.body.classList.add('print-shop');
    const done = () => { document.body.classList.remove('print-shop'); area.hidden = true; window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    setTimeout(() => { window.print(); setTimeout(done, 1500); }, 50);
  }

  function addItems(texts, source) {
    let n = 0;
    for (const raw of texts) {
      const { qty, name } = splitQty(raw);
      if (!name) continue;
      const k = norm(name);
      const same = state.shopping.find((x) => !x.done && norm(x.name) === k && (x.store || '') === (shopStore || ''));
      if (same) { if (qty) same.qty = same.qty ? `${same.qty} + ${qty}` : qty; if (source) same.note = same.note || source; continue; }
      state.shopping.push({ id: uid(), name: name.slice(0, 80), qty: qty.slice(0, 30), note: source || '', store: shopStore || '', done: false, by: state.settings.me, at: new Date().toISOString() });
      n++;
    }
    save(); render();
    return n;
  }

  function renderList() {
    renderStoreRow();
    const inStore = (x) => !shopStore || !x.store || x.store === shopStore;
    const open = state.shopping.filter((x) => !x.done && inStore(x));
    const done = state.shopping.filter((x) => x.done && inStore(x)).sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || ''));
    $('#shopCount').textContent = open.length ? `${open.length} offen` : 'alles erledigt';
    const groups = new Map();
    open.forEach((x) => { const g = itemGroup(x.name); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(x); });
    const order = GROUP_ORDER;
    const item = (x) => {
      const p = priceInfo(x.name, shopStore || x.store);
      return `<li class="sh-item ${x.done ? 'done' : ''}" data-id="${esc(x.id)}">
        <button class="sh-check" data-act="toggle" aria-label="${x.done ? 'wieder offen' : 'erledigt'}">${x.done ? '✓' : ''}</button>
        <span class="sh-main" data-act="edit"><span class="sh-name">${esc(x.name)}${x.qty ? ` <span class="sh-qty">${esc(x.qty)}</span>` : ''}${x.store && !shopStore ? ' ' + storeBadge(x.store) : ''}${!x.store && shopStore ? ' <span class="sh-any">egal wo</span>' : ''}</span>
          ${x.done ? `<span class="sh-sub">${x.doneBy ? 'gekauft von ' + esc(x.doneBy) : 'gekauft'}</span>`
            : `${p ? `<span class="sh-price">💶 ${esc(priceText(p))}</span>` : ''}${x.note || (x.by && x.by !== state.settings.me) ? `<span class="sh-sub">${[x.note, x.by && x.by !== state.settings.me ? 'von ' + x.by : ''].filter(Boolean).map(esc).join(' · ')}</span>` : ''}`}
        </span>
        <button class="sh-del" data-act="del" aria-label="Entfernen">✕</button></li>`;
    };
    let html = '';
    if (!open.length) html += '<div class="empty-state">Die Liste ist leer.<br>Oben eintippen, diktieren 🎤 oder einen Zettel fotografieren 📷.</div>';
    for (const g of order) if (groups.has(g)) html += `<div class="sh-group">${esc(GROUP_LABEL[g])}</div><ul class="sh-list">${groups.get(g).map(item).join('')}</ul>`;
    if (done.length) html += `<details class="sh-done"><summary>✓ Erledigt (${done.length})</summary><ul class="sh-list">${done.map(item).join('')}</ul>
      <button class="btn btn-ghost btn-sm" id="shClearDone">Erledigte löschen</button></details>`;
    $('#shopList').innerHTML = html;
    // Vorschläge: bisherige Artikel und Listeneinträge
    const names = new Set();
    state.shopping.forEach((x) => names.add(x.name));
    priceIndex().slice(-400).forEach((r) => names.add(r.name));
    $('#shopSuggest').innerHTML = [...names].slice(0, 300).map((n) => `<option value="${esc(n)}">`).join('');
  }

  function onListClick(e) {
    if (e.target.id === 'shClearDone') {
      if (!confirm('Alle erledigten Einträge löschen?')) return;
      state.shopping = state.shopping.filter((x) => !x.done); save(); render(); return;
    }
    const b = e.target.closest('[data-act]'); if (!b) return;
    const li = b.closest('[data-id]'); const x = state.shopping.find((s) => s.id === li.dataset.id); if (!x) return;
    if (b.dataset.act === 'toggle') {
      x.done = !x.done; x.doneBy = x.done ? state.settings.me : ''; x.doneAt = x.done ? new Date().toISOString() : '';
      save(); render();
    } else if (b.dataset.act === 'del') {
      state.shopping = state.shopping.filter((s) => s.id !== x.id); save(); render();
    } else if (b.dataset.act === 'edit') {
      shEditing = x;
      const f = $('#shEditForm');
      f.text.value = (x.qty ? x.qty + ' ' : '') + x.name;
      f.group.innerHTML = GROUP_ORDER.map((g) => `<option value="${g}">${esc(GROUP_LABEL[g])}</option>`).join('');
      f.group.value = itemGroup(x.name);
      f.store.innerHTML = '<option value="">— egal wo —</option>' + storeList().map((st) => `<option>${esc(st)}</option>`).join('');
      f.store.value = x.store || '';
      $('#shEditDialog').showModal();
    }
  }

  let shEditing = null;
  function saveShEdit(ev) {
    ev.preventDefault();
    const x = shEditing; if (!x) return;
    const f = $('#shEditForm');
    const v = f.text.value.trim();
    if (!v) state.shopping = state.shopping.filter((s) => s.id !== x.id);
    else {
      const sp = splitQty(v); x.name = sp.name.slice(0, 80); x.qty = sp.qty.slice(0, 30); x.store = f.store.value;
      if (f.group.value !== itemGroup(x.name)) state.rules['grp:' + normItem(x.name)] = f.group.value; // gemerkt – auch für Artikel & Preise
    }
    save(); $('#shEditDialog').close(); shEditing = null; render(); toast('Gespeichert ✓');
  }

  function submitInput(ev) {
    ev.preventDefault();
    const inp = $('#shopInput');
    const n = addItems(splitInput(inp.value));
    inp.value = '';
    if (n) toast(n === 1 ? '🛒 hinzugefügt' : `🛒 ${n} Einträge hinzugefügt`);
  }

  // ---------- Sprache ----------
  function voice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { $('#shopInput').focus(); toast('Tipp: Auf der Tastatur das 🎤 Mikrofon antippen und sprechen'); return; }
    const r = new SR(); r.lang = 'de-DE'; r.interimResults = false; r.maxAlternatives = 1;
    const btn = $('#shopVoice'); btn.classList.add('listening'); toast('🎤 Sprich jetzt – z. B. „Milch, Eier und zwei Butter“');
    r.onresult = (e) => { const t = e.results[0][0].transcript; const n = addItems(splitInput(t)); toast(`🎤 „${t}“ → ${n} Eintrag/Einträge`); };
    r.onerror = () => { $('#shopInput').focus(); toast('Spracheingabe nicht möglich – das 🎤 der Tastatur nutzen'); };
    r.onend = () => btn.classList.remove('listening');
    try { r.start(); } catch (e) { btn.classList.remove('listening'); $('#shopInput').focus(); }
  }

  // ---------- Bild (Zettel, Verpackung, Rezept) ----------
  async function ocrInto(file, target, hint) {
    const box = $(target);
    const prog = (p, txt) => { $('#ocrStatus').textContent = txt || `Lese Text … ${Math.round(p * 100)} %`; };
    $('#ocrStatus').hidden = false; prog(0.05, 'Bereite Bild auf …');
    try {
      const text = await Receipt.ocrFile(file, prog);
      const clean = text.split('\n').map((l) => l.replace(/\s{2,}/g, ' ').trim()).filter((l) => l.length > 1 && !/^[\W\d\s]+$/.test(l)).join('\n');
      box.value = (box.value ? box.value + '\n' : '') + clean;
      $('#ocrStatus').textContent = clean ? (hint || 'Erkannt – bitte kurz prüfen und korrigieren.') : 'Kein Text erkannt – bitte ein schärferes Foto versuchen.';
    } catch (e) { $('#ocrStatus').textContent = '⚠️ ' + e.message; }
  }
  function openImport(file) {
    $('#shopImportText').value = '';
    $('#shopImportDialog').showModal();
    if (file) ocrInto(file, '#shopImportText', 'Erkannt – jede Zeile wird ein Eintrag. Bitte prüfen.');
  }

  // ---------- Rezepte ----------
  const allRecipes = () => state.recipes.map((r) => ({ ...r, own: true })).concat((window.RECIPE_BASE || []).map((r) => ({ ...r, own: false })));
  function renderRecipes() {
    const q = norm($('#recipeSearch').value);
    const all = allRecipes();
    const tags = [...new Set(all.flatMap((r) => r.tags || []))].sort((a, b) => a.localeCompare(b, 'de'));
    $('#recipeTags').innerHTML = tags.map((t) => `<button type="button" class="chip ${tagFilter.has(t) ? 'selected' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('');
    const list = all.filter((r) => [...tagFilter].every((t) => (r.tags || []).includes(t)))
      .filter((r) => !q || norm(`${r.title} ${(r.tags || []).join(' ')} ${(r.ingredients || []).join(' ')}`).includes(q))
      .sort((a, b) => (b.own - a.own) || a.title.localeCompare(b.title, 'de'));
    $('#recipeList').innerHTML = list.length ? list.map((r) => `<li class="rc-card" data-rid="${esc(r.id)}">
        <div class="rc-title">${esc(r.title)}${r.own ? ' <span class="badge">eigenes</span>' : ''}</div>
        <div class="rc-meta">${r.time ? `⏱ ${r.time} Min · ` : ''}${(r.ingredients || []).length} Zutaten</div>
        <div class="rc-tags">${(r.tags || []).map((t) => `<span>${esc(t)}</span>`).join('')}</div></li>`).join('')
      : '<li class="empty-state">Kein Rezept passt zu diesem Filter.</li>';
  }
  function showRecipe(id) {
    const r = allRecipes().find((x) => x.id === id); if (!r) return;
    curRecipe = r;
    $('#rdTitle').textContent = r.title;
    $('#rdMeta').textContent = [r.time ? `⏱ ${r.time} Minuten` : '', r.servings ? `${r.servings} Portionen` : (r.own ? '' : '2 Portionen'), (r.tags || []).join(' · ')].filter(Boolean).join(' · ');
    $('#rdIngr').innerHTML = (r.ingredients || []).map((ing, i) => {
      const { name } = splitQty(ing);
      const p = priceInfo(name);
      return `<li><label class="check"><input type="checkbox" data-i="${i}" ${PANTRY.test(ing) ? '' : 'checked'}> <span>${esc(ing)}${p ? `<small class="sh-price">💶 ${esc(priceText(p))}</small>` : ''}</span></label></li>`;
    }).join('');
    $('#rdSteps').innerHTML = (r.steps || []).map((s) => `<li>${esc(s)}</li>`).join('');
    $('#rdNote').textContent = r.source ? `Quelle: ${r.source}` : '';
    $('#rdEdit').hidden = !r.own; $('#rdDelete').hidden = !r.own;
    $('#recipeDialog').showModal();
  }
  function recipeToList() {
    const r = curRecipe; if (!r) return;
    const picked = $$('#rdIngr input:checked').map((c) => r.ingredients[+c.dataset.i]);
    if (!picked.length) { toast('Keine Zutat ausgewählt'); return; }
    const n = addItems(picked, r.title);
    $('#recipeDialog').close(); tab = 'list'; render(); toast(`🛒 ${picked.length} Zutaten auf der Liste${n < picked.length ? ' (teils zusammengefasst)' : ''}`);
  }

  /** Eingefügten/erkannten Rezepttext in Zutaten und Schritte aufteilen */
  function parseRecipeText(text) {
    const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
    let title = '', ingr = [], steps = [], mode = '';
    for (const l of lines) {
      if (/^zutaten\b/i.test(l)) { mode = 'i'; continue; }
      if (/^(zubereitung|so geht'?s|anleitung|schritte)\b/i.test(l)) { mode = 's'; continue; }
      if (!title && !mode && l.length < 70 && !QTY_RE.test(l)) { title = l; continue; }
      if (mode === 'i' || (!mode && QTY_RE.test(l))) ingr.push(l.replace(/^[-•*·]\s*/, ''));
      else steps.push(l.replace(/^(\d+[.)]|[-•*·])\s*/, ''));
    }
    return { title, ingr, steps };
  }
  function openRecipeEdit(r) {
    editRecipeId = r ? r.id : null;
    const f = $('#recipeForm');
    f.title.value = r ? r.title : ''; f.tags.value = r ? (r.tags || []).join(', ') : ''; f.time.value = r && r.time ? r.time : '';
    f.ingr.value = r ? (r.ingredients || []).join('\n') : ''; f.steps.value = r ? (r.steps || []).join('\n') : ''; f.source.value = r ? r.source || '' : '';
    $('#ocrStatus2').hidden = true;
    $('#recipeEditDialog').showModal();
  }
  function saveRecipe(ev) {
    ev.preventDefault();
    const f = $('#recipeForm');
    // Alles in ein Feld eingefügt? → automatisch aufteilen
    if (f.ingr.value.trim() && !f.steps.value.trim() && /zubereitung|zutaten/i.test(f.ingr.value)) {
      const p = parseRecipeText(f.ingr.value); f.ingr.value = p.ingr.join('\n'); f.steps.value = p.steps.join('\n'); if (!f.title.value.trim()) f.title.value = p.title;
    }
    const data = {
      title: f.title.value.trim().slice(0, 100) || 'Rezept',
      tags: f.tags.value.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 12),
      time: Number(f.time.value) || 0,
      ingredients: f.ingr.value.split('\n').map((l) => l.replace(/^[-•*·]\s*/, '').trim()).filter(Boolean).slice(0, 60),
      steps: f.steps.value.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 40),
      source: f.source.value.trim().slice(0, 120),
    };
    if (!data.ingredients.length) { toast('Bitte mindestens eine Zutat eintragen'); return; }
    if (editRecipeId) Object.assign(state.recipes.find((x) => x.id === editRecipeId), data);
    else state.recipes.push({ id: uid(), ...data, by: state.settings.me });
    save(); $('#recipeEditDialog').close(); tab = 'recipes'; render(); toast('📖 Rezept gespeichert');
  }

  // ---------- Kalender (.ics) ----------
  const icsEsc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  function icsDate(d) { return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }
  function calendar({ title, start, minutes = 30, allDay = false, description = '' }) {
    const s = new Date(start);
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Haushaltsbuch//DE', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
      `UID:${uid()}@haushaltsbuch`, `DTSTAMP:${icsDate(new Date())}`];
    if (allDay) {
      const d = (x) => `${x.getFullYear()}${String(x.getMonth() + 1).padStart(2, '0')}${String(x.getDate()).padStart(2, '0')}`;
      const e = new Date(s); e.setDate(e.getDate() + 1);
      lines.push(`DTSTART;VALUE=DATE:${d(s)}`, `DTEND;VALUE=DATE:${d(e)}`);
    } else lines.push(`DTSTART:${icsDate(s)}`, `DTEND:${icsDate(new Date(s.getTime() + minutes * 60000))}`);
    lines.push(`SUMMARY:${icsEsc(title)}`, `DESCRIPTION:${icsEsc(description)}`,
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEsc(title)}`, `TRIGGER:${allDay ? '-PT15H' : '-PT30M'}`, 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR');
    const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'termin.ics';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    toast('📅 Termin geöffnet – „Hinzufügen“ tippen');
  }
  let calPending = null;
  function askCalendar(opts) {
    calPending = opts;
    const f = $('#calForm');
    f.title.value = opts.title;
    const d = opts.start ? new Date(opts.start) : new Date(Date.now() + 864e5);
    if (!opts.start) d.setHours(10, 0, 0, 0);
    const pad = (n) => String(n).padStart(2, '0');
    f.when.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    $('#calDialog').showModal();
  }
  function submitCal(ev) {
    ev.preventDefault();
    const f = $('#calForm');
    if (!f.when.value) return;
    calendar({ ...calPending, title: f.title.value.trim() || calPending.title, start: new Date(f.when.value), allDay: false });
    $('#calDialog').close();
  }

  // ---------- Darstellung ----------
  function render() {
    if (!document.getElementById('view-shop')) return;
    bind();
    if (!Array.isArray(state.shopping)) state.shopping = [];
    if (!Array.isArray(state.recipes)) state.recipes = [];
    priceIdx = null;
    $$('#shopTabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === tab)));
    $('#shopPane').hidden = tab !== 'list';
    $('#recipePane').hidden = tab !== 'recipes';
    if (tab === 'list') renderList(); else renderRecipes();
  }

  function bind() {
    if (bound) return; bound = true;
    $('#shopTabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (b) { tab = b.dataset.v; render(); } });
    $('#shopForm').addEventListener('submit', submitInput);
    $('#shopList').addEventListener('click', onListClick);
    $('#shopStores').addEventListener('click', onStorePick);
    $('#storeDlgList').addEventListener('change', (e) => { const i = e.target.closest('[data-logo]'); if (i && i.files[0]) setLogo(i.dataset.logo, i.files[0]); });
    $('#storeDlgList').addEventListener('click', (e) => {
      const nl = e.target.closest('[data-nologo]'), rm = e.target.closest('[data-rm]');
      if (nl) { const l = { ...(state.settings.storeLogos || {}) }; delete l[nl.dataset.nologo]; state.settings.storeLogos = l; save(); render(); openStoreDialog(); }
      if (rm && confirm(`„${rm.dataset.rm}“ aus der Ladenleiste entfernen?`)) { state.settings.shopStores = storeList().filter((x) => x !== rm.dataset.rm); if (shopStore === rm.dataset.rm) shopStore = ''; save(); render(); openStoreDialog(); }
    });
    $('#storeDlgAdd').onclick = () => {
      const n = (prompt('Name des Ladens (z. B. „Hit“, „Wochenmarkt“):') || '').trim().slice(0, 30); if (!n) return;
      const list = [...storeList()]; if (!list.some((x) => x.toLowerCase() === n.toLowerCase())) list.push(n);
      state.settings.shopStores = list; save(); render(); openStoreDialog();
    };
    $('#storeDlgClose').onclick = () => $('#storeDlg').close();
    $('#shopShare').onclick = shareList;
    $('#shopPrint').onclick = printList;
    $('#shEditForm').addEventListener('submit', saveShEdit);
    $('#shEditCancel').onclick = () => { $('#shEditDialog').close(); shEditing = null; };
    $('#shEditDelete').onclick = () => { if (shEditing) { state.shopping = state.shopping.filter((s) => s.id !== shEditing.id); save(); } $('#shEditDialog').close(); shEditing = null; render(); };
    $('#shopVoice').onclick = voice;
    $('#shopPhoto').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) openImport(f); });
    $('#shopImportForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const n = addItems($('#shopImportText').value.split('\n').map((l) => l.trim()).filter(Boolean));
      $('#shopImportDialog').close(); toast(`🛒 ${n} Einträge hinzugefügt`);
    });
    $('#shopImportCancel').onclick = () => $('#shopImportDialog').close();
    $('#shopCal').onclick = () => {
      const open = state.shopping.filter((x) => !x.done);
      askCalendar({ title: '🛒 Einkaufen', description: open.length ? 'Einkaufsliste:\n' + open.map((x) => `- ${x.qty ? x.qty + ' ' : ''}${x.name}`).join('\n') : '' });
    };
    // Rezepte
    $('#recipeSearch').addEventListener('input', renderRecipes);
    $('#recipeTags').addEventListener('click', (e) => { const b = e.target.closest('[data-tag]'); if (!b) return; const t = b.dataset.tag; if (tagFilter.has(t)) tagFilter.delete(t); else tagFilter.add(t); renderRecipes(); });
    $('#recipeList').addEventListener('click', (e) => { const c = e.target.closest('[data-rid]'); if (c) showRecipe(c.dataset.rid); });
    $('#recipeAdd').onclick = () => openRecipeEdit(null);
    $('#rdToList').onclick = recipeToList;
    $('#rdClose').onclick = () => $('#recipeDialog').close();
    $('#rdCal').onclick = () => { const r = curRecipe; $('#recipeDialog').close(); askCalendar({ title: `🍳 ${r.title}`, description: `Zutaten:\n${(r.ingredients || []).map((x) => '- ' + x).join('\n')}\n\nZubereitung:\n${(r.steps || []).map((s, i) => `${i + 1}. ${s}`).join('\n')}` }); };
    $('#rdEdit').onclick = () => { const r = state.recipes.find((x) => x.id === curRecipe.id); $('#recipeDialog').close(); openRecipeEdit(r); };
    $('#rdDelete').onclick = () => {
      if (!confirm(`Rezept „${curRecipe.title}“ löschen?`)) return;
      state.recipes = state.recipes.filter((x) => x.id !== curRecipe.id); save(); $('#recipeDialog').close(); render();
    };
    $('#recipeForm').addEventListener('submit', saveRecipe);
    $('#recipeEditCancel').onclick = () => $('#recipeEditDialog').close();
    $('#recipePhoto').addEventListener('change', async (e) => {
      const f = e.target.files[0]; e.target.value = ''; if (!f) return;
      const tmp = document.createElement('textarea'); tmp.id = 'ocrTmp';
      const st = $('#ocrStatus2'); st.hidden = false; st.textContent = 'Lese Rezept …';
      try {
        const text = await Receipt.ocrFile(f, (p, t) => { st.textContent = t || `Lese Rezept … ${Math.round(p * 100)} %`; });
        const p = parseRecipeText(text);
        const rf = $('#recipeForm');
        if (!rf.title.value.trim()) rf.title.value = p.title;
        rf.ingr.value = (rf.ingr.value ? rf.ingr.value + '\n' : '') + p.ingr.join('\n');
        rf.steps.value = (rf.steps.value ? rf.steps.value + '\n' : '') + p.steps.join('\n');
        st.textContent = p.ingr.length ? 'Erkannt – bitte kurz prüfen und korrigieren.' : 'Zutaten nicht sicher erkannt – bitte im Feld nachbessern.';
      } catch (err) { st.textContent = '⚠️ ' + err.message; }
    });
    $('#calForm').addEventListener('submit', submitCal);
    $('#calCancel').onclick = () => $('#calDialog').close();
  }

  return { render, calendar, askCalendar, addItems, _parseRecipeText: parseRecipeText, _splitInput: splitInput, _splitQty: splitQty };
})();
