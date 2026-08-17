// PER-SOURCE health report + bug finder.
//
// Each source formats titles and URLs differently, so quality has to be measured per source,
// never in aggregate — an aggregate number is dominated by whichever source happens to have
// the most rows (here: BaT at 93%) and hides everything else.
//
// The core bug-finding trick: parse make/model TWICE, independently —
//   (a) from the prose TITLE  (resolve-car-v2.parseTitle)
//   (b) from the URL SLUG     (slug-parsers, one per source)
// and compare. They are produced by different code paths from different inputs, so a
// disagreement is a strong signal that one of them is wrong. Agreement is cheap confirmation.
//
// Usage: node resolve/per-source-report.js

const fs = require("fs");
const path = require("path");
const { parseTitle } = require("./resolve-car-v2");
const { parseSlugForSource, hasParser } = require("./slug-parsers");
const { MAKE_ALIASES } = require("./vocab");

const DIR = path.join(__dirname, "..", "samples", "scraped");
const records = [];
require("../ingest/load-scraped").appendScrapedRecords(records, DIR);

// de-dupe: the same lot appears in several scrape files
const seen = new Set();
const unique = [];
for (const r of records) {
  const k = `${r.source}|${r.source_lot_id}`;
  if (seen.has(k)) continue;
  seen.add(k); unique.push(r);
}

const MAKE_KEYS = [...MAKE_ALIASES.keys()].sort((a, b) => b.split(" ").length - a.split(" ").length || b.length - a.length);
function makeFromTokens(tokens) {
  for (const key of MAKE_KEYS) {
    const parts = key.split(/[\s-]+/);
    for (let i = 0; i <= tokens.length - parts.length; i++) {
      if (parts.every((p, j) => tokens[i + j] === p)) return MAKE_ALIASES.get(key);
    }
  }
  return null;
}

const bySource = {};
for (const r of unique) (bySource[r.source] ||= []).push(r);

const FIELDS = ["price", "sold_at", "mileage", "vin_raw", "transmission", "color", "url", "title"];
const bugs = [];

console.log(`\nUnique lots: ${unique.length} across ${Object.keys(bySource).length} sources\n`);

for (const [source, recs] of Object.entries(bySource).sort((a, b) => b[1].length - a[1].length)) {
  console.log("=".repeat(70));
  console.log(`SOURCE: ${source}   (${recs.length} lots)`);
  console.log("=".repeat(70));

  // ---- adapter field coverage
  console.log("  field coverage:");
  for (const f of FIELDS) {
    const n = recs.filter((r) => r[f] != null && r[f] !== "").length;
    const pct = (n / recs.length) * 100;
    const flag = pct === 0 ? "  <-- ADAPTER GAP: never populated" : pct < 50 ? "  <-- low" : "";
    console.log(`     ${f.padEnd(14)} ${String(n).padStart(3)}/${recs.length}  ${pct.toFixed(0).padStart(3)}%${flag}`);
    if (pct === 0) bugs.push({ source, kind: "adapter-gap", detail: `${f} never populated` });
  }

  // ---- slug parser
  if (!hasParser(source)) {
    console.log(`  slug parser:   MISSING for "${source}"`);
    bugs.push({ source, kind: "no-slug-parser", detail: `no URL parser registered` });
  } else {
    const ok = recs.filter((r) => r.url && parseSlugForSource(source, r.url)?.year).length;
    console.log(`  slug parser:   ${ok}/${recs.length} URLs yielded a year`);
    if (ok < recs.length) bugs.push({ source, kind: "slug-parse-fail", detail: `${recs.length - ok} URLs unparseable` });
  }

  // ---- title vs URL cross-check
  let agree = 0, disagree = 0, titleOnly = 0, urlOnly = 0, neither = 0;
  const mismatches = [];
  for (const r of recs) {
    const t = parseTitle(r.title, { url: r.url });
    const slug = parseSlugForSource(source, r.url);
    const titleMake = t.ok ? t.make : null;
    const urlMake = slug ? makeFromTokens(slug.rest) : null;

    if (titleMake && urlMake) {
      if (titleMake === urlMake) agree++;
      else { disagree++; mismatches.push({ title: r.title, titleMake, urlMake, url: r.url }); }
    } else if (titleMake) titleOnly++;
    else if (urlMake) urlOnly++;
    else neither++;

    // year cross-check
    if (t.ok && slug?.year && t.year !== slug.year) {
      mismatches.push({ title: r.title, titleYear: t.year, urlYear: slug.year, url: r.url });
    }
  }
  console.log(`  title vs URL:  agree=${agree}  DISAGREE=${disagree}  title-only=${titleOnly}  url-only=${urlOnly}  neither=${neither}`);
  if (urlOnly > 0) bugs.push({ source, kind: "title-parse-miss", detail: `${urlOnly} lots the URL resolved but the title did not` });

  for (const m of mismatches.slice(0, 5)) {
    console.log(`     MISMATCH: ${JSON.stringify(m)}`);
    bugs.push({ source, kind: "title-url-mismatch", detail: m.title });
  }

  // ---- resolution outcome
  const resolved = recs.filter((r) => parseTitle(r.title, { url: r.url }).ok).length;
  console.log(`  auto-resolved: ${resolved}/${recs.length}  (${((resolved / recs.length) * 100).toFixed(1)}%)`);
  console.log();
}

console.log("=".repeat(70));
console.log(`BUGS / GAPS FOUND: ${bugs.length}`);
console.log("=".repeat(70));
const byKind = {};
for (const b of bugs) (byKind[b.kind] ||= []).push(b);
for (const [kind, list] of Object.entries(byKind)) {
  console.log(`\n${kind}  (${list.length})`);
  for (const b of list) console.log(`   [${b.source}] ${b.detail}`);
}
