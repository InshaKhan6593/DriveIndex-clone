// Builds the make/model mapping FROM SOURCE DATA — the scraped listing URLs and titles of
// the 13 auction houses. No competitor catalogue involved.
//
// Why URLs: BaT/C&B/Mecum slugs are machine-generated as {year}-{make}-{model...}, so the
// slug is a pre-tokenised, lowercase, punctuation-free version of the same car the title
// describes in prose. Comparing the two gives a free cross-check on every parse.
//
// Output: resolve/mapping.generated.json
//   makes  : make string -> { count, models: {model: count}, sources: [...] }
//   unknown: slugs whose make token we do NOT recognise -> these are the mapping gaps
//
// Usage: node resolve/build-mapping.js

const fs = require("fs");
const path = require("path");
const { MAKE_ALIASES } = require("./vocab");

const DIR = path.join(__dirname, "..", "samples", "scraped");
const records = [];
require("../ingest/load-scraped").appendScrapedRecords(records, DIR);

const MAKE_KEYS = [...MAKE_ALIASES.keys()].sort((a, b) => b.split(" ").length - a.split(" ").length || b.length - a.length);

// Slug -> {year, makeTokens, modelTokens}. The trailing -N is BaT's dedupe counter, not data.
function parseSlug(url) {
  const m = String(url).match(/\/listing\/([^/?]+)/) || String(url).match(/\/([^/?]+)\/?$/);
  if (!m) return null;
  let slug = m[1].replace(/-\d+$/, "");
  const ym = slug.match(/^(1[89]\d{2}|20[0-4]\d)-/);
  if (!ym) return null;
  const year = Number(ym[1]);
  const rest = slug.slice(ym[0].length);
  const tokens = rest.split("-").filter(Boolean);

  // longest-first make match against the token stream
  for (const key of MAKE_KEYS) {
    const parts = key.split(/[\s-]+/);
    for (let i = 0; i <= tokens.length - parts.length; i++) {
      if (parts.every((p, j) => tokens[i + j] === p)) {
        return { year, make: MAKE_ALIASES.get(key), makeTokens: parts,
                 modelTokens: [...tokens.slice(0, i), ...tokens.slice(i + parts.length)] };
      }
    }
  }
  return { year, make: null, makeTokens: [], modelTokens: tokens };
}

const makes = {};
const unknown = [];

for (const r of records) {
  if (!r.url) continue;
  const p = parseSlug(r.url);
  if (!p) continue;
  if (!p.make) { unknown.push({ url: r.url, title: r.title, tokens: p.modelTokens.slice(0, 4) }); continue; }

  const model = p.modelTokens.join(" ");
  makes[p.make] ||= { count: 0, models: {}, sources: new Set() };
  makes[p.make].count++;
  makes[p.make].models[model] = (makes[p.make].models[model] || 0) + 1;
  makes[p.make].sources.add(r.source);
}

const out = {
  _generated: new Date().toISOString(),
  _builtFrom: "scraped listing URLs + titles from the auction sources (no competitor data)",
  _recordsScanned: records.length,
  makes: Object.fromEntries(
    Object.entries(makes)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([k, v]) => [k, { count: v.count, sources: [...v.sources], models: Object.fromEntries(Object.entries(v.models).sort((a, b) => b[1] - a[1])) }])
  ),
  unknownMakeSlugs: unknown,
};

fs.writeFileSync(path.join(__dirname, "mapping.generated.json"), JSON.stringify(out, null, 1));

const modelTotal = Object.values(out.makes).reduce((a, m) => a + Object.keys(m.models).length, 0);
console.log(`records scanned : ${records.length}`);
console.log(`makes mapped    : ${Object.keys(out.makes).length}`);
console.log(`distinct models : ${modelTotal}`);
console.log(`UNMAPPED slugs  : ${unknown.length}   <-- these are the mapping gaps to fix\n`);

console.log("MAKES FOUND IN SOURCE DATA (by volume):");
for (const [make, v] of Object.entries(out.makes)) {
  console.log(`  ${String(v.count).padStart(3)}  ${make.padEnd(16)} ${Object.keys(v.models).length} models  [${v.sources.join(",")}]`);
}
if (unknown.length) {
  console.log("\nUNMAPPED — make token not in MAKE_ALIASES:");
  for (const u of unknown) console.log(`  tokens=[${u.tokens.join(", ")}]  <- ${u.title}`);
}
