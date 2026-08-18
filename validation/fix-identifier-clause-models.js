// ONE-TIME CLEANUP: re-resolve sales whose `model_key` was built from a chassis/engine/VIN
// number rather than from the model.
//
// ── WHY ────────────────────────────────────────────────────────────────────────────────
// Classic-auction houses append the identity of the individual car to the lot title:
//     "1969 Porsche 911E Coupe Chassis no. 119200650"
// Until `stripIdentifierClause` was added to resolve-car-v2.js, that number went into the
// model, and since it is unique per car EVERY LOT BECAME ITS OWN MODEL. Measured on Bonhams
// after its harvest was scaled up: 7,367 of 7,378 cars had exactly one sale and a signal of
// "insufficient" — 7,731 sales that could not contribute to any price curve.
//
// The parser fix only affects titles parsed FROM NOW ON. ingest.js has an "already ingested"
// fast path keyed on (source, source_lot_id), so a sale that already exists is never
// re-resolved and would keep its wrong car_id forever. This goes and finds them.
//
// ── HOW ────────────────────────────────────────────────────────────────────────────────
// Rather than re-implement resolution, this DELETES the affected sales and lets a normal
// `node ingest/ingest.js` re-create them through the ordinary path — same evidence gate, same
// review-queue behaviour, no second copy of the logic to drift.
//
// That is only safe if every deleted sale can actually be rebuilt, so the scraped files are
// checked FIRST: any sale whose (source, source_lot_id) is not present on disk is left
// untouched and reported. Cars left with no sales and no listings are removed with their
// valuation rows; a car still referenced by a listing is kept.
//
// Usage:
//   node validation/fix-identifier-clause-models.js --dry-run
//   node validation/fix-identifier-clause-models.js
//   node ingest/ingest.js && node jobs/nightly-compute.js      # afterwards, in that order
"use strict";

const { openDb } = require("../db/client");
const { parseTitle } = require("../resolve/resolve-car-v2");
const { loadScrapedRecords } = require("../ingest/load-scraped");

const dryRun = process.argv.includes("--dry-run");
const db = openDb();

// What the scraped corpus can rebuild.
const onDisk = new Set();
for (const r of loadScrapedRecords()) {
  if (r && r.source && r.source_lot_id != null) onDisk.add(`${r.source}|${r.source_lot_id}`);
}
console.log(`${onDisk.size} records available on disk to rebuild from\n`);

// SCOPE: titles that actually CARRY an identifier clause, not merely any title whose model_key
// no longer matches what is stored. Those are not the same set, and the difference matters — a
// first pass keyed on "model_key changed" swept up rows like "1966 Ford Country Squire Wagon"
// (no chassis number anywhere in it), whose key differs for unrelated reasons and which
// re-resolves to a WORSE answer: make Squire, model "Wagon", instead of a Ford Country Squire.
// That is separate pre-existing drift and is deliberately left alone here.
const HAS_ID_CLAUSE = /\b(?:chassis|engine|frame|body|gearbox|transmission)\s+(?:nos?|numbers?)\b|\bvin\b\.?\s*[A-Za-z0-9]{5,}/i;

const rows = db.prepare(
  `SELECT s.id, s.source, s.source_lot_id, s.title, s.car_id, c.model_key
   FROM sale s JOIN car c ON c.id = s.car_id
   WHERE s.title IS NOT NULL`
).all();

const affected = [], unrecoverable = [];
let skippedNoClause = 0;
for (const r of rows) {
  const p = parseTitle(String(r.title), {});
  if (!p.ok) continue;
  const key = p.modelKey || p.model;
  if (!key || !r.model_key || key === r.model_key) continue;
  if (!HAS_ID_CLAUSE.test(String(r.title))) { skippedNoClause++; continue; }
  if (onDisk.has(`${r.source}|${r.source_lot_id}`)) affected.push(r);
  else unrecoverable.push(r);
}
console.log(`skipped (model_key differs but no identifier clause — other drift): ${skippedNoClause}\n`);

const bySrc = {};
for (const r of affected) bySrc[r.source] = (bySrc[r.source] || 0) + 1;
console.log(`sales whose model_key was built from an identifier : ${affected.length + unrecoverable.length}`);
console.log(`  rebuildable from disk (will be re-resolved)     : ${affected.length}`);
for (const [s, n] of Object.entries(bySrc).sort((a, b) => b[1] - a[1])) console.log(`      ${String(s).padEnd(11)} ${n}`);
console.log(`  NOT on disk (left untouched)                    : ${unrecoverable.length}`);
for (const r of unrecoverable.slice(0, 5)) console.log(`      [${r.source}] ${String(r.title).slice(0, 66)}`);

if (!affected.length) { console.log("\nnothing to do"); process.exit(0); }

const carIds = [...new Set(affected.map((r) => r.car_id))];
console.log(`\ncars referenced by those sales: ${carIds.length}`);

if (dryRun) {
  console.log("\n--dry-run: no changes written");
  for (const r of affected.slice(0, 10)) {
    const p = parseTitle(String(r.title), {});
    console.log(`   "${r.model_key}"  ->  "${p.modelKey || p.model}"   | ${String(r.title).slice(0, 58)}`);
  }
  process.exit(0);
}

const delSale = db.prepare("DELETE FROM sale WHERE id = ?");
const salesLeft = db.prepare("SELECT COUNT(*) n FROM sale WHERE car_id = ?");
const listingsLeft = db.prepare("SELECT COUNT(*) n FROM listing WHERE car_id = ?");
const delVal = db.prepare("DELETE FROM car_valuation WHERE car_id = ?");
const delCar = db.prepare("DELETE FROM car WHERE id = ?");

let deletedSales = 0, deletedCars = 0, keptCars = 0;
db.exec("BEGIN");
try {
  for (const r of affected) { delSale.run(r.id); deletedSales++; }
  for (const id of carIds) {
    if (salesLeft.get(id).n > 0) { keptCars++; continue; }
    if (listingsLeft.get(id).n > 0) { keptCars++; continue; } // still backs a live listing
    delVal.run(id);
    delCar.run(id);
    deletedCars++;
  }
  db.exec("COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  console.error("\nrolled back:", e.message);
  process.exit(1);
}

console.log(`\ndeleted ${deletedSales} sales and ${deletedCars} now-empty cars (${keptCars} cars kept — still have sales or listings)`);
console.log("NOW RUN:  node ingest/ingest.js   then   node jobs/nightly-compute.js");
