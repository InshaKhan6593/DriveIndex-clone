// RANKING — how cars are ordered on leaderboards (Trending) and how a live ask is judged
// against market value (Deal Radar).
//
// ── WHY THIS IS NOT A SET OF THRESHOLDS ───────────────────────────────────────────────────
// The obvious implementation is `WHERE confidence >= 0.7 AND sales_count >= 15`. That was
// tried and rejected. Two problems:
//
//   1. Those numbers were reverse-engineered from one day's data — picked because they
//      happened to cap the leaderboard near a believable maximum. They encode nothing about
//      why a car is trustworthy.
//   2. They are cliffs. A cron job that adds sales nightly walks cars over the cliff in a
//      single step, and the cliff itself never adapts. Six months from now the same constants
//      are either far too strict or meaningless.
//
// What is used instead has no cliff and dissolves on its own as evidence accumulates:
//
//   score = populationMean + (lowerConfidenceBound - populationMean) * df/(df + PRIOR_STRENGTH)
//
// Two independent mechanisms, each fixing a distinct failure:
//
//   • LOWER CONFIDENCE BOUND handles NOISE. A trend fitted through scattered sales has a large
//     standard error, so the conservative end of its interval collapses toward (or past) zero
//     on its own. Measured: the raw leaderboard's top 8 were all +130%..+198%/yr artifacts;
//     every one has a lower bound below -86%, i.e. the data cannot rule out a crash.
//
//   • SHRINKAGE handles THIN EVIDENCE. LCB alone is not enough: three sales that happen to sit
//     on a straight line produce a tiny standard error and therefore a tight, confident-looking
//     interval. Shrinking toward the population mean in proportion to degrees of freedom fixes
//     exactly that — and it is self-dissolving, because df/(df+K) -> 1 as sales accumulate. A
//     car earns its position by evidence rather than by clearing a fixed bar.
//
// DEGREES OF FREEDOM, not sale count, is the right weight: fitting a line consumes two
// observations, so n=3 leaves df=1 — one scrap of information about whether the line is real.
// Using n would treat that car as 3/28ths trustworthy; using df treats it as 1/26th.
//
// Measured effect (2026-08-17, 9,600 cars): the 1970 Ford Torino GT that ranked top-8 at
// +165.9%/yr falls to rank 7,466. The resulting top of the board — 1991 Porsche 911 Turbo
// (n=38), 2005 BMW M3 ZCP (n=13), 2009 Ferrari 430 Scuderia 16M (n=17) — are cars with real,
// well-known appreciation.
"use strict";

const { mean } = require("./stats");

// PRIOR STRENGTH — the ONLY tuning constant here, and deliberately not a threshold.
// Read it as: "how many degrees of freedom before this car's own trend outweighs the market
// average." At df = K the two are weighted equally. It never needs revisiting as data grows,
// because its influence fades automatically — that is the whole point of expressing the
// control this way rather than as a minimum-sales cutoff.
const PRIOR_STRENGTH = 25;

// One-sided ~90% t-multipliers. Small samples get a much wider interval, which is precisely
// the conservatism wanted: df=1 carries a 6.31x penalty, df=30 only 1.70x.
const T_TABLE = { 1: 6.31, 2: 2.92, 3: 2.35, 4: 2.13, 5: 2.02, 6: 1.94, 7: 1.89, 8: 1.86,
  9: 1.83, 10: 1.81, 15: 1.75, 20: 1.72, 30: 1.70, 60: 1.67 };

function tCritical(df) {
  if (df < 1) return T_TABLE[1];
  for (const k of Object.keys(T_TABLE).map(Number).sort((a, b) => a - b)) {
    if (df <= k) return T_TABLE[k];
  }
  return 1.65; // large-sample normal limit
}

/**
 * Ordinary least squares plus the standard error of the slope — the piece `linearRegression`
 * in stats.js does not report, and the piece every conservative ranking needs.
 * @param {{x:number,y:number}[]} points
 * @returns {{slope:number, se:number, n:number, df:number}|null}
 */
function fitWithStandardError(points) {
  const n = points.length;
  if (n < 3) return null; // df would be <1: no information left to estimate error with
  const mx = mean(points.map((p) => p.x));
  const my = mean(points.map((p) => p.y));
  let sxx = 0, sxy = 0;
  for (const p of points) { sxx += (p.x - mx) ** 2; sxy += (p.x - mx) * (p.y - my); }
  if (sxx === 0) return null; // every sale on the same date — slope undefined
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let ssRes = 0;
  for (const p of points) ssRes += (p.y - (slope * p.x + intercept)) ** 2;
  return { slope, se: Math.sqrt((ssRes / (n - 2)) / sxx), n, df: n - 2 };
}

/**
 * The conservative end of the annualised-return interval.
 * Slope is on log-price vs YEARS AGO, so a rising market has a negative slope; the least
 * favourable slope in the interval is therefore `slope + t*se`.
 */
function lowerConfidenceReturn(fit) {
  if (!fit) return null;
  const v = Math.exp(-(fit.slope + tCritical(fit.df) * fit.se)) - 1;
  return Number.isFinite(v) ? v : null;
}

/** Mirror of the above, for ranking the steepest declines honestly. */
function upperConfidenceReturn(fit) {
  if (!fit) return null;
  const v = Math.exp(-(fit.slope - tCritical(fit.df) * fit.se)) - 1;
  return Number.isFinite(v) ? v : null;
}

/**
 * Shrink an estimate toward the population mean in proportion to degrees of freedom.
 * @param {number} estimate       usually a confidence bound, not the raw point estimate
 * @param {number} populationMean the market-wide average to fall back toward
 * @param {number} df             degrees of freedom behind `estimate`
 */
function shrinkToward(estimate, populationMean, df, priorStrength = PRIOR_STRENGTH) {
  if (estimate == null || !Number.isFinite(estimate)) return null;
  const w = Math.max(0, df) / (Math.max(0, df) + priorStrength);
  return populationMean + (estimate - populationMean) * w;
}

/**
 * Is a live asking price actually below market, or is the gap an artifact?
 *
 * The naive test — `ask < current_value` — produced 364 "deals" of which the top ones were all
 * project cars: a 1959 Jaguar XK 150 asking $21,500 against a $112,000 value computed from ONE
 * sale, with the listing reporting 0 miles. The discount was real arithmetic and completely
 * meaningless.
 *
 * The guard is deliberately expressed against the car's OWN observed sale prices rather than a
 * fixed maximum-discount percentage. That is self-calibrating: as more sales arrive the
 * observed range widens or tightens on its own, and no constant needs revisiting. An ask below
 * everything the model has ever actually sold for is not a bargain — it is a different car
 * (project, salvage, replica) that our identity model failed to separate.
 *
 * @param {{price:number}} listing
 * @param {{currentValue:number, salePrices:number[]}} ctx
 * @returns {{isDeal:boolean, discount:number|null, reason:string}}
 */
function judgeAsk(listing, ctx) {
  const { price } = listing;
  const { currentValue, salePrices } = ctx;
  if (!price || !currentValue || price <= 0 || currentValue <= 0) {
    return { isDeal: false, discount: null, reason: "no price or no computed value" };
  }
  if (price >= currentValue) {
    return { isDeal: false, discount: null, reason: "at or above market value" };
  }
  const discount = (currentValue - price) / currentValue;
  if (!salePrices || salePrices.length === 0) {
    return { isDeal: false, discount, reason: "no observed sales to sanity-check against" };
  }
  const cheapestEverSold = Math.min(...salePrices);
  if (price < cheapestEverSold) {
    return {
      isDeal: false, discount,
      reason: `ask is below the cheapest verified sale ($${Math.round(cheapestEverSold).toLocaleString()}) — likely a project or a different spec, not a discount`,
    };
  }
  return { isDeal: true, discount, reason: "within the observed sale range and under market" };
}

/**
 * Order deals by how much the discount can be BELIEVED, not by its raw size.
 *
 * A discount is only as good as the value it is measured against. Ranking on raw discount put
 * a 1972 Porsche 911 S at -63% on top — against a value computed at 22% confidence from six
 * sales, on a listing reporting 0 miles. Meanwhile a LaFerrari at -29% against a 64%-confidence
 * value sat below it. The second is the better lead by any reasonable reading.
 *
 * Multiplying by confidence is the same move as the trend shrinkage: an estimate is pulled
 * toward "no claim" in proportion to how little supports it. It needs no threshold and it
 * self-corrects as sales accumulate and confidence rises.
 */
function dealScore(discount, confidence) {
  if (discount == null || !Number.isFinite(discount)) return 0;
  return discount * (confidence ?? 0);
}

/**
 * A zero odometer on a car that is decades old is a "not disclosed" placeholder, not a
 * genuine reading — DuPont reports mileage on 96% of listings, so a literal 0 is an encoding
 * artifact. Treating it as real would let the mileage curve award a huge low-mileage premium.
 */
function plausibleMileage(mileage, year) {
  if (mileage == null) return null;
  const age = new Date().getFullYear() - year;
  if (mileage === 0 && age > 3) return null; // placeholder, not a delivery-mileage car
  return mileage;
}

module.exports = {
  fitWithStandardError,
  lowerConfidenceReturn,
  upperConfidenceReturn,
  shrinkToward,
  judgeAsk,
  dealScore,
  plausibleMileage,
  tCritical,
  PRIOR_STRENGTH,
};
