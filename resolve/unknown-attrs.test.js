// UNKNOWN vs ASSERTED attributes in car identity.
//
// Every case here comes from a real pair found in the live catalogue by
// validation/null-attribute-splits.js. The rule under test:
//
//   INTRINSIC (body_type, generation, displacement) — every car has one, so a blank means
//       UNKNOWN and must act as a wildcard. "1965 Ford Mustang" and "1965 Ford Mustang Coupe"
//       are one car described twice.
//   ASSERTED (modification) — a blank claims STOCK. A race-prepped M3 and a stock M3 are
//       different assets and must stay apart.
//
// Both directions matter equally: failing to merge fragments one car's price history, and
// over-merging averages two different assets into a curve describing neither.
//
// Run: node resolve/unknown-attrs.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { resolveCarV2 } = require("./resolve-car-v2");

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(fs.readFileSync(path.join(__dirname, "..", "db", "schema.sql"), "utf8"));
  return db;
}

// Resolve a title through the real pipeline entry point.
const put = (db, title, url = "https://bringatrailer.com/listing/x") =>
  resolveCarV2(db, { title, url, source: "bat", source_lot_id: String(Math.random()).slice(2) });

const carRows = (db) => db.prepare("SELECT * FROM car").all();

console.log("\nINTRINSIC ATTRIBUTES — a blank is UNKNOWN, so it must attach");

t("stated body style then unstated => ONE car", () => {
  const db = freshDb();
  const a = put(db, "1965 Ford Mustang Coupe");
  const b = put(db, "1965 Ford Mustang");
  assert.strictEqual(carRows(db).length, 1, `expected 1 car, got ${carRows(db).length}`);
  assert.strictEqual(a.carId, b.carId, "second listing created a separate car");
});

t("unstated first, then stated => still ONE car, and the row LEARNS the body style", () => {
  const db = freshDb();
  const a = put(db, "1965 Ford Mustang");
  const b = put(db, "1965 Ford Mustang Coupe");
  assert.strictEqual(carRows(db).length, 1, `expected 1 car, got ${carRows(db).length}`);
  assert.strictEqual(a.carId, b.carId);
  assert.strictEqual(carRows(db)[0].body_type, "Coupe", "the catalogue should keep the better description");
});

t("unstated displacement attaches to the stated one", () => {
  const db = freshDb();
  const a = put(db, "1977 Mercedes-Benz 450SEL 6.9");
  const b = put(db, "1977 Mercedes-Benz 450SEL");
  assert.strictEqual(carRows(db).length, 1, `expected 1 car, got ${carRows(db).length}`);
  assert.strictEqual(a.carId, b.carId);
});

console.log("\nASSERTED ATTRIBUTES — a blank means STOCK, so it must NOT attach");

t("a race car does NOT merge into the stock car", () => {
  const db = freshDb();
  put(db, "1995 BMW M3 Coupe");
  put(db, "1995 BMW M3 Coupe Race Car");
  const rows = carRows(db);
  assert.strictEqual(rows.length, 2, `expected 2 cars, got ${rows.length}`);
  assert.ok(rows.some((r) => r.modification), "one row should carry a modification");
});

t("an engine swap does NOT merge into the stock car", () => {
  const db = freshDb();
  put(db, "1989 BMW 325i Coupe");
  put(db, "1989 BMW 325i Coupe Engine Swap");
  assert.strictEqual(carRows(db).length, 2, `expected 2 cars, got ${carRows(db).length}`);
});

console.log("\nGENUINE DIFFERENCES STILL SEPARATE");

t("different body styles remain different cars", () => {
  const db = freshDb();
  put(db, "1987 Porsche 911 Carrera Coupe");
  put(db, "1987 Porsche 911 Carrera Cabriolet");
  assert.strictEqual(carRows(db).length, 2, `expected 2 cars, got ${carRows(db).length}`);
});

t("different model years remain different cars", () => {
  const db = freshDb();
  put(db, "1987 Porsche 911 Carrera Coupe");
  put(db, "1988 Porsche 911 Carrera Coupe");
  assert.strictEqual(carRows(db).length, 2);
});

console.log("\nWHEN IT CANNOT KNOW, IT ASKS");

t("unstated body style with TWO compatible cars => review, not a guess", () => {
  const db = freshDb();
  put(db, "1920 Ford Model T Convertible");
  put(db, "1920 Ford Model T Pickup");
  assert.strictEqual(carRows(db).length, 2, "setup should have produced two cars");

  const r = put(db, "1920 Ford Model T");
  assert.strictEqual(r.status ?? r.decision, r.status ? "queued" : "ambiguous",
    `expected a review verdict, got ${JSON.stringify(r).slice(0, 120)}`);
  assert.strictEqual(carRows(db).length, 2, "an ambiguous listing must not mint a third car");
});

t("...and the same holds for displacement", () => {
  const db = freshDb();
  put(db, "1964 Jaguar XKE 3.8 Coupe");
  put(db, "1964 Jaguar XKE 4.2 Coupe");
  const before = carRows(db).length;
  assert.strictEqual(before, 2, "setup should have produced two cars");
  put(db, "1964 Jaguar XKE Coupe");
  assert.strictEqual(carRows(db).length, 2, "must not create a third row when it cannot tell");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
