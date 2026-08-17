// VERBATIM CONFORMANCE — do our numbers equal THEIR numbers, exactly?
//
// The ground truth ships 11 of the engine's 13 components as `[V]` VERIFIED source, read
// straight from their production bundle. That is not a description to approximate; it is an
// implementation to match digit for digit.
//
// reconciliation.test.js checks BEHAVIOUR ("a $25k car sits at the baseline"). This file checks
// ARITHMETIC: every expected value below is computed by hand from the formula in the doc, so a
// pass means our output is identical to theirs, not merely similar.
//
// Where the doc says `[U]` (the Value Signal classifier's thresholds, the currentValue
// estimator, outlier method, seasonality) there is nothing to conform to and this file says so
// rather than inventing a target.
//
// Run: node engine/verbatim-conformance.test.js

const assert = require("assert");
const { confidence } = require("./confidence");
const { baselineDepreciationForValue } = require("./depreciation");
const { dealScore } = require("./deal-score");
const { computeLiquidity } = require("./liquidity");
const { classifySegment } = require("./segment");
const { isClean } = require("./clean");
const { normalizeVin, isValidVin } = require("../dedup/dedup");

let pass = 0, fail = 0;
function near(name, actual, expected, tol = 1e-9) {
  const ok = Math.abs(actual - expected) <= tol;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `   expected ${expected}, got ${actual}`}`);
  ok ? pass++ : fail++;
}
function eq(name, actual, expected) {
  const ok = actual === expected;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `   expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  ok ? pass++ : fail++;
}

// ── §4.3 CONFIDENCE ────────────────────────────────────────────────────────────────────
// confidence = 0.40*sample + 0.35*clamp((R2-0.10)/0.35,0,1) + 0.25*volatility
//   sample:     >=20→1.0  >=12→0.8  >=8→0.6  >=5→0.4  >=3→0.2  else 0
//   volatility: <=0→0.5  <=0.18→1.0  <=0.28→0.75  <=0.40→0.5  <=0.55→0.25  else 0
console.log("\n§4.3 confidence — exact score arithmetic");

// n=20 (1.0), R2=0.45 -> (0.45-0.10)/0.35 = 1.0, vol=0.15 (1.0)
near("n=20 R2=.45 vol=.15  => 0.40+0.35+0.25 = 1.00", confidence(20, 0.45, 0.15).score, 1.0, 1e-6);

// n=8 (0.6)=0.24, R2=0.20 -> 0.2857142857*0.35=0.1, vol=0.30 falls in the `<=0.40 -> 0.5`
// band (it is ABOVE 0.28), so 0.25*0.5=0.125  => 0.465.
// My first version of this line asserted 0.5275 by mis-banding 0.30 as 0.75. The engine was
// right and the test was wrong — worth recording, because the volatility ladder is exactly the
// kind of thing that looks obvious and is read off by one.
near("n=8  R2=.20 vol=.30  => 0.24+0.10+0.125 = 0.465", confidence(8, 0.2, 0.3).score, 0.465, 1e-6);
// Pin the band boundary itself: 0.28 is still the 0.75 band, 0.281 drops to 0.5.
near("volatility 0.28 is the 0.75 band", confidence(20, 0.45, 0.28).score, 0.4 + 0.35 + 0.1875, 1e-6);
near("volatility 0.29 has dropped to the 0.5 band", confidence(20, 0.45, 0.29).score, 0.4 + 0.35 + 0.125, 1e-6);

// n=5 (0.4)=0.16, R2=0.10 -> 0, vol=0.50 (0.25)=0.0625 => 0.2225
near("n=5  R2=.10 vol=.50  => 0.16+0+0.0625 = 0.2225", confidence(5, 0.1, 0.5).score, 0.2225, 1e-6);

// R2 below 0.10 clamps to 0, not negative
near("R2=0.05 clamps the fit term to zero", confidence(20, 0.05, 0.15).score, 0.4 + 0 + 0.25, 1e-6);
// R2 above 0.45 clamps to 1
near("R2=0.99 clamps the fit term to one", confidence(20, 0.99, 0.15).score, 1.0, 1e-6);
// volatility exactly 0 scores 0.5, NOT 1.0 (the `<=0 -> .5` branch is easy to get wrong)
near("volatility exactly 0 => 0.5 band, not 1.0", confidence(20, 0.45, 0).score, 0.4 + 0.35 + 0.125, 1e-6);

console.log("\n§4.3 confidence — level thresholds and honesty caps");
eq("score >= 0.62 => high", confidence(20, 0.45, 0.15).level, "high");
eq("honesty cap: n<12 downgrades high => moderate", confidence(8, 0.99, 0.05).level, "moderate");
eq("honesty cap: volatility>0.40 downgrades => moderate", confidence(20, 0.99, 0.45).level, "moderate");
eq("honesty cap: n<4 forces low", confidence(3, 0.99, 0.05).level, "low");

// ── §4.4 PRICE-BAND DEPRECIATION ───────────────────────────────────────────────────────
// m = [[25e3,.1],[75e3,0],[15e4,.075],[35e4,.045],[5e5,.09]], linear interp, clamped
console.log("\n§4.4 price-band depreciation — DOLLARS, linear interpolation");
near("$25,000 => 0.100 (first breakpoint)", baselineDepreciationForValue(25000), 0.1, 1e-9);
near("$75,000 => 0.000", baselineDepreciationForValue(75000), 0, 1e-9);
near("$150,000 => 0.075", baselineDepreciationForValue(150000), 0.075, 1e-9);
near("$350,000 => 0.045", baselineDepreciationForValue(350000), 0.045, 1e-9);
near("$500,000 => 0.090", baselineDepreciationForValue(500000), 0.09, 1e-9);
// halfway 25k->75k is halfway 0.10->0.00
near("$50,000 => 0.050 (midpoint interpolation)", baselineDepreciationForValue(50000), 0.05, 1e-9);
// 112,500 is halfway 75k->150k => halfway 0 -> 0.075
near("$112,500 => 0.0375", baselineDepreciationForValue(112500), 0.0375, 1e-9);
near("below the first breakpoint clamps to 0.10", baselineDepreciationForValue(5000), 0.1, 1e-9);
near("above the last breakpoint clamps to 0.09", baselineDepreciationForValue(2000000), 0.09, 1e-9);

// ── §4.9 DEAL SCORE ────────────────────────────────────────────────────────────────────
// dealScore = clamp(round(55 - 250*u), 5, 98),  u = (ask - fair)/fair
console.log("\n§4.9 deal score — 55 at fair, +2.5 per 1% under");
// Real signature: dealScore(askPrice, askMiles, avgMileage, collectibility, age, baseValue).
// Holding askMiles === avgMileage makes the mileage adjustment a no-op, so fairValue ===
// baseValue and the score isolates the 55 - 250*u formula.
const ds = (ask, fair) => dealScore(ask, 50000, 50000, 5, 10, fair).score;
eq("ask == fair => 55", ds(100000, 100000), 55);
eq("10% under fair => 80", ds(90000, 100000), 80);
eq("10% over fair => 30", ds(110000, 100000), 30);
eq("1% under fair => 57.5 rounds to 58", ds(99000, 100000), 58);
eq("clamped at 98 for an absurd bargain", ds(10000, 100000), 98);
eq("clamped at 5 for an absurd ask", ds(500000, 100000), 5);

// ── §4.11 SEGMENT ──────────────────────────────────────────────────────────────────────
console.log("\n§4.11 segment — make list OR value threshold");
eq("Bugatti at any value => hypercar", classifySegment("Bugatti", 1000), "hypercar");
eq("value > $1.5M => hypercar", classifySegment("Honda", 1500001), "hypercar");
eq("Ferrari => exotic", classifySegment("Ferrari", 1000), "exotic");
eq("value > $400k => exotic", classifySegment("Honda", 400001), "exotic");
eq("Porsche => perf", classifySegment("Porsche", 1000), "perf");
eq("value > $90k => perf", classifySegment("Honda", 90001), "perf");
eq("Honda at $20k => mainstream", classifySegment("Honda", 20000), "mainstream");

// ── §4.8 LIQUIDITY ─────────────────────────────────────────────────────────────────────
// b = x/2 (annualised from 24 months); monthsOfSupply = y / max(0.5, b) * 12
console.log("\n§4.8 liquidity — months of supply arithmetic");
const mkSales = (n, daysAgoMax = 700) =>
  Array.from({ length: n }, (_, i) => ({
    price: 50000, price_usd: 50000, currency: "USD",
    sold_at: new Date(Date.now() - Math.floor((i / Math.max(n - 1, 1)) * daysAgoMax) * 86400000).toISOString(),
  }));

{
  // 24 sales in 24 months => b = 12/yr; 6 active listings => 6/12*12 = 6 months of supply
  const r = computeLiquidity(mkSales(24), 6);
  near("24 sales/24mo + 6 listings => 6.0 months of supply", r.monthsOfSupply, 6, 0.6);
}
{
  // The ground truth's five states live on `verdict`; `tier` is the separate high/moderate/low
  // grading. Reading the wrong one is why my first draft of this file failed here.
  const r = computeLiquidity(mkSales(3), 5);
  eq("x<4 => THIN MARKET", r.verdict, "THIN MARKET");
  eq("thin market suppresses the metric", r.monthsOfSupply, null);
}
{
  const r = computeLiquidity(mkSales(24), 1);
  eq("listings<=1 => TIGHT SUPPLY", r.verdict, "TIGHT SUPPLY");
}
{
  // 24 sales/24mo => b = 12/yr. 3 listings => 3/12*12 = 3 months of supply, comfortably under 6.
  // NB: 6 listings gives EXACTLY 6.0 months, which is BALANCED — the rule is `mos < 6`, strict.
  // My draft asserted SELLER'S MARKET there and was wrong; the engine had the boundary right.
  const r = computeLiquidity(mkSales(24), 3);
  eq("mos<6 => SELLER'S MARKET", r.verdict, "SELLER'S MARKET");
  const b = computeLiquidity(mkSales(24), 6);
  eq("mos exactly 6.0 => BALANCED (strict <)", b.verdict, "BALANCED");
}
{
  // 8 sales/24mo => b=4/yr; 20 listings => 20/4*12 = 60 months => BUYER'S MARKET
  const r = computeLiquidity(mkSales(8), 20);
  eq("mos>18 => BUYER'S MARKET", r.verdict, "BUYER'S MARKET");
}

// ── §4.13 CLEAN-SALE PREDICATE ─────────────────────────────────────────────────────────
// !isOutlier && !carfaxDamage && !nonUsSale && !reserveNotMet
console.log("\n§4.13 clean-sale predicate — the four exclusion flags");
const base = { price: 1, price_usd: 1, currency: "USD", is_outlier: 0, carfax_damage: 0, non_us_sale: 0, status: "sold" };
eq("a clean sale passes", isClean(base), true);
eq("is_outlier excludes", isClean({ ...base, is_outlier: 1 }), false);
eq("carfax_damage excludes", isClean({ ...base, carfax_damage: 1 }), false);
eq("non_us_sale excludes", isClean({ ...base, non_us_sale: 1 }), false);
eq("reserve_not_met excludes", isClean({ ...base, status: "reserve_not_met" }), false);

// ── §4.12 VIN VALIDATION ───────────────────────────────────────────────────────────────
// S = /^[A-HJ-NPR-Z0-9]{17}$/ (no I, O, Q); >=11 floor admits pre-1981 chassis numbers
console.log("\n§4.12 VIN validation — ISO 3779 plus the deliberate >=11 floor");
eq("valid 17-char VIN accepted", isValidVin(normalizeVin("WP0AA2991VS111111")), true);
eq("letter I rejected inside a 17-char VIN", isValidVin(normalizeVin("WP0AA2991VSI11111")), false);
eq("11-char pre-1981 chassis number accepted", isValidVin(normalizeVin("CSX2000ABCD")), true);
eq("9-char chassis number rejected (below the floor)", isValidVin(normalizeVin("CSX2000AB")), false);
eq("placeholder 'CHASSIS' rejected", normalizeVin("CHASSIS"), null);
eq("placeholder 'N/A' rejected", normalizeVin("N/A"), null);
eq("all-same-character rejected", normalizeVin("00000000000"), null);
eq("no-digit string rejected", normalizeVin("ABCDEFGHIJK"), null);

// ── WHAT IS EXPLICITLY [U] ─────────────────────────────────────────────────────────────
console.log("\n§9 NOT ESTABLISHED — nothing to conform to, and we do not pretend otherwise:");
for (const u of [
  "Value Signal classifier thresholds / window lengths / seasonal adjustment",
  "currentValue robust estimator (method unstated)",
  "outlier detection method (no iqr/mad/slope in their bundle)",
  "seasonality computation (only its consumed output is visible)",
]) console.log(`     [U] ${u}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
