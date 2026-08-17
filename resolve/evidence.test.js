// Does the PATTERN system work WITHOUT the memorised lists?
//
// This is the honest test of the architecture change. It runs the structural + evidence
// classifier over every real scraped title with the curated shortcuts DISABLED
// (knownMake:false everywhere), so nothing can be recognised by name. If the pattern layer
// is doing real work, it should still reject the parts/wheels/motorcycles and still accept
// mainstream cars.
//
// Run: node resolve/evidence.test.js

const fs = require("fs");
const path = require("path");
const { classify, structuralVerdict, buildCorpusStats } = require("./evidence");
const { parseTitle } = require("./resolve-car-v2");
const { openDb } = require("../db/client");

const DIR = path.join(__dirname, "..", "samples", "scraped");
const recs = [];
require("../ingest/load-scraped").appendScrapedRecords(recs, DIR);
const byTitle = new Map();
for (const r of recs) if (r.title && !byTitle.has(r.title)) byTitle.set(r.title, r);

const db = openDb();
const stats = buildCorpusStats(db);
console.log(`corpus evidence base: ${stats.totalSales} sales, ${stats.makeFreq.size} distinct makes\n`);

const buckets = { accept: [], review: [], reject: [] };
for (const [title, rec] of byTitle) {
  const parsed = parseTitle(title, { url: rec.url });
  const hasYear = Boolean(parsed.ok ? parsed.year : String(rec.url || "").match(/\/(1[89]\d{2}|20[0-4]\d)-/));
  // knownMake FORCED FALSE — the curated vocabulary is switched off for this test.
  const v = classify({ title, parsed, knownMake: false, stats, hasYear });
  buckets[v.action].push({ title, reason: v.reason, conf: v.confidence });
}

console.log(`WITH CURATED VOCABULARY DISABLED:`);
console.log(`  accept : ${buckets.accept.length}`);
console.log(`  review : ${buckets.review.length}`);
console.log(`  reject : ${buckets.reject.length}`);

console.log(`\nREJECTED BY STRUCTURE ALONE (no brand names involved):`);
for (const r of buckets.reject) console.log(`   [${r.reason}]  ${r.title.slice(0, 62)}`);

console.log(`\nACCEPTED ON CORPUS EVIDENCE ALONE (sample):`);
for (const r of buckets.accept.slice(0, 8)) console.log(`   conf=${r.conf.toFixed(2)}  ${r.title.slice(0, 58)}`);

// Precision check: are the structural rejects actually non-cars?
const NON_CAR_HINT = /wheel|seat|sign|outboard|engine|tank|motorcycle|harley|indian model|cc\b|single-?seater/i;
const wrongRejects = buckets.reject.filter((r) => !NON_CAR_HINT.test(r.title));
console.log(`\nstructural rejects that look like they might be real cars: ${wrongRejects.length}`);
for (const w of wrongRejects) console.log(`   !! ${w.title}`);

db.close();
