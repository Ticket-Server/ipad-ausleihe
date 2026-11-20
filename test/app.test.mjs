// Startet die App lokal mit einer frischen D1-Datenbank und spielt die wichtigsten Abläufe durch.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const PORT = 8790 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PW = "admin-passwort-123";
let server;
let datenOrdner;

before(async () => {
  datenOrdner = mkdtempSync(join(tmpdir(), "ausleihe-test-"));
  server = spawn(
    "npx",
    ["wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1", "--persist-to", datenOrdner, "--var", "DEMO:1"],
    { stdio: "ignore", detached: true },
  );
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(BASE + "/")).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Server startet nicht");
});

after(() => {
  try {
    process.kill(-server.pid);
  } catch {}
  rmSync(datenOrdner, { recursive: true, force: true });
});

/** Einfacher Browser mit Cookies. */
class Browser {
  cookies = new Map();
  async anfrage(pfad, { methode = "GET", daten, origin = BASE } = {}) {
    const headers = { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ") };
    let body;
    if (daten) {
      body = new URLSearchParams(daten);
      headers["content-type"] = "application/x-www-form-urlencoded";
      if (origin) headers.origin = origin;
    }
    const r = await fetch(BASE + pfad, { method: methode, headers, body, redirect: "manual" });
    for (const c of r.headers.getSetCookie()) {
      const [paar] = c.split(";");
      const [k, ...v] = paar.split("=");
      const wert = v.join("=");
      if (!wert || /max-age=0/i.test(c)) this.cookies.delete(k);
      else this.cookies.set(k, wert);
    }
    return { status: r.status, ort: r.headers.get("location"), text: await r.text() };
  }
  get(pfad) {
    return this.anfrage(pfad);
  }
  post(pfad, daten, optionen = {}) {
    return this.anfrage(pfad, { methode: "POST", daten, ...optionen });
  }
  /** POST und der Weiterleitung folgen. */
  async senden(pfad, daten) {
    const r = await this.post(pfad, daten);
    if (r.status === 302) return this.get(r.ort);
    return r;
  }
}

const lehrkraft = new Browser();

test("Ersteinrichtung legt den Schul-Admin an und ist danach gesperrt", async () => {
  assert.equal((await new Browser().get("/anmelden")).ort, "/einrichten");
  const r = await lehrkraft.post("/einrichten", { kuerzel: "Admin", passwort: ADMIN_PW, passwort2: ADMIN_PW });
  assert.equal(r.ort, "/lehrkraft");
  assert.equal((await new Browser().get("/einrichten")).ort, "/anmelden");
  const r2 = await new Browser().post("/einrichten", { kuerzel: "boese", passwort: ADMIN_PW, passwort2: ADMIN_PW });
  assert.equal(r2.ort, "/anmelden");
});

test("Demo-Daten laden", async () => {
  const r = await lehrkraft.senden("/lehrkraft/demo", {});
  assert.match(r.text, /Demo-Daten geladen/);
  assert.match(r.text, /IPAD-010/);
});

test("Schüler leiht aus und gibt zurück, ohne angemeldet zu bleiben", async () => {
  const s = new Browser();
  let r = await s.senden("/g/IPAD-003", { aktion: "ausleihen", kuerzel: "AnWe3 ", pin: "1234" });
  assert.match(r.text, /IPAD-003 ist jetzt auf anwe3 ausgeliehen/);
  assert.ok(!s.cookies.has("sitzung"));

  r = await new Browser().get("/g/IPAD-003");
  assert.match(r.text, /Ausgeliehen/);
  assert.doesNotMatch(r.text, /anwe3/, "Öffentliche Seite darf das Kürzel nicht zeigen");

  r = await s.senden("/g/IPAD-003", { aktion: "zurueckgeben", kuerzel: "anwe3", pin: "1234", zustand: "ok" });
  assert.match(r.text, /IPAD-003 ist zurückgegeben/);
});

test("Gerät nicht doppelt, nur ein Gerät pro Schüler, nur eigenes Gerät zurückgeben", async () => {
  const s = new Browser();
  let r = await s.post("/g/IPAD-001", { aktion: "ausleihen", kuerzel: "tiro2", pin: "1234" });
  assert.equal(r.status, 400);
  assert.match(r.text, /schon ausgeliehen/);

  r = await s.post("/g/IPAD-006", { aktion: "ausleihen", kuerzel: "mamu7", pin: "1234" });
  assert.equal(r.status, 400);
  assert.match(r.text, /schon ein Gerät ausgeliehen \(IPAD-001\)/);

  r = await s.post("/g/IPAD-001", { aktion: "zurueckgeben", kuerzel: "tiro2", pin: "1234", zustand: "ok" });
  assert.match(r.text, /nicht auf dein Kürzel ausgeliehen/);
});

test("Defektes Gerät ist nicht ausleihbar", async () => {
  const r = await new Browser().get("/g/IPAD-005");
  assert.match(r.text, /Nicht ausleihbar/);
  const r2 = await new Browser().post("/g/IPAD-005", { aktion: "ausleihen", kuerzel: "tiro2", pin: "1234" });
  assert.match(r2.text, /kann gerade nicht ausgeliehen werden/);
});

test("Schaden braucht Beschreibung und sperrt das Gerät", async () => {
  const s = new Browser();
  await s.senden("/g/IPAD-007", { aktion: "ausleihen", kuerzel: "nihu4", pin: "1234" });
  let r = await s.post("/g/IPAD-007", { aktion: "zurueckgeben", kuerzel: "nihu4", pin: "1234", zustand: "schaden", bemerkung: "" });
  assert.equal(r.status, 400);
  assert.match(r.text, /beschreibe kurz/);
  r = await s.senden("/g/IPAD-007", { aktion: "zurueckgeben", kuerzel: "nihu4", pin: "1234", zustand: "schaden", bemerkung: "Ladebuchse wackelt" });
  assert.match(r.text, /Schaden ist gemeldet/);
  assert.match(r.text, /Nicht ausleihbar/);
  r = await lehrkraft.get("/lehrkraft");
  assert.match(r.text, /Ladebuchse wackelt/);
});

test("Falsche PIN: gleiche Meldung wie unbekanntes Kürzel, Sperre nach 5 Versuchen", async () => {
  const s = new Browser();
  let r = await s.post("/g/IPAD-008", { aktion: "ausleihen", kuerzel: "gibtsnicht", pin: "1234" });
  assert.match(r.text, /Kürzel oder PIN ist falsch/);
  for (let i = 0; i < 5; i++) {
    r = await s.post("/g/IPAD-008", { aktion: "ausleihen", kuerzel: "tiro2", pin: "0000" });
    assert.match(r.text, /Kürzel oder PIN ist falsch/);
  }
  r = await s.post("/g/IPAD-008", { aktion: "ausleihen", kuerzel: "tiro2", pin: "1234" });
  assert.match(r.text, /Zu viele Fehlversuche/);
  r = await lehrkraft.senden("/lehrkraft/schueler/tiro2", { aktion: "entsperren" });
  assert.match(r.text, /tiro2 ist entsperrt/);
  r = await s.senden("/g/IPAD-008", { aktion: "ausleihen", kuerzel: "tiro2", pin: "1234" });
  assert.match(r.text, /ist jetzt auf tiro2 ausgeliehen/);
});

test("Lehrkraft-Aktionen nur für Lehrkräfte, Schüler kann sich nicht als Lehrkraft anmelden", async () => {
  const s = new Browser();
  assert.equal((await s.post("/g/IPAD-011", { aktion: "lk_ausgeben", kuerzel: "joka2" })).status, 403);
  assert.match((await s.get("/lehrkraft")).ort, /^\/anmelden/);
  const r = await s.post("/anmelden", { kuerzel: "joka2", passwort: "1234", weiter: "/lehrkraft" });
  assert.equal(r.status, 400);
  assert.ok(!s.cookies.has("sitzung"));
});

test("Lehrkraft gibt ohne PIN aus und sieht das Kürzel", async () => {
  let r = await lehrkraft.senden("/g/IPAD-011", { aktion: "lk_ausgeben", kuerzel: "joka2" });
  assert.match(r.text, /IPAD-011 an joka2 ausgegeben/);
  assert.match(r.text, /durch admin/);
  r = await lehrkraft.senden("/g/IPAD-011", { aktion: "lk_zurueckbuchen", zustand: "ok", weiter: "uebersicht" });
  assert.match(r.text, /IPAD-011 ist zurückgebucht/);
});

test("Formulare von fremden Seiten werden abgelehnt (CSRF)", async () => {
  const r = await lehrkraft.post("/g/IPAD-012", { aktion: "lk_ausgeben", kuerzel: "joka2" }, { origin: "https://boese.example" });
  assert.equal(r.status, 403);
});

test("Import erzeugt PINs, die nur einmal angezeigt werden", async () => {
  let r = await lehrkraft.senden("/lehrkraft/schueler/import", { zeilen: "abcd1;7b\nEfgh2\nmamu7\n\nabcd1", klasse: "7a" });
  assert.match(r.text, /abcd1/);
  assert.match(r.text, /efgh2/);
  const pin = r.text.match(/<td class="pin">(\d{4})<\/td>/)?.[1];
  assert.ok(pin, "PIN wird angezeigt");
  r = await lehrkraft.get("/lehrkraft/zugaenge");
  assert.equal(r.ort, "/lehrkraft/schueler");
  r = await lehrkraft.get("/lehrkraft/schueler?klasse=7a");
  assert.match(r.text, /efgh2/);
  assert.doesNotMatch(r.text, /abcd1/);
  r = await new Browser().senden("/g/IPAD-012", { aktion: "ausleihen", kuerzel: "abcd1", pin });
  assert.match(r.text, /ist jetzt auf abcd1 ausgeliehen/);

  r = await lehrkraft.post("/lehrkraft/schueler/import", { zeilen: "gut1\nMax Müller" });
  assert.match(r.text, /kein gültiges Kürzel/);
  assert.equal((await lehrkraft.get("/lehrkraft/schueler/gut1")).status, 404);
});

test("Schüler mit offener Ausleihe kann nicht gelöscht werden", async () => {
  const r = await lehrkraft.senden("/lehrkraft/schueler/abcd1", { aktion: "loeschen" });
  assert.match(r.text, /noch ein Gerät ausgeliehen/);
});

test("QR-Etiketten enthalten den Link zum Gerät", async () => {
  const r = await lehrkraft.get("/lehrkraft/geraete/etiketten?nr=IPAD-001");
  assert.match(r.text, /<svg/);
  assert.match(r.text, /IPAD-001/);
  assert.doesNotMatch(r.text, /IPAD-002/);
});

test("Kleinschreibung leitet um, unbekanntes Gerät gibt 404", async () => {
  assert.equal((await new Browser().get("/g/ipad-001")).ort, "/g/IPAD-001");
  assert.equal((await new Browser().get("/g/IPAD-999")).status, 404);
  assert.equal((await new Browser().get("/?nr=ipad-002")).ort, "/g/IPAD-002");
});

test("Schul-Admin legt Lehrkraft an, die sich mit dem Startpasswort anmeldet", async () => {
  let r = await lehrkraft.senden("/lehrkraft/kollegium", { kuerzel: "mei" });
  const pw = r.text.match(/<td class="pin">([a-z0-9-]{14})<\/td>/)?.[1];
  assert.ok(pw, "Startpasswort wird angezeigt");
  const mei = new Browser();
  r = await mei.post("/anmelden", { kuerzel: "mei", passwort: pw, weiter: "/lehrkraft" });
  assert.equal(r.ort, "/lehrkraft");
  assert.equal((await mei.get("/lehrkraft/kollegium")).status, 403, "normale Lehrkraft darf keine Lehrkräfte verwalten");
  r = await mei.senden("/lehrkraft/passwort", { alt: pw, neu: "neues-passwort-1", neu2: "neues-passwort-1" });
  assert.match(r.text, /Passwort ist geändert/);
  r = await mei.senden("/abmelden", {});
  assert.equal((await mei.get("/lehrkraft")).status, 302);
});

test("Alle Lehrkräfte-Seiten laden", async () => {
  for (const pfad of [
    "/lehrkraft",
    "/lehrkraft/geraete",
    "/lehrkraft/geraete/neu",
    "/lehrkraft/geraete/IPAD-001",
    "/lehrkraft/schueler",
    "/lehrkraft/schueler/neu",
    "/lehrkraft/schueler/import",
    "/lehrkraft/schueler/mamu7",
    "/lehrkraft/kollegium",
    "/lehrkraft/passwort",
  ]) {
    assert.equal((await lehrkraft.get(pfad)).status, 200, pfad);
  }
});

test("Gerät anlegen und doppelte Inventarnummer ablehnen", async () => {
  let r = await lehrkraft.senden("/lehrkraft/geraete/neu", { inventarnummer: "ipad-100", bezeichnung: "Test", status: "verfuegbar" });
  assert.match(r.text, /IPAD-100 gespeichert/);
  r = await lehrkraft.post("/lehrkraft/geraete/neu", { inventarnummer: "IPAD-100", status: "verfuegbar" });
  assert.match(r.text, /gibt es schon/);
});
