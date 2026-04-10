const express = require("express");
const auth = require("../middleware/auth");

const { pingController } = require("../controllers/ping");
const { historyController } = require("../controllers/history");
const {
  peaksController,
  monthlyPeaksController,
  quarterPeaksController,
} = require("../controllers/peaks");
const { tariffsController } = require("../controllers/tariffs");
const {
  registerDevice,
  listDevices,
  updateDevice,
  removeDevice,
} = require("../controllers/devices");

const router = express.Router();

// Public (no auth) – just for connectivity check
router.get("/ping", pingController);

// Protected routes
router.get("/history", auth, historyController);
router.get("/peaks", auth, peaksController);
router.get("/peaks/monthly", auth, monthlyPeaksController);
router.get("/peaks/quarters", auth, quarterPeaksController);
router.get("/tariffs", auth, tariffsController);

router.post("/devices", auth, registerDevice);
router.get("/devices", auth, listDevices);
router.patch("/devices/:id", auth, updateDevice);
router.delete("/devices/:id", auth, removeDevice);

module.exports = router;
