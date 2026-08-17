// DUPLICATION AUDIT — "check that there is not duplicacy".
//
// "Duplicate" means four genuinely different things in this system, and a clean result on one
// says nothing about the others. This checks all four, at the level each actually occurs.
//
//  1. SCRAPE-LEVEL   the same lot harvested twice into the raw files.
//                    Guard: records keyed on (source, source_lot_id) in a Map.
//  2. INGEST-LEVEL   the same lot inserted into `sale` twice — e.g. re-running ingest, or one
//                    lot arriving from two partitions. Guard: idempotent ingest on the same key.
//  3. CROSS-SOURCE   one real transaction reported by two houses (an aggregator republishing
//                    a BaT sale). Guard: dedup/dedup.js duplicateScore + source trust.
//  4. CATALOGUE      two `car` rows that are the same car, so one car's price history is split
//                    across both. Guard: the identity key + resolver. (validation/split-audit.js)
//
// A repeat SALE of the same physical car is deliberately NOT a duplicate — it is the single
// most valuable signal in the product, and conflating the two would destroy it. Reported
// separately so the distinction stays visible.
//
// Usage: node validation/duplication-audit.js

"use strict";

const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { loadScrapedRecords } = require("../ingest/load-scraped");

const db = new DatabaseSync(path.join(__dirname, "..", "data", "driveindex.sqlite"));
const all = (s) => db.prepare(s).all();
const one = (s) => db.prepare(s).get();

let problems = 0;
// `expected` marks overlap that the design PRODUCES ON PURPOSE and then resolves. Counting it
// as a defect would make every clean run report hundreds of "issues" and train the reader to
// ignore the number — the opposite of what an audit is for.
const check = (label, count, detail = "", expected = false) => {
  if (count > 0 && !expected) problems += count;
  const tag = count === 0 ? "CLEAN" : expected ? " n/a " : " DUPS";
  console.log(`  ${tag}  ${label.padEnd(52)} ${count}${detail ? "  " + detail : ""}`);
};

console.log("=== 1. SCRAPE LEVEL — same lot harvested twice ===");
const recs = loadScrapedRecords();
const seen = new Map();
let scrapeDupes = 0;
for (const r of recs) {
  const k = `${r.source}|${r.source_lot_id}`;
  if (seen.has(k)) scrapeDupes++;
  else seen.set(k, r);
}
console.log(`  raw records across all files : ${recs.length}`);
console.log(`  distinct (source, lot) keys  : ${seen.size}`);
check("same lot appearing in more than one file", scrapeDupes,
  "(BY DESIGN — categories overlap; merged on the natural key)", true);

console.log("\n=== 2. INGEST LEVEL — same lot inserted twice into `sale` ===");
const lotDupes = all(`
  SELECT source, source_lot_id, COUNT(*) n
  FROM sale GROUP BY source, source_lot_id HAVING COUNT(*) > 1 ORDER BY n DESC`);
check("(source, source_lot_id) appearing twice in `sale`", lotDupes.length);
for (const d of lotDupes.slice(0, 10)) console.log(`         ${d.source} ${d.source_lot_id} x${d.n}`);

console.log("\n=== 3. CROSS-SOURCE — one transaction reported by two houses ===");
//
// ⚠️ SAME MODEL + SAME WEEK + SIMILAR PRICE IS NOT A DUPLICATE.
//
// An earlier version of this check used exactly that, and at 97,607 sales it reported 22
// "duplicates" that were nothing of the kind: a 2022 Taycan 4 Cross Turismo at $72,500 on BaT
// and $75,000 on Cars & Bids, a 2012 R8 Spyder at $68,000 and $71,000, a V70R at $13,250 and
// $12,766. Different URLs, different lots, different physical cars. Two examples of a common
// model selling in one week at similar money is ordinary market behaviour, and the volume of
// such coincidences grows with the corpus.
//
// The pipeline was right about all of them — duplicateScore lands near 0.60 against a 0.75
// threshold and keeps them separate. The AUDIT was wrong, and an audit that cries wolf at scale
// is worse than no audit, because the real signal gets ignored.
//
// A genuine cross-source duplicate is one PHYSICAL car reported twice, which needs identity
// evidence, not resemblance: a shared VIN, or a shared canonical listing URL.
const crossDupes = all(`
  SELECT a.car_id, a.source sa, b.source sb, a.price_usd pa, b.price_usd pb, a.sold_at,
         a.vin_normal va, b.vin_normal vb
  FROM sale a JOIN sale b
    ON a.car_id = b.car_id AND a.id < b.id
   AND a.source <> b.source
   AND abs(julianday(a.sold_at) - julianday(b.sold_at)) <= 7
   AND (
        (a.vin_normal IS NOT NULL AND a.vin_normal = b.vin_normal)
     OR (a.url IS NOT NULL AND lower(rtrim(a.url,'/')) = lower(rtrim(b.url,'/')))
   )`);
check("same PHYSICAL car (shared VIN or URL) from two sources", crossDupes.length);
for (const d of crossDupes.slice(0, 10))
  console.log(`         car ${d.car_id}: ${d.sa} $${d.pa} vs ${d.sb} $${d.pb} on ${String(d.sold_at).slice(0, 10)}  vin=${d.va || "-"}`);

// Reported for visibility only — this is the market, not a defect.
const coincidences = one(`
  SELECT COUNT(*) c FROM sale a JOIN sale b
    ON a.car_id = b.car_id AND a.id < b.id AND a.source <> b.source
   AND abs(julianday(a.sold_at) - julianday(b.sold_at)) <= 2
   AND a.price_usd IS NOT NULL AND b.price_usd IS NOT NULL
   AND abs(a.price_usd - b.price_usd) <= 0.05 * a.price_usd`).c;
check("same model, same week, similar price on two platforms", coincidences,
  "(NOT duplicates — two different cars of one model; expected at scale)", true);

console.log("\n=== 4. EXACT-ROW duplicates (same car, same day, same price, SAME source) ===");
const exact = all(`
  SELECT car_id, sold_at, price_usd, COUNT(*) n
  FROM sale WHERE price_usd IS NOT NULL
  GROUP BY car_id, date(sold_at), price_usd HAVING COUNT(*) > 1 ORDER BY n DESC`);
check("identical (car, date, price) rows", exact.length);
for (const d of exact.slice(0, 10)) console.log(`         car ${d.car_id} $${d.price_usd} on ${String(d.sold_at).slice(0, 10)} x${d.n}`);

console.log("\n=== 5. CATALOGUE — duplicate car rows ===");
const carDupes = all(`
  SELECT year, make, model_key, COALESCE(body_type,''), COALESCE(generation,''),
         COALESCE(modification,''), COALESCE(displacement,''), COUNT(*) n
  FROM car GROUP BY 1,2,3,4,5,6,7 HAVING COUNT(*) > 1`);
check("car rows identical on every identity field", carDupes.length,
  "(the UNIQUE constraint should make this impossible)");
console.log(`         -> for same-car-different-key splits, see validation/split-audit.js`);

console.log("\n=== NOT duplicates: genuine repeat sales (the product's core signal) ===");
const repeat = one(`SELECT COUNT(*) c FROM (SELECT car_id FROM sale GROUP BY car_id HAVING COUNT(*) > 1)`).c;
const totalSales = one("SELECT COUNT(*) c FROM sale").c;
const totalCars = one("SELECT COUNT(*) c FROM car").c;
console.log(`  cars with more than one sale : ${repeat}`);
console.log(`  sales attached to an existing car rather than creating a new one:`);
console.log(`     ${totalSales} sales across ${totalCars} cars = ${(totalSales / Math.max(totalCars, 1)).toFixed(2)} sales/car`);

console.log(`\n${problems === 0 ? "PASS — no duplication at any level" : `${problems} duplication issues found`}`);
process.exit(0);
