// Downloads the ECB's daily euro reference rates and writes them to data/fx-rates.json.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────
// engine/clean.js excluded every non-USD sale from the maths ("their defect #1, reproduced
// here only behind a flag") because there was no way to compare a £400,000 hammer to a
// $400,000 one. Measured across the corpus: 7,468 sold lots blocked — 2.84% overall, but
// 60.8% of Bonhams, 28.3% of RM Sotheby's and 27.7% of Broad Arrow, i.e. concentrated in
// exactly the international houses that sell the expensive cars.
//
// ── WHY THE RATE ON sold_at, NOT TODAY'S RATE ──────────────────────────────────────────
// A 2019 London sale converted at a 2026 rate is not that sale's price in dollars — GBP/USD
// has moved by double digits over that span, which would inject pure FX noise into every
// trend fitted through a mixed-currency car. The rate must be the one that applied on the day
// the hammer fell, so the whole daily series is stored rather than a single snapshot.
//
// ── WHY ECB ────────────────────────────────────────────────────────────────────────────
// Published reference rates, free, no key, no rate limit, documented for reuse, and they go
// back to 1999 — comfortably before this corpus starts in 2014. The series is EUR-based
// (units of X per 1 EUR), so a cross rate is derived: X -> USD = (1 / rate_X) * rate_USD.
//
// Rates are published on TARGET business days only, so there is no entry for weekends or
// holidays. fx/convert.js walks backwards for the most recent prior business day, which is
// the ordinary convention for valuing a transaction dated on a non-trading day.
//
// Usage:  node fx/fetch-ecb-rates.js
"use strict";

const fs = require("fs");
const path = require("path");

// Everything this corpus has traded in, plus the majors an auction house is likely to add.
const CURRENCIES = ["USD", "GBP", "CHF", "AUD", "HKD", "JPY", "CAD", "SEK", "DKK", "NOK", "NZD", "SGD", "PLN", "CZK"];
const START = "2013-01-01"; // corpus starts 2014; a year of headroom costs nothing
const OUT = path.join(__dirname, "..", "data", "fx-rates.json");

const URL =
  `https://data-api.ecb.europa.eu/service/data/EXR/D.${CURRENCIES.join("+")}.EUR.SP00.A` +
  `?format=csvdata&startPeriod=${START}`;

async function main() {
  console.log(`fetching ${CURRENCIES.length} currencies from the ECB since ${START} ...`);
  const res = await fetch(URL, {
    headers: { "User-Agent": "driveindex-pipeline/1.0", Accept: "text/csv" },
    redirect: "follow",
    signal: AbortSignal.timeout(120000),
  });
  if (res.status !== 200) throw new Error(`ECB returned HTTP ${res.status}`);
  const csv = await res.text();

  const lines = csv.split("\n");
  const header = lines[0].split(",");
  const iCur = header.indexOf("CURRENCY");
  const iDate = header.indexOf("TIME_PERIOD");
  const iVal = header.indexOf("OBS_VALUE");
  if (iCur < 0 || iDate < 0 || iVal < 0) throw new Error("unexpected CSV shape from the ECB");

  // { "2019-04-01": { USD: 1.1226, GBP: 0.8597, ... } }
  const byDate = {};
  let rows = 0;
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(",");
    if (f.length < iVal + 1) continue;
    const cur = f[iCur], date = f[iDate], val = Number(f[iVal]);
    if (!cur || !date || !Number.isFinite(val) || val <= 0) continue;
    (byDate[date] = byDate[date] || {})[cur] = val;
    rows++;
  }

  const dates = Object.keys(byDate).sort();
  if (!dates.length) throw new Error("no usable rows parsed");

  // A day without USD cannot produce a USD cross rate, so it is not a usable day.
  const usable = dates.filter((d) => byDate[d].USD);
  const out = { source: "ECB euro reference rates", base: "EUR", fetched_at: new Date().toISOString(), rates: {} };
  for (const d of usable) out.rates[d] = byDate[d];

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`  ${rows} observations -> ${usable.length} business days`);
  console.log(`  range: ${usable[0]} .. ${usable[usable.length - 1]}`);
  console.log(`  currencies: ${[...new Set(usable.flatMap((d) => Object.keys(byDate[d])))].sort().join(", ")}`);
  console.log(`Wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
