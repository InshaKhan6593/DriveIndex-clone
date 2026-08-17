// HOW CURRENT IS THE DATA?
//
// A price index that is a week stale gives yesterday's answer with today's confidence. This
// reports the most recent sale per source, in the DATABASE and in the raw harvest files
// (which run ahead of the DB between ingests), plus how much of the recent window we hold.
//
// Usage: node validation/freshness.js
"use strict";

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.join(__dirname, "..");
const db = new DatabaseSync(path.join(ROOT, "data", "driveindex.sqlite"));
const all = (s) => db.prepare(s).all();

const today = new Date();
const daysAgo = (iso) => ((today - new Date(iso)) / 86400000).toFixed(1);

console.log(`today: ${today.toISOString().slice(0, 10)}\n`);

console.log("=== IN THE DATABASE ===");
console.log(`  ${"source".padEnd(8)} ${"sales".padStart(7)}  ${"newest sale".padEnd(12)} ${"days old".padStart(9)}`);
for (const r of all(`SELECT source, COUNT(*) n, MAX(date(sold_at)) newest FROM sale GROUP BY source ORDER BY n DESC`))
  console.log(`  ${r.source.padEnd(8)} ${String(r.n).padStart(7)}  ${r.newest.padEnd(12)} ${daysAgo(r.newest).padStart(9)}`);

console.log("\n=== IN THE RAW HARVEST FILES (ahead of the DB between ingests) ===");
const FILES = [
  ["bat", "samples/scraped/bat-partitioned.json"],
  ["cab", "samples/scraped/cars-and-bids.json"],
  ["rms", "samples/scraped/rms.json"],
  ["mecum", "samples/scraped/mecum.json"],
];
for (const [code, rel] of FILES) {
  try {
    const recs = JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
    const dates = recs.map((r) => String(r.sold_at).slice(0, 10)).filter(Boolean).sort();
    const newest = dates[dates.length - 1];
    console.log(`  ${code.padEnd(8)} ${String(recs.length).padStart(7)}  ${newest.padEnd(12)} ${daysAgo(newest).padStart(9)}`);
  } catch { console.log(`  ${code.padEnd(8)} (no file)`); }
}

console.log("\n=== RECENT WINDOW: sales per day, last 14 days ===");
for (const r of all(`
  SELECT date(sold_at) d, COUNT(*) n FROM sale
  WHERE date(sold_at) >= date('now','-14 day') GROUP BY 1 ORDER BY 1 DESC`))
  console.log(`  ${r.d}  ${String(r.n).padStart(4)}  ${"#".repeat(Math.min(r.n, 50))}`);

console.log("\n=== WHY A GAP EXISTS AT ALL ===");
console.log("  Auctions close continuously, so 'today' is never complete — a sale ending this");
console.log("  evening cannot be in a harvest that ran this morning. A 1-2 day lag is the");
console.log("  NORMAL state of a daily-cron price index, not staleness.");
console.log("  What would be staleness: the newest sale drifting past ~3 days, which means a");
console.log("  cron tick failed silently. That is what jobs/cron.js --status is for.");
