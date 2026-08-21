// Real persistent storage via Node's built-in node:sqlite (experimental in Node 22, but
// zero native-module install risk — no node-gyp/build-tools dependency, which matters on
// a fresh machine that may not have a C++ toolchain configured).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// DB_PATH is overridable so a deployed API can point at a snapshot fetched at build time
// (see render.yaml) without the 249MB working database ever being in the repo.
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, "..", "data", "driveindex.sqlite");

// ── LOCAL FILE BY DEFAULT, HOSTED WHEN DEPLOYED ────────────────────────────────────────
// Everything that WRITES (crawlers, ingest, compute, validation) runs on a machine with the
// file and needs nothing here. Only the read-only API is deployed, and it cannot ship a
// 249MB file, so it points at a hosted libSQL database instead.
//
// `libsql` is used rather than `@libsql/client` on purpose: it exposes the SAME synchronous
// prepare/get/all/run/exec surface as node:sqlite, so not one of the 116 call sites in this
// codebase has to become async. Set TURSO_DATABASE_URL (and TURSO_AUTH_TOKEN for a remote
// database) to switch; unset, nothing changes.
const TURSO_URL = process.env.TURSO_DATABASE_URL;

function openConnection() {
  if (!TURSO_URL) {
    const { DatabaseSync } = require("node:sqlite");
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    // A deployed API serves a snapshot it must never write to. Opening read-only makes that a
    // guarantee rather than a convention, and surfaces a truncated download as an error here
    // instead of as mysterious empty results later.
    if (process.env.DB_READONLY === "1") return new DatabaseSync(DB_PATH, { readOnly: true });
    return new DatabaseSync(DB_PATH);
  }
  // Deliberately required lazily — a local run must not need the dependency installed at all.
  const Database = require("libsql");
  return new Database(TURSO_URL, { authToken: process.env.TURSO_AUTH_TOKEN });
}

// One-off, additive migrations for databases created before a schema change. CREATE TABLE IF
// NOT EXISTS never retrofits a column onto a table that already exists, so a genuinely new
// column needs its own ALTER TABLE here, run before schema.sql — which then either creates the
// table fresh with the column already in it (first run ever) or finds it already exists with
// the column now present (every run after this one). Each entry must be safe to run every time.
function migrate(db) {
  try { db.exec("ALTER TABLE listing ADD COLUMN source_lot_id TEXT"); } catch { /* table doesn't exist yet, or column already added */ }
  for (const col of [
    "listing_type", "listing_status", "price_type", "current_bid", "estimate_low", "estimate_high",
    "ends_at", "closed_at", "status_reason",
  ]) {
    // SQLite's ALTER TABLE path is intentionally plain/additive. Fresh databases get the
    // documentation comments and shape from schema.sql; old state releases are upgraded here.
    try { db.exec(`ALTER TABLE listing ADD COLUMN ${col} ${/bid|estimate/.test(col) ? "INTEGER" : "TEXT"}`); } catch { /* already present */ }
  }
  for (const col of ["trend_se", "trend_lcb", "trend_score"]) {
    try { db.exec(`ALTER TABLE car_valuation ADD COLUMN ${col} REAL`); } catch { /* already present */ }
  }
  // Scope of a valuation — see the comment on these columns in schema.sql.
  try { db.exec("ALTER TABLE car_valuation ADD COLUMN signal_scope TEXT"); } catch { /* already present */ }
  for (const col of ["scope_from", "scope_to", "scope_n"]) {
    try { db.exec(`ALTER TABLE car_valuation ADD COLUMN ${col} INTEGER`); } catch { /* already present */ }
  }
  // ALTER TABLE cannot add a CHECK constraint, so the added column is plain TEXT; the constraint
  // still applies to databases created fresh from schema.sql.
  try {
    db.exec("ALTER TABLE car_resolution_queue ADD COLUMN kind TEXT NOT NULL DEFAULT 'sale'");
    // Backfill: a listing record has no sold_at. Existing rows were all written before the
    // column existed, so classify them from the record itself rather than guessing.
    db.exec(`UPDATE car_resolution_queue SET kind = 'listing'
             WHERE json_extract(raw_record_json, '$.sold_at') IS NULL`);
  } catch { /* already present */ }
}

function openDb() {
  const db = openConnection();
  db.exec("PRAGMA foreign_keys = ON;");
  // A hosted database is served READ-ONLY: the schema and every migration were already applied
  // on the machine that built the snapshot. Running them again from a serverless handler would
  // mean concurrent DDL on every cold start, for no benefit.
  if (!TURSO_URL && process.env.DB_READONLY !== "1") {
    migrate(db);
    db.exec(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
  }
  return db;
}

function newId() {
  return crypto.randomUUID();
}

module.exports = { openDb, newId, DB_PATH, isHosted: Boolean(TURSO_URL) };
