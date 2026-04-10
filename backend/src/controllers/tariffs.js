/**
 * GET /api/tariffs – list all capacity tariffs
 */
const { getDb } = require("../services/database");

function tariffsController(req, res) {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM tariffs ORDER BY region, valid_from DESC`)
    .all();
  res.json({ tariffs: rows });
}

module.exports = { tariffsController };
