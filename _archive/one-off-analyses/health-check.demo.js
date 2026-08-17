// Demo/proof, run: node validation/health-check.demo.js
//
// Step 1: run the health check against the REAL scraped batches to establish baselines.
// Step 2: simulate the exact failure this session hit for real — Cars & Bids' spec-table
//         selector silently returning {} (see crawler/cars-and-bids.crawler.js history) —
//         by taking the real batch and nulling out vin_raw/mileage/transmission on every
//         record, as if the dl.cnb-details-quick-facts selector broke again after a
//         frontend redeploy. Confirm the drift detector flags it.

const fs = require("fs");
const path = require("path");
const { runHealthCheck } = require("./health-check");

const SCRAPED_DIR = path.join(__dirname, "..", "samples", "scraped");

console.log("### STEP 1 — establishing baselines from real scraped batches ###");
for (const file of ["cars-and-bids.json", "bring-a-trailer.json", "bonhams.json", "mecum.json"]) {
  const source = file.replace(".json", "");
  const filePath = path.join(SCRAPED_DIR, file);
  if (!fs.existsSync(filePath)) { console.log(`(skipping ${file}, not scraped yet)`); continue; }
  const records = JSON.parse(fs.readFileSync(filePath, "utf8"));
  runHealthCheck(records[0]?.source || source, records);
}

console.log("\n### STEP 2 — simulating a broken selector on Cars & Bids (real batch, fields nulled) ###");
const realBatch = JSON.parse(fs.readFileSync(path.join(SCRAPED_DIR, "cars-and-bids.json"), "utf8"));
const brokenBatch = realBatch.map((r) => ({ ...r, vin_raw: null, mileage: null, transmission: null, tc: "unknown" }));
runHealthCheck("cab", brokenBatch);
