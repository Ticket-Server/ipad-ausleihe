import type { Child, FC } from "hono/jsx";
import { raw } from "hono/html";
import {
  type AusleiheZeile,
  type Geraet,
  type Konto,
  type Zustand,
  istGesperrt,
  MAX_GERAETE_PRO_VORGANG,
  MAX_WAGEN,
  wagenTeile,
  STATUS_TEXT,
  ZUSTAND_TEXT,
} from "./logik";
import { faelligText, kurz, lang, uhrzeit } from "./zeit";

export interface Meldung {
  art: "ok" | "fehler" | "info";
  text: string;
}

export type Werte = Record<string, string>;
export type Fehler = Record<string, string>;

// --- Grundgerüst ---

export const Seite: FC<{ titel: string; nutzer: Konto | null; meldungen?: Meldung[]; schmal?: boolean; children?: Child }> = ({
  titel,
  nutzer,
  meldungen = [],
  schmal,
  children,
}) => (
  <html lang="de">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{titel} · iPad-Ausleihe</title>
      <link rel="stylesheet" href="/app.css" />
    </head>
    <body>
      <header>
        <div class="inner">
          <a class="brand" href="/">
            📱 iPad-Ausleihe
          </a>
          <nav>
            {nutzer ? (
              <>
                <a href="/lehrkraft">Übersicht</a>
                <a href="/lehrkraft/geraete">Geräte</a>
                <a href="/lehrkraft/schueler">Schüler</a>
                {nutzer.ist_admin ? <a href="/lehrkraft/kollegium">Lehrkräfte</a> : null}
                <a href="/lehrkraft/passwort">Passwort</a>
                <form method="post" action="/abmelden">
                  <button class="link">Abmelden ({nutzer.kuerzel})</button>
                </form>
              </>
            ) : (
              <a href="/anmelden">Für Lehrkräfte</a>
            )}
          </nav>
        </div>
      </header>
      <main class={schmal ? "schmal" : ""}>
        {meldungen.length ? (
          <ul class="messages">
            {meldungen.map((m) => (
              <li class={m.art === "ok" ? "" : m.art === "fehler" ? "error" : "info"}>{m.text}</li>
            ))}
          </ul>
        ) : null}
        {children}
      </main>
      <footer>
        <span>iPad-Ausleihe · läuft auf Cloudflare</span>
      </footer>
    </body>
  </html>
);

// --- Formular-Bausteine ---

const FeldFehler: FC<{ text?: string }> = ({ text }) => (text ? <ul class="errorlist"><li>{text}</li></ul> : null);

export const Feld: FC<{
  name: string;
  label: string;
  werte?: Werte;
  fehler?: Fehler;
  typ?: string;
  hilfe?: string;
  pflicht?: boolean;
  attrs?: Record<string, string | boolean>;
  mehrzeilig?: number;
}> = ({ name, label, werte = {}, fehler = {}, typ = "text", hilfe, pflicht = true, attrs = {}, mehrzeilig }) => (
  <p>
    <label for={`f-${name}`}>{label}:</label>
    <FeldFehler text={fehler[name]} />
    {mehrzeilig ? (
      <textarea id={`f-${name}`} name={name} rows={mehrzeilig} required={pflicht} {...attrs}>
        {werte[name] ?? ""}
      </textarea>
    ) : (
      <input
        id={`f-${name}`}
        type={typ}
        name={name}
        value={typ === "password" ? "" : (werte[name] ?? "")}
        required={pflicht}
        {...attrs}
      />
    )}
    {hilfe ? <span class="helptext">{hilfe}</span> : null}
  </p>
);

const KUERZEL_ATTRS = { autocapitalize: "none", autocorrect: "off", spellcheck: "false", autocomplete: "off" };
const PIN_ATTRS = { inputmode: "numeric", autocomplete: "off", pattern: "[0-9]*", maxlength: "12" };

const KuerzelPin: FC<{ werte: Werte; fehler: Fehler }> = ({ werte, fehler }) => (
  <>
    <Feld name="kuerzel" label="Kürzel" werte={werte} fehler={fehler} attrs={KUERZEL_ATTRS} />
    <Feld name="pin" label="PIN" typ="password" werte={werte} fehler={fehler} attrs={PIN_ATTRS} />
  </>
);

const ZustandFelder: FC<{ werte: Werte; fehler: Fehler }> = ({ werte, fehler }) => (
  <>
    <p>
      <label>Wie ist das Gerät?</label>
      <ul>
        {(Object.keys(ZUSTAND_TEXT) as Zustand[]).map((z) => (
          <li>
            <label>
              <input type="radio" name="zustand" value={z} checked={(werte.zustand || "ok") === z} /> {ZUSTAND_TEXT[z]}
            </label>
          </li>
        ))}
      </ul>
    </p>
    <Feld
      name="bemerkung"
      label="Bemerkung"
      werte={werte}
      fehler={fehler}
      pflicht={false}
      mehrzeilig={2}
      attrs={{ maxlength: "500", placeholder: "Nur nötig bei einem Schaden oder Problem" }}
    />
  </>
);

const Bestaetigen = (text: string) => ({ onsubmit: `return confirm(${JSON.stringify(text)})` });

// --- Öffentliche Seiten ---

export const StartSeite: FC<{ nutzer: Konto | null; nr?: string; fehler?: string; meldungen: Meldung[] }> = ({ nutzer, nr, fehler, meldungen }) => (
  <Seite titel="Start" nutzer={nutzer} meldungen={meldungen} schmal>
    <h1>iPad ausleihen oder zurückgeben</h1>
    <div class="card">
      <p>
        <strong>Am einfachsten:</strong> QR-Code auf der Rückseite des iPads mit der Kamera scannen.
      </p>
      <p class="muted">Kein Scanner zur Hand? Inventarnummer vom Aufkleber eingeben:</p>
      <form method="get" action="/">
        <Feld
          name="nr"
          label="Inventarnummer"
          werte={{ nr: nr ?? "" }}
          fehler={fehler ? { nr: fehler } : {}}
          attrs={{ placeholder: "z. B. W01-05", autocapitalize: "characters", autofocus: true, maxlength: "20" }}
        />
        <button class="primary gross">Weiter</button>
      </form>
    </div>
  </Seite>
);

export interface GeraetSeitenDaten {
  nutzer: Konto | null;
  meldungen: Meldung[];
  geraet: Geraet;
  offen: AusleiheZeile | null;
  fehler?: string;
  aktion?: string;
  werte: Werte;
  feldFehler: Fehler;
  verlauf?: AusleiheZeile[];
}

export const GeraetSeite: FC<GeraetSeitenDaten> = ({ nutzer, meldungen, geraet: g, offen, fehler, aktion, werte, feldFehler, verlauf }) => {
  const w = (a: string) => (aktion === a ? werte : {});
  const f = (a: string) => (aktion === a ? feldFehler : {});
  const jetzt = Date.now();
  return (
    <Seite titel={g.inventarnummer} nutzer={nutzer} meldungen={meldungen} schmal>
      <div class="geraetkopf">
        <span class="icon" aria-hidden="true">
          📱
        </span>
        <div>
          <h1>{g.inventarnummer}</h1>
          <div class="muted">
            {g.bezeichnung}
            {g.standort ? ` · ${g.standort}` : ""}
          </div>
        </div>
      </div>

      {fehler ? (
        <div class="fehler" role="alert">
          {fehler}
        </div>
      ) : null}

      {offen ? (
        <div class="card">
          <div class="row">
            <strong>Ausgeliehen</strong>
            {offen.faellig_am < jetzt ? <span class="badge danger">überfällig</span> : <span class="badge warn">ausgeliehen</span>}
          </div>
          <p class="muted">
            Seit {kurz(offen.ausgeliehen_am)} Uhr, Rückgabe {faelligText(offen.faellig_am, jetzt)}.
          </p>
          <h2>Zurückgeben</h2>
          <form method="post">
            <input type="hidden" name="aktion" value="zurueckgeben" />
            <KuerzelPin werte={w("zurueckgeben")} fehler={f("zurueckgeben")} />
            <ZustandFelder werte={w("zurueckgeben")} fehler={f("zurueckgeben")} />
            <button class="primary gross">Zurückgeben</button>
          </form>
        </div>
      ) : g.status === "verfuegbar" ? (
        <div class="card">
          <div class="row">
            <strong>Frei</strong>
            <span class="badge ok">verfügbar</span>
          </div>
          <h2>Ausleihen</h2>
          <form method="post">
            <input type="hidden" name="aktion" value="ausleihen" />
            <KuerzelPin werte={w("ausleihen")} fehler={f("ausleihen")} />
            <button class="primary gross">Ausleihen</button>
          </form>
          <p class="muted">PIN vergessen? Bitte bei einer Lehrkraft melden.</p>
        </div>
      ) : (
        <div class="card">
          <div class="row">
            <strong>Nicht ausleihbar</strong>
            <span class="badge danger">{STATUS_TEXT[g.status]}</span>
          </div>
          <p class="muted">Bitte ein anderes Gerät nehmen und dieses bei einer Lehrkraft abgeben.</p>
        </div>
      )}

      {nutzer ? (
        <>
          <h2>Für Lehrkräfte</h2>
          <div class="card">
            {offen ? (
              <>
                <p>
                  Ausgeliehen an{" "}
                  <a href={`/lehrkraft/schueler/${offen.kuerzel}`}>
                    <strong>
                      {offen.kuerzel}
                      {offen.klasse ? ` (${offen.klasse})` : ""}
                    </strong>
                  </a>
                  .
                </p>
                <details open={aktion === "lk_zurueckbuchen"}>
                  <summary>Ohne PIN zurückbuchen</summary>
                  <form method="post">
                    <input type="hidden" name="aktion" value="lk_zurueckbuchen" />
                    <ZustandFelder werte={w("lk_zurueckbuchen")} fehler={f("lk_zurueckbuchen")} />
                    <button class="primary">Zurückbuchen</button>
                  </form>
                </details>
              </>
            ) : g.status === "verfuegbar" ? (
              <details open={aktion === "lk_ausgeben"}>
                <summary>An Schüler ausgeben (ohne PIN)</summary>
                <form method="post">
                  <input type="hidden" name="aktion" value="lk_ausgeben" />
                  <Feld name="kuerzel" label="Kürzel des Schülers" werte={w("lk_ausgeben")} fehler={f("lk_ausgeben")} attrs={KUERZEL_ATTRS} />
                  <button class="primary">Ausgeben</button>
                </form>
              </details>
            ) : null}
            <div class="actions">
              <a class="btn klein" href={`/lehrkraft/geraete/${g.inventarnummer}`}>
                Gerät bearbeiten / Status ändern
              </a>
              <a class="btn klein" href={`/lehrkraft/geraete/etiketten?nr=${g.inventarnummer}`}>
                QR-Etikett drucken
              </a>
            </div>
          </div>

          <h2>Verlauf</h2>
          {verlauf && verlauf.length ? (
            <div class="tabelle">
              <table>
                <tr>
                  <th>Kürzel</th>
                  <th>Ausgeliehen</th>
                  <th>Zurück</th>
                  <th>Zustand</th>
                </tr>
                {verlauf.map((a) => (
                  <tr>
                    <td>
                      <a href={`/lehrkraft/schueler/${a.kuerzel}`}>{a.kuerzel}</a>
                    </td>
                    <td>
                      {kurz(a.ausgeliehen_am)}
                      {a.ausgegeben_von_kuerzel ? (
                        <>
                          <br />
                          <span class="muted">durch {a.ausgegeben_von_kuerzel}</span>
                        </>
                      ) : null}
                    </td>
                    <td>
                      {a.zurueckgegeben_am ? (
                        <>
                          {kurz(a.zurueckgegeben_am)}
                          {a.zurueckgebucht_von_kuerzel ? (
                            <>
                              <br />
                              <span class="muted">durch {a.zurueckgebucht_von_kuerzel}</span>
                            </>
                          ) : null}
                        </>
                      ) : (
                        <span class="badge warn">offen</span>
                      )}
                    </td>
                    <td>
                      {a.zustand ? ZUSTAND_TEXT[a.zustand] : ""}
                      {a.bemerkung ? (
                        <>
                          <br />
                          <span class="muted">{a.bemerkung}</span>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </table>
            </div>
          ) : (
            <p class="muted">Noch keine Ausleihen.</p>
          )}
        </>
      ) : null}
    </Seite>
  );
};

export const AnmeldeSeite: FC<{ werte: Werte; fehler?: string; weiter: string; meldungen: Meldung[] }> = ({ werte, fehler, weiter, meldungen }) => (
  <Seite titel="Anmelden" nutzer={null} meldungen={meldungen} schmal>
    <h1>Anmelden für Lehrkräfte</h1>
    {fehler ? (
      <div class="fehler" role="alert">
        {fehler}
      </div>
    ) : null}
    <div class="card">
      <form method="post">
        <input type="hidden" name="weiter" value={weiter} />
        <Feld name="kuerzel" label="Kürzel" werte={werte} attrs={{ ...KUERZEL_ATTRS, autofocus: true, autocomplete: "username" }} />
        <Feld name="passwort" label="Passwort" typ="password" attrs={{ autocomplete: "current-password" }} />
        <button class="primary gross">Anmelden</button>
      </form>
    </div>
    <p class="muted">Schüler brauchen kein Login. Sie geben Kürzel und PIN direkt beim Ausleihen ein.</p>
  </Seite>
);

export const EinrichtenSeite: FC<{ werte: Werte; fehler: Fehler }> = ({ werte, fehler }) => (
  <Seite titel="Einrichten" nutzer={null} schmal>
    <h1>Ersteinrichtung</h1>
    <div class="notice">
      Es gibt noch keine Lehrkraft. Lege jetzt das Konto des Schul-Admins an. Diese Seite ist danach nicht mehr erreichbar.
    </div>
    <div class="card">
      <form method="post">
        <Feld name="kuerzel" label="Kürzel des Schul-Admins" werte={werte} fehler={fehler} attrs={{ ...KUERZEL_ATTRS, autofocus: true }} />
        <Feld name="passwort" label="Passwort" typ="password" fehler={fehler} hilfe="Mindestens 10 Zeichen." attrs={{ autocomplete: "new-password" }} />
        <Feld name="passwort2" label="Passwort wiederholen" typ="password" fehler={fehler} attrs={{ autocomplete: "new-password" }} />
        <button class="primary gross">Admin-Konto anlegen</button>
      </form>
    </div>
  </Seite>
);

// --- Lehrkräfte ---

export interface Zahlen {
  frei: number;
  ausgeliehen: number;
  ueberfaellig: number;
  gesperrt: number;
}

export const UebersichtSeite: FC<{
  nutzer: Konto;
  meldungen: Meldung[];
  offene: AusleiheZeile[];
  schaeden: AusleiheZeile[];
  zahlen: Zahlen;
  demo: boolean;
}> = ({ nutzer, meldungen, offene, schaeden, zahlen, demo }) => {
  const jetzt = Date.now();
  return (
    <Seite titel="Übersicht" nutzer={nutzer} meldungen={meldungen}>
      <h1>Übersicht</h1>
      <div class="zahlen">
        <div class="card"><strong>{zahlen.frei}</strong><span class="muted">frei</span></div>
        <div class="card"><strong>{zahlen.ausgeliehen}</strong><span class="muted">ausgeliehen</span></div>
        <div class="card"><strong>{zahlen.ueberfaellig}</strong><span class="muted">überfällig</span></div>
        <div class="card"><strong>{zahlen.gesperrt}</strong><span class="muted">defekt / außer Betrieb</span></div>
      </div>

      <h2>Ausgeliehen</h2>
      {offene.length ? (
        <>
          <div class="tabelle">
            <table>
              <tr>
                <th>Gerät</th>
                <th>Kürzel</th>
                <th>Seit</th>
                <th>Rückgabe bis</th>
                <th></th>
              </tr>
              {offene.map((a) => {
                const ueber = a.faellig_am < jetzt;
                return (
                  <tr class={ueber ? "ueberfaellig" : ""}>
                    <td><a href={`/g/${a.inventarnummer}`}>{a.inventarnummer}</a></td>
                    <td>
                      <a href={`/lehrkraft/schueler/${a.kuerzel}`}>{a.kuerzel}</a>
                      {a.klasse ? <span class="muted"> {a.klasse}</span> : null}
                    </td>
                    <td>{kurz(a.ausgeliehen_am)}</td>
                    <td>
                      {kurz(a.faellig_am)} {ueber ? <span class="badge danger">überfällig</span> : null}
                    </td>
                    <td>
                      <form method="post" action={`/g/${a.inventarnummer}`}>
                        <input type="hidden" name="aktion" value="lk_zurueckbuchen" />
                        <input type="hidden" name="zustand" value="ok" />
                        <input type="hidden" name="weiter" value="uebersicht" />
                        <button class="klein">Zurückbuchen</button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </table>
          </div>
          <p class="muted">„Zurückbuchen“ hier bucht mit Zustand „Alles in Ordnung“. Für Schäden das Gerät öffnen.</p>
        </>
      ) : (
        <p class="muted">Gerade ist kein Gerät ausgeliehen.</p>
      )}

      <h2>Gemeldete Schäden</h2>
      {schaeden.length ? (
        schaeden.map((a) => (
          <div class="card">
            <div class="row">
              <strong><a href={`/g/${a.inventarnummer}`}>{a.inventarnummer}</a></strong>
              <span class="badge danger">{STATUS_TEXT[a.geraet_status]}</span>
            </div>
            <p>{a.bemerkung}</p>
            <p class="muted">
              Gemeldet bei Rückgabe am {lang(a.zurueckgegeben_am!)} · ausgeliehen von{" "}
              <a href={`/lehrkraft/schueler/${a.kuerzel}`}>
                {a.kuerzel}
                {a.klasse ? ` (${a.klasse})` : ""}
              </a>
            </p>
            <div class="actions">
              <form method="post" action={`/lehrkraft/schaden/${a.id}/erledigt`}>
                <input type="hidden" name="freigeben" value="1" />
                <button class="primary klein">Erledigt, Gerät wieder freigeben</button>
              </form>
              <form method="post" action={`/lehrkraft/schaden/${a.id}/erledigt`}>
                <button class="klein">Erledigt, Gerät bleibt gesperrt</button>
              </form>
            </div>
          </div>
        ))
      ) : (
        <p class="muted">Keine offenen Schäden.</p>
      )}

      {demo && nutzer.ist_admin ? (
        <>
          <h2>Demo</h2>
          <form method="post" action="/lehrkraft/demo" {...Bestaetigen("Alle Geräte, Schüler und Ausleihen löschen und Demo-Daten laden?")}>
            <button class="danger">Demo-Daten laden (löscht alle Geräte und Schüler)</button>
          </form>
        </>
      ) : null}
    </Seite>
  );
};

export const GeraeteSeite: FC<{
  nutzer: Konto;
  meldungen: Meldung[];
  geraete: (Geraet & { ausgeliehen: number })[];
  wagenListe: number[];
  wagen: number | null;
}> = ({ nutzer, meldungen, geraete, wagenListe, wagen }) => (
  <Seite titel="Geräte" nutzer={nutzer} meldungen={meldungen}>
    <div class="row">
      <h1>{wagen ? `Wagen ${wagen}` : "Geräte"}</h1>
      <div class="actions" style="margin:0">
        <a class="btn" href={`/lehrkraft/geraete/etiketten${wagen ? `?wagen=${wagen}` : ""}`}>
          QR-Etiketten drucken
        </a>
        <a class="btn" href="/lehrkraft/geraete/neu">+ Einzelnes Gerät</a>
        <a class="btn primary" href={`/lehrkraft/geraete/wagen${wagen ? `?wagen=${wagen}` : ""}`}>
          {wagen ? "+ Geräte ergänzen" : "+ iPad-Wagen anlegen"}
        </a>
      </div>
    </div>
    {wagenListe.length ? (
      <div class="filters">
        <a href="/lehrkraft/geraete" class={wagen ? "" : "active"}>Alle</a>
        {wagenListe.map((w) => (
          <a href={`/lehrkraft/geraete?wagen=${w}`} class={w === wagen ? "active" : ""}>
            Wagen {w}
          </a>
        ))}
      </div>
    ) : null}
    {geraete.length ? (
      <div class="tabelle">
        <table>
          <tr>
            <th>Inventarnummer</th>
            <th>Bezeichnung</th>
            <th>Standort</th>
            <th>Status</th>
            <th></th>
          </tr>
          {geraete.map((g) => (
            <tr>
              <td><a href={`/g/${g.inventarnummer}`}><strong>{g.inventarnummer}</strong></a></td>
              <td>{g.bezeichnung}</td>
              <td>{g.standort}</td>
              <td>
                {g.ausgeliehen ? (
                  <span class="badge warn">ausgeliehen</span>
                ) : g.status === "verfuegbar" ? (
                  <span class="badge ok">frei</span>
                ) : (
                  <span class="badge danger">{STATUS_TEXT[g.status]}</span>
                )}
              </td>
              <td><a href={`/lehrkraft/geraete/${g.inventarnummer}`}>Bearbeiten</a></td>
            </tr>
          ))}
        </table>
      </div>
    ) : (
      <p class="muted">
        Noch keine Geräte angelegt. Am schnellsten geht es mit <a href="/lehrkraft/geraete/wagen">iPad-Wagen anlegen</a>.
      </p>
    )}
    {wagen && geraete.length ? (
      <details style="margin-top:20px">
        <summary>Geräte dieses Wagens löschen</summary>
        <p class="muted">
          Löscht alle Geräte von Wagen {wagen}, die noch nie ausgeliehen wurden – z. B. wenn versehentlich zu viele angelegt wurden.
          Geräte mit Ausleihverlauf bleiben erhalten.
        </p>
        <form method="post" action={`/lehrkraft/geraete/wagen/${wagen}/loeschen`} {...Bestaetigen(`Alle unbenutzten Geräte von Wagen ${wagen} löschen?`)}>
          <button class="danger">Unbenutzte Geräte von Wagen {wagen} löschen</button>
        </form>
      </details>
    ) : null}
  </Seite>
);

export const WagenSeite: FC<{
  nutzer: Konto;
  werte: Werte;
  fehler?: string;
  bestand: Record<number, { anzahl: number; hoechste: number }>;
}> = ({ nutzer, werte, fehler, bestand }) => (
  <Seite titel="iPad-Wagen anlegen" nutzer={nutzer} schmal>
    <h1>iPad-Wagen anlegen</h1>
    {fehler ? (
      <div class="fehler" role="alert">
        {fehler}
      </div>
    ) : null}
    <div class="card">
      <form method="post" id="wagen-form">
        <Feld
          name="wagen"
          label="Wagen-Nummer"
          typ="number"
          werte={werte}
          attrs={{ min: "1", max: String(MAX_WAGEN), inputmode: "numeric", autofocus: true }}
          hilfe="Die Nummer, die auf dem iPad-Wagen steht."
        />
        <Feld
          name="anzahl"
          label="Anzahl Geräte"
          typ="number"
          werte={werte}
          attrs={{ min: "1", max: String(MAX_GERAETE_PRO_VORGANG), inputmode: "numeric" }}
          hilfe={`Bis zu ${MAX_GERAETE_PRO_VORGANG} auf einmal.`}
        />
        <Feld
          name="bezeichnung"
          label="Gerätetyp (optional)"
          werte={werte}
          pflicht={false}
          attrs={{ maxlength: "100", placeholder: "z. B. iPad 10. Gen." }}
        />
        <div class="notice" id="vorschau" aria-live="polite">
          Beispiel: Wagen 1 mit 20 Geräten ergibt <strong>W01-01</strong> bis <strong>W01-20</strong>.
        </div>
        <div class="actions">
          <button class="primary">Geräte anlegen</button>
          <a class="btn" href="/lehrkraft/geraete">Abbrechen</a>
        </div>
      </form>
    </div>
    <p class="muted">
      Hat der Wagen schon Geräte, werden die neuen hinten angehängt. Danach können die QR-Etiketten für den ganzen Wagen gedruckt werden.
    </p>
    {raw(`<script>
(() => {
  const bestand = ${JSON.stringify(bestand)};
  const f = document.getElementById("wagen-form");
  const v = document.getElementById("vorschau");
  const nr = (w, g) => "W" + String(w).padStart(2, "0") + "-" + String(g).padStart(2, "0");
  const zeigen = () => {
    const w = parseInt(f.wagen.value, 10), n = parseInt(f.anzahl.value, 10);
    if (!(w >= 1 && w <= ${MAX_WAGEN}) || !(n >= 1 && n <= ${MAX_GERAETE_PRO_VORGANG})) return;
    const b = bestand[w];
    const start = (b ? b.hoechste : 0) + 1;
    v.innerHTML = (b ? "Wagen " + w + " hat schon " + b.anzahl + " Gerät" + (b.anzahl === 1 ? "" : "e") + ". " : "")
      + "Es werden <strong>" + n + "</strong> Gerät" + (n === 1 ? "" : "e") + " angelegt: <strong>" + nr(w, start) + "</strong>"
      + (n > 1 ? " bis <strong>" + nr(w, start + n - 1) + "</strong>" : "") + ".";
  };
  f.addEventListener("input", zeigen);
  zeigen();
})();
</script>`)}
  </Seite>
);

export const GeraetFormSeite: FC<{ nutzer: Konto; geraet: Geraet | null; werte: Werte; fehler: Fehler; meldungen?: Meldung[] }> = ({
  nutzer,
  geraet,
  werte,
  fehler,
  meldungen = [],
}) => (
  <Seite titel={geraet ? geraet.inventarnummer : "Neues Gerät"} nutzer={nutzer} meldungen={meldungen} schmal>
    <h1>{geraet ? `${geraet.inventarnummer} bearbeiten` : "Neues Gerät"}</h1>
    <div class="card">
      <form method="post">
        <Feld name="inventarnummer" label="Inventarnummer" werte={werte} fehler={fehler} hilfe="Steht auf dem Aufkleber und im QR-Code, z. B. W01-05." attrs={{ maxlength: "20", autocapitalize: "characters" }} />
        <Feld name="bezeichnung" label="Bezeichnung" werte={werte} fehler={fehler} pflicht={false} hilfe="z. B. iPad 10. Gen." attrs={{ maxlength: "100" }} />
        <Feld name="seriennummer" label="Seriennummer" werte={werte} fehler={fehler} pflicht={false} attrs={{ maxlength: "50" }} />
        <Feld name="standort" label="Standort" werte={werte} fehler={fehler} pflicht={false} hilfe="z. B. Wagen 1 oder Raum 104" attrs={{ maxlength: "50" }} />
        <p>
          <label for="f-status">Status:</label>
          <select id="f-status" name="status">
            {Object.entries(STATUS_TEXT).map(([wert, text]) => (
              <option value={wert} selected={(werte.status || "verfuegbar") === wert}>
                {text}
              </option>
            ))}
          </select>
        </p>
        <Feld name="bemerkung" label="Bemerkung" werte={werte} fehler={fehler} pflicht={false} mehrzeilig={3} attrs={{ maxlength: "1000" }} />
        <div class="actions">
          <button class="primary">Speichern</button>
          <a class="btn" href="/lehrkraft/geraete">Abbrechen</a>
        </div>
      </form>
    </div>
    {geraet ? (
      <form method="post" action={`/lehrkraft/geraete/${geraet.inventarnummer}/loeschen`} {...Bestaetigen(`${geraet.inventarnummer} löschen?`)}>
        <button class="danger">Gerät löschen</button>
        <span class="muted"> Nur möglich, wenn es noch nie ausgeliehen wurde.</span>
      </form>
    ) : null}
  </Seite>
);

export const EtikettenSeite: FC<{ nutzer: Konto; etiketten: { nr: string; svg: string }[] }> = ({ nutzer, etiketten }) => (
  <Seite titel="QR-Etiketten" nutzer={nutzer}>
    <div class="kein-druck">
      <h1>QR-Etiketten</h1>
      <p class="muted">
        Ausdrucken, ausschneiden und auf die Rückseite oder Hülle der iPads kleben. Der Code führt direkt zur Seite des Geräts.
      </p>
      <div class="actions" style="margin-bottom:16px">
        <button class="primary" onclick="window.print()">Drucken</button>
      </div>
    </div>
    <div class="etiketten">
      {etiketten.length ? (
        etiketten.map((e) => (
          <div class="etikett">
            {raw(e.svg)}
            <strong>{e.nr}</strong>
            {wagenTeile(e.nr) ? (
              <small>
                Wagen {wagenTeile(e.nr)!.wagen} · Gerät {wagenTeile(e.nr)!.geraet}
              </small>
            ) : null}
            <small>Scannen zum Ausleihen &amp; Zurückgeben</small>
          </div>
        ))
      ) : (
        <p class="muted">Keine Geräte.</p>
      )}
    </div>
  </Seite>
);

export const SchuelerListeSeite: FC<{
  nutzer: Konto;
  meldungen: Meldung[];
  schueler: (Konto & { offen: number })[];
  klassen: string[];
  klasse: string;
  suche: string;
}> = ({ nutzer, meldungen, schueler, klassen, klasse, suche }) => (
  <Seite titel="Schüler" nutzer={nutzer} meldungen={meldungen}>
    <div class="row">
      <h1>Schüler</h1>
      <div class="actions" style="margin:0">
        <a class="btn" href="/lehrkraft/schueler/import">Liste importieren</a>
        <a class="btn primary" href="/lehrkraft/schueler/neu">+ Schüler</a>
      </div>
    </div>
    <div class="filters">
      <a href="?" class={klasse ? "" : "active"}>Alle</a>
      {klassen.map((k) => (
        <a href={`?klasse=${encodeURIComponent(k)}`} class={k === klasse ? "active" : ""}>
          {k}
        </a>
      ))}
      <form method="get">
        {klasse ? <input type="hidden" name="klasse" value={klasse} /> : null}
        <input type="search" name="q" value={suche} placeholder="Kürzel suchen" />
      </form>
    </div>
    {schueler.length ? (
      <div class="tabelle">
        <table>
          <tr>
            <th>Kürzel</th>
            <th>Klasse</th>
            <th>Status</th>
          </tr>
          {schueler.map((s) => (
            <tr>
              <td><a href={`/lehrkraft/schueler/${s.kuerzel}`}><strong>{s.kuerzel}</strong></a></td>
              <td>{s.klasse}</td>
              <td>
                {!s.aktiv ? <span class="badge">deaktiviert</span> : null} {istGesperrt(s) ? <span class="badge danger">gesperrt</span> : null}{" "}
                {s.offen ? <span class="badge warn">hat ein Gerät</span> : null}
              </td>
            </tr>
          ))}
        </table>
      </div>
    ) : (
      <p class="muted">Keine Schüler gefunden.</p>
    )}
  </Seite>
);

export const SchuelerNeuSeite: FC<{ nutzer: Konto; werte: Werte; fehler: Fehler }> = ({ nutzer, werte, fehler }) => (
  <Seite titel="Neuer Schüler" nutzer={nutzer} schmal>
    <h1>Neuer Schüler</h1>
    <div class="card">
      <form method="post">
        <Feld name="kuerzel" label="Kürzel" werte={werte} fehler={fehler} hilfe="Schulkürzel, kein Name." attrs={KUERZEL_ATTRS} />
        <Feld name="klasse" label="Klasse" werte={werte} fehler={fehler} pflicht={false} hilfe="z. B. 7b" attrs={{ maxlength: "10" }} />
        <p class="muted">Die PIN wird automatisch erzeugt und auf der nächsten Seite einmalig angezeigt.</p>
        <div class="actions">
          <button class="primary">Anlegen</button>
          <a class="btn" href="/lehrkraft/schueler">Abbrechen</a>
        </div>
      </form>
    </div>
  </Seite>
);

export const SchuelerImportSeite: FC<{ nutzer: Konto; werte: Werte; fehlerListe: string[] }> = ({ nutzer, werte, fehlerListe }) => (
  <Seite titel="Schüler importieren" nutzer={nutzer} schmal>
    <h1>Schülerliste importieren</h1>
    <div class="card">
      <form method="post">
        {fehlerListe.length ? (
          <ul class="errorlist">
            {fehlerListe.map((t) => (
              <li>{t}</li>
            ))}
          </ul>
        ) : null}
        <Feld
          name="zeilen"
          label="Kürzel (eines pro Zeile)"
          werte={werte}
          mehrzeilig={12}
          hilfe="Pro Zeile ein Kürzel, optional mit Semikolon und Klasse dahinter. Funktioniert auch mit einer aus Excel kopierten Spalte. Vorhandene Kürzel werden übersprungen."
          attrs={{ placeholder: "mamu7;7b\nlesc8;7b\njoka2;8a" }}
        />
        <Feld name="klasse" label="Klasse für alle (optional)" werte={werte} pflicht={false} hilfe="Wird verwendet, wenn in der Zeile keine Klasse steht." attrs={{ maxlength: "10" }} />
        <p class="muted">
          Für jedes neue Kürzel wird eine PIN erzeugt. Auf der nächsten Seite kann die Liste mit Kürzel und PIN einmalig ausgedruckt werden.
        </p>
        <div class="actions">
          <button class="primary">Importieren</button>
          <a class="btn" href="/lehrkraft/schueler">Abbrechen</a>
        </div>
      </form>
    </div>
  </Seite>
);

export interface NeuerZugang {
  kuerzel: string;
  klasse: string;
  geheimnis: string;
  art: "pin" | "passwort";
}

export const ZugaengeSeite: FC<{ nutzer: Konto; zugaenge: NeuerZugang[]; zurueck: string }> = ({ nutzer, zugaenge, zurueck }) => {
  const pins = zugaenge[0]?.art === "pin";
  return (
    <Seite titel={pins ? "Neue PINs" : "Neues Passwort"} nutzer={nutzer}>
      <div class="kein-druck">
        <h1>{pins ? "Neue PINs" : "Startpasswort"}</h1>
        <div class="notice">
          {pins ? "Diese PINs werden " : "Dieses Passwort wird "}
          <strong>nur jetzt</strong> angezeigt.{" "}
          {pins
            ? "Bitte ausdrucken und an die Schüler verteilen, z. B. als Zettel zum Ausschneiden."
            : "Bitte der Lehrkraft geben. Sie sollte es nach der ersten Anmeldung unter „Passwort“ ändern."}
        </div>
        <div class="actions" style="margin-bottom:16px">
          <button class="primary" onclick="window.print()">Drucken</button>
          <a class="btn" href={zurueck}>Fertig</a>
        </div>
      </div>
      <div class="tabelle pins">
        <table>
          <tr>
            <th>Kürzel</th>
            {pins ? <th>Klasse</th> : null}
            <th>{pins ? "PIN" : "Passwort"}</th>
          </tr>
          {zugaenge.map((z) => (
            <tr>
              <td><strong>{z.kuerzel}</strong></td>
              {pins ? <td>{z.klasse}</td> : null}
              <td class="pin">{z.geheimnis}</td>
            </tr>
          ))}
        </table>
      </div>
      {pins ? <p class="nur-druck">iPad-Ausleihe: QR-Code am iPad scannen, Kürzel und PIN eingeben. PIN geheim halten.</p> : null}
    </Seite>
  );
};

export const SchuelerDetailSeite: FC<{ nutzer: Konto; meldungen: Meldung[]; s: Konto; verlauf: AusleiheZeile[] }> = ({
  nutzer,
  meldungen,
  s,
  verlauf,
}) => {
  const jetzt = Date.now();
  return (
    <Seite titel={s.kuerzel} nutzer={nutzer} meldungen={meldungen}>
      <div class="row">
        <h1>
          {s.kuerzel} {s.klasse ? <span class="muted">({s.klasse})</span> : null}
        </h1>
        <div>
          {!s.aktiv ? <span class="badge">deaktiviert</span> : null}{" "}
          {istGesperrt(s) ? <span class="badge danger">gesperrt bis {uhrzeit(s.gesperrt_bis!)}</span> : null}
        </div>
      </div>

      <div class="card">
        <form method="post" class="row" style="align-items:flex-end">
          <input type="hidden" name="aktion" value="speichern" />
          <div style="flex:1">
            <Feld name="klasse" label="Klasse" werte={{ klasse: s.klasse }} pflicht={false} attrs={{ maxlength: "10" }} />
          </div>
          <p>
            <button>Klasse speichern</button>
          </p>
        </form>
        <div class="actions">
          <form method="post" {...Bestaetigen("Neue PIN vergeben? Die alte PIN funktioniert dann nicht mehr.")}>
            <input type="hidden" name="aktion" value="pin" />
            <button>Neue PIN vergeben</button>
          </form>
          {istGesperrt(s) ? (
            <form method="post">
              <input type="hidden" name="aktion" value="entsperren" />
              <button>Entsperren</button>
            </form>
          ) : null}
          <form method="post">
            <input type="hidden" name="aktion" value={s.aktiv ? "deaktivieren" : "aktivieren"} />
            <button>{s.aktiv ? "Deaktivieren" : "Aktivieren"}</button>
          </form>
          <form method="post" {...Bestaetigen(`${s.kuerzel} und den gesamten Ausleihverlauf endgültig löschen?`)}>
            <input type="hidden" name="aktion" value="loeschen" />
            <button class="danger">Löschen</button>
          </form>
        </div>
      </div>

      <h2>Ausleihen</h2>
      {verlauf.length ? (
        <div class="tabelle">
          <table>
            <tr>
              <th>Gerät</th>
              <th>Ausgeliehen</th>
              <th>Zurück</th>
              <th>Zustand</th>
            </tr>
            {verlauf.map((a) => (
              <tr class={!a.zurueckgegeben_am && a.faellig_am < jetzt ? "ueberfaellig" : ""}>
                <td><a href={`/g/${a.inventarnummer}`}>{a.inventarnummer}</a></td>
                <td>{lang(a.ausgeliehen_am)}</td>
                <td>{a.zurueckgegeben_am ? lang(a.zurueckgegeben_am) : <span class="badge warn">offen</span>}</td>
                <td>
                  {a.zustand ? ZUSTAND_TEXT[a.zustand] : ""}
                  {a.bemerkung ? (
                    <>
                      <br />
                      <span class="muted">{a.bemerkung}</span>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </table>
        </div>
      ) : (
        <p class="muted">Keine Ausleihen gespeichert.</p>
      )}
    </Seite>
  );
};

export const KollegiumSeite: FC<{ nutzer: Konto; meldungen: Meldung[]; lehrkraefte: Konto[]; werte: Werte; fehler: Fehler }> = ({
  nutzer,
  meldungen,
  lehrkraefte,
  werte,
  fehler,
}) => (
  <Seite titel="Lehrkräfte" nutzer={nutzer} meldungen={meldungen}>
    <h1>Lehrkräfte</h1>
    <div class="tabelle">
      <table>
        <tr>
          <th>Kürzel</th>
          <th>Rolle</th>
          <th></th>
        </tr>
        {lehrkraefte.map((l) => (
          <tr>
            <td>
              <strong>{l.kuerzel}</strong> {!l.aktiv ? <span class="badge">deaktiviert</span> : null}{" "}
              {istGesperrt(l) ? <span class="badge danger">gesperrt</span> : null}
            </td>
            <td>{l.ist_admin ? "Schul-Admin" : "Lehrkraft"}</td>
            <td>
              {l.id === nutzer.id ? (
                <span class="muted">Das bist du</span>
              ) : (
                <div class="actions" style="margin:0">
                  <form method="post" action={`/lehrkraft/kollegium/${l.kuerzel}`} {...Bestaetigen(`Neues Startpasswort für ${l.kuerzel} erzeugen?`)}>
                    <input type="hidden" name="aktion" value="passwort" />
                    <button class="klein">Neues Passwort</button>
                  </form>
                  <form method="post" action={`/lehrkraft/kollegium/${l.kuerzel}`}>
                    <input type="hidden" name="aktion" value={l.ist_admin ? "kein_admin" : "admin"} />
                    <button class="klein">{l.ist_admin ? "Admin-Rechte entziehen" : "Zum Admin machen"}</button>
                  </form>
                  <form method="post" action={`/lehrkraft/kollegium/${l.kuerzel}`}>
                    <input type="hidden" name="aktion" value={l.aktiv ? "deaktivieren" : "aktivieren"} />
                    <button class="klein">{l.aktiv ? "Deaktivieren" : "Aktivieren"}</button>
                  </form>
                  <form method="post" action={`/lehrkraft/kollegium/${l.kuerzel}`} {...Bestaetigen(`Konto ${l.kuerzel} löschen?`)}>
                    <input type="hidden" name="aktion" value="loeschen" />
                    <button class="klein danger">Löschen</button>
                  </form>
                </div>
              )}
            </td>
          </tr>
        ))}
      </table>
    </div>

    <h2>Lehrkraft hinzufügen</h2>
    <div class="card">
      <form method="post" action="/lehrkraft/kollegium">
        <Feld name="kuerzel" label="Kürzel" werte={werte} fehler={fehler} attrs={KUERZEL_ATTRS} />
        <p class="checkbox">
          <label>
            <input type="checkbox" name="ist_admin" value="1" checked={werte.ist_admin === "1"} /> Schul-Admin (darf Lehrkräfte verwalten)
          </label>
        </p>
        <p class="muted">Ein Startpasswort wird erzeugt und einmalig angezeigt.</p>
        <button class="primary">Anlegen</button>
      </form>
    </div>
  </Seite>
);

export const PasswortSeite: FC<{ nutzer: Konto; meldungen: Meldung[]; fehler: Fehler }> = ({ nutzer, meldungen, fehler }) => (
  <Seite titel="Passwort ändern" nutzer={nutzer} meldungen={meldungen} schmal>
    <h1>Passwort ändern</h1>
    <div class="card">
      <form method="post">
        <Feld name="alt" label="Bisheriges Passwort" typ="password" fehler={fehler} attrs={{ autocomplete: "current-password" }} />
        <Feld name="neu" label="Neues Passwort" typ="password" fehler={fehler} hilfe="Mindestens 10 Zeichen." attrs={{ autocomplete: "new-password" }} />
        <Feld name="neu2" label="Neues Passwort wiederholen" typ="password" fehler={fehler} attrs={{ autocomplete: "new-password" }} />
        <button class="primary">Speichern</button>
      </form>
    </div>
  </Seite>
);

export const FehlerSeite: FC<{ nutzer: Konto | null; titel: string; text: string }> = ({ nutzer, titel, text }) => (
  <Seite titel={titel} nutzer={nutzer} schmal>
    <h1>{titel}</h1>
    <div class="card">
      <p>{text}</p>
      <a class="btn" href="/">Zur Startseite</a>
    </div>
  </Seite>
);
