// Nightly compute job (build spec §6): for every car_id with at least one sale, run the
// full valuation engine and upsert car_valuation. Full recompute every run, not incremental —
// the spec's own reasoning for that (§6 callout) holds here too: a single new sale changes
// avg_mileage, which moves every other sale's normalized price, which moves the trend. At
// this data volume (dozens of rows, not 7,000 cars) a full recompute is milliseconds.

const { openDb, newId } = require("../db/client");
const { computeValuation } = require("../engine/index");

// How many model-years either side to pool from when a car's own sales cannot produce a signal.
// Measured trade-off across 64,296 cars (scratchpad/window-test.js):
//     +/-1   8,213 rescued   median drift 14.4%
//     +/-2  11,558 rescued   median drift 16.5%   <- chosen
//     +/-3  13,215 rescued   median drift 17.9%
//     +/-5  14,891 rescued   median drift 19.1%
// Drift is how far the pooled median sits from the car's own sales. +/-2 roughly doubles the
// 12,050 cars that publish today without reaching for the wider, blurrier windows.
const SCOPE_HALF_WIDTH = Number(process.env.SCOPE_HALF_WIDTH) || 2;

// A valuation borrowed from neighbouring model-years is weaker evidence than one a car earned
// from its own sales, and must never outrank it in any leaderboard.
const SCOPE_CONFIDENCE_PENALTY = 0.6;
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
       trend_se, trend_lcb, trend_score,
       signal_scope, scope_from, scope_to, scope_n)
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
       @trend_se,@trend_lcb,@trend_score,
       @signal_scope,@scope_from,@scope_to,@scope_n)
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
       trend_se=excluded.trend_se, trend_lcb=excluded.trend_lcb, trend_score=excluded.trend_score,
       signal_scope=excluded.signal_scope, scope_from=excluded.scope_from,
       scope_to=excluded.scope_to, scope_n=excluded.scope_n`
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
    signal_scope: result.signalScope ?? "own",
    scope_from: result.scopeFrom ?? null,
    scope_to: result.scopeTo ?? null,
    scope_n: result.scopeN ?? null,
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

  // MODEL-LINE INDEX for the fallback below: make|model_key|body_type -> year -> sales.
  // Built once; a per-car query would be ~64k extra round trips.
  const lineIndex = new Map();
  {
    const all = db.prepare(
      `SELECT s.*, c.year AS _y, c.make AS _mk, c.model_key AS _md, c.body_type AS _b
       FROM sale s JOIN car c ON c.id = s.car_id`
    ).all();
    for (const s of all) {
      const k = `${s._mk}|${s._md}|${s._b || ""}`;
      const byYear = lineIndex.get(k) || new Map();
      const arr = byYear.get(s._y) || [];
      arr.push(s);
      byYear.set(s._y, arr);
      lineIndex.set(k, byYear);
    }
  }

  // PASS 1 — value every car. Nothing is written yet: the shrinkage in pass 2 needs the
  // market-wide mean trend, which isn't known until every car has been fitted.
  let widened = 0;
  for (const car of cars) {
    const sales = db.prepare("SELECT * FROM sale WHERE car_id = ?").all(car.id);
    // Was hardcoded 0, so listings_count was 0 on all 54,818 rows and computeLiquidity() has
    // never once seen real supply — months-of-supply and the liquidity verdict were derived
    // from an assumed-empty market.
    const listings = listingCounts.get(car.id) ?? 0;
    let result = computeValuation(car, sales, listings);
    result.signalScope = "own";

    // ── FALLBACK: value from the MODEL LINE when this model-year cannot speak for itself ──
    //
    // 91.1% of "insufficient" cars have one or two sales IN EXISTENCE — no amount of harvesting
    // reaches them, because the transactions never happened. Measured on 227k sales: adding 274
    // new ones moved the signal count by exactly 0, because half of them created new singleton
    // cars. Breadth cannot fix this; pooling can.
    //
    // A window CENTRED on the car, not a fixed 5-year band: a band splits generations at
    // arbitrary boundaries (1964 and 1965 Mustangs would land in different buckets), whereas a
    // centred window cannot. Measured at +/-2: 11,558 cars rescued, against 12,050 that publish
    // on their own today — it roughly doubles coverage.
    //
    // The cost is real and is why this never overwrites an "own" verdict: the pooled median sits
    // a median 16.5% from the car's own sales (p90 62%). So it runs ONLY when the car has no
    // signal at all, the result is labelled with the exact years and sale count it came from,
    // and confidence is discounted so a pooled car can never outrank a car with its own history.
    if (result.signal === "insufficient" && car.model_key) {
      const byYear = lineIndex.get(`${car.make}|${car.model_key}|${car.body_type || ""}`);
      if (byYear) {
        let pool = [];
        for (let y = car.year - SCOPE_HALF_WIDTH; y <= car.year + SCOPE_HALF_WIDTH; y++) {
          const a = byYear.get(y);
          if (a) pool = pool.concat(a);
        }
        if (pool.length > sales.length) {
          const wide = computeValuation(car, pool, listings);
          if (wide.signal && wide.signal !== "insufficient") {
            wide.signalScope = "model-window";
            wide.scopeFrom = car.year - SCOPE_HALF_WIDTH;
            wide.scopeTo = car.year + SCOPE_HALF_WIDTH;
            wide.scopeN = pool.length;
            // A borrowed history is weaker evidence than an owned one, always.
            wide.confidence = (wide.confidence ?? 0) * SCOPE_CONFIDENCE_PENALTY;

            // BORROW ONLY WHAT IS MISSING. A car can have enough sales to know its PRICE but
            // still not enough TIME SPAN to show a direction — measured: 2023 Subaru BRZ, 4
            // sales inside 84 days. Replacing its price with the model line's would discard a
            // real, better number in favour of a pooled one. So where the car priced itself,
            // its own price survives and only the trend is taken from the neighbours.
            if (result.currentValue != null) {
              for (const k of ["currentValue", "medianPrice", "priceLow", "priceHigh",
                               "avgMileage", "peakPrice", "fromPeak", "retainedValue"]) {
                if (result[k] != null) wide[k] = result[k];
              }
              wide.signalScope = "own-price/window-trend";
            }
            result = wide;
            widened++;
          }
        }
      }
    }
    results.push({ car, result });
  }
  console.log(`valued from the model line (own sales insufficient): ${widened}`);

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
