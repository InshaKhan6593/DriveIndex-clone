// Push the serving snapshot into a hosted libSQL (Turso) database.
//
// WHY THIS EXISTS. The API needs its data reachable over the network from a serverless function,
// which cannot carry a 178MB file. Turso's free tier holds it (5GB) and needs no payment method,
// and db/client.js already speaks libSQL, so api/server.js runs against it unchanged.
//
// ── THE CONSTRAINT THAT SHAPES THIS WHOLE FILE ────────────────────────────────────────────
// Turso's free tier allows 10 MILLION ROW WRITES PER MONTH. The snapshot holds 361,234 rows.
// Reloading all of it daily is 10.8M writes/month — over the cap on day one, and the corpus
// grows every day. So a full reload is not an option, and this pushes only what CHANGED.
//
// Measured shape of a day's change: nightly-compute rewrites every car_valuation row by design
// (one new sale moves avg_mileage, hence every normalised price), while sales are append-mostly.
// So a daily diff is roughly 64k valuations + a few thousand sales ~= 70k writes, about 2.1M a
// month — inside the cap with 4x headroom rather than 8% over it.
//
// ── HOW THE DIFF IS COMPUTED ──────────────────────────────────────────────────────────────
// Not by asking Turso what it has (that would be hundreds of thousands of reads and slow), and
// not by tracking a watermark (which silently misses in-place updates). Instead the PREVIOUS
// snapshot is kept alongside the new one and SQLite computes the difference itself:
//
//     ATTACH 'serving-prev.sqlite' AS prev;
//     SELECT * FROM main.car EXCEPT SELECT * FROM prev.car;   -- inserted or changed
//     SELECT id FROM prev.car EXCEPT SELECT id FROM main.car;  -- deleted
//
// EXCEPT compares whole rows, so it catches an edit to any column without needing to know which.
// This is exact, needs no bookkeeping that can drift, and runs locally at file speed.
//
// With no previous snapshot (first run) everything is pushed — 361k writes, a one-off 3.6% of
// the monthly budget.
//
//   node db/load-turso.js <new-snapshot> [previous-snapshot]
//
// Requires TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.
"use strict";

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const NEW = process.argv[2] || path.join(__dirname, "..", "data", "serving.sqlite");
const PREV = process.argv[3] || null;

const URL = process.env.TURSO_DATABASE_URL;
const TOKEN = process.env.TURSO_AUTH_TOKEN;

if (!URL) {
  console.error("TURSO_DATABASE_URL is not set.");
  console.error("This step is what makes the published data reachable by the API — without it the");
  console.error("snapshot is built and stored but nothing serves it. See DEPLOY.md.");
  process.exit(1);
}
if (!fs.existsSync(NEW)) {
  console.error(`no snapshot at ${NEW} — run db/export-serving.js first`);
  process.exit(1);
}

// Tables in dependency order: car before the rows that reference it, so a fresh remote database
// never holds a row pointing at a car that has not arrived yet.
const TABLES = ["car", "car_valuation", "sale", "listing", "car_resolution_queue"];

const src = new DatabaseSync(NEW, { readOnly: true });
const hasPrev = PREV && fs.existsSync(PREV);
if (hasPrev) {
  src.exec(`ATTACH DATABASE '${PREV.replace(/'/g, "''")}' AS prev`);
  console.log(`diffing against previous snapshot: ${PREV}`);
} else {
  console.log("no previous snapshot — pushing everything (first load)");
}

const Database = require("libsql");
const remote = new Database(URL, { authToken: TOKEN });

// The remote database may be empty on a first run. schema.sql is the one definition of the shape,
// so it is replayed rather than duplicated here — CREATE TABLE IF NOT EXISTS makes it a no-op
// afterwards. Statements are split on semicolons at line ends to keep CHECK constraints intact.
const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
for (const stmt of schema.split(/;\s*\n/)) {
  // The first schema statement is preceded by documentation comments. Strip full-line SQL
  // comments before checking whether the chunk is empty, otherwise CREATE TABLE car is skipped
  // and the following index fails with "no such table: main.car" on a fresh Turso database.
  const s = stmt.split(/\r?\n/).filter((line) => !line.trim().startsWith("--")).join("\n").trim();
  if (!s) continue;
  try {
    remote.exec(s + ";");
  } catch (err) {
    // A generated column or an index that already exists is expected on every run after the first.
    if (!/already exists|duplicate/i.test(String(err.message))) {
      console.error(`schema statement failed: ${s.slice(0, 80)}...`);
      throw err;
    }
  }
}

// A previous local snapshot is only a valid diff base when the remote already contains that
// snapshot. A newly-created or partially initialized Turso database must receive the full
// serving snapshot, even though data-latest exists from before Turso was configured.
let usePreviousSnapshot = Boolean(hasPrev);
if (usePreviousSnapshot) {
  const remoteCounts = TABLES.map((table) => remote.prepare(`SELECT COUNT(*) n FROM "${table}"`).get().n);
  const previousCounts = TABLES.map((table) => src.prepare(`SELECT COUNT(*) n FROM prev."${table}"`).get().n);
  if (remoteCounts.some((count, i) => count !== previousCounts[i])) {
    console.log(`remote counts ${remoteCounts.join(",")} do not match previous snapshot ${previousCounts.join(",")} - resetting remote tables and pushing a full snapshot`);
    for (const table of [...TABLES].reverse()) remote.exec(`DELETE FROM "${table}"`);
    usePreviousSnapshot = false;
  }
}

function columnsOf(table) {
  return src.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((r) => r.name);
}

// A generated column cannot be written to — sale.reserve_not_met is derived from status — so it
// must be excluded from the INSERT or every statement errors.
function writableColumns(table) {
  const info = src.prepare(`SELECT name, hidden FROM pragma_table_xinfo('${table}')`).all();
  return info.filter((c) => c.hidden !== 2 && c.hidden !== 3).map((c) => c.name);
}

// NOT every table is keyed on "id": car_valuation is keyed on car_id. Assuming "id" made the
// deletion query throw, and because that query sat inside a try/catch the failure was invisible —
// retired rows would have accumulated in the served copy forever. Read the real key instead, and
// refuse to guess when a table has none.
function primaryKeyOf(table) {
  const pk = src.prepare(`SELECT name FROM pragma_table_info('${table}') WHERE pk > 0 ORDER BY pk`).all();
  if (pk.length === 1) return pk[0].name;
  return null; // composite or absent — deletion reconciliation is skipped, and says so
}

let totalWrites = 0;
let totalDeletes = 0;
// Deletions are collected here and applied after every insert, in reverse table order.
const pendingDeletes = [];

for (const table of TABLES) {
  const exists = src.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name=?").get(table).n;
  if (!exists) {
    console.log(`${table.padEnd(22)} not in snapshot — skipped`);
    continue;
  }

  const cols = writableColumns(table);
  const colList = cols.map((c) => `"${c}"`).join(", ");
  const placeholders = cols.map(() => "?").join(", ");

  // Whole-row EXCEPT: catches inserts AND in-place edits to any column, without having to know
  // which columns a given release happens to change.
  const changedSql = usePreviousSnapshot
    ? `SELECT ${colList} FROM main."${table}" EXCEPT SELECT ${colList} FROM prev."${table}"`
    : `SELECT ${colList} FROM main."${table}"`;

  let changed;
  try {
    changed = src.prepare(changedSql).all();
  } catch (err) {
    // A table absent from the PREVIOUS snapshot (schema added since) cannot be diffed — push all.
    console.log(`${table.padEnd(22)} diff failed (${err.message.slice(0, 40)}) — pushing all rows`);
    changed = src.prepare(`SELECT ${colList} FROM main."${table}"`).all();
  }

  // Deletions matter: a car removed from the catalogue must not linger in the served copy, or the
  // API answers with rows the pipeline has already retired.
  const pk = primaryKeyOf(table);
  let deletedIds = [];
  if (usePreviousSnapshot && pk) {
    deletedIds = src
      .prepare(`SELECT "${pk}" AS k FROM prev."${table}" EXCEPT SELECT "${pk}" AS k FROM main."${table}"`)
      .all()
      .map((r) => r.k);
  } else if (usePreviousSnapshot && !pk) {
    // Loud rather than silent: a table whose retired rows are never removed would drift further
    // from the snapshot every single day, and nothing downstream would report it.
    console.log(`${table.padEnd(22)} no single-column primary key — deletions NOT reconciled`);
  }

  if (!changed.length && !deletedIds.length) {
    console.log(`${table.padEnd(22)} unchanged`);
    continue;
  }

  const insert = remote.prepare(
    `INSERT OR REPLACE INTO "${table}" (${colList}) VALUES (${placeholders})`
  );
  // Deletions are NOT applied here. They are queued and run after every table's inserts, in
  // reverse dependency order — deleting a car while its sales still reference it fails on the
  // foreign key. (Found the hard way: the obvious per-table loop deletes parents before children.)
  if (deletedIds.length) pendingDeletes.push({ table, pk, ids: deletedIds });

  // Batched transactions rather than one giant one: a single transaction over 300k rows on a
  // first load is a very long-held remote write lock and a single point of failure. 1,000 rows
  // per commit keeps each round trip small and makes a mid-run failure resumable by re-running.
  const BATCH = 1000;
  for (let i = 0; i < changed.length; i += BATCH) {
    const slice = changed.slice(i, i + BATCH);
    remote.exec("BEGIN");
    try {
      for (const row of slice) insert.run(...cols.map((c) => row[c]));
      remote.exec("COMMIT");
    } catch (err) {
      remote.exec("ROLLBACK");
      throw err;
    }
    process.stdout.write(`\r${table.padEnd(22)} ${Math.min(i + BATCH, changed.length)}/${changed.length}   `);
  }

  totalWrites += changed.length;
  totalDeletes += deletedIds.length;
  console.log(`\r${table.padEnd(22)} ${String(changed.length).padStart(7)} written  ${String(deletedIds.length).padStart(5)} to delete`);
}

// ── DELETIONS, child tables first ─────────────────────────────────────────────────────────
// TABLES is in dependency order for INSERTS (a car before the sales that reference it), so
// deletions must walk it backwards. Deleting a car while its sales still point at it fails on
// the foreign key — confirmed against the real snapshot, where removing one car row threw
// FOREIGN KEY constraint failed. Doing this per-table inside the loop above would have hit that
// on the first day a car was ever retired, and aborted the whole load.
for (const job of pendingDeletes.reverse()) {
  const del = remote.prepare(`DELETE FROM "${job.table}" WHERE "${job.pk}" = ?`);
  remote.exec("BEGIN");
  try {
    for (const id of job.ids) del.run(id);
    remote.exec("COMMIT");
  } catch (err) {
    remote.exec("ROLLBACK");
    throw err;
  }
  console.log(`deleted ${String(job.ids.length).padStart(7)} from ${job.table}`);
}

const remoteCars = remote.prepare("SELECT COUNT(*) n FROM car").get().n;
const localCars = src.prepare("SELECT COUNT(*) n FROM main.car").get().n;

console.log(`\ntotal: ${totalWrites} rows written, ${totalDeletes} deleted`);
console.log(`monthly pace if repeated daily: ${((totalWrites + totalDeletes) * 30 / 1e6).toFixed(1)}M writes (free cap: 10M)`);
console.log(`cars — local ${localCars}, remote ${remoteCars}`);

// The whole point of the exercise is that the remote copy equals the local one. Saying so out
// loud turns a silent partial load into a failed step.
if (remoteCars !== localCars) {
  console.error(`\nMISMATCH: remote has ${remoteCars} cars, snapshot has ${localCars}.`);
  console.error("The load did not fully apply. Re-run; the upsert is idempotent so this is safe.");
  process.exit(1);
}
console.log("remote matches the snapshot");
