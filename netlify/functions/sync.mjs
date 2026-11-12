// Netlify Function „sync“ – Speicher für den Abgleich zwischen euren Geräten (Netlify Blobs).
//
// Sicherheit:
//  - Hier kommen NUR Ende-zu-Ende-verschlüsselte Daten an ({ e: "…" }). Netlify kann sie nicht lesen.
//  - Die Haushalts-Kennung ist ein SHA-256-Wert aus eurem geheimen Haushalts-Code (der Code selbst kommt nie hier an).
//    Ohne den Einladungslink kann niemand eure Daten abrufen oder entschlüsseln.
//  - Es wird nichts protokolliert.
//
// Aufbau: Jede Änderung wird als neuer, unveränderlicher Eintrag „<haushalt>/log/<zeit>-<zufall>“ abgelegt
// (kein Überschreiben → keine Konflikte zwischen gleichzeitig speichernden Geräten). Ältere Einträge werden
// gelegentlich zu einem Schnappschuss zusammengefasst. Die Geräte lösen Konflikte selbst (neuere Änderung gewinnt).
import { getStore } from '@netlify/blobs';
import { denyIfNoAccess } from '../lib/gate-node.mjs';
import { randomBytes } from 'node:crypto';

const KINDS = new Set(['expense', 'sub', 'category', 'settings', 'rule', 'shop', 'recipe']);
const HID = /^[0-9a-f]{64}$/;
const PAGE = 1000;
const MAX_BODY = 2_000_000;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});
const stamp = (ms) => String(ms).padStart(15, '0');
const keyTime = (key) => Number(key.split('/log/')[1].slice(0, 15));
const store = () => getStore({ name: 'ausgaben-sync', consistency: 'strong' });

async function push(hid, items) {
  if (!Array.isArray(items) || items.length > 1000) return json({ error: 'Ungültige Daten' }, 400);
  const clean = [];
  for (const i of items) {
    if (!i || !KINDS.has(i.kind) || typeof i.id !== 'string' || i.id.length < 1 || i.id.length > 200) continue;
    const mtime = Number(i.mtime);
    if (!Number.isFinite(mtime)) continue;
    const data = i.data && typeof i.data.e === 'string' ? { e: i.data.e } : null; // nur verschlüsselte Inhalte
    clean.push({ kind: i.kind, id: i.id, data, mtime, deleted: !!i.deleted });
  }
  if (!clean.length) return json(0);
  const now = Date.now();
  const rand = randomBytes(5).toString('hex');
  await store().setJSON(`${hid}/log/${stamp(now)}-${rand}`, clean);
  return json(clean.length);
}

/** Viele alte Einträge zu einem Schnappschuss zusammenfassen (neuere Änderung je Eintrag gewinnt) */
async function compact(s, hid, keys) {
  const cutoff = Date.now() - 24 * 3600e3;
  const old = keys.filter((k) => keyTime(k) < cutoff);
  if (old.length < 200) return;
  const merged = new Map();
  for (const k of old) {
    const rows = (await s.get(k, { type: 'json' })) || [];
    for (const r of rows) {
      const id = `${r.kind}:${r.id}`;
      const cur = merged.get(id);
      if (!cur || r.mtime >= cur.mtime) merged.set(id, r);
    }
  }
  const last = old[old.length - 1];
  await s.setJSON(`${hid}/log/${stamp(keyTime(last))}-snapshot`, [...merged.values()]);
  for (const k of old) if (k !== `${hid}/log/${stamp(keyTime(last))}-snapshot`) await s.delete(k);
}

async function pull(hid, since) {
  const sinceMs = Date.parse(since || '1970-01-01T00:00:00Z');
  if (!Number.isFinite(sinceMs)) return json({ error: 'Ungültiger Zeitpunkt' }, 400);
  const s = store();
  const { blobs } = await s.list({ prefix: `${hid}/log/` });
  const keys = blobs.map((b) => b.key).sort();
  const rows = [];
  for (const k of keys) {
    const t = keyTime(k);
    if (t <= sinceMs) continue;
    const batch = (await s.get(k, { type: 'json' })) || [];
    const updated_at = new Date(t).toISOString();
    for (const r of batch) rows.push({ ...r, updated_at });
    if (rows.length >= PAGE) break; // Rest beim nächsten Abruf
  }
  if (keys.length > 400) compact(s, hid, keys).catch(() => {});
  return json(rows);
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Nur POST erlaubt' }, 405);
  const deny = await denyIfNoAccess(req); if (deny) return deny;
  const len = Number(req.headers.get('content-length') || 0);
  if (len > MAX_BODY) return json({ error: 'Zu groß' }, 413);
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Ungültige Anfrage' }, 400); }
  const hid = String(body.p_household || '');
  if (!HID.test(hid)) return json({ error: 'Haushalts-Kennung ungültig' }, 400);
  try {
    if (body.fn === 'sync_push') return await push(hid, body.p_items);
    if (body.fn === 'sync_pull') return await pull(hid, body.p_since);
    return json({ error: 'Unbekannte Aktion' }, 400);
  } catch {
    return json({ error: 'Speicher vorübergehend nicht erreichbar' }, 503);
  }
};

export const config = { path: '/api/sync' };
