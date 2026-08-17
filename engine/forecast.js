// [V] VERIFIED — ground truth §4.7, reproduced verbatim.
//
// CORRECTION LOG — two pieces were missing from the previous version of this file:
//   1. The collectibility FLOOR applied to the age factor (`v`) after it is computed.
//      Without it, a 2-year-old collectible got the full -10% age drag instead of being
//      floored at -3%, which materially understated near-term forecasts for exactly the
//      cars the product exists to track.
//   2. The extra brake on falling cars — for depreciating/approaching signals with a trend
//      at or below -3%, the blended rate is capped at a fraction of the raw trend. Without
//      it, the collectibility clamp (floor -6% for a 8+ collectible) could hand a sharply
//      falling car a far more optimistic forecast than its own trend supports.

const { clamp } = require("./constants");

// h=collectibility, t=value/msrp ratio, x=age
function componentRates({ collectibility: h, age: x, msrpRatio: t, signal }) {
  const u = (h - 5) * 0.01;

  // msrpRatio may be unknown (no MSRP on file for vintage/one-off cars). Verbatim assumes
  // a number; returning 0 is our own neutral fallback so a missing MSRP contributes nothing
  // rather than silently landing in the `else .01` bucket.
  const y = t == null ? 0
    : t > 2 ? 0.03
    : t > 1.2 ? 0.02
    : t > 0.8 ? -0.01
    : t > 0.5 ? -0.02 : 0.01;

  let v = x <= 2 ? -0.1 : x <= 5 ? -0.06 : x <= 10 ? -0.02 : x <= 20 ? 0.01 : x <= 35 ? 0.03 : 0.04;

  // [V] collectibility raises the floor of the age factor
  if (x > 6) {
    if (h >= 8) v = Math.max(v, 0.02);
    else if (h >= 6) v = Math.max(v, -0.02);
  } else {
    if (h >= 8) v = Math.max(v, -0.03);
    else if (h >= 6) v = Math.max(v, -0.04);
  }

  const m = { appreciating: 0.02, bottomed: 0.03, approaching: 0.01, depreciating: -0.02 }[signal] ?? 0;

  return { collectFactor: u, msrpFactor: y, ageFactor: v, signalFactor: m };
}

// Blend weights change with data density — the single most copy-worthy idea in the system.
function regimeWeights({ signal, n, rSquared }) {
  if (signal === "depreciating" || signal === "appreciating") return { trend: 0.65, collect: 0.13, age: 0.12, msrp: 0.06, signal: 0.04 };
  if (signal === "approaching") return { trend: 0.55, collect: 0.15, age: 0.13, msrp: 0.10, signal: 0.07 };
  if (n >= 25 && rSquared > 0.5) return { trend: 0.50, collect: 0.20, age: 0.10, msrp: 0.10, signal: 0.10 };
  if (n >= 10) return { trend: 0.35, collect: 0.25, age: 0.15, msrp: 0.15, signal: 0.10 };
  return { trend: 0.20, collect: 0.30, age: 0.25, msrp: 0.15, signal: 0.10 };
}

function blendedRate({ trendRate: g, collectibility: h, age: x, msrpRatio, signal, n, rSquared }) {
  const w = regimeWeights({ signal, n, rSquared });
  const r = componentRates({ collectibility: h, age: x, msrpRatio, signal });

  let c = w.trend * g + w.collect * r.collectFactor + w.age * r.ageFactor + w.msrp * r.msrpFactor + w.signal * r.signalFactor;

  // [V] clamp by collectibility
  const lo = h >= 8 ? -0.06 : h >= 6 ? -0.1 : -0.15;
  const hi = h >= 9 ? 0.14 : h >= 7 ? 0.12 : h >= 5 ? 0.1 : 0.08;
  c = Math.max(lo, Math.min(hi, c));

  // [V] extra brake on falling cars — applied AFTER the clamp, so it can push below the
  // collectibility floor. Verbatim order.
  if ((signal === "depreciating" || signal === "approaching") && g <= -0.03) {
    const factor = signal === "approaching" ? 0.34 : (x <= 5 ? 0.65 : 0.5);
    c = Math.min(c, factor * g);
  }

  // [V] annual dampening
  let j = h >= 9 ? 0.94 : h >= 7 ? 0.9 : h >= 5 ? 0.85 : 0.82;
  if (c < -0.05) {
    const e = Math.abs(c);
    j = e >= 0.12 ? 0.62 : e >= 0.08 ? 0.7 : 0.78;
  }

  return { rate: c, damp: j };
}

function projectYears(currentValue, rate, damp, years, floor) {
  let value = currentValue;
  let yearRate = rate;
  for (let y = 0; y < years; y++) {
    value = Math.max(floor, value * (1 + yearRate));
    yearRate *= damp;
  }
  return Math.round(value);
}

// [I] INFERRED — ground truth §4.7 describes this narratively ("a quarterly simulation
// (4 steps/yr) that decays the rate, detects when the fall flattens, records that quarter
// as the estimated bottom, then recovers at ~1.5%/yr toward 60% of the gap back to current")
// but gives no exact stopping threshold. QUARTER_STOP_THRESHOLD below is our choice.
function simulateDecline(currentValue, rate, damp, floor, horizonYears = 5) {
  if (rate >= 0) return { bottomValue: null, bottomYears: null, status: "not_declining", recovered: null };

  const QUARTER_STOP_THRESHOLD = 0.005;
  const maxQuarters = horizonYears * 4;
  let value = currentValue;
  let quarterRate = rate / 4;

  for (let q = 1; q <= maxQuarters; q++) {
    const next = Math.max(floor, value * (1 + quarterRate));
    const flattened = Math.abs(next - value) / value < QUARTER_STOP_THRESHOLD;
    if (flattened || next <= floor) {
      const bottomYears = Math.round((q / 4) * 10) / 10;
      // recovery: ~1.5%/yr toward 60% of the gap back to current
      const remainingYears = Math.max(0, horizonYears - bottomYears);
      const gap = currentValue - next;
      const recoveryCap = next + 0.6 * gap;
      const recovered = Math.min(recoveryCap, next * Math.pow(1.015, remainingYears));
      return {
        bottomValue: Math.round(next),
        bottomYears,
        status: next <= floor ? "floor_reached" : "flattened",
        recovered: Math.round(recovered),
      };
    }
    value = next;
    quarterRate *= Math.pow(damp, 0.25); // damp is annual; take its quarterly root
  }
  return { bottomValue: Math.round(value), bottomYears: horizonYears, status: "did_not_converge", recovered: null };
}

function computeForecast(ctx) {
  const { rate, damp } = blendedRate(ctx);
  const floor = Math.round(0.4 * ctx.currentValue);

  const f1 = projectYears(ctx.currentValue, rate, damp, 1, floor);
  const f3 = projectYears(ctx.currentValue, rate, damp, 3, floor);
  const f5 = projectYears(ctx.currentValue, rate, damp, 5, floor);

  // [V] bear/bull bands widen as confidence falls
  const C = Math.max(0.15, 1 - ctx.confidence);
  const bear3 = Math.round(Math.max(floor, f3 * (0.92 - 0.15 * C)));
  const bull3 = Math.round(f3 * (1.10 + 0.18 * C));
  const bear5 = Math.round(Math.max(floor, f5 * (0.88 - 0.22 * C)));
  const bull5 = Math.round(f5 * (1.15 + 0.28 * C));

  const decline = simulateDecline(ctx.currentValue, rate, damp, floor);

  return {
    forecast1y: f1, forecast3y: f3, forecast5y: f5,
    bear3y: bear3, bull3y: bull3, bear5y: bear5, bull5y: bull5,
    blendedRate: rate, damp, floor,
    estimatedBottomValue: decline.bottomValue,
    estimatedBottomYears: decline.bottomYears,
    estimatedBottomStatus: decline.status,
    estimatedRecoveryValue: decline.recovered,
  };
}

module.exports = { computeForecast, componentRates, regimeWeights, blendedRate, projectYears, simulateDecline };
