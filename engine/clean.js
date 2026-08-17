// [V] clean-sale predicate (ground truth §4.13) + [U] outlier detector — the detector runs
// server-side and is explicitly NOT established (§9: "no iqr, mad, slope anywhere in the
// client bundle"). What follows is our own construction, not theirs.

const { median, mad } = require("./stats");
const { mileageAdjust } = require("./mileage");

// [V] the fuller of the two forms in their bundle:
//   h = g.filter(e => !e.isOutlier && !e.carfaxDamage && !e.nonUsSale && !e.reserveNotMet)
// plus the currency guard from the other call site.
//
// ⚠️ THE CURRENCY GUARD IS THEIR DEFECT #1, REPRODUCED HERE ONLY BEHIND A FLAG. They ingest
// 10 currencies and compute on 1, silently dropping every EUR/GBP/CHF/JPY sale from the
// maths while still DISPLAYING it. For international sources (Bonhams, Collecting Cars,
// RM's Zurich/London/Munich sales) that discards a large share of the corpus. The fix is
// price_usd populated at ingest using the FX rate on sold_at — then this predicate should
// gate on price_usd being present, NOT on currency === 'USD'.
function isClean(sale, { dropNonUsd = true } = {}) {
  const base = !sale.is_outlier
    && !sale.carfax_damage
    && !sale.non_us_sale
    && sale.status !== "reserve_not_met"
    && !sale.reserve_not_met
    && sale.price > 0;

  if (!base) return false;
  if (!dropNonUsd) return sale.price_usd != null && sale.price_usd > 0;
  return !sale.currency || sale.currency === "USD";
}

// RECOMMENDED — operates on mileage-normalized log price, never raw price (a legitimately
// low-mileage car is not an outlier). n<8: do not auto-flag, MAD is unstable at that size.
function detectOutliers(cleanSales, { avgMiles, collectibility, age }) {
  const n = cleanSales.length;
  if (n < 8) return new Set(); // too few to trust MAD

  const normalized = cleanSales.map((s) => mileageAdjust(s.price_usd ?? s.price, s.mileage ?? avgMiles, avgMiles, collectibility, age));
  const logValues = normalized.map((v) => Math.log(Math.max(v, 1)));
  const med = median(logValues);
  const madVal = mad(logValues);

  const threshold = n >= 20 ? 3.5 : 4.0;
  const outlierIds = new Set();
  cleanSales.forEach((s, i) => {
    if (madVal <= 0) return;
    const z = Math.abs(logValues[i] - med) / madVal;
    if (z > threshold) outlierIds.add(s.id);
  });
  return outlierIds;
}

module.exports = { isClean, detectOutliers };
