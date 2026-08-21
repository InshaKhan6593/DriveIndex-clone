// Validate the two files produced by crawler/hagerty.crawler.js.
// This is intentionally stricter than JSON.parse: a valid JSON file containing duplicate lots,
// an undated sale, or an active withdrawn auction is still a corrupt harvest.
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SALES = path.join(ROOT, "samples", "scraped", "hagerty.json");
const LISTINGS = path.join(ROOT, "samples", "listings", "hagerty-listings.json");
const FROM = new Date(`${process.env.HAGERTY_FROM_DATE || "2024-01-01"}T00:00:00.000Z`);
const TO = new Date();
const CLOSED = new Set(["sold", "sold_after", "bid_to", "reserve_not_met", "withdrawn", "ended"]);
const ACTIVE = new Set(["live", "upcoming"]);

function read(file) {
  if (!fs.existsSync(file)) return [];
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(data)) throw new Error(`${path.basename(file)} must contain an array`);
  return data;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validateUnique(records, file) {
  const seen = new Set();
  for (const [i, r] of records.entries()) {
    assert(r && r.source === "hagerty", `${file}[${i}] source is not hagerty`);
    assert(r.source_lot_id, `${file}[${i}] has no source_lot_id`);
    const key = `${r.source}|${r.source_lot_id}`;
    assert(!seen.has(key), `${file} duplicate natural key ${key}`);
    seen.add(key);
    assert(r.url && /^https:\/\/www\.hagerty\.com\//.test(r.url), `${file}[${i}] invalid url`);
    assert(r.title && String(r.title).trim(), `${file}[${i}] has no title`);
  }
}

function validateSales(records) {
  for (const [i, r] of records.entries()) {
    assert(["sold", "sold_after"].includes(r.status), `hagerty.json[${i}] invalid sale status ${r.status}`);
    assert(Number.isFinite(Number(r.price)) && Number(r.price) > 0, `hagerty.json[${i}] invalid sale price`);
    const date = new Date(r.sold_at);
    assert(!Number.isNaN(date.getTime()), `hagerty.json[${i}] missing/invalid sold_at`);
    assert(date >= FROM && date <= TO, `hagerty.json[${i}] sold_at outside configured 2024-current window`);
  }
}

function validateListings(records) {
  for (const [i, r] of records.entries()) {
    assert(["auction", "classified"].includes(r.listing_type), `hagerty-listings.json[${i}] invalid listing_type`);
    assert(["live", "upcoming", "sold", "sold_after", "bid_to", "reserve_not_met", "withdrawn", "ended", "unknown"].includes(r.listing_status), `hagerty-listings.json[${i}] invalid listing_status`);
    if (ACTIVE.has(r.listing_status)) assert(r.is_active === true, `hagerty-listings.json[${i}] active status has is_active=false`);
    if (CLOSED.has(r.listing_status)) assert(r.is_active === false, `hagerty-listings.json[${i}] closed status has is_active=true`);
    for (const field of ["price", "current_bid", "estimate_low", "estimate_high"]) {
      if (r[field] != null) assert(Number.isFinite(Number(r[field])) && Number(r[field]) >= 0, `hagerty-listings.json[${i}] invalid ${field}`);
    }
  }
}

const sales = read(SALES);
const listings = read(LISTINGS);
validateUnique(sales, "hagerty.json");
validateUnique(listings, "hagerty-listings.json");
validateSales(sales);
validateListings(listings);
console.log(`Hagerty format OK: ${sales.length} sales, ${listings.length} lifecycle listings; unique natural keys and lifecycle gates passed.`);
