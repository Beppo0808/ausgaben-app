// Produktseite (Link) lesen: Name, Marke, Strichcode und Bild – nur für angemeldete Haushaltsmitglieder.
// Schutz: nur https, keine internen Adressen, Größen- und Zeitgrenzen, nur Bilddateien werden zurückgegeben.
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { denyIfNoAccess } from '../lib/gate-node.mjs';

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const MAX_HTML = 1_500_000, MAX_IMG = 1_500_000;

function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const x = ip.toLowerCase();
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80') || x.startsWith('::ffff:');
}
async function safeUrl(raw) {
  let u; try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
  if (net.isIP(u.hostname) || /(^|\.)(localhost|internal|local)$/i.test(u.hostname)) return null;
  try { const addrs = await lookup(u.hostname, { all: true }); if (!addrs.length || addrs.some((a) => privateIp(a.address))) return null; } catch { return null; }
  return u;
}
/** Abruf mit Grenzen; Weiterleitungen werden einzeln geprüft */
async function get(raw, max, accept) {
  let url = raw;
  for (let hop = 0; hop < 4; hop++) {
    const u = await safeUrl(url); if (!u) throw new Error('Adresse nicht erlaubt');
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(u, { redirect: 'manual', signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Haushaltsbuch)', Accept: accept } });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { url = new URL(r.headers.get('location'), u).toString(); continue; }
      if (!r.ok) throw new Error('Seite antwortet nicht (' + r.status + ')');
      const reader = r.body.getReader(); const parts = []; let n = 0;
      for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length; if (n > max) { ctl.abort(); throw new Error('zu groß'); } parts.push(value); }
      return { buf: Buffer.concat(parts), type: r.headers.get('content-type') || '', url: u.toString() };
    } finally { clearTimeout(t); }
  }
  throw new Error('Zu viele Weiterleitungen');
}
const dec = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).trim();
const meta = (html, name) => { const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, 'i')); const c = m && m[0].match(/content=["']([^"']*)["']/i); return c ? dec(c[1]) : ''; };

export default async (req) => {
  const deny = await denyIfNoAccess(req); if (deny) return deny;
  const target = new URL(req.url).searchParams.get('url') || '';
  try {
    const page = await get(target, MAX_HTML, 'text/html,application/xhtml+xml');
    const html = page.buf.toString('utf8');
    // Produktdaten (schema.org) bevorzugen, sonst Vorschau-Angaben der Seite
    let prod = null;
    for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const j = JSON.parse(m[1]); const all = [].concat(j, j['@graph'] || []);
        prod = all.find((x) => x && /product/i.test([].concat(x['@type'] || []).join(' '))) || prod;
      } catch { /* weiter */ }
      if (prod) break;
    }
    const name = dec((prod && prod.name) || meta(html, 'og:title') || (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '').slice(0, 100);
    const brand = dec(prod && (typeof prod.brand === 'string' ? prod.brand : prod.brand && prod.brand.name) || '').slice(0, 40);
    const ean = String((prod && (prod.gtin13 || prod.gtin || prod.gtin8 || prod.gtin12)) || '').replace(/\D/g, '').slice(0, 14);
    let imgUrl = prod && [].concat(prod.image || [])[0]; if (imgUrl && typeof imgUrl === 'object') imgUrl = imgUrl.url;
    imgUrl = imgUrl || meta(html, 'og:image') || meta(html, 'twitter:image');
    let image = '';
    if (imgUrl) {
      try {
        const im = await get(new URL(imgUrl, page.url).toString(), MAX_IMG, 'image/*');
        const type = im.type.split(';')[0].trim();
        if (/^image\/(jpeg|png|webp)$/.test(type)) image = `data:${type};base64,${im.buf.toString('base64')}`;
      } catch { /* ohne Bild */ }
    }
    if (!name && !image) return json({ error: 'Auf der Seite wurden keine Produktdaten gefunden' }, 422);
    return json({ name, brand, ean, image });
  } catch (e) {
    return json({ error: e.message === 'Adresse nicht erlaubt' ? 'Dieser Link ist nicht erlaubt' : 'Seite konnte nicht gelesen werden' }, 400);
  }
};

export const config = { path: '/api/linkinfo' };
