"use strict";

// Refreshes one valuation point for every owned garage vehicle. In production this runs against
// Turso after the daily market diff is loaded, because garage data is user-owned and is not part
// of the pipeline's immutable serving snapshot.

const { openDb } = require("../db/client");
// Garage route helpers live outside api/ so Vercel does not deploy them as a standalone
// serverless function. Reuse the same shared implementation for the scheduled snapshot job.
const { snapshotUser } = require("../server/garage-routes");

const db = openDb();
const users = db.prepare("SELECT id FROM app_user ORDER BY id").all();
const date = new Date().toISOString().slice(0, 10);
let total = 0;

for (const user of users) {
  const count = snapshotUser(db, user.id, date);
  total += count;
  console.log(`${user.id}: ${count} owned vehicles snapshotted for ${date}`);
}

console.log(`garage snapshot complete: ${users.length} users, ${total} vehicles, ${date}`);
