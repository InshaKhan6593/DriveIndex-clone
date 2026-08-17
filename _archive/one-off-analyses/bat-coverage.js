// BaT COVERAGE — what we have, what is provably finished, and what is still out there.
//
// Three questions this answers, because they have three different answers:
//   1. how many BaT records are in the database
//   2. is BaT "done" — and for which slices is that a PROVEN claim rather than a hope
//   3. which makes are covered, and is coverage broad or concentrated
//
// Completion is judged per PARTITION, not globally. A partition whose measured total fits
// inside the reachable window (48 x 208 = 9,984 records) and which has been walked is
// genuinely exhausted. A partition larger than that is truncated by the server's 10k offset
// cap and can never be more than PARTIAL, however long it runs.
//
// Usage: node validation/bat-coverage.js

"use strict";

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.join(__dirname, "..");
const db = new DatabaseSync(path.join(ROOT, "data", "driveindex.sqlite"));
const all = (s, ...p) => db.prepare(s).all(...p);
const one = (s, ...p) => db.prepare(s).get(...p);

const REACHABLE = 48 * 208; // 9,984 — measured server-side offset ceiling

const plan = JSON.parse(fs.readFileSync(path.join(ROOT, "samples", "bat-partition-plan.json"), "utf8"));
let done = new Set();
try {
  done = new Set(JSON.parse(fs.readFileSync(path.join(ROOT, "samples", "scraped", "bat-partitioned.state.json"), "utf8")).completed);
} catch {}

// Same policy the harvester applies — these are not automobiles and are excluded on purpose.
const NON_CAR = new Set([379, 380, 383, 544, 432, 428, 430, 70, 553, 431]);

console.log("=== 1. WHAT IS IN THE DATABASE ===");
const batSales = one("SELECT COUNT(*) c FROM sale WHERE source = 'bat'").c;
const batCars = one("SELECT COUNT(DISTINCT car_id) c FROM sale WHERE source = 'bat'").c;
const range = one("SELECT MIN(sold_at) a, MAX(sold_at) b FROM sale WHERE source = 'bat'");
console.log(`  BaT sales in DB      : ${batSales.toLocaleString()}`);
console.log(`  distinct cars        : ${batCars.toLocaleString()}`);
console.log(`  date range           : ${String(range.a).slice(0, 10)} -> ${String(range.b).slice(0, 10)}`);

const harvested = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, "samples", "scraped", "bat-partitioned.json"), "utf8")).length; }
  catch { return 0; }
})();
console.log(`  harvested but not all ingested (review/rejects account for the gap):`);
console.log(`     partitioned file   : ${harvested.toLocaleString()} raw records`);

console.log("\n=== 2. IS BaT COMPLETE? ===");

// DENOMINATOR — do NOT sum category totals.
//
// Categories OVERLAP: a Porsche 911 Cabriolet is both "German" and "Convertibles", a Bronco is
// both "American" and "Truck & 4x4". Adding them up gave 389,465 against a site that reports
// 257,919 listings in total — i.e. a target 51% larger than the entire archive, which would
// have understated coverage by the same factor.
//
// The only unduplicated figures are the ones the unfiltered endpoint reports for itself:
const BAT_TOTAL_LISTINGS = 257919; // measured: items_total, no filter
const BAT_TOTAL_SOLD = 204272;     // measured: items_total, state=sold
// Non-car categories are largely disjoint from the car ones (a boat is not also "American"),
// so subtracting their sum is a fair approximation of the car-only universe.
const NON_CAR_LISTINGS = plan.filter((r) => NON_CAR.has(Number(r.id))).reduce((a, b) => a + b.total, 0);

const carRows = plan.filter((r) => !NON_CAR.has(Number(r.id)));
const carTotal = BAT_TOTAL_LISTINGS - NON_CAR_LISTINGS;
const carSold = BAT_TOTAL_SOLD - Math.round(NON_CAR_LISTINGS * (BAT_TOTAL_SOLD / BAT_TOTAL_LISTINGS));

let completeRecords = 0, partialRecords = 0, notRunRecords = 0;
const partials = [], notRun = [];
for (const r of carRows) {
  if (r.total === 0) continue;
  const anySortDone = ["td", "ta", "vd", "bd"].some((s) => done.has(`${r.id}|${r.state}|${s}`));
  if (r.total <= REACHABLE) {
    if (anySortDone) completeRecords += r.total;
    else { notRunRecords += r.total; notRun.push(r); }
  } else {
    if (anySortDone) { partialRecords += r.total; partials.push(r); }
    else { notRunRecords += r.total; notRun.push(r); }
  }
}

const pct = (n) => `${((n / Math.max(carSold, 1)) * 100).toFixed(1)}%`;
console.log(`  BaT listings in total (unfiltered)          : ${BAT_TOTAL_LISTINGS.toLocaleString()}`);
console.log(`  ...of which SOLD                            : ${BAT_TOTAL_SOLD.toLocaleString()}`);
console.log(`  ...minus non-car categories (~${NON_CAR_LISTINGS.toLocaleString()})`);
console.log(`  => car-only SOLD universe, our real target  : ~${carSold.toLocaleString()}`);
console.log(``);
console.log(`  BaT sold-sales actually in our DB           : ${batSales.toLocaleString()}  (${pct(batSales)} of target)`);
console.log(``);
console.log(`  Partition accounting (these figures DOUBLE COUNT — categories overlap —`);
console.log(`  so treat them as relative weights, not as a share of the target):`);
console.log(`    proven exhausted     : ${completeRecords.toLocaleString()}`);
console.log(`    capped at 10k        : ${partialRecords.toLocaleString()}`);
console.log(`    not yet run          : ${notRunRecords.toLocaleString()}`);

console.log(`\n  NOT COMPLETE. Still outstanding:`);
if (notRun.length) {
  console.log(`    never run (${notRun.length} partitions):`);
    for (const r of notRun.sort((a, b) => b.total - a.total).slice(0, 12))
      console.log(`       ${r.name.padEnd(22)} ${r.state.padEnd(6)} ${String(r.total).padStart(6)}`);
}
if (partials.length) {
  console.log(`    over the 10k cap, can never fully complete (${partials.length} partitions):`);
  for (const r of partials.sort((a, b) => b.total - a.total))
    console.log(`       ${r.name.padEnd(22)} ${r.state.padEnd(6)} ${String(r.total).padStart(6)}  reachable <= ${Math.min(r.total, REACHABLE * 4).toLocaleString()} via 4 sorts`);
}

console.log("\n=== 3. WHICH MAKES ===");
const makes = all(`
  SELECT c.make, COUNT(*) n, COUNT(DISTINCT c.id) cars, MIN(s.sold_at) first, MAX(s.sold_at) last
  FROM sale s JOIN car c ON c.id = s.car_id
  WHERE s.source = 'bat' GROUP BY c.make ORDER BY n DESC`);
console.log(`  distinct makes covered : ${makes.length}`);
console.log(`  -> this is a BROAD crawl of every car category, NOT one make.\n`);
console.log(`  ${"make".padEnd(20)} ${"sales".padStart(6)} ${"cars".padStart(6)}   share`);
let cum = 0;
for (const m of makes.slice(0, 25)) {
  cum += m.n;
  console.log(`  ${String(m.make).padEnd(20)} ${String(m.n).padStart(6)} ${String(m.cars).padStart(6)}   ${((m.n / batSales) * 100).toFixed(1)}%`);
}
console.log(`  ... ${makes.length - 25} more makes`);
console.log(`\n  top 25 makes = ${((cum / Math.max(batSales, 1)) * 100).toFixed(1)}% of BaT sales`);
const singleton = makes.filter((m) => m.n === 1).length;
console.log(`  makes with only ONE sale: ${singleton}  (the long tail auction catalogues always have)`);
