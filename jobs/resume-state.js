// WHAT DOES EACH STAGE RESUME FROM?
//
// A scheduled job that restarts from zero every night would re-fetch ~180,000 records daily,
// which is both wasteful and the fastest way to get rate-limited. Each stage therefore keeps
// its own resume marker — but they are DIFFERENT KINDS of marker, because the sources
// paginate differently, and knowing which is which matters when something goes wrong.
//
// Usage: node jobs/resume-state.js
"use strict";

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

const read = (p) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8")); } catch { return null; } };
const size = (p) => { try { return (fs.statSync(path.join(ROOT, p)).size / 1048576).toFixed(1) + " MB"; } catch { return "-"; } };
const count = (p) => { const a = read(p); return Array.isArray(a) ? a.length : null; };

console.log("=== 1. BRING A TRAILER — resumes by PARTITION ===");
const bat = read("samples/scraped/bat-partitioned.state.json");
const plan = read("samples/bat-partition-plan.json") || [];
if (bat) {
  const done = new Set(bat.completed || []);
  console.log(`  marker      : samples/scraped/bat-partitioned.state.json`);
  console.log(`  unit        : one (category x state x sort) partition`);
  console.log(`  completed   : ${done.size} partitions`);
  console.log(`  records     : ${count("samples/scraped/bat-partitioned.json")}  (${size("samples/scraped/bat-partitioned.json")})`);
  // Which partitions still owe work?
  const NON_CAR = new Set([379, 380, 383, 544, 432, 428, 430, 70, 553, 431]);
  const outstanding = plan
    .filter((r) => !NON_CAR.has(Number(r.id)) && r.total > 0)
    .filter((r) => !["td", "ta", "vd", "bd"].some((s) => done.has(`${r.id}|${r.state}|${s}`)));
  console.log(`  outstanding : ${outstanding.length} partitions, largest:`);
  for (const r of outstanding.sort((a, b) => b.total - a.total).slice(0, 6))
    console.log(`      ${r.name.padEnd(20)} ${r.state.padEnd(6)} ${String(r.total).padStart(6)}`);
  console.log(`  -> a partition is marked done ONLY after it is walked. A failed fetch leaves it`);
  console.log(`     unmarked, so the next run retries it rather than skipping it forever.`);
}

console.log("\n=== 2. RM SOTHEBY'S — resumes by AUCTION, with a recheck window ===");
const rms = read("samples/rms.state.json");
if (rms) {
  const auctions = Object.entries(rms.auctions || {});
  const complete = auctions.filter(([, m]) => m.complete);
  console.log(`  marker      : samples/rms.state.json`);
  console.log(`  unit        : one auction event (code from the lot URL, e.g. "mo26")`);
  console.log(`  known       : ${auctions.length} auctions, ${complete.length} complete`);
  console.log(`  records     : ${count("samples/scraped/rms.json")}  (${size("samples/scraped/rms.json")})`);
  console.log(`  -> a finished auction is IMMUTABLE and skipped. Auctions dated within 45 days`);
  console.log(`     are re-fetched anyway, because results post late and lots settle after the`);
  console.log(`     hammer. Completion also requires the walked count to match the API's claim,`);
  console.log(`     so a short walk is retried instead of being frozen as done.`);
  const recent = auctions.filter(([, m]) => m.date && (Date.now() - new Date(m.date).getTime()) / 86400000 < 45);
  console.log(`  in recheck window right now: ${recent.length}`);
}

console.log("\n=== 3. CARS & BIDS — resumes by RECORD, no state file ===");
console.log(`  marker      : the harvest file itself (samples/scraped/cars-and-bids.json)`);
console.log(`  unit        : one auction id`);
console.log(`  records     : ${count("samples/scraped/cars-and-bids.json")}  (${size("samples/scraped/cars-and-bids.json")})`);
console.log(`  -> the archive is newest-first and cannot be addressed by page, so an incremental`);
console.log(`     run scrolls from the top and STOPS after 8 consecutive batches containing`);
console.log(`     nothing new. A nightly tick therefore costs a handful of scrolls, not 800.`);
console.log(`     --full ignores that and re-walks everything.`);

console.log("\n=== 4. INGEST — reads everything, inserts only what is missing ===");
const { scrapedFiles } = require("../ingest/load-scraped");
const files = scrapedFiles();
console.log(`  marker      : none — the DATABASE is the marker`);
console.log(`  reads       : all ${files.length} record files, every run`);
console.log(`  guard       : UNIQUE (source, source_lot_id) — re-inserting a lot is a no-op`);
console.log(`  -> deliberately NOT incremental. It re-reads everything because the evidence`);
console.log(`     layer can accept on run 2 what it queued on run 1, once other records vouch`);
console.log(`     for a make. Measured: run 1 +2 sales, runs 2-4 +0. It converges, and never`);
console.log(`     duplicates (validation/cron-safety.test.js).`);

console.log("\n=== 5. COMPUTE — always full, never incremental ===");
console.log(`  marker      : none, by design`);
console.log(`  -> ground truth §11.4 is explicit: one new sale changes avg_mileage, which changes`);
console.log(`     every other sale's mileage-normalised price, which moves the trend, signal,`);
console.log(`     confidence and forecast. An incremental recompute would leave stale valuations`);
console.log(`     that look current. Full recompute over ${count("samples/scraped/bat-partitioned.json") ? "all" : "all"} cars each run.`);

console.log("\n=== SO A NIGHTLY TICK DOES ===");
console.log(`  BaT   : only partitions never completed  (nothing if all are done)`);
console.log(`  RM    : new auctions + any dated within 45 days`);
console.log(`  C&B   : scroll until 8 batches yield nothing new`);
console.log(`  ingest: re-read all files, insert only new lots`);
console.log(`  compute: recompute every car from scratch`);
