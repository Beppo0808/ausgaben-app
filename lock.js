/* App-Sperre pro Gerät: eigene PIN + optional Face ID / Touch ID (WebAuthn, Gerätesperre des iPhones).
 *
 * - Jede Person schützt ihr eigenes Gerät. Es gibt kein gemeinsames Passwort.
 * - Die PIN wird nie gespeichert, nur ein gesalzener PBKDF2-Hash (200.000 Runden).
 * - Face ID läuft komplett über das iPhone (Apple); die App bekommt nur „erfolgreich“ oder „abgebrochen“.
 * - Nach Fehlversuchen steigt die Wartezeit.
 * - Eine Zahlung per Kurzbefehl wird auch im gesperrten Zustand erfasst; angezeigt wird dann nur dieser Eintrag.
 *
 * Wird vor app.js geladen.
 */
'use strict';

const Lock = (() => {
  const KEY = 'ausgaben-lock-v1';
  const AUTO_LOCK_MIN = 5;
  let cfg = read();
  let unlocked = false;
  let entry = '';
  let hiddenAt = 0;
  let setupMode = null; // { step: 'new' | 'repeat', first: '' }
  let autoTried = false;  // Face ID pro Sperrvorgang nur einmal automatisch starten
  let skipAuto = false;   // z. B. wenn gerade eine Zahlung erfasst wurde
  let bioRunning = false;

  function read() { try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch (e) { return null; } }
  function write() { try { cfg ? localStorage.setItem(KEY, JSON.stringify(cfg)) : localStorage.removeItem(KEY); } catch (e) { /* egal */ } }
  const enabled = () => !!(cfg && cfg.hash && cfg.salt);
  const $l = (s) => document.querySelector(s);
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function hashPin(pin, saltB64) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(saltB64), iterations: 200000 }, base, 256);
    return b64(bits);
  }
  function eq(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }

  // ---------- Face ID (WebAuthn, nur lokale Bestätigung) ----------
  const bioSupported = async () => {
    try { return !!(window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); }
    catch (e) { return false; }
  };
  async function bioRegister() {
    const name = (typeof state !== 'undefined' && state.settings.me) || 'Ich';
    const cred = await navigator.credentials.create({
      publicKey: {
        rp: { name: 'Haushaltsbuch', id: location.hostname },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name, displayName: name },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
        timeout: 60000, attestation: 'none',
      },
    });
    cfg.bio = b64(cred.rawId); write();
  }
  async function bioUnlock() {
    if (!cfg || !cfg.bio) return false;
    try {
      const a = await navigator.credentials.get({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          allowCredentials: [{ type: 'public-key', id: unb64(cfg.bio) }],
          userVerification: 'required', timeout: 60000, rpId: location.hostname,
        },
      });
      return !!(a && a.response && a.response.authenticatorData);
    } catch (e) { return false; }
  }

  // ---------- Anzeige ----------
  function dots() {
    const n = setupMode ? Math.max(4, entry.length) : (cfg.len || 6);
    $l('#lockDots').innerHTML = Array.from({ length: n }, (_, i) => `<span class="${i < entry.length ? 'on' : ''}"></span>`).join('');
  }
  function setMsg(t, warn) { const m = $l('#lockMsg'); m.textContent = t || ''; m.classList.toggle('warn', !!warn); }

  function show() {
    unlocked = false;
    entry = '';
    document.body.classList.add('locked');
    const me = (typeof state !== 'undefined' && state.settings.me) || '';
    $l('#lockName').textContent = me ? `Haushaltsbuch · ${me}` : 'Haushaltsbuch';
    $l('#lockAvatar').textContent = (me || 'H').charAt(0).toUpperCase();
    $l('#lockScreen').hidden = false;
    $l('#lockBio').hidden = !cfg.bio;
    $l('#lockForgot').hidden = false;
    $l('#lockTitle').textContent = 'Bitte entsperren';
    setMsg(waitText());
    dots();
    autoTried = false;
    setTimeout(autoBio, 350);
  }

  /** Face ID automatisch starten; klappt es nicht, bleibt die PIN-Eingabe */
  async function autoBio() {
    if (!cfg || !cfg.bio || unlocked || setupMode || skipAuto || autoTried || bioRunning) return;
    if (document.visibilityState !== 'visible') return; // beim Zurückkehren erneut versuchen
    if (cfg.waitUntil && cfg.waitUntil > Date.now()) return;
    autoTried = true;
    await tryBio(true);
  }
  async function tryBio(auto) {
    if (bioRunning) return;
    bioRunning = true;
    setMsg('Face ID …');
    const ok = await bioUnlock();
    bioRunning = false;
    if (ok) { cfg.fails = 0; cfg.waitUntil = 0; write(); hide(); afterUnlock(); return; }
    setMsg(auto ? 'Bitte PIN eingeben (Face ID war nicht möglich)' : 'Face ID abgebrochen – bitte PIN eingeben');
  }
  function hide() {
    unlocked = true;
    document.body.classList.remove('locked');
    $l('#lockScreen').hidden = true;
    entry = '';
  }
  function waitText() {
    const until = cfg && cfg.waitUntil ? cfg.waitUntil - Date.now() : 0;
    return until > 0 ? `Zu viele Fehlversuche – bitte ${Math.ceil(until / 1000)} s warten` : '';
  }

  async function submit() {
    if (setupMode) return setupStep();
    if (cfg.waitUntil && cfg.waitUntil > Date.now()) { setMsg(waitText(), true); entry = ''; dots(); return; }
    const h = await hashPin(entry, cfg.salt);
    if (eq(h, cfg.hash)) { cfg.fails = 0; cfg.waitUntil = 0; write(); hide(); afterUnlock(); return; }
    cfg.fails = (cfg.fails || 0) + 1;
    if (cfg.fails >= 5) cfg.waitUntil = Date.now() + Math.min(15 * 60, 30 * 2 ** (cfg.fails - 5)) * 1000;
    write();
    entry = ''; dots();
    $l('#lockDots').classList.remove('shake'); void $l('#lockDots').offsetWidth; $l('#lockDots').classList.add('shake');
    setMsg(cfg.waitUntil > Date.now() ? waitText() : `Falsche PIN (${cfg.fails}. Versuch)`, true);
  }

  function press(d) {
    if (d === 'del') { entry = entry.slice(0, -1); dots(); return; }
    if (entry.length >= 8) return;
    entry += d; dots();
    if (!setupMode && entry.length === (cfg.len || 6)) submit();
  }

  // ---------- Einrichten / Ändern ----------
  function startSetup() {
    setupMode = { step: 'new', first: '' };
    entry = '';
    $l('#lockScreen').hidden = false;
    document.body.classList.add('locked');
    $l('#lockBio').hidden = true;
    $l('#lockForgot').hidden = true;
    $l('#lockTitle').textContent = 'Neue PIN festlegen (4–8 Ziffern)';
    $l('#lockOk').hidden = false;
    $l('#lockCancel').hidden = false;
    setMsg('Nur für dieses Gerät – niemand sonst kennt sie.');
    dots();
  }
  async function setupStep() {
    if (entry.length < 4) { setMsg('Mindestens 4 Ziffern', true); return; }
    if (setupMode.step === 'new') {
      if (/^(\d)\1+$/.test(entry) || '0123456789'.includes(entry) || '9876543210'.includes(entry)) { setMsg('Bitte keine zu einfache PIN (z. B. 1111 oder 1234)', true); entry = ''; dots(); return; }
      setupMode = { step: 'repeat', first: entry };
      entry = ''; $l('#lockTitle').textContent = 'PIN wiederholen'; setMsg(''); dots(); return;
    }
    if (entry !== setupMode.first) { setupMode = { step: 'new', first: '' }; entry = ''; $l('#lockTitle').textContent = 'Neue PIN festlegen (4–8 Ziffern)'; setMsg('Die PINs stimmten nicht überein – bitte neu', true); dots(); return; }
    const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
    const keepBio = cfg && cfg.bio;
    cfg = { salt, hash: await hashPin(entry, salt), len: entry.length, bio: keepBio || '', fails: 0, waitUntil: 0 };
    write();
    setupMode = null;
    $l('#lockOk').hidden = true; $l('#lockCancel').hidden = true;
    hide();
    toast('🔐 PIN gespeichert');
    if (!keepBio && await bioSupported() && confirm('Zusätzlich mit Face ID / Touch ID entsperren?')) {
      try { await bioRegister(); toast('Face ID eingerichtet ✓'); } catch (e) { toast('Face ID nicht eingerichtet'); }
    }
    if (typeof renderSettings === 'function') renderSettings();
  }
  function cancelSetup() {
    setupMode = null; entry = '';
    $l('#lockOk').hidden = true; $l('#lockCancel').hidden = true;
    if (enabled()) hide(); else { document.body.classList.remove('locked'); $l('#lockScreen').hidden = true; }
  }

  function forgot() {
    if (!confirm('PIN vergessen?\n\nAus Sicherheitsgründen kann die PIN nicht angezeigt werden. Du kannst dieses Gerät zurücksetzen: Alle Daten auf DIESEM Gerät werden gelöscht. Gemeinsame Ausgaben kommen danach über euren Einladungslink zurück, private Einträge und Kontodaten auf diesem Gerät gehen verloren.')) return;
    if (!confirm('Wirklich alle Daten auf diesem Gerät löschen?')) return;
    try { localStorage.clear(); sessionStorage.clear(); } catch (e) { /* egal */ }
    location.replace(location.pathname);
  }

  let afterUnlockCb = null;
  function afterUnlock() { if (afterUnlockCb) { const cb = afterUnlockCb; afterUnlockCb = null; cb(); } }

  function bind() {
    $l('#lockPad').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-k]');
      if (!b) return;
      press(b.dataset.k);
      if (navigator.vibrate) navigator.vibrate(5);
    });
    document.addEventListener('keydown', (e) => {
      if ($l('#lockScreen').hidden) return;
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('del');
      else if (e.key === 'Enter') submit();
    });
    $l('#lockOk').onclick = submit;
    $l('#lockCancel').onclick = cancelSetup;
    $l('#lockForgot').onclick = forgot;
    $l('#lockBio').onclick = () => tryBio(false);
    document.addEventListener('visibilitychange', () => {
      if (!enabled()) return;
      if (document.visibilityState === 'hidden') hiddenAt = Date.now();
      else if (unlocked && hiddenAt && Date.now() - hiddenAt > AUTO_LOCK_MIN * 60000) show();
      else if (!unlocked) setTimeout(autoBio, 350);
    });
    // Countdown bei Wartezeit aktualisieren
    setInterval(() => { if (!$l('#lockScreen').hidden && cfg && cfg.waitUntil > Date.now()) setMsg(waitText(), true); }, 1000);
  }

  function init() {
    bind();
    if (enabled()) show(); else unlocked = true;
  }

  return {
    init, enabled, startSetup, isUnlocked: () => unlocked || !enabled(), lockNow: () => { if (enabled()) show(); },
    hasBio: () => !!(cfg && cfg.bio), bioSupported,
    async enableBio() { if (!enabled()) return; try { await bioRegister(); toast('Face ID eingerichtet ✓'); } catch (e) { toast('Face ID nicht eingerichtet'); } },
    disableBio() { if (cfg) { cfg.bio = ''; write(); } },
    disable() { cfg = null; write(); },
    onUnlock(cb) { afterUnlockCb = cb; },
    skipAutoBio() { skipAuto = true; },
    allowAutoBio() { skipAuto = false; setTimeout(autoBio, 200); },
    refreshName() { if (!unlocked && enabled()) { const me = (typeof state !== 'undefined' && state.settings.me) || ''; $l('#lockName').textContent = me ? `Haushaltsbuch · ${me}` : 'Haushaltsbuch'; $l('#lockAvatar').textContent = (me || 'H').charAt(0).toUpperCase(); } },
  };
})();
