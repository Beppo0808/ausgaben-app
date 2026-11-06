# 💶 Ausgaben – unser Haushaltsbuch

Eine kleine Web-App (PWA) fürs Handy, um gemeinsam die Ausgaben im Blick zu behalten –
inklusive **automatischer Erfassung, sobald mit dem iPhone (Apple Pay) bezahlt wird**.

- 📊 **Übersicht**: Einnahmen, Ausgaben, was übrig ist, Ausgaben pro Tag, Budget je Kategorie
- 🧾 **Ausgaben**: schnell erfassen, suchen, nach Kategorie/Person filtern, bearbeiten
- 🔁 **Abos & Fixkosten**: Miete, Handy, Netflix … werden jeden Monat automatisch mitgezählt
- 🏷️ **Automatische Kategorien**: REWE → Lebensmittel, Aral → Tanken … und die App lernt aus jeder Korrektur
- 👫 **Personen**: wer hat bezahlt?
- 🔒 **Privat bleibt privat**: eigenes Einkommen, private Ausgaben und Kontobewegungen bleiben nur auf dem eigenen Gerät
- 🧾 **Kassenbon scannen**: Foto vom Bon → Laden, Datum, Summe und Artikel mit Preisen werden erkannt (auf dem Gerät)
- 🏦 **Mein Konto**: Kontoumsätze per CSV-Export aus dem Online-Banking ansehen (nur lesen), einzelne Ausgaben per Tipp ins Haushaltsbuch übernehmen
- ☁️ **Synchronisation** zwischen allen iPhones und iPads (über euer eigenes, kostenloses Supabase-Projekt)
- 💾 **Backup / CSV-Export** (für Excel, Numbers oder Google Sheets)
- 🌙 Hell/Dunkel, iPad-Ansicht, funktioniert offline

## Schritt für Schritt einrichten

Am einfachsten am **iPad** (größerer Bildschirm). Dauert ca. 15 Minuten, nur einmal nötig.

### Schritt 1 – App online stellen (GitHub Pages)
1. Auf github.com dieses Repository öffnen → **Settings** → links **Pages**
2. *Source*: **Deploy from a branch**
3. *Branch*: `claude/expense-tracking-mobile-payment-baq52q` (oder `main`, wenn übernommen), Ordner `/ (root)` → **Save**
4. Nach 1–2 Minuten erscheint oben die Adresse, z. B. `https://beppo0808.github.io/ausgaben-app/`

> Bei einem **privaten** Repository braucht GitHub Pages ein kostenpflichtiges Konto. Dann das Repo auf
> **öffentlich** stellen (Settings → General → ganz unten „Change visibility“). Das ist unbedenklich:
> Im Repo liegt nur der Programmcode – eure Ausgaben, Schlüssel und der Haushalts-Code stehen dort nie.

### Schritt 2 – Kostenlose Datenbank für die Synchronisation (Supabase)
1. Auf **supabase.com** → **Start your project** → mit GitHub anmelden
2. **New project**: Name z. B. `ausgaben`, ein Datenbank-Passwort vergeben (wird später nicht gebraucht),
   Region **Central EU (Frankfurt)** → **Create new project**, ca. 2 Minuten warten
3. Links **SQL Editor** → **New query** → den kompletten Inhalt der Datei
   [`supabase.sql`](supabase.sql) einfügen (auf GitHub die Datei öffnen → Kopieren-Symbol) → **Run**.
   Es muss „Success. No rows returned“ erscheinen.
4. Oben auf **Connect** bzw. links **Project Settings → API Keys** und **Data API**: zwei Werte notieren:
   - **Project URL** (`https://xxxx.supabase.co`)
   - **Publishable key** (`sb_publishable_…`) – oder bei älteren Projekten der **anon public** Key (`eyJ…`)

   ⚠️ Niemals den **secret** / **service_role** Key verwenden.

> Kostenloser Tarif: reicht für ein Haushaltsbuch dauerhaft. Wird ein Projekt eine Woche gar nicht benutzt,
> pausiert Supabase es – im Dashboard dann einfach auf „Restore“ tippen. Bei täglicher Nutzung passiert das nicht.

### Schritt 3 – Ersten Haushalt anlegen (auf einem Gerät)
1. Die App-Adresse aus Schritt 1 in **Safari** öffnen
2. **Einstellungen → Personen**: eure Namen eintragen, z. B. `Anna, Tom`; bei „Dieses Gerät gehört“ den eigenen Namen wählen
3. Einnahmen, Gesamtbudget und Budgets je Kategorie anpassen
4. **☁️ Gemeinsam nutzen**: Project URL und Key einfügen → **Haushalt erstellen** → Punkt wird grün „Synchronisiert“
5. **Einladungslink kopieren** → per AirDrop/iMessage an die anderen Geräte schicken

### Schritt 4 – Weitere Geräte verbinden (zweites iPhone, iPads)
1. Den Einladungslink auf dem Gerät antippen → öffnet Safari → „Verbinden?“ **OK**
2. Auf iPhones bei „Dieses Gerät gehört“ den eigenen Namen wählen (iPads: egal)
3. **Optional als App auf den Home-Bildschirm**: in Safari *Teilen → Zum Home-Bildschirm*. Die Home-Bildschirm-App
   hat einen eigenen Speicher – dort einmal **Einstellungen → Ich habe einen Einladungslink** → Link einfügen → **Verbinden**.

> Der Einladungslink ist wie ein Passwort zu euren Daten – nur innerhalb der Familie teilen.

### Schritt 5 – Automatisch erfassen beim Bezahlen (auf jedem iPhone)
iOS hat in der App **Kurzbefehle** eine Automation **„Transaktion“**: Sie startet bei jeder Zahlung mit Apple Pay
(iPhone oder Apple Watch) und liefert **Betrag** und **Händler**.

1. In der Ausgaben-App (Safari): **Einstellungen → Automatisch erfassen → Link kopieren**
   (`https://…/ausgaben-app/?betrag=BETRAG&haendler=HAENDLER&person=Anna`)
2. App **Kurzbefehle** → unten **Automation** → **+** (bzw. „Neue Automation“) → **Transaktion**
3. Karte(n) auswählen, **Sofort ausführen** → **Weiter** → **Neuer leerer Kurzbefehl**
4. Aktionen hinzufügen (oben in der Suche eintippen):
   1. **URL kodieren** – auf „Text“ tippen → Variable *Kurzbefehl-Eingabe* → dort **Händler** wählen
   2. **Text** – den kopierten Link einfügen. Das Wort `BETRAG` löschen und stattdessen die Variable
      *Kurzbefehl-Eingabe → Betrag* einsetzen; `HAENDLER` löschen und *URL-kodierter Text* einsetzen
   3. **URLs öffnen** – Eingabe: *Text*
5. **Fertig**. Mit **Einstellungen → „Test: Zahlung simulieren“** könnt ihr die App vorab testen.

Beim nächsten Bezahlen öffnet sich die App kurz, zeigt **„Erfasst ✓“**, und die Ausgabe ist sofort auf allen Geräten.
Mit einem Tipp lässt sich die Kategorie korrigieren – die App merkt sich das für diesen Händler.

## Datenschutz – wer kann was sehen?

| Was | Wo | Wer kann es sehen |
|---|---|---|
| Programmcode (dieses Repository) | GitHub, öffentlich | jeder – enthält **keine** persönlichen Daten |
| Webseite `…github.io/ausgaben-app` | GitHub Pages, öffentlich | jeder – zeigt aber nur eine **leere** App, eure Daten liegen dort nicht |
| Eure gemeinsamen Ausgaben | auf euren Geräten + **verschlüsselt** in eurem Supabase-Projekt | nur Geräte mit eurem Einladungslink |
| Einkommen, private Ausgaben, Kontoumsätze | nur auf dem eigenen Gerät | nur ihr selbst |

- **Ende-zu-Ende-Verschlüsselung (AES-256):** Alles wird schon auf dem iPhone/iPad verschlüsselt, bevor es in die
  Cloud geht. Supabase (und jeder, der sich Zugang zum Supabase-Konto verschafft) sieht nur unlesbare Daten –
  nicht einmal Händlernamen, Beträge oder eure Namen.
- Der **Schlüssel steckt nur im Einladungslink** und auf euren Geräten. Ihn nur untereinander teilen (AirDrop/iMessage).
  Wer den Link nicht hat, kommt nicht an die Daten.
- Empfehlung: Für GitHub und Supabase die **Zwei-Faktor-Anmeldung** einschalten.

## Was wird geteilt – und was nicht?

| Geteilt mit allen Geräten im Haushalt | Bleibt nur auf deinem Gerät 🔒 |
|---|---|
| Gemeinsame Ausgaben, Abos & Fixkosten | Dein Einkommen |
| Haushaltsbudget, Kategorien, Personen | Ausgaben mit Haken „Privat“ |
| Händler-Regeln (Auto-Kategorie) | Alles unter „Mein Konto“ (Kontoumsätze) |

**Private Zahlungen automatisch erkennen:** Legt im Kurzbefehl für eure *private* Karte eine eigene
Transaktions-Automation an und hängt an den Link `&privat=1` an. Zahlungen mit der Haushalts-/Gemeinschaftskarte
landen dann im gemeinsamen Buch, die mit der privaten Karte nur bei euch. Im „Erfasst ✓“-Fenster lässt sich
jede Zahlung zusätzlich per Tipp auf privat/gemeinsam umschalten.

> Hinweis: Kurzbefehle öffnen Safari. Private Einträge liegen daher im Speicher von Safari – nutzt die App für
> den privaten Teil am besten auch in Safari.

## Kassenbon scannen 🧾
1. **Ausgaben → 🧾 Kassenbon scannen** (oder im „+“-Dialog oben rechts)
2. Bon glatt hinlegen, gut beleuchten, Foto aufnehmen oder aus den Fotos wählen
3. Die App liest **Laden, Datum, Summe und alle Artikel mit Preis** aus – prüfen, ggf. korrigieren, **Speichern**

- Die Texterkennung läuft **direkt auf dem Gerät** (Tesseract.js). Das Foto wird weder hochgeladen noch gespeichert –
  nur Laden, Datum, Summe und Artikel. Beim allerersten Scan wird die Texterkennung einmalig geladen (ca. 5 MB).
- Wurde die Zahlung schon per Handy erfasst (gleicher Betrag, gleicher Tag), schlägt die App vor, die Artikel
  **dort** zu hinterlegen – so gibt es keine doppelte Buchung, und Person/Uhrzeit bleiben erhalten.
- Die Suche in „Ausgaben“ findet auch Artikel, z. B. „Kaffee“ → *Kaffee Crema 1kg 12,99 € bei ALDI*.
- Artikel lassen sich jederzeit über die Ausgabe → **🧾 Artikel bearbeiten** ändern oder nachträglich hinzufügen.

## Mein Konto (Kontoumsätze ansehen)
1. Im Online-Banking (in Safari) zu **Umsätze** → Zeitraum wählen → **Export als CSV**
2. In der App **🏦 Mein Konto → Umsätze importieren (CSV)** → Datei aus „Downloads“ wählen → Kontoname eingeben
3. Mehrfach importieren ist kein Problem, doppelte Buchungen werden erkannt.

Erkannt werden u. a. Sparkasse, Volksbank/Raiffeisen, ING, DKB, comdirect, Commerzbank, Postbank, N26.
Die Umsätze werden **nie** synchronisiert und sind auch nicht im Backup enthalten.

## iPad
Funktioniert genauso (Safari oder Home-Bildschirm) und zeigt auf dem großen Bildschirm eine zweispaltige Übersicht.
Die automatische Erfassung beim Bezahlen gibt es nur auf dem **iPhone** (bzw. der Apple Watch), weil man nur damit
im Laden bezahlt – die Einträge erscheinen per Synchronisation aber sofort auch auf den iPads.

## Wie die Synchronisation funktioniert
- Jede Ausgabe, jedes Abo, jede Kategorie usw. wird einzeln übertragen; bei gleichzeitigen Änderungen gewinnt die neuere.
- Ohne Internet wird lokal gespeichert und später automatisch nachsynchronisiert.
- Abgleich bei jedem Speichern, beim Öffnen der App und alle 30 Sekunden, solange sie offen ist.
- „Daten auf diesem Gerät löschen“ trennt das Gerät zuerst – die gemeinsamen Daten bleiben erhalten.
- Die Datenbank liegt in **eurem eigenen** Supabase-Projekt. Ohne Haushalts-Code kann niemand die Daten lesen.

## Link-Parameter (für eigene Automationen)

| Parameter  | Bedeutung                              | Beispiel        |
|------------|----------------------------------------|-----------------|
| `betrag`   | Betrag (Pflicht), Komma oder Punkt     | `12,50 €`       |
| `haendler` | Händler / Beschreibung                 | `REWE`          |
| `person`   | Person (muss in den Einstellungen existieren) | `Ich`    |
| `karte`    | Karte (wird als Notiz gespeichert)     | `Visa`          |
| `datum`    | Datum `JJJJ-MM-TT` (Standard: heute)   | `2026-11-06`    |

## Dateien
`index.html` · `style.css` · `app.js` (App-Logik) · `sync.js` (Synchronisation) · `konto.js` (Kontoumsätze) · `receipt.js` (Kassenbon-Scan) · `supabase.sql` (Datenbank-Setup) · `sw.js` (Offline) · `manifest.webmanifest` · Icons
