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

// ── TIME-SPAN GATE (added 2026-08-17 after a real defect) ─────────────────────────────────
// The count gate above is not sufficient on its own: n counts SALES, not TIME. Four sales in
// one week satisfy n>=3, and their slope — fitted per YEAR — then gets extrapolated 50x.
// Measured on live data before choosing this threshold: of cars whose whole clean-sale
// history spans <30 days, 40% produced |annualReturn| > 100%; 30-90d: 37%; 90-180d: 21%;
// 180-365d: 8%; 2y+: ~0%. The worst case reached +2.6e15 %/yr on a 2013 Ford E-350 whose four
// sales spanned 7 days — displayed to users as "Buy Now (Rising Fast)".
//
// 180 days = at most a 2x extrapolation to reach an annual figure. Below that we do not have
// a year's worth of evidence and say so, rather than inventing one.
const MIN_SPAN_DAYS = 180;

// Second, independent guard. Even above the span gate a degenerate fit (all sales clustered at
// one end of an otherwise long window) can explode. A collector car genuinely doubling in a
// year is real and must survive; a fit implying it TRIPLES every year is describing noise, not
// a market. Out-of-band means "this regression is not trustworthy" — reported as insufficient
// rather than silently clamped, because a clamped value looks like a real reading.
const MAX_PLAUSIBLE_ANNUAL = 2.0; // +200%/yr

function spanDays(points) {
  if (points.length < 2) return 0;
  const times = points.map((p) => p.yearsAgo);
  return (Math.max(...times) - Math.min(...times)) * 365.25;
}

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

  const volatility = volatilityOf(cleanSales.map((s) => s.price_usd ?? s.price));

  // Not enough TIME to make a per-year claim, however many sales there are.
  if (spanDays(normalized) < MIN_SPAN_DAYS) {
    return { signal: "insufficient", annualReturn: null, recentReturn: null, volatility, rSquared: 0, n };
  }

  const longWindow = linearRegression(normalized.map((p) => ({ x: p.yearsAgo, y: p.logPrice })));
  const annualReturn = annualizedReturnFromSlope(longWindow.slope);

  // Degenerate fit — the slope is describing noise, not a market.
  if (!Number.isFinite(annualReturn) || Math.abs(annualReturn) > MAX_PLAUSIBLE_ANNUAL) {
    return { signal: "insufficient", annualReturn: null, recentReturn: null, volatility, rSquared: longWindow.rSquared, n };
  }

  // Same reasoning for the short window: two sales days apart annualize to nonsense, so the
  // recent read only counts when it too covers real time. Falls back to the long-window rate.
  const recentCutoffYears = RECENT_WINDOW_DAYS / 365.25;
  const recentPoints = normalized.filter((p) => p.yearsAgo <= recentCutoffYears);
  let recentReturn = annualReturn;
  if (recentPoints.length >= 2 && spanDays(recentPoints) >= MIN_SPAN_DAYS) {
    const r = annualizedReturnFromSlope(linearRegression(recentPoints.map((p) => ({ x: p.yearsAgo, y: p.logPrice }))).slope);
    if (Number.isFinite(r) && Math.abs(r) <= MAX_PLAUSIBLE_ANNUAL) recentReturn = r;
  }

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

module.exports = { classifySignal, MIN_SALES_FOR_SIGNAL, STABLE_BAND, MIN_SPAN_DAYS, MAX_PLAUSIBLE_ANNUAL };
