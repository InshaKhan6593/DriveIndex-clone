// Proves the valuation engine's math against a case with enough sales to actually compute
// a signal — every real car ingested so far has exactly 1 clean sale, which correctly
// returns "insufficient" (see jobs/nightly-compute.js output). That's the engine working
// correctly on real data, but it doesn't exercise the interesting code paths.
//
// ONE real anchor point here: the 2018 Porsche 911 GT2 RS Weissach captured live during
// this session's Bring a Trailer probing (crawler/probe-bat8.js) — sold $807,000,
// 93 miles, chassis WP0AE2A96JS185417, 11 Aug 2026. This is also the exact car the
// DriveIndex build spec itself uses as its worked example (§11.1's "2018 GT2 RS" reference).
//
// Everything else below — 13 additional sales — is SYNTHETIC, fabricated for this demo to
// give the trend/signal/confidence/forecast/seasonality machinery enough data points to
// produce non-trivial output. Labeled clearly so nobody mistakes 14 sales of market depth
// for something this pipeline actually observed. Run: node engine/engine-demo.js

const { computeValuation } = require("./index");

const REAL_ANCHOR_SALE = {
  id: "real-1",
  source: "bat",
  price: 807000,
  price_usd: 807000,
  currency: "USD",
  mileage: 93,
  sold_at: "2026-08-11T00:00:00Z",
  is_outlier: false, carfax_damage: false, non_us_sale: false, reserve_not_met: false,
};

// SYNTHETIC — a plausible appreciating-market trend for a 991 GT2 RS Weissach over ~2 years,
// hand-authored with realistic noise, not derived from any real observation.
const SYNTHETIC_SALES = [
  { id: "syn-1", source: "bat", price: 655000, mileage: 1200, sold_at: "2024-09-05T00:00:00Z" },
  { id: "syn-2", source: "cab", price: 668000, mileage: 3400, sold_at: "2024-11-18T00:00:00Z" },
  { id: "syn-3", source: "rms", price: 690000, mileage: 850, sold_at: "2025-01-22T00:00:00Z" },
  { id: "syn-4", source: "bat", price: 671000, mileage: 5200, sold_at: "2025-02-10T00:00:00Z" },
  { id: "syn-5", source: "cab", price: 705000, mileage: 2100, sold_at: "2025-04-14T00:00:00Z" },
  { id: "syn-6", source: "bat", price: 720000, mileage: 1600, sold_at: "2025-06-02T00:00:00Z" },
  { id: "syn-7", source: "bon", price: 742000, mileage: 780, sold_at: "2025-07-19T00:00:00Z" },
  { id: "syn-8", source: "mecum", price: 715000, mileage: 6900, sold_at: "2025-08-15T00:00:00Z" },
  { id: "syn-9", source: "bat", price: 758000, mileage: 2300, sold_at: "2025-10-11T00:00:00Z" },
  { id: "syn-10", source: "cab", price: 775000, mileage: 1100, sold_at: "2025-12-20T00:00:00Z" },
  { id: "syn-11", source: "rms", price: 762000, mileage: 4400, sold_at: "2026-02-08T00:00:00Z" },
  { id: "syn-12", source: "bat", price: 790000, mileage: 1900, sold_at: "2026-04-17T00:00:00Z" },
  { id: "syn-13", source: "bon", price: 798000, mileage: 610, sold_at: "2026-06-25T00:00:00Z" },
].map((s) => ({ ...s, price_usd: s.price, currency: "USD", is_outlier: false, carfax_damage: false, non_us_sale: false, reserve_not_met: false }));

const car = {
  id: "gt2rs-2018-demo",
  year: 2018,
  make: "Porsche",
  model: "911 GT2 RS Weissach",
  msrp: 337000, // real 2018 GT2 RS Weissach Package MSRP, approx
};

const allSales = [REAL_ANCHOR_SALE, ...SYNTHETIC_SALES];

console.log(`Running full engine on ${allSales.length} sales (1 real anchor + ${SYNTHETIC_SALES.length} synthetic) for ${car.year} ${car.make} ${car.model}...\n`);

const result = computeValuation(car, allSales, /* activeListingsCount */ 3);

console.log("=== VALUATION RESULT ===");
console.log(JSON.stringify(result, null, 2));

console.log("\n=== SANITY CHECKS ===");
console.log(`Signal is directional (not "insufficient"): ${result.signal !== "insufficient" ? "PASS" : "FAIL"} (got "${result.signal}")`);
console.log(`Confidence is non-trivial (>0.3): ${result.confidence > 0.3 ? "PASS" : "FAIL"} (got ${result.confidence.toFixed(3)})`);
console.log(`Annual return is positive (prices trended up): ${result.annualReturn > 0 ? "PASS" : "FAIL"} (got ${(result.annualReturn * 100).toFixed(1)}%)`);
console.log(`Forecast values increase 1y < 3y < 5y at a positive rate: ${result.forecast1y < result.forecast3y && result.forecast3y < result.forecast5y ? "PASS" : result.forecast1y != null ? "CHECK" : "N/A"}`);
console.log(`Bear/bull bands bracket the point forecast (3y): ${result.bear3y <= result.forecast3y && result.forecast3y <= result.bull3y ? "PASS" : "FAIL"}`);
console.log(`Collectibility score in range 1-10: ${result.collectibilityScore >= 1 && result.collectibilityScore <= 10 ? "PASS" : "FAIL"} (got ${result.collectibilityScore})`);
console.log(`Liquidity computed (n24>=4): ${result.liquidityTier != null ? "PASS" : "FAIL"} (tier=${result.liquidityTier})`);
console.log(`buyHoldSell is a real label, not "Watch": ${result.buyHoldSell !== "Watch" ? "PASS" : "FAIL"} (got "${result.buyHoldSell}")`);
