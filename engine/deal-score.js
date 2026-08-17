// VERIFIED — build spec §8.2, reproduced exactly. An ask exactly at fair value scores 55;
// every 1% below fair value adds 2.5 points; a 10% discount scores 80, a 10% premium scores 30.

const { clamp } = require("./constants");
const { mileageAdjust } = require("./mileage");

function dealScore(askPrice, askMiles, avgMileage, collectibility, age, baseValue) {
  const fairValue = mileageAdjust(baseValue, askMiles, avgMileage, collectibility, age);
  const diff = (askPrice - fairValue) / fairValue;
  const score = clamp(Math.round(55 - 250 * diff), 5, 98);
  return { score, fairValue, diffPct: diff };
}

module.exports = { dealScore };
