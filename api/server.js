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
const { openDb } = require("../db/client");
const { serializeCarSummary, serializeCarDetail, TIERS } = require("./serialize");

const app = express();
const db = openDb();

function tierFrom(req) {
  const t = String(req.query.tier || "free").toLowerCase();
  return TIERS.includes(t) ? t : "free";
}

app.get("/api/cars", (req, res) => {
  const tier = tierFrom(req);
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const make = req.query.make;

  // Real server-side filtering + pagination. This is a DELIBERATE DIVERGENCE from
  // DriveIndex: ground truth §6 establishes that their /api/cars silently ignores every
  // param except make/limit/page because the dashboard ships all 6,805 cars inline in a
  // 2.98 MB RSC payload and filters client-side. That works at 7k cars and becomes
  // untenable past ~20k. Filtering belongs here.
  const where = make ? "WHERE lower(c.make) = lower(?)" : "";
  const params = make ? [make, limit, (page - 1) * limit] : [limit, (page - 1) * limit];

  const rows = db.prepare(
    `SELECT c.*, v.current_value, v.signal, v.confidence, v.segment
     FROM car c LEFT JOIN car_valuation v ON v.car_id = c.id
     ${where} ORDER BY c.year DESC LIMIT ? OFFSET ?`
  ).all(...params);

  const total = db.prepare(`SELECT COUNT(*) n FROM car c ${where}`).get(...(make ? [make] : [])).n;

  res.json({
    page, limit, total,
    cars: rows.map((r) => serializeCarSummary(r, r, tier)),
  });
});

app.get("/api/cars/:id", (req, res) => {
  const tier = tierFrom(req);
  const car = db.prepare("SELECT * FROM car WHERE id = ?").get(req.params.id);
  if (!car) return res.status(404).json({ error: "car not found" });

  const valuation = db.prepare("SELECT * FROM car_valuation WHERE car_id = ?").get(car.id);
  const sales = db.prepare("SELECT * FROM sale WHERE car_id = ?").all(car.id);

  res.json(serializeCarDetail(car, valuation, sales, tier));
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
