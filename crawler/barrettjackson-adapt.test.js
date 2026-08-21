// Smoke tests for the Barrett-Jackson adapter — written against REAL lot URLs observed on
// the live 2026-las-vegas docket (via reader proxy, 2026-08-19), since direct access is
// blocked from this network. Locks the URL parse, the vehicle/automobilia split, the $1
// charity sentinel, and the no-date refusal.
"use strict";

const fs = require("fs");
const path = require("path");
const { adaptLot, adaptApiRecord, parseApiDate, parseLotUrl, parseStatus } = require("./barrettjackson-adapt");

const DATE = "2026-09-12T23:00:00.000Z"; // Las Vegas sale close, last day of range

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}`); }
}

// URL parse — real shape from the live docket.
check("vehicle lot URL parses",
  JSON.stringify(parseLotUrl("/2026-las-vegas/docket/vehicle/1962-chevrolet-corvette-custom-convertible-299449?origin=featured")) ===
  JSON.stringify({ kind: "vehicle", slug: "1962-chevrolet-corvette-custom-convertible", lotId: "299449" }));

check("automobilia lot URL parses and is typed",
  parseLotUrl("/2026-las-vegas/docket/automobilia/1955-michelin-tires-porcelain-sign-302349?origin=featured_automobilia").kind === "automobilia");

// Full card adaptation.
const soldCard = adaptLot(
  { href: "/2026-las-vegas/docket/vehicle/1962-chevrolet-corvette-custom-convertible-299449?origin=featured",
    cardText: "1962 CHEVROLET CORVETTE CUSTOM CONVERTIBLE\nSOLD\n$143,500" },
  DATE, { event: "2026-las-vegas" });

check("sold card -> sale", soldCard.kind === "sale");
check("price parsed", soldCard.record && soldCard.record.price === 143500);
check("title from slug", soldCard.record && soldCard.record.title === "1962 Chevrolet Corvette Custom Convertible");
check("source is bj", soldCard.record && soldCard.record.source === "bj");
check("lot id is the trailing numeric", soldCard.record && soldCard.record.source_lot_id === "299449");
check("url strips query", soldCard.record && soldCard.record.url === "https://www.barrett-jackson.com/2026-las-vegas/docket/vehicle/1962-chevrolet-corvette-custom-convertible-299449");

// Gates.
check("automobilia path refused",
  adaptLot({ href: "/2026-las-vegas/docket/automobilia/1955-michelin-tires-porcelain-sign-302349", cardText: "$2,750" }, DATE, {}).kind === "skip");

check("automobilia TITLE gate catches vehicle-path misfiles",
  adaptLot({ href: "/2026-las-vegas/docket/vehicle/1955-michelin-tires-porcelain-sign-302349", cardText: "$2,750" }, DATE, {}).kind === "skip");

check("no price -> refused",
  adaptLot({ href: "/2026-las-vegas/docket/vehicle/1962-chevrolet-corvette-custom-convertible-299449", cardText: "1962 CHEVROLET CORVETTE" }, DATE, {}).kind === "skip");

check("$1 charity sentinel -> refused",
  adaptLot({ href: "/2026-las-vegas/docket/vehicle/2024-ford-mustang-charity-302000", cardText: "SOLD\n$1" }, DATE, {}).kind === "skip");

check("no date -> REFUSED (never a hollow row)",
  adaptLot({ href: "/2026-las-vegas/docket/vehicle/1962-chevrolet-corvette-custom-convertible-299449", cardText: "$143,500" }, null, {}).kind === "skip");

// Live API contract captured through the VPN-backed Playwright browser on 2026-08-21.
// The raw captures stay in samples/raw (ignored output); keep a compact fallback here so a
// clean checkout can still run the contract tests without redistributing scraped records.
function readCaptured(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "samples", "raw", name), "utf8"));
  } catch {
    return fallback;
  }
}

const fixture = (overrides = {}) => ({
  is_sold: true,
  is_canceled: false,
  title: "2022 FORD BRONCO CUSTOM SUV 4X4",
  price: "$93,500.00",
  price_decimal: 93500,
  item_id: "259280",
  event_slug: "las-vegas-2022",
  slug: "2022-ford-bronco-custom-suv-4x4-259280",
  run_date: "Saturday - July 02, 2022",
  run_datetime: "2022-07-02T18:00:00",
  vin: "1FMEE5BP0NLA89004",
  exterior_color: "CARBONIZED GRAY METALLIC",
  transmission_type_name: "10-SPEED AUTOMATIC",
  engine_size: "2.7L",
  number_of_cylinders: "6",
  ...overrides,
});

const soldSample = readCaptured("barrettjackson-sold-api-sample-full.json", {
  records: [
    fixture({
      title: "2023 CADILLAC ESCALADE - V FIRST RETAIL PRODUCTION VIN 001",
      price: "$525,000.00", price_decimal: 525000, item_id: "259083",
      slug: "2023-cadillac-escalade-v-first-retail-production-vin-001-259083",
      run_date: "Friday - July 01, 2022", run_datetime: "2022-07-01T16:30:00",
      vin: "000123456789", exterior_color: "TBD", transmission_type_name: "",
      engine_size: "6.2L", number_of_cylinders: "8",
    }),
    fixture(),
    fixture({ item_id: "259281", price: "$101,200.00", price_decimal: 101200, slug: "2022-ram-1500-trx-pickup-259281" }),
    fixture({ item_id: "259282", price: "$110,000.00", price_decimal: 110000, slug: "2022-ford-bronco-custom-suv-259282" }),
    fixture({ item_id: "259283", price: "$99,000.00", price_decimal: 99000, slug: "2022-ford-bronco-custom-suv-259283" }),
  ],
});
const previewSample = readCaptured("barrettjackson-api-sample.json", {
  records: [fixture({ is_sold: false, price: "$0.00", price_decimal: 0 })],
});

check("API date-only value is normalized at UTC noon",
  parseApiDate("Friday - July 01, 2022") === "2022-07-01T12:00:00.000Z");
check("API sold status is recognized", parseStatus("No Reserve SOLD $525,000.00") === "sold");
check("API not-sold status is not a sale", parseStatus("Not Sold $525,000.00") === "reserve_not_met");

const apiSales = soldSample.records.map((record) => adaptApiRecord(record, "2026-08-21T09:24:36.000Z"));
check("API sample has five sale adaptations", apiSales.filter((x) => x.kind === "sale").length === 5);
check("API source lot id uses native item_id", apiSales[0].record && apiSales[0].record.source_lot_id === "259083");
check("API price_decimal maps to price_usd", apiSales[0].record && apiSales[0].record.price_usd === 525000);
check("API date-only run_date maps to UTC noon", adaptApiRecord(
  { ...soldSample.records[0], run_datetime: null },
  "2026-08-21T09:24:36.000Z",
).record?.sold_at === "2022-07-01T12:00:00.000Z");
check("API run_datetime preserves its source calendar timestamp", apiSales[0].record && apiSales[0].record.sold_at === "2022-07-01T16:30:00.000Z");
check("API event slug maps into canonical lot URL", apiSales[0].record && apiSales[0].record.url ===
  "https://www.barrett-jackson.com/las-vegas-2022/docket/vehicle/2023-cadillac-escalade-v-first-retail-production-vin-001-259083");
check("API VIN and transmission are retained", apiSales[1].record &&
  apiSales[1].record.vin_raw === "1FMEE5BP0NLA89004" &&
  apiSales[1].record.transmission === "10-SPEED AUTOMATIC");
check("API structured color and engine fields are retained", apiSales[1].record &&
  apiSales[1].record.color === "CARBONIZED GRAY METALLIC" &&
  apiSales[1].record._extra.engineSize === "2.7L" &&
  apiSales[1].record._extra.cylinders === "6");
check("preview API record is rejected", adaptApiRecord(previewSample.records[0]).kind === "skip");

const recent2026 = adaptApiRecord({
  is_sold: true, is_canceled: false,
  title: "2025 CHEVROLET SILVERADO 1500 CUSTOM ANDURIL EDITION PICKUP",
  price_decimal: 150000, price: "$150,000.00", item_id: "301121",
  event_slug: "2026-columbus",
  slug: "2025-chevrolet-silverado-1500-custom-anduril-edition-pickup-301121",
  run_datetime: "2026-06-27T15:30:00", run_date: "Saturday - June 27, 2026",
}, "2026-08-21T09:24:36.000Z");
check("recent 2026 sale maps from the live API shape", recent2026.kind === "sale" &&
  recent2026.record.price_usd === 150000 && recent2026.record.sold_at === "2026-06-27T15:30:00.000Z");

const recent2025 = adaptApiRecord({
  is_sold: true, is_canceled: false,
  title: "2025 CHEVROLET CORVETTE ZR1 FIRST RETAIL PRODUCTION VIN 001",
  price_decimal: 3700000, price: "$3,700,000.00", item_id: "282495",
  event_slug: "scottsdale-2025",
  slug: "2025-chevrolet-corvette-zr1-first-retail-production-vin-001-282495",
  run_datetime: "2025-01-25T17:30:00", run_date: "Saturday - January 25, 2025",
}, "2026-08-21T09:24:36.000Z");
check("recent 2025 sale maps from the live API shape", recent2025.kind === "sale" &&
  recent2025.record.price_usd === 3700000 && recent2025.record.sold_at === "2025-01-25T17:30:00.000Z");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
