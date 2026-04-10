/**
 * MOCK P1 reader – generates realistic fake DSMR telegrams every second.
 * Same EventEmitter API as the real p1reader.js.
 *
 * DELETE THIS FILE when real hardware is available.
 */

const { EventEmitter } = require("events");

class P1ReaderMock extends EventEmitter {
  constructor() {
    super();
    this._intervalId = null;
    this._latest = null;

    // Simulated cumulative counters (kWh / m³)
    this._elecImportDay = 4523.456;
    this._elecImportNight = 3871.234;
    this._elecExportDay = 1845.678;
    this._elecExportNight = 1102.345;
    this._gasTotal = 2145.678;

    // Internal clock for time-of-day simulation
    this._tick = 0;
  }

  start() {
    console.log("P1 MOCK: starting fake telegram generator (1 s interval)");

    this._intervalId = setInterval(() => {
      const telegram = this._generate();
      this._latest = telegram;
      this.emit("telegram", telegram);
    }, 1000);
  }

  stop() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  }

  get latest() {
    return this._latest;
  }

  /* ---------------------------------------------------------------- */
  /*  Fake data generator                                              */
  /* ---------------------------------------------------------------- */

  _generate() {
    this._tick++;

    // Simulate a ~24 h cycle compressed into ~240 s so you see variation quickly.
    // "hour" goes 0 → 24 over 240 ticks, then repeats.
    const hour = (this._tick % 240) / 10; // 0 … 24

    // --- Solar: bell curve peaking at noon (~3500 W) ---
    const solarBase = Math.max(0, Math.sin(((hour - 6) / 12) * Math.PI)) * 3500;
    const solarW = Math.max(0, solarBase + this._jitter(200));

    // --- House consumption: base ~400 W, peaks morning/evening ---
    const morningBump = this._bump(hour, 7, 1.5) * 1200;
    const eveningBump = this._bump(hour, 19, 2) * 1800;
    const houseW = 400 + morningBump + eveningBump + this._jitter(150);

    // --- Net import / export ---
    const net = houseW - solarW; // positive = importing, negative = exporting
    const currentImportW = Math.max(0, net);
    const currentExportW = Math.max(0, -net);

    // Slowly increment cumulative counters (kWh = W / 3600 per second)
    this._elecImportDay += currentImportW / 3_600_000;
    this._elecImportNight += currentImportW / 7_200_000; // night accumulates slower
    this._elecExportDay += currentExportW / 3_600_000;
    this._elecExportNight += currentExportW / 7_200_000;
    this._gasTotal += hour > 6 && hour < 8 ? 0.0001 : 0.00002; // heating in the morning

    return {
      timestamp: new Date().toISOString(),
      elec_import_day: round(this._elecImportDay),
      elec_import_night: round(this._elecImportNight),
      elec_export_day: round(this._elecExportDay),
      elec_export_night: round(this._elecExportNight),
      current_import_w: round(currentImportW),
      current_export_w: round(currentExportW),
      solar_production_w: round(solarW),
      gas_total: round(this._gasTotal),
    };
  }

  /** Gaussian-ish bell bump centred at `centre` with width `sigma`. */
  _bump(x, centre, sigma) {
    return Math.exp(-0.5 * Math.pow((x - centre) / sigma, 2));
  }

  /** Small random jitter ±max. */
  _jitter(max) {
    return (Math.random() - 0.5) * 2 * max;
  }
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}

module.exports = P1ReaderMock;
