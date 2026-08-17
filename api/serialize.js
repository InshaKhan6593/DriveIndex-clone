// Single tier-gating choke point (build spec §9.1, §9.3): the server always returns the
// full object SHAPE, with paid fields nulled rather than omitted, and free listing arrays
// truncated rather than filtered. This mirrors DriveIndex's own confirmed behavior — a free
// user can see WHEN a car sold and at what mileage, never for how much, which is a
// legitimate conversion surface. The spec also flagged that DriveIndex itself was
// inconsistent about gating (three different lock patterns across endpoints, build spec
// §9.1) — that inconsistency is called out there as a defect to avoid, not a pattern to
// copy, so this file is the ONE place tier logic lives, deliberately.

const TIERS = ["free", "pro", "collector"];

function tierAtLeast(tier, min) {
  return TIERS.indexOf(tier) >= TIERS.indexOf(min);
}

function serializeSale(sale, tier) {
  const base = { date: sale.sold_at, mileage: sale.mileage };
  if (!tierAtLeast(tier, "pro")) {
    return { ...base, price: null, source: null, url: null };
  }
  return { ...base, price: sale.price, currency: sale.currency, source: sale.source, url: sale.url, vin: tierAtLeast(tier, "collector") ? sale.vin : null };
}

function serializeCarSummary(car, valuation, tier) {
  return {
    id: car.id,
    year: car.year,
    make: car.make,
    model: car.model,
    currentValue: valuation?.current_value ?? null,
    signal: tierAtLeast(tier, "pro") ? valuation?.signal ?? null : null,
    confidence: tierAtLeast(tier, "pro") ? valuation?.confidence ?? null : null,
    soldGated: !tierAtLeast(tier, "pro"),
  };
}

function serializeCarDetail(car, valuation, sales, tier) {
  const sortedSales = [...sales].sort((a, b) => new Date(b.sold_at) - new Date(a.sold_at));
  const visibleSales = tierAtLeast(tier, "pro") ? sortedSales : sortedSales.slice(0, 5);

  return {
    id: car.id,
    year: car.year,
    make: car.make,
    model: car.model,
    msrp: car.msrp,
    soldGated: !tierAtLeast(tier, "pro"),

    currentValue: valuation?.current_value ?? null,
    medianPrice: valuation?.median_price ?? null,
    retainedValue: valuation?.retained_value ?? null,

    // Pro tier and above
    signal: tierAtLeast(tier, "pro") ? valuation?.signal ?? null : null,
    confidence: tierAtLeast(tier, "pro") ? valuation?.confidence ?? null : null,
    annualReturn: tierAtLeast(tier, "pro") ? valuation?.annual_return ?? null : null,
    projections: tierAtLeast(tier, "pro") ? {
      forecast1y: valuation?.forecast_1y ?? null,
      forecast3y: valuation?.forecast_3y ?? null,
      forecast5y: valuation?.forecast_5y ?? null,
      bear3y: valuation?.bear_3y ?? null, bull3y: valuation?.bull_3y ?? null,
      bear5y: valuation?.bear_5y ?? null, bull5y: valuation?.bull_5y ?? null,
    } : null,

    // Collector tier only
    bestMonths: tierAtLeast(tier, "collector") ? JSON.parse(valuation?.best_months ?? "[]") : null,
    worstMonths: tierAtLeast(tier, "collector") ? JSON.parse(valuation?.worst_months ?? "[]") : null,
    seasonalStrength: tierAtLeast(tier, "collector") ? valuation?.seasonal_strength ?? null : null,
    collectibility: tierAtLeast(tier, "collector") ? {
      score: valuation?.collectibility_score ?? null,
      reasons: JSON.parse(valuation?.collectibility_reasons ?? "[]"),
    } : null,
    buyHoldSell: tierAtLeast(tier, "collector")
      ? { label: valuation?.buy_hold_sell ?? null, copy: valuation?.buy_hold_sell_copy ?? null }
      : null,

    // free-tier visible: segment and liquidity are positioning, not the paid signal
    segment: valuation?.segment ?? null,
    liquidity: {
      verdict: valuation?.liquidity_verdict ?? null,
      copy: valuation?.liquidity_copy ?? null,
      monthsOfSupply: tierAtLeast(tier, "pro") ? valuation?.months_of_supply ?? null : null,
    },

    salesCount: valuation?.sales_count ?? sales.length,
    sales: visibleSales.map((s) => serializeSale(s, tier)),
  };
}

module.exports = { serializeCarSummary, serializeCarDetail, tierAtLeast, TIERS };
