// Orchestrator each crawler calls after scraping a batch. Runs both layers and prints one
// clear report. This is the thing that should gate whether a scrape's output is trusted
// enough to feed into the nightly compute job (build spec §6) — a batch with DRIFT_DETECTED
// or a high invalid-record rate should be held for review, not silently ingested.

const { validateRecord } = require("./validate-record");
const { checkDrift } = require("./drift-detector");

function runHealthCheck(source, records, opts = {}) {
  const perRecord = records.map((r) => ({ record: r, ...validateRecord(r) }));
  const invalid = perRecord.filter((r) => !r.valid);
  const withWarnings = perRecord.filter((r) => r.valid && r.warnings.length > 0);

  const drift = checkDrift(source, records, opts);

  const report = {
    source,
    recordCount: records.length,
    invalidCount: invalid.length,
    warningCount: withWarnings.length,
    invalid,
    withWarnings,
    drift,
    overallStatus: invalid.length > 0 || drift.status === "DRIFT_DETECTED" ? "NEEDS_REVIEW" : drift.status === "BASELINE_ESTABLISHED" ? "BASELINE_ESTABLISHED" : "OK",
  };

  printReport(report);
  return report;
}

function printReport(report) {
  const bar = "=".repeat(60);
  console.log(`\n${bar}\nHEALTH CHECK — ${report.source} — ${report.recordCount} records\n${bar}`);

  if (report.invalidCount > 0) {
    console.log(`\n✗ ${report.invalidCount} INVALID record(s):`);
    for (const r of report.invalid) {
      console.log(`  - ${r.record.source_lot_id || "(no id)"}: ${r.errors.join("; ")}`);
    }
  }

  if (report.warningCount > 0) {
    console.log(`\n⚠ ${report.warningCount} record(s) with warnings (not blocking):`);
    for (const r of report.withWarnings) {
      console.log(`  - ${r.record.source_lot_id || "(no id)"}: ${r.warnings.join("; ")}`);
    }
  }

  if (report.drift.status === "BASELINE_ESTABLISHED") {
    console.log(`\n○ No baseline existed for "${report.source}" — this run's field-population rates were saved as the new baseline:`);
    for (const [field, rate] of Object.entries(report.drift.current)) {
      console.log(`    ${field}: ${rate == null ? "n/a" : (rate * 100).toFixed(0) + "%"}`);
    }
  } else if (report.drift.status === "DRIFT_DETECTED") {
    console.log(`\n✗ DRIFT DETECTED vs baseline:`);
    for (const w of report.drift.warnings) console.log(`  - ${w}`);
  } else {
    console.log(`\n✓ No drift vs baseline (n=${report.drift.baselineSampleSize}).`);
  }

  console.log(`\nOVERALL: ${report.overallStatus}\n${bar}\n`);
}

module.exports = { runHealthCheck };
