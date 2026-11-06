/* Ausgaben-App – Haushaltsbuch mit automatischer Erfassung bei Handy-Zahlung.
 * Alle Daten liegen lokal im Browser (localStorage). Kein Server, kein Tracking.
 */
'use strict';

const STORAGE_KEY = 'ausgaben-app-v1';

const DEFAULT_CATEGORIES = [
  { id: 'lebensmittel', name: 'Lebensmittel', emoji: '🛒', budget: 500 },
  { id: 'restaurant', name: 'Restaurant & Café', emoji: '🍽️', budget: 150 },
  { id: 'mobilitaet', name: 'Mobilität & Tanken', emoji: '🚗', budget: 200 },
  { id: 'wohnen', name: 'Wohnen & Energie', emoji: '🏠', budget: 0 },
  { id: 'drogerie', name: 'Drogerie & Gesundheit', emoji: '💊', budget: 80 },
  { id: 'shopping', name: 'Shopping', emoji: '🛍️', budget: 150 },
  { id: 'freizeit', name: 'Freizeit', emoji: '🎉', budget: 100 },
  { id: 'abos', name: 'Abos & Verträge', emoji: '🔁', budget: 0 },
  { id: 'sonstiges', name: 'Sonstiges', emoji: '📦', budget: 0 },
];

// Händler-Stichwörter → Kategorie (wird durch eigene Korrekturen ergänzt)
const KEYWORD_RULES = [
  [/rewe|edeka|aldi|lidl|netto|penny|kaufland|norma|globus|tegut|real\b|bäcker|baecker|backhaus|metzger|denns|alnatura|bio ?company|marktkauf|hit markt|famila|combi|nahkauf/i, 'lebensmittel'],
  [/mc ?donald|burger|starbucks|caf[eé]|coffee|kaffee|restaurant|pizza|döner|doener|kebab|sushi|subway|kfc|vapiano|lieferando|wolt|uber ?eats|bistro|bar\b|imbiss|eis/i, 'restaurant'],
  [/aral|shell|esso|jet\b|total|tankstelle|agip|omv|avia|star tankstelle|bft|deutsche bahn|\bdb\b|bahn|bvg|mvg|hvv|vrr|kvb|rmv|flixbus|uber|bolt|free ?now|sixt|parken|parkhaus|apcoa|ladestation|ionity|e\.on drive|enbw/i, 'mobilitaet'],
  [/\bdm\b|dm-drogerie|rossmann|müller|mueller|apotheke|pharmacy|budni|arzt|optik|fielmann/i, 'drogerie'],
  [/amazon|zalando|h&m|h ?& ?m|zara|primark|ikea|media ?markt|saturn|otto|about you|decathlon|tk ?maxx|c&a|deichmann|thalia|douglas|obi|hornbach|bauhaus|toom|action|tedi|kik/i, 'shopping'],
  [/netflix|spotify|disney|apple\.com|icloud|google|youtube|dazn|sky|audible|prime video|telekom|vodafone|o2|1&1|congstar/i, 'abos'],
  [/kino|cinema|cinemaxx|uci|theater|museum|eventim|ticket|fitness|mcfit|urban sports|schwimmbad|zoo|steam|playstation|nintendo|xbox/i, 'freizeit'],
  [/stadtwerke|strom|gas|miete|vattenfall|eon\b|e\.on|rundfunk|gez/i, 'wohnen'],
];

// ---------- State ----------
function defaultState() {
  return {
    version: 1,
    settings: { income: 0, budget: 2000, persons: ['Ich', 'Partner'], me: 'Ich' }, // income = privat, wird nie synchronisiert
    categories: structuredClone(DEFAULT_CATEGORIES),
    expenses: [],
    subs: [],
    rules: {}, // händler (klein) → kategorie-id
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const s = JSON.parse(raw);
    const d = defaultState();
    return {
      ...d, ...s,
      settings: { ...d.settings, ...(s.settings || {}) },
      categories: Array.isArray(s.categories) && s.categories.length ? s.categories : d.categories,
      expenses: Array.isArray(s.expenses) ? s.expenses : [],
      subs: Array.isArray(s.subs) ? s.subs : [],
      rules: s.rules && typeof s.rules === 'object' ? s.rules : {},
    };
  } catch (e) {
    console.warn('Konnte Daten nicht laden', e);
    return defaultState();
  }
}

let state = load();
function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch (e) { toast('⚠️ Speichern fehlgeschlagen – Speicher voll oder privat?'); }
  if (typeof Sync !== 'undefined') Sync.onSave();
}

// ---------- Helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const eur0 = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const fmt = (n) => eur.format(n || 0);
const fmt0 = (n) => eur0.format(n || 0);
const round2 = (n) => Math.round(n * 100) / 100;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Robust: "12,50 €", "€12.50", "1.234,56", "-3,20" → Zahl */
function parseAmount(input) {
  let s = String(input ?? '').trim().replace(/[^\d,.\-]/g, '');
  if (!s) return NaN;
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma > -1) {
    s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(/,/g, '.');
  } else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '');
  }
  const n = Math.abs(parseFloat(s));
  return Number.isFinite(n) ? round2(n) : NaN;
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const monthKey = (y, m) => `${y}-${String(m + 1).padStart(2, '0')}`;
const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();

// Personen: feste Farbe je Position in der Personenliste (Name steht immer dabei)
function personIndex(name) { return state.settings.persons.indexOf(name); }
function personAvatar(name, size = '') {
  if (!name) return '';
  const i = personIndex(name);
  const cls = i > -1 ? 'p' + (i % 4) : 'px';
  return `<span class="avatar ${cls} ${size}" aria-hidden="true">${esc(name.trim().charAt(0).toUpperCase())}</span>`;
}
function personTag(name) {
  return name ? `<span class="who">${personAvatar(name, 'sm')}${esc(name)}</span>` : '';
}
function timeOf(e) {
  if (e.time) return e.time + ' Uhr';
  if (e.virtual || !e.created || (e.source !== 'wallet' && e.source !== 'manual')) return '';
  const d = new Date(e.created);
  // nur anzeigen, wenn am selben Tag erfasst (sonst wurde später nachgetragen)
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return iso === e.date ? d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr' : '';
}

function catById(id) {
  return state.categories.find((c) => c.id === id) || state.categories.find((c) => c.id === 'sonstiges') || state.categories[0];
}

function guessCategory(merchant) {
  const key = String(merchant || '').trim().toLowerCase();
  if (!key) return 'sonstiges';
  if (state.rules[key] && state.categories.some((c) => c.id === state.rules[key])) return state.rules[key];
  for (const [re, cat] of KEYWORD_RULES) {
    if (re.test(key) && state.categories.some((c) => c.id === cat)) return cat;
  }
  return state.categories.some((c) => c.id === 'sonstiges') ? 'sonstiges' : state.categories[0].id;
}

function learnRule(merchant, catId) {
  const key = String(merchant || '').trim().toLowerCase();
  if (key) state.rules[key] = catId;
}

// ---------- Month selection ----------
const now = new Date();
let viewY = now.getFullYear();
let viewM = now.getMonth();

function shiftMonth(delta) {
  const d = new Date(viewY, viewM + delta, 1);
  viewY = d.getFullYear(); viewM = d.getMonth();
  render();
}

const INTERVALS = { month: 'monatlich', quarter: 'vierteljährlich', year: 'jährlich' };
/** Fällt ein wiederkehrender Eintrag (Fixkosten oder Haushaltsgeld) im Monat key (JJJJ-MM) an? */
function subActive(s, key) {
  if (!s.start || s.start > key) return false;
  if (s.end && s.end < key) return false;
  const diff = (+key.slice(0, 4) - +s.start.slice(0, 4)) * 12 + (+key.slice(5, 7) - +s.start.slice(5, 7));
  if (s.interval === 'year') return diff % 12 === 0;
  if (s.interval === 'quarter') return diff % 3 === 0;
  return true;
}
function perMonth(s) { return s.interval === 'year' ? s.amount / 12 : s.interval === 'quarter' ? s.amount / 3 : s.amount; }
const isTransfer = (s) => s.type === 'transfer';
/** Nächster Monat (JJJJ-MM), in dem ein Eintrag fällig ist – ab dem aktuellen Monat */
function nextDue(s) {
  const d = new Date(now.getFullYear(), now.getMonth(), 1);
  for (let i = 0; i < 24; i++) {
    const k = monthKey(d.getFullYear(), d.getMonth());
    if (subActive(s, k)) return k;
    d.setMonth(d.getMonth() + 1);
  }
  return '';
}
const fmtYM = (ym) => (ym ? new Date(+ym.slice(0, 4), +ym.slice(5, 7) - 1, 1).toLocaleDateString('de-DE', { month: 'short', year: 'numeric' }) : '');

/** Haushaltsgeld-Überweisungen zwischen euch in einem Monat (zählen NICHT als Ausgabe) */
function transfersForMonth(y, m) {
  const key = monthKey(y, m);
  return state.subs.filter((s) => isTransfer(s) && subActive(s, key));
}

/** Abos/Fixkosten, die in einem Monat anfallen, als „virtuelle“ Ausgaben */
function subsForMonth(y, m) {
  const key = monthKey(y, m);
  const spreadActive = (s) => s.spread && s.interval !== 'month' && s.start && s.start <= key && (!s.end || s.end >= key);
  return state.subs
    .filter((s) => !isTransfer(s) && (spreadActive(s) || (!s.spread && subActive(s, key))))
    .map((s) => spreadActive(s) ? ({
      id: 'sub-' + s.id, subId: s.id, virtual: true, date: `${key}-01`, amount: round2(perMonth(s)),
      merchant: s.name, category: s.category, person: s.payer || '', note: `umgelegt (${fmt(s.amount)} ${INTERVALS[s.interval]})`,
    }) : ({
      id: 'sub-' + s.id, subId: s.id, virtual: true, date: `${key}-01`, amount: s.amount,
      merchant: s.name, category: s.category, person: s.payer || '', note: INTERVALS[s.interval] || 'monatlich',
    }));
}

function expensesForMonth(y, m, withSubs = true) {
  const key = monthKey(y, m);
  const list = state.expenses.filter((e) => e.date && e.date.startsWith(key));
  return withSubs ? list.concat(subsForMonth(y, m)) : list;
}

// ---------- Rendering ----------
function render() {
  $('#monthLabel').textContent = new Date(viewY, viewM, 1).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
  renderOverview();
  renderList();
  renderSubs();
  renderSettings();
  if (typeof Konto !== 'undefined') Konto.render();
}

// ---------- Namen ----------
const DEFAULT_NAMES = ['Ich', 'Partner', ''];
/** Person umbenennen – auch in allen bisherigen Einträgen */
function renamePerson(oldN, newN) {
  newN = String(newN || '').replace(/[,<>]/g, '').trim().slice(0, 30);
  if (!newN || newN === oldN) return false;
  const ps = state.settings.persons;
  if (ps.includes(newN)) { toast('Diesen Namen gibt es schon'); return false; }
  const i = ps.indexOf(oldN);
  if (i > -1) ps[i] = newN; else ps.push(newN);
  state.expenses.forEach((e) => { if (e.person === oldN) e.person = newN; });
  state.subs.forEach((s) => { if (s.payer === oldN) s.payer = newN; if (s.to === oldN) s.to = newN; });
  if (state.settings.me === oldN || !state.settings.me) state.settings.me = state.settings.me === oldN ? newN : state.settings.me;
  return true;
}
function setMyName(name) {
  const me = state.settings.me;
  const n = String(name || '').trim();
  if (!n) return;
  if (!state.settings.persons.includes(me)) { state.settings.persons.unshift(n.slice(0, 30)); state.settings.me = n.slice(0, 30); save(); render(); return; }
  if (renamePerson(me, n)) { state.settings.me = n.replace(/[,<>]/g, '').trim().slice(0, 30); save(); render(); Lock.refreshName(); toast(`👤 Hallo ${state.settings.me}!`); }
}
function setPartnerName(name) {
  const me = state.settings.me;
  const other = state.settings.persons.find((p) => p !== me);
  const n = String(name || '').replace(/[,<>]/g, '').trim().slice(0, 30);
  if (!n) return;
  if (other) { if (renamePerson(other, n)) { save(); render(); } }
  else if (!state.settings.persons.includes(n)) { state.settings.persons.push(n); save(); render(); }
}
const needsName = () => DEFAULT_NAMES.includes(state.settings.me || '');

// ---------- Darstellung (pro Gerät) ----------
function localGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function localSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* egal */ } }
function applyLook() {
  const t = localGet('ausgaben-theme') === 'dim' ? 'dim' : 'light';
  const sz = ['large', 'xlarge'].includes(localGet('ausgaben-size')) ? localGet('ausgaben-size') : 'normal';
  document.documentElement.dataset.theme = t;
  if (sz === 'normal') delete document.documentElement.dataset.size; else document.documentElement.dataset.size = sz;
}
applyLook();

// ---------- Ansicht: Gemeinsam | Persönlich ----------
let mode = 'shared';
try { mode = localStorage.getItem('ausgaben-mode') === 'personal' ? 'personal' : 'shared'; } catch (e) { /* egal */ }
const isPersonal = () => mode === 'personal';
/** Gehört ein Eintrag zu „meinen“ Ausgaben? (privat oder von mir bezahlt) */
const isMine = (e) => e.private || (e.person && e.person === state.settings.me);

function setMode(m, silent) {
  mode = m === 'personal' ? 'personal' : 'shared';
  try { localStorage.setItem('ausgaben-mode', mode); } catch (e) { /* egal */ }
  document.body.dataset.mode = mode;
  $$('.mode-switch button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  const active = $('.view.active');
  const v = active ? active.id.replace('view-', '') : 'overview';
  if ((v === 'subs' && isPersonal()) || (v === 'konto' && !isPersonal())) showView('overview');
  $('#filterPerson').value = '';
  if (!silent) { render(); if (navigator.vibrate) navigator.vibrate(8); }
}

function renderOverview() {
  const meName = state.settings.me || '';
  $('#meChip').textContent = needsName() ? '👤 Name eintragen' : `👤 ${meName}`;
  $('#namePrompt').hidden = !needsName();
  const all = expensesForMonth(viewY, viewM);
  const isCurrent = viewY === now.getFullYear() && viewM === now.getMonth();
  const dim = daysInMonth(viewY, viewM);
  const me = state.settings.me;

  const sum = (list) => round2(list.reduce((x, e) => x + e.amount, 0));

  if (isPersonal()) {
    $('#modeBanner').textContent = `Persönliche Ansicht${me ? ' von ' + me : ''} – nur auf diesem Gerät`;
    const mineItems = all.filter(isMine);
    const tr = transfersForMonth(viewY, viewM);
    const given = round2(tr.filter((t) => t.payer === me).reduce((a, t) => a + t.amount, 0));
    const received = round2(tr.filter((t) => t.to === me).reduce((a, t) => a + t.amount, 0));
    const spentShared = sum(mineItems.filter((e) => !e.private && !e.virtual));
    const spentFixed = sum(mineItems.filter((e) => e.virtual));
    const spentPrivate = sum(mineItems.filter((e) => e.private));
    const household = round2(spentShared + spentFixed + given - received);

    $('#kpiLabel1').textContent = 'Meine Ausgaben gesamt';
    $('#kpiTotal').textContent = fmt(household + spentPrivate);
    $('#kpiTotalSub').textContent = '';
    $('#kpiLabel2').textContent = 'Anteil Haushalt';
    $('#kpiA').textContent = fmt(household);
    $('#kpiASub').textContent = given ? `inkl. Haushaltsgeld ${fmt0(given)}` : '';
    $('#kpiLabel3').textContent = '🔒 Privat';
    $('#kpiB').textContent = fmt(spentPrivate);
    $('#kpiBSub').textContent = '';

    const kv = (label, val) => `<li><span>${label}</span><b>${val}</b></li>`;
    $('#meContrib').innerHTML = [
      kv('🛒 Gemeinsame Einkäufe bezahlt', fmt(spentShared)),
      kv('🏠 Fixkosten von meinem Konto', fmt(spentFixed)),
      given ? kv('💶 Haushaltsgeld gezahlt', '+ ' + fmt(given)) : '',
      received ? kv('💶 Haushaltsgeld erhalten', '− ' + fmt(received)) : '',
      kv('<b>Mein Anteil am Haushalt</b>', fmt(household)),
    ].join('');
    $('#dailyTitle').textContent = 'Meine Ausgaben pro Tag';
    $('#catTitle').textContent = 'Meine Kategorien';
    $('#catSubtitle').textContent = 'privat + von mir bezahlt';
    renderDailyChart(mineItems.filter((e) => !e.virtual), dim, isCurrent ? now.getDate() : dim);
    renderCatBars(mineItems, true);
    return;
  }

  // ----- Gemeinsame Ansicht: reine Ausgabenübersicht -----
  const shown = state.settings.persons.filter((p) => !DEFAULT_NAMES.includes(p));
  $('#modeBanner').textContent = shown.length >= 2 ? `Gemeinsame Ansicht – sehen ${shown.join(' & ')}` : 'Gemeinsame Ansicht';
  const items = all.filter((e) => !e.private);
  const total = sum(items);
  const fixedList = items.filter((e) => e.virtual);
  const dailyList = items.filter((e) => !e.virtual);
  const prev = expensesForMonth(viewM === 0 ? viewY - 1 : viewY, viewM === 0 ? 11 : viewM - 1).filter((e) => !e.private);
  const prevTotal = sum(prev);

  $('#kpiLabel1').textContent = 'Ausgaben gesamt';
  $('#kpiTotal').textContent = fmt(total);
  $('#kpiTotalSub').textContent = prevTotal ? `Vormonat ${fmt0(prevTotal)}` : '';
  $('#kpiLabel2').textContent = '🏠 Fixkosten';
  $('#kpiA').textContent = fmt(sum(fixedList));
  $('#kpiASub').textContent = `${fixedList.length} Posten`;
  $('#kpiLabel3').textContent = '🛒 Alltag';
  $('#kpiB').textContent = fmt(sum(dailyList));
  $('#kpiBSub').textContent = `${dailyList.length} ${dailyList.length === 1 ? 'Einkauf' : 'Einkäufe'}`;

  renderWhoPaid(items);
  $('#dailyTitle').textContent = 'Ausgaben pro Tag';
  $('#catTitle').textContent = 'Kategorien';
  $('#catSubtitle').textContent = 'diesen Monat';
  renderDailyChart(dailyList, dim, isCurrent ? now.getDate() : dim);
  renderCatBars(items, true);
}

function renderWhoPaid(items) {
  const persons = state.settings.persons;
  const stats = {};
  const mk = () => ({ total: 0, count: 0, fixed: 0, given: 0, received: 0 });
  persons.forEach((p) => { stats[p] = mk(); });
  let open = 0; // Fixkosten ohne zugeordnete Person (z. B. Gemeinschaftskonto)
  items.forEach((e) => {
    if (!e.person) { open += e.amount; return; }
    const s = stats[e.person] || (stats[e.person] = mk());
    s.total += e.amount;
    if (e.virtual) s.fixed += e.amount; else s.count++;
  });
  // Haushaltsgeld: wer überweist, hat (über den anderen) mitbezahlt
  transfersForMonth(viewY, viewM).forEach((t) => {
    if (!t.payer || !t.to || t.payer === t.to) return;
    const from = stats[t.payer] || (stats[t.payer] = mk());
    const to = stats[t.to] || (stats[t.to] = mk());
    from.total += t.amount; from.given += t.amount;
    to.total -= t.amount; to.received += t.amount;
  });
  const rows = Object.entries(stats).filter(([p, s]) => s.total !== 0 || s.received || persons.includes(p));
  const sum = rows.reduce((a, [, s]) => a + s.total, 0);
  const ul = $('#whoList');
  if (!sum) {
    ul.innerHTML = '<li class="hint">Noch keine Zahlungen mit Person in diesem Monat.</li>';
    $('#whoBalance').textContent = '';
    $('#whoOpen').textContent = open ? `Ohne Person (z. B. Gemeinschaftskonto): ${fmt(open)}` : '';
    return;
  }
  ul.innerHTML = rows.sort((a, b) => b[1].total - a[1].total).map(([p, s]) => {
    const pct = Math.min(100, Math.max(0, (s.total / sum) * 100));
    const i = personIndex(p);
    const detail = [s.count ? `${s.count} ${s.count === 1 ? 'Einkauf' : 'Einkäufe'}` : '', s.fixed ? `Fixkosten ${fmt0(s.fixed)}` : '',
      s.given ? `+ Haushaltsgeld ${fmt0(s.given)}` : '', s.received ? `− erhaltenes Haushaltsgeld ${fmt0(s.received)}` : ''].filter(Boolean).join(' · ');
    return `<li data-person="${esc(p)}">
      <div class="who-line">${personAvatar(p)}<span class="who-name">${esc(p)}<span class="muted who-detail">${esc(detail)}</span></span>
        <span class="amt">${s.total < 0 ? `<span class="muted">Überschuss</span> <b>${fmt(-s.total)}</b>` : `<b>${fmt(s.total)}</b> <span class="muted">${Math.round(pct)} %</span>`}</span></div>
      <div class="progress"><div class="progress-fill ${i > -1 ? 'bg-p' + (i % 4) : ''}" style="width:${pct}%"></div></div>
    </li>`;
  }).join('');
  $$('li[data-person]', ul).forEach((li) => li.addEventListener('click', () => {
    $('#filterPerson').value = li.dataset.person; showView('list'); renderList();
  }));

  // Ausgleich bei gleicher Aufteilung
  const active = rows.filter(([p]) => persons.includes(p));
  let balance = '';
  if (active.length >= 2) {
    const share = sum / active.length;
    const diffs = active.map(([p, s]) => [p, round2(s.total - share)]);
    const payers = diffs.filter(([, d]) => d < -0.5).sort((a, b) => a[1] - b[1]);
    const receivers = diffs.filter(([, d]) => d > 0.5).sort((a, b) => b[1] - a[1]);
    const moves = [];
    let ri = 0;
    for (const [p, d0] of payers) {
      let d = -d0;
      while (d > 0.5 && ri < receivers.length) {
        const take = Math.min(d, receivers[ri][1]);
        moves.push(`${p} → ${receivers[ri][0]}: ${fmt(take)}`);
        receivers[ri][1] = round2(receivers[ri][1] - take); d = round2(d - take);
        if (receivers[ri][1] <= 0.5) ri++;
      }
    }
    balance = moves.length ? `⚖️ Bei halbe-halbe: ${moves.join(' · ')}` : '⚖️ Ausgeglichen – alle haben gleich viel bezahlt.';
  }
  $('#whoBalance').textContent = balance;
  $('#whoOpen').textContent = open ? `Ohne Person (z. B. Gemeinschaftskonto): ${fmt(open)}` : '';
}

function renderDailyChart(items, dim, elapsedDays) {
  const el = $('#dailyChart');
  const perDay = new Array(dim).fill(0);
  items.forEach((e) => { const d = parseInt(e.date.slice(8, 10), 10); if (d >= 1 && d <= dim) perDay[d - 1] += e.amount; });
  const total = perDay.reduce((a, b) => a + b, 0);
  $('#dailyAvg').textContent = total ? `Ø ${fmt(total / Math.max(1, elapsedDays))} / Tag` : '';

  const W = Math.max(280, Math.round(el.clientWidth || 340)), H = 160, padL = 44, padB = 22, padT = 10;
  const max = Math.max(...perDay, 1);
  const niceMax = niceCeil(max);
  const plotW = W - padL, plotH = H - padB - padT;
  const slot = plotW / dim, bw = Math.max(2, slot - 2);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Ausgaben pro Tag">`;
  if (total) [0.5, 1].forEach((f) => { // ohne Ausgaben keine Achsenwerte
    const y = padT + plotH - plotH * f;
    svg += `<line class="grid" x1="${padL}" x2="${W}" y1="${y}" y2="${y}"/><text x="${padL - 6}" y="${y + 3}" text-anchor="end">${esc(fmt0(niceMax * f))}</text>`;
  });
  perDay.forEach((v, i) => {
    const h = v > 0 ? Math.max(2, (v / niceMax) * plotH) : 0;
    const x = padL + i * slot + (slot - bw) / 2;
    const y = padT + plotH - h;
    const r = Math.min(4, bw / 2, h);
    if (h > 0) svg += `<path class="bar" data-i="${i}" d="${roundedTop(x, y, bw, h, r)}"/>`;
    svg += `<rect class="hit" data-i="${i}" x="${padL + i * slot}" y="${padT}" width="${slot}" height="${plotH + padB}"/>`;
    if ((i + 1) === 1 || (i + 1) % 5 === 0) svg += `<text x="${padL + i * slot + slot / 2}" y="${H - 5}" text-anchor="middle">${i + 1}.</text>`;
  });
  svg += `<line class="base" x1="${padL}" x2="${W}" y1="${padT + plotH}" y2="${padT + plotH}"/>`;
  if (!total) svg += `<text class="empty" x="${padL + plotW / 2}" y="${padT + plotH / 2}" text-anchor="middle">Noch keine Ausgaben in diesem Monat</text>`;
  svg += '</svg>';
  el.innerHTML = svg;

  const tip = $('#tooltip');
  const show = (ev) => {
    const t = ev.target.closest('.hit'); if (!t) return;
    const i = +t.dataset.i;
    $$('.bar.hover', el).forEach((b) => b.classList.remove('hover'));
    const b = el.querySelector(`.bar[data-i="${i}"]`); if (b) b.classList.add('hover');
    const d = new Date(viewY, viewM, i + 1).toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short' });
    tip.textContent = `${d}: ${fmt(perDay[i])}`;
    const r = t.getBoundingClientRect();
    tip.style.left = (r.left + r.width / 2) + 'px';
    tip.style.top = (r.top + 10) + 'px';
    tip.hidden = false;
  };
  const hide = () => { tip.hidden = true; $$('.bar.hover', el).forEach((b) => b.classList.remove('hover')); };
  el.onpointermove = show;
  if (!el.dataset.resize) { el.dataset.resize = '1'; let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(renderOverview, 150); }); } el.onpointerdown = show; el.onpointerleave = hide;
}

function roundedTop(x, y, w, h, r) {
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}
function niceCeil(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}

function renderCatBars(items, noBudget = false) {
  const sums = {};
  items.forEach((e) => {
    const its = (e.items || []).filter((it) => Number.isFinite(it.price));
    if (!its.length) { sums[e.category] = (sums[e.category] || 0) + e.amount; return; }
    let rest = e.amount;
    its.forEach((it) => { const c = it.cat || e.category; sums[c] = (sums[c] || 0) + it.price; rest -= it.price; });
    if (Math.abs(rest) > 0.004) sums[e.category] = (sums[e.category] || 0) + rest; // Abweichung (z. B. Rabatt) beim Laden-Typ
  });
  const cats = state.categories
    .map((c) => ({ ...c, spent: round2(sums[c.id] || 0) }))
    .filter((c) => c.spent > 0 || (!noBudget && Number(c.budget) > 0))
    .sort((a, b) => b.spent - a.spent);
  // Ausgaben mit gelöschten Kategorien
  const known = new Set(state.categories.map((c) => c.id));
  const orphan = Object.entries(sums).filter(([k]) => !known.has(k)).reduce((a, [, v]) => a + v, 0);
  if (orphan) cats.push({ id: '_orphan', name: 'Ohne Kategorie', emoji: '❔', budget: 0, spent: round2(orphan) });

  const ul = $('#catBars');
  if (!cats.length) { ul.innerHTML = '<li class="empty-state">Noch keine Kategorien mit Ausgaben.</li>'; return; }
  const maxSpent = Math.max(...cats.map((c) => c.spent), 1);
  ul.innerHTML = cats.map((c) => {
    const b = noBudget ? 0 : Number(c.budget) || 0;
    const over = b > 0 && c.spent > b;
    const pct = b > 0 ? Math.min(100, (c.spent / b) * 100) : (c.spent / maxSpent) * 100;
    return `<li data-cat="${esc(c.id)}">
      <div class="cat-line"><span>${esc(c.emoji)} ${esc(c.name)}${over ? '<span class="over-tag">⚠️ über Budget</span>' : ''}</span>
        <span class="amt"><b>${fmt(c.spent)}</b>${b > 0 ? ' / ' + fmt0(b) : ''}</span></div>
      <div class="progress ${over ? 'over' : ''}"><div class="progress-fill" style="width:${pct}%"></div></div>
    </li>`;
  }).join('');
  $$('li[data-cat]', ul).forEach((li) => li.addEventListener('click', () => {
    $('#filterCat').value = li.dataset.cat === '_orphan' ? '' : li.dataset.cat;
    showView('list'); renderList();
  }));
}

let listMode = 'exp';
const normItem = (n) => String(n || '').toLowerCase().replace(/[^a-zäöüß0-9%., ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Alle gekauften Artikel (alle Monate) – wann, wo, zu welchem Preis */
function renderArticles() {
  const root = $('#articleList');
  const q = $('#searchInput').value.trim().toLowerCase();
  const fc = $('#filterCat').value, fp = $('#filterPerson').value;
  const rows = [];
  state.expenses
    .filter((e) => (isPersonal() ? isMine(e) : !e.private))
    .filter((e) => !fp || (fp === '__private' ? e.private : fp === '__shared' ? !e.private : e.person === fp))
    .forEach((e) => (e.items || []).forEach((it) => {
      if (!it.name || !Number.isFinite(it.price) || it.price <= 0) return;
      const cat = it.cat || e.category;
      if (fc && cat !== fc) return;
      rows.push({ ...it, cat, norm: normItem(it.name), date: e.date, time: e.time || '', store: e.merchant || '', branch: e.branch || '', person: e.person || '', expId: e.id,
        each: it.qty && it.unit ? it.unit : it.price });
    }));
  const hits = q ? rows.filter((r) => `${r.name} ${r.store} ${r.branch}`.toLowerCase().includes(q)) : rows;
  if (!rows.length) { root.innerHTML = '<div class="empty-state">Noch keine Artikel erfasst.<br>Tippe oben auf <b>🧾 Kassenbon erfassen</b>.</div>'; return; }
  if (!hits.length) { root.innerHTML = '<div class="empty-state">Kein Artikel gefunden.</div>'; return; }
  const groups = new Map();
  hits.forEach((r) => { if (!groups.has(r.norm)) groups.set(r.norm, []); groups.get(r.norm).push(r); });
  const list = [...groups.values()].map((g) => g.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time)))
    .sort((a, b) => (b[0].date + b[0].time).localeCompare(a[0].date + a[0].time)).slice(0, 200);
  const d = (r) => new Date(r.date + 'T12:00').toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
  root.innerHTML = list.map((g, i) => {
    const last = g[0], each = g.map((r) => r.each);
    const min = Math.min(...each), max = Math.max(...each);
    const cheap = g.find((r) => r.each === min);
    const c = catById(last.cat);
    const range = g.length > 1 && max - min > 0.004 ? ` · günstigst ${fmt(min)} (${esc(cheap.store)}${cheap.branch ? ', ' + esc(cheap.branch.split(',')[0]) : ''}) · teuerst ${fmt(max)}` : '';
    return `<details class="art" ${q && list.length <= 3 ? 'open' : ''}>
      <summary><span class="emoji">${esc(c.emoji)}</span><span class="main"><div class="title">${esc(last.name)}</div>
        <div class="sub">${g.length}× gekauft · zuletzt ${esc(d(last))} bei ${esc(last.store)}${range}</div></span><span class="amount">${fmt(last.each)}</span></summary>
      <ul class="art-rows">${g.map((r) => `<li data-exp="${esc(r.expId)}"><span>${esc(d(r))}${r.time ? ' ' + esc(r.time) : ''}</span>
        <span>${esc(r.store)}${r.branch ? `<br><small>📍 ${esc(r.branch)}</small>` : ''}${r.person ? `<br><small>${esc(r.person)}</small>` : ''}</span>
        <span class="amt">${r.qty ? `<small>${String(r.qty).replace('.', ',')} ${esc(r.unitLabel || '×')} ${fmt(r.unit)}</small><br>` : ''}${fmt(r.price)}</span></li>`).join('')}</ul>
    </details>`;
  }).join('');
  $$('.art-rows li', root).forEach((li) => li.addEventListener('click', () => openExpenseDialog(state.expenses.find((e) => e.id === li.dataset.exp))));
}

function renderList() {
  const fc = $('#filterCat'), fp = $('#filterPerson');
  const prevC = fc.value, prevP = fp.value;
  fc.innerHTML = '<option value="">Alle Kategorien</option>' + state.categories.map((c) => `<option value="${esc(c.id)}">${esc(c.emoji)} ${esc(c.name)}</option>`).join('');
  fp.innerHTML = isPersonal()
    ? '<option value="">Alle meine</option><option value="__private">🔒 Nur private</option><option value="__shared">Nur gemeinsame (von mir bezahlt)</option>'
    : '<option value="">Alle Personen</option>' + state.settings.persons.map((p) => `<option>${esc(p)}</option>`).join('');
  fc.value = prevC; fp.value = prevP;

  $$('#listMode button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === listMode)));
  $('#expenseList').hidden = listMode !== 'exp';
  $('#articleList').hidden = listMode !== 'art';
  if (listMode === 'art') { renderArticles(); return; }
  const q = $('#searchInput').value.trim().toLowerCase();
  const items = expensesForMonth(viewY, viewM)
    .filter((e) => (isPersonal() ? isMine(e) : !e.private))
    .filter((e) => !fc.value || e.category === fc.value)
    .filter((e) => !fp.value || (fp.value === '__private' ? e.private : fp.value === '__shared' ? !e.private : e.person === fp.value))
    .filter((e) => !q || `${e.merchant} ${e.branch || ''} ${e.note} ${catById(e.category).name} ${(e.items || []).map((it) => it.name).join(' ')}`.toLowerCase().includes(q))
    .sort((a, b) => (b.date + (b.created || '')).localeCompare(a.date + (a.created || '')));

  const root = $('#expenseList');
  if (!items.length) {
    root.innerHTML = '<div class="empty-state">Keine Ausgaben gefunden.<br>Tippe auf <b>+</b>, um eine hinzuzufügen.</div>';
    return;
  }
  const groups = new Map();
  items.forEach((e) => { const k = e.virtual ? 'Abos & Fixkosten' : e.date; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); });
  let html = '';
  for (const [k, list] of groups) {
    const label = k.includes('-') ? new Date(k + 'T12:00').toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }) : k;
    const sum = list.reduce((a, e) => a + e.amount, 0);
    html += `<div class="day-group"><div class="day-head"><span>${esc(label)}</span><span>${fmt(sum)}</span></div><ul class="rows">`;
    html += list.map((e) => {
      const c = catById(e.category);
      const sub = [personTag(e.person), esc(timeOf(e)), e.branch ? '📍 ' + esc(e.branch) : '', esc(c.name), esc(e.note)].filter(Boolean).join(' · ');
      const itemHits = q && e.items ? e.items.filter((it) => it.name.toLowerCase().includes(q)).slice(0, 3) : [];
      const hitLine = itemHits.length ? `<div class="sub hit">🔎 ${itemHits.map((it) => `${esc(it.name)} ${fmt(it.price)}`).join(' · ')}</div>` : '';
      const badge = (e.private ? '<span class="badge badge-private">🔒 privat</span>' : '') + (e.source === 'wallet' ? '<span class="badge">📲 Handy</span>' : '') + (e.items && e.items.length ? `<span class="badge">🧾 ${e.items.length}</span>` : '');
      return `<li class="row ${e.virtual ? 'virtual' : ''}" data-id="${esc(e.id)}">
        <span class="emoji">${esc(c.emoji)}</span>
        <span class="main"><div class="title">${esc(e.merchant || c.name)}${badge}</div><div class="sub">${sub}</div>${hitLine}</span>
        <span class="amount">${fmt(e.amount)}</span></li>`;
    }).join('');
    html += '</ul></div>';
  }
  root.innerHTML = html;
  $$('.row', root).forEach((row) => row.addEventListener('click', () => {
    const id = row.dataset.id;
    if (id.startsWith('sub-')) { openSubDialog(state.subs.find((s) => 'sub-' + s.id === id)); return; }
    openExpenseDialog(state.expenses.find((e) => e.id === id));
  }));
}

function renderSubs() {
  const key = monthKey(now.getFullYear(), now.getMonth());
  const ended = (s) => s.end && s.end < key;
  const until = (s) => (s.end ? (ended(s) ? 'beendet ' : 'bis ') + s.end.split('-').reverse().join('/') : '');

  const fixed = state.subs.filter((s) => !isTransfer(s));
  const ul = $('#subsList');
  const monthly = fixed.filter((s) => !ended(s)).reduce((a, s) => a + perMonth(s), 0);
  $('#subsTotal').textContent = fixed.length ? `≈ ${fmt(monthly)} / Monat` : '';
  ul.innerHTML = fixed.length ? [...fixed].sort((a, b) => ended(a) - ended(b) || b.amount - a.amount).map((s) => {
    const c = catById(s.category);
    const rare = s.interval === 'quarter' || s.interval === 'year';
    const due = rare && !ended(s) ? nextDue(s) : '';
    const info = [esc(INTERVALS[s.interval] || 'monatlich'), esc(c.name), s.payer ? personTag(s.payer) : 'gemeinsam',
      s.via && s.via !== 'Girokonto' ? 'über ' + esc(s.via) : '', due ? `nächste Zahlung ${esc(fmtYM(due))}` : '',
      rare && s.spread ? `umgelegt ${esc(fmt(perMonth(s)))}/Monat` : '', esc(until(s))].filter(Boolean).join(' · ');
    return `<li class="row ${ended(s) ? 'ended' : ''}" data-id="${esc(s.id)}"><span class="emoji">${esc(c.emoji)}</span>
      <span class="main"><div class="title">${esc(s.name)}</div><div class="sub">${info}</div></span>
      <span class="amount">${fmt(s.amount)}${rare ? `<div class="muted per">${s.interval === 'year' ? 'pro Jahr' : 'pro Quartal'}</div>` : ''}</span></li>`;
  }).join('') : '<li class="empty-state">Noch keine Fixkosten. Miete, Strom, Handyvertrag, Netflix …<br>Tipp: In „Mein Konto“ werden regelmäßige Abbuchungen automatisch erkannt.</li>';

  const upcoming = fixed.filter((s) => (s.interval === 'quarter' || s.interval === 'year') && !ended(s))
    .map((s) => ({ s, due: nextDue(s) })).filter((x) => x.due).sort((a, b) => a.due.localeCompare(b.due)).slice(0, 6);
  $('#dueBox').hidden = !upcoming.length;
  $('#dueList').innerHTML = upcoming.map(({ s, due }) => `<li><span>${esc(fmtYM(due))}</span><span>${esc(s.name)}</span><b>${fmt(s.amount)}</b></li>`).join('');

  const tr = state.subs.filter(isTransfer);
  const tl = $('#transferList');
  const tMonthly = tr.filter((s) => !ended(s)).reduce((a, s) => a + perMonth(s), 0);
  $('#transferTotal').textContent = tr.length ? `≈ ${fmt(tMonthly)} / Monat` : '';
  tl.innerHTML = tr.length ? tr.map((s) => `<li class="row ${ended(s) ? 'ended' : ''}" data-id="${esc(s.id)}"><span class="emoji">💶</span>
      <span class="main"><div class="title">${esc(s.name || 'Haushaltsgeld')}</div><div class="sub">${[personTag(s.payer), '→', personTag(s.to), esc(INTERVALS[s.interval] || 'monatlich'), esc(until(s))].filter(Boolean).join(' ')}</div></span>
      <span class="amount">${fmt(s.amount)}</span></li>`).join('')
    : '<li class="empty-state">Überweist einer von euch dem anderen regelmäßig Geld für den Haushalt? Dann hier eintragen – es zählt bei „Wer hat bezahlt?“, aber nicht als Ausgabe.</li>';

  $$('.row', ul).concat($$('.row', tl)).forEach((row) => row.addEventListener('click', () => openSubDialog(state.subs.find((s) => s.id === row.dataset.id))));
}

function renderSettings() {
  const s = state.settings;
  const setIfIdle = (el, v) => { if (document.activeElement !== el) el.value = v; };
  $$('#segTheme button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === (localGet('ausgaben-theme') || 'light'))));
  $$('#segSize button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === (localGet('ausgaben-size') || 'normal'))));
  setIfIdle($('#setPersons'), s.persons.join(', '));
  $('#setMe').innerHTML = s.persons.map((p) => `<option ${p === s.me ? 'selected' : ''}>${esc(p)}</option>`).join('');

  const ul = $('#catSettings');
  if (!ul.contains(document.activeElement)) {
    ul.innerHTML = state.categories.map((c) => `<li class="cat-edit" data-id="${esc(c.id)}">
      <input class="emoji-in" value="${esc(c.emoji)}" aria-label="Emoji" data-k="emoji">
      <input value="${esc(c.name)}" aria-label="Name" data-k="name">
      <button aria-label="Kategorie löschen" data-del>✕</button></li>`).join('');
  }

  $('#shortcutUrl').value = shortcutUrl();
  renderLock();
  const meN = state.settings.me || '';
  const other = state.settings.persons.find((p) => p !== meN) || '';
  if (document.activeElement !== $('#nameMe')) $('#nameMe').value = DEFAULT_NAMES.includes(meN) ? '' : meN;
  if (document.activeElement !== $('#namePartner')) $('#namePartner').value = DEFAULT_NAMES.includes(other) ? '' : other;
  renderSync();
}

function renderLock() {
  const on = Lock.enabled();
  $('#lockState').textContent = on ? `✓ Gesperrt mit PIN${Lock.hasBio() ? ' und Face ID' : ''}. Sperrt automatisch nach 5 Minuten im Hintergrund.` : 'Noch nicht eingerichtet – jeder, der das Gerät in der Hand hat, könnte die App öffnen.';
  $('#lockSetupBtn').textContent = on ? 'PIN ändern' : 'PIN festlegen';
  $('#lockNowBtn').hidden = !on;
  $('#lockOffBtn').hidden = !on;
  $('#lockPrompt').hidden = on || sessionStorage.getItem('lock-later') === '1';
  Lock.bioSupported().then((ok) => {
    $('#lockBioBtn').hidden = !on || !ok;
    $('#lockBioBtn').textContent = Lock.hasBio() ? 'Face ID ausschalten' : 'Face ID einschalten';
  });
}

function renderSync() {
  const on = typeof Sync !== 'undefined' && Sync.enabled();
  $('#syncOff').hidden = on;
  const self = typeof Sync !== 'undefined' && Sync.selfAvailable();
  $('#syncSelf').hidden = !self;
  if (self && !$('#syncSupabase').dataset.init) { $('#syncSupabase').open = false; $('#syncSupabase').querySelector('summary').textContent = 'Fortgeschritten: eigener Supabase-Server'; $('#syncSupabase').dataset.init = '1'; }
  $('#syncOn').hidden = !on;
  const st = on ? Sync.status() : { state: 'off', text: 'Nicht verbunden – Daten nur auf diesem Gerät' };
  const pending = on ? Sync.pending() : 0;
  $('#syncStatusText').textContent = st.text + (pending && st.state !== 'busy' ? ` · ${pending} Änderung(en) ausstehend` : '');
  $('#syncDot').className = 'sync-dot ' + st.state;
  $('#footerNote').textContent = on ? (Sync.usesSelf() ? 'Ausgaben-App · verschlüsselt synchronisiert über euer Netlify-Konto' : 'Ausgaben-App · verschlüsselt synchronisiert über eure Supabase-Datenbank') : 'Ausgaben-App · Daten nur auf diesem Gerät';
}

async function joinFromInvite(text) {
  const info = Sync.parseInvite(text);
  if (!info) { toast('⚠️ Ungültiger Einladungslink'); return; }
  if (Sync.enabled() && Sync.household() === info.h) { toast('Bereits verbunden ✓'); return; }
  if (!confirm('Mit dem gemeinsamen Haushaltsbuch verbinden?')) return;
  let keepLocal = false;
  if (state.expenses.length || state.subs.length) {
    keepLocal = confirm(`Auf diesem Gerät sind schon ${state.expenses.length} Ausgabe(n) und ${state.subs.length} Abo(s).\n\nOK = in den gemeinsamen Haushalt übernehmen\nAbbrechen = verwerfen`);
  }
  if (Sync.enabled()) Sync.disconnect();
  try {
    toast('Verbinde …');
    await Sync.join(info, keepLocal);
    if (info.b) Konto.setBankToken(info.b); // Zugangsschlüssel für den Bank-Baustein (eigene Kontodaten bleiben getrennt)
    render();
    toast('Verbunden ✓ – Daten werden geteilt');
  } catch (e) { toast('⚠️ ' + e.message); render(); }
}

function handleInviteHash() {
  if (!location.hash.startsWith('#verbinden=')) return;
  const text = location.hash;
  history.replaceState(null, '', location.pathname + location.search);
  showView('settings');
  setTimeout(() => joinFromInvite(text), 300);
}

function shortcutUrl() {
  const base = location.origin + location.pathname;
  const p = encodeURIComponent(state.settings.me || '');
  return `${base}?betrag=BETRAG&haendler=HAENDLER&person=${p}`;
}

// ---------- Views ----------
function showView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $('#fab').hidden = name === 'settings' || name === 'konto';
  if (name === 'overview') renderOverview(); // Diagramm an sichtbare Breite anpassen
  if (name === 'konto' && typeof Konto !== 'undefined') { Konto.render(); Konto.autoRefresh(); }
  window.scrollTo({ top: 0 });
  try { sessionStorage.setItem('ausgaben-view', name); } catch (e) { /* egal */ }
}

// ---------- Expense dialog ----------
let editingId = null;
let chosenCat = null;

function renderChips(container, selected, onPick) {
  container.innerHTML = state.categories.map((c) =>
    `<button type="button" class="chip ${c.id === selected ? 'selected' : ''}" data-id="${esc(c.id)}">${esc(c.emoji)} ${esc(c.name)}</button>`).join('');
  $$('.chip', container).forEach((ch) => ch.addEventListener('click', () => {
    $$('.chip', container).forEach((x) => x.classList.remove('selected'));
    ch.classList.add('selected');
    onPick(ch.dataset.id);
  }));
}

function openExpenseDialog(exp) {
  const dlg = $('#expenseDialog'), f = $('#expenseForm');
  editingId = exp ? exp.id : null;
  $('#expenseDialogTitle').textContent = exp ? 'Ausgabe bearbeiten' : 'Neue Ausgabe';
  f.amount.value = exp ? String(exp.amount).replace('.', ',') : '';
  f.merchant.value = exp ? exp.merchant : '';
  const isCurrent = viewY === now.getFullYear() && viewM === now.getMonth();
  f.date.value = exp ? exp.date : (isCurrent ? todayISO() : `${monthKey(viewY, viewM)}-01`);
  f.note.value = exp ? exp.note || '' : '';
  f.private.checked = exp ? !!exp.private : isPersonal();
  f.person.innerHTML = state.settings.persons.map((p) => `<option>${esc(p)}</option>`).join('');
  f.person.value = exp ? exp.person : state.settings.me;
  chosenCat = exp ? exp.category : null;
  renderChips($('#catChips'), chosenCat, (id) => { chosenCat = id; });
  $('#deleteExpenseBtn').hidden = !exp;
  $('#scanBtnDialog').hidden = !!exp;
  const its = exp && exp.items ? exp.items : [];
  $('#expItems').hidden = !its.length;
  $('#expItemsAdd').hidden = !exp || !!its.length;
  $('#expItemsList').innerHTML = its.map((it) => {
    const c = catById(it.cat || exp.category);
    const qty = it.qty ? ` <span class="muted">${String(it.qty).replace('.', ',')} ${it.unitLabel ? esc(it.unitLabel) + ' ×' : '×'} ${fmt(it.unit)}${it.unitLabel ? '/' + esc(it.unitLabel) : ''}</span>` : '';
    return `<li><span>${esc(c.emoji)} ${esc(it.name)}${qty}</span><span>${fmt(it.price)}</span></li>`;
  }).join('');
  $('#expBonInfo').textContent = exp ? [exp.branch ? '📍 ' + exp.branch : '', exp.time ? '🕑 ' + exp.time + ' Uhr' : ''].filter(Boolean).join(' · ') : '';
  $('#expBonBtn').hidden = !(exp && exp.receipt);
  const merchants = [...new Set(state.expenses.map((e) => e.merchant).filter(Boolean))].slice(-200);
  $('#merchantList').innerHTML = merchants.map((m) => `<option value="${esc(m)}">`).join('');
  dlg.showModal();
  if (!exp) setTimeout(() => f.amount.focus(), 50);
}

function saveExpenseFromForm() {
  const f = $('#expenseForm');
  const amount = parseAmount(f.amount.value);
  if (!(amount > 0)) { toast('Bitte einen gültigen Betrag eingeben'); return false; }
  const merchant = f.merchant.value.trim();
  const category = chosenCat || guessCategory(merchant);
  if (chosenCat && merchant) learnRule(merchant, chosenCat);
  const data = { amount, merchant, category, date: f.date.value || todayISO(), person: f.person.value, note: f.note.value.trim(), private: f.private.checked };
  if (editingId) {
    const e = state.expenses.find((x) => x.id === editingId);
    Object.assign(e, data);
  } else {
    state.expenses.push({ id: uid(), created: new Date().toISOString(), source: 'manual', ...data });
  }
  save();
  const [y, m] = data.date.split('-').map(Number);
  viewY = y; viewM = m - 1;
  render();
  toast(editingId ? 'Gespeichert' : `${fmt(amount)} · ${catById(category).name} ✓`);
  return true;
}

// ---------- Sub dialog ----------
let editingSubId = null;
let subSavedCb = null;
function syncSubType() {
  const f = $('#subForm');
  const t = f.type.value === 'transfer';
  $$('.only-fixed', f).forEach((el) => { el.hidden = t; });
  $$('.only-transfer', f).forEach((el) => { el.hidden = !t; });
  $('#subSpreadRow').hidden = t || f.interval.value === 'month';
  $('#subPayerLabel').firstChild.textContent = t ? 'Von ' : 'Bezahlt von ';
  if (t && !f.name.value) f.name.placeholder = 'z. B. Haushaltsgeld';
}
/** sub: vorhandener Eintrag; preset: Vorbelegung (z. B. aus „Mein Konto“); onSaved(id): Rückmeldung */
function openSubDialog(sub, preset = null, onSaved = null) {
  const f = $('#subForm');
  const v = sub || preset || {};
  editingSubId = sub ? sub.id : null;
  subSavedCb = onSaved;
  const persons = state.settings.persons;
  f.type.value = v.type === 'transfer' ? 'transfer' : 'fixed';
  f.name.value = v.name || '';
  f.amount.value = v.amount ? String(v.amount).replace('.', ',') : '';
  f.interval.value = INTERVALS[v.interval] ? v.interval : 'month';
  f.category.innerHTML = state.categories.map((c) => `<option value="${esc(c.id)}">${esc(c.emoji)} ${esc(c.name)}</option>`).join('');
  f.category.value = v.category && state.categories.some((c) => c.id === v.category) ? v.category : (state.categories.some((c) => c.id === 'abos') ? 'abos' : state.categories[0].id);
  f.start.value = v.start || monthKey(viewY, viewM);
  f.end.value = v.end || '';
  f.via.value = v.via || '';
  f.spread.checked = v.spread !== undefined ? !!v.spread : false;
  f.payer.innerHTML = '<option value="">Gemeinsam / Gemeinschaftskonto</option>' + persons.map((p) => `<option>${esc(p)}</option>`).join('');
  f.payer.value = v.payer !== undefined ? v.payer : '';
  f.to.innerHTML = persons.map((p) => `<option>${esc(p)}</option>`).join('');
  f.to.value = v.to || persons.find((p) => p !== (v.payer || state.settings.me)) || persons[0];
  $('#subDialogTitle').textContent = sub ? 'Bearbeiten' : 'Neu: Fixkosten oder Haushaltsgeld';
  $('#deleteSubBtn').hidden = !sub;
  syncSubType();
  $('#subDialog').showModal();
}

// ---------- Automatische Erfassung (Kurzbefehl / Link) ----------
let lastCapturedId = null;
let capturedTimer = null;

function handleIncomingUrl() {
  const params = new URLSearchParams(location.search);
  const rawAmount = params.get('betrag') ?? params.get('amount');
  if (rawAmount == null) return;
  Lock.skipAutoBio(); // Erfasst-Fenster zuerst zeigen, Face ID erst auf Wunsch

  // Parameter sofort aus der Adresszeile entfernen → Neuladen erfasst nicht doppelt
  const query = location.search;
  history.replaceState(null, '', location.pathname + location.hash);
  try {
    if (sessionStorage.getItem('ausgaben-last-query') === query) return;
    sessionStorage.setItem('ausgaben-last-query', query);
  } catch (e) { /* egal */ }

  const amount = parseAmount(rawAmount);
  if (!(amount > 0) || /BETRAG/.test(rawAmount)) {
    toast('⚠️ Kein gültiger Betrag im Link – Kurzbefehl prüfen');
    return;
  }
  const merchant = (params.get('haendler') ?? params.get('merchant') ?? '').replace(/^HAENDLER$/, '').trim().slice(0, 80);
  const personParam = (params.get('person') || '').trim();
  const person = state.settings.persons.includes(personParam) ? personParam : state.settings.me;
  const card = (params.get('karte') ?? params.get('card') ?? '').trim().slice(0, 40);
  const isPrivate = /^(1|ja|true)$/i.test(params.get('privat') || '');
  let date = params.get('datum') || todayISO();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = todayISO();

  // Doppelte Auslösung (gleicher Betrag + Händler innerhalb 2 Minuten) ignorieren
  const recent = state.expenses.find((e) => e.source === 'wallet' && e.amount === amount && e.merchant === merchant &&
    Date.now() - new Date(e.created).getTime() < 2 * 60 * 1000);
  if (recent) { toast('Bereits erfasst ✓'); return; }

  const exp = {
    id: uid(), created: new Date().toISOString(), source: 'wallet', amount, merchant,
    category: guessCategory(merchant), date, person, note: card, private: isPrivate,
  };
  state.expenses.push(exp);
  save();
  const [y, m] = date.split('-').map(Number);
  viewY = y; viewM = m - 1;
  showCapturedSheet(exp);
}

function showCapturedSheet(exp) {
  lastCapturedId = exp.id;
  $('#capturedText').textContent = `${fmt(exp.amount)}${exp.merchant ? ' bei ' + exp.merchant : ''} · Kategorie wählen:`;
  renderChips($('#capturedChips'), exp.category, (id) => {
    const e = state.expenses.find((x) => x.id === lastCapturedId);
    if (!e) return;
    e.category = id;
    learnRule(e.merchant, id);
    save(); render();
    resetCapturedTimer();
  });
  const pb = $('#capturedPrivate');
  const paint = () => {
    const e = state.expenses.find((x) => x.id === lastCapturedId);
    pb.classList.toggle('selected', !!(e && e.private));
    pb.textContent = e && e.private ? '🔒 Privat – wird nicht geteilt' : '🔓 Gemeinsam – tippen für privat';
  };
  pb.onclick = () => {
    const e = state.expenses.find((x) => x.id === lastCapturedId);
    if (!e) return;
    e.private = !e.private;
    save(); render(); paint(); resetCapturedTimer();
  };
  paint();
  $('#capturedSheet').hidden = false;
  resetCapturedTimer();
}
function resetCapturedTimer() {
  clearTimeout(capturedTimer);
  capturedTimer = setTimeout(() => { $('#capturedSheet').hidden = true; }, 20000);
}

// ---------- Export / Import ----------
function download(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function exportCsv() {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Datum', 'Betrag', 'Händler', 'Kategorie', 'Person', 'Notiz', 'Quelle']];
  [...state.expenses].sort((a, b) => a.date.localeCompare(b.date)).forEach((e) =>
    rows.push([e.date, String(e.amount).replace('.', ','), e.merchant, catById(e.category).name, e.person, e.note, e.source === 'wallet' ? 'Handy' : 'manuell']));
  download(`ausgaben-${todayISO()}.csv`, '﻿' + rows.map((r) => r.map(q).join(';')).join('\n'), 'text/csv;charset=utf-8');
}

function importJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || !Array.isArray(data.expenses)) throw new Error('Kein gültiges Backup');
      const merge = confirm('Backup ZUSAMMENFÜHREN mit den vorhandenen Daten?\n\nOK = zusammenführen (z. B. Daten vom Partner)\nAbbrechen = vorhandene Daten ERSETZEN');
      if (merge) {
        const ids = new Set(state.expenses.map((e) => e.id));
        const added = data.expenses.filter((e) => !ids.has(e.id));
        state.expenses.push(...added);
        const subIds = new Set(state.subs.map((s) => s.id));
        state.subs.push(...(data.subs || []).filter((s) => !subIds.has(s.id)));
        const catIds = new Set(state.categories.map((c) => c.id));
        state.categories.push(...(data.categories || []).filter((c) => !catIds.has(c.id)));
        state.rules = { ...(data.rules || {}), ...state.rules };
        (data.settings?.persons || []).forEach((p) => { if (!state.settings.persons.includes(p)) state.settings.persons.push(p); });
        toast(`${added.length} Ausgaben hinzugefügt`);
      } else {
        const me = state.settings.me;
        state = { ...defaultState(), ...data, settings: { ...defaultState().settings, ...data.settings, me } };
        toast('Daten ersetzt');
      }
      save(); render();
    } catch (e) { toast('⚠️ Import fehlgeschlagen: ' + e.message); }
  };
  reader.readAsText(file);
}

// ---------- Toast ----------
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- Events ----------
function bind() {
  $$('.mode-switch button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  // Namen
  $('#nameMe').addEventListener('change', (e) => setMyName(e.target.value));
  $('#namePartner').addEventListener('change', (e) => setPartnerName(e.target.value));
  $('#namePromptBtn').onclick = () => { const v = $('#namePromptInput').value.trim(); if (!v) { toast('Bitte deinen Namen eingeben'); return; } setMyName(v); };
  $('#namePromptInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#namePromptBtn').click(); });
  $('#meChip').onclick = () => { showView('settings'); setTimeout(() => { $('#nameMe').focus(); $('#nameCard').scrollIntoView({ block: 'center' }); }, 50); };
  // App-Sperre
  $('#lockSetupBtn').onclick = () => Lock.startSetup();
  $('#lockPromptBtn').onclick = () => Lock.startSetup();
  $('#lockNowBtn').onclick = () => Lock.lockNow();
  $('#lockBioBtn').onclick = async () => { if (Lock.hasBio()) { Lock.disableBio(); toast('Face ID ausgeschaltet'); } else await Lock.enableBio(); renderLock(); };
  $('#lockOffBtn').onclick = () => { if (confirm('App-Sperre auf diesem Gerät ausschalten?')) { Lock.disable(); renderLock(); toast('Sperre ausgeschaltet'); } };
  $('#prevMonth').onclick = () => shiftMonth(-1);
  $('#nextMonth').onclick = () => shiftMonth(1);
  $$('.tabbar button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  $('#fab').onclick = () => openExpenseDialog(null);

  // Wischen links/rechts wechselt den Monat
  let sx = null, sy = null;
  document.querySelector('main').addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  document.querySelector('main').addEventListener('touchend', (e) => {
    if (sx == null) return;
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) > 80 && Math.abs(dy) < 40 && !e.target.closest('input,select,.chart')) shiftMonth(dx < 0 ? 1 : -1);
    sx = null;
  });

  $('#expenseForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (saveExpenseFromForm()) $('#expenseDialog').close();
  });
  $('#cancelExpenseBtn').onclick = () => $('#expenseDialog').close();
  // Kassenbon
  $('#scanBtnList').onclick = () => Receipt.open();
  $('#scanBtnDialog').onclick = () => { $('#expenseDialog').close(); Receipt.open(); };
  const editItems = () => {
    const e = state.expenses.find((x) => x.id === editingId);
    if (!e) return;
    $('#expenseDialog').close(); Receipt.editExpense(e);
  };
  $('#expItemsEdit').onclick = editItems;
  $('#expBonBtn').onclick = () => { const e = state.expenses.find((x) => x.id === editingId); if (e) { $('#expenseDialog').close(); Receipt.view(e); } };
  // Ausgaben: Einkäufe | Artikel & Preise
  $$('#listMode button').forEach((b) => b.addEventListener('click', () => { listMode = b.dataset.v; renderList(); }));
  $('#expItemsAdd').onclick = editItems;
  $('#deleteExpenseBtn').onclick = () => {
    if (!editingId || !confirm('Diese Ausgabe löschen?')) return;
    state.expenses = state.expenses.filter((e) => e.id !== editingId);
    save(); render(); $('#expenseDialog').close(); toast('Gelöscht');
  };
  // Kategorie automatisch vorschlagen, solange keine gewählt wurde
  $('#expenseForm').merchant.addEventListener('input', (e) => {
    if (editingId || chosenCat) return; // Nutzer hat schon selbst gewählt
    const guess = guessCategory(e.target.value);
    $$('#catChips .chip').forEach((c) => c.classList.toggle('selected', c.dataset.id === guess && e.target.value.trim() !== ''));
  });

  $('#subForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const amount = parseAmount(f.amount.value);
    if (!(amount > 0)) { toast('Bitte einen gültigen Betrag eingeben'); return; }
    const type = f.type.value === 'transfer' ? 'transfer' : 'fixed';
    if (f.end.value && f.end.value < f.start.value) { toast('„Bis“ liegt vor „Seit“'); return; }
    const data = { type, name: f.name.value.trim() || (type === 'transfer' ? 'Haushaltsgeld' : ''), amount, interval: f.interval.value,
      category: f.category.value, start: f.start.value, end: f.end.value || '', payer: f.payer.value, to: type === 'transfer' ? f.to.value : '',
      via: f.via.value, spread: type !== 'transfer' && f.interval.value !== 'month' && f.spread.checked };
    if (!data.name) { toast('Bitte einen Namen eingeben, z. B. Miete'); return; }
    if (type === 'transfer' && (!data.payer || data.payer === data.to)) { toast('Bitte „Von“ und „An“ (zwei verschiedene Personen) wählen'); return; }
    let id = editingSubId;
    if (id) Object.assign(state.subs.find((s) => s.id === id), data);
    else { id = uid(); state.subs.push({ id, ...data }); }
    save(); render(); $('#subDialog').close();
    if (subSavedCb) { const cb = subSavedCb; subSavedCb = null; cb(id); }
  });
  $('#subForm').type.addEventListener('change', syncSubType);
  $('#subForm').interval.addEventListener('change', () => {
    const f = $('#subForm');
    if (f.interval.value !== 'month' && !editingSubId) f.spread.checked = true; // Vorschlag: Rücklage bilden
    syncSubType();
  });
  $('#addTransferBtn').onclick = () => openSubDialog(null, { type: 'transfer', payer: state.settings.me, name: 'Haushaltsgeld' });
  $('#cancelSubBtn').onclick = () => $('#subDialog').close();
  $('#deleteSubBtn').onclick = () => {
    if (!editingSubId || !confirm('Diesen Eintrag löschen? (Er verschwindet auch aus vergangenen Monaten. Wenn er nur endet: stattdessen „Bis“ setzen.)')) return;
    state.subs = state.subs.filter((s) => s.id !== editingSubId);
    save(); render(); $('#subDialog').close();
  };
  $('#addSubBtn').onclick = () => openSubDialog(null);

  $('#searchInput').addEventListener('input', renderList);
  $('#filterCat').addEventListener('change', renderList);
  $('#filterPerson').addEventListener('change', renderList);

  // Einstellungen
  $$('#segTheme button').forEach((b) => b.addEventListener('click', () => { localSet('ausgaben-theme', b.dataset.v); applyLook(); renderSettings(); }));
  $$('#segSize button').forEach((b) => b.addEventListener('click', () => { localSet('ausgaben-size', b.dataset.v); applyLook(); renderSettings(); renderOverview(); }));
  $('#setPersons').addEventListener('change', (e) => {
    const list = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
    state.settings.persons = list.length ? [...new Set(list)] : ['Ich'];
    if (!state.settings.persons.includes(state.settings.me)) state.settings.me = state.settings.persons[0];
    save(); render();
  });
  $('#setMe').addEventListener('change', (e) => { state.settings.me = e.target.value; save(); render(); });

  const catUl = $('#catSettings');
  catUl.addEventListener('change', (e) => {
    const li = e.target.closest('li'); if (!li) return;
    const c = state.categories.find((x) => x.id === li.dataset.id); if (!c) return;
    const k = e.target.dataset.k;
    c[k] = e.target.value.trim() || c[k];
    save(); render();
  });
  catUl.addEventListener('click', (e) => {
    if (!e.target.matches('[data-del]')) return;
    const id = e.target.closest('li').dataset.id;
    if (state.categories.length <= 1) return;
    const c = state.categories.find((x) => x.id === id);
    if (!confirm(`Kategorie „${c.name}“ löschen? Ausgaben darin landen in „Sonstiges“.`)) return;
    state.categories = state.categories.filter((x) => x.id !== id);
    const fallback = guessCategory('');
    state.expenses.forEach((x) => { if (x.category === id) x.category = fallback; });
    state.subs.forEach((x) => { if (x.category === id) x.category = fallback; });
    save(); catUl.innerHTML = ''; render();
  });
  $('#addCatBtn').onclick = () => {
    state.categories.push({ id: uid(), name: 'Neue Kategorie', emoji: '🏷️', budget: 0 });
    save(); render();
    const inputs = $$('#catSettings li:last-child input'); if (inputs[1]) { inputs[1].focus(); inputs[1].select(); }
  };

  $('#copyUrlBtn').onclick = async () => {
    const url = $('#shortcutUrl').value;
    try { await navigator.clipboard.writeText(url); toast('Link kopiert ✓'); }
    catch (e) { $('#shortcutUrl').select(); toast('Bitte manuell kopieren'); }
  };
  $('#testWalletBtn').onclick = () => {
    const samples = [['REWE Markt', '23,47 €'], ['Aral Tankstelle', '61,20 €'], ['Starbucks', '5,90 €'], ['dm-drogerie markt', '14,85 €']];
    const [m, a] = samples[Math.floor(Math.random() * samples.length)];
    location.href = `${location.pathname}?betrag=${encodeURIComponent(a)}&haendler=${encodeURIComponent(m)}&person=${encodeURIComponent(state.settings.me)}`;
  };

  // Synchronisation
  $('#syncCreateSelfBtn').onclick = async () => {
    const btn = $('#syncCreateSelfBtn'); btn.disabled = true;
    try {
      await Sync.create('self', '');
      render();
      toast('Haushalt erstellt ✓ – jetzt Einladungslink an die anderen Geräte schicken');
    } catch (e) { toast('⚠️ ' + e.message); }
    finally { btn.disabled = false; }
  };
  $('#syncCreateBtn').onclick = async () => {
    const url = $('#syncUrl').value, key = $('#syncKey').value;
    if (!url.trim() || !key.trim()) { toast('Bitte URL und Schlüssel eintragen'); return; }
    const btn = $('#syncCreateBtn'); btn.disabled = true;
    try {
      await Sync.create(url, key);
      render();
      toast('Haushalt erstellt ✓ – jetzt Einladungslink an die anderen Geräte schicken');
    } catch (e) { toast('⚠️ ' + e.message); }
    finally { btn.disabled = false; }
  };
  $('#syncJoinBtn').onclick = () => joinFromInvite($('#syncInvite').value);
  $('#syncInviteBtn').onclick = async () => {
    const link = Sync.inviteLink();
    try {
      if (navigator.share) { await navigator.share({ title: 'Ausgaben – Einladung', text: 'Verbinde dich mit unserem Haushaltsbuch:', url: link }); return; }
    } catch (e) { if (e.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(link); toast('Einladungslink kopiert ✓'); }
    catch (e) { prompt('Einladungslink kopieren:', link); }
  };
  $('#syncNowBtn').onclick = () => Sync.syncNow();
  $('#syncDisconnectBtn').onclick = () => {
    if (!confirm('Dieses Gerät vom gemeinsamen Haushalt trennen? Die Daten bleiben auf diesem Gerät und in der Cloud erhalten.')) return;
    Sync.disconnect(); render(); toast('Getrennt');
  };
  Sync.onStatus(() => renderSync());

  $('#exportJsonBtn').onclick = () => download(`ausgaben-backup-${todayISO()}.json`, JSON.stringify(state, null, 2), 'application/json');
  $('#exportCsvBtn').onclick = exportCsv;
  $('#importFile').addEventListener('change', (e) => { if (e.target.files[0]) importJson(e.target.files[0]); e.target.value = ''; });
  $('#resetBtn').onclick = () => {
    const msg = Sync.enabled()
      ? 'Dieses Gerät wird vom gemeinsamen Haushalt getrennt und die Daten auf DIESEM Gerät gelöscht. Die gemeinsamen Daten in der Cloud bleiben erhalten. Fortfahren?'
      : 'Wirklich ALLE Daten auf diesem Gerät löschen? Vorher am besten ein Backup exportieren.';
    if (!confirm(msg)) return;
    if (Sync.enabled()) Sync.disconnect(); // sonst würden die Löschungen an alle Geräte verteilt
    state = defaultState(); save(); render(); toast('Daten auf diesem Gerät gelöscht');
  };

  $('#capturedOk').onclick = () => { $('#capturedSheet').hidden = true; Lock.allowAutoBio(); };
  $('#capturedUndo').onclick = () => {
    state.expenses = state.expenses.filter((e) => e.id !== lastCapturedId);
    save(); render(); $('#capturedSheet').hidden = true; toast('Rückgängig gemacht');
  };

  // Daten in anderem Tab geändert (z. B. Kurzbefehl hat neuen Tab geöffnet)
  window.addEventListener('storage', (e) => { if (e.key === STORAGE_KEY) { state = load(); render(); } });
}

// ---------- Start ----------
bind();
Lock.init();
Receipt.init();
setMode(mode, true);
handleIncomingUrl();
handleInviteHash();
window.addEventListener('hashchange', handleInviteHash);
let startView = 'overview';
try { startView = sessionStorage.getItem('ausgaben-view') || 'overview'; } catch (e) { /* egal */ }
if ((startView === 'subs' && isPersonal()) || (startView === 'konto' && !isPersonal())) startView = 'overview';
showView(startView);
render();
Sync.init();
Konto.handleCallback();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
