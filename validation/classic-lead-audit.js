// Audit the quarantined Classic.com aggregator output. This is intentionally separate from
// validate-record.js because a Classic lead is not a NormalizedSale and must never be ingested as
// one. Run: node validation/classic-lead-audit.js [file]
"use strict";

const fs = require("fs");
const path = require("path");

const file = process.argv[2] || path.join(__dirname, "..", "samples", "staging", "classic-leads.json");
const leads = JSON.parse(fs.readFileSync(file, "utf8"));
const errors = [];
const keys = new Set();
const outcomes = new Map();
const fields = ["title", "outcome", "sold_at", "reported_price_usd", "mileage", "vin_raw", "transmission", "image_url", "upstream_url"];

for (const lead of leads) {
  const key = `${lead.source}|${lead.source_lot_id}`;
  if (keys.has(key)) errors.push(`${key}: duplicate key`);
  keys.add(key);
  outcomes.set(lead.outcome, (outcomes.get(lead.outcome) || 0) + 1);
  if (lead.source !== "classic") errors.push(`${key}: wrong source`);
  if (!/^https:\/\/www\.classic\.com\/veh\//.test(lead.url || "")) errors.push(`${key}: invalid Classic URL`);
  if (!/^https?:\/\/(?!www\.classic\.com)/.test(lead.upstream_url || "")) errors.push(`${key}: missing external upstream URL`);
  if (!["sold", "not_sold", "pending", "for_sale"].includes(lead.outcome)) errors.push(`${key}: invalid outcome`);

  if (lead.outcome === "sold") {
    if (!(lead.reported_price_usd > 0)) errors.push(`${key}: sold lead has no positive USD price`);
    if (!lead.sold_at || Number.isNaN(new Date(lead.sold_at).getTime())) errors.push(`${key}: sold lead has no valid date`);
    if (lead.reported_currency !== "USD") errors.push(`${key}: sold lead is not explicitly USD`);
  } else if (lead.sold_at != null || lead.reported_price_usd != null) {
    errors.push(`${key}: non-sale outcome carries sale price/date`);
  }
}

console.log(`Classic leads: ${leads.length}`);
console.log(`Unique keys: ${keys.size}`);
console.log(`Outcomes: ${JSON.stringify(Object.fromEntries(outcomes))}`);
console.log(`External upstream URLs: ${leads.filter((lead) => /^https?:\/\/(?!www\.classic\.com)/.test(lead.upstream_url || "")).length}`);
console.log(`Field coverage: ${fields.map((field) => {
  const present = leads.filter((lead) => lead[field] != null && lead[field] !== "").length;
  return `${field}=${present}/${leads.length}`;
}).join(" ")}`);
const sold = leads.filter((lead) => lead.outcome === "sold");
console.log(`Sold-field coverage: ${fields.map((field) => {
  const present = sold.filter((lead) => lead[field] != null && lead[field] !== "").length;
  return `${field}=${present}/${sold.length}`;
}).join(" ")}`);
if (errors.length) {
  console.error(`\n${errors.length} audit error(s)`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exitCode = 1;
} else {
  console.log("Audit: PASS");
}
