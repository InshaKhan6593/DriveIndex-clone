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
const { judgeAsk, dealScore, plausibleMileage } = require("../engine/ranking");

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

// TRENDING — market health plus the leaderboards.
//
// Ordered by `trend_score`, never by `annual_return`. Ranking on the raw return puts artifacts
// on top: measured before this existed, the top 8 were all +130%..+198%/yr fits over 3-6 sales,
// against a real-world ceiling nearer +30%. trend_score is the conservative bound shrunk by
// degrees of freedom (engine/ranking.js) — cars rise as evidence accumulates rather than by
// clearing a hardcoded sales cutoff. annual_return is still what gets DISPLAYED, because that
// is the number a user understands; it just isn't what decides the order.
app.get("/api/trending", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 12, 50);

  const health = db.prepare(
    `SELECT signal, COUNT(*) n FROM car_valuation WHERE signal IS NOT NULL GROUP BY signal`
  ).all().reduce((acc, r) => ({ ...acc, [r.signal]: r.n }), {});

  const board = (dir) => db.prepare(
    `SELECT c.id, c.year, c.make, c.model, c.body_type,
            v.current_value, v.annual_return, v.trend_score, v.sales_count, v.confidence, v.signal,
            (SELECT COUNT(*) FROM listing l WHERE l.car_id = c.id AND l.is_active = 1) AS listings_count,
            (SELECT s.image_url FROM sale s WHERE s.car_id = c.id AND s.image_url IS NOT NULL
               ORDER BY s.sold_at DESC LIMIT 1) AS image_url
     FROM car_valuation v JOIN car c ON c.id = v.car_id
     WHERE v.trend_score IS NOT NULL AND v.annual_return IS NOT NULL AND v.current_value >= 5000
     ORDER BY v.trend_score ${dir === "up" ? "DESC" : "ASC"}
     LIMIT ?`
  ).all(limit);

  const segments = db.prepare(
    `SELECT segment, COUNT(*) n, AVG(annual_return) avgReturn, AVG(current_value) avgValue
     FROM car_valuation WHERE segment IS NOT NULL AND annual_return IS NOT NULL
     GROUP BY segment ORDER BY n DESC`
  ).all();

  const bottomed = db.prepare(
    `SELECT c.id, c.year, c.make, c.model, v.current_value, v.annual_return, v.sales_count,
            (SELECT s.image_url FROM sale s WHERE s.car_id = c.id AND s.image_url IS NOT NULL
               ORDER BY s.sold_at DESC LIMIT 1) AS image_url
     FROM car_valuation v JOIN car c ON c.id = v.car_id
     WHERE v.signal = 'bottomed' AND v.current_value >= 5000
     ORDER BY v.trend_score DESC LIMIT ?`
  ).all(limit);

  res.json({
    health,
    gainers: board("up"),
    decliners: board("down"),
    segments: segments.map((s) => ({ segment: s.segment, count: s.n, avgReturn: s.avgReturn, avgValue: Math.round(s.avgValue) })),
    bottomed,
  });
});

// MARKET DEAL RADAR — live asks priced under our computed value.
//
// Every candidate is checked by judgeAsk() against the car's OWN observed sale prices, not a
// fixed maximum-discount rule. Without that check the naive query returned 364 "deals" whose
// top entries were all project cars — e.g. a 1959 Jaguar XK 150 asking $21,500 against a
// $112,000 value derived from a single sale, listing 0 miles. An ask below everything the model
// has ever actually sold for is a different car, not a bargain.
app.get("/api/deals", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 40, 100);

  const candidates = db.prepare(
    `SELECT l.id AS listing_id, l.price, l.mileage, l.source, l.url, l.first_seen_at,
            c.id AS car_id, c.year, c.make, c.model,
            v.current_value, v.annual_return, v.signal, v.confidence, v.sales_count,
            (SELECT s.image_url FROM sale s WHERE s.car_id = c.id AND s.image_url IS NOT NULL
               ORDER BY s.sold_at DESC LIMIT 1) AS image_url
     FROM listing l
     JOIN car c ON c.id = l.car_id
     JOIN car_valuation v ON v.car_id = c.id
     WHERE l.is_active = 1 AND l.price > 0 AND v.current_value > 0 AND l.price < v.current_value`
  ).all();

  const salePricesFor = db.prepare("SELECT price FROM sale WHERE car_id = ? AND status = 'sold'");
  const deals = [];
  let rejected = 0;
  for (const cand of candidates) {
    const salePrices = salePricesFor.all(cand.car_id).map((r) => r.price);
    const verdict = judgeAsk({ price: cand.price }, { currentValue: cand.current_value, salePrices });
    if (!verdict.isDeal) { rejected++; continue; }
    deals.push({
      ...cand,
      mileage: plausibleMileage(cand.mileage, cand.year),
      discount: verdict.discount,
      score: dealScore(verdict.discount, cand.confidence),
    });
  }
  // Sorted by believability, not by raw discount — see dealScore() for why.
  deals.sort((a, b) => b.score - a.score);

  res.json({
    total: deals.length,
    rejectedAsUnverifiable: rejected,
    deals: deals.slice(0, limit),
  });
});

// COMPARE — up to 4 cars side by side. Pure projection over existing valuations.
app.get("/api/compare", (req, res) => {
  const ids = String(req.query.ids || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 4);
  if (!ids.length) return res.json({ cars: [] });

  const cars = ids.map((id) => {
    const row = db.prepare(
      `SELECT c.id, c.year, c.make, c.model, c.body_type, c.generation,
              v.current_value, v.median_price, v.signal, v.confidence, v.annual_return,
              v.forecast_1y, v.forecast_3y, v.forecast_5y, v.collectibility_score,
              v.collectibility_reasons, v.liquidity_verdict, v.months_of_supply,
              v.sales_count, v.avg_mileage, v.buy_hold_sell, v.buy_hold_sell_copy,
              v.best_months, v.worst_months, v.segment,
              (SELECT COUNT(*) FROM listing l WHERE l.car_id = c.id AND l.is_active = 1) AS listings_count,
              (SELECT s.image_url FROM sale s WHERE s.car_id = c.id AND s.image_url IS NOT NULL
                 ORDER BY s.sold_at DESC LIMIT 1) AS image_url
       FROM car c LEFT JOIN car_valuation v ON v.car_id = c.id WHERE c.id = ?`
    ).get(id);
    if (!row) return null;
    const sales = db.prepare(
      "SELECT sold_at, price, mileage FROM sale WHERE car_id = ? AND status = 'sold' ORDER BY sold_at"
    ).all(id);
    return {
      ...row,
      collectibility_reasons: JSON.parse(row.collectibility_reasons ?? "[]"),
      best_months: JSON.parse(row.best_months ?? "[]"),
      worst_months: JSON.parse(row.worst_months ?? "[]"),
      sales,
    };
  }).filter(Boolean);

  res.json({ cars });
});

// Typeahead for the compare picker.
app.get("/api/search", (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 2) return res.json({ results: [] });
  const rows = db.prepare(
    `SELECT c.id, c.year, c.make, c.model, v.current_value, v.sales_count
     FROM car c JOIN car_valuation v ON v.car_id = c.id
     WHERE (lower(c.make) || ' ' || lower(c.model)) LIKE lower(?)
       AND v.current_value IS NOT NULL
     ORDER BY v.sales_count DESC LIMIT 12`
  ).all(`%${q}%`);
  res.json({ results: rows });
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
