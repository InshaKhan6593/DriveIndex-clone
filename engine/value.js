// INFERRED — build spec §7.2: DriveIndex's methodology page states the method in prose
// ("normalise each clean sale to typical mileage, then aggregate with a robust estimator,
// recency-weighted") but the estimator itself is not exposed. This implements exactly what
// the spec says it reproduces closely: recency-weighted mileage-normalized prices, trimmed
// mean. Treat the exact output as an approximation of DriveIndex's own number, not a parity
// guarantee — there was no verbatim formula to copy here.

const { mileageAdjust } = require("./mileage");
const { trimmedMean, median } = require("./stats");

const RECENCY_HALFLIFE_DAYS = 365; // weight halves every year — not spec-confirmed, a reasonable default

function daysAgo(isoDate) {
  return (Date.now() - new Date(isoDate).getTime()) / 86400000;
}

/**
 * @param {object[]} cleanSales - clean_sale objects, each with price_usd, mileage, sold_at
 * @param {{ avgMiles: number, collectibility: number, age: number }} ctx
 * @returns {{ currentValue: number|null, medianPrice: number|null, priceLow: number|null, priceHigh: number|null }}
 */
function computeCurrentValue(cleanSales, ctx) {
  if (cleanSales.length === 0) return { currentValue: null, medianPrice: null, priceLow: null, priceHigh: null };

  const normalizedPrices = cleanSales.map((s) =>
    mileageAdjust(s.price_usd ?? s.price, s.mileage ?? ctx.avgMiles, ctx.avgMiles, ctx.collectibility, ctx.age)
  );

  // Recency weighting: repeat each price proportional to its recency weight (rounded),
  // rather than a true weighted trimmed mean (which trimmed-mean doesn't natively support) —
  // simple, and correct enough for small samples where this whole engine already gates on n.
  const weighted = [];
  cleanSales.forEach((s, i) => {
    const weight = Math.pow(0.5, daysAgo(s.sold_at) / RECENCY_HALFLIFE_DAYS);
    const repeats = Math.max(1, Math.round(weight * 10));
    for (let r = 0; r < repeats; r++) weighted.push(normalizedPrices[i]);
  });

  const currentValue = Math.round(trimmedMean(weighted, cleanSales.length >= 8 ? 0.1 : 0));
  const rawPrices = cleanSales.map((s) => s.price_usd ?? s.price);
  const medianPrice = Math.round(median(rawPrices));
  const sorted = [...normalizedPrices].sort((a, b) => a - b);

  return {
    currentValue,
    medianPrice,
    priceLow: sorted[0],
    priceHigh: sorted[sorted.length - 1],
  };
}

module.exports = { computeCurrentValue };
