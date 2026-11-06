// Netlify Function „files“ – Ablage für Kassenbon-Bilder (Netlify Blobs).
//
// Sicherheit:
//  - Bilder werden schon auf dem iPhone mit eurem Haushalts-Schlüssel verschlüsselt (AES-256-GCM).
//    Hier kommt nur Zeichensalat an; Netlify kann die Bons nicht ansehen.
//  - Ablage unter <Haushalts-Kennung>/<zufällige ID>. Ohne beides findet niemand etwas.
//  - Private Bons werden gar nicht hochgeladen. Es wird nichts protokolliert.
import { getStore } from '@netlify/blobs';

const HID = /^[0-9a-f]{64}$/;
const FID = /^[0-9a-f]{32}$/;
const MAX = 6_000_000; // Zeichen (base64) ≈ 4,5 MB

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Nur POST erlaubt' }, 405);
  if (Number(req.headers.get('content-length') || 0) > MAX + 2000) return json({ error: 'Bild zu groß' }, 413);
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Ungültige Anfrage' }, 400); }
  const h = String(body.h || ''), id = String(body.id || '');
  if (!HID.test(h) || !FID.test(id)) return json({ error: 'Ungültige Kennung' }, 400);
  const store = getStore({ name: 'ausgaben-files', consistency: 'strong' });
  const key = `${h}/${id}`;
  try {
    if (body.fn === 'put') {
      const data = String(body.data || '');
      if (!data || data.length > MAX || !/^[A-Za-z0-9+/=]+$/.test(data)) return json({ error: 'Ungültige Daten' }, 400);
      await store.set(key, data);
      return json({ ok: true });
    }
    if (body.fn === 'get') {
      const data = await store.get(key);
      return data ? json({ data }) : json({ error: 'Nicht gefunden' }, 404);
    }
    if (body.fn === 'delete') { await store.delete(key); return json({ ok: true }); }
    return json({ error: 'Unbekannte Aktion' }, 400);
  } catch {
    return json({ error: 'Ablage vorübergehend nicht erreichbar' }, 503);
  }
};

export const config = { path: '/api/files' };
