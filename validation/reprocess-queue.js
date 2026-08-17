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
const { parseTitle } = require("../resolve/resolve-car-v2");
const { MAKE_ALIASES } = require("../resolve/vocab");
const { buildCorpusStats } = require("../resolve/evidence");

function run() {
  const dryRun = process.argv.includes("--dry-run");
  const db = openDb();

  const rows = db.prepare(
    `SELECT id, source, source_lot_id, raw_record_json, status FROM car_resolution_queue WHERE status IN ('pending','rejected')`
  ).all();
  console.log(`${rows.length} queue rows to replay (pending + rejected)\n`);

  const records = rows.map((r) => {
    try { return JSON.parse(r.raw_record_json); } catch { return null; }
  }).filter(Boolean);

  // Same pre-pass ingestFiles() does: parse every title once, exclude structural rejects from
  // the evidence base, so batch diversity can vouch for a real marque exactly as it would on a
  // normal ingest run.
  const parsedByTitle = new Map();
  const incoming = [];
  const { structuralVerdict } = require("../resolve/evidence");
  for (const rec of records) {
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
    console.log("--dry-run: parsed", records.length, "records, computed evidence, stopping before ingest.");
    db.close();
    return;
  }

  const stats = {
    inserted: [], queued: [], duplicatesDropped: [], skippedNoPrice: 0, attachedToExistingCar: 0,
    standingRejects: [], structuralRejects: [], corpusStats, parsedByTitle,
  };
  for (const rec of records) ingestRecord(db, rec, stats);

  const after = {
    sale: db.prepare("SELECT COUNT(*) n FROM sale").get().n,
    pending: db.prepare("SELECT COUNT(*) n FROM car_resolution_queue WHERE status = 'pending'").get().n,
    rejected: db.prepare("SELECT COUNT(*) n FROM car_resolution_queue WHERE status = 'rejected'").get().n,
    resolved: db.prepare("SELECT COUNT(*) n FROM car_resolution_queue WHERE status = 'resolved'").get().n,
  };

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
