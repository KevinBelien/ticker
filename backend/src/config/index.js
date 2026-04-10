require("dotenv").config();

const config = {
  port: parseInt(process.env.PORT, 10) || 8080,
  apiKey: process.env.API_KEY || "",
  dataDir: process.env.DATA_DIR || "./data",
  p1SerialPort: process.env.P1_SERIAL_PORT || "/dev/ttyUSB0",
  p1BaudRate: parseInt(process.env.P1_BAUD_RATE, 10) || 115200,
  storageIntervalMs: parseInt(process.env.STORAGE_INTERVAL_MS, 10) || 60_000,
  firebaseServiceAccount: process.env.FIREBASE_SERVICE_ACCOUNT || "",
  firebaseServiceAccountBase64: process.env.FIREBASE_SA_BASE64 || "",
};

if (!config.apiKey) {
  console.error("FATAL: API_KEY environment variable is not set.");
  process.exit(1);
}

module.exports = config;
