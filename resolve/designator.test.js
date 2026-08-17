// Regression tests for model-key comparison, every case taken from a REAL pair the split
// audit (validation/split-audit.js) found in the live catalogue.
//
// These are recorded as tests rather than fixed silently because each one was a case where
// the resolver's answer was confidently wrong — the failure mode the client cares most about
// ("i want perfect or human review not bad data and sales"). A wrong "different" fragments one
// car's price history; a wrong "same" merges two cars into a curve that describes neither.
//
// Run: node resolve/designator.test.js

const assert = require("assert");
const { compareModelKeys, canonicalModelKey } = require("./resolve-car-v2");

let pass = 0, fail = 0;
function eq(label, actual, expected) {
  try {
    assert.strictEqual(actual, expected);
    console.log(`  ok   ${label}`);
    pass++;
  } catch {
    console.log(`  FAIL ${label}\n       expected ${expected}, got ${actual}`);
    fail++;
  }
}

console.log("\nENGINE CONFIG IS NOT A MODEL DESIGNATOR");
// Found as: 1970 Ford "f-250 v8" ~~ "mustang v8" scored ambiguous. They share only an engine
// layout. V8/I6/flat-6 contain a digit, which the "digit means model name" heuristic misread.
eq('"f-250 v8" vs "mustang v8"', compareModelKeys("f-250 v8", "mustang v8"), "different");
eq('"corvette v8" vs "camaro v8"', compareModelKeys("corvette v8", "camaro v8"), "different");
eq('engine config alone cannot make two models match',
  compareModelKeys("bronco v8", "f-100 v8"), "different");

console.log("\nA SHARED NUMBER DOES NOT OUTWEIGH DISAGREEING NAMES");
// Found as: 1968 Chevrolet "327 camaro" ~~ "327 corvette". 327 is a cubic-inch engine size
// that American listings put in the title; the model names are right there and disagree.
eq('"327 camaro" vs "327 corvette"', compareModelKeys("327 camaro", "327 corvette"), "different");
eq('"510 bre" vs "510 station"', compareModelKeys("510 bre", "510 station"), "different");
eq('"240z bre" vs "240z project"', compareModelKeys("240z bre", "240z project"), "different");

console.log("\nINTERNAL HYPHENS IN A CODE ARE TYPESETTING, NOT IDENTITY");
// Found as: 1978 Chevrolet "corvette l-82" and "corvette l82" as two cars, splitting the
// price history of one.
eq('"corvette l-82" vs "corvette l82"', compareModelKeys(canonicalModelKey(["corvette", "l-82"]), canonicalModelKey(["corvette", "l82"])), "same");
eq('"f-250" vs "f250"', compareModelKeys(canonicalModelKey(["f-250"]), canonicalModelKey(["f250"])), "same");
eq('"gt-r" vs "gtr"', compareModelKeys(canonicalModelKey(["skyline", "gt-r"]), canonicalModelKey(["skyline", "gtr"])), "same");
// ...but a hyphen JOINING TWO WORDS is part of the name and must survive.
eq("word-joining hyphen is preserved", canonicalModelKey(["mercedes-benz"]), "mercedes-benz");

console.log("\nTIED-LONGEST TOKENS MUST ALL COUNT AS DESIGNATORS");
// Found as: "eleanor mustang" vs "bullitt mustang" — both tokens are 7 chars, so the old
// tie-break picked "eleanor" for one and "bullitt" for the other, they failed to match, and
// two builds of the same base model were declared different with nobody asked.
eq('"eleanor mustang" vs "bullitt mustang"', compareModelKeys("eleanor mustang", "bullitt mustang"), "ambiguous");

console.log("\nTHE EXISTING CONTRACT STILL HOLDS");
eq("identical keys are same", compareModelKeys("911 carrera", "911 carrera"), "same");
eq("known variant difference is decided", compareModelKeys("911 gt3", "911 gt3 rs"), "different");
eq("base vs qualified variant is decided", compareModelKeys("m3", "dinan m3"), "different");
eq("different models entirely", compareModelKeys("bronco", "f350 ranger xlt"), "different");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
