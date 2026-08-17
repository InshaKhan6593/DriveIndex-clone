// [V] VERIFIED — ground truth §4.4, reproduced verbatim.
//
//   let m=[[25e3,.1],[75e3,0],[15e4,.075],[35e4,.045],[5e5,.09]];
//   function b(e){ /* linear interpolation, clamped at both ends */ }
//
// ⚠️ THE BREAKPOINTS ARE DOLLARS, NOT MILES. The call site is b(adjustedValue) — the
// argument is a PRICE. A $25k car carries a 10%/yr baseline depreciation, a $75k car ~0%,
// rising again for six-figure cars.
//
// CORRECTION LOG: an earlier version of this file (engine/mileage.js, since fixed) had this
// table named MILEAGE_CURVE and took `miles` as its argument — precisely the misreading the
// ground truth warns about. It produced a ~0% baseline for any car with 25k–75k miles
// regardless of value, and a 9% baseline for genuinely high-mileage cars that should have
// been near-flat. Fixed here; the table now takes a dollar value.

const PRICE_BANDS = [
  [25000, 0.100],
  [75000, 0.000],
  [150000, 0.075],
  [350000, 0.045],
  [500000, 0.090],
];

/**
 * Baseline annual depreciation rate for a car at a given DOLLAR value.
 * Linear interpolation between breakpoints, clamped at both ends.
 * @param {number} value - the car's value in USD (NOT its mileage)
 */
function baselineDepreciationForValue(value) {
  if (!Number.isFinite(value)) return 0;
  if (value <= PRICE_BANDS[0][0]) return PRICE_BANDS[0][1];
  const last = PRICE_BANDS[PRICE_BANDS.length - 1];
  if (value >= last[0]) return last[1];
  for (let i = 0; i < PRICE_BANDS.length - 1; i++) {
    const [x0, y0] = PRICE_BANDS[i];
    const [x1, y1] = PRICE_BANDS[i + 1];
    if (value >= x0 && value <= x1) {
      const t = (value - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return last[1];
}

module.exports = { PRICE_BANDS, baselineDepreciationForValue };
