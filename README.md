# iPad-Ausleihe

Einfaches Check-in/Check-out für die Leih-iPads der Schule (Sekundarstufe).
Läuft komplett bei **Cloudflare** (Workers + D1-Datenbank), ohne eigenen Server.

## So funktioniert es

**Schüler** brauchen kein Login und keine App:

1. QR-Code auf dem iPad mit der Kamera scannen (oder auf der Startseite die Inventarnummer eingeben, z. B. `W01-05`).
2. **Schulkürzel und PIN** eingeben und auf **Ausleihen** tippen.
3. Zum Zurückgeben denselben Code scannen, Kürzel und PIN eingeben, Zustand angeben
   („Alles in Ordnung“, „Akku leer“, „Schaden oder Problem“) und auf **Zurückgeben** tippen.

Danach bleibt niemand angemeldet. Der Nächste am Gerät kann also nicht im Namen des Vorgängers handeln.

**Regeln**

- Ein Gerät kann nie an zwei Schüler gleichzeitig ausgeliehen sein. Das sichert auch die Datenbank ab.
- Pro Schüler höchstens ein Gerät gleichzeitig (einstellbar).
- Rückgabe bis Ende des Schultags (Standard 16:00 Uhr). Wer danach ausleiht, gibt bis zum nächsten
  Schultag zurück (Wochenenden werden übersprungen).
- Zurückgeben kann nur, wer ausgeliehen hat, oder eine Lehrkraft.
- Bei einem gemeldeten Schaden wird das Gerät automatisch gesperrt, bis eine Lehrkraft es prüft.
- Nach 5 falschen PINs wird das Kürzel für 15 Minuten gesperrt. Eine Lehrkraft kann sofort entsperren.

**Lehrkräfte** melden sich unter „Für Lehrkräfte“ mit Kürzel und Passwort an:

- **Übersicht:** freie, ausgeliehene und überfällige Geräte (rot), gemeldete Schäden.
- **Geräteseite:** Wer hat das Gerät? Ausgeben oder zurückbuchen ohne PIN, Verlauf des Geräts.
- **Geräte:** mit **„iPad-Wagen anlegen“** Wagen-Nummer und Anzahl eingeben – die Geräte werden automatisch
  angelegt: Wagen 1 mit 20 Geräten ergibt `W01-01` bis `W01-20` (ab Gerät 100 dreistellig, bis zu 500 auf einmal).
  Erneut aufgerufen, werden weitere Geräte hinten angehängt. Filter nach Wagen, **QR-Etiketten pro Wagen drucken** (passend für den Etikettenbogen der Schule: A4 quer, 8 × 4 Etiketten à 33,8 × 48,3 mm; angebrochene Bögen und Feinjustierung in mm möglich),
  Status ändern (verfügbar / defekt / außer Betrieb). Versehentlich angelegte Geräte lassen sich löschen,
  solange sie noch nie ausgeliehen wurden.
- **Schüler:** einzeln anlegen oder **Liste importieren** (Kürzel aus der Schulverwaltung wie `MusterM`, eines pro Zeile;
  die Schreibweise bleibt erhalten, beim Eingeben spielt Groß-/Kleinschreibung keine Rolle;
  optional `;Klasse`). PINs werden automatisch erzeugt. Direkt danach: **Kärtchen drucken** (Scheckkartenformat,
  10 pro A4-Blatt, in den Schulfarben) und **Liste herunterladen** (Excel/CSV). Die PINs werden nur verschlüsselt
  gespeichert und sind später nicht mehr lesbar. Die Seite bleibt deshalb bis „Fertig“ abrufbar, höchstens 60 Minuten.
  Neue PIN für einzelne Schüler: Kürzel anklicken → „Neue PIN vergeben“. Für eine ganze Klasse: Schülerliste nach
  Klasse filtern → „Neue PINs für Klasse … vergeben“.
- **Passwort:** eigenes Passwort ändern.

**Schul-Admins** verwalten zusätzlich unter **Lehrkräfte** die Konten des Kollegiums
(anlegen mit Startpasswort, neues Passwort, Admin-Rechte, deaktivieren, löschen).

## Bei Cloudflare in Betrieb nehmen

Einmalig, dauert etwa 15 Minuten. Alles im Browser.

**1. Datenbank anlegen**
Im Cloudflare-Dashboard: **Storage & Databases → D1 SQL Database → Create**.
Name `ipad-ausleihe`, als Speicherort bzw. Jurisdiktion **EU** wählen, anlegen.
Die angezeigte **Database ID** kopieren.

**2. ID eintragen**
Auf GitHub die Datei `wrangler.jsonc` öffnen, auf den Stift klicken, `HIER-DATENBANK-ID-EINTRAGEN`
durch die kopierte ID ersetzen und **Commit changes** klicken.

**3. Worker anlegen**
Im Cloudflare-Dashboard: **Workers & Pages → Create → Import a repository**.
GitHub verbinden, das Repository `ipad-ausleihe` auswählen und **Deploy** klicken.
Die Voreinstellungen passen. Ab jetzt wird jede Änderung auf GitHub automatisch veröffentlicht.

**4. Sofort einrichten**
Die angezeigte Adresse (`…workers.dev`) öffnen. Beim ersten Aufruf von „Für Lehrkräfte“ erscheint die
**Ersteinrichtung** für das Schul-Admin-Konto. Bitte direkt erledigen. Danach ist die Seite gesperrt.

**5. Eigene Adresse (empfohlen)**
Im Worker unter **Settings → Domains & Routes → Add → Custom domain** z. B. `ausleihe.deine-schule.de`
eintragen. Erst **danach** die QR-Etiketten drucken, denn sie enthalten die Adresse.

**6. Optional: Lehrkräfte-Bereich zusätzlich schützen**
Mit **Cloudflare Zero Trust → Access** eine Anwendung für `ausleihe.deine-schule.de/lehrkraft*`
und `/anmelden` anlegen, die nur Schul-E-Mail-Adressen zulässt. Schülerseiten bleiben offen.

### Einstellungen

Im Worker unter **Settings → Variables and Secrets** (oder in `wrangler.jsonc`):

| Variable | Standard | Bedeutung |
|---|---|---|
| `RUECKGABE_UHRZEIT` | `16:00` | Rückgabe bis (deutsche Zeit) |
| `MAX_PRO_SCHUELER` | `1` | Geräte pro Schüler gleichzeitig |
| `PIN_LAENGE` | `4` | Länge neuer PINs |
| `AUFBEWAHRUNG_TAGE` | `90` | Löschfrist für abgeschlossene Ausleihen |
| `DEMO` | `0` | `1` zeigt Admins einen Knopf für Demo-Daten (löscht alle Geräte und Schüler!) |

Die Datenbanktabellen legt die App beim ersten Aufruf selbst an. Die Löschfrist läuft täglich
automatisch (Cron Trigger in `wrangler.jsonc`).

## Lokal entwickeln

```bash
npm install
npm run dev      # http://localhost:8787, lokale D1-Datenbank, Demo-Knopf aktiv (.dev.vars)
npm test         # startet die App mit leerer Datenbank und spielt alle Abläufe durch
```

## Datenschutz (Kurzfassung, keine Rechtsberatung)

- **Datensparsam:** Von Schülern speichert die App nur Schulkürzel, optional die Klasse, den Hash der PIN
  und die Ausleihen (Gerät, Zeiten, Zustand, Bemerkung). Keine Namen, keine E-Mail-Adressen.
  Die Zuordnung Kürzel → Person liegt nur in der Schulverwaltung.
- **Speicherort:** D1-Datenbank mit Jurisdiktion EU bei Cloudflare. Grundlage ist die AVV der Schule
  mit Cloudflare. Bitte prüfen, dass sie Workers und D1 abdeckt.
- **Rechtsgrundlage:** Ausgabe schuleigener Lernmittel gehört zum Schulbetrieb
  (Art. 6 Abs. 1 lit. e DSGVO i. V. m. dem Schulgesetz des Landes). Eine Einwilligung ist nicht nötig.
  Vor dem Start mit dem/der Datenschutzbeauftragten abstimmen und ins Verzeichnis der
  Verarbeitungstätigkeiten aufnehmen.
- **Sicherheit:** PINs und Passwörter nur als Hash (PBKDF2; Passwörter mit 20.000 Runden, passend zum kostenlosen
  Cloudflare-Tarif), Sperre nach 5 Fehlversuchen, nur HTTPS,
  Lehrkräfte-Sitzungen enden beim Schließen des Browsers und spätestens nach 8 Stunden.
- **Sichtbarkeit:** Die öffentliche Geräteseite zeigt nur „frei“ oder „ausgeliehen“, nie das Kürzel.
- **Löschung:** Abgeschlossene Ausleihen werden nach 90 Tagen automatisch gelöscht, außer ein gemeldeter
  Schaden ist noch offen. Schülerkonten löscht die Schule beim Verlassen der Schule unter „Schüler“.
