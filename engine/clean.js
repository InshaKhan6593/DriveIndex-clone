// [V] clean-sale predicate (ground truth §4.13) + [U] outlier detector — the detector runs
// server-side and is explicitly NOT established (§9: "no iqr, mad, slope anywhere in the
// client bundle"). What follows is our own construction, not theirs.

const { median, mad } = require("./stats");
const { mileageAdjust } = require("./mileage");

// [V] the fuller of the two forms in their bundle:
//   h = g.filter(e => !e.isOutlier && !e.carfaxDamage && !e.nonUsSale && !e.reserveNotMet)
// plus the currency guard from the other call site.
//
// ⚠️ THE CURRENCY GUARD WAS THEIR DEFECT #1. They ingest 10 currencies and compute on 1,
// silently dropping every EUR/GBP/CHF/JPY sale from the maths while still DISPLAYING it.
//
// FIXED 2026-08-18, as the comment that stood here specified: price_usd is now populated at
// ingest from the ECB reference rate FOR THE DAY THE LOT SOLD (fx/convert.js), so the test is
// "can this price be compared at all", i.e. is price_usd present — not "is it already dollars".
// `dropNonUsd` therefore defaults to false; passing true restores the old currency test for
// conformance testing against their bundle.
//
// THE TWO GATES ARE INDEPENDENT, AND ONLY THE CURRENCY ONE WAS A DEFECT.
//   price_usd    — "is this price comparable at all"   (fixed above)
//   non_us_sale  — "did it sell in the US"             (deliberately kept, see below)
//
// DECISION 2026-08-18: this stays a US-MARKET INDEX, matching their [V] predicate. A Paris or
// London result is a different buyer pool, tax treatment and fee structure, so it is excluded
// on purpose rather than by accident. Measured cost of that choice, so it is an informed one:
// 8,193 priced, comparable, real sales sit out (bon 3,888, bat 3,158, rms 900, good 145,
// broadarrow 102), 433 cars would otherwise cross 3+ clean sales, and 4,237 cars that report
// "insufficient" today do have priced overseas sales behind them.
//
// Note the flag is NOT a currency proxy — 5,606 USD-denominated sales are flagged non-US from
// real country data, and Bonhams alone has 33 lots sold in the UAE in dollars. Adapters that
// still derive it from currency alone (broadarrow, gooding, sms) are wrong in both directions
// and should read a country field where the source provides one, as bat and bon now do.
//
// Fixing the currency half is still what makes those overseas prices *correct* wherever they
// are shown or compared — the sale list, cross-currency deal scoring, and any future global
// basis — rather than displayed as evidence and silently ignored, which was the actual defect.
function isClean(sale, { dropNonUsd = false } = {}) {
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
