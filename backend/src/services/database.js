const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const config = require("../config");

let db;

/**
 * Returns the singleton database connection, creating (and seeding) the
 * database file + tables on first call if they don't exist yet.
 */
function getDb() {
  if (db) return db;

  // Ensure data directory exists
  fs.mkdirSync(config.dataDir, { recursive: true });

  const dbPath = path.join(config.dataDir, "ticker.db");
  const isNew = !fs.existsSync(dbPath);

  db = new Database(dbPath);

  // Performance settings for Raspberry Pi
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  if (isNew) {
    console.log("Database not found – creating tables and seeding data …");
    createTables(db);
    seedTariffs(db);
    console.log("Database initialised.");
  } else {
    // Ensure tables exist even on an existing file (idempotent)
    createTables(db);
  }

  return db;
}

/* ------------------------------------------------------------------ */
/*  Schema                                                             */
/* ------------------------------------------------------------------ */

function createTables(database) {
  database.exec(`
    ---------------------------------------------------------------
    -- Meter snapshots (stored every ~1 minute for graphs)
    -- Only cumulative counters. Live instantaneous W values go
    -- via WebSocket, not stored.
    ---------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS readings (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp       TEXT    NOT NULL,                     -- ISO-8601

      -- Electricity consumed from the grid (kWh cumulative)
      elec_import_day     REAL NOT NULL DEFAULT 0,         -- tariff 1 / day
      elec_import_night   REAL NOT NULL DEFAULT 0,         -- tariff 2 / night

      -- Electricity injected into the grid (kWh cumulative)
      elec_export_day     REAL NOT NULL DEFAULT 0,
      elec_export_night   REAL NOT NULL DEFAULT 0,

      -- Gas (m³ cumulative)
      gas_total           REAL NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings(timestamp);

    ---------------------------------------------------------------
    -- Quarter-hour peaks – Fluvius capacity tariff logic
    --
    -- Clock-aligned windows: :00, :15, :30, :45
    -- avg_power_kw = (kWh_end − kWh_start) / 0.25
    -- This is exactly how Fluvius calculates the "kwartuurpiek".
    ---------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS quarter_peaks (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      window_start    TEXT    NOT NULL,                     -- e.g. 2026-04-10T12:00:00
      window_end      TEXT    NOT NULL,                     -- e.g. 2026-04-10T12:15:00
      kwh_start       REAL   NOT NULL,                     -- cumulative import at window start
      kwh_end         REAL   NOT NULL,                     -- cumulative import at window end
      avg_power_kw    REAL   NOT NULL,                     -- (kwh_end - kwh_start) / 0.25
      UNIQUE(window_start)
    );

    CREATE INDEX IF NOT EXISTS idx_qp_start ON quarter_peaks(window_start);

    ---------------------------------------------------------------
    -- Monthly peak demand (capacity tariff tracking)
    ---------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS monthly_peaks (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      year            INTEGER NOT NULL,
      month           INTEGER NOT NULL,
      peak_kw         REAL    NOT NULL DEFAULT 0,
      peak_timestamp  TEXT,
      UNIQUE(year, month)
    );

    ---------------------------------------------------------------
    -- Capacity tariffs per region (seeded on first run)
    ---------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS tariffs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      region          TEXT    NOT NULL,
      netbeheerder    TEXT    NOT NULL,
      tariff_per_kw   REAL   NOT NULL,          -- EUR / kW / month
      valid_from      TEXT   NOT NULL,           -- ISO-8601 date
      valid_until     TEXT,                      -- NULL = still active
      UNIQUE(region, netbeheerder, valid_from)
    );

    ---------------------------------------------------------------
    -- Registered devices for push notifications (FCM)
    ---------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS devices (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      device_name         TEXT    NOT NULL,
      fcm_token           TEXT    NOT NULL UNIQUE,
      peak_threshold_kw   REAL    NOT NULL DEFAULT 2.5,    -- per-device, set from Flutter app
      created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    ---------------------------------------------------------------
    -- App settings (key/value for things like peak threshold)
    ---------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS settings (
      key             TEXT PRIMARY KEY,
      value           TEXT NOT NULL
    );
  `);

  // Default settings
  const upsertSetting = database.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO NOTHING
  `);
  upsertSetting.run("peak_threshold_kw", "2.5");
}

/* ------------------------------------------------------------------ */
/*  Seed: Belgian capacity tariffs per Fluvius region                  */
/*  Source: VREG – Distributienettarieven elektriciteit 2026           */
/*  Values: capaciteitstarief gemiddelde maandpiek (EUR/kW/jaar)       */
/*          excl. BTW – digitale meter                                 */
/* ------------------------------------------------------------------ */

function seedTariffs(database) {
  const insert = database.prepare(`
    INSERT OR IGNORE INTO tariffs (region, netbeheerder, tariff_per_kw, valid_from, valid_until)
    VALUES (?, ?, ?, ?, ?)
  `);

  // EUR/kW/jaar → EUR/kW/maand = divide by 12
  const tariffs = [
    // Flanders – Fluvius regions (capaciteitstarief 2026, excl. BTW)
    ["Fluvius Antwerpen", "Fluvius", 49.4036563 / 12, "2026-01-01", null],
    ["Fluvius Halle-Vilvoorde", "Fluvius", 56.0428955 / 12, "2026-01-01", null],
    ["Fluvius Imewo", "Fluvius", 54.2009816 / 12, "2026-01-01", null],
    ["Fluvius Kempen", "Fluvius", 56.2069857 / 12, "2026-01-01", null],
    ["Fluvius Limburg", "Fluvius", 49.0469384 / 12, "2026-01-01", null],
    [
      "Fluvius Midden-Vlaanderen",
      "Fluvius",
      50.1239818 / 12,
      "2026-01-01",
      null,
    ],
    ["Fluvius West", "Fluvius", 57.0995726 / 12, "2026-01-01", null],
    ["Fluvius Zenne-Dijle", "Fluvius", 56.1228635 / 12, "2026-01-01", null],
  ];

  const insertMany = database.transaction((rows) => {
    for (const row of rows) {
      insert.run(row[0], row[1], row[2], row[3], row[4]);
    }
  });

  insertMany(tariffs);
}

/* ------------------------------------------------------------------ */

function closeDb() {
  if (db) {
    db.close();
    db = undefined;
  }
}

module.exports = { getDb, closeDb };
