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
      if (d && Array.isArray(d.accounts) && Array.isArray(d.tx)) return d;
    } catch (e) { /* leer */ }
    return { accounts: [], tx: [] };
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

  function addToHousehold(txId) {
    const t = data.tx.find((x) => x.id === txId);
    if (!t || t.amount >= 0) return;
    const merchant = (t.name || t.purpose || 'Kontobuchung').slice(0, 60);
    const exp = {
      id: uid(), created: new Date().toISOString(), source: 'bank', amount: Math.abs(t.amount), merchant,
      category: guessCategory(merchant + ' ' + t.purpose), date: t.date, person: state.settings.me, note: '', private: false,
    };
    state.expenses.push(exp);
    t.linked = exp.id;
    write(); save(); window.render();
    toast(`${fmt(exp.amount)} ins Haushaltsbuch übernommen ✓`);
  }

  // ---------- Anzeige ----------
  function selectedAccount() {
    let id = '';
    try { id = sessionStorage.getItem('konto-acc') || ''; } catch (e) { /* egal */ }
    return data.accounts.some((a) => a.id === id) ? id : '';
  }

  function bind() {
    if (bound) return; bound = true;
    $('#kontoFile').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f); });
    $('#kontoHelpBtn').onclick = () => { const h = $('#kontoHelp'); h.hidden = !h.hidden; };
    $('#kontoAccount').addEventListener('change', (e) => { try { sessionStorage.setItem('konto-acc', e.target.value); } catch (x) { /* egal */ } render(); });
    $('#kontoSearch').addEventListener('input', render);
    $('#kontoDeleteBtn').onclick = () => {
      const id = selectedAccount(); const acc = data.accounts.find((a) => a.id === id);
      if (!acc || !confirm(`Alle importierten Umsätze von „${acc.name}“ auf diesem Gerät löschen? (Das Haushaltsbuch bleibt unverändert.)`)) return;
      data.tx = data.tx.filter((t) => t.account !== id);
      data.accounts = data.accounts.filter((a) => a.id !== id);
      write(); try { sessionStorage.removeItem('konto-acc'); } catch (e) { /* egal */ }
      render(); toast('Gelöscht');
    };
    $('#kontoList').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-add]');
      if (b) addToHousehold(b.dataset.add);
    });
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
    const q = $('#kontoSearch').value.trim().toLowerCase();
    const list = data.tx
      .filter((t) => (!accId || t.account === accId) && t.date.startsWith(key))
      .filter((t) => !q || `${t.name} ${t.purpose}`.toLowerCase().includes(q))
      .sort((a, b) => b.date.localeCompare(a.date));

    const inc = list.filter((t) => t.amount > 0).reduce((a, t) => a + t.amount, 0);
    const out = list.filter((t) => t.amount < 0).reduce((a, t) => a + t.amount, 0);
    $('#kontoIn').textContent = fmt(inc);
    $('#kontoOut').textContent = fmt(Math.abs(out));
    const s = $('#kontoSaldo'); s.textContent = fmt(inc + out); s.className = 'kpi-value ' + (inc + out < 0 ? 'neg' : 'pos');

    const root = $('#kontoList');
    if (!data.tx.length) { root.innerHTML = '<div class="empty-state">Noch keine Umsätze importiert.<br>Tippe auf <b>Umsätze importieren (CSV)</b>.</div>'; return; }
    if (!list.length) { root.innerHTML = '<div class="empty-state">Keine Buchungen in diesem Monat.<br>Mit ‹ › oben den Monat wechseln.</div>'; return; }

    const expIds = new Set(state.expenses.map((e) => e.id));
    const accName = (id) => (data.accounts.find((a) => a.id === id) || {}).name || '';
    const groups = new Map();
    list.forEach((t) => { if (!groups.has(t.date)) groups.set(t.date, []); groups.get(t.date).push(t); });
    let html = '';
    for (const [d, items] of groups) {
      const label = new Date(d + 'T12:00').toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
      const sum = items.reduce((a, t) => a + t.amount, 0);
      html += `<div class="day-group"><div class="day-head"><span>${esc(label)}</span><span>${fmt(sum)}</span></div><ul class="rows">`;
      html += items.map((t) => {
        const sub = [t.name ? t.purpose : '', !accId && data.accounts.length > 1 ? accName(t.account) : ''].filter(Boolean).map(esc).join(' · ');
        let action = '';
        if (t.amount < 0) {
          if (t.linked && expIds.has(t.linked)) action = '<span class="tx-add done">✓ im Haushalt</span>';
          else action = `<button class="tx-add" data-add="${esc(t.id)}">＋ Haushalt</button>` + (maybeCaptured(t) ? '<span class="muted" style="font-size:.7rem">evtl. schon erfasst</span>' : '');
        }
        return `<li class="row tx"><span class="emoji">${t.amount > 0 ? '⬇️' : '⬆️'}</span>
          <span class="main"><div class="title">${esc(t.name || t.purpose || 'Buchung')}</div><div class="sub">${sub}</div></span>
          <span class="tx-right"><span class="amount ${t.amount > 0 ? 'in' : ''}">${t.amount > 0 ? '+' : ''}${fmt(t.amount)}</span>${action}</span></li>`;
      }).join('');
      html += '</ul></div>';
    }
    root.innerHTML = html;
  }

  return { render, parseStatement, _data: () => data };
})();
