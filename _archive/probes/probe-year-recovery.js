// CAN THE MISSING YEAR BE RECOVERED?
//
// 5,050 queued items have no model year in the title or URL, and without one they cannot be
// indexed against a model-year price curve. Three possible sources, only one of which is sound:
//
//   WEB SEARCH   — NO. It gives a model's PRODUCTION RANGE ("Mini Clubman, 1969-1980"), never
//                  the year of one specific car. Assigning a range midpoint would invent data.
//   VIN DECODE   — position 10 encodes model year, but our VIN fill rate is ~1%.
//   DETAIL PAGE  — the listing itself. A title may omit the year while the page states it in
//                  the specs, the description, or the breadcrumb. This is a FACT ABOUT THIS CAR
//                  rather than an inference, so it is the only one worth building on.
//
// This measures how often the detail page actually carries it. Deliberately a handful of
// requests: BaT rate-limited us earlier today and this is a question, not a harvest.
//
// Usage: node crawler/probe-year-recovery.js
"use strict";

const fs = require("fs");
const path = require("path");
const { loadScrapedRecords } = require("../ingest/load-scraped");

const YEAR = /\b(1[89]\d{2}|20[0-4]\d)\b/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const recs = loadScrapedRecords();
const noYear = recs.filter((r) => r.title && r.url && !YEAR.test(r.title) && !YEAR.test(r.url));
console.log(`records with no year in title OR url: ${noYear.length} of ${recs.length}\n`);

// Sample across sources rather than taking the first N, which would all be one source.
const bySource = {};
for (const r of noYear) (bySource[r.source] = bySource[r.source] || []).push(r);
console.log("by source:");
for (const [s, list] of Object.entries(bySource)) console.log(`  ${s.padEnd(8)} ${list.length}`);

const sample = [];
for (const list of Object.values(bySource)) sample.push(...list.slice(0, 3));

(async () => {
  console.log(`\nfetching ${sample.length} detail pages to see whether the YEAR is there...\n`);
  let found = 0;
  for (const r of sample) {
    try {
      const res = await fetch(r.url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; price-index-research/1.0)" },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status !== 200) { console.log(`  HTTP ${res.status}  ${String(r.title).slice(0, 46)}`); await sleep(3000); continue; }
      const html = await res.text();

      // Look where a year would legitimately be stated about THIS car: page title, headings,
      // and any "Year" spec row. Body prose is excluded — a year mentioned in a description
      // ("raced through the 1970s") is not this car's model year.
      const h1 = (html.match(/<h1[^>]*>([\s\S]{0,200}?)<\/h1>/i) || [])[1] || "";
      const docTitle = (html.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i) || [])[1] || "";
      const specRow = (html.match(/year[^<]{0,30}<\/[^>]+>\s*<[^>]+>\s*((?:1[89]|20)\d{2})/i) || [])[1] || "";

      const hit = (h1.match(YEAR) || docTitle.match(YEAR) || [])[0] || specRow || null;
      if (hit) found++;
      console.log(`  ${hit ? "YEAR " + hit : "none "}  ${String(r.title).slice(0, 50)}`);
      if (hit) console.log(`            from: ${h1.match(YEAR) ? "h1" : docTitle.match(YEAR) ? "<title>" : "spec row"}`);
    } catch (e) {
      console.log(`  ERR ${e.cause?.code || e.name}  ${String(r.title).slice(0, 44)}`);
    }
    await sleep(3000); // gentle: BaT throttled us earlier
  }

  console.log(`\n${found}/${sample.length} detail pages carried a usable year.`);
  console.log(`\nIF THAT RATE HOLDS: one extra fetch per year-less record recovers most of the`);
  console.log(`5,050. At 3s each that is ~4 hours, one-off, and only for records that need it.`);
  console.log(`IF IT DOES NOT: the year genuinely is not published, and rejecting remains correct —`);
  console.log(`inventing one from a production range would corrupt the model-year curve it feeds.`);
})();
