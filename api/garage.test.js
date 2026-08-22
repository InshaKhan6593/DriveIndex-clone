"use strict";

// Small end-to-end regression test for the garage boundary: signed-session auth, persistence,
// mileage-aware value, update, refresh, and archive. It uses a throwaway SQLite file and does not
// touch the repository database.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");

process.env.DB_PATH = path.join(os.tmpdir(), `driveindex-garage-${crypto.randomUUID()}.sqlite`);
process.env.ACCESS_CODE = "garage-test-code";
process.env.SESSION_SECRET = "garage-test-secret";

const { openDb } = require("../db/client");
const db = openDb();
db.prepare("INSERT INTO car (id, year, make, model, model_key) VALUES (?, ?, ?, ?, ?)")
  .run("car-test", 2019, "Porsche", "911 GT3", "911 gt3");
db.prepare(
  `INSERT INTO car_valuation
   (car_id, computed_at, current_value, avg_mileage, collectibility_score, signal, segment)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
).run("car-test", new Date().toISOString(), 100000, 50000, 8, "stable", "modern");

const { app } = require("./server");
const userId = crypto.randomUUID();
const payload = `v1:${userId}`;
const signature = crypto.createHmac("sha256", process.env.SESSION_SECRET).update(payload).digest("hex");
const session = `${payload}.${signature}`;

function request(base, path, options = {}) {
  return fetch(`${base}${path}`, {
    ...options,
    headers: {
      "x-driveindex-session": session,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  assert.equal((await fetch(`${base}/api/garage`)).status, 401);

  let response = await request(base, "/api/garage", {
    method: "POST",
    body: JSON.stringify({
      carId: "car-test",
      nickname: "Blue GT3",
      purchasePrice: 90000,
      purchaseDate: "2025-01-15",
      currentMileage: 5000,
      fees: 2000,
    }),
  });
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.vehicle.nickname, "Blue GT3");
  assert.ok(created.vehicle.marketValue > 100000, "low mileage should receive a premium");
  assert.equal(created.vehicle.totalCost, 92000);

  response = await request(base, "/api/garage");
  assert.equal(response.status, 200);
  let portfolio = await response.json();
  assert.equal(portfolio.summary.ownedCount, 1);
  assert.equal(portfolio.vehicles.length, 1);
  assert.equal(portfolio.vehicles[0].history.length, 1);

  response = await request(base, `/api/garage/${created.vehicle.id}`, {
    method: "PATCH",
    body: JSON.stringify({ currentMileage: 60000, nickname: "High-mile GT3" }),
  });
  assert.equal(response.status, 200);
  const updated = await response.json();
  assert.equal(updated.vehicle.currentMileage, 60000);
  assert.equal(updated.vehicle.nickname, "High-mile GT3");

  response = await request(base, "/api/garage/refresh", { method: "POST", body: "{}" });
  assert.equal(response.status, 200);
  portfolio = await response.json();
  assert.equal(portfolio.summary.ownedCount, 1);

  response = await request(base, `/api/garage/${created.vehicle.id}`, { method: "DELETE" });
  assert.equal(response.status, 200);
  response = await request(base, "/api/garage");
  portfolio = await response.json();
  assert.equal(portfolio.summary.ownedCount, 0);
  assert.equal(portfolio.vehicles.length, 0);

  server.close();
  console.log("garage integration test passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
