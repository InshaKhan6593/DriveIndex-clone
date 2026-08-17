// VERIFIED — reproduced from the DriveIndex client bundle (build spec §7.4) exactly,
// including the two "honesty caps" that stop a thin/volatile sample from reading as "high".

const { clamp } = require("./constants");

function confidence(n, rSquared, volatility) {
  const sample = n >= 20 ? 1.0 : n >= 12 ? 0.8 : n >= 8 ? 0.6 : n >= 5 ? 0.4 : n >= 3 ? 0.2 : 0;
  const fit = clamp((rSquared - 0.10) / 0.35, 0, 1);
  const vol = volatility <= 0 ? 0.50
    : volatility <= 0.18 ? 1.00
    : volatility <= 0.28 ? 0.75
    : volatility <= 0.40 ? 0.50
    : volatility <= 0.55 ? 0.25 : 0;

  const score = 0.40 * sample + 0.35 * fit + 0.25 * vol;
  let level = score >= 0.62 ? "high" : score >= 0.36 ? "moderate" : "low";

  if (level === "high" && (n < 12 || volatility > 0.40)) level = "moderate";
  if (n < 4) level = "low";

  return { level, score };
}

module.exports = { confidence };
