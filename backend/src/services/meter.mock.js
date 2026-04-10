/**
 * MOCK meter service – same Fluvius logic as meter.js but uses the mock
 * P1 reader and compresses time: quarter-hour windows are 30 seconds,
 * snapshots stored every 5 seconds.
 *
 * DELETE THIS FILE when real hardware is available.
 */

const P1ReaderMock = require("./p1reader.mock");
const { getDb } = require("./database");

const MOCK_SNAPSHOT_INTERVAL = 5_000; // store snapshot every 5 s
const MOCK_QUARTER_SECONDS = 30; // compressed 15-min window = 30 s

class MeterServiceMock {
  constructor() {
    this._reader = new P1ReaderMock();
    this._storageIntervalId = null;
    this._quarterCheckId = null;

    this.live = {
      current_import_w: 0,
      current_export_w: 0,
      solar_production_w: 0,
      gas_total: 0,
      quarter_peak_kw: 0,
      day_peak_kw: 0,
      month_peak_kw: 0,
      timestamp: null,
    };

    this._windowStartTime = null;
    this._windowStartKwh = null;
    this._lastWindowBucket = null;
  }

  start() {
    this._reader.on("telegram", (t) => this._onTelegram(t));
    this._reader.start();

    this._storageIntervalId = setInterval(
      () => this._storeSnapshot(),
      MOCK_SNAPSHOT_INTERVAL,
    );
    this._quarterCheckId = setInterval(
      () => this._checkQuarterBoundary(),
      1000,
    );

    // Init first window
    this._initWindow();

    console.log(
      `Meter MOCK: snapshots every ${MOCK_SNAPSHOT_INTERVAL / 1000}s, quarter windows every ${MOCK_QUARTER_SECONDS}s`,
    );
  }

  stop() {
    if (this._storageIntervalId) clearInterval(this._storageIntervalId);
    if (this._quarterCheckId) clearInterval(this._quarterCheckId);
    this._reader.stop();
  }

  _onTelegram(t) {
    this.live.current_import_w = t.current_import_w;
    this.live.current_export_w = t.current_export_w;
    this.live.solar_production_w = t.solar_production_w;
    this.live.gas_total = t.gas_total;
    this.live.timestamp = t.timestamp;

    // Live quarter-peak estimate
    if (this._windowStartKwh !== null && this._windowStartTime) {
      const currentKwh = t.elec_import_day + t.elec_import_night;
      const elapsedHours =
        (Date.now() - this._windowStartTime.getTime()) / 3_600_000;
      if (elapsedHours > 0) {
        this.live.quarter_peak_kw =
          (currentKwh - this._windowStartKwh) / elapsedHours;
      }
    }
  }

  _initWindow() {
    this._windowStartTime = new Date();
    this._lastWindowBucket = this._getBucket();
    const t = this._reader.latest;
    if (t) {
      this._windowStartKwh = t.elec_import_day + t.elec_import_night;
    }
  }

  /** Returns a bucket number that changes every MOCK_QUARTER_SECONDS. */
  _getBucket() {
    return Math.floor(Date.now() / (MOCK_QUARTER_SECONDS * 1000));
  }

  _checkQuarterBoundary() {
    const bucket = this._getBucket();
    if (bucket === this._lastWindowBucket) return;

    const t = this._reader.latest;
    if (!t) {
      this._lastWindowBucket = bucket;
      return;
    }

    const currentKwh = t.elec_import_day + t.elec_import_night;
    const now = new Date();

    // Close previous window
    if (this._windowStartKwh !== null && this._windowStartTime) {
      const deltaKwh = currentKwh - this._windowStartKwh;
      const elapsedHours =
        (now.getTime() - this._windowStartTime.getTime()) / 3_600_000;
      const avgPowerKw = elapsedHours > 0 ? deltaKwh / elapsedHours : 0;

      this._storeQuarterPeak(
        this._windowStartTime,
        now,
        this._windowStartKwh,
        currentKwh,
        avgPowerKw,
      );
      console.log(
        `Meter MOCK: quarter ${this._windowStartTime.toISOString()} → ${now.toISOString()} = ${avgPowerKw.toFixed(3)} kW`,
      );
    }

    // Start new window
    this._windowStartTime = now;
    this._windowStartKwh = currentKwh;
    this._lastWindowBucket = bucket;
  }

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

    this._updateMonthlyPeak(avgPowerKw, windowEnd);
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

    const dayRow = db
      .prepare(
        `
      SELECT MAX(avg_power_kw) AS peak FROM quarter_peaks WHERE window_start >= ?
    `,
      )
      .get(today);
    this.live.day_peak_kw = dayRow?.peak ?? 0;

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

module.exports = MeterServiceMock;
