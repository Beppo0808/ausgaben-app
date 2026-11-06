/* Synchronisation zwischen Geräten über Supabase (siehe supabase.sql).
 *
 * Prinzip: Jede Ausgabe, jedes Abo, jede Kategorie, jede Händler-Regel und die
 * gemeinsamen Einstellungen sind ein eigener Datensatz. Bei jedem Speichern wird
 * erkannt, was sich geändert hat (Hash-Vergleich); nur das wird hochgeladen.
 * Bei Konflikten gewinnt die neuere Änderung. Gelöschtes wird als „gelöscht“ markiert.
 *
 * Ende-zu-Ende-verschlüsselt: Aus dem geheimen Haushalts-Code (nur in euren Geräten und im
 * Einladungslink) werden lokal abgeleitet:
 *   - die Haushalts-Kennung für den Server (SHA-256, der Code selbst verlässt nie das Gerät)
 *   - ein AES-256-GCM-Schlüssel. Inhalte UND Kennungen der Einträge werden verschlüsselt bzw.
 *     gehasht hochgeladen. Supabase sieht nur unlesbare Daten.
 *
 * Wird vor app.js geladen; nutzt dessen globale `state`, `save`, `render`, `toast`.
 */
'use strict';

const Sync = (() => {
  const KEY = 'ausgaben-sync-v1';
  const PAGE = 1000;
  let cfg = readCfg();
  if (cfg && cfg.e2e !== 2) cfg = null; // alte, unverschlüsselte Verbindung nicht weiterverwenden
  let keys = null; // { code, hid, aes }
  let pushTimer = null;
  let running = null;
  let again = false;
  let status = { state: 'off', text: 'Nicht verbunden' };
  const listeners = [];

  function readCfg() {
    try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch (e) { return null; }
  }
  function writeCfg() {
    try { cfg ? localStorage.setItem(KEY, JSON.stringify(cfg)) : localStorage.removeItem(KEY); } catch (e) { /* voll */ }
  }
  // „self“ = eigener Speicher auf demselben Server wie die App (Netlify, /api/sync) – ohne URL/Schlüssel
  const SELF = 'self';
  const selfAvailable = () => document.querySelector('meta[name="sync-backend"]')?.content === SELF;
  const enabled = () => !!(cfg && cfg.url && cfg.household && (cfg.url === SELF || cfg.key));

  function setStatus(s, text) {
    status = { state: s, text };
    listeners.forEach((fn) => { try { fn(status); } catch (e) { /* egal */ } });
  }

  // FNV-1a – kurzer Hash, um Änderungen zu erkennen
  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36) + ':' + str.length;
  }

  /** Alle synchronisierbaren Datensätze als Map "art:id" → Daten */
  function items() {
    const m = {};
    state.expenses.forEach((e) => { if (!e.private) m['expense:' + e.id] = e; }); // private Ausgaben bleiben auf dem Gerät
    state.subs.forEach((s) => { m['sub:' + s.id] = s; });
    state.categories.forEach((c) => { m['category:' + c.id] = c; });
    const { me, income, ...shared } = state.settings; // Gerät-Besitzer und eigenes Einkommen bleiben lokal
    m['settings:main'] = shared;
    Object.entries(state.rules).forEach(([k, v]) => { m['rule:' + k] = { cat: v }; });
    return m;
  }

  /** Vergleicht mit dem letzten Stand, markiert Änderungen. */
  function diff() {
    if (!enabled()) return false;
    const m = items();
    const now = Date.now();
    let changed = false;
    for (const [k, v] of Object.entries(m)) {
      const h = hash(JSON.stringify(v));
      if (cfg.hashes[k] !== h) { cfg.hashes[k] = h; cfg.mtimes[k] = now; cfg.dirty[k] = 1; changed = true; }
    }
    for (const k of Object.keys(cfg.hashes)) {
      if (!(k in m)) { delete cfg.hashes[k]; cfg.mtimes[k] = now; cfg.dirty[k] = 1; changed = true; }
    }
    writeCfg();
    return changed;
  }

  async function rpc(name, body, opts = {}) {
    let res;
    if (cfg.url === SELF) {
      res = await fetch('/api/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fn: name, ...body }), keepalive: !!opts.keepalive,
      });
    } else {
      const headers = { apikey: cfg.key, 'Content-Type': 'application/json' };
      if (!cfg.key.startsWith('sb_')) headers.Authorization = 'Bearer ' + cfg.key; // alter „anon“-Schlüssel (JWT)
      res = await fetch(cfg.url.replace(/\/+$/, '') + '/rest/v1/rpc/' + name, {
        method: 'POST', headers, body: JSON.stringify(body), keepalive: !!opts.keepalive,
      });
    }
    if (!res.ok) {
      let msg = res.status + ' ' + res.statusText;
      try { const j = await res.json(); msg = j.message || j.msg || j.error || msg; } catch (e) { /* egal */ }
      throw new Error(msg);
    }
    return res.json();
  }

  function splitKey(k) { const i = k.indexOf(':'); return [k.slice(0, i), k.slice(i + 1)]; }

  // ---------- Verschlüsselung ----------
  const enc8 = new TextEncoder();
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const sha = async (s) => hex(await crypto.subtle.digest('SHA-256', enc8.encode(s)));

  async function getKeys(code = cfg.household) {
    if (keys && keys.code === code) return keys;
    if (!crypto.subtle) throw new Error('Verschlüsselung nicht verfügbar (nur über https möglich)');
    const base = await crypto.subtle.importKey('raw', enc8.encode(code), 'HKDF', false, ['deriveKey']);
    const aes = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: enc8.encode('ausgaben-app/e2e/v1'), info: enc8.encode('daten') },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    keys = { code, aes, hid: await sha('ausgaben-app/haushalt/v1|' + code) };
    return keys;
  }
  /** Nicht umkehrbare Kennung eines Eintrags für den Server */
  async function remoteId(kind, id) {
    return (await sha(`${cfg.household}|${kind}|${id}`)).slice(0, 40);
  }
  async function encrypt(obj) {
    const { aes } = await getKeys();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, enc8.encode(JSON.stringify(obj)));
    const all = new Uint8Array(iv.length + ct.byteLength);
    all.set(iv); all.set(new Uint8Array(ct), iv.length);
    return { e: b64(all) };
  }
  async function decrypt(data) {
    if (!data || typeof data.e !== 'string') return null;
    const { aes } = await getKeys();
    const all = unb64(data.e);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, aes, all.slice(12));
    return JSON.parse(new TextDecoder().decode(pt));
  }

  async function push(opts) {
    const keys = Object.keys(cfg.dirty);
    if (!keys.length) return;
    const m = items();
    for (let i = 0; i < keys.length; i += 500) {
      const slice = keys.slice(i, i + 500);
      const batch = await Promise.all(slice.map(async (k) => {
        const [kind, id] = splitKey(k);
        const del = !(k in m);
        // Auch bei Löschungen die (verschlüsselte) lokale Kennung mitschicken, damit andere Geräte wissen, was weg ist
        return { kind, id: await remoteId(kind, id), data: await encrypt({ i: id, d: del ? null : m[k] }), deleted: del, mtime: cfg.mtimes[k] || Date.now(), _k: k };
      }));
      const { hid } = await getKeys();
      await rpc('sync_push', { p_household: hid, p_items: batch.map(({ _k, ...b }) => b) }, opts);
      batch.forEach((b) => { if (cfg.mtimes[b._k] === b.mtime) delete cfg.dirty[b._k]; });
      writeCfg();
    }
  }

  function applyRow(r) {
    const k = r.kind + ':' + r.id;
    const local = cfg.mtimes[k];
    if (local !== undefined && Number(r.mtime) <= local) return false; // lokal ist gleich/neuer
    cfg.mtimes[k] = Number(r.mtime);
    delete cfg.dirty[k];
    const listFor = { expense: 'expenses', sub: 'subs', category: 'categories' }[r.kind];
    if (listFor) {
      const arr = state[listFor];
      const idx = arr.findIndex((x) => x.id === r.id);
      if (idx > -1 && arr[idx].private) return true; // lokal privat gemacht → nicht überschreiben
      if (r.deleted) { if (idx > -1) arr.splice(idx, 1); }
      else {
        const obj = { ...r.data, id: r.id };
        if (idx > -1) arr[idx] = obj; else arr.push(obj);
      }
    } else if (r.kind === 'settings' && !r.deleted && r.data) {
      const { budget, persons } = r.data; // Einkommen wird bewusst NICHT übernommen
      if (budget !== undefined) state.settings.budget = budget;
      if (Array.isArray(persons) && persons.length) {
        state.settings.persons = persons;
        if (!persons.includes(state.settings.me)) state.settings.me = persons[0];
      }
    } else if (r.kind === 'rule') {
      if (r.deleted || !r.data) delete state.rules[r.id]; else state.rules[r.id] = r.data.cat;
    }
    return true;
  }

  async function pull() {
    let cursor = cfg.lastPull || '1970-01-01T00:00:00Z';
    const applied = new Set();
    let rows;
    const { hid } = await getKeys();
    do {
      rows = await rpc('sync_pull', { p_household: hid, p_since: cursor });
      for (const r of rows) {
        let payload;
        try { payload = await decrypt(r.data); } catch (e) { payload = null; }
        if (!payload || typeof payload.i !== 'string') continue; // nicht lesbar (falscher Schlüssel o. Ä.)
        const row = { kind: r.kind, id: payload.i, data: payload.d, mtime: r.mtime, deleted: r.deleted };
        if (applyRow(row)) applied.add(row.kind + ':' + row.id);
      }
      if (rows.length) cursor = rows[rows.length - 1].updated_at;
    } while (rows.length >= PAGE);
    // 30 s Überlappung, falls gleichzeitige Uploads minimal versetzt gespeichert werden
    const t = new Date(cursor).getTime();
    if (Number.isFinite(t)) cfg.lastPull = new Date(Math.max(0, t - 30000)).toISOString();
    if (applied.size) {
      const m = items();
      applied.forEach((k) => { if (k in m) cfg.hashes[k] = hash(JSON.stringify(m[k])); else delete cfg.hashes[k]; });
    }
    writeCfg();
    return applied.size;
  }

  /** Hochladen + Abholen. Läuft nie doppelt gleichzeitig. */
  async function syncNow() {
    if (!enabled()) return;
    if (running) { again = true; return running; }
    running = (async () => {
      setStatus('busy', 'Synchronisiere …');
      try {
        diff();
        await push();
        const n = await pull();
        if (n) { save(); render(); }
        cfg.lastOk = new Date().toISOString(); writeCfg();
        setStatus('ok', 'Synchronisiert ' + new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }));
      } catch (e) {
        console.warn('Sync-Fehler', e);
        setStatus('error', navigator.onLine === false ? 'Offline – wird später synchronisiert' : 'Fehler: ' + e.message);
      } finally {
        running = null;
        if (again) { again = false; syncNow(); }
      }
    })();
    return running;
  }

  /** Von app.js nach jedem Speichern aufgerufen */
  function onSave() {
    if (!enabled()) return;
    if (diff()) {
      clearTimeout(pushTimer);
      pushTimer = setTimeout(syncNow, 800);
    }
  }

  function randomCode() {
    const b = new Uint8Array(18);
    crypto.getRandomValues(b);
    return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function normalizeUrl(u) {
    if (u === SELF) return SELF;
    u = String(u || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
    if (u && !/^https?:\/\//.test(u)) u = 'https://' + u;
    return u;
  }

  /** Neuen gemeinsamen Haushalt anlegen – lädt die Daten dieses Geräts hoch */
  async function create(url, key) {
    cfg = { e2e: 2, url: normalizeUrl(url), key: String(key || '').trim(), household: randomCode(), lastPull: null, hashes: {}, mtimes: {}, dirty: {} };
    writeCfg();
    try {
      const { hid } = await getKeys();
      await rpc('sync_pull', { p_household: hid, p_since: '1970-01-01T00:00:00Z' }); // Verbindung testen
    } catch (e) {
      cfg = null; writeCfg();
      throw new Error('Verbindung fehlgeschlagen (' + e.message + '). URL, Schlüssel und SQL-Setup prüfen.');
    }
    await syncNow();
    if (status.state === 'error') throw new Error(status.text);
  }

  /** Bestehendem Haushalt beitreten. keepLocal: Einträge dieses Geräts mitnehmen */
  async function join(info, keepLocal) {
    const prev = cfg;
    cfg = { e2e: 2, url: normalizeUrl(info.u), key: String(info.k || '').trim(), household: info.h, lastPull: null, hashes: {}, mtimes: {}, dirty: {} };
    try {
      if (!keepLocal) { state.expenses = []; state.subs = []; state.rules = {}; }
      await pull(); // Daten des Haushalts gewinnen (lokal hat noch keine Zeitstempel)
      writeCfg();
      save(); // markiert nur noch lokal neue Einträge → werden hochgeladen
      render();
      await syncNow();
    } catch (e) {
      cfg = prev; writeCfg();
      throw new Error('Beitritt fehlgeschlagen: ' + e.message);
    }
  }

  function disconnect() {
    clearTimeout(pushTimer);
    cfg = null; writeCfg();
    setStatus('off', 'Nicht verbunden');
  }

  function inviteLink() {
    if (!enabled()) return '';
    const extra = typeof Konto !== 'undefined' && Konto.bankToken() ? { b: Konto.bankToken() } : {};
    const base = cfg.url === SELF ? { u: SELF, h: cfg.household } : { u: cfg.url, k: cfg.key, h: cfg.household };
    const payload = btoa(unescape(encodeURIComponent(JSON.stringify({ ...base, ...extra }))))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return location.origin + location.pathname + '#verbinden=' + payload;
  }

  function parseInvite(text) {
    const m = String(text || '').match(/verbinden=([A-Za-z0-9_-]+)/);
    if (!m) return null;
    try {
      const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
      const info = JSON.parse(decodeURIComponent(escape(atob(b64))));
      return info && info.u && (info.u === SELF || info.k) && info.h && String(info.h).length >= 20 ? info : null;
    } catch (e) { return null; }
  }

  function init() {
    // Mehrere Tabs (z. B. jeder Kurzbefehl öffnet einen neuen): Stand gemeinsam halten
    window.addEventListener('storage', (e) => {
      if (e.key !== KEY) return;
      cfg = readCfg();
      if (cfg && cfg.e2e !== 2) cfg = null;
      if (!cfg) setStatus('off', 'Nicht verbunden');
    });
    if (enabled()) {
      setStatus('idle', 'Verbunden');
      syncNow();
    }
    setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 30000);
    document.addEventListener('visibilitychange', () => {
      if (!enabled()) return;
      if (document.visibilityState === 'visible') syncNow();
      else if (Object.keys(cfg.dirty).length) push({ keepalive: true }).catch(() => {});
    });
    window.addEventListener('online', () => syncNow());
  }

  return {
    init, onSave, syncNow, create, join, disconnect, inviteLink, parseInvite, enabled, selfAvailable,
    usesSelf: () => !!(cfg && cfg.url === SELF),
    household: () => (cfg ? cfg.household : ''),
    status: () => status,
    pending: () => (cfg ? Object.keys(cfg.dirty).length : 0),
    onStatus: (fn) => listeners.push(fn),
  };
})();
