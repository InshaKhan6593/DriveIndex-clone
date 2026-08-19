// Prints what each source actually harvested, before ingest runs.
//
// The point is to make a SILENT failure visible. A crawler that gets Cloudflare-challenged, or
// blocked by a bot filter, or that finds nothing because a route changed, exits 0 and writes a
// valid empty array — the run stays green and the only symptom is that the numbers stop moving.
// Printing the record count and date range per file turns that into something you can see in the
// log the same day, rather than a week later when you notice the site is stale.
"use strict";

const fs = require("fs");
const path = require("path");

const DIRS = [
  path.join(__dirname, "..", "..", "samples", "scraped"),
  path.join(__dirname, "..", "..", "samples", "listings"),
];

let grandTotal = 0;
const empties = [];

for (const dir of DIRS) {
  if (!fs.existsSync(dir)) continue;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".state.json"));
  if (!files.length) continue;
  console.log(`\n${path.basename(dir)}/`);
  for (const f of files.sort()) {
    const full = path.join(dir, f);
    let records;
    try {
      records = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch (e) {
      console.log(`  ${f.padEnd(30)} UNREADABLE — ${e.message}`);
      continue;
    }
    if (!Array.isArray(records)) {
      console.log(`  ${f.padEnd(30)} not an array`);
      continue;
    }
    grandTotal += records.length;
    if (records.length === 0) {
      console.log(`  ${f.padEnd(30)} 0 records`);
      empties.push(f);
      continue;
    }
    const dates = records.map((r) => r.sold_at).filter(Boolean).sort();
    const span = dates.length ? `${dates[0].slice(0, 10)} -> ${dates[dates.length - 1].slice(0, 10)}` : "no dates";
    const sizeMb = (fs.statSync(full).size / 1048576).toFixed(1);
    console.log(`  ${f.padEnd(30)} ${String(records.length).padStart(7)} records  ${String(sizeMb).padStart(6)} MB  ${span}`);
  }
}

console.log(`\ntotal records staged for ingest: ${grandTotal}`);

// A warning, never a failure: an empty delta is completely normal for a source that had nothing
// new today, and failing the build for it would make the pipeline cry wolf every single day.
for (const f of empties) {
  console.log(`::warning::${f} contains 0 records — normal if nothing new, but worth checking if it repeats.`);
}
