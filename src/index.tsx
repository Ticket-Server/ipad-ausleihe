import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import type { HtmlEscapedString } from "hono/utils/html";
import { renderSVG } from "uqr";
import { hashen, PIN_RUNDEN, pinErzeugen, pruefen, startpasswortErzeugen, tokenErzeugen, tokenHash } from "./krypto";
import {
  anmelden,
  aufraeumen,
  AusleiheFehler,
  ausleihen,
  ausleihenListe,
  type Einstellungen,
  type Geraet,
  type GeraetStatus,
  geraetLoeschen,
  geraetNachNummer,
  gibtEsLehrkraefte,
  importZeilenLesen,
  type Konto,
  kontoNachKuerzel,
  KUERZEL_REGEL,
  kuerzelGueltig,
  kuerzelNormalisieren,
  lehrkraftAnlegen,
  natuerlich,
  NUMMER_REGEL,
  nummerGueltig,
  nummerNormalisieren,
  offeneAusleiheVon,
  PASSWORT_MIN,
  passwortSetzen,
  pinZuruecksetzen,
  schadenErledigen,
  schuelerAnlegen,
  schuelerLoeschen,
  STATUS_TEXT,
  wagenAnlegen,
  wagenBestand,
  wagenKennung,
  wagenLoeschen,
  wagenTeile,
  type Zustand,
  ZUSTAND_TEXT,
  zurueckgeben,
} from "./logik";
import { schemaSicherstellen } from "./schema";
import {
  AnmeldeSeite,
  EinrichtenSeite,
  EtikettenSeite,
  FehlerSeite,
  type Fehler,
  GeraeteSeite,
  GeraetFormSeite,
  GeraetSeite,
  KaertchenSeite,
  KollegiumSeite,
  type Meldung,
  type NeuerZugang,
  PasswortSeite,
  PRO_BOGEN,
  SchuelerDetailSeite,
  SchuelerImportSeite,
  SchuelerListeSeite,
  SchuelerNeuSeite,
  StartSeite,
  UebersichtSeite,
  WagenSeite,
  type Werte,
  ZugaengeSeite,
} from "./seiten";
import { faelligkeitBerechnen, faelligText } from "./zeit";

type Bindings = Einstellungen & { DB: D1Database };
type Variablen = { nutzer: Konto | null; sitzung: string | null; meldungen: Meldung[] };
type C = Context<{ Bindings: Bindings; Variables: Variablen }>;

const SITZUNG_STUNDEN = 8;
const app = new Hono<{ Bindings: Bindings; Variables: Variablen }>();

// --- Hilfsfunktionen ---

async function zeigen(c: C, seite: HtmlEscapedString | Promise<HtmlEscapedString>, status: 200 | 400 | 403 | 404 | 500 = 200) {
  return c.html(`<!doctype html>${await seite}`, status);
}

const istHttps = (c: C) => new URL(c.req.url).protocol === "https:";

/** Meldung für die nächste Seite merken (nach einer Weiterleitung). */
function melden(c: C, art: Meldung["art"], text: string) {
  const alt = c.get("meldungen") ?? [];
  const liste = [...alt.filter((m) => m.text !== text), { art, text }];
  c.set("meldungen", liste);
  setCookie(c, "meldung", JSON.stringify(liste), { path: "/", httpOnly: true, sameSite: "Lax", secure: istHttps(c), maxAge: 120 });
}

function feld(body: Record<string, unknown>, name: string) {
  const v = body[name];
  return typeof v === "string" ? v : "";
}

function sichererPfad(p: string | undefined) {
  return p && p.startsWith("/") && !p.startsWith("//") ? p : "/lehrkraft";
}

/** Neue PINs/Passwörter bleiben bis „Fertig“ abrufbar, höchstens eine Stunde und nur in dieser Sitzung. */
const ZUGAENGE_MINUTEN = 60;

async function zugaengeMerken(c: C, liste: NeuerZugang[]) {
  await c.env.DB.prepare("UPDATE sitzungen SET neue_zugaenge = ? WHERE token_hash = ?")
    .bind(JSON.stringify({ zeit: Date.now(), liste }), c.get("sitzung"))
    .run();
}

async function zugaengeLaden(c: C): Promise<NeuerZugang[]> {
  const zeile = await c.env.DB.prepare("SELECT neue_zugaenge FROM sitzungen WHERE token_hash = ?")
    .bind(c.get("sitzung"))
    .first<{ neue_zugaenge: string | null }>();
  if (!zeile?.neue_zugaenge) return [];
  const daten = JSON.parse(zeile.neue_zugaenge);
  if (Array.isArray(daten)) return daten; // Format der Vorversion
  if (Date.now() - daten.zeit > ZUGAENGE_MINUTEN * 60_000) {
    await zugaengeVerwerfen(c);
    return [];
  }
  return daten.liste;
}

async function zugaengeVerwerfen(c: C) {
  await c.env.DB.prepare("UPDATE sitzungen SET neue_zugaenge = NULL WHERE token_hash = ?").bind(c.get("sitzung")).run();
}

/** Ein Feld für CSV (Excel): in Anführungszeichen, ohne Formel-Anfang. */
function csvFeld(wert: string) {
  const sicher = /^[=+\-@\t\r]/.test(wert) ? `'${wert}` : wert;
  return `"${sicher.replace(/"/g, '""')}"`;
}

// --- Middleware ---

app.use("*", async (c, next) => {
  await schemaSicherstellen(c.env.DB);
  await next();
  c.header("X-Frame-Options", "DENY");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "same-origin");
  if (istHttps(c)) c.header("Strict-Transport-Security", "max-age=31536000");
});

// Formulare dürfen nur von dieser Seite selbst abgeschickt werden (Schutz gegen CSRF).
app.use("*", csrf());

app.use("*", async (c, next) => {
  c.set("nutzer", null);
  c.set("sitzung", null);
  c.set("meldungen", []);

  const token = getCookie(c, "sitzung");
  if (token) {
    const hash = await tokenHash(token);
    const konto = await c.env.DB.prepare(
      `SELECT k.* FROM sitzungen s JOIN konten k ON k.id = s.konto_id
       WHERE s.token_hash = ? AND s.laeuft_ab > ? AND k.aktiv = 1 AND k.rolle = 'lehrkraft'`,
    )
      .bind(hash, Date.now())
      .first<Konto>();
    if (konto) {
      c.set("nutzer", konto);
      c.set("sitzung", hash);
    } else {
      deleteCookie(c, "sitzung", { path: "/" });
    }
  }

  if (c.req.method === "GET") {
    const roh = getCookie(c, "meldung");
    if (roh) {
      try {
        c.set("meldungen", JSON.parse(roh));
      } catch {
        /* kaputtes Cookie ignorieren */
      }
      deleteCookie(c, "meldung", { path: "/" });
    }
  }
  await next();
});

const nurLehrkraefte = async (c: C, next: () => Promise<void>) => {
  if (!c.get("nutzer")) {
    if (c.req.method === "GET") return c.redirect(`/anmelden?weiter=${encodeURIComponent(new URL(c.req.url).pathname)}`);
    return zeigen(c, <FehlerSeite nutzer={null} titel="Nicht angemeldet" text="Bitte zuerst als Lehrkraft anmelden." />, 403);
  }
  await next();
};
app.use("/lehrkraft", nurLehrkraefte);
app.use("/lehrkraft/*", nurLehrkraefte);

const nurAdmins = async (c: C, next: () => Promise<void>) => {
  if (!c.get("nutzer")?.ist_admin) {
    return zeigen(c, <FehlerSeite nutzer={c.get("nutzer")} titel="Kein Zugriff" text="Das dürfen nur Schul-Admins." />, 403);
  }
  await next();
};
app.use("/lehrkraft/kollegium", nurAdmins);
app.use("/lehrkraft/kollegium/*", nurAdmins);
app.use("/lehrkraft/demo", nurAdmins);

// --- Für alle: Gerät per QR-Code oder Inventarnummer ---

app.get("/", async (c) => {
  const nrRoh = c.req.query("nr");
  if (nrRoh !== undefined) {
    const nr = nummerNormalisieren(nrRoh);
    if (nr && (await geraetNachNummer(c.env.DB, nr))) return c.redirect(`/g/${nr}`);
    return zeigen(c, <StartSeite nutzer={c.get("nutzer")} nr={nrRoh} fehler="Diese Inventarnummer gibt es nicht." meldungen={[]} />, 400);
  }
  return zeigen(c, <StartSeite nutzer={c.get("nutzer")} meldungen={c.get("meldungen")} />);
});

async function geraetSeite(c: C, geraet: Geraet, extra: { fehler?: string; aktion?: string; werte?: Werte; feldFehler?: Fehler } = {}) {
  const nutzer = c.get("nutzer");
  const offen = await offeneAusleiheVon(c.env.DB, geraet.id);
  const verlauf = nutzer ? await ausleihenListe(c.env.DB, "a.geraet_id = ?", [geraet.id], "a.ausgeliehen_am DESC", 20) : undefined;
  const fehlerhaft = extra.fehler || Object.keys(extra.feldFehler ?? {}).length;
  return zeigen(
    c,
    <GeraetSeite
      nutzer={nutzer}
      meldungen={c.get("meldungen")}
      geraet={geraet}
      offen={offen}
      verlauf={verlauf}
      fehler={extra.fehler}
      aktion={extra.aktion}
      werte={extra.werte ?? {}}
      feldFehler={extra.feldFehler ?? {}}
    />,
    fehlerhaft ? 400 : 200,
  );
}

app.get("/g/:nr", async (c) => {
  const nrRoh = c.req.param("nr");
  const nr = nummerNormalisieren(nrRoh);
  const geraet = await geraetNachNummer(c.env.DB, nr);
  if (!geraet) return zeigen(c, <FehlerSeite nutzer={c.get("nutzer")} titel="Gerät nicht gefunden" text={`Ein Gerät ${nr} gibt es nicht.`} />, 404);
  if (nrRoh !== nr) return c.redirect(`/g/${nr}`);
  return geraetSeite(c, geraet);
});

app.post("/g/:nr", async (c) => {
  const db = c.env.DB;
  const nutzer = c.get("nutzer");
  const geraet = await geraetNachNummer(db, nummerNormalisieren(c.req.param("nr")));
  if (!geraet) return zeigen(c, <FehlerSeite nutzer={nutzer} titel="Gerät nicht gefunden" text="Dieses Gerät gibt es nicht." />, 404);

  const body = await c.req.parseBody();
  const aktion = feld(body, "aktion");
  const werte: Werte = { kuerzel: feld(body, "kuerzel"), zustand: feld(body, "zustand"), bemerkung: feld(body, "bemerkung") };
  const feldFehler: Fehler = {};
  const zustand = (werte.zustand in ZUSTAND_TEXT ? werte.zustand : "ok") as Zustand;

  if (aktion.startsWith("lk_") && !nutzer) {
    return zeigen(c, <FehlerSeite nutzer={null} titel="Kein Zugriff" text="Das dürfen nur angemeldete Lehrkräfte." />, 403);
  }
  if (["ausleihen", "zurueckgeben", "lk_ausgeben"].includes(aktion) && !werte.kuerzel.trim()) feldFehler.kuerzel = "Bitte das Kürzel eingeben.";
  if (["ausleihen", "zurueckgeben"].includes(aktion) && !feld(body, "pin").trim()) feldFehler.pin = "Bitte die PIN eingeben.";
  if (["zurueckgeben", "lk_zurueckbuchen"].includes(aktion) && zustand === "schaden" && !werte.bemerkung.trim()) {
    feldFehler.bemerkung = "Bitte beschreibe kurz, was kaputt ist oder nicht funktioniert.";
  }
  if (Object.keys(feldFehler).length) return geraetSeite(c, geraet, { aktion, werte, feldFehler });

  const nr = geraet.inventarnummer;
  try {
    if (aktion === "ausleihen") {
      const schueler = await anmelden(db, werte.kuerzel, feld(body, "pin").trim(), "schueler");
      const faellig = await ausleihen(db, c.env, geraet, schueler);
      melden(c, "ok", `${nr} ist jetzt auf ${schueler.kuerzel} ausgeliehen. Bitte ${faelligText(faellig, Date.now())} zurückgeben.`);
      return c.redirect(`/g/${nr}`);
    }
    if (aktion === "zurueckgeben") {
      const schueler = await anmelden(db, werte.kuerzel, feld(body, "pin").trim(), "schueler");
      await zurueckgeben(db, geraet, zustand, werte.bemerkung, { schueler });
      melden(
        c,
        "ok",
        zustand === "schaden"
          ? `Danke, ${nr} ist zurückgegeben. Der Schaden ist gemeldet. Bitte gib das Gerät bei einer Lehrkraft ab.`
          : `Danke, ${nr} ist zurückgegeben. Bitte lege es zurück und schließe es ans Ladekabel an.`,
      );
      return c.redirect(`/g/${nr}`);
    }
    if (aktion === "lk_ausgeben") {
      const schueler = await kontoNachKuerzel(db, kuerzelNormalisieren(werte.kuerzel));
      if (!schueler || schueler.rolle !== "schueler") {
        return geraetSeite(c, geraet, { aktion, werte, feldFehler: { kuerzel: "Kein Schüler mit diesem Kürzel gefunden." } });
      }
      const faellig = await ausleihen(db, c.env, geraet, schueler, nutzer);
      melden(c, "ok", `${nr} an ${schueler.kuerzel} ausgegeben, ${faelligText(faellig, Date.now())}.`);
      return c.redirect(`/g/${nr}`);
    }
    if (aktion === "lk_zurueckbuchen") {
      await zurueckgeben(db, geraet, zustand, werte.bemerkung, { lehrkraft: nutzer! });
      melden(c, "ok", `${nr} ist zurückgebucht.`);
      return c.redirect(feld(body, "weiter") === "uebersicht" ? "/lehrkraft" : `/g/${nr}`);
    }
  } catch (e) {
    if (e instanceof AusleiheFehler) return geraetSeite(c, geraet, { fehler: e.message, aktion, werte });
    throw e;
  }
  return c.redirect(`/g/${nr}`);
});

// --- Anmeldung und Ersteinrichtung ---

app.get("/anmelden", async (c) => {
  if (!(await gibtEsLehrkraefte(c.env.DB))) return c.redirect("/einrichten");
  if (c.get("nutzer")) return c.redirect(sichererPfad(c.req.query("weiter")));
  return zeigen(c, <AnmeldeSeite werte={{}} weiter={sichererPfad(c.req.query("weiter"))} meldungen={c.get("meldungen")} />);
});

async function sitzungStarten(c: C, konto: Konto) {
  const token = tokenErzeugen();
  await c.env.DB.prepare("INSERT INTO sitzungen (token_hash, konto_id, laeuft_ab) VALUES (?, ?, ?)")
    .bind(await tokenHash(token), konto.id, Date.now() + SITZUNG_STUNDEN * 3_600_000)
    .run();
  // Ohne maxAge: Das Cookie verschwindet beim Schließen des Browsers (wichtig an geteilten Geräten).
  setCookie(c, "sitzung", token, { path: "/", httpOnly: true, sameSite: "Lax", secure: istHttps(c) });
}

app.post("/anmelden", async (c) => {
  const body = await c.req.parseBody();
  const weiter = sichererPfad(feld(body, "weiter"));
  try {
    const konto = await anmelden(c.env.DB, feld(body, "kuerzel"), feld(body, "passwort"), "lehrkraft", "Kürzel oder Passwort ist falsch.");
    await sitzungStarten(c, konto);
    return c.redirect(weiter);
  } catch (e) {
    if (!(e instanceof AusleiheFehler)) throw e;
    return zeigen(c, <AnmeldeSeite werte={{ kuerzel: feld(body, "kuerzel") }} fehler={e.message} weiter={weiter} meldungen={[]} />, 400);
  }
});

app.post("/abmelden", async (c) => {
  const sitzung = c.get("sitzung");
  if (sitzung) await c.env.DB.prepare("DELETE FROM sitzungen WHERE token_hash = ?").bind(sitzung).run();
  deleteCookie(c, "sitzung", { path: "/" });
  return c.redirect("/");
});

app.get("/einrichten", async (c) => {
  if (await gibtEsLehrkraefte(c.env.DB)) return c.redirect("/anmelden");
  return zeigen(c, <EinrichtenSeite werte={{}} fehler={{}} />);
});

function passwortFehler(neu: string, wiederholt: string, fehler: Fehler, feldname: string) {
  if (neu.length < PASSWORT_MIN) fehler[feldname] = `Mindestens ${PASSWORT_MIN} Zeichen.`;
  else if (neu !== wiederholt) fehler[`${feldname}2`] = "Die Passwörter stimmen nicht überein.";
}

app.post("/einrichten", async (c) => {
  const db = c.env.DB;
  if (await gibtEsLehrkraefte(db)) return c.redirect("/anmelden");
  const body = await c.req.parseBody();
  const kuerzel = kuerzelNormalisieren(feld(body, "kuerzel"));
  const fehler: Fehler = {};
  if (!kuerzelGueltig(kuerzel)) fehler.kuerzel = KUERZEL_REGEL;
  else if (await kontoNachKuerzel(db, kuerzel)) fehler.kuerzel = "Dieses Kürzel ist schon als Schüler vergeben.";
  passwortFehler(feld(body, "passwort"), feld(body, "passwort2"), fehler, "passwort");
  if (Object.keys(fehler).length) return zeigen(c, <EinrichtenSeite werte={{ kuerzel }} fehler={fehler} />, 400);

  await lehrkraftAnlegen(db, kuerzel, true, feld(body, "passwort"));
  const konto = (await kontoNachKuerzel(db, kuerzel))!;
  await sitzungStarten(c, konto);
  melden(c, "ok", "Willkommen! Lege jetzt unter „Geräte“ die iPads an und unter „Schüler“ die Kürzel.");
  return c.redirect("/lehrkraft");
});

// --- Lehrkräfte: Übersicht ---

app.get("/lehrkraft", async (c) => {
  const db = c.env.DB;
  const offene = await ausleihenListe(db, "a.zurueckgegeben_am IS NULL", [], "a.faellig_am");
  const schaeden = await ausleihenListe(db, "a.zustand = 'schaden' AND a.schaden_erledigt_am IS NULL", [], "a.zurueckgegeben_am DESC");
  const z = await db
    .prepare("SELECT COUNT(*) AS gesamt, COALESCE(SUM(status = 'verfuegbar'), 0) AS verfuegbar FROM geraete")
    .first<{ gesamt: number; verfuegbar: number }>();
  const jetzt = Date.now();
  const zahlen = {
    ausgeliehen: offene.length,
    frei: (z?.verfuegbar ?? 0) - offene.filter((a) => a.geraet_status === "verfuegbar").length,
    ueberfaellig: offene.filter((a) => a.faellig_am < jetzt).length,
    gesperrt: (z?.gesamt ?? 0) - (z?.verfuegbar ?? 0),
  };
  return zeigen(
    c,
    <UebersichtSeite
      nutzer={c.get("nutzer")!}
      meldungen={c.get("meldungen")}
      offene={offene}
      schaeden={schaeden}
      zahlen={zahlen}
      demo={c.env.DEMO === "1"}
    />,
  );
});

app.post("/lehrkraft/schaden/:id/erledigt", async (c) => {
  const body = await c.req.parseBody();
  const freigeben = feld(body, "freigeben") === "1";
  const a = await schadenErledigen(c.env.DB, Number(c.req.param("id")), freigeben);
  if (a) {
    const g = await c.env.DB.prepare("SELECT inventarnummer FROM geraete WHERE id = ?").bind(a.geraet_id).first<{ inventarnummer: string }>();
    melden(
      c,
      "ok",
      freigeben
        ? `Schaden an ${g?.inventarnummer} erledigt, das Gerät ist wieder ausleihbar.`
        : `Schaden an ${g?.inventarnummer} erledigt. Das Gerät bleibt gesperrt.`,
    );
  }
  return c.redirect("/lehrkraft");
});

// --- Lehrkräfte: Geräte ---

function wagenAusAnfrage(c: C) {
  const w = Number(c.req.query("wagen"));
  return Number.isInteger(w) && w >= 1 && w <= 99 ? w : null;
}

app.get("/lehrkraft/geraete", async (c) => {
  const wagen = wagenAusAnfrage(c);
  const r = await c.env.DB.prepare(
    `SELECT g.*, EXISTS (SELECT 1 FROM ausleihen a WHERE a.geraet_id = g.id AND a.zurueckgegeben_am IS NULL) AS ausgeliehen
     FROM geraete g ${wagen ? "WHERE g.inventarnummer GLOB ?" : ""}`,
  )
    .bind(...(wagen ? [`${wagenKennung(wagen)}-[0-9]*`] : []))
    .all<Geraet & { ausgeliehen: number }>();
  const geraete = r.results.sort((a, b) => natuerlich(a.inventarnummer, b.inventarnummer));
  const wagenListe = Object.keys(await wagenBestand(c.env.DB)).map(Number).sort((a, b) => a - b);
  return zeigen(
    c,
    <GeraeteSeite nutzer={c.get("nutzer")!} meldungen={c.get("meldungen")} geraete={geraete} wagenListe={wagenListe} wagen={wagen} />,
  );
});

// --- iPad-Wagen: viele Geräte auf einmal anlegen ---

app.get("/lehrkraft/geraete/wagen", async (c) => {
  const wagen = wagenAusAnfrage(c);
  const bestand = await wagenBestand(c.env.DB);
  const vorschlag = wagen ?? (Math.max(0, ...Object.keys(bestand).map(Number)) + 1);
  return zeigen(
    c,
    <WagenSeite nutzer={c.get("nutzer")!} werte={{ wagen: String(Math.min(vorschlag, 99)), anzahl: wagen ? "1" : "20" }} bestand={bestand} />,
  );
});

app.post("/lehrkraft/geraete/wagen", async (c) => {
  const db = c.env.DB;
  const body = await c.req.parseBody();
  const werte = { wagen: feld(body, "wagen").trim(), anzahl: feld(body, "anzahl").trim(), bezeichnung: feld(body, "bezeichnung") };
  const wagen = Number(werte.wagen);
  try {
    const nummern = await wagenAnlegen(db, wagen, Number(werte.anzahl), werte.bezeichnung);
    const bereich = nummern.length > 1 ? `${nummern[0]} bis ${nummern[nummern.length - 1]}` : nummern[0];
    melden(c, "ok", `Wagen ${wagen}: ${nummern.length} Gerät${nummern.length === 1 ? "" : "e"} angelegt (${bereich}). Jetzt die QR-Etiketten drucken.`);
    return c.redirect(`/lehrkraft/geraete?wagen=${wagen}`);
  } catch (e) {
    if (!(e instanceof AusleiheFehler)) throw e;
    return zeigen(c, <WagenSeite nutzer={c.get("nutzer")!} werte={werte} fehler={e.message} bestand={await wagenBestand(db)} />, 400);
  }
});

app.post("/lehrkraft/geraete/wagen/:wagen/loeschen", async (c) => {
  const wagen = Number(c.req.param("wagen"));
  if (!Number.isInteger(wagen) || wagen < 1 || wagen > 99) return c.notFound();
  const { geloescht, behalten } = await wagenLoeschen(c.env.DB, wagen);
  melden(c, "ok", `Wagen ${wagen}: ${geloescht} unbenutzte${geloescht === 1 ? "s" : ""} Gerät${geloescht === 1 ? "" : "e"} gelöscht.`);
  if (behalten.length) {
    melden(c, "info", `Behalten, weil schon ausgeliehen: ${behalten.join(", ")}. Diese bei Bedarf auf „Außer Betrieb“ setzen.`);
    return c.redirect(`/lehrkraft/geraete?wagen=${wagen}`);
  }
  return c.redirect("/lehrkraft/geraete");
});

app.get("/lehrkraft/geraete/etiketten", async (c) => {
  const auswahl = c.req.queries("nr")?.map(nummerNormalisieren).filter(Boolean) ?? [];
  const wagen = wagenAusAnfrage(c);
  const r = await c.env.DB.prepare("SELECT inventarnummer FROM geraete").all<{ inventarnummer: string }>();
  const herkunft = new URL(c.req.url).origin;
  const etiketten = r.results
    .sort((a, b) => natuerlich(a.inventarnummer, b.inventarnummer))
    .filter((g) => !auswahl.length || auswahl.includes(g.inventarnummer))
    .filter((g) => !wagen || wagenTeile(g.inventarnummer)?.wagen === wagen)
    .map((g) => ({ nr: g.inventarnummer, svg: renderSVG(`${herkunft}/g/${g.inventarnummer}`, { ecc: "M", border: 2, pixelSize: 4 }) }));
  const zahl = (name: string, min: number, max: number) => {
    const n = Number((c.req.query(name) ?? "").replace(",", "."));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : 0;
  };
  const filter: Record<string, string[]> = {};
  if (wagen) filter.wagen = [String(wagen)];
  if (auswahl.length) filter.nr = auswahl;
  return zeigen(
    c,
    <EtikettenSeite
      nutzer={c.get("nutzer")!}
      etiketten={etiketten}
      start={Math.round(zahl("start", 0, PRO_BOGEN - 1))}
      dx={zahl("dx", -10, 10)}
      dy={zahl("dy", -10, 10)}
      filter={filter}
    />,
  );
});

const GERAET_FELDER = ["inventarnummer", "bezeichnung", "seriennummer", "standort", "status", "bemerkung"] as const;
const GERAET_LAENGEN: Record<string, number> = { bezeichnung: 100, seriennummer: 50, standort: 50, bemerkung: 1000 };

async function geraetSpeichern(c: C, geraet: Geraet | null) {
  const db = c.env.DB;
  const body = await c.req.parseBody();
  const werte: Werte = {};
  for (const f of GERAET_FELDER) werte[f] = feld(body, f).trim();
  werte.inventarnummer = nummerNormalisieren(werte.inventarnummer);
  const fehler: Fehler = {};
  if (!nummerGueltig(werte.inventarnummer)) fehler.inventarnummer = NUMMER_REGEL;
  else {
    const vorhanden = await geraetNachNummer(db, werte.inventarnummer);
    if (vorhanden && vorhanden.id !== geraet?.id) fehler.inventarnummer = "Diese Inventarnummer gibt es schon.";
  }
  if (!(werte.status in STATUS_TEXT)) werte.status = "verfuegbar";
  for (const [f, max] of Object.entries(GERAET_LAENGEN)) werte[f] = werte[f].slice(0, max);
  if (Object.keys(fehler).length) return zeigen(c, <GeraetFormSeite nutzer={c.get("nutzer")!} geraet={geraet} werte={werte} fehler={fehler} />, 400);

  const daten = [werte.inventarnummer, werte.bezeichnung, werte.seriennummer, werte.standort, werte.status as GeraetStatus, werte.bemerkung];
  if (geraet) {
    await db
      .prepare("UPDATE geraete SET inventarnummer = ?, bezeichnung = ?, seriennummer = ?, standort = ?, status = ?, bemerkung = ? WHERE id = ?")
      .bind(...daten, geraet.id)
      .run();
  } else {
    await db.prepare("INSERT INTO geraete (inventarnummer, bezeichnung, seriennummer, standort, status, bemerkung) VALUES (?, ?, ?, ?, ?, ?)").bind(...daten).run();
  }
  melden(c, "ok", `${werte.inventarnummer} gespeichert.`);
  return c.redirect("/lehrkraft/geraete");
}

app.get("/lehrkraft/geraete/neu", (c) => zeigen(c, <GeraetFormSeite nutzer={c.get("nutzer")!} geraet={null} werte={{}} fehler={{}} />));
app.post("/lehrkraft/geraete/neu", (c) => geraetSpeichern(c, null));

app.post("/lehrkraft/geraete/:nr/loeschen", async (c) => {
  const g = await geraetNachNummer(c.env.DB, nummerNormalisieren(c.req.param("nr")));
  if (!g) return c.notFound();
  try {
    await geraetLoeschen(c.env.DB, g);
  } catch (e) {
    if (!(e instanceof AusleiheFehler)) throw e;
    melden(c, "fehler", e.message);
    return c.redirect(`/lehrkraft/geraete/${g.inventarnummer}`);
  }
  melden(c, "ok", `${g.inventarnummer} ist gelöscht.`);
  const w = wagenTeile(g.inventarnummer);
  return c.redirect(w ? `/lehrkraft/geraete?wagen=${w.wagen}` : "/lehrkraft/geraete");
});

app.get("/lehrkraft/geraete/:nr", async (c) => {
  const g = await geraetNachNummer(c.env.DB, nummerNormalisieren(c.req.param("nr")));
  if (!g) return c.notFound();
  const werte = Object.fromEntries(GERAET_FELDER.map((f) => [f, String(g[f] ?? "")]));
  return zeigen(c, <GeraetFormSeite nutzer={c.get("nutzer")!} geraet={g} werte={werte} fehler={{}} meldungen={c.get("meldungen")} />);
});
app.post("/lehrkraft/geraete/:nr", async (c) => {
  const g = await geraetNachNummer(c.env.DB, nummerNormalisieren(c.req.param("nr")));
  if (!g) return c.notFound();
  return geraetSpeichern(c, g);
});

// --- Lehrkräfte: Schüler ---

app.get("/lehrkraft/schueler", async (c) => {
  const klasse = (c.req.query("klasse") ?? "").trim();
  const suche = (c.req.query("q") ?? "").trim().toLowerCase();
  const bedingungen = ["k.rolle = 'schueler'"];
  const params: string[] = [];
  if (klasse) {
    bedingungen.push("k.klasse = ?");
    params.push(klasse);
  }
  if (suche) {
    bedingungen.push("instr(k.kuerzel, ?) > 0");
    params.push(suche);
  }
  const schueler = await c.env.DB.prepare(
    `SELECT k.*, EXISTS (SELECT 1 FROM ausleihen a WHERE a.schueler_id = k.id AND a.zurueckgegeben_am IS NULL) AS offen
     FROM konten k WHERE ${bedingungen.join(" AND ")} ORDER BY k.klasse, k.kuerzel LIMIT 2000`,
  )
    .bind(...params)
    .all<Konto & { offen: number }>();
  const klassen = await c.env.DB.prepare(
    "SELECT DISTINCT klasse FROM konten WHERE rolle = 'schueler' AND klasse != '' ORDER BY klasse",
  ).all<{ klasse: string }>();
  return zeigen(
    c,
    <SchuelerListeSeite
      nutzer={c.get("nutzer")!}
      meldungen={c.get("meldungen")}
      schueler={schueler.results}
      klassen={klassen.results.map((k) => k.klasse)}
      klasse={klasse}
      suche={suche}
    />,
  );
});

app.get("/lehrkraft/schueler/neu", (c) => zeigen(c, <SchuelerNeuSeite nutzer={c.get("nutzer")!} werte={{}} fehler={{}} />));

app.post("/lehrkraft/schueler/neu", async (c) => {
  const body = await c.req.parseBody();
  const kuerzel = kuerzelNormalisieren(feld(body, "kuerzel"));
  const klasse = feld(body, "klasse").trim();
  const fehler: Fehler = {};
  if (!kuerzelGueltig(kuerzel)) fehler.kuerzel = KUERZEL_REGEL;
  else if (await kontoNachKuerzel(c.env.DB, kuerzel)) fehler.kuerzel = "Dieses Kürzel ist schon vergeben.";
  if (Object.keys(fehler).length) return zeigen(c, <SchuelerNeuSeite nutzer={c.get("nutzer")!} werte={{ kuerzel, klasse }} fehler={fehler} />, 400);
  const pin = await schuelerAnlegen(c.env.DB, c.env, kuerzel, klasse);
  await zugaengeMerken(c, [{ kuerzel, klasse, geheimnis: pin, art: "pin" }]);
  return c.redirect("/lehrkraft/zugaenge");
});

app.get("/lehrkraft/schueler/import", (c) => zeigen(c, <SchuelerImportSeite nutzer={c.get("nutzer")!} werte={{}} fehlerListe={[]} />));

app.post("/lehrkraft/schueler/import", async (c) => {
  const db = c.env.DB;
  const body = await c.req.parseBody();
  const werte = { zeilen: feld(body, "zeilen"), klasse: feld(body, "klasse") };
  const { eintraege, fehler } = importZeilenLesen(werte.zeilen, werte.klasse);
  if (!fehler.length && !eintraege.length) fehler.push("Keine Kürzel gefunden.");
  if (eintraege.length > 1000) fehler.push("Bitte höchstens 1000 Kürzel auf einmal importieren.");
  if (fehler.length) return zeigen(c, <SchuelerImportSeite nutzer={c.get("nutzer")!} werte={werte} fehlerListe={fehler} />, 400);

  const neu: NeuerZugang[] = [];
  const uebersprungen: string[] = [];
  for (const { kuerzel, klasse } of eintraege) {
    if (await kontoNachKuerzel(db, kuerzel)) {
      uebersprungen.push(kuerzel);
      continue;
    }
    const pin = await schuelerAnlegen(db, c.env, kuerzel, klasse);
    neu.push({ kuerzel, klasse, geheimnis: pin, art: "pin" });
  }
  if (uebersprungen.length) melden(c, "info", `Schon vorhanden und übersprungen: ${uebersprungen.join(", ")}`);
  if (!neu.length) {
    melden(c, "fehler", "Es wurde kein neues Kürzel angelegt.");
    return c.redirect("/lehrkraft/schueler");
  }
  await zugaengeMerken(c, neu);
  return c.redirect("/lehrkraft/zugaenge");
});

/** Zeigt neu erzeugte PINs oder Startpasswörter genau einmal an. */
const KEINE_ZUGAENGE =
  "Die neuen Zugangsdaten sind nicht mehr abrufbar (nach „Fertig“ oder nach einer Stunde). Bei Bedarf PINs neu vergeben.";

app.get("/lehrkraft/zugaenge", async (c) => {
  const zugaenge = await zugaengeLaden(c);
  if (!zugaenge.length) {
    melden(c, "info", KEINE_ZUGAENGE);
    return c.redirect("/lehrkraft/schueler");
  }
  c.header("Cache-Control", "no-store");
  const zurueck = zugaenge[0].art === "pin" ? "/lehrkraft/schueler" : "/lehrkraft/kollegium";
  return zeigen(c, <ZugaengeSeite nutzer={c.get("nutzer")!} zugaenge={zugaenge} zurueck={zurueck} minuten={ZUGAENGE_MINUTEN} />);
});

app.post("/lehrkraft/zugaenge/fertig", async (c) => {
  await zugaengeVerwerfen(c);
  return c.redirect(sichererPfad(feld(await c.req.parseBody(), "zurueck")));
});

app.get("/lehrkraft/zugaenge/kaertchen", async (c) => {
  const pins = (await zugaengeLaden(c)).filter((z) => z.art === "pin");
  if (!pins.length) {
    melden(c, "info", KEINE_ZUGAENGE);
    return c.redirect("/lehrkraft/schueler");
  }
  c.header("Cache-Control", "no-store");
  return zeigen(c, <KaertchenSeite nutzer={c.get("nutzer")!} pins={pins} />);
});

app.get("/lehrkraft/zugaenge/liste.csv", async (c) => {
  const pins = (await zugaengeLaden(c)).filter((z) => z.art === "pin");
  if (!pins.length) {
    melden(c, "info", KEINE_ZUGAENGE);
    return c.redirect("/lehrkraft/schueler");
  }
  const klassen = [...new Set(pins.map((p) => p.klasse).filter(Boolean))];
  const name = `PINs-${klassen.length === 1 ? klassen[0].replace(/[^A-Za-z0-9_-]/g, "") : "Schueler"}-${new Date().toISOString().slice(0, 10)}.csv`;
  const zeilen = [["Kürzel", "Klasse", "PIN"], ...pins.map((p) => [p.kuerzel, p.klasse, p.geheimnis])];
  // BOM + Semikolon, damit Excel Umlaute und Spalten richtig erkennt
  const csv = "\uFEFF" + zeilen.map((z) => z.map(csvFeld).join(";")).join("\r\n") + "\r\n";
  return c.body(csv, 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${name}"`,
    "Cache-Control": "no-store",
  });
});

/** Neue PINs für alle (aktiven) Schüler einer Klasse, z. B. wenn die Liste verloren ging. */
app.post("/lehrkraft/schueler/klasse-pins", async (c) => {
  const db = c.env.DB;
  const klasse = feld(await c.req.parseBody(), "klasse").trim();
  const r = await db
    .prepare("SELECT * FROM konten WHERE rolle = 'schueler' AND aktiv = 1 AND klasse = ? ORDER BY kuerzel")
    .bind(klasse)
    .all<Konto>();
  if (!klasse || !r.results.length) {
    melden(c, "fehler", "In dieser Klasse gibt es keine aktiven Schüler.");
    return c.redirect("/lehrkraft/schueler");
  }
  const neu: NeuerZugang[] = [];
  const sql = db.prepare("UPDATE konten SET geheimnis = ?, fehlversuche = 0, gesperrt_bis = NULL WHERE id = ?");
  const schritte = [];
  for (const s of r.results) {
    const pin = pinErzeugen(Number(c.env.PIN_LAENGE) || 4);
    schritte.push(sql.bind(await hashen(pin, PIN_RUNDEN), s.id));
    neu.push({ kuerzel: s.kuerzel, klasse: s.klasse, geheimnis: pin, art: "pin" });
  }
  await db.batch(schritte);
  await zugaengeMerken(c, neu);
  return c.redirect("/lehrkraft/zugaenge");
});

async function schuelerLaden(c: C) {
  const s = await kontoNachKuerzel(c.env.DB, kuerzelNormalisieren(c.req.param("kuerzel")));
  return s && s.rolle === "schueler" ? s : null;
}

app.get("/lehrkraft/schueler/:kuerzel", async (c) => {
  const s = await schuelerLaden(c);
  if (!s) return c.notFound();
  const verlauf = await ausleihenListe(c.env.DB, "a.schueler_id = ?", [s.id], "a.ausgeliehen_am DESC", 30);
  return zeigen(c, <SchuelerDetailSeite nutzer={c.get("nutzer")!} meldungen={c.get("meldungen")} s={s} verlauf={verlauf} />);
});

app.post("/lehrkraft/schueler/:kuerzel", async (c) => {
  const db = c.env.DB;
  const s = await schuelerLaden(c);
  if (!s) return c.notFound();
  const body = await c.req.parseBody();
  const aktion = feld(body, "aktion");
  const hier = `/lehrkraft/schueler/${s.kuerzel}`;

  if (aktion === "speichern") {
    await db.prepare("UPDATE konten SET klasse = ? WHERE id = ?").bind(feld(body, "klasse").trim().slice(0, 10), s.id).run();
    melden(c, "ok", "Gespeichert.");
  } else if (aktion === "pin") {
    const pin = await pinZuruecksetzen(db, c.env, s);
    await zugaengeMerken(c, [{ kuerzel: s.kuerzel, klasse: s.klasse, geheimnis: pin, art: "pin" }]);
    return c.redirect("/lehrkraft/zugaenge");
  } else if (aktion === "entsperren") {
    await db.prepare("UPDATE konten SET fehlversuche = 0, gesperrt_bis = NULL WHERE id = ?").bind(s.id).run();
    melden(c, "ok", `${s.kuerzel} ist entsperrt.`);
  } else if (aktion === "deaktivieren" || aktion === "aktivieren") {
    await db.prepare("UPDATE konten SET aktiv = ? WHERE id = ?").bind(aktion === "aktivieren" ? 1 : 0, s.id).run();
    melden(c, "ok", `${s.kuerzel} ist ${aktion === "aktivieren" ? "aktiviert" : "deaktiviert"}.`);
  } else if (aktion === "loeschen") {
    try {
      await schuelerLoeschen(db, s);
    } catch (e) {
      if (!(e instanceof AusleiheFehler)) throw e;
      melden(c, "fehler", e.message);
      return c.redirect(hier);
    }
    melden(c, "ok", `${s.kuerzel} und der Ausleihverlauf sind gelöscht.`);
    return c.redirect("/lehrkraft/schueler");
  }
  return c.redirect(hier);
});

// --- Lehrkräfte: eigenes Passwort ---

app.get("/lehrkraft/passwort", (c) => zeigen(c, <PasswortSeite nutzer={c.get("nutzer")!} meldungen={c.get("meldungen")} fehler={{}} />));

app.post("/lehrkraft/passwort", async (c) => {
  const nutzer = c.get("nutzer")!;
  const body = await c.req.parseBody();
  const fehler: Fehler = {};
  if (!(await pruefen(feld(body, "alt"), nutzer.geheimnis))) fehler.alt = "Das bisherige Passwort stimmt nicht.";
  passwortFehler(feld(body, "neu"), feld(body, "neu2"), fehler, "neu");
  if (Object.keys(fehler).length) return zeigen(c, <PasswortSeite nutzer={nutzer} meldungen={[]} fehler={fehler} />, 400);
  await passwortSetzen(c.env.DB, nutzer.id, feld(body, "neu"));
  // Andere Sitzungen dieser Lehrkraft beenden, diese bleibt bestehen.
  await c.env.DB.prepare("DELETE FROM sitzungen WHERE konto_id = ? AND token_hash != ?").bind(nutzer.id, c.get("sitzung")).run();
  melden(c, "ok", "Dein Passwort ist geändert.");
  return c.redirect("/lehrkraft");
});

// --- Schul-Admin: Lehrkräfte verwalten ---

async function kollegiumZeigen(c: C, werte: Werte = {}, fehler: Fehler = {}, status: 200 | 400 = 200) {
  const r = await c.env.DB.prepare("SELECT * FROM konten WHERE rolle = 'lehrkraft' ORDER BY kuerzel").all<Konto>();
  return zeigen(
    c,
    <KollegiumSeite nutzer={c.get("nutzer")!} meldungen={c.get("meldungen")} lehrkraefte={r.results} werte={werte} fehler={fehler} />,
    status,
  );
}

app.get("/lehrkraft/kollegium", (c) => kollegiumZeigen(c));

app.post("/lehrkraft/kollegium", async (c) => {
  const body = await c.req.parseBody();
  const kuerzel = kuerzelNormalisieren(feld(body, "kuerzel"));
  const istAdmin = feld(body, "ist_admin") === "1";
  const fehler: Fehler = {};
  if (!kuerzelGueltig(kuerzel)) fehler.kuerzel = KUERZEL_REGEL;
  else if (await kontoNachKuerzel(c.env.DB, kuerzel)) fehler.kuerzel = "Dieses Kürzel ist schon vergeben.";
  if (Object.keys(fehler).length) return kollegiumZeigen(c, { kuerzel, ist_admin: istAdmin ? "1" : "" }, fehler, 400);
  const passwort = await lehrkraftAnlegen(c.env.DB, kuerzel, istAdmin);
  await zugaengeMerken(c, [{ kuerzel, klasse: "", geheimnis: passwort, art: "passwort" }]);
  return c.redirect("/lehrkraft/zugaenge");
});

app.post("/lehrkraft/kollegium/:kuerzel", async (c) => {
  const db = c.env.DB;
  const l = await kontoNachKuerzel(db, kuerzelNormalisieren(c.req.param("kuerzel")));
  if (!l || l.rolle !== "lehrkraft") return c.notFound();
  if (l.id === c.get("nutzer")!.id) {
    melden(c, "fehler", "Dein eigenes Konto kannst du hier nicht ändern.");
    return c.redirect("/lehrkraft/kollegium");
  }
  const aktion = feld(await c.req.parseBody(), "aktion");
  if (aktion === "passwort") {
    const pw = startpasswortErzeugen();
    await passwortSetzen(db, l.id, pw);
    await db.prepare("DELETE FROM sitzungen WHERE konto_id = ?").bind(l.id).run();
    await zugaengeMerken(c, [{ kuerzel: l.kuerzel, klasse: "", geheimnis: pw, art: "passwort" }]);
    return c.redirect("/lehrkraft/zugaenge");
  }
  if (aktion === "admin" || aktion === "kein_admin") {
    await db.prepare("UPDATE konten SET ist_admin = ? WHERE id = ?").bind(aktion === "admin" ? 1 : 0, l.id).run();
    melden(c, "ok", aktion === "admin" ? `${l.kuerzel} ist jetzt Schul-Admin.` : `${l.kuerzel} ist kein Schul-Admin mehr.`);
  } else if (aktion === "deaktivieren" || aktion === "aktivieren") {
    await db.batch([
      db.prepare("UPDATE konten SET aktiv = ? WHERE id = ?").bind(aktion === "aktivieren" ? 1 : 0, l.id),
      db.prepare("DELETE FROM sitzungen WHERE konto_id = ?").bind(l.id),
    ]);
    melden(c, "ok", `${l.kuerzel} ist ${aktion === "aktivieren" ? "aktiviert" : "deaktiviert"}.`);
  } else if (aktion === "loeschen") {
    await db.prepare("DELETE FROM konten WHERE id = ?").bind(l.id).run();
    melden(c, "ok", `${l.kuerzel} ist gelöscht.`);
  }
  return c.redirect("/lehrkraft/kollegium");
});

// --- Demo-Daten (nur wenn DEMO = "1") ---

app.post("/lehrkraft/demo", async (c) => {
  if (c.env.DEMO !== "1") return c.notFound();
  const db = c.env.DB;
  const pinHash = await hashen("1234", PIN_RUNDEN);
  const jetzt = Date.now();
  const stunde = 3_600_000;
  const schueler = [
    ["mamu7", "7b"], ["lesc8", "7b"], ["joka2", "7b"], ["anwe3", "7b"], ["fibe5", "8a"],
    ["emko1", "8a"], ["nihu4", "8a"], ["sola9", "9c"], ["bema6", "9c"], ["tiro2", "10a"],
  ];
  const schritte = [
    db.prepare("DELETE FROM ausleihen"),
    db.prepare("DELETE FROM geraete"),
    db.prepare("DELETE FROM konten WHERE rolle = 'schueler'"),
    ...schueler.map(([k, kl]) =>
      db.prepare("INSERT INTO konten (kuerzel, rolle, klasse, geheimnis, erstellt_am) VALUES (?, 'schueler', ?, ?, ?)").bind(k, kl, pinHash, jetzt),
    ),
    ...Array.from({ length: 16 }, (_, i) => {
      const nr = i < 8 ? `W01-${String(i + 1).padStart(2, "0")}` : `W02-${String(i - 7).padStart(2, "0")}`;
      const status = nr === "W02-08" ? "ausser_betrieb" : nr === "W01-05" ? "defekt" : "verfuegbar";
      return db
        .prepare("INSERT INTO geraete (inventarnummer, bezeichnung, seriennummer, standort, status, bemerkung) VALUES (?, 'iPad 10. Gen.', ?, ?, ?, ?)")
        .bind(nr, `DMPX${String(i + 1).padStart(4, "0")}DEMO`, i < 8 ? "Wagen 1" : "Wagen 2", status, nr === "W02-08" ? "Akku tauschen" : "");
    }),
  ];
  const ausleihe = (nr: string, k: string, vor: number, faellig: number, zurueckVor: number | null = null, zustand = "", bemerkung = "") =>
    db
      .prepare(
        `INSERT INTO ausleihen (geraet_id, schueler_id, ausgeliehen_am, faellig_am, zurueckgegeben_am, zustand, bemerkung)
         VALUES ((SELECT id FROM geraete WHERE inventarnummer = ?), (SELECT id FROM konten WHERE kuerzel = ?), ?, ?, ?, ?, ?)`,
      )
      .bind(nr, k, jetzt - vor * stunde, faellig, zurueckVor === null ? null : jetzt - zurueckVor * stunde, zustand, bemerkung);
  const faellig = faelligkeitBerechnen(jetzt, c.env.RUECKGABE_UHRZEIT || "16:00");
  schritte.push(
    ausleihe("W01-01", "mamu7", 1, faellig),
    ausleihe("W01-02", "lesc8", 2, faellig),
    ausleihe("W02-01", "fibe5", 0.5, faellig),
    ausleihe("W02-02", "sola9", 26, jetzt - 20 * stunde),
    ausleihe("W01-03", "joka2", 28, jetzt - 20 * stunde, 24, "ok"),
    ausleihe("W01-04", "emko1", 27, jetzt - 20 * stunde, 23, "akku_leer"),
    ausleihe("W01-05", "bema6", 5, jetzt, 3, "schaden", "Display hat einen Sprung unten rechts."),
  );
  await db.batch(schritte);
  melden(c, "ok", `Demo-Daten geladen. Schüler: ${schueler.map((s) => s[0]).join(", ")} – PIN für alle: 1234`);
  return c.redirect("/lehrkraft");
});

// --- Fehlerseiten ---

app.notFound((c) => zeigen(c as C, <FehlerSeite nutzer={(c as C).get("nutzer") ?? null} titel="Nicht gefunden" text="Diese Seite gibt es nicht." />, 404));

app.onError((err, c) => {
  if (err instanceof HTTPException && err.status === 403) {
    return zeigen(
      c as C,
      <FehlerSeite nutzer={null} titel="Abgelehnt" text="Das Formular kam nicht von dieser Seite. Bitte die Seite neu laden und es noch einmal versuchen." />,
      403,
    );
  }
  if (err instanceof HTTPException) return err.getResponse();
  console.error(err);
  return zeigen(
    c as C,
    <FehlerSeite nutzer={null} titel="Fehler" text="Da ist etwas schiefgegangen. Bitte versuche es noch einmal." />,
    500,
  );
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        await schemaSicherstellen(env.DB);
        const anzahl = await aufraeumen(env.DB, env);
        console.log(`Löschfrist: ${anzahl} alte Ausleihe(n) gelöscht.`);
      })(),
    );
  },
} satisfies ExportedHandler<Bindings>;

