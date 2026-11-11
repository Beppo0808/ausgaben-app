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
    return String(s || '').toLowerCase().replace(/[0-9]/g, ' ').replace(/[^a-zäöüß&+ ]/g, ' ')
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
  function groupInfo(t) {
    const agg = aggregatorOf(t);
    if (agg) {
      const inner = innerMerchant(t);
      if (inner) return { key: `${t.account}|${agg}|${baseName(inner) || inner.toLowerCase()}`, agg, inner };
      return { key: `${t.account}|${agg}|${Math.abs(t.amount).toFixed(2)}`, agg, inner: '' };
    }
    const b = baseName(t.name) || baseName(t.purpose);
    return b ? { key: `${t.account}|${b}`, agg: '', inner: '' } : null;
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
      list.sort((a, b) => a.date.localeCompare(b.date));
      const latest = list[list.length - 1];
      const months = [...new Set(list.map((t) => t.date.slice(0, 7)))];
      const amts = list.map((t) => Math.abs(t.amount));
      const max = Math.max(...amts), min = Math.min(...amts);
      const stable = (max - min) / max <= 0.15;
      const text = `${latest.name} ${latest.purpose}`;
      const gi = groupInfo(latest);
      const hint = HINTS.find(([re]) => re.test(gi.agg ? gi.inner : text));
      const others = state.settings.persons.filter((p) => p !== state.settings.me);
      const toPartner = others.find((p) => p.length >= 3 && new RegExp('\\b' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(text));
      const linked = !!data.links[key];
      const recurring = (months.length >= 2 && stable) || (hint && Math.abs(latest.amount) >= 2) || toPartner;
      if (!recurring && !linked && !includeAll) continue;
      if (data.dismissed[key] && !linked && !includeAll) continue;
      let interval = /jahres|jährlich|jaehrlich|p\.a\./i.test(text) ? 'year' : /quartal|vierteljähr|vierteljaehr/i.test(text) ? 'quarter' : 'month';
      if (months.length >= 2) {
        const idx = months.map(monthIdx);
        const gaps = idx.slice(1).map((v, i) => v - idx[i]).sort((a, b) => a - b);
        const g = gaps[Math.floor(gaps.length / 2)];
        interval = g <= 1.5 ? 'month' : g <= 4.5 ? 'quarter' : 'year';
      }
      out.push({
        key, list, latest, months, interval, toPartner,
        amount: Math.abs(latest.amount),
        name: gi.agg ? (gi.inner || `${gi.agg}-Abo ${fmt(Math.abs(latest.amount))}`) : hint ? hint[1] : (latest.name || latest.purpose || '').slice(0, 40),
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
    openSubDialog(null, presetFor(g, type), (subId) => {
      data.links[g.key] = subId; write(); window.render();
      toast(type === 'transfer' ? '💶 Haushaltsgeld eingetragen ✓' : '🏠 Als gemeinsame Fixkosten übernommen ✓');
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
    const rhythm = { month: 'monatlich', quarter: 'vierteljährlich', year: 'jährlich' };
    $('#kontoRecurring').innerHTML = lastGroups.map((g, i) => {
      const s = linkedSub(g.key);
      const day = +g.latest.date.slice(8, 10);
      const sub = [esc(g.counterparty), `${rhythm[g.interval]}, ca. am ${day}.`, `${g.list.length}× gefunden`].join(' · ');
      let actions;
      if (s) {
        const what = s.type === 'transfer' ? `✓ Haushaltsgeld an ${esc(s.to)}` : `✓ Gemeinsame Fixkosten „${esc(s.name)}“`;
        const current = state.subs.find((x) => x.id === s.id);
        const changed = current && Math.abs(current.amount - g.amount) > 0.009 && !current.end;
        actions = `<span class="rec-linked">${what}</span>`
          + (changed ? `<span class="rec-warn">⚠️ Letzte Buchung ${fmt(g.amount)} statt ${fmt(current.amount)}</span><button class="tx-add" data-act="update" data-i="${i}">Betrag übernehmen</button>` : '')
          + `<button class="tx-add" data-act="edit" data-i="${i}">Bearbeiten</button>`;
      } else {
        const tr = `<button class="tx-add" data-act="transfer" data-i="${i}">💶 Haushaltsgeld</button>`;
        const fx = `<button class="tx-add" data-act="fixed" data-i="${i}">＋ Fixkosten</button>`;
        actions = (g.toPartner ? tr + fx : fx + tr) + `<button class="tx-add" data-act="dismiss" data-i="${i}">Privat / ausblenden</button>`;
      }
      return `<li class="row tx rec"><span class="emoji">🔁</span>
        <span class="main"><div class="title">${esc(s ? s.name : g.name)}</div><div class="sub">${sub}</div><div class="actions">${actions}</div>${recDetails(g)}</span>
        <span class="tx-right"><span class="amount">${fmt(g.amount)}</span></span></li>`;
    }).join('');
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
    if (act === 'fixed' || act === 'transfer') linkGroup(g, act);
    else if (act === 'dismiss') { data.dismissed[g.key] = true; write(); render(); toast('Ausgeblendet – bleibt privat'); }
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
    if (!res.ok) { const err = new Error(j.error || `Fehler ${res.status}`); err.status = res.status; throw err; }
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
        const accId = 'eb-' + a.uid;
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
  async function refresh(force) {
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
            const from = new Date(a.lastDate ? new Date(a.lastDate + 'T12:00').getTime() - 10 * 864e5 : Date.now() - 89 * 864e5);
            let next = null, pages = 0;
            const existing = new Set(data.tx.map((t) => t.id));
            const seen = {};
            do {
              const r = await call('transactions', { account: a.uid, date_from: from.toISOString().slice(0, 10), continuation_key: next || undefined });
              for (const t of r.transactions || []) {
                if (t.status && t.status !== 'BOOK') continue; // nur gebuchte Umsätze (vorgemerkte ändern sich noch)
                if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date) || !t.amount) continue;
                const base = t.id || hash(`${t.date}|${t.amount}|${t.name}|${t.purpose}`);
                seen[base] = (seen[base] || 0) + 1;
                const id = `eb-${a.uid.slice(0, 8)}-${base}${t.id ? '' : '-' + seen[base]}`;
                if (existing.has(id)) continue;
                data.tx.push({ id, account: a.accId, date: t.date, amount: t.amount, name: String(t.name || '').slice(0, 120), purpose: String(t.purpose || '').slice(0, 300) });
                existing.add(id); added++;
                if (!a.lastDate || t.date > a.lastDate) a.lastDate = t.date;
              }
              next = r.next; pages++;
            } while (next && pages < 25);
            a.fetched = new Date().toISOString();
          } catch (e) {
            problems++;
            if (/expired|abgelaufen|consent|revoked|EXPIRED|SESSION/i.test(e.message)) conn.expired = true;
            else toast('⚠️ ' + e.message);
          }
        }
      }
      write();
      window.render();
      if (!problems || added) toast(added ? `🏦 ${added} neue Umsätze abgerufen ✓` : '🏦 Kontostand aktuell ✓');
    } finally { bankBusy = false; render(); }
  }

  /** Beim Öffnen von „Mein Konto“: automatisch aktualisieren, wenn länger als 4 Stunden her */
  function autoRefresh() {
    if (!bankReady()) return;
    const last = Math.max(0, ...connections().flatMap((c) => c.accounts.map((a) => (a.fetched ? new Date(a.fetched).getTime() : 0))));
    if (connections().length && Date.now() - last > 4 * 3600e3) refresh();
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
      const warn = c.expired || days < 0 ? '<span class="rec-warn">⚠️ Zugriff abgelaufen – bitte neu verbinden (pushTAN)</span>'
        : days <= 14 ? `<span class="rec-warn">Zugriff endet in ${days} Tagen – dann einmal neu verbinden</span>` : '';
      return `<div class="bank-conn">
        <div class="bank-head"><b>${esc(c.bank)}</b><button class="tx-mini" data-disc="${ci}">Trennen</button></div>
        ${c.accounts.map((a) => `<div class="bank-acc">
          <div><div class="bank-name">${esc(a.name || 'Konto')}</div><div class="muted">${a.iban ? esc(a.iban.slice(0, 4) + ' •••• ' + a.iban.slice(-4)) : ''}</div></div>
          <div class="bank-bal ${a.balance < 0 ? 'neg' : ''}">${a.balance !== undefined ? fmt(a.balance) : '–'}</div>
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
    $('#kontoSearch').addEventListener('input', render);
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

    renderBank();
    renderRecurring(accId);
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
          const gk = groupKey(t);
          const ls = gk ? linkedSub(gk) : null;
          if (ls) action = `<span class="tx-tag">${ls.type === 'transfer' ? '💶 Haushaltsgeld' : '🔁 ' + esc(ls.name)}</span>`;
          else if (t.linked && expIds.has(t.linked)) action = '<span class="tx-add done">✓ im Haushalt</span>';
          else action = `<button class="tx-add" data-add="${esc(t.id)}">＋ Haushalt</button>`
            + (maybeCaptured(t) ? '<span class="muted" style="font-size:.7rem">evtl. schon erfasst</span>' : '')
            + `<button class="tx-mini" data-rec="${esc(t.id)}">🔁 regelmäßig</button>`;
        }
        return `<li class="row tx"><span class="emoji">${t.amount > 0 ? '⬇️' : '⬆️'}</span>
          <span class="main"><div class="title">${esc(t.name || t.purpose || 'Buchung')}</div><div class="sub">${sub}</div></span>
          <span class="tx-right"><span class="amount ${t.amount > 0 ? 'in' : ''}">${t.amount > 0 ? '+' : ''}${fmt(t.amount)}</span>${action}</span></li>`;
      }).join('');
      html += '</ul></div>';
    }
    root.innerHTML = html;
  }

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

  return { render, parseStatement, detect, monthSummary, handleCallback, autoRefresh, refresh, setBankToken, bankToken: () => bankCfg().token || '', _data: () => data };
})();
