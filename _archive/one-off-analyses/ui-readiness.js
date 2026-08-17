// CAN OUR DATA DRIVE DRIVEINDEX'S UI?
//
// Their Explore screen needs, concretely:
//   * a MAKE dropdown (AC, AM General, AMC, Acura, Alfa Romeo, Alpina, Aston Martin, Audi,
//     Autokraft, Autozam, BAC, BMW, Beck, Bentley, Bizzarrini, Bugatti, ...)
//   * a BODY dropdown with exactly five values: Coupe, Convertible, SUV, Sedan, Wagon
//   * a YEAR dropdown
//   * model cards: "Porsche 911 GT2 RS (991)" · "55 listed" · "EST. VALUE $851,482"
//   * a model count — theirs reads 6,834
//
// This checks each against what we actually hold, and is deliberately blunt about the gaps.
//
// Usage: node validation/ui-readiness.js

"use strict";

const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(path.join(__dirname, "..", "data", "driveindex.sqlite"));
const one = (s, ...p) => db.prepare(s).get(...p);
const all = (s, ...p) => db.prepare(s).all(...p);

// Read verbatim off their dropdown screenshot.
const THEIR_MAKES = ["AC", "AM General", "AMC", "Acura", "Alfa Romeo", "Alpina", "Aston Martin",
  "Audi", "Autokraft", "Autozam", "BAC", "BMW", "Beck", "Bentley", "Bizzarrini", "Bugatti"];
const THEIR_BODIES = ["Coupe", "Convertible", "SUV", "Sedan", "Wagon"];

console.log("=== 1. MAKE DROPDOWN ===");
const ourMakes = new Set(all("SELECT DISTINCT make FROM car").map((r) => String(r.make)));
const lower = new Set([...ourMakes].map((m) => m.toLowerCase()));
console.log(`  our distinct makes: ${ourMakes.size}`);
let have = 0;
for (const m of THEIR_MAKES) {
  const hit = lower.has(m.toLowerCase());
  if (hit) have++;
  const n = hit ? one("SELECT COUNT(*) c FROM car WHERE lower(make) = lower(?)", m).c : 0;
  console.log(`   ${hit ? "HAVE" : "MISS"}  ${m.padEnd(14)} ${hit ? n + " cars" : ""}`);
}
console.log(`  -> ${have}/${THEIR_MAKES.length} of their visible dropdown entries`);

console.log("\n=== 2. BODY DROPDOWN (they expose exactly 5) ===");
const bodies = all(`SELECT body_type b, COUNT(*) n FROM car WHERE body_type IS NOT NULL AND body_type <> '' GROUP BY 1 ORDER BY n DESC`);
const totalCars = one("SELECT COUNT(*) c FROM car").c;
const withBody = bodies.reduce((a, b) => a + b.n, 0);
for (const b of bodies) console.log(`   ${String(b.b).padEnd(14)} ${b.n}`);
console.log(`  body_type populated on ${withBody}/${totalCars} cars (${((withBody / totalCars) * 100).toFixed(1)}%)`);
for (const b of THEIR_BODIES) {
  const n = one("SELECT COUNT(*) c FROM car WHERE lower(body_type) = lower(?)", b).c;
  console.log(`   ${n > 0 ? "HAVE" : "MISS"}  ${b.padEnd(12)} ${n} cars`);
}

console.log("\n=== 3. YEAR DROPDOWN ===");
const yr = one("SELECT MIN(year) a, MAX(year) b, COUNT(DISTINCT year) n FROM car");
console.log(`   ${yr.n} distinct model years, ${yr.a} - ${yr.b}`);

console.log("\n=== 4. MODEL COUNT — their header says 6,834 models ===");
console.log(`   our car rows (make+model+YEAR+body+...)  : ${totalCars}`);
const modelLevel = one("SELECT COUNT(*) c FROM (SELECT DISTINCT make, model_key FROM car)").c;
console.log(`   our MODEL level (make+model, year-agnostic): ${modelLevel}`);
console.log(`   -> their 'car' carries year AND yearEnd, i.e. a year RANGE per model+generation.`);
console.log(`      Ours is one row per exact model-year. Same data, different grain — a model`);
console.log(`      card is a GROUP BY over our rows, not a schema change.`);

console.log("\n=== 5. MODEL CARD: can we fill it? ===");
// "Porsche 911 GT2 RS (991)" · 55 listed · EST. VALUE $851,482
const sample = all(`
  SELECT c.make, c.model_key, c.generation, COUNT(s.id) sales,
         CAST(AVG(CASE WHEN s.status='sold' THEN s.price_usd END) AS INT) avg_sold
  FROM car c JOIN sale s ON s.car_id = c.id
  GROUP BY c.make, c.model_key HAVING COUNT(s.id) >= 20
  ORDER BY sales DESC LIMIT 5`);
for (const s of sample)
  console.log(`   ${s.make} ${String(s.model_key).slice(0, 24).padEnd(25)} sales=${String(s.sales).padStart(4)}  avg sold ${s.avg_sold ? "$" + s.avg_sold.toLocaleString() : "-"}`);

const valuable = one(`SELECT COUNT(*) c FROM (
  SELECT car_id FROM sale WHERE status='sold' AND price_usd IS NOT NULL
  GROUP BY car_id HAVING COUNT(*) >= 3)`).c;
console.log(`\n   cars with >=3 clean sold sales (enough for an EST. VALUE): ${valuable}`);

console.log("\n=== 6. THE GAPS ===");
const listings = one("SELECT COUNT(*) c FROM listing").c;
console.log(`   'N listed' needs ACTIVE listings. We hold ${listings} listing rows.`);
console.log(`   Their /api/stats/public reports 33,865 listings from RETAIL sources`);
console.log(`   (cars.com, classic.com) — a source class we have not scraped at all.`);
const gen = one("SELECT COUNT(*) c FROM car WHERE generation IS NOT NULL AND generation <> ''").c;
console.log(`\n   '(991)' in the card title is a GENERATION. We populate it on ${gen}/${totalCars} cars.`);
console.log(`   (Theirs is 6 of 7,240 — so neither of us has it, and they render it from the`);
console.log(`    model NAME string rather than the column.)`);
