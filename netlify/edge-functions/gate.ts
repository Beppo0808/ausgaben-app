// Zugangssperre vor der gesamten App (wie bei der Gesundheitsakte):
// Ohne gültigen Zugang wird weder die App noch der Speicher ausgeliefert – nur die Einladungsseite.
import { verify, readCookie, COOKIE, PUBLIC_PATHS } from '../lib/gate-core.mjs';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

function page(next: string): string {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Haushaltsbuch</title><link rel="apple-touch-icon" href="/icon-180.png">
<link rel="stylesheet" href="/gate.css"></head><body><div class="karte">
<img src="/icon-180.png" alt=""><h1>Haushaltsbuch</h1>
<p>Diese App ist nur für eingeladene Personen. Bitte öffne den Einladungslink, den du bekommen hast.</p>
<form id="invite"><input class="text" id="link" placeholder="Einladungslink hier einfügen" autocomplete="off" autocapitalize="off" spellcheck="false"><button>Öffnen</button></form>
<details><summary>Anmeldung für den Inhaber</summary>
<form method="post" action="/api/gate/login" id="login"><input type="hidden" name="next" value="${esc(next)}">
<input class="text" type="password" name="passwort" placeholder="Inhaber-Passwort" autocomplete="current-password"><button>Anmelden</button></form></details>
<p class="fehler" id="msg"></p><p class="klein">© 2026 Beppo0808 · Nur für eingeladene Personen</p></div>
<script src="/gate.js"></script></body></html>`;
}

export default async (req: Request, context: { next: () => Promise<Response> }) => {
  const url = new URL(req.url);
  if (PUBLIC_PATHS.some((r) => r.test(url.pathname))) return context.next();
  // @ts-ignore Netlify-Laufzeit
  const secret = (globalThis.Netlify?.env?.get('GATE_SECRET') ?? '') as string;
  if (!secret) return context.next(); // Sperre noch nicht eingerichtet
  const s = await verify(readCookie(req, COOKIE), secret, 's');
  if (s) return context.next();
  const headers = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' };
  if (url.pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'Kein Zugang – bitte Einladungslink öffnen' }), { status: 401, headers: { ...headers, 'Content-Type': 'application/json' } });
  }
  return new Response(page(url.pathname + url.search), { status: 401, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
};

export const config = { path: '/*' };
