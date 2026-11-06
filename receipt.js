/* Kassenbon scannen – Foto ODER PDF (z. B. „Dateien → Dokumente scannen“).
 *
 * - Texterkennung läuft direkt auf dem Gerät (Tesseract.js), PDF-Darstellung mit pdf.js – nichts wird dafür hochgeladen.
 * - Erkannt werden: Laden, Filiale (Adresse/Nr.), Datum, Uhrzeit, Summe, Artikel mit Preis, Menge × Stückpreis.
 * - Jeder Artikel bekommt eine Kategorie (lernt aus Korrekturen).
 * - Das Bon-Bild wird verkleinert lokal gespeichert (IndexedDB). Bei gemeinsamen Einkäufen zusätzlich
 *   Ende-zu-Ende-verschlüsselt auf eurem Netlify-Konto, damit es auf beiden Geräten angezeigt werden kann.
 *
 * Wird vor app.js geladen; nutzt dessen globale Helfer erst zur Laufzeit.
 */
'use strict';

const Receipt = (() => {
  const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
  const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  const PENDING_KEY = 'ausgaben-bon-upload';
  let worker = null;
  let editing = null;      // { expenseId } beim Bearbeiten
  let current = null;      // { imageBlob, w, h } des gerade gescannten Bons
  let bound = false;

  // ---------- Skripte nachladen ----------
  const loaded = {};
  function loadScript(url) {
    if (!loaded[url]) {
      loaded[url] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url; s.async = true; s.crossOrigin = 'anonymous';
        s.onload = resolve;
        s.onerror = () => { delete loaded[url]; reject(new Error('Baustein konnte nicht geladen werden – Internet prüfen')); };
        document.head.appendChild(s);
      });
    }
    return loaded[url];
  }

  async function getWorker(onProgress) {
    await loadScript(TESSERACT_URL);
    if (!worker) {
      worker = await Tesseract.createWorker('deu', 1, {
        logger: (m) => { if (m.status === 'recognizing text') onProgress(0.35 + m.progress * 0.65, 'Lese Bon …'); else onProgress(0.2, 'Lade Texterkennung (einmalig ca. 5 MB) …'); },
      });
      await worker.setParameters({ preserve_interword_spaces: '1' });
    }
    return worker;
  }

  // ---------- Bild / PDF vorbereiten ----------
  function loadImage(src) {
    return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Bild konnte nicht geöffnet werden')); i.src = src; });
  }

  /** Liefert ein Farb-Canvas des Bons (PDF: alle Seiten untereinander, max. 4) */
  async function toCanvas(file) {
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
    if (isPdf) {
      await loadScript(PDFJS_URL);
      if (!window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
        // Worker als blob: laden (strenge Sicherheitsregeln erlauben keine fremden Worker-Adressen)
        const code = await (await fetch(PDFJS_WORKER)).text();
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      }
      const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer(), isEvalSupported: false }).promise;
      const pages = [];
      for (let n = 1; n <= Math.min(pdf.numPages, 4); n++) {
        const page = await pdf.getPage(n);
        const v1 = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: Math.min(3, 1400 / v1.width) });
        const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        pages.push(c);
      }
      const w = Math.max(...pages.map((p) => p.width)), h = pages.reduce((a, p) => a + p.height, 0);
      const all = document.createElement('canvas'); all.width = w; all.height = h;
      const ctx = all.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
      let y = 0; for (const p of pages) { ctx.drawImage(p, 0, y); y += p.height; }
      return all;
    }
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImage(url);
      const scale = Math.min(1, 2000 / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c;
    } finally { URL.revokeObjectURL(url); }
  }

  /** Graustufen + Kontrast für die Texterkennung (Scanner-Bilder sind schon aufbereitet → nur Größe anpassen) */
  function forOcr(src, prepared) {
    if (prepared) {
      const sc = Math.max(1, Math.min(2.2, 1300 / src.width));
      const c = document.createElement('canvas'); c.width = Math.round(src.width * sc); c.height = Math.round(src.height * sc);
      const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, c.width, c.height);
      return c;
    }
    const scale = Math.min(1, 1800 / Math.max(src.width, src.height));
    const c = document.createElement('canvas'); c.width = Math.round(src.width * scale); c.height = Math.round(src.height * scale);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height); const px = d.data;
    for (let i = 0; i < px.length; i += 4) {
      let g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      g = Math.max(0, Math.min(255, (g - 128) * 1.5 + 140));
      px[i] = px[i + 1] = px[i + 2] = g;
    }
    ctx.putImageData(d, 0, 0);
    return c;
  }

  /** Verkleinertes Farbbild zum Aufbewahren (gut lesbar, klein) */
  function forStorage(src) {
    const scale = Math.min(1, 1300 / src.width, 6000 / src.height); // gut lesbar für Umtausch/Reklamation
    const c = document.createElement('canvas'); c.width = Math.round(src.width * scale); c.height = Math.round(src.height * scale);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return new Promise((res) => c.toBlob((b) => res({ blob: b, w: c.width, h: c.height }), 'image/jpeg', 0.8));
  }

  // ---------- Lokaler Bild-Speicher (IndexedDB) ----------
  let dbP = null;
  function db() {
    if (!dbP) dbP = new Promise((res, rej) => {
      const r = indexedDB.open('ausgaben-bons', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('bons');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return dbP;
  }
  async function idbPut(id, blob) { const d = await db(); return new Promise((res, rej) => { const t = d.transaction('bons', 'readwrite'); t.objectStore('bons').put(blob, id); t.oncomplete = res; t.onerror = () => rej(t.error); }); }
  async function idbGet(id) { const d = await db(); return new Promise((res, rej) => { const q = d.transaction('bons').objectStore('bons').get(id); q.onsuccess = () => res(q.result || null); q.onerror = () => rej(q.error); }); }
  async function idbDel(id) { const d = await db(); return new Promise((res) => { const t = d.transaction('bons', 'readwrite'); t.objectStore('bons').delete(id); t.oncomplete = res; t.onerror = res; }); }
  const newId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

  // Hochladen (verschlüsselt) – mit Warteschlange, falls gerade offline
  function pending() { try { return JSON.parse(localStorage.getItem(PENDING_KEY)) || []; } catch (e) { return []; } }
  function setPending(list) { try { localStorage.setItem(PENDING_KEY, JSON.stringify(list)); } catch (e) { /* egal */ } }
  async function uploadPending() {
    if (typeof Sync === 'undefined' || !Sync.canFiles()) return;
    const left = [];
    for (const id of pending()) {
      const exp = state.expenses.find((e) => e.receipt && e.receipt.id === id);
      if (!exp || exp.private) continue; // private Bons bleiben auf dem Gerät
      try {
        const blob = await idbGet(id);
        if (blob) await Sync.filePut(id, new Uint8Array(await blob.arrayBuffer()));
      } catch (e) { left.push(id); }
    }
    setPending(left);
  }

  // ---------- Bon-Text auswerten ----------
  const STORES = [
    ['ALDI SÜD', /aldi\s*s[üu]d/i], ['ALDI Nord', /aldi\s*nord/i], ['ALDI', /aldi/i], ['LIDL', /lidl/i], ['REWE', /rewe/i], ['EDEKA', /edeka/i],
    ['Netto', /netto(?!\s*\d)/i], ['Penny', /penny/i], ['Kaufland', /kaufland/i], ['Norma', /norma/i], ['Globus', /globus/i], ['tegut', /tegut/i],
    ['Marktkauf', /marktkauf/i], ['real', /\breal\b/i], ['dm', /\bdm[- ]?(drogerie|markt)|\bdm\b/i], ['Rossmann', /rossmann/i], ['Müller', /m[üu]ller/i],
    ['denn’s Biomarkt', /denn.?s/i], ['Alnatura', /alnatura/i], ['IKEA', /ikea/i], ['OBI', /\bobi\b/i], ['Hornbach', /hornbach/i],
    ['Bauhaus', /bauhaus/i], ['toom', /toom/i], ['Action', /\baction\b/i], ['Tedi', /tedi/i], ['Apotheke', /apotheke/i],
  ];
  const SKIP = /(summe|gesamt|\btotal\b|zu zahlen|\bmwst\b|\bust\b|steuer|netto ?umsatz|brutto|\bnetto\b|\bbar\b|gegeben|r[üu]ckgeld|wechselgeld|ec[- ]?karte|girocard|kartenzahlung|\bvisa\b|mastercard|maestro|kontaktlos|betrag\s*eur|\beur\s*$|datum|uhrzeit|\bkasse\b|bon[- ]?nr|\bbeleg\b|terminal|\btrace\b|\btse\b|signatur|transaktion|steuer-?nr|ust-?id|\btel\b\.?|telefon|www\.|danke|vielen dank|öffnungszeiten|payback|punkte|kundenkarte|filiale|markt\s*\d)/i;
  const PRICE_END = /(-?\s?[\dOo]{1,4}\s?[,.]\s?[\dOo]{2})\s*(?:€|eur)?\s*(?:[ABCD12]|\*|[ABCD]\s?\*)?\s*$/i;
  const QTY = /^\s*(\d{1,3}(?:[,.]\d{1,3})?)\s*(stk\.?|st\.?|kg|x|×|\*)\s*(?:x|×|\*)?\s*([\dOo]{1,4}[,.][\dOo]{2,3})\s*(?:eur|€)?(?:\s*\/\s*(?:kg|stk|st))?/i;

  function fixNum(s) { return s.replace(/[oO]/g, '0').replace(/[lI|]/g, '1').replace(/\s/g, ''); }
  function num(s) { const n = parseFloat(fixNum(s).replace(',', '.')); return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : NaN; }
  const round2 = (n) => Math.round(n * 100) / 100;

  function parseHeader(lines) {
    const head = lines.slice(0, 12);
    const out = { store: '', branch: '' };
    const hit = STORES.find(([, re]) => re.test(head.join(' ')));
    if (hit) out.store = hit[0];
    else { const l = head.slice(0, 6).find((x) => /[a-zäöü]{3,}/i.test(x) && !/\d{3,}/.test(x)); if (l) out.store = l.slice(0, 40); }
    // Filiale: Straße + PLZ/Ort (gleiche oder nächste Zeile) und ggf. Filial-/Marktnummer
    let street = '', place = '';
    for (let i = 0; i < head.length; i++) {
      const m = head[i].match(/\b(\d{5})\s+([A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß .\-/]{2,30})/);
      if (m) {
        place = `${m[1]} ${m[2].trim()}`;
        const before = head[i].slice(0, m.index).replace(/[,;]\s*$/, '').trim();
        if (/[a-zäöüß]{3,}.*\d/i.test(before)) street = before;
        else if (i > 0 && /[a-zäöüß]{3,}\.?\s*\d+\s*[a-z]?\b/i.test(head[i - 1])) street = head[i - 1].trim();
        break;
      }
    }
    const fil = head.join(' ').match(/(?:filiale|markt|fil\.?)\s*(?:nr\.?)?\s*[:#]?\s*(\d{2,6})/i);
    out.branch = [street, place].filter(Boolean).join(', ') + (fil ? `${street || place ? ' · ' : ''}Filiale ${fil[1]}` : '');
    return out;
  }

  function parse(text) {
    const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const result = { store: '', branch: '', date: '', time: '', total: NaN, items: [] };
    Object.assign(result, parseHeader(lines));

    // Datum + Uhrzeit (bevorzugt in derselben Zeile)
    for (const l of lines) {
      const m = l.match(/\b(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})\b/);
      if (!m) continue;
      let y = +m[3]; if (y < 100) y += 2000;
      const mo = +m[2], d = +m[1];
      if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) continue;
      result.date = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const t = l.match(/\b([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?\b/);
      if (t) result.time = `${t[1].padStart(2, '0')}:${t[2]}`;
      break;
    }
    if (!result.time) {
      const t = lines.map((l) => l.match(/\b([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?\b/)).find(Boolean);
      if (t) result.time = `${t[1].padStart(2, '0')}:${t[2]}`;
    }

    // Summe
    let totalIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/zwischensumme/i.test(l)) continue;
      if (/(^|\s)(summe|zu zahlen|gesamtbetrag|gesamt|total|endbetrag|betrag)\b/i.test(l)) {
        const m = l.match(PRICE_END) || (lines[i + 1] || '').match(PRICE_END);
        if (m) { const v = num(m[1]); if (v > 0) { result.total = round2(v); totalIdx = i; break; } }
      }
    }

    // Artikel + Mengenzeilen („2 x 0,49“, „0,512 kg x 2,99 EUR/kg“)
    const end = totalIdx > -1 ? totalIdx : lines.length;
    let pendingQty = null;
    for (let i = 0; i < end; i++) {
      const l = lines[i];
      const q = l.match(QTY);
      if (q && !/[a-zäöü]{4,}/i.test(l.replace(/stk|eur|kg/gi, ''))) {
        const qty = num(q[1]), unit = num(q[3]);
        const last = result.items[result.items.length - 1];
        // passt die Menge zum vorherigen Artikel? sonst gilt sie für den nächsten
        if (last && !last.qty && Math.abs(last.price - qty * unit) < 0.02) { last.qty = qty; last.unit = unit; last.unitLabel = /kg/i.test(q[2]) ? 'kg' : ''; }
        else pendingQty = { qty, unit, unitLabel: /kg/i.test(q[2]) ? 'kg' : '' };
        continue;
      }
      if (SKIP.test(l)) continue;
      const m = l.match(PRICE_END);
      if (!m) continue;
      const name = l.slice(0, m.index).replace(/\s+\d+([,.]\d+)?\s*(stk|st|x|×)\s*[\d,.]+\s*$/i, '').replace(/[\s.:*]+$/, '').trim();
      if (!/[a-zäöü]{2,}/i.test(name)) continue;
      const price = num(m[1]);
      if (!Number.isFinite(price) || Math.abs(price) > 999) continue;
      const it = { name: name.slice(0, 60), price: round2(price) };
      if (pendingQty && Math.abs(it.price - pendingQty.qty * pendingQty.unit) < 0.02) Object.assign(it, pendingQty);
      pendingQty = null;
      result.items.push(it);
    }
    if (!(result.total > 0) && result.items.length) result.total = round2(result.items.reduce((a, it) => a + it.price, 0));
    return result;
  }

  // ---------- Kategorie je Artikel ----------
  const ITEM_RULES = [
    [/pfand|leergut/i, 'sonstiges'],
    [/spül|wasch|reinig|putz|entkalk|toilett|wc[- ]|klopapier|küchenrolle|taschent|zahnpast|zahnbürst|zahncreme|shampoo|spülung|duschgel|deo|seife|creme|lotion|windel|binde|tampon|rasier|pflaster|vitamin|tablett|müllbeutel|alufolie|frischhalte|weichspül|schwamm|kosmet/i, 'drogerie'],
    [/zeitschrift|zeitung|magazin|spielzeug|blumen|pflanze/i, 'freizeit'],
    [/batterie|glühbirne|leuchtmittel|lampe|kabel|usb|socke|shirt|hose|strumpf/i, 'shopping'],
  ];
  const itemKey = (name) => 'item:' + String(name || '').toLowerCase().replace(/[^a-zäöüß0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  function itemCategory(name, fallback) {
    const k = itemKey(name);
    if (state.rules[k] && state.categories.some((c) => c.id === state.rules[k])) return state.rules[k];
    const r = ITEM_RULES.find(([re]) => re.test(name));
    if (r && state.categories.some((c) => c.id === r[1])) return r[1];
    return fallback;
  }

  // ---------- Dialog ----------
  const catOptions = (sel) => state.categories.map((c) => `<option value="${esc(c.id)}" ${c.id === sel ? 'selected' : ''}>${esc(c.emoji)} ${esc(c.name)}</option>`).join('');
  function itemRow(it = { name: '', price: '' }, fallbackCat) {
    const price = it.price === '' ? '' : String(it.price).replace('.', ',');
    const cat = it.cat || itemCategory(it.name, fallbackCat || 'lebensmittel');
    const qty = it.qty ? `${String(it.qty).replace('.', ',')} ${it.unitLabel ? it.unitLabel + ' ×' : '×'} ${fmt(it.unit)}${it.unitLabel ? '/' + it.unitLabel : ''}` : '';
    return `<li class="item-edit" data-qty="${it.qty || ''}" data-unit="${it.unit || ''}" data-ul="${esc(it.unitLabel || '')}">
      <input class="it-name" value="${esc(it.name)}" placeholder="Artikel" aria-label="Artikel">
      <input class="it-price" value="${esc(price)}" inputmode="decimal" placeholder="0,00" aria-label="Preis">
      <button type="button" class="it-del" aria-label="Artikel entfernen">✕</button>
      <div class="item-meta"><select class="it-cat" aria-label="Kategorie">${catOptions(cat)}</select>${qty ? `<span class="it-qty">${esc(qty)}</span>` : ''}</div></li>`;
  }

  function readItems() {
    return $$('#rcItems li').map((li) => {
      const it = { name: $('.it-name', li).value.trim(), price: parseSigned($('.it-price', li).value), cat: $('.it-cat', li).value };
      if (li.dataset.qty) { it.qty = +li.dataset.qty; it.unit = +li.dataset.unit; if (li.dataset.ul) it.unitLabel = li.dataset.ul; }
      return it;
    }).filter((it) => it.name && Number.isFinite(it.price));
  }
  function parseSigned(v) { const neg = /^\s*-/.test(v); const n = parseAmount(v); return Number.isFinite(n) ? (neg ? -n : n) : NaN; }

  function updateSum() {
    const items = readItems();
    const sum = round2(items.reduce((a, it) => a + it.price, 0));
    const total = parseAmount($('#rcTotal').value);
    const el = $('#rcCheck');
    if (!items.length) { el.textContent = ''; return; }
    if (Number.isFinite(total) && Math.abs(total - sum) > 0.01) { el.textContent = `⚠️ Summe der Artikel ${fmt(sum)} ≠ Bon-Summe ${fmt(total)} – bitte Artikel prüfen.`; el.className = 'hint warn'; }
    else { el.textContent = `✓ Summe der Artikel ${fmt(sum)} passt.`; el.className = 'hint ok'; }
  }
  function setProgress(p, text) {
    $('#rcProgress').hidden = p >= 1;
    $('#rcProgress .progress-fill').style.width = Math.round(p * 100) + '%';
    $('#rcStatus').textContent = text || '';
  }
  function fillForm(r) {
    const storeCat = guessCategory(r.store || '') || 'lebensmittel';
    $('#rcStore').value = r.store || '';
    $('#rcBranch').value = r.branch || '';
    $('#rcDate').value = r.date || todayISO();
    $('#rcTime').value = r.time || '';
    $('#rcTotal').value = Number.isFinite(r.total) ? String(r.total).replace('.', ',') : '';
    $('#rcItems').innerHTML = (r.items || []).map((it) => itemRow(it, storeCat === 'sonstiges' ? 'lebensmittel' : storeCat)).join('');
    $('#rcPerson').innerHTML = state.settings.persons.map((p) => `<option>${esc(p)}</option>`).join('');
    $('#rcPerson').value = r.person || state.settings.me;
    $('#rcPrivate').checked = !!r.private;
    updateSum();
  }

  function resetPreview() { const pv = $('#rcPreview'); if (pv.src) URL.revokeObjectURL(pv.src); pv.removeAttribute('src'); pv.hidden = true; }

  function open() {
    editing = null; current = null; bind();
    $('#rcTitle').textContent = '🧾 Kassenbon erfassen';
    $('#rcPick').hidden = false; $('#rcForm').hidden = true; resetPreview(); setProgress(1, '');
    $('#receiptDialog').showModal();
  }
  function editExpense(exp) {
    editing = { expenseId: exp.id }; current = null; bind();
    $('#rcTitle').textContent = '🧾 Bon / Artikel bearbeiten';
    $('#rcPick').hidden = false; $('#rcForm').hidden = false; resetPreview(); setProgress(1, '');
    fillForm({ store: exp.merchant, branch: exp.branch, date: exp.date, time: exp.time, total: exp.amount, items: exp.items || [], person: exp.person, private: exp.private });
    $('#receiptDialog').showModal();
  }

  async function scan(file) {
    $('#rcPick').hidden = true;
    setProgress(0.05, /pdf/i.test(file.type || file.name) ? 'Öffne PDF …' : 'Bereite Bild vor …');
    try { await scanCanvas(await toCanvas(file)); }
    catch (e) { console.warn(e); setProgress(1, '⚠️ ' + e.message); $('#rcPick').hidden = false; }
  }

  /** Direkt aus dem In-App-Scanner: Kamera → Bild → Auswertung */
  function startScan() {
    if (typeof Scanner === 'undefined' || !Scanner.supported()) { open(); return; }
    Scanner.open((canvas, mode) => {
      if (mode === 'fallback' || !canvas) { if (mode === 'fallback') open(); return; }
      editing = null; current = null; bind();
      $('#rcTitle').textContent = '🧾 Kassenbon erfassen';
      $('#rcPick').hidden = true; $('#rcForm').hidden = true; resetPreview(); setProgress(0.05, 'Bereite Scan auf …');
      $('#receiptDialog').showModal();
      scanCanvas(canvas, true).catch((e) => { setProgress(1, '⚠️ ' + e.message); $('#rcPick').hidden = false; });
    });
  }

  async function scanCanvas(color, prepared) {
    {
      current = await forStorage(color);
      const pv = $('#rcPreview'); pv.src = URL.createObjectURL(current.blob); pv.hidden = false;
      const w = await getWorker(setProgress);
      setProgress(0.35, 'Lese Bon …');
      const { data } = await w.recognize(forOcr(color, prepared));
      const r = parse(data.text || '');
      setProgress(1, '');
      if (editing) {
        const cur = readItems();
        r.items = cur.length ? cur : r.items;
        r.store = $('#rcStore').value || r.store; r.branch = $('#rcBranch').value || r.branch;
        r.date = $('#rcDate').value || r.date; r.time = $('#rcTime').value || r.time;
        r.total = parseAmount($('#rcTotal').value) || r.total;
        r.person = $('#rcPerson').value; r.private = $('#rcPrivate').checked;
      }
      const match = !editing && r.date && r.total > 0 ? findMatch(r.date, r.total) : null;
      if (match) { r.person = match.person; r.private = match.private; }
      fillForm(r);
      $('#rcForm').hidden = false;
      $('#rcStatus').textContent = (r.items.length ? `${r.items.length} Artikel erkannt – bitte kurz prüfen.` : 'Keine Artikel sicher erkannt – bitte prüfen und ggf. ergänzen.')
        + (match ? ` Passt zur Zahlung von ${match.person || '–'} (${match.merchant || 'Ausgabe'}, ${fmt(match.amount)}).` : '');
    }
  }

  function findMatch(date, total) {
    const d = new Date(date + 'T12:00').getTime();
    return state.expenses
      .filter((e) => !(e.items && e.items.length) && Math.abs(e.amount - total) < 0.015 && Math.abs(new Date(e.date + 'T12:00').getTime() - d) <= 864e5)
      .sort((a) => (a.date === date ? -1 : 1))[0];
  }

  async function saveReceipt() {
    const total = parseAmount($('#rcTotal').value);
    if (!(total > 0)) { toast('Bitte die Bon-Summe eintragen'); return; }
    const store = $('#rcStore').value.trim();
    const branch = $('#rcBranch').value.trim().slice(0, 120);
    const date = /^\d{4}-\d{2}-\d{2}$/.test($('#rcDate').value) ? $('#rcDate').value : todayISO();
    const time = /^\d{2}:\d{2}$/.test($('#rcTime').value) ? $('#rcTime').value : '';
    const items = readItems();
    const person = $('#rcPerson').value;
    const priv = $('#rcPrivate').checked;
    // Gelernt: Artikel-Kategorie merken (wird wie Händler-Regeln geteilt)
    items.forEach((it) => { if (it.cat) state.rules[itemKey(it.name)] = it.cat; });

    let exp = editing ? state.expenses.find((e) => e.id === editing.expenseId) : null;
    if (!exp) {
      const m = findMatch(date, total);
      if (m && confirm(`Diese Zahlung gibt es schon:\n${m.merchant || 'Ausgabe'} · ${fmt(m.amount)} · ${m.person || ''} · ${m.date.split('-').reverse().join('.')}\n\nOK = Bon dort hinterlegen (empfohlen)\nAbbrechen = als neue Ausgabe speichern`)) exp = m;
    }
    let receipt = exp && exp.receipt ? exp.receipt : null;
    if (current && current.blob) {
      if (receipt) await idbDel(receipt.id).catch(() => {});
      receipt = { id: newId(), w: current.w, h: current.h };
      await idbPut(receipt.id, current.blob);
    }
    const fields = { branch, time, items, ...(receipt ? { receipt } : {}) };
    if (exp && editing) Object.assign(exp, { amount: total, merchant: store || exp.merchant, date, person, private: priv, ...fields });
    else if (exp) Object.assign(exp, { merchant: store || exp.merchant, ...fields, time: time || exp.time || timeFromCreated(exp) }); // per Handy erfasst: Person/Betrag bleiben, Laden/Uhrzeit vom Bon sind genauer
    else {
      exp = { id: uid(), created: new Date().toISOString(), source: 'receipt', amount: total, merchant: store, category: guessCategory(store), date, person, note: '', private: priv, ...fields };
      state.expenses.push(exp);
    }
    save();
    if (receipt && current && !exp.private) { setPending([...new Set([...pending(), receipt.id])]); uploadPending(); }
    viewY = +date.slice(0, 4); viewM = +date.slice(5, 7) - 1;
    render();
    $('#receiptDialog').close();
    current = null; resetPreview();
    toast(`🧾 ${store || 'Bon'} · ${fmt(total)}${items.length ? ' · ' + items.length + ' Artikel' : ''} gespeichert ✓`);
  }
  function timeFromCreated(e) {
    if (!e.created) return '';
    const d = new Date(e.created);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  // ---------- Bon-Ansicht (wie Dokumente in der Gesundheitsakte) ----------
  let vList = [], vIdx = 0, vBlob = null, vUrl = '';

  /** Alle Bons, die in der aktuellen Ansicht sichtbar sind – neueste zuerst */
  function bonList() {
    const personal = typeof isPersonal === 'function' && isPersonal();
    return state.expenses
      .filter((e) => e.receipt && (personal ? isMine(e) : !e.private))
      .sort((x, y) => (y.date + (y.time || '')).localeCompare(x.date + (x.time || '')));
  }

  async function loadBlob(exp) {
    let blob = await idbGet(exp.receipt.id).catch(() => null);
    if (!blob && typeof Sync !== 'undefined' && Sync.canFiles() && !exp.private) {
      try { const bytes = await Sync.fileGet(exp.receipt.id); if (bytes) { blob = new Blob([bytes], { type: 'image/jpeg' }); await idbPut(exp.receipt.id, blob); } } catch (e) { /* offline */ }
    }
    return blob;
  }

  function view(exp) {
    if (!exp || !exp.receipt) return;
    vList = bonList();
    vIdx = Math.max(0, vList.findIndex((e) => e.id === exp.id));
    if (!vList.length || vList[vIdx].id !== exp.id) { vList = [exp]; vIdx = 0; }
    $('#bonViewer').hidden = false; document.body.classList.add('viewer-open');
    showBon();
  }

  async function showBon() {
    const exp = vList[vIdx];
    if (!exp) { closeViewer(); return; }
    const d = new Date(exp.date + 'T12:00');
    $('#bonTitle').textContent = `${d.toLocaleDateString('de-DE')}: ${exp.merchant || 'Kassenbon'}`;
    $('#bonPos').textContent = `${vIdx + 1} / ${vList.length}`;
    $('#bonPrev').disabled = vIdx <= 0;
    $('#bonNext').disabled = vIdx >= vList.length - 1;
    const c = catById(exp.category);
    const kv = (k, v) => (v ? `<div><dt>${k}</dt><dd>${v}</dd></div>` : '');
    $('#bonData').innerHTML = `<h3>${esc(exp.merchant || 'Kassenbon')}</h3><dl>
      ${kv('📍 Filiale', esc(exp.branch || ''))}
      ${kv('📅 Datum', esc(d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })) + (exp.time ? ' · ' + esc(exp.time) + ' Uhr' : ''))}
      ${kv('💶 Summe', fmt(exp.amount))}
      ${kv('👤 Bezahlt von', esc(exp.person || ''))}
      ${kv('🏷️ Kategorie', esc(c.emoji + ' ' + c.name))}
      ${exp.private ? kv('🔒', 'Privat – nur auf diesem Gerät') : ''}</dl>
      ${(exp.items || []).length ? `<ul class="item-list">${exp.items.map((it) => { const ic = catById(it.cat || exp.category); return `<li><span>${esc(ic.emoji)} ${esc(it.name)}</span><span>${fmt(it.price)}</span></li>`; }).join('')}</ul>` : ''}`;
    const img = $('#bonImg');
    img.hidden = true; $('#bonLoading').hidden = false; $('#bonLoading').textContent = 'Lade Bon …';
    if (vUrl) { URL.revokeObjectURL(vUrl); vUrl = ''; }
    vBlob = await loadBlob(exp);
    if (vList[vIdx] !== exp) return; // inzwischen weitergeblättert
    if (!vBlob) { $('#bonLoading').textContent = 'Das Bild ist auf diesem Gerät nicht vorhanden (privater Bon eines anderen Geräts oder gerade offline). Die Daten oben sind trotzdem gespeichert.'; return; }
    vUrl = URL.createObjectURL(vBlob);
    img.src = vUrl; img.hidden = false; $('#bonLoading').hidden = true;
    $('#bonScroll').scrollTop = 0;
  }

  const ascii = (t) => String(t || '').replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
  const fileName = (exp) => `Kassenbon_${ascii(exp.merchant || 'Bon').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}_${exp.date}${exp.time ? '_' + exp.time.replace(':', '-') : ''}.jpg`;

  async function share() {
    const exp = vList[vIdx]; if (!exp || !vBlob) { toast('Kein Bild vorhanden'); return; }
    const file = new File([vBlob], fileName(exp), { type: 'image/jpeg' });
    const text = `Kassenbon ${exp.merchant || ''}${exp.branch ? ' (' + exp.branch + ')' : ''}, ${new Date(exp.date + 'T12:00').toLocaleDateString('de-DE')}${exp.time ? ' ' + exp.time + ' Uhr' : ''}, ${fmt(exp.amount)}`;
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'Kassenbon', text }); return; }
    } catch (e) { if (e.name === 'AbortError') return; }
    download(); // Rückfall
  }
  function download() {
    const exp = vList[vIdx]; if (!exp || !vBlob) { toast('Kein Bild vorhanden'); return; }
    const a = document.createElement('a'); a.href = vUrl; a.download = fileName(exp);
    document.body.appendChild(a); a.click(); a.remove();
  }
  function print() {
    if (!vBlob) { toast('Kein Bild vorhanden'); return; }
    document.body.classList.add('print-bon');
    const done = () => { document.body.classList.remove('print-bon'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    setTimeout(() => { window.print(); setTimeout(done, 1500); }, 50);
  }
  async function removeBon() {
    const exp = vList[vIdx]; if (!exp) return;
    if (!confirm('Nur das Bon-Bild löschen?\n\nDie Ausgabe mit Laden, Datum, Betrag und Artikeln bleibt erhalten.')) return;
    const id = exp.receipt.id;
    await idbDel(id).catch(() => {});
    if (typeof Sync !== 'undefined') Sync.fileDelete(id).catch(() => {});
    delete exp.receipt; save(); render();
    vList.splice(vIdx, 1); if (vIdx >= vList.length) vIdx = vList.length - 1;
    toast('Bon-Bild gelöscht');
    if (!vList.length) closeViewer(); else showBon();
  }
  function edit() { const exp = vList[vIdx]; closeViewer(); if (exp) editExpense(exp); }
  function go(d) { const n = vIdx + d; if (n < 0 || n >= vList.length) return; vIdx = n; showBon(); }

  function closeViewer() {
    $('#bonViewer').hidden = true; document.body.classList.remove('viewer-open');
    const img = $('#bonImg'); img.removeAttribute('src');
    if (vUrl) { URL.revokeObjectURL(vUrl); vUrl = ''; }
    vBlob = null;
  }

  /** Bons beider Personen vorab aufs Gerät holen – damit sie im Laden auch offline da sind */
  async function prefetch() {
    if (typeof Sync === 'undefined' || !Sync.canFiles() || navigator.onLine === false) return;
    let n = 0;
    for (const e of state.expenses) {
      if (!e.receipt || e.private || n >= 25) continue;
      if (await idbGet(e.receipt.id).catch(() => null)) continue;
      try { const bytes = await Sync.fileGet(e.receipt.id); if (bytes) { await idbPut(e.receipt.id, new Blob([bytes], { type: 'image/jpeg' })); n++; } } catch (err) { break; }
    }
  }

  function bind() {
    if (bound) return; bound = true;
    $('#rcFile').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) scan(f); });
    $('#rcPdf').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) scan(f); });
    $('#rcManual').onclick = () => { $('#rcPick').hidden = true; fillForm({ items: [] }); $('#rcForm').hidden = false; };
    $('#rcAddItem').onclick = () => { $('#rcItems').insertAdjacentHTML('beforeend', itemRow({ name: '', price: '' }, 'lebensmittel')); $('#rcItems li:last-child .it-name').focus(); };
    $('#rcItems').addEventListener('click', (e) => { if (e.target.matches('.it-del')) { e.target.closest('li').remove(); updateSum(); } });
    $('#rcItems').addEventListener('input', updateSum);
    $('#rcItems').addEventListener('change', (e) => {
      if (!e.target.matches('.it-name')) return; // neuer Name → Kategorie neu vorschlagen
      const li = e.target.closest('li'); $('.it-cat', li).value = itemCategory(e.target.value, $('.it-cat', li).value);
    });
    $('#rcTotal').addEventListener('input', updateSum);
    $('#rcCancel').onclick = () => { $('#receiptDialog').close(); current = null; resetPreview(); };
    $('#rcSave').onclick = saveReceipt;
  }

  function init() {
    if (typeof Scanner !== 'undefined') Scanner.bind();
    $('#bonClose').onclick = closeViewer;
    $('#bonEdit').onclick = edit;
    $('#bonShare').onclick = share;
    $('#bonPrint').onclick = print;
    $('#bonDownload').onclick = download;
    $('#bonDelete').onclick = removeBon;
    $('#bonPrev').onclick = () => go(-1);
    $('#bonNext').onclick = () => go(1);
    document.addEventListener('keydown', (e) => {
      if ($('#bonViewer').hidden) return;
      if (e.key === 'Escape') closeViewer();
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
    });
    let sx = null, sy = null;
    $('#bonScroll').addEventListener('touchstart', (e) => { if (e.touches.length === 1) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; } else sx = null; }, { passive: true });
    $('#bonScroll').addEventListener('touchend', (e) => {
      if (sx == null) return;
      const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy; sx = null;
      if (Math.abs(dx) > 70 && Math.abs(dy) < 50) go(dx < 0 ? 1 : -1);
    });
    setTimeout(uploadPending, 3000);
    setTimeout(prefetch, 6000);
    if (typeof Sync !== 'undefined') Sync.onStatus((st) => { if (st.state === 'ok') setTimeout(prefetch, 1500); });
    window.addEventListener('online', uploadPending);
  }

  return { open, startScan, editExpense, parse, view, init, itemCategory, uploadPending, bonList, prefetch, _scanCanvas: (c) => scanCanvas(c) };
})();
