# 💶 Ausgaben – unser Haushaltsbuch

Eine kleine Web-App (PWA) fürs Handy, um gemeinsam die Ausgaben im Blick zu behalten –
inklusive **automatischer Erfassung, sobald mit dem iPhone (Apple Pay) bezahlt wird**.

- 📊 **Übersicht**: Einnahmen, Ausgaben, was übrig ist, Ausgaben pro Tag, Budget je Kategorie
- 🧾 **Ausgaben**: schnell erfassen, suchen, nach Kategorie/Person filtern, bearbeiten
- 🔁 **Abos & Fixkosten**: Miete, Handy, Netflix … werden jeden Monat automatisch mitgezählt
- 🏷️ **Automatische Kategorien**: REWE → Lebensmittel, Aral → Tanken … und die App lernt aus jeder Korrektur
- 👫 **Personen**: wer hat bezahlt?
- 💾 **Backup / CSV-Export** (für Excel oder Google Sheets), Import zum Zusammenführen
- 🌙 Hell/Dunkel, funktioniert offline, **keine Daten verlassen das Gerät**

## 1. App online stellen (GitHub Pages, einmalig)

1. Auf GitHub im Repository: **Settings → Pages**
2. *Source*: **Deploy from a branch**, Branch: `main`, Ordner: `/ (root)` → **Save**
3. Nach ca. 1 Minute ist die App erreichbar unter
   `https://<dein-github-name>.github.io/ausgaben-app/`

> Hinweis: Bei privaten Repositories braucht GitHub Pages ein kostenpflichtiges Konto.
> Alternativ das Repo öffentlich machen (es enthält keine persönlichen Daten – die liegen nur auf dem Handy)
> oder einen kostenlosen Dienst wie Netlify/Cloudflare Pages nutzen.

Zum lokalen Ausprobieren: `python3 -m http.server` im Ordner starten und `http://localhost:8000` öffnen.

## 2. Automatisch erfassen beim Bezahlen mit dem iPhone

iOS hat in der App **Kurzbefehle** eine Automation **„Transaktion“**: Sie startet jedes Mal,
wenn du mit einer Karte in Apple Wallet bezahlst (iPhone oder Apple Watch) und liefert
**Betrag** und **Händler** mit. Diese schicken wir per Link an die App.

1. In der Ausgaben-App: **Einstellungen → „Link für den Kurzbefehl“ → Link kopieren**
   (sieht so aus: `https://…/ausgaben-app/?betrag=BETRAG&haendler=HAENDLER&person=Ich`)
2. App **Kurzbefehle** → **Automation** → **+** → **Transaktion**
3. Karte(n) auswählen, **Sofort ausführen** → **Weiter** → **Neuer leerer Kurzbefehl**
4. Aktionen hinzufügen:
   1. **URL kodieren** – Eingabe: Variable *Kurzbefehl-Eingabe → Händler*
   2. **Text** – kopierten Link einfügen, dann `BETRAG` durch *Kurzbefehl-Eingabe → Betrag*
      und `HAENDLER` durch *URL-kodierter Text* ersetzen
   3. **URLs öffnen** – Eingabe: *Text*
5. Fertig! Beim nächsten Bezahlen öffnet sich die App kurz, zeigt **„Erfasst ✓“** und du kannst
   die Kategorie mit einem Tipp korrigieren (die App merkt sich das für diesen Händler).

Mit **Einstellungen → „Test: Zahlung simulieren“** kannst du das Ganze vorab ausprobieren.

### ⚠️ Wichtig: Safari vs. Home-Bildschirm
Kurzbefehle öffnen Links immer in **Safari**. Auf dem iPhone hat eine zum Home-Bildschirm
hinzugefügte Web-App aber einen **eigenen, getrennten Speicher**. Damit alle Einträge an einem Ort
landen, die App am besten **in Safari** nutzen (als Favorit/Lesezeichen speichern).

### Android
Google Wallet bietet keine solche Automation. Mit Apps wie **MacroDroid** oder **Tasker** lässt sich
die Zahlungsbenachrichtigung von Google Wallet auslesen und derselbe Link öffnen
(`?betrag=…&haendler=…`).

## 3. Zu zweit nutzen
Jedes Handy speichert seine eigenen Daten. Zum Zusammenführen:
**Einstellungen → Backup exportieren** auf dem einen Handy, auf dem anderen **Backup importieren → OK (zusammenführen)**.
Unter „Dieses Gerät gehört“ einstellen, wer das Handy nutzt – dann werden Zahlungen automatisch der richtigen Person zugeordnet.

> Mögliche Erweiterung: automatische Synchronisation zwischen beiden Handys über einen kleinen
> Cloud-Speicher (z. B. Supabase oder Firebase).

## Link-Parameter (für eigene Automationen)

| Parameter  | Bedeutung                              | Beispiel        |
|------------|----------------------------------------|-----------------|
| `betrag`   | Betrag (Pflicht), Komma oder Punkt     | `12,50 €`       |
| `haendler` | Händler / Beschreibung                 | `REWE`          |
| `person`   | Person (muss in den Einstellungen existieren) | `Ich`    |
| `karte`    | Karte (wird als Notiz gespeichert)     | `Visa`          |
| `datum`    | Datum `JJJJ-MM-TT` (Standard: heute)   | `2026-11-06`    |

## Dateien
`index.html` · `style.css` · `app.js` (gesamte Logik) · `sw.js` (Offline) · `manifest.webmanifest` · Icons
