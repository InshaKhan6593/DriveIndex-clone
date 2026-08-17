// SEGREGATION REPORT — does the catalogue actually separate cars that are different assets,
// while keeping cars that are the same asset together?
//
// Those are two failure modes pulling in opposite directions, and a system can only be judged
// on both at once:
//   OVER-SEPARATION (splitting)  one real car spread across several rows, so each has too few
//                                sales to compute a signal, and its price history is torn up.
//   UNDER-SEPARATION (merging)   a GT3 RS filed under GT3, or a Singer rebuild under a stock
//                                911, dragging a model-year's value up and possibly flipping
//                                its buy/sell signal.
//
// Identity key (db/schema.sql):
//     UNIQUE (year, make, model_key, body_type, generation, modification, displacement)
//
// Every one of those columns exists because it changes what the asset IS. Transmission
// deliberately does NOT — a 240Z and a 240Z Automatic are the same car with a different option,
// so transmission is recorded per SALE, not per car.
//
// Usage: node validation/segregation-report.js [make] [modelFragment]

"use strict";

const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const db = new DatabaseSync(path.join(__dirname, "..", "data", "driveindex.sqlite"));
const all = (s, ...p) => db.prepare(s).all(...p);
const one = (s, ...p) => db.prepare(s).get(...p);

const MAKE = process.argv[2] || "Porsche";
const MODEL = process.argv[3] || "911";

console.log(`=== THE IDENTITY KEY ===`);
console.log(`  year + make + model_key + body_type + generation + modification + displacement`);
console.log(`  (transmission is NOT here: it is a per-sale option, not a different car)\n`);

// ---- 1. SAME MODEL, DIFFERENT YEAR => DIFFERENT CARS ----
console.log(`=== 1. SAME MODEL, DIFFERENT YEAR = DIFFERENT CARS ===`);
const byYear = all(
  `SELECT c.year, COUNT(DISTINCT c.id) rows, COUNT(s.id) sales,
          CAST(AVG(CASE WHEN s.status='sold' THEN s.price_usd END) AS INT) avg_price
   FROM car c JOIN sale s ON s.car_id = c.id
   WHERE c.make = ? AND c.model_key LIKE ?
   GROUP BY c.year ORDER BY c.year`,
  MAKE, `%${MODEL}%`
);
console.log(`  ${MAKE} "${MODEL}" — each year is its own asset with its own price:`);
console.log(`  ${"year".padEnd(6)} ${"car rows".padStart(8)} ${"sales".padStart(6)} ${"avg sold".padStart(10)}`);
for (const r of byYear.slice(0, 14))
  console.log(`  ${String(r.year).padEnd(6)} ${String(r.rows).padStart(8)} ${String(r.sales).padStart(6)} ${r.avg_price ? "$" + r.avg_price.toLocaleString() : "-"}`.padStart(0));
if (byYear.length > 14) console.log(`  ... ${byYear.length - 14} more years`);
console.log(`  => ${byYear.length} distinct model years, each priced independently.\n`);

// ---- 2. SAME YEAR, DIFFERENT VARIANT => DIFFERENT CARS ----
console.log(`=== 2. SAME YEAR, DIFFERENT VARIANT = DIFFERENT CARS ===`);
const pickYear = byYear.sort((a, b) => b.sales - a.sales)[0];
if (pickYear) {
  const variants = all(
    `SELECT c.model_key, c.body_type, c.generation, c.modification, c.displacement,
            COUNT(s.id) sales,
            CAST(AVG(CASE WHEN s.status='sold' THEN s.price_usd END) AS INT) avg_price
     FROM car c JOIN sale s ON s.car_id = c.id
     WHERE c.make = ? AND c.year = ? AND c.model_key LIKE ?
     GROUP BY c.id ORDER BY sales DESC`,
    MAKE, pickYear.year, `%${MODEL}%`
  );
  console.log(`  ${pickYear.year} ${MAKE} ${MODEL} splits into ${variants.length} separate cars:`);
  console.log(`  ${"model_key".padEnd(30)} ${"body".padEnd(11)} ${"gen".padEnd(6)} ${"sales".padStart(5)} ${"avg sold".padStart(10)}`);
  for (const v of variants.slice(0, 14)) {
    console.log(
      `  ${String(v.model_key).slice(0, 29).padEnd(30)} ${String(v.body_type || "-").slice(0, 10).padEnd(11)} ` +
      `${String(v.generation || "-").padEnd(6)} ${String(v.sales).padStart(5)} ${v.avg_price ? "$" + v.avg_price.toLocaleString() : "-"}`
    );
  }
  const priced = variants.filter((v) => v.avg_price);
  if (priced.length > 1) {
    const lo = Math.min(...priced.map((v) => v.avg_price)), hi = Math.max(...priced.map((v) => v.avg_price));
    console.log(`  => same make, same year: $${lo.toLocaleString()} to $${hi.toLocaleString()} (${(hi / lo).toFixed(1)}x spread).`);
    console.log(`     Merging these would average a base car with a halo car and describe neither.\n`);
  }
}

// ---- 3. THE OPPOSITE TEST: are same-asset sales kept TOGETHER? ----
console.log(`=== 3. THE OPPOSITE TEST — same asset, many sales, ONE row ===`);
const grouped = all(
  `SELECT c.year, c.make, c.model_key, c.body_type, COUNT(s.id) sales
   FROM car c JOIN sale s ON s.car_id = c.id
   GROUP BY c.id HAVING COUNT(s.id) >= 8 ORDER BY sales DESC LIMIT 10`
);
console.log(`  cars whose history stayed on ONE row instead of fragmenting:`);
for (const g of grouped)
  console.log(`   ${String(g.sales).padStart(3)} sales  ${g.year} ${g.make} ${String(g.model_key).slice(0, 34)} (${g.body_type || "-"})`);

const multi = one(`SELECT COUNT(*) c FROM (SELECT car_id FROM sale GROUP BY car_id HAVING COUNT(*) > 1)`).c;
const cars = one("SELECT COUNT(*) c FROM car").c;
const sales = one("SELECT COUNT(*) c FROM sale").c;
console.log(`\n  ${multi} of ${cars} cars carry more than one sale (${((multi / cars) * 100).toFixed(1)}%).`);
console.log(`  ${sales} sales / ${cars} cars = ${(sales / cars).toFixed(2)} per car.`);
console.log(`  A splitting system drives this toward 1.00 — every sale inventing its own car.\n`);

// ---- 4. WHAT EACH COLUMN IS ACTUALLY DOING ----
console.log(`=== 4. HOW MUCH WORK EACH SEPARATOR DOES ===`);
for (const col of ["body_type", "generation", "modification", "displacement"]) {
  const populated = one(`SELECT COUNT(*) c FROM car WHERE ${col} IS NOT NULL AND ${col} <> ''`).c;
  const distinct = one(`SELECT COUNT(DISTINCT ${col}) c FROM car WHERE ${col} IS NOT NULL AND ${col} <> ''`).c;
  // How many cars would COLLAPSE into another row if this column were removed from identity?
  const collapsed = one(
    `SELECT COUNT(*) c FROM (
       SELECT year, make, model_key, COUNT(*) n FROM car GROUP BY year, make, model_key HAVING COUNT(*) > 1)`
  ).c;
  console.log(`  ${col.padEnd(14)} populated on ${String(populated).padStart(6)} cars, ${String(distinct).padStart(4)} distinct values`);
}
const wouldCollapse = one(
  `SELECT COALESCE(SUM(n - 1), 0) c FROM (
     SELECT COUNT(*) n FROM car GROUP BY year, make, model_key HAVING COUNT(*) > 1)`
).c;
console.log(`\n  ${wouldCollapse} car rows exist ONLY because of body_type/generation/modification/displacement.`);
console.log(`  Drop those columns from identity and those ${wouldCollapse} assets merge into others.`);
