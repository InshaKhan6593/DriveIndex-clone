// Turns the workflow's `sources` input into a matrix for the scrape job.
//
// Lives in a file rather than inline YAML because it has real rules — an unknown source name must
// FAIL rather than silently produce an empty matrix, which would look like a successful run that
// scraped nothing. Being a plain script also means it can be tested by running it directly:
//
//   SOURCES=all node .github/scripts/plan-sources.js
//   SOURCES=bat,bonhams node .github/scripts/plan-sources.js
//   SOURCES=none node .github/scripts/plan-sources.js
//
// Writes GitHub Actions output syntax to stdout, which the workflow appends to $GITHUB_OUTPUT.
"use strict";

const { STAGES } = require("../../jobs/stages");

// The scrapeable sources are derived from stages.js, so a source added there is automatically
// offered here and cannot be forgotten. bat-detail is excluded as a source in its own right: it
// is enrichment that must run in the same job as `bat`, immediately after it, because both
// rewrite samples/scraped/bat-partitioned.json and concurrent writes would lose data.
const ALL = STAGES
  .filter((s) => s.name.startsWith("scrape:"))
  .map((s) => s.name.slice("scrape:".length))
  .filter((s) => s !== "bat-detail");

const raw = (process.env.SOURCES || "all").trim();

let chosen;
if (raw === "" || raw.toLowerCase() === "all") {
  chosen = ALL;
} else if (raw.toLowerCase() === "none") {
  chosen = [];
} else {
  chosen = raw.split(",").map((x) => x.trim()).filter(Boolean);
  const unknown = chosen.filter((c) => !ALL.includes(c));
  if (unknown.length) {
    console.error(`unknown source(s): ${unknown.join(", ")}`);
    console.error(`known: ${ALL.join(", ")}`);
    process.exit(1);
  }
}

// `any` gates the scrape job. With an empty matrix GitHub would skip the job, and `needs` would
// then report it as skipped rather than successful — so the flag is explicit instead of implied.
console.log(`matrix=${JSON.stringify(chosen)}`);
console.log(`any=${chosen.length > 0}`);
console.error(`planned ${chosen.length} source(s): ${chosen.join(", ") || "(none)"}`);
