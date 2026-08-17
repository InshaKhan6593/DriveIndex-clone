// One-shot corpus status. Run this after every harvest/ingest so progress is measured,
// not assumed.  Usage: node jobs/status.js
const { DatabaseSync } = require("node:sqlite");
const path = require("path");

const db = new DatabaseSync(path.join(__dirname, "..", "data", "driveindex.sqlite"));
const one = (s) => db.prepare(s).get();
const all = (s) => db.prepare(s).all();

const sales = one("SELECT COUNT(*) c FROM sale").c;
const cars = one("SELECT COUNT(*) c FROM car").c;
const range = one("SELECT MIN(sold_at) a, MAX(sold_at) b FROM sale");
const multi = one("SELECT COUNT(*) c FROM (SELECT car_id FROM sale GROUP BY car_id HAVING COUNT(*) > 1)").c;
const review = one("SELECT COUNT(*) c FROM car_resolution_queue WHERE status = 'pending'").c;

console.log(`sales ............ ${sales}`);
console.log(`cars ............. ${cars}`);
console.log(`sales/car ........ ${(sales / Math.max(cars, 1)).toFixed(2)}`);
console.log(`multi-sale cars .. ${multi}`);
console.log(`pending review ... ${review}  (${((review / Math.max(sales, 1)) * 100).toFixed(1)}%)`);
console.log(`date range ....... ${String(range.a).slice(0, 10)} -> ${String(range.b).slice(0, 10)}`);

console.log("\nby source:");
for (const r of all("SELECT source, COUNT(*) c, MIN(sold_at) a, MAX(sold_at) b FROM sale GROUP BY 1 ORDER BY 2 DESC"))
  console.log(`  ${r.source.padEnd(8)} ${String(r.c).padStart(7)}   ${String(r.a).slice(0, 10)} -> ${String(r.b).slice(0, 10)}`);

console.log("\nsales per year:");
for (const r of all("SELECT substr(sold_at,1,4) y, COUNT(*) c FROM sale GROUP BY 1 ORDER BY 1"))
  console.log(`  ${r.y}  ${String(r.c).padStart(6)}  ${"#".repeat(Math.round(r.c / 200))}`);

// Field fill rates decide which engine components can actually run.
console.log("\nfill rates:");
for (const f of ["price_usd", "mileage", "vin_normal", "color", "transmission"]) {
  const c = one(`SELECT COUNT(${f}) c FROM sale`).c;
  console.log(`  ${f.padEnd(13)} ${((c / Math.max(sales, 1)) * 100).toFixed(1)}%`);
}
