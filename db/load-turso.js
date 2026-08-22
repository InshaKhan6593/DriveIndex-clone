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
const { createClient } = require("@libsql/client");

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
// Only immutable market tables are synchronized from the local pipeline snapshot. The
// user-owned app_user / garage_vehicle / garage_valuation_snapshot tables are created by the
// shared schema but intentionally never diffed, inserted, or deleted here.
const TABLES = ["car", "car_valuation", "sale", "listing", "car_resolution_queue"];

const src = new DatabaseSync(NEW, { readOnly: true });
const hasPrev = PREV && fs.existsSync(PREV);
if (hasPrev) {
  src.exec(`ATTACH DATABASE '${PREV.replace(/'/g, "''")}' AS prev`);
  console.log(`diffing against previous snapshot: ${PREV}`);
} else {
  console.log("no previous snapshot — pushing everything (first load)");
}

// The remote database may be empty on a first run. schema.sql is the one definition of the shape,
// so it is replayed rather than duplicated here — CREATE TABLE IF NOT EXISTS makes it a no-op
// afterwards. Statements are split on semicolons at line ends to keep CHECK constraints intact.
const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
const schemaStatements = schema.split(/;\s*\n/).map((stmt) => {
  // The first schema statement is preceded by documentation comments. Strip full-line SQL
  // comments before checking whether the chunk is empty, otherwise CREATE TABLE car is skipped.
  return stmt.split(/\r?\n/).filter((line) => !line.trim().startsWith("--")).join("\n").trim();
}).filter(Boolean);

// CREATE TABLE IF NOT EXISTS only creates a missing table; it does not retrofit columns onto an
// existing Turso table. Keep the hosted schema additive, just like db/client.js does for the local
// working database. This matters especially for the listing lifecycle fields: the local snapshot
// can contain them while an older remote listing table cannot accept the diff rows yet.
const REMOTE_ADDITIVE_MIGRATIONS = [
  ["listing", "source_lot_id", "TEXT"],
  ["listing", "listing_type", "TEXT"],
  ["listing", "listing_status", "TEXT"],
  ["listing", "price_type", "TEXT"],
  ["listing", "current_bid", "INTEGER"],
  ["listing", "estimate_low", "INTEGER"],
  ["listing", "estimate_high", "INTEGER"],
  ["listing", "ends_at", "TEXT"],
  ["listing", "closed_at", "TEXT"],
  ["listing", "status_reason", "TEXT"],
  ["car_valuation", "trend_se", "REAL"],
  ["car_valuation", "trend_lcb", "REAL"],
  ["car_valuation", "trend_score", "REAL"],
  ["car_valuation", "signal_scope", "TEXT"],
  ["car_valuation", "scope_from", "INTEGER"],
  ["car_valuation", "scope_to", "INTEGER"],
  ["car_valuation", "scope_n", "INTEGER"],
  ["car_resolution_queue", "kind", "TEXT NOT NULL DEFAULT 'sale'"],
];

async function migrateRemote(remote) {
  for (const [table, column, definition] of REMOTE_ADDITIVE_MIGRATIONS) {
    try {
      await remote.execute(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`);
      console.log(`remote schema: added ${table}.${column}`);
    } catch (err) {
      if (!/already exists|duplicate column|duplicate/i.test(String(err.message))) throw err;
    }
  }

  // Existing queue rows predate the kind column. Listings can be identified safely from their
  // normalized JSON because they do not carry sold_at; preserve the local migration's backfill.
  try {
    await remote.execute(`UPDATE "car_resolution_queue" SET "kind" = 'listing'
      WHERE json_extract("raw_record_json", '$.sold_at') IS NULL`);
  } catch (err) {
    if (!/no such column|no such table/i.test(String(err.message))) throw err;
  }
}

async function applySchemaStatements(remote, statements) {
  for (const s of statements) {
    try {
      await remote.execute(s + ";");
    } catch (err) {
      // A generated column, table, or index that already exists is expected on every run after
      // the first. Additive migrations above handle columns that CREATE TABLE cannot retrofit.
      if (!/already exists|duplicate/i.test(String(err.message))) {
        console.error(`schema statement failed: ${s.slice(0, 80)}...`);
        throw err;
      }
    }
  }
}

// A full market reset must leave user-owned Garage rows intact. garage_vehicle.car_id points at
// car, so deleting every car first violates the foreign key and would make a recoverable market
// snapshot failure look like a Garage-data failure. Keep any car referenced by Garage; it can be
// refreshed by the snapshot when it is still present in the market catalogue.
async function resetMarketTables(remote) {
  const protectedRows = await remote.execute(
    `SELECT DISTINCT car_id FROM garage_vehicle WHERE car_id IS NOT NULL`
  );
  const protectedCarIds = new Set(protectedRows.rows.map((row) => String(row.car_id)));
  await remote.batch([
    { sql: `DELETE FROM "car_resolution_queue"`, args: [] },
    { sql: `DELETE FROM "listing"`, args: [] },
    { sql: `DELETE FROM "sale"`, args: [] },
    { sql: `DELETE FROM "car_valuation"`, args: [] },
    {
      sql: `DELETE FROM "car"
            WHERE NOT EXISTS (
              SELECT 1 FROM "garage_vehicle" g WHERE g.car_id = car.id
            )`,
      args: [],
    },
  ], "write");
  if (protectedCarIds.size) {
    console.log(`preserved ${protectedCarIds.size} Garage-linked car rows during market reset`);
  }
  return protectedCarIds;
}

async function loadRemote() {
const remote = createClient({ url: URL, authToken: TOKEN });

// Tables first: an older remote listing table must exist before its additive columns can be
// migrated, and indexes must wait until those columns exist.
await applySchemaStatements(remote, schemaStatements.filter((s) => /^CREATE TABLE IF NOT EXISTS\b/i.test(s)));
await migrateRemote(remote);
await applySchemaStatements(remote, schemaStatements.filter((s) => !/^CREATE TABLE IF NOT EXISTS\b/i.test(s)));

// A previous local snapshot is only a valid diff base when the remote already contains that
// snapshot. A newly-created or partially initialized Turso database must receive the full
// serving snapshot, even though data-latest exists from before Turso was configured.
let usePreviousSnapshot = Boolean(hasPrev);
let preservedGarageCarIds = new Set();
if (usePreviousSnapshot) {
  const remoteCounts = await Promise.all(TABLES.map(async (table) => {
    const result = await remote.execute(`SELECT COUNT(*) n FROM "${table}"`);
    return Number(result.rows[0].n);
  }));
  const previousCounts = TABLES.map((table) => src.prepare(`SELECT COUNT(*) n FROM prev."${table}"`).get().n);
  const currentCounts = TABLES.map((table) => src.prepare(`SELECT COUNT(*) n FROM main."${table}"`).get().n);
  const matchesCurrent = remoteCounts.every((count, i) => count === currentCounts[i]);
  if (matchesCurrent) {
    console.log(`remote counts already match the new snapshot ${currentCounts.join(",")}; applying the diff without resetting`);
  } else if (remoteCounts.some((count, i) => count !== previousCounts[i])) {
    console.log(`remote counts ${remoteCounts.join(",")} do not match previous snapshot ${previousCounts.join(",")} - resetting remote tables and pushing a full snapshot`);
    preservedGarageCarIds = await resetMarketTables(remote);
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

// computed_at is bookkeeping, not valuation data. The compute job may refresh it for every
// row even when none of the values the API serves changed. Compare the business columns first,
// then fetch the complete current rows for the changed keys so new valuation fields are still
// written without causing timestamp-only Turso writes.
function rowsChangedIgnoring(table, cols, ignored) {
  const compareCols = cols.filter((column) => !ignored.includes(column));
  if (compareCols.length === cols.length) return null;

  const key = primaryKeyOf(table);
  if (!key || !compareCols.includes(key)) return null;

  const compareList = compareCols.map((column) => `"${column}"`).join(", ");
  const changedKeys = src.prepare(
    `SELECT "${key}" FROM (
       SELECT ${compareList} FROM main."${table}"
       EXCEPT
       SELECT ${compareList} FROM prev."${table}"
     )`
  ).all().map((row) => row[key]);

  if (!changedKeys.length) return [];

  const rows = [];
  const fullList = cols.map((column) => `"${column}"`).join(", ");
  for (let i = 0; i < changedKeys.length; i += 500) {
    const batch = changedKeys.slice(i, i + 500);
    rows.push(...src.prepare(
      `SELECT ${fullList}
       FROM main."${table}"
       WHERE "${key}" IN (${batch.map(() => "?").join(", ")})`
    ).all(...batch));
  }
  return rows;
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

  let changed;
  try {
    // Whole-row EXCEPT catches inserts AND in-place edits. Valuations get a business-field diff
    // so refreshing computed_at alone does not consume a Turso write; changed rows are still
    // loaded with every writable column below.
    changed = usePreviousSnapshot && table === "car_valuation"
      ? rowsChangedIgnoring(table, cols, ["computed_at"])
      : null;
    if (changed === null) {
      const changedSql = usePreviousSnapshot
        ? `SELECT ${colList} FROM main."${table}" EXCEPT SELECT ${colList} FROM prev."${table}"`
        : `SELECT ${colList} FROM main."${table}"`;
      changed = src.prepare(changedSql).all();
    }
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

  // Deletions are NOT applied here. They are queued and run after every table's inserts, in
  // reverse dependency order — deleting a car while its sales still reference it fails on the
  // foreign key. (Found the hard way: the obvious per-table loop deletes parents before children.)
  if (deletedIds.length) pendingDeletes.push({ table, pk, ids: deletedIds });

  // Turso's supported client batch API executes these statements in one implicit write
  // transaction, so a failed batch is rolled back without manual transaction control.
  const BATCH = 250;
  for (let i = 0; i < changed.length; i += BATCH) {
    const slice = changed.slice(i, i + BATCH);
    const insertSql = table === "car"
      ? `INSERT INTO "${table}" (${colList}) VALUES (${cols.map(() => "?").join(", ")})
         ON CONFLICT("id") DO UPDATE SET ${cols.filter((c) => c !== "id").map((c) => `"${c}" = excluded."${c}"`).join(", ")}`
      : `INSERT OR REPLACE INTO "${table}" (${colList}) VALUES (${cols.map(() => "?").join(", ")})`;
    const statements = slice.map((row) => ({
      sql: insertSql,
      args: cols.map((c) => row[c] ?? null),
    }));
    try {
      await remote.batch(statements, "write");
    } catch (err) {
      throw new Error(`${table} rows ${i}-${i + slice.length - 1} failed: ${err.message || err}`, { cause: err });
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
  for (let i = 0; i < job.ids.length; i += 250) {
    const statements = job.ids.slice(i, i + 250).map((id) => ({
      sql: `DELETE FROM "${job.table}" WHERE "${job.pk}" = ?`,
      args: [id],
    }));
    try {
      await remote.batch(statements, "write");
    } catch (err) {
      throw new Error(`${job.table} deletions ${i}-${Math.min(i + 249, job.ids.length - 1)} failed: ${err.message || err}`, { cause: err });
    }
  }
  console.log(`deleted ${String(job.ids.length).padStart(7)} from ${job.table}`);
}

const remoteResult = await remote.execute("SELECT COUNT(*) n FROM car");
const remoteCars = Number(remoteResult.rows[0].n);
const localCars = src.prepare("SELECT COUNT(*) n FROM main.car").get().n;
let expectedCars = localCars;
if (preservedGarageCarIds.size) {
  const localCarIds = new Set(src.prepare("SELECT id FROM main.car").all().map((row) => String(row.id)));
  const preservedExtras = [...preservedGarageCarIds].filter((id) => !localCarIds.has(id)).length;
  expectedCars += preservedExtras;
  if (preservedExtras) console.log(`expected remote car count includes ${preservedExtras} preserved Garage-only car rows`);
}

console.log(`\ntotal: ${totalWrites} rows written, ${totalDeletes} deleted`);
console.log(`monthly pace if repeated daily: ${((totalWrites + totalDeletes) * 30 / 1e6).toFixed(1)}M writes (free cap: 10M)`);
console.log(`cars — local ${localCars}, remote ${remoteCars}`);

// The whole point of the exercise is that the remote copy equals the local one. Saying so out
// loud turns a silent partial load into a failed step.
if (remoteCars !== expectedCars) {
  console.error(`\nMISMATCH: remote has ${remoteCars} cars, expected ${expectedCars} (${localCars} in snapshot plus preserved Garage rows).`);
  console.error("The load did not fully apply. Re-run; the upsert is idempotent so this is safe.");
  process.exit(1);
}
console.log("remote matches the snapshot");
}

loadRemote().catch((err) => {
  console.error(err);
  process.exit(1);
});
