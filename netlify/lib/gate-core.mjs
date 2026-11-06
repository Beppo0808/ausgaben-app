// Gemeinsamer Kern der Zugangssperre (läuft in der Edge-Funktion und in den Funktionen).
// Zugangs-Cookies und Einladungslinks sind mit HMAC-SHA-256 signiert (Geheimnis: GATE_SECRET, nur bei Netlify).
// Ohne gültige Signatur kein Zugang – fälschen ist ohne das Geheimnis nicht möglich.

export const COOKIE = 'hb_zugang';
const enc = new TextEncoder();

const b64u = (bytes) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64u = (s) => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(t + '==='.slice((t.length + 3) % 4)), (c) => c.charCodeAt(0));
};
const hmacKey = (secret) => crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

export async function sign(obj, secret) {
  const p = b64u(enc.encode(JSON.stringify(obj)));
  const s = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(p)));
  return `${p}.${b64u(s)}`;
}

/** Prüft Signatur und Ablauf. Liefert den Inhalt oder null. */
export async function verify(token, secret, type) {
  if (!token || !secret || token.length > 2000) return null;
  const [p, s] = String(token).split('.');
  if (!p || !s) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64u(s), enc.encode(p));
    if (!ok) return null;
    const o = JSON.parse(new TextDecoder().decode(fromB64u(p)));
    if (type && o.t !== type) return null;
    if (o.exp && Date.now() > o.exp) return null;
    return o;
  } catch { return null; }
}

export function readCookie(req, name = COOKIE) {
  const c = req.headers.get('cookie') || '';
  const m = c.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : '';
}

export const randomId = () => b64u(crypto.getRandomValues(new Uint8Array(12)));

/** Pfade, die ohne Zugang erreichbar sein müssen (Einladung, Anmeldung, Symbole, Schriften) */
export const PUBLIC_PATHS = [/^\/einladung\//, /^\/api\/gate\//, /^\/fonts\//, /^\/icon[-.]/, /^\/manifest\.webmanifest$/, /^\/gate\.(css|js)$/, /^\/favicon/];
