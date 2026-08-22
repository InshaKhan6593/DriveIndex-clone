"use strict";

const { mileageAdjust } = require("./mileage");

/**
 * Re-price one owned vehicle using the same mileage curve used by the public re-pricer.
 * `car` and `valuation` are intentionally small joined rows so this helper can be shared by
 * the API and the daily snapshot job without either layer reimplementing valuation math.
 */
function valueAtMileage(car, valuation, currentMileage) {
  if (valuation?.current_value == null) return null;

  const baseValue = Number(valuation.current_value);
  const avgMileage = Number(valuation.avg_mileage ?? currentMileage ?? 50000);
  const mileage = Number(currentMileage ?? avgMileage);
  const age = Math.max(0, new Date().getFullYear() - Number(car.year));

  return {
    value: mileageAdjust(
      baseValue,
      mileage,
      avgMileage,
      valuation.collectibility_score ?? null,
      age,
    ),
    baseValue,
    mileageUsed: Math.round(mileage),
    avgMileage: Math.round(avgMileage),
  };
}

function portfolioGain(marketValue, purchasePrice, fees = 0) {
  if (marketValue == null || purchasePrice == null) return { gain: null, returnPct: null, cost: null };
  const cost = Number(purchasePrice) + Number(fees || 0);
  const gain = Number(marketValue) - cost;
  return {
    gain,
    cost,
    returnPct: cost > 0 ? gain / cost : null,
  };
}

module.exports = { valueAtMileage, portfolioGain };
