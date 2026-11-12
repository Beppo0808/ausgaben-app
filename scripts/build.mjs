// Kopiert nur die App-Dateien nach dist/ (keine Quelltexte, README o. Ä. werden veröffentlicht)
// und schaltet den eigenen, verschlüsselten Abgleich über /api/sync ein.
import fs from 'node:fs';
const files = ['index.html', 'style.css', 'app.js', 'sync.js', 'konto.js', 'receipt.js', 'shop.js', 'recipes-data.js', 'scanner.js', 'lock.js', 'sw.js', 'manifest.webmanifest',
  'icon.svg', 'gate.js', 'gate.css', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'fonts/fraunces-latin.woff2', 'fonts/nunito-latin.woff2'];
fs.rmSync('dist', { recursive: true, force: true });
fs.mkdirSync('dist/fonts', { recursive: true });
for (const f of files) fs.copyFileSync(f, `dist/${f}`);
const html = fs.readFileSync('dist/index.html', 'utf8');
if (!html.includes('<meta name="sync-backend" content="">')) throw new Error('sync-backend-Meta fehlt');
fs.writeFileSync('dist/index.html', html.replace('<meta name="sync-backend" content="">', '<meta name="sync-backend" content="self">'));
console.log('dist/ erstellt:', files.length, 'Dateien');
