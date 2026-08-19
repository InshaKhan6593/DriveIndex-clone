// ONE-TIME CLEANUP: merge cars split purely by MAKE CASING (Mga vs MGA, Mgb vs MGB, ...).
//
// ── WHY ────────────────────────────────────────────────────────────────────────────────
// Positional make-inference title-cases its candidate, alias lookup returns the alias table's
// casing, and findOrCreateCar matches `make` exactly — so when both paths see the same marque
// the catalogue grows two parallel families and real price histories split in two. The REO/Reo
// fix normalised one direction (all-caps -> title case); this regression came from the other
// direction: an alias-resolved "MGA" row beside inference-created "Mga" rows. Measured
// (2026-08-19, split-audit FAIL with 8 true splits): 25 Mga/Mgb cars beside canonical MGA/MGB.
//
// resolveCarV2 now canonicalises an inferred make's casing against the catalogue before lookup,
// so this class cannot regrow. This script repairs what is already stored.
//
// ── HOW ────────────────────────────────────────────────────────────────────────────────
// Same approach as fix-identifier-clause-models.js: do NOT hand-merge rows. Delete the
// minority-casing sales (verified rebuildable from the scraped corpus on disk) and their
// now-empty cars, then re-run ingest — which now canonicalises casing and ATTACHES those sales
// to the dominant-casing car through the ordinary, tested path.
//
// Usage:
//   node validation/fix-make-casing-splits.js --dry-run
//   node validation/fix-make-casing-splits.js
//   node ingest/ingest.js && node jobs/nightly-compute.js      # afterwards, in that order
"use strict";

const { openDb } = require("../db/client");
const { loadScrapedRecords } = require("../ingest/load-scraped");

const dryRun = process.argv.includes("--dry-run");
const db = openDb();

// What the scraped corpus can rebuild.
const onDisk = new Set();
for (const r of loadScrapedRecords()) {
  if (r && r.source && r.source_lot_id != null) onDisk.add(`${r.source}|${r.source_lot_id}`);
}
console.log(`${onDisk.size} records available on disk to rebuild from\n`);

// Families of cars whose make differs only by casing.
const families = db.prepare(
  `SELECT lower(make) lm, COUNT(DISTINCT make) variants
   FROM car GROUP BY lower(make) HAVING variants > 1 ORDER BY lm`
).all();

if (!families.length) { console.log("no casing families found — nothing to do"); process.exit(0); }

const salesOf = db.prepare("SELECT COUNT(*) n FROM sale WHERE car_id = ?");
const listingsOf = db.prepare("SELECT COUNT(*) n FROM listing WHERE car_id = ?");

const toDelete = []; // { carId, make, model, sales: [ids] }
let unrecoverable = 0;

for (const f of families) {
  // Canonical casing = the variant carrying the most sales (tie -> most cars). The dominant
  // spelling is the one alias resolution and volume have already agreed on.
  const variants = db.prepare("SELECT id, make FROM car WHERE lower(make) = ?").all(f.lm);
  const byCasing = new Map();
  for (const v of variants) {
    const e = byCasing.get(v.make) || { make: v.make, cars: 0, sales: 0, ids: [] };
    e.cars++; e.sales += salesOf.get(v.id).n; e.ids.push(v.id);
    byCasing.set(v.make, e);
  }
  const ranked = [...byCasing.values()].sort((a, b) => b.sales - a.sales || b.cars - a.cars);
  const canonical = ranked[0];

  console.log(`${canonical.make}  (canonical: ${canonical.sales} sales / ${canonical.cars} cars)`);
  for (const minority of ranked.slice(1)) {
    console.log(`  vs ${minority.make}  (${minority.sales} sales / ${minority.cars} cars)`);
    for (const id of minority.ids) {
      const car = db.prepare("SELECT year, model FROM car WHERE id = ?").get(id);
      const sales = db.prepare("SELECT id, source, source_lot_id FROM sale WHERE car_id = ?").all(id);
      const missing = sales.filter((s) => !onDisk.has(`${s.source}|${s.source_lot_id}`));
      if (missing.length) {
        unrecoverable += missing.length;
        console.log(`    KEPT ${car.year} ${minority.make} "${car.model}" — ${missing.length} sale(s) not on disk, cannot rebuild`);
        continue;
      }
      const listings = listingsOf.get(id).n;
      if (listings) {
        console.log(`    KEPT ${car.year} ${minority.make} "${car.model}" — still backs ${listings} listing(s)`);
        continue;
      }
      toDelete.push({ carId: id, make: minority.make, year: car.year, model: car.model, saleIds: sales.map((s) => s.id) });
      console.log(`    will re-home ${car.year} ${minority.make} "${car.model}" — ${sales.length} sale(s)`);
    }
  }
}

console.log(`\nsales to delete and re-ingest: ${toDelete.reduce((a, b) => a + b.saleIds.length, 0)}`);
console.log(`cars to remove once empty     : ${toDelete.length}`);
if (unrecoverable) console.log(`sales unrecoverable (untouched): ${unrecoverable}`);

if (dryRun) { console.log("\n--dry-run: no changes written"); process.exit(0); }

const delSale = db.prepare("DELETE FROM sale WHERE id = ?");
const delVal = db.prepare("DELETE FROM car_valuation WHERE car_id = ?");
const delCar = db.prepare("DELETE FROM car WHERE id = ?");

let deletedSales = 0, deletedCars = 0;
db.exec("BEGIN");
try {
  for (const t of toDelete) {
    for (const sid of t.saleIds) { delSale.run(sid); deletedSales++; }
    delVal.run(t.carId);
    delCar.run(t.carId);
    deletedCars++;
  }
  db.exec("COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  console.error("\nrolled back:", e.message);
  process.exit(1);
}

console.log(`\ndeleted ${deletedSales} sales and ${deletedCars} minority-casing cars`);
console.log("NOW RUN:  node ingest/ingest.js   then   node jobs/nightly-compute.js");
