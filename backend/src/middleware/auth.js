/**
 * API-key auth middleware – checks the x-api-key header (or ?api_key query param).
 */
const config = require("../config");
const crypto = require("crypto");

function authMiddleware(req, res, next) {
  const key = req.headers["x-api-key"] || req.query.api_key;

  if (
    !key ||
    key.length !== config.apiKey.length ||
    !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(config.apiKey))
  ) {
    return res
      .status(401)
      .json({ error: "Unauthorized – invalid or missing API key." });
  }

  next();
}

module.exports = authMiddleware;
