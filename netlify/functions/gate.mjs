// Netlify Function „gate“ – Einladungen, Inhaber-Anmeldung und Zugänge verwalten.
//   GET  /einladung/<token>   Einladungslink öffnen → Zugang auf diesem Gerät (Cookie, 400 Tage)
//   POST /api/gate/login      Inhaber-Passwort (Formular) → Zugang als Inhaber
//   POST /api/gate/me         Wer bin ich?
//   POST /api/gate/invite     (Inhaber) Einladungslink erzeugen
//   POST /api/gate/people     (Inhaber) Zugänge auflisten
//   POST /api/gate/revoke     (Inhaber) Zugang sperren / wieder freigeben
//   POST /api/gate/password   (Inhaber) Inhaber-Passwort festlegen
//   POST /api/gate/logout     Auf diesem Gerät abmelden
import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { sign, verify, randomId, COOKIE } from '../lib/gate-core.mjs';
import { gateSecret, gateStore, people, savePeople, session } from '../lib/gate-node.mjs';

const MAX_AGE = 400 * 24 * 3600;
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });
const cookieHeader = (value, maxAge = MAX_AGE) => `${COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
const safeNext = (n) => (typeof n === 'string' && /^\/(?!\/)/.test(n) && !n.startsWith('/einladung/') ? n : '/');
const redirect = (loc, extra = {}) => new Response(null, { status: 302, headers: { Location: loc, 'Cache-Control': 'no-store', ...extra } });
const hashPw = (pw, salt) => pbkdf2Sync(pw, salt, 210000, 32, 'sha256');

async function newSession(person) {
  const all = await people();
  const p = all.find((x) => x.id === person.id);
  if (p) { p.lastSeen = new Date().toISOString(); p.devices = (p.devices || 0) + 1; }
  else all.push({ id: person.id, name: person.name, role: person.role, created: new Date().toISOString(), lastSeen: new Date().toISOString(), devices: 1, revoked: false });
  await savePeople(all);
  return sign({ t: 's', id: person.id, name: person.name, role: person.role, iat: Date.now() }, gateSecret());
}

export default async (req) => {
  const url = new URL(req.url);
  const secret = gateSecret();
  if (!secret) return json({ error: 'Zugangssperre ist nicht eingerichtet' }, 503);

  // Einladungslink öffnen
  if (url.pathname.startsWith('/einladung/')) {
    const token = decodeURIComponent(url.pathname.slice('/einladung/'.length));
    const inv = await verify(token, secret, 'i');
    if (!inv) return redirect('/?fehler=' + encodeURIComponent('Der Einladungslink ist ungültig oder abgelaufen – bitte einen neuen anfordern.'));
    const p = (await people()).find((x) => x.id === inv.id);
    if (p && p.revoked) return redirect('/?fehler=' + encodeURIComponent('Dieser Zugang wurde gesperrt.'));
    const s = await newSession(inv);
    return redirect(safeNext(url.searchParams.get('next')), { 'Set-Cookie': cookieHeader(s) });
  }

  if (req.method !== 'POST') return json({ error: 'Nur POST erlaubt' }, 405);
  const action = url.pathname.replace('/api/gate/', '');

  if (action === 'login') {
    const form = await req.formData().catch(() => null);
    const pw = String(form?.get('passwort') || '');
    const next = safeNext(String(form?.get('next') || '/'));
    const store = gateStore();
    const lock = (await store.get('loginlock', { type: 'json' })) || { fails: 0, until: 0 };
    const back = (msg) => redirect('/?fehler=' + encodeURIComponent(msg) + (next !== '/' ? '' : ''));
    if (lock.until > Date.now()) return back('Zu viele Fehlversuche – bitte in einigen Minuten erneut versuchen.');
    const owner = await store.get('owner', { type: 'json' });
    if (!owner) return back('Es ist noch kein Inhaber-Passwort festgelegt.');
    const ok = pw.length > 0 && timingSafeEqual(hashPw(pw, Buffer.from(owner.salt, 'base64')), Buffer.from(owner.hash, 'base64'));
    if (!ok) {
      lock.fails += 1;
      if (lock.fails >= 5) { lock.until = Date.now() + Math.min(60, 2 ** (lock.fails - 5)) * 60000; }
      await store.setJSON('loginlock', lock);
      await new Promise((r) => setTimeout(r, 800));
      return back('Passwort falsch.');
    }
    await store.setJSON('loginlock', { fails: 0, until: 0 });
    const s = await newSession({ id: 'inhaber', name: owner.name || 'Inhaber', role: 'owner' });
    return redirect(next, { 'Set-Cookie': cookieHeader(s) });
  }

  if (action === 'logout') return json({ ok: true }, 200, { 'Set-Cookie': cookieHeader('', 0) });

  const s = await session(req);
  if (!s || s.open) return json({ error: 'Kein Zugang' }, 401);
  if (action === 'me') return json({ id: s.id, name: s.name, role: s.role });
  if (s.role !== 'owner') return json({ error: 'Nur für den Inhaber' }, 403);

  const body = await req.json().catch(() => ({}));
  if (action === 'invite') {
    const name = String(body.name || '').replace(/[<>]/g, '').trim().slice(0, 30);
    if (!name) return json({ error: 'Bitte einen Namen angeben' }, 400);
    const days = Math.min(14, Math.max(1, Math.floor(Number(body.days) || 7)));
    const role = body.role === 'owner' ? 'owner' : 'member';
    const id = randomId();
    const token = await sign({ t: 'i', id, name, role, exp: Date.now() + days * 864e5 }, secret);
    const all = await people();
    all.push({ id, name, role, created: new Date().toISOString(), lastSeen: '', devices: 0, revoked: false, invitedUntil: new Date(Date.now() + days * 864e5).toISOString() });
    await savePeople(all);
    return json({ url: `${url.origin}/einladung/${token}`, days });
  }
  if (action === 'people') return json({ people: (await people()).map(({ id, name, role, created, lastSeen, devices, revoked, invitedUntil }) => ({ id, name, role, created, lastSeen, devices, revoked, invitedUntil, me: id === s.id })) });
  if (action === 'revoke') {
    const all = await people();
    const p = all.find((x) => x.id === body.id);
    if (!p) return json({ error: 'Unbekannt' }, 404);
    if (p.id === s.id) return json({ error: 'Den eigenen Zugang bitte nicht sperren' }, 400);
    p.revoked = body.revoked !== false;
    await savePeople(all);
    return json({ ok: true, revoked: p.revoked });
  }
  if (action === 'password') {
    const pw = String(body.password || '');
    if (pw.length < 10) return json({ error: 'Bitte mindestens 10 Zeichen' }, 400);
    const salt = randomBytes(16);
    await gateStore().setJSON('owner', { salt: salt.toString('base64'), hash: hashPw(pw, salt).toString('base64'), name: s.name, set: new Date().toISOString() });
    return json({ ok: true });
  }
  return json({ error: 'Unbekannte Aktion' }, 400);
};

export const config = { path: ['/einladung/*', '/api/gate/*'] };
