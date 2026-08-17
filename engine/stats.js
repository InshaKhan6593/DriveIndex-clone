// Shared statistics primitives used across the engine. Plain implementations, no dependency —
// this whole backend runs on Node's standard library plus node:sqlite by design.

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// Median Absolute Deviation, scaled by 1.4826 to be a consistent estimator of std-dev
// under normality — this is the exact scaling the build spec's outlier detector uses (§5).
function mad(values) {
  const med = median(values);
  if (med == null) return 0;
  return 1.4826 * median(values.map((v) => Math.abs(v - med)));
}

// Trimmed mean — drops the top/bottom `trimFraction` of sorted values before averaging.
// Used as the "robust estimator" for current_value (build spec §7.2 marks the real
// estimator as INFERRED, not exposed verbatim — this is the reconstruction they suggest:
// "A trimmed mean or Huber M-estimator... reproduces their published outputs closely").
function trimmedMean(values, trimFraction = 0.1) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const cut = Math.floor(sorted.length * trimFraction);
  const kept = sorted.slice(cut, sorted.length - cut || sorted.length);
  return mean(kept.length ? kept : sorted);
}

// Ordinary least squares over (x, y) pairs. x is expected pre-normalized (e.g. days since
// epoch / 365 for a roughly-unit-scaled regressor) to keep the numerics well-behaved.
// Returns slope, intercept, and R².
function linearRegression(points) {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: points[0]?.y ?? 0, rSquared: 0, n };

  const sumX = points.reduce((a, p) => a + p.x, 0);
  const sumY = points.reduce((a, p) => a + p.y, 0);
  const sumXY = points.reduce((a, p) => a + p.x * p.y, 0);
  const sumXX = points.reduce((a, p) => a + p.x * p.x, 0);
  const meanX = sumX / n;
  const meanY = sumY / n;

  const denom = sumXX - n * meanX * meanX;
  const slope = denom !== 0 ? (sumXY - n * meanX * meanY) / denom : 0;
  const intercept = meanY - slope * meanX;

  const ssTot = points.reduce((a, p) => a + (p.y - meanY) ** 2, 0);
  const ssRes = points.reduce((a, p) => a + (p.y - (slope * p.x + intercept)) ** 2, 0);
  const rSquared = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;

  return { slope, intercept, rSquared, n };
}

// Coefficient of variation of a set of (already mileage-normalized) prices — the engine's
// working definition of "volatility" / price dispersion, fed into confidence().
function volatilityOf(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  if (!m) return 0;
  const variance = mean(values.map((v) => (v - m) ** 2));
  return Math.sqrt(variance) / m;
}

module.exports = { median, mean, mad, trimmedMean, linearRegression, volatilityOf };
