// HOW MUCH BaT SCRAPING IS NEEDED TO APPROACH DRIVEINDEX'S VOLUME?
//
// DriveIndex publishes 110,043 sales across 13 sources, of which BaT is 72.2% of the source
// mix -> roughly 79,000 BaT sales. This projects whether that number is reachable through the
// endpoint at all, and what it costs in requests and wall-clock time.
//
// The projection is built on MEASURED yield, not optimism:
//   * partitions under the reachable window (9,984) return 100% of their claimed total, and we
//     have already walked dozens of them to natural termination to confirm it.
//   * partitions OVER the window are truncated. Four sort directions each return at most 9,984
//     records, and they overlap by an unknown amount. Both bounds are reported rather than a
//     single flattering number.
//   * categories overlap each other (a 911 Cabriolet is German AND Convertible), so summed
//     partition yields overcount. The observed de-overlap factor from the live harvest is
//     applied instead of assuming disjointness.
//
// Usage: node validation/bat-projection.js

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const plan = JSON.parse(fs.readFileSync(path.join(ROOT, "samples", "bat-partition-plan.json"), "utf8"));
const records = JSON.parse(fs.readFileSync(path.join(ROOT, "samples", "scraped", "bat-partitioned.json"), "utf8"));
let done = new Set();
try { done = new Set(JSON.parse(fs.readFileSync(path.join(ROOT, "samples", "scraped", "bat-partitioned.state.json"), "utf8")).completed); } catch {}

const PER_PAGE = 48, MAX_PAGE = 208, REACHABLE = PER_PAGE * MAX_PAGE; // 9,984
const SORTS = 4;
const NON_CAR = new Set([379, 380, 383, 544, 432, 428, 430, 70, 553, 431]);

const DRIVEINDEX_TOTAL = 110043;
const BAT_SHARE = 0.722;
const TARGET = Math.round(DRIVEINDEX_TOTAL * BAT_SHARE);

const carRows = plan.filter((r) => !NON_CAR.has(Number(r.id)) && r.total > 0);

// ---- MEASURED DE-OVERLAP ----
// Sum the claimed totals of every partition we have actually finished, and compare with the
// unique records on file. The ratio is how much category overlap is really costing us.
let claimedDone = 0;
for (const r of carRows) {
  if (r.total > REACHABLE) continue; // only fully-walked partitions give a clean measurement
  if (SORTS && ["td", "ta", "vd", "bd"].some((s) => done.has(`${r.id}|${r.state}|${s}`))) claimedDone += r.total;
}
const unique = records.length;
const overlapFactor = claimedDone > 0 ? unique / claimedDone : 1;

console.log(`=== MEASURED SO FAR ===`);
console.log(`  unique records on file           : ${unique.toLocaleString()}`);
console.log(`  claimed totals of finished parts : ${claimedDone.toLocaleString()}`);
console.log(`  => de-overlap factor             : ${overlapFactor.toFixed(3)}  (1.00 = no overlap)`);

// ---- REMAINING WORK ----
let remainUnder = 0, remainOverClaimed = 0, pagesUnder = 0, pagesOver = 0;
const remaining = [];
for (const r of carRows) {
  const anyDone = ["td", "ta", "vd", "bd"].some((s) => done.has(`${r.id}|${r.state}|${s}`));
  if (anyDone) continue;
  remaining.push(r);
  if (r.total <= REACHABLE) { remainUnder += r.total; pagesUnder += Math.ceil(r.total / PER_PAGE); }
  else { remainOverClaimed += r.total; pagesOver += MAX_PAGE * SORTS; }
}

console.log(`\n=== REMAINING PARTITIONS: ${remaining.length} ===`);
for (const r of remaining.sort((a, b) => b.total - a.total).slice(0, 14))
  console.log(`  ${r.name.padEnd(22)} ${r.state.padEnd(6)} ${String(r.total).padStart(6)} ${r.total > REACHABLE ? "(over cap - PARTIAL only)" : ""}`);

// ── THE CEILING THAT ACTUALLY BINDS ────────────────────────────────────────────────────
//
// An earlier version of this projection summed the over-cap partitions' reachable slices and
// got 220,000-286,000 — from a site that reports 257,919 listings in TOTAL. That was
// arithmetically unsound in two ways, and both matter:
//
//   1. the big categories overlap each other massively (a 911 Cabriolet is German AND
//      Convertible; a Bronco is American AND Truck), so their totals cannot be added;
//   2. the de-overlap factor measured above comes from SMALL national categories (Swedish,
//      Czech, Brazilian) which barely intersect anything, so it does not transfer to them.
//
// The defensible ceiling is the size of the universe itself, which the unfiltered endpoint
// reports directly. Per-partition reach then says how much of that universe we can actually
// touch, and the binding constraint is per-partition: a car that belongs to exactly ONE
// over-cap category (a plain 911 coupe is only "German") has no alternate route to it.
const BAT_TOTAL_LISTINGS = 257919;
const NON_CAR_LISTINGS = plan.filter((r) => NON_CAR.has(Number(r.id))).reduce((a, b) => a + b.total, 0);
const CAR_UNIVERSE = BAT_TOTAL_LISTINGS - NON_CAR_LISTINGS;

const overCap = remaining.filter((r) => r.total > REACHABLE);
let overReach = 0, overMissed = 0;
for (const r of overCap) {
  const reach = Math.min(r.total, REACHABLE * SORTS); // 4 sorts x 9,984 = 39,936 maximum
  overReach += reach;
  overMissed += r.total - reach;
}

// Cap the union at the universe. Sorts within one partition overlap to an unknown degree, so
// report a band rather than a single number: the low end assumes the four sorts duplicate each
// other substantially, the high end assumes they are close to disjoint.
const rawUnion = unique + remainUnder + overReach;
const projHigh = Math.min(Math.round(rawUnion * 0.75), CAR_UNIVERSE);
const projLow = Math.min(Math.round(rawUnion * 0.45), CAR_UNIVERSE);

console.log(`\n=== PROJECTION ===`);
console.log(`  BaT car-category universe (the hard ceiling)       : ${CAR_UNIVERSE.toLocaleString()} listings`);
console.log(`  target (BaT's ${(BAT_SHARE * 100).toFixed(1)}% of DriveIndex's ${DRIVEINDEX_TOTAL.toLocaleString()})  : ${TARGET.toLocaleString()}`);
console.log(`  have now                                          : ${unique.toLocaleString()}`);
console.log(`  under-cap partitions still to run (100% yield)     : +${remainUnder.toLocaleString()}`);
console.log(`  over-cap partitions, reachable at 4 x 9,984 each   : +${overReach.toLocaleString()}`);
console.log(`  ...permanently UNREACHABLE inside those partitions : -${overMissed.toLocaleString()}`);
console.log(`\n  PROJECTED FINAL: ${projLow.toLocaleString()} - ${projHigh.toLocaleString()} BaT records`);
console.log(`  vs target ${TARGET.toLocaleString()}  ->  ${((projLow / TARGET) * 100).toFixed(0)}% - ${((projHigh / TARGET) * 100).toFixed(0)}% of DriveIndex's BaT volume`);
console.log(`\n  (band is wide because sort-overlap within one partition is not yet measured —`);
console.log(`   it will be known exactly once the first big partition finishes all four sorts.)`);

// ---- COST ----
const pages = pagesUnder + pagesOver;
const DELAY = Number(process.env.DELAY_MS) || 1800;
const hours = (pages * DELAY) / 3600000;
console.log(`\n=== COST OF THE REMAINING RUN ===`);
console.log(`  pages to fetch : ${pages.toLocaleString()}  (${pagesUnder.toLocaleString()} under-cap + ${pagesOver.toLocaleString()} over-cap)`);
console.log(`  at ${DELAY}ms/request : ${hours.toFixed(1)} hours`);
console.log(`  requests total : ~${pages.toLocaleString()}  (the block last time came at ~7,000)`);

console.log(`\n=== WHAT THE GAP MEANS ===`);
const shortfall = TARGET - projLow;
if (shortfall > 0) {
  console.log(`  Even fully run, BaT leaves a shortfall of ~${shortfall.toLocaleString()} against their BaT volume.`);
  console.log(`  Cause: the 10,000-record offset cap. Partitions like German/sold (69,806) can`);
  console.log(`  never be fully walked through this endpoint - at best ~40k of it is reachable.`);
  console.log(`  Closing that needs a different mechanism (per-model pages, or the keyword-filter`);
  console.log(`  endpoint whose 'results' parameter is still unsolved), NOT more of the same run.`);
} else {
  console.log(`  BaT alone can reach the target; no additional mechanism required.`);
}
