// PIPELINE PROOF — answers, on real scraped records, the four questions that matter:
//
//   Q1  A new sale arrives for a car we ALREADY have -> does it ATTACH, or wrongly create a
//       second car and split the price history?
//   Q2  The SAME car turns up from a SECOND source -> is it deduped, and does the right
//       source survive?
//   Q3  A title is close to an existing car but not clearly the same -> do we refuse to
//       guess and send it to a human?
//   Q4  A genuinely new car -> is it created without bothering anyone?
//
// Every base record here is REAL (samples/scraped/*.json). Where a counterpart is needed
// (a second source, a second sale) it is constructed FROM that real record and labelled
// CONSTRUCTED — the corpus is BaT-dominated and does not yet contain a natural same-lot
// pair across two houses.
//
// Run: node ingest/pipeline-proof.js

const fs = require("fs");
const path = require("path");
const { openDb } = require("../db/client");
const { resolveCarV2, compareModelKeys, parseTitle } = require("../resolve/resolve-car-v2");
const { ingestRecord } = require("./ingest");
const { normalizeVin } = require("../dedup/dedup");

const DB_FILE = path.join(__dirname, "..", "data", "proof.sqlite");
try { fs.unlinkSync(DB_FILE); } catch {}
process.env.DRIVEINDEX_DB = DB_FILE;

// Use a scratch DB so this never touches the real one.
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA foreign_keys = ON;");
db.exec(fs.readFileSync(path.join(__dirname, "..", "db", "schema.sql"), "utf8"));

const DIR = path.join(__dirname, "..", "samples", "scraped");
const all = [];
require("./load-scraped").appendScrapedRecords(all, DIR);

const real = all.filter((r) => r.title && r.price > 0 && r.sold_at && r.vin_raw && normalizeVin(r.vin_raw)?.length === 17);
const base = real[0];

const line = (s) => console.log("\n" + "=".repeat(72) + "\n" + s + "\n" + "=".repeat(72));
const stats = () => ({ cars: db.prepare("SELECT COUNT(*) n FROM car").get().n,
                       sales: db.prepare("SELECT COUNT(*) n FROM sale").get().n,
                       queue: db.prepare("SELECT COUNT(*) n FROM car_resolution_queue").get().n });
let results = [];
function verdict(q, expected, actual) {
  const ok = expected === actual;
  results.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${q}\n        expected: ${expected}\n        actual:   ${actual}`);
}

line("Q1 — a SECOND SALE of a car we already have");
console.log(`REAL base record: ${base.title}\n  ${base.source} | $${base.price} | VIN ${base.vin_raw}`);
let s = { inserted: [], queued: [], duplicatesDropped: [], skippedNoPrice: 0, attachedToExistingCar: 0 };
ingestRecord(db, base, s);
const afterFirst = stats();
console.log(`\nafter ingesting it: cars=${afterFirst.cars} sales=${afterFirst.sales}`);

// CONSTRUCTED: the same MODEL sold again 14 months later — different physical car
// (different VIN), different lot, higher mileage. This is the everyday case: a new sale of
// a model already in the catalogue.
const secondSale = {
  ...base,
  // Constructed lot ids must be NUMERIC for a BaT record: ingest now rejects slug-shaped BaT
  // lot ids as a provenance signal (the API only ever issues numeric listing ids, so a slug
  // means the record came from the DOM harvest that fabricated title/URL pairings).
  source_lot_id: `9${base.source_lot_id}002`,
  url: base.url + "?second",
  vin_raw: "WP0ZZZ99ZTS999999",
  price: Math.round(base.price * 1.08),
  mileage: (base.mileage ?? 5000) + 4200,
  sold_at: new Date(new Date(base.sold_at).getTime() + 430 * 86400000).toISOString(),
};
s = { inserted: [], queued: [], duplicatesDropped: [], skippedNoPrice: 0, attachedToExistingCar: 0 };
ingestRecord(db, secondSale, s);
const afterSecond = stats();
console.log(`after a 2nd sale of the SAME model: cars=${afterSecond.cars} sales=${afterSecond.sales}`);
verdict("no new car row created (history stays on one car)", afterFirst.cars, afterSecond.cars);
verdict("the sale WAS recorded", afterFirst.sales + 1, afterSecond.sales);

line("Q2 — the SAME lot appears on a SECOND source");
// CONSTRUCTED: an aggregator republishes the base sale, price re-quoted ~4% lower
// (hammer vs all-in), same VIN, same day.
const republish = {
  ...base,
  source: "classic",
  source_lot_id: "CONSTRUCTED-classic-1",
  url: "https://www.classic.com/veh/constructed",
  price: Math.round(base.price * 0.96),
};
const before = stats();
s = { inserted: [], queued: [], duplicatesDropped: [], skippedNoPrice: 0, attachedToExistingCar: 0 };
ingestRecord(db, republish, s);
const after = stats();
verdict("aggregator republish did NOT add a sale", before.sales, after.sales);
verdict("it was recorded as a dropped duplicate", 1, s.duplicatesDropped.length);
if (s.duplicatesDropped[0]) console.log(`        kept "${s.duplicatesDropped[0].keptSource}", dropped "${s.duplicatesDropped[0].droppedSource}" (score ${s.duplicatesDropped[0].score.toFixed(2)})`);

line("Q3 — AMBIGUOUS: close to an existing car, but not clearly the same");
// NOTE: the original case here was "911 turbo" vs "3.8l 911 turbo", which USED to be
// ambiguous. It no longer is — engine displacement was promoted to its own structured
// column, so those two are now deterministically different cars (911 Turbo 3.8L vs the
// undisplaced 911 Turbo) with no human involvement. That is the displacement fix working,
// and it removed a whole class of items from the review queue.
// What remains ambiguous is a high-overlap difference in tokens that are neither a known
// variant nor a structured attribute — a nickname, a coachbuilder, a package name we do
// not recognise.
console.log(`  displacement is now structured: "911 turbo" vs "3.8l 911 turbo" -> ${compareModelKeys("911 turbo", "3.8l 911 turbo")}`);

// A STRICT SUBSET IS NO LONGER AMBIGUOUS — deliberate change, and it shrank the queue.
// "fastback mustang" vs "eleanor fastback mustang" is a base model against a qualified
// variant of itself. The extra token QUALIFIES the car (Eleanor tribute, Dinan tune, Singer
// rebuild), so the two are decidably different assets and must not share a price curve.
// Sending that to a human was pure noise: every base model in the corpus queued against each
// of its own tuned siblings.
verdict("base vs qualified variant is decided, not queued", "different", compareModelKeys("fastback mustang", "eleanor fastback mustang"));
verdict("a real variant difference is NOT ambiguous", "different", compareModelKeys("911 gt3", "911 gt3 rs"));

// WHAT IS STILL GENUINELY AMBIGUOUS: two COMPETING unrecognised qualifiers on the same base.
// Neither key is a subset of the other, they share the model designator, and neither
// differing token is a known variant — so there is no evidence to decide on, and a human
// should. This is the case the review queue exists for.
verdict("competing unknown qualifiers stay ambiguous", "ambiguous", compareModelKeys("eleanor fastback mustang", "bullitt fastback mustang"));

// end-to-end: ingest one, then the ambiguous sibling, and confirm it lands in the queue
const q0 = stats().queue;
const aTitle = "1967 Ford Mustang Fastback Eleanor";
const bTitle = "1967 Ford Mustang Fastback Bullitt";
s = { inserted: [], queued: [], duplicatesDropped: [], skippedNoPrice: 0, attachedToExistingCar: 0 };
ingestRecord(db, { ...base, title: aTitle, source_lot_id: "900000001", vin_raw: "WP0AA2991VS111111", url: "https://x/a" }, s);
ingestRecord(db, { ...base, title: bTitle, source_lot_id: "900000002", vin_raw: "WP0AA2991VS222222", url: "https://x/b", sold_at: new Date(new Date(base.sold_at).getTime() + 90 * 86400000).toISOString() }, s);
const q1 = stats().queue;
verdict("the ambiguous sibling went to the review queue", q0 + 1, q1);

line("Q4 — a genuinely NEW car");
const beforeNew = stats();
s = { inserted: [], queued: [], duplicatesDropped: [], skippedNoPrice: 0, attachedToExistingCar: 0 };
ingestRecord(db, { ...base, title: "1965 Shelby Cobra 427", source_lot_id: "900000003", vin_raw: "CSX3999XXXX000001", url: "https://x/new", sold_at: base.sold_at }, s);
const afterNew = stats();
verdict("created a new car without human involvement", beforeNew.cars + 1, afterNew.cars);
verdict("did not queue anything", beforeNew.queue, afterNew.queue);

line("SUMMARY");
const passed = results.filter(Boolean).length;
console.log(`${passed}/${results.length} checks passed`);
const final = stats();
console.log(`\nfinal scratch DB: ${final.cars} cars, ${final.sales} sales, ${final.queue} awaiting review`);
const multi = db.prepare("SELECT c.year, c.make, c.model, COUNT(s.id) n FROM car c JOIN sale s ON s.car_id=c.id GROUP BY c.id HAVING n>1").all();
console.log(`cars carrying more than one sale: ${multi.length}`);
for (const m of multi) console.log(`   ${m.year} ${m.make} ${m.model} -> ${m.n} sales`);
db.close();
if (passed !== results.length) process.exitCode = 1;
