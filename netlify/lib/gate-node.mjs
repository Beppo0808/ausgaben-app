// Zugangsprüfung für die Netlify-Funktionen (Node): Signatur + „gesperrt?“-Liste aus Netlify Blobs.
import { webcrypto } from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { verify, readCookie, COOKIE } from './gate-core.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto; // ältere Node-Laufzeit

export const gateSecret = () => process.env.GATE_SECRET || '';
export const gateStore = () => getStore({ name: 'ausgaben-gate', consistency: 'strong' });

let cache = { at: 0, people: null };
export async function people() {
  if (cache.people && Date.now() - cache.at < 3000) return cache.people; // Sperren wirkt nach spätestens 3 s
  const list = (await gateStore().get('people', { type: 'json' })) || [];
  cache = { at: Date.now(), people: list };
  return list;
}
export async function savePeople(list) { await gateStore().setJSON('people', list); cache = { at: Date.now(), people: list }; }

/** Gültige, nicht gesperrte Sitzung – oder null */
export async function session(req) {
  const secret = gateSecret();
  if (!secret) return null; // ohne Geheimnis lieber gesperrt als offen
  const s = await verify(readCookie(req, COOKIE), secret, 's');
  if (!s) return null;
  const p = (await people()).find((x) => x.id === s.id);
  if (p && p.revoked) return null;
  return s;
}

/** Für API-Funktionen: liefert eine 401-Antwort, wenn kein Zugang besteht */
export async function denyIfNoAccess(req) {
  try {
    if (await session(req)) return null;
  } catch { /* Speicher nicht erreichbar → sicherheitshalber ablehnen */ }
  return new Response(JSON.stringify({ error: 'Kein Zugang' }), { status: 401, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
