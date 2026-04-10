/**
 * P1 Telegram parser + serial reader.
 *
 * Connects to the Belgian/Dutch digital meter via the P1 port, parses
 * DSMR 5.x telegrams, and exposes the latest snapshot via an EventEmitter.
 *
 * Emits:
 *   'telegram' – a parsed object with the current meter values
 */

const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");
const { EventEmitter } = require("events");
const config = require("../config");

class P1Reader extends EventEmitter {
  constructor() {
    super();
    this._buffer = [];
    this._latest = null;
    this._port = null;
  }

  /* ---------------------------------------------------------------- */
  /*  Public API                                                       */
  /* ---------------------------------------------------------------- */

  /** Start reading from the serial port. */
  start() {
    console.log(
      `P1: opening ${config.p1SerialPort} @ ${config.p1BaudRate} baud`,
    );

    this._port = new SerialPort({
      path: config.p1SerialPort,
      baudRate: config.p1BaudRate,
      dataBits: 8,
      parity: "none",
      stopBits: 1,
    });

    const parser = this._port.pipe(new ReadlineParser({ delimiter: "\r\n" }));

    parser.on("data", (line) => this._onLine(line));

    this._port.on("error", (err) => {
      console.error("P1 serial error:", err.message);
    });

    this._port.on("open", () => {
      console.log("P1: serial port open");
    });
  }

  /** Stop reading and close the port. */
  stop() {
    if (this._port && this._port.isOpen) {
      this._port.close();
    }
  }

  /** Return the last fully-parsed telegram (or null). */
  get latest() {
    return this._latest;
  }

  /* ---------------------------------------------------------------- */
  /*  Internal: line-by-line state machine                             */
  /* ---------------------------------------------------------------- */

  _onLine(line) {
    // Telegrams start with '/' and end with '!' followed by a CRC
    if (line.startsWith("/")) {
      this._buffer = [line];
      return;
    }

    this._buffer.push(line);

    if (line.startsWith("!")) {
      // End of telegram – parse it
      const telegram = this._parse(this._buffer);
      if (telegram) {
        this._latest = telegram;
        this.emit("telegram", telegram);
      }
      this._buffer = [];
    }
  }

  /* ---------------------------------------------------------------- */
  /*  DSMR 5.x parser                                                  */
  /*  Reference OBIS codes: https://www.netbeheernederland.nl          */
  /* ---------------------------------------------------------------- */

  _parse(lines) {
    const data = {
      timestamp: new Date().toISOString(),

      // Cumulative electricity import (kWh)
      elec_import_day: 0, // 1-0:1.8.1 (tarief 1 / dag)
      elec_import_night: 0, // 1-0:1.8.2 (tarief 2 / nacht)

      // Cumulative electricity export (kWh)
      elec_export_day: 0, // 1-0:2.8.1
      elec_export_night: 0, // 1-0:2.8.2

      // Instantaneous power (kW → converted to W)
      current_import_w: 0, // 1-0:1.7.0
      current_export_w: 0, // 1-0:2.7.0

      // Gas (m³)
      gas_total: 0, // 0-1:24.2.1 or 0-1:24.2.3
    };

    for (const line of lines) {
      this._extractObis(line, data);
    }

    // Solar production estimate: if we export AND import, solar ≈ export + house consumption
    // A better value comes from a separate solar inverter meter, but this is a decent fallback.
    // When exporting: solar = export + own consumption  →  but we only know net import/export.
    // Simple heuristic: solar_production ≈ current_export + (current_import if current_import > 0 ? 0)
    // In practice current_import and current_export are mutually exclusive on P1.
    data.solar_production_w = data.current_export_w; // conservative: what we see going back

    return data;
  }

  _extractObis(line, data) {
    // Generic OBIS pattern:  X-X:X.X.X(VALUE*UNIT)
    const match = line.match(/^(\d+-\d+:\d+\.\d+\.\d+)\((.+)\)$/);
    if (!match) return;

    const obis = match[1];
    const rawValue = match[2];

    switch (obis) {
      case "1-0:1.8.1":
        data.elec_import_day = this._kwh(rawValue);
        break;
      case "1-0:1.8.2":
        data.elec_import_night = this._kwh(rawValue);
        break;
      case "1-0:2.8.1":
        data.elec_export_day = this._kwh(rawValue);
        break;
      case "1-0:2.8.2":
        data.elec_export_night = this._kwh(rawValue);
        break;
      case "1-0:1.7.0":
        data.current_import_w = this._kwToW(rawValue);
        break;
      case "1-0:2.7.0":
        data.current_export_w = this._kwToW(rawValue);
        break;
      default:
        // Gas has two common OBIS codes
        if (obis === "0-1:24.2.1" || obis === "0-1:24.2.3") {
          // Gas value is in a second set of brackets: (timestamp)(value*m3)
          const gasMatch = rawValue.match(/\)\((\d+\.\d+)/);
          if (gasMatch) {
            data.gas_total = parseFloat(gasMatch[1]);
          } else {
            data.gas_total = this._m3(rawValue);
          }
        }
        break;
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Value helpers                                                    */
  /* ---------------------------------------------------------------- */

  /** Parse "001234.567*kWh" → 1234.567 */
  _kwh(raw) {
    const m = raw.match(/([\d.]+)\*kWh/);
    return m ? parseFloat(m[1]) : 0;
  }

  /** Parse "01.234*kW" → 1234  (Watt) */
  _kwToW(raw) {
    const m = raw.match(/([\d.]+)\*kW/);
    return m ? parseFloat(m[1]) * 1000 : 0;
  }

  /** Parse "01234.567*m3" → 1234.567 */
  _m3(raw) {
    const m = raw.match(/([\d.]+)\*m3/);
    return m ? parseFloat(m[1]) : 0;
  }
}

module.exports = P1Reader;
