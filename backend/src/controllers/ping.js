/**
 * GET /api/ping – lightweight health check (the Flutter app uses this as
 * connection indicator: green dot = reachable, red = not).
 */
function pingController(req, res) {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
}

module.exports = { pingController };
