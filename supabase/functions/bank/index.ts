// Supabase Edge Function „bank“ – NUR LESENDER Zugriff auf eure eigenen Konten über Enable Banking.
//
// Sicherheit:
//  - Der private Enable-Banking-Schlüssel liegt nur hier als Supabase-Secret (nie in der App, nie im Repository).
//  - Jede Anfrage braucht euren eigenen Zugangsschlüssel (Secret BANK_ACCESS_TOKEN) und kommt nur von eurer App-Adresse.
//  - Es gibt ausschließlich Lese-Funktionen (Bankliste, Anmeldung, Kontostand, Umsätze, Verbindung trennen).
//    Zahlungen/Überweisungen sind hier nicht eingebaut und damit technisch unmöglich.
//  - Es wird nichts gespeichert und nichts protokolliert. Daten werden nur durchgereicht.
//
// Benötigte Secrets (Supabase → Edge Functions → Secrets):
//   EB_APP_ID          Application ID aus dem Enable Banking Control Panel
//   EB_PRIVATE_KEY     Inhalt der .pem-Datei (privater Schlüssel)
//   BANK_ACCESS_TOKEN  Zugangsschlüssel, den die App erzeugt
//   ALLOWED_ORIGIN     https://beppo0808.github.io
// In den Einstellungen der Funktion „Verify JWT“ ausschalten – der Schutz erfolgt über BANK_ACCESS_TOKEN.

type Json = Record<string, unknown>;

const env = (k: string): string =>
  // deno-lint-ignore no-explicit-any
  ((globalThis as any).Deno?.env?.get(k) ?? (globalThis as any).process?.env?.[k] ?? '') as string;

const API = () => (env('EB_API_URL') || 'https://api.enablebanking.com').replace(/\/+$/, '');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

class HttpError extends Error {
  status: number;
  code = '';
  constructor(status: number, message: string, code = '') { super(message); this.status = status; this.code = code; }
}

// ---------- JWT (RS256) ----------
const b64url = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const enc = new TextEncoder();

function derLen(n: number): number[] {
  if (n < 128) return [n];
  const out: number[] = [];
  while (n > 0) { out.unshift(n & 255); n >>= 8; }
  return [0x80 | out.length, ...out];
}
/** „BEGIN RSA PRIVATE KEY“ (PKCS#1) in PKCS#8 umwandeln, damit WebCrypto ihn lesen kann */
function pkcs1ToPkcs8(pk1: Uint8Array): Uint8Array {
  const version = [0x02, 0x01, 0x00];
  const algId = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octet = [0x04, ...derLen(pk1.length)];
  const innerLen = version.length + algId.length + octet.length + pk1.length;
  const head = [0x30, ...derLen(innerLen), ...version, ...algId, ...octet];
  const out = new Uint8Array(head.length + pk1.length);
  out.set(head); out.set(pk1, head.length);
  return out;
}

let keyCache: { pem: string; key: CryptoKey } | null = null;
async function signingKey(): Promise<CryptoKey> {
  const pem = env('EB_PRIVATE_KEY').replace(/\\n/g, '\n');
  if (!pem.includes('PRIVATE KEY')) throw new HttpError(500, 'Bank-Zugang ist noch nicht eingerichtet (EB_PRIVATE_KEY fehlt).');
  if (keyCache && keyCache.pem === pem) return keyCache.key;
  const pkcs1 = pem.includes('BEGIN RSA PRIVATE KEY');
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  let der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  if (pkcs1) der = pkcs1ToPkcs8(der);
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  keyCache = { pem, key };
  return key;
}

let jwtCache: { token: string; exp: number } | null = null;
async function jwt(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (jwtCache && jwtCache.exp - 300 > now) return jwtCache.token;
  const appId = env('EB_APP_ID');
  if (!appId) throw new HttpError(500, 'Bank-Zugang ist noch nicht eingerichtet (EB_APP_ID fehlt).');
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: appId })));
  const exp = now + 3600;
  const payload = b64url(enc.encode(JSON.stringify({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: now, exp })));
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await signingKey(), enc.encode(`${header}.${payload}`)));
  const token = `${header}.${payload}.${b64url(sig)}`;
  jwtCache = { token, exp };
  return token;
}

async function eb(method: string, path: string, body?: Json): Promise<Json> {
  const res = await fetch(API() + path, {
    method,
    headers: { Authorization: 'Bearer ' + await jwt(), 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: Json = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* keine JSON-Antwort */ }
  if (!res.ok) {
    const msg = (data.message || data.error || data.code || `Bankdienst antwortet mit ${res.status}`) as string;
    const code = String(data.error || data.code || '').slice(0, 60);
    throw new HttpError(res.status === 401 || res.status === 403 ? 502 : res.status, String(msg).slice(0, 300), code);
  }
  return data;
}

// ---------- Hilfen ----------
function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
const num = (v: unknown): number => { const n = parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : 0; };

// ---------- Aktionen (nur lesend) ----------
async function act(body: Json, allowed: string): Promise<Json> {
  switch (body.action) {
    case 'banks': {
      const country = /^[A-Z]{2}$/.test(String(body.country || '')) ? String(body.country) : 'DE';
      const r = await eb('GET', `/aspsps?country=${country}&psu_type=personal`);
      const list = (r.aspsps as Json[] | undefined) || [];
      return {
        banks: list.map((a) => ({
          name: a.name, country: a.country, logo: a.logo || '',
          maxDays: Math.max(1, Math.floor(num(a.maximum_consent_validity || 7776000) / 86400)),
        })),
      };
    }
    case 'start': {
      const bank = String(body.bank || '').slice(0, 200);
      const country = /^[A-Z]{2}$/.test(String(body.country || '')) ? String(body.country) : 'DE';
      const redirect = String(body.redirect_url || '');
      const state = String(body.state || '');
      const days = Math.min(180, Math.max(1, Math.floor(num(body.days) || 90)));
      if (!bank) throw new HttpError(400, 'Bank fehlt');
      if (!redirect.startsWith(allowed + '/')) throw new HttpError(400, 'Rücksprung-Adresse nicht erlaubt');
      if (!/^[A-Za-z0-9_-]{16,80}$/.test(state)) throw new HttpError(400, 'Ungültiger Status');
      const r = await eb('POST', '/auth', {
        access: { valid_until: new Date(Date.now() + days * 86400000).toISOString() },
        aspsp: { name: bank, country },
        state, redirect_url: redirect, psu_type: 'personal', language: 'de',
      });
      return { url: r.url };
    }
    case 'session': {
      const code = String(body.code || '');
      if (!code || code.length > 2000) throw new HttpError(400, 'Code fehlt');
      const s = await eb('POST', '/sessions', { code });
      const accounts = ((s.accounts as Json[] | undefined) || []).map((a) => {
        const id = (a.account_id as Json | undefined) || {};
        return {
          uid: a.uid, name: a.name || a.product || 'Konto', iban: id.iban || '',
          currency: a.currency || 'EUR', type: a.cash_account_type || '',
        };
      });
      return {
        session_id: s.session_id,
        valid_until: (s.access as Json | undefined)?.valid_until || '',
        bank: (s.aspsp as Json | undefined)?.name || '',
        accounts,
      };
    }
    case 'balances': {
      const acc = String(body.account || '');
      if (!UUID.test(acc)) throw new HttpError(400, 'Ungültiges Konto');
      const r = await eb('GET', `/accounts/${acc}/balances`);
      return {
        balances: ((r.balances as Json[] | undefined) || []).map((b) => {
          const amt = (b.balance_amount as Json | undefined) || {};
          return { name: b.name || '', type: b.balance_type || '', amount: num(amt.amount), currency: amt.currency || 'EUR', date: b.reference_date || b.last_change_date_time || '' };
        }),
      };
    }
    case 'transactions': {
      const acc = String(body.account || '');
      if (!UUID.test(acc)) throw new HttpError(400, 'Ungültiges Konto');
      const q = new URLSearchParams();
      if (DATE.test(String(body.date_from || ''))) q.set('date_from', String(body.date_from));
      if (body.continuation_key) q.set('continuation_key', String(body.continuation_key).slice(0, 2000));
      const r = await eb('GET', `/accounts/${acc}/transactions${q.toString() ? '?' + q : ''}`);
      const tx = ((r.transactions as Json[] | undefined) || []).map((t) => {
        const amt = (t.transaction_amount as Json | undefined) || {};
        const debit = t.credit_debit_indicator === 'DBIT';
        const value = Math.abs(num(amt.amount)) * (debit ? -1 : 1);
        const party = (debit ? t.creditor : t.debtor) as Json | undefined;
        const info = t.remittance_information;
        return {
          id: String(t.entry_reference || t.transaction_id || ''),
          date: t.booking_date || t.value_date || t.transaction_date || '',
          amount: Math.round(value * 100) / 100,
          name: (party && party.name) || '',
          purpose: Array.isArray(info) ? info.join(' ') : String(info || ''),
          status: t.status || '',
        };
      });
      return { transactions: tx, next: r.continuation_key || null };
    }
    case 'end': {
      const sid = String(body.session_id || '');
      if (!UUID.test(sid)) throw new HttpError(400, 'Ungültige Sitzung');
      await eb('DELETE', `/sessions/${sid}`);
      return { ok: true };
    }
    default:
      throw new HttpError(400, 'Unbekannte Aktion');
  }
}

export async function handler(req: Request): Promise<Response> {
  const allowed = (env('ALLOWED_ORIGIN') || 'https://beppo0808.github.io').replace(/\/+$/, '');
  const headers = {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-bank-token, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  };
  const reply = (data: Json, status = 200) => new Response(JSON.stringify(data), { status, headers });
  if (req.method === 'OPTIONS') return new Response('ok', { headers });
  if (req.method !== 'POST') return reply({ error: 'Nur POST erlaubt' }, 405);

  const origin = req.headers.get('origin');
  if (origin && origin !== allowed) return reply({ error: 'Herkunft nicht erlaubt' }, 403);
  const expected = env('BANK_ACCESS_TOKEN');
  if (expected.length < 24) return reply({ error: 'Bank-Zugang ist noch nicht eingerichtet (BANK_ACCESS_TOKEN fehlt).' }, 500);
  if (!safeEqual(req.headers.get('x-bank-token') || '', expected)) return reply({ error: 'Zugangsschlüssel falsch' }, 401);

  let body: Json;
  try { body = await req.json(); } catch { return reply({ error: 'Ungültige Anfrage' }, 400); }
  try {
    return reply(await act(body, allowed));
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    const message = e instanceof HttpError ? e.message : 'Interner Fehler';
    const code = e instanceof HttpError ? e.code : '';
    return reply({ error: message, code }, status); // bewusst keine Protokollierung von Inhalten
  }
}

// deno-lint-ignore no-explicit-any
if ((globalThis as any).Deno?.serve) (globalThis as any).Deno.serve(handler);
