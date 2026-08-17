// Batch-level drift detection. The question this answers: "the site changed its HTML and
// our selector now silently returns null for every record — how do we find out?"
//
// Per-record validation (validate-record.js) cannot catch this, because "vin_raw: null" is
// individually legal — plenty of real cars have no listed VIN. What's NOT legal is that
// field going from ~85% populated to ~0% populated between one scrape run and the next.
// That shape — one field cratering across the whole batch while everything else looks
// normal — is the signature of a broken selector, not a bad batch of listings, and it's
// exactly the bug class this session hit twice for real (Cars & Bids' spec-table selector,
// Bonhams' price-element length cap) before either one shipped.
//
// TRACKED_FIELDS is deliberately source-agnostic — every adapter in adapters/ fills these
// (some legitimately with nulls), so the same detector works unmodified for every source.

const fs = require("fs");
const path = require("path");

const BASELINE_DIR = path.join(__dirname, "baselines");
const TRACKED_FIELDS = ["price", "vin_raw", "mileage", "transmission", "sold_at"];
const DRIFT_THRESHOLD = 0.35; // absolute drop in population rate that triggers a warning

function populationRate(records, field) {
  if (records.length === 0) return null;
  const populated = records.filter((r) => r[field] != null && r[field] !== "").length;
  return populated / records.length;
}

function computeFieldPopulation(records) {
  const out = {};
  for (const field of TRACKED_FIELDS) out[field] = populationRate(records, field);
  return out;
}

function baselinePath(source) {
  return path.join(BASELINE_DIR, `${source}.json`);
}

function loadBaseline(source) {
  const p = baselinePath(source);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function saveBaseline(source, fieldPopulation, sampleSize) {
  fs.mkdirSync(BASELINE_DIR, { recursive: true });
  fs.writeFileSync(
    baselinePath(source),
    JSON.stringify({ source, updatedAt: new Date().toISOString(), sampleSize, fieldPopulation }, null, 2)
  );
}

/**
 * @param {string} source - registry code, e.g. "cab", "bat", "bon", "mecum"
 * @param {object[]} records - normalized sale records from one scrape run
 * @param {{updateBaseline?: boolean}} opts - pass updateBaseline:true only after a human
 *   has confirmed a shift is real (a source redesigning a field, not a broken selector) —
 *   never auto-update from every run, or a slow silent break would just redefine "normal"
 *   one run at a time and the detector would never fire.
 */
function checkDrift(source, records, opts = {}) {
  const current = computeFieldPopulation(records);
  const baseline = loadBaseline(source);
  const warnings = [];

  if (!baseline) {
    saveBaseline(source, current, records.length);
    return { status: "BASELINE_ESTABLISHED", source, sampleSize: records.length, current, warnings };
  }

  for (const field of TRACKED_FIELDS) {
    const cur = current[field];
    const base = baseline.fieldPopulation[field];
    if (cur == null || base == null) continue;
    const delta = base - cur;
    if (delta > DRIFT_THRESHOLD) {
      warnings.push(
        `FIELD DRIFT: "${field}" population dropped from ${(base * 100).toFixed(0)}% (baseline, n=${baseline.sampleSize}) ` +
        `to ${(cur * 100).toFixed(0)}% (this run, n=${records.length}) — likely a broken selector, not a real data change.`
      );
    }
  }

  if (records.length < baseline.sampleSize * 0.3 && records.length < 3) {
    warnings.push(`LOW YIELD: only ${records.length} records this run vs baseline sample of ${baseline.sampleSize} — check for a block/redirect before trusting field rates above.`);
  }

  if (opts.updateBaseline) saveBaseline(source, current, records.length);

  return {
    status: warnings.length ? "DRIFT_DETECTED" : "OK",
    source,
    sampleSize: records.length,
    baselineSampleSize: baseline.sampleSize,
    current,
    baseline: baseline.fieldPopulation,
    warnings,
  };
}

module.exports = { checkDrift, computeFieldPopulation, TRACKED_FIELDS, DRIFT_THRESHOLD };
