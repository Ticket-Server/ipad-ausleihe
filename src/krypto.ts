// Passwörter und PINs werden nur als PBKDF2-Hash gespeichert.

const ITERATIONEN = 100_000; // Höchstwert, den Cloudflare Workers erlauben
const enc = new TextEncoder();

function b64(bytes: Uint8Array) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function vonB64(text: string) {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function ableiten(geheimnis: string, salz: Uint8Array, iterationen: number) {
  const schluessel = await crypto.subtle.importKey("raw", enc.encode(geheimnis), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salz, iterations: iterationen }, schluessel, 256);
  return new Uint8Array(bits);
}

export async function hashen(geheimnis: string) {
  const salz = crypto.getRandomValues(new Uint8Array(16));
  const hash = await ableiten(geheimnis, salz, ITERATIONEN);
  return `pbkdf2$${ITERATIONEN}$${b64(salz)}$${b64(hash)}`;
}

export async function pruefen(geheimnis: string, gespeichert: string) {
  const [verfahren, iter, salz, hash] = gespeichert.split("$");
  if (verfahren !== "pbkdf2") return false;
  const neu = await ableiten(geheimnis, vonB64(salz), Number(iter));
  const alt = vonB64(hash);
  if (neu.length !== alt.length) return false;
  let unterschied = 0;
  for (let i = 0; i < neu.length; i++) unterschied |= neu[i] ^ alt[i];
  return unterschied === 0;
}

/** Gleich viel Rechenzeit wie eine echte Prüfung, damit man unbekannte Kürzel nicht an der Antwortzeit erkennt. */
export async function scheinPruefung(geheimnis: string) {
  await ableiten(geheimnis, new Uint8Array(16), ITERATIONEN);
}

function zufallAus(alphabet: string, laenge: number) {
  const out: string[] = [];
  const grenze = 256 - (256 % alphabet.length);
  while (out.length < laenge) {
    for (const b of crypto.getRandomValues(new Uint8Array(laenge * 2))) {
      if (b < grenze && out.length < laenge) out.push(alphabet[b % alphabet.length]);
    }
  }
  return out.join("");
}

export function pinErzeugen(laenge: number) {
  return zufallAus("0123456789", laenge);
}

/** Startpasswort für Lehrkräfte, gut abzuschreiben: z. B. "k7mp-x3ra-9bwe" */
export function startpasswortErzeugen() {
  const z = zufallAus("abcdefghjkmnpqrstuvwxyz23456789", 12);
  return `${z.slice(0, 4)}-${z.slice(4, 8)}-${z.slice(8)}`;
}

export function tokenErzeugen() {
  return b64(crypto.getRandomValues(new Uint8Array(32)));
}

export async function tokenHash(token: string) {
  return b64(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(token))));
}
