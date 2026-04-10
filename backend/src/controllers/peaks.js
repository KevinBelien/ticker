/**
 * GET  /api/peaks              – day & month peak
 * GET  /api/peaks/monthly      – all monthly peaks
 * GET  /api/peaks/quarters     – quarter-hour peaks for a date range
 */
const { getDb } = require("../services/database");

function peaksController(req, res) {
  const db = getDb();
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  const dayRow = db
    .prepare(
      `
    SELECT MAX(avg_power_kw) AS peak FROM quarter_peaks WHERE window_start >= ?
  `,
    )
    .get(today);

  const monthRow = db
    .prepare(
      `
    SELECT peak_kw, peak_timestamp FROM monthly_peaks WHERE year = ? AND month = ?
  `,
    )
    .get(now.getFullYear(), now.getMonth() + 1);

  res.json({
    day_peak_kw: dayRow?.peak ?? 0,
    month_peak_kw: monthRow?.peak_kw ?? 0,
    month_peak_timestamp: monthRow?.peak_timestamp ?? null,
  });
}

function monthlyPeaksController(req, res) {
  const db = getDb();
  const rows = db
    .prepare(
      `
    SELECT year, month, peak_kw, peak_timestamp FROM monthly_peaks
    ORDER BY year DESC, month DESC
  `,
    )
    .all();

  res.json({ peaks: rows });
}

function quarterPeaksController(req, res) {
  const db = getDb();
  const now = new Date();
  const todayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).toISOString();

  const from = req.query.from || todayStart;
  const to = req.query.to || now.toISOString();

  const rows = db
    .prepare(
      `
    SELECT window_start, window_end, kwh_start, kwh_end, avg_power_kw
    FROM quarter_peaks
    WHERE window_start BETWEEN ? AND ?
    ORDER BY window_start ASC
  `,
    )
    .all(from, to);

  res.json({ count: rows.length, quarter_peaks: rows });
}

module.exports = {
  peaksController,
  monthlyPeaksController,
  quarterPeaksController,
};
