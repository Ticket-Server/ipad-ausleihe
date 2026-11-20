// Fachlogik der Ausleihe. Die Routen in index.tsx rufen nur diese Funktionen auf.

import { hashen, mussErneuertWerden, PASSWORT_RUNDEN, PIN_RUNDEN, pinErzeugen, pruefen, scheinPruefung, startpasswortErzeugen } from "./krypto";
import { faelligkeitBerechnen, uhrzeit } from "./zeit";

export interface Einstellungen {
  RUECKGABE_UHRZEIT: string;
  MAX_PRO_SCHUELER: string;
  PIN_LAENGE: string;
  AUFBEWAHRUNG_TAGE: string;
  DEMO: string;
}

export type Rolle = "schueler" | "lehrkraft";
export type GeraetStatus = "verfuegbar" | "defekt" | "ausser_betrieb";
export type Zustand = "ok" | "akku_leer" | "schaden";

export interface Konto {
  id: number;
  kuerzel: string;
  rolle: Rolle;
  ist_admin: number;
  klasse: string;
  geheimnis: string;
  aktiv: number;
  fehlversuche: number;
  gesperrt_bis: number | null;
  erstellt_am: number;
}

export interface Geraet {
  id: number;
  inventarnummer: string;
  bezeichnung: string;
  seriennummer: string;
  standort: string;
  status: GeraetStatus;
  bemerkung: string;
}

export interface Ausleihe {
  id: number;
  geraet_id: number;
  schueler_id: number;
  ausgeliehen_am: number;
  faellig_am: number;
  ausgegeben_von: number | null;
  zurueckgegeben_am: number | null;
  zurueckgebucht_von: number | null;
  zustand: Zustand | "";
  bemerkung: string;
  schaden_erledigt_am: number | null;
}

/** Ausleihe mit Kürzel, Klasse und Inventarnummer für Listen. */
export interface AusleiheZeile extends Ausleihe {
  inventarnummer: string;
  kuerzel: string;
  klasse: string;
  geraet_status: GeraetStatus;
  ausgegeben_von_kuerzel: string | null;
  zurueckgebucht_von_kuerzel: string | null;
}

export const STATUS_TEXT: Record<GeraetStatus, string> = {
  verfuegbar: "Verfügbar",
  defekt: "Defekt – wird geprüft",
  ausser_betrieb: "Außer Betrieb",
};

export const ZUSTAND_TEXT: Record<Zustand, string> = {
  ok: "Alles in Ordnung",
  akku_leer: "Akku leer",
  schaden: "Schaden oder Problem",
};

export const MAX_FEHLVERSUCHE = 5;
export const SPERRE_MINUTEN = 15;
export const FALSCHE_ANMELDUNG = "Kürzel oder PIN ist falsch.";

/** Fehler mit einer Meldung, die man dem Nutzer direkt zeigen kann. */
export class AusleiheFehler extends Error {}

// --- Eingaben prüfen ---

/**
 * Kürzel werden so gespeichert und angezeigt, wie sie eingegeben wurden (z. B. "MusterM").
 * Beim Suchen und Anmelden spielt Groß-/Kleinschreibung keine Rolle.
 */
export const kuerzelNormalisieren = (s: unknown) => String(s ?? "").trim().normalize("NFC");
const kuerzelSchluessel = (k: string) => k.toLowerCase();
export const nummerNormalisieren = (s: unknown) => String(s ?? "").trim().toUpperCase();

export function kuerzelGueltig(k: string) {
  return /^[\p{L}\p{N}][\p{L}\p{N}._-]{1,29}$/u.test(k);
}
export const KUERZEL_REGEL =
  "Das Kürzel darf Buchstaben (auch Umlaute), Ziffern, Punkt, Bindestrich und Unterstrich enthalten (2 bis 30 Zeichen), aber keine Leerzeichen.";

export function nummerGueltig(n: string) {
  return /^[A-Z0-9][A-Z0-9-]{0,19}$/.test(n);
}
export const NUMMER_REGEL = "Nur Großbuchstaben, Ziffern und Bindestrich, höchstens 20 Zeichen (z. B. W01-05).";

export const PASSWORT_MIN = 10;

// --- Konten ---

export function kontoNachKuerzel(db: D1Database, kuerzel: string) {
  return db.prepare("SELECT * FROM konten WHERE kuerzel = ? COLLATE NOCASE").bind(kuerzel).first<Konto>();
}

export function istGesperrt(k: Konto, jetzt = Date.now()) {
  return k.gesperrt_bis !== null && k.gesperrt_bis > jetzt;
}

export async function schuelerAnlegen(db: D1Database, env: Einstellungen, kuerzel: string, klasse: string) {
  const pin = pinErzeugen(Number(env.PIN_LAENGE) || 4);
  await db
    .prepare("INSERT INTO konten (kuerzel, rolle, klasse, geheimnis, erstellt_am) VALUES (?, 'schueler', ?, ?, ?)")
    .bind(kuerzel, klasse.trim().slice(0, 10), await hashen(pin, PIN_RUNDEN), Date.now())
    .run();
  return pin;
}

export async function pinZuruecksetzen(db: D1Database, env: Einstellungen, konto: Konto) {
  const pin = pinErzeugen(Number(env.PIN_LAENGE) || 4);
  await db
    .prepare("UPDATE konten SET geheimnis = ?, fehlversuche = 0, gesperrt_bis = NULL WHERE id = ?")
    .bind(await hashen(pin, PIN_RUNDEN), konto.id)
    .run();
  return pin;
}

export async function lehrkraftAnlegen(db: D1Database, kuerzel: string, istAdmin: boolean, passwort?: string) {
  const pw = passwort ?? startpasswortErzeugen();
  await db
    .prepare("INSERT INTO konten (kuerzel, rolle, ist_admin, geheimnis, erstellt_am) VALUES (?, 'lehrkraft', ?, ?, ?)")
    .bind(kuerzel, istAdmin ? 1 : 0, await hashen(pw, PASSWORT_RUNDEN), Date.now())
    .run();
  return pw;
}

export async function passwortSetzen(db: D1Database, kontoId: number, passwort: string) {
  await db
    .prepare("UPDATE konten SET geheimnis = ?, fehlversuche = 0, gesperrt_bis = NULL WHERE id = ?")
    .bind(await hashen(passwort, PASSWORT_RUNDEN), kontoId)
    .run();
}

export async function gibtEsLehrkraefte(db: D1Database) {
  return (await db.prepare("SELECT 1 FROM konten WHERE rolle = 'lehrkraft' LIMIT 1").first()) !== null;
}

/**
 * Prüft Kürzel und Geheimnis (PIN oder Passwort) für die angegebene Rolle.
 * Nach zu vielen Fehlversuchen wird das Konto für einige Minuten gesperrt.
 */
export async function anmelden(db: D1Database, kuerzelRoh: string, geheimnis: string, rolle: Rolle, meldung = FALSCHE_ANMELDUNG) {
  const kuerzel = kuerzelNormalisieren(kuerzelRoh);
  const konto = kuerzel ? await kontoNachKuerzel(db, kuerzel) : null;
  const runden = rolle === "schueler" ? PIN_RUNDEN : PASSWORT_RUNDEN;
  if (!konto || konto.rolle !== rolle) {
    await scheinPruefung(geheimnis, runden);
    throw new AusleiheFehler(meldung);
  }
  const jetzt = Date.now();
  if (istGesperrt(konto, jetzt)) {
    throw new AusleiheFehler(
      `Zu viele Fehlversuche. Bitte ab ${uhrzeit(konto.gesperrt_bis!)} Uhr erneut versuchen oder an eine Lehrkraft wenden.`,
    );
  }
  if (!(await pruefen(geheimnis, konto.geheimnis))) {
    let fehl = konto.fehlversuche + 1;
    let gesperrtBis: number | null = null;
    if (fehl >= MAX_FEHLVERSUCHE) {
      fehl = 0;
      gesperrtBis = jetzt + SPERRE_MINUTEN * 60_000;
    }
    await db.prepare("UPDATE konten SET fehlversuche = ?, gesperrt_bis = ? WHERE id = ?").bind(fehl, gesperrtBis, konto.id).run();
    throw new AusleiheFehler(meldung);
  }
  if (!konto.aktiv) throw new AusleiheFehler("Dieses Kürzel ist deaktiviert. Bitte wende dich an eine Lehrkraft.");
  if (konto.fehlversuche || konto.gesperrt_bis) {
    await db.prepare("UPDATE konten SET fehlversuche = 0, gesperrt_bis = NULL WHERE id = ?").bind(konto.id).run();
  }
  if (mussErneuertWerden(konto.geheimnis, runden)) {
    konto.geheimnis = await hashen(geheimnis, runden);
    await db.prepare("UPDATE konten SET geheimnis = ? WHERE id = ?").bind(konto.geheimnis, konto.id).run();
  }
  return konto;
}

// --- Geräte und Ausleihen ---

export function geraetNachNummer(db: D1Database, nr: string) {
  return db.prepare("SELECT * FROM geraete WHERE inventarnummer = ?").bind(nr).first<Geraet>();
}

const ZEILE_SQL = `
  SELECT a.*, g.inventarnummer, g.status AS geraet_status, k.kuerzel, k.klasse,
         av.kuerzel AS ausgegeben_von_kuerzel, zv.kuerzel AS zurueckgebucht_von_kuerzel
  FROM ausleihen a
  JOIN geraete g ON g.id = a.geraet_id
  JOIN konten k ON k.id = a.schueler_id
  LEFT JOIN konten av ON av.id = a.ausgegeben_von
  LEFT JOIN konten zv ON zv.id = a.zurueckgebucht_von`;

export function offeneAusleiheVon(db: D1Database, geraetId: number) {
  return db.prepare(`${ZEILE_SQL} WHERE a.geraet_id = ? AND a.zurueckgegeben_am IS NULL`).bind(geraetId).first<AusleiheZeile>();
}

export async function ausleihenListe(db: D1Database, bedingung: string, params: unknown[], sortierung: string, limit = 500) {
  const r = await db
    .prepare(`${ZEILE_SQL} WHERE ${bedingung} ORDER BY ${sortierung} LIMIT ${limit}`)
    .bind(...params)
    .all<AusleiheZeile>();
  return r.results;
}

export async function ausleihen(db: D1Database, env: Einstellungen, geraet: Geraet, schueler: Konto, ausgegebenVon: Konto | null = null) {
  if (geraet.status !== "verfuegbar") {
    throw new AusleiheFehler(`${geraet.inventarnummer} kann gerade nicht ausgeliehen werden (${STATUS_TEXT[geraet.status]}).`);
  }
  if (await offeneAusleiheVon(db, geraet.id)) {
    throw new AusleiheFehler(`${geraet.inventarnummer} ist schon ausgeliehen. Es muss zuerst zurückgegeben werden.`);
  }
  if (!schueler.aktiv || schueler.rolle !== "schueler") {
    throw new AusleiheFehler("An dieses Kürzel können keine Geräte ausgeliehen werden.");
  }
  const offene = await ausleihenListe(db, "a.schueler_id = ? AND a.zurueckgegeben_am IS NULL", [schueler.id], "a.ausgeliehen_am");
  if (offene.length >= (Number(env.MAX_PRO_SCHUELER) || 1)) {
    const nummern = offene.map((a) => a.inventarnummer).join(", ");
    throw new AusleiheFehler(`Auf ${schueler.kuerzel} ist schon ein Gerät ausgeliehen (${nummern}). Bitte zuerst zurückgeben.`);
  }
  const jetzt = Date.now();
  const faellig = faelligkeitBerechnen(jetzt, env.RUECKGABE_UHRZEIT || "16:00");
  try {
    // Der eindeutige Index verhindert, dass zwei gleichzeitige Anfragen dasselbe Gerät ausleihen.
    await db
      .prepare("INSERT INTO ausleihen (geraet_id, schueler_id, ausgeliehen_am, faellig_am, ausgegeben_von) VALUES (?, ?, ?, ?, ?)")
      .bind(geraet.id, schueler.id, jetzt, faellig, ausgegebenVon?.id ?? null)
      .run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new AusleiheFehler(`${geraet.inventarnummer} wurde gerade von jemand anderem ausgeliehen.`);
    throw e;
  }
  return faellig;
}

/**
 * Bucht das Gerät zurück, entweder durch den ausleihenden Schüler oder durch eine Lehrkraft.
 * Bei einem gemeldeten Schaden wird das Gerät gesperrt, bis eine Lehrkraft es geprüft hat.
 */
export async function zurueckgeben(
  db: D1Database,
  geraet: Geraet,
  zustand: Zustand,
  bemerkungRoh: string,
  durch: { schueler: Konto } | { lehrkraft: Konto },
) {
  const bemerkung = bemerkungRoh.trim().slice(0, 500);
  if (zustand === "schaden" && !bemerkung) {
    throw new AusleiheFehler("Bitte beschreibe kurz, was kaputt ist oder nicht funktioniert.");
  }
  const offen = await offeneAusleiheVon(db, geraet.id);
  if (!offen) throw new AusleiheFehler(`${geraet.inventarnummer} ist gerade nicht ausgeliehen.`);
  if ("schueler" in durch && offen.schueler_id !== durch.schueler.id) {
    throw new AusleiheFehler(`${geraet.inventarnummer} ist nicht auf dein Kürzel ausgeliehen. Bitte gib es bei einer Lehrkraft ab.`);
  }
  const lehrkraftId = "lehrkraft" in durch ? durch.lehrkraft.id : null;
  const schritte = [
    db
      .prepare(
        "UPDATE ausleihen SET zurueckgegeben_am = ?, zurueckgebucht_von = ?, zustand = ?, bemerkung = ? WHERE id = ? AND zurueckgegeben_am IS NULL",
      )
      .bind(Date.now(), lehrkraftId, zustand, bemerkung, offen.id),
  ];
  if (zustand === "schaden") schritte.push(db.prepare("UPDATE geraete SET status = 'defekt' WHERE id = ?").bind(geraet.id));
  await db.batch(schritte);
}

export async function schadenErledigen(db: D1Database, ausleiheId: number, freigeben: boolean) {
  const a = await db
    .prepare("SELECT * FROM ausleihen WHERE id = ? AND zustand = 'schaden' AND schaden_erledigt_am IS NULL")
    .bind(ausleiheId)
    .first<Ausleihe>();
  if (!a) return null;
  const schritte = [db.prepare("UPDATE ausleihen SET schaden_erledigt_am = ? WHERE id = ?").bind(Date.now(), a.id)];
  if (freigeben) schritte.push(db.prepare("UPDATE geraete SET status = 'verfuegbar' WHERE id = ?").bind(a.geraet_id));
  await db.batch(schritte);
  return a;
}

export async function schuelerLoeschen(db: D1Database, konto: Konto) {
  const offen = await db
    .prepare("SELECT 1 FROM ausleihen WHERE schueler_id = ? AND zurueckgegeben_am IS NULL LIMIT 1")
    .bind(konto.id)
    .first();
  if (offen) throw new AusleiheFehler("Löschen nicht möglich: Auf dieses Kürzel ist noch ein Gerät ausgeliehen.");
  const schaden = await db
    .prepare("SELECT 1 FROM ausleihen WHERE schueler_id = ? AND zustand = 'schaden' AND schaden_erledigt_am IS NULL LIMIT 1")
    .bind(konto.id)
    .first();
  if (schaden) throw new AusleiheFehler("Löschen nicht möglich: Es ist noch ein gemeldeter Schaden offen.");
  await db.prepare("DELETE FROM konten WHERE id = ?").bind(konto.id).run();
}

/** Löschkonzept: abgeschlossene Ausleihen ohne offenen Schaden nach Ablauf der Frist löschen. */
export async function aufraeumen(db: D1Database, env: Einstellungen, jetzt = Date.now()) {
  const grenze = jetzt - (Number(env.AUFBEWAHRUNG_TAGE) || 90) * 86_400_000;
  const [alt] = await db.batch([
    db
      .prepare(
        "DELETE FROM ausleihen WHERE zurueckgegeben_am < ? AND NOT (zustand = 'schaden' AND schaden_erledigt_am IS NULL)",
      )
      .bind(grenze),
    db.prepare("DELETE FROM sitzungen WHERE laeuft_ab < ?").bind(jetzt),
  ]);
  return alt.meta.changes ?? 0;
}

// --- iPad-Wagen ---

export const MAX_WAGEN = 99;
export const MAX_GERAETE_PRO_VORGANG = 500;
const WAGEN_MUSTER = /^W(\d{2})-(\d{2,3})$/;

/** "W01" für Wagen 1 */
export const wagenKennung = (nr: number) => `W${String(nr).padStart(2, "0")}`;

/** Zerlegt "W01-05" in Wagen 1, Gerät 5. Andere Inventarnummern ergeben null. */
export function wagenTeile(inventarnummer: string) {
  const m = WAGEN_MUSTER.exec(inventarnummer);
  return m ? { wagen: Number(m[1]), geraet: Number(m[2]) } : null;
}

/** Sortiert Inventarnummern natürlich: W01-2 vor W01-10 vor W02-1. */
export const natuerlich = (a: string, b: string) => a.localeCompare(b, "de", { numeric: true });

/** Wie viele Geräte hat jeder Wagen schon, und welche Nummer ist die höchste? */
export async function wagenBestand(db: D1Database) {
  const r = await db
    .prepare("SELECT inventarnummer FROM geraete WHERE inventarnummer GLOB 'W[0-9][0-9]-[0-9]*'")
    .all<{ inventarnummer: string }>();
  const bestand: Record<number, { anzahl: number; hoechste: number }> = {};
  for (const { inventarnummer } of r.results) {
    const t = wagenTeile(inventarnummer);
    if (!t) continue;
    const b = (bestand[t.wagen] ??= { anzahl: 0, hoechste: 0 });
    b.anzahl++;
    b.hoechste = Math.max(b.hoechste, t.geraet);
  }
  return bestand;
}

/**
 * Legt die Geräte eines iPad-Wagens an: W01-01, W01-02, …
 * Hat der Wagen schon Geräte, wird hinten angehängt. Ab Gerät 100 dreistellig.
 */
export async function wagenAnlegen(db: D1Database, wagen: number, anzahl: number, bezeichnung: string) {
  if (!Number.isInteger(wagen) || wagen < 1 || wagen > MAX_WAGEN) {
    throw new AusleiheFehler(`Die Wagen-Nummer muss zwischen 1 und ${MAX_WAGEN} liegen.`);
  }
  if (!Number.isInteger(anzahl) || anzahl < 1 || anzahl > MAX_GERAETE_PRO_VORGANG) {
    throw new AusleiheFehler(`Bitte zwischen 1 und ${MAX_GERAETE_PRO_VORGANG} Geräte auf einmal anlegen.`);
  }
  const start = ((await wagenBestand(db))[wagen]?.hoechste ?? 0) + 1;
  const ende = start + anzahl - 1;
  if (ende > 999) throw new AusleiheFehler("Ein Wagen kann höchstens 999 Geräte haben.");
  const kennung = wagenKennung(wagen);
  const nummern = Array.from({ length: anzahl }, (_, i) => `${kennung}-${String(start + i).padStart(2, "0")}`);
  const sql = db.prepare("INSERT INTO geraete (inventarnummer, bezeichnung, standort) VALUES (?, ?, ?)");
  try {
    await db.batch(nummern.map((nr) => sql.bind(nr, bezeichnung.trim().slice(0, 100), `Wagen ${wagen}`)));
  } catch (e) {
    if (String(e).includes("UNIQUE")) {
      throw new AusleiheFehler("Einige dieser Inventarnummern gibt es schon. Bitte die Geräteliste prüfen.");
    }
    throw e;
  }
  return nummern;
}

/** Löscht ein Gerät, das noch nie ausgeliehen wurde (z. B. versehentlich angelegt). */
export async function geraetLoeschen(db: D1Database, geraet: Geraet) {
  const verlauf = await db.prepare("SELECT 1 FROM ausleihen WHERE geraet_id = ? LIMIT 1").bind(geraet.id).first();
  if (verlauf) {
    throw new AusleiheFehler(
      `${geraet.inventarnummer} wurde schon ausgeliehen und kann deshalb nicht gelöscht werden. Stattdessen den Status „Außer Betrieb“ setzen.`,
    );
  }
  await db.prepare("DELETE FROM geraete WHERE id = ?").bind(geraet.id).run();
}

/** Löscht alle Geräte eines Wagens, die noch nie ausgeliehen wurden. Gibt gelöschte und behaltene zurück. */
export async function wagenLoeschen(db: D1Database, wagen: number) {
  const r = await db
    .prepare(
      `SELECT g.id, g.inventarnummer, EXISTS (SELECT 1 FROM ausleihen a WHERE a.geraet_id = g.id) AS benutzt
       FROM geraete g WHERE g.inventarnummer GLOB ?`,
    )
    .bind(`${wagenKennung(wagen)}-[0-9]*`)
    .all<{ id: number; inventarnummer: string; benutzt: number }>();
  const loeschen = r.results.filter((g) => !g.benutzt);
  const behalten = r.results.filter((g) => g.benutzt).map((g) => g.inventarnummer).sort(natuerlich);
  if (loeschen.length) {
    const sql = db.prepare("DELETE FROM geraete WHERE id = ?");
    await db.batch(loeschen.map((g) => sql.bind(g.id)));
  }
  return { geloescht: loeschen.length, behalten };
}

/** Zeilen wie "mamu7;7b" oder "mamu7" einlesen. */
export function importZeilenLesen(text: string, standardKlasse: string) {
  const eintraege: { kuerzel: string; klasse: string }[] = [];
  const fehler: string[] = [];
  const gesehen = new Set<string>();
  text.split(/\r?\n/).forEach((zeileRoh, i) => {
    const zeile = zeileRoh.trim();
    if (!zeile) return;
    const teile = zeile.split(/[;,\t]/).map((t) => t.trim());
    const kuerzel = kuerzelNormalisieren(teile[0]);
    const klasse = (teile[1] || standardKlasse.trim()).slice(0, 10);
    if (!kuerzelGueltig(kuerzel)) {
      fehler.push(`Zeile ${i + 1}: „${teile[0]}“ ist kein gültiges Kürzel.`);
      return;
    }
    if (gesehen.has(kuerzelSchluessel(kuerzel))) return;
    gesehen.add(kuerzelSchluessel(kuerzel));
    eintraege.push({ kuerzel, klasse });
  });
  return { eintraege, fehler };
}
