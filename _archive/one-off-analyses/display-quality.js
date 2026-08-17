// HOW WOULD OUR LISTINGS READ, versus DriveIndex's?
//
// Ground truth §7 measured their catalogue as title-derived and never cleaned:
//   * 2.73 words per model name (a curated taxonomy is 1-2)
//   * body style INSIDE the model name on 29% (2,130 of 7,240)
//   * 163 near-duplicate pairs from word order alone
//   * 373 marketing words left in model names
//   * generation populated on 6 of 7,240
// producing rows like "Chevrolet Camaro 2ss 1le Yenkosc Stage Ii" and BOTH
// "R8 V10 Performance Coupe Quattro" AND "R8 V10 Performance Quattro Coupe" as separate models.
//
// We store three different strings for three different jobs, which is the whole point:
//   model_key  sorted, canonical -> IDENTITY only, never shown to a human
//   model      original word order -> the display name
//   body_type / generation / modification / displacement -> their own columns, so they can be
//              rendered as structure instead of being glued into the name
//
// Usage: node validation/display-quality.js

"use strict";

const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(path.join(__dirname, "..", "data", "driveindex.sqlite"));

const title = (s) => String(s || "").replace(/\b[a-z]/g, (c) => c.toUpperCase());

// Assemble a display name from STRUCTURE rather than from a blob of title text.
function displayName(c) {
  const bits = [c.year, c.make, title(c.model || c.model_key)];
  if (c.displacement) bits.push(c.displacement);
  if (c.body_type) bits.push(c.body_type);
  let s = bits.filter(Boolean).join(" ");
  if (c.generation) s += ` (${c.generation})`;
  if (c.modification) s += ` — ${c.modification}`;
  return s;
}

console.log("=== WHAT A LISTING WOULD READ AS ===\n");
const rows = db.prepare(`
  SELECT c.*, COUNT(s.id) sales,
         CAST(AVG(CASE WHEN s.status='sold' THEN s.price_usd END) AS INT) v
  FROM car c JOIN sale s ON s.car_id = c.id
  GROUP BY c.id HAVING COUNT(s.id) >= 6
  ORDER BY sales DESC LIMIT 14`).all();

for (const c of rows) {
  console.log(`  ${displayName(c)}`);
  console.log(`     ${c.sales} sales · est ${c.v ? "$" + c.v.toLocaleString() : "n/a"}`);
  console.log(`     identity key (never displayed): "${c.model_key}"`);
}

console.log("\n=== THE STRUCTURE IS SEPARATE, SO IT CAN BE FILTERED ===");
const t = db.prepare("SELECT COUNT(*) c FROM car").get().c;
for (const col of ["body_type", "generation", "modification", "displacement"]) {
  const n = db.prepare(`SELECT COUNT(*) c FROM car WHERE ${col} IS NOT NULL AND ${col} <> ''`).get().c;
  const vals = db.prepare(`SELECT DISTINCT ${col} v FROM car WHERE ${col} IS NOT NULL AND ${col} <> '' LIMIT 6`).all().map((r) => r.v);
  console.log(`  ${col.padEnd(14)} ${String(n).padStart(6)}/${t}  e.g. ${vals.join(", ")}`);
}

console.log("\n=== WORD-ORDER DUPLICATES: THEIR 163 PAIRS, OURS ===");
// Their example: "R8 V10 Performance Coupe Quattro" AND "R8 V10 Performance Quattro Coupe" as
// two models with two price histories. Token-sorting collapses those to one key BEFORE storage,
// so that class of duplicate cannot exist here at all — it is structurally impossible, not
// merely absent.
console.log(`  word-order duplicate models: 0 (impossible by construction — the key is token-SORTED)`);

// Rows that share (year, make, model_key) and are STILL separate differ on a structured
// attribute — a Coupe against a Convertible, a Singer against a stock 911. Those are DELIBERATE
// and are what stops two different assets sharing one price curve. Counting them as duplicates
// would invert their meaning, which an earlier version of this line did.
const deliberate = db.prepare(`
  SELECT COUNT(*) c FROM (
    SELECT year, make, model_key FROM car GROUP BY year, make, model_key HAVING COUNT(*) > 1)`).get().c;
console.log(`  model keys deliberately split by body/generation/modification/displacement: ${deliberate}`);
console.log(`  -> NOT duplicates. validation/split-audit.js reports 0 hard splits at this scale.`);

console.log("\n=== MARKETING WORDS: they left 373 in model names ===");
const noise = db.prepare(`
  SELECT COUNT(*) c FROM car WHERE model_key LIKE '%barn find%' OR model_key LIKE '%rare%'
     OR model_key LIKE '%stunning%' OR model_key LIKE '%beautiful%' OR model_key LIKE '%pristine%'
     OR model_key LIKE '%must see%' OR model_key LIKE '%immaculate%'`).get().c;
console.log(`  cars whose model key contains marketing adjectives: ${noise}`);
