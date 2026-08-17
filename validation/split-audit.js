// SPLIT AUDIT — the client's number one requirement, made repeatable and made to scale.
//
// "i dont want like same car sales to be splitted or we cerate d a new car vene we have it in
// the database" — so this asks, over the whole catalogue: are there two car rows that are
// really the same car, with that car's sale history torn between them?
//
// ── WHY BLOCKING, NOT BRUTE FORCE ──────────────────────────────────────────────────────
// The audit has been run ad hoc as a full pairwise sweep. At 8,690 cars that is ~37M
// comparisons — slow but survivable. The partitioned harvest takes the catalogue toward
// ~50,000 cars, where the same sweep is ~1.25 BILLION comparisons and simply will not finish.
//
// It is also almost all wasted work: two cars can only be the same car if they agree on YEAR
// and MAKE, because both are part of the identity key and neither is inferred loosely. So
// compare only within (year, make) blocks. That is exact, not approximate — no candidate pair
// is skipped — and it turns a quadratic sweep over the catalogue into a quadratic sweep over
// blocks that are typically a few dozen rows.
//
// ── WHAT COUNTS AS WHAT ────────────────────────────────────────────────────────────────
//   HARD SPLIT   two rows whose model keys compare "same". This must be zero. If it is not,
//                the identity key or the resolver let a duplicate car through, and the price
//                history of one real car is being computed from two half-histories.
//   SOFT SPLIT   model keys compare "ambiguous" — genuinely uncertain, and the pipeline is
//                supposed to have QUEUED one of these rather than created it silently.
//   DELIBERATE   same model key, differing only by body_type / generation / modification.
//                These are separate assets on purpose (a Singer 911 is not a stock 911) and
//                are reported only so the deliberate splits stay visible and reviewable.
//
// Severity is weighted by sales, because a split between two rows that each carry real sales
// corrupts an actual price curve, whereas a split involving a zero-sale row is inert.
//
// Usage: node validation/split-audit.js [--limit N]

"use strict";

const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { compareModelKeys } = require("../resolve/resolve-car-v2");

const db = new DatabaseSync(path.join(__dirname, "..", "data", "driveindex.sqlite"));

const cars = db
  .prepare(
    `SELECT c.id, c.year, c.make, c.model_key, c.body_type, c.generation, c.modification,
            c.displacement, COUNT(s.id) AS sales
     FROM car c LEFT JOIN sale s ON s.car_id = c.id
     GROUP BY c.id`
  )
  .all();

// ---- block on the parts of identity that are never loosely inferred ----
const blocks = new Map();
for (const c of cars) {
  const k = `${c.year}|${String(c.make).toLowerCase()}`;
  if (!blocks.has(k)) blocks.set(k, []);
  blocks.get(k).push(c);
}

const hard = [];
const soft = [];
const deliberate = [];
let comparisons = 0;

for (const [, group] of blocks) {
  if (group.length < 2) continue;
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      const a = group[i], b = group[j];
      comparisons++;

      if (a.model_key === b.model_key) {
        // Same model key means the rows were separated by a structured attribute — which is
        // the intended behaviour, not a defect. Record it so deliberate splits stay auditable.
        const differsBy = ["body_type", "generation", "modification", "displacement"].filter(
          (f) => (a[f] ?? null) !== (b[f] ?? null)
        );
        deliberate.push({ a, b, differsBy });
        continue;
      }

      const verdict = compareModelKeys(a.model_key, b.model_key);
      if (verdict === "same") hard.push({ a, b });
      else if (verdict === "ambiguous") soft.push({ a, b });
    }
  }
}

const sizes = [...blocks.values()].map((g) => g.length).sort((x, y) => y - x);
const naive = (cars.length * (cars.length - 1)) / 2;

console.log(`=== SPLIT AUDIT ===`);
console.log(`cars ................ ${cars.length}`);
console.log(`(year, make) blocks . ${blocks.size}   largest ${sizes[0] ?? 0}, median ${sizes[Math.floor(sizes.length / 2)] ?? 0}`);
console.log(`comparisons ......... ${comparisons.toLocaleString()}  (brute force would be ${naive.toLocaleString()}, ${(naive / Math.max(comparisons, 1)).toFixed(0)}x more)`);

const weight = (p) => Math.min(p.a.sales, p.b.sales); // both sides must have sales to corrupt a curve
const bySeverity = (arr) => [...arr].sort((x, y) => weight(y) - weight(x));

console.log(`\nHARD SPLITS (model keys compare "same" — must be 0) : ${hard.length}`);
for (const p of bySeverity(hard).slice(0, 25)) {
  console.log(`  ${p.a.year} ${p.a.make}`);
  console.log(`     "${p.a.model_key}" (${p.a.sales} sales)  ==  "${p.b.model_key}" (${p.b.sales} sales)`);
}

console.log(`\nSOFT SPLITS (ambiguous — should have been queued) : ${soft.length}`);
const softBoth = soft.filter((p) => p.a.sales > 0 && p.b.sales > 0);
console.log(`  of which BOTH sides carry sales (a real corrupted curve): ${softBoth.length}`);
for (const p of bySeverity(softBoth).slice(0, 20)) {
  console.log(`  ${p.a.year} ${p.a.make}  "${p.a.model_key}" (${p.a.sales})  ~~  "${p.b.model_key}" (${p.b.sales})`);
}

console.log(`\nDELIBERATE separations (same model key, split by a structured attribute) : ${deliberate.length}`);
const byField = {};
for (const d of deliberate) byField[d.differsBy.join("+") || "(identical!)"] = (byField[d.differsBy.join("+") || "(identical!)"] || 0) + 1;
for (const [f, n] of Object.entries(byField).sort((x, y) => y[1] - x[1])) console.log(`  ${String(n).padStart(5)}  differ by ${f}`);

// A pair identical on EVERY identity field is a genuine duplicate row and the UNIQUE
// constraint should have made it impossible — surface it loudly rather than in a tally.
const identical = deliberate.filter((d) => d.differsBy.length === 0);
if (identical.length) {
  console.log(`\n!! ${identical.length} pairs identical on every identity field — the UNIQUE constraint should forbid this:`);
  for (const d of identical.slice(0, 10)) console.log(`   car ${d.a.id} / ${d.b.id}: ${d.a.year} ${d.a.make} ${d.a.model_key}`);
}

const fatal = hard.length + identical.length;
console.log(`\n${fatal === 0 ? "PASS — no same-car splits in the catalogue" : `FAIL — ${fatal} true splits`}`);
process.exit(fatal === 0 ? 0 : 1);
