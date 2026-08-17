// Compare harvest METHODS for the same source, so the worse one can be retired on evidence.
//
// The duplication audit surfaced two duplicate sales, and both came from the DOM list crawler
// (bat-list.crawler.js) rather than the JSON API harvester. One was not merely duplicated but
// CORRUPT: the title "2025 McLaren 750S Spider" attached to the URL of a 1970 Porsche 911S
// Targa. That crawler matches titles to listing URLs by slug similarity over page text, and
// when the alignment slips it produces a record whose title and URL describe different cars.
//
// A wrong title-to-URL pairing is worse than a missing record: it invents a sale that never
// happened, on a car that never sold, at a price taken from a third car.
//
// This quantifies the damage so the decision to keep or drop the DOM harvest is made on
// numbers rather than instinct.
//
// Usage: node validation/harvest-quality.js

"use strict";

const fs = require("fs");
const path = require("path");
const { parseTitle } = require("../resolve/resolve-car-v2");
const { MAKE_ALIASES } = require("../resolve/vocab");

// Canonical make names, longest first so "Aston Martin" is tested before "Aston".
const MAKE_LIST = [...new Set(MAKE_ALIASES.values())].sort((a, b) => b.length - a.length);

const DIR = path.join(__dirname, "..", "samples", "scraped");
const read = (f) => {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")); } catch { return []; }
};

const api = [...read("bat-api-ta.json"), ...read("bat-partitioned.json")];
const dom = read("bat-list.json");

// Page chrome that leaked into titles because the text-sequence parser takes "everything since
// the previous result clause" as the title, and the first result on a page is preceded by the
// site header.
const CHROME = /(Completed Auctions|Get Daily Updates|This Week's Popular|Recent Exceptional Results|Reserve not met|View all|Sold\b.*\bListings)/i;

// A BaT listing URL is the true natural key — the numeric id and the slug are two names for
// the same lot, so a URL seen twice is one lot recorded twice.
const canon = (u) => String(u || "").split("?")[0].replace(/\/+$/, "").toLowerCase();

function report(name, recs) {
  const chrome = recs.filter((r) => CHROME.test(r.title || ""));
  const urls = new Map();
  for (const r of recs) {
    const u = canon(r.url);
    if (!u) continue;
    if (!urls.has(u)) urls.set(u, []);
    urls.get(u).push(r);
  }
  const dupUrl = [...urls.values()].filter((g) => g.length > 1);

  // The damaging case: one URL carrying records whose titles name DIFFERENT cars.
  const mismatched = dupUrl.filter((g) => {
    const norm = (t) => String(t || "").replace(CHROME, "").replace(/\s+/g, " ").trim().toLowerCase();
    return new Set(g.map((r) => norm(r.title))).size > 1;
  });

  // A slug-shaped lot id means the numeric listing id was never captured.
  const slugIds = recs.filter((r) => !/^\d+$/.test(String(r.source_lot_id || "")));

  // THE REAL CORRUPTION TEST, and the first version of this file got it wrong.
  //
  // It originally looked for one URL carrying two disagreeing titles. But the observed defect
  // is the mirror image: a record whose title names one car while its URL names another
  // ("2025 McLaren 750S Spider" on .../1970-porsche-911s-targa-7/). Those are two DIFFERENT
  // URLs, so the same-URL test could never see it.
  //
  // A BaT slug embeds the year and make, so title and URL are two independent statements about
  // the same car. When they disagree, the record is internally inconsistent and one of the two
  // is fabricated — which is far worse than a missing row.
  // Compare MAKES, using the same parsers the pipeline itself uses, rather than raw word
  // overlap. An earlier version of this check compared letters-only title words against slug
  // words that still contained digits, so "ca.1945 T-34/85 Medium Tank" and the slug
  // "1945-czech-arsenal-t-34-85" — plainly the same tank — counted as a mismatch. It reported
  // 51% corruption in a harvest that was fine.
  //
  // Makes are the right axis: both parsers already know how to extract one, and a record whose
  // title says Porsche while its URL says Ferrari is unambiguously broken.
  const inconsistent = recs.filter((r) => {
    const slug = (String(r.url || "").match(/\/listing\/([^/?#]+)/) || [])[1];
    if (!slug) return false;
    const fromTitle = parseTitle(r.title || "", {});
    if (!fromTitle.ok || !fromTitle.make) return false;
    const fromSlug = MAKE_LIST.find((m) => slug.toLowerCase().includes(m.replace(/[^a-z]/gi, "").toLowerCase()));
    if (!fromSlug) return false; // slug does not name a make we know — no claim either way
    return fromSlug.toLowerCase() !== String(fromTitle.make).toLowerCase();
  });

  const pct = (n) => `${((n / Math.max(recs.length, 1)) * 100).toFixed(2)}%`;
  console.log(`\n=== ${name} : ${recs.length} records ===`);
  console.log(`  titles polluted with page chrome  : ${chrome.length}  (${pct(chrome.length)})`);
  console.log(`  lot ids that are slugs, not ids   : ${slugIds.length}  (${pct(slugIds.length)})`);
  // NB: this counts a URL appearing in more than one RECORD, which for the API harvest is
  // just the same lot present in two overlapping files. It is NOT "one URL under two lot ids"
  // — measured separately, that is zero, which is what makes URL usable as a certainty key.
  console.log(`  URL appearing in >1 record        : ${dupUrl.length}  (file overlap, not conflict)`);
  console.log(`  TITLE AND URL NAME DIFFERENT CARS : ${inconsistent.length}  (${pct(inconsistent.length)})  <-- fabricated records`);
  for (const r of inconsistent.slice(0, 6)) {
    console.log(`     title: "${String(r.title).slice(0, 54)}"`);
    console.log(`     url:    ${(String(r.url).match(/\/listing\/([^/?#]+)/) || [])[1] || r.url}`);
  }
  return { urls: new Set(urls.keys()), chrome: chrome.length, inconsistent: inconsistent.length };
}

const a = report("API harvest (listings-filter JSON)", api);
const d = report("DOM harvest (bat-list.crawler.js)", dom);

const onlyDom = [...d.urls].filter((u) => !a.urls.has(u));
console.log(`\n=== OVERLAP ===`);
console.log(`  URLs in API harvest      : ${a.urls.size}`);
console.log(`  URLs in DOM harvest      : ${d.urls.size}`);
console.log(`  in DOM but NOT in API    : ${onlyDom.length}`);
console.log(`\nVERDICT`);
console.log(`  The DOM harvest contributes ${onlyDom.length} URLs the API harvest does not have,`);
console.log(`  but ${d.inconsistent} of its ${dom.length} records (${((d.inconsistent / Math.max(dom.length, 1)) * 100).toFixed(1)}%) pair a title with a URL for a`);
console.log(`  DIFFERENT car. Those are not incomplete records, they are invented ones:`);
console.log(`  a sale that never happened, on a car that never sold, at another car's price.`);
console.log(`  The API harvest reaches the same listings with structured ids and no guessing.`);
