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
  if (req.method !== 'OPTIONS') { const deny = await denyIfNoAccess(req); if (deny) return deny; }
  return handler(req);
};
export const config = { path: '/api/bank' };
