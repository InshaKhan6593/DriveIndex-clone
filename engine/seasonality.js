// INFERRED — build spec §7.7 confirms the OUTPUT shape (monthly_indices[12], month_counts[12],
// best_months, worst_months, seasonal_strength, buy_discount_pct, sell_premium_pct) and one
// explicit instruction — "gate the display on sufficient month_counts, a 'best month' from
// two sales is noise" — but not the exact detrending/indexing formula. Implemented as: remove
// the long-window price trend (same regression signal.js already fits) from each sale, then
// average the residual by calendar month.
//
// At this pipeline's current real data volume (1 sale per car for almost every car ingested
// so far) this will correctly return "not enough data" for nearly everything — that's the
// gate doing its job, not a bug. See engine/engine-demo.js for a synthetic fixture that
// actually exercises the non-trivial path.

const { linearRegression, mean } = require("./stats");

const MIN_SALES_FOR_SEASONALITY = 12;
const MIN_SALES_PER_MONTH_TO_COUNT = 2;

function toYearsAgo(isoDate) {
  return (Date.now() - new Date(isoDate).getTime()) / (365.25 * 86400000);
}

function computeSeasonality(cleanSales) {
  if (cleanSales.length < MIN_SALES_FOR_SEASONALITY) {
    return { insufficientData: true, monthlyIndices: null, monthCounts: null, bestMonths: [], worstMonths: [], seasonalStrength: null, buyDiscountPct: null, sellPremiumPct: null };
  }

  const points = cleanSales.map((s) => ({
    month: new Date(s.sold_at).getUTCMonth(),
    yearsAgo: toYearsAgo(s.sold_at),
    logPrice: Math.log(Math.max(s.price_usd ?? s.price, 1)),
  }));

  const trend = linearRegression(points.map((p) => ({ x: p.yearsAgo, y: p.logPrice })));
  const residuals = points.map((p) => p.logPrice - (trend.slope * p.yearsAgo + trend.intercept));

  const byMonth = Array.from({ length: 12 }, () => []);
  points.forEach((p, i) => byMonth[p.month].push(residuals[i]));

  const monthCounts = byMonth.map((arr) => arr.length);
  const overallMeanResidual = mean(residuals) ?? 0;
  const monthlyIndices = byMonth.map((arr, m) =>
    monthCounts[m] >= MIN_SALES_PER_MONTH_TO_COUNT ? Math.round((Math.exp(mean(arr) - overallMeanResidual) - 1) * 1000) / 1000 : null
  );

  const validMonths = monthlyIndices.map((idx, m) => ({ m, idx })).filter((x) => x.idx != null);
  if (validMonths.length < 2) {
    return { insufficientData: true, monthlyIndices, monthCounts, bestMonths: [], worstMonths: [], seasonalStrength: null, buyDiscountPct: null, sellPremiumPct: null };
  }

  const sorted = [...validMonths].sort((a, b) => b.idx - a.idx);
  const bestMonths = sorted.slice(0, Math.min(2, sorted.length)).map((x) => x.m);
  const worstMonths = sorted.slice(-Math.min(2, sorted.length)).map((x) => x.m);
  const seasonalStrength = sorted[0].idx - sorted[sorted.length - 1].idx;

  return {
    insufficientData: false,
    monthlyIndices,
    monthCounts,
    bestMonths,
    worstMonths,
    seasonalStrength,
    sellPremiumPct: sorted[0].idx,
    buyDiscountPct: Math.abs(sorted[sorted.length - 1].idx),
  };
}

module.exports = { computeSeasonality, MIN_SALES_FOR_SEASONALITY };
