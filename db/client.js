// Real persistent storage via Node's built-in node:sqlite (experimental in Node 22, but
// zero native-module install risk — no node-gyp/build-tools dependency, which matters on
// a fresh machine that may not have a C++ toolchain configured).

const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DB_PATH = path.join(__dirname, "..", "data", "driveindex.sqlite");

// One-off, additive migrations for databases created before a schema change. CREATE TABLE IF
// NOT EXISTS never retrofits a column onto a table that already exists, so a genuinely new
// column needs its own ALTER TABLE here, run before schema.sql — which then either creates the
// table fresh with the column already in it (first run ever) or finds it already exists with
// the column now present (every run after this one). Each entry must be safe to run every time.
function migrate(db) {
  try { db.exec("ALTER TABLE listing ADD COLUMN source_lot_id TEXT"); } catch { /* table doesn't exist yet, or column already added */ }
}

function openDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  db.exec(schema);
  return db;
}

function newId() {
  return crypto.randomUUID();
}

module.exports = { openDb, newId, DB_PATH };
