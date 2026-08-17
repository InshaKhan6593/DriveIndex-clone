// MODEL-LEVEL GROUPING — the same data, at the grain their UI actually shows.
//
// ── THE PROBLEM ────────────────────────────────────────────────────────────────────────
// Our `car` row is one exact MODEL-YEAR: a 1987 Porsche 911 Carrera Coupe. Theirs carries
// `year` AND `yearEnd` (§2), so one row spans a RANGE — which is why their cards read
// "Porsche 911 GT2 RS (991)" rather than naming a single year.
//
// The consequence is measurable: 5,044 of our 36,046 cars get a signal (14.0%), against their
// 3,286 of 7,241 (45.4%). Not because our maths is weaker — because 30 sales of a BMW M3 split
// across 12 model-years is 12 thin cars, while the same 30 sales at model level is one car with
// a computable trend.
//
// ── WHY GROUP AT THE API, NOT IN STORAGE ───────────────────────────────────────────────
// Rolling up in the database would destroy precision we cannot recover: a 2018 GT2 RS and a
// 2019 are genuinely different markets, and repeat-sale detection needs the exact car. So the
// fine grain stays in `car`, and grouping happens on read. Same data, two views.
//
// The grouped view is NOT a valuation — it does not re-run the engine over pooled sales, which
// would silently mix model-years with different values. It aggregates what the engine already
// decided per model-year, and says how much agreement is behind the headline.
"use strict";

const path = require("path");
const { DatabaseSync } = require("node:sqlite");

function openDb() {
  return new DatabaseSync(path.join(__dirname, "..", "data", "driveindex.sqlite"));
}

// A model group's signal is the one carrying the most SALES, not the most model-years — a
// verdict backed by 200 sales should outrank three thin years that happen to agree.
function dominantSignal(rows) {
  const weight = new Map();
  for (const r of rows) {
    if (!r.signal || r.signal === "insufficient") continue;
    weight.set(r.signal, (weight.get(r.signal) || 0) + (r.sales_count || 0));
  }
  if (!weight.size) return { signal: "insufficient", agreement: 0 };
  const sorted = [...weight.entries()].sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((a, b) => a + b[1], 0);
  return { signal: sorted[0][0], agreement: sorted[0][1] / total };
}

/**
 * One row per (make, model_key) — the grain a model card shows.
 * @param {object} db
 * @param {{minSales?:number, make?:string, limit?:number}} opts
 */
function modelGroups(db, opts = {}) {
  const { minSales = 1, make = null, limit = 500 } = opts;

  const rows = db.prepare(`
    SELECT c.id, c.make, c.model, c.model_key, c.year, c.body_type,
           v.signal, v.current_value, v.sales_count, v.confidence, v.annual_return,
           v.collectibility_score, v.buy_hold_sell
    FROM car c LEFT JOIN car_valuation v ON v.car_id = c.id
    ${make ? "WHERE c.make = ?" : ""}
  `).all(...(make ? [make] : []));

  const groups = new Map();
  for (const r of rows) {
    const key = `${r.make}|${r.model_key}`;
    if (!groups.has(key)) groups.set(key, { make: r.make, model_key: r.model_key, rows: [] });
    groups.get(key).rows.push(r);
  }

  const out = [];
  for (const g of groups.values()) {
    const sales = g.rows.reduce((a, r) => a + (r.sales_count || 0), 0);
    if (sales < minSales) continue;

    const years = g.rows.map((r) => r.year).filter(Boolean).sort((a, b) => a - b);
    const valued = g.rows.filter((r) => r.current_value != null);
    // Value the group by its most-traded model-year rather than averaging across years, which
    // would blend a $30k early car with a $90k late one into a number describing neither.
    const anchor = valued.sort((a, b) => (b.sales_count || 0) - (a.sales_count || 0))[0] || null;
    const { signal, agreement } = dominantSignal(g.rows);

    out.push({
      make: g.make,
      model: (g.rows.find((r) => r.model) || {}).model || g.model_key,
      modelKey: g.model_key,
      yearStart: years[0] ?? null,
      yearEnd: years[years.length - 1] ?? null,
      modelYears: g.rows.length,
      salesCount: sales,
      signal,
      signalAgreement: Number(agreement.toFixed(2)),
      currentValue: anchor ? anchor.current_value : null,
      anchorYear: anchor ? anchor.year : null,
      buyHoldSell: anchor ? anchor.buy_hold_sell : null,
      bodyTypes: [...new Set(g.rows.map((r) => r.body_type).filter(Boolean))],
    });
  }

  out.sort((a, b) => b.salesCount - a.salesCount);
  return limit ? out.slice(0, limit) : out;
}

module.exports = { modelGroups, openDb, dominantSignal };

// CLI: node api/model-groups.js [make]
if (require.main === module) {
  const db = openDb();
  const make = process.argv[2] || null;
  const groups = modelGroups(db, { make, minSales: 1, limit: null });

  const rated = groups.filter((g) => g.signal !== "insufficient").length;
  const carRows = db.prepare("SELECT COUNT(*) c FROM car").get().c;
  const ratedCars = db.prepare("SELECT COUNT(*) c FROM car_valuation WHERE signal <> 'insufficient'").get().c;

  console.log(`model-year rows : ${carRows}   rated ${ratedCars} (${((ratedCars / carRows) * 100).toFixed(1)}%)`);
  console.log(`MODEL groups    : ${groups.length}   rated ${rated} (${((rated / groups.length) * 100).toFixed(1)}%)`);
  console.log(`DriveIndex      : 7,241 rows, rated 3,286 (45.4%)\n`);

  console.log("top model cards:");
  for (const g of groups.slice(0, 18)) {
    const span = g.yearStart === g.yearEnd ? `${g.yearStart}` : `${g.yearStart}-${g.yearEnd}`;
    console.log(
      `  ${String(g.make + " " + g.model).slice(0, 30).padEnd(31)} ${span.padEnd(10)} ` +
      `${String(g.salesCount).padStart(5)} sales  ${String(g.signal).padEnd(13)} ` +
      `agree=${g.signalAgreement.toFixed(2)}  ${g.currentValue ? "$" + Number(g.currentValue).toLocaleString() : "-"}`
    );
  }
}
