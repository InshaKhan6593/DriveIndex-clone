// Minimal read API. The point of this file is the GATING ARCHITECTURE, not the routes —
// ground truth §5: gating happens at API serialisation, never in the UI. The server returns
// the full object SHAPE with paid fields nulled, so nothing sensitive reaches the browser
// to be CSS-hidden.
//
// Tier comes from ?tier= here purely so the shape is demonstrable without an auth stack.
// In production this MUST come from the session/subscription record — never from a
// client-supplied parameter.
//
// Usage: node api/server.js  then:
//   curl 'localhost:3000/api/cars'
//   curl 'localhost:3000/api/cars/<id>?tier=free'
//   curl 'localhost:3000/api/cars/<id>?tier=collector'

const express = require("express");
const cors = require("cors");
const { openDb } = require("../db/client");
const { serializeCarSummary, serializeCarDetail, TIERS } = require("./serialize");
const { mileageAdjust } = require("../engine/mileage");

const app = express();
app.use(cors());
const db = openDb();

const YEAR_BUCKETS = {
  pre70: "c.year < 1970",
  "70s": "c.year BETWEEN 1970 AND 1979",
  "80s": "c.year BETWEEN 1980 AND 1989",
  "90s": "c.year BETWEEN 1990 AND 1999",
  "00s": "c.year BETWEEN 2000 AND 2009",
  "10s": "c.year BETWEEN 2010 AND 2019",
  "20s": "c.year >= 2020",
};
const PRICE_BANDS = {
  under50k: "v.current_value < 50000",
  "50to100k": "v.current_value BETWEEN 50000 AND 100000",
  "100to250k": "v.current_value BETWEEN 100000 AND 250000",
  "250kplus": "v.current_value > 250000",
};
// Brand families the catalogue deliberately keeps as separate `make` values (they have
// genuinely different value curves — a Mercedes-AMG doesn't belong on the same price curve
// as a base Mercedes-Benz) but that a browsing user thinks of as one brand. Confirmed against
// the real data: this is the only such family in the catalogue — checked for any other make
// sharing a brand prefix, and everything else that matched (Austin/Austin-Healey,
// Pierce/Pierce-Arrow) is a genuinely separate historic marque, not a split of one brand.
const MAKE_GROUPS = {
  "Mercedes": ["Mercedes-Benz", "Mercedes-AMG", "Mercedes-Maybach"],
};

const SORTS = {
  popular: "v.sales_count DESC",
  "price-low": "v.current_value ASC",
  "price-high": "v.current_value DESC",
  "year-new": "c.year DESC",
  "year-old": "c.year ASC",
};

function tierFrom(req) {
  const t = String(req.query.tier || "free").toLowerCase();
  return TIERS.includes(t) ? t : "free";
}

app.get("/api/cars", (req, res) => {
  const tier = tierFrom(req);
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const { make, bodyType, year, price, sort, forSaleNow, q } = req.query;

  // Real server-side filtering + pagination. This is a DELIBERATE DIVERGENCE from
  // DriveIndex: ground truth §6 establishes that their /api/cars silently ignores every
  // param except make/limit/page because the dashboard ships all 6,805 cars inline in a
  // 2.98 MB RSC payload and filters client-side. That works at 7k cars and becomes
  // untenable past ~20k. Filtering belongs here.
  const clauses = [];
  const params = [];
  // Floor against pre-existing catalogue junk (parts, scale models — a handful of car rows
  // priced under $100 that predate the structural-reject patterns that would catch them
  // today). Not a fix for the underlying rows, just keeps them off the browse page.
  clauses.push("(v.current_value IS NULL OR v.current_value >= 2000)");
  if (make && MAKE_GROUPS[make]) {
    clauses.push(`lower(c.make) IN (${MAKE_GROUPS[make].map(() => "lower(?)").join(",")})`);
    params.push(...MAKE_GROUPS[make]);
  } else if (make) {
    clauses.push("lower(c.make) = lower(?)");
    params.push(make);
  }
  if (bodyType) { clauses.push("lower(c.body_type) = lower(?)"); params.push(bodyType); }
  if (q) { clauses.push("(lower(c.make) LIKE lower(?) OR lower(c.model) LIKE lower(?))"); params.push(`%${q}%`, `%${q}%`); }
  if (year && YEAR_BUCKETS[year]) clauses.push(YEAR_BUCKETS[year]);
  if (price && PRICE_BANDS[price]) clauses.push(PRICE_BANDS[price]);
  // forSaleNow is handled separately below — `listings_count` doesn't exist at this query
  // level yet (see note by `base`).

  // listings_count/fallback_image are SELECT-list aliases, not real columns of `car` or
  // `car_valuation` — SQLite (like standard SQL) can't see them from a WHERE clause at the
  // same query level. Computed in an inner subquery instead, filtered from the outer one,
  // where they're real columns of the derived table.
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const orderBy = SORTS[sort] || SORTS.popular;

  const base = `
    SELECT c.*, v.current_value, v.signal, v.confidence, v.segment, v.sales_count,
      (SELECT COUNT(*) FROM listing l WHERE l.car_id = c.id AND l.is_active = 1) AS listings_count,
      (SELECT s2.image_url FROM sale s2 WHERE s2.car_id = c.id AND s2.image_url IS NOT NULL
         ORDER BY s2.sold_at DESC LIMIT 1) AS fallback_image
    FROM car c LEFT JOIN car_valuation v ON v.car_id = c.id`;

  const forSaleClause = forSaleNow === "true" ? "WHERE t.listings_count > 0" : "";

  const rows = db.prepare(
    `SELECT * FROM (${base} ${where}) t
     ${forSaleClause}
     ORDER BY ${orderBy.replace(/^v\.|^c\./, "t.")}
     LIMIT ? OFFSET ?`
  ).all(...params, limit, (page - 1) * limit);

  const total = db.prepare(
    `SELECT COUNT(*) n FROM (${base} ${where}) t ${forSaleClause}`
  ).get(...params).n;

  res.json({
    page, limit, total,
    cars: rows.map((r) => ({ ...serializeCarSummary(r, r, tier), imageUrl: r.image_url || r.fallback_image || null })),
  });
});

app.get("/api/cars/:id", (req, res) => {
  const tier = tierFrom(req);
  const car = db.prepare("SELECT * FROM car WHERE id = ?").get(req.params.id);
  if (!car) return res.status(404).json({ error: "car not found" });

  const valuation = db.prepare("SELECT * FROM car_valuation WHERE car_id = ?").get(car.id);
  const sales = db.prepare("SELECT * FROM sale WHERE car_id = ?").all(car.id);
  const listings = db.prepare("SELECT * FROM listing WHERE car_id = ?").all(car.id);
  const fallbackImage = db.prepare(
    "SELECT image_url FROM sale WHERE car_id = ? AND image_url IS NOT NULL ORDER BY sold_at DESC LIMIT 1"
  ).get(car.id)?.image_url ?? null;

  // Related Markets — other model-years of the same nameplate, same shape DriveIndex uses
  // (adjacent-year tabs). Matched on model_key, not raw model text, so trim variations don't
  // fracture the sibling list.
  const relatedYears = db.prepare(
    `SELECT c.id, c.year FROM car c
     WHERE c.make = ? AND c.model_key = ? AND c.id != ?
     ORDER BY c.year`
  ).all(car.make, car.model_key, car.id);

  res.json({
    ...serializeCarDetail(car, valuation, sales, tier, listings, fallbackImage),
    relatedYears,
  });
});

// "What's it worth at your miles?" — re-prices the already-computed current value using the
// same mileageAdjust() curve the engine applies per-sale, rather than a fresh regression run.
// Real function, not a UI mockup: engine/mileage.js §[V] is reproduced verbatim from the
// DriveIndex client bundle.
app.get("/api/cars/:id/reprice", (req, res) => {
  const miles = Number(req.query.miles);
  if (!Number.isFinite(miles) || miles < 0) return res.status(400).json({ error: "miles must be a non-negative number" });

  const car = db.prepare("SELECT year FROM car WHERE id = ?").get(req.params.id);
  if (!car) return res.status(404).json({ error: "car not found" });

  const valuation = db.prepare("SELECT current_value, avg_mileage, collectibility_score FROM car_valuation WHERE car_id = ?").get(req.params.id);
  if (!valuation?.current_value) return res.status(404).json({ error: "no valuation on file for this car" });

  const age = new Date().getFullYear() - car.year;
  const value = mileageAdjust(valuation.current_value, miles, valuation.avg_mileage ?? miles, valuation.collectibility_score, age);
  res.json({ miles, value });
});

// Review queue — operational endpoint, not part of the DriveIndex surface. Exposes the
// unresolved-title backlog so a human can actually work it (§4.5's "never a silent guess"
// is only meaningful if someone can see the queue).
app.get("/api/admin/resolution-queue", (req, res) => {
  const rows = db.prepare("SELECT id, source, raw_title, extracted_year, extracted_make, status, created_at FROM car_resolution_queue WHERE status = 'pending' ORDER BY created_at DESC").all();
  res.json({ pending: rows.length, items: rows });
});

app.get("/api/stats/public", (req, res) => {
  const sales = db.prepare("SELECT COUNT(*) n FROM sale").get().n;
  const cars = db.prepare("SELECT COUNT(*) n FROM car").get().n;
  const sources = db.prepare("SELECT COUNT(DISTINCT source) n FROM sale").get().n;
  const totalValue = db.prepare("SELECT COALESCE(SUM(price_usd), 0) v FROM sale").get().v;
  const queued = db.prepare("SELECT COUNT(*) n FROM car_resolution_queue WHERE status='pending'").get().n;
  // Read these live, never hardcode — ground truth defect #4 is exactly this drifting.
  res.json({ sales, cars, sources, totalValue, pendingResolution: queued });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`API listening on http://localhost:${PORT}`));
}

module.exports = { app };
