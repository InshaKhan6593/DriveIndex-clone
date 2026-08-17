// Is the ENGINE actually producing usable output, or just running without error?
//
// A nightly compute that finishes cleanly but rates nothing is not working. The benchmark is
// DriveIndex's own live distribution, read from their /market-trends page:
//   430 appreciating · 2,374 stable · 235 depreciating · 247 bottomed = 3,286 rated of 7,241.
// So 55% of their catalogue sits UNRATED — a useful reminder that thin data is normal in this
// domain and a high unrated share is not automatically a defect.
//
// Usage: node jobs/engine-health.js
"use strict";

const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(path.join(__dirname, "..", "data", "driveindex.sqlite"));
const one = (s) => db.prepare(s).get();
const all = (s) => db.prepare(s).all();

const total = one("SELECT COUNT(*) c FROM car_valuation").c;
console.log(`valuations computed : ${total}`);
console.log(`cars in catalogue   : ${one("SELECT COUNT(*) c FROM car").c}`);

console.log(`\nsignal distribution:`);
for (const r of all("SELECT signal, COUNT(*) n FROM car_valuation GROUP BY signal ORDER BY n DESC"))
  console.log(`  ${String(r.signal || "(null)").padEnd(16)} ${String(r.n).padStart(7)}`);

const rated = one("SELECT COUNT(*) c FROM car_valuation WHERE signal IS NOT NULL AND signal <> 'insufficient'").c;
console.log(`\nrated ............... ${rated} / ${total}  (${((rated / Math.max(total, 1)) * 100).toFixed(1)}%)`);
console.log(`  DriveIndex rates 3,286 of 7,241 = 45.4%, so 55% unrated is the norm here.`);

console.log(`\nfields actually populated:`);
for (const f of ["current_value", "annual_return", "confidence", "collectibility_score",
                 "liquidity_verdict", "buy_hold_sell", "forecast_3y", "projection_confidence", "best_months"]) {
  try {
    const n = one(`SELECT COUNT(${f}) c FROM car_valuation`).c;
    console.log(`  ${f.padEnd(22)} ${String(n).padStart(7)}  (${((n / Math.max(total, 1)) * 100).toFixed(1)}%)`);
  } catch { console.log(`  ${f.padEnd(22)} (column absent)`); }
}

console.log(`\nbuy/hold/sell spread — the actual product output:`);
for (const r of all("SELECT buy_hold_sell b, COUNT(*) n FROM car_valuation WHERE buy_hold_sell IS NOT NULL GROUP BY 1 ORDER BY n DESC"))
  console.log(`  ${String(r.b).padEnd(24)} ${String(r.n).padStart(7)}`);

console.log(`\ncars with a real signal AND a value — what a customer would actually see:`);
const usable = all(`
  SELECT c.year, c.make, c.model, v.signal, v.current_value, v.confidence, v.buy_hold_sell,
         v.sales_count, v.annual_return, v.forecast_3y
  FROM car_valuation v JOIN car c ON c.id = v.car_id
  WHERE v.signal NOT IN ('insufficient') AND v.current_value IS NOT NULL
  ORDER BY v.sales_count DESC LIMIT 10`);
for (const u of usable)
  console.log(
    `  ${u.year} ${String(u.make + " " + (u.model || "")).slice(0, 26).padEnd(27)} ${String(u.signal).padEnd(13)}` +
    ` $${Number(u.current_value).toLocaleString().padStart(9)}  conf=${u.confidence ?? "-"}  n=${String(u.sales_count).padStart(4)}` +
    `  ret=${u.annual_return != null ? (u.annual_return * 100).toFixed(1) + "%" : "-"}  ${u.buy_hold_sell}`);
