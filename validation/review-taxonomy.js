// WHAT IS ACTUALLY IN THE REVIEW QUEUE, AND WHICH PART OF IT IS AUTOMATABLE?
//
// The queue is the pipeline's honest admission of "I don't know". But "I don't know" covers
// several very different situations, and they need different treatment:
//
//   PATTERN-SOLVABLE  the title has a regular shape the parser simply does not exploit yet
//                     (e.g. "{year} {UnknownMake} {model}" — position tells you the make).
//                     These should become code, not human work.
//   REFERENCE-SOLVABLE the shape is clear but a FACT is missing — is "Marsh Metz" a marque or
//                     a model? That is a lookup, answerable once and cached, by a human, a
//                     reference source, or later an LLM.
//   GENUINELY AMBIGUOUS no amount of cleverness decides it: two equally plausible cars, a
//                     replica whose status is a judgement call. These stay human forever.
//
// Sizing those three buckets is what decides where effort goes, and what an LLM could later be
// pointed at safely.
//
// Usage: node validation/review-taxonomy.js

"use strict";

const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const db = new DatabaseSync(path.join(__dirname, "..", "data", "driveindex.sqlite"));
const rows = db.prepare(`
  SELECT source, raw_title, extracted_year, extracted_make, raw_record_json
  FROM car_resolution_queue WHERE status = 'pending'`).all();

const YEAR = /\b(1[89]\d{2}|20[0-4]\d)\b/;

// Classify by the SHAPE of the title, not by its brand.
const BUCKETS = [
  {
    key: "no-year",
    why: "no model year anywhere — cannot be indexed against a model-year curve",
    action: "REJECT (structural)",
    test: (t) => !YEAR.test(t),
  },
  {
    key: "year-then-unknown-make",
    why: "title is '{year} {word} {model}...' but the word after the year is not a known make",
    action: "AUTOMATE — infer make positionally, then let evidence accept or queue",
    test: (t, r) => YEAR.test(t) && !r.extracted_make,
  },
  {
    key: "known-make-unproven-model",
    why: "make recognised, model tokens unfamiliar",
    action: "AUTOMATE — corpus/batch evidence already handles this once volume arrives",
    test: (t, r) => Boolean(r.extracted_make),
  },
];

const counts = {};
const samples = {};
for (const r of rows) {
  const t = String(r.raw_title || "");
  const b = BUCKETS.find((x) => x.test(t, r)) || { key: "other" };
  counts[b.key] = (counts[b.key] || 0) + 1;
  (samples[b.key] = samples[b.key] || []).push({ t, source: r.source });
}

console.log(`pending review items: ${rows.length}\n`);
for (const b of BUCKETS) {
  const n = counts[b.key] || 0;
  if (!n) continue;
  console.log(`${b.key.toUpperCase()}  ${n}  (${((n / rows.length) * 100).toFixed(1)}%)`);
  console.log(`   why    : ${b.why}`);
  console.log(`   action : ${b.action}`);
  for (const s of (samples[b.key] || []).slice(0, 6)) console.log(`      [${s.source}] ${s.t.slice(0, 66)}`);
  console.log("");
}

// For the positional-make bucket, what WORD sits after the year? If a handful of words dominate,
// they are real marques and the fix is mechanical. If it is a long flat tail, it needs lookup.
console.log("=== THE WORD AFTER THE YEAR, for items with no recognised make ===");
const freq = new Map();
for (const r of rows) {
  if (r.extracted_make) continue;
  const t = String(r.raw_title || "");
  const m = t.match(YEAR);
  if (!m) continue;
  const after = t.slice(m.index + m[0].length).trim();
  const word = (after.match(/^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ.'-]*/) || [""])[0];
  if (word) freq.set(word, (freq.get(word) || 0) + 1);
}
const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
console.log(`distinct first-words: ${sorted.length}`);
for (const [w, n] of sorted.slice(0, 30)) console.log(`   ${String(n).padStart(5)}  ${w}`);

const head = sorted.slice(0, 30).reduce((a, b) => a + b[1], 0);
const all = sorted.reduce((a, b) => a + b[1], 0);
console.log(`\ntop 30 words cover ${head}/${all} (${((head / all) * 100).toFixed(1)}%) of unknown-make items`);
console.log(`-> a concentrated head means these are REAL MARQUES and positional inference is mechanical;`);
console.log(`   a flat tail would mean per-title lookup is unavoidable.`);
