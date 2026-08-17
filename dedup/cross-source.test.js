// "Same car sold on two different sites" — the Layer B problem (ground truth §4.2 / build
// spec). This is the failure that quietly ruins a price index: an aggregator republishes a
// BaT result, the sale is counted twice, and the model's sales_count, median and venue mix
// are all wrong.
//
// Cases below use REAL scraped records as the base (samples/scraped/*.json) and then
// construct the cross-source counterpart, because our current corpus is BaT-heavy and does
// not yet contain a naturally-occurring same-lot-two-sources pair. The construction is
// clearly labelled; the BASE record in every case is real.
//
// Run: node dedup/cross-source.test.js

const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { normalizeVin, duplicateScore, DUPLICATE_THRESHOLD, collapseDuplicates, pickSurvivor, groupRepeatSales } = require("./dedup");

const DIR = path.join(__dirname, "..", "samples", "scraped");
const all = [];
require("../ingest/load-scraped").appendScrapedRecords(all, DIR);

// Base-record selection MATTERS and the first draft of this file got it wrong: it took
// withVin[0], which happened to be a 1967 DeTomaso with a 9-character chassis number and no
// mileage. Two tests failed against it — correctly, as it turned out:
//   • isValidVin() rejects 9 chars (the >=11 floor from ground truth §4.12, which exists to
//     admit pre-1981 chassis numbers while still excluding junk), so it can never take part
//     in repeat-sale detection.
//   • with no mileage AND no usable VIN the duplicate scorer tops out at 0.65.
// Neither was a logic bug. Pick records that actually exercise the intended path.
const modernVinRecords = all.filter((r) => r.vin_raw && normalizeVin(r.vin_raw)?.length === 17 && r.price > 0 && r.sold_at);
const withMileage = modernVinRecords.filter((r) => r.mileage != null);

if (!modernVinRecords.length) throw new Error("corpus has no 17-char-VIN records to test with");

const base = { ...withMileage[0] ?? modernVinRecords[0] };
base.vin_normal = normalizeVin(base.vin_raw);
base.price_usd = base.price;

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; process.exitCode = 1; }
}

console.log(`\nBase record (REAL, scraped): ${base.title}`);
console.log(`  ${base.source} | $${base.price} | VIN ${base.vin_raw} | ${base.sold_at}\n`);

console.log("LAYER B — same lot, two sources");
check("identical VIN within 7 days => certain duplicate (score 1.0)", () => {
  const other = { ...base, source: "classic", source_lot_id: "c-1" };
  assert.strictEqual(duplicateScore(base, other), 1.0);
});
check("same VIN but 60 days apart => NOT a duplicate (it's a repeat sale)", () => {
  const later = { ...base, source: "classic", source_lot_id: "c-2",
    sold_at: new Date(new Date(base.sold_at).getTime() + 60 * 86400000).toISOString() };
  assert.strictEqual(duplicateScore(base, later), 0);
});
check("no VIN but mileage present, hammer-vs-all-in gap (~8%) => collapses", () => {
  const republish = { ...base, source: "classic", source_lot_id: "c-3", vin_raw: null, vin_normal: null,
    price: Math.round(base.price * 0.92), price_usd: Math.round(base.price * 0.92) };
  const s = duplicateScore({ ...base, vin_normal: null }, republish);
  assert.ok(s >= DUPLICATE_THRESHOLD, `expected >= ${DUPLICATE_THRESHOLD}, got ${s.toFixed(3)}`);
});
check("DELIBERATE: no VIN AND no mileage tops out at 0.65 => stays separate", () => {
  // Under-evidenced on purpose. With neither a VIN nor a mileage to corroborate, all we have
  // is "same title, same day, plausible premium gap". For a rare car that is probably a
  // duplicate; for a common one it is probably two different cars that happened to sell the
  // same day. Wrongly MERGING two real sales destroys a datapoint and understates volume;
  // wrongly KEEPING a duplicate inflates sales_count by one. The second error is cheaper and
  // is visible in the data, so the threshold is set to prefer it.
  const a = { ...base, vin_raw: null, vin_normal: null, mileage: null };
  const b = { ...a, source: "classic", source_lot_id: "c-3b",
    price: Math.round(base.price * 0.92), price_usd: Math.round(base.price * 0.92) };
  const s = duplicateScore(a, b);
  assert.ok(s < DUPLICATE_THRESHOLD, `expected < ${DUPLICATE_THRESHOLD}, got ${s.toFixed(3)}`);
  assert.ok(s > 0.5, `expected a near-miss score >0.5, got ${s.toFixed(3)}`);
});
check("different car on the same day does NOT collapse", () => {
  const different = { ...base, source: "classic", source_lot_id: "c-4",
    title: "1994 Toyota Supra Turbo", vin_raw: "JT2XX10AJ0000001", vin_normal: "JT2XX10AJ0000001",
    price: 78000, price_usd: 78000, mileage: 92000 };
  assert.ok(duplicateScore(base, different) < DUPLICATE_THRESHOLD);
});

console.log("\nSURVIVOR SELECTION — aggregators must always lose");
check("primary auction house beats Classic.com aggregator", () => {
  const agg = { ...base, source: "classic", source_lot_id: "c-5" };
  assert.strictEqual(pickSurvivor(base, agg).source, base.source);
});
check("aggregator loses even against a retail source", () => {
  const agg = { source: "classic" }, retail = { source: "carscom" };
  assert.strictEqual(pickSurvivor(agg, retail).source, "carscom");
});
check("collapseDuplicates keeps the primary and drops the aggregator", () => {
  const agg = { ...base, source: "classic", source_lot_id: "c-6" };
  const { kept, dropped } = collapseDuplicates([base, agg]);
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(kept[0].source, base.source);
  assert.strictEqual(dropped.length, 1);
  assert.strictEqual(dropped[0].source, "classic");
});

console.log("\nLAYER C — repeat sales are SIGNAL, never collapsed");
check("same VIN sold twice years apart => a repeat-sale pair, both kept", () => {
  const first = { ...base, id: "r1", status: "sold", sold_at: "2022-05-01T00:00:00Z", price: 400000, price_usd: 400000, currency: "USD" };
  const second = { ...base, id: "r2", status: "sold", sold_at: "2026-05-01T00:00:00Z", price: 725000, price_usd: 725000, currency: "USD" };
  const groups = groupRepeatSales([first, second]);
  assert.strictEqual(groups.length, 1, "expected one repeat-sale group");
  assert.strictEqual(groups[0].sales.length, 2, "both sales must be kept");
});
check("repeat-sale detection ignores excluded (reserve-not-met) sales", () => {
  const real = { ...base, id: "r3", sold_at: "2022-05-01T00:00:00Z", price: 400000, price_usd: 400000, currency: "USD", reserve_not_met: false };
  const notSold = { ...base, id: "r4", sold_at: "2026-05-01T00:00:00Z", price: 725000, price_usd: 725000, currency: "USD", reserve_not_met: true };
  assert.strictEqual(groupRepeatSales([real, notSold]).length, 0);
});

console.log("\nREAL-CORPUS CHECK");
check("no undetected exact-duplicate VIN+date pairs survive in the scraped corpus", () => {
  const seen = new Map();
  const collisions = [];
  for (const r of all) {
    if (!r.vin_raw || !r.sold_at) continue;
    const k = `${normalizeVin(r.vin_raw)}|${r.sold_at.slice(0, 10)}|${r.source}|${r.source_lot_id}`;
    if (seen.has(k)) continue; // same lot re-listed in two files is expected (Layer A)
    seen.set(k, r);
  }
  // now look for the dangerous case: same VIN+date but DIFFERENT source_lot_id
  const byVinDate = new Map();
  for (const r of seen.values()) {
    // Records with no usable VIN must NOT be grouped — normalizeVin() returns null for all
    // of them, which would collapse every VIN-less sale on a given day into one fake
    // "collision". List-mode harvesting (crawler/bat-list.crawler.js) deliberately produces
    // VIN-less records, so this is now the common case rather than an edge one.
    const vin = normalizeVin(r.vin_raw);
    if (!vin) continue;
    const k = `${vin}|${r.sold_at.slice(0, 10)}`;
    if (!byVinDate.has(k)) byVinDate.set(k, []);
    byVinDate.get(k).push(r);
  }
  for (const [k, v] of byVinDate) if (v.length > 1) collisions.push(k);
  assert.strictEqual(collisions.length, 0, `unresolved cross-source collisions: ${collisions.join(", ")}`);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
