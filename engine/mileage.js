// [V] VERIFIED — ground truth §4.5, function j(), reproduced verbatim.
//
//   function j(e,t,r,n,i){    // e=value t=miles r=avgMiles n=collectibility i=age
//
// NOTE: the price-band table that used to live in this file has moved to
// engine/depreciation.js, where it belongs — it is indexed by DOLLARS, not miles (§4.4).
// Keeping it here under the name MILEAGE_CURVE was a misreading; see that file's
// correction log.

const { clamp } = require("./constants");

/**
 * @param {number} value  - base value to adjust
 * @param {number} miles  - this specific car's mileage
 * @param {number} avgMiles - the model's average mileage
 * @param {number} collectibility - 1..10 (undefined => neutral 1.0 multiplier, per verbatim)
 * @param {number} age    - years old (undefined => no age amplification)
 */
function mileageAdjust(value, miles, avgMiles, collectibility, age) {
  const o = (miles - avgMiles) / Math.max(avgMiles, 5000);
  const l = Math.abs(o);

  // s: collectibility multiplier. Verbatim defaults to 1 when collectibility is undefined.
  let s = 1;
  if (collectibility !== undefined && collectibility !== null) {
    s = collectibility >= 9 ? 1.5 : collectibility >= 7 ? 1.2 : collectibility >= 5 ? 1 : 0.7;
  }

  // d: age amplifier, applied ONLY on the below-average-mileage branch (verbatim: the
  // assignment is guarded by `o<0`).
  let d = 1;
  if (age !== undefined && age !== null && o < 0) {
    d = age >= 30 ? 1.5 : age >= 20 ? 1.3 : age >= 10 ? 1.1 : 1;
  }

  let a;
  if (o < 0) {
    // BELOW average mileage -> premium
    if (l < 0.15) a = 0.05 * l * s;
    else if (l < 0.4) a = 0.0075 + (l - 0.15) * 0.15 * s;
    else if (l < 0.7) a = (0.045 + (l - 0.4) * 0.3 * s) * d;
    else {
      a = (0.135 + (l - 0.7) * 0.6 * s) * d;
      if (miles <= 500) a *= 1.25;        // delivery-mileage premium
      else if (miles <= 1000) a *= 1.1;
    }
  } else {
    // ABOVE average mileage -> discount
    const e = s >= 1.5 ? 0.8 : s >= 1.2 ? 0.9 : 1;
    if (l < 0.25) a = -(0.02 * l * e);
    else if (l < 0.75) a = -(0.005 + (l - 0.25) * 0.05 * e);
    else if (l < 2) a = -(0.03 + (l - 0.75) * 0.08);
    else a = -(0.13 + (l - 2) * 0.1);
  }

  const lo = -(collectibility >= 9 ? 0.3 : collectibility >= 7 ? 0.25 : 0.3);
  const hi = collectibility >= 9 ? 0.45 : collectibility >= 7 ? 0.3 : collectibility >= 5 ? 0.2 : 0.15;
  a = clamp(a, lo, hi);

  return Math.round(value * (1 + a));
}

module.exports = { mileageAdjust };
