/* Kassenbon scannen – Texterkennung direkt auf dem Gerät (Tesseract.js).
 * Das Foto wird NICHT hochgeladen und nicht gespeichert; gespeichert werden nur
 * Laden, Datum, Summe und die Artikel mit Preisen (als Teil der Ausgabe).
 *
 * Wird vor app.js geladen; nutzt dessen globale Helfer erst zur Laufzeit.
 */
'use strict';

const Receipt = (() => {
  const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  let libPromise = null;
  let worker = null;
  let editing = null;   // { expenseId } beim Bearbeiten einer vorhandenen Ausgabe
  let bound = false;

  // ---------- Texterkennung ----------
  function loadLib() {
    if (window.Tesseract) return Promise.resolve();
    if (!libPromise) {
      libPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = TESSERACT_URL; s.async = true;
        s.onload = resolve;
        s.onerror = () => { libPromise = null; reject(new Error('Texterkennung konnte nicht geladen werden – Internet prüfen')); };
        document.head.appendChild(s);
      });
    }
    return libPromise;
  }

  async function getWorker(onProgress) {
    await loadLib();
    if (!worker) {
      worker = await Tesseract.createWorker('deu', 1, {
        logger: (m) => { if (m.status === 'recognizing text') onProgress(0.3 + m.progress * 0.7, 'Lese Bon …'); else onProgress(0.15, 'Lade Texterkennung (einmalig ca. 5 MB) …'); },
      });
      await worker.setParameters({ preserve_interword_spaces: '1' });
    }
    return worker;
  }

  /** Foto verkleinern, in Graustufen + mehr Kontrast umwandeln → bessere Erkennung */
  async function prepareImage(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Bild konnte nicht geöffnet werden')); i.src = url; });
      const scale = Math.min(1, 1800 / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h); const px = d.data;
      for (let i = 0; i < px.length; i += 4) {
        let g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        g = Math.max(0, Math.min(255, (g - 128) * 1.5 + 140)); // Kontrast anheben, leicht aufhellen
        px[i] = px[i + 1] = px[i + 2] = g;
      }
      ctx.putImageData(d, 0, 0);
      return c;
    } finally { URL.revokeObjectURL(url); }
  }

  // ---------- Bon-Text auswerten ----------
  const STORES = [
    ['ALDI', /aldi/i], ['LIDL', /lidl/i], ['REWE', /rewe/i], ['EDEKA', /edeka/i], ['Netto', /netto(?! ?\d)/i], ['Penny', /penny/i],
    ['Kaufland', /kaufland/i], ['Norma', /norma/i], ['Globus', /globus/i], ['tegut', /tegut/i], ['Marktkauf', /marktkauf/i],
    ['real', /\breal\b/i], ['dm', /\bdm[- ]?(drogerie|markt)|\bdm\b/i], ['Rossmann', /rossmann/i], ['Müller', /m[üu]ller/i],
    ['denn’s Biomarkt', /denn.?s/i], ['Alnatura', /alnatura/i], ['IKEA', /ikea/i], ['OBI', /\bobi\b/i], ['Hornbach', /hornbach/i],
    ['Bauhaus', /bauhaus/i], ['toom', /toom/i], ['Action', /\baction\b/i], ['Tedi', /tedi/i], ['Apotheke', /apotheke/i],
  ];
  const SKIP = /(summe|gesamt|\btotal\b|zu zahlen|\bmwst\b|\bust\b|steuer|netto ?umsatz|brutto|\bnetto\b|\bbar\b|gegeben|r[üu]ckgeld|wechselgeld|ec[- ]?karte|girocard|kartenzahlung|\bvisa\b|mastercard|maestro|kontaktlos|betrag\s*eur|\beur\s*$|datum|uhrzeit|\bkasse\b|bon[- ]?nr|\bbeleg\b|terminal|\btrace\b|\btse\b|signatur|transaktion|steuer-?nr|ust-?id|\btel\b\.?|telefon|www\.|danke|vielen dank|öffnungszeiten|payback|punkte|kundenkarte|filiale|markt\s*\d)/i;

  function fixNum(s) {
    return s.replace(/[oO]/g, '0').replace(/[lI|]/g, '1').replace(/\s/g, '');
  }
  function num(s) {
    const t = fixNum(s).replace(',', '.');
    const n = parseFloat(t);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
  }
  // Preis am Zeilenende, optional gefolgt von Steuerkennzeichen (A, B, 1, 2, *)
  const PRICE_END = /(-?\s?[\dOo]{1,4}\s?[,.]\s?[\dOo]{2})\s*(?:€|eur)?\s*(?:[ABCD12]|\*|[ABCD]\s?\*)?\s*$/i;

  function parse(text) {
    const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const result = { store: '', date: '', total: NaN, items: [] };

    // Laden: bekannte Kette in den ersten Zeilen, sonst erste „Text“-Zeile
    const head = lines.slice(0, 10).join(' ');
    const hit = STORES.find(([, re]) => re.test(head));
    if (hit) result.store = hit[0];
    else {
      const l = lines.slice(0, 6).find((x) => /[a-zäöü]{3,}/i.test(x) && !/\d{3,}/.test(x));
      if (l) result.store = l.slice(0, 40);
    }

    // Datum
    for (const l of lines) {
      const m = l.match(/\b(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})\b/);
      if (m) {
        let y = +m[3]; if (y < 100) y += 2000;
        const mo = +m[2], d = +m[1];
        if (y >= 2000 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
          result.date = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`; break;
        }
      }
    }

    // Summe: „Summe“, „zu zahlen“, „Gesamt“ – nicht „Zwischensumme“
    let totalIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/zwischensumme/i.test(l)) continue;
      if (/(^|\s)(summe|zu zahlen|gesamtbetrag|gesamt|total|endbetrag|betrag)\b/i.test(l)) {
        const m = l.match(PRICE_END) || (lines[i + 1] || '').match(PRICE_END);
        if (m) { const v = num(m[1]); if (v > 0) { result.total = v; totalIdx = i; break; } }
      }
    }

    // Artikel: Zeilen mit Preis am Ende, vor der Summe
    const end = totalIdx > -1 ? totalIdx : lines.length;
    for (let i = 0; i < end; i++) {
      const l = lines[i];
      if (SKIP.test(l)) continue;
      if (/^\d+([,.]\d+)?\s*(stk|st|x|×|\*)\s*[\dOo]/i.test(l) && !/[a-zäöü]{3,}/i.test(l.replace(/stk|st/i, ''))) continue; // „2 x 0,99“
      const m = l.match(PRICE_END);
      if (!m) continue;
      let name = l.slice(0, m.index).replace(/\s+\d+([,.]\d+)?\s*(stk|st|x|×)\s*[\d,.]+\s*$/i, '').replace(/[\s.:*]+$/, '').trim();
      if (!/[a-zäöü]{2,}/i.test(name)) continue;
      const price = num(m[1]);
      if (!Number.isFinite(price) || Math.abs(price) > 999) continue;
      result.items.push({ name: name.slice(0, 60), price });
    }

    if (!(result.total > 0) && result.items.length) {
      result.total = Math.round(result.items.reduce((a, it) => a + it.price, 0) * 100) / 100;
    }
    return result;
  }

  // ---------- Dialog ----------
  function itemRow(it = { name: '', price: '' }) {
    const price = it.price === '' ? '' : String(it.price).replace('.', ',');
    return `<li class="item-edit">
      <input class="it-name" value="${esc(it.name)}" placeholder="Artikel" aria-label="Artikel">
      <input class="it-price" value="${esc(price)}" inputmode="decimal" placeholder="0,00" aria-label="Preis">
      <button type="button" class="it-del" aria-label="Artikel entfernen">✕</button></li>`;
  }

  function readItems() {
    return $$('#rcItems li').map((li) => ({
      name: $('.it-name', li).value.trim(),
      price: parseSigned($('.it-price', li).value),
    })).filter((it) => it.name && Number.isFinite(it.price));
  }
  function parseSigned(v) {
    const neg = /^\s*-/.test(v);
    const n = parseAmount(v);
    return Number.isFinite(n) ? (neg ? -n : n) : NaN;
  }

  function updateSum() {
    const sum = Math.round(readItems().reduce((a, it) => a + it.price, 0) * 100) / 100;
    const total = parseAmount($('#rcTotal').value);
    const el = $('#rcCheck');
    if (!readItems().length) { el.textContent = ''; return; }
    if (Number.isFinite(total) && Math.abs(total - sum) > 0.01) {
      el.textContent = `⚠️ Summe der Artikel ${fmt(sum)} ≠ Bon-Summe ${fmt(total)} – bitte Artikel prüfen.`;
      el.className = 'hint warn';
    } else {
      el.textContent = `✓ Summe der Artikel ${fmt(sum)} passt.`;
      el.className = 'hint ok';
    }
  }

  function setProgress(p, text) {
    $('#rcProgress').hidden = p >= 1;
    $('#rcProgress .progress-fill').style.width = Math.round(p * 100) + '%';
    $('#rcStatus').textContent = text || '';
  }

  function fillForm(r) {
    $('#rcStore').value = r.store || '';
    $('#rcDate').value = r.date || todayISO();
    $('#rcTotal').value = Number.isFinite(r.total) ? String(r.total).replace('.', ',') : '';
    $('#rcItems').innerHTML = (r.items || []).map(itemRow).join('');
    $('#rcPerson').innerHTML = state.settings.persons.map((p) => `<option>${esc(p)}</option>`).join('');
    $('#rcPerson').value = r.person || state.settings.me;
    $('#rcPrivate').checked = !!r.private;
    updateSum();
  }

  function open() {
    editing = null;
    bind();
    $('#rcTitle').textContent = '🧾 Kassenbon scannen';
    $('#rcPick').hidden = false;
    $('#rcForm').hidden = true;
    $('#rcPreview').hidden = true;
    setProgress(1, '');
    $('#receiptDialog').showModal();
  }

  /** Artikel einer vorhandenen Ausgabe bearbeiten (oder nachträglich hinzufügen) */
  function editExpense(exp) {
    editing = { expenseId: exp.id };
    bind();
    $('#rcTitle').textContent = '🧾 Artikel bearbeiten';
    $('#rcPick').hidden = false;
    $('#rcForm').hidden = false;
    $('#rcPreview').hidden = true;
    setProgress(1, '');
    fillForm({ store: exp.merchant, date: exp.date, total: exp.amount, items: exp.items || [], person: exp.person, private: exp.private });
    $('#receiptDialog').showModal();
  }

  async function scan(file) {
    $('#rcPick').hidden = true;
    const pv = $('#rcPreview');
    pv.src = URL.createObjectURL(file); pv.hidden = false;
    setProgress(0.05, 'Bereite Foto vor …');
    try {
      const canvas = await prepareImage(file);
      const w = await getWorker(setProgress);
      setProgress(0.3, 'Lese Bon …');
      const { data } = await w.recognize(canvas);
      const r = parse(data.text || '');
      setProgress(1, '');
      if (editing) {
        // vorhandene Werte behalten, nur Artikel ergänzen
        const cur = readItems();
        r.items = cur.length ? cur : r.items;
        r.store = $('#rcStore').value || r.store; r.date = $('#rcDate').value || r.date;
        r.total = parseAmount($('#rcTotal').value) || r.total;
        r.person = $('#rcPerson').value; r.private = $('#rcPrivate').checked;
      }
      const match = !editing && r.date && r.total > 0 ? findMatch(r.date, r.total) : null;
      if (match) { r.person = match.person; r.private = match.private; }
      fillForm(r);
      $('#rcForm').hidden = false;
      $('#rcStatus').textContent = (r.items.length
        ? `${r.items.length} Artikel erkannt – bitte kurz prüfen und ggf. korrigieren.`
        : 'Keine Artikel sicher erkannt – bitte Laden und Summe prüfen, Artikel bei Bedarf von Hand ergänzen.')
        + (match ? ` Passt zur Zahlung von ${match.person || '–'} (${match.merchant || 'Ausgabe'}, ${fmt(match.amount)}).` : '');
    } catch (e) {
      console.warn(e);
      setProgress(1, '⚠️ ' + e.message);
      $('#rcPick').hidden = false;
    } finally {
      setTimeout(() => URL.revokeObjectURL(pv.src), 60000);
    }
  }

  function findMatch(date, total) {
    const d = new Date(date + 'T12:00').getTime();
    return state.expenses
      .filter((e) => !e.items?.length && Math.abs(e.amount - total) < 0.015 && Math.abs(new Date(e.date + 'T12:00').getTime() - d) <= 864e5)
      .sort((a, b) => (a.date === date ? -1 : 1))[0];
  }

  function saveReceipt() {
    const total = parseAmount($('#rcTotal').value);
    if (!(total > 0)) { toast('Bitte die Bon-Summe eintragen'); return; }
    const store = $('#rcStore').value.trim();
    const date = /^\d{4}-\d{2}-\d{2}$/.test($('#rcDate').value) ? $('#rcDate').value : todayISO();
    const items = readItems();
    const person = $('#rcPerson').value;
    const priv = $('#rcPrivate').checked;

    let exp = editing ? state.expenses.find((e) => e.id === editing.expenseId) : null;
    if (!exp) {
      // Wurde die Zahlung schon per Handy erfasst? Dann Artikel dort ergänzen statt doppelt buchen
      const m = findMatch(date, total);
      if (m && confirm(`Diese Zahlung gibt es schon:\n${m.merchant || 'Ausgabe'} · ${fmt(m.amount)} · ${m.person || ''} · ${m.date.split('-').reverse().join('.')}\n\nOK = Artikel dort hinterlegen (empfohlen)\nAbbrechen = als neue Ausgabe speichern`)) exp = m;
    }
    if (exp && editing) {
      Object.assign(exp, { amount: total, merchant: store || exp.merchant, date, items, person, private: priv });
    } else if (exp) {
      // Zahlung war schon erfasst (z. B. per Handy): nur die Artikel ergänzen, Person/Betrag/Datum bleiben
      Object.assign(exp, { items, merchant: exp.merchant || store });
    } else {
      exp = {
        id: uid(), created: new Date().toISOString(), source: 'receipt', amount: total, merchant: store,
        category: guessCategory(store), date, person, note: '', private: priv, items,
      };
      state.expenses.push(exp);
    }
    save();
    viewY = +date.slice(0, 4); viewM = +date.slice(5, 7) - 1;
    render();
    $('#receiptDialog').close();
    toast(`🧾 ${store || 'Bon'} · ${fmt(total)}${items.length ? ' · ' + items.length + ' Artikel' : ''} gespeichert ✓`);
  }

  function bind() {
    if (bound) return; bound = true;
    $('#rcFile').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) scan(f); });
    $('#rcManual').onclick = () => { $('#rcPick').hidden = true; fillForm({ items: [] }); $('#rcForm').hidden = false; };
    $('#rcAddItem').onclick = () => { $('#rcItems').insertAdjacentHTML('beforeend', itemRow()); $('#rcItems li:last-child .it-name').focus(); };
    $('#rcItems').addEventListener('click', (e) => { if (e.target.matches('.it-del')) { e.target.closest('li').remove(); updateSum(); } });
    $('#rcItems').addEventListener('input', updateSum);
    $('#rcTotal').addEventListener('input', updateSum);
    $('#rcCancel').onclick = () => $('#receiptDialog').close();
    $('#rcSave').onclick = saveReceipt;
  }

  return { open, editExpense, parse };
})();
