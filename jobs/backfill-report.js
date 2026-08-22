// Print the ingested sale coverage for a bounded historical backfill.
// This reports what the pipeline has, not an invented estimate of what a source may contain.
"use strict";

const { DatabaseSync } = require("node:sqlite");

const from = process.env.SCRAPE_FROM_DATE || "2024-01-01";
const to = process.env.SCRAPE_TO_DATE || "2026-08-22";
const endExclusive = `${to}T23:59:59.999Z`;
const db = new DatabaseSync("data/driveindex.sqlite", { readOnly: true });
const sources = [
  ["bat", "BaT"], ["cab", "Cars & Bids"], ["mecum", "Mecum"],
  ["rms", "RM Sotheby's"], ["bon", "Bonhams"], ["good", "Gooding"],
  ["sms", "Sotheby's Motorsport"], ["broadarrow", "Broad Arrow"],
  ["bj", "Barrett-Jackson"], ["hagerty", "Hagerty"], ["dupont", "DuPont Registry"],
];

const rows = db.prepare(`
  SELECT source, substr(sold_at, 1, 4) AS year, COUNT(*) AS lots
  FROM sale
  WHERE sold_at >= ? AND sold_at <= ?
  GROUP BY source, year
`).all(`${from}T00:00:00.000Z`, endExclusive);
const byKey = new Map(rows.map((row) => [`${row.source}|${row.year}`, Number(row.lots)]));

console.log(`## Backfill coverage: ${from} through ${to}`);
console.log("");
console.log("| Source | 2024 | 2025 | 2026 | Total |");
console.log("|---|---:|---:|---:|---:|");
let grand = 0;
for (const [key, label] of sources) {
  const values = [2024, 2025, 2026].map((year) => byKey.get(`${key}|${year}`) || 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  grand += total;
  console.log(`| ${label} | ${values[0].toLocaleString()} | ${values[1].toLocaleString()} | ${values[2].toLocaleString()} | ${total.toLocaleString()} |`);
}
console.log(`| **Total** |  |  |  | **${grand.toLocaleString()}** |`);
console.log("");
console.log("Counts are ingested sold lots. Zero means this database has no accepted sale row yet; it does not prove the auction house has no records.");
