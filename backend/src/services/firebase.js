/**
 * Firebase Cloud Messaging – sends push notifications per device
 * based on predicted quarter-hour peak vs each device's threshold.
 */

const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");
const config = require("../config");
const { getDb } = require("./database");

let firebaseReady = false;

// Track which devices already received an alert this quarter window
// so we don't spam. Reset when a new window starts.
let _alertedTokens = new Set();
let _lastWindowBucket = null;

function initFirebase() {
  let credential;

  // Option 1: base64-encoded JSON via env var (ideal for Docker)
  if (config.firebaseServiceAccountBase64) {
    try {
      const json = Buffer.from(
        config.firebaseServiceAccountBase64,
        "base64",
      ).toString("utf-8");
      credential = admin.credential.cert(JSON.parse(json));
    } catch (err) {
      console.error(
        "Firebase: failed to parse FIREBASE_SA_BASE64:",
        err.message,
      );
      return;
    }
    // Option 2: path to JSON file (volume mount)
  } else if (
    config.firebaseServiceAccount &&
    fs.existsSync(path.resolve(config.firebaseServiceAccount))
  ) {
    const absPath = path.resolve(config.firebaseServiceAccount);
    const serviceAccount = JSON.parse(fs.readFileSync(absPath, "utf-8"));
    credential = admin.credential.cert(serviceAccount);
  } else {
    console.warn(
      "Firebase: no credentials found – push notifications disabled.",
    );
    console.warn(
      "  Set FIREBASE_SA_BASE64 (base64 of JSON) or FIREBASE_SERVICE_ACCOUNT (file path).",
    );
    return;
  }

  admin.initializeApp({ credential });
  firebaseReady = true;
  console.log("Firebase: initialised.");
}

/**
 * Check the predicted quarter-hour peak against each device's effective
 * threshold = MAX(device_threshold, current_month_peak).
 *
 * Logic: if the month peak is already 3.0 kW and the user threshold is 2.5,
 * there's no point alerting at 2.6 kW — we only alert above 3.0 kW.
 * Conversely, if the month peak is 1.5 kW and the user wants max 2.5 kW,
 * we alert at 2.5 kW.
 *
 * This fires ~2 min into a quarter window (prediction based on current
 * consumption trend), so there's still time to react.
 *
 * @param {number} predictedKw – estimated avg kW for the full 15-min window
 */
async function checkAndNotify(predictedKw) {
  if (!firebaseReady) return;

  // Reset alerted set when a new quarter window starts
  const bucket = _getWindowBucket();
  if (bucket !== _lastWindowBucket) {
    _alertedTokens = new Set();
    _lastWindowBucket = bucket;
  }

  const db = getDb();

  // Current monthly peak
  const now = new Date();
  const monthRow = db
    .prepare("SELECT peak_kw FROM monthly_peaks WHERE year = ? AND month = ?")
    .get(now.getFullYear(), now.getMonth() + 1);
  const currentMonthPeak = monthRow?.peak_kw ?? 0;

  const devices = db
    .prepare("SELECT fcm_token, peak_threshold_kw, device_name FROM devices")
    .all();

  for (const device of devices) {
    // Effective threshold = the highest of user setting and current month peak
    const effectiveThreshold = Math.max(device.peak_threshold_kw, currentMonthPeak);

    if (predictedKw <= effectiveThreshold) continue;
    if (_alertedTokens.has(device.fcm_token)) continue;

    _alertedTokens.add(device.fcm_token);

    try {
      await admin.messaging().send({
        token: device.fcm_token,
        notification: {
          title: "⚡ Hoog verbruik — piek verwacht!",
          body: `Geschat ${predictedKw.toFixed(2)} kW als dit aanhoudt. Huidige maandpiek: ${currentMonthPeak.toFixed(2)} kW. Verminder verbruik!`,
        },
        data: {
          predicted_kw: String(predictedKw),
          effective_threshold_kw: String(effectiveThreshold),
          device_threshold_kw: String(device.peak_threshold_kw),
          month_peak_kw: String(currentMonthPeak),
        },
      });
      console.log(`Firebase: alert to ${device.device_name} (predicted ${predictedKw.toFixed(2)} kW > effective ${effectiveThreshold.toFixed(2)} kW)`);
    } catch (err) {
      console.error(`Firebase: failed to notify ${device.device_name}:`, err.message);
    }
  }
}

function _getWindowBucket() {
  const now = new Date();
  const mins = now.getMinutes();
  return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${mins - (mins % 15)}`;
}

module.exports = { initFirebase, checkAndNotify };
