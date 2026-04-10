/**
 * GET /api/history   – query historical 15-min readings
 *
 * Query params:
 *   from   – ISO-8601 start (default: today 00:00)
 *   to     – ISO-8601 end   (default: now)
 *   limit  – max rows       (default: 1000, max: 10000)
 */
const { getDb } = require("../services/database");

function historyController(req, res) {
  const db = getDb();
  const now = new Date();
  const todayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).toISOString();

  const from = req.query.from || todayStart;
  const to = req.query.to || now.toISOString();
  let limit = parseInt(req.query.limit, 10) || 1000;
  if (limit > 10000) limit = 10000;

  const rows = db
    .prepare(
      `
    SELECT * FROM readings
    WHERE timestamp BETWEEN ? AND ?
    ORDER BY timestamp ASC
    LIMIT ?
  `,
    )
    .all(from, to, limit);

  res.json({ count: rows.length, readings: rows });
}

module.exports = { historyController };
