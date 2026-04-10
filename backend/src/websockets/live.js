/**
 * WebSocket handler – pushes live meter data to connected Flutter clients.
 *
 * Events emitted to authenticated clients:
 *   'live'        – every 1s with current meter values
 *   'peak_alert'  – when predicted quarter-hour peak exceeds device threshold
 *
 * Auth message from client:
 *   { api_key: '...', fcm_token: '...' }      (fcm_token optional)
 *
 * The fcm_token is used to look up the per-device peak_threshold_kw.
 * If no fcm_token is sent, the default threshold (2.5 kW) is used.
 */
const crypto = require("crypto");
const config = require("../config");
const { getDb } = require("../services/database");

function setupWebSocket(io, meterService) {
  io.on("connection", (socket) => {
    let authenticated = false;

    // Give the client 5 seconds to authenticate
    const authTimeout = setTimeout(() => {
      if (!authenticated) {
        socket.emit("error_msg", { error: "Authentication timeout" });
        socket.disconnect(true);
      }
    }, 5000);

    socket.on("auth", (data) => {
      const key = data?.api_key || "";

      if (
        key.length === config.apiKey.length &&
        crypto.timingSafeEqual(Buffer.from(key), Buffer.from(config.apiKey))
      ) {
        authenticated = true;
        clearTimeout(authTimeout);

        // Look up per-device threshold via fcm_token
        let thresholdKw = 2.5;
        const fcmToken = data?.fcm_token;
        if (fcmToken) {
          try {
            const row = getDb()
              .prepare("SELECT peak_threshold_kw FROM devices WHERE fcm_token = ?")
              .get(fcmToken);
            if (row) thresholdKw = row.peak_threshold_kw;
          } catch (_) {}
        }

        socket.emit("auth_ok", { status: "authenticated", peak_threshold_kw: thresholdKw });

        let alertSent = false;
        let lastWindowBucket = _getWindowBucket();

        const liveInterval = setInterval(() => {
          const live = meterService.live;
          socket.emit("live", live);

          // Reset alert when a new quarter window starts
          const bucket = _getWindowBucket();
          if (bucket !== lastWindowBucket) {
            alertSent = false;
            lastWindowBucket = bucket;
          }

          // In-app peak alert: fires when the predicted quarter peak
          // exceeds MAX(user_threshold, current_month_peak).
          // This way we only warn when it actually matters (= new costly peak).
          const effectiveThreshold = Math.max(thresholdKw, live.month_peak_kw);
          if (live.quarter_peak_kw > effectiveThreshold && !alertSent) {
            socket.emit("peak_alert", {
              message: `Hoog verbruik! Geschat ${live.quarter_peak_kw.toFixed(2)} kW als dit aanhoudt. Huidige maandpiek: ${live.month_peak_kw.toFixed(2)} kW`,
              current_kw: live.quarter_peak_kw,
              effective_threshold_kw: effectiveThreshold,
              threshold_kw: thresholdKw,
              month_peak_kw: live.month_peak_kw,
            });
            alertSent = true;
          }
        }, 1000);

        // Allow client to update threshold live
        socket.on("set_threshold", (payload) => {
          const newThreshold = parseFloat(payload?.peak_threshold_kw);
          if (!isNaN(newThreshold) && newThreshold > 0) {
            thresholdKw = newThreshold;
            alertSent = false;
            socket.emit("threshold_updated", { peak_threshold_kw: thresholdKw });
          }
        });

        socket.on("disconnect", () => {
          clearInterval(liveInterval);
        });
      } else {
        socket.emit("error_msg", { error: "Invalid API key" });
        socket.disconnect(true);
      }
    });
  });
}

function _getWindowBucket() {
  const now = new Date();
  const mins = now.getMinutes();
  return `${now.getHours()}-${mins - (mins % 15)}`;
}

module.exports = { setupWebSocket };
