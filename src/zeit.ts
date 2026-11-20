// Alle Zeiten werden als Millisekunden (UTC) gespeichert und in deutscher Zeit angezeigt.

const ZONE = "Europe/Berlin";

const teileFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
  hourCycle: "h23",
});

export function berlinTeile(ms: number) {
  const t: Record<string, number> = {};
  for (const p of teileFormat.formatToParts(new Date(ms))) {
    if (p.type !== "literal") t[p.type] = Number(p.value);
  }
  return { jahr: t.year, monat: t.month, tag: t.day, stunde: t.hour, minute: t.minute, sekunde: t.second };
}

function versatz(ms: number) {
  const t = berlinTeile(ms);
  return Date.UTC(t.jahr, t.monat - 1, t.tag, t.stunde, t.minute, t.sekunde) - Math.floor(ms / 1000) * 1000;
}

/** Wandelt eine Uhrzeit in Deutschland in einen UTC-Zeitpunkt um (berücksichtigt Sommerzeit). */
export function berlinZeitpunkt(jahr: number, monat: number, tag: number, stunde: number, minute: number) {
  const alsUtc = Date.UTC(jahr, monat - 1, tag, stunde, minute);
  const schaetzung = alsUtc - versatz(alsUtc);
  return alsUtc - versatz(schaetzung);
}

function wochentag(jahr: number, monat: number, tag: number) {
  return new Date(Date.UTC(jahr, monat - 1, tag)).getUTCDay(); // 0 = Sonntag, 6 = Samstag
}

/** Rückgabe bis Ende des Schultags. Nach Schulschluss oder am Wochenende: nächster Schultag (Mo–Fr). */
export function faelligkeitBerechnen(jetzt: number, uhrzeit: string) {
  const [stunde, minute] = uhrzeit.split(":").map(Number);
  const t = berlinTeile(jetzt);
  let faellig = berlinZeitpunkt(t.jahr, t.monat, t.tag, stunde, minute);
  let wt = wochentag(t.jahr, t.monat, t.tag);
  if (faellig > jetzt && wt !== 0 && wt !== 6) return faellig;

  const d = new Date(Date.UTC(t.jahr, t.monat - 1, t.tag));
  do {
    d.setUTCDate(d.getUTCDate() + 1);
    wt = d.getUTCDay();
  } while (wt === 0 || wt === 6);
  return berlinZeitpunkt(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), stunde, minute);
}

const zweistellig = (n: number) => String(n).padStart(2, "0");

export function uhrzeit(ms: number) {
  const t = berlinTeile(ms);
  return `${zweistellig(t.stunde)}:${zweistellig(t.minute)}`;
}

/** z. B. 20.11. 18:39 */
export function kurz(ms: number) {
  const t = berlinTeile(ms);
  return `${zweistellig(t.tag)}.${zweistellig(t.monat)}. ${uhrzeit(ms)}`;
}

/** z. B. 20.11.2026 18:39 */
export function lang(ms: number) {
  const t = berlinTeile(ms);
  return `${zweistellig(t.tag)}.${zweistellig(t.monat)}.${t.jahr} ${uhrzeit(ms)}`;
}

const tagFormat = new Intl.DateTimeFormat("de-DE", { timeZone: ZONE, weekday: "long", day: "numeric", month: "long" });

/** z. B. "heute bis 16:00 Uhr" oder "bis Montag, 23. November, 16:00 Uhr" */
export function faelligText(faellig: number, jetzt: number) {
  const a = berlinTeile(faellig);
  const b = berlinTeile(jetzt);
  if (a.jahr === b.jahr && a.monat === b.monat && a.tag === b.tag) return `heute bis ${uhrzeit(faellig)} Uhr`;
  return `bis ${tagFormat.format(new Date(faellig))}, ${uhrzeit(faellig)} Uhr`;
}
