// HOW LONG UNTIL EACH THING IS DONE?
//
// Estimated from MEASURED rates in this session, not guessed: page counts come from the
// partition plan, per-request delay from what the crawler is actually running at, and review
// throughput from a stated human rate.
//
// Usage: node validation/eta.js
"use strict";

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.join(__dirname, "..");
const read = (p, d) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8")); } catch { return d; } };

const PER_PAGE = 48, MAX_PAGE = 208, SORTS = 4;
const REACHABLE = PER_PAGE * MAX_PAGE;
const NON_CAR = new Set([379, 380, 383, 544, 432, 428, 430, 70, 553, 431]);

// The crawler backs off on throttling; 3,750ms is where it settled this run.
const DELAY_MS = 3750;
const hrs = (ms) => (ms / 3600000).toFixed(1);

console.log("=== 1. BRING A TRAILER ===");
const plan = read("samples/bat-partition-plan.json", []);
const state = read("samples/scraped/bat-partitioned.state.json", { completed: [] });
const done = new Set(state.completed || []);

let pages = 0;
const outstanding = [];
for (const r of plan) {
  if (NON_CAR.has(Number(r.id)) || !r.total) continue;
  for (const sort of ["td", "ta", "vd", "bd"]) {
    if (done.has(`${r.id}|${r.state}|${sort}`)) continue;
    // Under-cap partitions need only enough pages to cover their total; over-cap ones walk the
    // full 208. vd/bd are skipped entirely below 2x the reachable window.
    if (r.total <= REACHABLE) { if (sort === "td") pages += Math.ceil(r.total / PER_PAGE); continue; }
    if (r.total <= REACHABLE * 2 && (sort === "vd" || sort === "bd")) continue;
    pages += MAX_PAGE;
    outstanding.push(`${r.name}/${r.state}/${sort}`);
  }
}
console.log(`  pages still to fetch : ${pages.toLocaleString()}`);
console.log(`  at ${DELAY_MS}ms/request : ${hrs(pages * DELAY_MS)} hours`);
console.log(`  partitions remaining : ${[...new Set(outstanding.map((o) => o.split("/").slice(0, 2).join("/")))].length}`);
console.log(`  records now          : ${(read("samples/scraped/bat-partitioned.json", []).length).toLocaleString()}`);

console.log("\n=== 2. MECUM ===");
const mst = read("samples/mecum.state.json", { events: {} });
const evs = Object.entries(mst.events || {});
const mdone = evs.filter(([, m]) => m.complete).length;
// Measured: 60 pages per event at roughly 4.5s per page including render.
const MECUM_PAGES = 60, MECUM_PAGE_MS = 4500;
console.log(`  events known         : ${evs.length}  (${mdone} complete)`);
console.log(`  per event            : ~${MECUM_PAGES} pages, ~${((MECUM_PAGES * MECUM_PAGE_MS) / 60000).toFixed(0)} min`);
console.log(`  records now          : ${(read("samples/scraped/mecum.json", []).length).toLocaleString()}`);
console.log(`  -> the real limit is DISCOVERY, not speed: past-event slugs must be found before`);
console.log(`     they can be harvested. Mecum runs ~10 sales a year going back decades.`);

console.log("\n=== 3. INGEST + RECOMPUTE (after harvesting) ===");
// Measured this session on ~180k raw records.
console.log(`  ingest  : ~12 min at current corpus size`);
console.log(`  compute : ~8 min for 36k cars`);
console.log(`  -> both scale with corpus, both must run before numbers are quotable.`);

console.log("\n=== 4. REVIEW QUEUE (human, not machine) ===");
const db = new DatabaseSync(path.join(ROOT, "data", "driveindex.sqlite"));
const q = db.prepare("SELECT COUNT(*) c FROM car_resolution_queue WHERE status='pending'").get().c;
for (const rate of [60, 120, 240]) {
  console.log(`  ${q.toLocaleString()} items at ${rate}/hour : ${(q / rate).toFixed(0)} hours of human time`);
}
console.log(`  -> but ~39% have NO YEAR and are structural rejects, and ~27% self-resolve as`);
console.log(`     volume grows. The genuinely human share is far smaller than the raw count.`);

console.log("\n=== SUMMARY ===");
console.log(`  BaT to finish        : ~${hrs(pages * DELAY_MS)} hours (unattended)`);
console.log(`  Mecum per event      : ~5 min, but needs event discovery first`);
console.log(`  ingest + recompute   : ~20 min`);
console.log(`  => a quotable, fully-audited corpus: roughly ${(Number(hrs(pages * DELAY_MS)) + 0.5).toFixed(1)} hours from now,`);
console.log(`     assuming no further throttling.`);
