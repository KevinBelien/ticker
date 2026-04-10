/**
 * POST   /api/devices           – register an FCM token for push notifications
 * GET    /api/devices           – list registered devices
 * PATCH  /api/devices/:id       – update device settings (e.g. threshold)
 * DELETE /api/devices/:id       – remove a device
 */
const { getDb } = require("../services/database");

function registerDevice(req, res) {
  const { device_name, fcm_token, peak_threshold_kw } = req.body;
  if (!device_name || !fcm_token) {
    return res
      .status(400)
      .json({ error: "device_name and fcm_token are required." });
  }

  const threshold =
    typeof peak_threshold_kw === "number" ? peak_threshold_kw : 2.5;

  const db = getDb();
  const info = db
    .prepare(
      `
    INSERT INTO devices (device_name, fcm_token, peak_threshold_kw)
    VALUES (?, ?, ?)
    ON CONFLICT(fcm_token) DO UPDATE
      SET device_name = excluded.device_name,
          peak_threshold_kw = excluded.peak_threshold_kw
  `,
    )
    .run(device_name, fcm_token, threshold);

  res.status(201).json({ id: info.lastInsertRowid });
}

function listDevices(req, res) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, device_name, peak_threshold_kw, created_at FROM devices`,
    )
    .all();
  res.json({ devices: rows });
}

function updateDevice(req, res) {
  const db = getDb();
  const { id } = req.params;
  const { peak_threshold_kw } = req.body;

  if (typeof peak_threshold_kw !== "number" || peak_threshold_kw < 0) {
    return res
      .status(400)
      .json({ error: "peak_threshold_kw must be a positive number." });
  }

  db.prepare(`UPDATE devices SET peak_threshold_kw = ? WHERE id = ?`).run(
    peak_threshold_kw,
    id,
  );
  res.json({ ok: true, peak_threshold_kw });
}

function removeDevice(req, res) {
  const db = getDb();
  const { id } = req.params;
  db.prepare(`DELETE FROM devices WHERE id = ?`).run(id);
  res.json({ ok: true });
}

module.exports = { registerDevice, listDevices, updateDevice, removeDevice };
