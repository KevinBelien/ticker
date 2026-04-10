/**
 * Standalone script – run once to (re)create the database and seed tariffs.
 *
 *   node src/scripts/create-db.js
 *
 * Safe to run multiple times: uses CREATE TABLE IF NOT EXISTS and INSERT OR IGNORE.
 */
const { getDb, closeDb } = require("../services/database");

console.log("Initialising database …");
getDb(); // triggers table creation + seed
closeDb();
console.log("Done.");
