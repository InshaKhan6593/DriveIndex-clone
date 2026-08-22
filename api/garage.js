"use strict";

const { newId } = require("../db/client");
const { valueAtMileage, portfolioGain } = require("../engine/garage");
const { requireUser } = require("./garage-auth");

const STATUSES = new Set(["owned", "sold", "archived"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const USER_COLUMNS = [
  "nickname", "purchase_price", "purchase_date", "current_mileage", "fees", "vin", "color",
  "transmission", "options", "notes", "status", "sold_at", "sold_price",
];

function today() {
  return new Date().toISOString().slice(0, 10);
}

function cleanText(value, maxLength, field) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${field} must be text`);
  const text = value.trim();
  if (text.length > maxLength) throw new Error(`${field} is too long`);
  return text || null;
}

function cleanDate(value, field) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !DATE_RE.test(value)) throw new Error(`${field} must be YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} is not a real date`);
  }
  return value;
}

function cleanInteger(value, field) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`${field} must be a non-negative whole number`);
  }
  return n;
}

function cleanOptions(value) {
  if (value == null || value === "") return "[]";
  let options = value;
  if (typeof value === "string") {
    try { options = JSON.parse(value); } catch { throw new Error("options must be an array"); }
  }
  if (!Array.isArray(options) || options.some((item) => typeof item !== "string")) {
    throw new Error("options must be an array of text values");
  }
  return JSON.stringify(options.map((item) => item.trim()).filter(Boolean).slice(0, 100));
}

function normalizeVin(value) {
  const vin = cleanText(value, 40, "vin");
  return vin ? vin.toUpperCase() : null;
}

function ensureUser(db, userId) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO app_user (id, created_at, last_seen_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at`
  ).run(userId, now, now);
}

function vehicleRow(db, userId, vehicleId) {
  return db.prepare(
    `SELECT g.id, g.user_id, g.car_id, g.nickname, g.purchase_price, g.purchase_date,
            g.current_mileage, g.fees, g.vin, g.color, g.transmission, g.options, g.notes,
            g.status, g.sold_at, g.sold_price, g.created_at, g.updated_at,
            c.year, c.make, c.model, c.body_type, c.generation, c.image_url AS car_image,
            v.current_value, v.avg_mileage, v.collectibility_score, v.signal, v.confidence,
            v.annual_return, v.segment, v.buy_hold_sell, v.buy_hold_sell_copy,
            v.liquidity_verdict, v.liquidity_copy, v.months_of_supply,
            (SELECT s.image_url FROM sale s
             WHERE s.car_id = c.id AND s.image_url IS NOT NULL
             ORDER BY s.sold_at DESC LIMIT 1) AS sale_image
     FROM garage_vehicle g
     JOIN car c ON c.id = g.car_id
     LEFT JOIN car_valuation v ON v.car_id = c.id
     WHERE g.user_id = ? AND g.id = ?`
  ).get(userId, vehicleId);
}

function userRows(db, userId) {
  return db.prepare(
    `SELECT g.id, g.user_id, g.car_id, g.nickname, g.purchase_price, g.purchase_date,
            g.current_mileage, g.fees, g.vin, g.color, g.transmission, g.options, g.notes,
            g.status, g.sold_at, g.sold_price, g.created_at, g.updated_at,
            c.year, c.make, c.model, c.body_type, c.generation, c.image_url AS car_image,
            v.current_value, v.avg_mileage, v.collectibility_score, v.signal, v.confidence,
            v.annual_return, v.segment, v.buy_hold_sell, v.buy_hold_sell_copy,
            v.liquidity_verdict, v.liquidity_copy, v.months_of_supply,
            (SELECT s.image_url FROM sale s
             WHERE s.car_id = c.id AND s.image_url IS NOT NULL
             ORDER BY s.sold_at DESC LIMIT 1) AS sale_image
     FROM garage_vehicle g
     JOIN car c ON c.id = g.car_id
     LEFT JOIN car_valuation v ON v.car_id = c.id
     WHERE g.user_id = ? AND g.status != 'archived'
     ORDER BY CASE WHEN g.status = 'owned' THEN 0 ELSE 1 END, g.updated_at DESC`
  ).all(userId);
}

function priorSnapshot(db, vehicleId, asOf) {
  return db.prepare(
    `SELECT snapshot_date, market_value
     FROM garage_valuation_snapshot
     WHERE garage_vehicle_id = ? AND snapshot_date < ?
     ORDER BY snapshot_date DESC LIMIT 1`
  ).get(vehicleId, asOf);
}

function history(db, vehicleId) {
  return db.prepare(
    `SELECT snapshot_date AS date, market_value AS marketValue, mileage_used AS mileage
     FROM garage_valuation_snapshot
     WHERE garage_vehicle_id = ?
     ORDER BY snapshot_date DESC LIMIT 180`
  ).all(vehicleId).reverse();
}

function serializeVehicle(db, row, asOf = today()) {
  const repriced = valueAtMileage(row, row, row.current_mileage);
  const marketValue = repriced?.value ?? null;
  const gain = portfolioGain(marketValue, row.purchase_price, row.fees);
  const previous = priorSnapshot(db, row.id, asOf);
  const dayChange = marketValue != null && previous?.market_value != null
    ? marketValue - Number(previous.market_value)
    : null;
  const parsedOptions = (() => {
    try { return JSON.parse(row.options || "[]"); } catch { return []; }
  })();

  return {
    id: row.id,
    status: row.status,
    nickname: row.nickname,
    carId: row.car_id,
    car: {
      id: row.car_id,
      year: row.year,
      make: row.make,
      model: row.model,
      bodyType: row.body_type,
      generation: row.generation,
      imageUrl: row.car_image || row.sale_image || null,
    },
    purchasePrice: row.purchase_price,
    purchaseDate: row.purchase_date,
    currentMileage: row.current_mileage,
    mileageUsed: repriced?.mileageUsed ?? null,
    averageMileage: repriced?.avgMileage ?? null,
    fees: row.fees,
    totalCost: gain.cost,
    vin: row.vin,
    color: row.color,
    transmission: row.transmission,
    options: parsedOptions,
    notes: row.notes,
    soldAt: row.sold_at,
    soldPrice: row.sold_price,
    marketValue,
    baseValue: repriced?.baseValue ?? null,
    gainLoss: gain.gain,
    returnPct: gain.returnPct,
    dayChange,
    valuation: {
      signal: row.signal,
      confidence: row.confidence,
      annualReturn: row.annual_return,
      segment: row.segment,
      buyHoldSell: row.buy_hold_sell ? { label: row.buy_hold_sell, copy: row.buy_hold_sell_copy } : null,
      liquidity: row.liquidity_verdict ? {
        verdict: row.liquidity_verdict,
        copy: row.liquidity_copy,
        monthsOfSupply: row.months_of_supply,
      } : null,
    },
    lastSnapshotDate: previous?.snapshot_date ?? null,
    history: history(db, row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function upsertSnapshot(db, row, snapshotDate = today()) {
  const repriced = valueAtMileage(row, row, row.current_mileage);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO garage_valuation_snapshot
       (id, garage_vehicle_id, snapshot_date, market_value, mileage_used, base_value, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(garage_vehicle_id, snapshot_date) DO UPDATE SET
       market_value = excluded.market_value,
       mileage_used = excluded.mileage_used,
       base_value = excluded.base_value,
       computed_at = excluded.computed_at`
  ).run(
    newId(), row.id, snapshotDate, repriced?.value ?? null, repriced?.mileageUsed ?? null,
    repriced?.baseValue ?? null, now,
  );
}

function snapshotUser(db, userId, snapshotDate = today()) {
  const rows = userRows(db, userId).filter((row) => row.status === "owned");
  for (const row of rows) upsertSnapshot(db, row, snapshotDate);
  return rows.length;
}

function portfolioResponse(db, userId) {
  const asOf = today();
  const vehicles = userRows(db, userId).map((row) => serializeVehicle(db, row, asOf));
  const owned = vehicles.filter((vehicle) => vehicle.status === "owned");
  const priced = owned.filter((vehicle) => vehicle.marketValue != null);
  const withCost = owned.filter((vehicle) => vehicle.totalCost != null);
  const totalValue = priced.reduce((sum, vehicle) => sum + vehicle.marketValue, 0);
  const totalCost = withCost.reduce((sum, vehicle) => sum + vehicle.totalCost, 0);
  const totalGain = withCost.length && priced.length
    ? priced.reduce((sum, vehicle) => sum + (vehicle.gainLoss ?? 0), 0)
    : null;
  const dayChangeValues = priced.filter((vehicle) => vehicle.dayChange != null);
  const dayChange = dayChangeValues.length
    ? dayChangeValues.reduce((sum, vehicle) => sum + vehicle.dayChange, 0)
    : null;

  const grouped = new Map();
  for (const vehicle of priced) {
    const key = vehicle.valuation.segment || "Unclassified";
    const entry = grouped.get(key) || { label: key, value: 0, count: 0 };
    entry.value += vehicle.marketValue;
    entry.count += 1;
    grouped.set(key, entry);
  }

  return {
    asOf,
    summary: {
      ownedCount: owned.length,
      pricedCount: priced.length,
      totalValue,
      totalCost: withCost.length ? totalCost : null,
      unrealizedGain: totalGain,
      unrealizedReturn: totalCost > 0 && totalGain != null ? totalGain / totalCost : null,
      dayChange,
      dayChangePct: totalValue > 0 && dayChange != null ? dayChange / (totalValue - dayChange) : null,
      unpricedCount: owned.length - priced.length,
    },
    allocation: [...grouped.values()].sort((a, b) => b.value - a.value),
    vehicles,
  };
}

function body(req) {
  return req.body && typeof req.body === "object" ? req.body : {};
}

function normalizedVehicleInput(input, partial = false) {
  const output = {};
  const has = (key) => Object.prototype.hasOwnProperty.call(input, key);
  if (!partial || has("nickname")) output.nickname = cleanText(input.nickname, 100, "nickname");
  if (!partial || has("purchasePrice")) output.purchase_price = cleanInteger(input.purchasePrice, "purchasePrice");
  if (!partial || has("purchaseDate")) output.purchase_date = cleanDate(input.purchaseDate, "purchaseDate");
  if (!partial || has("currentMileage")) output.current_mileage = cleanInteger(input.currentMileage, "currentMileage");
  if (!partial || has("fees")) output.fees = cleanInteger(input.fees, "fees") ?? 0;
  if (!partial || has("vin")) output.vin = normalizeVin(input.vin);
  if (!partial || has("color")) output.color = cleanText(input.color, 100, "color");
  if (!partial || has("transmission")) output.transmission = cleanText(input.transmission, 100, "transmission");
  if (!partial || has("options")) output.options = cleanOptions(input.options);
  if (!partial || has("notes")) output.notes = cleanText(input.notes, 2000, "notes");
  if (has("status")) {
    if (!STATUSES.has(input.status)) throw new Error("status must be owned, sold, or archived");
    output.status = input.status;
  }
  if (has("soldAt")) output.sold_at = cleanDate(input.soldAt, "soldAt");
  if (has("soldPrice")) output.sold_price = cleanInteger(input.soldPrice, "soldPrice");
  return output;
}

function registerGarageRoutes(app, db) {
  app.get("/api/garage", (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    try {
      ensureUser(db, userId);
      res.json(portfolioResponse(db, userId));
    } catch (err) {
      res.status(503).json({ error: "garage storage is unavailable", detail: String(err.message || err) });
    }
  });

  app.post("/api/garage", (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    try {
      const input = body(req);
      const carId = cleanText(input.carId, 100, "carId");
      if (!carId) throw new Error("carId is required");
      const car = db.prepare("SELECT id FROM car WHERE id = ?").get(carId);
      if (!car) return res.status(404).json({ error: "car not found" });

      const values = normalizedVehicleInput(input);
      const id = newId();
      const now = new Date().toISOString();
      ensureUser(db, userId);
      db.prepare(
        `INSERT INTO garage_vehicle
          (id, user_id, car_id, nickname, purchase_price, purchase_date, current_mileage, fees,
           vin, color, transmission, options, notes, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'owned', ?, ?)`
      ).run(
        id, userId, carId, values.nickname, values.purchase_price, values.purchase_date,
        values.current_mileage, values.fees, values.vin, values.color, values.transmission,
        values.options, values.notes, now, now,
      );
      const row = vehicleRow(db, userId, id);
      upsertSnapshot(db, row);
      res.status(201).json({ vehicle: serializeVehicle(db, row) });
    } catch (err) {
      const message = String(err.message || err);
      res.status(/UNIQUE|unique/i.test(message) ? 409 : 400).json({ error: message });
    }
  });

  app.post("/api/garage/refresh", (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    try {
      ensureUser(db, userId);
      const count = snapshotUser(db, userId);
      res.json({ ok: true, snapshotted: count, ...portfolioResponse(db, userId) });
    } catch (err) {
      res.status(503).json({ error: "garage refresh failed", detail: String(err.message || err) });
    }
  });

  app.patch("/api/garage/:id", (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    try {
      const existing = vehicleRow(db, userId, req.params.id);
      if (!existing) return res.status(404).json({ error: "garage vehicle not found" });
      const values = normalizedVehicleInput(body(req), true);
      const updates = [];
      const params = [];
      for (const column of USER_COLUMNS) {
        if (!Object.prototype.hasOwnProperty.call(values, column)) continue;
        updates.push(`${column} = ?`);
        params.push(values[column]);
      }
      if (!updates.length) return res.status(400).json({ error: "no editable fields supplied" });
      if (values.status === "owned") {
        updates.push("sold_at = NULL", "sold_price = NULL");
      }
      updates.push("updated_at = ?");
      params.push(new Date().toISOString(), userId, req.params.id);
      db.prepare(`UPDATE garage_vehicle SET ${updates.join(", ")} WHERE user_id = ? AND id = ?`).run(...params);
      const row = vehicleRow(db, userId, req.params.id);
      if (row.status === "owned") upsertSnapshot(db, row);
      res.json({ vehicle: serializeVehicle(db, row) });
    } catch (err) {
      const message = String(err.message || err);
      res.status(/UNIQUE|unique/i.test(message) ? 409 : 400).json({ error: message });
    }
  });

  // Archive instead of deleting: a user can remove a car from the active garage without losing
  // its purchase record or historical valuation snapshots.
  app.delete("/api/garage/:id", (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const result = db.prepare(
      "UPDATE garage_vehicle SET status = 'archived', updated_at = ? WHERE user_id = ? AND id = ?"
    ).run(new Date().toISOString(), userId, req.params.id);
    if (!result.changes) return res.status(404).json({ error: "garage vehicle not found" });
    res.json({ ok: true });
  });
}

module.exports = { registerGarageRoutes, snapshotUser, portfolioResponse, valueAtMileage };
