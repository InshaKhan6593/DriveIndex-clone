// REPROCESS THE REVIEW QUEUE against the CURRENT resolution code.
//
// The queue is not static: every row's `raw_record_json` is the full original sale record
// (see db/schema.sql), kept specifically so a lot can be re-decided once either (a) the code
// gets smarter (a bug fix, a new curated marque) or (b) the corpus grows enough to vouch for a
// make it couldn't before. Nothing else re-runs this automatically — an ordinary ingest only
// ever processes NEW files, so a code fix does nothing for lots already sitting in the queue
// until something replays them through it.
//
// Replays BOTH 'pending' and 'rejected' rows (not just pending) — a fixed false-positive reject
// rule can only recover a real car by re-trying rows that were already marked rejected, not just
// ones still waiting.
//
// Usage: node validation/reprocess-queue.js [--dry-run]

"use strict";

const { openDb } = require("../db/client");
const { ingestRecord } = require("../ingest/ingest");
const { ingestListingRecord } = require("../ingest/ingest-listings");
const { parseTitle } = require("../resolve/resolve-car-v2");
const { MAKE_ALIASES } = require("../resolve/vocab");
const { buildCorpusStats } = require("../resolve/evidence");

function run() {
  const dryRun = process.argv.includes("--dry-run");
  const db = openDb();

  const rows = db.prepare(
    `SELECT id, source, source_lot_id, raw_record_json, status, kind FROM car_resolution_queue WHERE status IN ('pending','rejected')`
  ).all();
  console.log(`${rows.length} queue rows to replay (pending + rejected)\n`);

  // Carry `kind` alongside the record. The queue holds BOTH sales and listings, and their
  // shapes are not interchangeable — a listing has no sold_at/price_usd/outlier_note, so feeding
  // one to the sale path throws "cannot be bound to SQLite parameter 20" and, before this was
  // routed, killed an entire 47k-row replay on the first listing it reached.
  const records = rows.map((r) => {
    try {
      const rec = JSON.parse(r.raw_record_json);
      if (!rec) return null;
      // Fall back to shape detection for rows written before the column existed.
      return { rec, kind: r.kind || (rec.sold_at === undefined ? "listing" : "sale") };
    } catch { return null; }
  }).filter(Boolean);

  // Same pre-pass ingestFiles() does: parse every title once, exclude structural rejects from
  // the evidence base, so batch diversity can vouch for a real marque exactly as it would on a
  // normal ingest run.
  const parsedByTitle = new Map();
  const incoming = [];
  const { structuralVerdict } = require("../resolve/evidence");
  for (const { rec } of records) {
    if (!rec || !rec.title || parsedByTitle.has(rec.title)) continue;
    const p = parseTitle(rec.title, { url: rec.url });
    parsedByTitle.set(rec.title, p);
    if (!p.ok) continue;
    if (structuralVerdict(rec.title, { hasYear: Boolean(p.year) })?.verdict === "reject") continue;
    incoming.push({ make: p.make, modelKey: p.modelKey, year: p.year ?? null, source: rec.source });
  }
  const corpusStats = buildCorpusStats(db, incoming);

  const before = {
    sale: db.prepare("SELECT COUNT(*) n FROM sale").get().n,
    pending: db.prepare("SELECT COUNT(*) n FROM car_resolution_queue WHERE status = 'pending'").get().n,
    rejected: db.prepare("SELECT COUNT(*) n FROM car_resolution_queue WHERE status = 'rejected'").get().n,
  };

  if (dryRun) {
    const nSale = records.filter((r) => r.kind === "sale").length;
    console.log(`--dry-run: parsed ${records.length} records (${nSale} sale, ${records.length - nSale} listing), computed evidence, stopping before ingest.`);
    db.close();
    return;
  }

  const stats = {
    inserted: [], queued: [], duplicatesDropped: [], skippedNoPrice: 0, attachedToExistingCar: 0,
    standingRejects: [], structuralRejects: [], corpusStats, parsedByTitle,
  };
  const listingStats = {
    inserted: [], queued: [], structuralRejects: [], skippedNoPrice: 0,
    attachedToExistingCar: 0, corpusStats, parsedByTitle,
  };
  // Each row is isolated: a single malformed record must not abort the replay of the other
  // 47,000. Failures are counted and reported rather than thrown.
  const failures = [];
  for (const { rec, kind } of records) {
    try {
      if (kind === "listing") ingestListingRecord(db, rec, listingStats);
      else ingestRecord(db, rec, stats);
    } catch (err) {
      failures.push({ source: rec.source, lot: rec.source_lot_id, kind, msg: String(err.message).slice(0, 90) });
    }
  }

  const after = {
    sale: db.prepare("SELECT COUNT(*) n FROM sale").get().n,
    pending: db.prepare("SELECT COUNT(*) n FROM car_resolution_queue WHERE status = 'pending'").get().n,
    rejected: db.prepare("SELECT COUNT(*) n FROM car_resolution_queue WHERE status = 'rejected'").get().n,
    resolved: db.prepare("SELECT COUNT(*) n FROM car_resolution_queue WHERE status = 'resolved'").get().n,
  };

  if (failures.length) {
    console.log(`
!! ${failures.length} rows failed to replay (isolated, run continued):`);
    for (const f of failures.slice(0, 5)) console.log(`   [${f.kind}] ${f.source}|${f.lot}: ${f.msg}`);
  }
  console.log(`listings replayed            : ${listingStats.inserted.length} inserted, ${listingStats.queued.length} still queued`);
  console.log(`newly inserted as real sales : ${stats.inserted.length}  (${stats.inserted.filter(i=>i.created).length} new cars, ${stats.inserted.filter(i=>!i.created).length} attached)`);
  console.log(`still queued for review       : ${stats.queued.length}`);
  console.log(`newly/still rejected          : ${stats.structuralRejects.length + stats.standingRejects.length}`);
  console.log(`\nsale   ${before.sale} -> ${after.sale}  (+${after.sale - before.sale})`);
  console.log(`pending  ${before.pending} -> ${after.pending}  (${after.pending - before.pending >= 0 ? "+" : ""}${after.pending - before.pending})`);
  console.log(`rejected ${before.rejected} -> ${after.rejected}  (${after.rejected - before.rejected >= 0 ? "+" : ""}${after.rejected - before.rejected})`);
  console.log(`resolved (now includes auto-cleared stale rows) -> ${after.resolved}`);

  db.close();
}

run();
