// NULL IS NOT A VALUE — measuring the splits caused by treating it as one.
//
// Found by inspecting 1987 Porsche 911 rows by hand. Three pairs were the same car twice:
//
//   "911 carrera" Convertible disp=NULL   (4 sales)  vs  "911 carrera" Convertible disp=3.2L (1)
//        every 1987 Carrera IS the 3.2 — one listing simply said so
//   "911 m505 turbo" Convertible          (1 sale)   vs  "911 m505 turbo" body=NULL          (1)
//        one title mentioned the body style, the other did not
//   "911 carrera g50" Convertible         (4 sales)  vs  "911 g50" Convertible               (2)
//        one seller omitted the word "Carrera"
//
// The identity key treats NULL as a distinct value, so "attribute stated" and "attribute not
// stated" become different assets. But a missing body style is not a DIFFERENT body style —
// it is an unknown one, and unknown should not silently mint a new car.
//
// This is invisible to the existing split audit: those rows have identical model_keys, so
// compareModelKeys is never consulted and they are counted as DELIBERATE separations.
//
// Usage: node validation/null-attribute-splits.js
"use strict";

const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(path.join(__dirname, "..", "data", "driveindex.sqlite"));
const all = (s) => db.prepare(s).all();

// Split the attributes by what a BLANK means, because only one group can produce a defect.
//   INTRINSIC — every car has one, so blank = UNKNOWN. A stated-vs-unstated pair here is one
//               car recorded twice, and must be zero.
//   ASSERTED  — blank = "stock". A stated-vs-unstated pair here is a genuine distinction
//               (race car vs stock), so counting it as a defect would train the reader to
//               ignore the number.
const INTRINSIC = ["body_type", "generation", "displacement"];
const ASSERTED = ["modification"];
const ATTRS = [...INTRINSIC, ...ASSERTED];

console.log("=== FILL RATES OF THE SEPARATOR COLUMNS ===");
const total = db.prepare("SELECT COUNT(*) c FROM car").get().c;
for (const a of ATTRS) {
  const n = db.prepare(`SELECT COUNT(*) c FROM car WHERE ${a} IS NOT NULL AND ${a} <> ''`).get().c;
  console.log(`  ${a.padEnd(14)} ${String(n).padStart(6)} / ${total}  (${((n / total) * 100).toFixed(1)}%)`);
}
console.log(`  -> a column populated only part of the time SEPARATES on its own absence.\n`);

let grand = 0;
for (const attr of ATTRS) {
  const others = ATTRS.filter((x) => x !== attr);
  const sameOthers = others.map((o) => `COALESCE(a.${o},'~') = COALESCE(b.${o},'~')`).join(" AND ");

  // Pairs identical on year+make+model_key and on every OTHER attribute, where exactly one
  // side states this attribute and the other leaves it NULL.
  const rows = all(`
    SELECT a.year, a.make, a.model_key, a.${attr} AS val,
           (SELECT COUNT(*) FROM sale WHERE car_id = a.id) a_sales,
           (SELECT COUNT(*) FROM sale WHERE car_id = b.id) b_sales
    FROM car a JOIN car b
      ON a.year = b.year AND a.make = b.make AND a.model_key = b.model_key
     AND a.id < b.id AND ${sameOthers}
    WHERE (a.${attr} IS NOT NULL AND a.${attr} <> '') AND (b.${attr} IS NULL OR b.${attr} = '')`);

  const withSales = rows.filter((r) => r.a_sales > 0 && r.b_sales > 0);
  const isDefect = INTRINSIC.includes(attr);
  if (isDefect) grand += withSales.length;
  console.log(
    `${attr}: ${rows.length} stated-vs-unstated pairs, ${withSales.length} where BOTH carry sales` +
    (isDefect ? "   <- DEFECT if > 0" : "   <- BY DESIGN (blank asserts 'stock')")
  );
  for (const r of withSales.slice(0, isDefect ? 6 : 3))
    console.log(`   ${r.year} ${r.make} "${String(r.model_key).slice(0, 30)}"  ${attr}=${r.val} (${r.a_sales} sales)  vs  NULL (${r.b_sales} sales)`);
}

console.log(`\n=== VERDICT ===`);
if (grand === 0) {
  console.log(`  PASS — no car is split merely because a listing left an intrinsic attribute unstated.`);
  console.log(`  (${ASSERTED.join("/")} pairs are excluded on purpose: a blank there asserts "stock",`);
  console.log(`   so a race car or engine swap staying separate from the stock car is CORRECT.)`);
} else {
  console.log(`  ${grand} car pairs are one asset recorded twice, separated only by whether a`);
  console.log(`  listing happened to mention an intrinsic attribute. Each one splits a price history.`);
}
process.exit(grand === 0 ? 0 : 1);
