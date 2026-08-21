// COVERAGE ACROSS THE 13 AUCTION SOURCES.
//
// The registry is verbatim from ground truth §3. Cars.com and Classic.com are deliberately not
// counted here: their own code classes them as the RETAIL complement, not auction houses —
// "retail listings = the complement" — and they carry asking prices rather than results.
"use strict";

const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(path.join(__dirname, "..", "data", "driveindex.sqlite"));

// §3, verbatim source registry (auction subset).
const AUCTION = [
  ["bat", "Bring a Trailer"],
  ["mecum", "Mecum"],
  ["rms", "RM Sotheby's"],
  ["cab", "Cars & Bids"],
  ["bon", "Bonhams"],
  ["bj", "Barrett-Jackson"],
  ["good", "Gooding"],
  ["hagerty", "Hagerty Marketplace"],
  ["sms", "Sotheby's Motorsport"],
  ["collectingcars", "Collecting Cars"],
  ["broadarrow", "Broad Arrow"],
  ["pcar", "PCAR Market"],
  ["dupont", "DuPont Registry"],
];

// Why each absent source is absent — established by probing, not assumed.
const WHY = {
  bj: "Recent 2025-2026 API crawler built; GitHub Actions requires BJ_PROXY_URL",
  hagerty: "403 blocked — needs a commercial/legal decision",
  collectingcars: "403 blocked — needs a commercial/legal decision",
  dupont: "carries ASKING prices — belongs in `listing`, never `sale`",
  good: "Gatsby page-data.json route found, harvester not built",
  sms: "API exists, results route not yet found",
  broadarrow: "reachable, 1 listing on index, not built",
  pcar: "results route not found",
};

const rows = db.prepare(`
  SELECT source, COUNT(*) n, MIN(date(sold_at)) a, MAX(date(sold_at)) b
  FROM sale GROUP BY source`).all();
const have = new Map(rows.map((r) => [r.source, r]));

// DriveIndex's measured source mix (§3), for weighting what the gaps actually cost.
const MIX = { bat: 72.2, mecum: 6.4, rms: 6.2, cab: 5.5, bon: 3.4, bj: 2.8, good: 1.9, hagerty: 0.6, sms: 0.6, collectingcars: 0.5 };

let withData = 0, mixCovered = 0;
console.log(`  ${"code".padEnd(15)} ${"source".padEnd(22)} ${"sales".padStart(8)}  coverage`);
for (const [code, name] of AUCTION) {
  const r = have.get(code);
  if (r) { withData++; mixCovered += MIX[code] || 0; }
  const span = r ? `${r.a} -> ${r.b}` : (WHY[code] || "not built");
  console.log(`  ${(r ? "HAVE " : "  -  ") + code.padEnd(15)} ${name.padEnd(22)} ${String(r ? r.n : 0).padStart(8)}  ${span}`);
}

const total = db.prepare("SELECT COUNT(*) c FROM sale").get().c;
console.log(`\n  ${withData} of 13 auction sources have data`);
console.log(`  total sales: ${total.toLocaleString()}   (DriveIndex: 110,043 across 13)`);
console.log(`\n  Weighted by THEIR measured source mix, our sources represent ${mixCovered.toFixed(1)}% of it.`);
console.log(`  That matters more than the source count: the four we hold are their #1, #2, #3 and #4.`);
