import assert from "node:assert/strict";
import { test } from "node:test";
import { berlinZeitpunkt, faelligkeitBerechnen, faelligText, kurz } from "../src/zeit.ts";

const b = (j, m, t, h, mi) => berlinZeitpunkt(j, m, t, h, mi);

test("vormittags: heute bis Schulschluss", () => {
  assert.equal(faelligkeitBerechnen(b(2026, 11, 18, 9, 0), "16:00"), b(2026, 11, 18, 16, 0));
});

test("nach Schulschluss: nächster Tag", () => {
  assert.equal(faelligkeitBerechnen(b(2026, 11, 18, 17, 0), "16:00"), b(2026, 11, 19, 16, 0));
});

test("Freitagabend und Samstag: bis Montag", () => {
  assert.equal(faelligkeitBerechnen(b(2026, 11, 20, 17, 0), "16:00"), b(2026, 11, 23, 16, 0));
  assert.equal(faelligkeitBerechnen(b(2026, 11, 21, 10, 0), "16:00"), b(2026, 11, 23, 16, 0));
});

test("Sommerzeit und Winterzeit werden richtig umgerechnet", () => {
  assert.equal(new Date(b(2026, 7, 1, 16, 0)).toISOString(), "2026-07-01T14:00:00.000Z");
  assert.equal(new Date(b(2026, 12, 1, 16, 0)).toISOString(), "2026-12-01T15:00:00.000Z");
});

test("Anzeige in deutscher Zeit", () => {
  assert.equal(kurz(Date.parse("2026-11-20T17:39:00Z")), "20.11. 18:39");
  const jetzt = b(2026, 11, 20, 17, 0);
  assert.equal(faelligText(b(2026, 11, 20, 18, 0), jetzt), "heute bis 18:00 Uhr");
  assert.equal(faelligText(b(2026, 11, 23, 16, 0), jetzt), "bis Montag, 23. November, 16:00 Uhr");
});
