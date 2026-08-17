// IS THE APPRECIATING/DEPRECIATING CALL ACTUALLY RIGHT?
//
// Honest position first: the ground truth marks the Value Signal classifier `[U]` — its
// thresholds, window lengths and seasonal adjustment are NOT established (§4.2, §9). We
// implement the confirmed METHOD (three-window regression on mileage-normalised prices, long
// window drives the call) with constants that are ours, not theirs. So our calls cannot be
// "verified against DriveIndex" — there is nothing published to verify against.
//
// What CAN be checked is internal soundness: when the engine says a car is appreciating, do its
// own underlying sales actually rise? That is not proof the thresholds are optimal, but it does
// catch the failure that matters — a signal pointing the wrong way.
//
// This compares each signal against a simple, independent measure: the ratio of the mean price
// in the newest third of a car's sales to the mean in the oldest third. Deliberately NOT the
// engine's own regression, so it is a genuine second opinion rather than a restatement.
//
// Usage: node validation/signal-sanity.js
"use strict";

const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(path.join(__dirname, "..", "data", "driveindex.sqlite"));

const cars = db.prepare(`
  SELECT v.car_id, v.signal, v.annual_return, v.sales_count, c.year, c.make, c.model
  FROM car_valuation v JOIN car c ON c.id = v.car_id
  WHERE v.signal IN ('appreciating','depreciating','stable','bottomed')
    AND v.sales_count >= 8`).all();

const salesFor = db.prepare(`
  SELECT price_usd, sold_at FROM sale
  WHERE car_id = ? AND status = 'sold' AND price_usd IS NOT NULL
    AND is_outlier = 0 AND carfax_damage = 0 AND non_us_sale = 0
  ORDER BY sold_at`);

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const buckets = {};

for (const c of cars) {
  const s = salesFor.all(c.car_id);
  if (s.length < 6) continue;
  const third = Math.max(2, Math.floor(s.length / 3));
  const oldMean = mean(s.slice(0, third).map((r) => r.price_usd));
  const newMean = mean(s.slice(-third).map((r) => r.price_usd));
  if (!oldMean || !newMean) continue;
  const ratio = newMean / oldMean;

  const b = (buckets[c.signal] = buckets[c.signal] || { n: 0, up: 0, down: 0, flat: 0, ratios: [] });
  b.n++;
  b.ratios.push(ratio);
  if (ratio > 1.05) b.up++;
  else if (ratio < 0.95) b.down++;
  else b.flat++;
}

console.log("Independent check: mean price of NEWEST third vs OLDEST third of each car's sales.");
console.log("(cars with >=8 sales and >=6 clean sold rows)\n");
console.log(`  ${"signal".padEnd(14)} ${"cars".padStart(6)} ${"median".padStart(8)}  ${"rose".padStart(6)} ${"fell".padStart(6)} ${"flat".padStart(6)}   agrees?`);

for (const [sig, b] of Object.entries(buckets).sort((a, b) => b[1].n - a[1].n)) {
  const sorted = b.ratios.sort((x, y) => x - y);
  const med = sorted[Math.floor(sorted.length / 2)];
  // What SHOULD dominate for this signal?
  const expect = sig === "appreciating" ? "up" : sig === "depreciating" || sig === "bottomed" ? "down" : "flat";
  const agree = expect === "up" ? b.up : expect === "down" ? b.down : b.flat;
  const pct = ((agree / b.n) * 100).toFixed(0);
  console.log(
    `  ${sig.padEnd(14)} ${String(b.n).padStart(6)} ${med.toFixed(3).padStart(8)}  ` +
    `${String(b.up).padStart(6)} ${String(b.down).padStart(6)} ${String(b.flat).padStart(6)}   ${pct}% ${expect}`
  );
}

console.log(`\nREADING THIS:`);
console.log(`  A median ratio ABOVE 1.0 for 'appreciating' and BELOW 1.0 for 'depreciating' means the`);
console.log(`  signal points the right way on the underlying data. It does NOT prove the thresholds`);
console.log(`  match DriveIndex's — those are [U] and unknowable from outside.`);
console.log(`  'bottomed' is expected to look like a past decline; that is what bottoming means.`);
