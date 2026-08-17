// One-off repair for state written by the pre-fix harvester.
//
// The bug: a FAILED request (host refusing us) was treated as an EMPTY partition, so once BaT
// rate-limited us every remaining partition "completed" instantly having fetched nothing — and
// was written to the completed set, which a resume then skips forever. Three real partitions
// were lost this way: Race Cars/unsold, Right-Hand Drive/unsold and Prewar/sold, ~11,000
// records between them.
//
// The fix is in the crawler. This repairs the state it already wrote, by re-deriving which
// partitions are actually complete: a partition is only genuinely done if the plan says it has
// records AND the harvest file actually contains records from it (each record carries its
// partition key in _extra.partition).
//
// Usage: node crawler/repair-partition-state.js [--apply]

"use strict";

const fs = require("fs");
const path = require("path");

const S = path.join(__dirname, "..", "samples", "scraped", "bat-partitioned.state.json");
const OUT = path.join(__dirname, "..", "samples", "scraped", "bat-partitioned.json");
const PLAN = path.join(__dirname, "..", "samples", "bat-partition-plan.json");

const state = JSON.parse(fs.readFileSync(S, "utf8"));
const records = JSON.parse(fs.readFileSync(OUT, "utf8"));
const plan = JSON.parse(fs.readFileSync(PLAN, "utf8"));

const planSize = new Map(plan.map((r) => [`${r.id}|${r.state}`, r.total]));
const planName = new Map(plan.map((r) => [String(r.id), r.name]));

// Which partitions actually contributed records?
const harvested = new Set();
for (const r of records) if (r._extra && r._extra.partition) harvested.add(r._extra.partition);

const keep = [];
const drop = [];
for (const key of state.completed) {
  const [cat, st] = key.split("|");
  const size = planSize.get(`${cat}|${st}`);

  // Genuinely empty per the plan -> legitimately done with zero records.
  if (size === 0 || size == null) { keep.push(key); continue; }
  // The plan says this partition has records. It is only done if we actually got some —
  // either from this partition directly, or because an earlier sort of the SAME partition
  // already took the whole thing (the deliberate short-circuit).
  const sameParitionAnySort = [...harvested].some((h) => h.startsWith(`${cat}|${st}|`));
  if (harvested.has(key) || sameParitionAnySort) keep.push(key);
  else drop.push({ key, size, name: planName.get(cat) });
}

console.log(`completed on file : ${state.completed.length}`);
console.log(`genuinely done    : ${keep.length}`);
console.log(`FALSELY marked    : ${drop.length}`);
for (const d of drop) console.log(`   ${String(d.name).padEnd(20)} ${d.key.padEnd(14)} plan says ${String(d.size).padStart(6)} records — never fetched`);
console.log(`\nrecords recoverable by re-running: ~${drop.reduce((a, b) => a + Math.min(b.size, 9984), 0).toLocaleString()}`);

if (process.argv.includes("--apply")) {
  fs.writeFileSync(S, JSON.stringify({ completed: keep, updated: new Date().toISOString(), repaired: true }, null, 1));
  console.log(`\nrepaired ${S} — ${drop.length} partitions returned to the work list`);
} else {
  console.log(`\n(dry run — pass --apply to write)`);
}
