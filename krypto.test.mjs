import assert from "node:assert/strict";
import { test } from "node:test";
import { hashen, mussErneuertWerden, PASSWORT_RUNDEN, PIN_RUNDEN, pruefen } from "../src/krypto.ts";

test("Hashes der Vorversion (100.000 Runden) werden erkannt und als veraltet markiert", async () => {
  const alt = await hashen("geheimes-passwort", 100_000);
  assert.ok(await pruefen("geheimes-passwort", alt));
  assert.ok(!(await pruefen("falsch", alt)));
  assert.ok(mussErneuertWerden(alt, PASSWORT_RUNDEN));
});

test("Aktuelle Hashes für PIN und Passwort", async () => {
  const pin = await hashen("4711", PIN_RUNDEN);
  assert.ok(await pruefen("4711", pin));
  assert.ok(!(await pruefen("4712", pin)));
  assert.ok(!mussErneuertWerden(pin, PIN_RUNDEN));
  const pw = await hashen("ein-langes-passwort", PASSWORT_RUNDEN);
  assert.ok(await pruefen("ein-langes-passwort", pw));
  assert.ok(!mussErneuertWerden(pw, PASSWORT_RUNDEN));
});
