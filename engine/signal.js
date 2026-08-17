// RECONSTRUCTED, not verbatim. Build spec §7.3 confirms the six-state enum exactly
// (appreciating/bottomed/approaching/stable/depreciating/insufficient — verified against
// the real client bundle) and confirms the METHOD in the product's own tooltip copy:
// "long-term trend call... a hold-out backtest showed the long trend predicts direction
// better than chasing recent sales... three-window regression over mileage-normalised,
// seasonally-adjusted prices; the long window drives the classification, and short-window
// divergence surfaces separately as Momentum cooling/warming."
//
// What's NOT in the spec: the exact numeric thresholds that separate "stable" from
// "appreciating," or that decide "bottomed" vs. "approaching." Those run server-side and
// were never in the client bundle. Everything below implements the confirmed METHOD with
// reasonable, clearly-arbitrary threshold constants — tune these against real DriveIndex
// output if exact parity with their calls is ever required; don't assume they already match.

const { linearRegression, volatilityOf } = require("./stats");
const { mileageAdjust } = require("./mileage");

const MIN_SALES_FOR_SIGNAL = 3; // below this, always "insufficient" — matches the spec's own confidence() n<4 => low-confidence floor
const STABLE_BAND = 0.03; // +/-3% annualized treated as flat, not a directional call — arbitrary, not spec-confirmed
const RECENT_WINDOW_DAYS = 365;

function toYearsAgo(isoDate) {
  return (Date.now() - new Date(isoDate).getTime()) / (365.25 * 86400000);
}

function annualizedReturnFromSlope(slopePerYear) {
  // slope is on log-price vs. years-ago (negative x = more recent); flip sign so positive
  // slope = price rising toward the present.
  return Math.exp(-slopePerYear) - 1;
}

/**
 * @param {object[]} cleanSales - clean_sale rows, sorted or not, each with price_usd/price, mileage, sold_at
 * @param {{ avgMiles: number, collectibility: number, age: number }} ctx
 * @returns {{ signal: string, annualReturn: number|null, recentReturn: number|null, volatility: number, rSquared: number, n: number }}
 */
function classifySignal(cleanSales, ctx) {
  const n = cleanSales.length;
  if (n < MIN_SALES_FOR_SIGNAL) {
    return { signal: "insufficient", annualReturn: null, recentReturn: null, volatility: 0, rSquared: 0, n };
  }

  const normalized = cleanSales.map((s) => ({
    yearsAgo: toYearsAgo(s.sold_at),
    logPrice: Math.log(Math.max(mileageAdjust(s.price_usd ?? s.price, s.mileage ?? ctx.avgMiles, ctx.avgMiles, ctx.collectibility, ctx.age), 1)),
  }));

  const longWindow = linearRegression(normalized.map((p) => ({ x: p.yearsAgo, y: p.logPrice })));
  const annualReturn = annualizedReturnFromSlope(longWindow.slope);

  const recentCutoffYears = RECENT_WINDOW_DAYS / 365.25;
  const recentPoints = normalized.filter((p) => p.yearsAgo <= recentCutoffYears);
  const recentReturn = recentPoints.length >= 2
    ? annualizedReturnFromSlope(linearRegression(recentPoints.map((p) => ({ x: p.yearsAgo, y: p.logPrice }))).slope)
    : annualReturn;

  const volatility = volatilityOf(cleanSales.map((s) => s.price_usd ?? s.price));

  let signal;
  if (Math.abs(annualReturn) < STABLE_BAND) {
    signal = "stable";
  } else if (annualReturn >= STABLE_BAND) {
    signal = "appreciating";
  } else {
    // declining on the long window — disambiguate bottomed / approaching / depreciating
    // using whether recent momentum has actually turned.
    if (recentReturn > 0.02) signal = "bottomed";
    else if (recentReturn > -0.02) signal = "approaching";
    else signal = "depreciating";
  }

  return { signal, annualReturn, recentReturn, volatility, rSquared: longWindow.rSquared, n };
}

module.exports = { classifySignal, MIN_SALES_FOR_SIGNAL, STABLE_BAND };
