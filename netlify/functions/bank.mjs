// Netlify Function „bank“ – nutzt denselben geprüften Baustein wie die Supabase-Variante
// (supabase/functions/bank/index.ts): nur lesender Kontoabruf über Enable Banking.
// Benötigte Umgebungsvariablen (Netlify → Site → Environment variables, „Secret“ markieren):
//   EB_APP_ID, EB_PRIVATE_KEY, BANK_ACCESS_TOKEN, ALLOWED_ORIGIN (= Adresse der App)
import { webcrypto } from 'node:crypto';
import { handler } from '../../supabase/functions/bank/index.ts';

// Ältere Node-Laufzeiten haben kein globales „crypto“ – nachrüsten (für die Signatur der Bank-Anfragen)
if (!globalThis.crypto) globalThis.crypto = webcrypto;

import { denyIfNoAccess } from '../lib/gate-node.mjs';

export default async (req) => {
  if (req.method === 'OPTIONS') return handler(req);
  const deny = await denyIfNoAccess(req); if (deny) return deny;
  // Mit aktiver Zugangssperre ist die Person schon per Einladung angemeldet –
  // der zusätzliche Bank-Schlüssel wird dann hier auf dem Server ergänzt (nicht auf den Geräten).
  if (process.env.GATE_SECRET && process.env.BANK_ACCESS_TOKEN) {
    const headers = new Headers(req.headers);
    headers.set('x-bank-token', process.env.BANK_ACCESS_TOKEN);
    req = new Request(req, { headers, duplex: 'half' });
  }
  return handler(req);
};
export const config = { path: '/api/bank' };
