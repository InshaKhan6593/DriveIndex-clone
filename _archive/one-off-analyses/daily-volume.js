// HOW MUCH NEW DATA ARRIVES PER DAY?
//
// This sizes everything downstream: how often cron should run, how much a per-record LLM call
// would cost, and how big the human review queue grows each day.
//
// Measured from real sold dates in the corpus, not estimated. Uses a recent window because
// older periods are under-harvested (the archive is reached through capped queries, so history
// is sampled while the present is near-complete).
//
// Usage: node validation/daily-volume.js

"use strict";

const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(path.join(__dirname, "..", "data", "driveindex.sqlite"));
const all = (s, ...p) => db.prepare(s).all(...p);

console.log("=== SALES PER DAY, BY SOURCE (last 90 days of harvested data) ===\n");

// The most recent date we hold is the reference; "today" in the data, not the wall clock.
const maxDate = db.prepare("SELECT MAX(date(sold_at)) d FROM sale").get().d;
console.log(`most recent sale in corpus: ${maxDate}\n`);

const rows = all(
  `SELECT source,
          COUNT(*) n,
          COUNT(DISTINCT date(sold_at)) days
   FROM sale
   WHERE date(sold_at) > date(?, '-90 day') AND date(sold_at) <= date(?)
   GROUP BY source ORDER BY n DESC`, maxDate, maxDate);

let totalPerDay = 0;
console.log(`  ${"source".padEnd(8)} ${"sales/90d".padStart(10)} ${"active days".padStart(12)} ${"per day".padStart(9)}`);
for (const r of rows) {
  const perDay = r.n / 90;
  totalPerDay += perDay;
  console.log(`  ${r.source.padEnd(8)} ${String(r.n).padStart(10)} ${String(r.days).padStart(12)} ${perDay.toFixed(1).padStart(9)}`);
}
console.log(`  ${"".padEnd(8)} ${"".padStart(10)} ${"TOTAL".padStart(12)} ${totalPerDay.toFixed(1).padStart(9)}`);

// BaT is the only source harvested to near-completeness for recent dates, so it gives the most
// honest per-day figure. Others are floors, not estimates.
console.log(`\n=== BaT DAILY DETAIL (the only near-complete recent source) ===`);
const bat = all(
  `SELECT date(sold_at) d, COUNT(*) n FROM sale
   WHERE source='bat' AND date(sold_at) > date(?, '-30 day') AND date(sold_at) <= date(?)
   GROUP BY 1 ORDER BY 1 DESC LIMIT 14`, maxDate, maxDate);
for (const r of bat) console.log(`  ${r.d}  ${String(r.n).padStart(4)}  ${"#".repeat(Math.min(r.n, 60))}`);

const b30 = db.prepare(
  `SELECT COUNT(*) n FROM sale WHERE source='bat' AND date(sold_at) > date(?, '-30 day') AND date(sold_at) <= date(?)`
).get(maxDate, maxDate).n;
console.log(`\n  BaT last 30 days: ${b30} sales = ${(b30 / 30).toFixed(0)}/day`);

// What DriveIndex's own volume implies, as a cross-check.
const DI_TOTAL = 110043, DI_BAT_SHARE = 0.722;
console.log(`\n=== CROSS-CHECK AGAINST DRIVEINDEX ===`);
console.log(`  their catalogue: ${DI_TOTAL.toLocaleString()} sales, BaT ${(DI_BAT_SHARE * 100).toFixed(1)}% of the mix`);
console.log(`  our BaT per-day rate x 365 = ${((b30 / 30) * 365).toFixed(0)} BaT sales/year`);
console.log(`  -> at that rate their BaT share (${Math.round(DI_TOTAL * DI_BAT_SHARE).toLocaleString()}) represents about ` +
            `${(Math.round(DI_TOTAL * DI_BAT_SHARE) / ((b30 / 30) * 365)).toFixed(1)} years of accumulation`);

console.log(`\n=== WHAT THIS MEANS FOR A DAILY CRON ===`);
const perDay = Math.round(totalPerDay);
console.log(`  new sales/day across current sources : ~${perDay}`);
console.log(`  at the measured 21% review rate      : ~${Math.round(perDay * 0.21)} items/day to a human`);
console.log(`  if an LLM handled the automatable 60% : ~${Math.round(perDay * 0.21 * 0.4)} items/day genuinely human`);
