// Populate price_usd on sales that were ingested before FX conversion existed.
//
// ingest.js has an "already ingested" fast path keyed on (source, source_lot_id), so an
// existing sale is never re-resolved and would keep price_usd NULL forever. This fills it in
// place from the ECB rate for the day each lot sold (fx/convert.js).
//
// Only ever writes a value where one can actually be derived; a row whose currency or date the
// rate table cannot cover is left NULL, which keeps it excluded from the maths rather than
// converted at a rate that did not apply.
//
// Usage:
//   node fx/backfill-price-usd.js --dry-run
//   node fx/backfill-price-usd.js
"use strict";

const { openDb } = require("../db/client");
const { toUsd, coverage } = require("./convert");

const dryRun = process.argv.includes("--dry-run");
const db = openDb();

const cov = coverage();
console.log(`rate table: ${cov.days} business days, ${cov.from} .. ${cov.to}\n`);

const rows = db.prepare(
  `SELECT id, source, currency, price, sold_at, price_usd FROM sale
   WHERE price_usd IS NULL AND price > 0`
).all();
console.log(`sales with no price_usd: ${rows.length}`);

const upd = db.prepare("UPDATE sale SET price_usd = ? WHERE id = ?");
const bySrc = {}, byCur = {}, failCur = {};
let ok = 0, fail = 0;

const apply = () => {
  for (const r of rows) {
    const usd = toUsd(r.price, r.currency, r.sold_at);
    const cur = r.currency || "(none)";
    if (usd == null) {
      fail++;
      failCur[cur] = (failCur[cur] || 0) + 1;
      continue;
    }
    ok++;
    bySrc[r.source] = (bySrc[r.source] || 0) + 1;
    byCur[cur] = (byCur[cur] || 0) + 1;
    if (!dryRun) upd.run(usd, r.id);
  }
};

if (dryRun) apply();
else { db.exec("BEGIN"); try { apply(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } }

console.log(`  converted : ${ok}`);
console.log(`  could not : ${fail}${fail ? "  " + JSON.stringify(failCur) : ""}`);
console.log("\nby currency:");
for (const [c, n] of Object.entries(byCur).sort((a, b) => b[1] - a[1])) console.log(`   ${c.padEnd(8)} ${n}`);
console.log("by source:");
for (const [s, n] of Object.entries(bySrc).sort((a, b) => b[1] - a[1])) console.log(`   ${s.padEnd(12)} ${n}`);
if (dryRun) console.log("\n--dry-run: no changes written");
