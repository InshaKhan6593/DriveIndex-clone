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
  // `status` is NOT optional detail — without it the client cannot tell a completed sale from
  // a reserve-not-met high bid, and will render a failed auction as a sold price. (That is
  // exactly what happened: one Porsche detail page listed 20 "sales" of which 6 were
  // reserve_not_met.) Enum per db/schema.sql: sold | sold_after | reserve_not_met.
  const base = { date: sale.sold_at, mileage: sale.mileage, status: sale.status ?? "sold" };
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
    bodyType: car.body_type ?? null,
    generation: car.generation ?? null,
    imageUrl: car.image_url ?? null,
    currentValue: valuation?.current_value ?? null,
    salesCount: valuation?.sales_count ?? 0,
    listingsCount: car.listings_count ?? 0,
    signal: tierAtLeast(tier, "pro") ? valuation?.signal ?? null : null,
    confidence: tierAtLeast(tier, "pro") ? valuation?.confidence ?? null : null,
    soldGated: !tierAtLeast(tier, "pro"),
  };
}

function serializeListing(listing, tier) {
  const base = { firstSeen: listing.first_seen_at, mileage: listing.mileage };
  if (!tierAtLeast(tier, "pro")) {
    return { ...base, price: null, source: null, url: null };
  }
  return { ...base, price: listing.price, currency: listing.currency, source: listing.source, url: listing.url };
}

function serializeCarDetail(car, valuation, sales, tier, listings = [], fallbackImage = null) {
  const sortedSales = [...sales].sort((a, b) => new Date(b.sold_at) - new Date(a.sold_at));
  const visibleSales = tierAtLeast(tier, "pro") ? sortedSales : sortedSales.slice(0, 5);
  const activeListings = listings.filter((l) => l.is_active);

  return {
    id: car.id,
    year: car.year,
    make: car.make,
    model: car.model,
    bodyType: car.body_type ?? null,
    generation: car.generation ?? null,
    imageUrl: car.image_url ?? fallbackImage,
    // Structured specs — currently 0% populated across the catalogue by any adapter (no
    // source publishes them in a form we've parsed yet). Left in the shape rather than
    // omitted so the frontend can distinguish "not on file" from "field doesn't exist",
    // and so this stops being a manual wiring job the day an adapter starts filling them in.
    hp: car.hp ?? null,
    zeroSixty: car.zero_sixty ?? null,
    production: car.production ?? null,
    msrp: car.msrp,
    soldGated: !tierAtLeast(tier, "pro"),

    currentValue: valuation?.current_value ?? null,
    medianPrice: valuation?.median_price ?? null,
    retainedValue: valuation?.retained_value ?? null,

    // WHERE THIS NUMBER CAME FROM. 91.1% of cars have one or two sales in existence, so a
    // model-year that cannot speak for itself is valued from its model line instead (year ±2,
    // see jobs/nightly-compute.js). That is only defensible if it is VISIBLE: a reader must be
    // able to tell "47 sales of this exact car" from "47 sales of 1963-1967, this year had two".
    // Never gated by tier — provenance is not a paid feature, it is what makes the number
    // honest, and hiding it would leave free users with a borrowed figure they cannot question.
    valuationBasis: valuation?.signal_scope
      ? {
          scope: valuation.signal_scope, // 'own' | 'own-price/window-trend' | 'model-window'
          fromYear: valuation.scope_from ?? null,
          toYear: valuation.scope_to ?? null,
          salesInScope: valuation.scope_n ?? null,
          // A plain sentence the UI can render as-is rather than re-deriving the wording.
          note:
            valuation.signal_scope === "own"
              ? null
              : valuation.signal_scope === "own-price/window-trend"
                ? `Price from this car's own sales; trend from ${valuation.scope_from}–${valuation.scope_to} (${valuation.scope_n} sales)`
                : `Based on ${valuation.scope_from}–${valuation.scope_to} (${valuation.scope_n} sales) — too few sales of this exact year`,
        }
      : null,

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

    listingsCount: activeListings.length,
    listings: activeListings.map((l) => serializeListing(l, tier)),
  };
}

module.exports = { serializeCarSummary, serializeCarDetail, serializeListing, tierAtLeast, TIERS };
