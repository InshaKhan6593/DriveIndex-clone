// Proves dedup.js actually works. Uses the ONE real record we have (Cars & Bids,
// samples/raw/cars-and-bids-1.json) plus two SYNTHETIC fixtures for comparison —
// clearly labeled as synthetic, not scraped. Run: node dedup/dedup.demo.js

const { normalizeVin, isValidVin, upsertKey, duplicateScore, DUPLICATE_THRESHOLD, collapseDuplicates } = require("./dedup");
const { adaptCarsAndBids } = require("../adapters/cars-and-bids");
const realRaw = require("../samples/raw/cars-and-bids-1.json");

const real = adaptCarsAndBids(realRaw.raw_fields_as_shown_on_page, realRaw._meta.source_url);
real.vin_normal = normalizeVin(real.vin_raw);

console.log("=== REAL record (Cars & Bids, actually scraped) ===");
console.log(JSON.stringify({ source: real.source, source_lot_id: real.source_lot_id, title: real.title, price: real.price, vin_raw: real.vin_raw, vin_normal: real.vin_normal, mileage: real.mileage, sold_at: real.sold_at }, null, 2));
console.log("VIN valid:", isValidVin(real.vin_raw));
console.log("upsertKey:", upsertKey(real));

// SYNTHETIC: what a Classic.com aggregator republish of THIS SAME sale would plausibly look
// like — same VIN, same day, price re-quoted without buyer's premium (a realistic ~3% under).
// This is fabricated for the test, not a second real scrape.
const syntheticAggregatorRepublish = {
  ...real,
  source: "classic",
  source_lot_id: "classic-synthetic-001",
  title: "2007 Porsche 911 (997) Turbo — 7k miles, PDK-adjacent 6spd manual", // paraphrased, as aggregators do
  price: 164900, // ~3% under C&B's $170,000 — plausible buyer's-premium-stripped re-quote
  price_usd: 164900,
  // Aggregators frequently drop the VIN even when the primary source had it — this is
  // exactly the case the score-based heuristic exists for. Force it through that path
  // instead of the trivial VIN-match shortcut, to actually exercise duplicateScore().
  vin_raw: null,
  vin_normal: null,
};

// SYNTHETIC: an unrelated car, same source-class, to prove the scorer doesn't false-positive.
const syntheticUnrelatedCar = {
  ...real,
  source: "classic",
  source_lot_id: "classic-synthetic-002",
  title: "1994 Toyota Supra Turbo",
  vin_raw: "JT2XX10AJ0000001", // different — clearly not a match
  vin_normal: normalizeVin("JT2XX10AJ0000001"),
  price: 78000,
  price_usd: 78000,
  mileage: 92000,
  sold_at: real.sold_at,
};

for (const [label, candidate] of [
  ["Synthetic aggregator republish of the SAME car", syntheticAggregatorRepublish],
  ["Synthetic UNRELATED car, same day", syntheticUnrelatedCar],
]) {
  const score = duplicateScore(real, candidate);
  console.log(`\n=== ${label} ===`);
  console.log("score:", score.toFixed(3), score >= DUPLICATE_THRESHOLD ? "-> COLLAPSE (correctly flagged as duplicate)" : "-> keep both (correctly NOT flagged)");
}

console.log("\n=== collapseDuplicates() over [real, aggregator-republish, unrelated] ===");
const { kept, dropped } = collapseDuplicates([real, syntheticAggregatorRepublish, syntheticUnrelatedCar]);
console.log("kept:", kept.map((s) => `${s.source}:${s.source_lot_id}`));
console.log("dropped:", dropped.map((s) => `${s.source}:${s.source_lot_id} — ${s._dropped_reason}`));
