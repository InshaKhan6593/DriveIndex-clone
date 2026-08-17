// Orchestrator — runs the full engine for ONE car. Rebuilt against the verbatim ground
// truth; see each module's CORRECTION LOG for what changed.

const { isClean, detectOutliers } = require("./clean");
const { collectibility } = require("./collectibility");
const { computeCurrentValue } = require("./value");
const { classifySignal } = require("./signal");
const { confidence } = require("./confidence");
const { computeForecast } = require("./forecast");
const { computeSeasonality } = require("./seasonality");
const { computeLiquidity } = require("./liquidity");
const { buyHoldSell } = require("./buy-hold-sell");
const { classifySegment } = require("./segment");
const { baselineDepreciationForValue } = require("./depreciation");
const { mileageAdjust } = require("./mileage");
const { fitWithStandardError, lowerConfidenceReturn, upperConfidenceReturn } = require("./ranking");
const { mean } = require("./stats");

function ageOf(year) {
  return new Date().getFullYear() - year;
}

/**
 * @param {object} car - row from `car`
 * @param {object[]} allSales - every sale for this car_id (flags stay visible in the DB,
 *   isClean() drops them from the maths — ground truth §4.13)
 * @param {number} activeListingsCount
 * @param {{useCuratedOverrides?: boolean}} opts - pass useCuratedOverrides:false in
 *   backtests; the curated collectibility table encodes 2026 hindsight (§4.6 warning).
 */
function computeValuation(car, allSales, activeListingsCount = 0, opts = {}) {
  const age = ageOf(car.year);
  const useCuratedOverrides = opts.useCuratedOverrides !== false;

  const bootstrapAvgMiles = mean(allSales.map((s) => s.mileage).filter((m) => m != null)) || 50000;
  const bootstrapValue = mean(allSales.map((s) => s.price_usd ?? s.price)) || 0;
  const collect = collectibility({
    modelName: car.model, make: car.make, value: bootstrapValue, msrp: car.msrp, age, useCuratedOverrides,
  });

  const preOutlierClean = allSales.filter(isClean);
  const outlierIds = detectOutliers(preOutlierClean, { avgMiles: bootstrapAvgMiles, collectibility: collect.score, age });
  const cleanSales = preOutlierClean.filter((s) => !outlierIds.has(s.id));

  const salesCount = allSales.length;
  const outlierCount = outlierIds.size;
  const segment = classifySegment(car.make, bootstrapValue);

  if (cleanSales.length === 0) {
    const bhs = buyHoldSell("insufficient", 0, 0);
    return {
      carId: car.id, computedAt: new Date().toISOString(),
      signal: "insufficient", confidence: 0, confidenceLevel: "low",
      salesCount, outlierCount, cleanSalesCount: 0,
      // Was omitted on this branch, so a car with live listings but no clean sales stored
      // listings_count = 0 even when the caller passed a real count.
      listingsCount: activeListingsCount,
      dataBasis: "auction", valueBasis: "listing",
      currentValue: null, segment,
      collectibilityScore: collect.score, collectibilityReasons: collect.reasons,
      buyHoldSell: bhs.label, buyHoldSellCopy: bhs.copy,
      note: "no clean sales — every sale for this car is excluded by a flag (outlier / carfax damage / non-US / reserve not met)",
    };
  }

  const avgMileage = Math.round(mean(cleanSales.map((s) => s.mileage).filter((m) => m != null)) || bootstrapAvgMiles);
  const valueResult = computeCurrentValue(cleanSales, { avgMiles: avgMileage, collectibility: collect.score, age });
  const msrpRatio = car.msrp ? valueResult.currentValue / car.msrp : null;

  const signalResult = classifySignal(cleanSales, { avgMiles: avgMileage, collectibility: collect.score, age });
  const conf = confidence(signalResult.n, signalResult.rSquared, signalResult.volatility);

  // Ranking inputs. Computed here (once per nightly run) rather than in the API, because it
  // needs every sale's mileage-adjusted log price — far too expensive to redo per request
  // across ~56k cars. Only stored when the signal itself is trustworthy: if classifySignal()
  // refused to make a call, there is no trend worth ranking. Note this deliberately re-fits
  // rather than reusing signal.js's regression — signal.js reports R² but not the slope's
  // standard error, which is the whole basis of a conservative bound.
  const trendPoints = cleanSales.map((s) => ({
    x: (Date.now() - new Date(s.sold_at).getTime()) / (365.25 * 86400000),
    y: Math.log(Math.max(mileageAdjust(s.price_usd ?? s.price, s.mileage ?? avgMileage, avgMileage, collect.score, age), 1)),
  }));
  const trendFit = signalResult.annualReturn != null ? fitWithStandardError(trendPoints) : null;
  const trendLcb = lowerConfidenceReturn(trendFit);
  const trendUcb = upperConfidenceReturn(trendFit);

  const forecast = valueResult.currentValue
    ? computeForecast({
        currentValue: valueResult.currentValue,
        trendRate: signalResult.annualReturn ?? 0,
        collectibility: collect.score, age, msrpRatio,
        signal: signalResult.signal, n: signalResult.n, rSquared: signalResult.rSquared,
        confidence: conf.score,
      })
    : null;

  const seasonality = computeSeasonality(cleanSales);
  const liquidity = computeLiquidity(cleanSales, activeListingsCount);
  const bhs = buyHoldSell(signalResult.signal, conf.score, signalResult.annualReturn);

  return {
    carId: car.id,
    computedAt: new Date().toISOString(),

    currentValue: valueResult.currentValue,
    medianPrice: valueResult.medianPrice,
    priceLow: valueResult.priceLow,
    priceHigh: valueResult.priceHigh,
    avgMileage,
    retainedValue: car.msrp ? valueResult.currentValue / car.msrp : null,
    segment,
    baselineDepreciation: baselineDepreciationForValue(valueResult.currentValue),

    signal: signalResult.signal,
    confidence: conf.score,
    confidenceLevel: conf.level,
    annualReturn: signalResult.annualReturn,
    recentReturn: signalResult.recentReturn,

    // Ranking inputs — see engine/ranking.js. trendScore is filled in by the caller, which is
    // the only place that knows the population mean to shrink toward.
    trendSe: trendFit ? trendFit.se : null,
    trendDf: trendFit ? trendFit.df : null,
    trendLcb,
    trendUcb,
    volatility: signalResult.volatility,

    // PROJECTION CONFIDENCE — a top-level key in their API (§2) that we were never emitting,
    // so the column sat 0% populated while forecasts computed on 68.5% of cars.
    //
    // It is deliberately the SAME score the bear/bull bands are already built from: §4.7 widens
    // them by `C = max(0.15, 1 - confidence)`. Publishing a different number beside bands
    // derived from this one would be incoherent. Null when there is no forecast at all, so the
    // field means "no projection" rather than "projection with zero confidence".
    projectionConfidence: forecast ? conf.score : null,
    projectionConfidenceLevel: forecast ? conf.level : null,

    forecast1y: forecast?.forecast1y ?? null,
    forecast3y: forecast?.forecast3y ?? null,
    forecast5y: forecast?.forecast5y ?? null,
    bear3y: forecast?.bear3y ?? null,
    bull3y: forecast?.bull3y ?? null,
    bear5y: forecast?.bear5y ?? null,
    bull5y: forecast?.bull5y ?? null,
    estimatedBottomValue: forecast?.estimatedBottomValue ?? null,
    estimatedBottomYears: forecast?.estimatedBottomYears ?? null,
    estimatedBottomStatus: forecast?.estimatedBottomStatus ?? null,

    monthlyIndices: seasonality.monthlyIndices,
    monthCounts: seasonality.monthCounts,
    bestMonths: seasonality.bestMonths,
    worstMonths: seasonality.worstMonths,
    seasonalStrength: seasonality.seasonalStrength,
    buyDiscountPct: seasonality.buyDiscountPct,
    sellPremiumPct: seasonality.sellPremiumPct,

    collectibilityScore: collect.score,
    collectibilityReasons: collect.reasons,
    collectibilityOverridden: collect.overridden,

    liquidityTier: liquidity.tier,
    liquidityVerdict: liquidity.verdict,
    liquidityCopy: liquidity.copy,
    monthsOfSupply: liquidity.monthsOfSupply,
    salesPerYear: liquidity.salesPerYear,
    daysBetweenSales: liquidity.daysBetweenSales,

    salesCount, outlierCount,
    cleanSalesCount: cleanSales.length,
    recentSalesCount: liquidity.sales24mo ?? 0,
    listingsCount: activeListingsCount,

    dataBasis: "auction",
    valueBasis: "signal",

    buyHoldSell: bhs.label,
    buyHoldSellCopy: bhs.copy,
  };
}

module.exports = { computeValuation };
