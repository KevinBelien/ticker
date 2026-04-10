/**
 * MOCK server entry point – runs the backend with fake P1 data.
 *
 *   node src/server.mock.js
 *
 * DELETE THIS FILE when real hardware is available.
 */

const http = require("http");
const express = require("express");
const cors = require("cors");
const { Server: SocketIO } = require("socket.io");

const config = require("./config");
const { getDb, closeDb } = require("./services/database");
const MeterServiceMock = require("./services/meter.mock");
const { setupWebSocket } = require("./websockets/live");
const { initFirebase } = require("./services/firebase");
const apiRoutes = require("./routes/api");

/* ------------------------------------------------------------------ */
/*  Express + HTTP server                                              */
/* ------------------------------------------------------------------ */

const app = express();
app.use(cors());
app.use(express.json());
app.use("/api", apiRoutes);

const server = http.createServer(app);

/* ------------------------------------------------------------------ */
/*  Socket.IO                                                          */
/* ------------------------------------------------------------------ */

const io = new SocketIO(server, {
  cors: { origin: "*" },
});

/* ------------------------------------------------------------------ */
/*  Bootstrap (mock)                                                   */
/* ------------------------------------------------------------------ */

getDb();
initFirebase();

const meterService = new MeterServiceMock();
meterService.start();

setupWebSocket(io, meterService);

server.listen(config.port, () => {
  console.log(`[MOCK] Ticker backend listening on port ${config.port}`);
});

/* ------------------------------------------------------------------ */
/*  Graceful shutdown                                                  */
/* ------------------------------------------------------------------ */

function shutdown() {
  console.log("Shutting down …");
  meterService.stop();
  closeDb();
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
