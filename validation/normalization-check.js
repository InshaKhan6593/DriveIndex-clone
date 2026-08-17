// ARE MILEAGE NORMALISATION AND SEASONALITY ACTUALLY RUNNING, or just implemented?
//
// The ground truth describes the signal as "3-window regression on mileage-normalised,
// SEASONALLY-ADJUSTED sale prices". Both adjustments are implemented — but an adjustment can
// only fire when the DATA supports it, and a normaliser silently fed nulls does nothing while
// looking fine. This measures what is actually happening.
//
// Usage: node validation/normalization-check.js
"use strict";

const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { mileageAdjust } = require("../engine/mileage");
const { computeSeasonality } = require("../engine/seasonality");

const db = new DatabaseSync(path.join(__dirname, "..", "data", "driveindex.sqlite"));
const one = (s) => db.prepare(s).get();
const all = (s, ...p) => db.prepare(s).all(...p);

console.log("=== MILEAGE: is there anything to normalise WITH? ===");
const total = one("SELECT COUNT(*) c FROM sale").c;
for (const src of all("SELECT source, COUNT(*) n, COUNT(mileage) m FROM sale GROUP BY source ORDER BY n DESC"))
  console.log(`  ${src.source.padEnd(8)} ${String(src.m).padStart(6)} / ${String(src.n).padStart(6)} have mileage  (${((src.m / src.n) * 100).toFixed(1)}%)`);
const withMiles = one("SELECT COUNT(mileage) c FROM sale").c;
console.log(`  OVERALL  ${withMiles}/${total} (${((withMiles / total) * 100).toFixed(1)}%)`);

console.log(`\n  -> signal.js falls back to ctx.avgMiles when a sale has no mileage, so a sale with`);
console.log(`     no odometer is treated as AVERAGE for its car. That is the safe default (it`);
console.log(`     applies no adjustment) but it means normalisation only does real work on the`);
console.log(`     ${((withMiles / total) * 100).toFixed(1)}% of rows that carry a number.`);

console.log("\n=== MILEAGE ADJUSTMENT: proof it changes the number ===");
// Same car, same value, different odometers.
const base = 100000, avg = 60000;
for (const [label, miles, coll] of [
  ["delivery-mile (500)", 500, 7],
  ["half average (30k)", 30000, 7],
  ["average (60k)", 60000, 7],
  ["double average (120k)", 120000, 7],
  ["4x average (240k)", 240000, 7],
  ["half average, collectible(9)", 30000, 9],
  ["half average, ordinary(3)", 30000, 3],
]) {
  const v = mileageAdjust(base, miles, avg, coll, 20);
  const pct = ((v / base - 1) * 100).toFixed(1);
  console.log(`  ${label.padEnd(30)} $${String(v).padStart(7)}  ${pct > 0 ? "+" : ""}${pct}%`);
}

console.log("\n=== SEASONALITY: how many cars have enough sales to compute it? ===");
const counts = all(`SELECT car_id, COUNT(*) n FROM sale WHERE status='sold' GROUP BY car_id HAVING COUNT(*) >= 12`);
console.log(`  cars with >=12 sold sales (the gate): ${counts.length}`);

const salesFor = db.prepare(`
  SELECT price_usd, sold_at, mileage FROM sale
  WHERE car_id=? AND status='sold' AND price_usd IS NOT NULL ORDER BY sold_at`);
let computed = 0, gated = 0;
const examples = [];
for (const c of counts.slice(0, 400)) {
  const s = salesFor.all(c.car_id).map((r) => ({ price_usd: r.price_usd, sold_at: r.sold_at, mileage: r.mileage }));
  const out = computeSeasonality(s);
  if (out && out.bestMonths && out.bestMonths.length) {
    computed++;
    if (examples.length < 6) {
      const car = one(`SELECT year, make, model FROM car WHERE id='${c.car_id}'`);
      examples.push(`${car.year} ${car.make} ${car.model || ""} — best ${out.bestMonths.join(",")} worst ${(out.worstMonths || []).join(",")} strength ${out.seasonalStrength != null ? out.seasonalStrength.toFixed(3) : "-"} (n=${s.length})`);
    }
  } else gated++;
}
console.log(`  of the first 400: ${computed} produced a seasonal profile, ${gated} correctly gated as too thin`);
for (const e of examples) console.log(`     ${e}`);

console.log("\n=== WHAT IS STORED ===");
for (const f of ["avg_mileage", "best_months", "worst_months", "seasonal_strength", "buy_discount_pct", "sell_premium_pct", "monthly_indices"]) {
  try {
    const n = one(`SELECT COUNT(${f}) c FROM car_valuation`).c;
    const t = one("SELECT COUNT(*) c FROM car_valuation").c;
    console.log(`  ${f.padEnd(20)} ${String(n).padStart(6)}/${t}  (${((n / t) * 100).toFixed(1)}%)`);
  } catch { console.log(`  ${f.padEnd(20)} (column absent)`); }
}
