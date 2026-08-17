// Asserts the engine matches the verbatim ground-truth extraction, using worked examples
// computed by hand from the published constants. Run: node engine/reconciliation.test.js
//
// These are regression locks on the specific things that were WRONG before the ground-truth
// doc arrived — if a future refactor reintroduces any of them, this fails loudly.

const assert = require("node:assert");
const { baselineDepreciationForValue, PRICE_BANDS } = require("./depreciation");
const { collectibility, CURATED_OVERRIDES } = require("./collectibility");
const { buyHoldSell } = require("./buy-hold-sell");
const { classifySegment } = require("./segment");
const { confidence } = require("./confidence");
const { componentRates, blendedRate } = require("./forecast");
const { computeLiquidity } = require("./liquidity");
const { mileageAdjust } = require("./mileage");

let passed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; }
}

console.log("\n§4.4 price bands are DOLLARS, not miles");
check("a $25k car sits at the 10%/yr baseline", () => {
  assert.strictEqual(baselineDepreciationForValue(25000), 0.1);
});
check("a $75k car sits at ~0%/yr", () => {
  assert.strictEqual(baselineDepreciationForValue(75000), 0);
});
check("a $150k car has risen back to 7.5%/yr", () => {
  assert.strictEqual(baselineDepreciationForValue(150000), 0.075);
});
check("interpolates between breakpoints ($50k is halfway 0.10 -> 0.00)", () => {
  assert.ok(Math.abs(baselineDepreciationForValue(50000) - 0.05) < 1e-9);
});
check("clamped at both ends", () => {
  assert.strictEqual(baselineDepreciationForValue(1000), 0.1);
  assert.strictEqual(baselineDepreciationForValue(9e9), 0.09);
});

console.log("\n§4.6 collectibility — curated table wins and DISCARDS the computed score");
check("GT2 RS resolves to the curated 9, not a rules-computed 10", () => {
  const r = collectibility({ modelName: "911 GT2 RS Weissach", make: "Porsche", value: 807000, msrp: 337000, age: 8 });
  assert.strictEqual(r.score, 9);
  assert.strictEqual(r.overridden, true);
});
check("longest key wins: 'SLS AMG BLACK SERIES' (10) beats 'SLS AMG' (9)", () => {
  const r = collectibility({ modelName: "SLS AMG BLACK SERIES", make: "Mercedes-Benz", value: 500000, msrp: null, age: 12 });
  assert.strictEqual(r.score, 10);
});
check("backtest mode disables the override (lookahead-bias guard)", () => {
  const r = collectibility({ modelName: "911 GT2 RS", make: "Porsche", value: 807000, msrp: 337000, age: 8, useCuratedOverrides: false });
  assert.strictEqual(r.overridden, false);
});
check("tier order: NISMO is in BOTH track(+3) and perf(+2) lists — track must win", () => {
  // 370Z NISMO: not in curated table, low value, so the tier bonus is observable.
  const r = collectibility({ modelName: "370Z NISMO", make: "Nissan", value: 45000, msrp: null, age: 10, useCuratedOverrides: false });
  // base 5 + 3 (track) = 8; no other modifier applies at $45k / age 10
  assert.strictEqual(r.score, 8, `expected 8 (5 base +3 track), got ${r.score} — perf tier may be matching first`);
});
check("mass-market marque is penalised (-2)", () => {
  const r = collectibility({ modelName: "CAYENNE", make: "Porsche", value: 45000, msrp: null, age: 10, useCuratedOverrides: false });
  // 5 base -2 mass +1 collector brand = 4
  assert.strictEqual(r.score, 4);
});

console.log("\n§4.10 buy/hold/sell — verbatim labels, numeric confidence gate");
check("bottomed + conf>0.6 => 'Buy Now'", () => {
  assert.strictEqual(buyHoldSell("bottomed", 0.61, 0).label, "Buy Now");
});
check("bottomed + conf exactly 0.6 => 'Likely Entry' (strict >)", () => {
  assert.strictEqual(buyHoldSell("bottomed", 0.6, 0).label, "Likely Entry");
});
check("appreciating + return>8% => 'Buy Now (Rising Fast)'", () => {
  assert.strictEqual(buyHoldSell("appreciating", 0.9, 0.137).label, "Buy Now (Rising Fast)");
});
check("appreciating + return<=8% => 'Buy Soon'", () => {
  assert.strictEqual(buyHoldSell("appreciating", 0.9, 0.05).label, "Buy Soon");
});
check("depreciating => 'Wait' (never a sell instruction — buyer-side vocabulary)", () => {
  assert.strictEqual(buyHoldSell("depreciating", 0.9, -0.1).label, "Wait");
});
check("stable => 'Fair Entry'", () => {
  assert.strictEqual(buyHoldSell("stable", 0.8, 0).label, "Fair Entry");
});
check("insufficient => 'Watch'", () => {
  assert.strictEqual(buyHoldSell("insufficient", 0, null).label, "Watch");
});

console.log("\n§4.11 segment classification");
check("Bugatti is hypercar regardless of value", () => {
  assert.strictEqual(classifySegment("Bugatti", 10000), "hypercar");
});
check("any car over $1.5M is hypercar", () => {
  assert.strictEqual(classifySegment("Toyota", 1600000), "hypercar");
});
check("Maserati is exotic (even though §4.6 docks it as depreciating)", () => {
  assert.strictEqual(classifySegment("Maserati", 50000), "exotic");
});
check("Porsche at $95k is perf", () => {
  assert.strictEqual(classifySegment("Porsche", 95000), "perf");
});
check("Honda at $20k is mainstream", () => {
  assert.strictEqual(classifySegment("Honda", 20000), "mainstream");
});

console.log("\n§4.3 confidence — honesty caps");
check("n=20, perfect fit, low vol => high", () => {
  assert.strictEqual(confidence(20, 0.9, 0.1).level, "high");
});
check("HONESTY CAP: high score but n<12 => downgraded to moderate", () => {
  const r = confidence(8, 0.9, 0.1);
  assert.ok(r.score >= 0.62, `score should be >=0.62, got ${r.score}`);
  assert.strictEqual(r.level, "moderate");
});
check("HONESTY CAP: high score but volatility>0.40 => moderate", () => {
  assert.strictEqual(confidence(20, 0.9, 0.5).level, "moderate");
});
check("HONESTY CAP: n<4 forces low regardless", () => {
  assert.strictEqual(confidence(3, 0.99, 0.01).level, "low");
});

console.log("\n§4.7 forecast — the two pieces that were missing");
check("age factor floor: 2yr-old collectible(9) floored at -0.03 not -0.10", () => {
  const r = componentRates({ collectibility: 9, age: 2, msrpRatio: 1.0, signal: "stable" });
  assert.strictEqual(r.ageFactor, -0.03);
});
check("age factor floor: 10yr-old collectible(9) raised to +0.02", () => {
  const r = componentRates({ collectibility: 9, age: 10, msrpRatio: 1.0, signal: "stable" });
  assert.strictEqual(r.ageFactor, 0.02);
});
check("no floor applied for low collectibility (<6)", () => {
  const r = componentRates({ collectibility: 4, age: 2, msrpRatio: 1.0, signal: "stable" });
  assert.strictEqual(r.ageFactor, -0.1);
});
check("falling-car brake: depreciating w/ trend -20% caps rate at 0.5*trend", () => {
  // age 10 (>5) so factor is 0.5; collectibility 9 would otherwise clamp the floor at -0.06
  const { rate } = blendedRate({ trendRate: -0.2, collectibility: 9, age: 10, msrpRatio: 1.0, signal: "depreciating", n: 30, rSquared: 0.8 });
  assert.ok(rate <= 0.5 * -0.2 + 1e-9, `expected rate <= -0.10, got ${rate}`);
});
check("falling-car brake does NOT fire above the -3% trend gate", () => {
  const { rate } = blendedRate({ trendRate: -0.02, collectibility: 9, age: 10, msrpRatio: 1.0, signal: "depreciating", n: 30, rSquared: 0.8 });
  assert.ok(rate > -0.06 - 1e-9, `collectibility clamp should hold at -0.06, got ${rate}`);
});

console.log("\n§4.8 liquidity");
const mkSales = (n, daysAgo = 30) => Array.from({ length: n }, (_, i) => ({ sold_at: new Date(Date.now() - (daysAgo + i) * 86400000).toISOString() }));
check("x<4 => THIN MARKET, metric suppressed", () => {
  const r = computeLiquidity(mkSales(3), 10);
  assert.strictEqual(r.verdict, "THIN MARKET");
  assert.strictEqual(r.monthsOfSupply, null);
});
check("listings<=1 => TIGHT SUPPLY", () => {
  assert.strictEqual(computeLiquidity(mkSales(10), 1).verdict, "TIGHT SUPPLY");
});
check("mos<6 => SELLER'S MARKET", () => {
  assert.strictEqual(computeLiquidity(mkSales(20), 3).verdict, "SELLER'S MARKET");
});
check("mos>18 => BUYER'S MARKET", () => {
  assert.strictEqual(computeLiquidity(mkSales(4), 30).verdict, "BUYER'S MARKET");
});

console.log("\n§4.5 mileage adjustment");
check("below-average mileage earns a premium", () => {
  assert.ok(mileageAdjust(100000, 5000, 20000, 8, 10) > 100000);
});
check("above-average mileage takes a discount", () => {
  assert.ok(mileageAdjust(100000, 60000, 20000, 8, 10) < 100000);
});
check("delivery-mileage (<=500) gets the extra 1.25x kicker", () => {
  const a = mileageAdjust(100000, 400, 20000, 9, 10);
  const b = mileageAdjust(100000, 900, 20000, 9, 10);
  assert.ok(a > b, `500mi car (${a}) should beat 900mi car (${b})`);
});
check("premium clamped at +45% for collectibility 9+", () => {
  assert.ok(mileageAdjust(100000, 1, 500000, 10, 40) <= 145000);
});
check("discount clamped at -30%", () => {
  assert.ok(mileageAdjust(100000, 900000, 5000, 10, 40) >= 70000);
});

console.log(`\n${passed} checks passed${process.exitCode ? " (with failures above)" : ""}\n`);
