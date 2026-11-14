/* Mein Konto – private Kontobewegungen (nur ansehen).
 *
 * Umsätze werden als CSV aus dem Online-Banking importiert und NUR lokal auf diesem
 * Gerät gespeichert (eigener Speicher, nicht im Haushalts-Sync, nicht im Backup).
 * Einzelne Ausgaben können bewusst per „＋ Haushalt“ ins gemeinsame Buch übernommen werden.
 *
 * Wird vor app.js geladen; nutzt dessen globale Helfer erst zur Laufzeit.
 */
'use strict';

const Konto = (() => {
  const KEY = 'ausgaben-konto-v1';
  let data = read();
  let bound = false;

  function read() {
    try {
      const d = JSON.parse(localStorage.getItem(KEY));
      if (d && Array.isArray(d.accounts) && Array.isArray(d.tx)) {
        d.links = d.links || {}; d.dismissed = d.dismissed || {};
        return d;
      }
    } catch (e) { /* leer */ }
    return { accounts: [], tx: [], links: {}, dismissed: {} };
  }
  function write() {
    try { localStorage.setItem(KEY, JSON.stringify(data)); }
    catch (e) { toast('⚠️ Speicher voll – Konto-Umsätze konnten nicht gespeichert werden'); }
  }

  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
  }

  // ---------- CSV ----------
  function decode(buf) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch (e) { return new TextDecoder('windows-1252').decode(buf); } // viele Banken exportieren ANSI
  }

  function parseCsv(text, delim) {
    const rows = []; let row = []; let cell = ''; let q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.map((r) => r.map((x) => x.trim()));
  }

  const norm = (s) => String(s || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]/g, '');

  const COLS = {
    date: ['buchungstag', 'buchungsdatum', 'datum', 'bookingdate', 'date', 'buchung', 'valutadatum', 'wertstellung', 'valuedate'],
    amount: ['betrag', 'betrageur', 'betrageuro', 'betragineur', 'umsatz', 'umsatzineur', 'amount', 'amounteur', 'betraginvalutaeur'],
    name: ['beguenstigterzahlungspflichtiger', 'namezahlungsbeteiligter', 'zahlungsbeteiligter', 'auftraggeberempfaenger', 'auftraggeberbeguenstigter',
      'zahlungsempfaengerin', 'zahlungsempfaenger', 'empfaengerauftraggeber', 'empfaenger', 'auftraggeber', 'payee', 'partnername', 'gegenpartei', 'name'],
    purpose: ['verwendungszweck', 'paymentreference', 'beschreibung', 'buchungsdetails', 'umsatzart', 'buchungstext', 'vorgang'],
    soll: ['soll', 'sollbetrag', 'ausgang'],
    haben: ['haben', 'habenbetrag', 'eingang'],
    sh: ['sollhaben', 'sh'],
    payer: ['zahlungspflichtiger', 'zahlungspflichtige', 'zahlungspflichtigerr'],
    payee: ['zahlungsempfaengerin', 'zahlungsempfaenger'],
  };

  function findCol(header, keys) {
    for (const k of keys) { const i = header.indexOf(k); if (i > -1) return i; }
    return -1;
  }

  function parseSigned(s) {
    let t = String(s || '').replace(/\s|€|eur/gi, '');
    if (!t) return NaN;
    let neg = false;
    if (/^-|-$/.test(t)) neg = true;
    t = t.replace(/^[+-]|[+-]$/g, '');
    if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
    const n = parseFloat(t);
    return Number.isFinite(n) ? Math.round((neg ? -n : n) * 100) / 100 : NaN;
  }

  function parseDate(s) {
    s = String(s || '').trim();
    let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
    if (m) {
      let y = +m[3]; if (y < 100) y += 2000;
      return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
    }
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  }

  /** CSV-Text → [{date, amount, name, purpose}] */
  function parseStatement(text) {
    text = text.replace(/^﻿/, '');
    const sample = text.split(/\r?\n/).slice(0, 30).join('\n');
    const delim = [';', ',', '\t'].map((d) => [d, sample.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = parseCsv(text, delim);
    let hi = -1, header = null;
    for (let i = 0; i < Math.min(rows.length, 40); i++) {
      const h = rows[i].map(norm);
      if (findCol(h, COLS.date) > -1 && (findCol(h, COLS.amount) > -1 || findCol(h, COLS.soll) > -1)) { hi = i; header = h; break; }
    }
    if (!header) throw new Error('Spalten „Datum“ und „Betrag“ nicht gefunden – ist das ein Umsatz-Export als CSV?');
    const c = {}; for (const k of Object.keys(COLS)) c[k] = findCol(header, COLS[k]);
    // Spalte „Betrag“ nicht mit „Soll“/„Haben“ verwechseln
    const out = [];
    for (const r of rows.slice(hi + 1)) {
      if (r.length < 2) continue;
      const date = parseDate(r[c.date]);
      if (!date) continue;
      let amount;
      if (c.amount > -1) {
        amount = parseSigned(r[c.amount]);
        if (c.sh > -1 && /^s/i.test(r[c.sh] || '') && amount > 0) amount = -amount;
      } else {
        const soll = parseSigned(r[c.soll]) || 0, haben = parseSigned(r[c.haben]) || 0;
        amount = Math.round((haben - Math.abs(soll)) * 100) / 100;
      }
      if (!Number.isFinite(amount) || amount === 0) continue;
      // DKB & Co.: getrennte Spalten für Zahler und Empfänger → je nach Richtung die Gegenseite nehmen
      const name = c.payer > -1 && c.payee > -1 ? (amount > 0 ? r[c.payer] : r[c.payee]) || '' : (c.name > -1 ? r[c.name] || '' : '');
      const purpose = c.purpose > -1 ? r[c.purpose] : '';
      out.push({ date, amount, name: name.replace(/\s+/g, ' ').slice(0, 120), purpose: purpose.replace(/\s+/g, ' ').slice(0, 300) });
    }
    if (!out.length) throw new Error('Keine Buchungen in der Datei gefunden.');
    return out;
  }

  // ---------- Import ----------
  async function importFile(file) {
    let rows;
    try { rows = parseStatement(decode(await file.arrayBuffer())); }
    catch (e) { toast('⚠️ ' + e.message); return; }

    const names = data.accounts.map((a) => a.name);
    const suggestion = names.length === 1 ? names[0] : (names[0] || 'Girokonto');
    const answer = prompt(
      `${rows.length} Buchungen gefunden.\n\nZu welchem Konto gehören sie?` + (names.length ? `\nVorhanden: ${names.join(', ')}` : ''),
      suggestion);
    if (answer === null) return;
    const accName = answer.trim() || suggestion;
    let acc = data.accounts.find((a) => a.name.toLowerCase() === accName.toLowerCase());
    if (!acc) { acc = { id: uid(), name: accName }; data.accounts.push(acc); }

    const existing = new Set(data.tx.map((t) => t.id));
    const seen = {};
    let added = 0;
    for (const r of rows) {
      const base = `${acc.id}|${r.date}|${r.amount}|${r.name}|${r.purpose}`;
      seen[base] = (seen[base] || 0) + 1; // identische Buchungen am selben Tag unterscheiden
      const id = hash(base) + '-' + seen[base];
      if (existing.has(id)) continue;
      data.tx.push({ id, account: acc.id, ...r });
      existing.add(id); added++;
    }
    write();
    try { sessionStorage.setItem('konto-acc', acc.id); } catch (e) { /* egal */ }
    // Zum Monat der neuesten Buchung springen
    const newest = rows.map((r) => r.date).sort().pop();
    if (newest) { viewY = +newest.slice(0, 4); viewM = +newest.slice(5, 7) - 1; }
    window.render();
    toast(added ? `${added} neue Buchungen importiert ✓` : 'Keine neuen Buchungen (alle schon vorhanden)');
  }

  // ---------- Übernahme in den Haushalt ----------
  function maybeCaptured(t) {
    const d = new Date(t.date + 'T12:00').getTime();
    return state.expenses.some((e) => !e.private && Math.abs(e.amount - Math.abs(t.amount)) < 0.005 &&
      Math.abs(new Date(e.date + 'T12:00').getTime() - d) <= 3 * 864e5);
  }

  function addToHousehold(txId) { openTx(txId, true); }

  /** Fenster für eine Kontobuchung: eigene Kategorie (abwählbar) und ob sie im Haushalt erscheint */
  let txEditing = null, txCat = '';
  function openTx(txId, household, split) {
    const t = data.tx.find((x) => x.id === txId);
    if (!t) return;
    txEditing = t;
    const exp = t.linked ? state.expenses.find((e) => e.id === t.linked) : null;
    const f = $('#txForm');
    const d = t.date.split('-').reverse().join('.');
    $('#txInfo').innerHTML = `<b>${fmt(t.amount)}</b> · ${esc(d)}<br>${esc(t.name || '')}${t.purpose ? '<br><span class="muted">' + esc(t.purpose) + '</span>' : ''}`;
    const gi0 = groupInfo(t);
    f.label.value = t.label || (exp && exp.merchant) || (gi0 && gi0.agg && gi0.inner) || (t.name || t.purpose || '').slice(0, 60); // PayPal → „Netflix“ statt „PayPal Europe …“
    // Keine Vermutung: nur was ihr selbst festgelegt habt (direkt oder bei einer gleichen Buchung)
    txCat = t.cat !== undefined ? t.cat : exp ? exp.category : learnedCat(t);
    txSubcat = t.subcat !== undefined ? t.subcat : exp && exp.subcat ? exp.subcat : learnedSubcat(t, txCat);
    drawTxCats();
    const gk = groupKey(t);
    const cur = (gk && linkedSub(gk)) || (t.sub && state.subs.find((x) => x.id === t.sub)) || null;
    txCurSub = cur && !isTransfer(cur) ? cur : null;
    const kind = t.amount >= 0 ? 'personal'
      : txCurSub ? (txCurSub.private ? 'fixprivate' : 'fixshared')
        : (household || (exp && !exp.private)) ? 'shared' : 'personal';
    f.querySelectorAll('input[name=kind]').forEach((r) => { r.checked = r.value === kind; r.disabled = t.amount >= 0 && r.value !== 'personal'; });
    { // Rhythmus vorschlagen: aus bisherigen gleichen Buchungen, sonst aus dem Text
      const g = gk ? detect('', true).find((x) => x.key === gk) : null;
      f.interval.value = g && g.months.length >= 2 ? g.interval : guessInterval(`${t.name} ${t.purpose}`);
    }
    const bonBtn = $('#txBon');
    bonBtn.hidden = !(exp && exp.receipt);
    bonBtn.onclick = () => { $('#txDialog').close(); Receipt.view(exp); };
    $('#txLinkInfo').textContent = exp && exp.source !== 'bank'
      ? `Gehört zu deinem Einkauf „${exp.merchant}“ vom ${exp.date.split('-').reverse().join('.')}${exp.items && exp.items.length ? ` – ${exp.items.length} Artikel vom Bon` : ''}.` : '';
    $('#txLinkInfo').hidden = !(exp && exp.source !== 'bank');
    $('#txUnlink').hidden = !(exp && exp.source !== 'bank');
    $('#txUnlink').onclick = () => { delete t.linked; t.noMatch = true; write(); $('#txDialog').close(); txEditing = null; render(); toast('Zuordnung gelöst'); };
    syncTxSub();
    txSplits = Array.isArray(t.splits) ? t.splits.map((x) => ({ ...x })) : [];
    const cashM = `${t.name} ${t.purpose}`.match(/bargeld\w*\.?\s*(\d{1,4}[,.]\d{2})/i);
    const cashAmt = cashM ? num2(cashM[1]) : 0;
    txCashHint = cashAmt > 0 && cashAmt < Math.abs(t.amount) ? cashAmt : 0;
    $('#txSplitHint').hidden = !txCashHint || txSplits.length;
    $('#txSplitHint').textContent = txCashHint ? `💵 Erkannt: ${fmt(txCashHint)} Bargeld abgehoben – tippe auf „Betrag aufteilen“.` : '';
    drawSplits();
    $('#txDialog').showModal();
    if (split && !txSplits.length) startSplit();
    { // Bon/Einkauf zuordnen
      const cands = t.amount < 0 ? bonCandidates(t) : [];
      const cur = exp && exp.source !== 'bank' ? exp : null;
      $('#txBonRow').hidden = !cands.length && !cur;
      const d = (x) => x.split('-').reverse().slice(0, 2).join('.');
      $('#txBonSel').innerHTML = '<option value="">— kein Bon —</option>' + cands.map((e) =>
        `<option value="${esc(e.id)}">${e.receipt ? '🧾' : '📲'} ${esc(e.merchant)} · ${d(e.date)} · ${fmt(e.amount)}${Math.abs(e.amount - Math.abs(t.amount)) < 0.005 ? ' ✓' : ''}</option>`).join('');
      $('#txBonSel').value = cur ? cur.id : '';
    }
  }
  /**
   * Gescannte Bons / per Handy erfasste Einkäufe der passenden Kartenzahlung zuordnen:
   * gleicher Betrag, Abbuchung 0–6 Tage nach dem Einkauf (Karten werden oft erst später gebucht), am liebsten gleicher Laden.
   */
  function matchReceipts() {
    const me = state.settings.me;
    const used = new Set(data.tx.filter((t) => t.linked).map((t) => t.linked));
    const cands = state.expenses.filter((e) => !used.has(e.id) && e.source !== 'bank' && !e.cash && (e.private || e.person === me) && e.amount > 0);
    if (!cands.length) return false;
    const day = (d) => new Date(d + 'T12:00').getTime() / 864e5;
    const shop = (x) => (typeof storeOf === 'function' ? storeOf(x) : String(x || '').toLowerCase());
    let changed = false;
    const bankExp = (t) => { const e = t.linked && state.expenses.find((x) => x.id === t.linked); return e && e.source === 'bank' && !(e.items && e.items.length) ? e : null; };
    for (const t of data.tx) {
      const replaceable = bankExp(t);
      if (t.amount >= 0 || (t.linked && !replaceable) || t.sub || t.noMatch || t.splits) continue;
      const gk = groupKey(t);
      if (gk && data.links[gk]) continue; // Abo/Haushaltsgeld
      let best = null, bestScore = -1;
      for (const e of cands) {
        if (used.has(e.id) || Math.abs(e.amount - Math.abs(t.amount)) > 0.005) continue;
        const diff = day(t.date) - day(e.date);
        if (diff < -1 || diff > 6) continue;
        const score = (shop(t.name) === shop(e.merchant) || `${t.name} ${t.purpose}`.toLowerCase().includes(shop(e.merchant).toLowerCase()) ? 10 : 0) + (6 - Math.abs(diff));
        if (score > bestScore) { best = e; bestScore = score; }
      }
      if (best) {
        if (replaceable) { // gleiche Ausgabe war schon aus der Kontobuchung übernommen → Bon ersetzt sie (keine Doppelzählung)
          best.private = replaceable.private; if (!best.category || best.category === 'sonstiges') best.category = replaceable.category;
          state.expenses = state.expenses.filter((x) => x.id !== replaceable.id);
          if (typeof save === 'function') save();
        }
        t.linked = best.id; used.add(best.id); changed = true;
      }
    }
    if (changed) write();
    return changed;
  }

  /** Bons/Einkäufe, die zu dieser Buchung passen könnten (nahe Datum, eigene, noch nicht verbunden) */
  function bonCandidates(t) {
    const me = state.settings.me;
    const used = new Set(data.tx.filter((x) => x !== t && x.linked).map((x) => x.linked));
    const day = (d) => new Date(d + 'T12:00').getTime() / 864e5;
    return state.expenses.filter((e) => e.source !== 'bank' && !e.cash && !used.has(e.id) && (e.private || e.person === me)
      && day(t.date) - day(e.date) >= -3 && day(t.date) - day(e.date) <= 10)
      .sort((a, b) => Math.abs(a.amount - Math.abs(t.amount)) - Math.abs(b.amount - Math.abs(t.amount)));
  }

  /** Rhythmus aus dem Buchungstext erraten: „Jahresbeitrag“, „01.10.26-30.09.27“ → jährlich usw. */
  function guessInterval(text) {
    const t = String(text || '');
    if (/halbj(ä|ae)hr|1\.\s*halbjahr|2\.\s*halbjahr|\bhj\b/i.test(t)) return 'half';
    if (/quartal|viertelj(ä|ae)hr|\bq[1-4]\b/i.test(t)) return 'quarter';
    if (/jahres|j(ä|ae)hrlich|p\.\s?a\.|beitrag\s*\d{4}\b/i.test(t)) return 'year';
    const r = t.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})\s*[-–bis ]+\s*(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
    if (r) { // Zeitraum im Verwendungszweck
      const y = (v) => (+v < 100 ? 2000 + +v : +v);
      const months = (y(r[6]) - y(r[3])) * 12 + (+r[5] - +r[2]) + 1;
      if (months >= 11) return 'year'; if (months >= 5) return 'half'; if (months >= 3) return 'quarter';
    }
    return 'month';
  }

  /** Abgehobenes Bargeld eines Monats (Geldautomat oder Bargeld an der Kasse) – nur dieses Gerät */
  const ATM = /bargeldausz|bargeldauszahlung|geldautomat|\bga\s+\d|auszahlung\s+ga|cash\s?withdraw/i;
  function cashForMonth(y, m) {
    const key = monthKey(y, m);
    let sum = 0;
    for (const t of data.tx) {
      if (!t.date.startsWith(key) || t.amount >= 0) continue;
      if (t.splits) sum += t.splits.filter((p) => p.kind === 'cash').reduce((a, p) => a + p.amount, 0);
      else if (t.cashAll || (ATM.test(`${t.name} ${t.purpose}`) && !t.linked && !t.sub && !/bargeldausz\.?\s*\d/i.test(t.purpose || ''))) sum += Math.abs(t.amount);
    }
    return Math.round(sum * 100) / 100;
  }

  /** Kategorie, die ihr bei einer gleichen Buchung schon festgelegt habt – sonst keine */
  function learnedCat(t) {
    const k = groupKey(t);
    const c = k && data.catRules ? data.catRules[k] : '';
    return c && state.categories.some((x) => x.id === c) ? c : '';
  }
  // ---------- Buchung aufteilen (z. B. Einkauf + Bargeld) ----------
  let txSplits = [], txCashHint = 0;
  const num2 = (s) => Math.round(parseFloat(String(s).replace(/\./g, '').replace(',', '.')) * 100) / 100;
  const SPLIT_KINDS = { cash: '💵 Bargeld – erst mal meins', personal: '🔒 Nur für mich', shared: '👫 Gemeinsam' };
  function drawSplits() {
    const on = txSplits.length > 0;
    $('#txSplit').hidden = !on; $('#txSplitBtn').hidden = on;
    $('#txKindField').hidden = on; $('#txSubRow').hidden = on || $('#txSubRow').hidden; $('#txIvRow').hidden = on || $('#txIvRow').hidden;
    if (!on) return;
    const cats = '<option value="">Kategorie …</option>' + state.categories.map((c) => `<option value="${esc(c.id)}">${esc(c.emoji)} ${esc(c.name)}</option>`).join('');
    $('#txSplitList').innerHTML = txSplits.map((p, i) => `<li data-i="${i}">
      <input class="sp-amt-in" inputmode="decimal" value="${p.amount ? String(p.amount).replace('.', ',') : ''}" placeholder="0,00" aria-label="Betrag">
      <input class="sp-label-in" value="${esc(p.label || '')}" placeholder="Bezeichnung" aria-label="Bezeichnung">
      <select class="sp-kind-in">${Object.entries(SPLIT_KINDS).map(([v, l]) => `<option value="${v}" ${p.kind === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select class="sp-cat-in" ${p.kind === 'cash' ? 'hidden' : ''}>${cats.replace(`value="${esc(p.cat || '')}"`, `value="${esc(p.cat || '')}" selected`)}</select>
      ${txSplits.length > 2 ? '<button type="button" class="sh-del sp-del" aria-label="Teil entfernen">✕</button>' : ''}</li>`).join('');
    const total = Math.abs(txEditing.amount), sum = Math.round(txSplits.reduce((s, p) => s + (p.amount || 0), 0) * 100) / 100;
    const rest = Math.round((total - sum) * 100) / 100;
    $('#txSplitSum').textContent = Math.abs(rest) < 0.005 ? `✓ Summe passt: ${fmt(total)}` : `⚠️ Noch ${fmt(rest)} offen (Buchung: ${fmt(total)})`;
    $('#txSplitSum').classList.toggle('warn', Math.abs(rest) >= 0.005);
  }
  function readSplits() {
    $$('#txSplitList li').forEach((li) => {
      const p = txSplits[+li.dataset.i];
      p.amount = num2(li.querySelector('.sp-amt-in').value) || 0;
      p.label = li.querySelector('.sp-label-in').value.trim().slice(0, 60);
      p.kind = li.querySelector('.sp-kind-in').value;
      p.cat = p.kind === 'cash' ? '' : li.querySelector('.sp-cat-in').value;
    });
  }
  function startSplit() {
    const total = Math.abs(txEditing.amount);
    const name = (txEditing.label || txEditing.name || 'Einkauf').slice(0, 40);
    txSplits = txCashHint
      ? [{ amount: Math.round((total - txCashHint) * 100) / 100, label: name, kind: 'shared', cat: txCat || '' }, { amount: txCashHint, label: 'Bargeld', kind: 'cash', cat: '' }]
      : [{ amount: total, label: name, kind: 'shared', cat: txCat || '' }, { amount: 0, label: '', kind: 'personal', cat: '' }];
    $('#txSplitHint').hidden = true;
    drawSplits();
  }
  /** Aufgeteilte Buchung speichern: gemeinsame Teile werden Haushaltsausgaben, Bargeld zählt nicht */
  function saveSplits(t) {
    readSplits();
    const parts = txSplits.filter((p) => p.amount > 0);
    const total = Math.abs(t.amount), sum = Math.round(parts.reduce((s, p) => s + p.amount, 0) * 100) / 100;
    if (Math.abs(total - sum) >= 0.005) { toast(`Die Teile ergeben ${fmt(sum)}, die Buchung ist ${fmt(total)}`); return false; }
    // bisherige Zuordnungen dieser Buchung lösen
    (t.splitExp || []).forEach((id) => { state.expenses = state.expenses.filter((e) => e.id !== id || e.source !== 'bank'); });
    if (t.linked) { const old = state.expenses.find((e) => e.id === t.linked); if (old && old.source === 'bank') state.expenses = state.expenses.filter((e) => e.id !== old.id); delete t.linked; }
    if (t.sub) delete t.sub;
    t.splitExp = [];
    parts.filter((p) => p.kind === 'shared').forEach((p) => {
      const e = { id: uid(), created: new Date().toISOString(), source: 'bank', amount: p.amount, merchant: p.label || (t.name || 'Kontobuchung').slice(0, 60),
        category: p.cat || 'sonstiges', date: t.date, person: state.settings.me, note: 'Teil einer Kontobuchung', private: false };
      state.expenses.push(e); t.splitExp.push(e.id);
    });
    t.splits = parts;
    write(); save(); $('#txDialog').close(); txEditing = null; window.render();
    toast('✂️ Aufgeteilt gespeichert');
    return true;
  }

  let txCurSub = null;
  const txKind = () => ($('#txForm').querySelector('input[name=kind]:checked') || {}).value || 'personal';
  /** Auswahl der Fixkosten nur zeigen, wenn „Fixkosten gemeinsam/privat“ gewählt ist – passend gefiltert */
  function syncTxSub() {
    const f = $('#txForm');
    const k = txKind();
    const fix = k === 'fixshared' || k === 'fixprivate';
    $('#txSubRow').hidden = !fix; $('#txSubHint').hidden = !fix; $('#txIvRow').hidden = true;
    if (!fix) return;
    const priv = k === 'fixprivate';
    const list = state.subs.filter((x) => !isTransfer(x) && !!x.private === priv);
    const prev = f.sub.value;
    f.sub.innerHTML = list.map((x) => `<option value="${esc(x.id)}">${esc(x.name)} (${fmt(x.amount)})</option>`).join('')
      + '<option value="__new">＋ Neu anlegen …</option>';
    const want = txCurSub && !!txCurSub.private === priv ? txCurSub.id : prev;
    f.sub.value = list.some((x) => x.id === want) ? want : '__new';
    $('#txIvRow').hidden = f.sub.value !== '__new';
  }
  let txSubcat = '';
  /** Kategorie als aufklappbare Liste (+ neu anlegen), darunter „Genauer“ mit Unterkategorien (+ neu, abwählbar) */
  function drawTxCats() {
    const cs = $('#txCatSel'), ss = $('#txSubcatSel');
    cs.innerHTML = '<option value="">— keine Kategorie —</option>'
      + state.categories.map((c) => `<option value="${esc(c.id)}">${esc(c.emoji)} ${esc(c.name)}</option>`).join('')
      + '<option value="__new">＋ Neue Kategorie …</option>';
    cs.value = state.categories.some((c) => c.id === txCat) ? txCat : '';
    const cat = state.categories.find((c) => c.id === txCat);
    $('#txSubcatRow').hidden = !cat;
    if (!cat) { txSubcat = ''; return; }
    const subs = Array.isArray(cat.subs) ? cat.subs : [];
    ss.innerHTML = '<option value="">— keine —</option>'
      + subs.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join('')
      + `<option value="__new">＋ Neu bei „${esc(cat.name)}“ …</option>`
      + (txSubcat && subs.includes(txSubcat) ? `<option value="__del">🗑 „${esc(txSubcat)}“ aus der Liste löschen</option>` : '');
    ss.value = subs.includes(txSubcat) ? txSubcat : '';
  }
  function onTxCat() {
    const cs = $('#txCatSel');
    if (cs.value === '__new') {
      const name = (prompt('Name der neuen Kategorie (z. B. „Hund“, „Geschenke“):') || '').trim().slice(0, 40);
      if (name) {
        let c = state.categories.find((x) => x.name.toLowerCase() === name.toLowerCase());
        if (!c) { c = { id: uid(), name, emoji: '🏷️', budget: 0, subs: [] }; state.categories.push(c); save(); toast('Kategorie angelegt ✓ (Symbol änderbar unter Einstellungen)'); }
        txCat = c.id;
      }
    } else txCat = cs.value;
    txSubcat = '';
    drawTxCats();
  }
  function onTxSubcat() {
    const ss = $('#txSubcatSel');
    const cat = state.categories.find((c) => c.id === txCat);
    if (!cat) return;
    cat.subs = Array.isArray(cat.subs) ? cat.subs : [];
    if (ss.value === '__new') {
      const name = (prompt(`Neue Unterkategorie bei „${cat.name}“ (z. B. „Auto“):`) || '').trim().slice(0, 40);
      if (name) { if (!cat.subs.some((x) => x.toLowerCase() === name.toLowerCase())) { cat.subs.push(name); save(); } txSubcat = cat.subs.find((x) => x.toLowerCase() === name.toLowerCase()); }
    } else if (ss.value === '__del') {
      if (confirm(`„${txSubcat}“ aus der Liste bei „${cat.name}“ löschen?\n(Bereits zugeordnete Buchungen behalten den Namen.)`)) { cat.subs = cat.subs.filter((x) => x !== txSubcat); save(); txSubcat = ''; }
    } else txSubcat = ss.value;
    drawTxCats();
  }
  function learnedSubcat(t, cat) {
    const k = groupKey(t);
    const r = k && data.subcatRules ? data.subcatRules[k] : null;
    return r && r.cat === cat ? r.sub : '';
  }
  function saveTx(ev) {
    ev.preventDefault();
    const t = txEditing; if (!t) return;
    const f = $('#txForm');
    const label = f.label.value.trim();
    const orig = (t.name || t.purpose || '').slice(0, 60);
    if (label && label !== orig) t.label = label; else delete t.label;
    t.cat = txCat;
    if (txSubcat) t.subcat = txSubcat; else delete t.subcat;
    { // merken: gleiche Buchungen (gleicher Empfänger bzw. gleicher Händler über PayPal …) künftig genauso einsortieren
      const lk = groupKey(t);
      if (lk) {
        data.catRules = data.catRules || {}; data.subcatRules = data.subcatRules || {};
        if (txCat) data.catRules[lk] = txCat; else delete data.catRules[lk];
        if (txCat && txSubcat) data.subcatRules[lk] = { cat: txCat, sub: txSubcat }; else delete data.subcatRules[lk];
      }
    }
    if (txCat && label) learnRule(label, txCat);
    if (txSplits.length) { saveSplits(t); return; }
    if (t.splits) { // Aufteilung wurde aufgehoben
      (t.splitExp || []).forEach((id) => { state.expenses = state.expenses.filter((e) => e.id !== id || e.source !== 'bank'); });
      delete t.splits; delete t.splitExp;
    }
    { // Bon/Einkauf von Hand zugeordnet bzw. gelöst
      const sel = $('#txBonRow').hidden ? null : $('#txBonSel').value;
      const curExp = t.linked ? state.expenses.find((e) => e.id === t.linked) : null;
      if (sel && (!curExp || curExp.id !== sel)) {
        const bon = state.expenses.find((e) => e.id === sel);
        if (curExp && curExp.source === 'bank') { bon.private = curExp.private; state.expenses = state.expenses.filter((e) => e.id !== curExp.id); }
        if (Math.abs(bon.amount - Math.abs(t.amount)) >= 0.005) { // Bank weiß den Betrag sicher – Bon-Summe war falsch gelesen
          bon.note = [bon.note, `Bon-Summe war ${fmt(bon.amount)}`].filter(Boolean).join(' · ');
          bon.amount = Math.abs(t.amount);
        }
        t.linked = bon.id; delete t.noMatch;
      } else if (sel === '' && curExp && curExp.source !== 'bank') { delete t.linked; t.noMatch = true; }
    }
    let exp = t.linked ? state.expenses.find((e) => e.id === t.linked) : null;
    // Abo-Zuordnung: Buchung zählt dann über das Abo (kein zusätzlicher Haushaltseintrag)
    const gk = groupKey(t);
    const kind = t.amount >= 0 ? 'personal' : txKind();
    const fix = kind === 'fixshared' || kind === 'fixprivate';
    const subSel = fix ? f.sub.value : '';
    const dropExp = () => { if (exp) { if (exp.source === 'bank') state.expenses = state.expenses.filter((e) => e.id !== exp.id); delete t.linked; } };
    const linkTo = (id) => { t.sub = id; if (gk) { data.links[gk] = id; delete data.dismissed[gk]; } dropExp(); };
    if (subSel === '__new') {
      // Direkt anlegen – alles Nötige steht schon in diesem Fenster (ändern geht später unter „Fixkosten“)
      const shared = kind === 'fixshared';
      const iv = f.interval.value || 'month';
      const sub = { id: uid(), type: 'fixed', name: (label || orig || 'Fixkosten').slice(0, 60), amount: Math.abs(t.amount), interval: iv, spread: iv !== 'month',
        category: txCat || 'abos', subcat: txSubcat || '', start: t.date.slice(0, 7), end: '', payer: state.settings.me, to: '',
        private: !shared, via: /paypal/i.test(`${t.name} ${t.purpose}`) ? 'PayPal' : '' };
      state.subs.push(sub);
      linkTo(sub.id);
      write(); save(); $('#txDialog').close(); txEditing = null; window.render();
      toast(`${shared ? '🏠 Gemeinsame' : '🔒 Private'} Fixkosten „${sub.name}“ angelegt (${INTERVALS[iv]}) ✓`);
      return;
    }
    if (subSel) {
      linkTo(subSel);
      write(); save(); $('#txDialog').close(); txEditing = null; window.render();
      const sb = state.subs.find((x) => x.id === subSel);
      toast(`✓ Zugeordnet: ${sb ? sb.name : 'Fixkosten'}`);
      return;
    }
    const oldSub = txCurSub;
    if (t.sub) delete t.sub;
    if (gk && oldSub && data.links[gk] === oldSub.id) delete data.links[gk];
    if (oldSub && !Object.values(data.links).includes(oldSub.id)
      && confirm(`„${oldSub.name}“ zählt dann nicht mehr als Fixkosten.\n\nDen Eintrag „${oldSub.name}“ (${fmt(oldSub.amount)}) auch aus den ${oldSub.private ? 'privaten' : 'gemeinsamen'} Fixkosten entfernen?`)) {
      state.subs = state.subs.filter((x) => x.id !== oldSub.id);
    }
    if (kind === 'shared') {
      const cat = txCat || 'sonstiges';
      if (exp && exp.source !== 'bank') { exp.private = false; if (txCat) { exp.category = txCat; exp.subcat = txSubcat || undefined; } } // Bon/Handy-Einkauf: nur freigeben
      else if (exp) { exp.merchant = label || orig; exp.category = cat; exp.subcat = txSubcat || undefined; }
      else {
        exp = { id: uid(), created: new Date().toISOString(), source: 'bank', amount: Math.abs(t.amount), merchant: label || orig || 'Kontobuchung',
          category: cat, subcat: txSubcat || undefined, date: t.date, person: state.settings.me, note: '', private: false };
        state.expenses.push(exp); t.linked = exp.id;
      }
      toast('✓ Gemeinsame Ausgabe');
    } else if (exp && exp.source !== 'bank') {
      exp.private = true; // Bon bleibt erhalten, zählt nur nicht mehr gemeinsam
      toast('Nur für mich – der Bon bleibt gespeichert');
    } else if (exp) {
      state.expenses = state.expenses.filter((e) => e.id !== exp.id);
      delete t.linked;
      toast('Nur für mich ✓');
    } else toast('Gespeichert ✓');
    write(); save(); $('#txDialog').close(); txEditing = null; window.render();
  }

  // ---------- Regelmäßige Zahlungen erkennen ----------
  // Vorschläge für Namen/Kategorie (nur Vorschlag – alles ist im Dialog änderbar)
  const HINTS = [
    [/kaltmiete|warmmiete|\bmiete\b|mietzahlung|wohnungsbau|hausverwaltung|vermiet|wohnungsgenossenschaft|vonovia|deutsche wohnen|leg immobilien|gewobag|saga/i, 'Miete', 'wohnen'],
    [/nebenkosten|hausgeld|betriebskosten/i, 'Nebenkosten', 'wohnen'],
    [/\bstrom\b|stadtwerke|vattenfall|e\.?on|enbw|yello|lichtblick|naturstrom|eprimo|tibber|ostrom|polarstern|energie/i, 'Strom', 'wohnen'],
    [/\bgas\b|erdgas|fernwärme|fernwaerme/i, 'Gas / Heizung', 'wohnen'],
    [/wasser|abwasser/i, 'Wasser', 'wohnen'],
    [/rundfunk|beitragsservice|ard zdf/i, 'Rundfunkbeitrag', 'wohnen'],
    [/telekom|vodafone|\bo2\b|telefonica|1&1|congstar|pyur|unitymedia|\bdsl\b|glasfaser|mobilfunk|freenet|winsim|drillisch/i, 'Internet & Handy', 'abos'],
    [/kfz|autoversicherung|kraftfahrt/i, 'Kfz-Versicherung', 'mobilitaet'],
    [/versicherung|allianz|\bhuk\b|ergo|\baxa\b|generali|devk|signal iduna|r\+v|debeka|haftpflicht|hausrat|gothaer|zurich|barmenia/i, 'Versicherung', 'sonstiges'],
    [/kita|kindergarten|\bhort\b|tagesmutter|schulgeld|mensa/i, 'Kita / Schule', 'sonstiges'],
    [/netflix|spotify|disney|dazn|\bsky\b|prime video|amazon prime|youtube premium|audible|waipu|joyn|rtl ?\+|magenta ?tv|zattoo|paramount|\bwow\b|crunchyroll|deezer|tidal/i, 'Streaming / Abo', 'abos'],
    [/fitness|mcfit|urban sports|clever fit|john reed|sportverein|\bverein\b/i, 'Fitness / Verein', 'freizeit'],
    [/kredit|darlehen|finanzierung|tilgung|ratenzahlung/i, 'Kredit / Rate', 'wohnen'],
    [/\badac\b|mitglied|mitgliedsbeitrag|jahresbeitrag|gewerkschaft|\bverband\b/i, 'Mitgliedschaft', 'sonstiges'],
    [/\bgez\b|steuer|kfz-steuer|hundesteuer|grundsteuer|finanzamt|bundeskasse/i, 'Steuern / Abgaben', 'wohnen'],
  ];
  const STOP = /\b(gmbh|ag|se|kg|ohg|co|eg|ev|e\.v|mbh|und|sagt|danke|ihr|einkauf|filiale|lastschrift|sepa|dauerauftrag|gutschrift|ueberweisung|überweisung|kartenzahlung|online|de|www|com)\b/g;

  function baseName(s) {
    return String(s || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[0-9]/g, ' ').replace(/[^a-zäöüß&+ ]/g, ' ')
      .replace(STOP, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 3).join(' ');
  }
  // Zahlungsdienste, die viele verschiedene Abos bündeln
  const AGGREGATORS = [
    ['PayPal', /paypal/i], ['Apple', /apple\.com|apple services|itunes|apple distribution/i],
    ['Google', /google (play|payment|\*)|google ireland/i], ['Amazon', /amazon (digital|prime|eu|payments)|amzn|amazon\.de/i],
    ['Klarna', /klarna/i],
  ];
  /** Bei PayPal steht der eigentliche Händler oft im Verwendungszweck */
  function innerMerchant(t) {
    const p = `${t.purpose} `;
    const m = p.match(/(?:ihr einkauf bei|einkauf bei|zahlung an|purchase at)\s+([^,/]+?)(?:\s*,|\s{2,}|\s*$)/i)
      || p.match(/PP\.\d+\.PP\s*\.\s*([^,/]+?)(?:\s*,|\s{2,}|\s*$)/i);
    const v = m ? m[1].trim() : '';
    return v && !/paypal/i.test(v) ? v.slice(0, 40) : '';
  }
  function aggregatorOf(t) {
    const text = `${t.name} ${t.purpose}`;
    const a = AGGREGATORS.find(([, re]) => re.test(text));
    return a ? a[0] : '';
  }
  /** Gruppiert gleiche Abbuchungen. Bei PayPal/Apple & Co. nach Händler bzw. Betrag getrennt */
  const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /** Überweisung an den Partner (z. B. Haushaltsgeld an Ute)? → Name des Partners */
  function partnerOf(t) {
    if (!(t.amount < 0)) return '';
    const text = `${t.name} ${t.purpose}`;
    return state.settings.persons.filter((x) => x && x !== state.settings.me)
      .find((x) => x.split(/\s+/)[0].length >= 3 && new RegExp('\\b' + escRe(x.split(/\s+/)[0]) + '\\b', 'i').test(text)) || '';
  }
  function legacyKey(t) { const b = baseName(t.name) || baseName(t.purpose); return b ? `${t.account}|${b}` : null; }
  function groupInfo(t) {
    const partner = partnerOf(t);
    if (partner) return { key: `${t.account}|partner|${partner.toLowerCase()}`, agg: '', inner: '', partner };
    const agg = aggregatorOf(t);
    if (agg) {
      const inner = innerMerchant(t);
      if (inner) return { key: `${t.account}|${agg}|${baseName(inner) || inner.toLowerCase()}`, agg, inner };
      return { key: `${t.account}|${agg}|${Math.abs(t.amount).toFixed(2)}`, agg, inner: '' };
    }
    const b = baseName(t.name) || baseName(t.purpose);
    if (b) return { key: `${t.account}|${b}`, agg: '', inner: '' };
    // Kein brauchbarer Name (z. B. nur „LASTSCHRIFT 88812“): am gleichen Betrag wiedererkennen
    return t.amount < 0 ? { key: `${t.account}|betrag|${Math.abs(t.amount).toFixed(2)}`, agg: '', inner: '', byAmount: true } : null;
  }
  function groupKey(t) { const g = groupInfo(t); return g ? g.key : null; }
  const monthIdx = (ym) => +ym.slice(0, 4) * 12 + (+ym.slice(5, 7) - 1);
  const ymOf = (i) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;

  function linkedSub(key) {
    const id = data.links[key];
    if (!id) return null;
    const s = state.subs.find((x) => x.id === id);
    if (!s) { delete data.links[key]; write(); }
    return s || null;
  }

  function otherPerson() {
    const me = state.settings.me;
    return state.settings.persons.find((p) => p !== me) || '';
  }

  /** Gruppen regelmäßiger Abbuchungen */
  function detect(accId, includeAll = false) {
    const groups = new Map();
    for (const t of data.tx) {
      if (t.amount >= 0 || (accId && t.account !== accId)) continue;
      const k = groupKey(t);
      if (!k) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    }
    const out = [];
    for (const [key, list] of groups) {
      if (key.includes('|partner|') && !data.links[key]) { // frühere Zuordnung (vor dem Zusammenfassen) weiterverwenden
        for (const t of list) { const lk = legacyKey(t); if (lk && data.links[lk]) { data.links[key] = data.links[lk]; if (data.dismissed[lk]) data.dismissed[key] = true; break; } }
      }
      list.sort((a, b) => a.date.localeCompare(b.date));
      const latest = list[list.length - 1];
      const months = [...new Set(list.map((t) => t.date.slice(0, 7)))];
      const amts = list.map((t) => Math.abs(t.amount));
      const max = Math.max(...amts), min = Math.min(...amts);
      const stable = (max - min) / max <= 0.15;
      // üblicher Betrag = häufigster der letzten 6 Buchungen (einzelne Abweichungen, z. B. Verrechnung, zählen nicht)
      const recent = amts.slice(-6), freq = {};
      recent.forEach((a) => { const k = a.toFixed(2); freq[k] = (freq[k] || 0) + 1; });
      let usual = +Object.entries(freq).sort((a, b) => b[1] - a[1] || +b[0] - +a[0])[0][0];
      // dauerhaft geändert (z. B. neuer Dauerauftrag): die letzten zwei Buchungen gleich → neuer Betrag
      if (amts.length >= 2 && Math.abs(amts[amts.length - 1] - amts[amts.length - 2]) < 0.005) usual = amts[amts.length - 1];
      const text = `${latest.name} ${latest.purpose}`;
      const gi = groupInfo(latest);
      const hint = HINTS.find(([re]) => re.test(gi.agg ? gi.inner : text));
      const others = state.settings.persons.filter((p) => p !== state.settings.me);
      const toPartner = gi.partner || others.find((p) => p.length >= 3 && new RegExp('\\b' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(text));
      const linked = !!data.links[key];
      const recurring = (months.length >= 2 && stable) || (hint && Math.abs(latest.amount) >= 2) || toPartner;
      if (!recurring && !linked && !includeAll) continue;
      if (gi.byAmount && !linked && !includeAll) continue; // nur am Betrag erkannt: nicht ungefragt vorschlagen
      if (data.dismissed[key] && !linked && !includeAll) continue;
      let interval = guessInterval(text);
      if (months.length >= 2) {
        const idx = months.map(monthIdx);
        const gaps = idx.slice(1).map((v, i) => v - idx[i]).sort((a, b) => a - b);
        const g = gaps[Math.floor(gaps.length / 2)];
        interval = g <= 1.5 ? 'month' : g <= 4.5 ? 'quarter' : g <= 8.5 ? 'half' : 'year';
      }
      if (gi.partner) interval = 'month'; // Haushaltsgeld kommt monatlich, auch wenn mal ein Monat fehlt
      out.push({
        key, list, latest, months, interval, toPartner,
        amount: gi.partner || !stable ? usual : Math.abs(latest.amount),
        name: gi.partner ? `Überweisung an ${gi.partner}` : gi.agg ? (gi.inner || `${gi.agg}-Abo ${fmt(Math.abs(latest.amount))}`) : hint ? hint[1] : (latest.name || latest.purpose || '').slice(0, 40),
        category: hint ? hint[2] : gi.agg ? 'abos' : guessCategory(text),
        counterparty: gi.agg ? `über ${gi.agg}${gi.inner ? ' → ' + gi.inner : ' (Händler steht nicht in der Buchung – bitte benennen)'}` : (latest.name || latest.purpose.slice(0, 40)),
        via: gi.agg || 'Girokonto',
      });
    }
    return out.sort((a, b) => (!!data.links[b.key] - !!data.links[a.key]) || b.amount - a.amount);
  }

  function presetFor(g, type) {
    const start = g.months[0];
    if (type === 'transfer') {
      return { type: 'transfer', name: 'Haushaltsgeld', amount: g.amount, interval: g.interval, payer: state.settings.me, to: g.toPartner || otherPerson(), start };
    }
    return { type: 'fixed', name: g.name, amount: g.amount, interval: g.interval, category: g.category, payer: state.settings.me, start, via: g.via, spread: g.interval !== 'month' };
  }

  function linkGroup(g, type) {
    delete data.dismissed[g.key];
    const preset = presetFor(g, type === 'private' ? 'fixed' : type);
    if (type === 'private') { preset.private = true; preset.payer = state.settings.me; }
    openSubDialog(null, preset, (subId) => {
      data.links[g.key] = subId; write(); window.render();
      toast(type === 'transfer' ? '💶 Haushaltsgeld eingetragen ✓' : type === 'private' ? '🔒 Als privates Abo gespeichert ✓' : '🏠 Als gemeinsame Fixkosten übernommen ✓');
    });
  }

  /** Neuer Betrag (z. B. Strom-Abschlag erhöht): alten Eintrag beenden, neuen ab diesem Monat anlegen */
  function updateAmount(g) {
    const s = linkedSub(g.key);
    if (!s) return;
    const L = g.latest.date.slice(0, 7);
    if (s.start >= L) s.amount = g.amount;
    else {
      s.end = ymOf(monthIdx(L) - 1);
      const n = { ...s, id: uid(), amount: g.amount, start: L, end: '' };
      state.subs.push(n);
      data.links[g.key] = n.id;
    }
    write(); save(); window.render();
    toast(`Neuer Betrag ${fmt(g.amount)} ab ${L.split('-').reverse().join('/')} ✓`);
  }

  let lastGroups = [];
  function renderRecurring(accId) {
    const card = $('#kontoRecurringCard');
    lastGroups = detect(accId);
    card.hidden = !lastGroups.length;
    if (!lastGroups.length) return;
    const rhythm = INTERVALS;
    $('#kontoRecurring').innerHTML = lastGroups.map((g, i) => {
      const s = linkedSub(g.key);
      const day = +g.latest.date.slice(8, 10);
      const sub = [esc(g.counterparty), `${rhythm[g.interval]}, ca. am ${day}.`, `${g.list.length}× gefunden`].join(' · ');
      let actions;
      if (s) {
        const what = s.type === 'transfer' ? `✓ Haushaltsgeld an ${esc(s.to)}` : s.private ? `✓ Privates Abo „${esc(s.name)}“` : `✓ Gemeinsame Fixkosten „${esc(s.name)}“`;
        const current = state.subs.find((x) => x.id === s.id);
        const changed = current && Math.abs(current.amount - g.amount) > 0.009 && !current.end;
        actions = `<span class="rec-linked">${what}</span>`
          + (changed ? `<span class="rec-warn">⚠️ Letzte Buchung ${fmt(g.amount)} statt ${fmt(current.amount)}</span><button class="tx-add" data-act="update" data-i="${i}">Betrag übernehmen</button>` : '')
          + `<button class="tx-add" data-act="edit" data-i="${i}">Bearbeiten</button>`;
      } else {
        const tr = `<button class="tx-add" data-act="transfer" data-i="${i}">💶 Haushaltsgeld</button>`;
        const fx = `<button class="tx-add" data-act="fixed" data-i="${i}">＋ Fixkosten</button>`;
        const pv = `<button class="tx-add" data-act="private" data-i="${i}">🔒 Privates Abo</button>`;
        actions = (g.toPartner ? tr + fx : fx + pv + tr) + (g.toPartner ? pv : '') + `<button class="tx-add" data-act="dismiss" data-i="${i}">Ausblenden</button>`;
      }
      return `<li class="row tx rec"><span class="emoji">🔁</span>
        <span class="main"><div class="title">${esc(s ? s.name : g.name)}</div><div class="sub">${sub}</div><div class="actions">${actions}</div>${recDetails(g)}</span>
        <span class="tx-right"><span class="amount">${fmt(g.amount)}</span></span></li>`;
    }).join('');
  }

  function renderPrivSubs() {
    const key = monthKey(new Date().getFullYear(), new Date().getMonth());
    const list = state.subs.filter((s) => s.private && !isTransfer(s));
    const active = list.filter((s) => !s.end || s.end >= key);
    const monthly = active.reduce((a, s) => a + perMonth(s), 0);
    $('#privSubsTotal').textContent = list.length ? `≈ ${fmt(monthly)} / Monat` : '';
    const iv = INTERVALS;
    $('#privSubsList').innerHTML = list.length ? list.sort((a, b) => b.amount - a.amount).map((s) => {
      const c = state.categories.find((x) => x.id === s.category) || { emoji: '🔁' };
      const ended = s.end && s.end < key;
      return `<li class="row ${ended ? 'ended' : ''}" data-sub="${esc(s.id)}"><span class="emoji">${esc(c.emoji)}</span>
        <span class="main"><div class="title">${esc(s.name)}</div><div class="sub">${esc(iv[s.interval] || 'monatlich')}${s.via ? ' · über ' + esc(s.via) : ''}${s.end ? ' · bis ' + esc(s.end.split('-').reverse().join('/')) : ''}</div></span>
        <span class="amount">${fmt(s.amount)}</span></li>`;
    }).join('') : '<li class="empty-state">Noch keine privaten Abos. Tipp: unten bei „Regelmäßige Zahlungen“ auf <b>🔒 Privates Abo</b> tippen.</li>';
  }

  /** Aufklappbare Liste der einzelnen Buchungen einer erkannten Gruppe */
  function recDetails(g) {
    const items = [...g.list].sort((a, b) => b.date.localeCompare(a.date)).map((t) => {
      const d = t.date.split('-').reverse().join('.');
      return `<li><div class="rd-head"><span>${esc(d)}</span><b>${fmt(Math.abs(t.amount))}</b></div>`
        + (t.name ? `<div class="rd-name">${esc(t.name)}</div>` : '')
        + (t.purpose ? `<div class="rd-purpose">${esc(t.purpose)}</div>` : '') + '</li>';
    }).join('');
    return `<details class="rec-details"><summary>Einzelne Buchungen ansehen (${g.list.length})</summary><ul>${items}</ul></details>`;
  }

  function onRecurringClick(e) {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const g = lastGroups[+b.dataset.i];
    if (!g) return;
    const act = b.dataset.act;
    if (act === 'fixed' || act === 'transfer' || act === 'private') linkGroup(g, act);
    else if (act === 'dismiss') { data.dismissed[g.key] = true; write(); render(); toast('Ausgeblendet'); }
    else if (act === 'update') updateAmount(g);
    else if (act === 'edit') { const s = linkedSub(g.key); if (s) openSubDialog(s); }
  }

  /** Einzelne Buchung manuell als regelmäßig markieren */
  function markTx(txId) {
    const t = data.tx.find((x) => x.id === txId);
    if (!t) return;
    const key = groupKey(t);
    const g = detect('', true).find((x) => x.key === key);
    if (g) linkGroup(g, g.toPartner ? 'transfer' : 'fixed');
  }

  // ---------- Direkter Kontoabruf (Enable Banking über den eigenen Supabase-Baustein) ----------
  const BANK_KEY = 'ausgaben-bank-v1';
  const PENDING_KEY = 'ausgaben-bank-pending';
  let bankBusy = false;
  let bankList = null;

  function bankCfg() {
    try { return JSON.parse(localStorage.getItem(BANK_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveBankCfg(c) { try { localStorage.setItem(BANK_KEY, JSON.stringify(c)); } catch (e) { /* voll */ } }
  function syncCfg() { try { return JSON.parse(localStorage.getItem('ausgaben-sync-v1')) || {}; } catch (e) { return {}; } }
  function functionUrl() {
    const c = bankCfg();
    if (c.url) return c.url.replace(/\/+$/, '');
    if (document.querySelector('meta[name="sync-backend"]')?.content === 'self') return location.origin + '/api/bank';
    const s = syncCfg();
    return s.url ? s.url.replace(/\/+$/, '') + '/functions/v1/bank' : '';
  }
  function redirectUrl() { return location.origin + location.pathname.replace(/index\.html$/, ''); }
  const selfHosted = () => document.querySelector('meta[name="sync-backend"]')?.content === 'self' && !bankCfg().url;
  function bankReady() { return !!((bankCfg().token || selfHosted()) && functionUrl()); }
  function connections() { data.bank = data.bank || { connections: [] }; return data.bank.connections; }
  function randomToken(n = 32) {
    const b = crypto.getRandomValues(new Uint8Array(n));
    return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function call(action, payload = {}) {
    const url = functionUrl();
    const c = bankCfg();
    if (!url || !(c.token || selfHosted())) throw new Error('Bank-Zugang ist noch nicht eingerichtet (siehe „Einrichtung“).');
    const headers = { 'Content-Type': 'application/json' };
    if (c.token) headers['x-bank-token'] = c.token;
    const s = syncCfg();
    if (s.key) headers.apikey = s.key;
    let res;
    try { res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ action, ...payload }) }); }
    catch (e) { throw new Error('Keine Verbindung zum Bank-Baustein – Internet prüfen'); }
    let j = {};
    try { j = await res.json(); } catch (e) { /* leer */ }
    if (!res.ok) { const err = new Error(j.error || `Fehler ${res.status}`); err.status = res.status; err.code = j.code || ''; throw err; }
    return j;
  }

  async function openPicker() {
    if (!bankReady()) { $('#bankSetup').open = true; toast('Bitte zuerst die Einrichtung abschließen'); return; }
    $('#bankPicker').hidden = false;
    $('#bankList').innerHTML = '<li class="hint">Lade Bankenliste …</li>';
    try {
      if (!bankList) bankList = (await call('banks', { country: 'DE' })).banks || [];
      renderBankList();
      $('#bankSearch').focus();
    } catch (e) { $('#bankList').innerHTML = `<li class="hint warn">⚠️ ${esc(e.message)}</li>`; }
  }
  function renderBankList() {
    const q = $('#bankSearch').value.trim().toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    const hits = (bankList || []).filter((b) => words.every((w) => b.name.toLowerCase().includes(w))).slice(0, 30);
    $('#bankList').innerHTML = !q ? '<li class="hint">Namen eingeben, z. B. „Düsseldorf“ oder „Hilden“.</li>'
      : hits.length ? hits.map((b, i) => `<li class="row" data-i="${i}"><span class="emoji">🏦</span><span class="main"><div class="title">${esc(b.name)}</div></span></li>`).join('')
        : '<li class="hint">Keine Bank gefunden – anderen Teil des Namens versuchen.</li>';
    $$('#bankList .row').forEach((li) => li.addEventListener('click', () => startConnect(hits[+li.dataset.i])));
  }

  async function startConnect(bank) {
    if (!bank) return;
    const state = randomToken(24);
    try { localStorage.setItem(PENDING_KEY, JSON.stringify({ state, bank: bank.name, ts: Date.now() })); } catch (e) { /* egal */ }
    toast('Weiter zur Anmeldung bei ' + bank.name + ' …');
    try {
      let r;
      try { r = await call('start', { bank: bank.name, country: bank.country || 'DE', redirect_url: redirectUrl(), state, days: Math.min(180, bank.maxDays || 90) }); }
      catch (e) { if (/valid|gültig|consent/i.test(e.message)) r = await call('start', { bank: bank.name, country: bank.country || 'DE', redirect_url: redirectUrl(), state, days: 90 }); else throw e; }
      const local = location.hostname === 'localhost'; // nur für lokale Tests ohne https
      if (!r.url || !(/^https:\/\//.test(r.url) || (local && /^http:\/\/localhost[:/]/.test(r.url)))) throw new Error('Keine sichere Anmeldeadresse erhalten');
      location.href = r.url; // echte Anmeldeseite der Bank (über Enable Banking)
    } catch (e) { toast('⚠️ ' + e.message); }
  }

  /** Rückkehr von der Bank-Anmeldung (?code=…&state=…) */
  async function handleCallback() {
    const params = new URLSearchParams(location.search);
    if (!params.has('state') || (!params.has('code') && !params.has('error'))) return false;
    const code = params.get('code'), state = params.get('state'), error = params.get('error');
    history.replaceState(null, '', location.pathname + location.hash);
    let pending = null;
    try { pending = JSON.parse(localStorage.getItem(PENDING_KEY)); localStorage.removeItem(PENDING_KEY); } catch (e) { /* egal */ }
    if (typeof setMode === 'function') setMode('personal', true);
    if (typeof showView === 'function') showView('konto');
    if (error) { toast('Verbindung abgebrochen' + (params.get('error_description') ? ': ' + params.get('error_description') : '')); return true; }
    // Sicherheitsprüfung: Die Anmeldung muss auf DIESEM Gerät/Browser gestartet worden sein
    if (!pending || pending.state !== state || Date.now() - pending.ts > 30 * 60000) {
      toast('⚠️ Sicherheitsprüfung fehlgeschlagen – bitte die Verbindung in Safari erneut starten');
      return true;
    }
    try {
      toast('Verbinde mit ' + pending.bank + ' …');
      const s = await call('session', { code });
      const conn = { session_id: s.session_id, bank: s.bank || pending.bank, valid_until: s.valid_until, created: new Date().toISOString(), accounts: [] };
      for (const a of s.accounts || []) {
        let accId = 'eb-' + a.uid;
        if (a.iban) { // dieselbe IBAN schon verbunden (z. B. Zugriff erneuert)? → bisheriges Konto weiterführen
          for (const oc of connections()) {
            const i = oc.accounts.findIndex((x) => x.iban === a.iban);
            if (i > -1) { accId = oc.accounts[i].accId; oc.accounts.splice(i, 1); }
          }
          data.bank.connections = connections().filter((oc) => oc.accounts.length);
        }
        const short = a.iban ? ' ··' + a.iban.slice(-4) : '';
        if (!data.accounts.some((x) => x.id === accId)) data.accounts.push({ id: accId, name: `${conn.bank}${short}` });
        conn.accounts.push({ uid: a.uid, accId, name: a.name, iban: a.iban, currency: a.currency });
      }
      connections().push(conn);
      write();
      toast(`✓ ${conn.bank} verbunden – ${conn.accounts.length} Konto/Konten`);
      await refresh(true);
    } catch (e) { toast('⚠️ Verbindung fehlgeschlagen: ' + e.message); render(); }
    return true;
  }

  const BAL_ORDER = ['CLBD', 'ITBD', 'CLAV', 'ITAV', 'XPCD', 'OTHR'];
  async function refresh(force, quiet) {
    if (bankBusy || !connections().length) return;
    bankBusy = true;
    $('#bankStatus').textContent = 'Aktualisiere …';
    let added = 0, problems = 0;
    try {
      for (const conn of connections()) {
        if (conn.valid_until && new Date(conn.valid_until) < new Date()) { conn.expired = true; continue; }
        for (const a of conn.accounts) {
          try {
            const b = await call('balances', { account: a.uid });
            const list = (b.balances || []).slice().sort((x, y) => (BAL_ORDER.indexOf(x.type) + 99) % 99 - (BAL_ORDER.indexOf(y.type) + 99) % 99);
            if (list[0]) { a.balance = list[0].amount; a.balanceCurrency = list[0].currency; a.balanceDate = list[0].date; }
            const carry = {}; // „im Haushalt übernommen“-Markierungen behalten
            const ck = (t) => `${t.date}|${t.amount}|${t.name}|${t.purpose}`;
            if (!a.idv) { // ganz alte Kennungen konnten gleiche Buchungen zusammenlegen → einmal komplett neu holen
              const pre = `eb-${a.uid.slice(0, 8)}-`;
              data.tx.forEach((t) => { if (String(t.id).startsWith(pre) && t.linked) carry[ck(t)] = t.linked; });
              data.tx = data.tx.filter((t) => !String(t.id).startsWith(pre));
              delete a.lastDate;
            }
            // Direkt nach der Anmeldung bei der Bank (TAN) darf ein ganzes Jahr abgerufen werden, danach nur 90 Tage.
            const fresh = conn.created && Date.now() - new Date(conn.created).getTime() < 30 * 60e3;
            const fromMs = fresh ? Date.now() - 365 * 864e5
              : a.lastDate ? new Date(a.lastDate + 'T12:00').getTime() - 30 * 864e5 // 30 Tage Überlappung: spät gebuchte Umsätze nicht verpassen
                : Date.now() - 89 * 864e5;
            // Erst ALLE Seiten holen – nur wenn alles geklappt hat, wird übernommen (keine Lücken bei Abbruch)
            let pend = [];
            const fetchAll = async (fromIso) => {
              const rows = []; let next = null, pages = 0; pend = [];
              do {
                const r = await call('transactions', { account: a.uid, date_from: fromIso, continuation_key: next || undefined });
                for (const t of r.transactions || []) {
                  if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date) || !t.amount) continue;
                  if (t.status && t.status !== 'BOOK') { // vorgemerkt: nur anzeigen, wird erst nach Buchung übernommen
                    pend.push({ date: t.date, amount: t.amount, name: String(t.name || '').slice(0, 120), purpose: String(t.purpose || '').slice(0, 300) });
                    continue;
                  }
                  rows.push({ account: a.accId, date: t.date, amount: t.amount, name: String(t.name || '').slice(0, 120), purpose: String(t.purpose || '').slice(0, 300) });
                }
                next = r.next; pages++;
              } while (next && pages < 400);
              if (next) throw new Error('Zu viele Seiten – bitte erneut „Aktualisieren“');
              return rows;
            };
            let rows;
            try { rows = await fetchAll(new Date(fromMs).toISOString().slice(0, 10)); }
            catch (e) {
              if (!fresh || /expired|abgelaufen|revoked|EXPIRED|SESSION/i.test(e.message)) throw e;
              rows = await fetchAll(new Date(Date.now() - 89 * 864e5).toISOString().slice(0, 10)); // Bank erlaubt kein ganzes Jahr
              toast('ℹ️ Die Bank liefert nur die letzten 90 Tage');
            }
            // Abgleich über den Inhalt (Datum, Betrag, Name, Zweck) – zwei gleiche Buchungen am selben Tag bleiben beide erhalten
            a.pending = pend;
            const have = {};
            data.tx.forEach((t) => { if (t.account === a.accId) have[ck(t)] = (have[ck(t)] || 0) + 1; });
            const got = {};
            let newest = a.lastDate || '';
            for (const row of rows) {
              const k = ck(row);
              got[k] = (got[k] || 0) + 1;
              if (row.date > newest) newest = row.date;
              if (got[k] <= (have[k] || 0)) continue;
              row.id = `eb3-${a.accId.slice(3, 11)}-${hash(k)}-${got[k]}`;
              row.seq = (data.seq = (data.seq || 0) + 1); // Reihenfolge der Bank innerhalb eines Tages
              if (carry[k]) row.linked = carry[k];
              data.tx.push(row); added++;
            }
            if (newest) a.lastDate = newest;
            if (rows.length) { const oldest = rows.reduce((m, r) => (r.date < m ? r.date : m), rows[0].date); if (!a.since || oldest < a.since) a.since = oldest; }
            a.fetched = new Date().toISOString(); a.idv = 3; delete a.lastError; conn.expired = false; delete conn.expiredCode;
          } catch (e) {
            problems++;
            const what = `${e.code || ''} ${e.message}`;
            a.lastError = String(e.message || '').slice(0, 160); a.lastErrorAt = new Date().toISOString();
            // Nur eindeutige Meldungen der Bank bedeuten „abgelaufen“ – alles andere (z. B. Tageslimit) nicht
            if (/EXPIRED_SESSION|REVOKED_SESSION|CLOSED_SESSION|session (has )?(expired|been revoked|closed)|consent (has )?(expired|been revoked)/i.test(what)) { conn.expired = true; conn.expiredCode = e.code || 'EXPIRED'; }
            else if (/RATE_LIMIT|limit|exceed|too many|429/i.test(what)) { /* Tageslimit der Bank – später erneut */ }
            else if (!quiet) toast('⚠️ ' + e.message);
          }
        }
      }
      write();
      window.render();
      if (added || (!quiet && !problems)) toast(added ? `🏦 ${added} neue Umsätze abgerufen ✓` : '🏦 Kontostand aktuell ✓');
    } finally { bankBusy = false; render(); }
  }

  /** Beim Öffnen von „Mein Konto“: automatisch aktualisieren, wenn länger als 4 Stunden her */
  /** Erinnerung, damit keine Lücke entsteht: die Bank gibt ohne neue TAN nur die letzten 90 Tage heraus */
  function reminder() {
    const conns = connections();
    if (!conns.length) return null;
    const now = Date.now();
    for (const c of conns) {
      const until = c.valid_until ? new Date(c.valid_until).getTime() : 0;
      if ((c.expired && c.expiredCode) || (until && until < now)) return { level: 'warn', text: `Der Zugriff auf ${c.bank} ist abgelaufen. Bitte unter „Mein Konto“ neu verbinden (pushTAN) – sonst fehlen Buchungen.` };
      if (until && until - now < 14 * 864e5) return { level: 'info', text: `Der Zugriff auf ${c.bank} endet am ${new Date(until).toLocaleDateString('de-DE')}. Bitte vorher unter „Mein Konto“ neu verbinden (pushTAN).` };
      for (const a of c.accounts) {
        const days = a.fetched ? Math.floor((now - new Date(a.fetched).getTime()) / 864e5) : 999;
        if (days >= 75) return { level: 'warn', text: `Dein Konto wurde seit ${days} Tagen nicht abgerufen. Bitte jetzt „Mein Konto“ öffnen – ab 90 Tagen gehen Buchungen verloren.` };
        if (days >= 45) return { level: 'info', text: `Dein Konto wurde seit ${days} Tagen nicht abgerufen. Bitte bald „Mein Konto“ öffnen, damit keine Buchung fehlt.` };
      }
    }
    return null;
  }

  function autoRefresh() {
    if (!bankReady()) return;
    const last = Math.max(0, ...connections().flatMap((c) => c.accounts.map((a) => (a.fetched ? new Date(a.fetched).getTime() : 0))));
    if (connections().length && Date.now() - last > 6 * 3600e3) refresh(false, true);
  }

  async function disconnect(i) {
    const conn = connections()[i];
    if (!conn || !confirm(`Verbindung zu ${conn.bank} trennen?\n\nDer Zugriff wird bei der Bank beendet. Bereits abgerufene Umsätze bleiben auf diesem Gerät (löschbar unten über „Umsätze dieses Kontos löschen“).`)) return;
    try { await call('end', { session_id: conn.session_id }); } catch (e) { /* Zugriff ggf. schon abgelaufen */ }
    connections().splice(i, 1);
    write(); render(); toast('Verbindung getrennt');
  }

  function renderBank() {
    const cfg = bankCfg();
    if (document.activeElement !== $('#bankToken')) $('#bankToken').value = cfg.token || '';
    if (document.activeElement !== $('#bankUrl')) $('#bankUrl').value = cfg.url || functionUrl();
    $('#bankRedirect').value = redirectUrl();
    $('#bankSetup').hidden = selfHosted(); // bei eurer Netlify-App ist alles schon eingerichtet
    const conns = connections();
    $('#bankRefresh').hidden = !conns.length;
    $('#bankSetup').open = !bankReady() && !conns.length ? $('#bankSetup').open : $('#bankSetup').open;
    if (!bankBusy) {
      const lastFetch = Math.max(0, ...conns.flatMap((c) => c.accounts.map((a) => (a.fetched ? new Date(a.fetched).getTime() : 0))));
      $('#bankStatus').textContent = lastFetch ? 'Stand ' + new Date(lastFetch).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'nur lesend · nur auf diesem Gerät';
    }
    if (!conns.length) {
      $('#bankAccounts').innerHTML = `<p class="hint">${bankReady() ? 'Tippe auf <b>Konto verbinden</b> und wähle deine Bank. Du meldest dich auf der echten Seite deiner Bank an und bestätigst mit pushTAN.' : 'Noch nicht eingerichtet – siehe <b>Einrichtung</b> unten.'}</p>`;
      return;
    }
    $('#bankAccounts').innerHTML = conns.map((c, ci) => {
      const until = c.valid_until ? new Date(c.valid_until).toLocaleDateString('de-DE') : '';
      const days = c.valid_until ? Math.ceil((new Date(c.valid_until) - Date.now()) / 864e5) : 999;
      const warn = (c.expired && c.expiredCode) || days < 0 ? '<span class="rec-warn">⚠️ Zugriff abgelaufen – bitte neu verbinden (pushTAN)</span>'
        : days <= 14 ? `<span class="rec-warn">Zugriff endet in ${days} Tagen – dann einmal neu verbinden</span>` : '';
      return `<div class="bank-conn">
        <div class="bank-head"><b>${esc(c.bank)}</b><button class="tx-mini" data-disc="${ci}">Trennen</button></div>
        ${c.accounts.map((a) => `<div class="bank-acc">
          <div><div class="bank-name">${esc(a.name || 'Konto')}</div><div class="muted">${a.iban ? esc(a.iban.slice(0, 4) + ' •••• ' + a.iban.slice(-4)) : ''}${a.since ? ' · Umsätze seit ' + esc(a.since.split('-').reverse().join('.')) : ''}</div></div>
          <div class="bank-bal ${a.balance < 0 ? 'neg' : ''}">${a.balance !== undefined ? fmt(a.balance) : '–'}</div>
          ${a.lastError ? `<div class="muted bank-err">Letzter Abruf hat nicht geklappt: ${esc(a.lastError)}</div>` : ''}
        </div>`).join('')}
        <div class="muted">${until ? 'Zugriff gültig bis ' + esc(until) : ''}</div>${warn}
      </div>`;
    }).join('');
  }

  function bindBank() {
    $('#bankAdd').onclick = openPicker;
    $('#bankPickerClose').onclick = () => { $('#bankPicker').hidden = true; };
    $('#bankSearch').addEventListener('input', renderBankList);
    $('#bankRefresh').onclick = () => refresh(true);
    $('#bankAccounts').addEventListener('click', (e) => { const b = e.target.closest('[data-disc]'); if (b) disconnect(+b.dataset.disc); });
    $('#bankToken').addEventListener('change', (e) => { const c = bankCfg(); c.token = e.target.value.trim(); saveBankCfg(c); render(); });
    $('#bankUrl').addEventListener('change', (e) => { const c = bankCfg(); c.url = e.target.value.trim(); saveBankCfg(c); render(); });
    $('#bankTokenNew').onclick = async () => {
      if (bankCfg().token && !confirm('Neuen Schlüssel erzeugen? Der alte funktioniert dann nicht mehr – ihr müsst ihn bei Supabase ersetzen und den neuen auf dem anderen Gerät eintragen.')) return;
      const c = bankCfg(); c.token = randomToken(32); saveBankCfg(c); render();
      try { await navigator.clipboard.writeText(c.token); toast('Schlüssel erzeugt und kopiert ✓'); } catch (e) { toast('Schlüssel erzeugt – bitte mit „Kopieren“ übernehmen'); }
    };
    $('#bankTokenCopy').onclick = async () => {
      const t = bankCfg().token; if (!t) return;
      try { await navigator.clipboard.writeText(t); toast('Kopiert ✓'); } catch (e) { $('#bankToken').select(); toast('Bitte manuell kopieren'); }
    };
    $('#bankPem').addEventListener('change', async (e) => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      const text = (await f.text()).trim();
      if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(text)) { toast('⚠️ Das ist keine private Schlüsseldatei (.pem)'); return; }
      const ta = $('#bankPemText'); ta.value = text; ta.hidden = false; $('#bankPemCopy').hidden = false;
      try { await navigator.clipboard.writeText(text); toast('Schlüssel kopiert ✓ – jetzt bei Supabase einfügen'); } catch (err) { toast('Bitte auf „Schlüssel kopieren“ tippen'); }
    });
    $('#bankPemCopy').onclick = async () => {
      const ta = $('#bankPemText');
      try { await navigator.clipboard.writeText(ta.value); toast('Kopiert ✓'); } catch (e) { ta.select(); document.execCommand && document.execCommand('copy'); toast('Kopiert'); }
      setTimeout(() => { ta.value = ''; ta.hidden = true; $('#bankPemCopy').hidden = true; }, 1500); // nichts liegen lassen
    };
  }

  function setBankToken(t) { if (t && t.length >= 24) { const c = bankCfg(); c.token = t; saveBankCfg(c); } }

  // ---------- Anzeige ----------
  function selectedAccount() {
    let id = '';
    try { id = sessionStorage.getItem('konto-acc') || ''; } catch (e) { /* egal */ }
    return data.accounts.some((a) => a.id === id) ? id : '';
  }

  function bind() {
    if (bound) return; bound = true;
    bindBank();
    $('#kontoFile').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f); });
    $('#kontoHelpBtn').onclick = () => { const h = $('#kontoHelp'); h.hidden = !h.hidden; };
    $('#kontoAccount').addEventListener('change', (e) => { try { sessionStorage.setItem('konto-acc', e.target.value); } catch (x) { /* egal */ } render(); });
    $('#kontoSearch').addEventListener('input', () => { kontoLimit = 150; render(); });
    $('#kontoRange').addEventListener('click', (e) => { const x = e.target.closest('button[data-v]'); if (!x) return; kontoRange = x.dataset.v; kontoLimit = 150; render(); });
    $('#kontoMore').onclick = () => { kontoLimit += 300; render(); };
    $('#txForm').addEventListener('submit', saveTx);
    $('#txKind').addEventListener('change', syncTxSub);
    $('#txSplitBtn').onclick = startSplit;
    $('#txSplitOff').onclick = () => { txSplits = []; $('#txKindField').hidden = false; syncTxSub(); drawSplits(); };
    $('#txSplitAdd').onclick = () => { readSplits(); const rest = Math.round((Math.abs(txEditing.amount) - txSplits.reduce((s, p) => s + (p.amount || 0), 0)) * 100) / 100; txSplits.push({ amount: Math.max(0, rest), label: '', kind: 'personal', cat: '' }); drawSplits(); };
    $('#txSplitList').addEventListener('change', () => { readSplits(); drawSplits(); });
    $('#txSplitList').addEventListener('click', (e) => { const d = e.target.closest('.sp-del'); if (!d) return; readSplits(); txSplits.splice(+d.closest('li').dataset.i, 1); drawSplits(); });
    $('#txSub').addEventListener('change', () => { $('#txIvRow').hidden = $('#txSub').value !== '__new'; });
    $('#txCatSel').addEventListener('change', onTxCat);
    $('#txSubcatSel').addEventListener('change', onTxSubcat);
    $('#addPrivSubBtn').onclick = () => openSubDialog(null, { type: 'fixed', private: true, payer: state.settings.me, category: 'abos', interval: 'month' });
    $('#privSubsList').addEventListener('click', (e) => { const li = e.target.closest('[data-sub]'); if (li) openSubDialog(state.subs.find((x) => x.id === li.dataset.sub)); });
    $('#txCancel').onclick = () => { $('#txDialog').close(); txEditing = null; };
    $('#kontoDeleteBtn').onclick = () => {
      const id = selectedAccount(); const acc = data.accounts.find((a) => a.id === id);
      if (!acc || !confirm(`Alle importierten Umsätze von „${acc.name}“ auf diesem Gerät löschen? (Das Haushaltsbuch bleibt unverändert.)`)) return;
      data.tx = data.tx.filter((t) => t.account !== id);
      Object.keys(data.links).forEach((k) => { if (k.startsWith(id + '|')) delete data.links[k]; });
      if (data.bank) data.bank.connections.forEach((c) => { c.accounts = c.accounts.filter((a) => a.accId !== id); });
      if (data.bank) data.bank.connections = data.bank.connections.filter((c) => c.accounts.length);
      data.accounts = data.accounts.filter((a) => a.id !== id);
      write(); try { sessionStorage.removeItem('konto-acc'); } catch (e) { /* egal */ }
      render(); toast('Gelöscht');
    };
    $('#kontoList').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-add]');
      if (b) addToHousehold(b.dataset.add);
      if (!b && !e.target.closest('button[data-rec]')) { const o = e.target.closest('[data-open]'); if (o) openTx(o.dataset.open, false); }
      const r = e.target.closest('button[data-rec]');
      if (r) markTx(r.dataset.rec);
    });
    $('#kontoRecurring').addEventListener('click', onRecurringClick);
  }

  function render() {
    if (!document.getElementById('kontoList')) return;
    bind();
    const accId = selectedAccount();
    const sel = $('#kontoAccount');
    sel.innerHTML = '<option value="">Alle Konten</option>' + data.accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
    sel.value = accId;
    $('#kontoDeleteBtn').hidden = !accId;

    const key = monthKey(viewY, viewM);
    const monthOnly = kontoRange === 'month';
    $$('#kontoRange button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.v === kontoRange)));
    $('#kontoRangeMonth').textContent = 'Nur ' + new Date(viewY, viewM, 1).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
    const q = $('#kontoSearch').value.trim().toLowerCase();
    const qNum = q.replace(/[€\s]/g, '').replace('.', ',');
    const match = (t) => !q || `${t.name} ${t.purpose} ${t.label || ''}`.toLowerCase().includes(q) || (qNum && fmt(Math.abs(t.amount)).replace(/\s|€/g, '').includes(qNum));
    const inRange = (t) => (!accId || t.account === accId) && (!monthOnly || t.date.startsWith(key));
    const list = data.tx.filter(inRange).filter(match)
      .sort((x, y) => y.date.localeCompare(x.date) || (x.seq || 0) - (y.seq || 0));
    const pending = connections().flatMap((c) => c.accounts.flatMap((acc) => (acc.pending || []).map((t) => ({ ...t, account: acc.accId, pending: true }))))
      .filter(inRange).filter(match).sort((x, y) => y.date.localeCompare(x.date));

    $('#kontoKpis').hidden = !monthOnly;
    if (monthOnly) {
      const inc = list.filter((t) => t.amount > 0).reduce((s2, t) => s2 + t.amount, 0);
      const out = list.filter((t) => t.amount < 0).reduce((s2, t) => s2 + t.amount, 0);
      $('#kontoIn').textContent = fmt(inc);
      $('#kontoOut').textContent = fmt(Math.abs(out));
      const sEl = $('#kontoSaldo'); sEl.textContent = fmt(inc + out); sEl.className = 'kpi-value ' + (inc + out < 0 ? 'neg' : 'pos');
    }

    matchReceipts();
    renderBank();
    renderPrivSubs();
    renderRecurring(accId);
    const root = $('#kontoList');
    $('#kontoMore').hidden = true;
    if (!data.tx.length && !pending.length) { root.innerHTML = '<div class="empty-state">Noch keine Umsätze.<br>Oben auf <b>🔗 Konto verbinden</b> tippen.</div>'; return; }
    if (!list.length && !pending.length) { root.innerHTML = `<div class="empty-state">${q ? 'Keine passende Buchung.' : 'Keine Buchungen in diesem Monat.'}</div>`; return; }

    const expIds = new Set(state.expenses.map((e) => e.id));
    const accName = (id) => (data.accounts.find((x) => x.id === id) || {}).name || '';
    const multi = !accId && data.accounts.length > 1;
    const row = (t) => {
      // Wie in der Banking-App: Empfänger/Auftraggeber, Verwendungszweck, Betrag – unverändert
      const tags = [];
      if (!t.pending) {
        const own = t.cat !== undefined, cid = own ? t.cat : learnedCat(t);
        const cat = cid ? state.categories.find((c) => c.id === cid) : null;
        const sc = own ? t.subcat : learnedSubcat(t, cid);
        if (cat) tags.push(`${esc(cat.emoji)} ${esc(cat.name)}${sc ? ' › ' + esc(sc) : ''}${own ? '' : ' <span class="sp-auto">(automatisch)</span>'}`);
        if (t.label) tags.push(`„${esc(t.label)}“`);
        if (t.amount < 0) {
          const gk = groupKey(t);
          const sb = (gk && linkedSub(gk)) || (t.sub && state.subs.find((x) => x.id === t.sub)) || null;
          if (t.splits) tags.push('✂️ ' + t.splits.map((p) => `${fmt(p.amount)} ${p.kind === 'cash' ? '💵 Bargeld' : p.kind === 'shared' ? '👫 ' + esc(p.label) : '🔒 ' + esc(p.label || 'privat')}`).join(' · '));
          else if (sb) tags.push(sb.type === 'transfer' ? '💶 Haushaltsgeld' : `${sb.private ? '🔒' : '👫'} ${esc(sb.name)}`);
          else if (t.linked && expIds.has(t.linked)) {
            const le = state.expenses.find((e) => e.id === t.linked);
            tags.push(le.receipt ? `🧾 Bon ${esc(le.merchant)}${le.private ? '' : ' · 👫 gemeinsam'}` : le.source === 'bank' ? '👫 im Haushalt' : `📲 ${esc(le.merchant)}${le.private ? '' : ' · 👫 gemeinsam'}`);
          }
        }
      }
      return `<li class="sp-row ${t.pending ? 'sp-pending' : ''}" ${t.pending ? '' : `data-open="${esc(t.id)}"`}>
        <div class="sp-line"><span class="sp-name">${esc(t.name || t.purpose || 'Buchung')}</span>
          <span class="sp-amt ${t.amount > 0 ? 'in' : 'out'}">${t.amount > 0 ? '+' : ''}${fmt(t.amount)}</span></div>
        ${t.purpose && t.name ? `<div class="sp-purpose">${esc(t.purpose)}</div>` : ''}
        ${t.pending ? '<div class="sp-tags">vorgemerkt</div>' : ''}
        ${multi ? `<div class="sp-acc">${esc(accName(t.account))}</div>` : ''}
        ${tags.length ? `<div class="sp-tags">${tags.join(' · ')}</div>` : ''}</li>`;
    };
    const day = (d) => new Date(d + 'T12:00').toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
    let html = '';
    if (pending.length) html += `<div class="sp-day">Vorgemerkte Umsätze</div><ul class="sp-list">${pending.map(row).join('')}</ul>`;
    const shown = list.slice(0, kontoLimit);
    let cur = '';
    shown.forEach((t, i) => {
      if (t.date !== cur) { html += (cur ? '</ul>' : '') + `<div class="sp-day">${esc(day(t.date))}</div><ul class="sp-list">`; cur = t.date; }
      html += row(t);
      if (i === shown.length - 1) html += '</ul>';
    });
    root.innerHTML = html;
    $('#kontoMore').hidden = list.length <= kontoLimit;
    $('#kontoMore').textContent = `Weitere Umsätze anzeigen (${list.length - shown.length})`;
  }
  let kontoRange = 'all', kontoLimit = 150;

  /** Summen eines Monats über alle Konten (für die persönliche Übersicht) */
  function monthSummary(y, m) {
    const key = monthKey(y, m);
    const list = data.tx.filter((t) => t.date.startsWith(key));
    return {
      count: list.length,
      in: Math.round(list.filter((t) => t.amount > 0).reduce((a, t) => a + t.amount, 0) * 100) / 100,
      out: Math.round(list.filter((t) => t.amount < 0).reduce((a, t) => a - t.amount, 0) * 100) / 100,
    };
  }

  /** Kontobuchung zu einer Haushaltsausgabe (falls auf diesem Gerät vorhanden) */
  function txForExpense(expId) { return data.tx.find((t) => t.linked === expId || (t.splitExp || []).includes(expId)) || null; }

  return { txForExpense, openTx, cashForMonth, matchReceipts, reminder, render, parseStatement, detect, monthSummary, handleCallback, autoRefresh, refresh, setBankToken, bankToken: () => bankCfg().token || '', _data: () => data };
})();
