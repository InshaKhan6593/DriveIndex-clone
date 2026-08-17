// [V] VERIFIED — ground truth §4.10, labels and copy reproduced verbatim.
//
// CORRECTION LOG: the previous version of this file was wrong in three ways, all fixed here.
//   1. Labels were invented ("Hold", "Consider Selling", "Approaching Entry"). The real
//      vocabulary is buyer-side throughout — DriveIndex never tells you to sell, it tells
//      you when to buy or wait. That is a product-positioning decision, not a detail.
//   2. The bottomed branch gated on confidence LEVEL === "high" (which requires score >=0.62
//      AND passes the honesty caps). Verbatim gates on the numeric score > 0.6.
//   3. "appreciating" collapsed to a single branch; verbatim splits it on annual return > 8%.

/**
 * @param {string} signal - one of the six enum states
 * @param {number} confidenceScore - NUMERIC confidence score 0..1 (not the level string)
 * @param {number|null} annualReturn - long-run trend rate, e.g. 0.12 for +12%/yr
 */
function buyHoldSell(signal, confidenceScore, annualReturn) {
  const conf = Number.isFinite(confidenceScore) ? confidenceScore : 0;
  const n = Number.isFinite(annualReturn) ? annualReturn : 0;

  if (signal === "bottomed" && conf > 0.6) {
    return { label: "Buy Now", copy: "Prices have bottomed — strong entry point." };
  }
  if (signal === "bottomed") {
    return { label: "Likely Entry", copy: "This call rests on thinner data — verify condition and spec, and negotiate." };
  }
  if (signal === "approaching") {
    return { label: "Wait for Better Entry", copy: "Still declining, but the fall is slowing." };
  }
  if (signal === "depreciating") {
    return { label: "Wait", copy: "Actively depreciating — waiting is cheaper than buying the decline." };
  }
  if (signal === "appreciating" && n > 0.08) {
    return { label: "Buy Now (Rising Fast)", copy: "Strong appreciation. Delaying will cost more." };
  }
  if (signal === "appreciating") {
    return { label: "Buy Soon", copy: "Prices rising. Good for long-term hold." };
  }
  if (signal === "stable") {
    return { label: "Fair Entry", copy: "Stable prices. Negotiate on spec and condition." };
  }
  if (signal === "insufficient") {
    return { label: "Watch", copy: "Not enough sold data for a timing call yet." };
  }
  return { label: "Watch Closely", copy: "Mixed signals — check back as new sales land." };
}

module.exports = { buyHoldSell };
