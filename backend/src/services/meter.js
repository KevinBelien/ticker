/**
 * Meter service – orchestrates the P1 reader and implements the exact
 * Fluvius capacity-tariff logic:
 *
 *  1. Snapshots (readings table) are stored every STORAGE_INTERVAL
 *     (default 1 min) for graphs / history.
 *
 *  2. Quarter-hour peaks are calculated on clock-aligned 15-min windows
 *     (:00, :15, :30, :45), using the AVERAGE power over the window:
 *         avg_kW = (kWh_end − kWh_start) / 0.25
 *     This is exactly how Fluvius determines the "kwartuurpiek".
 *
 *  3. Monthly peaks track the highest quarter-hour average per month.
 */

const P1Reader = require("./p1reader");
const { getDb } = require("./database");
const { checkAndNotify } = require("./firebase");
const config = require("../config");

class MeterService {
  constructor() {
    this._reader = new P1Reader();
    this._storageIntervalId = null;
    this._quarterCheckId = null;

    // Live snapshot updated on every telegram (~1 s)
    this.live = {
      current_import_w: 0,
      current_export_w: 0,
      solar_production_w: 0,
      gas_total: 0,
      quarter_peak_kw: 0, // avg kW of current 15-min window so far
      day_peak_kw: 0,
      month_peak_kw: 0,
      timestamp: null,
    };

    // Fluvius quarter-hour tracking
    this._windowStartTime = null; // Date of current window start
    this._windowStartKwh = null; // cumulative import kWh at window start
  }

  /* ---------------------------------------------------------------- */
  /*  Lifecycle                                                        */
  /* ---------------------------------------------------------------- */

  start() {
    this._reader.on("telegram", (t) => this._onTelegram(t));

    try {
      this._reader.start();
    } catch (err) {
      console.error(
        "Could not open P1 serial port – running in demo/headless mode.",
        err.message,
      );
    }

    // 1. Store a snapshot every STORAGE_INTERVAL (default 60 s)
    this._storageIntervalId = setInterval(() => {
      this._storeSnapshot();
    }, config.storageIntervalMs);

    // 2. Check for quarter-hour boundaries every second
    this._quarterCheckId = setInterval(() => {
      this._checkQuarterBoundary();
    }, 1000);

    // Initialise the current window
    this._initWindow();

    console.log(
      `Meter: snapshots every ${config.storageIntervalMs / 1000}s, quarter-peaks on :00/:15/:30/:45`,
    );
  }

  stop() {
    if (this._storageIntervalId) clearInterval(this._storageIntervalId);
    if (this._quarterCheckId) clearInterval(this._quarterCheckId);
    this._reader.stop();
  }

  /* ---------------------------------------------------------------- */
  /*  Internal: telegram handler (fires every ~1 s)                    */
  /* ---------------------------------------------------------------- */

  _onTelegram(t) {
    this.live.current_import_w = t.current_import_w;
    this.live.current_export_w = t.current_export_w;
    this.live.solar_production_w = t.solar_production_w;
    this.live.gas_total = t.gas_total;
    this.live.timestamp = t.timestamp;

    // Live quarter-peak estimate: average kW so far in this window
    if (this._windowStartKwh !== null && this._windowStartTime) {
      const currentKwh = t.elec_import_day + t.elec_import_night;
      const elapsedMs = Date.now() - this._windowStartTime.getTime();
      const elapsedHours = elapsedMs / 3_600_000;

      if (elapsedHours > 0) {
        this.live.quarter_peak_kw =
          (currentKwh - this._windowStartKwh) / elapsedHours;

        // After 2 minutes into the window, we have enough data to predict.
        // The predicted final peak ≈ current average (consumption trend).
        if (elapsedMs > 120_000) {
          checkAndNotify(this.live.quarter_peak_kw);
        }
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Quarter-hour boundary detection (Fluvius logic)                  */
  /* ---------------------------------------------------------------- */

  /** Set the window start to the current (or most recent) :00/:15/:30/:45. */
  _initWindow() {
    const now = new Date();
    const mins = now.getMinutes();
    const windowMin = mins - (mins % 15);
    this._windowStartTime = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      now.getHours(),
      windowMin,
      0,
      0,
    );

    const t = this._reader.latest;
    if (t) {
      this._windowStartKwh = t.elec_import_day + t.elec_import_night;
    }
  }

  /** Called every second – detects clock-aligned 15-min boundaries. */
  _checkQuarterBoundary() {
    const now = new Date();
    const mins = now.getMinutes();
    const secs = now.getSeconds();

    // Are we at a :00/:15/:30/:45 boundary (within the first second)?
    if (mins % 15 !== 0 || secs > 1) return;

    const t = this._reader.latest;
    if (!t) return;

    const currentKwh = t.elec_import_day + t.elec_import_night;

    // Close the previous window (if we have a start)
    if (this._windowStartKwh !== null && this._windowStartTime) {
      const deltaKwh = currentKwh - this._windowStartKwh;
      const avgPowerKw = deltaKwh / 0.25; // kWh / 0.25h = kW

      const windowEnd = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        now.getHours(),
        mins,
        0,
        0,
      );

      this._storeQuarterPeak(
        this._windowStartTime,
        windowEnd,
        this._windowStartKwh,
        currentKwh,
        avgPowerKw,
      );

      console.log(
        `Meter: quarter ${this._windowStartTime.toISOString()} → ${windowEnd.toISOString()} = ${avgPowerKw.toFixed(3)} kW`,
      );
    }

    // Start new window
    this._windowStartTime = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      now.getHours(),
      mins,
      0,
      0,
    );
    this._windowStartKwh = currentKwh;
  }

  /* ---------------------------------------------------------------- */
  /*  Storage: snapshots (every minute, for graphs)                    */
  /* ---------------------------------------------------------------- */

  _storeSnapshot() {
    const t = this._reader.latest;
    if (!t) return;

    const db = getDb();
    db.prepare(
      `
      INSERT INTO readings
        (timestamp, elec_import_day, elec_import_night,
         elec_export_day, elec_export_night, gas_total)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    ).run(
      new Date().toISOString(),
      t.elec_import_day,
      t.elec_import_night,
      t.elec_export_day,
      t.elec_export_night,
      t.gas_total,
    );
  }

  /* ---------------------------------------------------------------- */
  /*  Storage: quarter-hour peaks (Fluvius capacity tariff)            */
  /* ---------------------------------------------------------------- */

  _storeQuarterPeak(windowStart, windowEnd, kwhStart, kwhEnd, avgPowerKw) {
    const db = getDb();

    db.prepare(
      `
      INSERT OR IGNORE INTO quarter_peaks
        (window_start, window_end, kwh_start, kwh_end, avg_power_kw)
      VALUES (?, ?, ?, ?, ?)
    `,
    ).run(
      windowStart.toISOString(),
      windowEnd.toISOString(),
      kwhStart,
      kwhEnd,
      avgPowerKw,
    );

    // Update monthly peak
    this._updateMonthlyPeak(avgPowerKw, windowEnd);

    // Refresh live peaks
    this._refreshPeaks();
  }

  _updateMonthlyPeak(avgPowerKw, timestamp) {
    const db = getDb();
    const year = timestamp.getFullYear();
    const month = timestamp.getMonth() + 1;

    db.prepare(
      `
      INSERT INTO monthly_peaks (year, month, peak_kw, peak_timestamp)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(year, month) DO UPDATE
        SET peak_kw = MAX(peak_kw, excluded.peak_kw),
            peak_timestamp = CASE WHEN excluded.peak_kw > peak_kw THEN excluded.peak_timestamp ELSE peak_timestamp END
    `,
    ).run(year, month, avgPowerKw, timestamp.toISOString());
  }

  _refreshPeaks() {
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);
    const now = new Date();

    // Day peak (from quarter_peaks, not readings)
    const dayRow = db
      .prepare(
        `
      SELECT MAX(avg_power_kw) AS peak FROM quarter_peaks
      WHERE window_start >= ?
    `,
      )
      .get(today);
    this.live.day_peak_kw = dayRow?.peak ?? 0;

    // Month peak
    const monthRow = db
      .prepare(
        `
      SELECT peak_kw FROM monthly_peaks WHERE year = ? AND month = ?
    `,
      )
      .get(now.getFullYear(), now.getMonth() + 1);
    this.live.month_peak_kw = monthRow?.peak_kw ?? 0;
  }
}

module.exports = MeterService;
