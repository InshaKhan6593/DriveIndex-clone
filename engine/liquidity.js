// [V] VERIFIED — ground truth §4.8, thresholds and user-facing copy reproduced verbatim.
//
//   x = clean sales in trailing 24 months
//   f = clean sales in trailing 12 months
//   b = x/2                            // annualised pace
//   S = y / Math.max(.5, b) * 12       // months of supply (y = active listings)
//   j = x < 4                          // "thin" gate

const MS_24_MONTHS = 631152e5;
const MS_12_MONTHS = 315576e5;

function computeLiquidity(cleanSales, activeListingsCount) {
  const now = Date.now();
  const x = cleanSales.filter((s) => now - new Date(s.sold_at).getTime() <= MS_24_MONTHS).length;
  const f = cleanSales.filter((s) => now - new Date(s.sold_at).getTime() <= MS_12_MONTHS).length;
  const y = activeListingsCount;

  if (x < 4) {
    return { tier: null, verdict: "THIN MARKET", copy: "Too few verified sales to gauge demand", monthsOfSupply: null, sales24mo: x, sales12mo: f, salesPerYear: null, daysBetweenSales: null };
  }

  const b = x / 2;
  const mos = (y / Math.max(0.5, b)) * 12;

  const base = {
    sales24mo: x,
    sales12mo: f,
    salesPerYear: b,
    daysBetweenSales: Math.round(730 / x),
    monthsOfSupply: mos,
  };

  if (y <= 1) {
    return { ...base, tier: "high", verdict: "TIGHT SUPPLY", copy: "this market clears mostly at auction" };
  }
  if (mos < 6) {
    return { ...base, tier: "high", verdict: "SELLER'S MARKET", copy: "demand clears inventory quickly" };
  }
  if (mos <= 18) {
    return { ...base, tier: "moderate", verdict: "BALANCED", copy: "a normal selling window" };
  }
  return { ...base, tier: "low", verdict: "BUYER'S MARKET", copy: "buyers have leverage; pricing right matters more than timing" };
}

// [V] §4.8 — retail listings only (an auction lot has no ask to cut).
function priceCutPressure(retailListings) {
  const withHistory = retailListings.filter((l) => Array.isArray(l.priceHistory) && l.priceHistory.length > 1);
  const cut = withHistory.filter((l) => {
    const first = l.priceHistory[0].price;
    const last = l.priceHistory[l.priceHistory.length - 1].price;
    return last < first;
  });

  if (retailListings.length > 2 && cut.length / retailListings.length > 0.4) {
    const cutPcts = cut.map((l) => {
      const first = l.priceHistory[0].price;
      const last = l.priceHistory[l.priceHistory.length - 1].price;
      return (first - last) / first;
    }).sort((a, b) => a - b);
    const medianCut = cutPcts[Math.floor(cutPcts.length / 2)];
    return { status: "PRICE_CUT_PRESSURE", medianCutPct: medianCut, cutCount: cut.length, total: retailListings.length };
  }
  if (retailListings.length >= 3 && cut.length === 0) {
    return { status: "ASKS_HOLDING", medianCutPct: 0, cutCount: 0, total: retailListings.length };
  }
  return { status: null, medianCutPct: null, cutCount: cut.length, total: retailListings.length };
}

module.exports = { computeLiquidity, priceCutPressure };
