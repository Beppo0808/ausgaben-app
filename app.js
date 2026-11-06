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

/** Abos, die in einem Monat anfallen, als „virtuelle“ Ausgaben */
function subsForMonth(y, m) {
  const key = monthKey(y, m);
  return state.subs
    .filter((s) => {
      if (!s.start || s.start > key) return false;
      if (s.interval === 'year') return s.start.slice(5, 7) === key.slice(5, 7);
      return true;
    })
    .map((s) => ({
      id: 'sub-' + s.id, subId: s.id, virtual: true, date: `${key}-01`, amount: s.amount,
      merchant: s.name, category: s.category, person: s.payer || '', note: s.interval === 'year' ? 'jährlich' : 'monatlich',
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

function renderOverview() {
  const all = expensesForMonth(viewY, viewM);
  const items = all.filter((e) => !e.private); // Haushalt = alles Gemeinsame
  const spent = round2(items.reduce((a, e) => a + e.amount, 0));
  const fixed = round2(items.filter((e) => e.virtual).reduce((a, e) => a + e.amount, 0));
  const budget = Number(state.settings.budget) || 0;
  const left = budget - spent;

  $('#kpiBudget').textContent = budget > 0 ? fmt(budget) : '–';
  $('#kpiSpent').textContent = fmt(spent);
  $('#kpiSpentSub').textContent = `Fixkosten ${fmt0(fixed)} · Alltag ${fmt0(spent - fixed)}`;
  const leftEl = $('#kpiLeft');
  leftEl.textContent = budget > 0 ? fmt(left) : '–';
  leftEl.className = 'kpi-value ' + (left < 0 ? 'neg' : '');

  // Wer hat bezahlt (nur Alltagsausgaben, Fixkosten sind gemeinsam)
  renderWhoPaid(items);

  // Privater Bereich – nur auf diesem Gerät
  const me = state.settings.me;
  const income = Number(state.settings.income) || 0;
  const mine = round2(all.filter((e) => !e.virtual && (e.private || e.person === me)).reduce((a, e) => a + e.amount, 0));
  const minePrivate = round2(all.filter((e) => e.private).reduce((a, e) => a + e.amount, 0));
  $('#meTitle').textContent = `🔒 Nur für dich${me ? ' (' + me + ')' : ''}`;
  $('#meIncome').textContent = income ? fmt(income) : '–';
  $('#meSpent').textContent = fmt(mine);
  $('#meSpentSub').textContent = minePrivate ? `davon privat ${fmt0(minePrivate)}` : '';
  const meLeft = $('#meLeft');
  meLeft.textContent = income ? fmt(income - mine) : '–';
  meLeft.className = 'kpi-value ' + (income && income - mine < 0 ? 'neg' : '');
  $('#meHint').hidden = !!income;

  const pct = budget > 0 ? spent / budget : 0;
  const bar = $('#budgetBar');
  bar.classList.toggle('over', pct > 1);
  bar.querySelector('.progress-fill').style.width = Math.min(100, pct * 100) + '%';
  $('#budgetText').textContent = budget > 0 ? `${fmt0(spent)} von ${fmt0(budget)}` : 'kein Budget gesetzt';

  const isCurrent = viewY === now.getFullYear() && viewM === now.getMonth();
  const dim = daysInMonth(viewY, viewM);
  let hint = '';
  if (budget > 0) {
    if (spent > budget) hint = `⚠️ Budget um ${fmt(spent - budget)} überschritten.`;
    else if (isCurrent) {
      const daysLeft = dim - now.getDate() + 1;
      hint = `✓ Noch ${fmt(budget - spent)} – das sind ${fmt((budget - spent) / daysLeft)} pro Tag für ${daysLeft} Tage.`;
    } else hint = `✓ ${fmt(budget - spent)} unter Budget.`;
  }
  $('#budgetHint').textContent = hint;

  renderDailyChart(items.filter((e) => !e.virtual), dim, isCurrent ? now.getDate() : dim);
  renderCatBars(items);
}

function renderWhoPaid(items) {
  const persons = state.settings.persons;
  const stats = {};
  persons.forEach((p) => { stats[p] = { total: 0, count: 0, fixed: 0 }; });
  let open = 0; // Fixkosten ohne zugeordnete Person (z. B. Gemeinschaftskonto)
  items.forEach((e) => {
    if (!e.person) { open += e.amount; return; }
    const s = stats[e.person] || (stats[e.person] = { total: 0, count: 0, fixed: 0 });
    s.total += e.amount;
    if (e.virtual) s.fixed += e.amount; else s.count++;
  });
  const rows = Object.entries(stats).filter(([p, s]) => s.total > 0 || persons.includes(p));
  const sum = rows.reduce((a, [, s]) => a + s.total, 0);
  const ul = $('#whoList');
  if (!sum) {
    ul.innerHTML = '<li class="hint">Noch keine Zahlungen mit Person in diesem Monat.</li>';
    $('#whoBalance').textContent = '';
    $('#whoOpen').textContent = open ? `Ohne Person (z. B. Gemeinschaftskonto): ${fmt(open)}` : '';
    return;
  }
  ul.innerHTML = rows.sort((a, b) => b[1].total - a[1].total).map(([p, s]) => {
    const pct = (s.total / sum) * 100;
    const i = personIndex(p);
    const detail = [`${s.count} ${s.count === 1 ? 'Einkauf' : 'Einkäufe'}`, s.fixed ? `Fixkosten ${fmt0(s.fixed)}` : ''].filter(Boolean).join(' · ');
    return `<li data-person="${esc(p)}">
      <div class="who-line">${personAvatar(p)}<span class="who-name">${esc(p)}<span class="muted who-detail">${esc(detail)}</span></span>
        <span class="amt"><b>${fmt(s.total)}</b> <span class="muted">${Math.round(pct)} %</span></span></div>
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
  [0.5, 1].forEach((f) => {
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

function renderCatBars(items) {
  const sums = {};
  items.forEach((e) => { sums[e.category] = (sums[e.category] || 0) + e.amount; });
  const cats = state.categories
    .map((c) => ({ ...c, spent: round2(sums[c.id] || 0) }))
    .filter((c) => c.spent > 0 || Number(c.budget) > 0)
    .sort((a, b) => b.spent - a.spent);
  // Ausgaben mit gelöschten Kategorien
  const known = new Set(state.categories.map((c) => c.id));
  const orphan = Object.entries(sums).filter(([k]) => !known.has(k)).reduce((a, [, v]) => a + v, 0);
  if (orphan) cats.push({ id: '_orphan', name: 'Ohne Kategorie', emoji: '❔', budget: 0, spent: round2(orphan) });

  const ul = $('#catBars');
  if (!cats.length) { ul.innerHTML = '<li class="empty-state">Noch keine Kategorien mit Ausgaben.</li>'; return; }
  const maxSpent = Math.max(...cats.map((c) => c.spent), 1);
  ul.innerHTML = cats.map((c) => {
    const b = Number(c.budget) || 0;
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

function renderList() {
  const fc = $('#filterCat'), fp = $('#filterPerson');
  const prevC = fc.value, prevP = fp.value;
  fc.innerHTML = '<option value="">Alle Kategorien</option>' + state.categories.map((c) => `<option value="${esc(c.id)}">${esc(c.emoji)} ${esc(c.name)}</option>`).join('');
  fp.innerHTML = '<option value="">Alle (gemeinsam + privat)</option><option value="__shared">Nur gemeinsame</option><option value="__private">🔒 Nur meine privaten</option>' + state.settings.persons.map((p) => `<option>${esc(p)}</option>`).join('');
  fc.value = prevC; fp.value = prevP;

  const q = $('#searchInput').value.trim().toLowerCase();
  const items = expensesForMonth(viewY, viewM)
    .filter((e) => !fc.value || e.category === fc.value)
    .filter((e) => !fp.value || (fp.value === '__private' ? e.private : fp.value === '__shared' ? !e.private : e.person === fp.value))
    .filter((e) => !q || `${e.merchant} ${e.note} ${catById(e.category).name}`.toLowerCase().includes(q))
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
      const sub = [personTag(e.person), esc(timeOf(e)), esc(c.name), esc(e.note)].filter(Boolean).join(' · ');
      const badge = (e.private ? '<span class="badge badge-private">🔒 privat</span>' : '') + (e.source === 'wallet' ? '<span class="badge">📲 Handy</span>' : '');
      return `<li class="row ${e.virtual ? 'virtual' : ''}" data-id="${esc(e.id)}">
        <span class="emoji">${esc(c.emoji)}</span>
        <span class="main"><div class="title">${esc(e.merchant || c.name)}${badge}</div><div class="sub">${sub}</div></span>
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
  const ul = $('#subsList');
  const monthly = state.subs.reduce((a, s) => a + (s.interval === 'year' ? s.amount / 12 : s.amount), 0);
  $('#subsTotal').textContent = state.subs.length ? `≈ ${fmt(monthly)} / Monat` : '';
  if (!state.subs.length) { ul.innerHTML = '<li class="empty-state">Noch keine Abos. Miete, Handyvertrag, Netflix …</li>'; return; }
  ul.innerHTML = [...state.subs].sort((a, b) => b.amount - a.amount).map((s) => {
    const c = catById(s.category);
    return `<li class="row" data-id="${esc(s.id)}"><span class="emoji">${esc(c.emoji)}</span>
      <span class="main"><div class="title">${esc(s.name)}</div><div class="sub">${[s.interval === 'year' ? 'jährlich' : 'monatlich', esc(c.name), s.payer ? personTag(s.payer) : 'gemeinsam'].join(' · ')}</div></span>
      <span class="amount">${fmt(s.amount)}</span></li>`;
  }).join('');
  $$('.row', ul).forEach((row) => row.addEventListener('click', () => openSubDialog(state.subs.find((s) => s.id === row.dataset.id))));
}

function renderSettings() {
  const s = state.settings;
  const setIfIdle = (el, v) => { if (document.activeElement !== el) el.value = v; };
  setIfIdle($('#setIncome'), String(s.income).replace('.', ','));
  setIfIdle($('#setBudget'), String(s.budget).replace('.', ','));
  setIfIdle($('#setPersons'), s.persons.join(', '));
  $('#setMe').innerHTML = s.persons.map((p) => `<option ${p === s.me ? 'selected' : ''}>${esc(p)}</option>`).join('');

  const ul = $('#catSettings');
  if (!ul.contains(document.activeElement)) {
    ul.innerHTML = state.categories.map((c) => `<li class="cat-edit" data-id="${esc(c.id)}">
      <input class="emoji-in" value="${esc(c.emoji)}" aria-label="Emoji" data-k="emoji">
      <input value="${esc(c.name)}" aria-label="Name" data-k="name">
      <input value="${esc(String(c.budget || '').replace('.', ','))}" inputmode="decimal" placeholder="Budget" aria-label="Budget" data-k="budget">
      <button aria-label="Kategorie löschen" data-del>✕</button></li>`).join('');
  }

  $('#shortcutUrl').value = shortcutUrl();
  renderSync();
}

function renderSync() {
  const on = typeof Sync !== 'undefined' && Sync.enabled();
  $('#syncOff').hidden = on;
  $('#syncOn').hidden = !on;
  const st = on ? Sync.status() : { state: 'off', text: 'Nicht verbunden – Daten nur auf diesem Gerät' };
  const pending = on ? Sync.pending() : 0;
  $('#syncStatusText').textContent = st.text + (pending && st.state !== 'busy' ? ` · ${pending} Änderung(en) ausstehend` : '');
  $('#syncDot').className = 'sync-dot ' + st.state;
  $('#footerNote').textContent = on ? 'Ausgaben-App · synchronisiert über eure Supabase-Datenbank' : 'Ausgaben-App · Daten nur auf diesem Gerät';
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
  if (name === 'konto' && typeof Konto !== 'undefined') Konto.render();
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
  f.private.checked = !!(exp && exp.private);
  f.person.innerHTML = state.settings.persons.map((p) => `<option>${esc(p)}</option>`).join('');
  f.person.value = exp ? exp.person : state.settings.me;
  chosenCat = exp ? exp.category : null;
  renderChips($('#catChips'), chosenCat, (id) => { chosenCat = id; });
  $('#deleteExpenseBtn').hidden = !exp;
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
function openSubDialog(sub) {
  const f = $('#subForm');
  editingSubId = sub ? sub.id : null;
  f.name.value = sub ? sub.name : '';
  f.amount.value = sub ? String(sub.amount).replace('.', ',') : '';
  f.interval.value = sub ? sub.interval : 'month';
  f.category.innerHTML = state.categories.map((c) => `<option value="${esc(c.id)}">${esc(c.emoji)} ${esc(c.name)}</option>`).join('');
  f.category.value = sub ? sub.category : (state.categories.some((c) => c.id === 'abos') ? 'abos' : state.categories[0].id);
  f.start.value = sub ? sub.start : monthKey(viewY, viewM);
  f.payer.innerHTML = '<option value="">Gemeinsam / Gemeinschaftskonto</option>' + state.settings.persons.map((p) => `<option>${esc(p)}</option>`).join('');
  f.payer.value = sub && sub.payer ? sub.payer : '';
  $('#deleteSubBtn').hidden = !sub;
  $('#subDialog').showModal();
}

// ---------- Automatische Erfassung (Kurzbefehl / Link) ----------
let lastCapturedId = null;
let capturedTimer = null;

function handleIncomingUrl() {
  const params = new URLSearchParams(location.search);
  const rawAmount = params.get('betrag') ?? params.get('amount');
  if (rawAmount == null) return;

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
    const data = { name: f.name.value.trim(), amount, interval: f.interval.value, category: f.category.value, start: f.start.value, payer: f.payer.value };
    if (editingSubId) Object.assign(state.subs.find((s) => s.id === editingSubId), data);
    else state.subs.push({ id: uid(), ...data });
    save(); render(); $('#subDialog').close();
  });
  $('#cancelSubBtn').onclick = () => $('#subDialog').close();
  $('#deleteSubBtn').onclick = () => {
    if (!editingSubId || !confirm('Dieses Abo löschen?')) return;
    state.subs = state.subs.filter((s) => s.id !== editingSubId);
    save(); render(); $('#subDialog').close();
  };
  $('#addSubBtn').onclick = () => openSubDialog(null);

  $('#searchInput').addEventListener('input', renderList);
  $('#filterCat').addEventListener('change', renderList);
  $('#filterPerson').addEventListener('change', renderList);

  // Einstellungen
  $('#setIncome').addEventListener('change', (e) => { const v = parseAmount(e.target.value); state.settings.income = Number.isFinite(v) ? v : 0; save(); render(); });
  $('#setBudget').addEventListener('change', (e) => { const v = parseAmount(e.target.value); state.settings.budget = Number.isFinite(v) ? v : 0; save(); render(); });
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
    if (k === 'budget') { const v = parseAmount(e.target.value); c.budget = Number.isFinite(v) ? v : 0; }
    else c[k] = e.target.value.trim() || c[k];
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

  $('#capturedOk').onclick = () => { $('#capturedSheet').hidden = true; };
  $('#capturedUndo').onclick = () => {
    state.expenses = state.expenses.filter((e) => e.id !== lastCapturedId);
    save(); render(); $('#capturedSheet').hidden = true; toast('Rückgängig gemacht');
  };

  // Daten in anderem Tab geändert (z. B. Kurzbefehl hat neuen Tab geöffnet)
  window.addEventListener('storage', (e) => { if (e.key === STORAGE_KEY) { state = load(); render(); } });
}

// ---------- Start ----------
bind();
handleIncomingUrl();
handleInviteHash();
window.addEventListener('hashchange', handleInviteHash);
let startView = 'overview';
try { startView = sessionStorage.getItem('ausgaben-view') || 'overview'; } catch (e) { /* egal */ }
showView(startView);
render();
Sync.init();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
