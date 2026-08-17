// Nightly compute job (build spec §6): for every car_id with at least one sale, run the
// full valuation engine and upsert car_valuation. Full recompute every run, not incremental —
// the spec's own reasoning for that (§6 callout) holds here too: a single new sale changes
// avg_mileage, which moves every other sale's normalized price, which moves the trend. At
// this data volume (dozens of rows, not 7,000 cars) a full recompute is milliseconds.

const { openDb, newId } = require("../db/client");
const { computeValuation } = require("../engine/index");
const { shrinkToward } = require("../engine/ranking");

function upsertValuation(db, result) {
  db.prepare(
    `INSERT INTO car_valuation
      (car_id, computed_at, current_value, median_price, price_low, price_high, avg_mileage,
       retained_value, signal, confidence, annual_return, recent_return, volatility,
       forecast_1y, forecast_3y, forecast_5y, bear_3y, bull_3y, bear_5y, bull_5y,
       projection_confidence,
       estimated_bottom_value, estimated_bottom_years, estimated_bottom_status,
       monthly_indices, month_counts, best_months, worst_months, seasonal_strength,
       buy_discount_pct, sell_premium_pct, collectibility_score, collectibility_reasons,
       liquidity_tier, sales_per_year, days_between_sales, sales_count, outlier_count,
       recent_sales_count, listings_count, data_basis, value_basis,
       segment, buy_hold_sell, buy_hold_sell_copy, liquidity_verdict, liquidity_copy, months_of_supply,
       trend_se, trend_lcb, trend_score)
     VALUES (@car_id,@computed_at,@current_value,@median_price,@price_low,@price_high,@avg_mileage,
       @retained_value,@signal,@confidence,@annual_return,@recent_return,@volatility,
       @forecast_1y,@forecast_3y,@forecast_5y,@bear_3y,@bull_3y,@bear_5y,@bull_5y,
       @projection_confidence,
       @estimated_bottom_value,@estimated_bottom_years,@estimated_bottom_status,
       @monthly_indices,@month_counts,@best_months,@worst_months,@seasonal_strength,
       @buy_discount_pct,@sell_premium_pct,@collectibility_score,@collectibility_reasons,
       @liquidity_tier,@sales_per_year,@days_between_sales,@sales_count,@outlier_count,
       @recent_sales_count,@listings_count,@data_basis,@value_basis,
       @segment,@buy_hold_sell,@buy_hold_sell_copy,@liquidity_verdict,@liquidity_copy,@months_of_supply,
       @trend_se,@trend_lcb,@trend_score)
     ON CONFLICT(car_id) DO UPDATE SET
       computed_at=excluded.computed_at, current_value=excluded.current_value,
       median_price=excluded.median_price, price_low=excluded.price_low, price_high=excluded.price_high,
       avg_mileage=excluded.avg_mileage, retained_value=excluded.retained_value,
       signal=excluded.signal, confidence=excluded.confidence, annual_return=excluded.annual_return,
       recent_return=excluded.recent_return, volatility=excluded.volatility,
       forecast_1y=excluded.forecast_1y, forecast_3y=excluded.forecast_3y, forecast_5y=excluded.forecast_5y,
       bear_3y=excluded.bear_3y, bull_3y=excluded.bull_3y, bear_5y=excluded.bear_5y, bull_5y=excluded.bull_5y,
       projection_confidence=excluded.projection_confidence,
       estimated_bottom_value=excluded.estimated_bottom_value, estimated_bottom_years=excluded.estimated_bottom_years,
       estimated_bottom_status=excluded.estimated_bottom_status,
       monthly_indices=excluded.monthly_indices, month_counts=excluded.month_counts,
       best_months=excluded.best_months, worst_months=excluded.worst_months,
       seasonal_strength=excluded.seasonal_strength, buy_discount_pct=excluded.buy_discount_pct,
       sell_premium_pct=excluded.sell_premium_pct, collectibility_score=excluded.collectibility_score,
       collectibility_reasons=excluded.collectibility_reasons, liquidity_tier=excluded.liquidity_tier,
       sales_per_year=excluded.sales_per_year, days_between_sales=excluded.days_between_sales,
       sales_count=excluded.sales_count, outlier_count=excluded.outlier_count,
       recent_sales_count=excluded.recent_sales_count, listings_count=excluded.listings_count,
       data_basis=excluded.data_basis, value_basis=excluded.value_basis,
       segment=excluded.segment, buy_hold_sell=excluded.buy_hold_sell,
       buy_hold_sell_copy=excluded.buy_hold_sell_copy, liquidity_verdict=excluded.liquidity_verdict,
       liquidity_copy=excluded.liquidity_copy, months_of_supply=excluded.months_of_supply,
       trend_se=excluded.trend_se, trend_lcb=excluded.trend_lcb, trend_score=excluded.trend_score`
  ).run({
    car_id: result.carId,
    computed_at: result.computedAt,
    current_value: result.currentValue ?? null,
    median_price: result.medianPrice ?? null,
    price_low: result.priceLow ?? null,
    price_high: result.priceHigh ?? null,
    avg_mileage: result.avgMileage ?? null,
    retained_value: result.retainedValue ?? null,
    signal: result.signal,
    confidence: result.confidence ?? 0,
    annual_return: result.annualReturn ?? null,
    recent_return: result.recentReturn ?? null,
    volatility: result.volatility ?? null,
    forecast_1y: result.forecast1y ?? null, forecast_3y: result.forecast3y ?? null, forecast_5y: result.forecast5y ?? null,
    bear_3y: result.bear3y ?? null, bull_3y: result.bull3y ?? null, bear_5y: result.bear5y ?? null, bull_5y: result.bull5y ?? null,
    projection_confidence: result.projectionConfidence ?? null,
    estimated_bottom_value: result.estimatedBottomValue ?? null,
    estimated_bottom_years: result.estimatedBottomYears ?? null,
    estimated_bottom_status: result.estimatedBottomStatus ?? null,
    // SEASONALITY MUST BE NULL WHEN IT WAS GATED, NOT AN EMPTY STRING.
    //
    // These wrote JSON.stringify(null) === the literal text "null", and JSON.stringify([])
    // === "[]" — both of which SQL counts as NON-null. So best_months and monthly_indices
    // reported 100% populated while seasonal_strength, the field that actually gates, sat at
    // 1.9%. Any consumer keying off best_months would render a "best month for buying" for
    // 35,350 cars that have no seasonal profile at all — precisely the noise the ground truth
    // warns about ("a 'best month' from two sales is noise").
    //
    // A JSON column should hold JSON or nothing.
    monthly_indices: result.monthlyIndices ? JSON.stringify(result.monthlyIndices) : null,
    month_counts: result.monthCounts ? JSON.stringify(result.monthCounts) : null,
    best_months: result.bestMonths && result.bestMonths.length ? JSON.stringify(result.bestMonths) : null,
    worst_months: result.worstMonths && result.worstMonths.length ? JSON.stringify(result.worstMonths) : null,
    seasonal_strength: result.seasonalStrength ?? null,
    buy_discount_pct: result.buyDiscountPct ?? null,
    sell_premium_pct: result.sellPremiumPct ?? null,
    collectibility_score: result.collectibilityScore ?? null,
    collectibility_reasons: JSON.stringify(result.collectibilityReasons ?? []),
    liquidity_tier: result.liquidityTier ?? null,
    sales_per_year: result.salesPerYear ?? null,
    days_between_sales: result.daysBetweenSales ?? null,
    sales_count: result.salesCount ?? 0,
    outlier_count: result.outlierCount ?? 0,
    recent_sales_count: result.recentSalesCount ?? 0,
    listings_count: result.listingsCount ?? 0,
    data_basis: result.dataBasis ?? "auction",
    value_basis: result.valueBasis ?? "listing",
    segment: result.segment ?? null,
    buy_hold_sell: result.buyHoldSell ?? null,
    buy_hold_sell_copy: result.buyHoldSellCopy ?? null,
    liquidity_verdict: result.liquidityVerdict ?? null,
    liquidity_copy: result.liquidityCopy ?? null,
    months_of_supply: result.monthsOfSupply ?? null,
    trend_se: result.trendSe ?? null,
    trend_lcb: result.trendLcb ?? null,
    trend_score: result.trendScore ?? null,
  });
}

function runNightlyCompute(db) {
  // Cars with LISTINGS but no sales were previously skipped entirely (the old query inner-
  // joined `sale`), leaving 1,008 cars with live inventory and no valuation row at all —
  // their pages rendered a blank value. They still can't be valued without sales, but they
  // get a row carrying listings_count and an honest "insufficient" signal.
  const cars = db.prepare(`
    SELECT * FROM car WHERE id IN (SELECT car_id FROM sale)
       OR id IN (SELECT car_id FROM listing WHERE is_active = 1 AND car_id IS NOT NULL)
  `).all();
  const results = [];

  // One grouped query rather than a per-car lookup inside the loop — this runs over ~56k cars.
  const listingCounts = new Map(
    db.prepare("SELECT car_id, COUNT(*) n FROM listing WHERE is_active = 1 AND car_id IS NOT NULL GROUP BY car_id")
      .all().map((r) => [r.car_id, r.n])
  );

  // PASS 1 — value every car. Nothing is written yet: the shrinkage in pass 2 needs the
  // market-wide mean trend, which isn't known until every car has been fitted.
  for (const car of cars) {
    const sales = db.prepare("SELECT * FROM sale WHERE car_id = ?").all(car.id);
    // Was hardcoded 0, so listings_count was 0 on all 54,818 rows and computeLiquidity() has
    // never once seen real supply — months-of-supply and the liquidity verdict were derived
    // from an assumed-empty market.
    const result = computeValuation(car, sales, listingCounts.get(car.id) ?? 0);
    results.push({ car, result });
  }

  // PASS 2 — shrink each car's conservative trend toward the population mean and persist.
  // The mean is taken over cars that produced a trustworthy trend at all, so cars the engine
  // refused to call don't drag the baseline around.
  const trended = results.filter((r) => r.result.annualReturn != null);
  const populationMeanTrend = trended.length
    ? trended.reduce((a, r) => a + r.result.annualReturn, 0) / trended.length
    : 0;

  for (const { result } of results) {
    result.trendScore = shrinkToward(result.trendLcb, populationMeanTrend, result.trendDf ?? 0);
    upsertValuation(db, result);
  }

  return results;
}

function printReport(results) {
  console.log(`\n=== NIGHTLY COMPUTE — ${results.length} car(s) ===`);
  for (const { car, result } of results) {
    const label = `${car.year} ${car.make} ${car.model}`;
    console.log(
      `  ${label}: signal=${result.signal} confidence=${(result.confidence ?? 0).toFixed(2)} ` +
      `value=${result.currentValue ?? "n/a"} sales=${result.salesCount} clean=${result.cleanSalesCount ?? (result.salesCount - result.outlierCount)} ` +
      `buyHoldSell=${result.buyHoldSell}`
    );
  }
}

if (require.main === module) {
  // Shares the single-writer lock with ingest: a recompute running against a table another
  // ingest is still filling would write valuations from a half-populated corpus, and they would
  // look current. See jobs/lock.js.
  require("./lock").withLock("compute", () => {
    const db = openDb();
    const results = runNightlyCompute(db);
    printReport(results);
    db.close();
  });
}

module.exports = { runNightlyCompute, upsertValuation };
