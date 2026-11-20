// Datenbankschema. Wird beim ersten Aufruf automatisch angelegt, es sind keine Migrationsbefehle nötig.
// Neue Spalten später nur mit "ALTER TABLE ... ADD COLUMN" in einer weiteren Stufe ergänzen.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS konten (
    id INTEGER PRIMARY KEY,
    kuerzel TEXT NOT NULL UNIQUE,
    rolle TEXT NOT NULL CHECK (rolle IN ('schueler', 'lehrkraft')),
    ist_admin INTEGER NOT NULL DEFAULT 0,
    klasse TEXT NOT NULL DEFAULT '',
    geheimnis TEXT NOT NULL,
    aktiv INTEGER NOT NULL DEFAULT 1,
    fehlversuche INTEGER NOT NULL DEFAULT 0,
    gesperrt_bis INTEGER,
    erstellt_am INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS geraete (
    id INTEGER PRIMARY KEY,
    inventarnummer TEXT NOT NULL UNIQUE,
    bezeichnung TEXT NOT NULL DEFAULT '',
    seriennummer TEXT NOT NULL DEFAULT '',
    standort TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'verfuegbar' CHECK (status IN ('verfuegbar', 'defekt', 'ausser_betrieb')),
    bemerkung TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS ausleihen (
    id INTEGER PRIMARY KEY,
    geraet_id INTEGER NOT NULL REFERENCES geraete(id) ON DELETE RESTRICT,
    schueler_id INTEGER NOT NULL REFERENCES konten(id) ON DELETE CASCADE,
    ausgeliehen_am INTEGER NOT NULL,
    faellig_am INTEGER NOT NULL,
    ausgegeben_von INTEGER REFERENCES konten(id) ON DELETE SET NULL,
    zurueckgegeben_am INTEGER,
    zurueckgebucht_von INTEGER REFERENCES konten(id) ON DELETE SET NULL,
    zustand TEXT NOT NULL DEFAULT '',
    bemerkung TEXT NOT NULL DEFAULT '',
    schaden_erledigt_am INTEGER
  )`,
  // Ein Gerät kann nie gleichzeitig an zwei Schüler ausgeliehen sein.
  `CREATE UNIQUE INDEX IF NOT EXISTS eine_offene_ausleihe_pro_geraet ON ausleihen(geraet_id) WHERE zurueckgegeben_am IS NULL`,
  `CREATE INDEX IF NOT EXISTS ausleihen_schueler ON ausleihen(schueler_id)`,
  `CREATE TABLE IF NOT EXISTS sitzungen (
    token_hash TEXT PRIMARY KEY,
    konto_id INTEGER NOT NULL REFERENCES konten(id) ON DELETE CASCADE,
    laeuft_ab INTEGER NOT NULL,
    neue_zugaenge TEXT
  )`,
];

let angelegt = false;

export async function schemaSicherstellen(db: D1Database) {
  if (angelegt) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  angelegt = true;
}
