// Netlify Function „bank“ – nutzt denselben geprüften Baustein wie die Supabase-Variante
// (supabase/functions/bank/index.ts): nur lesender Kontoabruf über Enable Banking.
// Benötigte Umgebungsvariablen (Netlify → Site → Environment variables, „Secret“ markieren):
//   EB_APP_ID, EB_PRIVATE_KEY, BANK_ACCESS_TOKEN, ALLOWED_ORIGIN (= Adresse der App)
import { handler } from '../../supabase/functions/bank/index.ts';

export default (req) => handler(req);
export const config = { path: '/api/bank' };
