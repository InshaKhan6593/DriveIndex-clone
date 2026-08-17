// THE REVIEW QUEUE, AS A REVIEWER WOULD SEE IT.
//
// The queue is the pipeline's honest "I don't know", and it only works if a human can act on
// it. Two things previously made that impossible:
//
//   1. NO REASON WAS STORED. An item showed a title and nothing about what the pipeline could
//      not decide, so every one required re-deriving the problem by hand.
//   2. 34.8% OF IT WAS UNANSWERABLE. 5,050 of 14,531 items had no model year anywhere
//      ("Mini Clubman VTEC AWD Project"). A human cannot supply a year the listing never had.
//      Those are now structural rejects, not questions.
//
// This report groups what remains by the KIND of question, because they need different work:
// "is X a car marque?" is a lookup that can be answered once and cached; "are these the same
// car?" is a judgement that needs a person who knows the market.
//
// Usage: node validation/review-queue.js [reason_class]
"use strict";

const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(path.join(__dirname, "..", "data", "driveindex.sqlite"));
const all = (s, ...p) => db.prepare(s).all(...p);
const one = (s) => db.prepare(s).get(s ? undefined : undefined);

const pending = db.prepare("SELECT COUNT(*) c FROM car_resolution_queue WHERE status='pending'").get().c;
const rejected = db.prepare("SELECT COUNT(*) c FROM car_resolution_queue WHERE status='rejected'").get().c;
const sales = db.prepare("SELECT COUNT(*) c FROM sale").get().c;

console.log(`pending review : ${pending.toLocaleString()}  (${((pending / (pending + sales)) * 100).toFixed(1)}% of everything seen)`);
console.log(`auto-rejected  : ${rejected.toLocaleString()}`);

console.log(`\n=== BY KIND OF QUESTION ===`);
const classes = all(`
  SELECT COALESCE(reason_class,'(unclassified)') k, COUNT(*) n
  FROM car_resolution_queue WHERE status='pending' GROUP BY 1 ORDER BY n DESC`);

const GUIDE = {
  UNKNOWN_MAKE: "LOOKUP — is this token a car marque? Answer once, it applies to every listing of it.",
  "SAME_CAR?": "JUDGEMENT — merge or keep separate. Needs someone who knows the market.",
  UNPROVEN_MODEL: "USUALLY SELF-RESOLVES — accepted automatically once more of the model arrives.",
  UNPARSEABLE: "INSPECT — the title does not fit the {year} {make} {model} shape at all.",
  OTHER: "mixed",
};

for (const c of classes) {
  console.log(`\n  ${c.k}  ${c.n.toLocaleString()}`);
  console.log(`     ${GUIDE[c.k] || ""}`);
  for (const s of all(
    `SELECT raw_title, extracted_year, extracted_make FROM car_resolution_queue
     WHERE status='pending' AND COALESCE(reason_class,'(unclassified)') = ? LIMIT 4`, c.k))
    console.log(`       ${String(s.extracted_year || "----")} ${String(s.extracted_make || "?").padEnd(14)} ${String(s.raw_title).slice(0, 54)}`);
}

console.log(`\n=== HIGHEST-LEVERAGE ITEMS ===`);
console.log(`One answer here unblocks many listings, so this is where a reviewer should start.`);
for (const r of all(`
  SELECT extracted_make m, COUNT(*) n FROM car_resolution_queue
  WHERE status='pending' AND reason_class='UNKNOWN_MAKE' AND extracted_make IS NOT NULL
  GROUP BY 1 ORDER BY n DESC LIMIT 15`))
  console.log(`  ${String(r.n).padStart(5)} listings  hinge on: is "${r.m}" a car marque?`);

console.log(`\n=== SAMPLE REASONS (what the pipeline actually said) ===`);
for (const r of all(`SELECT DISTINCT reason FROM car_resolution_queue WHERE status='pending' AND reason IS NOT NULL LIMIT 5`))
  console.log(`  - ${String(r.reason).slice(0, 150)}`);
