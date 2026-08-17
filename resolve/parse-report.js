// Runs the v2 parser over every real scraped title and reports what it produced.
// This is the tuning loop: run it, read the misgroupings, fix vocab.js, run again.
// Usage: node resolve/parse-report.js [--group]

const fs = require("fs");
const path = require("path");
const { parseTitle } = require("./resolve-car-v2");

const DIR = path.join(__dirname, "..", "samples", "scraped");
const records = [];
for (const f of fs.readdirSync(DIR)) {
  if (f.endsWith(".json")) records.push(...JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")));
}

// dedupe by title but keep a URL for each, since the parser uses the URL as a year fallback
const byTitle = new Map();
for (const r of records) if (r.title && !byTitle.has(r.title)) byTitle.set(r.title, r.url);
const titles = [...byTitle.keys()];
const groups = new Map();
const queued = [];

for (const t of titles) {
  const p = parseTitle(t, { url: byTitle.get(t) });
  if (!p.ok) { queued.push({ title: t, reason: p.reason }); continue; }
  const key = [p.year, p.make, p.modelKey, p.bodyType ?? "-", p.generation ?? "-", p.modification ?? "-"].join(" | ");
  if (!groups.has(key)) groups.set(key, { parsed: p, titles: [] });
  groups.get(key).titles.push(t);
}

const showGroups = process.argv.includes("--group");

if (showGroups) {
  console.log("=== GROUPS WITH >1 TITLE (these are the merges v2 achieved) ===\n");
  for (const [key, g] of [...groups].sort((a, b) => b[1].titles.length - a[1].titles.length)) {
    if (g.titles.length < 2) continue;
    console.log(`${g.parsed.year} ${g.parsed.make} ${g.parsed.modelDisplay}` +
      `${g.parsed.bodyType ? " [" + g.parsed.bodyType + "]" : ""}` +
      `${g.parsed.generation ? " gen:" + g.parsed.generation : ""}` +
      `${g.parsed.modification ? " mod:" + g.parsed.modification : ""}  (${g.titles.length} sales)`);
    for (const t of g.titles) console.log(`      ${t}`);
    console.log();
  }
}

console.log("=== SUMMARY ===");
console.log(`unique titles           : ${titles.length}`);
console.log(`resolved automatically  : ${titles.length - queued.length}  (${((1 - queued.length / titles.length) * 100).toFixed(1)}%)`);
console.log(`sent to human review    : ${queued.length}  (${((queued.length / titles.length) * 100).toFixed(1)}%)`);
console.log(`distinct cars created   : ${groups.size}`);
console.log(`cars with >1 sale       : ${[...groups.values()].filter((g) => g.titles.length > 1).length}`);
console.log(`fragmentation ratio     : ${(groups.size / (titles.length - queued.length)).toFixed(3)}  (1.000 = every sale its own car = worst)`);

if (queued.length) {
  console.log("\n=== SENT TO REVIEW ===");
  for (const q of queued) console.log(`  ${q.reason.padEnd(42)} ${q.title}`);
}
