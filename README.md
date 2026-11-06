# 💶 Ausgaben – unser Haushaltsbuch

Eine kleine Web-App (PWA) fürs Handy, um gemeinsam die Ausgaben im Blick zu behalten –
inklusive **automatischer Erfassung, sobald mit dem iPhone (Apple Pay) bezahlt wird**.

- 📊 **Reine Ausgabenübersicht**: Ausgaben gesamt, Fixkosten, Alltag, Vergleich zum Vormonat, Ausgaben pro Tag und je Kategorie – ohne Budgets
- 🧾 **Ausgaben**: schnell erfassen, suchen, nach Kategorie/Person filtern, bearbeiten
- 🔁 **Abos & Fixkosten**: Miete, Handy, Netflix … werden jeden Monat automatisch mitgezählt
- 🏷️ **Automatische Kategorien**: REWE → Lebensmittel, Aral → Tanken … und die App lernt aus jeder Korrektur
- 👫 **Personen**: wer hat bezahlt?
- 🔒 **Privat bleibt privat**: private Ausgaben und Kontobewegungen bleiben nur auf dem eigenen Gerät
- 🧾 **Kassenbon erfassen** (Foto oder gescanntes PDF): Laden, Filiale, Datum, Uhrzeit, Artikel mit Preis und Kategorie, Bon als Bild – plus Preisverlauf je Artikel
- 🏦 **Kontostand direkt von der Bank** (nur lesend, per pushTAN freigegeben) – oder per CSV-Import
- 🏦 **Mein Konto**: Kontoumsätze per CSV-Export aus dem Online-Banking ansehen (nur lesen), einzelne Ausgaben per Tipp ins Haushaltsbuch übernehmen
- ☁️ **Synchronisation** zwischen allen iPhones und iPads (über euer eigenes, kostenloses Supabase-Projekt)
- 💾 **Backup / CSV-Export** (für Excel, Numbers oder Google Sheets)
- 👓 Augenschonend: warme helle Farben ohne Schwarz und ohne grelles Weiß, Helligkeit „Hell/Gedämpft“, Schriftgröße in 3 Stufen, iPad-Ansicht, funktioniert offline

## 🔐 App-Sperre: eigene PIN + Face ID pro Gerät
Jede Person schützt **ihr eigenes Gerät** (Einstellungen → 🔐 App-Sperre): eigene PIN (4–8 Ziffern) und optional
**Face ID / Touch ID**. Es gibt **kein gemeinsames Passwort** – niemand kennt die PIN des anderen.
- Die PIN wird nicht gespeichert, nur ein gesalzener PBKDF2-Hash; Face ID läuft über die Gerätesperre des iPhones.
- Sperrt beim Öffnen und nach 5 Minuten im Hintergrund; nach 5 Fehlversuchen steigende Wartezeit.
- Zahlungen per Kurzbefehl werden auch im gesperrten Zustand erfasst – angezeigt wird nur dieser eine Eintrag.
- PIN vergessen → Gerät zurücksetzen; gemeinsame Daten kommen per Einladungslink zurück.

## Betrieb auf Netlify
Die App läuft auf **Netlify** (`netlify.toml`, Build: `node scripts/build.mjs` → `dist/`):
- `netlify/functions/sync.mjs` – Speicher für den Abgleich (Netlify Blobs). Nimmt **nur verschlüsselte** Daten an.
  Damit entfällt Supabase; in der App genügt „👫 Gemeinsamen Haushalt erstellen“.
- `netlify/functions/bank.mjs` – optionaler Kontoabruf (Secrets als Umgebungsvariablen in Netlify).
- Strenge Sicherheits-Header (Content-Security-Policy, kein Einbetten, kein Referrer).

## Zwei Ansichten: 👫 Gemeinsam | 🔒 Persönlich
Oben in der App wählt jeder per Schalter seine Ansicht (das Gerät merkt sich die Wahl):

| 👫 Gemeinsam (Terrakotta) | 🔒 Persönlich (Salbei-Petrol) |
|---|---|
| Ausgaben gesamt, Fixkosten, Alltag | Meine Ausgaben gesamt, mein Anteil am Haushalt, privat |
| Wer hat bezahlt?, Kategorien, Tagesverlauf | Mein Beitrag zum Haushalt (Einkäufe, Fixkosten, Haushaltsgeld) |
| Reiter **Fixkosten** | Reiter **Mein Konto** (Kontoumsätze, nur auf dem Gerät) |
| Ausgabenliste: nur gemeinsame Einträge | Ausgabenliste: meine privaten + von mir bezahlten |

Neue Einträge in der persönlichen Ansicht sind automatisch **privat**.

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
3. Unter **👓 Darstellung** Helligkeit und Schriftgröße nach Wunsch einstellen
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
| Private Ausgaben, Kontoumsätze | nur auf dem eigenen Gerät | nur ihr selbst |

- **Ende-zu-Ende-Verschlüsselung (AES-256):** Alles wird schon auf dem iPhone/iPad verschlüsselt, bevor es in die
  Cloud geht. Supabase (und jeder, der sich Zugang zum Supabase-Konto verschafft) sieht nur unlesbare Daten –
  nicht einmal Händlernamen, Beträge oder eure Namen.
- Der **Schlüssel steckt nur im Einladungslink** und auf euren Geräten. Ihn nur untereinander teilen (AirDrop/iMessage).
  Wer den Link nicht hat, kommt nicht an die Daten.
- Empfehlung: Für GitHub und Supabase die **Zwei-Faktor-Anmeldung** einschalten.

## Was wird geteilt – und was nicht?

| Geteilt mit allen Geräten im Haushalt | Bleibt nur auf deinem Gerät 🔒 |
|---|---|
| Gemeinsame Ausgaben, Abos & Fixkosten | Alles unter „Mein Konto“ |
| Kategorien, Personen | Ausgaben mit Haken „Privat“ |
| Händler-Regeln (Auto-Kategorie) | |

**Private Zahlungen automatisch erkennen:** Legt im Kurzbefehl für eure *private* Karte eine eigene
Transaktions-Automation an und hängt an den Link `&privat=1` an. Zahlungen mit der Haushalts-/Gemeinschaftskarte
landen dann im gemeinsamen Buch, die mit der privaten Karte nur bei euch. Im „Erfasst ✓“-Fenster lässt sich
jede Zahlung zusätzlich per Tipp auf privat/gemeinsam umschalten.

> Hinweis: Kurzbefehle öffnen Safari. Private Einträge liegen daher im Speicher von Safari – nutzt die App für
> den privaten Teil am besten auch in Safari.

## Kassenbon erfassen 🧾
1. **Ausgaben → 📷 Kassenbon scannen** – die **Kamera öffnet sofort in der App** (eigener Scanner).
2. Bon in den Rahmen halten: Ist das Bild ruhig und scharf, **löst die App automatisch aus** (oder Auslöser tippen).
   Der Bon wird automatisch ausgeschnitten und **wie ein Scan aufbereitet** (weißer Hintergrund, klare Schrift).
   Lange Bons: weiter nach unten schieben → nächstes Stück wird aufgenommen und angehängt. Dann **✓ Fertig**.
   (Apples eigener Dokumentenscanner lässt sich aus einer Web-App nicht aufrufen – daher der eingebaute Scanner.
   Alternativ im Scanner **📄 Datei / Foto**, z. B. ein PDF aus „Dateien → Dokumente scannen“.)
3. Die App liest **Laden, Filiale (Adresse/Filialnummer), Datum, Uhrzeit, Summe** und **jeden Artikel mit Preis** –
   auch **Menge × Stückpreis** („2 x 0,49“) und **Gewicht** („1,234 kg x 1,24 EUR/kg“). Prüfen, ggf. korrigieren, **Speichern**.

- **Kategorie je Artikel:** Milch → Lebensmittel, Spülmittel/Toilettenpapier → Drogerie, Pfand → Sonstiges usw.
  Jede Kategorie ist im Prüf-Fenster änderbar; die App merkt sich das für den Artikel. Die Monatsauswertung
  verteilt den Bon auf diese Kategorien.
- **🥛 Artikel & Preise** (in „Ausgaben“): z. B. „Milch“ suchen → jeder Kauf mit Datum, Uhrzeit, Laden, Filiale,
  Person und Preis, dazu günstigster und teuerster Preis – über alle Monate.
- **Bon als Bild:** In jeder Ausgabe → **🧾 Bon als Bild ansehen**. Das Bild wird verkleinert gespeichert; bei
  gemeinsamen Einkäufen **Ende-zu-Ende-verschlüsselt** auf eurem Netlify-Konto (beide sehen es), bei privaten nur
  auf dem eigenen Gerät.
- Wurde die Zahlung schon per Handy erfasst, wird der Bon **dort** angehängt (keine doppelte Buchung).
- Texterkennung (Tesseract.js) und PDF-Anzeige (pdf.js) laufen **auf dem Gerät**; beim ersten Mal werden sie einmalig geladen.

## Fixkosten & Haushaltsgeld 🏠💶
**Fixkosten** (Miete, Strom, Versicherungen, Verträge …) legt ihr unter **🏠 Fixkosten** an – mit Name, Betrag,
Intervall (monatlich/vierteljährlich/jährlich), Kategorie, **wer sie bezahlt** und optional „Bis“, wenn ein Vertrag endet.
Sie zählen automatisch in jedem Monat zu den gemeinsamen Ausgaben.

**Haushaltsgeld** sind Überweisungen zwischen euch (z. B. Tom → Anna 1.200 € monatlich, von Annas Konto geht dann die
Miete ab). Das ist **keine** Ausgabe, wird aber bei „Wer hat bezahlt?“ dem Überweisenden angerechnet und beim
Empfänger abgezogen.

**Automatisch aus dem Konto:** „Mein Konto“ erkennt regelmäßige Abbuchungen (gleicher Empfänger, ähnlicher Betrag,
jeden Monat – oder typische wie Miete, Stadtwerke, Versicherung) und schlägt sie vor:
- **＋ Fixkosten** → Name vergeben (z. B. „Miete“), fertig. Gemeinsam sichtbar ist **nur dieser Eintrag** –
  die Kontobuchungen selbst bleiben privat.
- **💶 Haushaltsgeld** → für den Dauerauftrag an den Partner.
- **Privat / ausblenden** → bleibt privat und wird nicht mehr vorgeschlagen.
- Ändert sich der Betrag (z. B. neuer Strom-Abschlag), zeigt die App das an; „Betrag übernehmen“ gilt ab dem neuen
  Monat, vergangene Monate behalten den alten Betrag.
- Nicht erkannt? Bei jeder Abbuchung gibt es **🔁 regelmäßig** zum manuellen Markieren.
- **PayPal, Apple, Google, Amazon:** Solche Abbuchungen bündeln viele Abos. Bei PayPal liest die App den Händler aus dem
  Verwendungszweck („Ihr Einkauf bei waipu.tv“), bei Apple steht meist nur „APPLE.COM/BILL“ – dann trennt die App nach
  Betrag („Apple-Abo 12,99 €“) und ihr gebt den richtigen Namen (z. B. waipu.tv). Wechselnde Einkäufe (eBay usw.)
  werden nicht vorgeschlagen. Vollständige Listen: iPhone-Einstellungen → euer Name → **Abonnements** und
  PayPal → **Automatische Zahlungen**.
- **Monatlich, vierteljährlich, jährlich:** Quartals- und Jahreskosten können **auf die Monate umgelegt** werden
  (z. B. ADAC 94 €/Jahr → 7,83 €/Monat), damit die Monatsübersicht realistisch ist. Die nächsten Fälligkeiten stehen
  unter 🏠 Fixkosten → „📅 Nächste Quartals- & Jahreszahlungen“.

## 🏦 Kontostand direkt abrufen (ohne CSV)
Kontostand und Umsätze kommen auf Knopfdruck direkt von der Bank – **nur lesend**, über die offizielle
EU-Bankschnittstelle (PSD2) mit **Enable Banking** als zugelassenem Vermittler.

**So schützt die App eure Daten**
- Anmeldung nur auf der **echten Seite eurer Sparkasse** (Anmeldename + PIN), Bestätigung mit **S-pushTAN**.
  Die PIN sieht weder die App noch Enable Banking.
- Der geheime Enable-Banking-Schlüssel liegt **nur** als Secret in eurem eigenen Supabase-Projekt – nicht in der App,
  nicht im Repository. Der Baustein `supabase/functions/bank` reicht nur Lese-Anfragen durch, **speichert und
  protokolliert nichts** und ist mit eurem eigenen Zugangsschlüssel gesperrt. Zahlungen sind darin gar nicht eingebaut.
- Kontostand und Umsätze werden **nur auf dem eigenen Gerät** gespeichert und **nie** synchronisiert.
- Kreditkartenkonten gibt die Sparkasse über diese Schnittstelle nicht heraus (Abrechnung erscheint auf dem Girokonto).
- Etwa alle 90–180 Tage verlangt die Bank eine erneute Bestätigung per pushTAN – die App erinnert rechtzeitig.

**Kosten:** Supabase (Free) enthält Edge Functions. Enable Banking bietet für die eigenen Konten den
„eingeschränkten Modus“ an; dass er kostenlos ist, steht nicht ausdrücklich auf deren Seiten – vorher per Mail an
info@enablebanking.com bestätigen lassen. **Nichts unterschreiben oder bezahlen**, falls etwas anderes verlangt wird.

**Einrichtung (einmalig, ca. 20 Minuten, am besten am iPad):**
1. **Supabase** ist eingerichtet (siehe oben) und die App damit verbunden.
2. **In der App:** 🔒 Persönlich → 🏦 Mein Konto → ⚙️ Einrichtung → **„Neuen Schlüssel erzeugen“**
   (wird kopiert). Die „Rücksprung-Adresse“ dort ebenfalls notieren:
   `https://beppo0808.github.io/ausgaben-app/`
3. **Enable Banking:** auf enablebanking.com ein Konto anlegen → Control Panel → **Applications → neue Anwendung**:
   - Umgebung: **Production**, Name z. B. „Ausgaben privat“
   - Redirect URL: die Rücksprung-Adresse aus Schritt 2
   - Schlüssel **im Browser erzeugen lassen** → es wird eine Datei `<Application-ID>.pem` heruntergeladen
   - Danach **„Activate by linking accounts“**: Deutschland → eure Sparkasse wählen → mit Anmeldename/PIN
     anmelden und per pushTAN bestätigen. Deine Frau verknüpft im selben Schritt **ihr** Konto mit **ihrem** Login.
4. **Supabase → Edge Functions → „Deploy a new function“ → „Via Editor“**, Name **`bank`**.
   Den kompletten Inhalt von [`supabase/functions/bank/index.ts`](supabase/functions/bank/index.ts) einfügen → **Deploy**.
   In den Einstellungen der Funktion **„Verify JWT“ ausschalten** (der Schutz läuft über euren Zugangsschlüssel).
5. **Supabase → Edge Functions → Secrets** – vier Einträge anlegen:
   | Name | Wert |
   |---|---|
   | `EB_APP_ID` | Application ID aus Enable Banking (steht auch im Dateinamen der .pem) |
   | `EB_PRIVATE_KEY` | Inhalt der .pem-Datei – in der App unter Einrichtung „📄 .pem-Datei öffnen“ → wird nur kopiert, nicht gespeichert |
   | `BANK_ACCESS_TOKEN` | der Schlüssel aus Schritt 2 |
   | `ALLOWED_ORIGIN` | `https://beppo0808.github.io` |
   Danach die .pem-Datei aus „Downloads“ **löschen**.
6. **In der App:** 🔗 **Konto verbinden** → „Düsseldorf“ eintippen → Stadtsparkasse Düsseldorf → anmelden → pushTAN → fertig.
7. **Deine Frau:** Den Zugangsschlüssel bekommt sie automatisch über den Einladungslink (oder in der Einrichtung
   einfügen). Dann auf ihrem iPhone 🔗 Konto verbinden → „Hilden“ → Sparkasse HRV → ihre Anmeldung + pushTAN.
   Ihre Kontodaten sieht nur sie, deine nur du.

> Wichtig: Die Verbindung in **Safari** starten und abschließen (nicht wechseln), sonst schlägt die Sicherheitsprüfung fehl.

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

## Gestaltung
Warme Leinen-/Cremetöne, Karten wie erhabenes Papier, Knöpfe mit Tiefe und Druck-Effekt.
**Augenschonend (z. B. bei grauem Star):** kein Schwarz, kein reines Weiß, kein Dunkelmodus; Schrift in Dunkelbraun mit
nachgerechnetem Kontrast (~11:1, Nebentexte ≥ 7:1). Unter Einstellungen → 👓 Darstellung: Helligkeit „Hell“ oder
„Gedämpft“ (weniger Blendung) und Schriftgröße Normal / Groß / Sehr groß – jeweils pro Gerät.
Schriften: [Fraunces](https://fonts.google.com/specimen/Fraunces) und [Nunito](https://fonts.google.com/specimen/Nunito)
(SIL Open Font License), lokal im Ordner `fonts/` – es wird nichts von Google geladen.

## Dateien
`index.html` · `style.css` · `app.js` (App-Logik) · `sync.js` (Synchronisation) · `konto.js` (Kontoumsätze) · `receipt.js` (Kassenbon-Scan) · `supabase/functions/bank/index.ts` (geschützter Bank-Baustein) · `supabase.sql` (Datenbank-Setup) · `sw.js` (Offline) · `manifest.webmanifest` · Icons
